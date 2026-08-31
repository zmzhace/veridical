import Database from 'better-sqlite3';
import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, chmodSync, statSync, statfsSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseEvent, type TraceEvent } from '@veridical/schema';
import type { TraceStore, NewTraceEvent } from '@veridical/store';
import { canonical, digest, Fault, type Artifact, type Job, type JobKind } from './contracts';

export interface Fence {
  id: string;
  owner: string;
}
/** Minimal durable trace boundary shared by SQLite and future PostgreSQL ledgers. */
export interface TraceLedger {
  append(
    tenant: string,
    session: string,
    input: NewTraceEvent,
    fence?: Fence,
  ): TraceEvent | Promise<TraceEvent>;
  read(
    tenant: string,
    session: string,
    after?: number,
    limit?: number,
  ): TraceEvent[] | Promise<TraceEvent[]>;
}
/** Artifact boundary used by release/governance code. Implementations must preserve immutability. */
export interface ArtifactLedger {
  put(
    tenant: string,
    kind: string,
    key: string,
    body: unknown,
    actor: string,
    status?: string,
    meta?: unknown,
  ): Artifact;
  get<T = any>(tenant: string, kind: string, key: string): Artifact<T> | undefined;
  transition(
    tenant: string,
    kind: string,
    key: string,
    status: string,
    meta: unknown,
    actor: string,
  ): Artifact;
  list(tenant: string, kind: string, limit?: number, offset?: number): Artifact[];
  pointer(tenant: string, kind: string, name: string): string | undefined;
  point(
    tenant: string,
    kind: string,
    name: string,
    ref: string,
    actor: string,
    reason: string,
  ): void;
}
/** Async persistence contract used by managed production backends. */
export interface LedgerPort extends TraceLedger, ArtifactLedger {
  createSession(tenant: string, id: string, kind?: string, ref?: string): Promise<void>;
  verify(
    tenant: string,
    session: string,
    checkpoint?: Fence & { seq: number; head: string; signature: string },
  ): Promise<unknown>;
  enqueue(...args: any[]): Promise<Job>;
  job(tenant: string, id: string): Promise<Job | undefined>;
  claim(owner: string, timeoutMs: number): Promise<Job | undefined>;
  heartbeat(job: Job): Promise<void>;
  assertFence(tenant: string, fence: Fence): Promise<void>;
  finish(job: Job, state: string, result: unknown): Promise<void>;
  cancel(tenant: string, id: string, actor: string): Promise<Job>;
  capacity(): Promise<{ database_bytes: number; free_disk_bytes: number }>;
  close(): Promise<void>;
}
export class Ledger {
  readonly sql: Database.Database;
  constructor(
    private path: string,
    private dataKey: Buffer,
    private auditKey: Buffer,
  ) {
    if (dataKey.length !== 32 || auditKey.length !== 32 || dataKey.equals(auditKey))
      throw new Error('distinct 32-byte data and audit keys required');
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.sql = new Database(path, { timeout: 3000 });
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.sql.pragma('journal_mode = WAL');
    this.sql.pragma('synchronous = FULL');
    this.sql.pragma('foreign_keys = ON');
    const version = this.sql.pragma('user_version', { simple: true }) as number;
    if (version > 1) {
      this.sql.close();
      throw new Error('database is newer than this server');
    }
    try {
      this.sql
        .transaction(() => {
          this.sql.exec(`
        CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS sessions (tenant TEXT NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL,
          ref TEXT NOT NULL, created TEXT NOT NULL, seq INTEGER NOT NULL DEFAULT 0, head TEXT NOT NULL DEFAULT '', PRIMARY KEY(tenant,id));
        CREATE TABLE IF NOT EXISTS events (tenant TEXT NOT NULL, session TEXT NOT NULL, seq INTEGER NOT NULL,
          id TEXT NOT NULL, blob TEXT NOT NULL, prev TEXT NOT NULL, hash TEXT NOT NULL,
          PRIMARY KEY(tenant,session,seq), UNIQUE(tenant,session,id),
          FOREIGN KEY(tenant,session) REFERENCES sessions(tenant,id));
        CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT,'immutable events'); END;
        CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT,'immutable events'); END;
        CREATE TABLE IF NOT EXISTS artifacts (tenant TEXT NOT NULL, kind TEXT NOT NULL, key TEXT NOT NULL,
          author TEXT NOT NULL, status TEXT NOT NULL, digest TEXT NOT NULL, blob TEXT NOT NULL,
          meta TEXT NOT NULL, seal TEXT NOT NULL, created TEXT NOT NULL, PRIMARY KEY(tenant,kind,key));
        CREATE TRIGGER IF NOT EXISTS artifact_body_immutable BEFORE UPDATE OF tenant,kind,key,author,digest,blob,created ON artifacts
          BEGIN SELECT RAISE(ABORT,'immutable artifact'); END;
        CREATE TABLE IF NOT EXISTS pointers (tenant TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL,
          ref TEXT NOT NULL, seal TEXT NOT NULL, PRIMARY KEY(tenant,kind,name));
        CREATE TABLE IF NOT EXISTS jobs (tenant TEXT NOT NULL, id TEXT NOT NULL, actor TEXT NOT NULL, session TEXT NOT NULL,
          kind TEXT NOT NULL, idem TEXT NOT NULL, request_hash TEXT NOT NULL, blob TEXT NOT NULL,
          state TEXT NOT NULL, owner TEXT, deadline INTEGER, lease_until INTEGER, result TEXT,
          created INTEGER NOT NULL, PRIMARY KEY(tenant,id), UNIQUE(tenant,idem));
        CREATE UNIQUE INDEX IF NOT EXISTS one_active_session ON jobs(tenant,session) WHERE state IN ('queued','running');
        CREATE INDEX IF NOT EXISTS queued_jobs ON jobs(state,created);
        CREATE TABLE IF NOT EXISTS revoked_tokens (hash TEXT PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS rate_limits (key TEXT PRIMARY KEY, window INTEGER NOT NULL, count INTEGER NOT NULL);
      `);
          const marker = this.sql
            .prepare('SELECT value FROM settings WHERE key=?')
            .get('key-check') as any;
          if (marker) {
            if (this.decrypt(marker.value, 'key-check') !== this.mac('key-check'))
              throw new Error('incorrect ledger keys');
          } else
            this.sql
              .prepare('INSERT INTO settings VALUES (?,?)')
              .run('key-check', this.encrypt(this.mac('key-check'), 'key-check'));
          this.sql.pragma('user_version = 1');
        })
        .immediate();
    } catch (error) {
      this.sql.close();
      throw error;
    }
  }
  close() {
    this.sql.close();
  }
  capacity() {
    if (this.path === ':memory:')
      return { database_bytes: 0, free_disk_bytes: Number.MAX_SAFE_INTEGER };
    const fs = statfsSync(dirname(this.path));
    return {
      database_bytes: [this.path, `${this.path}-wal`].reduce(
        (n, p) => n + (existsSync(p) ? statSync(p).size : 0),
        0,
      ),
      free_disk_bytes: fs.bavail * fs.bsize,
    };
  }
  tx<T>(fn: () => T): T {
    return this.sql.transaction(fn).immediate();
  }
  transaction<T>(fn: () => T): T {
    return this.tx(fn);
  }
  /** Domain-level atomic boundary used by administration and compatibility paths. */
  atomic<T>(fn: () => T): T {
    return this.tx(fn);
  }
  mac(value: string) {
    return createHmac('sha256', this.auditKey).update(value).digest('hex');
  }
  encrypt(value: unknown, aad: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.dataKey, iv);
    cipher.setAAD(Buffer.from(aad));
    const bytes = Buffer.concat([cipher.update(canonical(value)), cipher.final()]);
    return [iv, cipher.getAuthTag(), bytes].map((b) => b.toString('base64')).join('.');
  }
  decrypt(blob: string, aad: string): any {
    const [iv, tag, data] = blob.split('.').map((v) => Buffer.from(v, 'base64'));
    const cipher = createDecipheriv('aes-256-gcm', this.dataKey, iv);
    cipher.setAAD(Buffer.from(aad));
    cipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([cipher.update(data), cipher.final()]).toString('utf8'));
  }
  session(tenant: string, id: string): any {
    return this.sql.prepare('SELECT * FROM sessions WHERE tenant=? AND id=?').get(tenant, id);
  }
  createSession(tenant: string, id: string, kind: string, ref: string) {
    this.sql
      .prepare('INSERT INTO sessions(tenant,id,kind,ref,created) VALUES (?,?,?,?,?)')
      .run(tenant, id, kind, ref, new Date().toISOString());
  }
  listSessions(tenant: string, limit = 50, offset = 0): any[] {
    return this.sql
      .prepare(
        "SELECT id,kind,ref,created,seq,head FROM sessions WHERE tenant=? AND kind='run' ORDER BY created DESC LIMIT ? OFFSET ?",
      )
      .all(tenant, limit, offset);
  }
  assertFence(tenant: string, fence: Fence) {
    const job = this.sql
      .prepare('SELECT state,owner,deadline,lease_until FROM jobs WHERE tenant=? AND id=?')
      .get(tenant, fence.id) as any;
    if (
      !job ||
      job.state !== 'running' ||
      job.owner !== fence.owner ||
      job.deadline <= Date.now() ||
      job.lease_until <= Date.now()
    )
      throw new Fault(409, 'execution_fenced');
  }
  append(tenant: string, session: string, input: NewTraceEvent, fence?: Fence): TraceEvent {
    return this.tx(() => {
      if (input.tenant_id !== tenant || input.session_id !== session)
        throw new Fault(403, 'tenant_mismatch');
      if (fence) this.assertFence(tenant, fence);
      const row = this.session(tenant, session);
      if (!row) throw new Fault(404, 'session_not_found');
      if (row.kind !== 'audit' && row.seq >= 20000) throw new Fault(429, 'session_limit');
      const seq = row.seq + 1;
      const event = parseEvent({
        ...input,
        id: `evt_${randomUUID()}`,
        seq,
        timestamp: new Date().toISOString(),
        event_schema_version: 1,
      });
      const blob = this.encrypt(event, canonical([tenant, session, seq]));
      const hash = this.mac(canonical([tenant, session, seq, event.id, row.head, blob]));
      this.sql
        .prepare('INSERT INTO events VALUES (?,?,?,?,?,?,?)')
        .run(tenant, session, seq, event.id, blob, row.head, hash);
      this.sql
        .prepare('UPDATE sessions SET seq=?,head=? WHERE tenant=? AND id=?')
        .run(seq, hash, tenant, session);
      return event;
    });
  }
  read(tenant: string, session: string, after = 0, limit = 20000): TraceEvent[] {
    return this.tx(() => {
      const snapshot = this.session(tenant, session);
      const rows = this.sql
        .prepare('SELECT * FROM events WHERE tenant=? AND session=? AND seq>? ORDER BY seq LIMIT ?')
        .all(tenant, session, after, limit) as any[];
      const predecessor =
        after > 0
          ? (this.sql
              .prepare('SELECT hash FROM events WHERE tenant=? AND session=? AND seq=?')
              .get(tenant, session, after) as any)
          : undefined;
      let head = after > 0 ? predecessor?.hash : '';
      let seq = after;
      const events = rows.map((r: any) => {
        if (r.seq !== ++seq || r.prev !== head) throw new Error('broken audit chain');
        if (this.mac(canonical([tenant, session, r.seq, r.id, r.prev, r.blob])) !== r.hash)
          throw new Error('ledger authentication failed');
        const event = parseEvent(this.decrypt(r.blob, canonical([tenant, session, r.seq])));
        if (
          event.seq !== r.seq ||
          event.id !== r.id ||
          event.session_id !== session ||
          event.tenant_id !== tenant
        )
          throw new Error('ledger identity mismatch');
        head = r.hash;
        return event;
      });
      if (
        snapshot &&
        after < snapshot.seq &&
        rows.length < limit &&
        (seq !== snapshot.seq || head !== snapshot.head)
      )
        throw new Error('truncated audit chain');
      if (snapshot && rows.length && seq === snapshot.seq && head !== snapshot.head)
        throw new Error('broken audit head');
      return events;
    });
  }
  verify(
    tenant: string,
    session: string,
    checkpoint?: { seq: number; head: string; signature: string },
  ) {
    return this.tx(() => {
      const row = this.session(tenant, session);
      if (!row) throw new Fault(404, 'session_not_found');
      const events = this.sql
        .prepare('SELECT * FROM events WHERE tenant=? AND session=? ORDER BY seq')
        .all(tenant, session) as any[];
      let head = '';
      let seq = 0;
      for (const e of events) {
        if (
          e.seq !== ++seq ||
          e.prev !== head ||
          this.mac(canonical([tenant, session, e.seq, e.id, e.prev, e.blob])) !== e.hash
        )
          throw new Error('broken audit chain');
        this.decrypt(e.blob, canonical([tenant, session, e.seq]));
        head = e.hash;
      }
      if (row.seq !== seq || row.head !== head) throw new Error('truncated audit chain');
      if (
        checkpoint &&
        (checkpoint.signature !==
          this.mac(canonical([tenant, session, checkpoint.seq, checkpoint.head])) ||
          checkpoint.seq > seq ||
          (checkpoint.seq > 0 ? events[checkpoint.seq - 1]?.hash : '') !== checkpoint.head)
      )
        throw new Error('external checkpoint mismatch');
      return { seq, head, signature: this.mac(canonical([tenant, session, seq, head])) };
    });
  }
  audit(tenant: string, actor: string, action: string, payload: unknown) {
    return this.tx(() => {
      if (!this.session(tenant, '_audit'))
        this.createSession(tenant, '_audit', 'audit', 'platform');
      return this.append(tenant, '_audit', {
        tenant_id: tenant,
        session_id: '_audit',
        actor_id: actor,
        span_id: 'governance',
        parent_span_id: null,
        type: action,
        verb: 'response',
        attempt: 1,
        duration_ms: 0,
        spec_version: 'platform-1',
        payload,
      });
    });
  }
  put(
    tenant: string,
    kind: string,
    key: string,
    body: unknown,
    actor: string,
    status = 'draft',
    meta: unknown = {},
  ): Artifact {
    return this.tx(() => {
      if (this.get(tenant, kind, key)) throw new Fault(409, 'artifact_exists');
      const hash = digest(body);
      const created = new Date().toISOString();
      const blob = this.encrypt(body, canonical([tenant, kind, key]));
      const metadata = this.encrypt(meta, canonical([tenant, kind, key, 'meta']));
      const seal = this.mac(
        canonical([tenant, kind, key, actor, status, hash, blob, metadata, created]),
      );
      this.sql
        .prepare('INSERT INTO artifacts VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(tenant, kind, key, actor, status, hash, blob, metadata, seal, created);
      this.audit(tenant, actor, `${kind}.created`, { key, digest: hash });
      return this.get(tenant, kind, key)!;
    });
  }
  get<T = any>(tenant: string, kind: string, key: string): Artifact<T> | undefined {
    const r = this.sql
      .prepare('SELECT * FROM artifacts WHERE tenant=? AND kind=? AND key=?')
      .get(tenant, kind, key) as any;
    if (!r) return undefined;
    if (
      r.seal !==
      this.mac(
        canonical([tenant, kind, key, r.author, r.status, r.digest, r.blob, r.meta, r.created]),
      )
    )
      throw new Error('artifact authentication failed');
    const body = this.decrypt(r.blob, canonical([tenant, kind, key]));
    if (digest(body) !== r.digest) throw new Error('artifact digest mismatch');
    return {
      key,
      body,
      digest: r.digest,
      author: r.author,
      status: r.status,
      meta: this.decrypt(r.meta, canonical([tenant, kind, key, 'meta'])),
      created: r.created,
    };
  }
  transition(
    tenant: string,
    kind: string,
    key: string,
    status: string,
    meta: unknown,
    actor: string,
  ) {
    return this.tx(() => {
      const before = this.get(tenant, kind, key);
      if (!before) throw new Fault(404, 'artifact_not_found');
      const r = this.sql
        .prepare('SELECT * FROM artifacts WHERE tenant=? AND kind=? AND key=?')
        .get(tenant, kind, key) as any;
      const metadata = this.encrypt(meta, canonical([tenant, kind, key, 'meta']));
      const seal = this.mac(
        canonical([tenant, kind, key, r.author, status, r.digest, r.blob, metadata, r.created]),
      );
      this.sql
        .prepare('UPDATE artifacts SET status=?,meta=?,seal=? WHERE tenant=? AND kind=? AND key=?')
        .run(status, metadata, seal, tenant, kind, key);
      this.audit(tenant, actor, `${kind}.${status}`, { key, digest: before.digest, meta });
      return this.get(tenant, kind, key)!;
    });
  }
  list(tenant: string, kind: string, limit = 50, offset = 0): Artifact[] {
    return this.sql
      .prepare(
        'SELECT key FROM artifacts WHERE tenant=? AND kind=? ORDER BY created DESC LIMIT ? OFFSET ?',
      )
      .all(tenant, kind, limit, offset)
      .map((r: any) => this.get(tenant, kind, r.key)!);
  }
  pointer(tenant: string, kind: string, name: string): string | undefined {
    const r = this.sql
      .prepare('SELECT ref,seal FROM pointers WHERE tenant=? AND kind=? AND name=?')
      .get(tenant, kind, name) as any;
    if (!r) return undefined;
    if (r.seal !== this.mac(canonical([tenant, kind, name, r.ref])))
      throw new Error('pointer authentication failed');
    return r.ref;
  }
  point(tenant: string, kind: string, name: string, ref: string, actor: string, reason: string) {
    this.tx(() => {
      const previous = this.pointer(tenant, kind, name);
      this.sql
        .prepare(
          'INSERT INTO pointers VALUES (?,?,?,?,?) ON CONFLICT(tenant,kind,name) DO UPDATE SET ref=excluded.ref,seal=excluded.seal',
        )
        .run(tenant, kind, name, ref, this.mac(canonical([tenant, kind, name, ref])));
      this.audit(tenant, actor, `${kind}.changed`, { name, previous, ref, reason });
    });
  }
  enqueue(
    tenant: string,
    actor: string,
    kind: JobKind,
    idem: string,
    args: any,
    session?: string,
  ): Job {
    return this.tx(() => {
      const hash = digest({ kind, args, session });
      const prior = this.existing(tenant, kind, idem, args, session);
      if (prior) return prior;
      const count = this.sql
        .prepare("SELECT COUNT(*) n FROM jobs WHERE tenant=? AND state IN ('queued','running')")
        .get(tenant) as any;
      if (count.n >= 20) throw new Fault(429, 'queue_full');
      if (
        session &&
        this.sql
          .prepare(
            "SELECT id FROM jobs WHERE tenant=? AND session=? AND state IN ('queued','running')",
          )
          .get(tenant, session)
      )
        throw new Fault(409, 'session_busy');
      const id = randomUUID();
      const sid = session ?? `run_${id}`;
      if (!this.session(tenant, sid)) this.createSession(tenant, sid, kind, args.ref ?? '');
      const blob = this.encrypt(args, canonical([tenant, id]));
      this.sql
        .prepare(
          'INSERT INTO jobs(tenant,id,actor,session,kind,idem,request_hash,blob,state,created) VALUES (?,?,?,?,?,?,?,?,?,?)',
        )
        .run(tenant, id, actor, sid, kind, idem, hash, blob, 'queued', Date.now());
      this.audit(tenant, actor, 'job.queued', { id, kind, session: sid, request_hash: hash });
      return this.job(tenant, id)!;
    });
  }
  existing(tenant: string, kind: JobKind, idem: string, args: unknown, session?: string) {
    const prior = this.sql
      .prepare('SELECT id,request_hash FROM jobs WHERE tenant=? AND idem=?')
      .get(tenant, idem) as any;
    if (!prior) return undefined;
    if (prior.request_hash !== digest({ kind, args, session }))
      throw new Fault(409, 'idempotency_conflict');
    return this.job(tenant, prior.id)!;
  }
  job(tenant: string, id: string): Job | undefined {
    const r = this.sql.prepare('SELECT * FROM jobs WHERE tenant=? AND id=?').get(tenant, id) as any;
    if (!r) return undefined;
    return {
      ...r,
      args: this.decrypt(r.blob, canonical([tenant, id])),
      result: r.result ? this.decrypt(r.result, canonical([tenant, id, 'result'])) : null,
    };
  }
  recover() {
    this.tx(() => {
      const rows = this.sql
        .prepare(
          "SELECT tenant,id FROM jobs WHERE state='running' AND (lease_until<=? OR deadline<=?)",
        )
        .all(Date.now(), Date.now()) as any[];
      for (const r of rows) {
        this.sql
          .prepare("UPDATE jobs SET state='interrupted' WHERE tenant=? AND id=?")
          .run(r.tenant, r.id);
        this.terminal(this.job(r.tenant, r.id)!, 'interrupted', {
          code: 'worker_lease_or_deadline_expired',
        });
        this.audit(r.tenant, 'system', 'job.interrupted', {
          id: r.id,
          reason: 'worker_lease_expired',
        });
      }
    });
  }
  claim(owner: string, timeoutMs: number, limit = 2): Job | undefined {
    return this.tx(() => {
      this.recover();
      if (
        (this.sql.prepare("SELECT COUNT(*) n FROM jobs WHERE state='running'").get() as any).n >=
        limit
      )
        return undefined;
      const r = this.sql
        .prepare(
          "SELECT tenant,id FROM jobs queued WHERE state='queued' AND NOT EXISTS (SELECT 1 FROM jobs active WHERE active.tenant=queued.tenant AND active.state='running') ORDER BY created LIMIT 1",
        )
        .get() as any;
      if (!r) return undefined;
      this.sql
        .prepare(
          "UPDATE jobs SET state='running',owner=?,deadline=?,lease_until=? WHERE tenant=? AND id=?",
        )
        .run(owner, Date.now() + timeoutMs, Date.now() + 5000, r.tenant, r.id);
      this.audit(r.tenant, 'system', 'job.started', { id: r.id, owner });
      return this.job(r.tenant, r.id);
    });
  }
  heartbeat(job: Job) {
    this.tx(() => {
      this.assertFence(job.tenant, { id: job.id, owner: job.owner! });
      this.sql
        .prepare('UPDATE jobs SET lease_until=? WHERE tenant=? AND id=? AND owner=?')
        .run(Date.now() + 5000, job.tenant, job.id, job.owner);
    });
  }
  private terminal(job: Job, state: string, result: unknown) {
    const session = this.session(job.tenant, job.session);
    if (session.seq < 20000)
      this.append(job.tenant, job.session, {
        tenant_id: job.tenant,
        session_id: job.session,
        actor_id: 'system',
        run_id: job.id,
        span_id: 'job',
        parent_span_id: null,
        type: `job.${state}`,
        verb: state === 'completed' ? 'response' : 'error',
        attempt: 1,
        duration_ms: 0,
        spec_version: 'platform-1',
        payload: { job_id: job.id, state, result_digest: digest(result) },
      });
  }
  finish(job: Job, state: string, result: unknown) {
    this.tx(() => {
      const current = this.job(job.tenant, job.id);
      if (!current || current.state !== 'running' || current.owner !== job.owner) return;
      if (current.deadline! <= Date.now() || current.lease_until! <= Date.now()) {
        state = 'failed';
        result = { code: 'execution_lease_or_deadline_expired' };
      }
      this.sql
        .prepare('UPDATE jobs SET state=?,result=? WHERE tenant=? AND id=?')
        .run(
          state,
          this.encrypt(result, canonical([job.tenant, job.id, 'result'])),
          job.tenant,
          job.id,
        );
      this.terminal(job, state, result);
      this.audit(job.tenant, job.actor, `job.${state}`, {
        id: job.id,
        result_digest: digest(result),
      });
    });
  }
  cancel(tenant: string, id: string, actor: string) {
    return this.tx(() => {
      const job = this.job(tenant, id);
      if (!job) throw new Fault(404, 'job_not_found');
      if (['queued', 'running'].includes(job.state)) {
        this.sql
          .prepare("UPDATE jobs SET state='cancelled' WHERE tenant=? AND id=?")
          .run(tenant, id);
        this.terminal(job, 'cancelled', { code: 'cancelled' });
        this.audit(tenant, actor, 'job.cancelled', { id });
      }
      return this.job(tenant, id)!;
    });
  }
  rate(key: string, limit: number): boolean {
    return this.tx(() => {
      const window = Math.floor(Date.now() / 60000);
      this.sql.prepare('DELETE FROM rate_limits WHERE window<?').run(window - 1);
      this.sql
        .prepare(
          'INSERT INTO rate_limits VALUES (?,?,1) ON CONFLICT(key) DO UPDATE SET window=excluded.window,count=CASE WHEN rate_limits.window=excluded.window THEN rate_limits.count+1 ELSE 1 END',
        )
        .run(key, window);
      return (
        (this.sql.prepare('SELECT count FROM rate_limits WHERE key=?').get(key) as any).count <=
        limit
      );
    });
  }
  activeJob(tenant: string, session: string) {
    return this.sql
      .prepare("SELECT 1 FROM jobs WHERE tenant=? AND session=? AND state IN ('queued','running')")
      .get(tenant, session) as any;
  }
  isRevoked(hash: string) {
    return Boolean(this.sql.prepare('SELECT 1 FROM revoked_tokens WHERE hash=?').get(hash));
  }
  revoke(hash: string) {
    this.sql.prepare('INSERT OR IGNORE INTO revoked_tokens VALUES (?)').run(hash);
  }
  jobCounts(tenant: string) {
    return this.sql
      .prepare('SELECT state,COUNT(*) count FROM jobs WHERE tenant=? GROUP BY state')
      .all(tenant);
  }
  /** Administrative integrity probe; callers do not need to reach into SQLite. */
  verifyAll() {
    if (this.sql.pragma('integrity_check', { simple: true }) !== 'ok')
      throw new Error('SQLite integrity check failed');
    const sessions = (this.sql.prepare('SELECT tenant,id FROM sessions').all() as any[]).map(
      (row) => ({
        tenant: row.tenant,
        session: row.id,
        ...this.verify(row.tenant, row.id),
      }),
    );
    for (const row of this.sql.prepare('SELECT tenant,kind,key FROM artifacts').all() as any[])
      this.get(row.tenant, row.kind, row.key);
    for (const row of this.sql.prepare('SELECT tenant,kind,name FROM pointers').all() as any[])
      this.pointer(row.tenant, row.kind, row.name);
    for (const row of this.sql.prepare('SELECT tenant,id FROM jobs').all() as any[])
      this.job(row.tenant, row.id);
    return sessions;
  }
  async backup(path: string) {
    await this.sql.backup(path);
    chmodSync(path, 0o600);
  }
}

export class TenantTraceStore implements TraceStore {
  constructor(
    private ledger: TraceLedger,
    readonly tenant: string,
    private actor: string,
    private fence?: Fence,
  ) {}
  async appendNext(evt: NewTraceEvent) {
    return await this.ledger.append(
      this.tenant,
      evt.session_id,
      { ...evt, actor_id: this.actor, run_id: this.fence?.id },
      this.fence,
    );
  }
  async append(_evt: TraceEvent): Promise<void> {
    throw new Fault(403, 'explicit_identity_import_disabled');
  }
  async readBySession(session: string) {
    return await this.ledger.read(this.tenant, session);
  }
  async bySeq(session: string, seq: number) {
    return (await this.ledger.read(this.tenant, session, seq - 1, 1)).find((e) => e.seq === seq);
  }
}
