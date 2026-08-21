import { createHash } from 'node:crypto';
import type { Recorder } from '@rt/runtime';
import type { LLMProvider, LLMRequest, LLMResponse } from './types';

export function fingerprint(req: LLMRequest): string {
  return createHash('sha256').update(JSON.stringify({ provider: req.provider, model: req.model, messages: req.messages })).digest('hex');
}

export class LLMGateway {
  constructor(private providers: Map<string, LLMProvider>) {}

  async complete(req: LLMRequest, recorder: Recorder): Promise<LLMResponse> {
    const started = Date.now();
    const fp = fingerprint(req);
    const reqPayload = { provider: req.provider, model: req.model, fingerprint: fp, messages: req.messages };
    const provider = this.providers.get(req.provider);
    if (!provider) {
      const err = new Error(`unknown provider: ${req.provider}`);
      await recorder.record({ span_id: 'llm', parent_span_id: null, type: 'llm.request', verb: 'request', attempt: 1, duration_ms: 0, payload: reqPayload });
      await recorder.record({ span_id: 'llm', parent_span_id: null, type: 'llm.response', verb: 'error', attempt: 1, duration_ms: Date.now() - started, payload: { provider: req.provider, model: req.model, fingerprint: fp, message: err.message } });
      throw err;
    }
    await recorder.record({ span_id: 'llm', parent_span_id: null, type: 'llm.request', verb: 'request', attempt: 1, duration_ms: 0, payload: reqPayload });
    const res = await provider.complete(req);
    const elapsed = Date.now() - started;
    await recorder.record({ span_id: 'llm', parent_span_id: null, type: 'llm.response', verb: 'response', attempt: 1, duration_ms: elapsed, tokens: res.usage, payload: { provider: req.provider, model: req.model, fingerprint: fp, text: res.text } });
    return res;
  }
}
