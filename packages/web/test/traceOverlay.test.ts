import { describe, expect, it } from 'vitest';
import { overlayFromEvents } from '../src/workspace/graph/traceOverlay';

describe('workspace trace overlay', () => {
  it('maps recorded execution events to canvas node states', () => {
    const event = (type: string, verb = 'success') => ({ type, verb } as never);
    expect(overlayFromEvents([event('user.message'), event('llm.request'), event('tool.called'), event('tool.result'), event('assistant.message')])).toEqual({ input: 'success', agent: 'running', tools: 'success', output: 'success' });
  });

  it('marks failed tool and model calls', () => {
    const event = (type: string, verb = 'success') => ({ type, verb } as never);
    expect(overlayFromEvents([event('llm.response', 'error'), event('tool.result', 'error')])).toEqual({ agent: 'failed', tools: 'failed' });
  });
});
