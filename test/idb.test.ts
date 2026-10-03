/**
 * IndexedDB 持久化集成测试（fake-indexeddb）：
 *  - Blob 与指纹索引在同一事务写入；同指纹第二次写入复用 key、不重复 Blob
 *  - 悬空索引清理
 *  - session/工程读写并自动把 v1 工程迁移为 v2 版本链
 */
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import * as idb from '../src/lib/idb.ts';
import type { ProjectDoc } from '../src/types.ts';

function v1Doc(): ProjectDoc {
  return {
    version: 1,
    tracks: [
      {
        id: 'f',
        name: 'old.wav',
        sourceType: 'file',
        blobKey: 'legacy-blob',
        originalFileName: 'old.wav',
        loop: false,
        muted: false,
        solo: false,
        gain: 0.9,
        channel: 1,
        channels: 2,
        color: '#fff',
        position: { x: 0, y: 0, z: 0 },
        status: 'ready',
        duration: 6,
      },
    ],
    listener: { position: { x: 0, y: 0, z: 3 }, yaw: 0, pitch: 0, earHeight: 0 },
    spatial: {
      distanceModel: 'inverse',
      refDistance: 1,
      rolloffFactor: 1,
      maxDistance: 30,
      positionTimeConstant: 0.06,
      hrtfIR: 'none',
    },
    busGain: 1,
    masterGain: 0.9,
    savedAt: 7,
  };
}

afterEach(async () => {
  // fake-indexeddb/auto 暴露的全局实例：每个用例重置
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase('spatial-audio-workbench');
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
});

describe('IndexedDB 素材持久化', () => {
  it('同内容指纹复用 Blob key 且只存一份；不同指纹分别存储', async () => {
    const b1 = new Blob([new Uint8Array([1, 2, 3])]);
    const b1dup = new Blob([new Uint8Array([1, 2, 3])]);
    const b2 = new Blob([new Uint8Array([4, 5, 6])]);
    const fp1 = 'sha256:1111111111111111111111111111111111111111111111111111111111111111';
    const fp2 = 'sha256:2222222222222222222222222222222222222222222222222222222222222222';

    const w1 = await idb.putBlobWithFingerprint(fp1, 'key-a', b1);
    assert.deepEqual(w1, { blobKey: 'key-a', reused: false });
    const w2 = await idb.putBlobWithFingerprint(fp1, 'key-b', b1dup);
    assert.equal(w2.reused, true);
    assert.equal(w2.blobKey, 'key-a'); // 复用旧 key，新 key 不落盘
    const w3 = await idb.putBlobWithFingerprint(fp2, 'key-c', b2);
    assert.deepEqual(w3, { blobKey: 'key-c', reused: false });

    // 索引与 Blob 都可查
    const idx1 = await idb.findBlobByFingerprint(fp1);
    assert.equal(idx1?.blobKey, 'key-a');
    const got1 = await idb.getBlob('key-a');
    assert.equal(got1?.size, b1.size);
    // key-b 从未写入（不重复 Blob）
    assert.equal(await idb.getBlob('key-b'), undefined);
    assert.equal((await idb.getBlob('key-c'))?.size, b2.size);
  });

  it('Blob 删除后悬空索引可清理；未悬空时不清理', async () => {
    const fp = 'sha256:3333333333333333333333333333333333333333333333333333333333333333';
    await idb.putBlobWithFingerprint(fp, 'k', new Blob([new Uint8Array([9])]));
    await idb.deleteDanglingBlobIndex(fp, 'k'); // 还存在 → 索引保留
    assert.ok(await idb.findBlobByFingerprint(fp));
    await idb.deleteBlob('k');
    await idb.deleteDanglingBlobIndex(fp, 'k'); // 已悬空 → 清除
    assert.equal(await idb.findBlobByFingerprint(fp), undefined);
  });

  it('session 保存/读回保留 v2 版本链', async () => {
    const doc = v1Doc();
    // 手动升级到 v2 版本链再存
    const migrated = (await import('../src/lib/versioning.ts')).migrateDoc(doc);
    await idb.saveSession(migrated);
    const loaded = await idb.loadSession();
    assert.equal(loaded?.version, 2);
    const t = loaded!.tracks[0];
    assert.equal(t.currentVersionId, t.versions?.[0].id);
    assert.equal(t.versions?.[0].blobKey, 'legacy-blob');
  });

  it('载入 v1 session / v1 工程时自动迁移为 v2', async () => {
    // 直接写一个 v1 文档（绕过迁移）
    await idb.saveSession(v1Doc());
    const loaded = await idb.loadSession();
    assert.equal(loaded?.version, 2);
    assert.equal(loaded!.tracks[0].versions?.length, 1);
    assert.equal(loaded!.tracks[0].versions?.[0].fingerprintAlg, 'unknown');
    assert.equal(loaded!.tracks[0].versions?.[0].selectedChannel, 1);

    await idb.saveProject({ id: 'p1', name: 'P', savedAt: 1, doc: v1Doc() });
    const list = await idb.listProjects();
    assert.equal(list[0].doc.version, 2);
    const p = await idb.getProject('p1');
    assert.equal(p?.doc.version, 2);
  });
});
