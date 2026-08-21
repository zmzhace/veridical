import { describe, it, expect } from 'vitest';
import type { TraceEvent } from '@veridical/schema';
import { fingerprint } from '@veridical/llm';
import { ReplayLLMProvider, ReplayToolProvider, ReplayMissError } from '../src/index';

function evt(seq: number, type: string, verb: string, payload: any): TraceEvent {
  return { id: `e${seq}`, tenant_id: 't1', session_id: 's1', span_id: 'sp', parent_span_id: null, seq, type, verb, attempt: 1, duration_ms: 1, payload, spec_version: '0.0.1' };
}

describe('ReplayLLMProvider', () => {
  const req = { provider: 'mock', model: 'm', messages: [{ role: 'user', content: 'hello' }] };
  const fp = fingerprint(req);
  const events = [
    evt(1, 'llm.request', 'request', { provider: 'mock', model: 'm', fingerprint: fp, messages: req.messages }),
    evt(2, 'llm.response', 'response', { provider: 'mock', model: 'm', fingerprint: fp, text: 'recorded answer' },),
  ];

  it('returns the recorded response for a matching fingerprint', async () => {
    const p = new ReplayLLMProvider(events);
    const res = await p.complete(req);
    expect(res.text).toBe('recorded answer');
    expect(res.usage).toEqual({ input: 0, output: 0, cached: 0, total: 0 });
  });

  it('throws ReplayMissError on an unknown fingerprint', async () => {
    const p = new ReplayLLMProvider(events);
    await expect(p.complete({ ...req, messages: [{ role: 'user', content: 'other' }] })).rejects.toThrow(ReplayMissError);
  });
});

describe('ReplayToolProvider', () => {
  const events = [
    evt(1, 'tool.called', 'request', { name: 'echo', args: { x: 1 } }),
    evt(2, 'tool.result', 'response', { name: 'echo', result: { echoed: 1 } }),
    evt(3, 'tool.called', 'request', { name: 'echo', args: { x: 2 } }),
    evt(4, 'tool.result', 'response', { name: 'echo', result: { echoed: 2 } }),
  ];

  it('serves the Nth recorded result for the Nth call', async () => {
    const p = new ReplayToolProvider(events);
    expect(await p.execute('echo', { x: 1 })).toEqual({ echoed: 1 });
    expect(await p.execute('echo', { x: 2 })).toEqual({ echoed: 2 });
  });

  it('throws ReplayMissError when the call sequence is exhausted', async () => {
    const p = new ReplayToolProvider(events);
    await p.execute('echo', { x: 1 });
    await p.execute('echo', { x: 2 });
    await expect(p.execute('echo', { x: 3 })).rejects.toThrow(ReplayMissError);
  });
});
