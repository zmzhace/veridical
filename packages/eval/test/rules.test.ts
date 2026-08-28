import { describe, it, expect } from 'vitest';
import {
  ruleOutcomeEquals, ruleTextContains, ruleToolCalled, ruleToolNotDenied, ruleNoErrors,
  RuleEngine, type TraceEvent,
} from '../src/index';

function evt(seq: number, type: string, verb: string, payload: any): TraceEvent {
  return { id: `e${seq}`, tenant_id: 't1', session_id: 's1', span_id: 'sp', parent_span_id: null, seq, type, verb, attempt: 1, duration_ms: 1, payload, spec_version: '0.0.1' };
}

function run(events: TraceEvent[]) {
  return [
    evt(1, 'turn/start', 'request', {}),
    ...events,
    evt(99, 'turn/end', 'response', { outcome: 'done' }),
  ];
}

describe('built-in rules', () => {
  it('ruleOutcomeEquals passes when turn/end outcome matches', () => {
    expect(ruleOutcomeEquals('done').check(run([]))).toEqual({ passed: true });
  });

  it('ruleOutcomeEquals fails on mismatch', () => {
    expect(ruleOutcomeEquals('nope').check(run([]))).toEqual({ passed: false });
  });

  it('ruleTextContains matches assistant text', () => {
    const evts = run([evt(2, 'assistant.message', 'response', { text: '您的保单号已收到' })]);
    expect(ruleTextContains('保单号').check(evts)).toEqual({ passed: true });
    expect(ruleTextContains('不存在的词').check(evts)).toMatchObject({ passed: false });
  });

  it('ruleToolCalled matches a tool.called event', () => {
    const evts = run([evt(2, 'tool.called', 'request', { name: 'lookup_policy', args: {} })]);
    expect(ruleToolCalled('lookup_policy').check(evts)).toEqual({ passed: true });
    expect(ruleToolCalled('other').check(evts)).toMatchObject({ passed: false });
  });

  it('ruleToolNotDenied passes when tool never denied', () => {
    const evts = run([evt(2, 'tool.result', 'response', { name: 'lookup_policy', result: 'ok' })]);
    expect(ruleToolNotDenied('lookup_policy').check(evts)).toEqual({ passed: true });
  });

  it('ruleToolNotDenied fails when tool was denied', () => {
    const evts = run([evt(2, 'tool.result', 'response', { name: 'lookup_policy', result: { ok: false, reason: 'denied' } })]);
    expect(ruleToolNotDenied('lookup_policy').check(evts)).toMatchObject({ passed: false });
  });

  it('ruleNoErrors passes on clean run and fails on an error event', () => {
    expect(ruleNoErrors().check(run([]))).toEqual({ passed: true });
    const bad = run([evt(2, 'llm.response', 'error', { message: 'boom' })]);
    expect(ruleNoErrors().check(bad)).toMatchObject({ passed: false });
  });

  it('rejects legacy denied results even when their verb is response', () => {
    expect(ruleNoErrors().check(run([
      evt(2, 'tool.result', 'response', { name: 'echo', result: { ok: false, reason: 'denied' } }),
    ])).passed).toBe(false);
  });

  it('rejects stage and step errors as well as provider errors', () => {
    expect(ruleNoErrors().check(run([evt(2, 'stage/end', 'error', {})])).passed).toBe(false);
  });
});

describe('RuleEngine', () => {
  it('passes when all rules pass', () => {
    const engine = new RuleEngine([ruleOutcomeEquals('done'), ruleNoErrors()]);
    expect(engine.evaluate(run([])).passed).toBe(true);
  });

  it('fails when any rule fails and reports which', () => {
    const engine = new RuleEngine([ruleOutcomeEquals('wrong'), ruleNoErrors()]);
    const report = engine.evaluate(run([]));
    expect(report.passed).toBe(false);
    expect(report.rules.find(r => r.name === 'outcome_equals')?.passed).toBe(false);
  });

  it('passes vacuously with no rules', () => {
    expect(new RuleEngine([]).evaluate(run([])).passed).toBe(true);
  });
});
