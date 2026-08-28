import { AgentSpecSchema, type AgentSpec } from '@veridical/spec/schema';
import { parseDocument, stringify } from 'yaml';
import type { SpecFormState } from './formToYaml';

export const starterSkills = [
  { name: '结构化输出', description: '将结果整理为清晰的结论、依据和下一步。', procedure: '先给结论，再列关键依据；不确定时明确标注。', tags: ['质量', '表达'] },
  { name: '事实核验', description: '区分已知事实、推断和待确认信息。', procedure: '对关键结论给出来源或核验步骤，避免把推测写成事实。', tags: ['可靠性'] },
  { name: '安全边界', description: '在敏感或高风险任务中主动识别限制。', procedure: '执行前检查权限、隐私和可逆性；需要外部操作时先请求确认。', tags: ['治理', '安全'] },
] as const;

export function recommendSkills(text: string) {
  const source = text.toLowerCase();
  return starterSkills.filter((skill) =>
    (skill.name === '事实核验' && /查|搜|检索|事实|来源|核验|research|search|source/.test(source)) ||
    (skill.name === '结构化输出' && /总结|报告|分析|整理|输出|summary|report|分析/.test(source)) ||
    (skill.name === '安全边界' && /客户|订单|发送|删除|支付|医疗|隐私|权限|安全|delete|send/.test(source)),
  );
}

export type { AgentSpec };
export type FieldErrors = Record<string, string>;

export function blankSpec(): SpecFormState {
  return {
    name: '',
    version: '0.1.0',
    schemaVersion: 1,
    description: '',
    system: '',
    llmProvider: '',
    llmModel: '',
    fallbacks: [],
    mode: 'single-loop',
    loop: '',
    loopStrategy: 'direct',
    maxSteps: 10,
    stages: [],
    agents: [],
    tools: [],
    skills: [],
  };
}

export function specToForm(s: AgentSpec): SpecFormState {
  return {
    name: s.name,
    version: s.version,
    schemaVersion: s.schema_version,
    description: s.description ?? '',
    system: s.instruction.system,
    llmProvider: s.llm.provider,
    llmModel: s.llm.model,
    fallbacks: s.llm.fallback ?? [],
    mode: s.flow.mode,
    loop: s.flow.loop?.engine ?? '',
    loopStrategy: s.flow.loop?.strategy ?? 'direct',
    maxSteps: s.flow.max_steps,
    stages: (s.flow.stages ?? []).map((r) => ({ id: r.id, tool: r.gate?.tool_called ?? '' })),
    agents: (s.agents ?? []).map((r) => ({
      name: r.name,
      specRef: r.spec_ref ?? '',
      when: r.when ?? '',
      system: r.inline?.instruction.system,
      provider: r.inline?.llm.provider,
      model: r.inline?.llm.model,
    })),
    tools: s.tools.map((r) => ({ ...r, deterministic: r.deterministic ?? false })),
    skills: (s.skills ?? []).map((r) => ({
      version: r.version, status: r.status, source: r.source, content_hash: r.content_hash,
      name: r.name,
      description: r.description ?? '',
      procedure: r.procedure ?? '',
      tags: r.tags ?? [],
    })),
  };
}

// Do not silently filter incomplete rows: validation must catch them before saving.
export function formToSpec(f: SpecFormState): AgentSpec {
  return {
    name: f.name,
    version: f.version,
    schema_version: f.schemaVersion,
    ...(f.description ? { description: f.description } : {}),
    instruction: { system: f.system },
    llm: { provider: f.llmProvider, model: f.llmModel, fallback: f.fallbacks },
    flow: {
      mode: f.mode,
      ...(f.loop?.trim() ? { loop: { engine: f.loop.trim(), strategy: f.loopStrategy ?? 'direct' } } : {}),
      max_steps: f.maxSteps,
      ...(f.stages.length
        ? {
            stages: f.stages.map((r) => ({
              id: r.id,
              ...(r.tool ? { gate: { tool_called: r.tool } } : {}),
            })),
          }
        : {}),
    },
    tools: f.tools.map((r) => ({ ...r })),
    skills: (f.skills ?? []).filter((r) => r.name.trim()).map((r) => ({
      version: r.version ?? '1.0.0', status: r.status ?? 'draft', source: r.source ?? 'spec',
      ...(r.content_hash ? { content_hash: r.content_hash } : {}),
      name: r.name.trim(),
      ...(r.description.trim() ? { description: r.description.trim() } : {}),
      ...(r.procedure.trim() ? { procedure: r.procedure.trim() } : {}),
      tags: r.tags,
    })),
    agents: f.agents.map((r) =>
      r.specRef
        ? {
            name: r.name,
            spec_ref: r.specRef,
            ...(r.when ? { when: r.when } : {}),
          }
        : {
            name: r.name,
            inline: {
              instruction: {
                system:
                  r.system?.trim() ||
                  `你负责${r.name}相关的任务。请根据主管分派完成工作，并返回清晰结果。`,
              },
              llm: { provider: r.provider || f.llmProvider, model: r.model || f.llmModel },
              tools: [{ name: 'finish', access: 'allow' as const, deterministic: true }],
            },
            ...(r.when ? { when: r.when } : {}),
          },
    ),
  };
}

export const editorYaml = (f: SpecFormState) => stringify(formToSpec(f), { lineWidth: 0 });

export function validateSpec(input: unknown): { spec?: AgentSpec; errors: FieldErrors } {
  const parsed = AgentSpecSchema.safeParse(input);
  const errors: FieldErrors = {};
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const key = issue.path.join('.');
      errors[key] =
        issue.code === 'custom'
          ? ({
              version: '请输入语义化版本，例如 1.0.0 或 1.1.0-beta.1。',
              tools: '工具名称不能重复。',
              agents: '主管编排至少需要一个专家。',
              'flow.stages': '至少添加一个阶段，门控工具必须已在工具权限中声明。',
            }[key] ?? issue.message)
          : '请填写完整，类型或取值不符合规格要求。';
    }
    return { errors };
  }
  const s = parsed.data;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(s.name))
    errors.name = '名称只能包含字母、数字、点、下划线和短横线，并以字母或数字开头。';
  if (!s.instruction.system.trim())
    errors['instruction.system'] = '请填写系统指令，说明任务目标与行为边界。';
  if (!s.llm.provider.trim()) errors['llm.provider'] = '请填写已注册的 Provider。';
  if (!s.llm.model.trim()) errors['llm.model'] = '请填写模型标识。';
  for (const [i, t] of s.tools.entries())
    if (!t.name.trim()) errors[`tools.${i}.name`] = '工具名称不能为空。';
  const ids = (s.flow.stages ?? []).map((r) => r.id);
  if (new Set(ids).size !== ids.length) errors['flow.stages'] = '阶段 ID 不能重复。';
  return { spec: s, errors };
}

function unknownPaths(raw: unknown, parsed: unknown, path = ''): string[] {
  if (!raw || typeof raw !== 'object') return [];
  return Object.entries(raw).flatMap(([key, value]) => {
    const next = path ? `${path}.${key}` : key;
    if (!parsed || typeof parsed !== 'object' || !Object.hasOwn(parsed, key)) return [next];
    return unknownPaths(value, (parsed as Record<string, unknown>)[key], next);
  });
}

export function readEditorYaml(text: string): { spec?: AgentSpec; errors: FieldErrors } {
  try {
    const doc = parseDocument(text, { uniqueKeys: true });
    if (doc.errors.length) return { errors: { yaml: `YAML 格式错误：${doc.errors[0].message}` } };
    const raw: unknown = doc.toJS({ maxAliasCount: 50 });
    const result = validateSpec(raw);
    if (result.spec) {
      const extra = unknownPaths(raw, result.spec);
      if (extra.length)
        return {
          errors: {
            yaml: `存在未支持的字段：${extra.join('、')}。为避免保存时丢失配置，请先移除或修正。`,
          },
        };
    }
    return result;
  } catch (e) {
    return { errors: { yaml: `无法解析 YAML：${e instanceof Error ? e.message : '未知错误'}` } };
  }
}

export function nextVersion(version: string, used: string[]): string {
  const match = /^(?:v)?(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) return '0.1.0';
  let patch = Number(match[3]) + 1;
  while (used.includes(`${match[1]}.${match[2]}.${patch}`)) patch++;
  return `${match[1]}.${match[2]}.${patch}`;
}

/** Deterministic, explainable starter tools for the quick setup flow. */
export function suggestTools(
  text: string,
): Array<{ name: string; access: 'allow' | 'deny' | 'ask'; deterministic: boolean }> {
  const source = text.toLowerCase();
  const suggestions: Array<{
    name: string;
    access: 'allow' | 'deny' | 'ask';
    deterministic: boolean;
  }> = [];
  const add = (name: string, access: 'allow' | 'deny' | 'ask', deterministic = false) => {
    if (!suggestions.some((tool) => tool.name === name))
      suggestions.push({ name, access, deterministic });
  };
  if (/查|搜|检索|订单|search|lookup|query/.test(source)) add('search', 'ask');
  if (/算|计算|金额|统计|calculate|math|sum/.test(source)) add('calculator', 'allow', true);
  if (/写|保存|更新|创建|发送|删除|修改|write|save|update|send|delete/.test(source))
    add('write', 'ask');
  add('finish', 'allow', true);
  return suggestions;
}
