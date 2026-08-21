import type { SessionSummary } from '../api/types';
export function SessionList({ sessions, onSelect }: { sessions: SessionSummary[]; onSelect: (id: string) => void }) {
  return (
    <table className="w-full text-sm border">
      <thead><tr className="bg-gray-50 text-left"><th className="p-2">Session</th><th>Spec</th><th>Events</th><th>Tokens</th><th>Duration(ms)</th></tr></thead>
      <tbody>
        {sessions.map((s) => (
          <tr key={s.session_id} className="border-t hover:bg-gray-50 cursor-pointer" onClick={() => onSelect(s.session_id)}>
            <td className="p-2 font-mono">{s.session_id}</td><td>{s.spec_version}</td><td>{s.event_count}</td>
            <td>{s.total_tokens?.total ?? '-'}</td><td>{s.total_duration_ms}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
