import type { TraceEvent } from '@veridical/schema';
import { fingerprint, type LLMProvider, type LLMRequest, type LLMResponse, type LLMUsage } from '@veridical/llm';

export class ReplayMissError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReplayMissError';
  }
}

const payloadOf = (e: TraceEvent) => e.payload as any;

export class ReplayLLMProvider implements LLMProvider {
  private byFingerprint = new Map<string, { text: string; usage: LLMUsage }>();

  constructor(events: TraceEvent[]) {
    for (const e of events) {
      if (e.type === 'llm.response' && e.verb === 'response') {
        const p = payloadOf(e);
        this.byFingerprint.set(p.fingerprint, { text: p.text ?? '', usage: e.tokens ?? { input: 0, output: 0, cached: 0, total: 0 } });
      }
    }
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    const fp = fingerprint(req);
    const hit = this.byFingerprint.get(fp);
    if (!hit) throw new ReplayMissError(`no recorded llm.response for fingerprint ${fp}`);
    return { text: hit.text, usage: hit.usage };
  }
}

export class ReplayToolProvider {
  private calls = new Map<string, { index: number; results: unknown[] }>();

  constructor(events: TraceEvent[]) {
    const byName = new Map<string, unknown[]>();
    for (const e of events) {
      if (e.type === 'tool.result') {
        const p = payloadOf(e);
        if (!byName.has(p.name)) byName.set(p.name, []);
        byName.get(p.name)!.push(p.result);
      }
    }
    for (const [name, results] of byName) this.calls.set(name, { index: 0, results });
  }

  async execute(name: string, _args: unknown): Promise<unknown> {
    const entry = this.calls.get(name);
    if (!entry || entry.index >= entry.results.length) throw new ReplayMissError(`no recorded tool.result left for ${name}`);
    return entry.results[entry.index++];
  }
}
