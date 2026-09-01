import { z } from 'zod';

export const InvocationActorSchema = z.enum(['agent', 'llm', 'tool', 'memory', 'knowledge', 'mcp', 'skill', 'loop', 'join', 'checkpoint', 'approval']);
export const InvocationStatusSchema = z.enum([
  'started',
  'success',
  'failed',
  'cancelled',
  'blocked',
]);
export const InvocationRecordSchema = z.object({
  run_id: z.string().min(1),
  invocation_id: z.string().min(1),
  parent_invocation_id: z.string().min(1).optional(),
  path: z.string().min(1),
  ordinal: z.number().int().positive(),
  attempt: z.number().int().positive(),
  actor: InvocationActorSchema,
  agent: z.string().optional(),
  loop: z.string().optional(),
  operation: z.string().min(1),
  input: z.unknown(),
  output: z.unknown().optional(),
  status: InvocationStatusSchema,
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  error: z
    .object({
      code: z.string(),
      message: z.union([
        z.string(),
        z.object({ redacted: z.literal(true), hash: z.string(), policy: z.string() }),
      ]),
    })
    .optional(),
  side_effect_state: z.enum(['not_started', 'completed', 'unknown']).optional(),
});
export type InvocationRecord = z.infer<typeof InvocationRecordSchema>;
export type InvocationActor = z.infer<typeof InvocationActorSchema>;
export type InvocationStatus = z.infer<typeof InvocationStatusSchema>;
