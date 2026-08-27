import { describe, it, expect } from 'vitest';
import { buildApp } from '../src/app';
import { buildHistory } from '../src/routes/turn.js';

function mkEvent(session: string, seq: number, type: string, payload: unknown, id = `${session}-${seq}`) {
  return { id, tenant_id: 't1', session_id: session, span_id: 'loop', parent_span_id: null, seq, type, verb: 'response', attempt: 1, duration_ms: 0, payload, spec_version: '1.0.0' };
}

describe('buildHistory', () => {
  it('dedups user.message per turn and keeps last assistant', () => {
    const events = [
      mkEvent('c', 1, 'turn/start', { prompt: 'a' }),
      mkEvent('c', 2, 'user.message', { text: '你好' }),
      mkEvent('c', 3, 'user.message', { text: '你好' }),
      mkEvent('c', 4, 'assistant.message', { text: '嗨' }),
      mkEvent('c', 5, 'assistant.message', { text: '嗨，需要什么？' }),
      mkEvent('c', 6, 'turn/start', { prompt: 'b' }),
      mkEvent('c', 7, 'user.message', { text: '我的保单' }),
      mkEvent('c', 8, 'assistant.message', { text: '请稍候' }),
    ];
    const history = buildHistory(events, 'c');
    expect(history).toEqual([
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '嗨，需要什么？' },
      { role: 'user', content: '我的保单' },
      { role: 'assistant', content: '请稍候' },
    ]);
  });

  it('truncates to last 10 turns', () => {
    const events: any[] = [];
    for (let i = 0; i < 12; i++) {
      events.push(mkEvent('c', i * 3 + 1, 'turn/start', { prompt: String(i) }));
      events.push(mkEvent('c', i * 3 + 2, 'user.message', { text: `q${i}` }));
      events.push(mkEvent('c', i * 3 + 3, 'assistant.message', { text: `a${i}` }));
    }
    const history = buildHistory(events, 'c');
    expect(history.length).toBe(20); // 10 turns × 2
    expect(history[0]).toEqual({ role: 'user', content: 'q2' });
    expect(history[history.length - 1]).toEqual({ role: 'assistant', content: 'a11' });
  });
});

describe('POST /api/run/turn error paths', () => {
  it('400 when specName missing', async () => {
    const app = await buildApp('/tmp/rt-turn-a-' + Date.now(), '/tmp/rt-turn-specs-' + Date.now());
    const res = await app.inject({ method: 'POST', url: '/api/run/turn', payload: { prompt: 'hi' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('bad_request');
    await app.close();
  });

  it('400 when spec not registered', async () => {
    const app = await buildApp('/tmp/rt-turn-b-' + Date.now(), '/tmp/rt-turn-specs-' + Date.now());
    const res = await app.inject({ method: 'POST', url: '/api/run/turn', payload: { specName: 'ghost', prompt: 'hi' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invalid_spec');
    await app.close();
  });

  it('404 when continuing a nonexistent conversation', async () => {
    const app = await buildApp('/tmp/rt-turn-c-' + Date.now(), '/tmp/rt-turn-specs-' + Date.now());
    // 先注册一个合法 spec
    const yaml = `name: demo\nversion: 1.0.0\nschema_version: 1\ninstruction: { system: hi }\nflow: { mode: single-loop, max_steps: 1 }\nllm: { provider: mock, model: m, fallback: [] }\ntools: []\n`;
    await app.inject({ method: 'POST', url: '/api/specs', payload: { yaml } });
    const res = await app.inject({ method: 'POST', url: '/api/run/turn', payload: { specName: 'demo', conversationId: 'conv_missing', prompt: 'hi' } });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('not_found');
    await app.close();
  });

  it('400 body unchanged when specName missing (sanity)', async () => {
    const app = await buildApp('/tmp/rt-turn-d-' + Date.now(), '/tmp/rt-turn-specs-' + Date.now());
    const res = await app.inject({ method: 'POST', url: '/api/run/turn', payload: { prompt: 'hi' } });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
