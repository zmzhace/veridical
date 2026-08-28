import { createHash, randomUUID } from 'node:crypto';
import type {
  TraceEvent,
  InvocationActor,
  InvocationStatus,
  InvocationRecord,
} from '@veridical/schema';
import type { TraceStore } from '@veridical/store';
import { Recorder, type RecordInput } from './recorder';
import { Session } from './session';

export type { InvocationActor, InvocationStatus, InvocationRecord } from '@veridical/schema';

/** Canonical JSON is shared by recording, replay and dataset identities. */
export function canonicalJson(value: unknown): string {
  const visit = (v: unknown): unknown => {
    if (v === undefined) return null;
    if (v instanceof Error)
      return {
        name: v.name,
        message: v.message,
        code: (v as Error & { code?: string }).code ?? 'error',
      };
    if (Array.isArray(v)) return v.map(visit);
    if (v !== null && typeof v === 'object')
      return Object.fromEntries(
        Object.keys(v)
          .sort()
          .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
          .map((k) => [k, visit((v as Record<string, unknown>)[k])]),
      );
    return v;
  };
  return JSON.stringify(visit(value));
}
export function contentHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export interface RedactionPolicy {
  keys?: string[];
  values?: string[];
}
export function redact(value: unknown, policy: RedactionPolicy = {}): unknown {
  const secretKey =
    /^(authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|password|secret|credentials)$/i;
  const marker = (v: unknown) => ({
    redacted: true,
    hash: contentHash(v),
    policy: 'invocation-v1',
  });
  const visit = (v: unknown): unknown => {
    if (typeof v === 'string') {
      // Redact the whole string: never retain a credential in an error or a prompt.
      if (
        policy.values?.some((s) => s.length > 0 && v.includes(s)) ||
        /\b(?:sk-[A-Za-z0-9_.-]{12,}|Bearer\s+[A-Za-z0-9_.-]{12,})/.test(v)
      )
        return marker(v);
      return v;
    }
    if (Array.isArray(v)) return v.map(visit);
    if (v && typeof v === 'object')
      return Object.fromEntries(
        Object.entries(v).map(([k, x]) => [
          k,
          secretKey.test(k) || policy.keys?.includes(k) ? marker(x) : visit(x),
        ]),
      );
    return v;
  };
  return visit(JSON.parse(canonicalJson(value)));
}
export function hasRedaction(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  if ((value as { redacted?: unknown }).redacted === true) return true;
  return Object.values(value).some(hasRedaction);
}

export type InvocationInterceptor = <T>(
  scope: InvocationRecorder,
  input: unknown,
  execute: () => Promise<T>,
) => Promise<T>;
interface Shared {
  counters: Map<string, number>;
  interceptor?: InvocationInterceptor;
  redaction: RedactionPolicy;
}
export interface InvocationOptions {
  path?: string;
  attempt?: number;
  ordinal?: number;
  agent?: string;
  loop?: string;
  specVersion?: string;
}

/** A scope is explicit, so concurrent children never share an implicit current span. */
export class InvocationRecorder extends Recorder {
  readonly invocation: InvocationRecord;
  private ended = false;
  private eventOrdinal = 0;
  private startedAt = Date.now();
  recordedDurationMs?: number;
  constructor(
    store: TraceStore,
    session: Session,
    invocation: InvocationRecord,
    private shared: Shared,
  ) {
    super(store, session);
    this.invocation = invocation;
  }
  static root(
    store: TraceStore,
    session: Session,
    input: unknown,
    options: {
      runId?: string;
      path?: string;
      agent?: string;
      interceptor?: InvocationInterceptor;
      redaction?: RedactionPolicy;
    } = {},
  ): InvocationRecorder {
    return new InvocationRecorder(
      store,
      session,
      {
        run_id: options.runId ?? randomUUID(),
        invocation_id: randomUUID(),
        path: options.path ?? 'root',
        ordinal: 1,
        attempt: 1,
        actor: 'agent',
        agent: options.agent,
        operation: 'agent.run',
        input: JSON.parse(canonicalJson(input)),
        status: 'started',
        fingerprint: contentHash(input),
      },
      { counters: new Map(), interceptor: options.interceptor, redaction: options.redaction ?? {} },
    );
  }
  child(
    actor: InvocationActor,
    operation: string,
    segment: string,
    input: unknown,
    options: InvocationOptions = {},
  ): InvocationRecorder {
    const key = `${this.invocation.path}/${segment}`;
    const ordinal = options.ordinal ?? (this.shared.counters.get(key) ?? 0) + 1;
    this.shared.counters.set(key, Math.max(ordinal, this.shared.counters.get(key) ?? 0));
    const path =
      options.path ?? (operation === 'agent.dispatch' && ordinal === 1 ? key : `${key}#${ordinal}`);
    const session = options.specVersion
      ? new Session({
          session_id: this.session.session_id,
          tenant_id: this.session.tenant_id,
          spec_version: options.specVersion,
        })
      : this.session;
    return new InvocationRecorder(
      this.store,
      session,
      {
        run_id: this.invocation.run_id,
        invocation_id: randomUUID(),
        parent_invocation_id: this.invocation.invocation_id,
        path,
        ordinal,
        attempt: options.attempt ?? 1,
        actor,
        agent: options.agent ?? this.invocation.agent,
        loop: options.loop ?? this.invocation.loop,
        operation,
        input: JSON.parse(canonicalJson(input)),
        status: 'started',
        fingerprint: contentHash(input),
      },
      this.shared,
    );
  }
  override async record(input: RecordInput): Promise<TraceEvent> {
    const i = this.invocation;
    this.eventOrdinal += 1;
    return super.record({
      ...input,
      payload: redact(input.payload, this.shared.redaction),
      run_id: i.run_id,
      invocation_id: i.invocation_id,
      parent_invocation_id: i.parent_invocation_id,
      path: i.path,
      ordinal: i.ordinal,
      attempt: i.attempt,
      path_source: 'explicit',
      replay_key: `${i.path}@${i.attempt}:${input.type}:${this.eventOrdinal}`,
    });
  }
  async start(): Promise<void> {
    await this.event('invocation.start', 'request', this.invocation);
  }
  /** Offline playback only. Rebind recorded child IDs to this run, retaining paths and chunk order. */
  async restoreEvents(events: TraceEvent[], sourceInvocationId: string): Promise<void> {
    const scopes = new Map<string, InvocationRecorder>([[sourceInvocationId, this]]);
    const ids = new Map<string, string>([[sourceInvocationId, this.invocation.invocation_id]]);
    for (const event of events)
      if (event.type === 'invocation.start' && event.invocation_id)
        ids.set(event.invocation_id, randomUUID());
    for (const event of events) {
      if (!event.invocation_id) throw new Error('cannot restore legacy event');
      if (event.type === 'invocation.start') {
        const original = event.payload as InvocationRecord;
        const session = new Session({
          tenant_id: this.session.tenant_id,
          session_id: this.session.session_id,
          spec_version: event.spec_version,
        });
        scopes.set(
          event.invocation_id,
          new InvocationRecorder(
            this.store,
            session,
            {
              ...original,
              run_id: this.invocation.run_id,
              invocation_id: ids.get(event.invocation_id)!,
              parent_invocation_id: original.parent_invocation_id
                ? ids.get(original.parent_invocation_id)
                : undefined,
            },
            this.shared,
          ),
        );
      }
      const scope = scopes.get(event.invocation_id);
      if (!scope) throw new Error('recorded subtree has an unknown parent');
      let payload = event.payload;
      if (event.type.startsWith('invocation.'))
        payload = {
          ...(payload as InvocationRecord),
          run_id: scope.invocation.run_id,
          invocation_id: scope.invocation.invocation_id,
          parent_invocation_id: scope.invocation.parent_invocation_id,
        };
      const {
        id: _id,
        seq: _seq,
        session_id: _session,
        tenant_id: _tenant,
        spec_version: _version,
        ...input
      } = event;
      await scope.record({ ...input, payload });
    }
  }
  async end(
    output: unknown,
    status: InvocationStatus = 'success',
    error?: InvocationRecord['error'],
  ): Promise<void> {
    if (this.ended) throw new Error(`invocation already completed: ${this.invocation.path}`);
    this.ended = true;
    await this.record({
      span_id: this.invocation.path,
      parent_span_id: this.invocation.parent_invocation_id ?? null,
      type: 'invocation.end',
      verb: status === 'success' ? 'response' : 'error',
      attempt: this.invocation.attempt,
      duration_ms: this.recordedDurationMs ?? Date.now() - this.startedAt,
      payload: {
        ...this.invocation,
        output: output ?? null,
        status,
        ...(error ? { error } : {}),
        ...(this.invocation.actor === 'tool'
          ? {
              side_effect_state:
                status === 'success'
                  ? 'completed'
                  : error?.code === 'tool_denied' ||
                      ['denied', 'not_found'].includes(
                        (output as { reason?: string } | null)?.reason ?? '',
                      )
                    ? 'not_started'
                    : 'unknown',
            }
          : {}),
      },
    });
  }
  async event(type: string, verb: TraceEvent['verb'], payload: unknown): Promise<void> {
    await this.record({
      span_id: this.invocation.path,
      parent_span_id: this.invocation.parent_invocation_id ?? null,
      type,
      verb,
      attempt: this.invocation.attempt,
      duration_ms: 0,
      payload,
    });
  }
  async invoke<T>(
    actor: InvocationActor,
    operation: string,
    segment: string,
    input: unknown,
    execute: (scope: InvocationRecorder) => Promise<T>,
    options: InvocationOptions = {},
  ): Promise<T> {
    const scope = this.child(actor, operation, segment, input, options);
    await scope.start();
    try {
      const run = () => execute(scope);
      const result = this.shared.interceptor
        ? await this.shared.interceptor(scope, input, run)
        : await run();
      const blocked =
        actor === 'tool' &&
        result &&
        typeof result === 'object' &&
        (result as { ok?: boolean }).ok === false;
      await scope.end(
        result,
        blocked
          ? (result as { reason?: string }).reason === 'error'
            ? 'failed'
            : 'blocked'
          : 'success',
      );
      return result;
    } catch (error) {
      const e = error as { code?: string; name?: string; message?: string };
      await scope.end(
        null,
        e?.name === 'AbortError' || e?.code === 'cancelled'
          ? 'cancelled'
          : e?.code === 'tool_denied'
            ? 'blocked'
            : 'failed',
        {
          code: typeof e?.code === 'string' ? e.code : (e?.name ?? 'error'),
          message: e?.message ?? String(error),
        },
      );
      throw error;
    }
  }
  async retry<T>(
    actor: InvocationActor,
    operation: string,
    segment: string,
    input: unknown,
    execute: (scope: InvocationRecorder) => Promise<T>,
    options: {
      maxAttempts: number;
      shouldRetry: (error: unknown) => boolean;
      signal?: AbortSignal;
    },
  ): Promise<T> {
    if (!Number.isInteger(options.maxAttempts) || options.maxAttempts < 1)
      throw new Error('invalid retry limit');
    const identity = this.child(actor, operation, segment, input).invocation;
    for (let attempt = 1; ; attempt++) {
      options.signal?.throwIfAborted();
      try {
        return await this.invoke(actor, operation, segment, input, execute, {
          path: identity.path,
          ordinal: identity.ordinal,
          attempt,
        });
      } catch (error) {
        if (
          attempt >= options.maxAttempts ||
          options.signal?.aborted ||
          !options.shouldRetry(error)
        )
          throw error;
      }
    }
  }
}

/** Stop awaiting uncooperative adapters; does not claim to undo their external side effects. */
export function withAbort<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) {
    void work.catch(() => {});
    return Promise.reject(signal.reason ?? new DOMException('cancelled', 'AbortError'));
  }
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new DOMException('cancelled', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
