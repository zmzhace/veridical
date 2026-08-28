import type { TraceEvent } from '@veridical/schema';
import { isDeepStrictEqual } from 'node:util';
import { fingerprint, type LLMProvider, type LLMRequest, type LLMResponse } from '@veridical/llm';

export class ReplayMissError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReplayMissError';
  }
}

const payloadOf = (e: TraceEvent) => e.payload as any;

export class ReplayLLMProvider implements LLMProvider {
  private byFingerprint = new Map<string, { index: number; responses: LLMResponse[] }>();

  constructor(events: TraceEvent[]) {
    for (const e of [...events].sort((a, b) => a.seq - b.seq)) {
      if (e.type === 'llm.response' && e.verb === 'response') {
        const p = payloadOf(e);
        const entry = this.byFingerprint.get(p.fingerprint) ?? { index: 0, responses: [] };
        entry.responses.push(structuredClone({ text: p.text ?? '', usage: e.tokens ?? { input: 0, output: 0, cached: 0, total: 0 } }));
        this.byFingerprint.set(p.fingerprint, entry);
      }
    }
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    const fp = fingerprint(req);
    const hit = this.byFingerprint.get(fp);
    if (!hit || hit.index >= hit.responses.length) throw new ReplayMissError(`no recorded llm.response left for fingerprint ${fp}`);
    return structuredClone(hit.responses[hit.index++]);
  }
}

export class ReplayToolProvider {
  private calls = new Map<string, { index: number; results: { args: unknown; result: unknown }[] }>();

  constructor(events: TraceEvent[]) {
    const pending: TraceEvent[] = [];
    for (const e of [...events].sort((a, b) => a.seq - b.seq)) {
      if (e.type === 'tool.called') { pending.push(e); continue; }
      if (e.type !== 'tool.result') continue;
      const p = payloadOf(e);
      const matches = pending.filter(call => payloadOf(call).name === p.name &&
        (e.call_id ? call.call_id === e.call_id : call.span_id === e.span_id));
      // Legacy sequential traces can be paired by span; ambiguous traces must not be guessed.
      if (matches.length !== 1) throw new ReplayMissError(`unpaired or ambiguous tool.result for ${p.name}`);
      const call = matches[0];
      pending.splice(pending.indexOf(call), 1);
      if (e.verb !== 'response' || p.blocked === true || p.result?.ok === false) continue;
      const entry = this.calls.get(p.name) ?? { index: 0, results: [] };
      entry.results.push(structuredClone({ args: payloadOf(call).args, result: p.result }));
      this.calls.set(p.name, entry);
    }
  }

  async execute(name: string, args: unknown): Promise<unknown> {
    const entry = this.calls.get(name);
    if (!entry || entry.index >= entry.results.length) throw new ReplayMissError(`no recorded tool.result left for ${name}`);
    const hit = entry.results[entry.index];
    if (!isDeepStrictEqual(hit.args, args)) throw new ReplayMissError(`tool arguments diverged for ${name}`);
    entry.index++;
    return structuredClone(hit.result);
  }
}
