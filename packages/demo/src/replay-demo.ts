import { JsonlTraceStore } from '@veridical/store';
import { InMemorySpecRegistry, parseSpecYaml, runSpec } from '@veridical/spec';
import { MockProvider, fingerprint } from '@veridical/llm';
import { ReplayEngine } from '@veridical/replay';
import type { ToolDef } from '@veridical/tools';

const SPEC = `
name: replay-demo
version: 1.0.0
schema_version: 1
instruction:
  system: You are a test agent.
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

const usage = { input: 1, output: 1, cached: 0, total: 2 };
const echo: ToolDef = { id: 'echo', name: 'echo', description: '', deterministic: true, execute: async (a) => a };

export async function runReplayDemo(dir: string) {
  const store = new JsonlTraceStore(dir);
  const spec = parseSpecYaml(SPEC);
  const mock = new MockProvider();
  const messages = [{ role: 'system', content: 'You are a test agent.' }, { role: 'user', content: 'hello' }];
  mock.record(fingerprint({ provider: 'mock', model: 'm', messages }), 'answer', usage);
  await runSpec({ store, providers: new Map([['mock', mock]]), tools: [echo], tenant_id: 't1', session_id: 's1' }, spec, 'hello');

  const registry = new InMemorySpecRegistry();
  await registry.register(spec);
  const engine = new ReplayEngine(store, registry);
  const replay = await engine.replay('s1', { spec: { name: 'replay-demo' } }, [echo]);
  return { store, replay };
}
