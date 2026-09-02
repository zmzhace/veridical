import { ReplayCursor, comparableGraph } from '@veridical/replay';
import type { InvocationInterceptor } from '@veridical/runtime';
import type { TraceEvent } from '@veridical/schema';
import type { AgentSpec } from '@veridical/spec';
import { digest, Fault, type Job } from './contracts';
import type { Ledger } from './database';
import type { ProductionConfig } from './config';
import {
  executeTurn,
  runtimeEnvironment,
  runtimeReleaseArtifactHash,
  type ProductionTool,
} from './runner';

const semantic = (events: TraceEvent[]) =>
  events
    .filter((e) => !e.type.startsWith('job.') && e.type !== 'run.provenance')
    .map((e) => ({ type: e.type, verb: e.verb, payload: e.payload, tokens: e.tokens }));

// Strict offline re-execution: never falls back to a live provider or tool.
export async function replayRecorded(options: {
  db: Pick<Ledger, 'verify' | 'read' | 'assertFence' | 'append' | 'get'> & {
    verify(tenant: string, session: string, checkpoint?: any): any | Promise<any>;
    read(
      tenant: string,
      session: string,
      after?: number,
      limit?: number,
    ): TraceEvent[] | Promise<TraceEvent[]>;
  };
  job: Job;
  spec: AgentSpec;
  config: ProductionConfig;
  tools: ProductionTool[];
  signal: AbortSignal;
  check: () => void | Promise<void>;
  target?: { invocation_id?: string; path?: string; scope?: 'invocation' | 'subtree' | 'agent' };
}): Promise<any> {
  const { db, job, spec, config, tools, signal, target } = options;
  const checkpoint = await db.verify(job.tenant, job.args.source, job.args.checkpoint);
  if (checkpoint.head !== job.args.checkpoint.head || checkpoint.seq !== job.args.checkpoint.seq)
    throw new Fault(409, 'replay_source_changed');
  const source = await db.read(job.tenant, job.args.source);
  if (
    !source.length ||
    source.some((e) => e.verb === 'error') ||
    source.filter((e) => e.type === 'user.message' && !e.parent_invocation_id).length !==
      source.filter((e) => e.type === 'turn/end' && !e.parent_invocation_id).length
  )
    throw new Fault(422, 'replay_requires_completed_successful_session');
  if (
    source
      .filter((e) => e.type === 'run.provenance')
      .some((e) => (e.payload as any).environment !== runtimeEnvironment(spec, config, tools))
  )
    throw new Fault(409, 'replay_requires_original_runtime');
  const expectedReleaseHash = runtimeReleaseArtifactHash(spec, config, tools);
  if (
    source
      .filter((event) => event.type === 'run.provenance' && !event.parent_invocation_id)
      .some((event) => (event.payload as any).release_artifact_hash !== expectedReleaseHash)
  )
    throw new Fault(409, 'replay_manifest_mismatch');
  const cursor = new ReplayCursor(source);
  if (!cursor.invocations.length) throw new Fault(422, 'replay_legacy_trace');
  if (target?.path || target?.invocation_id) {
    const hit = target.invocation_id
      ? cursor.invocations.find((item) => item.invocation_id === target.invocation_id)
      : cursor.invocations.find((item) => item.path === target.path);
    if (!hit) throw new Fault(409, target.invocation_id ? 'replay_miss' : 'replay_path_mismatch');
    if (target.path && hit.path !== target.path) throw new Fault(409, 'replay_path_mismatch');
    const result: any = await replayRecorded({ ...options, target: undefined });
    return {
      ...result,
      replayed_scope: target.scope ?? 'subtree',
      target_path: hit.path,
      target_invocation_id: hit.invocation_id,
      execution: 'path_aware_reexecution',
    };
  }
  const interceptor: InvocationInterceptor = async (scope, input, execute) => {
    const i = scope.invocation;
    const hit = cursor.nextInvocation(i.path, i.operation, input, i.attempt, i.ordinal);
    if (i.actor === 'llm' || i.actor === 'tool') return cursor.playback(scope, hit);
    return execute();
  };
  const model = {
    complete: async (): Promise<never> => {
      throw new Fault(409, 'replay_live_forbidden');
    },
  };
  let turn = 0;
  // Child-agent task prompts are recorded in the same physical session, but
  // are not user turns. Only root-level messages drive the replay scheduler;
  // dispatch() replays child messages through their path-scoped cursor.
  for (const event of source.filter((e) => e.type === 'user.message' && !e.parent_invocation_id)) {
    cursor.markRoot(turn++ === 0 ? 'root' : `root/turn#${turn}`);
    await executeTurn({
      ledger: db,
      job,
      session: job.session,
      spec,
      config,
      tools,
      invocationInterceptor: interceptor,
      signal,
      input: (event.payload as any).text,
      checkRelease: options.check,
      providers: new Map([[spec.llm.provider, model]]),
      resolveAgent: async (ref) => {
        const artifact = await db.get(job.tenant, 'spec', ref);
        if (!artifact || artifact.status === 'revoked') return undefined;
        return (artifact as any).body as AgentSpec;
      },
    });
  }
  cursor.assertConsumed();
  const clean = (events: TraceEvent[]) =>
    events.filter((e) => !e.type.startsWith('job.') && e.type !== 'run.provenance');
  const expected = digest(comparableGraph(clean(source))),
    actual = digest(comparableGraph(clean(await db.read(job.tenant, job.session))));
  if (expected !== actual) throw new Fault(409, 'replay_semantics_diverged');
  return {
    matched: true,
    mode: 'strict',
    identical: true,
    degraded: false,
    source: job.args.source,
    checkpoint,
    semantic_digest: actual,
    external_calls: 0,
  };
}
