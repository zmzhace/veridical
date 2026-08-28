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
  worker?: boolean;
  logger?: boolean;
}) {
  const config = ProductionConfigSchema.parse(options.config);
  const providers =
    options.providers ??
    new Map(
      config.providers.map((p) => {
        const key = process.env[p.apiKeyEnv];
        if (!key) throw new Error(`provider credential required in ${p.apiKeyEnv}`);
        return [
          p.name,
          new SecureProvider(p.baseUrl, key, p.model, { enableThinking: p.enableThinking }),
        ];
      }),
    );
  for (const provider of config.providers)
    if (!providers.has(provider.name)) throw new Error('provider not configured');
  const db = new Ledger(config.database, options.dataKey, options.auditKey);
  const service = new ProductionService(db, config, providers, options.tools);
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
    if (!db.rate(`ip:${req.ip}`, config.requestsPerMinute * 4))
      throw new Fault(429, 'rate_limited');
    const auth = req.headers.authorization;
    if (!auth?.startsWith('Bearer ') || auth.length < 39 || auth.length > 512)
      throw new Fault(401, 'authentication_required');
    const hash = tokenDigest(auth.slice(7));
    const found = config.tokens.find((t) =>
      timingSafeEqual(Buffer.from(t.hash, 'hex'), Buffer.from(hash, 'hex')),
    );
    if (
      !found ||
      Date.parse(found.expires) <= Date.now() ||
      db.sql.prepare('SELECT hash FROM revoked_tokens WHERE hash=?').get(hash)
    )
      throw new Fault(401, 'invalid_credentials');
    req.principal = {
      tenant: found.tenant,
      actor: found.actor,
      roles: found.roles,
      tokenHash: hash,
    };
    if (!db.rate(`actor:${found.tenant}:${found.actor}`, config.requestsPerMinute))
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
    service.checkCapacity();
    db.sql.prepare('SELECT 1').get();
    return { ok: true, release: config.releaseId, build: BUILD_ID };
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
    return reply.code(201).send(service.createSpec(req.principal, body.yaml));
  });
  app.post('/v1/suites/:name', async (req, reply) => {
    const { name } = z.object({ name: Key }).parse(req.params);
    return reply.code(201).send(service.setSuite(req.principal, name, req.body));
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
      .send(jobView(service.evaluate(req.principal, body.ref, idem(req.headers))));
  });
  app.post('/v1/approvals', async (req) => {
    const body = z.object({ ref: Ref, reason: Reason }).strict().parse(req.body);
    return service.approve(req.principal, body.ref, body.reason);
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
    return service.deploy(req.principal, name, body.ref, body.channel, body.reason);
  });
  app.post('/v1/revocations', async (req) => {
    const body = z.object({ ref: Ref, reason: Reason }).strict().parse(req.body);
    return service.revoke(req.principal, body.ref, body.reason);
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
    return reply.code(202).send(jobView(service.run(req.principal, body, idem(req.headers))));
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
          service.improve(req.principal, body.name, body.version, body.feedback, idem(req.headers)),
        ),
      );
  });
  app.post('/v1/replays', async (req, reply) => {
    const body = z.object({ session: Key }).strict().parse(req.body);
    return reply
      .code(202)
      .send(jobView(service.replay(req.principal, body.session, idem(req.headers))));
  });
  app.post('/v1/replay', async (req, reply) => {
    const body = z
      .object({ session: Key, mode: z.literal('strict').default('strict') })
      .strict()
      .parse(req.body);
    return reply
      .code(202)
      .send(jobView(service.replay(req.principal, body.session, idem(req.headers))));
  });
  app.get('/v1/jobs/:id', async (req) => {
    requireRole(req.principal, 'viewer', 'operator', 'developer', 'reviewer');
    const { id } = z.object({ id: Key }).parse(req.params);
    const job = db.job(req.principal.tenant, id);
    if (!job) throw new Fault(404, 'job_not_found');
    return jobView(job);
  });
  app.post('/v1/jobs/:id/cancel', async (req) => {
    const { id } = z.object({ id: Key }).parse(req.params);
    return jobView(service.cancel(req.principal, id));
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
    const events = db.read(req.principal.tenant, id, query.after, query.limit);
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
    const events = db.read(req.principal.tenant, id).filter((e) => e.type === 'run.provenance');
    db.audit(req.principal.tenant, req.principal.actor, 'provenance.read', {
      session: id,
      request_id: req.id,
    });
    return {
      session: id,
      checkpoint: db.verify(req.principal.tenant, id),
      provenance: events.map((e) => ({ path: e.path, seq: e.seq, payload: e.payload })),
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
    return db.verify(req.principal.tenant, id, checkpoint);
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
    db.tx(() => {
      db.sql.prepare('INSERT OR IGNORE INTO revoked_tokens VALUES (?)').run(body.hash);
      db.audit(req.principal.tenant, req.principal.actor, 'token.revoked', {
        actor: target.actor,
        reason: body.reason,
      });
    });
    return { revoked: true };
  });
  app.get('/v1/metrics', async (req) => {
    requireRole(req.principal, 'admin');
    return {
      jobs: db.sql
        .prepare('SELECT state,COUNT(*) count FROM jobs WHERE tenant=? GROUP BY state')
        .all(req.principal.tenant),
      storage: db.capacity(),
      release: config.releaseId,
      build: BUILD_ID,
    };
  });
  app.addHook('onClose', async () => {
    await service.close();
    db.close();
  });
  if (options.worker !== false) service.start();
  return { app, db, service };
}
