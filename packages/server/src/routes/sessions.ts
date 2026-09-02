import type { FastifyInstance } from 'fastify';
import type { TraceStore } from '@veridical/store';
import {
  TraceProjection,
  projectTrajectory,
  projectInvocations,
  trajectoryJsonl,
  exportGRPO,
  trajectoryHtml,
  ReplayEngine,
  type ReplayPlan,
} from '@veridical/replay';
import { z } from 'zod';
import { resolveTools } from '../providers.js';

const TrajectoryQuery = z
  .object({ path: z.string().max(1024).optional(), scope: z.enum(['tree', 'agent']).optional() })
  .strict();
const ExportOptions = TrajectoryQuery.extend({
  format: z.enum(['json', 'jsonl', 'grpo']).default('jsonl'),
  group_id: z.string().min(1).max(200).optional(),
  rewards: z.record(z.number().finite()).optional(),
}).strict();
const ReplayRequest = z
  .object({
    mode: z.enum(['strict', 'fixture', 'semantic']),
    target_invocation_id: z.string().min(1).max(256).optional(),
    target_path: z.string().min(1).max(1024).optional(),
    target_scope: z.enum(['invocation', 'subtree', 'agent']).default('subtree').optional(),
    downgrade_reason: z.string().min(1).max(2000).optional(),
    spec: z.object({ name: z.string().min(1), version: z.string().optional() }).optional(),
    invocation_fixtures: z
      .array(
        z
          .object({
            path: z.string().min(1),
            operation: z.string().min(1),
            fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
            attempt: z.number().int().positive().optional(),
            source: z.string().min(1),
            version: z.string().min(1),
            output: z.unknown(),
            hash: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .strict(),
      )
      .max(1000)
      .optional(),
    semantic: z
      .object({
        expected_outcome: z.unknown().optional(),
        required_tools: z.array(z.string()).optional(),
        forbidden_tools: z.array(z.string()).optional(),
        completed_agents: z.array(z.string()).optional(),
        completed_stages: z.array(z.string()).optional(),
        max_steps: z.number().nonnegative().optional(),
        max_tokens: z.number().nonnegative().optional(),
        max_cost: z.number().nonnegative().optional(),
        max_duration_ms: z.number().nonnegative().optional(),
        golden: z.object({ outcome: z.unknown() }).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((value) => !(value.target_path && value.target_invocation_id), {
    message: 'choose target_path or target_invocation_id, not both',
  })
  ;

interface SessionSummary {
  session_id: string;
  spec_version: string;
  event_count: number;
  total_tokens?: { input: number; output: number; cached: number; total: number };
  total_duration_ms: number;
  first_seq: number;
  last_seq: number;
  spec_name?: string;
  turn_count?: number;
  first_message?: string;
}

export async function listSessions(store: TraceStore): Promise<SessionSummary[]> {
  const { readdirSync, existsSync } = await import('node:fs');
  const { join } = await import('node:path');
  const dir = (store as any).dir as string;
  if (!existsSync(dir)) return [];
  const out: SessionSummary[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.jsonl')) continue;
    const id = f.slice(0, -'.jsonl'.length);
    let events;
    try {
      events = await store.readBySession(id);
    } catch (err) {
      console.warn(`skipping malformed session file ${f}: ${err}`);
      continue;
    }
    if (events.length === 0) continue;
    const tokens = events.reduce(
      (acc, e) => {
        if (e.tokens) {
          acc.input += e.tokens.input;
          acc.output += e.tokens.output;
          acc.cached += e.tokens.cached;
          acc.total += e.tokens.total;
        }
        return acc;
      },
      { input: 0, output: 0, cached: 0, total: 0 },
    );
    const turnCount = events.filter((e) => e.type === 'turn/start').length;
    const startEvt = [...events].find((e) => e.type === 'spec/run/start');
    const firstMsg = [...events].find((e) => e.type === 'user.message');
    out.push({
      session_id: id,
      spec_version: events[0]?.spec_version ?? '',
      spec_name: (startEvt?.payload as { spec_name?: string } | undefined)?.spec_name,
      event_count: events.length,
      total_tokens: tokens.total > 0 ? tokens : undefined,
      total_duration_ms: events.reduce((s, e) => s + e.duration_ms, 0),
      first_seq: events[0]?.seq ?? 0,
      last_seq: events[events.length - 1]?.seq ?? 0,
      turn_count: turnCount,
      first_message:
        typeof (firstMsg?.payload as { text?: unknown } | undefined)?.text === 'string'
          ? (firstMsg?.payload as { text: string }).text.slice(0, 40)
          : '',
    });
  }
  return out.sort((a, b) => b.last_seq - a.last_seq);
}

export async function registerSessionsRoutes(app: FastifyInstance) {
  const store = app.store as TraceStore;

  app.get('/api/sessions', async () => listSessions(store));

  app.get<{ Params: { id: string } }>('/api/agents/:id/tasks', async (req) =>
    (await listSessions(store)).filter((session) => session.spec_name === req.params.id),
  );

  app.post<{ Params: { id: string } }>('/api/agents/:id/tasks', async (req) => ({
    id: 'new',
    agent_id: req.params.id,
    status: 'ready',
  }));

  app.get<{ Params: { id: string } }>('/api/sessions/:id', async (req, reply) => {
    try {
      const events = await store.readBySession(req.params.id);
      if (events.length === 0)
        return reply
          .code(404)
          .send({ error: { code: 'not_found', message: `session ${req.params.id} not found` } });
      return events;
    } catch (err) {
      return reply.code(500).send({ error: { code: 'trace_corrupt', message: String(err) } });
    }
  });

  app.get<{ Params: { id: string } }>('/api/tasks/:id', async (req, reply) => {
    const events = await store.readBySession(req.params.id).catch(() => []);
    if (!events.length) return reply.code(404).send({ error: { code: 'not_found' } });
    return { id: req.params.id, status: 'completed', events };
  });

  app.get<{ Params: { id: string } }>('/api/tasks/:id/artifacts', async (req) => {
    const events = await store.readBySession(req.params.id).catch(() => []);
    return events
      .filter((event) => ['artifact.created', 'artifact.output'].includes(event.type))
      .map((event) => event.payload);
  });

  app.post<{ Params: { id: string }; Body: { targetSeq?: number; mode?: string } }>(
    '/api/sessions/:id/replay',
    async (req, reply) => {
      try {
        const events = await store.readBySession(req.params.id);
        if (!events.length) return reply.code(404).send({ error: { code: 'not_found' } });
        if (req.body?.mode) {
          const body = ReplayRequest.parse(req.body);
          const snapshots = events
            .filter((e) => e.type === 'run.provenance')
            .map(
              (e) =>
                e.payload as {
                  spec?: { name: string; version: string; tools: { name: string }[] };
                },
            );
          const spec = body.spec ?? snapshots[0]?.spec;
          if (!spec) return reply.code(422).send({ error: { code: 'replay_legacy_trace' } });
          const names = [
            ...new Set(snapshots.flatMap((p) => p.spec?.tools.map((t) => t.name) ?? [])),
          ];
          return await new ReplayEngine(store, app.specRegistry).replay(
            req.params.id,
            { ...body, spec } as ReplayPlan,
            resolveTools(names),
          );
        }
        z.object({ targetSeq: z.number().int().nonnegative().optional() })
          .strict()
          .parse(req.body ?? {});
        const projection = new TraceProjection(store);
        const target = req.body?.targetSeq ?? (await store.readBySession(req.params.id)).length;
        return await projection.projectAt(req.params.id, target);
      } catch (err) {
        return reply.code(err instanceof z.ZodError ? 400 : 409).send({
          error: {
            code: (err as { code?: string }).code ?? 'replay_failed',
            message: String(err),
          },
        });
      }
    },
  );

  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/api/tasks/:id/replay',
    async (req, reply) => {
      const result = await app.inject({
        method: 'POST',
        url: `/api/sessions/${encodeURIComponent(req.params.id)}/replay`,
        payload: req.body,
      });
      return reply.code(result.statusCode).headers(result.headers).send(result.rawPayload);
    },
  );

  app.get<{ Params: { id: string } }>('/api/sessions/:id/invocations', async (req, reply) => {
    const events = await store.readBySession(req.params.id);
    if (events.length === 0) return reply.code(404).send({ error: { code: 'not_found' } });
    return {
      legacy: !events.some((e) => e.type === 'invocation.start'),
      invocations: projectInvocations(events),
    };
  });

  app.get<{ Params: { id: string } }>('/api/tasks/:id/invocations', async (req, reply) => {
    const events = await store.readBySession(req.params.id);
    if (!events.length) return reply.code(404).send({ error: { code: 'not_found' } });
    return {
      legacy: !events.some((event) => event.type === 'invocation.start'),
      invocations: projectInvocations(events),
    };
  });

  app.get<{ Params: { id: string } }>('/api/sessions/:id/trajectory', async (req, reply) => {
    const events = await store.readBySession(req.params.id);
    if (events.length === 0) return reply.code(404).send({ error: { code: 'not_found' } });
    const query = TrajectoryQuery.safeParse(req.query);
    if (!query.success)
      return reply.code(400).send({ error: { code: 'invalid_trajectory_query' } });
    return projectTrajectory(events, query.data);
  });

  app.get<{ Params: { id: string } }>('/api/sessions/:id/trace.html', async (req, reply) => {
    const events = await store.readBySession(req.params.id);
    if (!events.length) return reply.code(404).send({ error: { code: 'not_found' } });
    reply.header('content-type', 'text/html; charset=utf-8');
    return reply.send(trajectoryHtml(events));
  });

  app.post<{ Params: { id: string } }>(
    '/api/sessions/:id/trajectory/export',
    async (req, reply) => {
      const events = await store.readBySession(req.params.id);
      if (events.length === 0) return reply.code(404).send({ error: { code: 'not_found' } });
      try {
        const body = ExportOptions.parse(req.body ?? {});
        if (body.format === 'json') return projectTrajectory(events, body);
        const output =
          body.format === 'grpo'
            ? exportGRPO(events, { ...body, group_id: body.group_id ?? '' })
            : trajectoryJsonl(projectTrajectory(events, body));
        reply.header('content-type', 'application/x-ndjson');
        return reply.send(output);
      } catch (error) {
        return reply.code(400).send({
          error: {
            code: (error as { code?: string }).code ?? 'invalid_export',
            message: String(error),
          },
        });
      }
    },
  );

  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/api/tasks/:id/trajectory/export',
    async (req, reply) => {
      const result = await app.inject({
        method: 'POST',
        url: `/api/sessions/${encodeURIComponent(req.params.id)}/trajectory/export`,
        payload: req.body,
      });
      return reply.code(result.statusCode).headers(result.headers).send(result.rawPayload);
    },
  );
}
