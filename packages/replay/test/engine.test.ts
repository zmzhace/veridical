import { describe, it, expect } from 'vitest';
import { InMemoryTraceStore } from '@veridical/store';
import { InMemorySpecRegistry, parseSpecYaml, runSpec } from '@veridical/spec';
import { MockProvider, fingerprint } from '@veridical/llm';
import type { ToolDef } from '@veridical/tools';
import { ReplayEngine, ReplayError, ReplayMissError, TraceDivergenceError } from '../src/index';

const SPEC = `
name: replay-test
version: 1.0.0
schema_version: 1
instruction:
  system: You are a test agent.
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

const usage = { input: 1, output: 1, cached: 0, total: 2 };
const echo: ToolDef = { id: 'echo', name: 'echo', description: '', deterministic: true, execute: async (a) => a };

async function recordRun(store: InMemoryTraceStore, prompt: string): Promise<string> {
  const spec = parseSpecYaml(SPEC);
  const mock = new MockProvider();
  const fp = (p: string) => fingerprint({ provider: 'mock', model: 'm', messages: [{ role: 'system', content: 'You are a test agent.' }, { role: 'user', content: p }] });
  mock.record(fp(prompt), 'answer', usage);
  await runSpec(
    { store, providers: new Map([['mock', mock]]), tools: [echo], tenant_id: 't1', session_id: 's1' },
    spec,
    prompt,
  );
  return 's1';
}

describe('ReplayEngine', () => {
  it('replays a recorded run identically', async () => {
    const store = new InMemoryTraceStore();
    await recordRun(store, 'hello');
    const registry = new InMemorySpecRegistry();
    await registry.register(parseSpecYaml(SPEC));
    const engine = new ReplayEngine(store, registry);
    const result = await engine.replay('s1', { spec: { name: 'replay-test', version: '1.0.0' } }, [echo]);
    expect(result.identical).toBe(true);
    expect(result.outcome).toBe('answer');
  });

  it('throws TraceDivergenceError when the recorded response changed', async () => {
    const store = new InMemoryTraceStore();
    await recordRun(store, 'hello');
    const registry = new InMemorySpecRegistry();
    await registry.register(parseSpecYaml(SPEC));
    const engine = new ReplayEngine(store, registry);
    // Override the recorded response via fixtures: replay a DIFFERENT response than recorded
    const fp = fingerprint({ provider: 'mock', model: 'm', messages: [{ role: 'system', content: 'You are a test agent.' }, { role: 'user', content: 'hello' }] });
    await expect(
      engine.replay('s1', { spec: { name: 'replay-test' }, llm: { mock: 'fixture' }, fixtures: { llm: [{ provider: 'mock', responses: [{ fingerprint: fp, text: 'DIFFERENT', usage }] }] } }, [echo]),
    ).rejects.toThrow(TraceDivergenceError);
  });

  it('throws ReplayError when the spec is not registered', async () => {
    const store = new InMemoryTraceStore();
    await recordRun(store, 'hello');
    const engine = new ReplayEngine(store, new InMemorySpecRegistry());
    await expect(engine.replay('s1', { spec: { name: 'missing' } }, [echo])).rejects.toThrow(ReplayError);
  });

  it('returns not identical when assertion disabled and responses differ', async () => {
    const store = new InMemoryTraceStore();
    await recordRun(store, 'hello');
    const registry = new InMemorySpecRegistry();
    await registry.register(parseSpecYaml(SPEC));
    const engine = new ReplayEngine(store, registry);
    const fp = fingerprint({ provider: 'mock', model: 'm', messages: [{ role: 'system', content: 'You are a test agent.' }, { role: 'user', content: 'hello' }] });
    const result = await engine.replay('s1', {
      spec: { name: 'replay-test' }, assert_trace_identical: false,
      llm: { mock: 'fixture' }, fixtures: { llm: [{ provider: 'mock', responses: [{ fingerprint: fp, text: 'DIFFERENT', usage }] }] },
    }, [echo]);
    expect(result.identical).toBe(false);
  });
});
