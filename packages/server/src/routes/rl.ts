import type { FastifyInstance } from 'fastify';
import { parseSpecYaml, type SpecRunnerDeps } from '@veridical/spec';
import { parseScenarioYaml } from '@veridical/eval';
import { MockPolicy, RewardAggregator, GRPOTrainer, decisionStepFrom, type TrainConfig } from '@veridical/rl';
import { Memory, MemoryStore, MEMORY_SESSION } from '@veridical/memory';
import { Session, Recorder } from '@veridical/runtime';
import { resolveTools } from '../providers.js';

interface TrainBody {
  specYaml: string; scenarioYaml: string; candidates: string[];
  iterations?: number; groupSize?: number; lr?: number;
  goldenSessionId?: string; judge?: { provider: string; model: string; apiKey: string };
}

export async function registerRlRoutes(app: FastifyInstance) {
  const store = app.store;
  app.post<{ Body: TrainBody }>('/api/rl/train', async (req, reply) => {
    const b = req.body;
    if (!b?.specYaml || !b?.scenarioYaml || !Array.isArray(b.candidates) || b.candidates.length === 0) {
      return reply.code(400).send({ error: { code: 'bad_request', message: 'specYaml, scenarioYaml and candidates[] required' } });
    }
    let spec, scenario;
    try {
      spec = parseSpecYaml(b.specYaml);
      scenario = parseScenarioYaml(b.scenarioYaml);
    } catch (e) {
      return reply.code(400).send({ error: { code: 'invalid_yaml', message: String(e) } });
    }
    const candidatesByPrompt: Record<string, string[]> = {};
    for (const step of scenario.steps) candidatesByPrompt[step.user] = b.candidates;

    const policy = new MockPolicy(candidatesByPrompt);
    const reward = new RewardAggregator(scenario.rules);
    const rewardCtx: any = { store, goldenSessionId: b.goldenSessionId };

    reply.hijack();
    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache');
    reply.raw.setHeader('Connection', 'keep-alive');
    // @ts-ignore
    reply.raw.flushHeaders?.();
    const send = (obj: unknown) => { if (reply.raw.writableEnded) return; try { reply.raw.write(`data: ${JSON.stringify(obj)}\n\n`); } catch {} };
    const abort = () => { try { reply.raw.end(); } catch {} };
    reply.raw.on('close', abort);

    const deps: SpecRunnerDeps = {
      store,
      providers: new Map([['mock', { complete: async () => ({ text: '', usage: { input: 1, output: 1, cached: 0, total: 2 } }) }]]),
      tools: resolveTools(spec.tools.map((t) => t.name)),
      tenant_id: 't1', runStep: decisionStepFrom(b.candidates[0]),
    };

    const cfg: TrainConfig = {
      deps, spec, scenario,
      iterations: b.iterations ?? 20, groupSize: b.groupSize ?? 8, lr: b.lr ?? 0.5,
      policy, reward, rewardCtx, candidatesByPrompt,
    };

    let last: any;
    try {
      const trainer = new GRPOTrainer();
      for await (const s of trainer.train(cfg)) {
        if (reply.raw.writableEnded) break;
        last = s;
        send({ type: 'iteration', ...s });
      }
      // Distill best option per fingerprint into long-term memory
      const snap = policy.snapshot();
      const session = new Session({ session_id: `rl_distill`, tenant_id: 't1', spec_version: spec.version });
      const recorder = new Recorder(store, session);
      const longSession = new Session({ session_id: MEMORY_SESSION, tenant_id: 't1', spec_version: spec.version });
      const mem = new Memory(new MemoryStore(), store, `rl_distill`, recorder, new Recorder(store, longSession));
      for (const [fp, st] of Object.entries(snap)) {
        const best = st.options.reduce((a, b) => (b.prob > a.prob ? b : a)).text;
        await mem.rememberSkill(`rl:${fp}`, { name: `rl:${fp}`, description: 'distilled from GRPO training', procedure: best });
      }
      send({ type: 'done', iterations: last?.iteration ?? 0, final_mean_reward: last?.mean_reward ?? 0, best_option: last?.best_option ?? '' });
    } catch (e) {
      send({ type: 'error', message: String(e) });
    } finally {
      clearInterval; abort();
    }
  });
}
