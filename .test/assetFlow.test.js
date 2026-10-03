// test/assetFlow.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";

// src/lib/assetFlow.ts
var DURATION_TOLERANCE_SEC = 0.05;
var MAX_EVENTS = 200;
function uid(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
async function computeFingerprint(data) {
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    const digest = await subtle.digest("SHA-256", data);
    const bytes2 = new Uint8Array(digest);
    let hex2 = "";
    for (const b of bytes2) hex2 += b.toString(16).padStart(2, "0");
    return `sha256:${hex2}`;
  }
  const bytes = new Uint8Array(data);
  let h1 = 2166136261;
  let h2 = 2166136261 ^ 2654435769;
  for (let i = 0; i < bytes.length; i++) {
    h1 = Math.imul(h1 ^ bytes[i], 16777619);
    h2 = Math.imul(h2 ^ bytes[bytes.length - 1 - i], 16777619);
  }
  const hex = (n) => (n >>> 0).toString(16).padStart(8, "0");
  return `fnv:${hex(h1)}${hex(h2)}:${bytes.length}`;
}
function blobKeyFor(fingerprint) {
  return `fp-${fingerprint.replace(/[^a-zA-Z0-9]/g, "")}`;
}
function assessCompatibility(current, next, toleranceSec = DURATION_TOLERANCE_SEC) {
  const channelsDiffer = current.channels != null && next.channels != null && current.channels !== next.channels;
  const durationDiffer = current.duration != null && next.duration != null && Math.abs(current.duration - next.duration) > toleranceSec;
  const reasons = [];
  if (channelsDiffer) {
    reasons.push(`\u58F0\u9053\u5E03\u5C40\u4E0D\u540C\uFF1A\u5F53\u524D ${current.channels} \u58F0\u9053 \u2192 \u65B0\u6587\u4EF6 ${next.channels} \u58F0\u9053`);
  }
  if (durationDiffer) {
    reasons.push(
      `\u65F6\u957F\u4E0D\u540C\uFF1A\u5F53\u524D ${current.duration.toFixed(2)}s \u2192 \u65B0\u6587\u4EF6 ${next.duration.toFixed(2)}s`
    );
  }
  return { compatible: !channelsDiffer && !durationDiffer, channelsDiffer, durationDiffer, reasons };
}
function candidateOf(doc, trackId) {
  return doc.assets.find((a) => a.trackId === trackId && a.status === "candidate");
}
function findVersionByFingerprint(doc, trackId, fingerprint) {
  if (!fingerprint) return void 0;
  return doc.assets.find((a) => a.trackId === trackId && a.fingerprint === fingerprint);
}
function isBlobReferenced(doc, blobKey) {
  return doc.assets.some((a) => a.blobKey === blobKey) || doc.tracks.some((t) => t.blobKey === blobKey);
}
function pushEvent(doc, ev) {
  const event = {
    id: uid("ev"),
    at: ev.at ?? Date.now(),
    trackId: ev.trackId,
    kind: ev.kind,
    versionId: ev.versionId,
    detail: ev.detail
  };
  const assetEvents = [...doc.assetEvents, event].slice(-MAX_EVENTS);
  return { ...doc, assetEvents };
}
function submitCandidate(doc, trackId, version) {
  if (findVersionByFingerprint(doc, trackId, version.fingerprint)) return { doc };
  const dropped = doc.assets.find((a) => a.trackId === trackId && a.status === "candidate");
  const assets = doc.assets.filter((a) => a !== dropped).concat(version);
  return {
    doc: pushEvent({ ...doc, assets }, {
      trackId,
      kind: "submit",
      versionId: version.id,
      detail: `\u63D0\u4EA4\u5019\u9009\uFF1A${version.fileName}`
    }),
    dropped
  };
}
function registerFailure(doc, trackId, version) {
  if (findVersionByFingerprint(doc, trackId, version.fingerprint)) return doc;
  return pushEvent({ ...doc, assets: [...doc.assets, version] }, {
    trackId,
    kind: "fail",
    versionId: version.id,
    detail: `\u5019\u9009\u5931\u8D25\uFF1A${version.fileName} \u2014\u2014 ${version.errorMessage ?? "\u672A\u77E5\u539F\u56E0"}`
  });
}
function applySwitch(doc, trackId, candidateId, channel) {
  const candidate = doc.assets.find((a) => a.id === candidateId && a.trackId === trackId);
  const track = doc.tracks.find((t) => t.id === trackId);
  if (!candidate || !track || candidate.status !== "candidate") return doc;
  const now = Date.now();
  const assets = doc.assets.map((a) => {
    if (a.id === candidateId) {
      return { ...a, status: "ready", channel, note: "\u6362\u7248" };
    }
    if (a.trackId === trackId && a.status === "ready") {
      return { ...a, status: "superseded", replacedBy: candidateId, supersededAt: now };
    }
    return a;
  });
  const tracks = doc.tracks.map(
    (t) => t.id === trackId ? {
      ...t,
      activeVersionId: candidateId,
      blobKey: candidate.blobKey ?? t.blobKey,
      channel,
      channels: candidate.channels ?? t.channels,
      duration: candidate.duration ?? t.duration,
      originalFileName: candidate.fileName,
      status: "ready",
      errorMessage: void 0
    } : t
  );
  return pushEvent({ ...doc, assets, tracks }, {
    trackId,
    kind: "switch",
    versionId: candidateId,
    detail: `\u5207\u6362\u5230\uFF1A${candidate.fileName}`
  });
}
function applyRollback(doc, trackId, versionId) {
  const target = doc.assets.find((a) => a.id === versionId && a.trackId === trackId);
  const track = doc.tracks.find((t) => t.id === trackId);
  if (!target || !track || target.status !== "superseded") return doc;
  const now = Date.now();
  const current = doc.assets.find((a) => a.trackId === trackId && a.status === "ready");
  const assets = doc.assets.map((a) => {
    if (a.id === target.id) {
      return { ...a, status: "ready", replacedBy: void 0, supersededAt: void 0 };
    }
    if (current && a.id === current.id) {
      return { ...a, status: "superseded", replacedBy: target.id, supersededAt: now };
    }
    return a;
  });
  const tracks = doc.tracks.map(
    (t) => t.id === trackId ? {
      ...t,
      activeVersionId: target.id,
      blobKey: target.blobKey ?? t.blobKey,
      channel: target.channel,
      channels: target.channels ?? t.channels,
      duration: target.duration ?? t.duration,
      originalFileName: target.fileName,
      status: "ready",
      errorMessage: void 0
    } : t
  );
  return pushEvent({ ...doc, assets, tracks }, {
    trackId,
    kind: "rollback",
    versionId: target.id,
    detail: `\u56DE\u9000\u5230\uFF1A${target.fileName}`
  });
}
function discardVersion(doc, versionId) {
  const v = doc.assets.find((a) => a.id === versionId);
  if (!v || v.status !== "candidate" && v.status !== "failed") return { doc };
  const nd = pushEvent({ ...doc, assets: doc.assets.filter((a) => a.id !== versionId) }, {
    trackId: v.trackId,
    kind: "discard",
    versionId: v.id,
    detail: `\u79FB\u9664${v.status === "candidate" ? "\u5019\u9009" : "\u5931\u8D25\u8BB0\u5F55"}\uFF1A${v.fileName}`
  });
  return { doc: nd, blobKey: v.blobKey };
}
function updateActiveVersionChannel(doc, trackId, channel) {
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
function fillActiveVersionMeta(doc, trackId, meta) {
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
function migrateDoc(raw) {
  let assets = raw.assets ?? [];
  const assetEvents = raw.assetEvents ?? [];
  const tracks = raw.tracks.map((t) => {
    if (t.sourceType !== "file") return t;
    const existing = assets.find((a) => a.id === t.activeVersionId) ?? assets.find((a) => a.trackId === t.id && a.status === "ready");
    if (existing) {
      return t.activeVersionId ? t : { ...t, activeVersionId: existing.id, blobKey: existing.blobKey ?? t.blobKey };
    }
    if (!t.blobKey) return t;
    const v = {
      id: uid("ver"),
      trackId: t.id,
      fingerprint: "",
      blobKey: t.blobKey,
      fileName: t.originalFileName ?? t.name,
      size: 0,
      status: "ready",
      channel: t.channel,
      channels: t.channels,
      duration: t.duration,
      createdAt: raw.savedAt || Date.now(),
      note: "\u65E7\u7248\u4F1A\u8BDD\u8FC1\u79FB"
    };
    assets = [...assets, v];
    return { ...t, activeVersionId: v.id };
  });
  const dropped = assets.filter((a) => a.status === "candidate");
  assets = assets.filter((a) => a.status !== "candidate");
  const doc = { ...raw, tracks, assets, assetEvents };
  const orphanedBlobKeys = dropped.map((a) => a.blobKey).filter((k) => !!k && !isBlobReferenced(doc, k));
  return { doc, orphanedBlobKeys };
}

// test/assetFlow.test.ts
function makeTrack(over = {}) {
  return {
    id: "trk-1",
    name: "\u4E3B\u5531",
    sourceType: "file",
    blobKey: "fp-aaa",
    activeVersionId: "v1",
    loop: false,
    muted: false,
    solo: false,
    gain: 0.9,
    channel: 1,
    color: "#fff",
    position: { x: 2, y: 0, z: -1 },
    status: "ready",
    duration: 3,
    channels: 2,
    ...over
  };
}
function makeVersion(over) {
  return {
    id: "v?",
    trackId: "trk-1",
    fingerprint: "sha256:x",
    blobKey: "fp-x",
    fileName: "a.wav",
    size: 100,
    status: "ready",
    channel: 0,
    createdAt: 1e3,
    note: "\u6D4B\u8BD5",
    ...over
  };
}
function makeDoc() {
  const v1 = makeVersion({
    id: "v1",
    fingerprint: "sha256:aaa",
    blobKey: "fp-aaa",
    fileName: "old.wav",
    status: "ready",
    channel: 1,
    channels: 2,
    duration: 3
  });
  return {
    version: 1,
    tracks: [makeTrack()],
    assets: [v1],
    assetEvents: [],
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
    savedAt: 0
  };
}
describe("\u5185\u5BB9\u6307\u7EB9", () => {
  it("\u76F8\u540C\u5185\u5BB9\u6307\u7EB9\u76F8\u540C\uFF0C\u4E0D\u540C\u5185\u5BB9\u6307\u7EB9\u4E0D\u540C\uFF1BBlob \u952E\u5185\u5BB9\u5BFB\u5740", async () => {
    const a = new TextEncoder().encode("hello audio").buffer;
    const b = new TextEncoder().encode("hello audio").buffer;
    const c = new TextEncoder().encode("different").buffer;
    const fa = await computeFingerprint(a);
    const fb = await computeFingerprint(b);
    const fc = await computeFingerprint(c);
    assert.equal(fa, fb);
    assert.notEqual(fa, fc);
    assert.equal(blobKeyFor(fa), blobKeyFor(fb));
    assert.notEqual(blobKeyFor(fa), blobKeyFor(fc));
  });
});
describe("\u517C\u5BB9\u6027\u68C0\u67E5", () => {
  it("\u58F0\u9053\u4E0E\u65F6\u957F\u76F8\u8FD1 \u2192 \u517C\u5BB9", () => {
    const r = assessCompatibility({ channels: 2, duration: 3 }, { channels: 2, duration: 3.02 });
    assert.equal(r.compatible, true);
    assert.equal(r.reasons.length, 0);
  });
  it("\u58F0\u9053\u5E03\u5C40\u4E0D\u540C \u2192 \u4E0D\u517C\u5BB9\u5E76\u7ED9\u51FA\u539F\u56E0", () => {
    const r = assessCompatibility({ channels: 2, duration: 3 }, { channels: 1, duration: 3 });
    assert.equal(r.compatible, false);
    assert.equal(r.channelsDiffer, true);
    assert.ok(r.reasons.some((x) => x.includes("\u58F0\u9053\u5E03\u5C40\u4E0D\u540C")));
  });
  it("\u65F6\u957F\u5DEE\u5F02\u8D85\u5BB9\u5DEE \u2192 \u4E0D\u517C\u5BB9", () => {
    const r = assessCompatibility({ channels: 1, duration: 3 }, { channels: 1, duration: 4.2 });
    assert.equal(r.compatible, false);
    assert.equal(r.durationDiffer, true);
  });
  it("\u5143\u4FE1\u606F\u7F3A\u5931\u65F6\u4E0D\u5984\u65AD\uFF08\u89C6\u4E3A\u517C\u5BB9\uFF0C\u7531\u7528\u6237\u786E\u8BA4\uFF09", () => {
    const r = assessCompatibility({}, { channels: 2, duration: 3 });
    assert.equal(r.compatible, true);
  });
});
describe("\u6362\u7248\u72B6\u6001\u673A", () => {
  it("\u2460 \u786E\u8BA4\u5207\u6362\uFF1A\u5019\u9009\u6210\u4E3A\u5F53\u524D\u7248\u672C\uFF0C\u65E7\u7248\u672C\u8F6C\u4E3A\u5DF2\u53D6\u4EE3\uFF0C\u8F68\u9053\u7A7A\u95F4/\u589E\u76CA\u53C2\u6570\u4E0D\u53D8", () => {
    const doc0 = makeDoc();
    const cand = makeVersion({
      id: "v2",
      fingerprint: "sha256:bbb",
      blobKey: "fp-bbb",
      fileName: "new.wav",
      status: "candidate",
      channel: 1,
      channels: 2,
      duration: 3
    });
    const { doc: doc1 } = submitCandidate(doc0, "trk-1", cand);
    const doc2 = applySwitch(doc1, "trk-1", "v2", 1);
    const t = doc2.tracks.find((x) => x.id === "trk-1");
    assert.equal(t.activeVersionId, "v2");
    assert.equal(t.blobKey, "fp-bbb");
    assert.deepEqual(t.position, { x: 2, y: 0, z: -1 });
    assert.equal(t.gain, 0.9);
    assert.equal(t.muted, false);
    assert.equal(t.solo, false);
    const oldV = doc2.assets.find((a) => a.id === "v1");
    assert.equal(oldV.status, "superseded");
    assert.equal(oldV.replacedBy, "v2");
    assert.equal(doc2.assets.find((a) => a.id === "v2").status, "ready");
    assert.ok(doc2.assetEvents.some((e) => e.kind === "switch"));
  });
  it("\u2461 \u5931\u8D25\u5019\u9009\uFF1A\u53EA\u767B\u8BB0\u8BB0\u5F55\u4E0E\u539F\u56E0\uFF0C\u5F53\u524D\u7248\u672C\u4FDD\u6301 ready \u53EF\u64AD\u653E", () => {
    const doc0 = makeDoc();
    const failed = makeVersion({
      id: "vBad",
      fingerprint: "sha256:bad",
      fileName: "broken.wav",
      status: "failed",
      blobKey: void 0,
      errorMessage: "\u97F3\u9891\u89E3\u7801\u5931\u8D25\uFF1AEncodingError"
    });
    const doc1 = registerFailure(doc0, "trk-1", failed);
    const t = doc1.tracks.find((x) => x.id === "trk-1");
    assert.equal(t.activeVersionId, "v1");
    assert.equal(t.status, "ready");
    const fv = doc1.assets.find((a) => a.id === "vBad");
    assert.equal(fv.status, "failed");
    assert.ok(fv.errorMessage.includes("\u89E3\u7801\u5931\u8D25"));
    assert.ok(doc1.assetEvents.some((e) => e.kind === "fail"));
  });
  it("\u2462 \u540C\u4E00\u6307\u7EB9\u91CD\u590D\u63D0\u4EA4\uFF1A\u4E0D\u4EA7\u751F\u91CD\u590D\u7248\u672C\uFF1B\u5931\u8D25\u8BB0\u5F55\u4E5F\u4E0D\u91CD\u590D", () => {
    const doc0 = makeDoc();
    const cand = makeVersion({
      id: "v2",
      fingerprint: "sha256:bbb",
      status: "candidate",
      fileName: "n.wav"
    });
    const { doc: doc1 } = submitCandidate(doc0, "trk-1", cand);
    const again = makeVersion({ ...cand, id: "v2-dup" });
    const { doc: doc2 } = submitCandidate(doc1, "trk-1", again);
    assert.equal(doc2.assets.filter((a) => a.fingerprint === "sha256:bbb").length, 1);
    const failed = makeVersion({ id: "vf", fingerprint: "sha256:bad", status: "failed" });
    const d1 = registerFailure(doc0, "trk-1", failed);
    const d2 = registerFailure(d1, "trk-1", { ...failed, id: "vf-dup" });
    assert.equal(d2.assets.filter((a) => a.fingerprint === "sha256:bad").length, 1);
    const sameAsCurrent = makeVersion({ id: "v9", fingerprint: "sha256:aaa", status: "candidate" });
    const { doc: d3 } = submitCandidate(doc0, "trk-1", sameAsCurrent);
    assert.equal(d3.assets.length, doc0.assets.length);
  });
  it("\u65B0\u5019\u9009\u66FF\u6362\u65E7\u5019\u9009\uFF08\u540C\u4E00\u8F68\u9053\u540C\u65F6\u53EA\u6709\u4E00\u4E2A\u5019\u9009\uFF09", () => {
    const doc0 = makeDoc();
    const c1 = makeVersion({ id: "c1", fingerprint: "sha256:c1", status: "candidate" });
    const c2 = makeVersion({ id: "c2", fingerprint: "sha256:c2", status: "candidate" });
    const { doc: d1 } = submitCandidate(doc0, "trk-1", c1);
    const { doc: d2, dropped } = submitCandidate(d1, "trk-1", c2);
    assert.equal(dropped?.id, "c1");
    assert.equal(candidateOf(d2, "trk-1")?.id, "c2");
  });
  it("\u2464 \u56DE\u9000\uFF1A\u6062\u590D\u5386\u53F2\u7248\u672C\u7684\u539F\u59CB\u58F0\u9053\u9009\u62E9\uFF0C\u7A7A\u95F4\u6446\u4F4D\u4E0D\u53D8\uFF0C\u4E8B\u4EF6\u5165\u94FE", () => {
    let doc = makeDoc();
    const cand = makeVersion({
      id: "v2",
      fingerprint: "sha256:bbb",
      blobKey: "fp-bbb",
      status: "candidate",
      channel: 0,
      channels: 2,
      duration: 3
    });
    doc = submitCandidate(doc, "trk-1", cand).doc;
    doc = applySwitch(doc, "trk-1", "v2", 0);
    assert.equal(doc.tracks[0].channel, 0);
    doc = applyRollback(doc, "trk-1", "v1");
    const t = doc.tracks[0];
    assert.equal(t.activeVersionId, "v1");
    assert.equal(t.channel, 1);
    assert.deepEqual(t.position, { x: 2, y: 0, z: -1 });
    assert.equal(doc.assets.find((a) => a.id === "v1").status, "ready");
    assert.equal(doc.assets.find((a) => a.id === "v2").status, "superseded");
    assert.ok(doc.assetEvents.some((e) => e.kind === "rollback"));
  });
  it("\u653E\u5F03\u5019\u9009\uFF1A\u79FB\u9664\u5019\u9009\u5E76\u8FD4\u56DE blobKey \u4F9B\u56DE\u6536\uFF0C\u5F53\u524D\u7248\u672C\u4E0D\u52A8", () => {
    const doc0 = makeDoc();
    const cand = makeVersion({
      id: "c1",
      fingerprint: "sha256:c1",
      blobKey: "fp-c1",
      status: "candidate"
    });
    const { doc: d1 } = submitCandidate(doc0, "trk-1", cand);
    const { doc: d2, blobKey } = discardVersion(d1, "c1");
    assert.equal(blobKey, "fp-c1");
    assert.equal(candidateOf(d2, "trk-1"), void 0);
    assert.equal(d2.tracks[0].activeVersionId, "v1");
    assert.equal(isBlobReferenced(d2, "fp-c1"), false);
    assert.equal(isBlobReferenced(d2, "fp-aaa"), true);
  });
  it("\u5F53\u524D\u7248\u672C\u4E0A\u76F4\u63A5\u5207 L/R \u4F1A\u5199\u56DE\u7248\u672C\u8BB0\u5F55\uFF08\u56DE\u9000\u4E00\u81F4\u6027\uFF09", () => {
    const doc0 = makeDoc();
    const d1 = updateActiveVersionChannel(doc0, "trk-1", 0);
    assert.equal(d1.assets.find((a) => a.id === "v1").channel, 0);
  });
  it("fillActiveVersionMeta \u53EA\u8865\u7F3A\u5931\u5B57\u6BB5", () => {
    const doc0 = makeDoc();
    const same = fillActiveVersionMeta(doc0, "trk-1", { duration: 9, channels: 9 });
    assert.equal(same, doc0);
    const legacy = makeDoc();
    legacy.assets = [{ ...legacy.assets[0], duration: void 0, channels: void 0 }];
    const filled = fillActiveVersionMeta(legacy, "trk-1", { duration: 2.5, channels: 2 });
    assert.equal(filled.assets[0].duration, 2.5);
    assert.equal(filled.assets[0].channels, 2);
  });
});
describe("\u8FC1\u79FB\u4E0E\u5237\u65B0", () => {
  it("\u65E7\u7248\u6587\u6863\uFF08\u65E0 assets\uFF09\u8FC1\u79FB\u51FA\u7248\u672C\u8BB0\u5F55\uFF1B\u5019\u9009\u5237\u65B0\u5373\u4F5C\u5E9F\u5E76\u62A5\u544A\u5B64\u513F Blob", () => {
    const legacyTrack = makeTrack({ activeVersionId: void 0 });
    const legacyDoc = {
      version: 1,
      tracks: [legacyTrack],
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
      savedAt: 0
    };
    const { doc: migrated, orphanedBlobKeys } = migrateDoc(legacyDoc);
    const t = migrated.tracks[0];
    assert.ok(t.activeVersionId);
    const v = migrated.assets.find((a) => a.id === t.activeVersionId);
    assert.equal(v.status, "ready");
    assert.equal(v.blobKey, "fp-aaa");
    assert.equal(v.channel, 1);
    assert.equal(orphanedBlobKeys.length, 0);
    const withCand = makeDoc();
    const cand = makeVersion({
      id: "c1",
      fingerprint: "sha256:c1",
      blobKey: "fp-c1",
      status: "candidate"
    });
    const { doc: d1 } = submitCandidate(withCand, "trk-1", cand);
    const { doc: d2, orphanedBlobKeys: orphans } = migrateDoc(d1);
    assert.equal(candidateOf(d2, "trk-1"), void 0);
    assert.deepEqual(orphans, ["fp-c1"]);
    assert.equal(d2.tracks[0].activeVersionId, "v1");
    assert.equal(d2.assets.find((a) => a.id === "v1").status, "ready");
  });
});
