export interface ToolDef {
  id: string;
  name: string;
  description: string;
  deterministic: boolean;
  execute(args: unknown): Promise<unknown>;
}

export type ApprovalDecision = 'allow' | 'deny' | 'ask';

export interface ApprovalPolicy {
  decide(tool: ToolDef, args: unknown): Promise<ApprovalDecision>;
}

export type ToolResult =
  | { ok: true; result: unknown }
  | { ok: false; reason: 'denied' | 'not_found' | 'error'; error?: unknown };
