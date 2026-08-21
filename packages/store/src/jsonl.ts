import { mkdirSync, readFileSync, appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseEvent, type TraceEvent } from '@veridical/schema';
import type { TraceStore } from './trace-store';

export class JsonlTraceStore implements TraceStore {
  constructor(private dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  private file(session_id: string) {
    return join(this.dir, `${session_id}.jsonl`);
  }

  async append(evt: TraceEvent): Promise<void> {
    appendFileSync(this.file(evt.session_id), JSON.stringify(evt) + '\n', 'utf8');
  }

  async readBySession(session_id: string): Promise<TraceEvent[]> {
    const f = this.file(session_id);
    if (!existsSync(f)) return [];
    const out: TraceEvent[] = [];
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      if (line.trim() === '') continue;
      out.push(parseEvent(JSON.parse(line)));
    }
    return out.sort((a, b) => a.seq - b.seq);
  }

  async bySeq(session_id: string, seq: number): Promise<TraceEvent | undefined> {
    return (await this.readBySession(session_id)).find(e => e.seq === seq);
  }
}