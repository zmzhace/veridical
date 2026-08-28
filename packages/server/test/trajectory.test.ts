import { afterAll, beforeAll, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentSpecSchema, runSpec } from '@veridical/spec';
import { buildApp } from '../src/app';
import { resolveTools } from '../src/providers';

let app: Awaited<ReturnType<typeof buildApp>>;
const directory = mkdtempSync(join(tmpdir(), 'veridical-trajectories-'));
beforeAll(async () => {
  app = await buildApp(join(directory, 'traces'), join(directory, 'specs'));
  const spec = AgentSpecSchema.parse({
    name: 'trajectory',
    version: '1.0.0',
    schema_version: 1,
    instruction: { system: 'test' },
    flow: { max_steps: 1 },
    llm: { provider: 'mock', model: 'm' },
    tools: [{ name: 'echo', access: 'allow' }],
  });
  await app.specRegistry.register(spec);
  await runSpec(
    {
      store: app.store,
      registry: app.specRegistry,
      tenant_id: 't1',
      session_id: 'trajectory',
      providers: new Map([
        [
          'mock',
          {
            complete: async () => ({
              text: 'done',
              usage: { input: 1, output: 1, cached: 0, total: 2 },
            }),
          },
        ],
      ]),
      tools: resolveTools(['echo']),
      release_artifact_hash: 'c'.repeat(64),
      runStep: async () => ({
        text: 'echo',
        tool: { name: 'echo', args: { in: 'value', session_id: 'business-id' } },
      }),
    },
    spec,
    'prompt',
  );
});
afterAll(async () => {
  await app.close();
  rmSync(directory, { recursive: true, force: true });
});

test('internal training API is removed while data export remains available', async () => {
  const response = await app.inject({ method: 'POST', url: '/api/rl/train', payload: {} });
  expect(response.statusCode).toBe(404);
});

test('invocations endpoint pairs full input/output and trajectory filters a path', async () => {
  const response = await app.inject({ method: 'GET', url: '/api/sessions/trajectory/invocations' });
  expect(response.statusCode).toBe(200);
  expect(response.json().legacy).toBe(false);
  const tool = response.json().invocations.find((i: any) => i.actor === 'tool');
  expect(tool.input.args.session_id).toBe('business-id');
  expect(tool.status).toBe('success');
  expect(tool.output).toBeDefined();
  const trajectory = await app.inject({
    method: 'GET',
    url: '/api/sessions/trajectory/trajectory?path=root%2Ftool%3Aecho%231',
  });
  expect(trajectory.json()).toHaveLength(1);
  expect(trajectory.json()[0].tool_input).toEqual(tool.input.args);
});

test('replay endpoint executes strict path replay and rejects unsupported controls', async () => {
  const replay = await app.inject({
    method: 'POST',
    url: '/api/sessions/trajectory/replay',
    payload: { mode: 'strict' },
  });
  expect(replay.statusCode).toBe(200);
  expect(replay.json()).toMatchObject({ mode: 'strict', identical: true, external_calls: 0 });
  const denied = await app.inject({
    method: 'POST',
    url: '/api/sessions/trajectory/replay',
    payload: { mode: 'strict', tools: { echo: 'live' } },
  });
  expect(denied.statusCode).toBe(400);
  const missing = await app.inject({
    method: 'POST',
    url: '/api/sessions/missing/replay',
    payload: { mode: 'strict' },
  });
  expect(missing.statusCode).toBe(404);
});

test('exports JSON, JSONL and reward-labelled GRPO without inventing reward or release', async () => {
  const json = await app.inject({
    method: 'POST',
    url: '/api/sessions/trajectory/trajectory/export',
    payload: { format: 'json' },
  });
  expect(Array.isArray(json.json())).toBe(true);
  const grpo = await app.inject({
    method: 'POST',
    url: '/api/sessions/trajectory/trajectory/export',
    payload: { format: 'grpo', group_id: 'prompt-group', rewards: { 'root/decision#1@1': 1 } },
  });
  expect(grpo.statusCode).toBe(200);
  expect(grpo.headers['content-type']).toContain('application/x-ndjson');
  const row = JSON.parse(grpo.body.trim());
  expect(row).toMatchObject({
    prompt: 'prompt',
    reward: 1,
    group_id: 'prompt-group',
    release_artifact_hash: 'c'.repeat(64),
  });
  expect(row.tools[0].tool_input).toMatchObject({ session_id: 'business-id' });
  const bad = await app.inject({
    method: 'POST',
    url: '/api/sessions/trajectory/trajectory/export',
    payload: { format: 'grpo' },
  });
  expect(bad.statusCode).toBe(400);
  const forged = await app.inject({
    method: 'POST',
    url: '/api/sessions/trajectory/trajectory/export',
    payload: { release_artifact_hash: 'fake' },
  });
  expect(forged.statusCode).toBe(400);
});
