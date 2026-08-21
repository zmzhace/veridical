import { describe, it, expect } from 'vitest';
import { parseEvent } from '../src/event';

describe('TraceEvent', () => {
  const base = {
    id: 'evt_1', tenant_id: 't1', session_id: 's1', span_id: 'sp1', parent_span_id: null,
    seq: 1, type: 'llm.request', verb: 'request', attempt: 1, duration_ms: 12,
    payload: { model: 'gpt-4o' }, spec_version: '0.0.1',
  };

  it('parses a valid minimal event', () => {
    expect(parseEvent(base).seq).toBe(1);
  });

  it('rejects a missing required field', () => {
    const bad = { ...base };
    delete (bad as any).seq;
    expect(() => parseEvent(bad)).toThrow();
  });

  it('accepts tokens and call_id when present', () => {
    const withMeta = { ...base, tokens: { input: 5, output: 3, cached: 0, total: 8 }, cost: 0.001, call_id: 'call_1' };
    const parsed = parseEvent(withMeta);
    expect(parsed.tokens?.total).toBe(8);
    expect(parsed.call_id).toBe('call_1');
  });
});
