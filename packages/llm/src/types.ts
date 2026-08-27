export interface LLMRequest { messages: unknown[]; model: string; provider: string }
export interface LLMUsage { input: number; output: number; cached: number; total: number }
export interface LLMResponse { text: string; usage: LLMUsage }
export interface LLMProvider {
  complete(req: LLMRequest): Promise<LLMResponse>;
  stream?(req: LLMRequest): AsyncIterable<string>;
}
