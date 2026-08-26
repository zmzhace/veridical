import { randomUUID } from 'node:crypto';
import type { TraceStore } from '@veridical/store';
import type { TraceEvent } from '@veridical/schema';
import { Session, Recorder, runSingleLoop, runStageGate, StageGateError, type FlowContext } from '@veridical/runtime';
import { ToolBroker, type ApprovalDecision, type ApprovalPolicy, type ToolDef } from '@veridical/tools';
import { LLMGateway, type LLMProvider, type LLMRequest, type LLMResponse } from '@veridical/llm';
import type { AgentSpec } from './spec';
import type { SpecRegistry } from './registry';

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

export interface MemoryLike {
  recall(query: string, opts?: { tags?: string[]; limit?: number }): Promise<{ key: string; value: unknown; scope: string; tags?: string[] }[]>;
  onStep?: (step: number, ctx: { prompt: string }) => Promise<void>;
}

export interface SpecRunnerDeps {
  store: TraceStore;
  providers: Map<string, LLMProvider>;
  tools: ToolDef[];
  policy?: ApprovalPolicy;
  onAsk?: (tool: ToolDef, args: unknown) => Promise<boolean> | boolean;
  runStep?: (ctx: RunnerStepCtx) => Promise<{ text: string; tool?: { name: string; args: unknown }; delegate?: string; task?: string }>;
  verify?: (events: TraceEvent[]) => boolean;
  registry?: SpecRegistry;
  session_id?: string;
  tenant_id: string;
  memory?: MemoryLike;
}

export interface RunResult {
  session_id: string;
  spec_name: string;
  spec_version: string;
  outcome: unknown;
  events: TraceEvent[];
}

async function buildRequest(spec: AgentSpec, prompt: string, memory?: MemoryLike): Promise<LLMRequest> {
  let system = spec.instruction.system;
  if (memory) {
    try {
      const recalled = await memory.recall(prompt);
      if (recalled.length > 0) {
        system = system + memorySystemBlock(recalled);
      }
    } catch {
      // memory is augmentation; degrade to no-memory
    }
  }
  return { provider: spec.llm.provider, model: spec.llm.model, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }] };
}

function memorySystemBlock(recalled: { key: string; value: unknown; scope: string; tags?: string[] }[]): string {
  const lines = recalled.map(m => {
    const v = typeof m.value === 'string' ? m.value : JSON.stringify(m.value);
    return `- [${m.scope}] ${m.key}: ${v}`;
  });
  return `\n## 记忆\n${lines.join('\n')}`;
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
    const req = await buildRequest(spec, prompt, deps.memory);
    const res = await completeWithFallback(llm, deps.providers, spec, req, recorder);
    return { text: res.text };
  };
  const stepRun: (ctx: RunnerStepCtx) => Promise<{ text: string; tool?: { name: string; args: unknown }; delegate?: string; task?: string }> = deps.runStep ?? defaultRunStep;

  const isSupervisor = spec.flow.mode === 'supervisor';
  const dispatch = async (delegate: string, task: string): Promise<{ ok: true }> => {
    const ref = spec.agents.find(a => a.name === delegate);
    if (!ref) {
      await recorder.record({ span_id: 'supervisor', parent_span_id: null, type: 'agent.dispatch', verb: 'error', attempt: 1, duration_ms: 0, payload: { delegate, task, error: 'unknown agent' } });
      throw new SpecRunError(`unknown agent: ${delegate}`);
    }
    if (!deps.registry) {
      await recorder.record({ span_id: 'supervisor', parent_span_id: null, type: 'agent.dispatch', verb: 'error', attempt: 1, duration_ms: 0, payload: { delegate, task, error: 'no registry' } });
      throw new SpecRunError('no registry');
    }
    const [name, version] = ref.spec_ref.split('@');
    const expert = await deps.registry.resolve(name, version);
    if (!expert) {
      await recorder.record({ span_id: 'supervisor', parent_span_id: null, type: 'agent.dispatch', verb: 'error', attempt: 1, duration_ms: 0, payload: { delegate, task, error: 'expert spec not found' } });
      throw new SpecRunError(`expert spec not found: ${ref.spec_ref}`);
    }
    const tool = expert.tools[0];
    if (!tool) throw new SpecRunError(`expert has no tool: ${delegate}`);
    const dispatchEvt = await recorder.record({
      span_id: 'supervisor', parent_span_id: null, type: 'agent.dispatch', verb: 'request', attempt: 1, duration_ms: 0,
      payload: { delegate, task, spec_ref: ref.spec_ref },
    });
    const expertSession = new Session({ session_id, tenant_id: deps.tenant_id, spec_version: expert.version });
    const expertRecorder = new Recorder(deps.store, expertSession);
    await expertRecorder.record({
      span_id: delegate, parent_span_id: dispatchEvt.id, type: 'spec/run/start', verb: 'request', attempt: 1, duration_ms: 0,
      payload: { spec_name: expert.name, spec_version: expert.version, input: task, delegated_by: 'supervisor' },
    });
    let expertResult: RunResult;
    try {
      const expertRunStep = async () => ({ text: task, tool: { name: tool.name, args: { task } } });
      expertResult = await runSpec({ ...deps, session_id, runStep: expertRunStep }, expert, task);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await expertRecorder.record({
        span_id: delegate, parent_span_id: dispatchEvt.id, type: 'spec/run/end', verb: 'error', attempt: 1, duration_ms: 0,
        payload: { message, delegated_by: 'supervisor' },
      });
      await recorder.record({
        span_id: 'supervisor', parent_span_id: null, type: 'agent.result', verb: 'error', attempt: 1, duration_ms: 0,
        payload: { delegate, task, ok: false, error: message },
      });
      throw err instanceof Error ? err : new SpecRunError(message);
    }
    await expertRecorder.record({
      span_id: delegate, parent_span_id: dispatchEvt.id, type: 'spec/run/end', verb: 'response', attempt: 1, duration_ms: 0,
      payload: { outcome: expertResult.outcome, delegated_by: 'supervisor' },
    });
    await recorder.record({
      span_id: 'supervisor', parent_span_id: null, type: 'agent.result', verb: 'response', attempt: 1, duration_ms: 0,
      payload: { delegate, task, ok: true, outcome: expertResult.outcome },
    });
    return { ok: true };
  };
  const delegateRunStep: typeof stepRun = async (ctx) => {
    const res = await stepRun(ctx);
    if (isSupervisor && res.delegate) {
      await dispatch(res.delegate, res.task ?? '');
      return { text: `[${res.delegate} 完成]`, tool: undefined };
    }
    return res;
  };
  const effectiveRunStep = isSupervisor ? delegateRunStep : stepRun;

  let stepEvents: TraceEvent[] = [];
  let stepCount = 0;
  const ctx: FlowContext = {
    recorder,
    runStep: async (p) => {
      stepCount += 1;
      if (deps.memory?.onStep) await deps.memory.onStep(stepCount, { prompt: p });
      if (deps.verify) {
        stepEvents = await deps.store.readBySession(session_id);
      }
      return effectiveRunStep({ llm, spec, recorder, prompt: p });
    },
    executeTool: async (name, args) => {
      const r = await broker.call(name, args);
      return r.ok ? r.result : { ok: false, reason: r.reason };
    },
    shouldStop: () => false,
    verifyToolResult: deps.verify
      ? (name: string, result: unknown) => {
          const pendingResult = {
            id: `vr_${session_id}_${stepEvents.length + 1}`,
            tenant_id: deps.tenant_id,
            session_id,
            span_id: 'loop',
            parent_span_id: null,
            seq: stepEvents.length + 1,
            type: 'tool.result',
            verb: 'response',
            attempt: 1,
            duration_ms: 0,
            payload: { name, result },
            spec_version: spec.version,
          } satisfies TraceEvent;
          return deps.verify!([...stepEvents, pendingResult]);
        }
      : () => true,
    maxSteps: spec.flow.max_steps,
  };

  let caught = false;
  let error: unknown;
  let outcome: unknown;
  try {
    if (spec.flow.mode === 'stage-gate' && spec.flow.stages && spec.flow.stages.length > 0) {
      await runStageGate(ctx, prompt, spec.flow.stages, () => deps.store.readBySession(session_id));
    } else {
      await runSingleLoop(ctx, prompt);
    }
  } catch (err) {
    caught = true;
    error = err;
    throw err;
  } finally {
    const events = await deps.store.readBySession(session_id);
    const endTurn = [...events].reverse().find(e => e.type === 'turn/end');
    outcome = (endTurn?.payload as { outcome?: unknown } | undefined)?.outcome;
    const stuckStage = error instanceof StageGateError ? error.stage : undefined;

    await recorder.record({
      span_id: 'spec', parent_span_id: null, type: 'spec/run/end', verb: caught ? 'error' : 'response', attempt: 1, duration_ms: 0,
      payload: caught ? { outcome, message: error instanceof Error ? error.message : String(error), ...(stuckStage ? { stuck_stage: stuckStage } : {}) } : { outcome },
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
