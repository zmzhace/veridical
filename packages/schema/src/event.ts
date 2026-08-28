import { z } from 'zod';

export const EventVerbSchema = z.enum(['request', 'response', 'error', 'stream_chunk']);
export type EventVerb = z.infer<typeof EventVerbSchema>;

export const TokensSchema = z.object({
  input: z.number(),
  output: z.number(),
  cached: z.number(),
  total: z.number(),
});
export type Tokens = z.infer<typeof TokensSchema>;

export const TraceEventSchema = z.object({
  id: z.string(),
  tenant_id: z.string(),
  session_id: z.string(),
  span_id: z.string(),
  parent_span_id: z.string().nullable(),
  seq: z.number().int().nonnegative(),
  type: z.string(),
  verb: EventVerbSchema,
  attempt: z.number().int().nonnegative(),
  duration_ms: z.number().nonnegative(),
  tokens: TokensSchema.optional(),
  cost: z.number().optional(),
  payload: z.unknown(),
  call_id: z.string().optional(),
  spec_version: z.string(),
  timestamp: z.string().datetime().optional(),
  event_schema_version: z.number().int().positive().optional(),
  actor_id: z.string().optional(),
  run_id: z.string().optional(),
  invocation_id: z.string().optional(),
  parent_invocation_id: z.string().optional(),
  path: z.string().optional(),
  replay_key: z.string().optional(),
  ordinal: z.number().int().positive().optional(),
  path_source: z.enum(['explicit', 'legacy']).optional(),
});

export type TraceEvent = z.infer<typeof TraceEventSchema>;

export function parseEvent(input: unknown): TraceEvent {
  return TraceEventSchema.parse(input);
}
