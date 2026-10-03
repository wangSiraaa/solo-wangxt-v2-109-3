/**
 * 素材换版纯逻辑测试：指纹/兼容性/去重/原子切换/定位解析/v1 迁移。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AssetVersion, ProjectDoc, Track } from '../src/types.ts';
import {
  applyVersionSwitch,
  computeFingerprint,
  durationToleranceSec,
  evaluateCompatibility,
  findSameContentVersion,
  getCurrentVersion,
  getPendingCandidates,
  getSupersededVersions,
  markCandidateFailed,
  markCandidateProbed,
  migrateDoc,
  resolveStartOffset,
  shortFingerprint,
  switchNeedsChannelChoice,
  switchNeedsPositionChoice,
  VersionSwitchError,
} from '../src/lib/versioning.ts';

const FP_A = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const FP_B = 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function ver(over: Partial<AssetVersion> = {}): AssetVersion {
  return {
    id: over.id ?? 'v1',
    blobKey: over.blobKey ?? 'blob-1',
    fingerprint: over.fingerprint ?? FP_A,
    fingerprintAlg: 'sha-256',
    fileName: over.fileName ?? 'a.wav',
    fileSize: 100,
    fileType: 'audio/wav',
    status: over.status ?? 'ready',
    channels: ('channels' in over ? over.channels : 2) ?? null,
    duration: ('duration' in over ? over.duration : 10) ?? null,
    sampleRate: 48000,
    selectedChannel: over.selectedChannel,
    error: over.error,
    createdAt: 1000,
    readyAt: over.readyAt ?? 1000,
  };
}

function trackWith(versions: AssetVersion[], currentId?: string, over: Partial<Track> = {}): Track {
  return {
    id: 't',
    name: 'T',
    sourceType: 'file',
    versions,
    currentVersionId: currentId ?? versions.find((v) => v.status === 'ready')?.id,
    loop: false,
    muted: false,
    solo: false,
    gain: 0.9,
    channel: over.channel ?? 0,
    color: '#fff',
    position: { x: 1, y: 0, z: 0 },
    status: 'ready',
    channels: over.channels ?? 2,
    duration: over.duration ?? 10,
    ...over,
  };
}

describe('素材换版纯逻辑', () => {
  it('内容指纹：相同字节得到相同 sha256，不同字节不同；unknown 指纹不参与去重', async () => {
    const b1 = new Blob([new Uint8Array([1, 2, 3, 4])]);
    const b1copy = new Blob([new Uint8Array([1, 2, 3, 4])]);
    const b2 = new Blob([new Uint8Array([1, 2, 3, 5])]);
    const f1 = await computeFingerprint(b1);
    const f1c = await computeFingerprint(b1copy);
    const f2 = await computeFingerprint(b2);
    assert.equal(f1.fingerprint, f1c.fingerprint);
    assert.notEqual(f1.fingerprint, f2.fingerprint);
    assert.ok(f1.fingerprint.startsWith('sha256:'));
    assert.equal(f1.fingerprint.length, 'sha256:'.length + 64);

    const t = trackWith([ver({ fingerprint: 'unknown:v1:blob-1' })]);
    assert.equal(findSameContentVersion(t, 'unknown:v1:blob-1'), null);
    assert.equal(shortFingerprint('unknown:v1:x'), 'legacy');
  });

  it('同内容指纹判定（任意状态）——验收③重复文件不产生新版本', () => {
    const ready = ver();
    const failed = ver({ id: 'vf', status: 'failed', fingerprint: FP_B, fileName: 'bad.wav' });
    const t = trackWith([ready, failed]);
    assert.equal(findSameContentVersion(t, FP_A)?.id, 'v1');
    assert.equal(findSameContentVersion(t, FP_B)?.id, 'vf');
    assert.equal(findSameContentVersion(t, 'sha256:cccc'), null);
  });

  it('兼容性：声道数不同 → 声道不兼容；时长差在容差内兼容、超出不兼容', () => {
    const cur = { channels: 2, duration: 10 };
    assert.deepEqual(evaluateCompatibility(cur, { channels: 2, duration: 10.1 }), {
      channelsCompatible: true,
      durationCompatible: true,
      durationDeltaSec: 0.09999999999999964,
    });
    const far = evaluateCompatibility(cur, { channels: 2, duration: 11 });
    assert.equal(far.durationCompatible, false);
    assert.ok(Math.abs(far.durationDeltaSec - 1) < 1e-9);
    const ch = evaluateCompatibility(cur, { channels: 1, duration: 10 });
    assert.equal(ch.channelsCompatible, false);
    assert.equal(ch.durationCompatible, false); // 声道变化时时长也按不兼容处理（必须显式走选择流程）
    // 无当前版本时（首版）一律视为兼容
    assert.deepEqual(evaluateCompatibility(null, { channels: 5, duration: 3 }), {
      channelsCompatible: true,
      durationCompatible: true,
      durationDeltaSec: 0,
    });
    assert.ok(durationToleranceSec(100) === 0.5);
    assert.ok(durationToleranceSec(10) === 0.25);
  });

  it('needs* 选择判定正确', () => {
    const cur = ver({ channels: 2, duration: 10 });
    const t = trackWith([cur]);
    const mono = ver({ id: 'cand', status: 'candidate', channels: 1, duration: 10 });
    const longer = ver({ id: 'cand2', status: 'candidate', channels: 2, duration: 12 });
    const same = ver({ id: 'cand3', status: 'candidate', channels: 2, duration: 10.01 });
    assert.equal(switchNeedsChannelChoice(getCurrentVersion(t), mono), true);
    assert.equal(switchNeedsChannelChoice(getCurrentVersion(t), same), false);
    assert.equal(switchNeedsPositionChoice(getCurrentVersion(t), longer), true);
    assert.equal(switchNeedsPositionChoice(getCurrentVersion(t), same), false);
  });

  it('定位解析：三种模式都被钳制到目标时长内；explicit 用用户秒数', () => {
    const target = { duration: 5 };
    assert.equal(resolveStartOffset(8, target, { mode: 'keep-relative' }), 5);
    assert.equal(resolveStartOffset(2, target, { mode: 'keep-relative' }), 2);
    assert.equal(resolveStartOffset(2, target, { mode: 'from-start' }), 0);
    assert.equal(resolveStartOffset(8, target, { mode: 'explicit', explicitOffsetSec: 3.2 }), 3.2);
    assert.equal(resolveStartOffset(8, target, { mode: 'explicit', explicitOffsetSec: 99 }), 5);
    assert.equal(resolveStartOffset(-4, target, { mode: 'keep-relative' }), 0);
  });

  it('原子换版：旧版本 superseded 且记录原声道；目标 ready；轨参数指向新版本；来源链追加 swap', () => {
    const cur = ver({ id: 'v0', blobKey: 'b0', fileName: 'old.wav', selectedChannel: 0 });
    const cand = ver({
      id: 'v1',
      blobKey: 'b1',
      fileName: 'new.wav',
      fingerprint: FP_B,
      status: 'candidate',
      channels: 2,
      duration: 10,
    });
    const t = trackWith([cur, cand], 'v0', { channel: 1, channels: 2, duration: 10 });
    const r = applyVersionSwitch(t, {
      target: cand,
      channel: 0,
      resolution: { mode: 'keep-relative' },
      kind: 'swap',
      at: 5000,
      prevOffsetSec: 3,
    });
    assert.equal(r.startOffsetSec, 3);
    assert.equal(r.track.currentVersionId, 'v1');
    assert.equal(r.track.blobKey, 'b1');
    assert.equal(r.track.originalFileName, 'new.wav');
    assert.equal(r.track.channel, 0);
    const v0 = r.track.versions!.find((x) => x.id === 'v0')!;
    const v1 = r.track.versions!.find((x) => x.id === 'v1')!;
    assert.equal(v0.status, 'superseded');
    assert.equal(v0.selectedChannel, 1); // 回退时恢复的“原始声道选择”
    assert.equal(v1.status, 'ready');
    assert.equal(v1.readyAt, 5000);
    assert.equal(r.log.kind, 'swap');
    assert.equal(r.log.fromVersionId, 'v0');
    assert.equal(r.log.toVersionId, 'v1');
    assert.equal(r.track.swapLog?.length, 1);
    // 入参未被修改（失败无中间态的前提）
    assert.equal(cur.status, 'ready');
    assert.equal(cand.status, 'candidate');
  });

  it('回退：superseded → ready，原当前 → superseded；日志 kind=rollback；恢复当年声道', () => {
    const v0 = ver({ id: 'v0', status: 'superseded', selectedChannel: 1, fileName: 'old.wav', blobKey: 'b0' });
    const v1 = ver({ id: 'v1', status: 'ready', selectedChannel: 0, fileName: 'new.wav', blobKey: 'b1', fingerprint: FP_B });
    const t = trackWith([v0, v1], 'v1', { channel: 0 });
    const target = t.versions!.find((x) => x.id === 'v0')!;
    const r = applyVersionSwitch(t, {
      target,
      channel: 1,
      resolution: { mode: 'from-start' },
      kind: 'rollback',
      at: 9000,
      prevOffsetSec: 4,
    });
    assert.equal(r.startOffsetSec, 0);
    const nv0 = r.track.versions!.find((x) => x.id === 'v0')!;
    const nv1 = r.track.versions!.find((x) => x.id === 'v1')!;
    assert.equal(nv0.status, 'ready');
    assert.equal(nv1.status, 'superseded');
    assert.equal(nv1.selectedChannel, 0);
    assert.equal(r.track.channel, 1);
    assert.equal(r.log.kind, 'rollback');
    // 历史列表仍可继续回退（v1 现在是 superseded）
    assert.equal(getSupersededVersions(r.track)[0].id, 'v1');
  });

  it('非法切换被拒绝：目标不存在/状态错误/声道越界，均不产生中间态', () => {
    const cur = ver();
    const t = trackWith([cur]);
    assert.throws(
      () =>
        applyVersionSwitch(t, {
          target: ver({ id: 'ghost', status: 'candidate' }),
          channel: 0,
          resolution: { mode: 'from-start' },
          kind: 'swap',
          at: 1,
          prevOffsetSec: 0,
        }),
      VersionSwitchError,
    );
    const failed = ver({ id: 'f', status: 'failed' });
    const t2 = trackWith([cur, failed], 'v1');
    assert.throws(
      () =>
        applyVersionSwitch(t2, {
          target: failed,
          channel: 0,
          resolution: { mode: 'from-start' },
          kind: 'swap',
          at: 1,
          prevOffsetSec: 0,
        }),
      VersionSwitchError,
    );
    const cand = ver({ id: 'c', status: 'candidate', channels: 1 });
    const t3 = trackWith([cur, cand], 'v1');
    assert.throws(
      () =>
        applyVersionSwitch(t3, {
          target: cand,
          channel: 2, // 越界：单声道只有 0
          resolution: { mode: 'from-start' },
          kind: 'swap',
          at: 1,
          prevOffsetSec: 0,
        }),
      VersionSwitchError,
    );
    // 未通过解码（channels/duration null）不可切
    const unprobed = ver({ id: 'u', status: 'candidate', channels: null, duration: null });
    const t4 = trackWith([cur, unprobed], 'v1');
    assert.throws(
      () =>
        applyVersionSwitch(t4, {
          target: unprobed,
          channel: 0,
          resolution: { mode: 'from-start' },
          kind: 'swap',
          at: 1,
          prevOffsetSec: 0,
        }),
      VersionSwitchError,
    );
    // 原轨原样
    assert.equal(getCurrentVersion(t3)!.id, 'v1');
    assert.equal(getPendingCandidates(t3).length, 1);
  });

  it('markCandidateProbed / markCandidateFailed 只移动目标候选，不碰其他版本', () => {
    const cur = ver({ id: 'v0' });
    const c1 = ver({ id: 'c1', status: 'candidate', channels: null, duration: null });
    const c2 = ver({ id: 'c2', status: 'candidate', channels: null, duration: null, fingerprint: FP_B });
    const t = trackWith([cur, c1, c2], 'v0');
    const p = markCandidateProbed(t, 'c1', { channels: 1, duration: 3, sampleRate: 44100 });
    assert.deepEqual(
      p.versions!.find((x) => x.id === 'c1'),
      { ...c1, channels: 1, duration: 3, sampleRate: 44100 },
    );
    assert.equal(p.versions!.find((x) => x.id === 'c2')!.channels, null);
    const f = markCandidateFailed(p, 'c2', '解码失败：坏文件');
    assert.equal(f.versions!.find((x) => x.id === 'c2')!.status, 'failed');
    assert.equal(f.versions!.find((x) => x.id === 'c2')!.error, '解码失败：坏文件');
    assert.equal(f.versions!.find((x) => x.id === 'v0')!.status, 'ready');
  });

  it('v1 工程迁移：file 轨补 ready 的 legacy 版本（unknown 指纹）；doc.version=2；样例轨不动', () => {
    const doc: ProjectDoc = {
      version: 1,
      tracks: [
        {
          id: 'f',
          name: 'old.wav',
          sourceType: 'file',
          blobKey: 'old-blob',
          originalFileName: 'old.wav',
          loop: false,
          muted: false,
          solo: false,
          gain: 0.7,
          channel: 1,
          channels: 2,
          color: '#fff',
          position: { x: 0, y: 0, z: 0 },
          status: 'ready',
          duration: 8,
        },
        {
          id: 's',
          name: 'tone',
          sourceType: 'tone',
          loop: true,
          muted: false,
          solo: false,
          gain: 0.9,
          channel: 0,
          color: '#000',
          position: { x: 0, y: 0, z: 0 },
          status: 'ready',
        },
      ],
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
      savedAt: 123,
    };
    const m = migrateDoc(doc);
    assert.equal(m.version, 2);
    const ft = m.tracks[0];
    assert.equal(ft.versions?.length, 1);
    const legacy = ft.versions![0];
    assert.equal(legacy.status, 'ready');
    assert.equal(legacy.blobKey, 'old-blob');
    assert.equal(legacy.fingerprintAlg, 'unknown');
    assert.equal(legacy.selectedChannel, 1);
    assert.equal(ft.currentVersionId, legacy.id);
    assert.equal(m.tracks[1].versions, undefined);
    // 已是 v2 时原样返回
    assert.equal(migrateDoc(m), m);
  });
});
