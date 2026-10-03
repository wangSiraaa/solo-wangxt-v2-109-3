import type { NamedProject, ProjectDoc } from '../types';
import { migrateDoc } from './versioning';

/**
 * 所有数据仅保存在浏览器本地 IndexedDB，音频文件绝不上传。
 * 对象仓：
 *  - session：单条最近会话（key = 'current'）
 *  - projects：具名工程
 *  - blobs：音频文件 Blob（内置样例不存音频，重载后按类型重新生成）。
 *    同一内容指纹只存一份 Blob（换版历史/回退与多轨复用同一 key）
 *  - blob-index：fingerprint → { fingerprint, blobKey }，用于跨工程/声轨去重
 */
const DB_NAME = 'spatial-audio-workbench';
const DB_VERSION = 2;
const STORE_SESSION = 'session';
const STORE_PROJECTS = 'projects';
const STORE_BLOBS = 'blobs';
const STORE_BLOB_INDEX = 'blob-index';

export interface BlobIndexEntry {
  fingerprint: string;
  blobKey: string;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_SESSION)) db.createObjectStore(STORE_SESSION);
      if (!db.objectStoreNames.contains(STORE_PROJECTS)) {
        const s = db.createObjectStore(STORE_PROJECTS, { keyPath: 'id' });
        s.createIndex('savedAt', 'savedAt');
      }
      if (!db.objectStoreNames.contains(STORE_BLOBS)) db.createObjectStore(STORE_BLOBS);
      if (!db.objectStoreNames.contains(STORE_BLOB_INDEX)) {
        db.createObjectStore(STORE_BLOB_INDEX, { keyPath: 'fingerprint' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** 多仓事务（原子写 Blob 与其指纹索引） */
function txStores<T>(
  storeNames: string[],
  mode: IDBTransactionMode,
  fn: (stores: Map<string, IDBObjectStore>) => T | Promise<T>,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(storeNames, mode);
        const map = new Map(storeNames.map((n) => [n, t.objectStore(n)]));
        Promise.resolve(fn(map)).then(
          (val) => {
            // oncomplete 后再 resolve，保证落盘顺序
            t.oncomplete = () => {
              db.close();
              resolve(val);
            };
            t.onerror = () => {
              db.close();
              reject(t.error);
            };
            t.onabort = () => {
              db.close();
              reject(t.error);
            };
          },
          (err) => {
            try {
              t.abort();
            } catch {
              /* ignore */
            }
            db.close();
            reject(err);
          },
        );
      }),
  );
}

function tx<T>(
  storeName: string,
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(storeName, mode);
        const req = fn(t.objectStore(storeName));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        t.oncomplete = () => db.close();
      }),
  );
}

/** v1 工程读出后统一迁移为 v2（见 versioning.migrateDoc） */
function migrate(d: ProjectDoc): ProjectDoc {
  return migrateDoc(d);
}

export async function saveSession(doc: ProjectDoc): Promise<void> {
  await tx(STORE_SESSION, 'readwrite', (s) => s.put(doc, 'current'));
}

export async function loadSession(): Promise<ProjectDoc | undefined> {
  const d = await tx<ProjectDoc | undefined>(STORE_SESSION, 'readonly', (s) => s.get('current'));
  return d ? migrate(d) : d;
}

export async function putBlob(key: string, blob: Blob): Promise<void> {
  await tx(STORE_BLOBS, 'readwrite', (s) => s.put(blob, key));
}

export async function getBlob(key: string): Promise<Blob | undefined> {
  return tx(STORE_BLOBS, 'readonly', (s) => s.get(key));
}

export async function deleteBlob(key: string): Promise<void> {
  await tx(STORE_BLOBS, 'readwrite', (s) => s.delete(key));
}

/** 按内容指纹查找已入库 Blob 键（同内容绝不重复存 Blob） */
export async function findBlobByFingerprint(
  fingerprint: string,
): Promise<BlobIndexEntry | undefined> {
  if (!fingerprint.startsWith('sha256:')) return undefined;
  return tx(STORE_BLOB_INDEX, 'readonly', (s) => s.get(fingerprint));
}

/**
 * 存入一个素材 Blob 并登记指纹索引（同一事务）。
 * 若指纹已指向另一 key，则复用既有 key、跳过写入，直接返回旧 key。
 */
export async function putBlobWithFingerprint(
  fingerprint: string,
  preferredKey: string,
  blob: Blob,
): Promise<{ blobKey: string; reused: boolean }> {
  if (!fingerprint.startsWith('sha256:')) {
    // 未知指纹（理论上不会走到）：退化为普通写入，不登记索引
    await putBlob(preferredKey, blob);
    return { blobKey: preferredKey, reused: false };
  }
  return txStores(
    [STORE_BLOB_INDEX, STORE_BLOBS],
    'readwrite',
    (stores) =>
      new Promise<{ blobKey: string; reused: boolean }>((resolve, reject) => {
        const idx = stores.get(STORE_BLOB_INDEX)!;
        const blobs = stores.get(STORE_BLOBS)!;
        const getReq = idx.get(fingerprint);
        getReq.onsuccess = () => {
          const existing = getReq.result as BlobIndexEntry | undefined;
          if (existing?.blobKey) {
            // 同内容：直接复用，不重复写 Blob
            resolve({ blobKey: existing.blobKey, reused: true });
            return;
          }
          blobs.put(blob, preferredKey);
          idx.put({ fingerprint, blobKey: preferredKey } as BlobIndexEntry);
          resolve({ blobKey: preferredKey, reused: false });
        };
        getReq.onerror = () => reject(getReq.error);
      }),
  );
}

/** 仅在索引悬空（指向的 Blob 已不存在）时清理索引项 */
export async function deleteDanglingBlobIndex(
  fingerprint: string,
  blobKey: string,
): Promise<void> {
  await txStores(
    [STORE_BLOB_INDEX, STORE_BLOBS],
    'readwrite',
    (stores) =>
      new Promise<void>((resolve, reject) => {
        const idx = stores.get(STORE_BLOB_INDEX)!;
        const blobs = stores.get(STORE_BLOBS)!;
        const getReq = blobs.getKey(blobKey);
        getReq.onsuccess = () => {
          if (getReq.result === undefined) idx.delete(fingerprint);
          resolve();
        };
        getReq.onerror = () => reject(getReq.error);
      }),
  );
}

export async function listProjects(): Promise<NamedProject[]> {
  const all = await tx<NamedProject[]>(STORE_PROJECTS, 'readonly', (s) => s.getAll());
  return all
    .map((p) => ({ ...p, doc: migrate(p.doc) }))
    .sort((a, b) => b.savedAt - a.savedAt);
}

export async function saveProject(p: NamedProject): Promise<void> {
  await tx(STORE_PROJECTS, 'readwrite', (s) => s.put({ ...p, doc: migrate(p.doc) }));
}

export async function deleteProject(id: string): Promise<void> {
  await tx(STORE_PROJECTS, 'readwrite', (s) => s.delete(id));
}

export async function getProject(id: string): Promise<NamedProject | undefined> {
  const p = await tx<NamedProject | undefined>(STORE_PROJECTS, 'readonly', (s) => s.get(id));
  return p ? { ...p, doc: migrate(p.doc) } : p;
}
