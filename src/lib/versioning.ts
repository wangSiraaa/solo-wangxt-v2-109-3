/**
 * 本地音频素材换版（version swap）纯逻辑层。
 *
 * 不接触 Web Audio / IndexedDB / React，全部为可单测的纯函数：
 *  - 内容指纹（SHA-256，浏览器 crypto.subtle；失败时不允许静默当作新文件）
 *  - 声道布局 / 时长兼容性判定
 *  - 版本链查询与“同内容指纹”去重判定
 *  - 换版/回退的纯状态迁移（原子：失败不产生中间态）
 *  - 播放定位解析（不兼容时必须由调用方传入用户显式选择）
 *  - v1 工程（单 Blob、无版本链）迁移
 */
import type {
  AssetVersion,
  ProjectDoc,
  SwapLogEntry,
  Track,
  VersionCompatibility,
  VersionResolution,
} from '../types';

/** 时长兼容性容差：max(250ms, 旧时长 0.5%)，抵抗容器层微小时长差异 */
export function durationToleranceSec(oldDurationSec: number): number {
  return Math.max(0.25, oldDurationSec * 0.005);
}

export function evaluateCompatibility(
  current: Pick<AssetVersion, 'channels' | 'duration'> | null,
  candidate: Pick<AssetVersion, 'channels' | 'duration'>,
): VersionCompatibility {
  if (!current || current.channels == null || current.duration == null) {
    return {
      channelsCompatible: true,
      durationCompatible: true,
      durationDeltaSec: 0,
    };
  }
  const chCur = current.channels;
  const chNew = candidate.channels;
  const dCur = current.duration;
  const dNew = candidate.duration ?? 0;
  return {
    channelsCompatible: chNew === chCur,
    durationCompatible:
      chNew === chCur && Math.abs(dNew - dCur) <= durationToleranceSec(dCur),
    durationDeltaSec: dNew - dCur,
  };
}

/**
 * 声轨范围内查找同内容指纹的既有版本（任意状态，含失败候选以外的全部记录）。
 * 用于验收③：重复选择同一文件不制造多个版本。
 */
export function findSameContentVersion(
  track: Pick<Track, 'versions'>,
  fingerprint: string,
): AssetVersion | null {
  if (!fingerprint.startsWith('sha256:')) return null;
  return track.versions?.find((v) => v.fingerprint === fingerprint) ?? null;
}

export function getCurrentVersion(track: Track): AssetVersion | null {
  if (track.sourceType !== 'file') return null;
  return track.versions?.find((v) => v.id === track.currentVersionId) ?? null;
}

export function getVersion(track: Track, versionId: string): AssetVersion | null {
  return track.versions?.find((v) => v.id === versionId) ?? null;
}

/** 待确认候选（不含失败项） */
export function getPendingCandidates(track: Track): AssetVersion[] {
  return (track.versions ?? []).filter((v) => v.status === 'candidate');
}

/** 失败候选（需可见原因，且永不影响当前素材） */
export function getFailedCandidates(track: Track): AssetVersion[] {
  return (track.versions ?? []).filter((v) => v.status === 'failed');
}

/** 可回退的历史版本（曾就绪、已被取代），新到旧 */
export function getSupersededVersions(track: Track): AssetVersion[] {
  return (track.versions ?? []).filter((v) => v.status === 'superseded').reverse();
}

/** 换版是否需要用户显式处理“原始左/右声道选择” */
export function switchNeedsChannelChoice(
  current: AssetVersion | null,
  target: AssetVersion,
): boolean {
  if (!current || current.channels == null || target.channels == null) return false;
  return current.channels !== target.channels;
}

/** 换版是否需要用户显式处理播放定位（时长不兼容） */
export function switchNeedsPositionChoice(
  current: AssetVersion | null,
  target: AssetVersion,
): boolean {
  if (!current) return false;
  return !evaluateCompatibility(current, target).durationCompatible;
}

/**
 * 解析切换后 source 的起始偏移。
 * 不兼容定位必须显式：from-start / explicit 由用户在 UI 明确选择；
 * keep-relative 仅用于时长兼容的默认路径，或用户在不兼容时主动选择“保持位置（钳制）”。
 */
export function resolveStartOffset(
  prevOffsetSec: number,
  target: Pick<AssetVersion, 'duration'>,
  resolution: VersionResolution,
): number {
  const max = target.duration ?? 0;
  switch (resolution.mode) {
    case 'from-start':
      return 0;
    case 'explicit': {
      const v = resolution.explicitOffsetSec ?? 0;
      return Math.min(Math.max(0, v), max);
    }
    case 'keep-relative':
    default:
      return Math.min(Math.max(0, prevOffsetSec), max);
  }
}

export interface SwitchInput {
  target: AssetVersion;
  /** 切换后该轨使用的输入声道（原始 L/R 选择） */
  channel: number;
  resolution: VersionResolution;
  kind: SwapLogEntry['kind'];
  at: number;
  prevOffsetSec: number;
}

export interface SwitchResult {
  track: Track;
  startOffsetSec: number;
  log: SwapLogEntry;
}

export class VersionSwitchError extends Error {}

/**
 * 原子版本切换（纯函数）：要么返回完整新轨，要么抛错且不修改任何入参。
 *  - 当前版本 → superseded（记录其使用中的声道选择）
 *  - 目标版本（candidate/superseded）→ ready
 *  - 追加换版记录；轨道的 blobKey/文件名/声道/时长随之指向新版本
 */
export function applyVersionSwitch(track: Track, input: SwitchInput): SwitchResult {
  const target = track.versions?.find((v) => v.id === input.target.id);
  if (!target) throw new VersionSwitchError('目标素材版本不存在');
  if (target.status !== 'candidate' && target.status !== 'superseded') {
    throw new VersionSwitchError(`版本状态为 ${target.status}，不可切换`);
  }
  if (target.channels == null || target.duration == null) {
    throw new VersionSwitchError('目标素材尚未通过浏览器解码校验');
  }
  const channel = Math.floor(input.channel);
  if (channel < 0 || channel >= target.channels) {
    throw new VersionSwitchError(`声道选择 ${channel} 超出目标素材范围（${target.channels} 声道）`);
  }

  const current = getCurrentVersion(track);
  const compatibility = evaluateCompatibility(current, target);

  // 深拷贝版本链后再改，保证失败时无中间态
  const versions: AssetVersion[] = (track.versions ?? []).map((v) => ({ ...v }));
  if (current) {
    const cur = versions.find((v) => v.id === current.id)!;
    cur.status = 'superseded';
    cur.selectedChannel = track.channel;
  }
  const tgt = versions.find((v) => v.id === target.id)!;
  tgt.status = 'ready';
  tgt.readyAt = input.at;
  tgt.selectedChannel = channel;
  tgt.error = undefined;

  const log: SwapLogEntry = {
    id: `log-${track.id}-${input.at.toString(36)}-${target.id}`,
    at: input.at,
    kind: input.kind,
    fromVersionId: current?.id ?? null,
    fromFingerprint: current?.fingerprint ?? null,
    fromFileName: current?.fileName ?? null,
    toVersionId: target.id,
    toFingerprint: target.fingerprint,
    toFileName: target.fileName,
    channel,
    resolution: input.resolution,
    compatibility,
  };

  const next: Track = {
    ...track,
    versions,
    currentVersionId: target.id,
    blobKey: target.blobKey,
    originalFileName: target.fileName,
    channel,
    channels: target.channels ?? undefined,
    duration: target.duration ?? undefined,
    swapLog: [...(track.swapLog ?? []), log],
  };

  return {
    track: next,
    startOffsetSec: resolveStartOffset(input.prevOffsetSec, target, input.resolution),
    log,
  };
}

/** 候选解码校验失败：标记 failed 并记录原因；当前版本链不受影响 */
export function markCandidateFailed(track: Track, versionId: string, error: string): Track {
  return {
    ...track,
    versions: track.versions?.map((v) =>
      v.id === versionId && v.status === 'candidate'
        ? { ...v, status: 'failed', error }
        : v,
    ),
  };
}

/** 候选通过浏览器解码：补全声道/时长/采样率元信息 */
export function markCandidateProbed(
  track: Track,
  versionId: string,
  meta: { channels: number; duration: number; sampleRate: number },
): Track {
  return {
    ...track,
    versions: track.versions?.map((v) =>
      v.id === versionId && v.status === 'candidate'
        ? { ...v, channels: meta.channels, duration: meta.duration, sampleRate: meta.sampleRate }
        : v,
    ),
  };
}

/**
 * v1 工程迁移：旧 file 轨只有 blobKey，没有版本链。
 * 补一条“当前版本”（unknown 指纹不参与去重）；解锁后由水合流程重新解码并
 * 按真实结果更新为 ready/failed。
 */
export function migrateDoc(doc: ProjectDoc): ProjectDoc {
  if (doc.version === 2) return doc;
  const tracks = doc.tracks.map((t) => {
    if (t.sourceType !== 'file' || !t.blobKey || t.versions?.length) return t;
    const legacy: AssetVersion = {
      id: `ver-legacy-${t.id}`,
      blobKey: t.blobKey,
      fingerprint: `unknown:v1:${t.blobKey}`,
      fingerprintAlg: 'unknown',
      fileName: t.originalFileName ?? t.name,
      fileSize: 0,
      fileType: '',
      status: 'ready',
      channels: t.channels ?? null,
      duration: t.duration ?? null,
      sampleRate: null,
      selectedChannel: t.channel,
      createdAt: doc.savedAt || 0,
      readyAt: doc.savedAt || 0,
    };
    return {
      ...t,
      versions: [legacy],
      currentVersionId: legacy.id,
    };
  });
  return { ...doc, version: 2, tracks };
}

export function shortFingerprint(fp: string): string {
  if (fp.startsWith('sha256:')) return fp.slice(7, 17);
  if (fp.startsWith('unknown:')) return 'legacy';
  return fp.slice(0, 10);
}

export function formatVersionTime(ms: number): string {
  if (!ms) return '';
  const d = new Date(ms);
  const p = (n: number) => n.toString().padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * 计算内容指纹。必须基于文件全部字节；ArrayBuffer 读取后不影响原 Blob。
 * 返回 sha256:<hex>。crypto.subtle 不可用时抛错——不得静默当作不同文件入库。
 */
export async function computeFingerprint(
  blob: Blob,
): Promise<{ fingerprint: string; alg: 'sha-256' }> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('当前环境不支持 crypto.subtle，无法计算素材内容指纹');
  const buf = await blob.arrayBuffer();
  const digest = await subtle.digest('SHA-256', buf);
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return { fingerprint: `sha256:${hex}`, alg: 'sha-256' };
}
