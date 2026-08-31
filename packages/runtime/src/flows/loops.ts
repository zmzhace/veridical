import type { FlowContext, AgentLoop } from './engine';
import { runSingleLoop } from './single-loop';
import { runStageGate } from './stage-gate';
import { canonicalJson } from '../invocation';

export class DirectLoop implements AgentLoop {
  readonly kind = 'direct';
  async run(ctx: FlowContext, prompt: string): Promise<void> {
    await runSingleLoop(ctx, prompt);
  }
}

/** Two-pass planning loop: planning remains an LLM decision, execution uses the same context. */
export class PlanAndSolveLoop implements AgentLoop {
  readonly kind = 'plan-and-solve';
  async run(ctx: FlowContext, prompt: string): Promise<void> {
    await ctx.checkAbort?.();
    await ctx.checkpoint?.({ phase: 'plan', prompt });
    const plan = await ctx.runStep(`制定执行计划（只输出可执行步骤）：${prompt}`);
    await ctx.checkpoint?.({ phase: 'solve', plan: plan.text });
    const result = await ctx.runStep(`按照以下计划完成任务：\n${plan.text}\n\n原始任务：${prompt}`);
    await ctx.recorder.record({ span_id: 'plan-and-solve', parent_span_id: null, type: 'assistant.message', verb: 'response', attempt: 1, duration_ms: 0, payload: { text: result.text, strategy: this.kind } });
  }
}

/** Draft/critique/final loop for quality-sensitive tasks. */
export class ReflectionLoop implements AgentLoop {
  readonly kind = 'reflection';
  async run(ctx: FlowContext, prompt: string): Promise<void> {
    await ctx.checkAbort?.();
    const draft = await ctx.runStep(`先完成任务并给出草稿：${prompt}`);
    await ctx.checkpoint?.({ phase: 'reflect', draft: draft.text });
    const critique = await ctx.runStep(`检查下面草稿的事实、完整性和约束问题，并给出修正建议：\n${draft.text}`);
    await ctx.checkpoint?.({ phase: 'final', critique: critique.text });
    const result = await ctx.runStep(`根据草稿和审查意见输出最终答案。\n草稿：${draft.text}\n审查：${critique.text}`);
    await ctx.recorder.record({ span_id: 'reflection', parent_span_id: null, type: 'assistant.message', verb: 'response', attempt: 1, duration_ms: 0, payload: { text: result.text, strategy: this.kind } });
  }
}

export class StageGateLoop implements AgentLoop {
  readonly kind = 'stage-gate';
  constructor(
    private readonly stages: { id: string; gate?: { tool_called: string } }[],
    private readonly readEvents: () => Promise<unknown[]>,
    private readonly turn = false,
  ) {}
  async run(ctx: FlowContext, prompt: string): Promise<void> {
    await runStageGate(ctx, prompt, this.stages, this.readEvents as never, { turn: this.turn });
  }
}

/** Minimal evidence-first loop sample. Tool names are injectable so domains can provide their own adapters. */
export class ResearchLoop implements AgentLoop {
  readonly kind = 'research';
  constructor(private readonly tools = { search: 'research_search', verify: 'research_verify' }) {}
  async run(ctx: FlowContext, prompt: string): Promise<void> {
    if (ctx.checkAbort) await ctx.checkAbort();
    else if (ctx.signal?.aborted) throw ctx.signal.reason ?? new Error('loop cancelled');
    await ctx.recorder.record({
      span_id: 'research',
      parent_span_id: null,
      type: 'research/start',
      verb: 'request',
      attempt: 1,
      duration_ms: 0,
      payload: { prompt },
    });
    await ctx.checkpoint?.({ phase: 'plan', query: prompt });
    const plan = await ctx.runStep(`制定研究计划：${prompt}`);
    const search = await ctx.executeTool(this.tools.search, { query: plan.text || prompt });
    await ctx.checkpoint?.({ phase: 'collect', search });
    const verified = await ctx.executeTool(this.tools.verify, { query: prompt, evidence: search });
    await ctx.checkpoint?.({ phase: 'verify', verified });
    const synthesis = await ctx.runStep(`基于以下已核验证据回答问题：${canonicalJson(verified)}`);
    await ctx.recorder.record({
      span_id: 'research',
      parent_span_id: null,
      type: 'research/end',
      verb: 'response',
      attempt: 1,
      duration_ms: 0,
      payload: { outcome: synthesis.text },
    });
    await ctx.recorder.record({
      span_id: 'research',
      parent_span_id: null,
      type: 'turn/end',
      verb: 'response',
      attempt: 1,
      duration_ms: 0,
      payload: { outcome: synthesis.text },
    });
  }
}

export class SupervisorLoop implements AgentLoop {
  readonly kind = 'supervisor';
  async run(ctx: FlowContext, prompt: string): Promise<void> {
    await runSingleLoop(ctx, prompt);
  }
}

export function builtinLoops(): Map<string, AgentLoop> {
  return new Map<string, AgentLoop>([
    ['direct', new DirectLoop()],
    ['plan-and-solve', new PlanAndSolveLoop()],
    ['reflection', new ReflectionLoop()],
    ['research', new ResearchLoop()],
    ['supervisor', new SupervisorLoop()],
  ]);
}
