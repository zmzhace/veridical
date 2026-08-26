import type { TraceEvent } from '@veridical/schema';

const COLORS: Record<string, string> = {
  'llm.request': 'border-blue-400', 'llm.response': 'border-blue-400',
  'tool.called': 'border-amber-400', 'tool.result': 'border-amber-400',
  'state.snapshot': 'border-gray-300', 'turn/end': 'border-green-400',
};
function depthOf(e: TraceEvent, all: TraceEvent[]): number {
  let d = 0; let cur: TraceEvent | undefined = e;
  while (cur && cur.parent_span_id) { d++; cur = all.find((x) => x.span_id === cur!.parent_span_id); if (d > 20) break; }
  return d;
}

export function TraceTimeline({ events, onSelect }: { events: TraceEvent[]; onSelect: (e: TraceEvent) => void }) {
  return (
    <div className="space-y-1">
      {events.map((e) => (
        <button key={e.id} onClick={() => onSelect(e)} style={{ marginLeft: depthOf(e, events) * 16 }}
          className={`w-full text-left border-l-4 ${COLORS[e.type] ?? 'border-gray-200'} p-2 rounded hover:bg-gray-50 ${
            e.type === 'stage/start' || e.type === 'stage/end'
              ? 'bg-teal-50/40'
              : e.span_id && e.span_id !== 'loop' && e.span_id !== 'supervisor' && e.span_id !== 'spec'
                ? 'bg-amber-50/40'
                : 'bg-white'
          }`}>
          <span className="font-mono text-xs text-gray-500">seq {e.seq}</span>{' '}
          <span className="font-mono text-sm">{e.type}</span>{' '}
          {e.type === 'stage/start' || e.type === 'stage/end' ? (
            <span className="ml-1 text-[10px] px-1 rounded bg-teal-100 text-teal-700">[stage:{(e.payload as any)?.stage}]</span>
          ) : (
            e.span_id && e.span_id !== 'loop' && e.span_id !== 'supervisor' && e.span_id !== 'spec' && (
              <span className="ml-1 text-[10px] px-1 rounded bg-amber-100 text-amber-700">[{e.span_id}]</span>
            )
          )}{' '}
          <span className="text-xs text-gray-400">{e.duration_ms}ms</span>
        </button>
      ))}
    </div>
  );
}
