import { createHash } from 'node:crypto';
import { z } from 'zod';
import { SkillSchema, AgentSpecSchema } from './spec';

export const ArtifactStatusSchema = z.enum(['draft', 'approved', 'published', 'deprecated']);
export type ArtifactStatus = z.infer<typeof ArtifactStatusSchema>;

export const ToolArtifactSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  input_schema: z.unknown().optional(),
  output_schema: z.unknown().optional(),
  side_effect: z.enum(['none', 'read', 'write', 'destructive']).default('none'),
});
export const ModelProfileSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  version: z.string().optional(),
});
export const McpDiscoverySnapshotSchema = z.object({
  server_id: z.string().min(1),
  server_version: z.string().min(1),
  schema_hash: z.string().regex(/^[a-f0-9]{64}$/),
  tools: z.array(
    z.object({
      id: z.string().min(1),
      version: z.string().min(1),
      schema_hash: z.string().regex(/^[a-f0-9]{64}$/),
    }),
  ),
  resources: z
    .array(
      z.object({
        id: z.string().min(1),
        content_hash: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
      }),
    )
    .default([]),
  prompts: z
    .array(
      z.object({
        id: z.string().min(1),
        content_hash: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
      }),
    )
    .default([]),
  discovered_at: z.string().datetime(),
});
export const AgentCapabilityManifestSchema = z
  .object({
    tools: z
      .array(
        z.object({
          id: z.string().min(1),
          version: z.string().min(1),
          schema_hash: z.string().regex(/^[a-f0-9]{64}$/),
          access: z.enum(['allow', 'deny', 'ask']),
        }),
      )
      .default([]),
    skills: z
      .array(
        z.object({
          id: z.string().min(1),
          version: z.string().min(1),
          content_hash: z.string().regex(/^[a-f0-9]{64}$/),
          activation: z.enum(['auto', 'always', 'manual']),
        }),
      )
      .default([]),
    mcp_servers: z
      .array(
        z.object({
          id: z.string().min(1),
          version: z.string().min(1),
          snapshot_hash: z.string().regex(/^[a-f0-9]{64}$/),
          tool_ids: z.array(z.string().min(1)),
        }),
      )
      .default([]),
    memory_policy_hash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    knowledge_source_hashes: z.array(z.string().regex(/^[a-f0-9]{64}$/)).default([]),
  })
  .optional();
export type AgentCapabilityManifest = z.infer<typeof AgentCapabilityManifestSchema>;
export function buildAgentCapabilityManifest(
  spec: z.infer<typeof AgentSpecSchema>,
  toolVersions: Array<{ name: string; version: string; schema_hash: string }>,
): NonNullable<AgentCapabilityManifest> {
  const bindings = spec.capabilities?.bindings ?? [];
  const mcpIds = new Set([
    ...(spec.capabilities?.mcp_servers ?? []),
    ...bindings.filter((item) => item.kind === 'mcp').map((item) => item.capability_id),
  ]);
  return {
    tools: spec.tools.map((entry) => {
      const runtime = toolVersions.find((tool) => tool.name === entry.name);
      return {
        id: entry.name,
        version: runtime?.version ?? 'unknown',
        schema_hash: runtime?.schema_hash ?? createHash('sha256').update(entry.name).digest('hex'),
        access: entry.access,
      };
    }),
    skills: spec.skills.map((skill) => {
      const binding = bindings.find(
        (item) => item.kind === 'skill' && item.capability_id === skill.name,
      );
      return {
        id: skill.name,
        version: skill.version,
        content_hash:
          skill.content_hash ?? createHash('sha256').update(canonical(skill)).digest('hex'),
        activation: binding?.activation ?? 'auto',
      };
    }),
    mcp_servers: [...mcpIds].sort().map((id) => {
      const binding = bindings.find((item) => item.kind === 'mcp' && item.capability_id === id);
      const tool_ids = binding?.selected_children ?? [];
      return {
        id,
        version: binding?.version ?? 'pinned',
        snapshot_hash: createHash('sha256')
          .update(canonical({ id, version: binding?.version ?? 'pinned', tool_ids }))
          .digest('hex'),
        tool_ids,
      };
    }),
    memory_policy_hash: spec.capabilities?.memory_scopes?.length
      ? createHash('sha256').update(canonical(spec.capabilities.memory_scopes)).digest('hex')
      : undefined,
    knowledge_source_hashes: (spec.capabilities?.knowledge_backends ?? []).map((id) =>
      createHash('sha256').update(id).digest('hex'),
    ),
  };
}
export const ReleaseArtifactSchema = z.object({
  kind: z.literal('release'),
  name: z.string().min(1),
  version: z.string().min(1),
  status: ArtifactStatusSchema,
  spec: AgentSpecSchema,
  skills: z.array(SkillSchema),
  tools: z.array(ToolArtifactSchema),
  model: ModelProfileSchema,
  capability_manifest: AgentCapabilityManifestSchema,
  content_hash: z.string().regex(/^[a-f0-9]{64}$/),
});
export type ReleaseArtifact = z.infer<typeof ReleaseArtifactSchema>;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
export function artifactHash(input: Omit<ReleaseArtifact, 'content_hash'>): string {
  return createHash('sha256').update(canonical(input)).digest('hex');
}
export function createReleaseArtifact(
  input: Omit<ReleaseArtifact, 'content_hash'>,
): ReleaseArtifact {
  return ReleaseArtifactSchema.parse({ ...input, content_hash: artifactHash(input) });
}
