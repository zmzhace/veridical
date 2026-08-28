import type { LLMUsage } from '@veridical/llm';

export type ReplayStrategy = 'replay' | 'live' | 'fixture';
export type ReplayMode = 'strict' | 'fixture' | 'semantic';
export interface InvocationFixture {
  path: string;
  operation: string;
  fingerprint: string;
  attempt?: number;
  source: string;
  version: string;
  output: unknown;
  hash: string;
}
export interface SemanticCriteria {
  expected_outcome?: unknown;
  required_tools?: string[];
  forbidden_tools?: string[];
  completed_agents?: string[];
  completed_stages?: string[];
  max_steps?: number;
  max_tokens?: number;
  max_cost?: number;
  max_duration_ms?: number;
  golden?: { outcome: unknown };
}

export interface ReplayPlan {
  mode?: ReplayMode;
  downgrade_reason?: string;
  invocation_fixtures?: InvocationFixture[];
  semantic?: SemanticCriteria;
  spec: { name: string; version?: string };
  llm?: { [provider: string]: ReplayStrategy };
  tools?: { [name: string]: ReplayStrategy };
  fixtures?: {
    llm?: {
      provider: string;
      responses: { fingerprint: string; text: string; usage: LLMUsage }[];
    }[];
    tools?: { name: string; responses: unknown[] }[];
  };
  assert_trace_identical?: boolean;
}
