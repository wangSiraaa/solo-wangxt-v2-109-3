/** 共享类型定义 */

export type DistanceModel = 'exponential' | 'inverse' | 'linear';

export type SourceType = 'file' | 'pulse' | 'tone' | 'duoA' | 'duoB';

export type TrackStatus =
  | 'pending' // 等待音频解锁后解码/生成
  | 'loading'
  | 'ready'
  | 'decode-error';

/**
 * 素材（音频内容）版本状态：
 *  - candidate：已提交、已在浏览器内解码校验，等待用户确认切换；或提交后解码失败（见 failed）
 *  - ready：当前正在试听的版本（每条声轨同一时刻至多一个 ready）
 *  - failed：浏览器解码/兼容性校验失败的候选，旧素材不受影响，记录失败原因可见
 *  - superseded：曾经是当前版本、后来被换版或回退取代；Blob 与元信息保留以便回退
 */
export type AssetVersionStatus = 'candidate' | 'ready' | 'failed' | 'superseded';

/** 换版时新旧素材时长不一致的播放定位策略（必须由用户显式选择，禁止偷偷映射） */
export type PlayPositionMode =
  | 'keep-relative' // 保持当前播放进度，钳制到新素材时长内
  | 'from-start' // 从新素材 0 秒开始
  | 'explicit'; // 用户显式指定秒数

export interface VersionResolution {
  mode: PlayPositionMode;
  /** mode = 'explicit' 时的定位秒数 */
  explicitOffsetSec?: number;
}

/**
 * 一条本地音频素材的具体版本。
 * 同一声轨的多个版本组成素材链；Blob 以 blobKey 存 IndexedDB，
 * 内容相同（指纹相同）的文件在全库范围内复用同一个 Blob，不重复入库。
 */
export interface AssetVersion {
  id: string;
  /** IndexedDB blobs 仓键 */
  blobKey: string;
  /** 内容指纹；sha256:<hex>；v1 工程迁移产物为 unknown:v1:<blobKey>，不参与去重 */
  fingerprint: string;
  fingerprintAlg: 'sha-256' | 'unknown';
  fileName: string;
  fileSize: number;
  fileType: string;
  status: AssetVersionStatus;
  /** 浏览器内解码后的元信息；failed 时可能为 null */
  channels: number | null;
  duration: number | null;
  sampleRate: number | null;
  /** 该版本成为当前版本时显式选择的输入声道（用于回退时恢复“原始 L/R 选择”） */
  selectedChannel?: number;
  /** 失败原因（解码失败/不兼容等），与工程一同持久化 */
  error?: string;
  createdAt: number;
  readyAt?: number;
}

/** 新旧版本兼容性结论；不兼容时 UI 必须要求用户显式处理，不得自动映射 */
export interface VersionCompatibility {
  channelsCompatible: boolean;
  durationCompatible: boolean;
  /** 新 - 旧（秒），无旧版本时为 0 */
  durationDeltaSec: number;
}

export type SwapKind = 'swap' | 'rollback';

/** 换版/回退记录，与项目一同保存在 IndexedDB，构成界面上的“来源链” */
export interface SwapLogEntry {
  id: string;
  at: number;
  kind: SwapKind;
  /** 被取代的版本；首个可用版本取代失败的导入时可能为 null */
  fromVersionId: string | null;
  toVersionId: string;
  fromFingerprint: string | null;
  toFingerprint: string;
  fromFileName: string | null;
  toFileName: string;
  /** 切换后生效的输入声道 */
  channel: number;
  resolution: VersionResolution;
  compatibility: VersionCompatibility;
}

export interface Track {
  id: string;
  name: string;
  sourceType: SourceType;
  /** file 类型时为“当前版本”在 IDB 中的 Blob 键（= currentVersion.blobKey，便于既有逻辑读取） */
  blobKey?: string;
  originalFileName?: string;
  /** file 声轨的素材版本链（候选/当前/失败/已取代），按提交时间从旧到新 */
  versions?: AssetVersion[];
  /** 当前试听版本 id；与状态为 ready 的版本一致 */
  currentVersionId?: string;
  /** 换版/回退历史（来源链），旧到新 */
  swapLog?: SwapLogEntry[];
  loop: boolean;
  muted: boolean;
  solo: boolean;
  /** 推子线性增益（0..1.5），真实进入音频链 */
  gain: number;
  /** 立体声文件选用的输入声道：HRTF 需要单声道输入 */
  channel: number;
  /** 解码后文件的声道数（决定 UI 是否显示 L/R 选择） */
  channels?: number;
  /** UI 颜色 */
  color: string;
  /** 声源世界坐标，单位米，右手系：+X 右，+Y 上，+Z 朝向屏幕（听者后方） */
  position: Vec3;
  status: TrackStatus;
  errorMessage?: string;
  duration?: number;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface ListenerState {
  position: Vec3;
  /** 偏航角（弧度），绕世界 +Y 轴；yaw=0 时朝向 -Z（屏幕内） */
  yaw: number;
  /** 俯仰角（弧度），绕本地右向量，正为向上看 */
  pitch: number;
  /** 听者耳高基准（暂以 position.y 为准，保留字段） */
  earHeight: number;
}

export interface SpatialSettings {
  distanceModel: DistanceModel;
  refDistance: number;
  rolloffFactor: number;
  maxDistance: number;
  /** PannerNode 内部平滑时间（秒），移动时不中断音频 */
  positionTimeConstant: number;
  /** HRTF 内部分辨率（部分浏览器不支持读取/设置则忽略） */
  hrtfIR: 'none';
}

export interface ProjectDoc {
  /** 1：单 Blob 无版本链；2：素材版本链 + 指纹 + 换版记录 */
  version: 1 | 2;
  tracks: Track[];
  listener: ListenerState;
  spatial: SpatialSettings;
  busGain: number;
  masterGain: number;
  savedAt: number;
  name?: string;
}

export interface NamedProject {
  id: string;
  name: string;
  savedAt: number;
  doc: ProjectDoc;
}

export interface LevelState {
  /** 线性峰值 0..1+ */
  l: number;
  r: number;
  /** 锁存的削波标记（任意采样 >= 1.0） */
  clipL: boolean;
  clipR: boolean;
}

export type UnlockState = 'locked' | 'unlocking' | 'unlocked' | 'failed';

export interface ProgressInfo {
  trackId: string;
  current: number;
  duration: number;
}
