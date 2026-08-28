import { describe, it, expect } from 'vitest';
import { InMemoryTraceStore } from '@veridical/store';
import { Session, Recorder } from '@veridical/runtime';
import { LLMGateway, fingerprint, MockProvider, type LLMProvider } from '../src/index';

const usage = { input: 1, output: 1, cached: 0, total: 2 };

describe('LLMGateway', () => {
  it('records exactly one paired error when a registered provider throws', async () => {
    const store = new InMemoryTraceStore();
    const recorder = new Recorder(store, new Session({ session_id: 'failure', tenant_id: 't1', spec_version: '1.0.0' }));
    const gw = new LLMGateway(new Map([['mock', { complete: async () => { throw new Error('provider failed'); } }]]));
    const req = { provider: 'mock', model: 'm', messages: [] };
    await expect(gw.complete(req, recorder)).rejects.toThrow('provider failed');
    const events = await store.readBySession('failure');
    expect(events.map(e => e.type)).toEqual(['llm.request', 'llm.response']);
    expect(events[1]).toMatchObject({ verb: 'error', payload: { fingerprint: fingerprint(req), message: 'provider failed' } });
  });
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

describe('LLMGateway.stream', () => {
  it('retains partial chunks and records a terminal error on stream failure', async () => {
    const store = new InMemoryTraceStore();
    const recorder = new Recorder(store, new Session({ session_id: 'partial', tenant_id: 't1', spec_version: '1.0.0' }));
    const provider: LLMProvider = {
      complete: async () => ({ text: '', usage }),
      stream: async function* () { yield 'partial'; throw new Error('stream failed'); },
    };
    const req = { provider: 'mock', model: 'm', messages: [] };
    const gw = new LLMGateway(new Map([['mock', provider]]));
    await expect(gw.stream(req, recorder)).rejects.toThrow('stream failed');
    const events = await store.readBySession('partial');
    expect(events.map(e => e.type)).toEqual(['llm.request', 'llm.stream_chunk', 'llm.response']);
    expect(events[2]).toMatchObject({ verb: 'error', payload: { fingerprint: fingerprint(req), message: 'stream failed' } });
  });
  it('yields chunks via provider.stream and records llm.stream_chunk events', async () => {
    const store = new InMemoryTraceStore();
    const session = new Session({ session_id: 's3', tenant_id: 't1', spec_version: '0.0.1' });
    const recorder = new Recorder(store, session);
    const streaming: LLMProvider = {
      complete: async () => ({ text: 'ab', usage }),
      stream: async function* () {
        yield 'a';
        yield 'b';
      },
    };
    const gw = new LLMGateway(new Map([['mock', streaming]]));
    const tokens: string[] = [];
    const res = await gw.stream(
      { messages: [{ role: 'user', content: 'x' }], model: 'm', provider: 'mock' },
      recorder,
      (chunk) => tokens.push(chunk),
    );
    expect(res.text).toBe('ab');
    expect(tokens).toEqual(['a', 'b']);
    const events = await store.readBySession('s3');
    const types = events.map((e) => e.type);
    expect(types).toEqual(['llm.request', 'llm.stream_chunk', 'llm.stream_chunk', 'llm.response']);
    const chunks = events.filter((e) => e.type === 'llm.stream_chunk');
    expect(chunks.every((c) => c.verb === 'stream_chunk')).toBe(true);
    expect(chunks.map((c) => (c.payload as { text?: string }).text)).toEqual(['a', 'b']);
    const resp = events.find((e) => e.type === 'llm.response');
    expect(resp?.verb).toBe('response');
    expect(resp?.tokens?.total).toBe(2);
  });

  it('falls back to complete() when provider has no stream()', async () => {
    const store = new InMemoryTraceStore();
    const session = new Session({ session_id: 's4', tenant_id: 't1', spec_version: '0.0.1' });
    const recorder = new Recorder(store, session);
    const plain: LLMProvider = { complete: async () => ({ text: 'hi', usage }) };
    const gw = new LLMGateway(new Map([['mock', plain]]));
    const res = await gw.stream(
      { messages: [{ role: 'user', content: 'x' }], model: 'm', provider: 'mock' },
      recorder,
    );
    expect(res.text).toBe('hi');
    const events = await store.readBySession('s4');
    expect(events.filter((e) => e.type === 'llm.stream_chunk').length).toBe(0);
    expect(events.map((e) => e.type)).toEqual(['llm.request', 'llm.response']);
  });

  it('records llm.response error when provider is unknown', async () => {
    const store = new InMemoryTraceStore();
    const session = new Session({ session_id: 's5', tenant_id: 't1', spec_version: '0.0.1' });
    const recorder = new Recorder(store, session);
    const gw = new LLMGateway(new Map());
    await expect(
      gw.stream({ messages: [{ role: 'user', content: 'x' }], model: 'm', provider: 'nope' }, recorder),
    ).rejects.toThrow(/unknown provider/);
    const events = await store.readBySession('s5');
    expect(events.map((e) => e.type)).toEqual(['llm.request', 'llm.response']);
    expect(events[1].verb).toBe('error');
  });
});
