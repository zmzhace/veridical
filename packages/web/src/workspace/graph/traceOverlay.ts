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
