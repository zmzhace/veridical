import type { Recorder } from '../recorder';

export interface FlowContext {
  recorder: Recorder;
  runStep(prompt: string): Promise<{ text: string; tool?: { name: string; args: unknown } }>;
  executeTool(name: string, args: unknown): Promise<unknown>;
  shouldStop(outcome: unknown): boolean;
  verifyToolResult(result: unknown): boolean;
  maxSteps: number;
}