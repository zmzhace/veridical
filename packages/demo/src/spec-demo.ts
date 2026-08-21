import { JsonlTraceStore } from '@veridical/store';
import { InMemorySpecRegistry, parseSpecYaml, runSpec, type RunResult } from '@veridical/spec';
import { MockProvider, fingerprint } from '@veridical/llm';

const SPEC_YAML = `
name: claim-filing
description: 报案场景：收集槽位并出报告
version: 1.0.0
schema_version: 1
instruction:
  system: |
    You are a claim filing assistant. Collect slots: policy_no, date, location.
flow:
  mode: single-loop
  max_steps: 3
llm:
  provider: mock
  model: m
  fallback: []
tools:
  - name: echo
    access: allow
`;

export async function runSpecDemo(dir: string): Promise<{ store: JsonlTraceStore; result: RunResult }> {
  const store = new JsonlTraceStore(dir);
  const registry = new InMemorySpecRegistry();
  const spec = parseSpecYaml(SPEC_YAML);
  await registry.register(spec);

  const messages = [
    { role: 'system', content: spec.instruction.system },
    { role: 'user', content: 'hello' },
  ];
  const mock = new MockProvider();
  mock.record(fingerprint({ provider: 'mock', model: 'm', messages }), 'call echo', { input: 1, output: 1, cached: 0, total: 2 });

  let calls = 0;
  const result = await runSpec(
    {
      store,
      providers: new Map([['mock', mock]]),
      tools: [{ id: 'echo', name: 'echo', description: 'echo', deterministic: true, execute: async (a) => a }],
      tenant_id: 't1',
      session_id: 'spec_s1',
      runStep: async ({ llm, spec, recorder, prompt }) => {
        const res = await llm.complete({ provider: 'mock', model: 'm', messages: [{ role: 'system', content: spec.instruction.system }, { role: 'user', content: prompt }] }, recorder);
        if (calls++ === 0) return { text: res.text, tool: { name: 'echo', args: { x: 1 } } };
        return { text: res.text };
      },
    },
    spec,
    'hello',
  );

  return { store, result };
}
