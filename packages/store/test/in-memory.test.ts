import { describe, it, expect } from 'vitest';
import type { TraceEvent } from '@veridical/schema';
import { InMemoryTraceStore } from '../src/in-memory';

function evt(session_id: string, seq: number): TraceEvent {
  return {
    id: `e_${seq}`, tenant_id: 't1', session_id, span_id: 'sp', parent_span_id: null,
    seq, type: 'llm.request', verb: 'request', attempt: 1, duration_ms: 1,
    payload: {}, spec_version: '0.0.1',
  };
}

describe('InMemoryTraceStore', () => {
  it('stores and reads events in seq order', async () => {
    const s = new InMemoryTraceStore();
    await s.append(evt('s1', 2));
    await s.append(evt('s1', 1));
    const all = await s.readBySession('s1');
    expect(all.map(e => e.seq)).toEqual([1, 2]);
  });

  it('isolates sessions', async () => {
    const s = new InMemoryTraceStore();
    await s.append(evt('s1', 1));
    await s.append(evt('s2', 1));
    expect((await s.readBySession('s1')).length).toBe(1);
  });

  it('reads a single event by seq', async () => {
    const s = new InMemoryTraceStore();
    await s.append(evt('s1', 7));
    const found = await s.bySeq('s1', 7);
    expect(found?.seq).toBe(7);
    expect(await s.bySeq('s1', 99)).toBeUndefined();
  });
});
