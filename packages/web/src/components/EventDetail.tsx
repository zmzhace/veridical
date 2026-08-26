import type { TraceEvent } from '@veridical/schema';
import { eventMeta } from '../lib/events';

export function EventDetail({ event, onClose }: { event: TraceEvent; onClose: () => void }) {
  const meta = eventMeta(event);
  const rows: [string, string][] = [
    ['序号', String(event.seq)],
    ['所属环节', event.span_id],
    ['尝试次数', String(event.attempt)],
    ['调用 ID', event.call_id ?? '-'],
    ['耗时', `${event.duration_ms}ms`],
  ];
  if (event.tokens) rows.push(['Token', `${event.tokens.input}入 / ${event.tokens.output}出`]);

  return (
    <div className="fixed right-0 top-0 h-full w-[420px] bg-[var(--surface)] border-l border-[var(--line)] p-5 overflow-auto shadow-xl flex flex-col">
      <div className="flex items-start justify-between mb-1">
        <div className="flex items-center gap-2.5">
          <span className={`w-8 h-7 flex items-center justify-center rounded-md text-xs font-bold border ${meta.tone === 'bad' ? 'text-red-700 bg-red-50 border-red-200' : meta.tone === 'good' ? 'text-emerald-700 bg-emerald-50 border-emerald-200' : 'text-indigo-700 bg-indigo-50 border-indigo-200'}`}>{meta.icon}</span>
          <div>
            <h3 className="font-semibold">{meta.label}</h3>
            <p className="text-xs text-[var(--muted)]">{meta.desc(event)}</p>
          </div>
        </div>
        <button onClick={onClose} className="btn btn-ghost px-2 py-1 text-xs">关闭</button>
      </div>
      <dl className="mt-4 text-[13px] space-y-1.5 border-t border-[var(--line)] pt-3">
        {rows.map(([k, v]) => (
          <div key={k} className="flex justify-between gap-4">
            <dt className="text-[var(--muted)] shrink-0">{k}</dt>
            <dd className="mono text-right break-all">{v}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-4 flex-1 min-h-0 flex flex-col">
        <div className="text-xs font-semibold text-[var(--muted)] mb-2">内容</div>
        <pre className="flex-1 text-[11px] mono bg-[#faf9f7] border border-[var(--line)] rounded-lg p-3 overflow-auto">{JSON.stringify(event.payload, null, 2)}</pre>
      </div>
    </div>
  );
}