import { describe, it, expect } from 'vitest';
import { runEvalDemo } from '../src/eval-demo';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('eval-driven demo', () => {
  it('runs a simulator scenario and reports evaluation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rt-eval-'));
    const { store, report } = await runEvalDemo(dir);
    expect(report.name).toBe('claim-scenario');
    expect(report.steps.length).toBeGreaterThan(0);
    const events = await store.readBySession('eval_s1');
    const types = events.map(e => e.type);
    for (const t of ['eval/run/start', 'eval/step/end']) {
      expect(types).toContain(t);
    }
  });
});
