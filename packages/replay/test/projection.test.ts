import { describe, it, expect } from 'vitest';
import { InMemoryTraceStore } from '@veridical/store';
import type { TraceEvent } from '@veridical/schema';
import { TraceProjection } from '../src/index';

function evt(seq: number, type: string, verb: string, payload: any): TraceEvent {
  return { id: `e${seq}`, tenant_id: 't1', session_id: 's1', span_id: 'sp', parent_span_id: null, seq, type, verb, attempt: 1, duration_ms: 1, payload, spec_version: '0.0.1' };
}

async function seed(): Promise<InMemoryTraceStore> {
  const store = new InMemoryTraceStore();
  await store.append(evt(1, 'user.message', 'request', { text: 'hello' }));
  await store.append(evt(2, 'assistant.message', 'response', { text: 'hi' }));
  await store.append(evt(3, 'tool.called', 'request', { name: 'echo', args: {} }));
  await store.append(evt(4, 'tool.result', 'response', { name: 'echo', result: 'ok' }));
  return store;
}

describe('TraceProjection', () => {
  it('projects state up to a seq', async () => {
    const p = new TraceProjection(await seed());
    const snap = await p.projectAt('s1', 2);
    expect(snap.up_to_seq).toBe(2);
    expect(snap.events.map(e => e.seq)).toEqual([1, 2]);
    expect(snap.messages.map(m => m.content)).toEqual(['hello', 'hi']);
    expect(snap.last_event?.seq).toBe(2);
  });

  it('truncates when seq exceeds the event count', async () => {
    const p = new TraceProjection(await seed());
    const snap = await p.projectAt('s1', 99);
    expect(snap.events.length).toBe(4);
    expect(snap.up_to_seq).toBe(4);
  });

  it('returns empty for seq 0 or negative', async () => {
    const p = new TraceProjection(await seed());
    const snap = await p.projectAt('s1', 0);
    expect(snap.events).toEqual([]);
    expect(snap.messages).toEqual([]);
  });

  it('count returns the number of events', async () => {
    const p = new TraceProjection(await seed());
    expect(await p.count('s1')).toBe(4);
  });

  it('cursor yields one snapshot per seq', async () => {
    const p = new TraceProjection(await seed());
    const seqs: number[] = [];
    for await (const snap of p.cursor('s1')) seqs.push(snap.up_to_seq);
    expect(seqs).toEqual([1, 2, 3, 4]);
  });
});
