import { JsonlTraceStore } from '@veridical/store';
import { InMemorySpecRegistry, parseSpecYaml } from '@veridical/spec';
import { parseScenarioYaml, Simulator } from '@veridical/eval';
import { MockProvider, fingerprint } from '@veridical/llm';

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

export async function runEvalDemo(dir: string) {
  const store = new JsonlTraceStore(dir);

  const registry = new InMemorySpecRegistry();
  const spec = parseSpecYaml(SPEC);
  await registry.register(spec);

  const mock = new MockProvider();
  const fp = (user: string) => fingerprint({ provider: 'mock', model: 'm', messages: [{ role: 'system', content: 'You are a claim assistant.' }, { role: 'user', content: user }] });
  mock.record(fp('hello'), 'a', { input: 1, output: 1, cached: 0, total: 2 });
  mock.record(fp('world'), 'b', { input: 1, output: 1, cached: 0, total: 2 });

  const sim = new Simulator({
    store,
    providers: new Map([['mock', mock]]),
    tools: [{ id: 'echo', name: 'echo', description: '', deterministic: true, execute: async (a: unknown) => a }],
    tenant_id: 't1',
  });

  const scenario = parseScenarioYaml(SCENARIO);
  const report = await sim.run(scenario, registry);
  return { store, report };
}
