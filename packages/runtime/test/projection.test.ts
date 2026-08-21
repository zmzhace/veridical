import { describe, it, expect } from 'vitest';
import { InMemoryTraceStore } from '@veridical/store';
import { deriveMessages } from '../src/index';

function evt(session_id: string, seq: number, type: string, verb: string, payload: any) {
  return { id: `e_${seq}`, tenant_id: 't1', session_id, span_id: 'sp', parent_span_id: null, seq, type, verb, attempt: 1, duration_ms: 1, payload, spec_version: '0.0.1' };
}

describe('deriveMessages', () => {
  it('rebuilds user/assistant/tool messages from events', async () => {
    const store = new InMemoryTraceStore();
    const s = 's1';
    await store.append(evt(s, 1, 'user.message', 'request', { text: 'hello' }));
    await store.append(evt(s, 2, 'assistant.message', 'response', { text: 'let me check' }));
    await store.append(evt(s, 3, 'tool.called', 'request', { name: 'get_map', args: { q: 'x' } }));
    await store.append(evt(s, 4, 'tool.result', 'response', { name: 'get_map', result: 'ok' }));
    const msgs = await deriveMessages(store, s);
    expect(msgs.map(m => m.role)).toEqual(['user', 'assistant', 'assistant', 'assistant']);
    expect(msgs[2].tool_calls![0].name).toBe('get_map');
    expect(msgs[3].content).toContain('ok');
  });
});

describe('deriveMessages upToSeq', () => {
  it('truncates to seq when upToSeq provided', async () => {
    const { InMemoryTraceStore } = await import('@veridical/store');
    const store = new InMemoryTraceStore();
    await store.append(evt('s1', 1, 'user.message', 'request', { text: 'a' }));
    await store.append(evt('s1', 2, 'assistant.message', 'response', { text: 'b' }));
    await store.append(evt('s1', 3, 'user.message', 'request', { text: 'c' }));
    const msgs = await deriveMessages(store, 's1', 2);
    expect(msgs.map(m => m.content)).toEqual(['a', 'b']);
  });

  it('defaults to full when upToSeq omitted', async () => {
    const { InMemoryTraceStore } = await import('@veridical/store');
    const store = new InMemoryTraceStore();
    await store.append(evt('s1', 1, 'user.message', 'request', { text: 'a' }));
    await store.append(evt('s1', 2, 'assistant.message', 'response', { text: 'b' }));
    const msgs = await deriveMessages(store, 's1');
    expect(msgs.map(m => m.content)).toEqual(['a', 'b']);
  });
});
