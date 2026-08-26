import { fingerprint } from '@veridical/llm';
import type { Scenario } from '@veridical/eval';
import { runSpec, type AgentSpec, type SpecRunnerDeps } from '@veridical/spec';
import type { IterationStats } from './types';
import type { MockPolicy } from './policy';
import { RewardAggregator, type RewardCtx } from './reward';
import { decisionStepFrom } from './decision';

export interface TrainConfig {
  deps: SpecRunnerDeps;
  spec: AgentSpec;
  scenario: Scenario;
  iterations: number;
  groupSize: number;
  lr: number;
  policy: MockPolicy;
  reward: RewardAggregator;
  rewardCtx: RewardCtx;
  candidatesByPrompt: Record<string, string[]>;
}

// The state identity for GRPO grouping. Matches MockPolicy's internal keying
// (fingerprint of the canonical request) so snapshot/update/seed agree.
export function stateFingerprint(prompt: string): string {
  return fingerprint({ provider: 'mock', model: 'm', messages: [{ role: 'user', content: prompt }] });
}

export class GRPOTrainer {
  async *train(cfg: TrainConfig): AsyncIterable<IterationStats> {
    const { deps, spec, scenario, iterations, groupSize, lr, policy, reward, rewardCtx } = cfg;
    const states = scenario.steps.map((s) => s.user);

    if (spec.flow.mode === 'stage-gate') {
      const stageIds = (spec.flow.stages ?? []).map((s) => s.id);
      // Seed every (stage, user) state so policy.update() finds pre-existing options.
      for (const prompt of states) {
        for (const stage of stageIds) {
          policy.seed(stateFingerprint(`${stage}:${prompt}`), cfg.candidatesByPrompt[prompt] ?? []);
        }
      }
      for (let iter = 1; iter <= iterations; iter++) {
        let totalReward = 0;
        const groupRewards: number[] = [];
        for (const prompt of states) {
          // groupRollouts[i] = { log: {stage, action}[], reward }
          const groupRollouts: { log: { stage: string; action: string }[]; reward: number }[] = [];
          for (let g = 0; g < groupSize; g++) {
            const log: { stage: string; action: string }[] = [];
            const sessionId = `rl_${Math.random().toString(36).slice(2)}`;
            const local: SpecRunnerDeps = { ...deps, session_id: sessionId, runStep: stageAwareRunStep(deps, sessionId, prompt, policy, log) };
            let r = 0;
            try {
              const run = await runSpec(local, spec, prompt);
              ({ reward: r } = await reward.score(run, rewardCtx));
            } catch {
              // Rollout crashed (a stage gate was never satisfied within max_steps):
              // keep its partial log with a zero end-to-end reward.
            }
            groupRollouts.push({ log, reward: r });
          }
          // 按 (stage, user) 分组算 advantage
          const byState = new Map<string, { actions: string[]; rewards: number[] }>();
          for (const ro of groupRollouts) {
            for (const l of ro.log) {
              const key = stateFingerprint(`${l.stage}:${prompt}`);
              const e = byState.get(key) ?? { actions: [], rewards: [] };
              e.actions.push(l.action);
              e.rewards.push(ro.reward);
              byState.set(key, e);
            }
          }
          for (const [fp, e] of byState) {
            const mean = e.rewards.reduce((a, b) => a + b, 0) / Math.max(e.rewards.length, 1);
            const std = Math.sqrt(e.rewards.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(e.rewards.length, 1)) || 1;
            for (let i = 0; i < e.actions.length; i++) {
              policy.update([{ fingerprint: fp, text: e.actions[i], advantage: (e.rewards[i] - mean) / std, lr }]);
            }
          }
          const meanReward = groupRollouts.reduce((a, ro) => a + ro.reward, 0) / groupRollouts.length;
          totalReward += meanReward;
          groupRewards.push(meanReward);
        }
        const overallMean = totalReward / states.length;
        const snap = policy.snapshot();
        const fp = stateFingerprint(`${stageIds[0]}:${states[0]}`); // 用第一个 stage 与第一个 state 作 best 展示
        const best = snap[fp]?.options.reduce((a, b) => (b.prob > a.prob ? b : a)).text ?? '';
        yield { iteration: iter, mean_reward: overallMean, best_option: best, group_rewards: groupRewards, policy: snap };
      }
      return;
    }

    // Seed every state so policy.update() finds pre-existing options.
    for (const prompt of states) {
      policy.seed(stateFingerprint(prompt), cfg.candidatesByPrompt[prompt] ?? []);
    }

    for (let iter = 1; iter <= iterations; iter++) {
      let totalReward = 0;
      const groupRewards: number[] = [];

      for (let si = 0; si < states.length; si++) {
        const prompt = states[si];
        const step = scenario.steps[si];
        const fp = stateFingerprint(prompt);
        // Per-step reward: merge step.expect_rules with scenario.rules (mirrors Simulator).
        // Fall back to the global aggregator when the step has no expect_rules.
        const stepReward =
          step.expect_rules && step.expect_rules.length > 0
            ? new RewardAggregator([...(step.expect_rules ?? []), ...(scenario.rules ?? [])])
            : reward;
        // Sample the full group from the current policy first, then compute
        // group-normalized advantages. Policy-weighted sampling makes mean_reward
        // rise as the policy concentrates on high-reward options.
        const req = { provider: 'mock', model: 'm', messages: [{ role: 'user', content: prompt }] };
        const samples: { chosen: string; reward: number }[] = [];
        for (let g = 0; g < groupSize; g++) {
          const chosen = (await policy.complete(req)).text;
          const run = await runOne(deps, spec, prompt, chosen);
          const { reward: r } = await stepReward.score(run, rewardCtx);
          samples.push({ chosen, reward: r });
        }
        const mean = samples.reduce((a, s) => a + s.reward, 0) / samples.length;
        const std = Math.sqrt(samples.reduce((a, s) => a + (s.reward - mean) ** 2, 0) / samples.length) || 1;
        for (const s of samples) {
          policy.update([{ fingerprint: fp, text: s.chosen, advantage: (s.reward - mean) / std, lr }]);
        }
        totalReward += mean;
        groupRewards.push(mean);
      }

      const overallMean = totalReward / states.length;
      const snap = policy.snapshot();
      const fp = stateFingerprint(states[0]);
      const best = snap[fp]?.options.reduce((a, b) => (b.prob > a.prob ? b : a)).text ?? '';
      yield { iteration: iter, mean_reward: overallMean, best_option: best, group_rewards: groupRewards, policy: snap };
    }
  }
}

async function runOne(deps: SpecRunnerDeps, spec: AgentSpec, prompt: string, chosen: string) {
  const sessionId = `rl_${Math.random().toString(36).slice(2)}`;
  const local: SpecRunnerDeps = { ...deps, session_id: sessionId, runStep: decisionStepFrom(chosen) };
  return runSpec(local, spec, prompt);
}

export function stageAwareRunStep(
  deps: SpecRunnerDeps,
  sessionId: string,
  prompt: string,
  policy: MockPolicy,
  log: { stage: string; action: string }[],
) {
  return async function step(ctx: { spec: AgentSpec; prompt: string }) {
    const events = await deps.store.readBySession(sessionId);
    const starts = events.filter(e => e.type === 'stage/start');
    const ends = new Set(events.filter(e => e.type === 'stage/end').map(e => (e.payload as any)?.stage));
    const last = [...starts].reverse().find(e => !ends.has((e.payload as any)?.stage));
    const stage = (last?.payload as any)?.stage ?? '';
    const req = { provider: 'mock', model: 'm', messages: [{ role: 'user', content: `${stage}:${prompt}` }] };
    const res = await policy.complete(req);
    log.push({ stage, action: res.text });
    return decisionStepFrom(res.text)(ctx);
  };
}
