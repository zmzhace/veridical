import { describe, expect, it } from 'vitest';
import { selectToolCandidates } from '../src/broker';
import type { ToolDef } from '../src/types';

const tool = (name: string, description: string, status: ToolDef['status'] = 'approved'): ToolDef => ({ id: name, name, description, deterministic: true, status, execute: async () => null });

describe('selectToolCandidates', () => {
  it('selects from the approved pool without granting permissions', () => {
    const result = selectToolCandidates([tool('search', 'search sources'), tool('write', 'write files', 'draft')], 'search sources');
    expect(result.map((item) => item.tool.name)).toEqual(['search']);
    expect(result[0].permission).toBe('broker');
  });

  it('applies deny and skill-required tools', () => {
    const result = selectToolCandidates([tool('search', 'search'), tool('fetch', 'fetch page')], 'read', ['fetch'], { deny: ['search'], mode: 'allowlist' });
    expect(result.map((item) => item.tool.name)).toEqual(['fetch']);
  });
});
