import type { TraceEvent } from '@veridical/schema';

export interface SessionSummary {
  session_id: string; spec_version: string; event_count: number;
  total_tokens?: { input: number; output: number; cached: number; total: number };
  total_duration_ms: number; first_seq: number; last_seq: number;
}
export type SessionEvents = TraceEvent[];
export interface ReplayResponse {
  session_id: string; up_to_seq: number; events: TraceEvent[]; last_event?: TraceEvent;
}
export interface CompareResponse {
  session_a: string; session_b: string;
  differences: { seq: number; field: string; left?: unknown; right?: unknown; kind: string }[];
  summary: { events_a: number; events_b: number; first_divergence?: number; outcomes_equal: boolean; identical: boolean };
}
export interface EvalResponse { passed: boolean; rules?: { rules: { name: string; passed: boolean; detail?: string }[]; passed: boolean } }
export interface RunResponse { session_id: string; spec_name: string; spec_version: string; outcome: unknown; events: TraceEvent[] }
