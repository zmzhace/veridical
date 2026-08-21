import { describe, it, expect } from 'vitest';
import { runSpecDemo } from '../src/spec-demo';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('spec-driven demo', () => {
  it('runs a spec-driven agent and records spec-bound events', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rt-spec-'));
    const { store, result } = await runSpecDemo(dir);
    const events = await store.readBySession('spec_s1');
    const types = events.map(e => e.type);
    for (const t of ['spec/run/start', 'turn/start', 'llm.request', 'llm.response', 'tool.result', 'turn/end', 'spec/run/end']) {
      expect(types).toContain(t);
    }
    expect(result.spec_name).toBe('claim-filing');
    expect(result.spec_version).toBe('1.0.0');
    expect(result.events.length).toBe(events.length);
  });
});
