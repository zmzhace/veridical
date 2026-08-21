import { useState } from 'react';
import { useSessions, useEvaluate } from '../api/queries';

export function AuditPage() {
  const { data: sessions } = useSessions();
  const [id, setId] = useState('');
  const ev = useEvaluate();
  const ids = sessions?.map((s) => s.session_id) ?? [];
  return (
    <div className="space-y-3 max-w-xl">
      <h2 className="text-xl font-semibold">Audit</h2>
      <select className="border p-2 w-full" value={id} onChange={(e) => setId(e.target.value)}><option value="">select session</option>{ids.map((i) => <option key={i} value={i}>{i}</option>)}</select>
      <button className="bg-black text-white px-3 py-2 rounded" disabled={!id} onClick={() => ev.mutate({ sessionId: id })}>Evaluate</button>
      {ev.data && (<div className={`p-3 rounded ${ev.data.passed ? 'bg-green-50' : 'bg-red-50'}`}>Passed: {String(ev.data.passed)}</div>)}
    </div>
  );
}
