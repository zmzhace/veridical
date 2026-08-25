import { fingerprint, type LLMRequest, type LLMResponse, type LLMUsage } from '@veridical/llm';
import type { PolicySnapshot, PolicyState, RLPolicy } from './types';

const USAGE: LLMUsage = { input: 1, output: 1, cached: 0, total: 2 };

function softmax(logits: number[]): number[] {
  const max = Math.max(...logits);
  const exps = logits.map((l) => Math.exp(l - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map((e) => e / sum);
}

export class MockPolicy implements RLPolicy {
  private states = new Map<string, PolicyState>();

  constructor(private candidatesByPrompt: Record<string, string[]>) {}

  candidates(fp: string): string[] {
    return this.states.get(fp)?.options.map((o) => o.text) ?? [];
  }

  seed(fp: string, texts: string[]) {
    this.states.set(fp, { options: texts.map((text) => ({ text, logit: 0, prob: 1 / texts.length })) });
  }

  private stateFor(req: LLMRequest): PolicyState {
    const fp = fingerprint(req);
    let st = this.states.get(fp);
    if (!st) {
      const texts = this.candidatesByPrompt[(req.messages.at(-1) as any)?.content] ?? [''];
      st = { options: texts.map((text) => ({ text, logit: 0, prob: 1 / Math.max(texts.length, 1) })) };
      this.states.set(fp, st);
    }
    return st;
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    const st = this.stateFor(req);
    const probs = softmax(st.options.map((o) => o.logit));
    const r = Math.random();
    let acc = 0;
    for (let i = 0; i < st.options.length; i++) {
      acc += probs[i];
      if (r < acc) return { text: st.options[i].text, usage: USAGE };
    }
    return { text: st.options[0].text, usage: USAGE };
  }

  logProb(req: LLMRequest, text: string): number {
    const st = this.stateFor(req);
    const probs = softmax(st.options.map((o) => o.logit));
    const idx = st.options.findIndex((o) => o.text === text);
    return idx < 0 ? 0 : probs[idx];
  }

  update(updates: { fingerprint: string; text: string; advantage: number; lr: number }[]): void {
    for (const u of updates) {
      const st = this.states.get(u.fingerprint);
      if (!st) continue;
      const opt = st.options.find((o) => o.text === u.text);
      if (opt) opt.logit += u.lr * u.advantage;
    }
  }

  snapshot(): PolicySnapshot {
    const out: PolicySnapshot = {};
    for (const [fp, st] of this.states) {
      const probs = softmax(st.options.map((o) => o.logit));
      out[fp] = { options: st.options.map((o, i) => ({ text: o.text, logit: o.logit, prob: probs[i] })) };
    }
    return out;
  }
}
