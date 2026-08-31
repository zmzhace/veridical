import { beforeEach, expect, test } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/app.js';

let app: Awaited<ReturnType<typeof buildApp>>;
beforeEach(async () => {
  const root = mkdtempSync(join(tmpdir(), 'veridical-agents-'));
  app = await buildApp(join(root, 'traces'), join(root, 'specs'));
});

test('creates an Agent and persists its typed graph draft', async () => {
  const created = await app.inject({
    method: 'POST',
    url: '/api/agents',
    payload: { name: 'Research Agent', description: 'Collect evidence', model: 'server-default' },
  });
  expect(created.statusCode).toBe(201);
  const agent = created.json();
  const saved = await app.inject({
    method: 'PUT',
    url: `/api/agents/${agent.id}/draft`,
    payload: { graph: { id: agent.id, nodes: [], edges: [] }, yaml: 'name: test' },
  });
  expect(saved.statusCode).toBe(200);
  expect(saved.json().revision).toBe(1);
  const listed = await app.inject({ method: 'GET', url: '/api/agents' });
  expect(listed.json()[0]).toMatchObject({ id: agent.id, status: 'draft' });
});

test('publishes a validated immutable Agent spec', async () => {
  const created = await app.inject({
    method: 'POST',
    url: '/api/agents',
    payload: { name: 'research', description: 'Collect evidence', model: 'server-default' },
  });
  const id = created.json().id;
  const yaml = `name: ${id}\nversion: 1.0.0\nschema_version: 1\ndescription: Research\ninstruction:\n  system: Collect evidence\nflow:\n  mode: single-loop\n  max_steps: 8\n  loop:\n    engine: orchestrator\n    strategy: direct\nllm:\n  provider: local\n  model: configured\n  fallback: []\ntools: []\nskills: []\nagents: []\n`;
  const published = await app.inject({
    method: 'POST',
    url: `/api/agents/${id}/publish`,
    payload: { yaml, graph: { id } },
  });
  expect(published.statusCode).toBe(200);
  expect(published.json().agent).toMatchObject({ status: 'published', version: '1.0.0' });
  expect(published.json().release.spec_hash).toMatch(/^[a-f0-9]{64}$/);
  expect(published.json().release.artifact).toMatchObject({ kind: 'release', name: id, version: '1.0.0' });
  expect(published.json().agent.capabilities).toMatchObject({
    model: { provider: 'local', name: 'configured' }, tools: [], skills: [], child_agents: [],
  });
});

test('publish rejects capabilities that are not approved in the registry', async () => {
  const created = await app.inject({ method: 'POST', url: '/api/agents', payload: { name: 'guarded', description: 'Guarded', model: 'server-default' } });
  const id = created.json().id;
  const yaml = `name: ${id}\nversion: 1.0.0\nschema_version: 1\ndescription: Guarded\ninstruction:\n  system: Guarded\nflow:\n  mode: single-loop\n  max_steps: 3\nllm:\n  provider: local\n  model: configured\n  fallback: []\ntools:\n  - name: unknown\n    access: allow\nskills: []\nagents: []\n`;
  const response = await app.inject({ method: 'POST', url: `/api/agents/${id}/publish`, payload: { yaml } });
  expect(response.statusCode).toBe(409); expect(response.json().error.code).toBe('publish_failed');
});
