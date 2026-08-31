import type { FastifyInstance } from 'fastify';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

const Id = z.string().min(1).max(80).regex(/^[a-zA-Z0-9_.-]+$/);
const OrgInput = z.object({ id: Id.optional(), name: z.string().trim().min(1).max(120) });
const ProjectInput = z.object({ id: Id.optional(), organization_id: Id, name: z.string().trim().min(1).max(120), description: z.string().max(500).default('') });
type Org = { id: string; name: string; created_at: string };
type Project = { id: string; organization_id: string; name: string; description: string; created_at: string };

export async function registerOrganizationRoutes(app: FastifyInstance, opts: { dataDir?: string } = {}) {
  const file = join(opts.dataDir ?? process.cwd(), 'organizations.json');
  async function read(): Promise<{ organizations: Org[]; projects: Project[] }> {
    try { return JSON.parse(await readFile(file, 'utf8')) as { organizations: Org[]; projects: Project[] }; }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; return { organizations: [], projects: [] }; }
  }
  async function write(value: { organizations: Org[]; projects: Project[] }) { await mkdir(dirname(file), { recursive: true }); const tmp = `${file}.${randomUUID()}.tmp`; await writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600 }); await rename(tmp, file); }
  app.get('/api/organizations', async () => (await read()).organizations);
  app.post('/api/organizations', async (req, reply) => {
    const parsed = OrgInput.safeParse(req.body); if (!parsed.success) return reply.code(400).send({ error: { code: 'invalid_organization' } });
    const db = await read(); const id = parsed.data.id ?? `org_${randomUUID().slice(0, 12)}`;
    if (db.organizations.some((x) => x.id === id)) return reply.code(409).send({ error: { code: 'organization_exists' } });
    const row = { id, name: parsed.data.name, created_at: new Date().toISOString() }; db.organizations.push(row); await write(db); return reply.code(201).send(row);
  });
  app.get('/api/projects', async (req, reply) => { const q = z.object({ organization_id: Id }).safeParse(req.query); if (!q.success) return reply.code(400).send({ error: { code: 'organization_required' } }); return (await read()).projects.filter((x) => x.organization_id === q.data.organization_id); });
  app.post('/api/projects', async (req, reply) => {
    const parsed = ProjectInput.safeParse(req.body); if (!parsed.success) return reply.code(400).send({ error: { code: 'invalid_project' } });
    const db = await read(); if (!db.organizations.some((x) => x.id === parsed.data.organization_id)) return reply.code(404).send({ error: { code: 'organization_not_found' } });
    const id = parsed.data.id ?? `proj_${randomUUID().slice(0, 12)}`; if (db.projects.some((x) => x.id === id)) return reply.code(409).send({ error: { code: 'project_exists' } });
    const row = { ...parsed.data, id, created_at: new Date().toISOString() }; db.projects.push(row); await write(db); return reply.code(201).send(row);
  });
}
