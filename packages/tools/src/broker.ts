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
    try {
      const result = await tool.execute(args);
      return { ok: true, result };
    } catch (error) {
      return { ok: false, reason: 'error', error };
    }
  }
}
