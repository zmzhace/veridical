import { describe, it, expect } from 'vitest';
import { InMemoryTraceStore } from '@veridical/store';
import { Session, Recorder, runSingleLoop, type FlowContext } from '../../src/index';

describe('runSingleLoop', () => {
  it('runs gather-act-verify loop and stops when done', async () => {
    const store = new InMemoryTraceStore();
    const session = new Session({ session_id: 's1', tenant_id: 't1', spec_version: '0.0.1' });
    const recorder = new Recorder(store, session);
    let verifyCalled = 0;

    const ctx: FlowContext = {
      recorder,
      async runStep() {
        return { text: 'answer', tool: { name: 'do_thing', args: {} } };
      },
      async executeTool() { return 'ok'; },
      shouldStop(outcome) { return outcome !== undefined; },
      verifyToolResult(_name: string, _result: unknown) { verifyCalled++; return true; },
      maxSteps: 5,
    };

    await runSingleLoop(ctx, 'do the task');
    const events = await store.readBySession('s1');
    const types = events.map(e => e.type);
    expect(types).toContain('turn/start');
    expect(types).toContain('step/start');
    expect(types).toContain('step/end');
    expect(types).toContain('turn/end');
    expect(verifyCalled).toBe(1);
  });

  it('emits user.message and tool.called with name/args for a tool step', async () => {
    const store = new InMemoryTraceStore();
    const session = new Session({ session_id: 's1', tenant_id: 't1', spec_version: '0.0.1' });
    const recorder = new Recorder(store, session);

    const ctx: FlowContext = {
      recorder,
      async runStep() {
        return { text: 'answer', tool: { name: 'do_thing', args: { q: 1 } } };
      },
      async executeTool() { return 'ok'; },
      shouldStop(outcome) { return outcome !== undefined; },
      verifyToolResult(_name: string, _result: unknown) { return true; },
      maxSteps: 5,
    };

    await runSingleLoop(ctx, 'do the task');
    const events = await store.readBySession('s1');
    const user = events.find(e => e.type === 'user.message');
    const toolCalled = events.find(e => e.type === 'tool.called');
    expect(user?.payload).toEqual({ text: 'do the task' });
    expect(toolCalled?.payload).toEqual({ name: 'do_thing', args: { q: 1 } });
  });

  it('emits an assistant.message when the step returns text only', async () => {
    const store = new InMemoryTraceStore();
    const session = new Session({ session_id: 's2', tenant_id: 't1', spec_version: '0.0.1' });
    const recorder = new Recorder(store, session);

    const ctx: FlowContext = {
      recorder,
      async runStep() { return { text: 'plain answer' }; },
      async executeTool() { throw new Error('unexpected tool call'); },
      shouldStop(outcome) { return outcome !== undefined; },
      verifyToolResult(_name: string, _result: unknown) { return true; },
      maxSteps: 5,
    };

    await runSingleLoop(ctx, 'ask me');
    const events = await store.readBySession('s2');
    const types = events.map(e => e.type);
    expect(types).toContain('user.message');
    expect(types).toContain('assistant.message');
    const am = events.find(e => e.type === 'assistant.message');
    expect(am?.payload.text).toBe('plain answer');
  });

  it('emits tool.result error and step/end error when verification fails, then retries', async () => {
    const store = new InMemoryTraceStore();
    const session = new Session({ session_id: 's3', tenant_id: 't1', spec_version: '0.0.1' });
    const recorder = new Recorder(store, session);
    let runCalls = 0;

    const ctx: FlowContext = {
      recorder,
      async runStep() { runCalls++; return { text: 'x', tool: { name: 'do_thing', args: {} } }; },
      async executeTool() { return 'bad'; },
      shouldStop() { return false; },
      verifyToolResult(_name: string, _result: unknown) { return false; },
      maxSteps: 2,
    };

    await runSingleLoop(ctx, 'p');
    const events = await store.readBySession('s3');
    const errResults = events.filter(e => e.type === 'tool.result' && e.verb === 'error');
    const errEnds = events.filter(e => e.type === 'step/end' && e.verb === 'error');
    expect(errResults.length).toBe(2);
    expect(errEnds.length).toBe(2);
    expect(errResults[0].payload).toMatchObject({ name: 'do_thing', result: 'bad', blocked: true });
    expect(errEnds[0].payload).toMatchObject({ blocked: true });
    expect(runCalls).toBe(2);
  });
});