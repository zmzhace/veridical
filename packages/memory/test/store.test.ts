import { describe, it, expect } from 'vitest';
import { InMemoryTraceStore } from '@veridical/store';
import { Session, Recorder } from '@veridical/runtime';
import { MemoryStore, MEMORY_SESSION, type MemoryScope } from '../src/index';

function session(id: string, spec_version = '0.0.1'): Session {
  return new Session({ session_id: id, tenant_id: 't1', spec_version });
}

async function newRecorder(store: InMemoryTraceStore, id = 's1'): Promise<Recorder> {
  return new Recorder(store, session(id));
}

describe('MemoryStore', () => {
  it('writes a memory.write event and reconstructs it via snapshot', async () => {
    const store = new InMemoryTraceStore();
    const rec = await newRecorder(store);
    const ms = new MemoryStore();
    await ms.write(rec, { key: 'k1', value: 'v1', scope: 'working' });
    const snap = await ms.snapshot(store, 's1');
    expect(snap.entries).toContainEqual({ key: 'k1', value: 'v1', scope: 'working' });
    const types = (await store.readBySession('s1')).map(e => e.type);
    expect(types).toContain('memory.write');
  });

  it('last-write-wins on the same key', async () => {
    const store = new InMemoryTraceStore();
    const rec = await newRecorder(store);
    const ms = new MemoryStore();
    await ms.write(rec, { key: 'k', value: 1, scope: 'working' });
    await ms.write(rec, { key: 'k', value: 2, scope: 'working' });
    const snap = await ms.snapshot(store, 's1');
    expect(snap.entries.find(e => e.key === 'k')?.value).toBe(2);
    expect(snap.entries.length).toBe(1);
  });

  it('snapshot excludes tombstoned keys', async () => {
    const store = new InMemoryTraceStore();
    const rec = await newRecorder(store);
    const ms = new MemoryStore();
    await ms.write(rec, { key: 'k', value: 'v', scope: 'working' });
    await ms.write(rec, { key: 'k', value: undefined, scope: 'working' });
    const snap = await ms.snapshot(store, 's1');
    expect(snap.entries.find(e => e.key === 'k')).toBeUndefined();
    expect(snap.entries).toEqual([]);
  });

  it('keeps tags and multiple scopes', async () => {
    const store = new InMemoryTraceStore();
    const rec = await newRecorder(store);
    const ms = new MemoryStore();
    await ms.write(rec, { key: 'a', value: 'x', scope: 'semantic', tags: ['claim', 'policy'] });
    await ms.write(rec, { key: 'b', value: 'y', scope: 'skill', tags: ['procedure'] });
    const snap = await ms.snapshot(store, 's1');
    expect(snap.entries).toHaveLength(2);
    expect(snap.entries.find(e => e.key === 'a')?.tags).toEqual(['claim', 'policy']);
  });

  it('read returns the current value and records a memory.read event', async () => {
    const store = new InMemoryTraceStore();
    const rec = await newRecorder(store);
    const ms = new MemoryStore();
    await ms.write(rec, { key: 'k', value: 'val', scope: 'working' });
    const rec2 = await newRecorder(store);
    expect(await ms.read(rec2, store, 's1', 'k')).toBe('val');
    expect(await ms.read(rec2, store, 's1', 'missing')).toBeUndefined();
    const types = (await store.readBySession('s1')).map(e => e.type);
    expect(types.filter(t => t === 'memory.read').length).toBeGreaterThanOrEqual(1);
  });

  it('snapshot from the shared MEMORY_SESSION holds long-term entries', async () => {
    const store = new InMemoryTraceStore();
    const rec = await newRecorder(store, MEMORY_SESSION);
    const ms = new MemoryStore();
    await ms.write(rec, { key: 'lt', value: 'long', scope: 'semantic', tags: ['shared'] });
    const snap = await ms.snapshot(store, MEMORY_SESSION);
    expect(snap.entries.find(e => e.key === 'lt')?.value).toBe('long');
  });

  it('snapshot returns empty for an unknown session', async () => {
    const store = new InMemoryTraceStore();
    const ms = new MemoryStore();
    expect((await ms.snapshot(store, 'nope')).entries).toEqual([]);
  });
});
