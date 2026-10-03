/**
 * 素材换版流程纯逻辑测试（Node 环境）。
 * 覆盖验收点：
 *  ① 兼容换版后其他轨与轨道参数不变，新版本成为当前版本
 *  ② 解码失败只登记失败候选（含原因），当前版本与播放不受影响
 *  ③ 同一内容指纹重复提交不制造多个版本
 *  ⑤ 迁移/刷新后保留当前版本与完整回退链；回退恢复原始声道选择
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AssetVersion, ProjectDoc, Track } from '../src/types.ts';
import {
  applyRollback,
  applySwitch,
  assessCompatibility,
  blobKeyFor,
  candidateOf,
  computeFingerprint,
  discardVersion,
  fillActiveVersionMeta,
  isBlobReferenced,
  migrateDoc,
  registerFailure,
  submitCandidate,
  updateActiveVersionChannel,
} from '../src/lib/assetFlow.ts';

function makeTrack(over: Partial<Track> = {}): Track {
  return {
    id: 'trk-1',
    name: '主唱',
    sourceType: 'file',
    blobKey: 'fp-aaa',
    activeVersionId: 'v1',
    loop: false,
    muted: false,
    solo: false,
    gain: 0.9,
    channel: 1,
    color: '#fff',
    position: { x: 2, y: 0, z: -1 },
    status: 'ready',
    duration: 3,
    channels: 2,
    ...over,
  };
}

function makeVersion(over: Partial<AssetVersion>): AssetVersion {
  return {
    id: 'v?',
    trackId: 'trk-1',
    fingerprint: 'sha256:x',
    blobKey: 'fp-x',
    fileName: 'a.wav',
    size: 100,
    status: 'ready',
    channel: 0,
    createdAt: 1000,
    note: '测试',
    ...over,
  };
}

function makeDoc(): ProjectDoc {
  const v1 = makeVersion({
    id: 'v1',
    fingerprint: 'sha256:aaa',
    blobKey: 'fp-aaa',
    fileName: 'old.wav',
    status: 'ready',
    channel: 1,
    channels: 2,
    duration: 3,
  });
  return {
    version: 1,
    tracks: [makeTrack()],
    assets: [v1],
    assetEvents: [],
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
    savedAt: 0,
  };
}

describe('内容指纹', () => {
  it('相同内容指纹相同，不同内容指纹不同；Blob 键内容寻址', async () => {
    const a = new TextEncoder().encode('hello audio').buffer as ArrayBuffer;
    const b = new TextEncoder().encode('hello audio').buffer as ArrayBuffer;
    const c = new TextEncoder().encode('different').buffer as ArrayBuffer;
    const fa = await computeFingerprint(a);
    const fb = await computeFingerprint(b);
    const fc = await computeFingerprint(c);
    assert.equal(fa, fb);
    assert.notEqual(fa, fc);
    assert.equal(blobKeyFor(fa), blobKeyFor(fb));
    assert.notEqual(blobKeyFor(fa), blobKeyFor(fc));
  });
});

describe('兼容性检查', () => {
  it('声道与时长相近 → 兼容', () => {
    const r = assessCompatibility({ channels: 2, duration: 3.0 }, { channels: 2, duration: 3.02 });
    assert.equal(r.compatible, true);
    assert.equal(r.reasons.length, 0);
  });

  it('声道布局不同 → 不兼容并给出原因', () => {
    const r = assessCompatibility({ channels: 2, duration: 3 }, { channels: 1, duration: 3 });
    assert.equal(r.compatible, false);
    assert.equal(r.channelsDiffer, true);
    assert.ok(r.reasons.some((x) => x.includes('声道布局不同')));
  });

  it('时长差异超容差 → 不兼容', () => {
    const r = assessCompatibility({ channels: 1, duration: 3 }, { channels: 1, duration: 4.2 });
    assert.equal(r.compatible, false);
    assert.equal(r.durationDiffer, true);
  });

  it('元信息缺失时不妄断（视为兼容，由用户确认）', () => {
    const r = assessCompatibility({}, { channels: 2, duration: 3 });
    assert.equal(r.compatible, true);
  });
});

describe('换版状态机', () => {
  it('① 确认切换：候选成为当前版本，旧版本转为已取代，轨道空间/增益参数不变', () => {
    const doc0 = makeDoc();
    const cand = makeVersion({
      id: 'v2',
      fingerprint: 'sha256:bbb',
      blobKey: 'fp-bbb',
      fileName: 'new.wav',
      status: 'candidate',
      channel: 1,
      channels: 2,
      duration: 3,
    });
    const { doc: doc1 } = submitCandidate(doc0, 'trk-1', cand);
    const doc2 = applySwitch(doc1, 'trk-1', 'v2', 1);

    const t = doc2.tracks.find((x) => x.id === 'trk-1')!;
    assert.equal(t.activeVersionId, 'v2');
    assert.equal(t.blobKey, 'fp-bbb');
    // 空间摆位/增益/静音/独奏完全不变
    assert.deepEqual(t.position, { x: 2, y: 0, z: -1 });
    assert.equal(t.gain, 0.9);
    assert.equal(t.muted, false);
    assert.equal(t.solo, false);
    // 旧版本保留为已取代，可回退
    const oldV = doc2.assets.find((a) => a.id === 'v1')!;
    assert.equal(oldV.status, 'superseded');
    assert.equal(oldV.replacedBy, 'v2');
    assert.equal(doc2.assets.find((a) => a.id === 'v2')!.status, 'ready');
    assert.ok(doc2.assetEvents.some((e) => e.kind === 'switch'));
  });

  it('② 失败候选：只登记记录与原因，当前版本保持 ready 可播放', () => {
    const doc0 = makeDoc();
    const failed = makeVersion({
      id: 'vBad',
      fingerprint: 'sha256:bad',
      fileName: 'broken.wav',
      status: 'failed',
      blobKey: undefined,
      errorMessage: '音频解码失败：EncodingError',
    });
    const doc1 = registerFailure(doc0, 'trk-1', failed);
    const t = doc1.tracks.find((x) => x.id === 'trk-1')!;
    assert.equal(t.activeVersionId, 'v1');
    assert.equal(t.status, 'ready');
    const fv = doc1.assets.find((a) => a.id === 'vBad')!;
    assert.equal(fv.status, 'failed');
    assert.ok(fv.errorMessage!.includes('解码失败'));
    assert.ok(doc1.assetEvents.some((e) => e.kind === 'fail'));
  });

  it('③ 同一指纹重复提交：不产生重复版本；失败记录也不重复', () => {
    const doc0 = makeDoc();
    const cand = makeVersion({
      id: 'v2',
      fingerprint: 'sha256:bbb',
      status: 'candidate',
      fileName: 'n.wav',
    });
    const { doc: doc1 } = submitCandidate(doc0, 'trk-1', cand);
    const again = makeVersion({ ...cand, id: 'v2-dup' });
    const { doc: doc2 } = submitCandidate(doc1, 'trk-1', again);
    assert.equal(doc2.assets.filter((a) => a.fingerprint === 'sha256:bbb').length, 1);

    const failed = makeVersion({ id: 'vf', fingerprint: 'sha256:bad', status: 'failed' });
    const d1 = registerFailure(doc0, 'trk-1', failed);
    const d2 = registerFailure(d1, 'trk-1', { ...failed, id: 'vf-dup' });
    assert.equal(d2.assets.filter((a) => a.fingerprint === 'sha256:bad').length, 1);
    // 与当前版本同指纹 → 直接拒绝
    const sameAsCurrent = makeVersion({ id: 'v9', fingerprint: 'sha256:aaa', status: 'candidate' });
    const { doc: d3 } = submitCandidate(doc0, 'trk-1', sameAsCurrent);
    assert.equal(d3.assets.length, doc0.assets.length);
  });

  it('新候选替换旧候选（同一轨道同时只有一个候选）', () => {
    const doc0 = makeDoc();
    const c1 = makeVersion({ id: 'c1', fingerprint: 'sha256:c1', status: 'candidate' });
    const c2 = makeVersion({ id: 'c2', fingerprint: 'sha256:c2', status: 'candidate' });
    const { doc: d1 } = submitCandidate(doc0, 'trk-1', c1);
    const { doc: d2, dropped } = submitCandidate(d1, 'trk-1', c2);
    assert.equal(dropped?.id, 'c1');
    assert.equal(candidateOf(d2, 'trk-1')?.id, 'c2');
  });

  it('⑤ 回退：恢复历史版本的原始声道选择，空间摆位不变，事件入链', () => {
    let doc = makeDoc();
    // 当前版本 v1 的声道选择是 R(1)；换版到 v2 时用户明确选了 L(0)
    const cand = makeVersion({
      id: 'v2',
      fingerprint: 'sha256:bbb',
      blobKey: 'fp-bbb',
      status: 'candidate',
      channel: 0,
      channels: 2,
      duration: 3,
    });
    doc = submitCandidate(doc, 'trk-1', cand).doc;
    doc = applySwitch(doc, 'trk-1', 'v2', 0);
    assert.equal(doc.tracks[0].channel, 0);
    // 回退到 v1：声道选择恢复为 v1 当初记录的 R(1)
    doc = applyRollback(doc, 'trk-1', 'v1');
    const t = doc.tracks[0];
    assert.equal(t.activeVersionId, 'v1');
    assert.equal(t.channel, 1);
    assert.deepEqual(t.position, { x: 2, y: 0, z: -1 });
    assert.equal(doc.assets.find((a) => a.id === 'v1')!.status, 'ready');
    assert.equal(doc.assets.find((a) => a.id === 'v2')!.status, 'superseded');
    assert.ok(doc.assetEvents.some((e) => e.kind === 'rollback'));
  });

  it('放弃候选：移除候选并返回 blobKey 供回收，当前版本不动', () => {
    const doc0 = makeDoc();
    const cand = makeVersion({
      id: 'c1',
      fingerprint: 'sha256:c1',
      blobKey: 'fp-c1',
      status: 'candidate',
    });
    const { doc: d1 } = submitCandidate(doc0, 'trk-1', cand);
    const { doc: d2, blobKey } = discardVersion(d1, 'c1');
    assert.equal(blobKey, 'fp-c1');
    assert.equal(candidateOf(d2, 'trk-1'), undefined);
    assert.equal(d2.tracks[0].activeVersionId, 'v1');
    assert.equal(isBlobReferenced(d2, 'fp-c1'), false);
    assert.equal(isBlobReferenced(d2, 'fp-aaa'), true);
  });

  it('当前版本上直接切 L/R 会写回版本记录（回退一致性）', () => {
    const doc0 = makeDoc();
    const d1 = updateActiveVersionChannel(doc0, 'trk-1', 0);
    assert.equal(d1.assets.find((a) => a.id === 'v1')!.channel, 0);
  });

  it('fillActiveVersionMeta 只补缺失字段', () => {
    const doc0 = makeDoc();
    const same = fillActiveVersionMeta(doc0, 'trk-1', { duration: 9, channels: 9 });
    assert.equal(same, doc0); // 已有元信息 → 不变
    const legacy = makeDoc();
    legacy.assets = [{ ...legacy.assets[0], duration: undefined, channels: undefined }];
    const filled = fillActiveVersionMeta(legacy, 'trk-1', { duration: 2.5, channels: 2 });
    assert.equal(filled.assets[0].duration, 2.5);
    assert.equal(filled.assets[0].channels, 2);
  });
});

describe('迁移与刷新', () => {
  it('旧版文档（无 assets）迁移出版本记录；候选刷新即作废并报告孤儿 Blob', () => {
    const legacyTrack = makeTrack({ activeVersionId: undefined });
    const legacyDoc = {
      version: 1,
      tracks: [legacyTrack],
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
      savedAt: 0,
    } as unknown as ProjectDoc;

    const { doc: migrated, orphanedBlobKeys } = migrateDoc(legacyDoc);
    const t = migrated.tracks[0];
    assert.ok(t.activeVersionId);
    const v = migrated.assets.find((a) => a.id === t.activeVersionId)!;
    assert.equal(v.status, 'ready');
    assert.equal(v.blobKey, 'fp-aaa');
    assert.equal(v.channel, 1);
    assert.equal(orphanedBlobKeys.length, 0);

    // 带候选的文档：候选被清除，其孤儿 Blob 键被报告
    const withCand = makeDoc();
    const cand = makeVersion({
      id: 'c1',
      fingerprint: 'sha256:c1',
      blobKey: 'fp-c1',
      status: 'candidate',
    });
    const { doc: d1 } = submitCandidate(withCand, 'trk-1', cand);
    const { doc: d2, orphanedBlobKeys: orphans } = migrateDoc(d1);
    assert.equal(candidateOf(d2, 'trk-1'), undefined);
    assert.deepEqual(orphans, ['fp-c1']);
    // 当前版本与回退链完整保留
    assert.equal(d2.tracks[0].activeVersionId, 'v1');
    assert.equal(d2.assets.find((a) => a.id === 'v1')!.status, 'ready');
  });
});
