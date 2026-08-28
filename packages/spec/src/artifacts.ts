import { createHash } from 'node:crypto';
import { z } from 'zod';
import { SkillSchema, AgentSpecSchema } from './spec';

export const ArtifactStatusSchema = z.enum(['draft', 'approved', 'published', 'deprecated']);
export type ArtifactStatus = z.infer<typeof ArtifactStatusSchema>;

export const ToolArtifactSchema = z.object({
  name: z.string().min(1), version: z.string().min(1),
  input_schema: z.unknown().optional(), output_schema: z.unknown().optional(),
  side_effect: z.enum(['none', 'read', 'write']).default('none'),
});
export const ModelProfileSchema = z.object({ provider: z.string().min(1), model: z.string().min(1), version: z.string().optional() });
export const ReleaseArtifactSchema = z.object({
  kind: z.literal('release'), name: z.string().min(1), version: z.string().min(1), status: ArtifactStatusSchema,
  spec: AgentSpecSchema, skills: z.array(SkillSchema), tools: z.array(ToolArtifactSchema), model: ModelProfileSchema,
  content_hash: z.string().regex(/^[a-f0-9]{64}$/),
});
export type ReleaseArtifact = z.infer<typeof ReleaseArtifactSchema>;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value as object).sort().map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
export function artifactHash(input: Omit<ReleaseArtifact, 'content_hash'>): string {
  return createHash('sha256').update(canonical(input)).digest('hex');
}
export function createReleaseArtifact(input: Omit<ReleaseArtifact, 'content_hash'>): ReleaseArtifact {
  return ReleaseArtifactSchema.parse({ ...input, content_hash: artifactHash(input) });
}
