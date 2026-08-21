import type { FlowContext } from './engine';

export async function runSingleLoop(ctx: FlowContext, prompt: string): Promise<void> {
  await ctx.recorder.record({ span_id: 'loop', parent_span_id: null, type: 'turn/start', verb: 'request', attempt: 1, duration_ms: 0, payload: { prompt } });
  let step = 0;
  let outcome: unknown = undefined;
  while (!ctx.shouldStop(outcome) && step < ctx.maxSteps) {
    step += 1;
    await ctx.recorder.record({ span_id: 'loop', parent_span_id: null, type: 'step/start', verb: 'request', attempt: step, duration_ms: 0, payload: { step } });
    await ctx.recorder.record({ span_id: 'loop', parent_span_id: null, type: 'user.message', verb: 'request', attempt: step, duration_ms: 0, payload: { text: prompt } });
    const res = await ctx.runStep(prompt);
    if (res.tool) {
      await ctx.recorder.record({ span_id: 'loop', parent_span_id: null, type: 'tool.called', verb: 'request', attempt: step, duration_ms: 0, payload: { name: res.tool.name, args: res.tool.args } });
      const result = await ctx.executeTool(res.tool.name, res.tool.args);
      const ok = ctx.verifyToolResult(result);
      if (!ok) {
        await ctx.recorder.record({ span_id: 'loop', parent_span_id: null, type: 'tool.result', verb: 'error', attempt: step, duration_ms: 0, payload: { name: res.tool.name, result, blocked: true } });
        await ctx.recorder.record({ span_id: 'loop', parent_span_id: null, type: 'step/end', verb: 'error', attempt: step, duration_ms: 0, payload: { step, blocked: true } });
        continue;
      }
      await ctx.recorder.record({ span_id: 'loop', parent_span_id: null, type: 'tool.result', verb: 'response', attempt: step, duration_ms: 0, payload: { name: res.tool.name, result } });
      outcome = result;
    } else {
      await ctx.recorder.record({ span_id: 'loop', parent_span_id: null, type: 'assistant.message', verb: 'response', attempt: step, duration_ms: 0, payload: { text: res.text } });
      outcome = res.text;
    }
    await ctx.recorder.record({ span_id: 'loop', parent_span_id: null, type: 'step/end', verb: 'response', attempt: step, duration_ms: 0, payload: { step } });
  }
  await ctx.recorder.record({ span_id: 'loop', parent_span_id: null, type: 'turn/end', verb: 'response', attempt: 1, duration_ms: 0, payload: { outcome } });
}