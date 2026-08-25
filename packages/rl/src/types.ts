import type { LLMProvider, LLMRequest, LLMResponse } from '@veridical/llm';

export interface PolicyOption { text: string; logit: number; prob: number }
export interface PolicyState { options: PolicyOption[] }
export type PolicySnapshot = Record<string, PolicyState>;

export interface RLPolicy extends LLMProvider {
  logProb(req: LLMRequest, text: string): number;
  update(updates: { fingerprint: string; text: string; advantage: number; lr: number }[]): void;
  snapshot(): PolicySnapshot;
}

export interface IterationStats {
  iteration: number;
  mean_reward: number;
  best_option: string;
  group_rewards: number[];
  policy: PolicySnapshot;
}
