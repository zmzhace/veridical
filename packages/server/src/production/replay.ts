import { ReplayCursor, comparableGraph } from '@veridical/replay';
import type { InvocationInterceptor } from '@veridical/runtime';
import type { TraceEvent } from '@veridical/schema';
import type { AgentSpec } from '@veridical/spec';
import { digest, Fault, type Job } from './contracts';
import type { Ledger } from './database';
import type { ProductionConfig } from './config';
import { executeTurn, runtimeEnvironment, type ProductionTool } from './runner';

const semantic = (events: TraceEvent[]) =>
  events
    .filter((e) => !e.type.startsWith('job.') && e.type !== 'run.provenance')
    .map((e) => ({ type: e.type, verb: e.verb, payload: e.payload, tokens: e.tokens }));

// Strict offline re-execution: never falls back to a live provider or tool.
export async function replayRecorded(options: {
  db: Pick<Ledger, 'verify' | 'read' | 'assertFence' | 'append'> & {
    verify(tenant: string, session: string, checkpoint?: any): any | Promise<any>;
    read(tenant: string, session: string, after?: number, limit?: number): TraceEvent[] | Promise<TraceEvent[]>;
  };
  job: Job;
  spec: AgentSpec;
  config: ProductionConfig;
  tools: ProductionTool[];
  signal: AbortSignal;
  check: () => void | Promise<void>;
}) {
  const { db, job, spec, config, tools, signal } = options;
  const checkpoint = await db.verify(job.tenant, job.args.source, job.args.checkpoint);
  if (checkpoint.head !== job.args.checkpoint.head || checkpoint.seq !== job.args.checkpoint.seq)
    throw new Fault(409, 'replay_source_changed');
  const source = await db.read(job.tenant, job.args.source);
  if (
    !source.length ||
    source.some((e) => e.verb === 'error') ||
    source.filter((e) => e.type === 'user.message').length !==
      source.filter((e) => e.type === 'turn/end').length
  )
    throw new Fault(422, 'replay_requires_completed_successful_session');
  if (
    source
      .filter((e) => e.type === 'run.provenance')
      .some((e) => (e.payload as any).environment !== runtimeEnvironment(spec, config, tools))
  )
    throw new Fault(409, 'replay_requires_original_runtime');
  const cursor = new ReplayCursor(source);
  if (!cursor.invocations.length) throw new Fault(422, 'replay_legacy_trace');
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
  for (const event of source.filter((e) => e.type === 'user.message')) {
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
