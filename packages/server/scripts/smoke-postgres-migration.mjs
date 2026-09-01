import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { Ledger } from '../src/production/database.ts';
import { Pool } from 'pg';

const postgres = process.env.VERIDICAL_POSTGRES_URL ?? 'postgres://veridical:veridical-dev-only@127.0.0.1:5432/veridical';
const reset = new Pool({ connectionString: postgres });
await reset.query('TRUNCATE jobs, artifacts, pointers, events, sessions, rate_limits, revoked_tokens, migration_checkpoints CASCADE');
await reset.end();
const dir = await mkdtemp(join(tmpdir(), 'veridical-migration-'));
const source = join(dir, 'source.db');
const report = join(dir, 'report.json');
const dataKey = randomBytes(32);
const auditKey = randomBytes(32);
const ledger = new Ledger(source, dataKey, auditKey);
const tenant = `migration-${Date.now()}`;
const session = `session-${randomUUID()}`;
ledger.createSession(tenant, session, 'run', 'migration-fixture');
ledger.append(tenant, session, {
  tenant_id: tenant, session_id: session, span_id: 'root', parent_span_id: null,
  type: 'run.start', verb: 'request', attempt: 1, duration_ms: 0,
  payload: { source: 'migration-smoke' }, spec_version: '1.0.0',
});
ledger.put(tenant, 'spec', 'migration-fixture@1', { name: 'migration-fixture' }, 'smoke', 'published');
ledger.point(tenant, 'release', 'active', 'migration-fixture@1', 'smoke', 'migration smoke');
ledger.enqueue(tenant, 'smoke', 'run', `migration-${randomUUID()}`, { ref: 'migration-fixture@1' }, session);
ledger.close();

const run = (args, env) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/migrate-postgres.mjs', ...args], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stdout.on('data', (chunk) => { out += chunk; });
  child.stderr.on('data', (chunk) => { err += chunk; });
  child.on('close', (code) => code === 0 ? resolve({ out, err }) : reject(new Error(`migration exited ${code}: ${err || out}`)));
});
const env = { ...process.env, VERIDICAL_SQLITE_PATH: source, VERIDICAL_POSTGRES_URL: postgres,
  VERIDICAL_DATA_KEY: dataKey.toString('hex'), VERIDICAL_AUDIT_KEY: auditKey.toString('hex'),
  VERIDICAL_MIGRATION_REPORT: report, VERIDICAL_MIGRATION_ID: `smoke-${randomUUID()}` };
await run([], env);
const migrated = JSON.parse(await readFile(report, 'utf8'));
assert.equal(migrated.ok, true);
assert.equal(migrated.counts.sessions, 2); // run session plus immutable audit session
assert.ok(migrated.counts.events >= 2); // run/start and audit lifecycle events
assert.equal(migrated.counts.artifacts, 1);
assert.equal(migrated.counts.pointers, 1);
assert.equal(migrated.counts.jobs, 1);
await run(['--rollback'], env);
const rolledBack = JSON.parse(await readFile(report, 'utf8'));
assert.equal(rolledBack.rolled_back, true);
console.log(`PostgreSQL migration/rollback passed: ${tenant}`);
await rm(dir, { recursive: true, force: true });
