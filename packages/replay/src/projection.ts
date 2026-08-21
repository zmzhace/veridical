import type { TraceStore } from '@veridical/store';
import type { TraceEvent } from '@veridical/schema';
import { deriveMessages, type ModelMessage } from '@veridical/runtime';

export interface ProjectionSnapshot {
  session_id: string;
  up_to_seq: number;
  messages: ModelMessage[];
  events: TraceEvent[];
  last_event?: TraceEvent;
}

export class TraceProjection {
  constructor(private store: TraceStore) {}

  async projectAt(session_id: string, seq: number): Promise<ProjectionSnapshot> {
    const all = await this.store.readBySession(session_id);
    const events = seq <= 0 ? [] : all.filter(e => e.seq <= seq);
    const up_to_seq = events.length > 0 ? events[events.length - 1].seq : 0;
    const messages = seq <= 0 ? [] : await deriveMessages(this.store, session_id, up_to_seq);
    return { session_id, up_to_seq, messages, events, last_event: events.length > 0 ? events[events.length - 1] : undefined };
  }

  async *cursor(session_id: string): AsyncIterable<ProjectionSnapshot> {
    const count = await this.count(session_id);
    for (let seq = 1; seq <= count; seq++) {
      yield await this.projectAt(session_id, seq);
    }
  }

  async count(session_id: string): Promise<number> {
    return (await this.store.readBySession(session_id)).length;
  }
}
