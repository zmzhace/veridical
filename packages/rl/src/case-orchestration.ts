import { InMemoryTraceStore, type TraceStore } from '@veridical/store';
import { InMemorySpecRegistry, parseSpecYaml, runSpec, type SpecRunnerDeps } from '@veridical/spec';
import { parseScenarioYaml } from '@veridical/eval';
import { MockPolicy } from './policy';
import { RewardAggregator } from './reward';
import { GRPOTrainer, stateFingerprint, type TrainConfig } from './grpo';
import { decisionStepFrom } from './decision';
import type { IterationStats } from './types';

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
  - name: claims-agent
    spec_ref: claims-agent@1.0.0
  - name: close-agent
    spec_ref: close-agent@1.0.0
`;

const COMPARE = `
name: compare-agent
version: 1.0.0
schema_version: 1
instruction: { system: 保单对比专家 }
flow: { mode: single-loop, max_steps: 1 }
llm: { provider: mock, model: m, fallback: [] }
tools:
  - name: compare_policy
    access: allow
`;
const CLAIMS = `
name: claims-agent
version: 1.0.0
schema_version: 1
instruction: { system: 理赔查询专家 }
flow: { mode: single-loop, max_steps: 1 }
llm: { provider: mock, model: m, fallback: [] }
tools:
  - name: query_claims
    access: allow
`;
const CLOSE = `
name: close-agent
version: 1.0.0
schema_version: 1
instruction: { system: 签约促成专家 }
flow: { mode: single-loop, max_steps: 1 }
llm: { provider: mock, model: m, fallback: [] }
tools:
  - name: schedule_close
    access: allow
`;

const SCENARIO = `
name: hub-routing
spec: { name: insurance-hub }
steps:
  - user: 张女士想对比新旧保单
    expect_rules:
      - tool_called: compare_policy
  - user: 李先生想查理赔记录
    expect_rules:
      - tool_called: query_claims
`;

const CANDIDATES = {
  default: [
    JSON.stringify({ delegate: 'compare-agent', task: '对比新旧保单' }),
    JSON.stringify({ delegate: 'claims-agent', task: '查理赔记录' }),
    JSON.stringify({ delegate: 'close-agent', task: '直接促成' }),
    JSON.stringify({ text: '直接回复不派发', done: true }),
  ],
};

const TOOLS: SpecRunnerDeps['tools'] = [
  { id: 'compare_policy', name: 'compare_policy', description: '', deterministic: true, execute: async (a) => a },
  { id: 'query_claims', name: 'query_claims', description: '', deterministic: true, execute: async (a) => a },
  { id: 'schedule_close', name: 'schedule_close', description: '', deterministic: true, execute: async (a) => a },
];

export async function runOrchestrationRL(opts: { iterations?: number; groupSize?: number; lr?: number; store?: TraceStore } = {}): Promise<IterationStats[]> {
  const store = opts.store ?? new InMemoryTraceStore();
  const registry = new InMemorySpecRegistry();
  for (const y of [COMPARE, CLAIMS, CLOSE]) await registry.register(parseSpecYaml(y));
  const spec = parseSpecYaml(HUB);
  const scenario = parseScenarioYaml(SCENARIO);
  const policy = new MockPolicy(CANDIDATES);
  const reward = new RewardAggregator([]);
  const deps: SpecRunnerDeps = {
    store, registry,
    providers: new Map([['mock', { complete: async () => ({ text: '', usage: { input: 1, output: 1, cached: 0, total: 2 } }) }]]),
    tools: TOOLS,
    tenant_id: 't1',
    runStep: decisionStepFrom(CANDIDATES.default[0]),
  };
  const cfg: TrainConfig = {
    deps, spec, scenario,
    iterations: opts.iterations ?? 30, groupSize: opts.groupSize ?? 8, lr: opts.lr ?? 0.5,
    policy, reward, rewardCtx: { store },
    candidatesByPrompt: Object.fromEntries(scenario.steps.map(s => [s.user, CANDIDATES.default])),
  };
  const trainer = new GRPOTrainer();
  const stats: IterationStats[] = [];
  for await (const s of trainer.train(cfg)) {
    stats.push(s);
    console.log(`iter ${s.iteration}: mean_reward=${s.mean_reward.toFixed(3)} best=${s.best_option.slice(0, 30)}`);
  }
  return stats;
}
