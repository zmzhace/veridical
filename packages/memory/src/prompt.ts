import type { MemoryEntry } from './store';

function stringify(v: unknown): string {
  return typeof v === 'string' ? v : JSON.stringify(v);
}

export function memoryToSystemPrompt(memories: MemoryEntry[]): string {
  if (memories.length === 0) return '';
  const lines = memories.map(m => {
    if (m.scope === 'skill') {
      const v = m.value as { name?: string; description?: string } | undefined;
      return `- [skill] ${v?.name ?? m.key}: ${v?.description ?? ''}`;
    }
    return `- [${m.scope}] ${m.key}: ${stringify(m.value)}`;
  });
  return `\n## 记忆\n${lines.join('\n')}`;
}
