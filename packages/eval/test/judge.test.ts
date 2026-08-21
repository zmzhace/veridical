import { describe, it, expect } from 'vitest';
import { LLMGateway } from '@veridical/llm';
import type { LLMProvider } from '@veridical/llm';
import type { TraceEvent } from '@veridical/schema';
import { LLMJudge, JudgeParseError, type RunResult } from '../src/index';

const usage = { input: 1, output: 1, cached: 0, total: 2 };

function result(events: TraceEvent[]): RunResult {
  return { session_id: 's1', spec_name: 'n', spec_version: '1.0.0', outcome: undefined, events };
}

function evt(seq: number, type: string, verb: string, payload: any): TraceEvent {
  return { id: `e${seq}`, tenant_id: 't1', session_id: 's1', span_id: 'sp', parent_span_id: null, seq, type, verb, attempt: 1, duration_ms: 1, payload, spec_version: '0.0.1' };
}

function judgeWith(text: string): LLMJudge {
  const provider: LLMProvider = { complete: async () => ({ text, usage }) };
  return new LLMJudge(new LLMGateway(new Map([['j', provider]])), 'j', 'j');
}

describe('LLMJudge', () => {
  const run = result([
    evt(1, 'user.message', 'request', { text: 'hello' }),
    evt(2, 'assistant.message', 'response', { text: 'hi there' }),
  ]);

  it('parses a valid JSON verdict', async () => {
    const j = judgeWith(JSON.stringify({ passed: true, reasoning: 'good' }));
    const v = await j.judge(run, 'rubric');
    expect(v.passed).toBe(true);
    expect(v.reasoning).toBe('good');
    expect(v.tokens).toEqual(usage);
  });

  it('throws JudgeParseError on invalid JSON', async () => {
    const j = judgeWith('not json at all');
    await expect(j.judge(run, 'rubric')).rejects.toThrow(JudgeParseError);
  });

  it('throws JudgeParseError on missing passed field', async () => {
    const j = judgeWith(JSON.stringify({ reasoning: 'no passed' }));
    await expect(j.judge(run, 'rubric')).rejects.toThrow(JudgeParseError);
  });
});
