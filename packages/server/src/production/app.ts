import Fastify from 'fastify';
import { timingSafeEqual, randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import type { LLMProvider } from '@veridical/llm';
import { Ledger } from './database';
import {
  Fault,
  Key,
  digest,
  requireRole,
  tokenDigest,
  type Principal,
  type Job,
} from './contracts';
import { assertProductionStorage, ProductionConfigSchema, type ProductionConfig } from './config';
import { ProductionService } from './service';
import { SecureProvider, safeTools, type ProductionTool } from './runner';
import { BUILD_ID } from './build';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { resolveCredential } from './credentials';
import { PostgresJobStore, type AsyncJobStore, type JobStore } from './job-store';
import { RedisJobQueue } from './redis-queue';
import { buildLedger, buildObjectStore } from './storage';
import { exportGRPO, projectTrajectory, trajectoryJsonl } from '@veridical/replay';
import { createMcpProductionTool, executeMcpTool, type McpRuntimeConfig } from './mcp-runtime';
import type { KnowledgePort } from '@veridical/knowledge';
import { GBrainMcpAdapter } from '@veridical/knowledge';

/** Create a KnowledgePort from reviewed, fixed MCP tool bindings. */
export function createMcpKnowledgeAdapter(serverRef: string, bindings: McpRuntimeConfig[]) {
  const serverBindings = bindings.filter((binding) => binding.id === serverRef);
  return new GBrainMcpAdapter(
    {
      call: async <T>(operation: string, args: Record<string, unknown>) => {
        const toolName = operation.split('.').at(-1)!;
        const binding = serverBindings.find((candidate) => candidate.toolName === toolName);
        if (!binding)
          throw new Fault(503, 'knowledge_mcp_tool_not_bound', `${serverRef}/${toolName}`);
        return (await executeMcpTool(binding, args)) as T;
      },
    },
    serverRef,
  );
}

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal;
  }
}
const Page = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(100000).default(0),
});
const Ref = z
  .string()
  .min(3)
  .max(260)
  .regex(/^[a-zA-Z0-9_.-]+@[a-zA-Z0-9.+-]+$/);
const Reason = z.string().trim().min(5).max(2000);
const jobView = (j: Job) => ({
  id: j.id,
  session: j.session,
  kind: j.kind,
  state: j.state,
  created: j.created,
  result: j.result,
});

export async function buildProductionApp(options: {
  config: ProductionConfig;
  dataKey: Buffer;
  auditKey: Buffer;
  providers?: Map<string, LLMProvider>;
  tools?: ProductionTool[];
  mcpTools?: McpRuntimeConfig[];
  knowledgeBackends?: Map<string, KnowledgePort>;
  objectStore?: import('./object-store').S3ObjectStore;
  jobs?: JobStore;
  asyncJobs?: AsyncJobStore;
  worker?: boolean;
  logger?: boolean;
}) {
  const config = ProductionConfigSchema.parse(options.config);
  if (process.env.VERIDICAL_MODE === 'production') assertProductionStorage(config);
  const managedQueue =
    config.storage.queue === 'redis'
      ? (options.asyncJobs ?? new RedisJobQueue(config.storage.redisUrl!))
      : options.asyncJobs;
  const providers =
    options.providers ??
    new Map(
      await Promise.all(
        config.providers.map(async (p) => {
          const key = p.apiKeyEnv.startsWith('vault:')
            ? await resolveCredential({
                kind: 'vault',
                address: process.env.VERIDICAL_VAULT_ADDR ?? '',
                tokenEnv: process.env.VERIDICAL_VAULT_TOKEN_ENV ?? 'VERIDICAL_VAULT_TOKEN',
                path: p.apiKeyEnv.slice(6).split('#')[0],
                field: p.apiKeyEnv.slice(6).split('#')[1],
              })
            : await resolveCredential({ kind: 'env', name: p.apiKeyEnv });
          return [
            p.name,
            new SecureProvider(p.baseUrl, key, p.model, { enableThinking: p.enableThinking }),
          ] as const;
        }),
      ),
    );
  for (const provider of config.providers)
    if (!providers.has(provider.name)) throw new Error('provider not configured');
  const db: any = await buildLedger(config, options.dataKey, options.auditKey);
  const objectStore = options.objectStore ?? buildObjectStore(config);
  const knowledgeBackends = new Map(options.knowledgeBackends ?? []);
  const fixedMcpBindings = options.mcpTools ?? config.mcpTools;
  const knowledgeSearchTool: ProductionTool = {
    name: 'knowledge_search',
    version: '1.0.0',
    description: '在当前租户授权的知识文件中检索相关片段',
    readOnly: true,
    schema: z.object({
      project_id: Key,
      query: z.string().min(1).max(1000),
      limit: z.number().int().min(1).max(20).default(8),
      backend_id: z.string().min(3).max(160).optional(),
    }),
    execute: async (args, context) => {
      const input = z
        .object({
          project_id: Key,
          query: z.string().min(1).max(1000),
          limit: z.number().int().min(1).max(20).default(8),
          backend_id: z.string().min(3).max(160).optional(),
        })
        .parse(args);
      if (input.backend_id) {
        if (!context.allowedKnowledgeBackends?.includes(input.backend_id))
          throw new Fault(403, 'knowledge_backend_not_bound_to_release', input.backend_id);
        const backend = await db.get(context.tenant, 'knowledge_backend', input.backend_id);
        if (!backend || backend.status !== 'approved')
          throw new Fault(409, 'knowledge_backend_not_approved');
        let adapter = knowledgeBackends.get(input.backend_id);
        if (!adapter && backend.body?.type === 'gbrain' && backend.body.server_ref) {
          const candidate = createMcpKnowledgeAdapter(backend.body.server_ref, fixedMcpBindings);
          if (fixedMcpBindings.some((binding) => binding.id === backend.body.server_ref)) {
            knowledgeBackends.set(input.backend_id, candidate);
            adapter = candidate;
          }
        }
        if (adapter) {
          const result = await adapter.search({
            organization_id: context.tenant,
            project_id: input.project_id,
            query: input.query,
            limit: input.limit,
          });
          return result.hits;
        }
        if (backend.body?.type !== 'native')
          throw new Fault(501, 'knowledge_backend_runtime_unavailable', input.backend_id);
      }
      const terms = input.query.toLowerCase().split(/\s+/).filter(Boolean);
      const files = await db.list(context.tenant, 'knowledge_file', 200, 0);
      return files
        .filter(
          (file: any) => file?.status === 'active' && file.body?.project_id === input.project_id,
        )
        .flatMap((file: any) =>
          (file.body?.chunks ?? []).map((chunk: any) => ({
            file_id: file.key,
            file_name: file.body.name,
            chunk_id: chunk.id,
            text: chunk.text,
            score: terms.filter((term) => chunk.text.toLowerCase().includes(term)).length,
          })),
        )
        .filter((hit: any) => hit.score > 0)
        .sort((a: any, b: any) => b.score - a.score)
        .slice(0, input.limit);
    },
  };
  const durableJobs =
    config.storage.database === 'postgres' ? new PostgresJobStore(db) : options.jobs;
  const registeredTools = [
    ...(options.tools ?? safeTools),
    knowledgeSearchTool,
    ...(options.mcpTools ?? config.mcpTools).map(createMcpProductionTool),
  ];
  const service = new ProductionService(
    db as any,
    config,
    providers,
    registeredTools,
    durableJobs as any,
    managedQueue,
    objectStore,
  );
  const oidcKeys = config.oidc ? createRemoteJWKSet(new URL(config.oidc.jwksUrl)) : undefined;
  const app = Fastify({
    bodyLimit: 20 * 1024 * 1024,
    requestTimeout: 15000,
    connectionTimeout: 20000,
    keepAliveTimeout: 5000,
    trustProxy: false,
    genReqId: () => randomUUID(),
    logger:
      options.logger === false
        ? false
        : {
            level: 'info',
            redact: [
              'req.headers.authorization',
              'req.headers.cookie',
              'req.body',
              'res.headers["set-cookie"]',
            ],
          },
  });
  // All protected handlers run after authentication assigns the principal.
  app.decorateRequest('principal', null as unknown as Principal);
  app.addHook('onRequest', async (req, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('cache-control', 'no-store');
    reply.header('content-security-policy', "default-src 'none'; frame-ancestors 'none'");
    reply.header('x-request-id', req.id);
    if (req.url === '/health/live') return;
    if (!(await (db as any).rate(`ip:${req.ip}`, config.requestsPerMinute * 4)))
      throw new Fault(429, 'rate_limited');
    const auth = req.headers.authorization;
    if (!auth?.startsWith('Bearer ') || auth.length < 39 || auth.length > 512)
      throw new Fault(401, 'authentication_required');
    const rawToken = auth.slice(7);
    const hash = tokenDigest(rawToken);
    const found = config.tokens.find((t) =>
      timingSafeEqual(Buffer.from(t.hash, 'hex'), Buffer.from(hash, 'hex')),
    );
    let principal: Principal | undefined;
    if (found && Date.parse(found.expires) > Date.now() && !(await db.isRevoked(hash))) {
      principal = { tenant: found.tenant, actor: found.actor, roles: found.roles, tokenHash: hash };
    } else if (oidcKeys && config.oidc) {
      try {
        const verified = await jwtVerify(rawToken, oidcKeys, {
          issuer: config.oidc.issuer,
          audience: config.oidc.audience,
        });
        const claims = verified.payload as Record<string, unknown>;
        const tenant = claims[config.oidc.tenantClaim];
        const actor = claims[config.oidc.actorClaim];
        const rawRoles = claims[config.oidc.rolesClaim];
        const roles = (
          Array.isArray(rawRoles)
            ? rawRoles
            : typeof rawRoles === 'string'
              ? rawRoles.split(/[ ,]+/)
              : []
        ).filter(
          (role): role is string =>
            typeof role === 'string' &&
            ['viewer', 'operator', 'developer', 'reviewer', 'publisher', 'admin'].includes(role),
        );
        if (
          typeof tenant !== 'string' ||
          typeof actor !== 'string' ||
          !Key.safeParse(tenant).success ||
          !Key.safeParse(actor).success ||
          !roles.length
        )
          throw new Error('OIDC claims missing tenant, actor or roles');
        principal = { tenant, actor, roles: roles as Principal['roles'], tokenHash: hash };
      } catch {
        throw new Fault(401, 'invalid_credentials');
      }
    } else throw new Fault(401, 'invalid_credentials');
    req.principal = principal;
    if (
      !(await (db as any).rate(
        `actor:${principal.tenant}:${principal.actor}`,
        config.requestsPerMinute,
      ))
    )
      throw new Fault(429, 'rate_limited');
  });
  app.setErrorHandler(async (error, req, reply) => {
    const isValidation = error instanceof z.ZodError;
    const httpStatus =
      error &&
      typeof error === 'object' &&
      'statusCode' in error &&
      typeof error.statusCode === 'number'
        ? error.statusCode
        : 500;
    const status =
      error instanceof Fault
        ? error.status
        : isValidation
          ? 400
          : httpStatus >= 400 && httpStatus < 500
            ? httpStatus
            : 500;
    if (status === 403 && req.principal) {
      try {
        await db.audit(req.principal.tenant, req.principal.actor, 'access.denied', {
          request_id: req.id,
          route: req.routeOptions.url,
          code: error instanceof Fault ? error.code : 'forbidden',
        });
      } catch {
        service.healthy = false;
      }
    }
    if (status >= 500)
      req.log.error(
        {
          requestId: req.id,
          code: 'internal_error',
          error: error instanceof Error ? error.message : String(error),
        },
        'request failed',
      );
    reply.code(status).send({
      error: {
        code:
          error instanceof Fault
            ? error.code
            : isValidation
              ? 'invalid_request'
              : status === 500
                ? 'internal_error'
                : 'request_rejected',
        request_id: req.id,
      },
    });
  });
  app.get('/health/live', async () => ({ ok: true }));
  app.get('/health/ready', async () => {
    if (!service.healthy) throw new Fault(503, 'worker_unhealthy');
    await service.checkCapacity();
    if ('pool' in (db as any)) await (db as any).pool.query('SELECT 1');
    if (managedQueue && 'ping' in (managedQueue as any)) {
      const ok = await (managedQueue as unknown as { ping: () => Promise<boolean> }).ping();
      if (!ok) throw new Fault(503, 'queue_unhealthy');
    }
    if (objectStore) {
      try {
        await objectStore.health();
      } catch {
        throw new Fault(503, 'object_store_unhealthy');
      }
    }
    return {
      ok: true,
      release: config.releaseId,
      build: BUILD_ID,
      storage: config.storage,
      execution: config.storage.queue === 'redis' ? 'redis_async' : 'in_process',
      ledger: config.storage.database,
    };
  });
  app.get('/v1/me', async (req) => ({
    tenant: req.principal.tenant,
    actor: req.principal.actor,
    roles: req.principal.roles,
  }));
  app.get('/v1/capabilities', async (req) => {
    requireRole(req.principal, 'viewer', 'operator', 'developer', 'reviewer', 'publisher');
    const tools = service.tools.map((tool) => ({
      name: tool.name,
      version: tool.version,
      description: tool.description,
      source: 'builtin' as const,
      side_effect: tool.readOnly ? 'read' : 'write',
      approved: tool.readOnly === true,
    }));
    const models = config.providers.map((provider) => ({
      provider: provider.name,
      model: provider.model,
      version: provider.version,
      configured: providers.has(provider.name),
    }));
    const [skillRows, mcpRows, knowledgeRows] = await Promise.all([
      db.list(req.principal.tenant, 'skill', 200, 0),
      db.list(req.principal.tenant, 'mcp_server', 100, 0),
      db.list(req.principal.tenant, 'knowledge_backend', 100, 0),
    ]);
    const skills = skillRows
      .filter((row: any) => row?.status === 'approved')
      .map((row: any) => ({
        id: row.key,
        name: row.body.name,
        version: row.body.version,
        content_hash: row.digest,
      }));
    const mcp_servers = mcpRows
      .filter((row: any) => row?.status === 'approved')
      .map((row: any) => ({
        id: row.key,
        name: row.body.name,
        version: row.body.version,
        transport: row.body.transport,
        schema_hash: row.body.schema_hash,
        artifact_hash: row.digest,
      }));
    const knowledge_backends = knowledgeRows
      .filter((row: any) => row?.status === 'approved')
      .map((row: any) => ({
        id: row.key,
        name: row.body.name,
        version: row.body.version,
        type: row.body.type,
        config_hash: row.body.config_hash,
        artifact_hash: row.digest,
      }));
    await db.audit(req.principal.tenant, req.principal.actor, 'capabilities.read', {
      tools: tools.length,
      models: models.length,
      skills: skills.length,
      mcp_servers: mcp_servers.length,
      knowledge_backends: knowledge_backends.length,
      request_id: req.id,
    });
    return { models, tools, mcp_servers, skills, knowledge_backends };
  });
  const MemoryInput = z
    .object({
      project_id: Key,
      user_id: Key.optional(),
      agent_id: Key.optional(),
      scope: z.enum(['task', 'project', 'user', 'agent']),
      kind: z.enum(['fact', 'preference', 'summary', 'candidate']).default('candidate'),
      content: z.unknown(),
      summary: z.string().max(1000).optional(),
      source_refs: z.array(z.string().max(500)).max(50).default([]),
      confidence: z.number().min(0).max(1).default(1),
      sensitivity: z.enum(['normal', 'sensitive', 'restricted']).default('normal'),
      expires_at: z.string().datetime().optional(),
    })
    .strict();
  app.get('/v1/memories', async (req) => {
    requireRole(req.principal, 'viewer', 'operator', 'developer', 'reviewer');
    const query = z
      .object({
        project_id: Key,
        user_id: Key.optional(),
        scope: z.enum(['task', 'project', 'user', 'agent']).optional(),
      })
      .parse(req.query);
    const now = Date.now();
    const records = await db.list(req.principal.tenant, 'memory', 200, 0);
    const result = records
      .filter(
        (record: any) =>
          record?.status !== 'deleted' &&
          record?.body?.project_id === query.project_id &&
          (!record.body.expires_at || Date.parse(record.body.expires_at) > now) &&
          (!query.user_id || record.body.user_id === query.user_id) &&
          (!query.scope || record.body.scope === query.scope),
      )
      .map((record: any) => ({
        ...record.body,
        id: record.key,
        status: record.status,
        content_hash: record.digest,
      }));
    await db.audit(req.principal.tenant, req.principal.actor, 'memory.list', {
      project_id: query.project_id,
      count: result.length,
      request_id: req.id,
    });
    return result;
  });
  app.post('/v1/memories', async (req, reply) => {
    requireRole(req.principal, 'operator', 'developer', 'reviewer');
    const input = MemoryInput.parse(req.body);
    const id = randomUUID();
    const body = { ...input, created_at: new Date().toISOString() };
    const record = await db.put(
      req.principal.tenant,
      'memory',
      id,
      body,
      req.principal.actor,
      'candidate',
    );
    await db.audit(req.principal.tenant, req.principal.actor, 'memory.candidate_created', {
      memory_id: id,
      project_id: input.project_id,
      sensitivity: input.sensitivity,
      request_id: req.id,
    });
    return reply
      .code(201)
      .send({ ...body, id, status: record.status, content_hash: record.digest });
  });
  app.post('/v1/memories/:id/decision', async (req) => {
    requireRole(req.principal, 'reviewer', 'developer');
    const { id } = z.object({ id: Key }).parse(req.params);
    const decision = z
      .object({ status: z.enum(['active', 'rejected']) })
      .strict()
      .parse(req.body);
    const current = await db.get(req.principal.tenant, 'memory', id);
    if (!current || current.status === 'deleted') throw new Fault(404, 'memory_not_found');
    const updated = await db.transition(
      req.principal.tenant,
      'memory',
      id,
      decision.status,
      { ...current.meta, decided_at: new Date().toISOString() },
      req.principal.actor,
    );
    await db.audit(req.principal.tenant, req.principal.actor, 'memory.decision', {
      memory_id: id,
      status: decision.status,
      request_id: req.id,
    });
    return { ...updated.body, id, status: updated.status, content_hash: updated.digest };
  });
  app.delete('/v1/memories/:id', async (req) => {
    requireRole(req.principal, 'developer', 'reviewer');
    const { id } = z.object({ id: Key }).parse(req.params);
    const current = await db.get(req.principal.tenant, 'memory', id);
    if (!current || current.status === 'deleted') throw new Fault(404, 'memory_not_found');
    await db.transition(
      req.principal.tenant,
      'memory',
      id,
      'deleted',
      { ...current.meta, deleted_at: new Date().toISOString() },
      req.principal.actor,
    );
    await db.audit(req.principal.tenant, req.principal.actor, 'memory.deleted', {
      memory_id: id,
      request_id: req.id,
    });
    return { deleted: true, id };
  });
  const SkillInput = z
    .object({
      name: Key,
      version: z.string().min(1).max(80),
      description: z.string().max(2000).default(''),
      content: z.string().min(1).max(100_000),
      tool_dependencies: z.array(Key).max(100).default([]),
      source: z.string().max(500).default('local'),
    })
    .strict();
  app.get('/v1/skills', async (req) => {
    requireRole(req.principal, 'viewer', 'operator', 'developer', 'reviewer', 'publisher');
    const rows = await db.list(req.principal.tenant, 'skill', 200, 0);
    const result = rows
      .filter((row: any) => row?.status !== 'deleted')
      .map((row: any) => ({
        ...row.body,
        id: row.key,
        status: row.status,
        content_hash: row.digest,
      }));
    await db.audit(req.principal.tenant, req.principal.actor, 'skill.list', {
      count: result.length,
      request_id: req.id,
    });
    return result;
  });
  app.post('/v1/skills', async (req, reply) => {
    requireRole(req.principal, 'developer', 'reviewer');
    const input = SkillInput.parse(req.body);
    const id = `${input.name}@${input.version}`;
    if (await db.get(req.principal.tenant, 'skill', id)) throw new Fault(409, 'skill_exists');
    const record = await db.put(
      req.principal.tenant,
      'skill',
      id,
      input,
      req.principal.actor,
      'draft',
    );
    await db.audit(req.principal.tenant, req.principal.actor, 'skill.created', {
      skill_id: id,
      content_hash: record.digest,
      request_id: req.id,
    });
    return reply
      .code(201)
      .send({ ...input, id, status: record.status, content_hash: record.digest });
  });
  app.post('/v1/skills/:id/decision', async (req) => {
    requireRole(req.principal, 'reviewer', 'publisher');
    const { id } = z.object({ id: z.string().min(3).max(160) }).parse(req.params);
    const decision = z
      .object({ status: z.enum(['approved', 'deprecated', 'revoked']) })
      .strict()
      .parse(req.body);
    const current = await db.get(req.principal.tenant, 'skill', id);
    if (!current || current.status === 'deleted') throw new Fault(404, 'skill_not_found');
    const updated = await db.transition(
      req.principal.tenant,
      'skill',
      id,
      decision.status,
      {
        ...current.meta,
        decided_at: new Date().toISOString(),
      },
      req.principal.actor,
    );
    await db.audit(req.principal.tenant, req.principal.actor, 'skill.decision', {
      skill_id: id,
      status: decision.status,
      request_id: req.id,
    });
    return { ...updated.body, id, status: updated.status, content_hash: updated.digest };
  });
  const McpInput = z
    .object({
      name: Key,
      version: z.string().min(1).max(80),
      transport: z.enum(['streamable-http', 'stdio']),
      endpoint: z.string().url().optional(),
      command: z.string().min(1).max(500).optional(),
      args: z.array(z.string().max(500)).max(32).default([]),
      credential_ref: z.string().max(260).optional(),
      schema_hash: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
      tool_names: z.array(Key).max(200).default([]),
    })
    .strict()
    .superRefine((value, ctx) => {
      if (value.transport === 'streamable-http' && !value.endpoint)
        ctx.addIssue({ code: 'custom', path: ['endpoint'], message: 'HTTP MCP 需要 endpoint' });
      if (value.transport === 'stdio' && !value.command)
        ctx.addIssue({ code: 'custom', path: ['command'], message: 'stdio MCP 需要 command' });
    });
  app.get('/v1/mcp/servers', async (req) => {
    requireRole(req.principal, 'viewer', 'operator', 'developer', 'reviewer', 'publisher');
    const rows = await db.list(req.principal.tenant, 'mcp_server', 100, 0);
    const result = rows
      .filter((row: any) => row?.status !== 'deleted')
      .map((row: any) => ({
        ...row.body,
        id: row.key,
        status: row.status,
        artifact_hash: row.digest,
      }));
    await db.audit(req.principal.tenant, req.principal.actor, 'mcp.list', {
      count: result.length,
      request_id: req.id,
    });
    return result;
  });
  app.post('/v1/mcp/servers', async (req, reply) => {
    requireRole(req.principal, 'developer', 'reviewer');
    const input = McpInput.parse(req.body);
    const id = `${input.name}@${input.version}`;
    if (await db.get(req.principal.tenant, 'mcp_server', id))
      throw new Fault(409, 'mcp_server_exists');
    const record = await db.put(
      req.principal.tenant,
      'mcp_server',
      id,
      input,
      req.principal.actor,
      'draft',
    );
    await db.audit(req.principal.tenant, req.principal.actor, 'mcp.created', {
      server_id: id,
      artifact_hash: record.digest,
      request_id: req.id,
    });
    return reply
      .code(201)
      .send({ ...input, id, status: record.status, artifact_hash: record.digest });
  });
  app.post('/v1/mcp/servers/:id/decision', async (req) => {
    requireRole(req.principal, 'reviewer', 'publisher');
    const { id } = z.object({ id: z.string().min(3).max(160) }).parse(req.params);
    const decision = z
      .object({ status: z.enum(['approved', 'deprecated', 'revoked']) })
      .strict()
      .parse(req.body);
    const current = await db.get(req.principal.tenant, 'mcp_server', id);
    if (!current || current.status === 'deleted') throw new Fault(404, 'mcp_server_not_found');
    const updated = await db.transition(
      req.principal.tenant,
      'mcp_server',
      id,
      decision.status,
      {
        ...current.meta,
        decided_at: new Date().toISOString(),
      },
      req.principal.actor,
    );
    await db.audit(req.principal.tenant, req.principal.actor, 'mcp.decision', {
      server_id: id,
      status: decision.status,
      request_id: req.id,
    });
    return { ...updated.body, id, status: updated.status, artifact_hash: updated.digest };
  });
  app.post('/v1/mcp/servers/:id/discover', async (req) => {
    requireRole(req.principal, 'developer', 'reviewer', 'publisher');
    const { id } = z.object({ id: z.string().min(3).max(160) }).parse(req.params);
    const server = await db.get(req.principal.tenant, 'mcp_server', id);
    if (!server || server.status === 'deleted') throw new Fault(404, 'mcp_server_not_found');
    const bindings = (options.mcpTools ?? config.mcpTools).filter((binding) => binding.id === id);
    const toolNames = server.body?.tool_names ?? [];
    if (server.status === 'approved' && !bindings.length)
      throw new Fault(503, 'mcp_fixed_bindings_missing', id);
    await db.audit(req.principal.tenant, req.principal.actor, 'mcp.discover', {
      server_id: id,
      tool_count: toolNames.length,
      dynamic_discovery: false,
      request_id: req.id,
    });
    return {
      id,
      name: server.body?.name,
      transport: server.body?.transport,
      url: server.body?.endpoint,
      command: server.body?.command,
      status: server.status,
      dynamic_discovery: false,
      changed: false,
      discovered_tools: toolNames.map((name: string) => ({
        id: `${id}/${name}`,
        name,
        version: server.body?.version ?? 'unknown',
        source: 'mcp',
        description: `MCP ${server.body?.name ?? id} · ${name}`,
        side_effect: 'read',
        status: 'approved',
        implementation_hash: server.digest,
        binding: bindings.some((b) => b.toolName === name),
      })),
      discovered_resources: [],
      discovered_prompts: [],
      tools: toolNames.map((name: string) => ({
        name,
        binding: bindings.some((b) => b.toolName === name),
      })),
      message: '生产环境使用已审批的固定工具清单；新增工具需要新版本并重新审批。',
    };
  });
  const KnowledgeBackendInput = z
    .object({
      name: Key,
      version: z.string().min(1).max(80),
      type: z.enum(['native', 'gbrain', 'hybrid']),
      config_hash: z.string().regex(/^[a-f0-9]{64}$/),
      capabilities: z.array(Key).max(32).default([]),
    })
    .strict();
  app.get('/v1/knowledge/backends', async (req) => {
    requireRole(req.principal, 'viewer', 'operator', 'developer', 'reviewer', 'publisher');
    const rows = await db.list(req.principal.tenant, 'knowledge_backend', 100, 0);
    const result = rows
      .filter((row: any) => row?.status !== 'deleted')
      .map((row: any) => ({
        ...row.body,
        id: row.key,
        status: row.status,
        artifact_hash: row.digest,
      }));
    await db.audit(req.principal.tenant, req.principal.actor, 'knowledge_backend.list', {
      count: result.length,
      request_id: req.id,
    });
    return result;
  });
  app.post('/v1/knowledge/backends', async (req, reply) => {
    requireRole(req.principal, 'developer', 'reviewer');
    const input = KnowledgeBackendInput.parse(req.body);
    const id = `${input.name}@${input.version}`;
    if (await db.get(req.principal.tenant, 'knowledge_backend', id))
      throw new Fault(409, 'knowledge_backend_exists');
    const record = await db.put(
      req.principal.tenant,
      'knowledge_backend',
      id,
      input,
      req.principal.actor,
      'draft',
    );
    await db.audit(req.principal.tenant, req.principal.actor, 'knowledge_backend.created', {
      backend_id: id,
      artifact_hash: record.digest,
      request_id: req.id,
    });
    return reply
      .code(201)
      .send({ ...input, id, status: record.status, artifact_hash: record.digest });
  });
  app.post('/v1/knowledge/backends/:id/decision', async (req) => {
    requireRole(req.principal, 'reviewer', 'publisher');
    const { id } = z.object({ id: z.string().min(3).max(160) }).parse(req.params);
    const decision = z
      .object({ status: z.enum(['approved', 'deprecated', 'revoked']) })
      .strict()
      .parse(req.body);
    const current = await db.get(req.principal.tenant, 'knowledge_backend', id);
    if (!current || current.status === 'deleted')
      throw new Fault(404, 'knowledge_backend_not_found');
    const updated = await db.transition(
      req.principal.tenant,
      'knowledge_backend',
      id,
      decision.status,
      {
        ...current.meta,
        decided_at: new Date().toISOString(),
      },
      req.principal.actor,
    );
    await db.audit(req.principal.tenant, req.principal.actor, 'knowledge_backend.decision', {
      backend_id: id,
      status: decision.status,
      request_id: req.id,
    });
    return { ...updated.body, id, status: updated.status, artifact_hash: updated.digest };
  });
  app.get('/v1/specs', async (req) => {
    requireRole(req.principal, 'viewer', 'developer', 'reviewer', 'publisher');
    const page = Page.parse(req.query);
    return db.list(req.principal.tenant, 'spec', page.limit, page.offset);
  });
  // Production-facing Agent catalog. Only reviewed specs are exposed; drafts remain
  // confined to the research/Studio API. The response intentionally mirrors the
  // lightweight AgentSummary consumed by the Agent app.
  const productionAgent = (artifact: any) => {
    const spec = artifact.body ?? {};
    return {
      id: spec.name ?? artifact.key,
      name: spec.name ?? artifact.key,
      description: spec.description ?? spec.instructions ?? '',
      model: spec.llm?.model ?? 'configured',
      status: artifact.status === 'revoked' ? 'archived' : 'published',
      version: spec.version,
      updated_at: artifact.created,
      capabilities: {
        tools: (spec.tools ?? []).map((tool: any) => (typeof tool === 'string' ? tool : tool.name)),
        skills: (spec.skills ?? []).map((skill: any) =>
          typeof skill === 'string' ? skill : skill.name,
        ),
        mcp: spec.capabilities?.mcp_servers ?? [],
        memory: spec.memory?.scopes ?? [],
      },
    };
  };
  app.get('/v1/agents', async (req) => {
    requireRole(req.principal, 'viewer', 'operator', 'developer', 'reviewer', 'publisher');
    const page = Page.parse(req.query);
    const artifacts = await db.list(req.principal.tenant, 'spec', page.limit, page.offset);
    return artifacts.filter((artifact: any) => artifact.status === 'approved').map(productionAgent);
  });
  app.get('/v1/agents/:name', async (req) => {
    requireRole(req.principal, 'viewer', 'operator', 'developer', 'reviewer', 'publisher');
    const { name } = z.object({ name: Key }).parse(req.params);
    let artifact = await db.get(req.principal.tenant, 'spec', name);
    if (!artifact) {
      const candidates = await db.list(req.principal.tenant, 'spec', 100, 0);
      artifact = candidates.find((candidate: any) => candidate.body?.name === name);
    }
    if (!artifact || artifact.status !== 'approved') throw new Fault(404, 'agent_not_found');
    return productionAgent(artifact);
  });
  app.get('/v1/agents/:name/draft', async (req) => {
    requireRole(req.principal, 'developer', 'reviewer', 'publisher');
    const { name } = z.object({ name: Key }).parse(req.params);
    const draft = await db.get(req.principal.tenant, 'agent_draft', name);
    if (!draft) return { graph: null, revision: 0 };
    return {
      ...(draft.body as any),
      revision: Number((draft.meta as any)?.revision ?? 1),
      digest: draft.digest,
    };
  });
  app.get('/v1/agents/:name/deployment', async (req) => {
    requireRole(req.principal, 'viewer', 'operator', 'developer', 'reviewer', 'publisher');
    const { name } = z.object({ name: Key }).parse(req.params);
    const channel = z
      .object({ channel: z.enum(['production', 'canary']).default('production') })
      .parse(req.query).channel;
    const ref = await db.pointer(req.principal.tenant, 'deployment', `${channel}.${name}`);
    if (!ref) return { name, channel, deployed: false };
    const spec = await db.get(req.principal.tenant, 'spec', ref);
    if (!spec || spec.status !== 'approved') return { name, channel, deployed: false, ref };
    return {
      name,
      channel,
      deployed: true,
      ref,
      digest: spec.digest,
      release_artifact_hash: spec.meta.release_artifact_hash,
      version: spec.body.version,
      manifest_url: `/v1/releases/${encodeURIComponent(ref)}/manifest`,
    };
  });
  app.put('/v1/agents/:name/draft', async (req) => {
    requireRole(req.principal, 'developer');
    const { name } = z.object({ name: Key }).parse(req.params);
    const body = z
      .object({ graph: z.unknown(), yaml: z.string().max(32000).optional() })
      .strict()
      .parse(req.body);
    const previous = await db.get(req.principal.tenant, 'agent_draft', name);
    const revision = Number((previous?.meta as any)?.revision ?? 0) + 1;
    const draft = await db.put(
      req.principal.tenant,
      'agent_draft',
      name,
      body,
      req.principal.actor,
      'draft',
      { revision },
    );
    await db.audit(req.principal.tenant, req.principal.actor, 'agent_draft.updated', {
      name,
      revision,
      digest: draft.digest,
      request_id: req.id,
    });
    return { ...body, revision, digest: draft.digest };
  });
  app.post('/v1/agents/:name/publish', async (req, reply) => {
    requireRole(req.principal, 'developer');
    const { name } = z.object({ name: Key }).parse(req.params);
    const body = z
      .object({ yaml: z.string().min(1).max(32000), graph: z.unknown().optional() })
      .strict()
      .parse(req.body);
    const artifact = await service.createSpec(req.principal, body.yaml);
    if (artifact.body.name !== name) throw new Fault(409, 'agent_spec_mismatch');
    // Publishing is intentionally a governed two-step operation in production:
    // this endpoint creates the immutable candidate; evaluation, review and
    // deployment remain explicit actions and cannot be bypassed by the UI.
    return reply
      .code(202)
      .send({ status: 'pending_review', ref: artifact.key, digest: artifact.digest });
  });
  app.get('/v1/releases/:ref/manifest', async (req) => {
    requireRole(req.principal, 'viewer', 'developer', 'reviewer', 'publisher');
    const { ref } = z.object({ ref: Ref }).parse(req.params);
    const spec = await db.get(req.principal.tenant, 'spec', ref);
    if (!spec || spec.status === 'revoked') throw new Fault(404, 'release_not_found');
    const skillRows = await Promise.all(
      (spec.body.skills ?? []).map((skill: any) =>
        db.get(req.principal.tenant, 'skill', `${skill.name}@${skill.version}`),
      ),
    );
    const mcpRows = await Promise.all(
      (spec.body.capabilities?.mcp_servers ?? []).map((id: string) =>
        db.get(req.principal.tenant, 'mcp_server', id),
      ),
    );
    const knowledgeRows = await Promise.all(
      (spec.body.capabilities?.knowledge_backends ?? []).map((id: string) =>
        db.get(req.principal.tenant, 'knowledge_backend', id),
      ),
    );
    const manifest = {
      release_artifact_hash: spec.meta.release_artifact_hash,
      spec_hash: spec.digest,
      loop: { engine: spec.body.flow.loop?.engine ?? 'orchestrator', version: BUILD_ID },
      skill_hashes: skillRows.filter(Boolean).map((row: any) => row.digest),
      tool_versions: Object.fromEntries(
        spec.body.tools.map((entry: any) => {
          const tool = service.tools.find((candidate) => candidate.name === entry.name);
          return [
            entry.name,
            { version: tool?.version ?? 'unknown', schema_hash: tool ? digest(tool.schema) : null },
          ];
        }),
      ),
      mcp_hashes: mcpRows.filter(Boolean).map((row: any) => row.digest),
      knowledge_hashes: knowledgeRows.filter(Boolean).map((row: any) => row.digest),
      memory_scopes: spec.body.capabilities?.memory_scopes ?? ['turn', 'task'],
      budget: {
        max_steps: spec.body.flow.max_steps,
        max_tokens: config.maxOutputTokens,
      },
      model: { provider: spec.body.llm.provider, model: spec.body.llm.model },
      environment: spec.meta.environment,
    };
    await db.audit(req.principal.tenant, req.principal.actor, 'release.manifest_read', {
      ref,
      request_id: req.id,
    });
    return manifest;
  });
  app.get('/v1/artifacts/:kind/:key', async (req) => {
    requireRole(req.principal, 'viewer', 'operator', 'developer', 'reviewer', 'publisher');
    const params = z
      .object({
        kind: Key,
        key: z
          .string()
          .min(1)
          .max(260)
          .regex(/^[a-zA-Z0-9_.@+-]+$/),
      })
      .parse(req.params);
    const artifact = await db.get(req.principal.tenant, params.kind, params.key);
    if (!artifact) throw new Fault(404, 'artifact_not_found');
    await db.audit(req.principal.tenant, req.principal.actor, 'artifact.read', {
      kind: params.kind,
      key: params.key,
      digest: artifact.digest,
      request_id: req.id,
    });
    return {
      key: artifact.key,
      kind: params.kind,
      digest: artifact.digest,
      author: artifact.author,
      status: artifact.status,
      created: artifact.created,
      object_key: `tenants/${req.principal.tenant}/artifacts/${artifact.key}/${artifact.digest}.json`,
    };
  });
  app.get('/v1/artifacts/:kind/:key/content', async (req, reply) => {
    requireRole(req.principal, 'viewer', 'operator', 'developer', 'reviewer', 'publisher');
    const params = z
      .object({
        kind: Key,
        key: z
          .string()
          .min(1)
          .max(260)
          .regex(/^[a-zA-Z0-9_.@+-]+$/),
      })
      .parse(req.params);
    const artifact = await db.get(req.principal.tenant, params.kind, params.key);
    if (!artifact) throw new Fault(404, 'artifact_not_found');
    await db.audit(req.principal.tenant, req.principal.actor, 'artifact.content_read', {
      kind: params.kind,
      key: params.key,
      digest: artifact.digest,
      request_id: req.id,
    });
    if (!objectStore) return reply.type('application/json').send(JSON.stringify(artifact.body));
    const bytes = await objectStore.get(
      `tenants/${req.principal.tenant}/artifacts/${artifact.key}/${artifact.digest}.json`,
    );
    return reply.type('application/json').send(Buffer.from(bytes));
  });
  const FileUpload = z
    .object({
      project_id: Key,
      name: z.string().trim().min(1).max(240),
      mime_type: z.string().trim().min(1).max(120),
      content_base64: z.string().min(1).max(20_000_000),
    })
    .strict();
  const fileObjectKey = (tenant: string, id: string, hash: string) =>
    `tenants/${tenant}/files/${id}/${hash}`;
  app.post('/v1/files', async (req, reply) => {
    requireRole(req.principal, 'operator', 'developer', 'reviewer');
    if (!objectStore) throw new Fault(503, 's3_object_store_required');
    const input = FileUpload.parse(req.body);
    const bytes = Buffer.from(input.content_base64, 'base64');
    if (!bytes.length || bytes.length > 25 * 1024 * 1024) throw new Fault(413, 'file_too_large');
    const id = randomUUID();
    const contentHash = createHash('sha256').update(bytes).digest('hex');
    const objectKey = fileObjectKey(req.principal.tenant, id, contentHash);
    await objectStore.put(objectKey, bytes, input.mime_type);
    const metadata = {
      id,
      project_id: input.project_id,
      name: input.name,
      mime_type: input.mime_type,
      size: bytes.length,
      content_hash: contentHash,
      object_key: objectKey,
      created_at: new Date().toISOString(),
    };
    try {
      const artifact = await db.put(
        req.principal.tenant,
        'file',
        id,
        metadata,
        req.principal.actor,
        'active',
      );
      await db.audit(req.principal.tenant, req.principal.actor, 'file.created', {
        file_id: id,
        project_id: input.project_id,
        digest: artifact.digest,
        request_id: req.id,
      });
      return reply.code(201).send({ ...metadata, artifact_digest: artifact.digest });
    } catch (error) {
      await objectStore.delete(objectKey).catch(() => undefined);
      throw error;
    }
  });
  app.get('/v1/files', async (req) => {
    requireRole(req.principal, 'viewer', 'operator', 'developer', 'reviewer');
    const query = z.object({ project_id: Key }).parse(req.query);
    const files = await db.list(req.principal.tenant, 'file', 100, 0);
    const result = files
      .filter(
        (file: any) => file?.status === 'active' && file.body?.project_id === query.project_id,
      )
      .map((file: any) => ({ ...file.body, artifact_digest: file.digest }));
    await db.audit(req.principal.tenant, req.principal.actor, 'file.list', {
      project_id: query.project_id,
      count: result.length,
      request_id: req.id,
    });
    return result;
  });
  app.get('/v1/files/:id/content', async (req, reply) => {
    requireRole(req.principal, 'viewer', 'operator', 'developer', 'reviewer');
    const { id } = z.object({ id: Key }).parse(req.params);
    const file = await db.get(req.principal.tenant, 'file', id);
    if (!file || file.status !== 'active') throw new Fault(404, 'file_not_found');
    if (!objectStore) throw new Fault(503, 's3_object_store_required');
    const bytes = await objectStore.get(file.body.object_key);
    await db.audit(req.principal.tenant, req.principal.actor, 'file.content_read', {
      file_id: id,
      project_id: file.body.project_id,
      request_id: req.id,
    });
    return reply.type(file.body.mime_type).send(Buffer.from(bytes));
  });
  app.delete('/v1/files/:id', async (req) => {
    requireRole(req.principal, 'developer', 'reviewer');
    const { id } = z.object({ id: Key }).parse(req.params);
    const file = await db.get(req.principal.tenant, 'file', id);
    if (!file || file.status !== 'active') throw new Fault(404, 'file_not_found');
    await db.transition(
      req.principal.tenant,
      'file',
      id,
      'deleted',
      { ...file.meta, deleted_at: new Date().toISOString() },
      req.principal.actor,
    );
    if (objectStore) await objectStore.delete(file.body.object_key).catch(() => undefined);
    await db.audit(req.principal.tenant, req.principal.actor, 'file.deleted', {
      file_id: id,
      project_id: file.body.project_id,
      request_id: req.id,
    });
    return { deleted: true, id };
  });
  const KnowledgeUpload = z
    .object({
      project_id: Key,
      name: z.string().trim().min(1).max(240),
      mime_type: z.string().trim().min(1).max(120),
      content_base64: z.string().min(1).max(18_000_000),
    })
    .strict();
  const knowledgeObjectKey = (tenant: string, id: string, hash: string) =>
    `tenants/${tenant}/knowledge/${id}/${hash}`;
  app.post('/v1/knowledge/files', async (req, reply) => {
    requireRole(req.principal, 'operator', 'developer', 'reviewer');
    if (!objectStore) throw new Fault(503, 's3_object_store_required');
    const input = KnowledgeUpload.parse(req.body);
    const bytes = Buffer.from(input.content_base64, 'base64');
    if (!bytes.length || bytes.length > 15 * 1024 * 1024) throw new Fault(413, 'file_too_large');
    const id = randomUUID();
    const contentHash = createHash('sha256').update(bytes).digest('hex');
    const objectKey = knowledgeObjectKey(req.principal.tenant, id, contentHash);
    await objectStore.put(objectKey, bytes, input.mime_type);
    const text =
      /^text\//.test(input.mime_type) || /json|csv|xml/.test(input.mime_type)
        ? bytes.toString('utf8')
        : '';
    const chunks = [];
    for (let start = 0, n = 0; start < text.length; start += 1200, n += 1) {
      const end = Math.min(text.length, start + 1200);
      const value = text.slice(start, end);
      chunks.push({
        id: `${id}:${n}`,
        text: value,
        start,
        end,
        hash: createHash('sha256').update(value).digest('hex'),
      });
    }
    const metadata = {
      id,
      project_id: input.project_id,
      name: input.name,
      mime_type: input.mime_type,
      size: bytes.length,
      content_hash: contentHash,
      object_key: objectKey,
      chunks,
      created_at: new Date().toISOString(),
    };
    try {
      const artifact = await db.put(
        req.principal.tenant,
        'knowledge_file',
        id,
        metadata,
        req.principal.actor,
        'active',
      );
      return reply.code(201).send({ ...metadata, artifact_digest: artifact.digest });
    } catch (error) {
      await objectStore.delete(objectKey).catch(() => undefined);
      throw error;
    }
  });
  app.get('/v1/knowledge/files', async (req) => {
    requireRole(req.principal, 'viewer', 'operator', 'developer', 'reviewer');
    const query = z.object({ project_id: Key }).parse(req.query);
    const files = await db.list(req.principal.tenant, 'knowledge_file', 100, 0);
    const result = files
      .filter(
        (file: any) =>
          file && file.status === 'active' && file.body?.project_id === query.project_id,
      )
      .map((file: any) => ({ ...file.body, artifact_digest: file.digest }));
    await db.audit(req.principal.tenant, req.principal.actor, 'knowledge.list', {
      project_id: query.project_id,
      count: result.length,
      request_id: req.id,
    });
    return result;
  });
  app.get('/v1/knowledge/files/:id/content', async (req, reply) => {
    requireRole(req.principal, 'viewer', 'operator', 'developer', 'reviewer');
    const { id } = z.object({ id: Key }).parse(req.params);
    const file = await db.get(req.principal.tenant, 'knowledge_file', id);
    if (!file || file.status !== 'active') throw new Fault(404, 'file_not_found');
    if (!objectStore) throw new Fault(503, 's3_object_store_required');
    const bytes = await objectStore.get(file.body.object_key);
    await db.audit(req.principal.tenant, req.principal.actor, 'knowledge.content_read', {
      file_id: id,
      project_id: file.body.project_id,
      request_id: req.id,
    });
    return reply.type(file.body.mime_type).send(Buffer.from(bytes));
  });
  app.get('/v1/knowledge/search', async (req) => {
    requireRole(req.principal, 'viewer', 'operator', 'developer', 'reviewer');
    const query = z
      .object({
        project_id: Key,
        q: z.string().trim().min(1).max(1000),
        limit: z.coerce.number().int().min(1).max(50).default(10),
        backend_id: z.string().min(3).max(160).optional(),
      })
      .parse(req.query);
    if (query.backend_id) {
      const backend = await db.get(req.principal.tenant, 'knowledge_backend', query.backend_id);
      if (!backend || backend.status !== 'approved')
        throw new Fault(409, 'knowledge_backend_not_approved');
      if (
        backend.body?.type !== 'native' &&
        !knowledgeBackends.has(query.backend_id) &&
        !fixedMcpBindings.some((binding) => binding.id === backend.body?.server_ref)
      )
        throw new Fault(501, 'knowledge_backend_runtime_unavailable', query.backend_id);
    }
    if (query.backend_id) {
      const backend = await db.get(req.principal.tenant, 'knowledge_backend', query.backend_id);
      if (
        backend?.body?.type === 'gbrain' &&
        backend.body.server_ref &&
        !knowledgeBackends.has(query.backend_id)
      ) {
        knowledgeBackends.set(
          query.backend_id,
          createMcpKnowledgeAdapter(backend.body.server_ref, fixedMcpBindings),
        );
      }
    }
    if (query.backend_id && knowledgeBackends.has(query.backend_id)) {
      const result = await knowledgeBackends.get(query.backend_id)!.search({
        organization_id: req.principal.tenant,
        project_id: query.project_id,
        query: query.q,
        limit: query.limit,
      });
      await db.audit(req.principal.tenant, req.principal.actor, 'knowledge.search', {
        project_id: query.project_id,
        backend_id: query.backend_id,
        query_hash: createHash('sha256').update(query.q).digest('hex'),
        count: result.hits.length,
        request_id: req.id,
      });
      return result.hits;
    }
    const terms = query.q.toLowerCase().split(/\s+/).filter(Boolean);
    const files = await db.list(req.principal.tenant, 'knowledge_file', 100, 0);
    const result = files
      .filter(
        (file: any) =>
          file && file.status === 'active' && file.body?.project_id === query.project_id,
      )
      .flatMap((file: any) =>
        (file.body?.chunks ?? [])
          .map((chunk: any) => ({
            file_id: file.key,
            file_name: file.body.name,
            chunk_id: chunk.id,
            text: chunk.text,
            start: chunk.start,
            end: chunk.end,
            score: terms.filter((term) => chunk.text.toLowerCase().includes(term)).length,
          }))
          .filter((hit: any) => hit.score > 0),
      )
      .sort((a: any, b: any) => b.score - a.score)
      .slice(0, query.limit);
    await db.audit(req.principal.tenant, req.principal.actor, 'knowledge.search', {
      project_id: query.project_id,
      backend_id: query.backend_id ?? 'native',
      query_hash: createHash('sha256').update(query.q).digest('hex'),
      count: result.length,
      request_id: req.id,
    });
    return result;
  });
  app.delete('/v1/knowledge/files/:id', async (req) => {
    requireRole(req.principal, 'developer', 'reviewer');
    const { id } = z.object({ id: Key }).parse(req.params);
    const file = await db.get(req.principal.tenant, 'knowledge_file', id);
    if (!file || file.status !== 'active') throw new Fault(404, 'file_not_found');
    await db.transition(
      req.principal.tenant,
      'knowledge_file',
      id,
      'deleted',
      { ...file.meta, deleted_at: new Date().toISOString() },
      req.principal.actor,
    );
    if (objectStore) await objectStore.delete(file.body.object_key).catch(() => undefined);
    await db.audit(req.principal.tenant, req.principal.actor, 'knowledge.deleted', {
      file_id: id,
      project_id: file.body.project_id,
      request_id: req.id,
    });
    return { deleted: true, id };
  });
  app.post('/v1/specs', async (req, reply) => {
    const body = z
      .object({ yaml: z.string().min(1).max(32000) })
      .strict()
      .parse(req.body);
    return reply.code(201).send(await service.createSpec(req.principal, body.yaml));
  });
  app.post('/v1/suites/:name', async (req, reply) => {
    const { name } = z.object({ name: Key }).parse(req.params);
    return reply.code(201).send(await service.setSuite(req.principal, name, req.body));
  });
  const idem = (headers: Record<string, any>) =>
    z
      .string()
      .regex(/^[a-zA-Z0-9_.-]{8,120}$/)
      .parse(headers['idempotency-key']);
  app.post('/v1/evaluations', async (req, reply) => {
    const body = z.object({ ref: Ref }).strict().parse(req.body);
    return reply
      .code(202)
      .send(jobView(await service.evaluate(req.principal, body.ref, idem(req.headers))));
  });
  app.post('/v1/approvals', async (req) => {
    const body = z.object({ ref: Ref, reason: Reason }).strict().parse(req.body);
    return await service.approve(req.principal, body.ref, body.reason);
  });
  app.post('/v1/deployments/:name', async (req) => {
    const { name } = z.object({ name: Key }).parse(req.params);
    const body = z
      .object({
        ref: Ref,
        channel: z.enum(['production', 'canary']).default('production'),
        reason: Reason,
      })
      .strict()
      .parse(req.body);
    return await service.deploy(req.principal, name, body.ref, body.channel, body.reason);
  });
  app.post('/v1/revocations', async (req) => {
    const body = z.object({ ref: Ref, reason: Reason }).strict().parse(req.body);
    return await service.revoke(req.principal, body.ref, body.reason);
  });
  app.post('/v1/runs', async (req, reply) => {
    const body = z
      .object({
        name: Key,
        channel: z.enum(['production', 'canary']).default('production'),
        prompt: z.string().min(1).max(8000),
        project_id: Key.optional(),
        session: Key.optional(),
      })
      .strict()
      .parse(req.body);
    return reply.code(202).send(jobView(await service.run(req.principal, body, idem(req.headers))));
  });
  app.post('/v1/agents/:name/tasks', async (req, reply) => {
    requireRole(req.principal, 'operator');
    const { name } = z.object({ name: Key }).parse(req.params);
    const body = z
      .object({
        prompt: z.string().min(1).max(8000),
        project_id: Key.optional(),
        channel: z.enum(['production', 'canary']).default('production'),
      })
      .strict()
      .parse(req.body);
    const task = await service.run(
      req.principal,
      { name, channel: body.channel, prompt: body.prompt, project_id: body.project_id },
      idem(req.headers),
    );
    return reply.code(202).send(jobView(task));
  });
  app.get('/v1/agents/:name/tasks', async (req) => {
    requireRole(req.principal, 'viewer', 'operator', 'developer', 'reviewer');
    const { name } = z.object({ name: Key }).parse(req.params);
    const page = Page.parse(req.query);
    const sessions = await db.listSessions(req.principal.tenant, page.limit, page.offset);
    return sessions
      .filter(
        (session: any) =>
          session.kind === 'run' && (session.ref === name || session.ref?.startsWith(`${name}@`)),
      )
      .map((session: any) => ({
        session_id: session.id,
        spec_name: name,
        spec_version: session.ref,
        event_count: session.seq,
        turn_count: 0,
        total_duration_ms: 0,
        first_seq: session.seq ? 1 : 0,
        last_seq: session.seq,
      }));
  });
  app.get('/v1/tasks/:id', async (req) => {
    requireRole(req.principal, 'viewer', 'operator', 'developer', 'reviewer');
    const { id } = z.object({ id: Key }).parse(req.params);
    const session = await db.session(req.principal.tenant, id);
    if (!session || session.kind !== 'run') throw new Fault(404, 'task_not_found');
    const events = await db.read(req.principal.tenant, id);
    return {
      id,
      session_id: id,
      kind: session.kind,
      release_ref: session.ref,
      turns: events.filter((event: any) => event.type === 'turn/end').length,
      events: events.filter((event: any) =>
        ['user.message', 'assistant.message', 'turn/end'].includes(event.type),
      ),
    };
  });
  app.post('/v1/tasks/:id/turns', async (req, reply) => {
    requireRole(req.principal, 'operator');
    const { id } = z.object({ id: Key }).parse(req.params);
    const body = z
      .object({ prompt: z.string().min(1).max(8000), project_id: Key.optional() })
      .strict()
      .parse(req.body);
    const session = await db.session(req.principal.tenant, id);
    if (!session || session.kind !== 'run') throw new Fault(404, 'task_not_found');
    const spec = await db.get(req.principal.tenant, 'spec', session.ref);
    if (!spec) throw new Fault(409, 'task_release_missing');
    const task = await service.run(
      req.principal,
      {
        name: spec.body.name,
        channel: 'production',
        prompt: body.prompt,
        project_id: body.project_id,
        session: id,
      },
      idem(req.headers),
    );
    return reply.code(202).send(jobView(task));
  });
  app.post('/v1/tasks/:id/cancel', async (req) => {
    requireRole(req.principal, 'operator');
    const { id } = z.object({ id: Key }).parse(req.params);
    return jobView(await service.cancel(req.principal, id));
  });
  app.post('/v1/improvements', async (req, reply) => {
    const body = z
      .object({
        name: Key,
        version: z.string().min(1).max(80),
        feedback: z.string().max(4000).default(''),
      })
      .strict()
      .parse(req.body);
    return reply
      .code(202)
      .send(
        jobView(
          await service.improve(
            req.principal,
            body.name,
            body.version,
            body.feedback,
            idem(req.headers),
          ),
        ),
      );
  });
  app.post('/v1/replays', async (req, reply) => {
    const body = z.object({ session: Key }).strict().parse(req.body);
    return reply
      .code(202)
      .send(jobView(await service.replay(req.principal, body.session, idem(req.headers))));
  });
  app.post('/v1/replay', async (req, reply) => {
    const body = z
      .object({ session: Key, mode: z.literal('strict').default('strict') })
      .strict()
      .parse(req.body);
    return reply
      .code(202)
      .send(jobView(await service.replay(req.principal, body.session, idem(req.headers))));
  });
  app.get('/v1/jobs/:id', async (req) => {
    requireRole(req.principal, 'viewer', 'operator', 'developer', 'reviewer');
    const { id } = z.object({ id: Key }).parse(req.params);
    const job = await db.job(req.principal.tenant, id);
    if (!job) throw new Fault(404, 'job_not_found');
    return jobView(job);
  });
  app.post('/v1/jobs/:id/cancel', async (req) => {
    const { id } = z.object({ id: Key }).parse(req.params);
    return jobView(await service.cancel(req.principal, id));
  });
  app.get('/v1/sessions', async (req) => {
    requireRole(req.principal, 'viewer', 'operator');
    const page = Page.parse(req.query);
    return db.listSessions(req.principal.tenant, page.limit, page.offset);
  });
  const visibleSession = async (p: Principal, id: string) => {
    requireRole(p, 'viewer', 'operator', 'reviewer');
    const session = await db.session(p.tenant, id);
    if (
      !session ||
      session.kind === 'audit' ||
      (session.kind !== 'run' && !p.roles.includes('reviewer') && !p.roles.includes('admin'))
    )
      throw new Fault(404, 'session_not_found');
  };
  app.get('/v1/sessions/:id/events', async (req) => {
    const { id } = z.object({ id: Key }).parse(req.params);
    await visibleSession(req.principal, id);
    const query = z
      .object({
        after: z.coerce.number().int().min(0).default(0),
        limit: z.coerce.number().int().min(1).max(500).default(100),
      })
      .parse(req.query);
    const events = await db.read(req.principal.tenant, id, query.after, query.limit);
    await db.audit(req.principal.tenant, req.principal.actor, 'trace.read', {
      session: id,
      after: query.after,
      limit: query.limit,
      request_id: req.id,
    });
    return events;
  });
  // Task aliases keep the public Task API independent from the physical session
  // storage used by the ledger while preserving one canonical event source.
  app.get('/v1/tasks/:id/events', async (req) => {
    const { id } = z.object({ id: Key }).parse(req.params);
    await visibleSession(req.principal, id);
    const query = z
      .object({
        after: z.coerce.number().int().min(0).default(0),
        limit: z.coerce.number().int().min(1).max(500).default(100),
      })
      .parse(req.query);
    return db.read(req.principal.tenant, id, query.after, query.limit);
  });
  app.get('/v1/sessions/:id/integrity', async (req) => {
    const { id } = z.object({ id: Key }).parse(req.params);
    await visibleSession(req.principal, id);
    return db.verify(req.principal.tenant, id);
  });
  app.get('/v1/sessions/:id/invocations', async (req) => {
    const { id } = z.object({ id: Key }).parse(req.params);
    await visibleSession(req.principal, id);
    const events = await db.read(req.principal.tenant, id);
    const invocations = new Map<string, any>();
    for (const event of events) {
      if (!event.invocation_id) continue;
      const current = invocations.get(event.invocation_id) ?? {
        invocation_id: event.invocation_id,
        parent_invocation_id: event.parent_invocation_id,
        path: event.path,
        ordinal: event.ordinal,
        attempt: event.attempt,
        run_id: event.run_id,
        fingerprint: event.fingerprint,
        operation: event.type,
        events: [],
      };
      current.events.push({
        seq: event.seq,
        type: event.type,
        verb: event.verb,
        payload: event.payload,
        fingerprint: event.fingerprint,
      });
      invocations.set(event.invocation_id, current);
    }
    await db.audit(req.principal.tenant, req.principal.actor, 'invocations.read', {
      session: id,
      request_id: req.id,
    });
    return { session: id, invocations: [...invocations.values()] };
  });
  app.get('/v1/tasks/:id/invocations', async (req) => {
    const { id } = z.object({ id: Key }).parse(req.params);
    await visibleSession(req.principal, id);
    const events = await db.read(req.principal.tenant, id);
    const invocations = new Map<string, any>();
    for (const event of events) {
      if (!event.invocation_id) continue;
      const current = invocations.get(event.invocation_id) ?? {
        invocation_id: event.invocation_id,
        parent_invocation_id: event.parent_invocation_id,
        path: event.path,
        ordinal: event.ordinal,
        attempt: event.attempt,
        run_id: event.run_id,
        fingerprint: event.fingerprint,
        operation: event.type,
        events: [],
      };
      current.events.push({
        seq: event.seq,
        type: event.type,
        verb: event.verb,
        payload: event.payload,
        fingerprint: event.fingerprint,
      });
      invocations.set(event.invocation_id, current);
    }
    return { session: id, invocations: [...invocations.values()] };
  });
  app.get('/v1/sessions/:id/trajectory', async (req) => {
    const { id } = z.object({ id: Key }).parse(req.params);
    await visibleSession(req.principal, id);
    const query = z
      .object({
        path: z.string().min(1).max(500).optional(),
        scope: z.enum(['tree', 'agent']).default('tree'),
      })
      .parse(req.query);
    const events = await db.read(req.principal.tenant, id);
    const steps = projectTrajectory(events, { path: query.path, scope: query.scope });
    await db.audit(req.principal.tenant, req.principal.actor, 'trajectory.read', {
      session: id,
      path: query.path,
      count: steps.length,
      request_id: req.id,
    });
    return { session: id, steps };
  });
  app.get('/v1/tasks/:id/trajectory', async (req) => {
    const { id } = z.object({ id: Key }).parse(req.params);
    await visibleSession(req.principal, id);
    const query = z
      .object({
        path: z.string().min(1).max(500).optional(),
        scope: z.enum(['tree', 'agent']).default('tree'),
      })
      .parse(req.query);
    const events = await db.read(req.principal.tenant, id);
    return {
      session: id,
      steps: projectTrajectory(events, { path: query.path, scope: query.scope }),
    };
  });
  app.get('/v1/tasks/:id/artifacts', async (req) => {
    const { id } = z.object({ id: Key }).parse(req.params);
    await visibleSession(req.principal, id);
    const events = await db.read(req.principal.tenant, id);
    const refs = new Set<string>();
    for (const event of events) {
      const payload = event.payload as any;
      for (const ref of payload?.artifact_refs ?? payload?.artifacts ?? []) {
        if (typeof ref === 'string') refs.add(ref);
        else if (ref?.key) refs.add(String(ref.key));
      }
    }
    const artifacts = [];
    for (const key of refs) {
      const artifact = await db.get(req.principal.tenant, 'artifact', key);
      if (artifact)
        artifacts.push({
          key: artifact.key,
          digest: artifact.digest,
          status: artifact.status,
          created: artifact.created,
        });
    }
    return artifacts;
  });
  app.post('/v1/sessions/:id/trajectory/export', async (req, reply) => {
    const { id } = z.object({ id: Key }).parse(req.params);
    await visibleSession(req.principal, id);
    const body = z
      .object({
        format: z.enum(['json', 'jsonl', 'grpo']).default('jsonl'),
        path: z.string().min(1).max(500).optional(),
        scope: z.enum(['tree', 'agent']).default('tree'),
        group_id: z.string().min(1).max(160).optional(),
      })
      .strict()
      .parse(req.body);
    const events = await db.read(req.principal.tenant, id);
    const options = { path: body.path, scope: body.scope } as const;
    if (body.format === 'grpo' && !body.group_id) throw new Fault(400, 'group_id_required');
    const payload =
      body.format === 'grpo'
        ? exportGRPO(events, { ...options, group_id: body.group_id! })
        : body.format === 'jsonl'
          ? trajectoryJsonl(projectTrajectory(events, options))
          : projectTrajectory(events, options);
    await db.audit(req.principal.tenant, req.principal.actor, 'trajectory.export', {
      session: id,
      format: body.format,
      path: body.path,
      request_id: req.id,
    });
    if (body.format === 'json') return { session: id, steps: payload };
    return reply.type('application/x-ndjson').send(payload);
  });
  app.get('/v1/runs/:id/provenance', async (req) => {
    const { id } = z.object({ id: Key }).parse(req.params);
    await visibleSession(req.principal, id);
    const events = (await db.read(req.principal.tenant, id)).filter(
      (e: any) => e.type === 'run.provenance',
    );
    await db.audit(req.principal.tenant, req.principal.actor, 'provenance.read', {
      session: id,
      request_id: req.id,
    });
    const provenance = events.map((e: any) => ({ path: e.path, seq: e.seq, payload: e.payload }));
    const latest = provenance.at(-1)?.payload as Record<string, unknown> | undefined;
    const manifest = latest
      ? {
          release_artifact_hash: latest.release_artifact_hash,
          loop: latest.loop,
          spec_hash: latest.spec_digest,
          skill_hashes: latest.skill_hashes ?? [],
          model_versions: latest.model_versions ?? {},
          replay_mode: latest.replay_mode ?? 'strict',
        }
      : undefined;
    return {
      session: id,
      checkpoint: await db.verify(req.principal.tenant, id),
      manifest,
      provenance,
    };
  });
  app.post('/v1/sessions/:id/integrity', async (req) => {
    const { id } = z.object({ id: Key }).parse(req.params);
    await visibleSession(req.principal, id);
    const checkpoint = z
      .object({
        seq: z.number().int().nonnegative(),
        head: z.string().regex(/^(?:[a-f0-9]{64})?$/),
        signature: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict()
      .parse(req.body);
    return await db.verify(req.principal.tenant, id, checkpoint);
  });
  app.get('/v1/audit', async (req) => {
    requireRole(req.principal, 'reviewer');
    const page = Page.parse(req.query);
    return db.read(req.principal.tenant, '_audit', page.offset, page.limit);
  });
  app.post('/v1/tokens/revoke', async (req) => {
    requireRole(req.principal, 'admin');
    const body = z
      .object({ hash: z.string().regex(/^[a-f0-9]{64}$/), reason: Reason })
      .strict()
      .parse(req.body);
    const target = config.tokens.find(
      (t) => t.hash === body.hash && t.tenant === req.principal.tenant,
    );
    if (!target) throw new Fault(404, 'token_not_found');
    await db.revoke(body.hash);
    await db.audit(req.principal.tenant, req.principal.actor, 'token.revoked', {
      actor: target.actor,
      reason: body.reason,
    });
    return { revoked: true };
  });
  app.get('/v1/metrics', async (req) => {
    requireRole(req.principal, 'admin');
    return {
      jobs: await db.jobCounts(req.principal.tenant),
      storage: await db.capacity(),
      release: config.releaseId,
      build: BUILD_ID,
    };
  });
  app.addHook('onClose', async () => {
    await service.close();
    if (managedQueue && managedQueue !== options.asyncJobs && 'close' in managedQueue)
      await (managedQueue as { close: () => Promise<void> }).close();
    await db.close();
  });
  if (options.worker !== false) service.start();
  return { app, db, service, objectStore };
}
