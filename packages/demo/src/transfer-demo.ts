import { JsonlTraceStore } from '@veridical/store';
import { parseSpecYaml, runSpec, type SpecRunnerDeps } from '@veridical/spec';

const TRANSFER = `
name: transfer-advisor
version: 1.0.0
schema_version: 1
instruction: { system: 你是转保顾问，必须按顺序核验健康、评估退保损失、核对保障连续性，再促成。 }
flow:
  mode: stage-gate
  max_steps: 4
  stages:
    - id: health_check
      gate: { tool_called: verify_health }
    - id: surrender_analysis
      gate: { tool_called: assess_surrender }
    - id: continuity_check
      gate: { tool_called: compare_benefits }
    - id: close
      gate: { tool_called: submit_transfer }
llm: { provider: mock, model: m, fallback: [] }
tools:
  - name: get_policy
    access: allow
  - name: verify_health
    access: allow
  - name: assess_surrender
    access: allow
  - name: compare_benefits
    access: allow
  - name: submit_transfer
    access: allow
`;

const TOOLS: SpecRunnerDeps['tools'] = [
  { id: 'get_policy', name: 'get_policy', description: '', deterministic: true, execute: async (a) => a },
  { id: 'verify_health', name: 'verify_health', description: '', deterministic: true, execute: async (a) => a },
  { id: 'assess_surrender', name: 'assess_surrender', description: '', deterministic: true, execute: async (a) => a },
  { id: 'compare_benefits', name: 'compare_benefits', description: '', deterministic: true, execute: async (a) => a },
  { id: 'submit_transfer', name: 'submit_transfer', description: '', deterministic: true, execute: async (a) => a },
];

export async function runTransferDemo(dir: string, opts: { skipHealth?: boolean } = {}) {
  const store = new JsonlTraceStore(dir);
  const spec = parseSpecYaml(TRANSFER);
  const stageTools = ['verify_health', 'assess_surrender', 'compare_benefits', 'submit_transfer'];
  let calls = 0;
  const deps: SpecRunnerDeps = {
    store,
    providers: new Map([['mock', { complete: async () => ({ text: '', usage: { input: 1, output: 1, cached: 0, total: 2 } }) }]]),
    tools: TOOLS,
    tenant_id: 't1',
    session_id: 'transfer_s1',
    runStep: async () => {
      const idx = Math.min(calls + (opts.skipHealth ? 1 : 0), stageTools.length - 1);
      calls += 1;
      return { text: '', tool: { name: stageTools[idx], args: {} } };
    },
  };
  const result = await runSpec(deps, spec, '我想转保');
  return { store, result };
}