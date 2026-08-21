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

declare module 'fastify' {
  interface FastifyInstance {
    store: TraceStore;
    specRegistry: SpecRegistry;
  }
}

export async function buildApp(tracesDir?: string, specsDir?: string) {
  const app = Fastify({ logger: false });
  await app.register(cors);
  app.decorate('store', new JsonlTraceStore(tracesDir ?? CONFIG.tracesDir));
  app.decorate('specRegistry', new JsonlSpecRegistry(specsDir ?? CONFIG.specsDir));
  await app.register(registerSessionsRoutes);
  await app.register(registerRunRoutes);
  await app.register(registerSpecRoutes);
  await app.register(registerEvalRoutes);
  await app.register(registerCompareRoutes);
  app.get('/api/health', async () => ({ ok: true }));
  return app;
}
