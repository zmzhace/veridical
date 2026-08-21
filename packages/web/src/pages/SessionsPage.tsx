import { useNavigate } from 'react-router-dom';
import { useSessions } from '../api/queries';
import { SessionList } from '../components/SessionList';
export function SessionsPage() {
  const { data, isLoading, error } = useSessions();
  const nav = useNavigate();
  if (isLoading) return <p>Loading…</p>;
  if (error) return <p className="text-red-600">Failed to load sessions.</p>;
  return (<div><h2 className="text-xl font-semibold mb-4">Sessions</h2>{data && data.length ? <SessionList sessions={data} onSelect={(id) => nav(`/sessions/${id}`)} /> : <p>No sessions found in <code>.traces</code>.</p>}</div>);
}
