import { describe, expect, it } from 'vitest';
import { overlayFromEvents, overlayFromReplayResult } from '../src/workspace/graph/traceOverlay';

describe('workspace trace overlay', () => {
  it('maps recorded execution events to canvas node states', () => {
    const event = (type: string, verb = 'success') => ({ type, verb } as never);
    expect(overlayFromEvents([event('user.message'), event('llm.request'), event('tool.called'), event('tool.result'), event('assistant.message')])).toEqual({ input: 'success', agent: 'running', tools: 'success', output: 'success' });
  });

  it('marks failed tool and model calls', () => {
    const event = (type: string, verb = 'success') => ({ type, verb } as never);
    expect(overlayFromEvents([event('llm.response', 'error'), event('tool.result', 'error')])).toEqual({ agent: 'failed', tools: 'failed' });
  });

  it('marks strict replay paths and semantic differences', () => {
    expect(overlayFromReplayResult({ identical: true })).toEqual({ input: 'success', agent: 'success', tools: 'success', output: 'success' });
    expect(overlayFromReplayResult({ identical: false, differences: [{ field: 'tool.args' }] })).toEqual({ agent: 'difference', output: 'difference', tools: 'difference' });
  });
});
