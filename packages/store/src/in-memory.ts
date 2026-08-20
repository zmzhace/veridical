import type { TraceEvent } from '@rt/schema';
import type { TraceStore } from './trace-store';

export class InMemoryTraceStore implements TraceStore {
  private events = new Map<string, TraceEvent[]>();

  async append(evt: TraceEvent): Promise<void> {
    const list = this.events.get(evt.session_id) ?? [];
    list.push(evt);
    this.events.set(evt.session_id, list);
  }

  async readBySession(session_id: string): Promise<TraceEvent[]> {
    return [...(this.events.get(session_id) ?? [])].sort((a, b) => a.seq - b.seq);
  }

  async bySeq(session_id: string, seq: number): Promise<TraceEvent | undefined> {
    return (await this.readBySession(session_id)).find(e => e.seq === seq);
  }
}