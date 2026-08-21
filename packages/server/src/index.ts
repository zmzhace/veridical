import Fastify from 'fastify';
import cors from '@fastify/cors';
import { CONFIG } from './config.js';
import { registerSessionsRoutes } from './routes/sessions.js';

const app = Fastify({ logger: true });
await app.register(cors);
await app.register(registerSessionsRoutes);

app.get('/api/health', async () => ({ ok: true }));

try {
  await app.listen({ port: CONFIG.port, host: '0.0.0.0' });
  console.log(`veridical server on :${CONFIG.port}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
