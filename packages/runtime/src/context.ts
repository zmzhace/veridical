import { createHash } from 'node:crypto';

export interface ContextLayers {
  safety?: string;
  identity?: string;
  task?: string;
  focus?: string;
  history?: string;
  observations?: string;
  memory?: string;
  knowledge?: string;
  summary?: string;
}

export interface BuiltContext { text: string; layers: string[]; truncated: boolean; content_hash: string }

/** Deterministic, auditable context assembly. Safety and task layers are never evicted. */
export class ContextBuilder {
  constructor(private readonly maxChars = 24000) {}
  build(layers: ContextLayers): BuiltContext {
    const required: [keyof ContextLayers, string][] = [['safety', '安全规则'], ['identity', 'Agent 身份'], ['task', '当前任务'], ['focus', '当前焦点']];
    const optional: [keyof ContextLayers, string][] = [['history', '最近对话'], ['observations', '工具观察'], ['memory', '记忆'], ['knowledge', '知识证据'], ['summary', '历史摘要']];
    const parts: string[] = []; let omitted = false;
    for (const [key, title] of [...required, ...optional]) {
      const value = layers[key]; if (!value) continue;
      const block = `## ${title}\n${value}`;
      if (parts.join('\n\n').length + block.length <= this.maxChars || required.some(([requiredKey]) => requiredKey === key)) parts.push(block); else omitted = true;
    }
    let text = parts.join('\n\n'); let truncated = omitted || text.length > this.maxChars;
    if (truncated) text = text.slice(0, this.maxChars);
    return { text, layers: parts.map((part) => part.slice(3, part.indexOf('\n'))), truncated, content_hash: createHash('sha256').update(text).digest('hex') };
  }
}
