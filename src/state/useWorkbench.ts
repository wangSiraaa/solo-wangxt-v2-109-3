import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AssetVersion,
  LevelState,
  ListenerState,
  NamedProject,
  ProjectDoc,
  SourceType,
  SpatialSettings,
  Track,
  UnlockState,
  VersionResolution,
} from '../types';
import { engine } from '../lib/engineInstance';
import { DecodeError } from '../lib/audioEngine';
import * as idb from '../lib/idb';
import { SAMPLE_LABELS } from '../lib/samples';
import {
  applyVersionSwitch,
  computeFingerprint,
  findSameContentVersion,
  getCurrentVersion,
  markCandidateFailed,
  markCandidateProbed,
  VersionSwitchError,
} from '../lib/versioning';

const COLORS = ['#e8734a', '#4ecdc4', '#ffe066', '#a78bfa', '#f472b6', '#34d399', '#60a5fa'];

const DEFAULT_SPATIAL: SpatialSettings = {
  distanceModel: 'inverse',
  refDistance: 1,
  rolloffFactor: 1,
  maxDistance: 30,
  positionTimeConstant: 0.06,
  hrtfIR: 'none',
};

const DEFAULT_LISTENER: ListenerState = {
  position: { x: 0, y: 0, z: 3 },
  yaw: 0,
  pitch: 0,
  earHeight: 0,
};

let counter = 0;
function uid(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter}`;
}

function sampleTrack(type: Exclude<SourceType, 'file'>, index: number): Track {
  const presets: Record<Exclude<SourceType, 'file'>, Partial<Track> & { position: Track['position'] }> = {
    pulse: { position: { x: -3, y: 0, z: 0 }, loop: true },
    tone: { position: { x: 3, y: 0, z: 0 }, loop: true },
    duoA: { position: { x: -2, y: 0, z: 0 }, loop: true },
    duoB: { position: { x: 2, y: 0, z: 0 }, loop: true },
  };
  const p = presets[type];
  return {
    id: uid('trk'),
    name: SAMPLE_LABELS[type],
    sourceType: type,
    loop: p.loop ?? true,
    muted: false,
    solo: false,
    gain: 0.9,
    channel: 0,
    color: COLORS[index % COLORS.length],
    position: { ...p.position },
    status: 'pending',
  };
}

function emptyDoc(): ProjectDoc {
  return {
    version: 2,
    tracks: [],
    listener: { ...DEFAULT_LISTENER, position: { ...DEFAULT_LISTENER.position } },
    spatial: { ...DEFAULT_SPATIAL },
    busGain: 1,
    masterGain: 0.9,
    savedAt: 0,
  };
}

/** 初次导入 / 换版候选提交的结果；dup 表示同内容指纹已存在，未产生新版本或新 Blob */
export interface SubmitResult {
  kind: 'added' | 'candidate-ready' | 'duplicate' | 'error';
  trackId: string;
  versionId?: string;
  message?: string;
  /** duplicate 时指向既有版本 */
  existingVersionId?: string;
}

export interface WorkbenchApi {
  doc: ProjectDoc;
  unlock: UnlockState;
  unlockError: string | null;
  playingIds: Set<string>;
  levels: LevelState;
  selectedId: string | null;
  projects: NamedProject[];
  loadedProjectId: string | null;
  loadedProjectName: string | null;
  saveState: 'idle' | 'saving' | 'saved';
  globalError: string | null;
  selectTrack: (id: string | null) => void;
  unlockAudio: () => Promise<void>;
  addSample: (type: Exclude<SourceType, 'file'>) => Promise<void>;
  addFiles: (files: FileList | File[]) => Promise<void>;
  removeTrack: (id: string) => Promise<void>;
  updateTrack: (id: string, patch: Partial<Track>) => void;
  moveTrack: (id: string, position: Track['position']) => void;
  setListener: (
    patch:
      | Partial<Omit<ListenerState, 'position'>>
      | { position: Partial<ListenerState['position']> },
  ) => void;
  setSpatial: (patch: Partial<SpatialSettings>) => void;
  setBusGain: (v: number) => void;
  setMasterGain: (v: number) => void;
  play: (id: string) => Promise<void>;
  pause: (id: string) => void;
  stop: (id: string) => void;
  seek: (id: string, offsetSec: number) => Promise<void>;
  togglePlay: (id: string) => Promise<void>;
  playAll: () => Promise<void>;
  stopAll: () => void;
  clearClips: () => void;
  saveProjectAs: (name: string) => Promise<void>;
  loadProject: (id: string) => Promise<void>;
  deleteProject: (id: string) => Promise<void>;
  newProject: () => Promise<void>;
  dismissGlobalError: () => void;

  // ---------- 本地素材换版 ----------
  /** 提交换版候选：算指纹 → 去重 → 入库 Blob → 浏览器内解码校验（不接入该轨） */
  submitCandidate: (trackId: string, file: File) => Promise<SubmitResult>;
  /**
   * 用户确认原子切换。incompatible 时必须显式给出声道选择与播放定位；
   * 播放中调用只在该确认时替换该轨 source，不影响全局播放。
   */
  confirmSwitch: (
    trackId: string,
    versionId: string,
    opts: { channel: number; resolution: VersionResolution },
  ) => Promise<SubmitResult>;
  /** 回退到已取代的历史版本（同样要求显式处理声道/定位，复用原子切换） */
  rollbackVersion: (
    trackId: string,
    versionId: string,
    opts: { channel: number; resolution: VersionResolution },
  ) => Promise<SubmitResult>;
  /** 丢弃失败/候选版本（不影响当前版本与历史回退链其他版本） */
  discardVersion: (trackId: string, versionId: string) => Promise<void>;
}

export function useWorkbench(): WorkbenchApi {
  const [doc, setDoc] = useState<ProjectDoc>(emptyDoc);
  const [unlock, setUnlock] = useState<UnlockState>('locked');
  const [unlockError, setUnlockError] = useState<string | null>(null);
  const [playingIds, setPlayingIds] = useState<Set<string>>(new Set());
  const [levels, setLevels] = useState<LevelState>({ l: 0, r: 0, clipL: false, clipR: false });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [projects, setProjects] = useState<NamedProject[]>([]);
  const [loadedProjectId, setLoadedProjectId] = useState<string | null>(null);
  const [loadedProjectName, setLoadedProjectName] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [globalError, setGlobalError] = useState<string | null>(null);

  const docRef = useRef(doc);
  docRef.current = doc;
  const initDone = useRef(false);

  function patchTrack(id: string, patch: Partial<Track>) {
    setDoc((d) => ({
      ...d,
      tracks: d.tracks.map((t) => (t.id === id ? { ...t, ...patch } : t)),
    }));
  }

  /** 按函数结果替换整条声轨（换版原子状态迁移使用） */
  function replaceTrack(id: string, next: Track) {
    setDoc((d) => ({ ...d, tracks: d.tracks.map((t) => (t.id === id ? next : t)) }));
  }

  // ---------- 初始化：恢复会话与工程列表，绝不自动播放 ----------
  useEffect(() => {
    // React StrictMode 会双重挂载；用标志保证只加载一次，cancelled 只阻止写状态
    if (initDone.current) return;
    initDone.current = true;
    let cancelled = false;
    (async () => {
      try {
        const [session, list] = await Promise.all([idb.loadSession(), idb.listProjects()]);
        if (cancelled) return;
        if (list) setProjects(list);
        if (session) {
          // 恢复全部参数，但播放状态一律归零（不擅自自动播放）。
          // 文件轨标记 pending，待音频解锁后按当前版本重新注入 Blob 解码。
          setDoc({
            ...session,
            tracks: session.tracks.map((t) => ({
              ...t,
              status: 'pending',
              errorMessage: undefined,
            })),
          });
        }
      } catch (err) {
        if (!cancelled) {
          setGlobalError(`读取本地工程失败：${err instanceof Error ? err.message : String(err)}`);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ---------- 引擎事件订阅 ----------
  useEffect(() => engine.onUnlock(setUnlock), []);
  useEffect(() => engine.onLevels(setLevels), []);

  useEffect(() => {
    return engine.onEnded((trackId) => {
      setPlayingIds((prev) => {
        if (!prev.has(trackId)) return prev;
        const next = new Set(prev);
        next.delete(trackId);
        return next;
      });
    });
  }, []);

  // ---------- 全局参数同步到音频链 ----------
  useEffect(() => {
    engine.setSpatialSettings(doc.spatial);
  }, [doc.spatial]);

  useEffect(() => {
    engine.setListener(doc.listener);
  }, [doc.listener]);

  useEffect(() => {
    engine.setBusGain(doc.busGain);
  }, [doc.busGain]);

  useEffect(() => {
    engine.setMasterGain(doc.masterGain);
  }, [doc.masterGain]);

  // 声轨任意参数（位置/增益/静音/独奏/loop）实时同步到音频链：
  // syncTracks 只更新 AudioParam 与路由，不重建 source，移动不会重启音轨
  useEffect(() => {
    engine.syncTracks(doc.tracks);
  }, [doc.tracks]);

  /**
   * 解锁后 / 载入工程后水合全部声轨：
   *  - file 轨按“当前版本”的 blobKey 注入 Blob 并解码；失败只标记该轨，不影响其他轨
   *  - 内置样例即时合成
   *  - 绝不启动播放
   */
  const hydrateTracks = useCallback(async (tracks: Track[]) => {
    if (engine.unlock !== 'unlocked') return;
    for (const t of tracks) {
      if (t.sourceType === 'file') {
        const cur = getCurrentVersion(t);
        const key = cur?.blobKey ?? t.blobKey;
        if (!key) {
          // 没有当前版本（如初次导入即解码失败）：保持错误态，不可试听
          patchTrack(t.id, { status: 'decode-error', errorMessage: '无可用素材版本' });
          continue;
        }
        try {
          const blob = await idb.getBlob(key);
          if (blob) engine.setFileBlob(t.id, blob);
          else {
            patchTrack(t.id, { status: 'decode-error', errorMessage: '本地音频 Blob 缺失' });
            continue;
          }
        } catch {
          patchTrack(t.id, { status: 'decode-error', errorMessage: '读取本地音频失败' });
          continue;
        }
      }
      try {
        await engine.ensureTrack(t);
        if (!docRef.current.tracks.some((x) => x.id === t.id)) {
          engine.removeTrack(t.id);
          continue;
        }
        const dur = engine.getDuration(t.id);
        const ch = engine.getChannelCount(t.id);
        const cur = getCurrentVersion(t);
        let versions = t.versions;
        if (cur && cur.fingerprintAlg === 'unknown') {
          // 当前版本元信息（迁移自 v1 的 unknown 版本）借真实解码结果补全
          versions = versions?.map((v) =>
            v.id === cur.id
              ? { ...v, status: 'ready' as const, channels: ch ?? v.channels, duration: dur ?? v.duration }
              : v,
          );
        }
        patchTrack(t.id, {
          status: 'ready',
          errorMessage: undefined,
          duration: dur ?? t.duration,
          channels: ch ?? t.channels,
          versions,
        });
      } catch (err) {
        if (!docRef.current.tracks.some((x) => x.id === t.id)) continue;
        if (err instanceof DecodeError) {
          patchTrack(t.id, { status: 'decode-error', errorMessage: err.message });
        }
      }

      // 刷新前正处于“已提交、未完成浏览器解码”的候选：恢复后重新校验或标记失败，
      // 避免界面永远停在“校验中…”。失败候选不动（原因已持久化）。
      const fresh = docRef.current.tracks.find((x) => x.id === t.id);
      const unprobed =
        fresh?.versions?.filter((v) => v.status === 'candidate' && v.channels == null) ?? [];
      for (const v of unprobed) {
        try {
          const blob = await idb.getBlob(v.blobKey);
          if (!blob) throw new Error('候选素材 Blob 缺失');
          const meta = await engine.probeCandidate(t.id, v.id, blob);
          const latest = docRef.current.tracks.find((x) => x.id === t.id);
          if (latest) patchTrack(t.id, { versions: latest.versions?.map((x) => (x.id === v.id ? { ...x, ...meta } : x)) });
        } catch (e) {
          const reason = e instanceof Error ? e.message : String(e);
          const latest = docRef.current.tracks.find((x) => x.id === t.id);
          if (latest) {
            patchTrack(t.id, {
              versions: latest.versions?.map((x) =>
                x.id === v.id && x.status === 'candidate'
                  ? { ...x, status: 'failed' as const, error: reason }
                  : x,
              ),
            });
          }
          engine.dropCandidate(t.id, v.id);
        }
      }
    }
  }, []);

  // ---------- 解锁后：同步全部声轨（解码/合成 + 参数），但不播放 ----------
  useEffect(() => {
    if (unlock !== 'unlocked') return;
    (async () => {
      // 先把当前全局参数推入音频图（恢复工程后这些 effect 不会因解锁而重跑）
      engine.setSpatialSettings(docRef.current.spatial);
      engine.setListener(docRef.current.listener);
      engine.setBusGain(docRef.current.busGain);
      engine.setMasterGain(docRef.current.masterGain);
      await hydrateTracks(docRef.current.tracks);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unlock]);

  // ---------- 自动保存会话（参数，不保存播放状态），防抖 ----------
  const saveTimer = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!initDone.current) return;
    setSaveState('saving');
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(async () => {
      const snapshot: ProjectDoc = {
        ...docRef.current,
        savedAt: Date.now(),
      };
      try {
        await idb.saveSession(snapshot);
        setSaveState('saved');
        window.setTimeout(() => setSaveState('idle'), 1200);
      } catch {
        setSaveState('idle');
      }
    }, 500);
    return () => window.clearTimeout(saveTimer.current);
  }, [doc]);

  const selectTrack = useCallback((id: string | null) => setSelectedId(id), []);

  const unlockAudio = useCallback(async () => {
    setUnlockError(null);
    try {
      await engine.resume();
    } catch (err) {
      setUnlockError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const addSample = useCallback(async (type: Exclude<SourceType, 'file'>) => {
    if (engine.unlock !== 'unlocked') {
      // 解锁失败时不继续；用户在遮罩上能看到明确错误
      await unlockAudio();
      if ((engine.unlock as UnlockState) !== 'unlocked') return;
    }
    const track = sampleTrack(type, docRef.current.tracks.length);
    setDoc((d) => ({ ...d, tracks: [...d.tracks, track] }));
    if (engine.unlock === 'unlocked') {
      try {
        await engine.ensureTrack(track);
        const dur = engine.getDuration(track.id);
        const ch = engine.getChannelCount(track.id);
        patchTrack(track.id, {
          status: 'ready',
          duration: dur ?? undefined,
          channels: ch ?? undefined,
        });
      } catch {
        patchTrack(track.id, { status: 'decode-error', errorMessage: '样例合成失败' });
      }
    }
    setSelectedId(track.id);
  }, [unlock, unlockAudio]);

  /**
   * 初次导入本地文件（新声轨）。
   * 与换版同一套管线：指纹 → 全库去重 Blob → 解码校验 → ready。
   * 解码失败也保留该声轨与 failed 版本（原因可见），不影响其他轨（验收②）。
   */
  const addFiles = useCallback(
    async (files: FileList | File[]) => {
      const arr = [...files];
      if (arr.length === 0) return;
      if (engine.unlock !== 'unlocked') {
        await unlockAudio();
        if ((engine.unlock as UnlockState) !== 'unlocked') return;
      }
      for (let i = 0; i < arr.length; i++) {
        const file = arr[i];
        const idx = docRef.current.tracks.length + i;
        const trackId = uid('trk');
        const versionId = uid('ver');

        let fingerprint = '';
        let alg: 'sha-256' = 'sha-256';
        try {
          const fp = await computeFingerprint(file);
          fingerprint = fp.fingerprint;
          alg = fp.alg;
        } catch (err) {
          setGlobalError(`无法为「${file.name}」计算内容指纹：${err instanceof Error ? err.message : String(err)}`);
          continue;
        }

        // 全库（跨声轨/工程）同内容指纹复用 Blob，不重复占空间。
        // 写不进 IndexedDB 就不建立版本（否则刷新后素材丢失），直接报错跳过。
        const preferredBlobKey = uid('blob');
        let blobKey: string;
        try {
          ({ blobKey } = await idb.putBlobWithFingerprint(fingerprint, preferredBlobKey, file));
        } catch (err) {
          setGlobalError(
            `「${file.name}」写入本地 IndexedDB 失败（浏览器存储可能已满）：${err instanceof Error ? err.message : String(err)}`,
          );
          continue;
        }

        const version: AssetVersion = {
          id: versionId,
          blobKey,
          fingerprint,
          fingerprintAlg: alg,
          fileName: file.name,
          fileSize: file.size,
          fileType: file.type,
          status: 'candidate',
          channels: null,
          duration: null,
          sampleRate: null,
          createdAt: Date.now(),
        };
        const track: Track = {
          id: trackId,
          name: file.name,
          sourceType: 'file',
          versions: [version],
          currentVersionId: undefined, // 校验通过、原子激活后才指向该版本
          loop: false,
          muted: false,
          solo: false,
          gain: 0.9,
          channel: 0,
          color: COLORS[idx % COLORS.length],
          position: {
            x: Math.cos((idx * 2 * Math.PI) / Math.max(arr.length, 1)) * 2.5,
            y: 0,
            z: Math.sin((idx * 2 * Math.PI) / Math.max(arr.length, 1)) * 2.5,
          },
          status: 'loading',
        };
        setDoc((d) => ({ ...d, tracks: [...d.tracks, track] }));

        // 浏览器内解码校验（新轨没有“当前素材”，probe 不接触任何 voice）
        try {
          const meta = await engine.probeCandidate(trackId, versionId, file);
          // 校验通过 → 原子激活为首版本（相对偏移 0，即从头；新轨无播放态）
          const probed = markCandidateProbed(track, versionId, meta);
          const v = probed.versions!.find((x) => x.id === versionId)!;
          const switched = applyVersionSwitch(probed, {
            target: v,
            channel: 0,
            resolution: { mode: 'from-start' },
            kind: 'swap',
            at: Date.now(),
            prevOffsetSec: 0,
          });
          // 引擎侧建立节点（不播放）
          engine.setFileBlob(trackId, file);
          await engine.activateTrackVersion(switched.track, 0);
          const finalTrack: Track = {
            ...switched.track,
            status: 'ready',
            channels: meta.channels,
            duration: meta.duration,
          };
          replaceTrack(trackId, finalTrack);
          setSelectedId(trackId);
        } catch (err) {
          // 坏文件/解码失败：保留 failed 版本与原因；该轨无法试听但其他轨不受影响
          const reason = err instanceof Error ? err.message : String(err);
          const latest = docRef.current.tracks.find((x) => x.id === trackId) ?? track;
          const failed = markCandidateFailed(latest, versionId, reason);
          replaceTrack(trackId, {
            ...failed,
            status: 'decode-error',
            errorMessage: reason,
          });
          engine.dropCandidate(trackId, versionId);
        }
      }
    },
    [unlock, unlockAudio],
  );

  const removeTrack = useCallback(async (id: string) => {
    const t = docRef.current.tracks.find((x) => x.id === id);
    engine.removeTrack(id);
    // 仅删除“没有被其他声轨引用”的 Blob；同内容指纹跨轨复用时保留
    if (t?.versions?.length) {
      const otherTrackKeys = new Set(
        docRef.current.tracks
          .filter((x) => x.id !== id && x.sourceType === 'file')
          .flatMap((x) => (x.versions ?? []).map((v) => v.blobKey)),
      );
      for (const v of t.versions) {
        if (!otherTrackKeys.has(v.blobKey)) {
          try {
            await idb.deleteBlob(v.blobKey);
          } catch {
            /* 忽略清理失败 */
          }
          try {
            await idb.deleteDanglingBlobIndex(v.fingerprint, v.blobKey);
          } catch {
            /* ignore */
          }
        }
      }
    }
    setPlayingIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    setDoc((d) => ({ ...d, tracks: d.tracks.filter((x) => x.id !== id) }));
    setSelectedId((cur) => (cur === id ? null : cur));
  }, []);

  const updateTrack = useCallback(
    (id: string, patch: Partial<Track>) => {
      const prev = docRef.current.tracks.find((x) => x.id === id);
      patchTrack(id, patch);
      // 切换所选输入声道需要重建输入图（splitter 接线改变）
      if (
        prev &&
        patch.channel !== undefined &&
        patch.channel !== prev.channel &&
        engine.unlock === 'unlocked'
      ) {
        const merged: Track = { ...prev, ...patch };
        void engine.rebuildVoiceGraph(merged).catch((err) => {
          if (err instanceof DecodeError) {
            patchTrack(id, { status: 'decode-error', errorMessage: err.message });
          }
        });
      }
    },
    [],
  );

  const moveTrack = useCallback((id: string, position: Track['position']) => {
    setDoc((d) => ({
      ...d,
      tracks: d.tracks.map((t) => (t.id === id ? { ...t, position: { ...position } } : t)),
    }));
  }, []);

  const setListener = useCallback(
    (patch: Partial<ListenerState> | { position: Partial<ListenerState['position']> }) => {
      setDoc((d) => {
        if ('position' in patch) {
          return {
            ...d,
            listener: {
              ...d.listener,
              position: { ...d.listener.position, ...(patch as { position: Partial<ListenerState['position']> }).position },
            },
          };
        }
        return { ...d, listener: { ...d.listener, ...(patch as Partial<ListenerState>) } };
      });
    },
    [],
  );

  const setSpatial = useCallback((patch: Partial<SpatialSettings>) => {
    setDoc((d) => ({ ...d, spatial: { ...d.spatial, ...patch } }));
  }, []);

  const setBusGain = useCallback((v: number) => {
    setDoc((d) => ({ ...d, busGain: v }));
  }, []);

  const setMasterGain = useCallback((v: number) => {
    setDoc((d) => ({ ...d, masterGain: v }));
  }, []);

  // ---------- 素材换版 ----------

  const submitCandidate = useCallback(
    async (trackId: string, file: File): Promise<SubmitResult> => {
      const track = docRef.current.tracks.find((x) => x.id === trackId);
      if (!track || track.sourceType !== 'file') {
        return { kind: 'error', trackId, message: '目标声轨不存在或不是本地文件轨' };
      }
      if (engine.unlock !== 'unlocked') {
        await unlockAudio();
        if ((engine.unlock as UnlockState) !== 'unlocked') {
          return { kind: 'error', trackId, message: '音频未解锁，无法在浏览器内校验候选素材' };
        }
      }

      // 1) 内容指纹（全字节）
      let fingerprint = '';
      try {
        fingerprint = (await computeFingerprint(file)).fingerprint;
      } catch (err) {
        return {
          kind: 'error',
          trackId,
          message: `内容指纹计算失败：${err instanceof Error ? err.message : String(err)}`,
        };
      }

      // 2) 同一声轨内同内容指纹 → 不制造新版本、不重复 Blob（验收③）
      const same = findSameContentVersion(track, fingerprint);
      if (same) {
        return {
          kind: 'duplicate',
          trackId,
          versionId: same.id,
          existingVersionId: same.id,
          message:
            same.status === 'ready'
              ? '该文件与当前试听版本内容完全相同（指纹一致）'
              : `该文件与既有版本「${same.fileName}」内容完全相同（指纹一致），未重复入库`,
        };
      }

      const versionId = uid('ver');

      // 3) 全库去重入库 Blob（跨轨/跨工程同指纹共用一份）
      let blobKey = uid('blob');
      try {
        const r = await idb.putBlobWithFingerprint(fingerprint, blobKey, file);
        blobKey = r.blobKey;
      } catch (err) {
        return {
          kind: 'error',
          trackId,
          message: `音频写入本地 IndexedDB 失败：${err instanceof Error ? err.message : String(err)}`,
        };
      }

      // 4) 建立 candidate（尚未解码：元信息为空），当前试听素材完全不动
      const version: AssetVersion = {
        id: versionId,
        blobKey,
        fingerprint,
        fingerprintAlg: 'sha-256',
        fileName: file.name,
        fileSize: file.size,
        fileType: file.type,
        status: 'candidate',
        channels: null,
        duration: null,
        sampleRate: null,
        createdAt: Date.now(),
      };
      replaceTrack(trackId, { ...track, versions: [...(track.versions ?? []), version] });

      // 5) 浏览器内解码 + 兼容性检查；不接入该轨任何节点（验收④）
      try {
        const meta = await engine.probeCandidate(trackId, versionId, file);
        const latest = docRef.current.tracks.find((x) => x.id === trackId);
        if (!latest || !latest.versions?.some((v) => v.id === versionId)) {
          engine.dropCandidate(trackId, versionId);
          return { kind: 'error', trackId, message: '声轨在校验期间被移除' };
        }
        replaceTrack(trackId, markCandidateProbed(latest, versionId, meta));
        return {
          kind: 'candidate-ready',
          trackId,
          versionId,
          message: `候选素材已通过浏览器解码校验（${meta.channels} 声道 / ${meta.duration.toFixed(2)} 秒）`,
        };
      } catch (err) {
        // 失败候选：旧素材继续可播放，原因可见（验收②）
        const reason = err instanceof Error ? err.message : String(err);
        const latest = docRef.current.tracks.find((x) => x.id === trackId);
        if (latest) replaceTrack(trackId, markCandidateFailed(latest, versionId, reason));
        engine.dropCandidate(trackId, versionId);
        return { kind: 'error', trackId, versionId, message: reason };
      }
    },
    [unlockAudio],
  );

  /** 确认切换/回退共用实现（原子：引擎替换成功后才提交状态） */
  const performSwitch = useCallback(
    async (
      trackId: string,
      versionId: string,
      opts: { channel: number; resolution: VersionResolution },
      kind: 'swap' | 'rollback',
    ): Promise<SubmitResult> => {
      // 仅做同步前置校验；真正的状态迁移在所有 await 之后基于“最新 doc”执行，
      // 避免候选提交后用户对增益/摆位等的编辑在切换提交时被旧快照回退（验收①）。
      const validate = (): { ok: true; track: Track; target: AssetVersion } | { ok: false; message: string } => {
        const track = docRef.current.tracks.find((x) => x.id === trackId);
        if (!track) return { ok: false, message: '声轨不存在' };
        const target = track.versions?.find((v) => v.id === versionId);
        if (!target) return { ok: false, message: '目标版本不存在' };
        if (target.status !== 'candidate' && target.status !== 'superseded') {
          return { ok: false, message: '该版本不是可切换的候选/历史版本' };
        }
        if (target.channels == null || target.duration == null) {
          return { ok: false, message: '目标素材尚未通过浏览器解码校验' };
        }
        // 声道布局不兼容时的“显式原始 L/R 选择”由 UI 强制；
        // 这里再兜底校验声道范围（越界直接拒绝，绝不自动映射/下混）。
        if (opts.channel < 0 || opts.channel >= target.channels) {
          return {
            ok: false,
            message: `新素材为 ${target.channels} 声道，请明确选择要使用的原始声道后再切换`,
          };
        }
        if (engine.unlock !== 'unlocked') return { ok: false, message: '音频未解锁，无法切换素材' };
        return { ok: true, track, target };
      };

      const first = validate();
      if (!first.ok) return { kind: 'error', trackId, message: first.message };

      // 回退到历史版本（候选缓存已不在）：先把 Blob 注入引擎；这一过程不触碰当前 voice
      if (!engine.hasCandidateBuffer(trackId, versionId)) {
        const blob = await idb.getBlob(first.target.blobKey);
        if (!blob) {
          return { kind: 'error', trackId, message: '目标素材 Blob 在本地库中缺失，无法切换' };
        }
        engine.setFileBlob(trackId, blob);
      }

      // 所有异步完成后，基于最新状态计算原子迁移
      const now = validate();
      if (!now.ok) return { kind: 'error', trackId, message: now.message };

      let switched: ReturnType<typeof applyVersionSwitch>;
      try {
        switched = applyVersionSwitch(now.track, {
          target: now.target,
          channel: opts.channel,
          resolution: opts.resolution,
          kind,
          at: Date.now(),
          prevOffsetSec: engine.getProgress(trackId) ?? 0,
        });
      } catch (err) {
        return {
          kind: 'error',
          trackId,
          message: err instanceof VersionSwitchError ? err.message : String(err),
        };
      }

      // 引擎原子替换：解码发生在替换之前；若解码失败则旧 voice 完全不动。
      // 节点替换（停旧 source → 建 → 起播）在同一 JS 轮次内完成。
      try {
        await engine.activateTrackVersion(switched.track, switched.startOffsetSec);
      } catch (err) {
        return {
          kind: 'error',
          trackId,
          message: `切换未生效：${err instanceof Error ? err.message : String(err)}`,
        };
      }

      // 成功后原子提交新状态；播放态以引擎实际为准（仅该轨可能变化）
      replaceTrack(trackId, {
        ...switched.track,
        status: 'ready',
        errorMessage: undefined,
        channels: now.target.channels ?? undefined,
        duration: now.target.duration ?? undefined,
      });
      const stillPlaying = engine.isPlaying(trackId);
      setPlayingIds((prev) => {
        const next = new Set(prev);
        if (stillPlaying) next.add(trackId);
        else next.delete(trackId);
        return next;
      });
      return {
        kind: 'candidate-ready',
        trackId,
        versionId,
        message: kind === 'rollback' ? '已回退到历史版本' : '已切换到新版本',
      };
    },
    [],
  );

  const confirmSwitch = useCallback(
    (trackId: string, versionId: string, opts: { channel: number; resolution: VersionResolution }) =>
      performSwitch(trackId, versionId, opts, 'swap'),
    [performSwitch],
  );

  const rollbackVersion = useCallback(
    (trackId: string, versionId: string, opts: { channel: number; resolution: VersionResolution }) =>
      performSwitch(trackId, versionId, opts, 'rollback'),
    [performSwitch],
  );

  const discardVersion = useCallback(
    async (trackId: string, versionId: string) => {
      const track = docRef.current.tracks.find((x) => x.id === trackId);
      if (!track) return;
      const v = track.versions?.find((x) => x.id === versionId);
      if (!v || (v.status !== 'candidate' && v.status !== 'failed')) return; // 历史版本保留供回退
      engine.dropCandidate(trackId, versionId);
      setDoc((d) => ({
        ...d,
        tracks: d.tracks.map((t) =>
          t.id === trackId
            ? { ...t, versions: (t.versions ?? []).filter((x) => x.id !== versionId) }
            : t,
        ),
      }));
      // Blob 若无人引用则清理（同指纹被其他版本/声轨引用时保留）
      const stillReferenced = docRef.current.tracks.some((x) =>
        x.id === trackId
          ? (x.versions ?? [])
              .filter((z) => z.id !== versionId)
              .some((z) => z.blobKey === v.blobKey)
          : (x.versions ?? []).some((z) => z.blobKey === v.blobKey),
      );
      if (!stillReferenced) {
        try {
          await idb.deleteBlob(v.blobKey);
          await idb.deleteDanglingBlobIndex(v.fingerprint, v.blobKey);
        } catch {
          /* 忽略清理失败 */
        }
      }
    },
    [],
  );

  // ---------- 传输 ----------
  const play = useCallback(
    async (id: string) => {
      if (engine.unlock !== 'unlocked') await unlockAudio();
      const t = docRef.current.tracks.find((x) => x.id === id);
      if (!t || t.status === 'decode-error') return;
      try {
        await engine.playTrack(t);
        setPlayingIds((prev) => {
          const next = new Set(prev);
          next.add(id);
          return next;
        });
      } catch (err) {
        if (err instanceof DecodeError) {
          patchTrack(id, { status: 'decode-error', errorMessage: err.message });
        } else {
          setGlobalError(err instanceof Error ? err.message : String(err));
        }
      }
    },
    [unlockAudio],
  );

  const pause = useCallback((id: string) => {
    const t = docRef.current.tracks.find((x) => x.id === id);
    if (!t) return;
    engine.pauseTrack(t);
    setPlayingIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const stop = useCallback((id: string) => {
    const t = docRef.current.tracks.find((x) => x.id === id);
    if (!t) return;
    engine.stopTrack(t);
    setPlayingIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const seek = useCallback(
    async (id: string, offsetSec: number) => {
      const t = docRef.current.tracks.find((x) => x.id === id);
      if (!t) return;
      const wasPlaying = engine.isPlaying(id);
      await engine.seekTrack(t, offsetSec, wasPlaying);
      setPlayingIds((prev) => {
        const next = new Set(prev);
        if (wasPlaying) next.add(id);
        else next.delete(id);
        return next;
      });
    },
    [],
  );

  const togglePlay = useCallback(
    async (id: string) => {
      if (engine.isPlaying(id)) pause(id);
      else await play(id);
    },
    [pause, play],
  );

  const playAll = useCallback(async () => {
    if (engine.unlock !== 'unlocked') await unlockAudio();
    for (const t of docRef.current.tracks) {
      if (t.status === 'decode-error') continue;
      try {
        await engine.playTrack(t);
        setPlayingIds((prev) => new Set(prev).add(t.id));
      } catch (err) {
        if (err instanceof DecodeError) {
          patchTrack(t.id, { status: 'decode-error', errorMessage: err.message });
        }
      }
    }
  }, [unlockAudio]);

  const stopAll = useCallback(() => {
    for (const t of docRef.current.tracks) engine.stopTrack(t);
    setPlayingIds(new Set());
  }, []);

  const clearClips = useCallback(() => {
    engine.clearClipLatch();
    setLevels((l) => ({ ...l, clipL: false, clipR: false }));
  }, []);

  // ---------- 具名工程 ----------
  const refreshProjects = useCallback(async () => {
    setProjects(await idb.listProjects());
  }, []);

  const saveProjectAs = useCallback(
    async (name: string) => {
      const id = loadedProjectId ?? uid('proj');
      const named: NamedProject = {
        id,
        name: name.trim() || `工程 ${new Date().toLocaleString()}`,
        savedAt: Date.now(),
        doc: { ...docRef.current, savedAt: Date.now() },
      };
      await idb.saveProject(named);
      setLoadedProjectId(id);
      setLoadedProjectName(named.name);
      await refreshProjects();
    },
    [loadedProjectId, refreshProjects],
  );

  const loadProject = useCallback(
    async (id: string) => {
      const p = await idb.getProject(id);
      if (!p) return;
      // 先拆除当前声轨节点
      for (const t of docRef.current.tracks) engine.removeTrack(t.id);
      setPlayingIds(new Set());
      const restored: ProjectDoc = {
        ...p.doc, // getProject 已迁移到 v2（版本链齐全）
        tracks: p.doc.tracks.map((t) => ({
          ...t,
          // 恢复工程绝不自动播放；文件轨等待当前版本 Blob 注入解码
          status: 'pending' as const,
          errorMessage: undefined,
        })),
      };
      setDoc(restored);
      setLoadedProjectId(p.id);
      setLoadedProjectName(p.name);
      setSelectedId(null);
      await hydrateTracks(restored.tracks);
    },
    [hydrateTracks],
  );

  const deleteProject = useCallback(
    async (id: string) => {
      await idb.deleteProject(id);
      if (loadedProjectId === id) {
        setLoadedProjectId(null);
        setLoadedProjectName(null);
      }
      await refreshProjects();
    },
    [loadedProjectId, refreshProjects],
  );

  const newProject = useCallback(async () => {
    for (const t of docRef.current.tracks) engine.removeTrack(t.id);
    setPlayingIds(new Set());
    setDoc(emptyDoc());
    setLoadedProjectId(null);
    setLoadedProjectName(null);
    setSelectedId(null);
  }, []);

  const dismissGlobalError = useCallback(() => setGlobalError(null), []);

  const api = useMemo<WorkbenchApi>(
    () => ({
      doc,
      unlock,
      unlockError,
      playingIds,
      levels,
      selectedId,
      projects,
      loadedProjectId,
      loadedProjectName,
      saveState,
      globalError,
      selectTrack,
      unlockAudio,
      addSample,
      addFiles,
      removeTrack,
      updateTrack,
      moveTrack,
      setListener,
      setSpatial,
      setBusGain,
      setMasterGain,
      play,
      pause,
      stop,
      seek,
      togglePlay,
      playAll,
      stopAll,
      clearClips,
      saveProjectAs,
      loadProject,
      deleteProject,
      newProject,
      dismissGlobalError,
      submitCandidate,
      confirmSwitch,
      rollbackVersion,
      discardVersion,
    }),
    [
      doc,
      unlock,
      unlockError,
      playingIds,
      levels,
      selectedId,
      projects,
      loadedProjectId,
      loadedProjectName,
      saveState,
      globalError,
      selectTrack,
      unlockAudio,
      addSample,
      addFiles,
      removeTrack,
      updateTrack,
      moveTrack,
      setListener,
      setSpatial,
      setBusGain,
      setMasterGain,
      play,
      pause,
      stop,
      seek,
      togglePlay,
      playAll,
      stopAll,
      clearClips,
      saveProjectAs,
      loadProject,
      deleteProject,
      newProject,
      dismissGlobalError,
      submitCandidate,
      confirmSwitch,
      rollbackVersion,
      discardVersion,
    ],
  );

  return api;
}
