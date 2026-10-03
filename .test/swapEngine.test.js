var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/lib/spatial.ts
function forwardVector(yaw, pitch = 0) {
  return {
    x: Math.sin(yaw) * Math.cos(pitch),
    y: Math.sin(pitch),
    z: -Math.cos(yaw) * Math.cos(pitch)
  };
}
var init_spatial = __esm({
  "src/lib/spatial.ts"() {
    "use strict";
  }
});

// src/lib/samples.ts
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = a + 1831565813 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function createPulseBuffer(ctx) {
  const sr = ctx.sampleRate;
  const dur = 1.6;
  const buf = ctx.createBuffer(1, Math.floor(sr * dur), sr);
  const data = buf.getChannelData(0);
  const pulseStarts = [0.05, 0.55, 1.05];
  for (const start of pulseStarts) {
    const s0 = Math.floor(start * sr);
    const n = Math.floor(0.05 * sr);
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const env = Math.pow(1 - i / n, 1.6);
      data[s0 + i] = Math.sin(2 * Math.PI * 1200 * t) * env * 0.9;
    }
  }
  return buf;
}
function createToneBuffer(ctx) {
  const sr = ctx.sampleRate;
  const dur = 3;
  const buf = ctx.createBuffer(1, Math.floor(sr * dur), sr);
  const data = buf.getChannelData(0);
  const n = data.length;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const fade = Math.min(1, t / 0.02, (dur - t) / 0.05);
    data[i] = Math.sin(2 * Math.PI * 440 * t) * 0.5 * fade;
  }
  return buf;
}
function createDuoBuffer(ctx, _variant) {
  const sr = ctx.sampleRate;
  const dur = 4;
  const buf = ctx.createBuffer(1, Math.floor(sr * dur), sr);
  const data = buf.getChannelData(0);
  const rand = mulberry32(20260929);
  for (let i = 0; i < data.length; i++) {
    const t = i / sr;
    const noise = (rand() * 2 - 1) * 0.18;
    const tone = Math.sin(2 * Math.PI * 330 * t) * 0.28;
    const lfo = 0.5 + 0.5 * Math.sin(2 * Math.PI * 2 * t);
    const fade = Math.min(1, t / 0.05, (dur - t) / 0.1);
    data[i] = (noise + tone) * (0.6 + 0.4 * lfo) * fade;
  }
  return buf;
}
function createSampleBuffer(ctx, type) {
  switch (type) {
    case "pulse":
      return createPulseBuffer(ctx);
    case "tone":
      return createToneBuffer(ctx);
    case "duoA":
      return createDuoBuffer(ctx, "A");
    case "duoB":
      return createDuoBuffer(ctx, "B");
    default:
      throw new Error(`\u975E\u5185\u7F6E\u6837\u4F8B\u7C7B\u578B: ${type}`);
  }
}
var init_samples = __esm({
  "src/lib/samples.ts"() {
    "use strict";
  }
});

// src/lib/audioEngine.ts
var audioEngine_exports = {};
__export(audioEngine_exports, {
  AudioEngine: () => AudioEngine,
  DecodeError: () => DecodeError
});
function localUp(yaw, pitch) {
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  return {
    x: -sp * Math.sin(yaw),
    y: cp,
    z: sp * Math.cos(yaw)
  };
}
var DecodeError, AudioEngine;
var init_audioEngine = __esm({
  "src/lib/audioEngine.ts"() {
    "use strict";
    init_spatial();
    init_samples();
    DecodeError = class extends Error {
      trackId;
      constructor(trackId, message) {
        super(message);
        this.name = "DecodeError";
        this.trackId = trackId;
      }
    };
    AudioEngine = class {
      ctx = null;
      unlock = "locked";
      busGain = null;
      masterGain = null;
      soloBus = null;
      muteBus = null;
      analyser = null;
      timeDomainBuf = new Float32Array(new ArrayBuffer(8192));
      peakWorklet = null;
      workletFailed = false;
      voices = /* @__PURE__ */ new Map();
      buffers = /* @__PURE__ */ new Map();
      pendingFiles = /* @__PURE__ */ new Map();
      spatial = null;
      anySolo = false;
      unlockListeners = /* @__PURE__ */ new Set();
      levelListeners = /* @__PURE__ */ new Set();
      endedListeners = /* @__PURE__ */ new Set();
      rafHandle = 0;
      clipLatchL = false;
      clipLatchR = false;
      lastPeak = { l: 0, r: 0, clipL: false, clipR: false };
      onUnlock(fn) {
        this.unlockListeners.add(fn);
        fn(this.unlock);
        return () => {
          this.unlockListeners.delete(fn);
        };
      }
      onLevels(fn) {
        this.levelListeners.add(fn);
        return () => {
          this.levelListeners.delete(fn);
        };
      }
      onEnded(fn) {
        this.endedListeners.add(fn);
        return () => {
          this.endedListeners.delete(fn);
        };
      }
      emitUnlock() {
        this.unlockListeners.forEach((fn) => fn(this.unlock));
      }
      /** 必须在用户手势中调用；与“未解锁”分别上报明确的失败状态 */
      async resume() {
        if (this.unlock === "unlocked" && this.ctx) {
          if (this.ctx.state === "suspended") await this.ctx.resume();
          return;
        }
        this.unlock = "unlocking";
        this.emitUnlock();
        try {
          const Ctor = window.AudioContext ?? window.webkitAudioContext;
          if (!Ctor) throw new Error("\u5F53\u524D\u6D4F\u89C8\u5668\u4E0D\u652F\u6301 Web Audio API");
          const ctx = new Ctor();
          this.ctx = ctx;
          this.buildGraph(ctx);
          if (ctx.state === "suspended") await ctx.resume();
          if (ctx.state !== "running") {
            throw new Error("AudioContext \u88AB\u6D4F\u89C8\u5668\u7B56\u7565\u963B\u6B62\uFF0C\u672A\u80FD\u8FDB\u5165 running \u72B6\u6001");
          }
          this.unlock = "unlocked";
          this.emitUnlock();
          this.startMeterLoop();
          void this.ensurePeakWorklet(ctx);
        } catch (err) {
          this.unlock = "failed";
          this.emitUnlock();
          throw err;
        }
      }
      buildGraph(ctx) {
        this.soloBus = ctx.createGain();
        this.muteBus = ctx.createGain();
        this.muteBus.gain.value = 0;
        this.busGain = ctx.createGain();
        this.masterGain = ctx.createGain();
        this.analyser = ctx.createAnalyser();
        this.analyser.fftSize = 2048;
        this.timeDomainBuf = new Float32Array(new ArrayBuffer(this.analyser.fftSize * 4));
        this.soloBus.connect(this.busGain);
        this.muteBus.connect(this.busGain);
        this.busGain.connect(this.masterGain);
        this.masterGain.connect(this.analyser);
        this.analyser.connect(ctx.destination);
      }
      /**
       * 峰值/削波检测器串联在 masterGain 之后、destination 之前的真实输出链上，
       * 逐采样扫描。Worklet 源码以 Blob 注入，无需额外网络资源。
       */
      async ensurePeakWorklet(ctx) {
        if (this.peakWorklet || this.workletFailed) return !!this.peakWorklet;
        try {
          const workletSource = `
class PeakMeterProcessor extends AudioWorkletProcessor {
  process(inputs, outputs) {
    const in0 = inputs[0];
    const out0 = outputs[0];
    if (!in0 || in0.length === 0) {
      // \u4E0A\u6E38\u9759\u9ED8\u4F18\u5316\u65F6\u8F93\u51FA\u4FDD\u6301\u96F6\u586B\u5145\u5373\u53EF
      return true;
    }
    let peakL = 0, peakR = 0, clipL = false, clipR = false;
    const l = in0[0];
    const r = in0[1] || in0[0];
    const ol = out0[0];
    const or = out0[1] || out0[0];
    for (let i = 0; i < l.length; i++) {
      const vl = l[i];
      const al = Math.abs(vl);
      if (al > peakL) peakL = al;
      if (al >= 1.0) clipL = true;
      if (ol) ol[i] = vl; // \u5FC5\u987B\u663E\u5F0F\u900F\u4F20\uFF0C\u5426\u5219\u8F93\u51FA\u9759\u97F3
    }
    if (r && or) for (let i = 0; i < r.length; i++) {
      const vr = r[i];
      const ar = Math.abs(vr);
      if (ar > peakR) peakR = ar;
      if (ar >= 1.0) clipR = true;
      if (out0[1]) or[i] = vr;
    }
    this.port.postMessage({ l: peakL, r: peakR, clipL, clipR });
    return true;
  }
}
registerProcessor('peak-meter', PeakMeterProcessor);
`;
          const blob2 = new Blob([workletSource], { type: "application/javascript" });
          const url = URL.createObjectURL(blob2);
          try {
            await ctx.audioWorklet.addModule(url);
          } finally {
            URL.revokeObjectURL(url);
          }
          const node = new AudioWorkletNode(ctx, "peak-meter", {
            // 节点串在真实输出链上：必须保持立体声直通，避免被下混成单声道
            numberOfInputs: 1,
            numberOfOutputs: 1,
            outputChannelCount: [2]
          });
          node.channelCount = 2;
          node.channelInterpretation = "speakers";
          this.masterGain.disconnect();
          this.masterGain.connect(node);
          this.analyser.disconnect();
          node.connect(this.analyser);
          this.analyser.connect(ctx.destination);
          node.port.onmessage = (e) => {
            const d = e.data;
            if (d.clipL) this.clipLatchL = true;
            if (d.clipR) this.clipLatchR = true;
            this.lastPeak = { l: d.l, r: d.r, clipL: this.clipLatchL, clipR: this.clipLatchR };
          };
          this.peakWorklet = node;
          return true;
        } catch {
          this.workletFailed = true;
          return false;
        }
      }
      clearClipLatch() {
        this.clipLatchL = false;
        this.clipLatchR = false;
      }
      startMeterLoop() {
        const tick = () => {
          if (!this.peakWorklet && this.analyser) {
            this.analyser.getFloatTimeDomainData(this.timeDomainBuf);
            let peak = 0;
            for (let i = 0; i < this.timeDomainBuf.length; i++) {
              const a = Math.abs(this.timeDomainBuf[i]);
              if (a > peak) peak = a;
            }
            if (peak >= 1) {
              this.clipLatchL = true;
              this.clipLatchR = true;
            }
            this.lastPeak = {
              l: peak,
              r: peak,
              clipL: this.clipLatchL,
              clipR: this.clipLatchR
            };
          }
          const p = this.lastPeak;
          this.levelListeners.forEach((fn) => fn({ ...p }));
          this.rafHandle = requestAnimationFrame(tick);
        };
        this.rafHandle = requestAnimationFrame(tick);
      }
      // ---------- 全局参数 ----------
      setSpatialSettings(s) {
        this.spatial = s;
        if (!this.ctx) return;
        for (const v of this.voices.values()) {
          v.panner.distanceModel = s.distanceModel;
          v.panner.refDistance = s.refDistance;
          v.panner.rolloffFactor = s.rolloffFactor;
          v.panner.maxDistance = s.maxDistance;
        }
      }
      setBusGain(g2) {
        if (this.busGain && this.ctx) {
          this.busGain.gain.setTargetAtTime(g2, this.ctx.currentTime, 0.01);
        }
      }
      setMasterGain(g2) {
        if (this.masterGain && this.ctx) {
          this.masterGain.gain.setTargetAtTime(g2, this.ctx.currentTime, 0.01);
        }
      }
      /** 听者位置/朝向；朝向定义与 spatial.ts、Three.js 相机严格一致 */
      setListener(l) {
        if (!this.ctx) return;
        const t = this.ctx.currentTime;
        const f = forwardVector(l.yaw, l.pitch);
        const u = localUp(l.yaw, l.pitch);
        const li = this.ctx.listener;
        const set = (p, v) => {
          if (p) p.setTargetAtTime(v, t, 0.02);
        };
        set(li.positionX, l.position.x);
        set(li.positionY, l.position.y);
        set(li.positionZ, l.position.z);
        set(li.forwardX, f.x);
        set(li.forwardY, f.y);
        set(li.forwardZ, f.z);
        set(li.upX, u.x);
        set(li.upY, u.y);
        set(li.upZ, u.z);
      }
      // ---------- 声轨缓冲与节点 ----------
      /**
       * 确保声轨缓冲与节点就绪。
       * 已存在的 voice 只做实时参数更新（位置/增益/路由/loop），绝不重启源。
       *
       * 缓冲键约定：
       *  - 内置样例：trackId
       *  - file 声轨当前版本：`file::<trackId>::<versionId>`
       *  - file 声轨待校验候选：`cand::<trackId>::<versionId>`（不接入任何节点）
       */
      async ensureTrack(track) {
        if (!this.ctx || this.unlock !== "unlocked") return;
        const currentVersion = track.currentVersionId;
        const bufferKey = track.sourceType === "file" && currentVersion ? this.fileBufferKey(track.id, currentVersion) : track.id;
        let buffer = this.buffers.get(bufferKey);
        if (!buffer) {
          if (track.sourceType === "file") {
            const blob2 = this.pendingFiles.get(track.id);
            if (!blob2) return;
            try {
              const arr = await blob2.arrayBuffer();
              buffer = await this.ctx.decodeAudioData(arr.slice(0));
            } catch (err) {
              throw new DecodeError(
                track.id,
                `\u97F3\u9891\u89E3\u7801\u5931\u8D25\uFF1A${err instanceof Error ? err.message : "\u4E0D\u652F\u6301\u7684\u7F16\u7801\u6216\u6587\u4EF6\u635F\u574F"}`
              );
            }
          } else {
            buffer = createSampleBuffer(this.ctx, track.sourceType);
          }
          this.buffers.set(bufferKey, buffer);
        }
        const existing = this.voices.get(track.id);
        if (!existing) {
          this.voices.set(track.id, this.createVoice(track, buffer, currentVersion));
        } else {
          this.updateVoiceLive(existing, track);
        }
      }
      fileBufferKey(trackId, versionId) {
        return `file::${trackId}::${versionId}`;
      }
      candidateBufferKey(trackId, versionId) {
        return `cand::${trackId}::${versionId}`;
      }
      /**
       * 候选素材校验：仅在浏览器内解码并缓存结果，返回声道/时长元信息。
       * 绝不触碰该轨当前 voice，因此播放中提交候选不会产生第二个 source、
       * 也不会改变当前试听内容（验收④）。失败时清理缓存并抛 DecodeError，旧素材继续可播。
       */
      async probeCandidate(trackId, versionId, blob2) {
        if (!this.ctx || this.unlock !== "unlocked") {
          throw new Error("\u97F3\u9891\u5C1A\u672A\u89E3\u9501\uFF0C\u65E0\u6CD5\u5728\u6D4F\u89C8\u5668\u5185\u6821\u9A8C\u5019\u9009\u7D20\u6750");
        }
        const key = this.candidateBufferKey(trackId, versionId);
        const cached = this.buffers.get(key);
        if (cached) {
          return {
            channels: cached.numberOfChannels,
            duration: cached.duration,
            sampleRate: cached.sampleRate
          };
        }
        let buffer;
        try {
          const arr = await blob2.arrayBuffer();
          buffer = await this.ctx.decodeAudioData(arr.slice(0));
        } catch (err) {
          this.buffers.delete(key);
          throw new DecodeError(
            trackId,
            `\u5019\u9009\u7D20\u6750\u89E3\u7801\u5931\u8D25\uFF1A${err instanceof Error ? err.message : "\u4E0D\u652F\u6301\u7684\u7F16\u7801\u6216\u6587\u4EF6\u635F\u574F"}`
          );
        }
        if (!buffer.numberOfChannels || !(buffer.duration > 0)) {
          this.buffers.delete(key);
          throw new DecodeError(trackId, "\u5019\u9009\u7D20\u6750\u89E3\u7801\u7ED3\u679C\u65E0\u6548\uFF08\u58F0\u9053\u6570\u6216\u65F6\u957F\u4E3A 0\uFF09");
        }
        this.buffers.set(key, buffer);
        return {
          channels: buffer.numberOfChannels,
          duration: buffer.duration,
          sampleRate: buffer.sampleRate
        };
      }
      /** 放弃候选（解码失败或用户丢弃）：清掉候选解码缓存，不影响当前素材 */
      dropCandidate(trackId, versionId) {
        this.buffers.delete(this.candidateBufferKey(trackId, versionId));
      }
      /** 候选是否已通过浏览器解码且缓存仍在（UI 据此决定切换前要不要重新注入 Blob） */
      hasCandidateBuffer(trackId, versionId) {
        return this.buffers.has(this.candidateBufferKey(trackId, versionId));
      }
      /**
       * 原子切换声轨素材版本（用户已确认）。
       * 目标版本缓冲优先来自候选校验缓存（不重复解码）；其次用 pendingFiles 中
       * 由 UI 注入的 Blob（回退到历史版本的场景）。
       *
       * 保持该轨全部图参数与播放态：空间摆位/增益/M/S/loop 来自 newTrack spec；
       * 正在播放 → 从 startOffsetSec 起播且仅此一个 source（旧 source 立即停掉），
       * 不暂停/重置其他轨，也不动全局播放（验收①④）。
       */
      async activateTrackVersion(newTrack, startOffsetSec) {
        if (!this.ctx || this.unlock !== "unlocked") {
          throw new Error("\u97F3\u9891\u5C1A\u672A\u89E3\u9501\uFF0C\u65E0\u6CD5\u5207\u6362\u7D20\u6750\u7248\u672C");
        }
        const versionId = newTrack.currentVersionId;
        if (!versionId) throw new DecodeError(newTrack.id, "\u7F3A\u5C11\u7D20\u6750\u7248\u672C\u4FE1\u606F");
        const targetKey = this.fileBufferKey(newTrack.id, versionId);
        let buffer = this.buffers.get(targetKey);
        if (!buffer) {
          const candKey = this.candidateBufferKey(newTrack.id, versionId);
          buffer = this.buffers.get(candKey);
          if (buffer) {
            this.buffers.set(targetKey, buffer);
            this.buffers.delete(candKey);
          }
        }
        if (!buffer) {
          const blob2 = this.pendingFiles.get(newTrack.id);
          if (!blob2) throw new DecodeError(newTrack.id, "\u672C\u5730\u7D20\u6750 Blob \u7F3A\u5931\uFF0C\u65E0\u6CD5\u5207\u6362");
          try {
            buffer = await this.ctx.decodeAudioData((await blob2.arrayBuffer()).slice(0));
          } catch (err) {
            throw new DecodeError(
              newTrack.id,
              `\u7D20\u6750\u7248\u672C\u5207\u6362\u5931\u8D25\uFF1A${err instanceof Error ? err.message : "\u4E0D\u652F\u6301\u7684\u7F16\u7801\u6216\u6587\u4EF6\u635F\u574F"}`
            );
          }
          this.buffers.set(targetKey, buffer);
        }
        const old = this.voices.get(newTrack.id);
        const wasPlaying = old?.playing ?? false;
        const offset = Math.min(Math.max(0, startOffsetSec), buffer.duration);
        if (old) {
          const nv = this.replaceVoice(old, newTrack, buffer, offset, versionId);
          if (wasPlaying) {
            nv.source.start(this.ctx.currentTime, offset);
            nv.startedAt = this.ctx.currentTime;
            nv.playing = true;
            nv.consumed = true;
          }
        } else {
          const nv = this.createVoice(newTrack, buffer, versionId);
          nv.offset = offset;
          this.voices.set(newTrack.id, nv);
        }
        const prefix = `cand::${newTrack.id}::`;
        for (const key of [...this.buffers.keys()]) {
          if (key.startsWith(prefix) && key !== this.candidateBufferKey(newTrack.id, versionId)) {
            this.buffers.delete(key);
          }
        }
        return {
          channels: buffer.numberOfChannels,
          duration: buffer.duration,
          sampleRate: buffer.sampleRate
        };
      }
      /** 文件 Blob 在解锁后由 UI 层提供（来自 IndexedDB，全程本地） */
      setFileBlob(trackId, blob2) {
        this.pendingFiles.set(trackId, blob2);
      }
      dropBuffer(trackId) {
        this.buffers.delete(trackId);
        for (const key of [...this.buffers.keys()]) {
          if (key.startsWith(`file::${trackId}::`) || key.startsWith(`cand::${trackId}::`)) {
            this.buffers.delete(key);
          }
        }
      }
      createVoice(track, buffer, versionId) {
        const ctx = this.ctx;
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.loop = track.loop;
        const trackGain = ctx.createGain();
        trackGain.gain.value = track.muted ? 0 : track.gain;
        const panner = new PannerNode(ctx, {
          panningModel: "HRTF",
          distanceModel: this.spatial?.distanceModel ?? "inverse",
          refDistance: this.spatial?.refDistance ?? 1,
          rolloffFactor: this.spatial?.rolloffFactor ?? 1,
          maxDistance: this.spatial?.maxDistance ?? 100,
          positionX: track.position.x,
          positionY: track.position.y,
          positionZ: track.position.z
        });
        if (buffer.numberOfChannels <= 1) {
          source.connect(trackGain);
        } else {
          const splitter = ctx.createChannelSplitter(buffer.numberOfChannels);
          source.connect(splitter);
          const ch = Math.min(track.channel, buffer.numberOfChannels - 1);
          splitter.connect(trackGain, ch);
        }
        trackGain.connect(panner);
        const audible = this.shouldBeAudible(track);
        panner.connect(audible ? this.soloBus : this.muteBus);
        const voice2 = {
          trackId: track.id,
          spec: track,
          source,
          trackGain,
          panner,
          versionId,
          buffer,
          audiblyRouted: audible,
          playing: false,
          consumed: false,
          startedAt: 0,
          offset: 0,
          duration: buffer.duration
        };
        source.onended = () => {
          if (!voice2.playing) return;
          const latest = voice2.spec;
          voice2.playing = false;
          voice2.consumed = true;
          voice2.offset = 0;
          const fresh = this.createVoice(latest, voice2.buffer, voice2.versionId);
          fresh.offset = 0;
          this.voices.set(track.id, fresh);
          this.endedListeners.forEach((fn) => fn(track.id));
        };
        return voice2;
      }
      shouldBeAudible(track) {
        if (track.muted) return false;
        if (this.anySolo) return track.solo;
        return true;
      }
      /** 实时参数更新：不触碰 source 节点 —— 移动声源不会重启音轨 */
      updateVoiceLive(voice2, track) {
        const ctx = this.ctx;
        const t = ctx.currentTime;
        const tau = Math.max(5e-3, this.spatial?.positionTimeConstant ?? 0.05);
        voice2.panner.positionX.setTargetAtTime(track.position.x, t, tau);
        voice2.panner.positionY.setTargetAtTime(track.position.y, t, tau);
        voice2.panner.positionZ.setTargetAtTime(track.position.z, t, tau);
        voice2.panner.distanceModel = this.spatial?.distanceModel ?? voice2.panner.distanceModel;
        voice2.trackGain.gain.setTargetAtTime(track.muted ? 0 : track.gain, t, 0.01);
        if (voice2.source.loop !== track.loop) voice2.source.loop = track.loop;
        const audible = this.shouldBeAudible(track);
        if (audible !== voice2.audiblyRouted) {
          voice2.panner.disconnect();
          voice2.panner.connect(audible ? this.soloBus : this.muteBus);
          voice2.audiblyRouted = audible;
        }
        voice2.spec = track;
      }
      /** 静音/独奏变化：重新评估全部路由（增益本身在 updateVoiceLive 中已设置） */
      reevaluateRouting(tracks) {
        this.anySolo = tracks.some((t) => t.solo);
        if (!this.ctx) return;
        for (const tr of tracks) {
          const v = this.voices.get(tr.id);
          if (!v) continue;
          const audible = this.shouldBeAudible(tr);
          if (audible !== v.audiblyRouted) {
            v.panner.disconnect();
            v.panner.connect(audible ? this.soloBus : this.muteBus);
            v.audiblyRouted = audible;
          }
          v.trackGain.gain.setTargetAtTime(tr.muted ? 0 : tr.gain, this.ctx.currentTime, 0.01);
          v.spec = tr;
        }
      }
      /**
       * 高频实时同步：对已存在的 voice 更新位置/增益/loop/独奏路由。
       * 不创建节点、不触碰 source，移动声源不会重启音轨。
       * 尚未创建 voice 的声轨（未解锁/未解码）跳过，由 ensureTrack 负责。
       */
      syncTracks(tracks) {
        if (!this.ctx) return;
        this.anySolo = tracks.some((t) => t.solo);
        for (const tr of tracks) {
          const v = this.voices.get(tr.id);
          if (v) this.updateVoiceLive(v, tr);
        }
      }
      getChannelCount(trackId) {
        const v = this.voices.get(trackId);
        if (v) return v.buffer.numberOfChannels;
        return this.buffers.get(trackId)?.numberOfChannels ?? null;
      }
      /**
       * 重建声轨输入图（切换立体声文件的 L/R 声道时使用）。
       * 保持播放偏移；若原本在播放，从同一位置继续（声道选择本身不属于“移动”）。
       */
      async rebuildVoiceGraph(track) {
        await this.ensureTrack(track);
        const old = this.voices.get(track.id);
        if (!old) return;
        const buf = old.buffer;
        const wasPlaying = old.playing;
        const offset = wasPlaying ? this.currentOffset(old) : old.offset;
        const nv = this.replaceVoice(old, track, buf, offset);
        if (wasPlaying) {
          nv.source.start(this.ctx.currentTime, offset);
          nv.startedAt = this.ctx.currentTime;
          nv.playing = true;
          nv.consumed = true;
        }
      }
      // ---------- 传输控制 ----------
      async playTrack(track) {
        await this.ensureTrack(track);
        let voice2 = this.voices.get(track.id);
        if (!voice2) return;
        if (voice2.playing) return;
        if (voice2.consumed) {
          voice2 = this.replaceVoice(voice2, track, voice2.buffer, voice2.offset);
        }
        const ctx = this.ctx;
        voice2.source.start(ctx.currentTime, voice2.offset % voice2.duration);
        voice2.startedAt = ctx.currentTime;
        voice2.playing = true;
        voice2.consumed = true;
      }
      pauseTrack(track) {
        const voice2 = this.voices.get(track.id);
        if (!voice2 || !voice2.playing) return;
        voice2.offset = this.currentOffset(voice2);
        this.replaceVoice(voice2, track, voice2.buffer, voice2.offset);
      }
      stopTrack(track) {
        const voice2 = this.voices.get(track.id);
        if (!voice2) return;
        if (voice2.playing || voice2.consumed) {
          this.replaceVoice(voice2, track, voice2.buffer, 0);
        } else {
          voice2.offset = 0;
        }
      }
      /** 跳转：offsetSec 秒处；autoplay=true 时立即继续播放 */
      async seekTrack(track, offsetSec, autoplay) {
        await this.ensureTrack(track);
        const voice2 = this.voices.get(track.id);
        if (!voice2) return;
        const buf = voice2.buffer;
        const offset = track.loop ? (offsetSec % buf.duration + buf.duration) % buf.duration : Math.min(Math.max(0, offsetSec), buf.duration);
        const nv = this.replaceVoice(voice2, track, buf, offset);
        if (autoplay) {
          nv.source.start(this.ctx.currentTime, offset);
          nv.startedAt = this.ctx.currentTime;
          nv.playing = true;
          nv.consumed = true;
        }
      }
      /**
       * 停止旧节点并按最新参数重建（仅用于暂停/停止/跳转）。
       * 位置移动严禁走此路径。
       */
      replaceVoice(old, track, buffer, offset, versionId) {
        try {
          old.source.onended = null;
          old.source.stop();
        } catch {
        }
        old.source.disconnect();
        old.trackGain.disconnect();
        old.panner.disconnect();
        const nv = this.createVoice(track, buffer, versionId ?? old.versionId);
        nv.offset = offset;
        this.voices.set(track.id, nv);
        return nv;
      }
      currentOffset(v) {
        let p = v.offset + (this.ctx.currentTime - v.startedAt);
        p = v.spec.loop ? (p % v.duration + v.duration) % v.duration : Math.min(p, v.duration);
        return p;
      }
      removeTrack(trackId) {
        const voice2 = this.voices.get(trackId);
        if (voice2) {
          try {
            voice2.source.onended = null;
            voice2.source.stop();
          } catch {
          }
          voice2.source.disconnect();
          voice2.trackGain.disconnect();
          voice2.panner.disconnect();
        }
        this.voices.delete(trackId);
        for (const key of [...this.buffers.keys()]) {
          if (key === trackId || key.startsWith(`file::${trackId}::`) || key.startsWith(`cand::${trackId}::`)) {
            this.buffers.delete(key);
          }
        }
        this.pendingFiles.delete(trackId);
      }
      getProgress(trackId) {
        const v = this.voices.get(trackId);
        if (!v) return null;
        return v.playing ? this.currentOffset(v) : v.offset;
      }
      getDuration(trackId) {
        const v = this.voices.get(trackId);
        if (v) return v.buffer.duration;
        return this.buffers.get(trackId)?.duration ?? null;
      }
      isPlaying(trackId) {
        return this.voices.get(trackId)?.playing ?? false;
      }
      dispose() {
        cancelAnimationFrame(this.rafHandle);
        for (const id of [...this.voices.keys()]) this.removeTrack(id);
        void this.ctx?.close();
        this.ctx = null;
        this.unlock = "locked";
      }
    };
  }
});

// test/swapEngine.test.ts
import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
var FakeAudioParam = class {
  value;
  events = [];
  constructor(v) {
    this.value = v;
  }
  setTargetAtTime(v, time, tc) {
    this.value = v;
    this.events.push({ time, value: v, tc });
  }
  setValueAtTime(v) {
    this.value = v;
  }
};
var FakeNode = class {
  connects = [];
  disconnected = false;
  connect(node, out, inp) {
    const target = node.input ?? node;
    this.connects.push({ node: target, out, inp });
    return target;
  }
  disconnect() {
    this.connects = [];
    this.disconnected = true;
  }
};
var FakeGain = class extends FakeNode {
  gain = new FakeAudioParam(1);
};
var FakeDestination = class extends FakeNode {
};
var FakePanner = class extends FakeNode {
  panningModel = "HRTF";
  distanceModel = "inverse";
  refDistance = 1;
  rolloffFactor = 1;
  maxDistance = 100;
  positionX;
  positionY;
  positionZ;
  constructor(_ctx, opts = {}) {
    super();
    Object.assign(this, opts);
    this.positionX = new FakeAudioParam(opts.positionX ?? 0);
    this.positionY = new FakeAudioParam(opts.positionY ?? 0);
    this.positionZ = new FakeAudioParam(opts.positionZ ?? 0);
  }
};
var FakeBufferSource = class extends FakeNode {
  buffer = null;
  loop = false;
  started = [];
  stopped = 0;
  onended = null;
  start(time, offset = 0) {
    this.started.push({ time, offset });
  }
  stop() {
    this.stopped++;
  }
};
var FakeBuffer = class {
  duration;
  numberOfChannels;
  length;
  sampleRate;
  constructor(ch, length, sr, duration) {
    this.numberOfChannels = ch;
    this.length = length;
    this.sampleRate = sr;
    this.duration = duration;
  }
  getChannelData() {
    return new Float32Array(this.length);
  }
};
var FakeSplitter = class extends FakeNode {
  constructor(channels) {
    super();
    this.channels = channels;
  }
};
var FakeAnalyser = class extends FakeNode {
  fftSize = 2048;
  getFloatTimeDomainData(arr) {
    arr.fill(0);
  }
};
var FakeListener = class {
  positionX = new FakeAudioParam(0);
  positionY = new FakeAudioParam(0);
  positionZ = new FakeAudioParam(0);
  forwardX = new FakeAudioParam(0);
  forwardY = new FakeAudioParam(0);
  forwardZ = new FakeAudioParam(-1);
  upX = new FakeAudioParam(0);
  upY = new FakeAudioParam(1);
  upZ = new FakeAudioParam(0);
};
var FakeAudioContext = class {
  state = "running";
  currentTime = 10;
  destination = new FakeDestination();
  listener = new FakeListener();
  sampleRate = 48e3;
  audioWorklet = { addModule: async () => {
  } };
  createGain() {
    return new FakeGain();
  }
  createBufferSource() {
    return new FakeBufferSource();
  }
  createBuffer(ch, length, sr) {
    return new FakeBuffer(ch, length, sr, length / sr);
  }
  createChannelSplitter(ch) {
    return new FakeSplitter(ch);
  }
  createAnalyser() {
    return new FakeAnalyser();
  }
  async resume() {
    this.state = "running";
  }
  async decodeAudioData(buf) {
    const text = new TextDecoder().decode(buf);
    if (text === "BAD") throw new Error("EncodingError: fake bad file");
    let ch = 1;
    let dur = 1;
    if (text.includes(":")) {
      const [a, b] = text.split(":");
      ch = Number(a) || 1;
      dur = Number(b) || 1;
    }
    return new FakeBuffer(ch, Math.floor(48e3 * dur), 48e3, dur);
  }
  async close() {
  }
};
var g = globalThis;
g.AudioContext = FakeAudioContext;
g.requestAnimationFrame = (fn) => setTimeout(() => fn(0), 16);
g.cancelAnimationFrame = (id) => clearTimeout(id);
g.window = globalThis;
g.PannerNode = FakePanner;
var { AudioEngine: AudioEngine2, DecodeError: DecodeError2 } = await Promise.resolve().then(() => (init_audioEngine(), audioEngine_exports));
function blob(text) {
  return new Blob([new TextEncoder().encode(text)], { type: "audio/x" });
}
function fileTrack(id, versionId, over = {}) {
  return {
    id,
    name: id,
    sourceType: "file",
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
    color: "#fff",
    position: { x: 2, y: 0, z: 0 },
    status: "pending",
    duration: 1,
    ...over
  };
}
function voice(engine, id) {
  return engine.voices.get(id);
}
function bufferCount(engine) {
  return engine.buffers.size;
}
describe("AudioEngine \u7D20\u6750\u6362\u7248\uFF08\u6A21\u62DF\u73AF\u5883\uFF09", () => {
  let engine;
  beforeEach(async () => {
    engine = new AudioEngine2();
    await engine.resume();
  });
  afterEach(() => engine.dispose());
  it("probeCandidate \u53EA\u89E3\u7801\u5019\u9009\u3001\u7F13\u5B58\u7ED3\u679C\uFF0C\u7EDD\u4E0D\u521B\u5EFA voice/source", async () => {
    const t = fileTrack("a", "cur");
    engine.setFileBlob("a", blob("1:1"));
    await engine.ensureTrack(t);
    await engine.playTrack(t);
    const before = voice(engine, "a").source;
    const startsBefore = before.started.length;
    const meta = await engine.probeCandidate("a", "cand1", blob("2:5"));
    assert.equal(meta.channels, 2);
    assert.equal(meta.duration, 5);
    assert.equal(meta.sampleRate, 48e3);
    const after = voice(engine, "a");
    assert.equal(after.source, before);
    assert.equal(after.source.started.length, startsBefore);
    assert.equal(after.source.stopped, 0);
    assert.equal(engine.hasCandidateBuffer("a", "cand1"), true);
    assert.equal(voice(engine, "a").panner.positionX.value, 2);
  });
  it("\u574F\u5019\u9009\u89E3\u7801\u5931\u8D25\u629B DecodeError \u4E14\u4E0D\u7559\u7F13\u5B58\uFF1B\u5F53\u524D\u7D20\u6750\u7EE7\u7EED\u53EF\u64AD\u653E\uFF0C\u5176\u4ED6\u8F68\u4E0D\u53D7\u5F71\u54CD", async () => {
    const a = fileTrack("a", "cur", { position: { x: 3, y: 0, z: 0 } });
    const b = fileTrack("b", "curb");
    engine.setFileBlob("a", blob("1:1"));
    engine.setFileBlob("b", blob("1:1"));
    await engine.ensureTrack(a);
    await engine.ensureTrack(b);
    await engine.playTrack(a);
    await engine.playTrack(b);
    await assert.rejects(
      engine.probeCandidate("a", "bad", blob("BAD")),
      (err) => err instanceof DecodeError2
    );
    assert.equal(engine.hasCandidateBuffer("a", "bad"), false);
    assert.equal(engine.isPlaying("a"), true);
    assert.equal(engine.isPlaying("b"), true);
    assert.equal(voice(engine, "a").source.buffer?.duration, 1);
    assert.equal(voice(engine, "b").source.buffer?.numberOfChannels, 1);
    const buffersBefore = bufferCount(engine);
    assert.ok(buffersBefore >= 2);
  });
  it("\u64AD\u653E\u4E2D\u786E\u8BA4\u5207\u6362\uFF1A\u539F\u5B50\u66FF\u6362\u4E3A\u552F\u4E00\u65B0 source\uFF0C\u4ECE\u89E3\u6790\u504F\u79FB\u8D77\u64AD\uFF1B\u6446\u4F4D/\u589E\u76CA/M/S \u6CBF\u7528\u65B0 spec\uFF1B\u4E0D\u5F71\u54CD\u5168\u5C40\u5176\u4ED6\u8F68", async () => {
    const t = fileTrack("a", "cur", { gain: 0.6, position: { x: -4, y: 1, z: 2 } });
    const other = fileTrack("o", "curo", { position: { x: 5, y: 0, z: 0 } });
    engine.setFileBlob("a", blob("1:1"));
    engine.setFileBlob("o", blob("1:1"));
    await engine.ensureTrack(t);
    await engine.ensureTrack(other);
    await engine.playTrack(t);
    await engine.playTrack(other);
    const oldSource = voice(engine, "a").source;
    const otherSource = voice(engine, "o").source;
    await engine.probeCandidate("a", "new", blob("2:5"));
    const newTrack = fileTrack("a", "new", {
      blobKey: "blob-new",
      channels: 2,
      duration: 5,
      channel: 1,
      gain: 0.6,
      muted: true,
      // M/S 等参数必须沿用
      position: { x: -4, y: 1, z: 2 }
    });
    const meta = await engine.activateTrackVersion(newTrack, 1.5);
    assert.equal(meta.channels, 2);
    assert.equal(meta.duration, 5);
    const v = voice(engine, "a");
    assert.notEqual(v.source, oldSource);
    assert.equal(oldSource.stopped, 1);
    assert.equal(v.versionId, "new");
    assert.equal(v.buffer.numberOfChannels, 2);
    assert.equal(v.buffer.duration, 5);
    assert.equal(v.source.started.length, 1);
    assert.equal(v.source.started[0].offset, 1.5);
    assert.equal(v.playing, true);
    assert.equal(v.panner.positionX.value, -4);
    assert.equal(v.panner.positionY.value, 1);
    assert.equal(v.panner.positionZ.value, 2);
    assert.equal(v.trackGain.gain.value, 0);
    assert.equal(voice(engine, "o").source, otherSource);
    assert.equal(voice(engine, "o").source.started.length, 1);
    assert.equal(engine.isPlaying("o"), true);
    assert.equal(engine.hasCandidateBuffer("a", "new"), false);
  });
  it("\u6682\u505C\u6001\u5207\u6362\uFF1A\u4E0D\u542F\u52A8\u64AD\u653E\uFF0C\u504F\u79FB\u88AB\u4FDD\u7559\uFF1B\u4E4B\u540E\u64AD\u653E\u4ECE\u8BE5\u504F\u79FB\u5F00\u59CB", async () => {
    const t = fileTrack("a", "cur");
    engine.setFileBlob("a", blob("2:4"));
    await engine.ensureTrack({ ...t, channels: 2, duration: 4 });
    await engine.playTrack({ ...t, channels: 2, duration: 4 });
    engine.pauseTrack({ ...t, channels: 2, duration: 4 });
    voice(engine, "a").offset = 2;
    await engine.probeCandidate("a", "new", blob("2:8"));
    const nt = fileTrack("a", "new", { channels: 2, duration: 8, blobKey: "blob-new" });
    await engine.activateTrackVersion(nt, 2);
    const v = voice(engine, "a");
    assert.equal(v.playing, false);
    assert.equal(v.source.started.length, 0);
    assert.equal(v.offset, 2);
    await engine.playTrack(nt);
    assert.equal(v.source.started[v.source.started.length - 1].offset, 2);
  });
  it("\u56DE\u9000\u5230\u5386\u53F2\u7248\u672C\uFF08\u65E0\u5019\u9009\u7F13\u5B58\uFF09\uFF1A\u4ECE\u6CE8\u5165 Blob \u89E3\u7801\uFF0C\u65E7\u5F53\u524D source \u88AB\u539F\u5B50\u66FF\u6362", async () => {
    const t = fileTrack("a", "new", { channels: 2, duration: 5 });
    engine.setFileBlob("a", blob("2:5"));
    await engine.ensureTrack(t);
    assert.equal(voice(engine, "a").versionId, "new");
    assert.equal(engine.hasCandidateBuffer("a", "old"), false);
    engine.setFileBlob("a", blob("1:1"));
    const old = fileTrack("a", "old", { channels: 1, duration: 1, blobKey: "blob-old", channel: 0 });
    await engine.activateTrackVersion(old, 0);
    const v = voice(engine, "a");
    assert.equal(v.versionId, "old");
    assert.equal(v.buffer.numberOfChannels, 1);
    assert.equal(v.buffer.duration, 1);
  });
  it("\u76EE\u6807 Blob \u89E3\u7801\u5931\u8D25\u65F6\u629B DecodeError\uFF0C\u65E7 voice \u539F\u6837\u4FDD\u7559\uFF08\u5207\u6362\u4E0D\u751F\u6548\uFF09", async () => {
    const t = fileTrack("a", "cur");
    engine.setFileBlob("a", blob("1:1"));
    await engine.ensureTrack(t);
    await engine.playTrack(t);
    const oldSource = voice(engine, "a").source;
    engine.setFileBlob("a", blob("BAD"));
    const bad = fileTrack("a", "broken", { blobKey: "blob-bad" });
    await assert.rejects(engine.activateTrackVersion(bad, 0), DecodeError2);
    const v = voice(engine, "a");
    assert.equal(v.source, oldSource);
    assert.equal(v.versionId, "cur");
    assert.equal(v.playing, true);
    assert.equal(engine.isPlaying("a"), true);
  });
  it("removeTrack \u6E05\u6389\u8BE5\u8F68\u5F53\u524D\u4E0E\u5168\u90E8\u5019\u9009\u7F13\u51B2\uFF0C\u4E0D\u78B0\u522B\u7684\u8F68", async () => {
    await engine.probeCandidate("a", "c1", blob("1:1"));
    await engine.probeCandidate("b", "c2", blob("1:1"));
    engine.setFileBlob("a", blob("1:1"));
    await engine.ensureTrack(fileTrack("a", "cur"));
    const n = bufferCount(engine);
    engine.removeTrack("a");
    assert.equal(bufferCount(engine), n - 2);
    assert.equal(engine.hasCandidateBuffer("b", "c2"), true);
  });
});
