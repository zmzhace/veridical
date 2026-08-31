import type { FastifyInstance } from 'fastify';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';

const Upload = z.object({ organization_id: z.string().min(1), project_id: z.string().min(1), name: z.string().min(1).max(240), mime_type: z.string().min(1).max(120), content_base64: z.string().min(1).max(20_000_000) });
type Chunk = { id: string; text: string; start: number; end: number; hash: string; embedding: number[] };
type FileRecord = { id: string; organization_id: string; project_id: string; name: string; mime_type: string; size: number; content_hash: string; status: 'processing' | 'ready' | 'rejected'; chunks: Chunk[]; created_at: string };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
/** Deterministic local embedding fallback. Replaceable by a provider without changing the index format. */
const embed = (value: string, dimensions = 64) => { const vector = Array.from({ length: dimensions }, () => 0); for (const token of value.toLowerCase().split(/\W+/).filter(Boolean)) { const digest = createHash('sha256').update(token).digest(); for (let i = 0; i < 4; i += 1) vector[digest[i] % dimensions] += (digest[i + 4] / 255) * 2 - 1; } const norm = Math.hypot(...vector) || 1; return vector.map((item) => item / norm); };
const cosine = (a: number[], b: number[]) => { const normA = Math.hypot(...a) || 1; const normB = Math.hypot(...b) || 1; return a.reduce((sum, item, i) => sum + item * (b[i] ?? 0), 0) / (normA * normB); };
async function extractText(bytes: Buffer, mime: string): Promise<string | null> {
  if (/^(text\/|application\/(json|csv|xml)|.*\+json$)/.test(mime)) return bytes.toString('utf8');
  if (mime === 'application/pdf' || mime === 'application/x-pdf') {
    const { PDFParse } = await import('pdf-parse');
    const parser = new PDFParse({ data: bytes });
    try { return (await parser.getText()).text; } finally { await parser.destroy(); }
  }
  if (mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || mime === 'application/msword') {
    const mammoth = await import('mammoth') as unknown as { extractRawText(input: { buffer: Buffer }): Promise<{ value: string }> };
    return (await mammoth.extractRawText({ buffer: bytes })).value;
  }
  return null;
}

export async function registerKnowledgeRoutes(app: FastifyInstance, opts: { dataDir?: string } = {}) {
  const root = opts.dataDir ?? process.cwd(); const file = join(root, 'knowledge-files.json'); const blobs = join(root, 'knowledge-blobs');
  async function read(): Promise<FileRecord[]> { try { return JSON.parse(await readFile(file, 'utf8')) as FileRecord[]; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return []; } }
  async function write(rows: FileRecord[]) { await mkdir(dirname(file), { recursive: true }); const tmp = `${file}.${randomUUID()}.tmp`; await writeFile(tmp, JSON.stringify(rows, null, 2), { mode: 0o600 }); await rename(tmp, file); }
  app.get('/api/knowledge/files', async (req) => { const q = z.object({ organization_id: z.string().min(1), project_id: z.string().min(1) }).parse(req.query); return (await read()).filter((item) => item.organization_id === q.organization_id && item.project_id === q.project_id); });
  app.post('/api/knowledge/files', async (req, reply) => {
    const parsed = Upload.safeParse(req.body); if (!parsed.success) return reply.code(400).send({ error: { code: 'invalid_file', details: parsed.error.issues } });
    let bytes: Buffer; try { bytes = Buffer.from(parsed.data.content_base64, 'base64'); } catch { return reply.code(400).send({ error: { code: 'invalid_file_encoding' } }); }
    if (!bytes.length || bytes.length > 15 * 1024 * 1024) return reply.code(413).send({ error: { code: 'file_too_large' } });
    const id = randomUUID();
    let text = ''; let status: FileRecord['status'] = 'processing';
    try { text = (await extractText(bytes, parsed.data.mime_type)) ?? ''; status = text ? 'ready' : 'processing'; } catch { status = 'rejected'; }
    const chunks: Chunk[] = [];
    for (let start = 0, n = 0; start < text.length; start += 1200, n += 1) {
      const end = Math.min(text.length, start + 1200); const value = text.slice(start, end);
      chunks.push({ id: `${id}:${n}`, text: value, start, end, hash: hash(value), embedding: embed(value) });
    }
    const record: FileRecord = { id, organization_id: parsed.data.organization_id, project_id: parsed.data.project_id, name: parsed.data.name, mime_type: parsed.data.mime_type, size: bytes.length, content_hash: hash(parsed.data.content_base64), status, chunks, created_at: new Date().toISOString() };
    await mkdir(blobs, { recursive: true }); await writeFile(join(blobs, id), bytes, { mode: 0o600 }); const rows = await read(); rows.push(record); await write(rows); return reply.code(201).send(record);
  });
  app.get('/api/knowledge/search', async (req) => {
    const q = z.object({ organization_id: z.string().min(1), project_id: z.string().min(1), query: z.string().min(1).max(1000), limit: z.coerce.number().int().min(1).max(50).default(10) }).parse(req.query);
    const terms = q.query.toLowerCase().split(/\s+/).filter(Boolean); const queryEmbedding = embed(q.query);
    return (await read()).filter((item) => item.organization_id === q.organization_id && item.project_id === q.project_id && item.status === 'ready').flatMap((item) => item.chunks.map((chunk) => ({ file_id: item.id, file_name: item.name, chunk_id: chunk.id, text: chunk.text, start: chunk.start, end: chunk.end, score: cosine(queryEmbedding, chunk.embedding ?? embed(chunk.text)), lexical_score: terms.filter((term) => chunk.text.toLowerCase().includes(term)).length })).filter((hit) => hit.score > 0 || hit.lexical_score > 0)).sort((a, b) => (b.score + b.lexical_score * 0.05) - (a.score + a.lexical_score * 0.05)).slice(0, q.limit);
  });
  app.get<{ Params: { id: string } }>('/api/knowledge/files/:id/content', async (req, reply) => { const record = (await read()).find((item) => item.id === req.params.id); if (!record) return reply.code(404).send({ error: { code: 'file_not_found' } }); const bytes = await readFile(join(blobs, record.id)); return reply.type(record.mime_type).send(bytes); });
  app.delete<{ Params: { id: string } }>('/api/knowledge/files/:id', async (req, reply) => { const rows = await read(); const index = rows.findIndex((item) => item.id === req.params.id); if (index < 0) return reply.code(404).send({ error: { code: 'file_not_found' } }); rows.splice(index, 1); await write(rows); return { deleted: true, id: req.params.id }; });
}
