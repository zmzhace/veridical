import type { LLMProvider, LLMRequest, LLMResponse, LLMUsage } from '@veridical/llm';
import { editText, globFiles, grepFiles, listFiles, multiEditText, readText, writeText, type ToolDef } from '@veridical/tools';

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
  async *stream(req: LLMRequest): AsyncIterable<string> {
    const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ model: this.model, messages: req.messages, stream: true }),
    });
    if (!res.ok || !res.body) throw new Error(`live llm stream failed: ${res.status} ${await res.text()}`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (data === '[DONE]') continue;
        try {
          const json = JSON.parse(data);
          const delta: unknown = json?.choices?.[0]?.delta?.content;
          if (typeof delta === 'string' && delta.length > 0) yield delta;
        } catch {
          // 跳过半行/非 JSON
        }
      }
    }
  }
}

export class MockScriptedProvider implements LLMProvider {
  private queue: string[] = [];
  enqueue(text: string) { this.queue.push(text); }
  async complete(_req: LLMRequest): Promise<LLMResponse> {
    const text = this.queue.shift() ?? JSON.stringify({ text: 'done', done: true });
    return { text, usage: { input: 1, output: 1, cached: 0, total: 2 } };
  }
  async *stream(_req: LLMRequest): AsyncIterable<string> {
    const text = this.queue.shift() ?? JSON.stringify({ text: 'done', done: true });
    const step = 4;
    for (let i = 0; i < text.length; i += step) {
      yield text.slice(i, i + step);
    }
  }
}

export const BUILTIN_TOOLS: ToolDef[] = [
  { id: 'echo', name: 'echo', description: 'echo args', deterministic: true, execute: async (a) => a },
  { id: 'finish', name: 'finish', description: 'finish with report', deterministic: true, execute: async (a) => a },
];

export function builtinTools(workspace = process.env.VERIDICAL_WORKSPACE ?? process.cwd()): ToolDef[] {
  return [...BUILTIN_TOOLS,
    { id: 'list', name: 'list', description: 'List workspace entries', deterministic: true, side_effect: 'none', execute: async (args: any) => listFiles(workspace, typeof args?.path === 'string' ? args.path : '') },
    { id: 'glob', name: 'glob', description: 'Find workspace files by pattern', deterministic: true, side_effect: 'none', execute: async (args: any) => globFiles(workspace, typeof args?.pattern === 'string' ? args.pattern : '**/*') },
    { id: 'read', name: 'read', description: 'Read a workspace text file', deterministic: true, side_effect: 'none', execute: async (args: any) => readText(workspace, String(args?.path ?? '')) },
    { id: 'grep', name: 'grep', description: 'Search workspace text', deterministic: true, side_effect: 'none', execute: async (args: any) => grepFiles(workspace, String(args?.pattern ?? ''), typeof args?.path === 'string' ? args.path : '') },
    { id: 'write', name: 'write', description: 'Write a workspace text file with optimistic locking', deterministic: false, side_effect: 'write', execute: async (args: any) => writeText(workspace, String(args?.path ?? ''), String(args?.content ?? ''), typeof args?.expected_hash === 'string' ? args.expected_hash : undefined) },
    { id: 'edit', name: 'edit', description: 'Replace one exact workspace text range', deterministic: false, side_effect: 'write', execute: async (args: any) => editText(workspace, String(args?.path ?? ''), String(args?.old_text ?? ''), String(args?.new_text ?? ''), typeof args?.expected_hash === 'string' ? args.expected_hash : undefined) },
    { id: 'multi_edit', name: 'multi_edit', description: 'Apply multiple exact workspace edits', deterministic: false, side_effect: 'write', execute: async (args: any) => multiEditText(workspace, String(args?.path ?? ''), Array.isArray(args?.edits) ? args.edits : [], typeof args?.expected_hash === 'string' ? args.expected_hash : undefined) },
  ];
}

export function resolveTools(names: string[], workspace?: string): ToolDef[] {
  const available = builtinTools(workspace);
  return names.map((name) => {
    const tool = available.find((candidate) => candidate.name === name);
    if (!tool) throw Object.assign(new Error(`tool is not registered: ${name}`), { code: 'tool_not_registered' });
    return tool;
  });
}
