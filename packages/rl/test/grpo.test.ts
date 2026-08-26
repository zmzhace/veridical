import { describe, it, expect } from 'vitest';
import { parseSpecYaml, type SpecRunnerDeps } from '@veridical/spec';
import { parseScenarioYaml, ruleToolCalled, ruleNoErrors } from '@veridical/eval';
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
    // Under policy-weighted sampling, mean_reward rises as the policy concentrates
    // on the high-reward (correct) option.
    expect(stats[stats.length - 1].mean_reward).toBeGreaterThan(stats[0].mean_reward);
  });
});

import { ruleOutcomeEquals, ruleToolCalled } from '@veridical/eval';

describe('GRPOTrainer per-step expect_rules', () => {
  it('uses step expect_rules when present (mirrors Simulator merge)', async () => {
    const store = new InMemoryTraceStore();
    const spec = parseSpecYaml(SPEC);
    // Two steps, each with its OWN expect_rules rewarding a DIFFERENT tool.
    const scenario = parseScenarioYaml(`
name: two-personas
spec: { name: rl-demo }
steps:
  - user: persona A
    expect_rules:
      - tool_called: compare_policy
  - user: persona B
    expect_rules:
      - tool_called: get_policy
`);
    const candidates = {
      'persona A': [JSON.stringify({ text: 'compare', tool: { name: 'compare_policy', args: {} } }), JSON.stringify({ text: 'get', tool: { name: 'get_policy', args: {} } })],
      'persona B': [JSON.stringify({ text: 'compare', tool: { name: 'compare_policy', args: {} } }), JSON.stringify({ text: 'get', tool: { name: 'get_policy', args: {} } })],
    };
    const policy = new MockPolicy(candidates);
    const trainer = new GRPOTrainer();
    const deps: SpecRunnerDeps = {
      store,
      providers: new Map([['mock', { complete: async () => ({ text: '', usage: { input: 1, output: 1, cached: 0, total: 2 } }) }]]),
      tools: [
        { id: 'get_policy', name: 'get_policy', description: '', deterministic: true, execute: async (a) => a },
        { id: 'compare_policy', name: 'compare_policy', description: '', deterministic: true, execute: async (a) => a },
      ],
      tenant_id: 't1',
    };
    const reward = new RewardAggregator([ruleToolCalled('get_policy')]); // global fallback: never the per-step winner
    const stats: any[] = [];
    for await (const s of trainer.train({ deps, spec, scenario, iterations: 30, groupSize: 6, lr: 0.5, policy, reward, rewardCtx: { store }, candidatesByPrompt: candidates })) {
      stats.push(s);
    }
    const last = stats[stats.length - 1];
    const fpA = stateFingerprint('persona A');
    const fpB = stateFingerprint('persona B');
    // persona A must converge to compare_policy (its own expect_rule).
    expect(last.policy[fpA].options.find((o: any) => o.text === candidates['persona A'][0])?.prob).toBeGreaterThan(0.8);
    // persona B must converge to get_policy (its own expect_rule) even though
    // the global fallback rewards get_policy — proving per-step rules win.
    expect(last.policy[fpB].options.find((o: any) => o.text === candidates['persona B'][1])?.prob).toBeGreaterThan(0.8);
    // The two persona states must diverge (learned different moves).
    const pA = last.policy[fpA].options.find((o: any) => o.text === candidates['persona A'][0])?.prob ?? 0;
    const pB = last.policy[fpB].options.find((o: any) => o.text === candidates['persona B'][1])?.prob ?? 0;
    expect(pA).toBeGreaterThan(0.8);
    expect(pB).toBeGreaterThan(0.8);
  });
});

const SG_SPEC = `
name: sg
version: 1.0.0
schema_version: 1
instruction: { system: sg }
flow:
  mode: stage-gate
  max_steps: 3
  stages:
    - id: s1
      gate: { tool_called: t1 }
    - id: s2
      gate: { tool_called: t2 }
llm: { provider: mock, model: m, fallback: [] }
tools:
  - name: t1
    access: allow
  - name: t2
    access: allow
`;

describe('GRPOTrainer stage-gate', () => {
  it('trains per-stage decisions to end-to-end success', async () => {
    const store = new InMemoryTraceStore();
    const spec = parseSpecYaml(SG_SPEC);
    const scenario = parseScenarioYaml(`
name: sg-rl
spec: { name: sg }
rules:
  - tool_called: t2
  - no_errors: true
steps:
  - user: 客户A
`);
    const candidates = {
      '客户A': [JSON.stringify({ text: '', tool: { name: 't1', args: {} } }), JSON.stringify({ text: '', tool: { name: 't2', args: {} } })],
    };
    const policy = new MockPolicy(candidates);
    const reward = new RewardAggregator([ruleToolCalled('t2'), ruleNoErrors()]);
    const deps: SpecRunnerDeps = {
      store,
      providers: new Map([['mock', { complete: async () => ({ text: '', usage: { input: 1, output: 1, cached: 0, total: 2 } }) }]]),
      tools: [
        { id: 't1', name: 't1', description: '', deterministic: true, execute: async (a) => a },
        { id: 't2', name: 't2', description: '', deterministic: true, execute: async (a) => a },
      ],
      tenant_id: 't1',
    };
    const trainer = new GRPOTrainer();
    const stats: any[] = [];
    for await (const s of trainer.train({ deps, spec, scenario, iterations: 40, groupSize: 8, lr: 0.5, policy, reward, rewardCtx: { store }, candidatesByPrompt: candidates })) {
      stats.push(s);
    }
    const last = stats[stats.length - 1];
    expect(last.mean_reward).toBeGreaterThan(0.7);
    // s1 state converges to t1; s2 state converges to t2
    const fp1 = stateFingerprint('s1:客户A');
    const fp2 = stateFingerprint('s2:客户A');
    expect(last.policy[fp1]?.options.find((o: any) => o.text.includes('"name":"t1"'))?.prob ?? 0).toBeGreaterThan(0.7);
    expect(last.policy[fp2]?.options.find((o: any) => o.text.includes('"name":"t2"'))?.prob ?? 0).toBeGreaterThan(0.7);
  });
});
