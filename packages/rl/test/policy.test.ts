import { describe, it, expect } from 'vitest';
import { fingerprint } from '@veridical/llm';
import { MockPolicy } from '../src/policy';

const req = (prompt: string) => ({ provider: 'mock', model: 'm', messages: [{ role: 'user', content: prompt }] });
const fp = fingerprint(req('hello'));

describe('MockPolicy', () => {
  it('samples from candidate set', async () => {
    const p = new MockPolicy({ hello: ['a', 'b'] });
    const texts = new Set(['a', 'b']);
    for (let i = 0; i < 20; i++) {
      const r = await p.complete(req('hello'));
      expect(texts.has(r.text)).toBe(true);
    }
  });

  it('logProb matches softmax and sums to 1', () => {
    const p = new MockPolicy({ hello: ['a', 'b'] });
    p.seed(fp, ['a', 'b']);
    const pa = p.logProb(req('hello'), 'a');
    const pb = p.logProb(req('hello'), 'b');
    expect(pa + pb).toBeCloseTo(1, 5);
    expect(p.logProb(req('hello'), 'zzz')).toBe(0);
  });

  it('update shifts logits by lr*advantage', () => {
    const p = new MockPolicy({ hello: ['a', 'b'] });
    p.seed(fp, ['a', 'b']);
    const before = p.logProb(req('hello'), 'a');
    p.update([{ fingerprint: fp, text: 'a', advantage: 1, lr: 1 }]);
    const after = p.logProb(req('hello'), 'a');
    expect(after).toBeGreaterThan(before);
  });
});
