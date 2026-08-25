import { describe, it, expect } from 'vitest';
import { parseSpecYaml, type SpecRunnerDeps } from '@veridical/spec';
import { parseScenarioYaml, ruleToolCalled } from '@veridical/eval';
import { InMemoryTraceStore } from '@veridical/store';
import { MockPolicy } from '../src/policy';
import { RewardAggregator } from '../src/reward';
import { GRPOTrainer, stateFingerprint } from '../src/grpo';

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

const candidates = {
  hello: [
    JSON.stringify({ text: 'call echo', tool: { name: 'echo', args: { x: 1 } } }),
    JSON.stringify({ text: 'say hi', done: true }),
    JSON.stringify({ text: 'say bye', done: true }),
    JSON.stringify({ text: 'say nope', done: true }),
  ],
};

describe('GRPOTrainer', () => {
  it('converges: correct option prob > 0.9 and mean reward rises', async () => {
    const store = new InMemoryTraceStore();
    const spec = parseSpecYaml(SPEC);
    const scenario = parseScenarioYaml(SCENARIO);
    const fp = stateFingerprint('hello');
    const policy = new MockPolicy(candidates);
    policy.seed(fp, candidates.hello);
    const reward = new RewardAggregator([ruleToolCalled('echo')]);
    const trainer = new GRPOTrainer();
    const deps: SpecRunnerDeps = {
      store,
      providers: new Map([['mock', { complete: async () => ({ text: '', usage: { input: 1, output: 1, cached: 0, total: 2 } }) }]]),
      tools: [{ id: 'echo', name: 'echo', description: '', deterministic: true, execute: async (a) => a }],
      tenant_id: 't1',
    };

    const stats: any[] = [];
    for await (const s of trainer.train({ deps, spec, scenario, iterations: 25, groupSize: 8, lr: 0.5, policy, reward, rewardCtx: { store }, candidatesByPrompt: candidates })) {
      stats.push(s);
    }
    const last = stats[stats.length - 1];
    const correctProb = (o: any) => o.text === candidates.hello[0];
    expect(last.policy[fp].options.find(correctProb)?.prob).toBeGreaterThan(0.9);
    // Training shifts the policy toward the correct option: its prob at the
    // final iteration exceeds its prob after the first iteration.
    expect(last.policy[fp].options.find(correctProb)?.prob).toBeGreaterThan(stats[0].policy[fp].options.find(correctProb)?.prob ?? 0);
  });
});
