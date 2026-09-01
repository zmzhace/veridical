import type { FastifyInstance } from 'fastify';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const Status = z.enum(['draft', 'approved', 'deprecated', 'revoked']);
const ToolArtifact = z.object({
  id: z.string().min(1).optional(),
  name: z.string().min(1).max(120),
  version: z.string().min(1).default('1.0.0'),
  source: z.enum(['builtin', 'mcp', 'custom']).default('custom'),
  description: z.string().max(1000).default(''),
  input_schema: z.unknown().default({ type: 'object' }),
  output_schema: z.unknown().default({}),
  side_effect: z.enum(['none', 'read', 'write', 'destructive']).default('none'),
  network_scope: z.array(z.string()).default([]),
  data_classification: z.array(z.string()).default([]),
  timeout_ms: z.number().int().min(100).max(300_000).default(30_000),
  credential_refs: z.array(z.string()).default([]),
  implementation_hash: z.string().optional(),
  status: Status.default('draft'),
});

const McpServer = z
  .object({
    id: z.string().min(1).optional(),
    name: z.string().min(1).max(120),
    transport: z.enum(['streamable-http', 'stdio']),
    url: z.string().url().optional(),
    command: z.string().min(1).optional(),
    args: z.array(z.string()).default([]),
    credential_ref: z.string().optional(),
    status: Status.default('draft'),
    enabled: z.boolean().default(true),
    discovered_tools: z.array(ToolArtifact).default([]),
    discovered_resources: z
      .array(
        z.object({
          uri: z.string(),
          name: z.string().optional(),
          description: z.string().optional(),
        }),
      )
      .default([]),
    discovered_prompts: z
      .array(z.object({ name: z.string(), description: z.string().optional() }))
      .default([]),
    server_version: z.object({ name: z.string(), version: z.string() }).optional(),
    capabilities: z.unknown().optional(),
    schema_hash: z.string().optional(),
    last_error: z.string().optional(),
    last_checked_at: z.string().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.transport === 'streamable-http' && !value.url)
      ctx.addIssue({ code: 'custom', path: ['url'], message: 'HTTP MCP 需要 URL' });
    if (value.transport === 'stdio' && !value.command)
      ctx.addIssue({ code: 'custom', path: ['command'], message: 'stdio MCP 需要 command' });
  });

type ToolRow = z.infer<typeof ToolArtifact> & { id: string; implementation_hash: string };
type McpRow = z.infer<typeof McpServer> & { id: string };
interface CatalogData {
  tools: ToolRow[];
  mcp_servers: McpRow[];
}

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
};
const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const safeId = (name: string) =>
  name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_.-]+/g, '-') || randomUUID();

class CapabilityCatalog {
  private file: string;
  private queue = Promise.resolve();
  constructor(dir: string) {
    this.file = join(dir, 'capabilities.json');
  }
  async read(): Promise<CatalogData> {
    try {
      return JSON.parse(await readFile(this.file, 'utf8')) as CatalogData;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return {
        tools: [
          {
            id: 'finish',
            name: 'finish',
            version: '1.0.0',
            source: 'builtin',
            description: '提交最终结果',
            input_schema: { type: 'object' },
            output_schema: {},
            side_effect: 'none',
            network_scope: [],
            data_classification: [],
            timeout_ms: 30_000,
            credential_refs: [],
            implementation_hash: hash('builtin:finish@1.0.0'),
            status: 'approved',
          },
          {
            id: 'echo',
            name: 'echo',
            version: '1.0.0',
            source: 'builtin',
            description: '本地测试回声工具',
            input_schema: { type: 'object' },
            output_schema: {},
            side_effect: 'none',
            network_scope: [],
            data_classification: [],
            timeout_ms: 30_000,
            credential_refs: [],
            implementation_hash: hash('builtin:echo@1.0.0'),
            status: 'approved',
          },
          {
            id: 'list',
            name: 'list',
            version: '1.0.0',
            source: 'builtin',
            description: '列出工作区文件',
            input_schema: { type: 'object' },
            output_schema: {},
            side_effect: 'read',
            network_scope: [],
            data_classification: [],
            timeout_ms: 30_000,
            credential_refs: [],
            implementation_hash: hash('builtin:list@1.0.0'),
            status: 'approved',
          },
          {
            id: 'glob',
            name: 'glob',
            version: '1.0.0',
            source: 'builtin',
            description: '按模式查找文件',
            input_schema: { type: 'object' },
            output_schema: {},
            side_effect: 'read',
            network_scope: [],
            data_classification: [],
            timeout_ms: 30_000,
            credential_refs: [],
            implementation_hash: hash('builtin:glob@1.0.0'),
            status: 'approved',
          },
          {
            id: 'read',
            name: 'read',
            version: '1.0.0',
            source: 'builtin',
            description: '读取工作区文件',
            input_schema: { type: 'object' },
            output_schema: {},
            side_effect: 'read',
            network_scope: [],
            data_classification: [],
            timeout_ms: 30_000,
            credential_refs: [],
            implementation_hash: hash('builtin:read@1.0.0'),
            status: 'approved',
          },
          {
            id: 'grep',
            name: 'grep',
            version: '1.0.0',
            source: 'builtin',
            description: '搜索文件内容',
            input_schema: { type: 'object' },
            output_schema: {},
            side_effect: 'read',
            network_scope: [],
            data_classification: [],
            timeout_ms: 30_000,
            credential_refs: [],
            implementation_hash: hash('builtin:grep@1.0.0'),
            status: 'approved',
          },
          {
            id: 'write',
            name: 'write',
            version: '1.0.0',
            source: 'builtin',
            description: '写入工作区文件',
            input_schema: { type: 'object' },
            output_schema: {},
            side_effect: 'write',
            network_scope: [],
            data_classification: [],
            timeout_ms: 30_000,
            credential_refs: [],
            implementation_hash: hash('builtin:write@1.0.0'),
            status: 'approved',
          },
          {
            id: 'edit',
            name: 'edit',
            version: '1.0.0',
            source: 'builtin',
            description: '精确编辑文件',
            input_schema: { type: 'object' },
            output_schema: {},
            side_effect: 'write',
            network_scope: [],
            data_classification: [],
            timeout_ms: 30_000,
            credential_refs: [],
            implementation_hash: hash('builtin:edit@1.0.0'),
            status: 'approved',
          },
          {
            id: 'multi_edit',
            name: 'multi_edit',
            version: '1.0.0',
            source: 'builtin',
            description: '批量编辑文件',
            input_schema: { type: 'object' },
            output_schema: {},
            side_effect: 'write',
            network_scope: [],
            data_classification: [],
            timeout_ms: 30_000,
            credential_refs: [],
            implementation_hash: hash('builtin:multi_edit@1.0.0'),
            status: 'approved',
          },
        ],
        mcp_servers: [],
      };
    }
  }
  async mutate<T>(fn: (data: CatalogData) => T | Promise<T>): Promise<T> {
    const result = this.queue.then(async () => {
      const data = await this.read();
      const output = await fn(data);
      await mkdir(dirname(this.file), { recursive: true });
      const temp = `${this.file}.${randomUUID()}.tmp`;
      await writeFile(temp, JSON.stringify(data, null, 2), { mode: 0o600 });
      await rename(temp, this.file);
      return output;
    });
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

async function discoverMcp(server: McpRow) {
  const client = new Client({ name: 'veridical', version: '0.1.0' }, { capabilities: {} });
  const credential = server.credential_ref ? process.env[server.credential_ref] : undefined;
  const requestInit = credential
    ? { requestInit: { headers: { Authorization: `Bearer ${credential}` } } }
    : undefined;
  const transport =
    server.transport === 'streamable-http'
      ? new StreamableHTTPClientTransport(new URL(server.url!), requestInit)
      : new StdioClientTransport({ command: server.command!, args: server.args, stderr: 'pipe' });
  try {
    await client.connect(transport);
    const capabilities = client.getServerCapabilities();
    const [toolResult, resourceResult, promptResult] = await Promise.all([
      capabilities?.tools ? client.listTools() : Promise.resolve({ tools: [] }),
      capabilities?.resources ? client.listResources() : Promise.resolve({ resources: [] }),
      capabilities?.prompts ? client.listPrompts() : Promise.resolve({ prompts: [] }),
    ]);
    const tools: ToolRow[] = toolResult.tools.map((tool) => ({
      id: `${server.id}.${tool.name}`,
      name: `${server.id}.${tool.name}`,
      version: '1.0.0',
      source: 'mcp',
      description: tool.description ?? '',
      input_schema: tool.inputSchema ?? { type: 'object' },
      output_schema: tool.outputSchema ?? {},
      side_effect: 'read',
      network_scope:
        server.transport === 'streamable-http' && server.url ? [new URL(server.url).host] : [],
      data_classification: [],
      timeout_ms: 30_000,
      credential_refs: server.credential_ref ? [server.credential_ref] : [],
      implementation_hash: hash({ server: server.id, tool }),
      status: 'draft',
    }));
    return {
      tools,
      resources: resourceResult.resources.map((resource) => ({
        uri: resource.uri,
        name: resource.name,
        description: resource.description,
      })),
      prompts: promptResult.prompts.map((prompt) => ({
        name: prompt.name,
        description: prompt.description,
      })),
      capabilities,
      serverVersion: client.getServerVersion(),
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}

export async function registerCapabilityRoutes(app: FastifyInstance, dataDir: string) {
  const catalog = new CapabilityCatalog(dataDir);
  app.get('/api/tools', async () => (await catalog.read()).tools);
  app.post('/api/tools', async (req, reply) => {
    const parsed = ToolArtifact.safeParse(req.body);
    if (!parsed.success)
      return reply
        .code(400)
        .send({ error: { code: 'invalid_tool', details: parsed.error.issues } });
    const row = await catalog.mutate((data) => {
      const id = parsed.data.id ?? safeId(parsed.data.name);
      if (data.tools.some((tool) => tool.id === id)) return null;
      const row: ToolRow = {
        ...parsed.data,
        id,
        implementation_hash: parsed.data.implementation_hash ?? hash(parsed.data),
      };
      data.tools.push(row);
      return row;
    });
    return row
      ? reply.code(201).send(row)
      : reply.code(409).send({ error: { code: 'tool_exists' } });
  });
  app.get('/api/mcp/servers', async () => (await catalog.read()).mcp_servers);
  app.post('/api/mcp/servers', async (req, reply) => {
    const parsed = McpServer.safeParse(req.body);
    if (!parsed.success)
      return reply
        .code(400)
        .send({ error: { code: 'invalid_mcp_server', details: parsed.error.issues } });
    const row = await catalog.mutate((data) => {
      const id = parsed.data.id ?? safeId(parsed.data.name);
      if (data.mcp_servers.some((server) => server.id === id)) return null;
      const row: McpRow = { ...parsed.data, id };
      data.mcp_servers.push(row);
      return row;
    });
    return row
      ? reply.code(201).send(row)
      : reply.code(409).send({ error: { code: 'mcp_server_exists' } });
  });
  app.post<{ Params: { id: string } }>('/api/mcp/servers/:id/discover', async (req, reply) => {
    const result = await catalog.mutate(async (data) => {
      const server = data.mcp_servers.find((item) => item.id === req.params.id);
      if (!server) return { kind: 'missing' as const };
      try {
        const discovery = await discoverMcp(server);
        server.discovered_tools = discovery.tools;
        server.discovered_resources = discovery.resources;
        server.discovered_prompts = discovery.prompts;
        server.capabilities = discovery.capabilities;
        server.server_version = discovery.serverVersion;
        server.schema_hash = hash({
          tools: discovery.tools,
          resources: discovery.resources,
          prompts: discovery.prompts,
          server: discovery.serverVersion,
        });
        server.last_checked_at = new Date().toISOString();
        server.last_error = undefined;
        return { kind: 'ok' as const, server };
      } catch (error) {
        server.last_checked_at = new Date().toISOString();
        server.last_error = error instanceof Error ? error.message : String(error);
        return { kind: 'error' as const, message: server.last_error };
      }
    });
    if (result.kind === 'missing')
      return reply.code(404).send({ error: { code: 'mcp_server_not_found' } });
    if (result.kind === 'error')
      return reply
        .code(502)
        .send({ error: { code: 'mcp_discovery_failed', message: result.message } });
    return result.server;
  });
}
