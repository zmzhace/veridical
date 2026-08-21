import type { TraceStore } from '@veridical/store';
import type { TraceEvent } from '@veridical/schema';
import { fingerprint, type LLMProvider } from '@veridical/llm';
import { runSpec, type SpecRegistry, type SpecRunnerDeps } from '@veridical/spec';
import type { ToolDef } from '@veridical/tools';
import { ReplayLLMProvider, ReplayToolProvider, ReplayMissError } from './providers';
import type { ReplayPlan, ReplayStrategy } from './plan';
import { RunComparator, type DiffEntry } from './comparator';

export class TraceDivergenceError extends Error {
  constructor(public seq: number, public differences: DiffEntry[]) {
    super(`trace diverged at seq ${seq}`);
    this.name = 'TraceDivergenceError';
  }
}

export class ReplayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReplayError';
  }
}

export interface ReplayResult {
  session_id: string;
  spec_name: string;
  spec_version: string;
  outcome: unknown;
  events: TraceEvent[];
  identical: boolean;
}

const payloadOf = (e: TraceEvent) => e.payload as any;

export class ReplayEngine {
  constructor(private store: TraceStore, private registry: SpecRegistry) {}

  async replay(session_id: string, plan: ReplayPlan, tools: ToolDef[]): Promise<ReplayResult> {
    const recorded = await this.store.readBySession(session_id);
    const startEvt = recorded.find(e => e.type === 'spec/run/start');
    if (!startEvt) throw new ReplayError(`no spec/run/start found for session ${session_id}`);
    const prompt = payloadOf(startEvt).input;

    const spec = await this.registry.resolve(plan.spec.name, plan.spec.version);
    if (!spec) throw new ReplayError(`spec not found: ${plan.spec.name}@${plan.spec.version ?? 'latest'}`);

    // LLM providers: each recorded provider name maps to a strategy (default 'replay').
    const replayProvider = new ReplayLLMProvider(recorded);
    const providers = new Map<string, LLMProvider>();
    const providerNames = new Set<string>();
    for (const e of recorded) if (e.type === 'llm.request') providerNames.add(payloadOf(e).provider);
    const llmStrategy = (provider: string): ReplayStrategy => plan.llm?.[provider] ?? 'replay';
    for (const name of providerNames) {
      const strategy = llmStrategy(name);
      if (strategy === 'replay') {
        providers.set(name, replayProvider);
      } else if (strategy === 'fixture') {
        const f = plan.fixtures?.llm?.find(x => x.provider === name);
        if (!f || f.responses.length === 0) throw new ReplayMissError(`no fixture responses for llm provider ${name}`);
        const responses = new Map(f.responses.map(r => [r.fingerprint, { text: r.text, usage: r.usage }]));
        providers.set(name, {
          complete: async (req) => {
            const hit = responses.get(fingerprint(req));
            if (!hit) throw new ReplayMissError(`no fixture response for fingerprint`);
            return hit;
          },
        });
      }
      // 'live' (real provider) requires the caller to inject a live provider map; not wired here.
    }

    // Tools: per-name strategy wrapping the injected library.
    const replayTool = new ReplayToolProvider(recorded);
    const toolStrategy = (name: string): ReplayStrategy => plan.tools?.[name] ?? 'replay';
    const wrappedTools = tools.map(t => ({
      ...t,
      execute: async (args: unknown) => {
        const strategy = toolStrategy(t.name);
        if (strategy === 'replay') return replayTool.execute(t.name, args);
        if (strategy === 'fixture') {
          const f = plan.fixtures?.tools?.find(x => x.name === t.name);
          if (!f || f.responses.length === 0) throw new ReplayMissError(`no fixture responses for tool ${t.name}`);
          return f.responses.shift();
        }
        return t.execute(args); // 'live'
      },
    }));

    const replaySessionId = `replay_${session_id}`;
    const deps: SpecRunnerDeps = {
      store: this.store,
      providers,
      tools: wrappedTools,
      tenant_id: recorded[0]?.tenant_id ?? 't1',
      session_id: replaySessionId,
    };

    await runSpec(deps, spec, prompt);

    // Trace identity assertion: the replay events landed in the store under replaySessionId.
    const compare = new RunComparator(this.store);
    const diff = await compare.compare(session_id, replaySessionId);
    if (plan.assert_trace_identical !== false && !diff.summary.identical) {
      throw new TraceDivergenceError(diff.summary.first_divergence ?? 0, diff.differences);
    }

    const replayEvents = await this.store.readBySession(replaySessionId);
    const endTurn = [...replayEvents].reverse().find(e => e.type === 'turn/end');
    return {
      session_id: replaySessionId,
      spec_name: spec.name,
      spec_version: spec.version,
      outcome: endTurn ? payloadOf(endTurn).outcome : undefined,
      events: replayEvents,
      identical: diff.summary.identical,
    };
  }
}
