import type { ApprovalPolicy, ToolDef, ToolResult, ToolObservation } from './types';

export interface ToolSelectionPolicy {
  mode?: 'auto' | 'allowlist';
  approvedOnly?: boolean;
  deny?: string[];
  maxCandidates?: number;
}

/** Selects relevant tools from the approved pool; selection never grants a new permission. */
export function selectToolCandidates(tools: ToolDef[], task: string, skillRequiredTools: string[] = [], policy: ToolSelectionPolicy = {}) {
  const deny = new Set(policy.deny ?? []);
  const words = new Set(task.toLocaleLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter((word) => word.length > 1));
  const required = new Set(skillRequiredTools);
  return tools
    .filter((tool) => !deny.has(tool.name))
    .filter((tool) => policy.approvedOnly !== false ? tool.status !== 'draft' && tool.status !== 'revoked' : true)
    .filter((tool) => policy.mode !== 'allowlist' || required.has(tool.name))
    .map((tool) => {
      const descriptionWords = `${tool.name} ${tool.description}`.toLocaleLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter((word) => word.length > 1);
      const matched = [...new Set(descriptionWords.filter((word) => words.has(word)))];
      return { tool, score: (required.has(tool.name) ? 1 : 0) + matched.length / Math.max(1, words.size), matched, permission: 'broker' as const };
    })
    .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
    .slice(0, policy.maxCandidates ?? 12);
}

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
