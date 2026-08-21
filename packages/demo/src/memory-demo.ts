import { JsonlTraceStore } from '@veridical/store';
import { Session, Recorder } from '@veridical/runtime';
import { InMemorySpecRegistry, parseSpecYaml, runSpec } from '@veridical/spec';
import { MockProvider, fingerprint } from '@veridical/llm';
import { Memory, MemoryStore } from '@veridical/memory';

const SPEC = `
name: memory-demo
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
tools: []
`;

export async function runMemoryDemo(dir: string) {
  const store = new JsonlTraceStore(dir);

  const spec = parseSpecYaml(SPEC);
  const registry = new InMemorySpecRegistry();
  await registry.register(spec);

  const session = new Session({ session_id: 's1', tenant_id: 't1', spec_version: '1.0.0' });
  const longSession = new Session({ session_id: '_memory', tenant_id: 't1', spec_version: '1.0.0' });
  const memory = new Memory(new MemoryStore(), store, 's1', new Recorder(store, session), new Recorder(store, longSession));
  await memory.rememberSemantic('policy', 'P12345', ['claim']);

  const mock = new MockProvider();
  const sys = 'You are a claim assistant.\n## 记忆\n- [semantic] policy: P12345';
  const fp = (p: string) => fingerprint({ provider: 'mock', model: 'm', messages: [{ role: 'system', content: sys }, { role: 'user', content: p }] });
  mock.record(fp('hello claim'), 'answer', { input: 1, output: 1, cached: 0, total: 2 });

  const result = await runSpec(
    { store, providers: new Map([['mock', mock]]), tools: [], tenant_id: 't1', session_id: 's1', memory },
    spec,
    'hello claim',
  );
  return { store, outcome: result.outcome };
}
