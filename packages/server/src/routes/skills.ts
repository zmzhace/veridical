import type { FastifyInstance } from 'fastify';
import { MEMORY_SESSION, MemoryStore } from '@veridical/memory';

/** Read-only, governance-friendly skill catalog. Procedures are returned for explicit Spec pinning. */
export async function registerSkillRoutes(app: FastifyInstance) {
  app.get('/api/skills', async () => {
    const snapshot = await new MemoryStore().snapshot(app.store, MEMORY_SESSION);
    return snapshot.entries
      .filter((entry) => entry.scope === 'skill')
      .map((entry) => {
        const value = entry.value && typeof entry.value === 'object' ? entry.value as Record<string, unknown> : {};
        return {
          name: typeof value.name === 'string' ? value.name : entry.key.replace(/^skill:/, ''),
          description: typeof value.description === 'string' ? value.description : '',
          procedure: typeof value.procedure === 'string' ? value.procedure : '',
          tags: entry.tags ?? [],
          source: 'memory',
          key: entry.key,
        };
      });
  });
}
