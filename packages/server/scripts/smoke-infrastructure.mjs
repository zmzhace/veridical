import { randomUUID } from 'node:crypto';
import { migratePostgres, probePostgres, probeRedis } from '../src/production/storage.ts';
import { S3ObjectStore } from '../src/production/object-store.ts';
import { PostgresTraceLedger } from '../src/production/postgres-ledger.ts';
import { RedisJobQueue } from '../src/production/redis-queue.ts';

const postgres =
  process.env.VERIDICAL_POSTGRES_URL ??
  'postgres://veridical:veridical-dev-only@127.0.0.1:5432/veridical';
const redis = process.env.VERIDICAL_REDIS_URL ?? 'redis://127.0.0.1:6379';
const s3 = new S3ObjectStore({
  endpoint: process.env.VERIDICAL_S3_ENDPOINT ?? 'http://127.0.0.1:9000',
  bucket: process.env.VERIDICAL_S3_BUCKET ?? 'veridical-artifacts',
  accessKey: process.env.VERIDICAL_S3_ACCESS_KEY ?? 'veridical',
  secretKey: process.env.VERIDICAL_S3_SECRET_KEY ?? 'veridical-dev-only',
});
await migratePostgres(postgres);
const pg = await probePostgres(postgres);
if (!pg.ok) throw new Error(`postgres unavailable: ${pg.error}`);
const rd = await probeRedis(redis);
if (!rd.ok) throw new Error(`redis unavailable: ${rd.error}`);
await s3.ensureBucket();
const trace = new PostgresTraceLedger(postgres, Buffer.alloc(32, 7), Buffer.alloc(32, 9));
const tenant = `infra_${randomUUID().slice(0, 8)}`;
const queue = new RedisJobQueue(redis, `veridical:infra:${randomUUID()}`);
const duplicateKey = `duplicate_${randomUUID()}`;
const duplicateJobs = await Promise.all(
  ['a', 'b'].map((suffix) =>
    queue.enqueue(
      {
        id: `redis-${suffix}-${randomUUID()}`,
        tenant,
        actor: 'smoke',
        kind: 'run',
        args: {},
        created: Date.now(),
      },
      duplicateKey,
    ),
  ),
);
if (duplicateJobs[0].id !== duplicateJobs[1].id || !duplicateJobs.some((item) => item.duplicate))
  throw new Error('redis duplicate enqueue is not idempotent');
await queue.close();
const traceSession = `infra_${randomUUID()}`;
await trace.createSession(tenant, traceSession);
await trace.append(tenant, traceSession, {
  tenant_id: tenant,
  session_id: traceSession,
  actor_id: 'smoke',
  run_id: 'smoke',
  span_id: 'smoke',
  parent_span_id: null,
  type: 'smoke',
  verb: 'response',
  attempt: 1,
  duration_ms: 0,
  spec_version: 'smoke',
  payload: { ok: true },
});
if ((await trace.read(tenant, traceSession)).length !== 1)
  throw new Error('postgres trace round trip mismatch');
const artifact = await trace.put(
  tenant,
  'smoke',
  `artifact_${randomUUID()}`,
  { ok: true },
  'smoke',
);
const artifactCopy = await trace.get(tenant, 'smoke', artifact.key);
if (!artifactCopy || artifactCopy.digest !== artifact.digest)
  throw new Error('postgres artifact round trip mismatch');
await trace.point(tenant, 'deployment', 'smoke', artifact.key, 'smoke', 'integration');
if ((await trace.pointer(tenant, 'deployment', 'smoke')) !== artifact.key)
  throw new Error('postgres pointer mismatch');
await trace.audit(tenant, 'smoke', 'smoke.completed', { traceSession, artifact: artifact.key });
if ((await trace.read(tenant, '_audit')).length < 1) throw new Error('postgres audit mismatch');
const job = await trace.enqueue(tenant, 'smoke', 'run', `idem_${randomUUID()}`, {
  ref: 'smoke@1.0.0',
});
const claimed = await trace.claim('infra-worker', 30_000, 1, tenant);
if (!claimed || claimed.id !== job.id) throw new Error('postgres job claim mismatch');
await trace.heartbeat(claimed);
await trace.finish(claimed, 'completed', { ok: true });
const finished = await trace.job(tenant, job.id);
if (!finished || finished.state !== 'completed' || finished.result?.ok !== true)
  throw new Error('postgres job finish mismatch');
// Two workers racing for the same queued row must yield exactly one owner.
const raceJob = await trace.enqueue(tenant, 'smoke', 'run', `idem_${randomUUID()}`, {
  ref: 'smoke-race@1.0.0',
});
const claims = await Promise.all([
  trace.claim('race-a', 30_000, 1, tenant),
  trace.claim('race-b', 30_000, 1, tenant),
]);
const winners = claims.filter((candidate) => candidate?.id === raceJob.id);
if (winners.length !== 1) throw new Error('postgres concurrent claim fencing mismatch');
const winner = winners[0];
const loser = claims.find((candidate) => candidate?.id !== raceJob.id);
if (loser) throw new Error('postgres claim selected an unexpected job');
await trace.finish(winner, 'completed', { raced: true });
if ((await trace.job(tenant, raceJob.id).then((value) => value?.state)) !== 'completed')
  throw new Error('postgres raced job did not finish');
const expiredJob = await trace.enqueue(tenant, 'smoke', 'run', `idem_${randomUUID()}`, {
  ref: 'smoke-recovery@1.0.0',
});
await trace.claim('dead-worker', 20, 1, tenant);
await new Promise((resolve) => setTimeout(resolve, 30));
const recovered = await trace.claimById(tenant, expiredJob.id, 'recovery-worker', 30_000);
if (!recovered || recovered.owner !== 'recovery-worker')
  throw new Error('postgres expired lease was not recoverable');
await trace.finish(recovered, 'completed', { recovered: true });
await trace.close();
const key = `smoke/${randomUUID()}.txt`;
const body = new TextEncoder().encode('veridical-infrastructure-smoke');
await s3.put(key, body, 'text/plain');
const roundTrip = await s3.get(key);
if (new TextDecoder().decode(roundTrip) !== 'veridical-infrastructure-smoke')
  throw new Error('s3 round trip mismatch');
await s3.delete(key);
console.log(
  `Infrastructure smoke passed (PostgreSQL ${pg.server_version}, Redis ${rd.version}, S3 ${key})`,
);
