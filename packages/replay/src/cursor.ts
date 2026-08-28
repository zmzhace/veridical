import type { TraceEvent } from '@veridical/schema';
import { contentHash, hasRedaction, type InvocationRecorder } from '@veridical/runtime';
import type { LLMRequest, LLMResponse } from '@veridical/llm';
import { projectInvocations, type ProjectedInvocation } from './trajectory';

export type PathReplayErrorCode =
  | 'replay_miss'
  | 'replay_path_mismatch'
  | 'replay_fingerprint_mismatch'
  | 'replay_child_agent_missing'
  | 'replay_tool_argument_mismatch'
  | 'replay_manifest_mismatch'
  | 'replay_unconsumed'
  | 'replay_redacted'
  | 'replay_incomplete';
export class PathReplayError extends Error {
  constructor(
    public code: PathReplayErrorCode,
    public path: string,
    public expected?: unknown,
    public actual?: unknown,
  ) {
    super(`${code}: ${path}`);
    this.name = 'PathReplayError';
  }
}

/** A call is consumed only after every matching predicate succeeds. */
export class ReplayCursor {
  readonly invocations: ProjectedInvocation[];
  private used = new Set<string>();
  constructor(readonly events: TraceEvent[]) {
    this.invocations = projectInvocations(events);
  }
  find(path: string, attempt = 1): ProjectedInvocation | undefined {
    return this.invocations.find((i) => i.path === path && i.attempt === attempt);
  }
  nextInvocation(
    path: string,
    operation: string,
    input?: unknown,
    attempt = 1,
    ordinal?: number,
  ): ProjectedInvocation {
    const hit = this.find(path, attempt);
    if (!hit)
      throw new PathReplayError(
        operation === 'agent.dispatch' ? 'replay_child_agent_missing' : 'replay_path_mismatch',
        path,
      );
    if (this.used.has(hit.invocation_id)) throw new PathReplayError('replay_miss', path);
    if (hit.operation !== operation || (ordinal !== undefined && ordinal !== hit.ordinal))
      throw new PathReplayError('replay_path_mismatch', path, hit.operation, operation);
    if (input !== undefined && hit.fingerprint !== contentHash(input))
      throw new PathReplayError(
        hit.actor === 'tool' ? 'replay_tool_argument_mismatch' : 'replay_fingerprint_mismatch',
        path,
        hit.fingerprint,
        contentHash(input),
      );
    this.used.add(hit.invocation_id);
    return hit;
  }
  async playback<T>(scope: InvocationRecorder, hit: ProjectedInvocation): Promise<T> {
    scope.recordedDurationMs = hit.duration_ms;
    if (hit.end_seq === undefined) throw new PathReplayError('replay_incomplete', hit.path);
    if (hasRedaction(hit.output) || hasRedaction(hit.input) || hasRedaction(hit.error))
      throw new PathReplayError('replay_redacted', hit.path);
    const descendants = this.invocations.filter((i) => i.path.startsWith(hit.path + '/'));
    const ids = new Set([hit.invocation_id, ...descendants.map((i) => i.invocation_id)]);
    for (const child of descendants) this.used.add(child.invocation_id);
    await scope.restoreEvents(
      this.events.filter(
        (e) => e.seq > hit.start_seq && e.seq < hit.end_seq! && ids.has(e.invocation_id!),
      ),
      hit.invocation_id,
    );
    if (hit.error) {
      const error = new Error(String(hit.error.message)) as Error & { code: string };
      error.name = hit.error.code;
      error.code = hit.error.code;
      throw error;
    }
    return structuredClone(hit.output) as T;
  }
  nextLLM(path: string, request: LLMRequest | string): LLMResponse {
    if (typeof request === 'string') {
      const hit = this.find(path);
      if (!hit) throw new PathReplayError('replay_miss', path);
      if (hit.fingerprint !== request)
        throw new PathReplayError('replay_fingerprint_mismatch', path, hit.fingerprint, request);
      return this.nextInvocation(path, hit.operation).output as LLMResponse;
    }
    const { signal: _signal, invocationPath: _path, ...input } = request;
    return this.nextInvocation(path, 'llm.complete', input).output as LLMResponse;
  }
  nextTool(path: string, name: string, args: unknown): unknown {
    const hit = this.find(path);
    if (!hit) throw new PathReplayError('replay_miss', path);
    return this.nextInvocation(path, name, { ...(hit.input as object), name, args }).output;
  }
  markRoot(path: string): void {
    const i = this.find(path);
    if (i) this.nextInvocation(path, i.operation, i.input, i.attempt, i.ordinal);
  }
  assertConsumed(): void {
    const unused = this.invocations.find((i) => !this.used.has(i.invocation_id));
    if (unused) throw new PathReplayError('replay_unconsumed', unused.path);
  }
}
