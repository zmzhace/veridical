import type { TraceStore } from '@veridical/store';
import type { TraceEvent } from '@veridical/schema';
import type { Recorder } from '@veridical/runtime';
import type { MemoryScope } from './events';

export const MEMORY_SESSION = '_memory';

export interface MemoryEntry {
  key: string;
  value: unknown;
  scope: MemoryScope;
  tags?: string[];
}

export interface MemorySnapshot {
  entries: MemoryEntry[];
}

const payloadOf = (e: TraceEvent) => e.payload as any;

export class MemoryStore {
  async write(recorder: Recorder, entry: MemoryEntry): Promise<void> {
    await recorder.record({
      span_id: 'memory', parent_span_id: null, type: 'memory.write', verb: 'request', attempt: 1, duration_ms: 0,
      payload: { action: 'write', key: entry.key, value: entry.value, scope: entry.scope, ...(entry.tags ? { tags: entry.tags } : {}) },
    });
  }

  async read(recorder: Recorder, store: TraceStore, session_id: string, key: string): Promise<unknown> {
    await recorder.record({
      span_id: 'memory', parent_span_id: null, type: 'memory.read', verb: 'request', attempt: 1, duration_ms: 0,
      payload: { action: 'read', key, scope: 'working' },
    });
    const snap = await this.snapshot(store, session_id);
    return snap.entries.find(e => e.key === key)?.value;
  }

  async snapshot(store: TraceStore, session_id: string): Promise<MemorySnapshot> {
    const events = await store.readBySession(session_id);
    const byKey = new Map<string, MemoryEntry>();
    for (const e of events) {
      if (e.type !== 'memory.write') continue;
      const p = payloadOf(e);
      if (p.value === undefined) { byKey.delete(p.key); continue; }  // tombstone
      byKey.set(p.key, { key: p.key, value: p.value, scope: p.scope, ...(p.tags ? { tags: p.tags } : {}) });
    }
    return { entries: [...byKey.values()] };
  }
}
