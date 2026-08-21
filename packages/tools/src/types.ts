export interface ToolDef {
  id: string;
  name: string;
  description: string;
  deterministic: boolean;
  execute(args: unknown): Promise<unknown>;
  guard?(args: unknown): Promise<boolean>;
  verify?(result: unknown): boolean | Promise<boolean>;
}

export type ApprovalDecision = 'allow' | 'deny' | 'ask';

export interface ApprovalPolicy {
  decide(tool: ToolDef, args: unknown): Promise<ApprovalDecision>;
  onAsk?(tool: ToolDef, args: unknown): Promise<boolean>;
}

export type ToolResult =
  | { ok: true; result: unknown }
  | { ok: false; reason: 'denied' | 'not_found' | 'error' | 'verify_failed'; error?: unknown; result?: unknown };
