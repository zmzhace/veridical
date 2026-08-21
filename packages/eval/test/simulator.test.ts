import { describe, it, expect } from 'vitest';
import { InMemoryTraceStore } from '@veridical/store';
import { InMemorySpecRegistry, parseSpecYaml } from '@veridical/spec';
import { MockProvider, fingerprint } from '@veridical/llm';
import { parseScenarioYaml, Simulator, ScenarioError, ruleToolCalled, ruleNoErrors, type SpecRunnerDeps } from '../src/index';

const SPEC = `
name: claim
version: 1.0.0
schema_version: 1
instruction:
  system: You are a claim assistant.
flow:
  mode: single-loop
  max_steps: 2
llm:
  provider: mock
  model: m
  fallback: []
tools:
  - name: echo
    access: allow
`;

const SCENARIO = `
name: claim-scenario
description: two turns
spec:
  name: claim
  version: 1.0.0
rules:
  - no_errors: true
steps:
  - user: "hello"
    expect_rules:
      - tool_called: echo
  - user: "world"
`;

function setup() {
  const store = new InMemoryTraceStore();
  const registry = new InMemorySpecRegistry();
  const spec = parseSpecYaml(SPEC);
  void registry.register(spec);
  const mock = new MockProvider();
  mock.record(fingerprint({ provider: 'mock', model: 'm', messages: [{ role: 'system', content: 'You are a claim assistant.' }, { role: 'user', content: 'hello' }] }), 'a', { input: 1, output: 1, cached: 0, total: 2 });
  mock.record(fingerprint({ provider: 'mock', model: 'm', messages: [{ role: 'system', content: 'You are a claim assistant.' }, { role: 'user', content: 'world' }] }), 'b', { input: 1, output: 1, cached: 0, total: 2 });
  const deps: SpecRunnerDeps = {
    store,
    providers: new Map([['mock', mock]]),
    tools: [{ id: 'echo', name: 'echo', description: '', deterministic: true, execute: async (a: unknown) => a }],
    tenant_id: 't1',
    runStep: async ({ llm, spec, recorder, prompt }) => {
      const res = await llm.complete({ provider: spec.llm.provider, model: spec.llm.model, messages: [{ role: 'system', content: spec.instruction.system }, { role: 'user', content: prompt }] }, recorder);
      return prompt === 'hello' ? { text: res.text, tool: { name: 'echo', args: {} } } : { text: res.text };
    },
  };
  return { store, registry, deps };
}

describe('parseScenarioYaml', () => {
  it('parses a scenario with rule decls into Rule functions', () => {
    const s = parseScenarioYaml(SCENARIO);
    expect(s.name).toBe('claim-scenario');
    expect(s.steps).toHaveLength(2);
    expect(s.steps[0].expect_rules?.[0].name).toBe('tool_called');
    expect(s.rules?.[0].name).toBe('no_errors');
  });

  it('throws ScenarioError on unknown rule kind', () => {
    const bad = SCENARIO.replace('- no_errors: true', '- unknown_rule: 1');
    expect(() => parseScenarioYaml(bad)).toThrow(ScenarioError);
  });
});

describe('Simulator', () => {
  it('runs each turn and reports per-turn evaluation', async () => {
    const { store, registry, deps } = setup();
    const sim = new Simulator(deps);
    const scenario = parseScenarioYaml(SCENARIO);
    const report = await sim.run(scenario, registry);
    expect(report.name).toBe('claim-scenario');
    expect(report.steps).toHaveLength(2);
    // step 0 runs BOTH the step's expect_rules (tool_called: echo) AND the global scenario.rules (no_errors)
    const step0RuleNames = report.steps[0].report.rules?.rules.map(r => r.name) ?? [];
    expect(step0RuleNames).toContain('tool_called');
    expect(step0RuleNames).toContain('no_errors');
    expect(report.steps[0].report.passed).toBe(true);
    expect(report.passed).toBe(true);
    const types = (await store.readBySession('eval_s1')).map(e => e.type);
    expect(types).toContain('eval/run/start');
    expect(types).toContain('eval/step/end');
  });

  it('throws ScenarioError when the spec is not registered', async () => {
    const { deps } = setup();
    const sim = new Simulator(deps);
    const scenario = parseScenarioYaml(SCENARIO);
    const empty = new InMemorySpecRegistry();
    await expect(sim.run(scenario, empty)).rejects.toThrow(ScenarioError);
  });
});
