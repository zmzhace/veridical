import { parseEvent, type TraceEvent } from '@veridical/schema';
import type { NewTraceEvent, TraceStore } from './trace-store';
import { assertAppendable, nextEvent } from './integrity';

export class InMemoryTraceStore implements TraceStore {
  private events = new Map<string, TraceEvent[]>();

  async append(evt: TraceEvent): Promise<void> {
    this.insert(parseEvent(structuredClone(evt)));
  }

  private insert(evt: TraceEvent): void {
    const list = this.events.get(evt.session_id) ?? [];
    assertAppendable(list, evt);
    list.push(evt);
    this.events.set(evt.session_id, list);
  }

  async appendNext(input: NewTraceEvent): Promise<TraceEvent> {
    // No await between allocation and insertion: atomic within this JS process.
    const evt = nextEvent(this.events.get(input.session_id) ?? [], structuredClone(input));
    this.insert(evt);
    return structuredClone(evt);
  }

  async readBySession(session_id: string): Promise<TraceEvent[]> {
    return structuredClone(this.events.get(session_id) ?? []).sort((a, b) => a.seq - b.seq);
  }

  async bySeq(session_id: string, seq: number): Promise<TraceEvent | undefined> {
    return (await this.readBySession(session_id)).find(e => e.seq === seq);
  }
}
