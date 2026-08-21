import type { LLMProvider, LLMRequest, LLMResponse, LLMUsage } from '@veridical/llm';
import type { ToolDef } from '@veridical/tools';

export class OpenAICompatibleProvider implements LLMProvider {
  constructor(private baseUrl: string, private apiKey: string, private model: string) {}
  async complete(req: LLMRequest): Promise<LLMResponse> {
    const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ model: this.model, messages: req.messages }),
    });
    if (!res.ok) throw new Error(`live llm failed: ${res.status} ${await res.text()}`);
    const json = await res.json();
    const content: string = json.choices?.[0]?.message?.content ?? '';
    const usage: LLMUsage = { input: json.usage?.prompt_tokens ?? 0, output: json.usage?.completion_tokens ?? 0, cached: 0, total: (json.usage?.prompt_tokens ?? 0) + (json.usage?.completion_tokens ?? 0) };
    return { text: content, usage };
  }
}

export class MockScriptedProvider implements LLMProvider {
  private queue: string[] = [];
  enqueue(text: string) { this.queue.push(text); }
  async complete(_req: LLMRequest): Promise<LLMResponse> {
    const text = this.queue.shift() ?? JSON.stringify({ text: 'done', done: true });
    return { text, usage: { input: 1, output: 1, cached: 0, total: 2 } };
  }
}

export const BUILTIN_TOOLS: ToolDef[] = [
  { id: 'echo', name: 'echo', description: 'echo args', deterministic: true, execute: async (a) => a },
  { id: 'finish', name: 'finish', description: 'finish with report', deterministic: true, execute: async (a) => a },
];

export function resolveTools(names: string[]): ToolDef[] {
  return names.map((n) => BUILTIN_TOOLS.find((t) => t.name === n) ?? { id: n, name: n, description: `generic ${n}`, deterministic: false, execute: async (a) => a });
}
