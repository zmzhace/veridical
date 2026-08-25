import { InMemoryTraceStore, type TraceStore } from '@veridical/store';
import { parseSpecYaml, type SpecRunnerDeps } from '@veridical/spec';
import { parseScenarioYaml, ruleToolCalled } from '@veridical/eval';
import { MockPolicy } from './policy';
import { RewardAggregator } from './reward';
import { GRPOTrainer, type TrainConfig } from './grpo';
import type { IterationStats } from './types';

const SPEC = `
name: rl-demo
version: 1.0.0
schema_version: 1
instruction: { system: you are a bot }
flow: { mode: single-loop, max_steps: 1 }
llm: { provider: mock, model: m, fallback: [] }
tools:
  - name: echo
    access: allow
`;
const SCENARIO = `
name: pick-echo
spec: { name: rl-demo }
rules:
  - tool_called: echo
steps:
  - user: hello
`;
const CANDIDATES = {
  hello: [
    JSON.stringify({ text: 'call echo', tool: { name: 'echo', args: { x: 1 } } }),
    JSON.stringify({ text: 'say hi', done: true }),
    JSON.stringify({ text: 'say bye', done: true }),
    JSON.stringify({ text: 'say nope', done: true }),
  ],
};

export async function runRlDemo(opts: { iterations?: number; groupSize?: number; lr?: number; store?: TraceStore } = {}): Promise<IterationStats[]> {
  const store = opts.store ?? new InMemoryTraceStore();
  const spec = parseSpecYaml(SPEC);
  const scenario = parseScenarioYaml(SCENARIO);
  const policy = new MockPolicy(CANDIDATES);
  policy.seed('hello', CANDIDATES.hello);
  const reward = new RewardAggregator([ruleToolCalled('echo')]);
  const deps: SpecRunnerDeps = {
    store,
    providers: new Map([['mock', { complete: async () => ({ text: '', usage: { input: 1, output: 1, cached: 0, total: 2 } }) }]]),
    tools: [{ id: 'echo', name: 'echo', description: '', deterministic: true, execute: async (a) => a }],
    tenant_id: 't1',
  };
  const cfg: TrainConfig = {
    deps, spec, scenario,
    iterations: opts.iterations ?? 25, groupSize: opts.groupSize ?? 8, lr: opts.lr ?? 0.5,
    policy, reward, rewardCtx: { store }, candidatesByPrompt: CANDIDATES,
  };
  const trainer = new GRPOTrainer();
  const stats: IterationStats[] = [];
  for await (const s of trainer.train(cfg)) {
    stats.push(s);
    console.log(`iter ${s.iteration}: mean_reward=${s.mean_reward.toFixed(3)} best=${s.best_option}`);
  }
  const snap = policy.snapshot();
  console.log('final policy:', JSON.stringify(snap, null, 2));
  return stats;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  runRlDemo().then((stats) => {
    const last = stats[stats.length - 1];
    const echo = JSON.stringify({ text: 'call echo', tool: { name: 'echo', args: { x: 1 } } });
    const prob = Math.max(...Object.values(last.policy).map((s) => s.options.find((o) => o.text === echo)?.prob ?? 0));
    console.log(`final echo option prob=${prob.toFixed(3)}`);
  });
}
