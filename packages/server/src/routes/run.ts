import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { parseSpecYaml, runSpec, type SpecRunnerDeps } from '@veridical/spec';
import { OpenAICompatibleProvider, MockScriptedProvider, resolveTools } from '../providers.js';
import { makeDecisionRunStep } from '../runStep.js';
import { createLocalModel, localModelMetadata } from '../local-model.js';

interface RunBody {
  specYaml: string;
  mode: 'mock' | 'live';
  script?: string[];
  provider?: string;
  model?: string;
  apiKey?: string;
  prompt?: string;
}

export async function registerRunRoutes(app: FastifyInstance) {
  const store = app.store;
  app.get('/api/model-profile', async () => localModelMetadata());
  app.post<{ Body: RunBody }>('/api/run', async (req, reply) => {
    const body = req.body;
    if (!body?.specYaml) return reply.code(400).send({ error: { code: 'bad_request', message: 'specYaml required' } });
    let spec;
    try {
      spec = parseSpecYaml(body.specYaml);
    } catch (e) {
      return reply.code(400).send({ error: { code: 'invalid_spec', message: String(e) } });
    }
    const sessionId = `run_${randomUUID()}`;
    const providers = new Map<string, any>();
    if (body.mode === 'live') {
      if (body.apiKey && body.model) {
        spec.llm.model = body.model;
        providers.set(spec.llm.provider, new OpenAICompatibleProvider('https://api.openai.com/v1', body.apiKey, body.model));
      } else {
        try {
          const local = createLocalModel();
          spec.llm.model = local.model;
          spec.llm.provider = 'local';
          spec.llm.fallback = [];
          providers.set('local', local.provider);
        } catch {
          return reply.code(400).send({ error: { code: 'model_not_configured', message: '请检查服务端 .env.local 模型配置并重启研究服务' } });
        }
      }
    } else {
      const mock = new MockScriptedProvider();
      (body.script ?? [`${JSON.stringify({ text: 'done', done: true })}`]).forEach((s) => mock.enqueue(s));
      providers.set(spec.llm.provider, mock);
    }

    // SSE headers - hijack to keep connection open for streaming
    reply.hijack();
    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache');
    reply.raw.setHeader('Connection', 'keep-alive');
    // @ts-ignore flushHeaders may not exist in types but exists at runtime
    reply.raw.flushHeaders?.();

    const send = (obj: unknown) => {
      if (reply.raw.writableEnded) return;
      try {
        reply.raw.write(`data: ${JSON.stringify(obj)}\n\n`);
      } catch {
        // ignore write after close
      }
    };

    // Polling loop: every 150ms emit new events whose seq > lastSeq
    let lastSeq = 0;
    const poll = setInterval(async () => {
      if (reply.raw.writableEnded) return;
      try {
        const evs = await store.readBySession(sessionId);
        // Emit seq-delta events (spec describes this behavior)
        for (const ev of evs) {
          const seq = (ev as any).seq ?? 0;
          if (seq > lastSeq) {
            send({ type: 'event', event: ev, count: evs.length });
            lastSeq = seq;
          }
        }
        // Also emit legacy progress count for brief compatibility (no-op if events already emitted)
        // Intentionally not emitting duplicate progress to reduce noise; but keep polling alive
      } catch {
        // ignore poll errors
      }
    }, 150);
    const clearPoll = () => clearInterval(poll);
    req.raw.on('close', clearPoll);
    reply.raw.on('close', clearPoll);

    const deps: SpecRunnerDeps = {
      store,
      providers,
      tools: resolveTools(spec.tools.map((t) => t.name)),
      tenant_id: 't1',
      session_id: sessionId,
      runStep: makeDecisionRunStep(),
      childRunStep: makeDecisionRunStep(),
      registry: app.specRegistry,
    };

    try {
      const result = await runSpec(deps, spec, body.prompt ?? 'hello');
      clearInterval(poll);
      const final = await store.readBySession(sessionId);
      // Emit any remaining events not yet streamed
      for (const ev of final) {
        const seq = (ev as any).seq ?? 0;
        if (seq > lastSeq) {
          send({ type: 'event', event: ev, count: final.length });
          lastSeq = seq;
        }
      }
      send({ type: 'done', session_id: sessionId, event_count: final.length, outcome: result.outcome });
    } catch (e) {
      clearInterval(poll);
      send({ type: 'error', message: String(e) });
    } finally {
      clearInterval(poll);
      try {
        reply.raw.end();
      } catch {
        // already closed
      }
    }
  });
}
