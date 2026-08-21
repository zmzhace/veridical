import { describe, it, expect } from 'vitest';
import { LLMGateway } from '@veridical/llm';
import type { TraceEvent } from '@veridical/schema';
import { evaluateRun, ruleOutcomeEquals, ruleNoErrors, type RunResult } from '../src/index';

function evt(seq: number, type: string, verb: string, payload: any): TraceEvent {
  return { id: `e${seq}`, tenant_id: 't1', session_id: 's1', span_id: 'sp', parent_span_id: null, seq, type, verb, attempt: 1, duration_ms: 1, payload, spec_version: '0.0.1' };
}

function result(outcome: unknown, extra: TraceEvent[] = []): RunResult {
  const events: TraceEvent[] = [
    evt(1, 'turn/start', 'request', {}),
    ...extra,
    evt(99, 'turn/end', 'response', { outcome }),
  ];
  return { session_id: 's1', spec_name: 'n', spec_version: '1.0.0', outcome, events };
}

describe('evaluateRun', () => {
  it('passes when all rules pass', async () => {
    const report = await evaluateRun(result('done'), { rules: [ruleOutcomeEquals('done')] });
    expect(report.passed).toBe(true);
    expect(report.rules?.passed).toBe(true);
  });

  it('fails when a rule fails', async () => {
    const report = await evaluateRun(result('wrong'), { rules: [ruleOutcomeEquals('done')] });
    expect(report.passed).toBe(false);
  });

  it('treats golden as ruleOutcomeEquals sugar', async () => {
    const report = await evaluateRun(result('done'), { golden: 'done' });
    expect(report.passed).toBe(true);
  });

  it('supports pass_requirement any', async () => {
    const report = await evaluateRun(result('wrong'), { rules: [ruleOutcomeEquals('done'), ruleNoErrors()], pass_requirement: 'any' });
    expect(report.passed).toBe(true);
  });

  it('combines rules and judge', async () => {
    const provider: import('@veridical/llm').LLMProvider = {
      complete: async () => ({ text: JSON.stringify({ passed: true, reasoning: 'looks good' }), usage: { input: 1, output: 1, cached: 0, total: 2 } }),
    };
    const gw = new LLMGateway(new Map([['j', provider]]));
    const judge = new (await import('../src/judge')).LLMJudge(gw, 'j', 'j');
    const report = await evaluateRun(result('done'), { judge: { provider: 'j', model: 'j', rubric: 'r' } }, judge);
    expect(report.passed).toBe(true);
    expect(report.judge?.reasoning).toBe('looks good');
  });

  it('judge failure makes the report fail when judge provided', async () => {
    const provider: import('@veridical/llm').LLMProvider = {
      complete: async () => ({ text: JSON.stringify({ passed: false, reasoning: 'bad' }), usage: { input: 1, output: 1, cached: 0, total: 2 } }),
    };
    const gw = new LLMGateway(new Map([['j', provider]]));
    const judge = new (await import('../src/judge')).LLMJudge(gw, 'j', 'j');
    const report = await evaluateRun(result('done'), { judge: { provider: 'j', model: 'j', rubric: 'r' } }, judge);
    expect(report.passed).toBe(false);
  });
});
