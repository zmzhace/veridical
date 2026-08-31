import { Pool, type PoolClient } from 'pg';
import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { parseEvent, type TraceEvent } from '@veridical/schema';
import type { NewTraceEvent } from '@veridical/store';
import { canonical, digest, Fault, type Artifact, type Job, type JobKind } from './contracts';
import type { Fence, TraceLedger } from './database';

/** PostgreSQL-backed immutable trace ledger. Domain methods are async by design. */
export class PostgresTraceLedger implements TraceLedger {
  readonly pool: Pool;
  constructor(
    connectionString: string,
    private readonly dataKey: Buffer,
    private readonly auditKey: Buffer,
  ) {
    if (dataKey.length !== 32 || auditKey.length !== 32 || dataKey.equals(auditKey))
      throw new Error('distinct 32-byte data and audit keys required');
    this.pool = new Pool({ connectionString, max: 10, application_name: 'veridical-ledger' });
  }
  close() { return this.pool.end(); }
  async createSession(tenant: string, id: string, kind = 'run', ref = '') {
    await this.pool.query(
      `INSERT INTO sessions(tenant,id,kind,ref,created) VALUES($1,$2,$3,$4,now()) ON CONFLICT DO NOTHING`,
      [tenant, id, kind, ref],
    );
  }
  private mac(value: string) { return createHmac('sha256', this.auditKey).update(value).digest('hex'); }
  private encrypt(value: unknown, aad: string) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.dataKey, iv);
    cipher.setAAD(Buffer.from(aad));
    const bytes = Buffer.concat([cipher.update(canonical(value)), cipher.final()]);
    return [iv, cipher.getAuthTag(), bytes].map((b) => b.toString('base64')).join('.');
  }
  private decrypt(blob: string, aad: string) {
    const [iv, tag, data] = blob.split('.').map((v) => Buffer.from(v, 'base64'));
    const cipher = createDecipheriv('aes-256-gcm', this.dataKey, iv);
    cipher.setAAD(Buffer.from(aad)); cipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([cipher.update(data), cipher.final()]).toString('utf8'));
  }
  private async ensureSession(client: PoolClient, tenant: string, session: string) {
    await client.query(
      `INSERT INTO sessions(tenant,id,kind,ref,created) VALUES($1,$2,'run','',now()) ON CONFLICT DO NOTHING`,
      [tenant, session],
    );
  }
  async append(tenant: string, session: string, input: NewTraceEvent, fence?: Fence): Promise<TraceEvent> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const row = await client.query<{ seq: number; head: string; kind: string }>(
        'SELECT seq,head,kind FROM sessions WHERE tenant=$1 AND id=$2 FOR UPDATE', [tenant, session],
      );
      if (!row.rows[0]) throw new Fault(404, 'session_not_found');
      if (input.tenant_id !== tenant || input.session_id !== session) throw new Fault(403, 'tenant_mismatch');
      if (fence) {
        const job = await client.query('SELECT state,owner,deadline,lease_until FROM jobs WHERE tenant=$1 AND id=$2', [tenant, fence.id]);
        const j = job.rows[0] as any;
        if (!j || j.state !== 'running' || j.owner !== fence.owner || Number(j.deadline) <= Date.now() || Number(j.lease_until) <= Date.now())
          throw new Fault(409, 'execution_fenced');
      }
      const seq = Number(row.rows[0].seq) + 1;
      const event = parseEvent({ ...input, id: `evt_${randomUUID()}`, seq, timestamp: new Date().toISOString(), event_schema_version: 1 });
      const blob = this.encrypt(event, canonical([tenant, session, seq]));
      const hash = this.mac(canonical([tenant, session, seq, event.id, row.rows[0].head, blob]));
      await client.query('INSERT INTO events(tenant,session,seq,id,blob,prev,hash) VALUES($1,$2,$3,$4,$5,$6,$7)', [tenant, session, seq, event.id, blob, row.rows[0].head, hash]);
      await client.query('UPDATE sessions SET seq=$1,head=$2 WHERE tenant=$3 AND id=$4', [seq, hash, tenant, session]);
      await client.query('COMMIT');
      return event;
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
    finally { client.release(); }
  }
  async read(tenant: string, session: string, after = 0, limit = 20000): Promise<TraceEvent[]> {
    const result = await this.pool.query<{ seq: number; id: string; blob: string; prev: string; hash: string }>(
      'SELECT seq,id,blob,prev,hash FROM events WHERE tenant=$1 AND session=$2 AND seq>$3 ORDER BY seq LIMIT $4', [tenant, session, after, limit],
    );
    let seq = after; let head = '';
    if (after > 0) { const p = await this.pool.query<{ hash: string }>('SELECT hash FROM events WHERE tenant=$1 AND session=$2 AND seq=$3', [tenant, session, after]); head = p.rows[0]?.hash ?? ''; }
    return result.rows.map((row) => {
      if (Number(row.seq) !== ++seq || row.prev !== head || this.mac(canonical([tenant, session, row.seq, row.id, row.prev, row.blob])) !== row.hash) throw new Error('broken audit chain');
      const event = parseEvent(this.decrypt(row.blob, canonical([tenant, session, row.seq])));
      head = row.hash; return event;
    });
  }
  async verify(tenant: string, session: string, checkpoint?: { seq: number; head: string; signature: string }) {
    const row = await this.pool.query<{ seq: number; head: string }>('SELECT seq,head FROM sessions WHERE tenant=$1 AND id=$2', [tenant, session]);
    if (!row.rows[0]) throw new Fault(404, 'session_not_found');
    const result = { seq: Number(row.rows[0].seq), head: row.rows[0].head, signature: this.mac(canonical([tenant, session, row.rows[0].seq, row.rows[0].head])) };
    if (checkpoint && (checkpoint.seq !== result.seq || checkpoint.head !== result.head)) throw new Fault(409, 'checkpoint_mismatch');
    return result;
  }

  async session(tenant: string, id: string) {
    const r = await this.pool.query('SELECT tenant,id,kind,ref,created,seq,head FROM sessions WHERE tenant=$1 AND id=$2', [tenant,id]);
    return r.rows[0];
  }
  async listSessions(tenant: string, limit = 50, offset = 0) {
    const r = await this.pool.query('SELECT tenant,id,kind,ref,created,seq,head FROM sessions WHERE tenant=$1 ORDER BY created DESC LIMIT $2 OFFSET $3', [tenant,limit,offset]);
    return r.rows;
  }
  async put(tenant: string, kind: string, key: string, body: unknown, actor: string, status = 'draft', meta: unknown = {}): Promise<Artifact> {
    return await this.putArtifact(tenant, kind, key, body, actor, status, meta);
  }
  async putArtifact(tenant: string, kind: string, key: string, body: unknown, actor: string, status = 'draft', meta: unknown = {}): Promise<Artifact> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const hash = digest(body), created = new Date().toISOString();
      const blob = this.encrypt(body, canonical([tenant, kind, key]));
      const metadata = this.encrypt(meta, canonical([tenant, kind, key, 'meta']));
      const seal = this.mac(canonical([tenant, kind, key, actor, status, hash, blob, metadata, created]));
      await client.query('INSERT INTO artifacts(tenant,kind,key,author,status,digest,blob,meta,seal,created) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)', [tenant,kind,key,actor,status,hash,blob,JSON.stringify(metadata),seal,created]);
      await client.query('COMMIT');
      return { key, body, digest: hash, author: actor, status, meta, created };
    } catch (e) { await client.query('ROLLBACK').catch(()=>undefined); throw e; } finally { client.release(); }
  }
  async getArtifact<T = any>(tenant: string, kind: string, key: string) { return this.get<T>(tenant,kind,key); }
  async transition(tenant: string, kind: string, key: string, status: string, meta: unknown, actor: string): Promise<Artifact> {
    const current = await this.get(tenant,kind,key); if (!current) throw new Fault(404,'artifact_not_found');
    await this.pool.query('UPDATE artifacts SET status=$1,meta=$2::jsonb WHERE tenant=$3 AND kind=$4 AND key=$5', [status, JSON.stringify(this.encrypt(meta, canonical([tenant,kind,key,'meta']))), tenant,kind,key]);
    const result = await this.get(tenant,kind,key); if (!result) throw new Error('artifact_transition_lost');
    await this.audit(tenant, actor, `${kind}.transitioned`, { key, status }); return result;
  }
  async list(tenant: string, kind: string, limit = 50, offset = 0) {
    const r = await this.pool.query('SELECT key,author,status,digest,blob,meta,created FROM artifacts WHERE tenant=$1 AND kind=$2 ORDER BY created DESC LIMIT $3 OFFSET $4',[tenant,kind,limit,offset]);
    return Promise.all(r.rows.map((row:any)=>this.get(tenant,kind,row.key)));
  }

  async get<T = any>(tenant: string, kind: string, key: string): Promise<Artifact<T> | undefined> {
    const result = await this.pool.query<any>('SELECT * FROM artifacts WHERE tenant=$1 AND kind=$2 AND key=$3', [tenant, kind, key]);
    const row = result.rows[0]; if (!row) return undefined;
    const metadata = typeof row.meta === 'string' ? row.meta : JSON.stringify(row.meta);
    const created = row.created instanceof Date ? row.created.toISOString() : new Date(row.created).toISOString();
    if (row.seal !== this.mac(canonical([tenant, kind, key, row.author, row.status, row.digest, row.blob, metadata, created]))) throw new Error('artifact authentication failed');
    const body = this.decrypt(row.blob, canonical([tenant, kind, key]));
    if (digest(body) !== row.digest) throw new Error('artifact digest mismatch');
    return { key, body, digest: row.digest, author: row.author, status: row.status, meta: this.decrypt(metadata, canonical([tenant, kind, key, 'meta'])), created };
  }
  async pointer(tenant: string, kind: string, name: string): Promise<string | undefined> {
    const result = await this.pool.query<{ ref: string; seal: string }>('SELECT ref,seal FROM pointers WHERE tenant=$1 AND kind=$2 AND name=$3', [tenant, kind, name]);
    const row = result.rows[0]; if (!row) return undefined;
    if (row.seal !== this.mac(canonical([tenant, kind, name, row.ref]))) throw new Error('pointer authentication failed');
    return row.ref;
  }
  async point(tenant: string, kind: string, name: string, ref: string, actor: string, reason: string) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const previous = await this.pointer(tenant, kind, name);
      const seal = this.mac(canonical([tenant, kind, name, ref]));
      await client.query('INSERT INTO pointers(tenant,kind,name,ref,seal) VALUES($1,$2,$3,$4,$5) ON CONFLICT(tenant,kind,name) DO UPDATE SET ref=EXCLUDED.ref,seal=EXCLUDED.seal', [tenant, kind, name, ref, seal]);
      await client.query('COMMIT');
      await this.audit(tenant, actor, `${kind}.changed`, { name, previous, ref, reason });
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
    finally { client.release(); }
  }
  async rate(key: string, limit: number): Promise<boolean> {
    const window = Math.floor(Date.now()/60000);
    const r = await this.pool.query(`INSERT INTO rate_limits(key,window_start,count) VALUES($1,$2,1) ON CONFLICT(key) DO UPDATE SET window_start=EXCLUDED.window_start,count=CASE WHEN rate_limits.window_start=EXCLUDED.window_start THEN rate_limits.count+1 ELSE 1 END RETURNING count`, [key,window]);
    return Number(r.rows[0]?.count ?? limit + 1) <= limit;
  }
  async isRevoked(hash: string): Promise<boolean> { const r = await this.pool.query('SELECT 1 FROM revoked_tokens WHERE hash=$1',[hash]); return r.rowCount === 1; }
  async revoke(hash: string): Promise<void> { await this.pool.query('INSERT INTO revoked_tokens(hash) VALUES($1) ON CONFLICT DO NOTHING',[hash]); }
  async jobCounts(tenant: string) { const r = await this.pool.query('SELECT state,COUNT(*)::int AS count FROM jobs WHERE tenant=$1 GROUP BY state',[tenant]); return r.rows; }
  async capacity() { const r = await this.pool.query<{ size: string }>('SELECT pg_database_size(current_database())::text AS size'); return { database_bytes: Number(r.rows[0]?.size ?? 0), free_disk_bytes: Number.MAX_SAFE_INTEGER }; }
  async audit(tenant: string, actor: string, action: string, payload: unknown) {
    const session = '_audit';
    await this.createSession(tenant, session, 'audit', 'platform');
    return this.append(tenant, session, {
      tenant_id: tenant, session_id: session, actor_id: actor, run_id: undefined,
      span_id: 'governance', parent_span_id: null, type: action, verb: 'response', attempt: 1,
      duration_ms: 0, spec_version: 'platform-1', payload,
    });
  }

  async enqueue(tenant: string, actor: string, kind: JobKind, idem: string, args: any, session?: string): Promise<Job> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const requestHash = digest({ kind, args, session });
      const prior = await client.query<any>('SELECT * FROM jobs WHERE tenant=$1 AND idem=$2', [tenant, idem]);
      if (prior.rows[0]) {
        if (prior.rows[0].request_hash !== requestHash) throw new Fault(409, 'idempotency_conflict');
        await client.query('COMMIT');
        return this.decodeJob(prior.rows[0]);
      }
      const id = randomUUID();
      const sid = session ?? `run_${id}`;
      await this.ensureSession(client, tenant, sid);
      const blob = this.encrypt(args, canonical([tenant, id]));
      await client.query('INSERT INTO jobs(tenant,id,actor,session,kind,idem,request_hash,blob,state,created) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [tenant, id, actor, sid, kind, idem, requestHash, blob, 'queued', Date.now()]);
      await client.query('COMMIT');
      const job = await this.job(tenant, id);
      if (!job) throw new Error('postgres_job_insert_lost');
      return job;
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
    finally { client.release(); }
  }
  private decodeJob(row: any): Job {
    const resultRaw = row.result;
    let result: unknown = null;
    if (resultRaw) {
      const encrypted = typeof resultRaw === 'string' ? resultRaw : JSON.stringify(resultRaw);
      result = this.decrypt(encrypted, canonical([row.tenant, row.id, 'result']));
    }
    return {
      id: row.id, tenant: row.tenant, actor: row.actor, session: row.session, kind: row.kind,
      state: row.state, owner: row.owner, deadline: row.deadline === null ? null : Number(row.deadline),
      lease_until: row.lease_until === null ? null : Number(row.lease_until),
      args: this.decrypt(row.blob, canonical([row.tenant, row.id])), result, created: Number(row.created),
    } as Job;
  }
  async job(tenant: string, id: string): Promise<Job | undefined> {
    const result = await this.pool.query<any>('SELECT * FROM jobs WHERE tenant=$1 AND id=$2', [tenant, id]);
    return result.rows[0] ? this.decodeJob(result.rows[0]) : undefined;
  }
  async activeJob(tenant: string, session: string): Promise<boolean> {
    const r = await this.pool.query("SELECT 1 FROM jobs WHERE tenant=$1 AND session=$2 AND state IN ('queued','running') LIMIT 1", [tenant,session]);
    return r.rowCount === 1;
  }
  async claim(owner: string, timeoutMs: number): Promise<Job | undefined> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("UPDATE jobs SET state='interrupted' WHERE state='running' AND (lease_until <= $1 OR deadline <= $1)", [Date.now()]);
      const selected = await client.query<any>("SELECT * FROM jobs WHERE state='queued' ORDER BY created FOR UPDATE SKIP LOCKED LIMIT 1");
      const row = selected.rows[0]; if (!row) { await client.query('COMMIT'); return undefined; }
      const deadline = Date.now() + timeoutMs, lease = Date.now() + 5000;
      await client.query("UPDATE jobs SET state='running',owner=$1,deadline=$2,lease_until=$3 WHERE tenant=$4 AND id=$5", [owner, deadline, lease, row.tenant, row.id]);
      await client.query('COMMIT');
      const job = await this.job(row.tenant, row.id);
      return job;
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
    finally { client.release(); }
  }
  async heartbeat(job: Job) {
    const now = Date.now();
    const result = await this.pool.query("UPDATE jobs SET lease_until=$1 WHERE tenant=$2 AND id=$3 AND state='running' AND owner=$4 AND deadline>$5 AND lease_until>$5", [now + 5000, job.tenant, job.id, job.owner, now]);
    if (result.rowCount !== 1) throw new Fault(409, 'execution_fenced');
  }
  async assertFence(tenant: string, fence: Fence) {
    const result = await this.pool.query<any>('SELECT state,owner,deadline,lease_until FROM jobs WHERE tenant=$1 AND id=$2', [tenant, fence.id]);
    const row = result.rows[0]; const now = Date.now();
    if (!row || row.state !== 'running' || row.owner !== fence.owner || Number(row.deadline) <= now || Number(row.lease_until) <= now)
      throw new Fault(409, 'execution_fenced');
  }
  async finish(job: Job, state: string, result: unknown) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query<any>("SELECT * FROM jobs WHERE tenant=$1 AND id=$2 AND state='running' AND owner=$3 FOR UPDATE", [job.tenant, job.id, job.owner]);
      if (!current.rows[0]) { await client.query('ROLLBACK'); return; }
      const encrypted = this.encrypt(result, canonical([job.tenant, job.id, 'result']));
      await client.query('UPDATE jobs SET state=$1,result=$2::jsonb WHERE tenant=$3 AND id=$4', [state, JSON.stringify(encrypted), job.tenant, job.id]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
    finally { client.release(); }
  }
  async cancel(tenant: string, id: string, actor: string) {
    const result = await this.pool.query("UPDATE jobs SET state='cancelled' WHERE tenant=$1 AND id=$2 AND state IN ('queued','running') RETURNING *", [tenant, id]);
    if (!result.rows[0]) { const existing = await this.job(tenant, id); if (!existing) throw new Fault(404, 'job_not_found'); return existing; }
    await this.audit(tenant, actor, 'job.cancelled', { id });
    return this.decodeJob(result.rows[0]);
  }
}
