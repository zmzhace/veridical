import { describe, it, expect } from 'vitest';
import type { TraceEvent } from '@veridical/schema';
import type { FlowContext } from '../src/flows/engine';
import { runStageGate, gateSatisfied, StageGateError } from '../src/flows/stage-gate';
import type { Stage } from '@veridical/spec';
import { Session, Recorder } from '../src/index';
import { InMemoryTraceStore } from '@veridical/store';

function toolEvt(name: string, verb: 'response' | 'error', span: string): TraceEvent {
  return {
    id: `e_${name}_${verb}`, tenant_id: 't1', session_id: 's1', span_id: span, parent_span_id: null,
    seq: 1, type: 'tool.result', verb, attempt: 1, duration_ms: 1, payload: { name }, spec_version: '1.0.0',
  };
}

describe('gateSatisfied', () => {
  it('true when tool succeeded in the stage span', () => {
    const stage: Stage = { id: 'health_check', gate: { tool_called: 'verify_health' } };
    const events = [toolEvt('verify_health', 'response', 'stage:health_check')];
    expect(gateSatisfied(stage, events)).toBe(true);
  });

  it('false when tool blocked (verb error)', () => {
    const stage: Stage = { id: 'health_check', gate: { tool_called: 'verify_health' } };
    const events = [toolEvt('verify_health', 'error', 'stage:health_check')];
    expect(gateSatisfied(stage, events)).toBe(false);
  });

  it('false when different stage span', () => {
    const stage: Stage = { id: 'health_check', gate: { tool_called: 'verify_health' } };
    const events = [toolEvt('verify_health', 'response', 'stage:other')];
    expect(gateSatisfied(stage, events)).toBe(false);
  });

  it('true immediately when no gate', () => {
    const stage: Stage = { id: 'close' };
    expect(gateSatisfied(stage, [])).toBe(true);
  });
});

describe('runStageGate', () => {
  it('advances through stages when gates satisfied', async () => {
    const store = new InMemoryTraceStore();
    const session = new Session({ session_id: 's1', tenant_id: 't1', spec_version: '1.0.0' });
    const recorder = new Recorder(store, session);
    const ctx: FlowContext = {
      recorder,
      runStep: async () => ({ text: '', tool: { name: 'verify_health', args: {} } }),
      executeTool: async () => 'ok',
      shouldStop: () => false,
      verifyToolResult: () => true,
      maxSteps: 5,
    };
    const stages: Stage[] = [
      { id: 'health_check', gate: { tool_called: 'verify_health' } },
      { id: 'close' },
    ];
    await runStageGate(ctx, 'hi', stages, () => store.readBySession('s1'));
    const events = await store.readBySession('s1');
    const types = events.map(e => e.type);
    expect(types).toContain('stage/start');
    expect(types).toContain('stage/end');
    expect(types.filter(t => t === 'stage/start')).toHaveLength(2);
    expect(types.filter(t => t === 'stage/end')).toHaveLength(2);
  });

  it('throws StageGateError when a gate is never satisfied', async () => {
    const store = new InMemoryTraceStore();
    const session = new Session({ session_id: 's2', tenant_id: 't1', spec_version: '1.0.0' });
    const recorder = new Recorder(store, session);
    const ctx: FlowContext = {
      recorder,
      runStep: async () => ({ text: 'say something', tool: undefined }),
      executeTool: async () => 'ok',
      shouldStop: () => false,
      verifyToolResult: () => true,
      maxSteps: 2,
    };
    const stages: Stage[] = [{ id: 'health_check', gate: { tool_called: 'verify_health' } }];
    await expect(runStageGate(ctx, 'hi', stages, () => store.readBySession('s2'))).rejects.toThrow(StageGateError);
    const events = await store.readBySession('s2');
    const end = [...events].reverse().find(e => e.type === 'stage/end' && e.span_id === 'stage:health_check');
    expect(end?.verb).toBe('error');
  });

  it('throws StageGateError when the gate tool call is denied/blocked', async () => {
    const store = new InMemoryTraceStore();
    const session = new Session({ session_id: 's3', tenant_id: 't1', spec_version: '1.0.0' });
    const recorder = new Recorder(store, session);
    const ctx: FlowContext = {
      recorder,
      runStep: async () => ({ text: '', tool: { name: 'verify_health', args: {} } }),
      executeTool: async () => ({ ok: false, reason: 'denied' }),
      shouldStop: () => false,
      verifyToolResult: () => true,
      maxSteps: 3,
    };
    const stages: Stage[] = [{ id: 'health_check', gate: { tool_called: 'verify_health' } }];
    await expect(runStageGate(ctx, 'hi', stages, () => store.readBySession('s3'))).rejects.toThrow(StageGateError);
    const events = await store.readBySession('s3');
    // no satisfying tool.result (verb response) recorded for the denied call
    const sat = events.find(e => e.type === 'tool.result' && e.verb === 'response' && (e.payload as any)?.name === 'verify_health');
    expect(sat).toBeUndefined();
    const end = [...events].reverse().find(e => e.type === 'stage/end' && e.span_id === 'stage:health_check');
    expect(end?.verb).toBe('error');
  });
});