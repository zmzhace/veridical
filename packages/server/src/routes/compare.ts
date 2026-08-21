import type { FastifyInstance } from 'fastify';
import { RunComparator } from '@veridical/replay';
import { getStore } from '../store.js';

export async function registerCompareRoutes(app: FastifyInstance) {
  app.post<{ Body: { a: string; b: string } }>('/api/compare', async (req, reply) => {
    const store = getStore();
    if ((await store.readBySession(req.body.a)).length === 0 || (await store.readBySession(req.body.b)).length === 0)
      return reply.code(404).send({ error: { code: 'not_found', message: 'one or both sessions missing' } });
    const diff = await new RunComparator(store).compare(req.body.a, req.body.b);
    return diff;
  });
}
