import type { FastifyInstance } from 'fastify';
import { evaluateRun, ruleNoErrors, type EvalConfig } from '@veridical/eval';

export async function registerEvalRoutes(app: FastifyInstance) {
  const store = app.store;
  app.post<{ Body: { sessionId: string; golden?: unknown } }>('/api/evaluate', async (req, reply) => {
    const events = await store.readBySession(req.body.sessionId);
    if (events.length === 0) return reply.code(404).send({ error: { code: 'not_found', message: 'session not found' } });
    const config: EvalConfig = { golden: req.body.golden, rules: [ruleNoErrors()], pass_requirement: 'all' };
    const report = await evaluateRun({ session_id: req.body.sessionId, spec_name: '', spec_version: events[0]?.spec_version ?? '', outcome: undefined, events }, config);
    return { passed: report.passed, rules: report.rules };
  });
  app.get<{ Params: { sessionId: string } }>('/api/evals/:sessionId', async (req, reply) => {
    const events = await store.readBySession(req.params.sessionId);
    if (events.length === 0) return reply.code(404).send({ error: { code: 'not_found', message: 'session not found' } });
    const report = await evaluateRun({ session_id: req.params.sessionId, spec_name: '', spec_version: events[0]?.spec_version ?? '', outcome: undefined, events }, { rules: [ruleNoErrors()], pass_requirement: 'all' });
    return { passed: report.passed, rules: report.rules };
  });
}
