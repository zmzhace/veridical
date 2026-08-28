import { afterEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryTraceStore, JsonlTraceStore, type NewTraceEvent, type TraceStore } from '../src/index';

const input: NewTraceEvent = {
  tenant_id: 't1', session_id: 's1', span_id: 'sp', parent_span_id: null,
  type: 'probe', verb: 'response', attempt: 1, duration_ms: 0,
  payload: { nested: { value: 1 } }, spec_version: '1.0.0',
};
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function stores(kind: string): [TraceStore, TraceStore] {
  if (kind === 'memory') { const store = new InMemoryTraceStore(); return [store, store]; }
  const dir = mkdtempSync(join(tmpdir(), 'veridical-integrity-'));
  dirs.push(dir);
  return [new JsonlTraceStore(dir), new JsonlTraceStore(dir)];
}

describe.each(['memory', 'jsonl'])('%s trace integrity', kind => {
  it('allocates unique sequences under concurrent calls and shared instances', async () => {
    const pair = stores(kind);
    const events = await Promise.all(Array.from({ length: 100 }, (_, i) => pair[i % 2].appendNext(input)));
    expect(new Set(events.map(e => e.id)).size).toBe(100);
    expect(events.map(e => e.seq)).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
    expect(await pair[0].readBySession('s1')).toHaveLength(100);
  });

  it('allocates after maximum sequence, not event count', async () => {
    const [store] = stores(kind);
    await store.append({ ...input, id: 'imported', seq: 99 });
    expect((await store.appendNext(input)).seq).toBe(100);
  });

  it('rejects duplicate IDs, duplicate sequences and mixed-tenant sessions', async () => {
    const [store] = stores(kind);
    const first = await store.appendNext(input);
    await expect(store.append({ ...first, id: 'other' })).rejects.toThrow(/duplicate/);
    await expect(store.append({ ...first, seq: 2 })).rejects.toThrow(/duplicate/);
    await expect(store.appendNext({ ...input, tenant_id: 't2' })).rejects.toThrow(/tenant/);
    expect((await store.appendNext(input)).seq).toBe(2);
  });

  it('does not expose stored payloads to mutation', async () => {
    const [store] = stores(kind);
    const submitted = structuredClone(input);
    const first = await store.appendNext(submitted);
    (submitted.payload as any).nested.value = 2;
    (first.payload as any).nested.value = 3;
    const read = await store.readBySession('s1');
    (read[0].payload as any).nested.value = 4;
    expect((await store.bySeq('s1', 1))?.payload).toEqual(input.payload);
  });

  it('rejects invalid records without consuming an identity', async () => {
    const [store] = stores(kind);
    await expect(store.appendNext({ ...input, attempt: -1 })).rejects.toThrow();
    expect((await store.appendNext(input)).seq).toBe(1);
  });
});

it.each(['../escape', '/absolute', 'a/b', 'a\\b', '..', '.', '', 'bad\0id'])('rejects unsafe JSONL session key %j', async session_id => {
  const [store] = stores('jsonl');
  await expect(store.readBySession(session_id)).rejects.toThrow(/storage key/);
  await expect(store.appendNext({ ...input, session_id })).rejects.toThrow(/storage key/);
});

it.each(['duplicate', 'session', 'tenant'])('refuses corrupted JSONL %s identities without repairing history', async kind => {
  const [store] = stores('jsonl');
  const first = await store.appendNext(input);
  const corrupt = kind === 'duplicate' ? first : {
    ...first, id: 'corrupt', seq: 2,
    ...(kind === 'session' ? { session_id: 'other' } : { tenant_id: 't2' }),
  };
  appendFileSync(join((store as JsonlTraceStore).dir, 's1.jsonl'), JSON.stringify(corrupt) + '\n');
  await expect(store.readBySession('s1')).rejects.toThrow(/corrupt trace/);
  await expect(store.appendNext(input)).rejects.toThrow(/corrupt trace/);
});
