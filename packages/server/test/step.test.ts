import { describe, it, expect } from 'vitest';
import { buildApp } from '../src/app';

describe('checkpoints + step run', () => {
  it('GET /api/sessions/:id/checkpoints filters checkpoint events', async () => {
    const app = await buildApp('/tmp/rt-step-check-' + Date.now(), '/tmp/rt-step-specs-' + Date.now());
    const store = (app as any).store as { append: (e: any) => Promise<void> };
    await store.append({ id: 'e1', tenant_id: 't1', session_id: 'cp1', span_id: 'loop', parent_span_id: null, seq: 1, type: 'llm.request', verb: 'request', attempt: 1, duration_ms: 0, payload: {}, spec_version: '1.0.0' });
    await store.append({ id: 'e2', tenant_id: 't1', session_id: 'cp1', span_id: 'loop', parent_span_id: null, seq: 2, type: 'state.checkpoint', verb: 'response', attempt: 1, duration_ms: 0, payload: { frame: 1, messages: [] }, spec_version: '1.0.0' });
    const res = await app.inject({ method: 'GET', url: '/api/sessions/cp1/checkpoints' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.length).toBe(1);
    expect(body[0].type).toBe('state.checkpoint');
    await app.close();
  });
});
