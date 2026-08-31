import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { buildProductionApp } from '../src/production/app.ts';
import { ProductionConfigSchema } from '../src/production/config.ts';
import { RedisJobQueue } from '../src/production/redis-queue.ts';
import { safeTools } from '../src/production/runner.ts';

const postgres = process.env.VERIDICAL_POSTGRES_URL ?? 'postgres://veridical:veridical-dev-only@127.0.0.1:5432/veridical';
const redis = process.env.VERIDICAL_REDIS_URL ?? 'redis://127.0.0.1:6379';
process.env.E2E_S3_ACCESS ??= process.env.VERIDICAL_S3_ACCESS_KEY ?? 'veridical';
process.env.E2E_S3_SECRET ??= process.env.VERIDICAL_S3_SECRET_KEY ?? 'veridical-dev-only';
process.env.E2E_PROVIDER ??= 'fixture';
const tokens = { developer: randomBytes(32).toString('hex'), reviewer: randomBytes(32).toString('hex'), publisher: randomBytes(32).toString('hex'), operator: randomBytes(32).toString('hex') };
const dataKey = randomBytes(32), auditKey = randomBytes(32);
const agentName = `e2e${Date.now().toString().slice(-8)}`;
const config = ProductionConfigSchema.parse({
  database: '/tmp/veridical-postgres-e2e-unused.db', releaseId: 'postgres-e2e-release', dataKeyEnv: 'E2E_DATA', auditKeyEnv: 'E2E_AUDIT',
  storage: { database: 'postgres', objectStore: 's3', queue: 'redis', postgresUrl: postgres, redisUrl: redis, s3Endpoint: process.env.VERIDICAL_S3_ENDPOINT ?? 'http://127.0.0.1:9000', s3Bucket: process.env.VERIDICAL_S3_BUCKET ?? 'veridical-artifacts', s3AccessKeyEnv: 'E2E_S3_ACCESS', s3SecretKeyEnv: 'E2E_S3_SECRET' },
  requestsPerMinute: 1000,
  tokens: Object.entries(tokens).map(([role, value]) => ({ hash: createHash('sha256').update(value).digest('hex'), tenant: 'e2e', actor: role, roles: [role], expires: '2099-01-01T00:00:00Z' })),
  providers: [{ name: 'fixture', model: 'fixture-model', version: 'fixture-v1', baseUrl: 'https://provider.invalid/v1', apiKeyEnv: 'E2E_PROVIDER' }],
});
const provider = { complete: async () => ({ text: '{"text":"E2E OK","done":true}', usage: { input: 2, output: 1, cached: 0, total: 3 } }) };
const queue = new RedisJobQueue(redis, `veridical:e2e:${Date.now()}`);
const env = await buildProductionApp({ config, dataKey, auditKey, providers: new Map([['fixture', provider]]), tools: safeTools, asyncJobs: queue, logger: false });
const request = (method, url, payload, idempotency, role = 'developer') => env.app.inject({ method, url, payload, headers: { authorization: `Bearer ${tokens[role]}`, ...(idempotency ? { 'idempotency-key': idempotency } : {}) } });
const yaml = `name: ${agentName}\nversion: 1.0.0\nschema_version: 1\ninstruction: {system: Be useful}\nflow: {mode: single-loop, max_steps: 2}\nllm: {provider: fixture, model: fixture-model}\ntools: [{name: finish, access: allow}]`;
async function waitJob(id) {
  for (let i = 0; i < 120; i += 1) {
    const job = await env.db.job('e2e', id);
    if (job && !['queued', 'running'].includes(job.state)) return job;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`job timeout: ${id}`);
}
try {
  const specResponse = await request('POST', '/v1/specs', { yaml }, undefined, 'developer');
  if (specResponse.statusCode !== 201) console.error('spec response', specResponse.statusCode, specResponse.body);
  assert.equal(specResponse.statusCode, 201);
  const suite = { name: 'acceptance', cases: [1, 2, 3].map((i) => ({ input: `case-${i}`, contains: ['E2E OK'] })) };
  assert.equal((await request('POST', `/v1/suites/${agentName}`, suite, undefined, 'reviewer')).statusCode, 201);
  const evaluation = await request('POST', '/v1/evaluations', { ref: `${agentName}@1.0.0` }, `e2e-evaluation-${agentName}`, 'developer');
  assert.equal(evaluation.statusCode, 202);
  const evaluationJob = await waitJob((await evaluation.json()).id);
  assert.equal(evaluationJob.state, 'completed');
  assert.equal(evaluationJob.result.passed, true);
  assert.equal((await request('POST', '/v1/approvals', { ref: `${agentName}@1.0.0`, reason: 'independent e2e approval' }, undefined, 'reviewer')).statusCode, 200);
  assert.equal((await request('POST', `/v1/deployments/${agentName}`, { ref: `${agentName}@1.0.0`, channel: 'production', reason: 'e2e rollout' }, undefined, 'publisher')).statusCode, 200);
  const run = await request('POST', '/v1/runs', { name: agentName, channel: 'production', prompt: 'hello' }, `e2e-run-${agentName}`, 'operator');
  assert.equal(run.statusCode, 202);
  const result = await waitJob((await run.json()).id);
  assert.equal(result.state, 'completed');
  const session = await env.db.session('e2e', result.session);
  assert.equal(session.kind, 'run');
  const events = await env.db.read('e2e', result.session);
  assert.ok(events.some((event) => event.type === 'run.provenance'));
  assert.ok(events.some((event) => event.type === 'turn/end'));
  const artifact = await env.db.get('e2e', 'spec', `${agentName}@1.0.0`);
  assert.ok(artifact);
  assert.equal((await env.objectStore.head(`tenants/e2e/artifacts/${agentName}@1.0.0/${artifact.digest}.json`)).$metadata.httpStatusCode, 200);
  console.log(`PostgreSQL business E2E passed: ${events.length} events, job ${result.id}`);
} finally {
  await env.app.close();
  await queue.close();
}
