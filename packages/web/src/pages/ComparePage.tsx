import { useState } from 'react';
import { useSessions, useSession, useCompare } from '../api/queries';
import { TraceTimeline } from '../components/TraceTimeline';

export function ComparePage() {
  const { data: sessions } = useSessions();
  const [a, setA] = useState(''); const [b, setB] = useState('');
  const cmp = useCompare();
  const sa = useSession(a); const sb = useSession(b);
  const ids = sessions?.map((s) => s.session_id) ?? [];
  return (
    <div className="space-y-3">
      <h2 className="text-xl font-semibold">Compare runs</h2>
      <div className="flex gap-2">
        <select className="border p-2" value={a} onChange={(e) => setA(e.target.value)}><option value="">session A</option>{ids.map((i) => <option key={i} value={i}>{i}</option>)}</select>
        <select className="border p-2" value={b} onChange={(e) => setB(e.target.value)}><option value="">session B</option>{ids.map((i) => <option key={i} value={i}>{i}</option>)}</select>
        <button className="bg-black text-white px-3 py-2 rounded" onClick={() => cmp.mutate({ a, b })} disabled={!a || !b}>Compare</button>
      </div>
      {cmp.data && (<div className="text-sm">identical: {String(cmp.data.summary.identical)} · differences: {cmp.data.differences.length} · first divergence: {cmp.data.summary.first_divergence ?? '-'}</div>)}
      <div className="grid grid-cols-2 gap-4">
        <div><h3 className="font-medium">A</h3>{sa.data && <TraceTimeline events={sa.data} onSelect={() => {}} />}</div>
        <div><h3 className="font-medium">B</h3>{sb.data && <TraceTimeline events={sb.data} onSelect={() => {}} />}</div>
      </div>
    </div>
  );
}
