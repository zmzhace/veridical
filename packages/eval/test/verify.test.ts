import { describe, it, expect } from 'vitest';
import { InMemoryTraceStore } from '@veridical/store';
import { MockProvider, fingerprint } from '@veridical/llm';
import { parseSpecYaml, runSpec } from '@veridical/spec';
import { verifyFromRules, ruleToolCalled, ruleNoErrors } from '../src/index';

const SPEC = `
name: verify-test
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

function provider(text: string): MockProvider {
  const p = new MockProvider();
  p.record(fingerprint({ provider: 'mock', model: 'm', messages: [{ role: 'system', content: 'You are a test agent.' }, { role: 'user', content: 'hello' }] }), text, { input: 1, output: 1, cached: 0, total: 2 });
  return p;
}

const echo = { id: 'echo', name: 'echo', description: '', deterministic: true, execute: async (a: unknown) => a };

describe('verifyFromRules', () => {
  it('passes when rules pass, fails otherwise', () => {
    const v = verifyFromRules([ruleNoErrors()]);
    expect(v([])).toBe(true);
  });
});

describe('runSpec with verify hook', () => {
  it('fails the tool step (blocked) when verify rules fail', async () => {
    const store = new InMemoryTraceStore();
    const spec = parseSpecYaml(SPEC);
    // verify requires the tool to have been called twice — never true on first call → blocked
    const result = await runSpec(
      {
        store,
        providers: new Map([['mock', provider('hi')]]),
        tools: [echo],
        tenant_id: 't1',
        session_id: 's1',
        verify: verifyFromRules([ruleToolCalled('echo')]),
        runStep: async () => ({ text: '', tool: { name: 'echo', args: {} } }),
      },
      spec,
      'hello',
    );
    const blocked = result.events.filter(e => e.type === 'tool.result' && (e.payload as any)?.blocked === true);
    expect(blocked.length).toBeGreaterThan(0);
  });

  it('passes the tool step when verify rules are satisfied', async () => {
    const store = new InMemoryTraceStore();
    const spec = parseSpecYaml(SPEC);
    const result = await runSpec(
      {
        store,
        providers: new Map([['mock', provider('hi')]]),
        tools: [echo],
        tenant_id: 't1',
        session_id: 's1',
        verify: verifyFromRules([ruleNoErrors()]),
        runStep: async () => ({ text: '', tool: { name: 'echo', args: {} } }),
      },
      spec,
      'hello',
    );
    expect(result.events.some(e => e.type === 'tool.result' && (e.payload as any)?.blocked === true)).toBe(false);
  });
});
