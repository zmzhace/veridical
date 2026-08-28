import { randomUUID } from 'node:crypto';
import type { TraceStore } from '@veridical/store';
import type { TraceEvent } from '@veridical/schema';
import {
  canonicalJson,
  contentHash,
  type AgentLoop,
  type InvocationInterceptor,
} from '@veridical/runtime';
import { runSpec, type AgentSpec, type SpecRegistry, type SpecRunnerDeps } from '@veridical/spec';
import type { ToolDef } from '@veridical/tools';
import type { LLMProvider } from '@veridical/llm';
import { ReplayCursor, PathReplayError } from './cursor';
import { projectInvocations } from './trajectory';
import type { ReplayPlan, ReplayMode, InvocationFixture } from './plan';
import type { DiffEntry } from './comparator';

export class TraceDivergenceError extends Error {
  readonly code = 'replay_path_mismatch';
  constructor(
    public seq: number,
    public differences: DiffEntry[],
  ) {
    super(`trace diverged at seq ${seq}`);
    this.name = 'TraceDivergenceError';
  }
}
export class ReplayError extends Error {
  constructor(
    message: string,
    public code = 'replay_miss',
  ) {
    super(message);
    this.name = 'ReplayError';
  }
}
export interface ReplayResult {
  session_id: string;
  spec_name: string;
  spec_version: string;
  outcome: unknown;
  events: TraceEvent[];
  identical: boolean;
  mode: ReplayMode;
  degraded: boolean;
  passed?: boolean;
  fixtures_used: number;
  external_calls: 0;
  differences: unknown[];
  source_manifest: unknown;
  replay_manifest: unknown;
}
export interface ReplayOptions {
  runStep?: SpecRunnerDeps['runStep'];
  childRunStep?: SpecRunnerDeps['runStep'];
  loops?: Map<string, AgentLoop>;
  runtime_version?: string;
  signal?: AbortSignal;
  verify?: SpecRunnerDeps['verify'];
}

/** Excludes transport identity/timing only; compares event structure within each explicit call path. */
export function comparableGraph(events: TraceEvent[]): Record<string, unknown[]> {
  const ids = new Map(
    events.filter((e) => e.invocation_id).map((e) => [e.invocation_id!, e.path!]),
  );
  const normalize = (e: TraceEvent): unknown => {
    if (!e.type.startsWith('invocation.')) return e.payload;
    const {
      run_id: _run,
      invocation_id,
      parent_invocation_id,
      ...payload
    } = e.payload as import('@veridical/runtime').InvocationRecord;
    return {
      ...payload,
      invocation_id: ids.get(invocation_id),
      parent_invocation_id: parent_invocation_id ? ids.get(parent_invocation_id) : null,
    };
  };
  const graph: Record<string, unknown[]> = {};
  for (const e of events) {
    if (e.type.startsWith('replay.')) continue;
    const key = `${e.path}@${e.attempt}`;
    (graph[key] ??= []).push({
      type: e.type,
      verb: e.verb,
      ordinal: e.ordinal,
      spec_version: e.spec_version,
      parent: e.parent_invocation_id ? ids.get(e.parent_invocation_id) : null,
      payload: normalize(e),
      tokens: e.tokens ?? null,
      cost: e.cost ?? null,
    });
  }
  return graph;
}
export function fixtureHash(fixture: Omit<InvocationFixture, 'hash'>): string {
  return contentHash(fixture);
}

export class ReplayEngine {
  constructor(
    private store: TraceStore,
    private registry: SpecRegistry,
  ) {}

  async replay(
    session_id: string,
    plan: ReplayPlan,
    tools: ToolDef[],
    opts: ReplayOptions = {},
  ): Promise<ReplayResult> {
    const mode = plan.mode ?? 'strict';
    if (!['strict', 'fixture', 'semantic'].includes(mode))
      throw new ReplayError('invalid replay mode');
    if ([...Object.values(plan.llm ?? {}), ...Object.values(plan.tools ?? {})].includes('live'))
      throw new ReplayError('live fallback is forbidden', 'replay_live_forbidden');
    if (
      mode === 'strict' &&
      (plan.assert_trace_identical === false ||
        plan.invocation_fixtures?.length ||
        plan.fixtures ||
        [...Object.values(plan.llm ?? {}), ...Object.values(plan.tools ?? {})].includes('fixture'))
    )
      throw new ReplayError(
        'strict cannot disable identity or use fixtures; select an explicit degraded mode',
        'replay_mode_conflict',
      );
    if (mode !== 'strict' && !plan.downgrade_reason?.trim())
      throw new ReplayError('degraded replay requires a reason', 'replay_reason_required');
    if (mode === 'semantic' && (!plan.semantic || !Object.keys(plan.semantic).length))
      throw new ReplayError(
        'semantic replay requires explicit invariants',
        'replay_invariants_required',
      );
    const source = await this.store.readBySession(session_id);
    const cursor = new ReplayCursor(source);
    if (!cursor.invocations.length)
      throw new ReplayError(
        'legacy trace has no complete invocation graph; use trace projection, not strict replay',
        'replay_legacy_trace',
      );
    if (mode === 'strict' && cursor.invocations.some((i) => i.end_seq === undefined))
      throw new ReplayError('source contains incomplete calls', 'replay_incomplete');
    const roots = cursor.invocations.filter((i) => !i.parent_invocation_id);
    const manifests = new Map(
      source
        .filter((e) => e.type === 'run.provenance')
        .map((e) => [
          e.path!,
          e.payload as { manifest: Record<string, any>; manifest_hash: string; spec: AgentSpec },
        ]),
    );
    for (const [path, p] of manifests)
      if (
        contentHash(p.manifest) !== p.manifest_hash ||
        contentHash(p.spec) !== p.manifest.spec_hash
      )
        throw new PathReplayError('replay_manifest_mismatch', path);
    const first = manifests.get(roots[0].path);
    if (!first) throw new PathReplayError('replay_manifest_mismatch', roots[0].path);
    const spec = await this.registry.resolve(
      plan.spec.name,
      plan.spec.version ?? first.spec.version,
    );
    if (!spec)
      throw new ReplayError(`spec not found: ${plan.spec.name}`, 'replay_child_agent_missing');
    const fixtures = new Map<string, InvocationFixture>();
    for (const f of plan.invocation_fixtures ?? []) {
      const { hash, ...body } = f;
      const key = `${f.path}@${f.attempt ?? 1}`;
      if (
        !f.source?.trim() ||
        !f.version?.trim() ||
        !f.fingerprint ||
        contentHash(body) !== hash ||
        fixtures.has(key)
      )
        throw new ReplayError('invalid or duplicate fixture manifest', 'replay_fixture_invalid');
      fixtures.set(key, structuredClone(f));
    }
    if (mode === 'fixture' && !fixtures.size)
      throw new ReplayError(
        'fixture mode requires path-bound versioned fixtures',
        'replay_fixture_missing',
      );
    const replaySession = `replay_${randomUUID()}`;
    if (mode !== 'strict') {
      await this.store.appendNext({
        tenant_id: source[0].tenant_id,
        session_id: replaySession,
        spec_version: spec.version,
        span_id: 'replay',
        parent_span_id: null,
        type: 'replay.degraded',
        verb: 'response',
        attempt: 1,
        duration_ms: 0,
        payload: {
          source: session_id,
          mode,
          reason: plan.downgrade_reason,
          fixture_manifest_hash: contentHash(plan.invocation_fixtures ?? []),
        },
      });
    }
    const neverLive: LLMProvider = {
      complete: async () => {
        throw new ReplayError('unrecorded LLM call', 'replay_live_forbidden');
      },
    };
    const providers = new Map<string, LLMProvider>();
    for (const p of manifests.values()) {
      providers.set(p.spec.llm.provider, neverLive);
      for (const f of p.spec.llm.fallback) providers.set(f.provider, neverLive);
    }
    providers.set(spec.llm.provider, neverLive);
    let fixturesUsed = 0;
    const usedFixtures = new Set<string>();
    const interceptor: InvocationInterceptor = async <T>(
      scope: import('@veridical/runtime').InvocationRecorder,
      input: unknown,
      execute: () => Promise<T>,
    ): Promise<T> => {
      const i = scope.invocation;
      const key = `${i.path}@${i.attempt}`;
      const f = fixtures.get(key);
      if (f) {
        if (
          f.operation !== i.operation ||
          f.fingerprint !== contentHash(input) ||
          usedFixtures.has(key)
        )
          throw new PathReplayError('replay_fingerprint_mismatch', i.path);
        if (!['tool', 'llm', 'memory'].includes(i.actor))
          throw new ReplayError(
            'fixtures cannot replace agent or loop execution',
            'replay_fixture_invalid',
          );
        if (cursor.find(i.path, i.attempt))
          cursor.nextInvocation(i.path, i.operation, input, i.attempt, i.ordinal);
        usedFixtures.add(key);
        fixturesUsed++;
        await scope.event('replay.fixture', 'response', {
          source: f.source,
          version: f.version,
          hash: f.hash,
          fingerprint: f.fingerprint,
        });
        if (i.actor === 'llm') {
          const output = f.output as import('@veridical/llm').LLMResponse;
          if (
            typeof output?.text !== 'string' ||
            !output.usage ||
            Object.values(output.usage).some((v) => !Number.isFinite(v) || v < 0)
          )
            throw new ReplayError(
              'LLM fixture requires text and valid usage',
              'replay_fixture_invalid',
            );
          await scope.event('llm.request', 'request', {
            ...(input as object),
            fingerprint: f.fingerprint,
          });
          await scope.record({
            span_id: i.path,
            parent_span_id: i.parent_invocation_id ?? null,
            type: 'llm.response',
            verb: 'response',
            attempt: i.attempt,
            duration_ms: 0,
            tokens: output.usage,
            cost: output.cost,
            payload: { ...output, fingerprint: f.fingerprint, fixture: true },
          });
        }
        return structuredClone(f.output) as T;
      }
      const hit =
        (mode === 'semantic' ||
          (mode === 'fixture' &&
            ['agent.decision', 'checkpoint', 'control.check', 'loop.run'].includes(i.operation))) &&
        !cursor.find(i.path, i.attempt)
          ? undefined
          : cursor.nextInvocation(
              i.path,
              i.operation,
              (mode === 'semantic' && (i.actor === 'agent' || i.actor === 'join')) ||
                (mode !== 'strict' && i.operation === 'checkpoint')
                ? undefined
                : input,
              i.attempt,
              i.ordinal,
            );
      if (i.operation === 'control.check' && hit) return cursor.playback<T>(scope, hit);
      if (i.operation === 'agent.decision') {
        const agentPath = i.path.slice(0, i.path.lastIndexOf('/decision#'));
        const decisionHash = manifests.get(agentPath)?.manifest.decision_hash;
        const callback =
          agentPath === roots[0].path || /^root\/turn#\d+$/.test(agentPath)
            ? opts.runStep
            : opts.childRunStep;
        if (hit && !callback && decisionHash !== 'default-json-v1')
          return cursor.playback<T>(scope, hit);
        return execute();
      }
      if (i.actor === 'tool' || i.actor === 'llm' || i.actor === 'memory') {
        if (!hit) throw new PathReplayError('replay_miss', i.path);
        return cursor.playback<T>(scope, hit);
      }
      return execute();
    };
    const validateManifest: SpecRunnerDeps['validateManifest'] = (actual, path) => {
      const expected = manifests.get(path)?.manifest;
      if (mode === 'strict' && (!expected || contentHash(expected) !== contentHash(actual)))
        throw new PathReplayError('replay_manifest_mismatch', path, expected, actual);
    };
    const hasMemory = cursor.invocations.some((i) => i.operation === 'memory.recall');
    const hasMemoryStep = cursor.invocations.some((i) => i.operation === 'memory.onStep');
    let outcome: unknown;
    let runError: unknown;
    for (const root of roots) {
      cursor.markRoot(root.path);
      const input = root.input as {
        prompt: string;
        history: { role: 'user' | 'assistant'; content: string }[];
        turn: boolean;
        firstTurn: boolean;
        spec_hash: string;
      };
      if (mode === 'strict' && input.spec_hash !== contentHash(spec))
        throw new PathReplayError('replay_manifest_mismatch', root.path);
      try {
        const result = await runSpec(
          {
            store: this.store,
            registry: this.registry,
            providers,
            tools,
            tenant_id: source[0].tenant_id,
            session_id: replaySession,
            historyMessages: input.history,
            turn: input.turn,
            firstTurn: input.firstTurn,
            invocationInterceptor: interceptor,
            validateManifest,
            runStep: opts.runStep,
            childRunStep: opts.childRunStep,
            loops: opts.loops,
            signal: opts.signal,
            verify: opts.verify,
            decisionHash: (path) => manifests.get(path)?.manifest.decision_hash,
            release_artifact_hash: first.manifest.release_artifact_hash ?? undefined,
            runtime_version: opts.runtime_version,
            budget: first.manifest.budget ?? undefined,
            memory:
              hasMemory || hasMemoryStep
                ? {
                    recall: async () => [],
                    ...(hasMemoryStep ? { onStep: async () => undefined } : {}),
                  }
                : undefined,
          },
          spec,
          input.prompt,
        );
        outcome = result.outcome;
      } catch (error) {
        if (error instanceof PathReplayError || error instanceof ReplayError) throw error;
        if ((error as { code?: string })?.code === 'replay_child_agent_missing')
          throw new PathReplayError('replay_child_agent_missing', root.path);
        if (root.status === 'success')
          throw new ReplayError(
            error instanceof Error ? error.message : String(error),
            'replay_execution_failed',
          );
        runError = error;
      }
    }
    if (mode === 'strict') cursor.assertConsumed();
    if (usedFixtures.size !== fixtures.size)
      throw new ReplayError(
        'fixture manifest contains unconsumed entries',
        'replay_fixture_unused',
      );
    let events = await this.store.readBySession(replaySession);
    const before = comparableGraph(source),
      after = comparableGraph(events);
    const differences: { path: string; expected: unknown; actual: unknown }[] = [
      ...new Set([...Object.keys(before), ...Object.keys(after)]),
    ]
      .sort()
      .filter((path) => canonicalJson(before[path]) !== canonicalJson(after[path]))
      .map((path) => ({ path, expected: before[path] ?? null, actual: after[path] ?? null }));
    if (mode === 'strict' && differences.length)
      throw new TraceDivergenceError(0, differences as unknown as DiffEntry[]);
    let passed: boolean | undefined;
    if (mode === 'semantic') {
      const criteria = plan.semantic!;
      const graph = projectInvocations(events);
      const checks: { check: string; passed: boolean }[] = [];
      if (Object.hasOwn(criteria, 'expected_outcome'))
        checks.push({
          check: 'final_outcome',
          passed: canonicalJson(outcome) === canonicalJson(criteria.expected_outcome),
        });
      for (const name of criteria.required_tools ?? [])
        checks.push({
          check: `required_tool:${name}`,
          passed: graph.some(
            (i) => i.actor === 'tool' && i.operation === name && i.status === 'success',
          ),
        });
      for (const name of criteria.forbidden_tools ?? [])
        checks.push({
          check: `forbidden_tool:${name}`,
          passed: !graph.some((i) => i.actor === 'tool' && i.operation === name),
        });
      for (const name of criteria.completed_agents ?? [])
        checks.push({
          check: `completed_agent:${name}`,
          passed: graph.some(
            (i) =>
              i.operation === 'agent.dispatch' &&
              (i.input as { delegate?: string }).delegate === name &&
              i.status === 'success',
          ),
        });
      for (const name of criteria.completed_stages ?? [])
        checks.push({
          check: `completed_stage:${name}`,
          passed: events.some(
            (e) =>
              e.type === 'stage/end' &&
              e.verb === 'response' &&
              (e.payload as { stage?: string }).stage === name,
          ),
        });
      const totals = {
        max_steps: graph.filter((i) => i.operation === 'agent.decision').length,
        max_tokens: events.reduce((n, e) => n + (e.tokens?.total ?? 0), 0),
        max_cost: events.reduce((n, e) => n + (typeof e.cost === 'number' ? e.cost : 0), 0),
        // Replay reuses recorded service durations; this is a trace budget, not a live benchmark.
        max_duration_ms: graph
          .filter((i) => i.actor === 'tool' || i.actor === 'llm')
          .reduce((n, i) => n + i.duration_ms, 0),
      };
      for (const key of Object.keys(totals) as (keyof typeof totals)[])
        if (criteria[key] !== undefined) {
          if (!Number.isFinite(criteria[key]) || criteria[key]! < 0)
            throw new ReplayError('invalid budget threshold');
          checks.push({ check: key, passed: totals[key] <= criteria[key]! });
        }
      if (criteria.max_cost !== undefined)
        checks.push({
          check: 'cost_accounting',
          passed: events
            .filter((e) => e.type === 'llm.response' && e.verb === 'response')
            .every((e) => e.cost !== undefined),
        });
      if (criteria.golden)
        checks.push({
          check: 'golden',
          passed: canonicalJson(outcome) === canonicalJson(criteria.golden.outcome),
        });
      if (!checks.length)
        throw new ReplayError('semantic criteria produced no checks', 'replay_invariants_required');
      passed = !runError && checks.every((c) => c.passed);
      differences.push(
        ...checks
          .filter((c) => !c.passed)
          .map((c) => ({ path: c.check, expected: true, actual: false })),
      );
    }
    if (mode !== 'strict') {
      await this.store.appendNext({
        tenant_id: source[0].tenant_id,
        session_id: replaySession,
        spec_version: spec.version,
        span_id: 'replay',
        parent_span_id: null,
        type: 'replay.result',
        verb: 'response',
        attempt: 1,
        duration_ms: 0,
        payload: {
          source: session_id,
          mode,
          reason: plan.downgrade_reason,
          fixture_manifest_hash: contentHash(plan.invocation_fixtures ?? []),
          fixtures_used: fixturesUsed,
          passed: passed ?? null,
        },
      });
      events = await this.store.readBySession(replaySession);
    }
    return {
      session_id: replaySession,
      spec_name: spec.name,
      spec_version: spec.version,
      outcome,
      events,
      mode,
      identical: mode === 'strict' && !differences.length,
      degraded: mode !== 'strict',
      passed,
      fixtures_used: fixturesUsed,
      external_calls: 0,
      differences,
      source_manifest: first.manifest,
      replay_manifest:
        (events.find((e) => e.type === 'run.provenance')?.payload as { manifest?: unknown })
          ?.manifest ?? null,
    };
  }
}
