import { useRef, useState } from 'react';
import type { AssetVersion, Track, VersionResolution } from '../types';
import type { WorkbenchApi } from '../state/useWorkbench';
import {
  evaluateCompatibility,
  formatVersionTime,
  getCurrentVersion,
  getFailedCandidates,
  getPendingCandidates,
  getSupersededVersions,
  shortFingerprint,
  switchNeedsChannelChoice,
  switchNeedsPositionChoice,
} from '../lib/versioning';

interface Props {
  track: Track;
  api: WorkbenchApi;
}

function fmtDur(v: AssetVersion): string {
  return v.duration == null ? '时长未知' : `${v.duration.toFixed(2)} s`;
}
function fmtCh(v: AssetVersion): string {
  if (v.channels == null) return '声道未知';
  if (v.channels === 1) return '单声道';
  if (v.channels === 2) return '立体声（2 声道）';
  return `${v.channels} 声道`;
}
function channelLabel(i: number): string {
  if (i === 0) return 'L（原始左）';
  if (i === 1) return 'R（原始右）';
  return `CH${i + 1}`;
}
function resolutionLabel(r: VersionResolution): string {
  switch (r.mode) {
    case 'from-start':
      return '从头播放';
    case 'explicit':
      return `定位到 ${(r.explicitOffsetSec ?? 0).toFixed(2)}s`;
    case 'keep-relative':
    default:
      return '保持当前位置（钳制）';
  }
}

/**
 * 本地素材换版面板（来源链）：
 * 当前版本 → 待确认候选（含不兼容时的显式声道/定位处理）→ 失败候选（原因可见）
 * → 历史版本回退 → 换版/回退记录。全部随工程持久化到 IndexedDB。
 */
export function VersionChain({ track, api }: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'dup' | 'err'; text: string } | null>(null);

  if (track.sourceType !== 'file') return null;

  const current = getCurrentVersion(track);
  const candidates = getPendingCandidates(track);
  const failed = getFailedCandidates(track);
  const history = getSupersededVersions(track);
  const log = track.swapLog ?? [];

  const onPick = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setBusy(true);
    setNotice(null);
    const r = await api.submitCandidate(track.id, files[0]);
    setBusy(false);
    if (r.kind === 'candidate-ready') setNotice({ kind: 'ok', text: r.message ?? '候选已就绪，请确认切换' });
    else if (r.kind === 'duplicate') setNotice({ kind: 'dup', text: r.message ?? '相同内容已存在' });
    else setNotice({ kind: 'err', text: r.message ?? '候选提交失败' });
  };

  return (
    <div className="version-chain">
      <div className="vc-head">
        <span className="vc-title">素材版本 · 来源链</span>
        <label className="btn mini">
          {busy ? '校验中…' : '⇄ 换版（选新文件）'}
          <input
            ref={fileRef}
            type="file"
            accept="audio/*"
            hidden
            disabled={busy}
            onChange={(e) => {
              void onPick(e.target.files);
              if (fileRef.current) fileRef.current.value = '';
            }}
          />
        </label>
      </div>

      {notice && (
        <div className={`vc-notice vc-${notice.kind}`}>
          {notice.kind === 'err' ? '⚠ ' : notice.kind === 'dup' ? 'ⓘ ' : '✓ '}
          {notice.text}
          <button className="btn mini ghost" onClick={() => setNotice(null)}>
            ×
          </button>
        </div>
      )}

      {/* 当前试听版本（最后一份可试听素材在成功切换前永不被覆盖） */}
      <div className="vc-current">
        <span className="vc-badge current">当前试听</span>
        {current ? (
          <span className="vc-version" title={current.fileName}>
            <b>{current.fileName}</b>
            <span className="vc-meta">
              {fmtCh(current)} · {fmtDur(current)} · fp:{shortFingerprint(current.fingerprint)}
              {current.readyAt ? ` · ${formatVersionTime(current.readyAt)}` : ''}
            </span>
          </span>
        ) : (
          <span className="vc-meta err">尚无可用版本（导入失败，可重新选文件换版）</span>
        )}
      </div>

      {/* 待确认候选：必须在浏览器内解码通过；不兼容必须显式选择声道/定位 */}
      {candidates.map((v) => (
        <CandidateCard key={v.id} track={track} target={v} api={api} onResult={setNotice} />
      ))}

      {/* 失败候选：原因可见，不影响当前素材与其他轨 */}
      {failed.map((v) => (
        <div key={v.id} className="vc-item failed" title={v.error}>
          <span className="vc-badge failed">校验失败</span>
          <span className="vc-version">
            <b>{v.fileName}</b>
            <span className="vc-meta err">⚠ {v.error ?? '解码失败'} · fp:{shortFingerprint(v.fingerprint)}</span>
          </span>
          <button
            className="btn mini ghost danger"
            onClick={() => void api.discardVersion(track.id, v.id)}
            title="移除失败候选（不影响当前素材）"
          >
            丢弃
          </button>
        </div>
      ))}

      {/* 历史版本（可回退，Blob 与链均保留） */}
      {history.length > 0 && (
        <div className="vc-history">
          <div className="vc-subhead">历史版本（可回退）</div>
          {history.map((v) => (
            <RollbackRow key={v.id} track={track} target={v} api={api} onResult={setNotice} />
          ))}
        </div>
      )}

      {/* 来源链：换版/回退记录 */}
      {log.length > 0 && (
        <details className="vc-log">
          <summary>来源链记录（{log.length}）</summary>
          <ol>
            {log
              .slice()
              .reverse()
              .map((e) => (
                <li key={e.id} className={e.kind === 'rollback' ? 'rollback' : ''}>
                  <span className={`vc-kind ${e.kind}`}>{e.kind === 'rollback' ? '回退' : '换版'}</span>
                  <span title={`${e.fromFingerprint ?? ''} → ${e.toFingerprint}`}>
                    {e.fromFileName ? `${e.fromFileName} → ` : ''}
                    <b>{e.toFileName}</b>
                  </span>
                  <span className="vc-meta">
                    {formatVersionTime(e.at)} · 用 {channelLabel(e.channel)} · {resolutionLabel(e.resolution)}
                    {e.compatibility.channelsCompatible ? '' : ' · 声道布局变更（已显式选择）'}
                    {e.compatibility.durationCompatible
                      ? ''
                      : ` · 时长差 ${e.compatibility.durationDeltaSec >= 0 ? '+' : ''}${e.compatibility.durationDeltaSec.toFixed(2)}s（已显式定位）`}
                  </span>
                </li>
              ))}
          </ol>
        </details>
      )}
    </div>
  );
}

interface CardProps {
  track: Track;
  target: AssetVersion;
  api: WorkbenchApi;
  onResult: (n: { kind: 'ok' | 'dup' | 'err'; text: string } | null) => void;
}

/**
 * 候选/回退的显式选择卡片。
 * 声道布局不兼容 → 必须点选目标素材的原始 L/R（绝不自动映射）；
 * 时长不兼容 → 必须选择播放定位（保持并钳制 / 从头 / 指定秒数）。
 */
function SwitchCard({ track, target, api, onResult, kind }: CardProps & { kind: 'swap' | 'rollback' }) {
  const current = getCurrentVersion(track);
  const incompatCh = switchNeedsChannelChoice(current, target);
  const incompatDur = switchNeedsPositionChoice(current, target);
  const compat = current ? evaluateCompatibility(current, target) : null;

  // 默认值：回退优先用该版本当年选择的声道；兼容换版沿用当前选择
  const initialChannel = clamp(
    target.selectedChannel ?? track.channel,
    target.channels ?? 1,
  );
  const [channel, setChannel] = useState(initialChannel);
  const [channelChosen, setChannelChosen] = useState(!incompatCh);
  const [mode, setMode] = useState<VersionResolution['mode'] | ''>(incompatDur ? '' : 'keep-relative');
  const [explicit, setExplicit] = useState('0');
  const [busy, setBusy] = useState(false);

  if (target.channels == null || target.duration == null) {
    return (
      <div className="vc-item pending">
        <span className="vc-badge pending">候选</span>
        <span className="vc-version">
          <b>{target.fileName}</b>
          <span className="vc-meta">浏览器解码校验中…</span>
        </span>
      </div>
    );
  }

  const needsExplicit = incompatCh || incompatDur;
  const canConfirm =
    channelChosen &&
    (!incompatDur || mode !== '') &&
    !busy &&
    channel >= 0 &&
    channel < target.channels!;

  const doSwitch = async () => {
    if (!canConfirm) return;
    const resolution: VersionResolution =
      mode === 'explicit'
        ? { mode, explicitOffsetSec: Number(explicit) || 0 }
        : { mode: (mode || 'keep-relative') as VersionResolution['mode'] };
    setBusy(true);
    const r =
      kind === 'rollback'
        ? await api.rollbackVersion(track.id, target.id, { channel, resolution })
        : await api.confirmSwitch(track.id, target.id, { channel, resolution });
    setBusy(false);
    if (r.kind === 'candidate-ready') onResult({ kind: 'ok', text: r.message ?? '切换完成' });
    else onResult({ kind: 'err', text: r.message ?? '切换失败' });
  };

  return (
    <div className={`vc-item ${kind === 'rollback' ? 'history' : 'pending'}`}>
      <div className="vc-item-row">
        <span className={`vc-badge ${kind === 'rollback' ? 'history' : 'pending'}`}>
          {kind === 'rollback' ? '可回退' : '候选就绪'}
        </span>
        <span className="vc-version">
          <b>{target.fileName}</b>
          <span className="vc-meta">
            {fmtCh(target)} · {fmtDur(target)} · fp:{shortFingerprint(target.fingerprint)}
            {compat && current
              ? ` · 对当前时长差 ${compat.durationDeltaSec >= 0 ? '+' : ''}${compat.durationDeltaSec.toFixed(2)}s`
              : ''}
          </span>
        </span>
      </div>

      {needsExplicit && (
        <div className="vc-resolve">
          {!compat?.channelsCompatible && (
            <div className="vc-field warn">
              <span>声道布局变化（当前 {current?.channels ?? '?'} → 新 {target.channels}）：请明确选择要送入 HRTF 的原始声道，不做自动映射</span>
              <div className="vc-ch-buttons">
                {Array.from({ length: target.channels! }).map((_, i) => (
                  <button
                    key={i}
                    className={`btn mini ${channel === i && channelChosen ? 'active' : ''}`}
                    onClick={() => {
                      setChannel(i);
                      setChannelChosen(true);
                    }}
                  >
                    {channelLabel(i)}
                  </button>
                ))}
              </div>
            </div>
          )}
          {!compat?.durationCompatible && (
            <div className="vc-field warn">
              <span>
                时长不兼容（当前 {current?.duration?.toFixed(2) ?? '?'}s → 新 {target.duration!.toFixed(2)}s）：请明确播放定位
              </span>
              <div className="vc-pos">
                <label>
                  <input
                    type="radio"
                    name={`pos-${target.id}`}
                    checked={mode === 'keep-relative'}
                    onChange={() => setMode('keep-relative')}
                  />
                  保持当前进度（钳制到新素材时长内）
                </label>
                <label>
                  <input
                    type="radio"
                    name={`pos-${target.id}`}
                    checked={mode === 'from-start'}
                    onChange={() => setMode('from-start')}
                  />
                  新版本从头开始
                </label>
                <label className="vc-explicit">
                  <input
                    type="radio"
                    name={`pos-${target.id}`}
                    checked={mode === 'explicit'}
                    onChange={() => setMode('explicit')}
                  />
                  定位到
                  <input
                    type="number"
                    min={0}
                    max={target.duration!}
                    step={0.1}
                    value={explicit}
                    onChange={(e) => {
                      setExplicit(e.target.value);
                      setMode('explicit');
                    }}
                  />
                  秒
                </label>
              </div>
            </div>
          )}
        </div>
      )}

      {!needsExplicit && (
        <div className="vc-meta ok">
          ✓ 声道布局与时长兼容；将沿用当前原始声道选择（{channelLabel(channel)}）与播放位置
        </div>
      )}

      <div className="vc-actions">
        <button className="btn small primary" disabled={!canConfirm} onClick={() => void doSwitch()}>
          {busy ? '切换中…' : kind === 'rollback' ? '确认回退到此版本' : '确认切换（原子生效）'}
        </button>
        {kind === 'swap' && (
          <button className="btn mini ghost" onClick={() => void api.discardVersion(track.id, target.id)}>
            放弃候选
          </button>
        )}
      </div>
    </div>
  );
}

function CandidateCard(props: CardProps) {
  return <SwitchCard {...props} kind="swap" />;
}
function RollbackRow(props: CardProps) {
  return <SwitchCard {...props} kind="rollback" />;
}

function clamp(v: number, max: number): number {
  return Math.min(Math.max(0, v), Math.max(0, max - 1));
}
