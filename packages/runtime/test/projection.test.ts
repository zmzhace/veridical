import { describe, it, expect } from 'vitest';
import { InMemoryTraceStore } from '@rt/store';
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
