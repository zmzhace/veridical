import { Ledger } from '../../src/production/database';
const [path, mode, count = '1'] = process.argv.slice(2);
const db = new Ledger(
  path,
  Buffer.from(process.env.TEST_DATA_KEY!, 'hex'),
  Buffer.from(process.env.TEST_AUDIT_KEY!, 'hex'),
);
if (mode === 'append') {
  for (let i = 0; i < Number(count); i++)
    db.append('tenant', 'shared', {
      tenant_id: 'tenant',
      session_id: 'shared',
      span_id: 'worker',
      parent_span_id: null,
      type: 'worker.event',
      verb: 'response',
      attempt: 1,
      duration_ms: 0,
      spec_version: '1.0.0',
      payload: { pid: process.pid, index: i },
    });
  db.close();
} else if (mode === 'crash') {
  db.tx(() => {
    db.createSession('tenant', 'uncommitted', 'run', 'probe@1.0.0');
    process.kill(process.pid, 'SIGKILL');
  });
} else if (mode === 'lease') {
  const job = db.claim('crashed-owner', 60000);
  if (!job) throw new Error('no job');
  process.kill(process.pid, 'SIGKILL');
}
