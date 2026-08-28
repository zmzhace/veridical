import { parseEvent, type TraceEvent } from '@veridical/schema';
import type { NewTraceEvent } from './trace-store';

export function assertStorageKey(value: string): void {
  if (typeof value !== 'string' || !value || value === '.' || value === '..' || /[/\\\0]/.test(value)) {
    throw new Error('invalid storage key');
  }
}

export function assertAppendable(events: TraceEvent[], evt: TraceEvent): void {
  if (events.some(e => e.tenant_id !== evt.tenant_id)) {
    throw new Error('session belongs to a different tenant');
  }
  if (events.some(e => e.seq === evt.seq || e.id === evt.id)) {
    throw new Error('duplicate event identity or sequence');
  }
}

export function nextEvent(events: TraceEvent[], input: NewTraceEvent): TraceEvent {
  const seq = events.reduce((max, e) => Math.max(max, e.seq), 0) + 1;
  return parseEvent({ ...input, id: `evt_${input.session_id}_${seq}`, seq });
}
