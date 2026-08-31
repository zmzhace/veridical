import { describe, expect, it } from 'vitest';
import { ContextBuilder } from '../src';

describe('ContextBuilder', () => {
  it('keeps required layers and produces deterministic hashes', () => {
    const layers = { safety: 'never leak secrets', task: 'ship feature', focus: 'tests', history: 'x'.repeat(1000) };
    const a = new ContextBuilder(100).build(layers);
    const b = new ContextBuilder(100).build(layers);
    expect(a.text).toContain('安全规则'); expect(a.text).toContain('当前任务'); expect(a.text).toContain('当前焦点');
    expect(a.content_hash).toBe(b.content_hash); expect(a.truncated).toBe(true);
  });
});
