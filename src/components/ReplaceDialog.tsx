import { useEffect, useState } from 'react';
import type { SwitchPositioning } from '../types';
import type { WorkbenchApi } from '../state/useWorkbench';
import { assessCompatibility } from '../lib/assetFlow';

function fmtDur(d?: number): string {
  return d == null ? '未知' : `${d.toFixed(2)}s`;
}

function fmtCh(c?: number): string {
  if (c == null) return '未知';
  if (c === 1) return '单声道';
  if (c === 2) return '立体声';
  return `${c} 声道`;
}

function channelLabel(i: number): string {
  if (i === 0) return 'L（原始左）';
  if (i === 1) return 'R（原始右）';
  return `CH${i + 1}`;
}

/**
 * 换版确认弹窗。
 *  - 兼容：声道布局与时长一致，沿用当前版本的原始声道选择、保持当前播放位置，
 *    用户一键确认即可；
 *  - 不兼容：绝不隐式映射——用户必须明确选择新文件的原始左/右声道，
 *    以及切换后的播放定位方式，两者选齐才能确认。
 * 确认前当前版本始终是试听来源；放弃候选不影响任何播放。
 */
export function ReplaceDialog({ api }: { api: WorkbenchApi }) {
  const pending = api.pendingCandidate;
  const [channel, setChannel] = useState<number | null>(null);
  const [positioning, setPositioning] = useState<SwitchPositioning | null>(null);

  useEffect(() => {
    setChannel(null);
    setPositioning(null);
  }, [pending?.candidate.id]);

  if (!pending) return null;
  const { track, candidate, current } = pending;
  const compat = assessCompatibility(current ?? {}, candidate);
  const candidateChannels = candidate.channels ?? 1;
  // 声道布局不同且新文件为多声道时，必须显式选择；单声道只有一个选择，直接展示
  const mustPickChannel = compat.channelsDiffer && candidateChannels > 1;
  const mustPickPositioning = compat.durationDiffer;
  const effectiveChannel = mustPickChannel
    ? channel
    : Math.min(candidate.channel, candidateChannels - 1);
  const effectivePositioning = mustPickPositioning ? positioning : 'keep-time';
  const canConfirm = effectiveChannel != null && effectivePositioning != null;

  return (
    <div className="replace-overlay">
      <div className="replace-card">
        <div className="replace-title">换版确认 · {track.name}</div>

        <div className="replace-compare">
          <div className="replace-col">
            <div className="replace-col-title">当前版本（仍在试听）</div>
            <div className="replace-file" title={current?.fileName}>
              {current?.fileName ?? track.originalFileName ?? '—'}
            </div>
            <div className="muted small">
              {fmtCh(current?.channels)} · {fmtDur(current?.duration)}
            </div>
          </div>
          <div className="replace-arrow">→</div>
          <div className="replace-col">
            <div className="replace-col-title">候选新版本</div>
            <div className="replace-file" title={candidate.fileName}>
              {candidate.fileName}
            </div>
            <div className="muted small">
              {fmtCh(candidate.channels)} · {fmtDur(candidate.duration)}
            </div>
            {candidate.fingerprint && (
              <div className="muted small fingerprint" title={candidate.fingerprint}>
                指纹 {candidate.fingerprint.replace(/^sha256:/, '').slice(0, 12)}…
              </div>
            )}
          </div>
        </div>

        {compat.compatible ? (
          <div className="replace-note ok">
            ✓ 声道布局与时长兼容：沿用当前原始声道选择，切换后保持当前播放位置。
          </div>
        ) : (
          <div className="replace-note warn">
            <b>兼容性差异，需要明确处理：</b>
            <ul>
              {compat.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </div>
        )}

        {compat.channelsDiffer && (
          <div className="replace-section">
            <div className="replace-section-title">原始声道选择（新文件）</div>
            {candidateChannels === 1 ? (
              <div className="muted small">新文件为单声道，直接作为 HRTF 输入。</div>
            ) : (
              <div className="radio-row">
                {Array.from({ length: candidateChannels }).map((_, i) => (
                  <label key={i} className={`radio-pill ${channel === i ? 'active' : ''}`}>
                    <input
                      type="radio"
                      name="replace-channel"
                      checked={channel === i}
                      onChange={() => setChannel(i)}
                    />
                    {channelLabel(i)}
                  </label>
                ))}
              </div>
            )}
            {mustPickChannel && channel == null && (
              <div className="replace-hint">声道布局已变化，请明确选择使用新文件的哪个原始声道。</div>
            )}
          </div>
        )}

        {mustPickPositioning && (
          <div className="replace-section">
            <div className="replace-section-title">播放定位（时长已变化）</div>
            <div className="radio-col">
              <label className={`radio-pill ${positioning === 'restart' ? 'active' : ''}`}>
                <input
                  type="radio"
                  name="replace-positioning"
                  checked={positioning === 'restart'}
                  onChange={() => setPositioning('restart')}
                />
                从头开始播放
              </label>
              <label className={`radio-pill ${positioning === 'keep-time' ? 'active' : ''}`}>
                <input
                  type="radio"
                  name="replace-positioning"
                  checked={positioning === 'keep-time'}
                  onChange={() => setPositioning('keep-time')}
                />
                保持当前秒位置（超出新时长则截到末尾）
              </label>
              <label className={`radio-pill ${positioning === 'keep-ratio' ? 'active' : ''}`}>
                <input
                  type="radio"
                  name="replace-positioning"
                  checked={positioning === 'keep-ratio'}
                  onChange={() => setPositioning('keep-ratio')}
                />
                保持相对进度比例
              </label>
            </div>
            {positioning == null && (
              <div className="replace-hint">时长已变化，请明确选择切换后的播放定位方式。</div>
            )}
          </div>
        )}

        <div className="muted small">
          切换只作用于本轨：空间摆位、增益、静音/独奏与其他轨保持不变；当前版本会保留在来源链中，可随时回退。
        </div>

        <div className="replace-actions">
          <button
            className="btn primary"
            disabled={!canConfirm}
            onClick={() =>
              void api.confirmCandidate(track.id, {
                channel: effectiveChannel ?? 0,
                positioning: effectivePositioning ?? 'keep-time',
              })
            }
          >
            确认切换
          </button>
          <button className="btn" onClick={() => api.cancelCandidate(track.id)}>
            放弃候选
          </button>
          <button className="btn ghost" onClick={api.closeCandidateDialog}>
            稍后决定
          </button>
        </div>
      </div>
    </div>
  );
}
