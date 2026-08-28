export interface LLMRequest {
  messages: unknown[];
  model: string;
  provider: string;
  signal?: AbortSignal;
  maxOutputTokens?: number;
  invocationPath?: string;
  parameters?: Record<string, unknown>;
}
export interface LLMUsage {
  input: number;
  output: number;
  cached: number;
  total: number;
}
export interface LLMResponse {
  text: string;
  usage: LLMUsage;
  finish_reason?: string;
  actions?: unknown;
  cost?: number;
  token_ids?: number[];
  logprobs?: number[];
}
export interface LLMProvider {
  complete(req: LLMRequest): Promise<LLMResponse>;
  stream?(req: LLMRequest): AsyncIterable<string>;
}
