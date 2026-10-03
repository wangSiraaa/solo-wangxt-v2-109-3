/**
 * 本地音频素材换版流程的纯逻辑层（不依赖 Web Audio / DOM，可在 Node 中单测）。
 *
 * 核心约定：
 *  - 每个素材版本记录内容指纹（SHA-256）与声道/时长元信息；
 *  - 状态机：candidate(候选) → ready(已就绪/当前) → superseded(已取代)，
 *    解码或检查失败 → failed(失败，只留记录与原因，不保存音频)；
 *  - 同一内容指纹在同一轨道只对应一个版本；Blob 以指纹内容寻址（fp-<指纹>），
 *    重复提交既不制造新版本，也不产生第二份 Blob；
 *  - 声道布局或时长不兼容时不在此层做任何隐式映射——由 UI 要求用户明确选择
 *    原始左/右声道与播放定位后，才调用 applySwitch 原子切换；
 *  - 所有切换/回退/失败/丢弃都追加到 assetEvents，随工程一起存入 IndexedDB。
 */
import type { AssetEvent, AssetVersion, ProjectDoc } from '../types';

/** 时长容差：编解码器补齐造成的尾差在此范围内视为兼容 */
export const DURATION_TOLERANCE_SEC = 0.05;
const MAX_EVENTS = 200;

function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 内容指纹：优先 SHA-256（Web Crypto）；非安全上下文回退双 FNV-1a */
export async function computeFingerprint(data: ArrayBuffer): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    const digest = await subtle.digest('SHA-256', data);
    const bytes = new Uint8Array(digest);
    let hex = '';
    for (const b of bytes) hex += b.toString(16).padStart(2, '0');
    return `sha256:${hex}`;
  }
  const bytes = new Uint8Array(data);
  let h1 = 0x811c9dc5;
  let h2 = 0x811c9dc5 ^ 0x9e3779b9;
  for (let i = 0; i < bytes.length; i++) {
    h1 = Math.imul(h1 ^ bytes[i], 0x01000193);
    h2 = Math.imul(h2 ^ bytes[bytes.length - 1 - i], 0x01000193);
  }
  const hex = (n: number) => (n >>> 0).toString(16).padStart(8, '0');
  return `fnv:${hex(h1)}${hex(h2)}:${bytes.length}`;
}

/** Blob 键内容寻址：同一内容永远落在同一个键上，重复提交不会写出第二份 Blob */
export function blobKeyFor(fingerprint: string): string {
  return `fp-${fingerprint.replace(/[^a-zA-Z0-9]/g, '')}`;
}

export interface VersionMeta {
  channels?: number;
  duration?: number;
}

export interface Compatibility {
  compatible: boolean;
  channelsDiffer: boolean;
  durationDiffer: boolean;
  reasons: string[];
}

/**
 * 兼容性检查：仅比较声道布局与时长，元信息缺失时不妄断。
 * 不兼容时调用方必须要求用户明确处理原始声道选择与播放定位。
 */
export function assessCompatibility(
  current: VersionMeta,
  next: VersionMeta,
  toleranceSec = DURATION_TOLERANCE_SEC,
): Compatibility {
  const channelsDiffer =
    current.channels != null && next.channels != null && current.channels !== next.channels;
  const durationDiffer =
    current.duration != null &&
    next.duration != null &&
    Math.abs(current.duration - next.duration) > toleranceSec;
  const reasons: string[] = [];
  if (channelsDiffer) {
    reasons.push(`声道布局不同：当前 ${current.channels} 声道 → 新文件 ${next.channels} 声道`);
  }
  if (durationDiffer) {
    reasons.push(
      `时长不同：当前 ${current.duration!.toFixed(2)}s → 新文件 ${next.duration!.toFixed(2)}s`,
    );
  }
  return { compatible: !channelsDiffer && !durationDiffer, channelsDiffer, durationDiffer, reasons };
}

// ---------- 查询 ----------

export function versionsOf(doc: ProjectDoc, trackId: string): AssetVersion[] {
  return doc.assets.filter((a) => a.trackId === trackId);
}

export function activeVersionOf(doc: ProjectDoc, trackId: string): AssetVersion | undefined {
  const t = doc.tracks.find((x) => x.id === trackId);
  if (!t) return undefined;
  return (
    doc.assets.find((a) => a.id === t.activeVersionId) ??
    doc.assets.find((a) => a.trackId === trackId && a.status === 'ready')
  );
}

export function candidateOf(doc: ProjectDoc, trackId: string): AssetVersion | undefined {
  return doc.assets.find((a) => a.trackId === trackId && a.status === 'candidate');
}

export function findVersionByFingerprint(
  doc: ProjectDoc,
  trackId: string,
  fingerprint: string,
): AssetVersion | undefined {
  if (!fingerprint) return undefined;
  return doc.assets.find((a) => a.trackId === trackId && a.fingerprint === fingerprint);
}

export function isBlobReferenced(doc: ProjectDoc, blobKey: string): boolean {
  return (
    doc.assets.some((a) => a.blobKey === blobKey) ||
    doc.tracks.some((t) => t.blobKey === blobKey)
  );
}

// ---------- 事件记录 ----------

function pushEvent(
  doc: ProjectDoc,
  ev: Omit<AssetEvent, 'id' | 'at'> & { at?: number },
): ProjectDoc {
  const event: AssetEvent = {
    id: uid('ev'),
    at: ev.at ?? Date.now(),
    trackId: ev.trackId,
    kind: ev.kind,
    versionId: ev.versionId,
    detail: ev.detail,
  };
  const assetEvents = [...doc.assetEvents, event].slice(-MAX_EVENTS);
  return { ...doc, assetEvents };
}

// ---------- 状态迁移（全部返回新 doc，不修改入参） ----------

/**
 * 登记初始导入的已就绪版本（新文件轨）。
 */
export function registerInitialVersion(doc: ProjectDoc, version: AssetVersion): ProjectDoc {
  const assets = [...doc.assets, version];
  const tracks = doc.tracks.map((t) =>
    t.id === version.trackId
      ? { ...t, activeVersionId: version.id, blobKey: version.blobKey ?? t.blobKey }
      : t,
  );
  return pushEvent({ ...doc, assets, tracks }, {
    trackId: version.trackId,
    kind: 'import',
    versionId: version.id,
    detail: `初始导入：${version.fileName}`,
  });
}

/**
 * 提交换版候选。同一轨道同时只允许一个候选（旧候选被替换并返回以便清理）；
 * 同指纹版本已存在时不制造重复版本。
 */
export function submitCandidate(
  doc: ProjectDoc,
  trackId: string,
  version: AssetVersion,
): { doc: ProjectDoc; dropped?: AssetVersion } {
  if (findVersionByFingerprint(doc, trackId, version.fingerprint)) return { doc };
  const dropped = doc.assets.find((a) => a.trackId === trackId && a.status === 'candidate');
  const assets = doc.assets.filter((a) => a !== dropped).concat(version);
  return {
    doc: pushEvent({ ...doc, assets }, {
      trackId,
      kind: 'submit',
      versionId: version.id,
      detail: `提交候选：${version.fileName}`,
    }),
    dropped,
  };
}

/**
 * 登记失败候选：保留指纹与原因供界面展示，不保存音频 Blob。
 * 同指纹记录已存在时不重复制造。
 */
export function registerFailure(doc: ProjectDoc, trackId: string, version: AssetVersion): ProjectDoc {
  if (findVersionByFingerprint(doc, trackId, version.fingerprint)) return doc;
  return pushEvent({ ...doc, assets: [...doc.assets, version] }, {
    trackId,
    kind: 'fail',
    versionId: version.id,
    detail: `候选失败：${version.fileName} —— ${version.errorMessage ?? '未知原因'}`,
  });
}

/**
 * 原子切换：候选 → 当前版本；原当前版本 → 已取代（保留可回退）。
 * 轨道本身的空间位置/增益/静音/独奏/循环一律不动。
 */
export function applySwitch(
  doc: ProjectDoc,
  trackId: string,
  candidateId: string,
  channel: number,
): ProjectDoc {
  const candidate = doc.assets.find((a) => a.id === candidateId && a.trackId === trackId);
  const track = doc.tracks.find((t) => t.id === trackId);
  if (!candidate || !track || candidate.status !== 'candidate') return doc;
  const now = Date.now();
  const assets = doc.assets.map((a) => {
    if (a.id === candidateId) {
      return { ...a, status: 'ready' as const, channel, note: '换版' };
    }
    if (a.trackId === trackId && a.status === 'ready') {
      return { ...a, status: 'superseded' as const, replacedBy: candidateId, supersededAt: now };
    }
    return a;
  });
  const tracks = doc.tracks.map((t) =>
    t.id === trackId
      ? {
          ...t,
          activeVersionId: candidateId,
          blobKey: candidate.blobKey ?? t.blobKey,
          channel,
          channels: candidate.channels ?? t.channels,
          duration: candidate.duration ?? t.duration,
          originalFileName: candidate.fileName,
          status: 'ready' as const,
          errorMessage: undefined,
        }
      : t,
  );
  return pushEvent({ ...doc, assets, tracks }, {
    trackId,
    kind: 'switch',
    versionId: candidateId,
    detail: `切换到：${candidate.fileName}`,
  });
}

/**
 * 回退到历史版本：目标版本重新成为当前版本（其当初明确选择的原始声道一并恢复），
 * 现版本转为已取代。空间摆位等轨道参数不变。
 */
export function applyRollback(doc: ProjectDoc, trackId: string, versionId: string): ProjectDoc {
  const target = doc.assets.find((a) => a.id === versionId && a.trackId === trackId);
  const track = doc.tracks.find((t) => t.id === trackId);
  if (!target || !track || target.status !== 'superseded') return doc;
  const now = Date.now();
  const current = doc.assets.find((a) => a.trackId === trackId && a.status === 'ready');
  const assets = doc.assets.map((a) => {
    if (a.id === target.id) {
      return { ...a, status: 'ready' as const, replacedBy: undefined, supersededAt: undefined };
    }
    if (current && a.id === current.id) {
      return { ...a, status: 'superseded' as const, replacedBy: target.id, supersededAt: now };
    }
    return a;
  });
  const tracks = doc.tracks.map((t) =>
    t.id === trackId
      ? {
          ...t,
          activeVersionId: target.id,
          blobKey: target.blobKey ?? t.blobKey,
          channel: target.channel,
          channels: target.channels ?? t.channels,
          duration: target.duration ?? t.duration,
          originalFileName: target.fileName,
          status: 'ready' as const,
          errorMessage: undefined,
        }
      : t,
  );
  return pushEvent({ ...doc, assets, tracks }, {
    trackId,
    kind: 'rollback',
    versionId: target.id,
    detail: `回退到：${target.fileName}`,
  });
}

/** 丢弃候选或清除失败记录；返回被移除版本的 blobKey 供调用方做垃圾回收 */
export function discardVersion(
  doc: ProjectDoc,
  versionId: string,
): { doc: ProjectDoc; blobKey?: string } {
  const v = doc.assets.find((a) => a.id === versionId);
  if (!v || (v.status !== 'candidate' && v.status !== 'failed')) return { doc };
  const nd = pushEvent({ ...doc, assets: doc.assets.filter((a) => a.id !== versionId) }, {
    trackId: v.trackId,
    kind: 'discard',
    versionId: v.id,
    detail: `移除${v.status === 'candidate' ? '候选' : '失败记录'}：${v.fileName}`,
  });
  return { doc: nd, blobKey: v.blobKey };
}

/** 用户在当前版本上直接切换 L/R 时，同步写回版本记录（回退一致性） */
export function updateActiveVersionChannel(
  doc: ProjectDoc,
  trackId: string,
  channel: number,
): ProjectDoc {
  const t = doc.tracks.find((x) => x.id === trackId);
  if (!t?.activeVersionId) return doc;
  let changed = false;
  const assets = doc.assets.map((a) => {
    if (a.id === t.activeVersionId && a.channel !== channel) {
      changed = true;
      return { ...a, channel };
    }
    return a;
  });
  return changed ? { ...doc, assets } : doc;
}

/** 解锁解码后回填版本缺失的声道/时长元信息（旧版迁移版本尤其需要） */
export function fillActiveVersionMeta(
  doc: ProjectDoc,
  trackId: string,
  meta: VersionMeta,
): ProjectDoc {
  const t = doc.tracks.find((x) => x.id === trackId);
  if (!t?.activeVersionId) return doc;
  let changed = false;
  const assets = doc.assets.map((a) => {
    if (a.id !== t.activeVersionId) return a;
    const duration = a.duration ?? meta.duration;
    const channels = a.channels ?? meta.channels;
    if (duration === a.duration && channels === a.channels) return a;
    changed = true;
    return { ...a, duration, channels };
  });
  return changed ? { ...doc, assets } : doc;
}

/**
 * 载入会话/工程时的迁移与清理：
 *  - 旧版文档（无 assets）：为每条带 blobKey 的文件轨补一条 ready 版本记录；
 *  - 候选版本只在本次会话内有效（其解码缓冲不持久化），刷新一律作废，
 *    孤儿 Blob 键返回给调用方清理。
 */
export function migrateDoc(raw: ProjectDoc): { doc: ProjectDoc; orphanedBlobKeys: string[] } {
  let assets = raw.assets ?? [];
  const assetEvents = raw.assetEvents ?? [];
  const tracks = raw.tracks.map((t) => {
    if (t.sourceType !== 'file') return t;
    const existing =
      assets.find((a) => a.id === t.activeVersionId) ??
      assets.find((a) => a.trackId === t.id && a.status === 'ready');
    if (existing) {
      return t.activeVersionId
        ? t
        : { ...t, activeVersionId: existing.id, blobKey: existing.blobKey ?? t.blobKey };
    }
    if (!t.blobKey) return t;
    const v: AssetVersion = {
      id: uid('ver'),
      trackId: t.id,
      fingerprint: '',
      blobKey: t.blobKey,
      fileName: t.originalFileName ?? t.name,
      size: 0,
      status: 'ready',
      channel: t.channel,
      channels: t.channels,
      duration: t.duration,
      createdAt: raw.savedAt || Date.now(),
      note: '旧版会话迁移',
    };
    assets = [...assets, v];
    return { ...t, activeVersionId: v.id };
  });
  const dropped = assets.filter((a) => a.status === 'candidate');
  assets = assets.filter((a) => a.status !== 'candidate');
  const doc: ProjectDoc = { ...raw, tracks, assets, assetEvents };
  const orphanedBlobKeys = dropped
    .map((a) => a.blobKey)
    .filter((k): k is string => !!k && !isBlobReferenced(doc, k));
  return { doc, orphanedBlobKeys };
}
