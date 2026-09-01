import type { Job, JobKind } from './contracts';
import type { Ledger } from './database';
import type { PostgresTraceLedger } from './postgres-ledger';

/** Stable boundary for durable job delivery. Implementations must preserve tenant/idempotency fencing. */
export interface JobStore {
  enqueue(
    tenant: string,
    actor: string,
    kind: JobKind,
    idempotencyKey: string,
    args: unknown,
    session?: string,
  ): Job;
  claim(owner: string, leaseMs: number, limit?: number): Job | undefined;
  heartbeat(job: Job): void;
  finish(job: Job, state: 'completed' | 'failed' | 'blocked' | 'interrupted', result: unknown): void;
  cancel(tenant: string, id: string, actor: string): Job;
  job(tenant: string, id: string): Job | undefined;
  recover(): void;
}

/** Network-backed variant. Implementations must be idempotent and lease-fenced. */
export interface AsyncJobStore {
  enqueue(
    job: {
      id: string;
      tenant: string;
      actor: string;
      kind: JobKind;
      args: unknown;
      created: number;
      session?: string;
      deadline?: number;
    },
    idempotencyKey: string,
  ): Promise<{ id: string; duplicate: boolean }>;
  claim(
    owner: string,
    leaseMs: number,
  ): Promise<
    | {
        id: string;
        tenant: string;
        actor: string;
        kind: JobKind;
        args: unknown;
        created: number;
        session?: string;
        deadline?: number;
        owner: string;
        leaseUntil: number;
      }
    | undefined
  >;
  heartbeat(id: string, owner: string, leaseMs: number): Promise<boolean>;
  finish(
    id: string,
    owner: string,
    state: 'completed' | 'failed' | 'blocked' | 'cancelled',
    result?: unknown,
  ): Promise<boolean>;
  recoverExpired?(): Promise<number>;
}

/** PostgreSQL is the source of truth; Redis only delivers wake-up notifications. */
export class PostgresJobStore implements AsyncJobStore {
  constructor(private readonly ledger: PostgresTraceLedger) {}
  async create(
    tenant: string,
    actor: string,
    kind: JobKind,
    idempotencyKey: string,
    args: unknown,
    session?: string,
  ) {
    return this.ledger.enqueue(tenant, actor, kind, idempotencyKey, args, session);
  }
  async queued(limit = 1000) {
    const result = await this.ledger.pool.query<{ tenant: string; id: string }>(
      "SELECT tenant,id FROM jobs WHERE state='queued' ORDER BY created LIMIT $1",
      [limit],
    );
    const jobs = await Promise.all(result.rows.map((row) => this.ledger.job(row.tenant, row.id)));
    return jobs.filter((job): job is Job => Boolean(job));
  }
  async enqueue(job: any, idempotencyKey: string) {
    const created = await this.ledger.enqueue(
      job.tenant,
      job.actor,
      job.kind,
      idempotencyKey,
      job.args,
      job.session,
    );
    // The ledger resolves idempotency inside its transaction and may return a
    // previously persisted job with a different id than this delivery envelope.
    return { id: created.id, duplicate: created.id !== job.id };
  }
  async claim(owner: string, leaseMs: number) {
    const job = await this.ledger.claim(owner, leaseMs);
    if (!job) return undefined;
    return {
      id: job.id,
      tenant: job.tenant,
      actor: job.actor,
      kind: job.kind,
      args: job.args,
      created: job.created,
      session: job.session,
      deadline: job.deadline ?? undefined,
      owner,
      leaseUntil: job.lease_until ?? Date.now() + leaseMs,
    };
  }
  async heartbeat(id: string, owner: string, leaseMs: number) {
    const row = await this.find(id);
    if (!row || row.owner !== owner) return false;
    await this.ledger.heartbeat(row);
    return true;
  }
  async finish(
    id: string,
    owner: string,
    state: 'completed' | 'failed' | 'blocked' | 'cancelled',
    result?: unknown,
  ) {
    const row = await this.find(id);
    if (!row || row.owner !== owner) return false;
    await this.ledger.finish(row, state, result);
    return true;
  }
  async job(tenant: string, id: string) {
    return this.ledger.job(tenant, id);
  }
  async cancel(tenant: string, id: string, actor: string) {
    return this.ledger.cancel(tenant, id, actor);
  }
  async claimById(tenant: string, id: string, owner: string, timeoutMs: number) {
    return this.ledger.claimById(tenant, id, owner, timeoutMs);
  }
  private async find(id: string) {
    const rows = await this.ledger.pool.query<any>('SELECT tenant FROM jobs WHERE id=$1', [id]);
    const tenant = rows.rows[0]?.tenant;
    return tenant ? await this.ledger.job(tenant, id) : undefined;
  }
}

/** Compatibility adapter while the async Redis implementation is rolled out. */
export class SqliteJobStore implements JobStore {
  constructor(private readonly ledger: Ledger) {}
  enqueue(...args: Parameters<Ledger['enqueue']>) {
    return this.ledger.enqueue(...args);
  }
  claim(...args: Parameters<Ledger['claim']>) {
    return this.ledger.claim(...args);
  }
  heartbeat(...args: Parameters<Ledger['heartbeat']>) {
    return this.ledger.heartbeat(...args);
  }
  finish(...args: Parameters<Ledger['finish']>) {
    return this.ledger.finish(...args);
  }
  cancel(...args: Parameters<Ledger['cancel']>) {
    return this.ledger.cancel(...args);
  }
  job(...args: Parameters<Ledger['job']>) {
    return this.ledger.job(...args);
  }
  recover(...args: Parameters<Ledger['recover']>) {
    return this.ledger.recover(...args);
  }
}

/** Promise-shaped compatibility adapter used while callers are migrated to async APIs. */
export class AsyncSqliteJobStore implements AsyncJobStore {
  constructor(private readonly ledger: Ledger) {}
  async enqueue(
    job: {
      id: string;
      tenant: string;
      actor: string;
      kind: JobKind;
      args: unknown;
      created: number;
      deadline?: number;
    },
    idempotencyKey: string,
  ) {
    const result = this.ledger.enqueue(job.tenant, job.actor, job.kind, idempotencyKey, job.args);
    return { id: result.id, duplicate: result.created !== job.created };
  }
  async claim(owner: string, leaseMs: number) {
    const result = this.ledger.claim(owner, leaseMs, 1);
    if (!result) return undefined;
    return {
      id: result.id,
      tenant: result.tenant,
      actor: result.actor,
      kind: result.kind,
      args: result.args,
      created: result.created,
      ...(result.deadline ? { deadline: result.deadline } : {}),
      owner,
      leaseUntil: result.lease_until ?? Date.now() + leaseMs,
    };
  }
  async heartbeat(id: string, owner: string, leaseMs: number) {
    const row = this.ledger.sql.prepare('SELECT tenant FROM jobs WHERE id=?').get(id) as
      | { tenant?: string }
      | undefined;
    const job = row?.tenant ? this.ledger.job(row.tenant, id) : undefined;
    if (!job || job.owner !== owner) return false;
    this.ledger.heartbeat(job);
    return true;
  }
  async finish(
    id: string,
    owner: string,
    state: 'completed' | 'failed' | 'blocked' | 'cancelled',
    result?: unknown,
  ) {
    const row = this.ledger.sql.prepare('SELECT tenant FROM jobs WHERE id=?').get(id) as
      | { tenant?: string }
      | undefined;
    const job = row?.tenant ? this.ledger.job(row.tenant, id) : undefined;
    if (!job || job.owner !== owner) return false;
    this.ledger.finish(job, state === 'cancelled' ? 'interrupted' : state, result ?? null);
    return true;
  }
}
