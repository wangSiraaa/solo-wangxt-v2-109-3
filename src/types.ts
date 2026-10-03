/** 共享类型定义 */

export type DistanceModel = 'exponential' | 'inverse' | 'linear';

export type SourceType = 'file' | 'pulse' | 'tone' | 'duoA' | 'duoB';

export type TrackStatus =
  | 'pending' // 等待音频解锁后解码/生成
  | 'loading'
  | 'ready'
  | 'decode-error';

/** 素材版本状态：候选 → 已就绪（当前试听来源） → 已取代；解码/检查失败 → 失败 */
export type AssetStatus =
  | 'candidate' // 已提交并通过浏览器内解码，等待用户确认切换（或等待明确声道/定位选择）
  | 'ready' // 当前启用版本
  | 'failed' // 解码或兼容性检查失败（只保留记录与原因，不保存音频）
  | 'superseded'; // 已被新版本取代，保留用于回退

/** 换版时的播放定位策略；时长不兼容时必须由用户明确选择，不做隐式映射 */
export type SwitchPositioning =
  | 'restart' // 从头开始
  | 'keep-time' // 保持当前秒位置（超出新时长则截到末尾）
  | 'keep-ratio'; // 保持相对进度比例

/** 一个素材版本：内容指纹 + 声道/时长元信息 + 状态 + 该版本自己的原始声道选择 */
export interface AssetVersion {
  id: string;
  trackId: string;
  /** 内容指纹（SHA-256）；同一轨道内相同指纹只对应一个版本 */
  fingerprint: string;
  /** 内容寻址的 Blob 键（fp-<指纹>）；failed 版本不保存音频 */
  blobKey?: string;
  fileName: string;
  size: number;
  status: AssetStatus;
  /** 浏览器内解码得到的元信息 */
  channels?: number;
  duration?: number;
  sampleRate?: number;
  /** 该版本选定的文件原始输入声道（回退时随版本一并恢复） */
  channel: number;
  errorMessage?: string;
  createdAt: number;
  note: string;
  /** 取代本版本的版本 id（来源链） */
  replacedBy?: string;
  supersededAt?: number;
}

/** 换版/回退/失败事件，随工程一起持久化，界面展示为来源链记录 */
export interface AssetEvent {
  id: string;
  trackId: string;
  at: number;
  kind: 'import' | 'submit' | 'switch' | 'rollback' | 'fail' | 'discard';
  versionId?: string;
  detail?: string;
}

export interface Track {
  id: string;
  name: string;
  sourceType: SourceType;
  /** file 类型时为当前启用版本在 IDB 中的 Blob 键（镜像 activeVersionId 对应版本） */
  blobKey?: string;
  /** 当前启用的素材版本 id；历史版本与候选见 ProjectDoc.assets */
  activeVersionId?: string;
  originalFileName?: string;
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
  version: 1;
  tracks: Track[];
  /** 素材版本链（候选/已就绪/失败/已取代），与工程一同存入 IndexedDB */
  assets: AssetVersion[];
  /** 换版/回退/失败事件记录（来源链） */
  assetEvents: AssetEvent[];
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
