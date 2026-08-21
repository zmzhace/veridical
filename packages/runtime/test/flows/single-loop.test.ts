import { describe, it, expect } from 'vitest';
import { InMemoryTraceStore } from '@rt/store';
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
      verifyToolResult() { verifyCalled++; return true; },
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
});