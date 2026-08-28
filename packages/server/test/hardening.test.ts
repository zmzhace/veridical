import { afterEach, beforeEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/app';

let app: Awaited<ReturnType<typeof buildApp>>;
let dir: string;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'veridical-http-'));
  app = await buildApp(join(dir, 'traces'), join(dir, 'specs'));
});
afterEach(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

const specYaml = `
name: probe
version: 1.0.0
schema_version: 1
instruction: { system: test }
flow: { mode: single-loop, max_steps: 1 }
llm: { provider: mock, model: m }
tools: [{ name: echo, access: deny }]
`;

test('single-run HTTP records model calls and rejects denied tools during evaluation', async () => {
  const response = await app.inject({
    method: 'POST', url: '/api/run',
    payload: { specYaml, mode: 'mock', prompt: 'test', script: [JSON.stringify({ tool: { name: 'echo', args: { x: 1 } } })] },
  });
  expect(response.statusCode).toBe(200);
  const frames = response.body.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
  const done = frames.find(frame => frame.type === 'done');
  expect(done).toBeDefined();
  const events = await app.store.readBySession(done.session_id);
  expect(events.filter(e => e.type === 'llm.request')).toHaveLength(1);
  expect(events.filter(e => e.type === 'llm.response')).toHaveLength(1);
  expect(events.find(e => e.type === 'tool.result')?.verb).toBe('error');
  for (const request of [
    { method: 'POST' as const, url: '/api/evaluate', payload: { sessionId: done.session_id } },
    { method: 'GET' as const, url: `/api/evals/${done.session_id}` },
  ]) {
    const evaluation = await app.inject(request);
    expect(evaluation.statusCode).toBe(200);
    expect(evaluation.json()).toMatchObject({ passed: false, rules: { rules: [{ name: 'no_errors', passed: false }] } });
  }
});

test('spec registration rejects path traversal without creating a spec', async () => {
  const response = await app.inject({ method: 'POST', url: '/api/specs', payload: { yaml: specYaml.replace('name: probe', 'name: ../escape') } });
  expect(response.statusCode).toBe(400);
  expect(await app.specRegistry.list()).toEqual([]);
});
