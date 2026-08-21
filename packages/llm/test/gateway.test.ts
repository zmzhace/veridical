import { describe, it, expect } from 'vitest';
import { InMemoryTraceStore } from '@rt/store';
import { Session, Recorder } from '@rt/runtime';
import { LLMGateway, fingerprint, MockProvider, type LLMProvider } from '../src/index';

const usage = { input: 1, output: 1, cached: 0, total: 2 };

describe('LLMGateway', () => {
  it('emits request/response events with fingerprint and usage', async () => {
    const store = new InMemoryTraceStore();
    const session = new Session({ session_id: 's1', tenant_id: 't1', spec_version: '0.0.1' });
    const recorder = new Recorder(store, session);
    const real: LLMProvider = { complete: async () => ({ text: 'hi', usage }) };
    const gw = new LLMGateway(new Map([['openai', real]]));
    const req = { messages: [{ role: 'user', content: 'hello' }], model: 'gpt-4o', provider: 'openai' };
    const res = await gw.complete(req, recorder);
    expect(res.text).toBe('hi');
    const events = await store.readBySession('s1');
    expect(events.map(e => e.type)).toEqual(['llm.request', 'llm.response']);
    expect(events[0].payload.fingerprint).toBe(fingerprint(req));
    expect(events[1].tokens?.total).toBe(2);
  });

  it('mock provider returns recorded response by fingerprint', async () => {
    const req = { messages: [{ role: 'user', content: 'x' }], model: 'm', provider: 'mock' };
    const mock = new MockProvider();
    mock.record(fingerprint(req), 'recorded answer', usage);
    const gw = new LLMGateway(new Map([['mock', mock]]));
    const res = await gw.complete(req, new Recorder(new InMemoryTraceStore(), new Session({ session_id: 's', tenant_id: 't', spec_version: '0.0.1' })));
    expect(res.text).toBe('recorded answer');
  });

  it('records a paired llm.response error when the provider is unknown', async () => {
    const store = new InMemoryTraceStore();
    const session = new Session({ session_id: 's2', tenant_id: 't1', spec_version: '0.0.1' });
    const recorder = new Recorder(store, session);
    const gw = new LLMGateway(new Map());
    const req = { messages: [{ role: 'user', content: 'hello' }], model: 'm', provider: 'nope' };
    await expect(gw.complete(req, recorder)).rejects.toThrow(/unknown provider/);
    const events = await store.readBySession('s2');
    expect(events.map(e => e.type)).toEqual(['llm.request', 'llm.response']);
    expect(events[1].verb).toBe('error');
    expect(events[1].payload.message).toContain('unknown provider');
    expect(events[1].payload.provider).toBe('nope');
  });

  it('mock provider throws on a fingerprint with no recording', async () => {
    const mock = new MockProvider();
    await expect(mock.complete({ messages: [{ role: 'user', content: 'x' }], model: 'm', provider: 'mock' })).rejects.toThrow(/no recording/);
  });
});
