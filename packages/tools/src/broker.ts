import type { ApprovalPolicy, ToolDef, ToolResult } from './types';

export class ToolBroker {
  private byName = new Map<string, ToolDef>();

  constructor(private tools: ToolDef[], private policy: ApprovalPolicy) {
    for (const t of tools) this.byName.set(t.name, t);
  }

  async call(name: string, args: unknown): Promise<ToolResult> {
    const tool = this.byName.get(name);
    if (!tool) return { ok: false, reason: 'not_found' };

    const decision = await this.policy.decide(tool, args);
    if (decision === 'deny') return { ok: false, reason: 'denied' };
    if (decision === 'ask') {
      const approved = this.policy.onAsk ? await this.policy.onAsk(tool, args) : false;
      if (!approved) return { ok: false, reason: 'denied' };
    }

    if (tool.guard && !(await tool.guard(args))) return { ok: false, reason: 'denied' };

    let result: unknown;
    try {
      result = await tool.execute(args);
    } catch (error) {
      return { ok: false, reason: 'error', error };
    }

    if (tool.verify && !(await tool.verify(result))) {
      return { ok: false, reason: 'verify_failed', result };
    }
    return { ok: true, result };
  }
}
