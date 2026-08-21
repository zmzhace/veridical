import { describe, it, expect } from 'vitest';
import { InMemoryTraceStore } from '@veridical/store';
import { ToolBroker, type ToolDef } from '@veridical/tools';
import type { LLMProvider } from '@veridical/llm';
import { parseSpecYaml, runSpec, SpecRunError, SpecApprovalPolicy } from '../src/index';

const SPEC_YAML = `
name: runner-test
version: 1.0.0
schema_version: 1
instruction:
  system: You are a test agent.
flow:
  mode: single-loop
  max_steps: 2
llm:
  provider: main
  model: m
  fallback:
    - provider: backup
      model: b
tools:
  - name: echo
    access: allow
`;

const usage = { input: 1, output: 1, cached: 0, total: 2 };
function provider(text: string): LLMProvider {
  return { complete: async () => ({ text, usage }) };
}
function echoTool(): ToolDef {
  return { id: 'echo', name: 'echo', description: '', deterministic: true, execute: async (a) => a };
}

describe('runSpec', () => {
  it('runs a single-loop spec and records spec-bound events', async () => {
    const store = new InMemoryTraceStore();
    const spec = parseSpecYaml(SPEC_YAML);
    const result = await runSpec(
      { store, providers: new Map([['main', provider('hi')], ['backup', provider('boo')]]), tools: [], tenant_id: 't1', session_id: 's1' },
      spec,
      'hello',
    );
    const types = result.events.map(e => e.type);
    for (const t of ['spec/run/start', 'turn/start', 'llm.request', 'llm.response', 'turn/end', 'spec/run/end']) {
      expect(types).toContain(t);
    }
    expect(result.spec_name).toBe('runner-test');
    expect(result.spec_version).toBe('1.0.0');
    expect(result.outcome).toBe('hi');
  });

  it('records a denied event for a library tool excluded by the spec whitelist', async () => {
    const store = new InMemoryTraceStore();
    const spec = parseSpecYaml(SPEC_YAML);
    const otherTool: ToolDef = { id: 'other', name: 'other', description: '', deterministic: true, execute: async (a) => a };
    const result = await runSpec(
      {
        store,
        providers: new Map([['main', provider('x')]]),
        tools: [echoTool(), otherTool],
        tenant_id: 't1',
        session_id: 's1',
        runStep: async () => ({ text: '', tool: { name: 'other', args: {} } }),
      },
      spec,
      'hello',
    );
    const denied = result.events.find(e => e.type === 'tool.result' && (e.payload as any)?.result?.reason === 'denied');
    expect(denied).toBeDefined();
  });

  it('falls back when the primary provider fails', async () => {
    const store = new InMemoryTraceStore();
    const spec = parseSpecYaml(SPEC_YAML);
    const boom: LLMProvider = { complete: async () => { throw new Error('boom'); } };
    const result = await runSpec(
      { store, providers: new Map([['main', boom], ['backup', provider('saved')]]), tools: [], tenant_id: 't1', session_id: 's1' },
      spec,
      'hello',
    );
    expect(result.outcome).toBe('saved');
    expect(result.events.some(e => e.type === 'llm.response' && e.verb === 'error')).toBe(true);
  });

  it('throws SpecRunError when all providers fail', async () => {
    const store = new InMemoryTraceStore();
    const spec = parseSpecYaml(SPEC_YAML);
    const boom: LLMProvider = { complete: async () => { throw new Error('boom'); } };
    await expect(
      runSpec({ store, providers: new Map([['main', boom], ['backup', boom]]), tools: [], tenant_id: 't1', session_id: 's1' }, spec, 'hello'),
    ).rejects.toThrow(SpecRunError);
  });

  it('persists an error spec/run/end event when all providers fail', async () => {
    const store = new InMemoryTraceStore();
    const spec = parseSpecYaml(SPEC_YAML);
    const boom: LLMProvider = { complete: async () => { throw new Error('boom'); } };
    await expect(
      runSpec({ store, providers: new Map([['main', boom], ['backup', boom]]), tools: [], tenant_id: 't1', session_id: 's1' }, spec, 'hello'),
    ).rejects.toThrow(SpecRunError);

    const events = await store.readBySession('s1');
    const start = events.find(e => e.type === 'spec/run/start');
    const end = events.find(e => e.type === 'spec/run/end');
    expect(start).toBeDefined();
    expect(end).toBeDefined();
    expect(end?.verb).toBe('error');
    expect((end?.payload as { message?: string } | undefined)?.message).toContain('all LLM providers failed');
  });

  it('throws SpecRunError when the primary provider is not registered', async () => {
    const store = new InMemoryTraceStore();
    const spec = parseSpecYaml(SPEC_YAML);
    await expect(
      runSpec({ store, providers: new Map([['other', provider('x')]]), tools: [], tenant_id: 't1', session_id: 's1' }, spec, 'hello'),
    ).rejects.toThrow(SpecRunError);
  });

  it('stops at max_steps', async () => {
    const store = new InMemoryTraceStore();
    const spec = parseSpecYaml(SPEC_YAML);
    const result = await runSpec(
      { store, providers: new Map([['main', provider('hi')]]), tools: [], tenant_id: 't1', session_id: 's1' },
      spec,
      'hello',
    );
    expect(result.events.filter(e => e.type === 'llm.request').length).toBe(2);
  });
});

describe('SpecApprovalPolicy', () => {
  it('allows whitelisted tools and denies others', async () => {
    const spec = parseSpecYaml(SPEC_YAML);
    const policy = new SpecApprovalPolicy(spec);
    expect(await policy.decide(echoTool(), {})).toBe('allow');
    expect(await policy.decide({ id: 'x', name: 'x', description: '', deterministic: true, execute: async (a) => a }, {})).toBe('deny');
  });

  it('delegates ask to the injected callback', async () => {
    const spec = parseSpecYaml(SPEC_YAML.replace('- name: echo\n    access: allow', '- name: echo\n    access: ask'));
    const policy = new SpecApprovalPolicy(spec, async () => true);
    expect(await policy.decide(echoTool(), {})).toBe('ask');
    expect(await policy.onAsk!(echoTool(), {})).toBe(true);
  });
});

describe('ToolBroker integration', () => {
  it('broker returns denied for a library tool excluded by the spec whitelist', async () => {
    const spec = parseSpecYaml(SPEC_YAML);
    const otherTool: ToolDef = { id: 'other', name: 'other', description: '', deterministic: true, execute: async (a) => a };
    const broker = new ToolBroker([echoTool(), otherTool], new SpecApprovalPolicy(spec));
    const r = await broker.call('other', {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('denied');
  });
});
