import type { AssetEvent, AssetVersion, Track } from '../types';
import type { WorkbenchApi } from '../state/useWorkbench';

const STATUS_LABEL: Record<AssetVersion['status'], string> = {
  ready: '当前',
  candidate: '候选',
  superseded: '已取代',
  failed: '失败',
};

const EVENT_LABEL: Record<AssetEvent['kind'], string> = {
  import: '导入',
  submit: '提交候选',
  switch: '切换',
  rollback: '回退',
  fail: '失败',
  discard: '移除',
};

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleString();
}

function shortFingerprint(fp: string): string {
  if (!fp) return '未知';
  return fp.replace(/^sha256:/, '').slice(0, 10);
}

function VersionItem({ v, api }: { v: AssetVersion; api: WorkbenchApi }) {
  return (
    <div className={`version-item ${v.status}`}>
      <div className="version-head">
        <span className={`version-badge ${v.status}`}>{STATUS_LABEL[v.status]}</span>
        <span className="version-name" title={v.fileName}>
          {v.fileName}
        </span>
      </div>
      <div className="version-meta">
        {v.channels != null && <span>{v.channels}ch</span>}
        {v.duration != null && <span>{v.duration.toFixed(2)}s</span>}
        {v.channels != null && v.channels > 1 && (
          <span title="该版本选定的文件原始声道">
            {v.channel === 0 ? '原始L' : v.channel === 1 ? '原始R' : `CH${v.channel + 1}`}
          </span>
        )}
        <span title={v.fingerprint || '（旧版迁移，指纹未知）'}>
          指纹 {shortFingerprint(v.fingerprint)}
        </span>
        <span>{fmtTime(v.createdAt)}</span>
      </div>
      <div className="version-note muted small">{v.note}</div>
      {v.status === 'failed' && (
        <div className="version-error" title={v.errorMessage}>
          ⚠ {v.errorMessage ?? '解码失败'}
        </div>
      )}
      <div className="version-actions">
        {v.status === 'candidate' && (
          <>
            <button className="btn mini primary" onClick={() => api.openCandidateDialog(v.trackId)}>
              处理候选…
            </button>
            <button className="btn mini ghost" onClick={() => api.cancelCandidate(v.trackId)}>
              放弃
            </button>
          </>
        )}
        {v.status === 'superseded' && (
          <button
            className="btn mini"
            onClick={() => void api.rollbackToVersion(v.trackId, v.id)}
            title="切换回此版本（恢复其原始声道选择，空间摆位不变）"
          >
            回退到此版本
          </button>
        )}
        {v.status === 'failed' && (
          <button className="btn mini ghost danger" onClick={() => api.dismissFailedVersion(v.id)}>
            移除记录
          </button>
        )}
      </div>
    </div>
  );
}

/** 素材来源链：版本历史 + 换版/回退/失败事件记录 */
export function VersionChain({ api, track }: { api: WorkbenchApi; track: Track }) {
  if (track.sourceType !== 'file') return null;
  const versions = api.doc.assets
    .filter((a) => a.trackId === track.id)
    .sort((a, b) => b.createdAt - a.createdAt);
  const events = api.doc.assetEvents
    .filter((e) => e.trackId === track.id)
    .slice(-8)
    .reverse();

  return (
    <div className="version-chain">
      <div className="panel-subtitle">素材来源链</div>
      {versions.length === 0 && <div className="muted small">暂无版本记录。</div>}
      {versions.map((v) => (
        <VersionItem key={v.id} v={v} api={api} />
      ))}
      {events.length > 0 && (
        <div className="asset-events">
          <div className="panel-subtitle">换版记录</div>
          {events.map((e) => (
            <div key={e.id} className="asset-event">
              <span className="muted">{new Date(e.at).toLocaleTimeString()}</span>{' '}
              <b>{EVENT_LABEL[e.kind]}</b> {e.detail}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
