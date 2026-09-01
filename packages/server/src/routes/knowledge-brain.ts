import type { FastifyInstance } from 'fastify';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { GBrainMcpAdapter, NativeKnowledgeAdapter } from '@veridical/knowledge';
import { compileWikiCandidates, sha256 } from '@veridical/knowledge';

type BackendRecord = {
  id: string;
  name: string;
  type: 'native' | 'gbrain' | 'hybrid';
  status: 'unconfigured' | 'draft' | 'approved' | 'revoked';
  transport?: 'stdio' | 'streamable-http';
  server_ref?: string;
  schema_hash?: string;
  scope: 'project' | 'organization';
};

const BackendInput = z.object({
  id: z.string().min(1).max(120).optional(),
  name: z.string().min(1).max(120),
  type: z.enum(['native', 'gbrain', 'hybrid']),
  transport: z.enum(['stdio', 'streamable-http']).optional(),
  server_ref: z.string().max(240).optional(),
  schema_hash: z.string().regex(/^[a-f0-9]{16,128}$/).optional(),
  scope: z.enum(['project', 'organization']).default('project'),
  status: z.enum(['unconfigured', 'draft', 'approved', 'revoked']).default('draft'),
});

const SearchInput = z.object({
  backend_id: z.string().default('native'),
  organization_id: z.string().min(1),
  project_id: z.string().min(1),
  query: z.string().min(1).max(2000),
  limit: z.number().int().min(1).max(50).default(10),
});

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try { return JSON.parse(await readFile(file, 'utf8')) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return fallback; }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  await rename(temporary, file);
}

async function nativeAdapter(dataDir: string): Promise<NativeKnowledgeAdapter> {
  const files = await readJson<any[]>(join(dataDir, 'knowledge-files.json'), []);
  const documents = files.flatMap((file) => [{
    id: file.id,
    organization_id: file.organization_id,
    project_id: file.project_id,
    title: file.name,
    text: Array.isArray(file.chunks) ? file.chunks.map((chunk: any) => chunk.text).join('\n') : '',
    source: { source_type: 'file' as const, source_id: file.id, excerpt_hash: sha256(file.name), content_hash: String(file.content_hash ?? sha256(file)) },
  }]);
  return new NativeKnowledgeAdapter(documents);
}

type McpServerRecord = { id: string; transport: 'stdio' | 'streamable-http'; url?: string; command?: string; args?: string[]; credential_ref?: string; enabled?: boolean };

async function mcpInvoker(dataDir: string, serverRef: string) {
  const catalog = await readJson<{ mcp_servers?: McpServerRecord[] }>(join(dataDir, 'capabilities.json'), { mcp_servers: [] });
  const server = (catalog.mcp_servers ?? []).find((item) => item.id === serverRef);
  if (!server || server.enabled === false) throw new Error('gbrain_mcp_server_not_configured');
  return {
    call: async <T>(operation: string, args: unknown): Promise<T> => {
      const client = new Client({ name: 'veridical-gbrain', version: '0.1.0' }, { capabilities: {} });
      const credential = server.credential_ref ? process.env[server.credential_ref] : undefined;
      const requestInit = credential ? { requestInit: { headers: { Authorization: `Bearer ${credential}` } } } : undefined;
      const transport = server.transport === 'streamable-http'
        ? new StreamableHTTPClientTransport(new URL(server.url!), requestInit)
        : new StdioClientTransport({ command: server.command!, args: server.args ?? [], stderr: 'pipe' });
      try {
        await client.connect(transport);
        const method = operation.split('.').at(-1)!;
        const result: any = await client.callTool({ name: method, arguments: (args ?? {}) as Record<string, unknown> });
        if (result?.structuredContent !== undefined) return result.structuredContent as T;
        const text = result?.content?.find((item: any) => item?.type === 'text')?.text;
        if (typeof text === 'string') {
          try { return JSON.parse(text) as T; } catch { return text as T; }
        }
        return result as T;
      } finally {
        await client.close().catch(() => undefined);
      }
    },
  };
}

export async function registerKnowledgeBrainRoutes(app: FastifyInstance, dataDir: string) {
  const backendFile = join(dataDir, 'knowledge-backends.json');
  const wikiFile = join(dataDir, 'wiki-candidates.json');
  app.get('/api/knowledge/backends', async () => {
    const configured = await readJson<BackendRecord[]>(backendFile, []);
    return [{ id: 'native', name: 'Veridical Knowledge', type: 'native', status: 'approved', scope: 'project' }, ...configured.filter((item) => item.id !== 'native')];
  });

  app.post('/api/knowledge/backends', async (request, reply) => {
    const parsed = BackendInput.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'invalid_knowledge_backend', details: parsed.error.issues } });
    const records = await readJson<BackendRecord[]>(backendFile, []);
    const id = parsed.data.id ?? (parsed.data.name.toLowerCase().replace(/[^a-z0-9_.-]+/g, '-') || randomUUID());
    if (id === 'native' || records.some((item) => item.id === id)) return reply.code(409).send({ error: { code: 'knowledge_backend_exists' } });
    const record = { ...parsed.data, id } as BackendRecord;
    records.push(record);
    await writeJson(backendFile, records);
    return reply.code(201).send(record);
  });

  app.post<{ Params: { id: string } }>('/api/knowledge/backends/:id/test', async (request, reply) => {
    const id = request.params.id;
    if (id === 'native') return { id, ok: true, degraded: false, message: 'Native Knowledge 可用' };
    const backend = (await readJson<BackendRecord[]>(backendFile, [])).find((item) => item.id === id);
    if (!backend) return reply.code(404).send({ error: { code: 'knowledge_backend_not_found' } });
    try {
      const adapter = new GBrainMcpAdapter(await mcpInvoker(dataDir, backend.server_ref ?? id), id);
      return { id, ...(await adapter.health()), message: 'GBrain MCP 连接可用' };
    } catch (error) {
      return { id, ok: false, degraded: true, message: error instanceof Error ? error.message : String(error) };
    }
  });

  app.post('/api/knowledge/search', async (request, reply) => {
    const parsed = SearchInput.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'invalid_knowledge_search', details: parsed.error.issues } });
    if (parsed.data.backend_id === 'native') return nativeAdapter(dataDir).then((adapter) => adapter.search(parsed.data));
    const backend = (await readJson<BackendRecord[]>(backendFile, [])).find((item) => item.id === parsed.data.backend_id);
    if (!backend || backend.type !== 'gbrain' || backend.status !== 'approved') return reply.code(503).send({ error: { code: 'knowledge_backend_unavailable', message: '该知识 Backend 尚未审批或连接' } });
    return new GBrainMcpAdapter(await mcpInvoker(dataDir, backend.server_ref ?? backend.id), backend.id).search(parsed.data);
  });

  app.post('/api/knowledge/synthesize', async (request, reply) => {
    const parsed = SearchInput.extend({ intent: z.string().max(500).optional() }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'invalid_knowledge_synthesis', details: parsed.error.issues } });
    if (parsed.data.backend_id === 'native') return nativeAdapter(dataDir).then((adapter) => adapter.synthesize(parsed.data));
    const backend = (await readJson<BackendRecord[]>(backendFile, [])).find((item) => item.id === parsed.data.backend_id);
    if (!backend || backend.type !== 'gbrain' || backend.status !== 'approved') return reply.code(503).send({ error: { code: 'knowledge_backend_unavailable', message: '该知识 Backend 尚未审批或连接' } });
    return new GBrainMcpAdapter(await mcpInvoker(dataDir, backend.server_ref ?? backend.id), backend.id).synthesize(parsed.data);
  });

  app.post<{ Params: { projectId: string } }>('/api/projects/:projectId/wiki/compile', async (request, reply) => {
    const parsed = z.object({ organization_id: z.string().min(1), run_id: z.string().min(1), events: z.array(z.record(z.unknown())).max(100_000) }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'invalid_wiki_compile', details: parsed.error.issues } });
    const result = compileWikiCandidates({ organization_id: parsed.data.organization_id, project_id: request.params.projectId, run_id: parsed.data.run_id, events: parsed.data.events as any });
    const existing = await readJson<any[]>(wikiFile, []);
    const next = [...existing.filter((item) => item.idempotency_key !== result.idempotency_key), result];
    await writeJson(wikiFile, next);
    return reply.code(202).send(result);
  });

  app.get<{ Params: { projectId: string } }>('/api/projects/:projectId/wiki/pages', async (request) => {
    const rows = await readJson<any[]>(wikiFile, []);
    return rows.filter((row) => row.pages?.[0]?.project_id === request.params.projectId).flatMap((row) => row.pages ?? []);
  });
}
