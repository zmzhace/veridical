import type { SessionSummary } from '../api/types';
import { sessionHuman } from '../lib/events';

export function SessionList({ sessions, onSelect }: { sessions: SessionSummary[]; onSelect: (id: string) => void }) {
  return (
    <div className="grid gap-3">
      {sessions.map((s) => {
        const tokens = s.total_tokens?.total ?? 0;
        const dur = s.total_duration_ms;
        return (
          <button key={s.session_id} onClick={() => onSelect(s.session_id)}
            className="card px-5 py-4 text-left transition-all hover:border-[var(--accent)] hover:shadow-sm hover:-translate-y-px">
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-semibold truncate">{sessionHuman(s.session_id)}</span>
                  <span className="badge badge-neutral mono">{s.spec_version}</span>
                </div>
                <p className="text-xs text-[var(--muted)] mt-1 mono truncate">{s.session_id}</p>
              </div>
              <div className="flex items-center gap-6 shrink-0 tnum text-[13px] text-[var(--muted)]">
                <span title="事件数">{s.event_count} 事件</span>
                <span title="token 用量">{tokens} tok</span>
                <span title="耗时">{dur} ms</span>
                <span className="text-[var(--accent)]">→</span>
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}