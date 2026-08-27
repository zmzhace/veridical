import { test, expect } from 'vitest';
import { buildChat } from '../src/pages/SessionPage';
import type { TraceEvent } from '@veridical/schema';

function ev(partial: Partial<TraceEvent> & { id: string; seq: number; type: string }): TraceEvent {
  return {
    tenant_id: 't', session_id: 's', span_id: 'sp', parent_span_id: null,
    verb: 'response', attempt: 0, duration_ms: 0, payload: {}, spec_version: '1.0.0',
    ...partial,
  } as TraceEvent;
}

test('checkpoint present in both events stream and checkpoints list attaches once', () => {
  const cp7 = ev({ id: 'cp7', seq: 7, type: 'state.checkpoint' });
  const cp12 = ev({ id: 'cp12', seq: 12, type: 'state.checkpoint' });
  const events = [
    ev({ id: 'u1', seq: 1, type: 'user.message', payload: { text: 'hi' } }),
    ev({ id: 'a1', seq: 5, type: 'assistant.message', payload: { text: 'yo' } }),
    cp7,
    ev({ id: 't1', seq: 8, type: 'tool.called', payload: { name: 'x' }, verb: 'request' }),
    ev({ id: 'u2', seq: 10, type: 'user.message', payload: { text: 'go' } }),
    ev({ id: 'a2', seq: 11, type: 'assistant.message', payload: { text: 'done' } }),
    cp12,
  ];
  const items = buildChat(events, [cp7, cp12]);
  const checkpoints = items.filter(i => i.kind === 'bubble').flatMap(i => i.checkpoints);
  expect(checkpoints).toHaveLength(2);
});

test('checkpoint only in checkpoints list (not in events) still attaches to nearest assistant', () => {
  const cp3 = ev({ id: 'cp3', seq: 7, type: 'state.checkpoint' });
  const events = [
    ev({ id: 'u1', seq: 1, type: 'user.message', payload: { text: 'hi' } }),
    ev({ id: 'a1', seq: 5, type: 'assistant.message', payload: { text: 'yo' } }),
  ];
  const items = buildChat(events, [cp3]);
  const checkpoints = items.filter(i => i.kind === 'bubble').flatMap(i => i.checkpoints);
  expect(checkpoints).toHaveLength(1);
  expect(checkpoints[0].id).toBe('cp3');
});

test('dedupes user.message within a turn but keeps across turns', () => {
  const events = [
    ev({ id: 't1', seq: 1, type: 'turn/start', payload: { prompt: 'a' } }),
    ev({ id: 'u1', seq: 2, type: 'user.message', payload: { text: '你好' } }),
    ev({ id: 'u2', seq: 3, type: 'user.message', payload: { text: '你好' } }),
    ev({ id: 'a1', seq: 4, type: 'assistant.message', payload: { text: '嗨' } }),
    ev({ id: 't2', seq: 5, type: 'turn/start', payload: { prompt: 'b' } }),
    ev({ id: 'u3', seq: 6, type: 'user.message', payload: { text: '我的保单' } }),
    ev({ id: 'a2', seq: 7, type: 'assistant.message', payload: { text: '请稍候' } }),
  ];
  const items = buildChat(events, []);
  const users = items.filter((i) => i.kind === 'bubble' && i.role === 'user').map((i) => i.event.payload.text);
  expect(users).toEqual(['你好', '我的保单']);
});

test('inserts a turn boundary item between turns', () => {
  const events = [
    ev({ id: 't1', seq: 1, type: 'turn/start', payload: {} }),
    ev({ id: 'u1', seq: 2, type: 'user.message', payload: { text: 'a' } }),
    ev({ id: 'a1', seq: 3, type: 'assistant.message', payload: { text: 'x' } }),
    ev({ id: 't2', seq: 4, type: 'turn/start', payload: {} }),
    ev({ id: 'u2', seq: 5, type: 'user.message', payload: { text: 'b' } }),
    ev({ id: 'a2', seq: 6, type: 'assistant.message', payload: { text: 'y' } }),
  ];
  const items = buildChat(events, []);
  const kinds = items.map((i) => i.kind);
  // 两个 turn/start 对应的边界项（首轮也可渲染为边界）
  expect(kinds.filter((k) => k === 'stage').length).toBe(2);
  expect(items.length).toBe(6);
  expect((items[1] as any).event.id).toBe('u1');
});