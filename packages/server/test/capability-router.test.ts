import { describe, expect, it } from 'vitest';
import { rankCapabilities } from '../src/production/capability-router';

describe('capability router', () => {
  it('ranks deterministically and limits tool and skill candidates', () => {
    const candidates = [
      {
        id: 'read',
        kind: 'tool' as const,
        name: 'read',
        description: '读取文件',
        explicitlyBound: true,
      },
      {
        id: 'search',
        kind: 'tool' as const,
        name: 'search',
        description: '搜索网页和资料',
        explicitlyBound: true,
      },
      {
        id: 'research@1',
        kind: 'skill' as const,
        name: 'research',
        description: '研究和证据',
        activation: 'auto' as const,
      },
      {
        id: 'manual@1',
        kind: 'skill' as const,
        name: 'manual-only',
        description: '其他流程',
        activation: 'manual' as const,
      },
    ];
    const first = rankCapabilities('请搜索资料并研究证据', candidates, { tools: 1, skills: 1 });
    const second = rankCapabilities('请搜索资料并研究证据', candidates, { tools: 1, skills: 1 });
    expect(first).toEqual(second);
    expect(first.filter((item) => item.kind === 'tool')).toHaveLength(1);
    expect(first.find((item) => item.id === 'research@1')).toBeTruthy();
    expect(first.find((item) => item.id === 'manual@1')).toBeFalsy();
  });
});
