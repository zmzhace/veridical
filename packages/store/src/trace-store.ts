import type { TraceEvent } from '@veridical/schema';

export interface TraceStore {
  append(evt: TraceEvent): Promise<void>;
  readBySession(session_id: string): Promise<TraceEvent[]>;
  bySeq(session_id: string, seq: number): Promise<TraceEvent | undefined>;
}