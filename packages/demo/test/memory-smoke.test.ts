import { describe, it, expect } from 'vitest';
import { runMemoryDemo } from '../src/memory-demo';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('memory-driven demo', () => {
  it('runs a memory-aware agent and records memory events', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rt-mem-'));
    const { store, outcome } = await runMemoryDemo(dir);
    expect(outcome).toBeDefined();
    const events = await store.readBySession('s1');
    const longEvents = await store.readBySession('_memory');
    const types = [...events.map(e => e.type), ...longEvents.map(e => e.type)];
    for (const t of ['memory.write', 'memory.recalled']) {
      expect(types).toContain(t);
    }
  });
});
