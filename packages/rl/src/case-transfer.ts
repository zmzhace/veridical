import { InMemoryTraceStore, type TraceStore } from '@veridical/store';
import { parseSpecYaml, type SpecRunnerDeps } from '@veridical/spec';
import { parseScenarioYaml, ruleToolCalled, ruleNoErrors } from '@veridical/eval';
import { MockPolicy } from './policy';
import { RewardAggregator } from './reward';
import { GRPOTrainer, type TrainConfig } from './grpo';
import type { IterationStats } from './types';

const TRANSFER = `
name: transfer-advisor
version: 1.0.0
schema_version: 1
instruction: { system: 你是转保顾问，必须按顺序核验健康、评估退保损失、核对保障连续性，再促成。 }
flow:
  mode: stage-gate
  max_steps: 3
  stages:
    - id: health_check
      gate: { tool_called: verify_health }
    - id: surrender_analysis
      gate: { tool_called: assess_surrender }
    - id: close
      gate: { tool_called: submit_transfer }
llm: { provider: mock, model: m, fallback: [] }
tools:
  - name: verify_health
    access: allow
  - name: assess_surrender
    access: allow
  - name: submit_transfer
    access: allow
`;

// 每个 (stage, user) 是独立状态；候选 = 该 stage 的可用工具。
const CANDIDATES = {
  default: [
    JSON.stringify({ text: '', tool: { name: 'verify_health', args: {} } }),
    JSON.stringify({ text: '', tool: { name: 'assess_surrender', args: {} } }),
    JSON.stringify({ text: '', tool: { name: 'submit_transfer', args: {} } }),
    JSON.stringify({ text: '直接推客户转保，不核验', done: true }),
  ],
};

export async function runTransferRL(opts: { iterations?: number; groupSize?: number; lr?: number; store?: TraceStore } = {}): Promise<IterationStats[]> {
  const store = opts.store ?? new InMemoryTraceStore();
  const spec = parseSpecYaml(TRANSFER);
  const scenario = parseScenarioYaml(`
name: transfer-rl
spec: { name: transfer-advisor }
rules:
  - tool_called: submit_transfer
  - no_errors: true
steps:
  - user: 张先生40岁有慢性病想转保
  - user: 李女士35岁旧保单交了很多年想转保
`);
  const policy = new MockPolicy(CANDIDATES);
  const reward = new RewardAggregator([ruleToolCalled('submit_transfer'), ruleNoErrors()]);
  const deps: SpecRunnerDeps = {
    store,
    providers: new Map([['mock', { complete: async () => ({ text: '', usage: { input: 1, output: 1, cached: 0, total: 2 } }) }]]),
    tools: [
      { id: 'verify_health', name: 'verify_health', description: '', deterministic: true, execute: async (a) => a },
      { id: 'assess_surrender', name: 'assess_surrender', description: '', deterministic: true, execute: async (a) => a },
      { id: 'submit_transfer', name: 'submit_transfer', description: '', deterministic: true, execute: async (a) => a },
    ],
    tenant_id: 't1',
  };
  const cfg: TrainConfig = {
    deps, spec, scenario,
    iterations: opts.iterations ?? 40, groupSize: opts.groupSize ?? 8, lr: opts.lr ?? 0.5,
    policy, reward, rewardCtx: { store },
    candidatesByPrompt: Object.fromEntries(scenario.steps.map(s => [s.user, CANDIDATES.default])),
  };
  const trainer = new GRPOTrainer();
  const stats: IterationStats[] = [];
  for await (const s of trainer.train(cfg)) {
    stats.push(s);
  }
  return stats;
}