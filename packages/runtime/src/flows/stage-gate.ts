import type { TraceEvent } from '@veridical/schema';
import type { Stage } from '@veridical/spec';
import type { FlowContext } from './engine';

export class StageGateError extends Error {
  constructor(public stage: string, public tool: string) {
    super(`stage ${stage} gate not satisfied: ${tool}`);
    this.name = 'StageGateError';
  }
}

export function gateSatisfied(stage: Stage, events: TraceEvent[]): boolean {
  if (!stage.gate) return true;
  const span = `stage:${stage.id}`;
  return events.some(e =>
    e.type === 'tool.result' && e.verb === 'response' && e.span_id === span &&
    (e.payload as any)?.name === stage.gate!.tool_called
  );
}

export async function runStageGate(ctx: FlowContext, prompt: string, stages: Stage[], readEvents: () => Promise<TraceEvent[]>): Promise<void> {
  for (const stage of stages) {
    const span = `stage:${stage.id}`;
    await ctx.recorder.record({ span_id: span, parent_span_id: null, type: 'stage/start', verb: 'request', attempt: 1, duration_ms: 0, payload: { stage: stage.id } });
    let steps = 0;
    while (steps < ctx.maxSteps) {
      const events = await readEvents();
      if (gateSatisfied(stage, events)) break;
      steps += 1;
      await ctx.recorder.record({ span_id: span, parent_span_id: null, type: 'step/start', verb: 'request', attempt: steps, duration_ms: 0, payload: { stage: stage.id, step: steps } });
      const res = await ctx.runStep(prompt);
      if (res.tool) {
        await ctx.recorder.record({ span_id: span, parent_span_id: null, type: 'tool.called', verb: 'request', attempt: steps, duration_ms: 0, payload: { name: res.tool.name, args: res.tool.args } });
        const result = await ctx.executeTool(res.tool.name, res.tool.args);
        const blocked = result && typeof result === 'object' && (result as { ok?: boolean }).ok === false;
        const ok = !blocked && ctx.verifyToolResult(res.tool.name, result);
        if (!ok) {
          await ctx.recorder.record({ span_id: span, parent_span_id: null, type: 'tool.result', verb: 'error', attempt: steps, duration_ms: 0, payload: { name: res.tool.name, result, blocked: true } });
          await ctx.recorder.record({ span_id: span, parent_span_id: null, type: 'step/end', verb: 'error', attempt: steps, duration_ms: 0, payload: { stage: stage.id, step: steps, blocked: true } });
          await ctx.onStepEnd?.();
          continue;
        }
        await ctx.recorder.record({ span_id: span, parent_span_id: null, type: 'tool.result', verb: 'response', attempt: steps, duration_ms: 0, payload: { name: res.tool.name, result } });
      } else {
        await ctx.recorder.record({ span_id: span, parent_span_id: null, type: 'assistant.message', verb: 'response', attempt: steps, duration_ms: 0, payload: { text: res.text } });
      }
      await ctx.recorder.record({ span_id: span, parent_span_id: null, type: 'step/end', verb: 'response', attempt: steps, duration_ms: 0, payload: { stage: stage.id, step: steps } });
      await ctx.onStepEnd?.();
    }
    const finalEvents = await readEvents();
    if (!gateSatisfied(stage, finalEvents)) {
      await ctx.recorder.record({ span_id: span, parent_span_id: null, type: 'stage/end', verb: 'error', attempt: 1, duration_ms: 0, payload: { stage: stage.id, reason: 'gate_not_satisfied' } });
      throw new StageGateError(stage.id, stage.gate?.tool_called ?? '(none)');
    }
    await ctx.recorder.record({ span_id: span, parent_span_id: null, type: 'stage/end', verb: 'response', attempt: 1, duration_ms: 0, payload: { stage: stage.id } });
  }
}