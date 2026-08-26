import { useState } from 'react';
import { useSessions, useSession, useCompare } from '../api/queries';
import { TraceTimeline } from '../components/TraceTimeline';
import { sessionHuman } from '../lib/events';

export function ComparePage() {
  const { data: sessions } = useSessions();
  const [a, setA] = useState(''); const [b, setB] = useState('');
  const cmp = useCompare();
  const sa = useSession(a); const sb = useSession(b);
  const ids = sessions?.map((s) => s.session_id) ?? [];
  return (
    <div className="space-y-5">
      <div>
        <h2 className="page-title">对比运行</h2>
        <p className="page-desc">选两次运行逐事件比对，找出它们从哪一步开始分叉。</p>
      </div>

      <div className="card p-4 flex flex-wrap items-center gap-3">
        <select className="field w-64" value={a} onChange={(e) => setA(e.target.value)}>
          <option value="">运行 A</option>
          {ids.map((i) => <option key={i} value={i}>{sessionHuman(i)}</option>)}
        </select>
        <select className="field w-64" value={b} onChange={(e) => setB(e.target.value)}>
          <option value="">运行 B</option>
          {ids.map((i) => <option key={i} value={i}>{sessionHuman(i)}</option>)}
        </select>
        <button className="btn btn-primary" onClick={() => cmp.mutate({ a, b })} disabled={!a || !b}>开始对比</button>
        {cmp.data && (
          <span className={`badge ${cmp.data.summary.identical ? 'badge-good' : 'badge-warn'}`}>
            {cmp.data.summary.identical ? '完全一致' : `${cmp.data.differences.length} 处差异`}
            {cmp.data.summary.first_divergence != null && ` · 最早分叉于第 ${cmp.data.summary.first_divergence} 步`}
          </span>
        )}
        {cmp.isError && <span className="text-[12px] text-red-600">对比失败</span>}
      </div>

      <div className="grid grid-cols-2 gap-5">
        <div>
          <div className="mb-2 text-[13px] font-semibold">{a ? sessionHuman(a) : '运行 A'}</div>
          {sa.data ? <TraceTimeline events={sa.data} onSelect={() => {}} /> : <div className="empty"><div className="empty-title">未选择</div></div>}
        </div>
        <div>
          <div className="mb-2 text-[13px] font-semibold">{b ? sessionHuman(b) : '运行 B'}</div>
          {sb.data ? <TraceTimeline events={sb.data} onSelect={() => {}} /> : <div className="empty"><div className="empty-title">未选择</div></div>}
        </div>
      </div>
    </div>
  );
}