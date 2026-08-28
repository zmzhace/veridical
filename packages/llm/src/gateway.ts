import { createHash } from 'node:crypto';
import type { Recorder } from '@veridical/runtime';
import type { LLMProvider, LLMRequest, LLMResponse, LLMUsage } from './types';

export function fingerprint(req: LLMRequest): string {
  return createHash('sha256').update(JSON.stringify({ provider: req.provider, model: req.model, messages: req.messages, maxOutputTokens: req.maxOutputTokens })).digest('hex');
}

export class LLMGateway {
  constructor(private providers: Map<string, LLMProvider>) {}

  async complete(req: LLMRequest, recorder: Recorder): Promise<LLMResponse> {
    const started = Date.now();
    const fp = fingerprint(req);
    const reqPayload = { provider: req.provider, model: req.model, fingerprint: fp, messages: req.messages, maxOutputTokens: req.maxOutputTokens };
    const provider = this.providers.get(req.provider);
    if (!provider) {
      const err = new Error(`unknown provider: ${req.provider}`);
      await recorder.record({ span_id: 'llm', parent_span_id: null, type: 'llm.request', verb: 'request', attempt: 1, duration_ms: 0, payload: reqPayload });
      await recorder.record({ span_id: 'llm', parent_span_id: null, type: 'llm.response', verb: 'error', attempt: 1, duration_ms: Date.now() - started, payload: { provider: req.provider, model: req.model, fingerprint: fp, message: err.message } });
      throw err;
    }
    await recorder.record({ span_id: 'llm', parent_span_id: null, type: 'llm.request', verb: 'request', attempt: 1, duration_ms: 0, payload: reqPayload });
    let res: LLMResponse;
    try {
      res = await provider.complete(req);
    } catch (error) {
      await this.recordError(req, recorder, fp, started, error);
      throw error;
    }
    const elapsed = Date.now() - started;
    await recorder.record({ span_id: 'llm', parent_span_id: null, type: 'llm.response', verb: 'response', attempt: 1, duration_ms: elapsed, tokens: res.usage, payload: { provider: req.provider, model: req.model, fingerprint: fp, text: res.text } });
    return res;
  }

  async stream(req: LLMRequest, recorder: Recorder, onToken?: (chunk: string) => void): Promise<LLMResponse> {
    const started = Date.now();
    const fp = fingerprint(req);
    const reqPayload = { provider: req.provider, model: req.model, fingerprint: fp, messages: req.messages, maxOutputTokens: req.maxOutputTokens };
    const provider = this.providers.get(req.provider);
    await recorder.record({ span_id: 'llm', parent_span_id: null, type: 'llm.request', verb: 'request', attempt: 1, duration_ms: 0, payload: reqPayload });
    if (!provider) {
      const err = new Error(`unknown provider: ${req.provider}`);
      await recorder.record({ span_id: 'llm', parent_span_id: null, type: 'llm.response', verb: 'error', attempt: 1, duration_ms: Date.now() - started, payload: { provider: req.provider, model: req.model, fingerprint: fp, message: err.message } });
      throw err;
    }
    let text = '';
    let usage: LLMUsage = { input: 0, output: 0, cached: 0, total: 0 };
    try {
      if (typeof provider.stream === 'function') {
        let chunks = 0;
        for await (const chunk of provider.stream(req)) {
          text = text + chunk;
          chunks = chunks + 1;
          await recorder.record({ span_id: 'llm', parent_span_id: null, type: 'llm.stream_chunk', verb: 'stream_chunk', attempt: 1, duration_ms: 0, payload: { provider: req.provider, model: req.model, fingerprint: fp, text: chunk } });
          if (onToken) onToken(chunk);
        }
        // Approximation only: provider chunks are not tokenizer tokens.
        usage = { input: 0, output: chunks, cached: 0, total: chunks };
      } else {
        const res = await provider.complete(req);
        text = res.text;
        usage = res.usage;
      }
    } catch (error) {
      await this.recordError(req, recorder, fp, started, error);
      throw error;
    }
    const elapsed = Date.now() - started;
    await recorder.record({ span_id: 'llm', parent_span_id: null, type: 'llm.response', verb: 'response', attempt: 1, duration_ms: elapsed, tokens: usage, payload: { provider: req.provider, model: req.model, fingerprint: fp, text } });
    return { text, usage };
  }

  private async recordError(req: LLMRequest, recorder: Recorder, fp: string, started: number, error: unknown): Promise<void> {
    await recorder.record({
      span_id: 'llm', parent_span_id: null, type: 'llm.response', verb: 'error', attempt: 1,
      duration_ms: Date.now() - started,
      payload: { provider: req.provider, model: req.model, fingerprint: fp, message: error instanceof Error ? error.message : String(error) },
    });
  }
}
