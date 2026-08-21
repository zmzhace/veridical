import { randomUUID } from 'node:crypto';
import type { TraceStore } from '@veridical/store';
import type { TraceEvent } from '@veridical/schema';
import { Session, Recorder, runSingleLoop, type FlowContext } from '@veridical/runtime';
import { ToolBroker, type ApprovalDecision, type ApprovalPolicy, type ToolDef } from '@veridical/tools';
import { LLMGateway, type LLMProvider, type LLMRequest, type LLMResponse } from '@veridical/llm';
import type { AgentSpec } from './spec';

export class SpecRunError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'SpecRunError';
  }
}

export class SpecApprovalPolicy implements ApprovalPolicy {
  constructor(private spec: AgentSpec, private ask?: (tool: ToolDef, args: unknown) => Promise<boolean> | boolean) {}

  async decide(tool: ToolDef, _args: unknown): Promise<ApprovalDecision> {
    const entry = this.spec.tools.find(t => t.name === tool.name);
    return entry?.access ?? 'deny';
  }

  async onAsk(tool: ToolDef, args: unknown): Promise<boolean> {
    return this.ask ? await this.ask(tool, args) : false;
  }
}

export interface RunnerStepCtx {
  llm: LLMGateway;
  spec: AgentSpec;
  recorder: Recorder;
  prompt: string;
}

export interface SpecRunnerDeps {
  store: TraceStore;
  providers: Map<string, LLMProvider>;
  tools: ToolDef[];
  policy?: ApprovalPolicy;
  onAsk?: (tool: ToolDef, args: unknown) => Promise<boolean> | boolean;
  runStep?: (ctx: RunnerStepCtx) => Promise<{ text: string; tool?: { name: string; args: unknown } }>;
  session_id?: string;
  tenant_id: string;
}

export interface RunResult {
  session_id: string;
  spec_name: string;
  spec_version: string;
  outcome: unknown;
  events: TraceEvent[];
}

function requestFor(spec: AgentSpec, prompt: string): LLMRequest {
  return {
    provider: spec.llm.provider,
    model: spec.llm.model,
    messages: [
      { role: 'system', content: spec.instruction.system },
      { role: 'user', content: prompt },
    ],
  };
}

async function completeWithFallback(
  llm: LLMGateway,
  providers: Map<string, LLMProvider>,
  spec: AgentSpec,
  req: LLMRequest,
  recorder: Recorder,
): Promise<LLMResponse> {
  const chain = [{ provider: spec.llm.provider, model: spec.llm.model }, ...spec.llm.fallback];
  let lastErr: unknown;
  for (const r of chain) {
    if (!providers.has(r.provider)) continue;
    try {
      return await llm.complete({ ...req, provider: r.provider, model: r.model }, recorder);
    } catch (err) {
      lastErr = err;
      await recorder.record({
        span_id: 'llm', parent_span_id: null, type: 'llm.response', verb: 'error', attempt: 1, duration_ms: 0,
        payload: { provider: r.provider, model: r.model, message: err instanceof Error ? err.message : String(err) },
      });
    }
  }
  throw new SpecRunError(`all LLM providers failed: ${chain.map(c => c.provider).join(', ')}`, lastErr);
}

export async function runSpec(deps: SpecRunnerDeps, spec: AgentSpec, prompt: string): Promise<RunResult> {
  if (!deps.providers.has(spec.llm.provider)) {
    throw new SpecRunError(`llm provider not registered: ${spec.llm.provider}`);
  }
  const session_id = deps.session_id ?? `s_${randomUUID()}`;
  const session = new Session({ session_id, tenant_id: deps.tenant_id, spec_version: spec.version });
  const recorder = new Recorder(deps.store, session);
  const llm = new LLMGateway(deps.providers);
  const policy = deps.policy ?? new SpecApprovalPolicy(spec, deps.onAsk);
  const broker = new ToolBroker(deps.tools, policy);

  await recorder.record({
    span_id: 'spec', parent_span_id: null, type: 'spec/run/start', verb: 'request', attempt: 1, duration_ms: 0,
    payload: { spec_name: spec.name, spec_version: spec.version, input: prompt },
  });

  const defaultRunStep = async ({ llm, spec, recorder, prompt }: RunnerStepCtx) => {
    const res = await completeWithFallback(llm, deps.providers, spec, requestFor(spec, prompt), recorder);
    return { text: res.text };
  };
  const stepRun = deps.runStep ?? defaultRunStep;

  const ctx: FlowContext = {
    recorder,
    runStep: (p) => stepRun({ llm, spec, recorder, prompt: p }),
    executeTool: async (name, args) => {
      const r = await broker.call(name, args);
      return r.ok ? r.result : { ok: false, reason: r.reason };
    },
    shouldStop: () => false,
    verifyToolResult: () => true,
    maxSteps: spec.flow.max_steps,
  };

  let caught = false;
  let error: unknown;
  let outcome: unknown;
  try {
    await runSingleLoop(ctx, prompt);
  } catch (err) {
    caught = true;
    error = err;
    throw err;
  } finally {
    const events = await deps.store.readBySession(session_id);
    const endTurn = [...events].reverse().find(e => e.type === 'turn/end');
    outcome = (endTurn?.payload as { outcome?: unknown } | undefined)?.outcome;

    await recorder.record({
      span_id: 'spec', parent_span_id: null, type: 'spec/run/end', verb: caught ? 'error' : 'response', attempt: 1, duration_ms: 0,
      payload: caught ? { outcome, message: error instanceof Error ? error.message : String(error) } : { outcome },
    });
  }

  return {
    session_id,
    spec_name: spec.name,
    spec_version: spec.version,
    outcome,
    events: await deps.store.readBySession(session_id),
  };
}
