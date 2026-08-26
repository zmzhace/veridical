export interface FallbackRow { provider: string; model: string }
export interface StageRow { id: string; tool: string }
export interface AgentRow { name: string; specRef: string; when: string }
export interface ToolRow { name: string; access: 'allow' | 'deny' | 'ask'; deterministic: boolean }

export interface SpecFormState {
  name: string;
  version: string;
  schemaVersion: number;
  description: string;
  system: string;
  llmProvider: string;
  llmModel: string;
  fallbacks: FallbackRow[];
  mode: 'single-loop' | 'supervisor' | 'stage-gate';
  maxSteps: number;
  stages: StageRow[];
  agents: AgentRow[];
  tools: ToolRow[];
}

const q = JSON.stringify;
const has = (s: string) => s.trim().length > 0;

export function formToYaml(f: SpecFormState): string {
  const out: string[] = [];
  out.push(`name: ${q(f.name)}`);
  out.push(`version: ${q(f.version || '0.1.0')}`);
  out.push(`schema_version: ${f.schemaVersion || 1}`);
  if (has(f.description)) out.push(`description: ${q(f.description)}`);
  out.push(`instruction:`);
  out.push(`  system: ${q(f.system)}`);
  out.push(`flow:`);
  out.push(`  mode: ${f.mode}`);
  out.push(`  max_steps: ${f.maxSteps || 1}`);
  if (f.mode === 'stage-gate') {
    const rows = f.stages.filter(r => has(r.id));
    if (rows.length) {
      out.push(`  stages:`);
      for (const s of rows) {
        out.push(`    - id: ${q(s.id)}`);
        if (has(s.tool)) out.push(`      gate:`);
        if (has(s.tool)) out.push(`        tool_called: ${q(s.tool)}`);
      }
    }
  }
  out.push(`llm:`);
  out.push(`  provider: ${q(f.llmProvider)}`);
  out.push(`  model: ${q(f.llmModel)}`);
  const fbs = f.fallbacks.filter(r => has(r.provider) && has(r.model));
  if (fbs.length) {
    out.push(`  fallback:`);
    for (const fb of fbs) {
      out.push(`    - provider: ${q(fb.provider)}`);
      out.push(`      model: ${q(fb.model)}`);
    }
  }
  const tools = f.tools.filter(r => has(r.name));
  if (tools.length) {
    out.push(`tools:`);
    for (const t of tools) {
      out.push(`  - name: ${q(t.name)}`);
      out.push(`    access: ${t.access}`);
      if (t.deterministic) out.push(`    deterministic: true`);
    }
  } else {
    out.push(`tools: []`);
  }
  const agents = f.agents.filter(r => has(r.name));
  if (agents.length) {
    out.push(`agents:`);
    for (const a of agents) {
      out.push(`  - name: ${q(a.name)}`);
      out.push(`    spec_ref: ${q(a.specRef)}`);
      if (has(a.when)) out.push(`    when: ${q(a.when)}`);
    }
  }
  return out.join('\n');
}