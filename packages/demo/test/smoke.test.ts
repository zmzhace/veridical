import { describe, it, expect } from 'vitest';
import { runDemo } from '../src/demo';
import { deriveMessages } from '@rt/runtime';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('end-to-end smoke', () => {
  it('runs a full agent loop, persists to JSONL, and rebuilds context', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rt-e2e-'));
    const store = await runDemo(dir);

    const events = await store.readBySession('s1');
    const types = events.map(e => e.type);
    for (const t of ['turn/start', 'llm.request', 'llm.response', 'tool.result', 'turn/end']) {
      expect(types).toContain(t);
    }

    const msgs = await deriveMessages(store, 's1');
    const userMsgs = msgs.filter(m => m.role === 'user');
    const assistantMsgs = msgs.filter(m => m.role === 'assistant');
    expect(userMsgs.length).toBeGreaterThan(0);
    expect(assistantMsgs.length).toBeGreaterThan(0);
    expect(assistantMsgs.some(m => m.content.length > 0)).toBe(true);

    const totalTokens = events.reduce((s, e) => s + (e.tokens?.total ?? 0), 0);
    expect(totalTokens).toBeGreaterThan(0);
    expect(events.every(e => typeof e.duration_ms === 'number')).toBe(true);
  });
});