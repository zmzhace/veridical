export interface ToolDef {
  id: string;
  name: string;
  description: string;
  deterministic: boolean;
  version?: string;
  status?: 'draft' | 'approved' | 'deprecated' | 'revoked';
  input_schema?: unknown;
  output_schema?: unknown;
  side_effect?: 'none' | 'read' | 'write';
  timeout_ms?: number;
  execute(args: unknown): Promise<unknown>;
  guard?(args: unknown): Promise<boolean>;
  verify?(result: unknown): boolean | Promise<boolean>;
}

export type ApprovalDecision = 'allow' | 'deny' | 'ask';

export interface ApprovalPolicy {
  decide(tool: ToolDef, args: unknown): Promise<ApprovalDecision>;
  onAsk?(tool: ToolDef, args: unknown): Promise<boolean>;
}

export interface ToolObservation<T = unknown> {
  status: 'success' | 'empty' | 'partial' | 'error' | 'blocked';
  data?: T;
  text: string;
  error?: { code: string; message: string; retryable: boolean; details?: unknown };
  metadata: { duration_ms: number; truncated: boolean; content_hash?: string };
}

export type ToolResult =
  | { ok: true; result: unknown; observation?: ToolObservation }
  | { ok: false; reason: 'denied' | 'not_found' | 'error' | 'verify_failed'; error?: unknown; result?: unknown; observation?: ToolObservation };
