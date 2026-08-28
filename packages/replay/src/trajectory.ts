import { InvocationRecordSchema, type TraceEvent } from '@veridical/schema';
import { contentHash, hasRedaction, type InvocationRecord } from '@veridical/runtime';

export interface ProjectedInvocation extends InvocationRecord {
  start_seq: number;
  end_seq?: number;
  event_ids: string[];
  children: string[];
  duration_ms: number;
  tokens: number;
  cost: number;
  legacy: boolean;
}
export class TrajectoryError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'TrajectoryError';
  }
}

/** Pair boundaries by ID, never by proximity or tool name. An incomplete call stays started. */
export function projectInvocations(events: TraceEvent[]): ProjectedInvocation[] {
  const records = new Map<string, ProjectedInvocation>();
  const paths = new Set<string>();
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  if (new Set(ordered.map((e) => e.seq)).size !== ordered.length)
    throw new TrajectoryError(
      'invocation_duplicate_sequence',
      'trace sequence numbers must be unique',
    );
  for (const e of ordered) {
    if (e.type === 'invocation.start') {
      const p = InvocationRecordSchema.parse(e.payload);
      if (
        !p ||
        !e.invocation_id ||
        !e.path ||
        p.invocation_id !== e.invocation_id ||
        p.path !== e.path ||
        p.parent_invocation_id !== e.parent_invocation_id ||
        p.status !== 'started'
      )
        throw new TrajectoryError('invocation_invalid', `invalid start at seq ${e.seq}`);
      const key = `${e.path}@${e.attempt}`;
      if (records.has(e.invocation_id) || paths.has(key))
        throw new TrajectoryError('invocation_duplicate', key);
      if (p.fingerprint !== contentHash(p.input) && !hasRedaction(p.input))
        throw new TrajectoryError('invocation_fingerprint_mismatch', key);
      paths.add(key);
      records.set(e.invocation_id, {
        ...p,
        start_seq: e.seq,
        event_ids: [e.id],
        children: [],
        duration_ms: 0,
        tokens: 0,
        cost: 0,
        legacy: false,
      });
    } else if (e.invocation_id && records.has(e.invocation_id)) {
      const record = records.get(e.invocation_id)!;
      if (
        e.path !== record.path ||
        e.parent_invocation_id !== record.parent_invocation_id ||
        e.attempt !== record.attempt ||
        e.ordinal !== record.ordinal
      )
        throw new TrajectoryError('invocation_event_mismatch', record.path);
      record.event_ids.push(e.id);
      record.duration_ms += e.duration_ms;
      record.tokens += e.tokens?.total ?? 0;
      record.cost += typeof e.cost === 'number' ? e.cost : 0;
      if (e.type === 'invocation.end') {
        const p = InvocationRecordSchema.parse(e.payload);
        if (
          record.end_seq ||
          p.path !== record.path ||
          p.fingerprint !== record.fingerprint ||
          p.parent_invocation_id !== record.parent_invocation_id ||
          p.attempt !== record.attempt ||
          p.ordinal !== record.ordinal ||
          p.operation !== record.operation ||
          p.actor !== record.actor ||
          p.status === 'started' ||
          contentHash(p.input) !== contentHash(record.input)
        )
          throw new TrajectoryError('invocation_invalid_end', record.path);
        record.status = p.status;
        record.output = p.output;
        record.error = p.error;
        record.side_effect_state = p.side_effect_state;
        record.end_seq = e.seq;
        record.duration_ms = e.duration_ms;
      }
    } else if (e.type === 'invocation.end')
      throw new TrajectoryError('invocation_orphan', `unpaired end at ${e.seq}`);
  }
  for (const record of records.values()) {
    if (!record.parent_invocation_id) continue;
    const parent = records.get(record.parent_invocation_id);
    if (
      !parent ||
      !record.path.startsWith(parent.path + '/') ||
      parent.start_seq >= record.start_seq ||
      (parent.end_seq !== undefined &&
        (record.end_seq === undefined || parent.end_seq < record.end_seq))
    )
      throw new TrajectoryError('invocation_parent_mismatch', record.path);
    parent.children.push(record.invocation_id);
  }
  return [...records.values()];
}

export interface TrajectoryOptions {
  path?: string;
  scope?: 'tree' | 'agent';
  rewards?: Record<string, number>;
  release_artifact_hash?: string;
}
export interface TrajectoryStep {
  trajectory_id: string;
  invocation_id: string;
  parent_invocation_id?: string;
  path: string;
  ordinal: number;
  attempt: number;
  prompt: unknown;
  state: unknown;
  action: { actor: string; operation: string; input: unknown };
  observation: unknown;
  next_state: unknown;
  tool_input: unknown;
  tool_output: unknown;
  reward: number | null;
  status: string;
  release_artifact_hash: string | null;
  event_ids: string[];
  sequence: { start: number; end: number | null };
  turn: string;
  stage: string | null;
  redacted: boolean;
  legacy: boolean;
}

export function projectTrajectory(
  events: TraceEvent[],
  trajectoryIdOrOptions?: string | TrajectoryOptions,
  options: TrajectoryOptions = {},
): TrajectoryStep[] {
  const opts = typeof trajectoryIdOrOptions === 'object' ? trajectoryIdOrOptions : options;
  const trajectory_id =
    typeof trajectoryIdOrOptions === 'string'
      ? trajectoryIdOrOptions
      : (events.find((e) => e.run_id)?.run_id ?? events[0]?.session_id ?? 'empty');
  const invocations = projectInvocations(events);
  const byId = new Map(invocations.map((i) => [i.invocation_id, i]));
  const provenance = events.find((e) => e.type === 'run.provenance')?.payload as
    | { manifest?: { release_artifact_hash?: string } }
    | undefined;
  const release = opts.release_artifact_hash ?? provenance?.manifest?.release_artifact_hash ?? null;
  const states = new Map<string, unknown>();
  const agentOf = (i: ProjectedInvocation): ProjectedInvocation => {
    if (i.operation === 'agent.run' || i.operation === 'agent.dispatch') return i;
    return i.parent_invocation_id && byId.has(i.parent_invocation_id)
      ? agentOf(byId.get(i.parent_invocation_id)!)
      : i;
  };
  const steps: TrajectoryStep[] = [];
  for (const i of invocations) {
    const agent = agentOf(i);
    if (
      opts.path &&
      !(
        i.path === opts.path ||
        (opts.scope !== 'agent' ? i.path.startsWith(opts.path + '/') : agent.path === opts.path)
      )
    )
      continue;
    const input = i.input as {
      prompt?: unknown;
      task?: unknown;
      history?: unknown;
      args?: unknown;
    } | null;
    const agentInput = agent.input as { prompt?: unknown; task?: unknown } | null;
    const state = {
      context: input?.history ?? states.get(agent.path) ?? agent.input,
      input: i.input,
    };
    const next_state = { ...state, observation: i.output ?? null, status: i.status };
    // An aggregate parent result occurs after its children; it must not leak into their pre-state.
    if (!i.children.length) states.set(agent.path, next_state);
    const reward =
      opts.rewards?.[`${i.path}@${i.attempt}`] ?? opts.rewards?.[i.invocation_id] ?? null;
    if (reward !== null && !Number.isFinite(reward))
      throw new TrajectoryError('reward_invalid', i.path);
    const stageEvent = events
      .filter((e) => e.seq <= i.start_seq && e.type === 'stage/start' && e.path === agent.path)
      .at(-1);
    steps.push({
      trajectory_id,
      invocation_id: i.invocation_id,
      parent_invocation_id: i.parent_invocation_id,
      path: i.path,
      ordinal: i.ordinal,
      attempt: i.attempt,
      prompt: agentInput?.prompt ?? agentInput?.task ?? null,
      state,
      action: { actor: i.actor, operation: i.operation, input: i.input },
      observation: i.output ?? null,
      next_state,
      tool_input: i.actor === 'tool' ? (input?.args ?? i.input) : null,
      tool_output: i.actor === 'tool' ? (i.output ?? null) : null,
      reward,
      status: i.status,
      release_artifact_hash: release,
      event_ids: i.event_ids,
      sequence: { start: i.start_seq, end: i.end_seq ?? null },
      turn: i.path.match(/^root\/turn#\d+/)?.[0] ?? 'root',
      stage: (stageEvent?.payload as { stage?: string } | undefined)?.stage ?? null,
      redacted: hasRedaction(i.input) || hasRedaction(i.output),
      legacy: false,
    });
  }
  // Old traces remain readable but are never presented as complete invocation pairs.
  if (!invocations.length)
    return events.map((e) => ({
      trajectory_id,
      invocation_id: e.invocation_id ?? e.id,
      path: e.path ?? e.span_id,
      ordinal: e.ordinal ?? e.seq,
      attempt: e.attempt,
      prompt: null,
      state: null,
      action: { actor: e.type.split('.')[0], operation: e.type, input: e.payload },
      observation: null,
      next_state: null,
      tool_input: null,
      tool_output: null,
      reward: null,
      status: 'legacy',
      release_artifact_hash: release,
      event_ids: [e.id],
      sequence: { start: e.seq, end: null },
      turn: 'legacy',
      stage: null,
      redacted: hasRedaction(e.payload),
      legacy: true,
    }));
  return steps;
}

export function trajectoryJsonl(steps: TrajectoryStep[]): string {
  return steps.map((step) => JSON.stringify(step)).join('\n') + (steps.length ? '\n' : '');
}

/** Dataset preparation, not a trainer: absent rewards or model token/logprob data are not invented. */
export function exportGRPO(
  events: TraceEvent[],
  options: TrajectoryOptions & { group_id: string },
): string {
  if (!options.group_id?.trim())
    throw new TrajectoryError('group_id_required', 'GRPO requires an explicit prompt group');
  const steps = projectTrajectory(events, options);
  if (steps.some((s) => s.legacy || s.status === 'started' || s.redacted))
    throw new TrajectoryError(
      'trajectory_not_trainable',
      'legacy, incomplete or redacted trajectories require explicit curation',
    );
  const decisions = steps.filter((s) => s.action.operation === 'agent.decision');
  // One sample per policy decision; do not double-count the LLM calls inside that decision.
  const samples = steps.filter(
    (s) =>
      s.action.operation === 'agent.decision' ||
      (s.action.actor === 'llm' && !decisions.some((d) => s.path.startsWith(d.path + '/'))),
  );
  const parentPath = (path: string) => path.slice(0, path.lastIndexOf('/'));
  return (
    samples
      .map((s) => {
        const nextDecision = decisions.find(
          (d) => d.sequence.start > s.sequence.start && parentPath(d.path) === parentPath(s.path),
        );
        const toolSteps = steps.filter(
          (t) =>
            t.action.actor === 'tool' &&
            parentPath(t.path) === parentPath(s.path) &&
            t.sequence.start > (s.sequence.end ?? s.sequence.start) &&
            (!nextDecision || t.sequence.start < nextDecision.sequence.start),
        );
        const models =
          s.action.actor === 'llm'
            ? [s]
            : steps.filter((t) => t.action.actor === 'llm' && t.path.startsWith(s.path + '/'));
        const model = models.at(-1);
        const response = model?.observation as
          | { text?: string; token_ids?: number[]; logprobs?: number[] }
          | undefined;
        return JSON.stringify({
          ...s,
          group_id: options.group_id,
          sample_id: contentHash({
            trajectory_id: s.trajectory_id,
            path: s.path,
            attempt: s.attempt,
          }),
          training_ready:
            s.reward !== null &&
            s.release_artifact_hash !== null &&
            typeof response?.text === 'string',
          reward_source: s.reward === null ? 'unlabelled' : 'explicit',
          model_calls: models.map((m) => ({
            path: m.path,
            request: m.action.input,
            response: m.observation,
          })),
          token_ids: response?.token_ids ?? null,
          logprobs: response?.logprobs ?? null,
          tool_input: toolSteps.map((t) => t.tool_input),
          tool_output: toolSteps.map((t) => t.tool_output),
          tools: toolSteps.map((t) => ({
            path: t.path,
            tool_input: t.tool_input,
            tool_output: t.tool_output,
            status: t.status,
          })),
        });
      })
      .join('\n') + (samples.length ? '\n' : '')
  );
}
