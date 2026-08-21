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
    expect(msgs.length).toBeGreaterThan(0);
  });
});