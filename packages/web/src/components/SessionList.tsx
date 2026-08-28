import type { SessionSummary } from '../api/types';
import { sessionHuman } from '../lib/events';

export function SessionList({ sessions, onSelect, kind }: {
  sessions: SessionSummary[]; onSelect: (id: string) => void; kind?: 'conv' | 'run';
}) {
  return (
    <div className="session-list">
      {sessions.map((s) => {
        const tokens = s.total_tokens?.total ?? 0;
        const title = kind === 'conv' ? (s.spec_name ?? '对话') : sessionHuman(s.session_id);
        return (
          <button key={s.session_id} onClick={() => onSelect(s.session_id)}
            className="session-row">
            <div className="session-row-content">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-semibold truncate">{title}</span>
                  <span className="badge badge-neutral mono">{s.spec_version}</span>
                  {kind === 'conv' && s.turn_count ? <span className="badge badge-accent">{s.turn_count} 轮</span> : null}
                </div>
                <p className="text-xs text-[var(--muted)] mt-1 mono truncate">
                  {kind === 'conv' ? (s.first_message || s.session_id) : s.session_id}
                </p>
              </div>
              <div className="session-row-metrics tnum">
                <span title="事件数">{s.event_count} 事件</span>
                <span title="token 用量">{tokens} tok</span>
                <span className="text-[var(--accent)]">→</span>
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}
