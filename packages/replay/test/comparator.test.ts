import { describe, it, expect } from 'vitest';
import { InMemoryTraceStore } from '@veridical/store';
import type { TraceEvent } from '@veridical/schema';
import { RunComparator } from '../src/index';

function evt(seq: number, type: string, verb: string, payload: any, session_id = 's'): TraceEvent {
  return { id: `e${seq}`, tenant_id: 't1', session_id, span_id: 'sp', parent_span_id: null, seq, type, verb, attempt: 1, duration_ms: 1, payload, spec_version: '0.0.1' };
}

async function seedA(): Promise<InMemoryTraceStore> {
  const store = new InMemoryTraceStore();
  await store.append(evt(1, 'user.message', 'request', { text: 'hello' }, 'a'));
  await store.append(evt(2, 'assistant.message', 'response', { text: 'hi' }, 'a'));
  await store.append(evt(99, 'turn/end', 'response', { outcome: 'done' }, 'a'));
  return store;
}

describe('RunComparator', () => {
  it('reports identical for two same sessions', async () => {
    const store = await seedA();
    const cmp = new RunComparator(store);
    const diff = await cmp.compare('a', 'a');
    expect(diff.summary.identical).toBe(true);
    expect(diff.differences).toEqual([]);
    expect(diff.summary.outcomes_equal).toBe(true);
  });

  it('reports changed for a differing payload', async () => {
    const store = await seedA();
    await store.append(evt(2, 'assistant.message', 'response', { text: 'bye' }, 'b'));
    await store.append(evt(1, 'user.message', 'request', { text: 'hello' }, 'b'));
    await store.append(evt(99, 'turn/end', 'response', { outcome: 'done' }, 'b'));
    const cmp = new RunComparator(store);
    const diff = await cmp.compare('a', 'b');
    expect(diff.summary.identical).toBe(false);
    const changed = diff.differences.find(d => d.field === 'payload');
    expect(changed).toBeDefined();
    expect(diff.summary.first_divergence).toBe(2);
  });

  it('reports left_only / right_only for differing event counts', async () => {
    const store = await seedA();
    await store.append(evt(1, 'user.message', 'request', { text: 'hello' }, 'c'));
    await store.append(evt(3, 'turn/end', 'response', { outcome: 'done' }, 'c'));
    const cmp = new RunComparator(store);
    const diff = await cmp.compare('a', 'c');
    expect(diff.summary.identical).toBe(false);
    expect(diff.summary.events_a).toBe(3);
    expect(diff.summary.events_b).toBe(2);
    expect(diff.differences.some(d => d.kind === 'right_only')).toBe(true);
  });

  it('reports unequal outcomes', async () => {
    const store = await seedA();
    await store.append(evt(1, 'user.message', 'request', { text: 'hello' }, 'd'));
    await store.append(evt(99, 'turn/end', 'response', { outcome: 'failed' }, 'd'));
    const cmp = new RunComparator(store);
    const diff = await cmp.compare('a', 'd');
    expect(diff.summary.outcomes_equal).toBe(false);
  });
});
