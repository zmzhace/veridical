import { z } from 'zod';
import { parse as parseYaml } from 'yaml';
import { valid } from 'semver';

export const AccessSchema = z.enum(['allow', 'deny', 'ask']);
export type Access = z.infer<typeof AccessSchema>;

export const FlowModeSchema = z.enum(['single-loop']);
export type FlowMode = z.infer<typeof FlowModeSchema>;

const FallbackSchema = z.object({ provider: z.string().min(1), model: z.string().min(1) });

export const AgentSpecSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  version: z.string().min(1),
  schema_version: z.number().int().positive(),
  instruction: z.object({ system: z.string() }),
  flow: z.object({ mode: FlowModeSchema, max_steps: z.number().int().positive() }),
  llm: z.object({
    provider: z.string().min(1),
    model: z.string().min(1),
    fallback: z.array(FallbackSchema).default([]),
  }),
  tools: z.array(z.object({
    name: z.string().min(1),
    access: AccessSchema,
    deterministic: z.boolean().optional(),
  })),
}).superRefine((spec, ctx) => {
  if (!valid(spec.version)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['version'], message: `invalid semver: ${spec.version}` });
  }
  const names = spec.tools.map(t => t.name);
  if (new Set(names).size !== names.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['tools'], message: 'duplicate tool name' });
  }
});

export type AgentSpec = z.infer<typeof AgentSpecSchema>;

export function parseSpecYaml(yamlText: string): AgentSpec {
  return AgentSpecSchema.parse(parseYaml(yamlText));
}
