import type { FastifyInstance } from 'fastify';
import { parseSpecYaml } from '@veridical/spec';

export async function registerSpecRoutes(app: FastifyInstance) {
  const registry = app.specRegistry;
  app.get('/api/specs', async () => registry.list());
  app.post<{ Body: { yaml: string } }>('/api/specs', async (req, reply) => {
    try {
      const spec = parseSpecYaml(req.body.yaml);
      await registry.register(spec);
      return reply.code(201).send(spec);
    } catch (e) {
      return reply.code(400).send({ error: { code: 'invalid_spec', message: String(e) } });
    }
  });
}
