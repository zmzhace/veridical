import type { TraceEvent } from '@veridical/schema';

export interface SessionSummary {
  session_id: string;
  spec_version: string;
  event_count: number;
  spec_name?: string;
  turn_count?: number;
  first_message?: string;
  total_tokens?: { input: number; output: number; cached: number; total: number };
  total_duration_ms: number;
  first_seq: number;
  last_seq: number;
}
export type SessionEvents = TraceEvent[];
export interface Checkpoint {
  frame: number;
  stage?: string;
  messages: unknown[];
  memory?: unknown;
  outcome_so_far: unknown;
  blocked?: boolean;
}
export interface ReplayResponse {
  session_id: string;
  up_to_seq: number;
  events: TraceEvent[];
  last_event?: TraceEvent;
}
export interface CompareResponse {
  session_a: string;
  session_b: string;
  differences: { seq: number; field: string; left?: unknown; right?: unknown; kind: string }[];
  summary: {
    events_a: number;
    events_b: number;
    first_divergence?: number;
    outcomes_equal: boolean;
    identical: boolean;
  };
}
export interface EvalResponse {
  passed: boolean;
  rules?: { rules: { name: string; passed: boolean; detail?: string }[]; passed: boolean };
}
export interface RunResponse {
  session_id: string;
  spec_name: string;
  spec_version: string;
  outcome: unknown;
  events: TraceEvent[];
}

export interface AgentSummary {
  id: string;
  name: string;
  description: string;
  model: string;
  status: 'draft' | 'published' | 'archived';
  version?: string;
  created_at: string;
  updated_at: string;
  instructions?: string;
  mock?: boolean;
  capabilities?: {
    model: { provider: string; name: string };
    tools: Array<{ name: string; access: string }>;
    skills: Array<{ name: string; version: string; status: string }>;
    memory: { enabled: boolean; scopes: string[] };
    knowledge_bases: string[];
    mcp_servers: string[];
    child_agents: string[];
  };
  draft?: { graph: unknown; yaml?: string; revision: number };
}

export interface AgentDraft {
  graph: unknown;
  yaml?: string;
  revision: number;
}
export interface InvocationResponse {
  legacy: boolean;
  invocations: Array<Record<string, unknown>>;
}

export type TurnFrame =
  | { type: 'token'; session_id?: string; text: string }
  | { type: 'event'; event: TraceEvent }
  | { type: 'turn_end'; session_id: string }
  | { type: 'done'; session_id: string; event_count: number; outcome?: unknown }
  | { type: 'error'; message: string; session_id?: string };

export interface TurnRequestBody {
  specName: string;
  version?: string;
  conversationId?: string;
  mode?: 'mock' | 'live';
  prompt: string;
  project_id?: string;
  script?: string[];
  provider?: string;
  model?: string;
  apiKey?: string;
}
