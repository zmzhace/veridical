import { describe, it, expect } from 'vitest';
import { runTransferDemo } from '../src/transfer-demo';
import { StageGateError } from '@veridical/runtime';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('transfer demo', () => {
  it('completes all stages when gates satisfied', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rt-transfer-'));
    const { store, result } = await runTransferDemo(dir);
    const events = await store.readBySession('transfer_s1');
    const types = events.map(e => e.type);
    expect(types).toContain('stage/start');
    expect(types.filter(t => t === 'stage/start')).toHaveLength(4);
    expect(types.filter(t => t === 'stage/end')).toHaveLength(4);
    const submit = events.find(e => e.type === 'tool.called' && (e.payload as any).name === 'submit_transfer');
    expect(submit).toBeTruthy();
    expect(result.events.length).toBe(events.length);
  });

  it('gets stuck at health_check when health verification is skipped', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rt-transfer-stuck-'));
    await expect(runTransferDemo(dir, { skipHealth: true })).rejects.toThrow(StageGateError);
  });
});