import { describe, it, expect } from 'vitest';
import { runReplayDemo } from '../src/replay-demo';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('replay-driven demo', () => {
  it('runs, replays identically, projects, and compares', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rt-replay-'));
    const { store, replay } = await runReplayDemo(dir);
    expect(replay.identical).toBe(true);
    const events = await store.readBySession('s1');
    expect(events.length).toBeGreaterThan(0);
  });
});
