import { describe, expect, it } from 'vitest';
import { InMemoryTraceStore } from '@veridical/store';
import { Recorder, Session, type FlowContext, LoopRegistry, ResearchLoop, PlanAndSolveLoop, ReflectionLoop } from '../../src';

function context(overrides: Partial<FlowContext> = {}) {
  const store = new InMemoryTraceStore();
  const recorder = new Recorder(store, new Session({ session_id: 'loop-test', tenant_id: 't1', spec_version: '1.0.0' }));
  return { store, recorder, ctx: {
    recorder, maxSteps: 4, shouldStop: () => false, verifyToolResult: () => true,
    runStep: async () => ({ text: 'plan' }), executeTool: async () => ({ ok: true }), ...overrides,
  } satisfies FlowContext };
}

describe('pluggable loops', () => {
  it('registers and runs the research loop with checkpoints', async () => {
    const { store, ctx } = context({ executeTool: async (name) => ({ tool: name, evidence: true }) });
    const registry = new LoopRegistry().register(new ResearchLoop());
    await registry.get('research')!.run(ctx, 'question');
    const types = (await store.readBySession('loop-test')).map((event) => event.type);
    expect(types).toContain('research/start');
    expect(types).toContain('research/end');
  });

  it('fails fast when cancelled before a step', async () => {
    const controller = new AbortController(); controller.abort(new Error('cancelled'));
    const { ctx } = context({ signal: controller.signal });
    await expect(new ResearchLoop().run(ctx, 'question')).rejects.toThrow('cancelled');
  });

  it('runs plan-and-solve and reflection strategies through the shared context', async () => {
    const seen: string[] = [];
    const { ctx } = context({ runStep: async (prompt) => { seen.push(prompt); return { text: 'ok' }; }, checkpoint: async () => undefined });
    await new PlanAndSolveLoop().run(ctx, 'task');
    await new ReflectionLoop().run(ctx, 'task');
    expect(seen).toHaveLength(5);
    expect(seen[0]).toContain('制定执行计划');
    expect(seen[2]).toContain('草稿');
  });
});
