import { afterEach, beforeEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { Ledger } from '../src/production/database';
let dir: string, db: Ledger, path: string;
const data = randomBytes(32),
  audit = randomBytes(32);
const event = (tenant = 'tenant', session = 'shared') => ({
  tenant_id: tenant,
  session_id: session,
  span_id: 'test',
  parent_span_id: null,
  type: 'test.event',
  verb: 'response' as const,
  attempt: 1,
  duration_ms: 0,
  spec_version: '1.0.0',
  payload: { text: 'private' },
});
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'veridical-ledger-'));
  path = join(dir, 'ledger.db');
  db = new Ledger(path, data, audit);
  db.createSession('tenant', 'shared', 'run', 'probe@1.0.0');
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
function worker(mode: string, count?: string) {
  return new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        '--import',
        createRequire(import.meta.url).resolve('tsx'),
        fileURLToPath(new URL('./fixtures/ledger-worker.ts', import.meta.url)),
        path,
        mode,
        ...(count ? [count] : []),
      ],
      {
        env: {
          ...process.env,
          TEST_DATA_KEY: data.toString('hex'),
          TEST_AUDIT_KEY: audit.toString('hex'),
        },
        stdio: ['ignore', 'ignore', 'pipe'],
      },
    );
    let errors = '';
    child.stderr.on('data', (chunk) => {
      errors += chunk;
    });
    child.once('error', reject);
    child.once('close', (code, signal) =>
      code && mode === 'append' ? reject(new Error(errors)) : resolve({ code, signal }),
    );
  });
}
test('separate OS processes allocate a contiguous, authenticated event sequence', async () => {
  const results = await Promise.all([
    worker('append', '60'),
    worker('append', '60'),
    worker('append', '60'),
  ]);
  expect(results.every((r) => r.code === 0)).toBe(true);
  const events = db.read('tenant', 'shared');
  expect(events).toHaveLength(180);
  expect(events.map((e) => e.seq)).toEqual(Array.from({ length: 180 }, (_, i) => i + 1));
  expect(new Set(events.map((e) => e.id)).size).toBe(180);
  expect(db.verify('tenant', 'shared').seq).toBe(180);
}, 15000);
test('SIGKILL inside a SQLite transaction never exposes partial writes', async () => {
  expect((await worker('crash')).signal).toBe('SIGKILL');
  expect(db.session('tenant', 'uncommitted')).toBeUndefined();
  expect(db.sql.pragma('integrity_check', { simple: true })).toBe('ok');
  db.append('tenant', 'shared', event());
  expect(db.verify('tenant', 'shared').seq).toBe(1);
});
test('killed workers recover as interrupted, never auto-retry, and stale writers are fenced', async () => {
  const queued = db.enqueue(
    'tenant',
    'operator',
    'run',
    'crashed-job-key',
    { ref: 'probe@1.0.0' },
    'shared',
  );
  expect((await worker('lease')).signal).toBe('SIGKILL');
  const running = db.job('tenant', queued.id)!;
  expect(running.state).toBe('running');
  // Move the persisted lease into the past instead of relying on wall-clock sleeps.
  db.sql.prepare('UPDATE jobs SET lease_until=0 WHERE id=?').run(queued.id);
  db.recover();
  expect(db.job('tenant', queued.id)?.state).toBe('interrupted');
  expect(db.claim('new-worker', 60000)).toBeUndefined();
  expect(() =>
    db.append('tenant', 'shared', event(), { id: queued.id, owner: 'crashed-owner' }),
  ).toThrow('execution_fenced');
  db.finish(running, 'completed', { should_not_publish: true });
  expect(db.job('tenant', queued.id)?.state).toBe('interrupted');
  expect(db.read('tenant', 'shared').at(-1)?.type).toBe('job.interrupted');
});
test('idempotency, active-session uniqueness and tenant boundaries are database enforced', () => {
  const job = db.enqueue('tenant', 'operator', 'run', 'idem-key', { ref: 'probe@1.0.0' }, 'shared');
  expect(
    db.enqueue('tenant', 'operator', 'run', 'idem-key', { ref: 'probe@1.0.0' }, 'shared').id,
  ).toBe(job.id);
  expect(() =>
    db.enqueue('tenant', 'operator', 'run', 'idem-key', { ref: 'other' }, 'shared'),
  ).toThrow('idempotency_conflict');
  expect(() =>
    db.enqueue('tenant', 'operator', 'run', 'other-key', { ref: 'probe@1.0.0' }, 'shared'),
  ).toThrow('session_busy');
  db.createSession('other', 'shared', 'run', 'probe@1.0.0');
  db.append('other', 'shared', event('other'));
  expect(db.read('tenant', 'shared')).toHaveLength(0);
  expect(() => db.append('tenant', 'shared', event('other'))).toThrow('tenant_mismatch');
});
test('signed external checkpoints detect rollback that a self-contained chain cannot', () => {
  db.append('tenant', 'shared', event());
  const old = db.verify('tenant', 'shared');
  db.append('tenant', 'shared', event());
  const latest = db.verify('tenant', 'shared');
  db.sql.exec('DROP TRIGGER events_no_delete');
  db.sql.prepare('DELETE FROM events WHERE seq=2').run();
  db.sql
    .prepare('UPDATE sessions SET seq=?,head=? WHERE tenant=? AND id=?')
    .run(old.seq, old.head, 'tenant', 'shared');
  expect(db.verify('tenant', 'shared')).toEqual(old);
  expect(() => db.verify('tenant', 'shared', latest)).toThrow('external checkpoint mismatch');
});
test('artifact status and deployment pointer tampering fail signature verification', () => {
  db.put('tenant', 'spec', 'probe@1.0.0', { instruction: 'private' }, 'author');
  db.sql.prepare("UPDATE artifacts SET status='approved'").run();
  expect(() => db.get('tenant', 'spec', 'probe@1.0.0')).toThrow('artifact authentication failed');
  db.point('tenant', 'deployment', 'production.probe', 'probe@1.0.0', 'publisher', 'rollout');
  db.sql.prepare("UPDATE pointers SET ref='probe@9.0.0'").run();
  expect(() => db.pointer('tenant', 'deployment', 'production.probe')).toThrow(
    'pointer authentication failed',
  );
});
test('rate and queue bounds are persisted, not process-local', () => {
  expect(db.rate('actor:test', 1)).toBe(true);
  const other = new Ledger(path, data, audit);
  expect(other.rate('actor:test', 1)).toBe(false);
  other.close();
  for (let i = 0; i < 20; i++)
    db.enqueue('tenant', 'operator', 'run', `queue-key-${i}`, { ref: 'probe@1.0.0' });
  expect(() =>
    db.enqueue('tenant', 'operator', 'run', 'queue-key-overflow', { ref: 'probe@1.0.0' }),
  ).toThrow('queue_full');
});
