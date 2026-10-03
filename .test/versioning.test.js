// test/versioning.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";

// src/lib/versioning.ts
function durationToleranceSec(oldDurationSec) {
  return Math.max(0.25, oldDurationSec * 5e-3);
}
function evaluateCompatibility(current, candidate) {
  if (!current || current.channels == null || current.duration == null) {
    return {
      channelsCompatible: true,
      durationCompatible: true,
      durationDeltaSec: 0
    };
  }
  const chCur = current.channels;
  const chNew = candidate.channels;
  const dCur = current.duration;
  const dNew = candidate.duration ?? 0;
  return {
    channelsCompatible: chNew === chCur,
    durationCompatible: chNew === chCur && Math.abs(dNew - dCur) <= durationToleranceSec(dCur),
    durationDeltaSec: dNew - dCur
  };
}
function findSameContentVersion(track, fingerprint) {
  if (!fingerprint.startsWith("sha256:")) return null;
  return track.versions?.find((v) => v.fingerprint === fingerprint) ?? null;
}
function getCurrentVersion(track) {
  if (track.sourceType !== "file") return null;
  return track.versions?.find((v) => v.id === track.currentVersionId) ?? null;
}
function getPendingCandidates(track) {
  return (track.versions ?? []).filter((v) => v.status === "candidate");
}
function getSupersededVersions(track) {
  return (track.versions ?? []).filter((v) => v.status === "superseded").reverse();
}
function switchNeedsChannelChoice(current, target) {
  if (!current || current.channels == null || target.channels == null) return false;
  return current.channels !== target.channels;
}
function switchNeedsPositionChoice(current, target) {
  if (!current) return false;
  return !evaluateCompatibility(current, target).durationCompatible;
}
function resolveStartOffset(prevOffsetSec, target, resolution) {
  const max = target.duration ?? 0;
  switch (resolution.mode) {
    case "from-start":
      return 0;
    case "explicit": {
      const v = resolution.explicitOffsetSec ?? 0;
      return Math.min(Math.max(0, v), max);
    }
    case "keep-relative":
    default:
      return Math.min(Math.max(0, prevOffsetSec), max);
  }
}
var VersionSwitchError = class extends Error {
};
function applyVersionSwitch(track, input) {
  const target = track.versions?.find((v) => v.id === input.target.id);
  if (!target) throw new VersionSwitchError("\u76EE\u6807\u7D20\u6750\u7248\u672C\u4E0D\u5B58\u5728");
  if (target.status !== "candidate" && target.status !== "superseded") {
    throw new VersionSwitchError(`\u7248\u672C\u72B6\u6001\u4E3A ${target.status}\uFF0C\u4E0D\u53EF\u5207\u6362`);
  }
  if (target.channels == null || target.duration == null) {
    throw new VersionSwitchError("\u76EE\u6807\u7D20\u6750\u5C1A\u672A\u901A\u8FC7\u6D4F\u89C8\u5668\u89E3\u7801\u6821\u9A8C");
  }
  const channel = Math.floor(input.channel);
  if (channel < 0 || channel >= target.channels) {
    throw new VersionSwitchError(`\u58F0\u9053\u9009\u62E9 ${channel} \u8D85\u51FA\u76EE\u6807\u7D20\u6750\u8303\u56F4\uFF08${target.channels} \u58F0\u9053\uFF09`);
  }
  const current = getCurrentVersion(track);
  const compatibility = evaluateCompatibility(current, target);
  const versions = (track.versions ?? []).map((v) => ({ ...v }));
  if (current) {
    const cur = versions.find((v) => v.id === current.id);
    cur.status = "superseded";
    cur.selectedChannel = track.channel;
  }
  const tgt = versions.find((v) => v.id === target.id);
  tgt.status = "ready";
  tgt.readyAt = input.at;
  tgt.selectedChannel = channel;
  tgt.error = void 0;
  const log = {
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
    compatibility
  };
  const next = {
    ...track,
    versions,
    currentVersionId: target.id,
    blobKey: target.blobKey,
    originalFileName: target.fileName,
    channel,
    channels: target.channels ?? void 0,
    duration: target.duration ?? void 0,
    swapLog: [...track.swapLog ?? [], log]
  };
  return {
    track: next,
    startOffsetSec: resolveStartOffset(input.prevOffsetSec, target, input.resolution),
    log
  };
}
function markCandidateFailed(track, versionId, error) {
  return {
    ...track,
    versions: track.versions?.map(
      (v) => v.id === versionId && v.status === "candidate" ? { ...v, status: "failed", error } : v
    )
  };
}
function markCandidateProbed(track, versionId, meta) {
  return {
    ...track,
    versions: track.versions?.map(
      (v) => v.id === versionId && v.status === "candidate" ? { ...v, channels: meta.channels, duration: meta.duration, sampleRate: meta.sampleRate } : v
    )
  };
}
function migrateDoc(doc) {
  if (doc.version === 2) return doc;
  const tracks = doc.tracks.map((t) => {
    if (t.sourceType !== "file" || !t.blobKey || t.versions?.length) return t;
    const legacy = {
      id: `ver-legacy-${t.id}`,
      blobKey: t.blobKey,
      fingerprint: `unknown:v1:${t.blobKey}`,
      fingerprintAlg: "unknown",
      fileName: t.originalFileName ?? t.name,
      fileSize: 0,
      fileType: "",
      status: "ready",
      channels: t.channels ?? null,
      duration: t.duration ?? null,
      sampleRate: null,
      selectedChannel: t.channel,
      createdAt: doc.savedAt || 0,
      readyAt: doc.savedAt || 0
    };
    return {
      ...t,
      versions: [legacy],
      currentVersionId: legacy.id
    };
  });
  return { ...doc, version: 2, tracks };
}
function shortFingerprint(fp) {
  if (fp.startsWith("sha256:")) return fp.slice(7, 17);
  if (fp.startsWith("unknown:")) return "legacy";
  return fp.slice(0, 10);
}
async function computeFingerprint(blob) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("\u5F53\u524D\u73AF\u5883\u4E0D\u652F\u6301 crypto.subtle\uFF0C\u65E0\u6CD5\u8BA1\u7B97\u7D20\u6750\u5185\u5BB9\u6307\u7EB9");
  const buf = await blob.arrayBuffer();
  const digest = await subtle.digest("SHA-256", buf);
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return { fingerprint: `sha256:${hex}`, alg: "sha-256" };
}

// test/versioning.test.ts
var FP_A = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
var FP_B = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
function ver(over = {}) {
  return {
    id: over.id ?? "v1",
    blobKey: over.blobKey ?? "blob-1",
    fingerprint: over.fingerprint ?? FP_A,
    fingerprintAlg: "sha-256",
    fileName: over.fileName ?? "a.wav",
    fileSize: 100,
    fileType: "audio/wav",
    status: over.status ?? "ready",
    channels: ("channels" in over ? over.channels : 2) ?? null,
    duration: ("duration" in over ? over.duration : 10) ?? null,
    sampleRate: 48e3,
    selectedChannel: over.selectedChannel,
    error: over.error,
    createdAt: 1e3,
    readyAt: over.readyAt ?? 1e3
  };
}
function trackWith(versions, currentId, over = {}) {
  return {
    id: "t",
    name: "T",
    sourceType: "file",
    versions,
    currentVersionId: currentId ?? versions.find((v) => v.status === "ready")?.id,
    loop: false,
    muted: false,
    solo: false,
    gain: 0.9,
    channel: over.channel ?? 0,
    color: "#fff",
    position: { x: 1, y: 0, z: 0 },
    status: "ready",
    channels: over.channels ?? 2,
    duration: over.duration ?? 10,
    ...over
  };
}
describe("\u7D20\u6750\u6362\u7248\u7EAF\u903B\u8F91", () => {
  it("\u5185\u5BB9\u6307\u7EB9\uFF1A\u76F8\u540C\u5B57\u8282\u5F97\u5230\u76F8\u540C sha256\uFF0C\u4E0D\u540C\u5B57\u8282\u4E0D\u540C\uFF1Bunknown \u6307\u7EB9\u4E0D\u53C2\u4E0E\u53BB\u91CD", async () => {
    const b1 = new Blob([new Uint8Array([1, 2, 3, 4])]);
    const b1copy = new Blob([new Uint8Array([1, 2, 3, 4])]);
    const b2 = new Blob([new Uint8Array([1, 2, 3, 5])]);
    const f1 = await computeFingerprint(b1);
    const f1c = await computeFingerprint(b1copy);
    const f2 = await computeFingerprint(b2);
    assert.equal(f1.fingerprint, f1c.fingerprint);
    assert.notEqual(f1.fingerprint, f2.fingerprint);
    assert.ok(f1.fingerprint.startsWith("sha256:"));
    assert.equal(f1.fingerprint.length, "sha256:".length + 64);
    const t = trackWith([ver({ fingerprint: "unknown:v1:blob-1" })]);
    assert.equal(findSameContentVersion(t, "unknown:v1:blob-1"), null);
    assert.equal(shortFingerprint("unknown:v1:x"), "legacy");
  });
  it("\u540C\u5185\u5BB9\u6307\u7EB9\u5224\u5B9A\uFF08\u4EFB\u610F\u72B6\u6001\uFF09\u2014\u2014\u9A8C\u6536\u2462\u91CD\u590D\u6587\u4EF6\u4E0D\u4EA7\u751F\u65B0\u7248\u672C", () => {
    const ready = ver();
    const failed = ver({ id: "vf", status: "failed", fingerprint: FP_B, fileName: "bad.wav" });
    const t = trackWith([ready, failed]);
    assert.equal(findSameContentVersion(t, FP_A)?.id, "v1");
    assert.equal(findSameContentVersion(t, FP_B)?.id, "vf");
    assert.equal(findSameContentVersion(t, "sha256:cccc"), null);
  });
  it("\u517C\u5BB9\u6027\uFF1A\u58F0\u9053\u6570\u4E0D\u540C \u2192 \u58F0\u9053\u4E0D\u517C\u5BB9\uFF1B\u65F6\u957F\u5DEE\u5728\u5BB9\u5DEE\u5185\u517C\u5BB9\u3001\u8D85\u51FA\u4E0D\u517C\u5BB9", () => {
    const cur = { channels: 2, duration: 10 };
    assert.deepEqual(evaluateCompatibility(cur, { channels: 2, duration: 10.1 }), {
      channelsCompatible: true,
      durationCompatible: true,
      durationDeltaSec: 0.09999999999999964
    });
    const far = evaluateCompatibility(cur, { channels: 2, duration: 11 });
    assert.equal(far.durationCompatible, false);
    assert.ok(Math.abs(far.durationDeltaSec - 1) < 1e-9);
    const ch = evaluateCompatibility(cur, { channels: 1, duration: 10 });
    assert.equal(ch.channelsCompatible, false);
    assert.equal(ch.durationCompatible, false);
    assert.deepEqual(evaluateCompatibility(null, { channels: 5, duration: 3 }), {
      channelsCompatible: true,
      durationCompatible: true,
      durationDeltaSec: 0
    });
    assert.ok(durationToleranceSec(100) === 0.5);
    assert.ok(durationToleranceSec(10) === 0.25);
  });
  it("needs* \u9009\u62E9\u5224\u5B9A\u6B63\u786E", () => {
    const cur = ver({ channels: 2, duration: 10 });
    const t = trackWith([cur]);
    const mono = ver({ id: "cand", status: "candidate", channels: 1, duration: 10 });
    const longer = ver({ id: "cand2", status: "candidate", channels: 2, duration: 12 });
    const same = ver({ id: "cand3", status: "candidate", channels: 2, duration: 10.01 });
    assert.equal(switchNeedsChannelChoice(getCurrentVersion(t), mono), true);
    assert.equal(switchNeedsChannelChoice(getCurrentVersion(t), same), false);
    assert.equal(switchNeedsPositionChoice(getCurrentVersion(t), longer), true);
    assert.equal(switchNeedsPositionChoice(getCurrentVersion(t), same), false);
  });
  it("\u5B9A\u4F4D\u89E3\u6790\uFF1A\u4E09\u79CD\u6A21\u5F0F\u90FD\u88AB\u94B3\u5236\u5230\u76EE\u6807\u65F6\u957F\u5185\uFF1Bexplicit \u7528\u7528\u6237\u79D2\u6570", () => {
    const target = { duration: 5 };
    assert.equal(resolveStartOffset(8, target, { mode: "keep-relative" }), 5);
    assert.equal(resolveStartOffset(2, target, { mode: "keep-relative" }), 2);
    assert.equal(resolveStartOffset(2, target, { mode: "from-start" }), 0);
    assert.equal(resolveStartOffset(8, target, { mode: "explicit", explicitOffsetSec: 3.2 }), 3.2);
    assert.equal(resolveStartOffset(8, target, { mode: "explicit", explicitOffsetSec: 99 }), 5);
    assert.equal(resolveStartOffset(-4, target, { mode: "keep-relative" }), 0);
  });
  it("\u539F\u5B50\u6362\u7248\uFF1A\u65E7\u7248\u672C superseded \u4E14\u8BB0\u5F55\u539F\u58F0\u9053\uFF1B\u76EE\u6807 ready\uFF1B\u8F68\u53C2\u6570\u6307\u5411\u65B0\u7248\u672C\uFF1B\u6765\u6E90\u94FE\u8FFD\u52A0 swap", () => {
    const cur = ver({ id: "v0", blobKey: "b0", fileName: "old.wav", selectedChannel: 0 });
    const cand = ver({
      id: "v1",
      blobKey: "b1",
      fileName: "new.wav",
      fingerprint: FP_B,
      status: "candidate",
      channels: 2,
      duration: 10
    });
    const t = trackWith([cur, cand], "v0", { channel: 1, channels: 2, duration: 10 });
    const r = applyVersionSwitch(t, {
      target: cand,
      channel: 0,
      resolution: { mode: "keep-relative" },
      kind: "swap",
      at: 5e3,
      prevOffsetSec: 3
    });
    assert.equal(r.startOffsetSec, 3);
    assert.equal(r.track.currentVersionId, "v1");
    assert.equal(r.track.blobKey, "b1");
    assert.equal(r.track.originalFileName, "new.wav");
    assert.equal(r.track.channel, 0);
    const v0 = r.track.versions.find((x) => x.id === "v0");
    const v1 = r.track.versions.find((x) => x.id === "v1");
    assert.equal(v0.status, "superseded");
    assert.equal(v0.selectedChannel, 1);
    assert.equal(v1.status, "ready");
    assert.equal(v1.readyAt, 5e3);
    assert.equal(r.log.kind, "swap");
    assert.equal(r.log.fromVersionId, "v0");
    assert.equal(r.log.toVersionId, "v1");
    assert.equal(r.track.swapLog?.length, 1);
    assert.equal(cur.status, "ready");
    assert.equal(cand.status, "candidate");
  });
  it("\u56DE\u9000\uFF1Asuperseded \u2192 ready\uFF0C\u539F\u5F53\u524D \u2192 superseded\uFF1B\u65E5\u5FD7 kind=rollback\uFF1B\u6062\u590D\u5F53\u5E74\u58F0\u9053", () => {
    const v0 = ver({ id: "v0", status: "superseded", selectedChannel: 1, fileName: "old.wav", blobKey: "b0" });
    const v1 = ver({ id: "v1", status: "ready", selectedChannel: 0, fileName: "new.wav", blobKey: "b1", fingerprint: FP_B });
    const t = trackWith([v0, v1], "v1", { channel: 0 });
    const target = t.versions.find((x) => x.id === "v0");
    const r = applyVersionSwitch(t, {
      target,
      channel: 1,
      resolution: { mode: "from-start" },
      kind: "rollback",
      at: 9e3,
      prevOffsetSec: 4
    });
    assert.equal(r.startOffsetSec, 0);
    const nv0 = r.track.versions.find((x) => x.id === "v0");
    const nv1 = r.track.versions.find((x) => x.id === "v1");
    assert.equal(nv0.status, "ready");
    assert.equal(nv1.status, "superseded");
    assert.equal(nv1.selectedChannel, 0);
    assert.equal(r.track.channel, 1);
    assert.equal(r.log.kind, "rollback");
    assert.equal(getSupersededVersions(r.track)[0].id, "v1");
  });
  it("\u975E\u6CD5\u5207\u6362\u88AB\u62D2\u7EDD\uFF1A\u76EE\u6807\u4E0D\u5B58\u5728/\u72B6\u6001\u9519\u8BEF/\u58F0\u9053\u8D8A\u754C\uFF0C\u5747\u4E0D\u4EA7\u751F\u4E2D\u95F4\u6001", () => {
    const cur = ver();
    const t = trackWith([cur]);
    assert.throws(
      () => applyVersionSwitch(t, {
        target: ver({ id: "ghost", status: "candidate" }),
        channel: 0,
        resolution: { mode: "from-start" },
        kind: "swap",
        at: 1,
        prevOffsetSec: 0
      }),
      VersionSwitchError
    );
    const failed = ver({ id: "f", status: "failed" });
    const t2 = trackWith([cur, failed], "v1");
    assert.throws(
      () => applyVersionSwitch(t2, {
        target: failed,
        channel: 0,
        resolution: { mode: "from-start" },
        kind: "swap",
        at: 1,
        prevOffsetSec: 0
      }),
      VersionSwitchError
    );
    const cand = ver({ id: "c", status: "candidate", channels: 1 });
    const t3 = trackWith([cur, cand], "v1");
    assert.throws(
      () => applyVersionSwitch(t3, {
        target: cand,
        channel: 2,
        // 越界：单声道只有 0
        resolution: { mode: "from-start" },
        kind: "swap",
        at: 1,
        prevOffsetSec: 0
      }),
      VersionSwitchError
    );
    const unprobed = ver({ id: "u", status: "candidate", channels: null, duration: null });
    const t4 = trackWith([cur, unprobed], "v1");
    assert.throws(
      () => applyVersionSwitch(t4, {
        target: unprobed,
        channel: 0,
        resolution: { mode: "from-start" },
        kind: "swap",
        at: 1,
        prevOffsetSec: 0
      }),
      VersionSwitchError
    );
    assert.equal(getCurrentVersion(t3).id, "v1");
    assert.equal(getPendingCandidates(t3).length, 1);
  });
  it("markCandidateProbed / markCandidateFailed \u53EA\u79FB\u52A8\u76EE\u6807\u5019\u9009\uFF0C\u4E0D\u78B0\u5176\u4ED6\u7248\u672C", () => {
    const cur = ver({ id: "v0" });
    const c1 = ver({ id: "c1", status: "candidate", channels: null, duration: null });
    const c2 = ver({ id: "c2", status: "candidate", channels: null, duration: null, fingerprint: FP_B });
    const t = trackWith([cur, c1, c2], "v0");
    const p = markCandidateProbed(t, "c1", { channels: 1, duration: 3, sampleRate: 44100 });
    assert.deepEqual(
      p.versions.find((x) => x.id === "c1"),
      { ...c1, channels: 1, duration: 3, sampleRate: 44100 }
    );
    assert.equal(p.versions.find((x) => x.id === "c2").channels, null);
    const f = markCandidateFailed(p, "c2", "\u89E3\u7801\u5931\u8D25\uFF1A\u574F\u6587\u4EF6");
    assert.equal(f.versions.find((x) => x.id === "c2").status, "failed");
    assert.equal(f.versions.find((x) => x.id === "c2").error, "\u89E3\u7801\u5931\u8D25\uFF1A\u574F\u6587\u4EF6");
    assert.equal(f.versions.find((x) => x.id === "v0").status, "ready");
  });
  it("v1 \u5DE5\u7A0B\u8FC1\u79FB\uFF1Afile \u8F68\u8865 ready \u7684 legacy \u7248\u672C\uFF08unknown \u6307\u7EB9\uFF09\uFF1Bdoc.version=2\uFF1B\u6837\u4F8B\u8F68\u4E0D\u52A8", () => {
    const doc = {
      version: 1,
      tracks: [
        {
          id: "f",
          name: "old.wav",
          sourceType: "file",
          blobKey: "old-blob",
          originalFileName: "old.wav",
          loop: false,
          muted: false,
          solo: false,
          gain: 0.7,
          channel: 1,
          channels: 2,
          color: "#fff",
          position: { x: 0, y: 0, z: 0 },
          status: "ready",
          duration: 8
        },
        {
          id: "s",
          name: "tone",
          sourceType: "tone",
          loop: true,
          muted: false,
          solo: false,
          gain: 0.9,
          channel: 0,
          color: "#000",
          position: { x: 0, y: 0, z: 0 },
          status: "ready"
        }
      ],
      listener: { position: { x: 0, y: 0, z: 3 }, yaw: 0, pitch: 0, earHeight: 0 },
      spatial: {
        distanceModel: "inverse",
        refDistance: 1,
        rolloffFactor: 1,
        maxDistance: 30,
        positionTimeConstant: 0.06,
        hrtfIR: "none"
      },
      busGain: 1,
      masterGain: 0.9,
      savedAt: 123
    };
    const m = migrateDoc(doc);
    assert.equal(m.version, 2);
    const ft = m.tracks[0];
    assert.equal(ft.versions?.length, 1);
    const legacy = ft.versions[0];
    assert.equal(legacy.status, "ready");
    assert.equal(legacy.blobKey, "old-blob");
    assert.equal(legacy.fingerprintAlg, "unknown");
    assert.equal(legacy.selectedChannel, 1);
    assert.equal(ft.currentVersionId, legacy.id);
    assert.equal(m.tracks[1].versions, void 0);
    assert.equal(migrateDoc(m), m);
  });
});
