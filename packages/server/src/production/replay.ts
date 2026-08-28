import { ReplayLLMProvider, ReplayToolProvider } from '@veridical/replay';
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
  db: Ledger;
  job: Job;
  spec: AgentSpec;
  config: ProductionConfig;
  tools: ProductionTool[];
  signal: AbortSignal;
  check: () => void;
}) {
  const { db, job, spec, config, tools, signal } = options;
  const checkpoint = db.verify(job.tenant, job.args.source, job.args.checkpoint);
  if (checkpoint.head !== job.args.checkpoint.head || checkpoint.seq !== job.args.checkpoint.seq)
    throw new Fault(409, 'replay_source_changed');
  const source = db.read(job.tenant, job.args.source);
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
  const model = new ReplayLLMProvider(source),
    tool = new ReplayToolProvider(source);
  const replayTools = tools.map((t) => ({
    ...t,
    execute: (args: unknown) => tool.execute(t.name, args),
  }));
  for (const event of source.filter((e) => e.type === 'user.message')) {
    await executeTurn({
      ledger: db,
      job,
      session: job.session,
      spec,
      config,
      tools: replayTools,
      signal,
      input: (event.payload as any).text,
      checkRelease: options.check,
      providers: new Map([[spec.llm.provider, model]]),
    });
  }
  const expected = digest(semantic(source)),
    actual = digest(semantic(db.read(job.tenant, job.session)));
  if (expected !== actual) throw new Fault(409, 'replay_semantics_diverged');
  return {
    matched: true,
    source: job.args.source,
    checkpoint,
    semantic_digest: actual,
    external_calls: 0,
  };
}
