import { describe, it, expect } from 'vitest';
import { memoryToSystemPrompt } from '../src/index';

describe('memoryToSystemPrompt', () => {
  it('builds a memory block from entries', () => {
    const out = memoryToSystemPrompt([
      { key: 'policy', value: 'P12345', scope: 'semantic', tags: ['claim'] },
      { key: 'echo', value: { name: 'echo', description: 'echo', procedure: 'x' }, scope: 'skill' },
    ]);
    expect(out).toContain('## 记忆');
    expect(out).toContain('[semantic] policy: P12345');
    expect(out).toContain('[skill] echo: echo');
  });

  it('returns empty for no memories', () => {
    expect(memoryToSystemPrompt([])).toBe('');
  });
});
