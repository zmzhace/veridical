import { JsonlTraceStore } from '@veridical/store';
import { InMemorySpecRegistry, parseSpecYaml, runSpec, type SpecRunnerDeps } from '@veridical/spec';

const HUB = `
name: insurance-hub
version: 1.0.0
schema_version: 1
instruction: { system: 你是客服中心主管，按客户诉求把任务派给最合适的专家。 }
flow: { mode: supervisor, max_steps: 2 }
llm: { provider: mock, model: m, fallback: [] }
tools: []
agents:
  - name: compare-agent
    spec_ref: compare-agent@1.0.0
    when: 客户想对比新旧保单
`;

const COMPARE = `
name: compare-agent
version: 1.0.0
schema_version: 1
instruction: { system: 你是保单对比专家。 }
flow: { mode: single-loop, max_steps: 1 }
llm: { provider: mock, model: m, fallback: [] }
tools:
  - name: compare_policy
    access: allow
`;

export async function runOrchestrationDemo(dir: string) {
  const store = new JsonlTraceStore(dir);
  const registry = new InMemorySpecRegistry();
  await registry.register(parseSpecYaml(COMPARE));
  const hub = parseSpecYaml(HUB);
  const deps: SpecRunnerDeps = {
    store,
    registry,
    providers: new Map([['mock', { complete: async () => ({ text: JSON.stringify({ text: '对比保单', tool: { name: 'compare_policy', args: { task: '对比张女士新旧保单' } } }), usage: { input: 1, output: 1, cached: 0, total: 2 } }) }]]),
    tools: [{ id: 'compare_policy', name: 'compare_policy', description: '', deterministic: true, execute: async (a) => a }],
    tenant_id: 't1',
    session_id: 'orch_s1',
    runStep: async () => ({ text: '', delegate: 'compare-agent', task: '对比张女士新旧保单' }),
  };
  const result = await runSpec(deps, hub, '张女士想对比新旧保单');
  return { store, result };
}
