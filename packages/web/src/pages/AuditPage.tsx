import { useState } from 'react';
import { useSessions, useEvaluate } from '../api/queries';
import { sessionHuman } from '../lib/events';

export function AuditPage() {
  const { data: sessions } = useSessions();
  const [id, setId] = useState('');
  const ev = useEvaluate();
  const ids = sessions?.map((s) => s.session_id) ?? [];
  return (
    <div className="space-y-5 max-w-xl">
      <div>
        <h2 className="page-title">审计</h2>
        <p className="page-desc">对一次运行按规则评估：有没有合规问题、结果是否达标。</p>
      </div>

      <div className="card p-4 space-y-3">
        <div>
          <label className="label">选择会话</label>
          <select className="field" value={id} onChange={(e) => setId(e.target.value)}>
            <option value="">请选择…</option>
            {ids.map((i) => <option key={i} value={i}>{sessionHuman(i)}</option>)}
          </select>
        </div>
        <button className="btn btn-primary" disabled={!id} onClick={() => ev.mutate({ sessionId: id })}>
          {ev.isPending ? '评估中…' : '开始评估'}
        </button>

        {ev.data && (
          <div className={`rounded-lg border p-4 ${ev.data.passed ? 'border-emerald-200 bg-emerald-50' : 'border-red-200 bg-red-50'}`}>
            <div className="flex items-center gap-2">
              <span className={`w-8 h-7 flex items-center justify-center rounded-md text-xs font-bold ${ev.data.passed ? 'bg-emerald-600 text-white' : 'bg-red-600 text-white'}`}>{ev.data.passed ? '✓' : '✕'}</span>
              <span className="font-semibold">{ev.data.passed ? '通过' : '未通过'}</span>
            </div>
            {ev.data.rules && (
              <ul className="mt-3 space-y-1.5">
                {ev.data.rules.rules.map((r) => (
                  <li key={r.name} className="flex items-center gap-2 text-[13px]">
                    <span className={`badge ${r.passed ? 'badge-good' : 'badge-bad'}`}>{r.passed ? '通过' : '未过'}</span>
                    <span>{r.name}</span>
                    {r.detail && <span className="text-[var(--muted)] text-[12px]">{r.detail}</span>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {ev.isError && <p className="text-[13px] text-red-600">评估失败。</p>}
      </div>
    </div>
  );
}