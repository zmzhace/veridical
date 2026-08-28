import type { Recorder } from '@veridical/runtime';
import type { TraceStore } from '@veridical/store';
import { MemoryStore, MEMORY_SESSION, type MemoryEntry } from './store';
import type { MemoryScope } from './events';

function stringify(v: unknown): string {
  return typeof v === 'string' ? v : JSON.stringify(v);
}

function tokenize(query: string): string[] {
  return query.split(/\W+/).map(t => t.trim().toLowerCase()).filter(t => t.length >= 2);
}

export class Memory {
  constructor(
    private store: MemoryStore,
    private storeImpl: TraceStore,       // the underlying store (for snapshot/recall reads)
    private session_id: string,
    private recorder: Recorder,          // bound to current session (working memory)
    private longRecorder: Recorder,      // bound to MEMORY_SESSION (long-term memory)
  ) {}

  async remember(key: string, value: unknown): Promise<void> {
    await this.store.write(this.recorder, { key, value, scope: 'working' });
  }

  async workingGet(key: string): Promise<unknown> {
    const snap = await this.store.snapshot(this.storeImpl, this.session_id);
    return snap.entries.find(e => e.key === key)?.value;
  }

  async rememberSemantic(key: string, value: unknown, tags?: string[]): Promise<void> {
    await this.store.write(this.longRecorder, { key, value, scope: 'semantic', ...(tags ? { tags } : {}) });
  }

  async rememberSkill(name: string, procedure: unknown, tags?: string[]): Promise<void> {
    const isFull = procedure !== null && typeof procedure === 'object' &&
      'name' in (procedure as Record<string, unknown>) &&
      'description' in (procedure as Record<string, unknown>);
    const value = isFull ? procedure : { name, description: name, procedure };
    await this.store.write(this.longRecorder, {
      key: `skill:${name}`,
      value,
      scope: 'skill',
      ...(tags ? { tags } : {}),
    });
  }

  async listSkills(): Promise<MemoryEntry[]> {
    const snap = await this.store.snapshot(this.storeImpl, MEMORY_SESSION);
    return snap.entries.filter(e => e.scope === 'skill');
  }

  async recall(query: string, opts?: { tags?: string[]; limit?: number; recorder?: Recorder }): Promise<MemoryEntry[]> {
    const limit = opts?.limit ?? 5;
    const keywords = tokenize(query);
    const byKey = new Map<string, MemoryEntry>();
    const seqOrder: string[] = [];
    // Rebuild with write order (recency): iterate events in seq order.
    const events = await this.storeImpl.readBySession(MEMORY_SESSION);
    for (const e of events) {
      if (e.type !== 'memory.write') continue;
      const p = (e.payload as any);
      if (p.scope !== 'semantic' && p.scope !== 'skill') continue;
      if (p.value === undefined) { byKey.delete(p.key); continue; }  // tombstone
      byKey.set(p.key, { key: p.key, value: p.value, scope: p.scope, ...(p.tags ? { tags: p.tags } : {}) });
      seqOrder.push(p.key);
    }
    let matches = [...byKey.values()].filter(entry => {
      const tags = entry.tags ?? [];
      const tagHit = keywords.some(kw => tags.some(t => t.toLowerCase() === kw)) ||
        (opts?.tags ? tags.some(t => opts.tags!.includes(t)) : false);
      const kwHit = keywords.some(kw => stringify(entry.value).toLowerCase().includes(kw));
      return tagHit || kwHit;
    });
    // Recency: order by last-write seq descending (last occurrence per key wins).
    const lastSeq = new Map<string, number>();
    seqOrder.forEach((k, i) => lastSeq.set(k, i));
    matches.sort((a, b) => (lastSeq.get(b.key) ?? 0) - (lastSeq.get(a.key) ?? 0));
    matches = matches.slice(0, limit);

    await (opts?.recorder ?? this.recorder).record({
      span_id: 'memory', parent_span_id: null, type: 'memory.recalled', verb: 'response', attempt: 1, duration_ms: 0,
      payload: { action: 'recall', query, scope: 'semantic', hits: matches.map(m => ({ key: m.key })) },
    });
    return matches;
  }

  async forget(key: string, scope: MemoryScope): Promise<void> {
    const target = scope === 'working' ? this.recorder : this.longRecorder;
    await this.store.write(target, { key, value: undefined, scope });
  }
}
