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
  spec_name?: string;
  turn_count?: number;
  first_message?: string;
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
    let events;
    try {
      events = await store.readBySession(id);
    } catch (err) {
      console.warn(`skipping malformed session file ${f}: ${err}`);
      continue;
    }
    if (events.length === 0) continue;
    const tokens = events.reduce((acc, e) => {
      if (e.tokens) { acc.input += e.tokens.input; acc.output += e.tokens.output; acc.cached += e.tokens.cached; acc.total += e.tokens.total; }
      return acc;
    }, { input: 0, output: 0, cached: 0, total: 0 });
    const turnCount = events.filter(e => e.type === 'turn/start').length;
    const startEvt = [...events].find(e => e.type === 'spec/run/start');
    const firstMsg = [...events].find(e => e.type === 'user.message');
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
      first_message: typeof (firstMsg?.payload as { text?: unknown } | undefined)?.text === 'string' ? ((firstMsg?.payload as { text: string }).text).slice(0, 40) : '',
    });
  }
  return out.sort((a, b) => b.last_seq - a.last_seq);
}

export async function registerSessionsRoutes(app: FastifyInstance) {
  const store = app.store as TraceStore;

  app.get('/api/sessions', async () => listSessions(store));

  app.get<{ Params: { id: string } }>('/api/sessions/:id', async (req, reply) => {
    try {
      const events = await store.readBySession(req.params.id);
      if (events.length === 0) return reply.code(404).send({ error: { code: 'not_found', message: `session ${req.params.id} not found` } });
      return events;
    } catch (err) {
      return reply.code(500).send({ error: { code: 'trace_corrupt', message: String(err) } });
    }
  });

  app.post<{ Params: { id: string }; Body: { targetSeq?: number } }>('/api/sessions/:id/replay', async (req, reply) => {
    try {
      const projection = new TraceProjection(store);
      const target = req.body?.targetSeq ?? (await store.readBySession(req.params.id)).length;
      return await projection.projectAt(req.params.id, target);
    } catch (err) {
      return reply.code(500).send({ error: { code: 'trace_corrupt', message: String(err) } });
    }
  });
}
