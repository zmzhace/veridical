import type { FastifyInstance } from 'fastify';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';

const MemoryInput = z.object({ organization_id: z.string().min(1), project_id: z.string().min(1), user_id: z.string().optional(), agent_id: z.string().optional(), scope: z.enum(['task', 'project', 'user', 'agent']), kind: z.enum(['fact', 'preference', 'summary', 'candidate']).default('fact'), content: z.unknown(), summary: z.string().max(1000).optional(), source_refs: z.array(z.string()).default([]), confidence: z.number().min(0).max(1).default(1), sensitivity: z.enum(['normal', 'sensitive', 'restricted']).default('normal'), expires_at: z.string().datetime().optional(), status: z.enum(['candidate', 'active', 'rejected', 'deleted']).default('candidate') });
type MemoryRecord = z.infer<typeof MemoryInput> & { id: string; content_hash: string; created_at: string; updated_at: string };
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export async function registerMemoryRoutes(app: FastifyInstance, opts: { dataDir?: string } = {}) {
  const file = join(opts.dataDir ?? process.cwd(), 'memories.json');
  async function read(): Promise<MemoryRecord[]> { try { return JSON.parse(await readFile(file, 'utf8')) as MemoryRecord[]; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return []; } }
  async function write(rows: MemoryRecord[]) { await mkdir(dirname(file), { recursive: true }); const tmp = `${file}.${randomUUID()}.tmp`; await writeFile(tmp, JSON.stringify(rows, null, 2), { mode: 0o600 }); await rename(tmp, file); }
  app.get('/api/memories', async (req) => {
    const query = z.object({ organization_id: z.string().min(1), project_id: z.string().min(1), user_id: z.string().optional(), scope: z.enum(['task', 'project', 'user', 'agent']).optional() }).parse(req.query);
    const now = Date.now();
    return (await read()).filter((memory) => memory.organization_id === query.organization_id && memory.project_id === query.project_id && memory.status !== 'deleted' && (!memory.expires_at || Date.parse(memory.expires_at) > now) && (!query.user_id || memory.user_id === query.user_id) && (!query.scope || memory.scope === query.scope));
  });
  app.post('/api/memories', async (req, reply) => {
    const parsed = MemoryInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'invalid_memory', details: parsed.error.issues } });
    const now = new Date().toISOString();
    const row: MemoryRecord = { ...parsed.data, id: randomUUID(), content_hash: hash(parsed.data.content), created_at: now, updated_at: now };
    const rows = await read(); rows.push(row); await write(rows); return reply.code(201).send(row);
  });
  app.delete<{ Params: { id: string } }>('/api/memories/:id', async (req, reply) => {
    const rows = await read(); const row = rows.find((memory) => memory.id === req.params.id);
    if (!row) return reply.code(404).send({ error: { code: 'memory_not_found' } });
    row.status = 'deleted'; row.updated_at = new Date().toISOString(); await write(rows); return { id: row.id, deleted: true };
  });
  app.post<{ Params: { id: string } }>('/api/memories/:id/decision', async (req, reply) => {
    const decision = z.object({ status: z.enum(['active', 'rejected']) }).safeParse(req.body);
    if (!decision.success) return reply.code(400).send({ error: { code: 'invalid_memory_decision' } });
    const rows = await read(); const row = rows.find((memory) => memory.id === req.params.id);
    if (!row) return reply.code(404).send({ error: { code: 'memory_not_found' } });
    row.status = decision.data.status; row.updated_at = new Date().toISOString(); await write(rows); return row;
  });
}
