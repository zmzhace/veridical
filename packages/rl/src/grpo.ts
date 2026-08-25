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
