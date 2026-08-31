import Fastify from 'fastify';
import cors from '@fastify/cors';
import { JsonlTraceStore } from '@veridical/store';
import type { TraceStore } from '@veridical/store';
import { JsonlSpecRegistry } from '@veridical/spec';
import type { SpecRegistry } from '@veridical/spec';
import { CONFIG } from './config.js';
import { registerSessionsRoutes } from './routes/sessions.js';
import { registerRunRoutes } from './routes/run.js';
import { registerSpecRoutes } from './routes/specs.js';
import { registerEvalRoutes } from './routes/eval.js';
import { registerCompareRoutes } from './routes/compare.js';
import { registerStepRoutes } from './routes/step.js';
import { registerTurnRoutes } from './routes/turn.js';
import { registerSkillRoutes } from './routes/skills.js';
import { registerAgentRoutes } from './routes/agents.js';
import { registerCapabilityRoutes } from './routes/capabilities.js';
import { registerMemoryRoutes } from './routes/memories.js';
import { registerKnowledgeRoutes } from './routes/knowledge.js';
import { registerOrganizationRoutes } from './routes/organizations.js';
import { localModelMetadata } from './local-model.js';

declare module 'fastify' {
  interface FastifyInstance {
    store: TraceStore;
    specRegistry: SpecRegistry;
  }
}

export async function buildApp(tracesDir?: string, specsDir?: string) {
  const app = Fastify({ logger: false });
  // Local credentials must not be spendable by an arbitrary website via CORS.
  app.addHook('onRequest', async (request, reply) => {
    const origin = request.headers.origin;
    if (!origin) return;
    try {
      const url = new URL(origin);
      if (['http:', 'https:'].includes(url.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return;
    } catch { /* reject malformed and opaque origins */ }
    return reply.code(403).send({ error: { code: 'origin_not_allowed', message: 'Local research console only' } });
  });
  await app.register(cors);
  app.decorate('store', new JsonlTraceStore(tracesDir ?? CONFIG.tracesDir));
  app.decorate('specRegistry', new JsonlSpecRegistry(specsDir ?? CONFIG.specsDir));
  await app.register(registerSessionsRoutes);
  await app.register(registerRunRoutes);
  await app.register(registerSpecRoutes);
  await app.register(registerEvalRoutes);
  await app.register(registerCompareRoutes);
  await app.register(registerStepRoutes);
  await app.register(registerTurnRoutes);
  await app.register(registerSkillRoutes, { dataDir: specsDir ?? CONFIG.specsDir });
  await registerAgentRoutes(app, specsDir ?? CONFIG.specsDir);
  await registerCapabilityRoutes(app, specsDir ?? CONFIG.specsDir);
  await registerMemoryRoutes(app, { dataDir: specsDir ?? CONFIG.specsDir });
  await registerKnowledgeRoutes(app, { dataDir: specsDir ?? CONFIG.specsDir });
  await registerOrganizationRoutes(app, { dataDir: specsDir ?? CONFIG.specsDir });
  app.get('/api/models', async () => {
    const model = localModelMetadata();
    return model.configured ? [{ id: `${model.provider}:${model.model}`, provider: model.provider, model: model.model, status: 'configured' }] : [];
  });
  app.get('/api/credentials/status', async () => ({ provider: localModelMetadata() }));
  app.get('/api/health', async () => ({ ok: true }));
  return app;
}
