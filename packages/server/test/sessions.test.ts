import { test, expect, beforeAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonlTraceStore } from '@veridical/store';
import { buildApp } from '../src/app.js';

let app: Awaited<ReturnType<typeof buildApp>>;
let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'vrx-'));
  const store = new JsonlTraceStore(dir);
  await store.append({ id: 'e1', tenant_id: 't1', session_id: 's1', span_id: 'a', parent_span_id: null, seq: 1, type: 'llm.request', verb: 'request', attempt: 1, duration_ms: 10, tokens: { input: 1, output: 2, cached: 0, total: 3 }, cost: 0.01, payload: { provider: 'mock', model: 'm' }, spec_version: '1.0.0' });
  await store.append({ id: 'e2', tenant_id: 't1', session_id: 's1', span_id: 'b', parent_span_id: 'a', seq: 2, type: 'llm.response', verb: 'response', attempt: 1, duration_ms: 20, tokens: { input: 1, output: 2, cached: 0, total: 3 }, cost: 0.01, payload: { text: 'hi' }, spec_version: '1.0.0' });
  app = await buildApp(dir);
});

test('lists sessions with summary', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/sessions' });
  expect(res.statusCode).toBe(200);
  const body = res.json();
  expect(body).toHaveLength(1);
  expect(body[0].session_id).toBe('s1');
  expect(body[0].event_count).toBe(2);
  expect(body[0].total_tokens?.total).toBe(6);
});

test('returns full events for a session', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/sessions/s1' });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toHaveLength(2);
});
