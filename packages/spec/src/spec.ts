import { z } from 'zod';
import { parse as parseYaml } from 'yaml';
import { valid } from 'semver';

export const AccessSchema = z.enum(['allow', 'deny', 'ask']);
export type Access = z.infer<typeof AccessSchema>;

export const FlowModeSchema = z.enum(['single-loop', 'supervisor', 'stage-gate']);
export type FlowMode = z.infer<typeof FlowModeSchema>;

const StageGateSchema = z.object({ tool_called: z.string().min(1) });
const StageSchema = z.object({ id: z.string().min(1), gate: StageGateSchema.optional() });
export type Stage = z.infer<typeof StageSchema>;

const FallbackSchema = z.object({ provider: z.string().min(1), model: z.string().min(1) });

const AgentRefSchema = z.object({
  name: z.string().min(1),
  spec_ref: z.string().min(1),
  when: z.string().optional(),
});
export type AgentRef = z.infer<typeof AgentRefSchema>;

export const AgentSpecSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  version: z.string().min(1),
  schema_version: z.number().int().positive(),
  instruction: z.object({ system: z.string() }),
  flow: z.object({
    mode: FlowModeSchema,
    max_steps: z.number().int().positive(),
    stages: z.array(StageSchema).optional(),
  }),
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
  agents: z.array(AgentRefSchema).default([]),
}).superRefine((spec, ctx) => {
  if (!valid(spec.version)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['version'], message: `invalid semver: ${spec.version}` });
  }
  const names = spec.tools.map(t => t.name);
  if (new Set(names).size !== names.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['tools'], message: 'duplicate tool name' });
  }
  if (spec.flow.mode === 'supervisor' && spec.agents.length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['agents'], message: 'supervisor mode requires at least one agent' });
  }
  if (spec.flow.mode === 'stage-gate') {
    if (!spec.flow.stages || spec.flow.stages.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['flow', 'stages'], message: 'stage-gate mode requires at least one stage' });
    } else {
      const toolNames = new Set(spec.tools.map(t => t.name));
      for (const s of spec.flow.stages) {
        if (s.gate && !toolNames.has(s.gate.tool_called)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['flow', 'stages'], message: `stage ${s.id} gate tool not in spec.tools: ${s.gate.tool_called}` });
        }
      }
    }
  }
});

export type AgentSpec = z.infer<typeof AgentSpecSchema>;

export function parseSpecYaml(yamlText: string): AgentSpec {
  return AgentSpecSchema.parse(parseYaml(yamlText));
}
