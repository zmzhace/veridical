import type { TraceEvent } from '@veridical/schema';

export type RuntimeNodeStatus = 'idle' | 'running' | 'success' | 'failed' | 'difference';
export type RuntimeOverlay = Record<string, RuntimeNodeStatus>;

export function overlayFromEvents(events: TraceEvent[]): RuntimeOverlay {
  const overlay: RuntimeOverlay = {};
  for (const event of events) {
    if (event.type === 'user.message' || event.type === 'turn/start') overlay.input = 'success';
    if (event.type === 'llm.request' || event.type === 'step/start') overlay.agent = 'running';
    if (event.type === 'llm.response' || event.type === 'step/end') overlay.agent = event.verb === 'error' ? 'failed' : 'success';
    if (event.type === 'tool.called') overlay.tools = 'running';
    if (event.type === 'tool.result') overlay.tools = event.verb === 'error' ? 'failed' : 'success';
    if (event.type === 'assistant.message' || event.type === 'turn/end') overlay.output = event.verb === 'error' ? 'failed' : 'success';
  }
  return overlay;
}

export function overlayFromReplayResult(result?: { identical?: boolean; passed?: boolean; differences?: unknown[] }): RuntimeOverlay {
  if (!result) return {};
  if (result.identical) return { input: 'success', agent: 'success', tools: 'success', output: 'success' };
  const overlay: RuntimeOverlay = { agent: 'difference', output: result.passed ? 'success' : 'difference' };
  const text = JSON.stringify(result.differences ?? []).toLowerCase();
  if (text.includes('tool')) overlay.tools = 'difference';
  return overlay;
}
