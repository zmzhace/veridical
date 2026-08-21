import type { LLMProvider, LLMRequest, LLMResponse, LLMUsage } from './types';
import { fingerprint } from './gateway';

export class MockProvider implements LLMProvider {
  private recordings = new Map<string, { text: string; usage: LLMUsage }>();

  record(fp: string, text: string, usage: LLMUsage) {
    this.recordings.set(fp, { text, usage });
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    const fp = fingerprint(req);
    const hit = this.recordings.get(fp);
    if (!hit) throw new Error(`no recording for fingerprint`);
    return { text: hit.text, usage: hit.usage };
  }
}
