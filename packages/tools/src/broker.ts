import type { ApprovalPolicy, ToolDef, ToolResult, ToolObservation } from './types';

export class ToolBroker {
  private byName = new Map<string, ToolDef>();

  constructor(private tools: ToolDef[], private policy: ApprovalPolicy) {
    for (const t of tools) this.byName.set(t.name, t);
  }

  async call(name: string, args: unknown): Promise<ToolResult> {
    const result = await this.callObserved(name, args);
    if (result.observation) {
      const { observation: _observation, ...legacy } = result;
      return legacy as ToolResult;
    }
    return result;
  }

  async callObserved(name: string, args: unknown): Promise<ToolResult> {
    const started = Date.now();
    const meta = (extra: Partial<ToolObservation['metadata']> = {}) => ({ duration_ms: Date.now() - started, truncated: false, ...extra });
    const tool = this.byName.get(name);
    if (!tool) return { ok: false, reason: 'not_found', observation: { status: 'error', text: `Tool ${name} is not registered`, error: { code: 'TOOL_NOT_REGISTERED', message: `Tool ${name} is not registered`, retryable: false }, metadata: meta() } };

    const decision = await this.policy.decide(tool, args);
    if (decision === 'deny') return { ok: false, reason: 'denied', observation: { status: 'blocked', text: `Tool ${name} was denied`, error: { code: 'PERMISSION_DENIED', message: 'Tool access denied by policy', retryable: false }, metadata: meta() } };
    if (decision === 'ask') {
      const approved = this.policy.onAsk ? await this.policy.onAsk(tool, args) : false;
      if (!approved) return { ok: false, reason: 'denied', observation: { status: 'blocked', text: `Approval required for ${name}`, error: { code: 'APPROVAL_REQUIRED', message: 'Tool approval was not granted', retryable: false }, metadata: meta() } };
    }

    if (tool.guard && !(await tool.guard(args))) return { ok: false, reason: 'denied', observation: { status: 'blocked', text: `Tool ${name} arguments were blocked`, error: { code: 'PERMISSION_DENIED', message: 'Tool guard rejected the arguments', retryable: false }, metadata: meta() } };

    let result: unknown;
    try {
      result = await tool.execute(args);
    } catch (error) {
      return { ok: false, reason: 'error', error, observation: { status: 'error', text: `Tool ${name} failed`, error: { code: 'TOOL_ERROR', message: error instanceof Error ? error.message : String(error), retryable: true }, metadata: meta() } };
    }

    if (tool.verify && !(await tool.verify(result))) {
      return { ok: false, reason: 'verify_failed', result, observation: { status: 'error', text: `Tool ${name} returned an invalid result`, error: { code: 'OUTPUT_INVALID', message: 'Tool result verification failed', retryable: false }, metadata: meta() } };
    }
    const empty = result === undefined || result === null;
    return { ok: true, result, observation: { status: empty ? 'empty' : 'success', data: result, text: empty ? 'Tool returned no data' : 'Tool completed successfully', metadata: meta() } };
  }
}
