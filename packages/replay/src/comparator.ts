import type { TraceStore } from '@veridical/store';
import type { TraceEvent } from '@veridical/schema';

export interface DiffEntry {
  seq: number;
  field: 'type' | 'verb' | 'payload' | 'tokens' | 'cost';
  left?: unknown;
  right?: unknown;
  kind: 'changed' | 'left_only' | 'right_only';
}

export interface RunDiff {
  session_a: string;
  session_b: string;
  differences: DiffEntry[];
  summary: {
    events_a: number;
    events_b: number;
    first_divergence?: number;
    outcomes_equal: boolean;
    identical: boolean;
  };
}

const payloadOf = (e: TraceEvent) => e.payload as any;

function deepEq(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function outcomeOf(events: TraceEvent[]): unknown {
  const end = [...events].reverse().find(e => e.type === 'turn/end');
  return end ? payloadOf(end).outcome : undefined;
}

export class RunComparator {
  constructor(private store: TraceStore) {}

  async compare(a: string, b: string): Promise<RunDiff> {
    const evA = await this.store.readBySession(a);
    const evB = await this.store.readBySession(b);
    const bySeqA = new Map(evA.map(e => [e.seq, e]));
    const bySeqB = new Map(evB.map(e => [e.seq, e]));

    const differences: DiffEntry[] = [];
    const seqs = new Set([...bySeqA.keys(), ...bySeqB.keys()]);
    for (const seq of [...seqs].sort((x, y) => x - y)) {
      const ea = bySeqA.get(seq);
      const eb = bySeqB.get(seq);
      if (!ea) {
        differences.push({ seq, field: 'type', left: undefined, right: eb?.type, kind: 'right_only' });
      } else if (!eb) {
        differences.push({ seq, field: 'type', left: ea.type, right: undefined, kind: 'left_only' });
      } else {
        const fields: ('type' | 'verb' | 'payload' | 'tokens' | 'cost')[] = ['type', 'verb', 'payload', 'tokens', 'cost'];
        for (const field of fields) {
          const l = ea[field];
          const r = eb[field];
          if (!deepEq(l, r)) differences.push({ seq, field, left: l, right: r, kind: 'changed' });
        }
      }
    }

    const first_divergence = differences.length > 0 ? differences[0].seq : undefined;
    return {
      session_a: a,
      session_b: b,
      differences,
      summary: {
        events_a: evA.length,
        events_b: evB.length,
        first_divergence,
        outcomes_equal: deepEq(outcomeOf(evA), outcomeOf(evB)),
        identical: differences.length === 0,
      },
    };
  }
}
