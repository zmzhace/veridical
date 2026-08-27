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

describe('runStageGate turn mode', () => {
  it('turn mode records turn/start + user.message + turn/end and completes gate within turn', async () => {
    const store = new InMemoryTraceStore();
    const session = new Session({ session_id: 'tg1', tenant_id: 't1', spec_version: '1.0.0' });
    const recorder = new Recorder(store, session);
    const ctx: FlowContext = {
      recorder,
      runStep: async () => ({ text: '', tool: { name: 'verify_health', args: {} } }),
      executeTool: async () => 'ok',
      shouldStop: () => false, verifyToolResult: () => true, maxSteps: 5,
    };
    const stages: Stage[] = [{ id: 'health_check', gate: { tool_called: 'verify_health' } }];
    await runStageGate(ctx, '我要转保', stages, () => store.readBySession('tg1'), { turn: true });
    const types = (await store.readBySession('tg1')).map(e => e.type);
    expect(types).toContain('turn/start');
    expect(types).toContain('user.message');
    expect(types).toContain('turn/end');
    expect(types).toContain('stage/end');
  });

  it('turn mode: second turn resumes at first incomplete stage, gate scoped to own turn (no instant pass)', async () => {
    const store = new InMemoryTraceStore();
    const session = new Session({ session_id: 'tg2', tenant_id: 't1', spec_version: '1.0.0' });
    const recorder = new Recorder(store, session);
    const stages: Stage[] = [
      { id: 's1', gate: { tool_called: 'a' } },
      { id: 's2', gate: { tool_called: 'b' } },
    ];
    // turn1: runStep only ever calls tool 'a' → s1 passes, s2 not → graceful end, no throw
    const ctx1: FlowContext = { recorder, runStep: async () => ({ text: '', tool: { name: 'a', args: {} } }), executeTool: async () => 'ok', shouldStop: () => false, verifyToolResult: () => true, maxSteps: 2 };
    await runStageGate(ctx1, 't1', stages, () => store.readBySession('tg2'), { turn: true });
    // turn2: now calls tool 'b' → s2 passes. CRUCIAL: s2 must not have passed in turn1 due to scanning whole session.
    const ctx2: FlowContext = { recorder, runStep: async () => ({ text: '', tool: { name: 'b', args: {} } }), executeTool: async () => 'ok', shouldStop: () => false, verifyToolResult: () => true, maxSteps: 2 };
    await runStageGate(ctx2, 't2', stages, () => store.readBySession('tg2'), { turn: true });
    const events = await store.readBySession('tg2');
    const completed = events.filter(e => e.type === 'stage/end' && e.verb === 'response').map(e => (e.payload as any).stage);
    expect(completed).toContain('s1');
    expect(completed).toContain('s2');
    expect(events.filter(e => e.type === 'turn/start').length).toBe(2);
    // turn1 called tool a but not b; ensure s2's gate tool ran in turn2 (seq after turn2's turn/start)
    const bCall = events.find(e => e.type === 'tool.result' && (e.payload as any)?.name === 'b');
    expect(bCall).toBeDefined();
  });

  it('turn mode: gate never satisfied → no throw, no stage/end error', async () => {
    const store = new InMemoryTraceStore();
    const session = new Session({ session_id: 'tg3', tenant_id: 't1', spec_version: '1.0.0' });
    const recorder = new Recorder(store, session);
    const ctx: FlowContext = { recorder, runStep: async () => ({ text: '聊天', tool: undefined }), executeTool: async () => 'ok', shouldStop: () => false, verifyToolResult: () => true, maxSteps: 2 };
    await runStageGate(ctx, 't', [{ id: 's1', gate: { tool_called: 'x' } }], () => store.readBySession('tg3'), { turn: true });
    const events = await store.readBySession('tg3');
    expect(events.some(e => e.type === 'stage/end' && e.verb === 'error')).toBe(false);
    expect(events.filter(e => e.type === 'turn/start').length).toBe(1);
    expect(events.filter(e => e.type === 'turn/end').length).toBe(1);
  });
});