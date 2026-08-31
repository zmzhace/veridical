import Fastify from 'fastify';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { LLMProvider } from '@veridical/llm';
import { Ledger } from './database';
import { Fault, Key, requireRole, tokenDigest, type Principal, type Job } from './contracts';
import { ProductionConfigSchema, type ProductionConfig } from './config';
import { ProductionService } from './service';
import { SecureProvider, type ProductionTool } from './runner';
import { BUILD_ID } from './build';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { resolveCredential } from './credentials';
import type { AsyncJobStore, JobStore } from './job-store';
import { RedisJobQueue } from './redis-queue';
import { buildLedger, buildObjectStore } from './storage';

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
  jobs?: JobStore;
  asyncJobs?: AsyncJobStore;
  worker?: boolean;
  logger?: boolean;
}) {
  const config = ProductionConfigSchema.parse(options.config);
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
  const objectStore = buildObjectStore(config);
  const service = new ProductionService(
    db as any,
    config,
    providers,
    options.tools,
    options.jobs,
    managedQueue,
    objectStore,
  );
  const oidcKeys = config.oidc ? createRemoteJWKSet(new URL(config.oidc.jwksUrl)) : undefined;
  const app = Fastify({
    bodyLimit: 65536,
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
    if (
      found &&
      Date.parse(found.expires) > Date.now() &&
      !(db.isRevoked ? await db.isRevoked(hash) : !!db.sql.prepare('SELECT hash FROM revoked_tokens WHERE hash=?').get(hash))
    ) {
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
    if (!(await (db as any).rate(`actor:${principal.tenant}:${principal.actor}`, config.requestsPerMinute)))
      throw new Fault(429, 'rate_limited');
  });
  app.setErrorHandler((error, req, reply) => {
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
        db.audit(req.principal.tenant, req.principal.actor, 'access.denied', {
          request_id: req.id,
          route: req.routeOptions.url,
          code: error instanceof Fault ? error.code : 'forbidden',
        });
      } catch {
        service.healthy = false;
      }
    }
    if (status >= 500)
      req.log.error({ requestId: req.id, code: 'internal_error' }, 'request failed');
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
  app.get('/v1/specs', async (req) => {
    requireRole(req.principal, 'viewer', 'developer', 'reviewer', 'publisher');
    const page = Page.parse(req.query);
    return db.list(req.principal.tenant, 'spec', page.limit, page.offset);
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
        session: Key.optional(),
      })
      .strict()
      .parse(req.body);
    return reply.code(202).send(jobView(await service.run(req.principal, body, idem(req.headers))));
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
  const visibleSession = (p: Principal, id: string) => {
    requireRole(p, 'viewer', 'operator', 'reviewer');
    const session = db.session(p.tenant, id);
    if (
      !session ||
      session.kind === 'audit' ||
      (session.kind !== 'run' && !p.roles.includes('reviewer') && !p.roles.includes('admin'))
    )
      throw new Fault(404, 'session_not_found');
  };
  app.get('/v1/sessions/:id/events', async (req) => {
    const { id } = z.object({ id: Key }).parse(req.params);
    visibleSession(req.principal, id);
    const query = z
      .object({
        after: z.coerce.number().int().min(0).default(0),
        limit: z.coerce.number().int().min(1).max(500).default(100),
      })
      .parse(req.query);
    const events = await db.read(req.principal.tenant, id, query.after, query.limit);
    db.audit(req.principal.tenant, req.principal.actor, 'trace.read', {
      session: id,
      after: query.after,
      limit: query.limit,
      request_id: req.id,
    });
    return events;
  });
  app.get('/v1/sessions/:id/integrity', async (req) => {
    const { id } = z.object({ id: Key }).parse(req.params);
    visibleSession(req.principal, id);
    return db.verify(req.principal.tenant, id);
  });
  app.get('/v1/runs/:id/provenance', async (req) => {
    const { id } = z.object({ id: Key }).parse(req.params);
    visibleSession(req.principal, id);
    const events = (await db.read(req.principal.tenant, id)).filter((e: any) => e.type === 'run.provenance');
    db.audit(req.principal.tenant, req.principal.actor, 'provenance.read', {
      session: id,
      request_id: req.id,
    });
    return {
      session: id,
      checkpoint: await db.verify(req.principal.tenant, id),
      provenance: events.map((e: any) => ({ path: e.path, seq: e.seq, payload: e.payload })),
    };
  });
  app.post('/v1/sessions/:id/integrity', async (req) => {
    const { id } = z.object({ id: Key }).parse(req.params);
    visibleSession(req.principal, id);
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
    if (db.revoke) await db.revoke(body.hash);
    else db.tx(() => db.sql.prepare('INSERT OR IGNORE INTO revoked_tokens VALUES (?)').run(body.hash));
    await db.audit(req.principal.tenant, req.principal.actor, 'token.revoked', {
      actor: target.actor,
      reason: body.reason,
    });
    return { revoked: true };
  });
  app.get('/v1/metrics', async (req) => {
    requireRole(req.principal, 'admin');
    return {
      jobs: db.jobCounts ? await db.jobCounts(req.principal.tenant) : db.sql.prepare('SELECT state,COUNT(*) count FROM jobs WHERE tenant=? GROUP BY state').all(req.principal.tenant),
      storage: await db.capacity(),
      release: config.releaseId,
      build: BUILD_ID,
    };
  });
  app.addHook('onClose', async () => {
    await service.close();
    if (managedQueue && managedQueue !== options.asyncJobs && 'close' in managedQueue)
      await (managedQueue as { close: () => Promise<void> }).close();
    db.close();
  });
  if (options.worker !== false) service.start();
  return { app, db, service, objectStore };
}
