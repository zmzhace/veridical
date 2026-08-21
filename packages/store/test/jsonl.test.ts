import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonlTraceStore } from '../src/jsonl';

function evt(session_id: string, seq: number) {
  return { id: `e_${seq}`, tenant_id: 't1', session_id, span_id: 'sp', parent_span_id: null, seq, type: 'llm.request', verb: 'request', attempt: 1, duration_ms: 1, payload: {}, spec_version: '0.0.1' };
}

describe('JsonlTraceStore', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'rt-')); });

  it('persists and reloads events in seq order', async () => {
    const s = new JsonlTraceStore(dir);
    await s.append(evt('s1', 1));
    await s.append(evt('s1', 2));
    const reloaded = new JsonlTraceStore(dir);
    const all = await reloaded.readBySession('s1');
    expect(all.map(e => e.seq)).toEqual([1, 2]);
  });

  it('rejects corrupt event lines on load', async () => {
    const s = new JsonlTraceStore(dir);
    await s.append(evt('s1', 1));
    const fs = await import('node:fs');
    fs.appendFileSync(join(dir, 's1.jsonl'), '{not json}\n');
    await expect(new JsonlTraceStore(dir).readBySession('s1')).rejects.toThrow();
  });
});