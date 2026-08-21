import { describe, it, expect } from 'vitest';
import { InMemoryTraceStore } from '@veridical/store';
import { Session, Recorder } from '@veridical/runtime';
import { MockProvider, fingerprint } from '@veridical/llm';
import { InMemorySpecRegistry, parseSpecYaml, runSpec } from '@veridical/spec';
import { Memory, MemoryStore } from '../src/index';

const SPEC = `
name: mem-test
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

function providerFor(prompt: string, withMemory: boolean): MockProvider {
  const p = new MockProvider();
  const system = withMemory ? 'You are a test agent.\n## 记忆\n- [semantic] policy: P12345' : 'You are a test agent.';
  p.record(fingerprint({ provider: 'mock', model: 'm', messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }] }), 'answer', { input: 1, output: 1, cached: 0, total: 2 });
  return p;
}

describe('runSpec with memory hook', () => {
  it('injects recalled memory into the system message when present', async () => {
    const store = new InMemoryTraceStore();
    const spec = parseSpecYaml(SPEC);
    const registry = new InMemorySpecRegistry();
    await registry.register(spec);

    const session = new Session({ session_id: 's1', tenant_id: 't1', spec_version: '1.0.0' });
    const longSession = new Session({ session_id: '_memory', tenant_id: 't1', spec_version: '1.0.0' });
    const memory = new Memory(new MemoryStore(), store, 's1', new Recorder(store, session), new Recorder(store, longSession));
    await memory.rememberSemantic('policy', 'P12345', ['claim']);

    const mock = providerFor('hello claim', true);
    const result = await runSpec(
      { store, providers: new Map([['mock', mock]]), tools: [], tenant_id: 't1', session_id: 's1', memory },
      spec,
      'hello claim',
    );
    expect(result.outcome).toBe('answer');
    // The memory.recalled event was recorded during the run
    const types = (await store.readBySession('s1')).map(e => e.type);
    expect(types).toContain('memory.recalled');
  });

  it('degrades to no memory when recall throws', async () => {
    const store = new InMemoryTraceStore();
    const spec = parseSpecYaml(SPEC);
    const registry = new InMemorySpecRegistry();
    await registry.register(spec);
    const mock = providerFor('hello', false);
    const badMemory = {
      recall: async () => { throw new Error('memory down'); },
    };
    const result = await runSpec(
      { store, providers: new Map([['mock', mock]]), tools: [], tenant_id: 't1', session_id: 's1', memory: badMemory },
      spec,
      'hello',
    );
    expect(result.outcome).toBe('answer');
  });

  it('calls onStep each loop step', async () => {
    const store = new InMemoryTraceStore();
    const spec = parseSpecYaml(SPEC);
    const registry = new InMemorySpecRegistry();
    await registry.register(spec);
    const mock = providerFor('hello', false);
    const steps: number[] = [];
    const memory = { recall: async () => [], onStep: async (s: number) => { steps.push(s); } };
    await runSpec(
      { store, providers: new Map([['mock', mock]]), tools: [], tenant_id: 't1', session_id: 's1', memory },
      spec,
      'hello',
    );
    expect(steps.length).toBeGreaterThan(0);
  });
});
