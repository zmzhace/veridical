import { mkdirSync, readFileSync, appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseEvent, type TraceEvent } from '@veridical/schema';
import type { NewTraceEvent, TraceStore } from './trace-store';
import { assertAppendable, assertStorageKey, nextEvent } from './integrity';

export class JsonlTraceStore implements TraceStore {
  constructor(public dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  private file(session_id: string) {
    assertStorageKey(session_id);
    return join(this.dir, `${session_id}.jsonl`);
  }

  async append(evt: TraceEvent): Promise<void> {
    evt = parseEvent(evt);
    assertAppendable(this.read(evt.session_id), evt);
    appendFileSync(this.file(evt.session_id), JSON.stringify(evt) + '\n', 'utf8');
  }

  async appendNext(input: NewTraceEvent): Promise<TraceEvent> {
    // Synchronous critical section also covers separate store instances in this process.
    // JSONL remains single-process only; use a transactional store for multiple workers.
    const events = this.read(input.session_id);
    const evt = nextEvent(events, input);
    assertAppendable(events, evt);
    appendFileSync(this.file(evt.session_id), JSON.stringify(evt) + '\n', 'utf8');
    return structuredClone(evt);
  }

  async readBySession(session_id: string): Promise<TraceEvent[]> {
    return this.read(session_id);
  }

  private read(session_id: string): TraceEvent[] {
    const f = this.file(session_id);
    if (!existsSync(f)) return [];
    const out: TraceEvent[] = [];
    const ids = new Set<string>();
    const seqs = new Set<number>();
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      if (line.trim() === '') continue;
      const evt = parseEvent(JSON.parse(line));
      if (evt.session_id !== session_id || (out.length > 0 && evt.tenant_id !== out[0].tenant_id)) {
        throw new Error('corrupt trace: inconsistent session or tenant');
      }
      if (ids.has(evt.id) || seqs.has(evt.seq)) throw new Error('corrupt trace: duplicate event identity or sequence');
      ids.add(evt.id);
      seqs.add(evt.seq);
      out.push(evt);
    }
    return out.sort((a, b) => a.seq - b.seq);
  }

  async bySeq(session_id: string, seq: number): Promise<TraceEvent | undefined> {
    return (await this.readBySession(session_id)).find(e => e.seq === seq);
  }
}
