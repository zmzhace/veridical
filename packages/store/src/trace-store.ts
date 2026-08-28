import type { TraceEvent } from '@veridical/schema';

export type NewTraceEvent = Omit<TraceEvent, 'id' | 'seq'>;

export interface TraceStore {
  append(evt: TraceEvent): Promise<void>;
  /** Allocate identity and append as one operation. Never implement as an unlocked read/append pair. */
  appendNext(evt: NewTraceEvent): Promise<TraceEvent>;
  readBySession(session_id: string): Promise<TraceEvent[]>;
  bySeq(session_id: string, seq: number): Promise<TraceEvent | undefined>;
}
