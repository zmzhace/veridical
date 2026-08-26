import type { TraceEvent } from '@veridical/schema';
import { eventMeta, toneClass } from '../lib/events';

const TRACE_KEYS = ['spec/run/start', 'spec/run/end', 'turn/start', 'turn/end', 'stage/start', 'stage/end'];

function depthOf(e: TraceEvent, all: TraceEvent[]): number {
  let d = 0; let cur: TraceEvent | undefined = e;
  while (cur && cur.parent_span_id) { d++; cur = all.find((x) => x.span_id === cur!.parent_span_id); if (d > 20) break; }
  return d;
}

export function TraceTimeline({ events, onSelect }: { events: TraceEvent[]; onSelect: (e: TraceEvent) => void }) {
  return (
    <div className="space-y-1.5">
      {events.map((e) => {
        const meta = eventMeta(e);
        const depth = depthOf(e, events);
        const isTrace = TRACE_KEYS.includes(e.type);
        const isStep = e.type === 'step/start' || e.type === 'step/end';
        return (
          <button key={e.id} onClick={() => onSelect(e)}
            style={{ marginLeft: depth * 20 }}
            className={`w-full text-left rounded-lg border transition-colors hover:border-[var(--accent)] ${isTrace ? 'bg-[var(--accent-soft)]/60 border-transparent' : isStep ? 'bg-transparent border-transparent hover:bg-[#f6f4f0]' : 'card'}`}>
            <div className={`flex items-start gap-2.5 px-3 ${isStep ? 'py-1.5' : 'py-2.5'}`}>
              {/* icon */}
              <span className={`mt-0.5 w-7 h-6 shrink-0 flex items-center justify-center rounded-md text-[11px] font-bold border ${toneClass(meta.tone)}`}>
                {meta.icon}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2 flex-wrap">
                  <span className="text-[13px] font-semibold">{meta.label}</span>
                  <span className="text-[11px] text-[var(--muted)]">{meta.desc(e)}</span>
                </div>
                {e.type === 'tool.called' && (
                  <div className="mt-1 text-[11px] mono text-[var(--muted)] truncate">{JSON.stringify((e.payload as any)?.args ?? {})}</div>
                )}
                {e.type === 'llm.request' && (e.payload as any)?.messages?.slice(-1)?.[0]?.content && (
                  <div className="mt-1 text-[11px] text-[var(--muted)] line-clamp-2">{(e.payload as any).messages.slice(-1)[0].content.slice(0, 120)}</div>
                )}
              </div>
              <div className="shrink-0 flex items-center gap-2 tnum text-[11px] text-[var(--muted)]">
                <span>{e.duration_ms}ms</span>
                <span className="mono">{e.seq}</span>
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}