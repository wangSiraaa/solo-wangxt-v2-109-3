/**
 * AudioEngine 素材换版图行为测试（独立假实现，可按 Blob 文本返回不同声道/时长）：
 *  - probeCandidate 只解码缓存，不产生 voice/source（验收④提交候选不产生两个 source）
 *  - 坏候选抛 DecodeError 且当前素材继续可播放（验收②）
 *  - activateTrackVersion 原子换缓冲：播放中仅一个 source、空间摆位等参数沿用新 spec、
 *    不重置全局播放；按解析偏移起播（验收①④）
 *  - 回退到历史版本：从 IDB 注入 Blob 的路径同样工作
 *  - 其他轨完全不受影响
 */
import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';

class FakeAudioParam {
  value: number;
  events: { time: number; value: number; tc: number }[] = [];
  constructor(v: number) {
    this.value = v;
  }
  setTargetAtTime(v: number, time: number, tc: number) {
    this.value = v;
    this.events.push({ time, value: v, tc });
  }
  setValueAtTime(v: number) {
    this.value = v;
  }
}

class FakeNode {
  connects: { node: FakeNode; out?: number; inp?: number }[] = [];
  disconnected = false;
  connect(node: FakeNode | { input?: FakeNode }, out?: number, inp?: number): FakeNode {
    const target = (node as { input?: FakeNode }).input ?? (node as FakeNode);
    this.connects.push({ node: target, out, inp });
    return target;
  }
  disconnect() {
    this.connects = [];
    this.disconnected = true;
  }
}
class FakeGain extends FakeNode {
  gain = new FakeAudioParam(1);
}
class FakeDestination extends FakeNode {}
class FakePanner extends FakeNode {
  panningModel = 'HRTF';
  distanceModel = 'inverse';
  refDistance = 1;
  rolloffFactor = 1;
  maxDistance = 100;
  positionX: FakeAudioParam;
  positionY: FakeAudioParam;
  positionZ: FakeAudioParam;
  constructor(_ctx: unknown, opts: Record<string, unknown> = {}) {
    super();
    Object.assign(this, opts);
    this.positionX = new FakeAudioParam((opts.positionX as number) ?? 0);
    this.positionY = new FakeAudioParam((opts.positionY as number) ?? 0);
    this.positionZ = new FakeAudioParam((opts.positionZ as number) ?? 0);
  }
}
class FakeBufferSource extends FakeNode {
  buffer: { duration: number; numberOfChannels: number } | null = null;
  loop = false;
  started: { time: number; offset: number }[] = [];
  stopped = 0;
  onended: (() => void) | null = null;
  start(time: number, offset = 0) {
    this.started.push({ time, offset });
  }
  stop() {
    this.stopped++;
  }
}
class FakeBuffer {
  duration: number;
  numberOfChannels: number;
  length: number;
  sampleRate: number;
  constructor(ch: number, length: number, sr: number, duration: number) {
    this.numberOfChannels = ch;
    this.length = length;
    this.sampleRate = sr;
    this.duration = duration;
  }
  getChannelData() {
    return new Float32Array(this.length);
  }
}
class FakeSplitter extends FakeNode {
  constructor(public channels: number) {
    super();
  }
}
class FakeAnalyser extends FakeNode {
  fftSize = 2048;
  getFloatTimeDomainData(arr: Float32Array) {
    arr.fill(0);
  }
}
class FakeListener {
  positionX = new FakeAudioParam(0);
  positionY = new FakeAudioParam(0);
  positionZ = new FakeAudioParam(0);
  forwardX = new FakeAudioParam(0);
  forwardY = new FakeAudioParam(0);
  forwardZ = new FakeAudioParam(-1);
  upX = new FakeAudioParam(0);
  upY = new FakeAudioParam(1);
  upZ = new FakeAudioParam(0);
}

// Blob 文本约定：
//  BAD → 解码失败；其余按 "ch:dur" 解析，如 "2:5" = 立体声 5 秒，默认 1 声道 1 秒
class FakeAudioContext {
  state: 'running' | 'suspended' = 'running';
  currentTime = 10;
  destination = new FakeDestination();
  listener = new FakeListener();
  sampleRate = 48000;
  audioWorklet = { addModule: async () => {} };
  createGain() {
    return new FakeGain();
  }
  createBufferSource() {
    return new FakeBufferSource();
  }
  createBuffer(ch: number, length: number, sr: number) {
    return new FakeBuffer(ch, length, sr, length / sr);
  }
  createChannelSplitter(ch: number) {
    return new FakeSplitter(ch);
  }
  createAnalyser() {
    return new FakeAnalyser();
  }
  async resume() {
    this.state = 'running';
  }
  async decodeAudioData(buf: ArrayBuffer): Promise<FakeBuffer> {
    const text = new TextDecoder().decode(buf);
    if (text === 'BAD') throw new Error('EncodingError: fake bad file');
    let ch = 1;
    let dur = 1;
    if (text.includes(':')) {
      const [a, b] = text.split(':');
      ch = Number(a) || 1;
      dur = Number(b) || 1;
    }
    return new FakeBuffer(ch, Math.floor(48000 * dur), 48000, dur);
  }
  async close() {}
}

const g = globalThis as unknown as Record<string, unknown>;
g.AudioContext = FakeAudioContext;
g.requestAnimationFrame = (fn: FrameRequestCallback) => setTimeout(() => fn(0), 16) as unknown as number;
g.cancelAnimationFrame = (id: number) => clearTimeout(id);
g.window = globalThis;
g.PannerNode = FakePanner;

const { AudioEngine, DecodeError } = await import('../src/lib/audioEngine.ts');
import type { Track } from '../src/types.ts';

function blob(text: string): Blob {
  return new Blob([new TextEncoder().encode(text)], { type: 'audio/x' });
}

function fileTrack(id: string, versionId: string, over: Partial<Track> = {}): Track {
  return {
    id,
    name: id,
    sourceType: 'file',
    blobKey: `blob-${versionId}`,
    originalFileName: `${versionId}.wav`,
    versions: [],
    currentVersionId: versionId,
    loop: false,
    muted: false,
    solo: false,
    gain: 0.8,
    channel: 0,
    channels: 1,
    color: '#fff',
    position: { x: 2, y: 0, z: 0 },
    status: 'pending',
    duration: 1,
    ...over,
  };
}

type VoiceInternal = {
  source: FakeBufferSource;
  panner: FakePanner;
  trackGain: FakeGain;
  playing: boolean;
  offset: number;
  buffer: FakeBuffer;
  versionId?: string;
};

function voice(engine: InstanceType<typeof AudioEngine>, id: string): VoiceInternal {
  return (engine as unknown as { voices: Map<string, VoiceInternal> }).voices.get(id)!;
}
function bufferCount(engine: InstanceType<typeof AudioEngine>): number {
  return (engine as unknown as { buffers: Map<string, unknown> }).buffers.size;
}

describe('AudioEngine 素材换版（模拟环境）', () => {
  let engine: InstanceType<typeof AudioEngine>;

  beforeEach(async () => {
    engine = new AudioEngine();
    await engine.resume();
  });
  afterEach(() => engine.dispose());

  it('probeCandidate 只解码候选、缓存结果，绝不创建 voice/source', async () => {
    // 当前轨正在播放（单声道 1s）
    const t = fileTrack('a', 'cur');
    engine.setFileBlob('a', blob('1:1'));
    await engine.ensureTrack(t);
    await engine.playTrack(t);
    const before = voice(engine, 'a').source;
    const startsBefore = before.started.length;

    const meta = await engine.probeCandidate('a', 'cand1', blob('2:5'));
    assert.equal(meta.channels, 2);
    assert.equal(meta.duration, 5);
    assert.equal(meta.sampleRate, 48000);

    // 没有产生第二个 voice / source；当前 source 未被停启
    const after = voice(engine, 'a');
    assert.equal(after.source, before);
    assert.equal(after.source.started.length, startsBefore);
    assert.equal(after.source.stopped, 0);
    assert.equal(engine.hasCandidateBuffer('a', 'cand1'), true);
    // 其他轨不存在任何节点
    assert.equal(voice(engine, 'a').panner.positionX.value, 2);
  });

  it('坏候选解码失败抛 DecodeError 且不留缓存；当前素材继续可播放，其他轨不受影响', async () => {
    const a = fileTrack('a', 'cur', { position: { x: 3, y: 0, z: 0 } });
    const b = fileTrack('b', 'curb');
    engine.setFileBlob('a', blob('1:1'));
    engine.setFileBlob('b', blob('1:1'));
    await engine.ensureTrack(a);
    await engine.ensureTrack(b);
    await engine.playTrack(a);
    await engine.playTrack(b);

    await assert.rejects(
      engine.probeCandidate('a', 'bad', blob('BAD')),
      (err: unknown) => err instanceof DecodeError,
    );
    assert.equal(engine.hasCandidateBuffer('a', 'bad'), false);
    // a、b 仍在播放，且仍是旧缓冲（单声道 1s）
    assert.equal(engine.isPlaying('a'), true);
    assert.equal(engine.isPlaying('b'), true);
    assert.equal(voice(engine, 'a').source.buffer?.duration, 1);
    assert.equal(voice(engine, 'b').source.buffer?.numberOfChannels, 1);
    const buffersBefore = bufferCount(engine);
    assert.ok(buffersBefore >= 2);
  });

  it('播放中确认切换：原子替换为唯一新 source，从解析偏移起播；摆位/增益/M/S 沿用新 spec；不影响全局其他轨', async () => {
    const t = fileTrack('a', 'cur', { gain: 0.6, position: { x: -4, y: 1, z: 2 } });
    const other = fileTrack('o', 'curo', { position: { x: 5, y: 0, z: 0 } });
    engine.setFileBlob('a', blob('1:1'));
    engine.setFileBlob('o', blob('1:1'));
    await engine.ensureTrack(t);
    await engine.ensureTrack(other);
    await engine.playTrack(t);
    await engine.playTrack(other);
    const oldSource = voice(engine, 'a').source;
    const otherSource = voice(engine, 'o').source;

    // 候选先校验（立体声 5s）
    await engine.probeCandidate('a', 'new', blob('2:5'));

    const newTrack = fileTrack('a', 'new', {
      blobKey: 'blob-new',
      channels: 2,
      duration: 5,
      channel: 1,
      gain: 0.6,
      muted: true, // M/S 等参数必须沿用
      position: { x: -4, y: 1, z: 2 },
    });
    const meta = await engine.activateTrackVersion(newTrack, 1.5);
    assert.equal(meta.channels, 2);
    assert.equal(meta.duration, 5);

    const v = voice(engine, 'a');
    assert.notEqual(v.source, oldSource); // 旧 source 已被替换
    assert.equal(oldSource.stopped, 1); // 旧的恰好停一次
    assert.equal(v.versionId, 'new');
    assert.equal(v.buffer.numberOfChannels, 2);
    assert.equal(v.buffer.duration, 5);
    // 播放中 → 新 source 只 start 一次，从用户解析偏移 1.5 起；没有两个 source
    assert.equal(v.source.started.length, 1);
    assert.equal(v.source.started[0].offset, 1.5);
    assert.equal(v.playing, true);
    // 空间摆位等图参数沿用新 spec（未重置）
    assert.equal(v.panner.positionX.value, -4);
    assert.equal(v.panner.positionY.value, 1);
    assert.equal(v.panner.positionZ.value, 2);
    assert.equal(v.trackGain.gain.value, 0); // muted
    // 其他轨完全没动
    assert.equal(voice(engine, 'o').source, otherSource);
    assert.equal(voice(engine, 'o').source.started.length, 1);
    assert.equal(engine.isPlaying('o'), true);
    // 候选缓存已并入当前键，不重复占两份
    assert.equal(engine.hasCandidateBuffer('a', 'new'), false);
  });

  it('暂停态切换：不启动播放，偏移被保留；之后播放从该偏移开始', async () => {
    const t = fileTrack('a', 'cur');
    engine.setFileBlob('a', blob('2:4'));
    await engine.ensureTrack({ ...t, channels: 2, duration: 4 });
    await engine.playTrack({ ...t, channels: 2, duration: 4 });
    engine.pauseTrack({ ...t, channels: 2, duration: 4 });
    // 手动制造暂停偏移 2.0
    voice(engine, 'a').offset = 2;

    await engine.probeCandidate('a', 'new', blob('2:8'));
    const nt = fileTrack('a', 'new', { channels: 2, duration: 8, blobKey: 'blob-new' });
    await engine.activateTrackVersion(nt, 2);
    const v = voice(engine, 'a');
    assert.equal(v.playing, false);
    assert.equal(v.source.started.length, 0);
    assert.equal(v.offset, 2);
    await engine.playTrack(nt);
    assert.equal(v.source.started[v.source.started.length - 1].offset, 2);
  });

  it('回退到历史版本（无候选缓存）：从注入 Blob 解码，旧当前 source 被原子替换', async () => {
    const t = fileTrack('a', 'new', { channels: 2, duration: 5 });
    engine.setFileBlob('a', blob('2:5'));
    await engine.ensureTrack(t);
    assert.equal(voice(engine, 'a').versionId, 'new');

    // 用户刷新后场景：候选缓存不存在，只有 setFileBlob 注入的历史 Blob
    assert.equal(engine.hasCandidateBuffer('a', 'old'), false);
    engine.setFileBlob('a', blob('1:1'));
    const old = fileTrack('a', 'old', { channels: 1, duration: 1, blobKey: 'blob-old', channel: 0 });
    await engine.activateTrackVersion(old, 0);
    const v = voice(engine, 'a');
    assert.equal(v.versionId, 'old');
    assert.equal(v.buffer.numberOfChannels, 1);
    assert.equal(v.buffer.duration, 1);
  });

  it('目标 Blob 解码失败时抛 DecodeError，旧 voice 原样保留（切换不生效）', async () => {
    const t = fileTrack('a', 'cur');
    engine.setFileBlob('a', blob('1:1'));
    await engine.ensureTrack(t);
    await engine.playTrack(t);
    const oldSource = voice(engine, 'a').source;

    engine.setFileBlob('a', blob('BAD'));
    const bad = fileTrack('a', 'broken', { blobKey: 'blob-bad' });
    await assert.rejects(engine.activateTrackVersion(bad, 0), DecodeError);
    const v = voice(engine, 'a');
    assert.equal(v.source, oldSource);
    assert.equal(v.versionId, 'cur');
    assert.equal(v.playing, true);
    assert.equal(engine.isPlaying('a'), true);
  });

  it('removeTrack 清掉该轨当前与全部候选缓冲，不碰别的轨', async () => {
    await engine.probeCandidate('a', 'c1', blob('1:1'));
    await engine.probeCandidate('b', 'c2', blob('1:1'));
    engine.setFileBlob('a', blob('1:1'));
    await engine.ensureTrack(fileTrack('a', 'cur'));
    const n = bufferCount(engine);
    engine.removeTrack('a');
    assert.equal(bufferCount(engine), n - 2); // a 的 current + candidate
    assert.equal(engine.hasCandidateBuffer('b', 'c2'), true);
  });
});
