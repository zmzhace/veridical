import type { LLMUsage } from '@veridical/llm';

export type ReplayStrategy = 'replay' | 'live' | 'fixture';

export interface ReplayPlan {
  spec: { name: string; version?: string };
  llm?: { [provider: string]: ReplayStrategy };
  tools?: { [name: string]: ReplayStrategy };
  fixtures?: {
    llm?: { provider: string; responses: { fingerprint: string; text: string; usage: LLMUsage }[] }[];
    tools?: { name: string; responses: unknown[] }[];
  };
  assert_trace_identical?: boolean;
}
