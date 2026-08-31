import type { FastifyInstance } from 'fastify';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { createReleaseArtifact, parseSpecYaml, type AgentSpec } from '@veridical/spec';

const AgentInput = z.object({
  name: z.string().min(1).max(80),
  description: z.string().min(1).max(500),
  model: z.string().min(1).max(160).default('server-default'),
});
const DraftInput = z.object({ graph: z.unknown(), yaml: z.string().optional() });
const PublishInput = z.object({ yaml: z.string().min(1), graph: z.unknown().optional() });

interface AgentRow {
  id: string;
  name: string;
  description: string;
  model: string;
  status: 'draft' | 'published' | 'archived';
  version?: string;
  created_at: string;
  updated_at: string;
  instructions?: string;
  mock?: boolean;
  capabilities?: ReturnType<typeof specCapabilities>;
  draft?: { graph: unknown; yaml?: string; revision: number };
}

function specCapabilities(spec: AgentSpec) {
  return {
    model: { provider: spec.llm.provider, name: spec.llm.model },
    tools: spec.tools.map((tool) => ({ name: tool.name, access: tool.access })),
    skills: spec.skills.map((skill) => ({ name: skill.name, version: skill.version, status: skill.status })),
    memory: { enabled: true, scopes: ['task'] },
    knowledge_bases: [] as string[],
    mcp_servers: [...new Set(spec.tools.map((tool) => tool.name.split('.')[0]).filter((name) => name && !['echo', 'finish'].includes(name)))],
    child_agents: spec.agents.map((agent) => agent.name),
  };
}

function importedAgent(spec: AgentSpec): AgentRow {
  return {
    id: spec.name,
    name: spec.name,
    description: spec.description ?? '',
    instructions: spec.instruction.system,
    model: spec.llm.model,
    status: 'published',
    version: spec.version,
    mock: spec.llm.provider === 'mock' || spec.llm.model.startsWith('mock'),
    capabilities: specCapabilities(spec),
    created_at: '',
    updated_at: '',
  };
}

class AgentCatalog {
  private readonly file: string;
  private queue = Promise.resolve();
  constructor(private readonly dir: string) {
    this.file = join(dir, 'agents.json');
  }
  async read(): Promise<AgentRow[]> {
    try {
      return JSON.parse(await readFile(this.file, 'utf8')) as AgentRow[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }
  async write(rows: AgentRow[]) {
    await mkdir(this.dir, { recursive: true });
    const temp = `${this.file}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(rows, null, 2), { mode: 0o600 });
    await rename(temp, this.file);
  }
  mutate<T>(fn: (rows: AgentRow[]) => Promise<T> | T): Promise<T> {
    const result = this.queue.then(async () => {
      const rows = await this.read();
      const out = await fn(rows);
      await this.write(rows);
      return out;
    });
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function slug(value: string) {
  const normalized = value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-|-$/g, '');
  return normalized || `agent-${randomUUID().slice(0, 8)}`;
}

export async function registerAgentRoutes(app: FastifyInstance, dataDir: string) {
  const catalog = new AgentCatalog(dataDir);
  async function validateCapabilities(spec: AgentSpec) {
    let tools: Array<{ name: string; status?: string }> = [];
    let skills: Array<{ name: string; version: string; status?: string }> = [];
    try { tools = JSON.parse(await readFile(join(dataDir, 'capabilities.json'), 'utf8')).tools ?? []; } catch { /* empty registry is valid for no-tool agents */ }
    tools = [...tools, ...['echo', 'finish'].map((name) => ({ name, status: 'approved' }))];
    try { skills = JSON.parse(await readFile(join(dataDir, 'skills.json'), 'utf8')); } catch { /* empty registry is valid for no-skill agents */ }
    const invalidTools = spec.tools.filter((entry) => !tools.some((tool) => tool.name === entry.name && tool.status === 'approved'));
    if (invalidTools.length) throw new Error(`unapproved or unregistered tools: ${invalidTools.map((tool) => tool.name).join(', ')}`);
    const invalidSkills = spec.skills.filter((entry) => !skills.some((skill) => skill.name === entry.name && skill.version === entry.version && skill.status === 'approved'));
    if (invalidSkills.length) throw new Error(`unapproved or unregistered skills: ${invalidSkills.map((skill) => `${skill.name}@${skill.version}`).join(', ')}`);
  }
  async function makeRelease(spec: AgentSpec) {
    let registered: Array<Record<string, any>> = [];
    try { registered = JSON.parse(await readFile(join(dataDir, 'capabilities.json'), 'utf8')).tools ?? []; } catch { /* builtins below */ }
    const tools = spec.tools.map((entry) => {
      const found = registered.find((tool) => tool.name === entry.name) ?? { name: entry.name, version: '1.0.0', side_effect: 'none', input_schema: { type: 'object' }, output_schema: {}, implementation_hash: `builtin:${entry.name}` };
      return { name: entry.name, version: String(found.version ?? '1.0.0'), input_schema: found.input_schema, output_schema: found.output_schema, side_effect: found.side_effect ?? 'none' };
    });
    return createReleaseArtifact({ kind: 'release', name: spec.name, version: spec.version, status: 'approved', spec, skills: spec.skills, tools, model: { provider: spec.llm.provider, model: spec.llm.model } });
  }

  app.get('/api/agents', async () => {
    const specs = await app.specRegistry.list();
    return catalog.mutate((rows) => {
      for (const spec of specs) {
        const existing = rows.find((row) => row.id === spec.name);
        if (existing) {
          // Rows imported by older builds used description as display name and instructions as description.
          if (!existing.created_at) Object.assign(existing, importedAgent(spec));
          if (
            existing.status !== 'archived' &&
            (!existing.version || existing.version < spec.version)
          ) {
            existing.version = spec.version;
            existing.status = 'published';
          }
          continue;
        }
        rows.push(importedAgent(spec));
      }
      return rows.filter((row) => row.status !== 'archived');
    });
  });

  app.post('/api/agents', async (req, reply) => {
    const parsed = AgentInput.safeParse(req.body);
    if (!parsed.success)
      return reply
        .code(400)
        .send({ error: { code: 'invalid_agent', message: parsed.error.issues[0]?.message } });
    return catalog.mutate((rows) => {
      let id = slug(parsed.data.name);
      let suffix = 2;
      while (rows.some((row) => row.id === id)) id = `${slug(parsed.data.name)}-${suffix++}`;
      const now = new Date().toISOString();
      const row: AgentRow = {
        id,
        ...parsed.data,
        status: 'draft',
        created_at: now,
        updated_at: now,
      };
      rows.push(row);
      return reply.code(201).send(row);
    });
  });

  app.get<{ Params: { id: string } }>('/api/agents/:id', async (req, reply) => {
    const row = (await catalog.read()).find((item) => item.id === req.params.id);
    if (row) return row;
    const spec = await app.specRegistry.resolve(req.params.id);
    if (!spec)
      return reply.code(404).send({ error: { code: 'not_found', message: 'Agent 不存在' } });
    return importedAgent(spec);
  });

  app.patch<{ Params: { id: string } }>('/api/agents/:id', async (req, reply) => {
    const patch = AgentInput.partial()
      .extend({ status: z.enum(['draft', 'published', 'archived']).optional() })
      .safeParse(req.body);
    if (!patch.success) return reply.code(400).send({ error: { code: 'invalid_agent' } });
    return catalog.mutate((rows) => {
      const row = rows.find((item) => item.id === req.params.id);
      if (!row) return reply.code(404).send({ error: { code: 'not_found' } });
      Object.assign(row, patch.data, { updated_at: new Date().toISOString() });
      return row;
    });
  });

  app.post<{ Params: { id: string } }>('/api/agents/:id/duplicate', async (req, reply) =>
    catalog.mutate((rows) => {
      const source = rows.find((item) => item.id === req.params.id);
      if (!source) return reply.code(404).send({ error: { code: 'not_found' } });
      let id = `${source.id}-copy`;
      let suffix = 2;
      while (rows.some((item) => item.id === id)) id = `${source.id}-copy-${suffix++}`;
      const now = new Date().toISOString();
      const copy: AgentRow = {
        ...structuredClone(source),
        id,
        name: `${source.name} 副本`,
        status: 'draft',
        version: undefined,
        created_at: now,
        updated_at: now,
      };
      rows.push(copy);
      return reply.code(201).send(copy);
    }),
  );

  app.get<{ Params: { id: string } }>('/api/agents/:id/draft', async (req, reply) => {
    const row = (await catalog.read()).find((item) => item.id === req.params.id);
    if (!row) return reply.code(404).send({ error: { code: 'not_found' } });
    return row.draft ?? { graph: null, revision: 0 };
  });

  app.put<{ Params: { id: string } }>('/api/agents/:id/draft', async (req, reply) => {
    const parsed = DraftInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'invalid_draft' } });
    return catalog.mutate((rows) => {
      const row = rows.find((item) => item.id === req.params.id);
      if (!row) return reply.code(404).send({ error: { code: 'not_found' } });
      row.draft = {
        graph: parsed.data.graph ?? null,
        yaml: parsed.data.yaml,
        revision: (row.draft?.revision ?? 0) + 1,
      };
      row.updated_at = new Date().toISOString();
      return row.draft;
    });
  });

  app.post<{ Params: { id: string } }>('/api/agents/:id/publish', async (req, reply) => {
    const parsed = PublishInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'invalid_release' } });
    try {
      const spec = parseSpecYaml(parsed.data.yaml);
      if (spec.name !== req.params.id)
        return reply
          .code(409)
          .send({
            error: { code: 'agent_spec_mismatch', message: '规格名称必须与 Agent ID 一致' },
          });
      await validateCapabilities(spec);
      const release = await makeRelease(spec);
      await app.specRegistry.register(spec);
      return catalog.mutate((rows) => {
        const row = rows.find((item) => item.id === req.params.id);
        if (!row) return reply.code(404).send({ error: { code: 'not_found' } });
        row.status = 'published';
        row.version = spec.version;
        row.model = spec.llm.model;
        row.description = spec.description ?? row.description;
        row.instructions = spec.instruction.system;
        row.mock = spec.llm.provider === 'mock' || spec.llm.model.startsWith('mock');
        row.capabilities = specCapabilities(spec);
        row.draft = {
          graph: parsed.data.graph ?? row.draft?.graph ?? null,
          yaml: parsed.data.yaml,
          revision: (row.draft?.revision ?? 0) + 1,
        };
        row.updated_at = new Date().toISOString();
        return {
          agent: row,
          release: {
            id: `${spec.name}@${spec.version}`,
            spec_hash: release.content_hash,
            approved: true,
            artifact: release,
          },
        };
      });
    } catch (error) {
      return reply
        .code(409)
        .send({
          error: {
            code: 'publish_failed',
            message: error instanceof Error ? error.message : String(error),
          },
        });
    }
  });
}
