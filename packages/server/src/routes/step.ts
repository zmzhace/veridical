import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { parseSpecYaml, runSpec, type SpecRunnerDeps } from '@veridical/spec';
import { resolveTools } from '../providers.js';

const pendingSteps = new Map<string, () => void>();

interface StepBody { specYaml: string; prompt?: string; script?: string[]; mode?: 'mock' | 'live' }
interface ContinueBody { sessionId: string }

export async function registerStepRoutes(app: FastifyInstance) {
  const store = app.store;

  app.get<{ Params: { id: string } }>('/api/sessions/:id/checkpoints', async (req, reply) => {
    try {
      const events = await store.readBySession(req.params.id);
      return events.filter(e => e.type === 'state.checkpoint').sort((a, b) => a.seq - b.seq);
    } catch (err) {
      return reply.code(500).send({ error: { code: 'trace_corrupt', message: String(err) } });
    }
  });

  app.post<{ Body: StepBody }>('/api/run/step', async (req, reply) => {
    const b = req.body;
    if (!b?.specYaml) return reply.code(400).send({ error: { code: 'bad_request', message: 'specYaml required' } });
    if (b.mode === 'live') return reply.code(400).send({ error: { code: 'bad_request', message: 'step mode only supports mock' } });
    let spec;
    try { spec = parseSpecYaml(b.specYaml); } catch (e) { return reply.code(400).send({ error: { code: 'invalid_spec', message: String(e) } }); }
    const sessionId = `step_${randomUUID()}`;
    const providers = new Map([['mock', { complete: async () => ({ text: '', usage: { input: 1, output: 1, cached: 0, total: 2 } }) }]]);

    reply.hijack();
    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache');
    reply.raw.setHeader('Connection', 'keep-alive');
    // @ts-ignore
    reply.raw.flushHeaders?.();
    const send = (obj: unknown) => { if (reply.raw.writableEnded) return; try { reply.raw.write(`data: ${JSON.stringify(obj)}\n\n`); } catch {} };
    const aborted = { value: false };
    const abort = () => {
      aborted.value = true;
      const fn = pendingSteps.get(sessionId);
      if (fn) { pendingSteps.delete(sessionId); fn(); }
      try { reply.raw.end(); } catch {}
    };
    // IMPORTANT: use reply.raw 'close' (real client disconnect). req.raw 'close' fires as
    // soon as the POST body is received — that would abort the step run immediately.
    // On client disconnect, release the pending gate so runSpec completes/cleans up.
    reply.raw.on('close', abort);

    const script = b.script?.[0] ?? JSON.stringify({ text: 'done', done: true });
    const stepBoundary = () => new Promise<void>((resolve) => {
      if (aborted.value) { resolve(); return; }
      pendingSteps.set(sessionId, resolve);
    });

    const deps: SpecRunnerDeps = {
      store,
      providers,
      tools: resolveTools(spec.tools.map(t => t.name)),
      tenant_id: 't1',
      session_id: sessionId,
      stepBoundary,
      runStep: async () => {
        const raw = JSON.parse(script);
        return { text: raw.text ?? script, tool: raw.tool };
      },
    };

    try {
      const result = await runSpec(deps, spec, b.prompt ?? 'hello');
      const events = await store.readBySession(sessionId);
      send({ type: 'done', session_id: sessionId, event_count: events.length, outcome: result.outcome });
    } catch (e) {
      send({ type: 'error', message: String(e) });
    } finally {
      pendingSteps.delete(sessionId);
      abort();
    }
  });

  app.post<{ Body: ContinueBody }>('/api/run/step/continue', async (req, reply) => {
    const fn = pendingSteps.get(req.body?.sessionId ?? '');
    if (!fn) return reply.code(404).send({ error: { code: 'not_found', message: 'no pending step for session' } });
    pendingSteps.delete(req.body.sessionId);
    fn();
    return { ok: true };
  });
}
