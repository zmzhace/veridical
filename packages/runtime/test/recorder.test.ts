import { describe, it, expect } from 'vitest';
import { InMemoryTraceStore } from '@veridical/store';
import { Session, Recorder } from '../src/index';

describe('Recorder', () => {
  it('assigns monotonic seq and fills identity fields', async () => {
    const store = new InMemoryTraceStore();
    const session = new Session({ session_id: 's1', tenant_id: 't1', spec_version: '0.0.1' });
    const rec = new Recorder(store, session);
    const e1 = await rec.record({ span_id: 'sp', parent_span_id: null, type: 'llm.request', verb: 'request', attempt: 1, duration_ms: 2, payload: {} });
    const e2 = await rec.record({ span_id: 'sp', parent_span_id: null, type: 'llm.response', verb: 'response', attempt: 1, duration_ms: 3, payload: {} });
    expect(e1.seq).toBe(1);
    expect(e2.seq).toBe(2);
    expect(e1.session_id).toBe('s1');
    expect(e1.tenant_id).toBe('t1');
    expect(e1.id).toBeTruthy();
  });

  it('appends the recorded event to the store', async () => {
    const store = new InMemoryTraceStore();
    const session = new Session({ session_id: 's2', tenant_id: 't1', spec_version: '0.0.1' });
    const rec = new Recorder(store, session);
    await rec.record({ span_id: 'sp', parent_span_id: null, type: 'llm.request', verb: 'request', attempt: 1, duration_ms: 1, payload: {} });
    const evts = await store.readBySession('s2');
    expect(evts).toHaveLength(1);
    expect(evts[0].type).toBe('llm.request');
    expect(evts[0].session_id).toBe('s2');
  });
});
