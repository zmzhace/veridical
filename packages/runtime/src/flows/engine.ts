import type { Recorder } from '../recorder';

export interface FlowContext {
  /** Opaque run metadata keeps runtime independent from any Spec package. */
  identity?: {
    runId?: string;
    sessionId?: string;
    tenantId?: string;
    specVersion?: string;
    invocationId?: string;
    path?: string;
  };
  spec?: unknown;
  recorder: Recorder;
  runStep(
    prompt: string,
  ): Promise<{
    text: string;
    tool?: { name: string; args: unknown };
    delegate?: string;
    task?: string;
    done?: boolean;
  }>;
  executeTool(name: string, args: unknown): Promise<unknown>;
  shouldStop(outcome: unknown): boolean;
  verifyToolResult(name: string, result: unknown): boolean;
  maxSteps: number;
  onStepEnd?: () => Promise<void>;
  signal?: AbortSignal;
  checkAbort?: () => Promise<void>;
  budget?: { maxSteps: number; maxTokens?: number; maxCost?: number };
  checkpoint?: (state: unknown) => Promise<void>;
  dispatch?: (delegate: string, task: string) => Promise<unknown>;
  dispatchMany?: (tasks: { delegate: string; task: string }[]) => Promise<unknown[]>;
}

/** Pluggable loop contract. Domain loops (research, coding, browser) implement this interface. */
export interface AgentLoop {
  readonly kind: string;
  run(ctx: FlowContext, prompt: string): Promise<void>;
}

export class LoopRegistry {
  private readonly loops = new Map<string, AgentLoop>();
  register(loop: AgentLoop): this {
    this.loops.set(loop.kind, loop);
    return this;
  }
  get(kind: string): AgentLoop | undefined {
    return this.loops.get(kind);
  }
}
