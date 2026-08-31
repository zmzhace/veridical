import { beforeEach, expect, test } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/app.js';

let app: Awaited<ReturnType<typeof buildApp>>;
beforeEach(async () => { const root = mkdtempSync(join(tmpdir(), 'veridical-data-')); app = await buildApp(join(root, 'traces'), join(root, 'data')); });

test('memory candidates can be approved and deleted', async () => {
  const created = await app.inject({ method: 'POST', url: '/api/memories', payload: { organization_id: 'org', project_id: 'project', scope: 'project', kind: 'candidate', content: { preference: 'concise' } } });
  expect(created.statusCode).toBe(201); const id = created.json().id;
  const approved = await app.inject({ method: 'POST', url: `/api/memories/${id}/decision`, payload: { status: 'active' } });
  expect(approved.json().status).toBe('active');
  const deleted = await app.inject({ method: 'DELETE', url: `/api/memories/${id}` }); expect(deleted.json()).toEqual({ id, deleted: true });
});

test('knowledge files are scoped and content is retrievable', async () => {
  const created = await app.inject({ method: 'POST', url: '/api/knowledge/files', payload: { organization_id: 'org', project_id: 'project', name: 'notes.txt', mime_type: 'text/plain', content_base64: Buffer.from('hello').toString('base64') } });
  expect(created.statusCode).toBe(201); const id = created.json().id;
  const listed = await app.inject({ method: 'GET', url: '/api/knowledge/files?organization_id=org&project_id=project' }); expect(listed.json()).toHaveLength(1);
  const search = await app.inject({ method: 'GET', url: '/api/knowledge/search?organization_id=org&project_id=project&query=hello' }); expect(search.json()[0]).toMatchObject({ file_id: id, file_name: 'notes.txt' });
  const content = await app.inject({ method: 'GET', url: `/api/knowledge/files/${id}/content` }); expect(content.body).toBe('hello');
});
