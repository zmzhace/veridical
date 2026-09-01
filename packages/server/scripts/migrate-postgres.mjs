import { randomUUID, createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { Ledger } from '../src/production/database.ts';
import { migratePostgres } from '../src/production/storage.ts';
import { PostgresTraceLedger } from '../src/production/postgres-ledger.ts';
import { canonical } from '../src/production/contracts.ts';

const source = process.env.VERIDICAL_SQLITE_PATH;
const url = process.env.VERIDICAL_POSTGRES_URL;
const dataKey = process.env.VERIDICAL_DATA_KEY;
const auditKey = process.env.VERIDICAL_AUDIT_KEY;
const reportPath = process.env.VERIDICAL_MIGRATION_REPORT ?? 'postgres-migration-report.json';
const rollback = process.argv.includes('--rollback');
if (!source || !url || !dataKey || !auditKey)
  throw new Error(
    'VERIDICAL_SQLITE_PATH, VERIDICAL_POSTGRES_URL, VERIDICAL_DATA_KEY and VERIDICAL_AUDIT_KEY are required',
  );

const id = process.env.VERIDICAL_MIGRATION_ID ?? `migration_${randomUUID()}`;
const key = (value) => Buffer.from(value, 'hex');
const sqlite = new Ledger(source, key(dataKey), key(auditKey));
const pool = new Pool({ connectionString: url, max: 4 });
const report = {
  id,
  source,
  started_at: new Date().toISOString(),
  counts: {
    sessions: 0,
    events: 0,
    artifacts: 0,
    pointers: 0,
    jobs: 0,
    revoked_tokens: 0,
    rate_limits: 0,
    audit_events: 0,
  },
  tenants: [],
  failures: [],
};

function sourceState() {
  const rows = sqlite.sql
    .prepare(
      `SELECT
        (SELECT count(*) FROM sessions) AS sessions,
        (SELECT count(*) FROM events) AS events,
        (SELECT count(*) FROM artifacts) AS artifacts,
        (SELECT count(*) FROM pointers) AS pointers,
        (SELECT count(*) FROM jobs) AS jobs,
        (SELECT count(*) FROM revoked_tokens) AS revoked_tokens,
        (SELECT count(*) FROM rate_limits) AS rate_limits,
        (SELECT coalesce(max(seq), 0) FROM sessions) AS max_seq`,
    )
    .get();
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

try {
  await migratePostgres(url);
  if (rollback) await rollbackMigration();
  else {
    await importAll();
    if (!report.failures.length) await verifyTarget();
  }
  report.finished_at = new Date().toISOString();
  report.ok = report.failures.length === 0;
  await writeFile(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report));
  if (!report.ok) process.exitCode = 1;
} finally {
  sqlite.close();
  await pool.end();
}

async function importAll() {
  const sourceStateBefore = sourceState();
  report.source_state_before = sourceStateBefore;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [71938402]);
    const existing = await client.query(`SELECT
      (SELECT count(*) FROM sessions) AS sessions,
      (SELECT count(*) FROM artifacts) AS artifacts,
      (SELECT count(*) FROM pointers) AS pointers,
      (SELECT count(*) FROM jobs) AS jobs`);
    if (Object.values(existing.rows[0]).some((value) => Number(value) !== 0))
      throw new Error('postgres_target_not_empty');
    await client.query(
      `INSERT INTO migration_checkpoints(id,source,status,target_was_empty) VALUES($1,$2,'running',true)`,
      [id, source],
    );
    const sessions = sqlite.sql
      .prepare('SELECT tenant,id,kind,ref,created,seq,head FROM sessions ORDER BY tenant,created')
      .all();
    const tenantSet = new Set();
    const sourceHash = createHash('sha256');
    for (const row of sessions) {
      tenantSet.add(row.tenant);
      sourceHash.update(JSON.stringify(row));
      sqlite.verify(row.tenant, row.id);
      await client.query(
        `INSERT INTO sessions(tenant,id,kind,ref,created,seq,head) VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [row.tenant, row.id, row.kind, row.ref, row.created, row.seq, row.head],
      );
      report.counts.sessions++;
      const events = sqlite.sql
        .prepare(
          'SELECT tenant,session,seq,id,blob,prev,hash FROM events WHERE tenant=? AND session=? ORDER BY seq',
        )
        .all(row.tenant, row.id);
      if (row.kind === 'audit') report.counts.audit_events += events.length;
      for (const event of events) {
        sourceHash.update(JSON.stringify(event));
        const decoded = sqlite.decrypt(
          event.blob,
          canonical([event.tenant, event.session, event.seq]),
        );
        await client.query(
          `INSERT INTO events(tenant,session,seq,id,blob,prev,hash,run_id,invocation_id,parent_invocation_id,path,ordinal,attempt,fingerprint) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
          [
            event.tenant,
            event.session,
            event.seq,
            event.id,
            event.blob,
            event.prev,
            event.hash,
            decoded.run_id ?? null,
            decoded.invocation_id ?? null,
            decoded.parent_invocation_id ?? null,
            decoded.path ?? null,
            decoded.ordinal ?? null,
            decoded.attempt ?? null,
            decoded.fingerprint ?? null,
          ],
        );
        report.counts.events++;
      }
    }
    for (const row of sqlite.sql
      .prepare(
        'SELECT tenant,kind,key,author,status,digest,blob,meta,seal,created FROM artifacts ORDER BY tenant,kind,key',
      )
      .all()) {
      tenantSet.add(row.tenant);
      sourceHash.update(JSON.stringify(row));
      await client.query(
        `INSERT INTO artifacts(tenant,kind,key,author,status,digest,blob,meta,seal,created) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)`,
        [
          row.tenant,
          row.kind,
          row.key,
          row.author,
          row.status,
          row.digest,
          row.blob,
          JSON.stringify(row.meta),
          row.seal,
          row.created,
        ],
      );
      report.counts.artifacts++;
    }
    for (const row of sqlite.sql
      .prepare('SELECT tenant,kind,name,ref,seal FROM pointers ORDER BY tenant,kind,name')
      .all()) {
      tenantSet.add(row.tenant);
      sourceHash.update(JSON.stringify(row));
      await client.query(`INSERT INTO pointers(tenant,kind,name,ref,seal) VALUES($1,$2,$3,$4,$5)`, [
        row.tenant,
        row.kind,
        row.name,
        row.ref,
        row.seal,
      ]);
      report.counts.pointers++;
    }
    for (const row of sqlite.sql
      .prepare(
        'SELECT tenant,id,actor,session,kind,idem,request_hash,blob,state,owner,deadline,lease_until,result,created FROM jobs ORDER BY tenant,created',
      )
      .all()) {
      tenantSet.add(row.tenant);
      sourceHash.update(JSON.stringify(row));
      await client.query(
        `INSERT INTO jobs(tenant,id,actor,session,kind,idem,request_hash,blob,state,owner,deadline,lease_until,result,created) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14)`,
        [
          row.tenant,
          row.id,
          row.actor,
          row.session,
          row.kind,
          row.idem,
          row.request_hash,
          row.blob,
          row.state,
          row.owner,
          row.deadline,
          row.lease_until,
          row.result === null ? null : JSON.stringify(row.result),
          row.created,
        ],
      );
      report.counts.jobs++;
    }
    for (const row of sqlite.sql.prepare('SELECT hash FROM revoked_tokens').all()) {
      sourceHash.update(JSON.stringify(row));
      await client.query('INSERT INTO revoked_tokens(hash) VALUES($1)', [row.hash]);
      report.counts.revoked_tokens++;
    }
    for (const row of sqlite.sql.prepare('SELECT key,window,count FROM rate_limits').all()) {
      sourceHash.update(JSON.stringify(row));
      await client.query('INSERT INTO rate_limits(key,window_start,count) VALUES($1,$2,$3)', [
        row.key,
        row.window,
        row.count,
      ]);
      report.counts.rate_limits++;
    }
    report.tenants = [...tenantSet].sort();
    report.source_hash = sourceHash.digest('hex');
    const sourceStateAfter = sourceState();
    report.source_state_after = sourceStateAfter;
    if (sourceStateAfter !== sourceStateBefore) throw new Error('sqlite_changed_during_migration');
    report.migration_hash = createHash('sha256')
      .update(
        JSON.stringify({
          source_hash: report.source_hash,
          counts: report.counts,
          tenants: report.tenants,
        }),
      )
      .digest('hex');
    await client.query(
      `UPDATE migration_checkpoints SET status='completed',tenants=$2::jsonb,counts=$3::jsonb,source_hash=$4,completed_at=now() WHERE id=$1`,
      [id, JSON.stringify(report.tenants), JSON.stringify(report.counts), report.source_hash],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    report.failures.push({ type: 'transaction', error: String(error) });
  } finally {
    client.release();
  }
}

async function verifyTarget() {
  const target = new PostgresTraceLedger(url, key(dataKey), key(auditKey));
  try {
    const sessions = await target.verifyAll();
    if (sessions.length !== report.counts.sessions)
      throw new Error('migration_session_count_mismatch');
    const result = await target.pool.query(`SELECT
      (SELECT count(*) FROM events) AS events,
      (SELECT count(*) FROM artifacts) AS artifacts,
      (SELECT count(*) FROM pointers) AS pointers,
      (SELECT count(*) FROM jobs) AS jobs,
      (SELECT count(*) FROM revoked_tokens) AS revoked_tokens,
      (SELECT count(*) FROM rate_limits) AS rate_limits`);
    for (const [name, value] of Object.entries(result.rows[0]))
      if (Number(value) !== report.counts[name])
        throw new Error(`migration_${name}_count_mismatch`);
    const audit = await target.pool.query(
      "SELECT count(*) FROM events e JOIN sessions s ON s.tenant=e.tenant AND s.id=e.session WHERE s.kind='audit'",
    );
    if (Number(audit.rows[0].count) !== report.counts.audit_events)
      throw new Error('migration_audit_event_count_mismatch');
    const targetHash = createHash('sha256');
    for (const table of ['events', 'artifacts', 'pointers', 'jobs']) {
      const rows = await target.pool.query(`SELECT * FROM ${table} ORDER BY tenant, 2`, []);
      for (const row of rows.rows) targetHash.update(JSON.stringify(row));
    }
    report.target_hash = targetHash.digest('hex');
  } catch (error) {
    report.failures.push({ type: 'verification', error: String(error) });
  } finally {
    await target.close();
  }
}

async function rollbackMigration() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [71938402]);
    const result = await client.query(
      'SELECT * FROM migration_checkpoints WHERE id=$1 FOR UPDATE',
      [id],
    );
    const checkpoint = result.rows[0];
    if (!checkpoint || checkpoint.status !== 'completed' || !checkpoint.target_was_empty)
      throw new Error('migration_rollback_not_allowed');
    // PostgreSQL event immutability is correct during normal operation. A
    // rollback is the explicitly audited exception and recreates the triggers
    // before committing.
    await client.query('DROP TRIGGER IF EXISTS events_no_delete ON events');
    await client.query('DROP TRIGGER IF EXISTS events_no_update ON events');
    for (const tenant of checkpoint.tenants) {
      await client.query('DELETE FROM jobs WHERE tenant=$1', [tenant]);
      await client.query('DELETE FROM pointers WHERE tenant=$1', [tenant]);
      await client.query('DELETE FROM artifacts WHERE tenant=$1', [tenant]);
      await client.query('DELETE FROM events WHERE tenant=$1', [tenant]);
      await client.query('DELETE FROM sessions WHERE tenant=$1', [tenant]);
    }
    await client.query(
      'CREATE TRIGGER events_no_update BEFORE UPDATE ON events FOR EACH ROW EXECUTE FUNCTION reject_event_mutation()',
    );
    await client.query(
      'CREATE TRIGGER events_no_delete BEFORE DELETE ON events FOR EACH ROW EXECUTE FUNCTION reject_event_mutation()',
    );
    await client.query(
      `UPDATE migration_checkpoints SET status='rolled_back',completed_at=now() WHERE id=$1`,
      [id],
    );
    await client.query('COMMIT');
    report.rolled_back = true;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    report.failures.push({ type: 'rollback', error: String(error) });
  } finally {
    client.release();
  }
}
