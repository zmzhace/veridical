import type { FastifyInstance } from 'fastify';
import type { TraceStore } from '@veridical/store';
import { TraceProjection } from '@veridical/replay';

interface SessionSummary {
  session_id: string;
  spec_version: string;
  event_count: number;
  total_tokens?: { input: number; output: number; cached: number; total: number };
  total_duration_ms: number;
  first_seq: number;
  last_seq: number;
}

async function listSessions(store: TraceStore): Promise<SessionSummary[]> {
  const { readdirSync, existsSync } = await import('node:fs');
  const { join } = await import('node:path');
  const dir = (store as any).dir as string;
  if (!existsSync(dir)) return [];
  const out: SessionSummary[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.jsonl')) continue;
    const id = f.slice(0, -'.jsonl'.length);
    const events = await store.readBySession(id);
    if (events.length === 0) continue;
    const tokens = events.reduce((acc, e) => {
      if (e.tokens) { acc.input += e.tokens.input; acc.output += e.tokens.output; acc.cached += e.tokens.cached; acc.total += e.tokens.total; }
      return acc;
    }, { input: 0, output: 0, cached: 0, total: 0 });
    out.push({
      session_id: id,
      spec_version: events[0]?.spec_version ?? '',
      event_count: events.length,
      total_tokens: tokens.total > 0 ? tokens : undefined,
      total_duration_ms: events.reduce((s, e) => s + e.duration_ms, 0),
      first_seq: events[0]?.seq ?? 0,
      last_seq: events[events.length - 1]?.seq ?? 0,
    });
  }
  return out.sort((a, b) => b.last_seq - a.last_seq);
}

export async function registerSessionsRoutes(app: FastifyInstance) {
  const store = app.store as TraceStore;

  app.get('/api/sessions', async () => listSessions(store));

  app.get<{ Params: { id: string } }>('/api/sessions/:id', async (req, reply) => {
    const events = await store.readBySession(req.params.id);
    if (events.length === 0) return reply.code(404).send({ error: { code: 'not_found', message: `session ${req.params.id} not found` } });
    return events;
  });

  app.post<{ Params: { id: string }; Body: { targetSeq?: number } }>('/api/sessions/:id/replay', async (req) => {
    const projection = new TraceProjection(store);
    const target = req.body?.targetSeq ?? (await store.readBySession(req.params.id)).length;
    return projection.projectAt(req.params.id, target);
  });
}
