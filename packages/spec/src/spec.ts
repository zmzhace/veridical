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

/** Controls the final user-visible output without exposing raw Spec complexity. */
export const OutputProfileSchema = z
  .object({
    profile: z
      .enum(['conversational', 'structured', 'report', 'artifact'])
      .default('conversational'),
    message_format: z.enum(['markdown', 'text']).default('markdown'),
    schema: z.unknown().optional(),
    strict: z.boolean().default(true),
    repair_attempts: z.number().int().min(0).max(2).default(1),
    artifact_mime_type: z.string().min(1).max(160).optional(),
  })
  .default({
    profile: 'conversational',
    message_format: 'markdown',
    strict: true,
    repair_attempts: 1,
  });
export type SpecOutputProfile = z.infer<typeof OutputProfileSchema>;

export const AgentCapabilitiesSchema = z
  .object({
    mcp_servers: z.array(z.string().min(1).max(120)).max(32).default([]),
    knowledge_backends: z.array(z.string().min(1).max(120)).max(32).default([]),
    memory_scopes: z
      .array(z.enum(['turn', 'task', 'project', 'user', 'agent']))
      .max(8)
      .default(['turn', 'task']),
    /** Agent may choose among tools granted by this release at runtime. */
    tool_selection: z.enum(['bound', 'catalog']).default('bound'),
    /** Tool creation only produces a reviewable draft; it never grants execution. */
    tool_creation: z.enum(['disabled', 'draft']).default('disabled'),
  })
  .optional();
export type AgentCapabilities = z.infer<typeof AgentCapabilitiesSchema>;

/** A reusable, auditable capability pack. Skills add instructions only; tools remain governed by spec.tools. */
export const SkillSchema = z.object({
  name: z.string().min(1).max(80),
  version: z.string().min(1).max(40).default('1.0.0'),
  status: z.enum(['draft', 'approved', 'deprecated']).default('approved'),
  source: z.string().min(1).max(120).default('spec'),
  content_hash: z
    .string()
    .regex(/^[a-f0-9]{16,128}$/)
    .optional(),
  description: z.string().max(240).optional(),
  procedure: z.string().max(8_000).optional(),
  tags: z.array(z.string().min(1).max(32)).max(12).default([]),
});
export type Skill = z.infer<typeof SkillSchema>;

const InlineAgentSchema = z.object({
  instruction: z.object({ system: z.string().min(1) }),
  llm: z.object({ provider: z.string().min(1), model: z.string().min(1) }),
  tools: z
    .array(
      z.object({
        name: z.string().min(1),
        access: AccessSchema,
        deterministic: z.boolean().optional(),
      }),
    )
    .default([{ name: 'finish', access: 'allow', deterministic: true }]),
});

const AgentRefSchema = z
  .object({
    name: z.string().min(1),
    spec_ref: z.string().min(1).optional(),
    inline: InlineAgentSchema.optional(),
    when: z.string().optional(),
  })
  .superRefine((agent, ctx) => {
    if (!agent.spec_ref && !agent.inline)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'agent requires spec_ref or inline configuration',
      });
    if (agent.spec_ref && agent.inline)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'agent cannot have both spec_ref and inline configuration',
      });
  });
export type AgentRef = z.infer<typeof AgentRefSchema>;

export const AgentSpecSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    version: z.string().min(1),
    schema_version: z.number().int().positive(),
    instruction: z.object({ system: z.string() }),
    flow: z.object({
      // `mode` is retained for backwards compatibility; new specs should use loop.
      mode: FlowModeSchema.default('single-loop'),
      loop: z
        .object({
          engine: z.string().min(1).max(80),
          strategy: z.string().min(1).max(80).default('direct'),
        })
        .optional(),
      max_steps: z.number().int().positive(),
      stages: z.array(StageSchema).optional(),
    }),
    llm: z.object({
      provider: z.string().min(1),
      model: z.string().min(1),
      fallback: z.array(FallbackSchema).default([]),
    }),
    output: OutputProfileSchema,
    capabilities: AgentCapabilitiesSchema,
    tools: z.array(
      z.object({
        name: z.string().min(1),
        access: AccessSchema,
        deterministic: z.boolean().optional(),
      }),
    ),
    skills: z.array(SkillSchema).max(24).default([]),
    agents: z.array(AgentRefSchema).default([]),
  })
  .superRefine((spec, ctx) => {
    if (!valid(spec.version)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['version'],
        message: `invalid semver: ${spec.version}`,
      });
    }
    const names = spec.tools.map((t) => t.name);
    if (new Set(names).size !== names.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['tools'],
        message: 'duplicate tool name',
      });
    }
    if (spec.flow.mode === 'supervisor' && spec.agents.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['agents'],
        message: 'supervisor mode requires at least one agent',
      });
    }
    if (spec.flow.mode === 'stage-gate') {
      if (!spec.flow.stages || spec.flow.stages.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['flow', 'stages'],
          message: 'stage-gate mode requires at least one stage',
        });
      } else {
        const toolNames = new Set(spec.tools.map((t) => t.name));
        for (const s of spec.flow.stages) {
          if (s.gate && !toolNames.has(s.gate.tool_called)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['flow', 'stages'],
              message: `stage ${s.id} gate tool not in spec.tools: ${s.gate.tool_called}`,
            });
          }
        }
      }
    }
  });

export type AgentSpec = z.infer<typeof AgentSpecSchema>;

export function parseSpecYaml(yamlText: string): AgentSpec {
  return AgentSpecSchema.parse(parseYaml(yamlText));
}
