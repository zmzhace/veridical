import Fastify from 'fastify';
import cors from '@fastify/cors';
import { JsonlTraceStore } from '@veridical/store';
import type { TraceStore } from '@veridical/store';
import { CONFIG } from './config.js';
import { registerSessionsRoutes } from './routes/sessions.js';

declare module 'fastify' {
  interface FastifyInstance {
    store: TraceStore;
  }
}

export async function buildApp(tracesDir?: string) {
  const app = Fastify({ logger: false });
  await app.register(cors);
  app.decorate('store', new JsonlTraceStore(tracesDir ?? CONFIG.tracesDir));
  await app.register(registerSessionsRoutes);
  app.get('/api/health', async () => ({ ok: true }));
  return app;
}
