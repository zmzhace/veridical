import { describe, it, expect } from 'vitest';
import { MockScriptedProvider } from '../src/providers.js';

describe('MockScriptedProvider.stream', () => {
  it('slices script text into chunks', async () => {
    const p = new MockScriptedProvider();
    p.enqueue('{"text":"已为您分析","done":true}');
    const all: string[] = [];
    for await (const chunk of p.stream({ provider: 'mock', model: 'm', messages: [] })) {
      all.push(chunk);
    }
    expect(all.join('')).toBe('{"text":"已为您分析","done":true}');
    expect(all.length).toBeGreaterThan(1);
  });

  it('consumes queue like complete()', async () => {
    const p = new MockScriptedProvider();
    p.enqueue('one');
    p.enqueue('two');
    const first: string[] = [];
    for await (const c of p.stream({ provider: 'mock', model: 'm', messages: [] })) first.push(c);
    expect(first.join('')).toBe('one');
    const second = await p.complete({ provider: 'mock', model: 'm', messages: [] });
    expect(second.text).toBe('two');
  });
});
