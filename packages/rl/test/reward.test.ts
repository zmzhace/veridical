import { describe, it, expect } from 'vitest';
import { RewardAggregator } from '../src/reward';
import { ruleOutcomeEquals, ruleToolCalled } from '@veridical/eval';
import { InMemoryTraceStore } from '@veridical/store';
import type { TraceEvent } from '@veridical/schema';

function evt(seq: number, type: string, verb: string, payload: any): TraceEvent {
  return { id: `e${seq}`, tenant_id: 't1', session_id: 's1', span_id: 'sp', parent_span_id: null, seq, type, verb, attempt: 1, duration_ms: 1, payload, spec_version: '0.0.1' };
}
function run(outcome: unknown, events: TraceEvent[] = []) {
  return { session_id: 's1', spec_name: 'n', spec_version: '1.0.0', outcome, events: [evt(1,'turn/start','request',{}), ...events, evt(9,'turn/end','response',{outcome})] };
}

describe('RewardAggregator', () => {
  it('rule source: passing rules contribute, failing gives 0', async () => {
    const agg = new RewardAggregator([ruleOutcomeEquals('done')]);
    const ok = await agg.score(run('done'), { store: new InMemoryTraceStore() });
    const bad = await agg.score(run('nope'), { store: new InMemoryTraceStore() });
    // With default weights {rule:1, replay:1, process:0.5, judge:0.5} and no
    // golden/judge/step events, the denominator is 3 and only `rule` is non-zero,
    // so a passing rule yields 1/3 and a failing rule yields 0.
    expect(ok.reward).toBeCloseTo(1 / 3, 5);
    expect(bad.reward).toBe(0);
  });

  it('replay source contributes 0 when no goldenSessionId', async () => {
    const agg = new RewardAggregator([ruleOutcomeEquals('done')]);
    const r = await agg.score(run('done'), { store: new InMemoryTraceStore() });
    expect(r.breakdown.replay).toBe(0);
  });
});
