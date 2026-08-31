import { Ledger } from '../src/production/database.ts';
import { PostgresTraceLedger } from '../src/production/postgres-ledger.ts';
import { migratePostgres } from '../src/production/storage.ts';
import { writeFile } from 'node:fs/promises';
const source = process.env.VERIDICAL_SQLITE_PATH;
const url = process.env.VERIDICAL_POSTGRES_URL;
const dataKey = process.env.VERIDICAL_DATA_KEY;
const auditKey = process.env.VERIDICAL_AUDIT_KEY;
const reportPath = process.env.VERIDICAL_MIGRATION_REPORT ?? 'postgres-migration-report.json';
if (!source || !url || !dataKey || !auditKey) throw new Error('VERIDICAL_SQLITE_PATH, VERIDICAL_POSTGRES_URL, VERIDICAL_DATA_KEY and VERIDICAL_AUDIT_KEY are required');
const toKey = (v) => Buffer.from(v, 'hex');
const sqlite = new Ledger(source, toKey(dataKey), toKey(auditKey));
await migratePostgres(url);
const postgres = new PostgresTraceLedger(url, toKey(dataKey), toKey(auditKey));
const report = { source, sessions: 0, events: 0, failures: [], started_at: new Date().toISOString() };
try {
  for (const session of sqlite.sql.prepare("SELECT tenant,id,kind,ref FROM sessions ORDER BY created").all()) {
    try {
      await postgres.createSession(session.tenant, session.id, session.kind, session.ref);
      const events = sqlite.read(session.tenant, session.id);
      for (const event of events) await postgres.append(event.tenant_id, event.session_id, event);
      report.sessions++; report.events += events.length;
    } catch (error) { report.failures.push({ type: 'session', id: session.id, error: String(error) }); }
  }
  report.finished_at = new Date().toISOString(); report.ok = report.failures.length === 0;
  await writeFile(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report));
  if (!report.ok) process.exitCode = 1;
} finally { sqlite.close(); await postgres.close(); }
