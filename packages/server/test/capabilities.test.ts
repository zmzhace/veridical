import { beforeEach, expect, test } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/app.js';

let app: Awaited<ReturnType<typeof buildApp>>;
beforeEach(async () => {
  const root = mkdtempSync(join(tmpdir(), 'veridical-capabilities-'));
  app = await buildApp(join(root, 'traces'), join(root, 'data'));
});

test('exposes governed builtin tools', async () => {
  const response = await app.inject({ method: 'GET', url: '/api/tools' });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: 'finish', source: 'builtin', status: 'approved' }),
    expect.objectContaining({ id: 'echo', source: 'builtin', status: 'approved' }),
  ]));
});

test('persists MCP server definitions without exposing credentials', async () => {
  const created = await app.inject({
    method: 'POST', url: '/api/mcp/servers',
    payload: { name: 'Research MCP', transport: 'streamable-http', url: 'https://example.com/mcp', credential_ref: 'vault:mcp/research' },
  });
  expect(created.statusCode).toBe(201);
  expect(created.json()).toMatchObject({ id: 'research-mcp', status: 'draft', discovered_tools: [] });
  const listed = await app.inject({ method: 'GET', url: '/api/mcp/servers' });
  expect(listed.json()[0]).not.toHaveProperty('credential');
  expect(JSON.stringify(listed.json())).not.toContain('Bearer ');
});

test('rejects invalid MCP transport configuration', async () => {
  const response = await app.inject({ method: 'POST', url: '/api/mcp/servers', payload: { name: 'Broken', transport: 'stdio' } });
  expect(response.statusCode).toBe(400);
  expect(response.json().error.code).toBe('invalid_mcp_server');
});

test('imports a versioned Skill package from the configured directory', async () => {
  const root = mkdtempSync(join(tmpdir(), 'veridical-skill-')); const skillDir = join(root, 'skills', 'research');
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'skill.json'), JSON.stringify({ name: 'research', version: '1.2.0', description: 'Research method', tags: ['research'], tool_dependencies: ['echo'] }));
  writeFileSync(join(skillDir, 'SKILL.md'), '# Research\n\nUse evidence and cite sources.');
  process.env.VERIDICAL_SKILLS_DIR = join(root, 'skills');
  try {
    const response = await app.inject({ method: 'POST', url: '/api/skills/import-directory', payload: { path: skillDir } });
    expect(response.statusCode).toBe(201); expect(response.json()).toMatchObject({ key: 'research@1.2.0', status: 'draft', tool_dependencies: ['echo'] });
  } finally { delete process.env.VERIDICAL_SKILLS_DIR; }
});
