import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { buildProductionApp } from '../src/production/app.ts';
import { ProductionConfigSchema } from '../src/production/config.ts';
import { SecureProvider, safeTools } from '../src/production/runner.ts';
import { RedisJobQueue } from '../src/production/redis-queue.ts';

if (process.env.VERIDICAL_RUN_LIVE_E2E !== '1')
  throw new Error('set VERIDICAL_RUN_LIVE_E2E=1 to authorize billable live Qwen calls');
const baseUrl = process.env.VERIDICAL_LLM_BASE_URL;
const model = process.env.VERIDICAL_LLM_MODEL;
const apiKey = process.env.VERIDICAL_PROVIDER_KEY;
if (!baseUrl || !model || !apiKey) throw new Error('VERIDICAL_PROVIDER_KEY, VERIDICAL_LLM_BASE_URL and VERIDICAL_LLM_MODEL are required');
const postgres = process.env.VERIDICAL_POSTGRES_URL ?? 'postgres://veridical:veridical-dev-only@127.0.0.1:5432/veridical';
const redis = process.env.VERIDICAL_REDIS_URL ?? 'redis://127.0.0.1:6379';
const s3Endpoint = process.env.VERIDICAL_S3_ENDPOINT ?? 'http://127.0.0.1:9000';
process.env.LIVE_S3_ACCESS ??= process.env.VERIDICAL_S3_ACCESS_KEY ?? 'veridical';
process.env.LIVE_S3_SECRET ??= process.env.VERIDICAL_S3_SECRET_KEY ?? 'veridical-dev-only';
const tokenValues = Object.fromEntries(['developer', 'reviewer', 'publisher', 'operator'].map((role) => [role, randomBytes(32).toString('hex')]));
const token = (role) => ({ hash: createHash('sha256').update(tokenValues[role]).digest('hex'), tenant: 'live', actor: role, roles: [role], expires: '2099-01-01T00:00:00Z' });
const config = ProductionConfigSchema.parse({
  database: '/tmp/veridical-live-unused.db', releaseId: 'qwen-live-e2e-release', dataKeyEnv: 'LIVE_DATA', auditKeyEnv: 'LIVE_AUDIT',
  storage: { database: 'postgres', queue: 'redis', objectStore: 's3', postgresUrl: postgres, redisUrl: redis, s3Endpoint, s3Bucket: process.env.VERIDICAL_S3_BUCKET ?? 'veridical-artifacts', s3AccessKeyEnv: 'LIVE_S3_ACCESS', s3SecretKeyEnv: 'LIVE_S3_SECRET' },
  tokens: ['developer', 'reviewer', 'publisher', 'operator'].map(token), providers: [{ name: 'qwen', model, version: 'live-configured', baseUrl, apiKeyEnv: 'VERIDICAL_PROVIDER_KEY' }],
  timeoutMs: Number(process.env.VERIDICAL_LIVE_TIMEOUT_MS ?? 120000), maxOutputTokens: Number(process.env.VERIDICAL_LLM_MAX_OUTPUT_TOKENS ?? 512), requestsPerMinute: 1000,
});
const provider = new SecureProvider(baseUrl, apiKey, model, { enableThinking: process.env.VERIDICAL_LLM_ENABLE_THINKING === 'true' });
const queue = new RedisJobQueue(redis, `veridical:live:${Date.now()}`);
const env = await buildProductionApp({ config, dataKey: randomBytes(32), auditKey: randomBytes(32), providers: new Map([['qwen', provider]]), tools: safeTools, asyncJobs: queue, logger: false });
const request = (role, method, url, payload, idem) => env.app.inject({ method, url, payload, headers: { authorization: `Bearer ${tokenValues[role]}`, ...(idem ? { 'idempotency-key': idem } : {}) } });
const runs = Number(process.env.VERIDICAL_LIVE_E2E_RUNS ?? 3);
async function waitJob(id) { for (let i = 0; i < 1200; i += 1) { const job = await env.db.job('live', id); if (job && !['queued', 'running'].includes(job.state)) return job; await new Promise((resolve) => setTimeout(resolve, 100)); } throw new Error(`live job timeout: ${id}`); }
const name = `qwen${Date.now().toString().slice(-8)}`;
const yaml = `name: ${name}\nversion: 1.0.0\nschema_version: 1\ninstruction: {system: 'Return exactly a JSON response with text LIVE_OK and done true. Do not call tools.'}\nflow: {mode: single-loop, max_steps: 2}\nllm: {provider: qwen, model: ${model}}\ntools: []`;
try {
  const specResponse = await request('developer', 'POST', '/v1/specs', { yaml });
  if (specResponse.statusCode !== 201) console.error('live spec rejected', specResponse.statusCode, specResponse.body);
  assert.equal(specResponse.statusCode, 201);
  assert.equal((await request('reviewer', 'POST', `/v1/suites/${name}`, { name: 'acceptance', cases: [1, 2, 3].map((i) => ({ input: `live-${i}`, contains: ['LIVE_OK'] })) })).statusCode, 201);
  const evaluation = await request('developer', 'POST', '/v1/evaluations', { ref: `${name}@1.0.0` }, `live-eval-${name}`);
  assert.equal(evaluation.statusCode, 202);
  const evaluated = await waitJob((await evaluation.json()).id);
  assert.equal(evaluated.state, 'completed');
  assert.equal(evaluated.result.passed, true);
  assert.equal((await request('reviewer', 'POST', '/v1/approvals', { ref: `${name}@1.0.0`, reason: 'live independent review' })).statusCode, 200);
  assert.equal((await request('publisher', 'POST', `/v1/deployments/${name}`, { ref: `${name}@1.0.0`, channel: 'production', reason: 'live canary acceptance' })).statusCode, 200);
  const latencies = [];
  for (let i = 0; i < runs; i += 1) {
    const started = Date.now();
    const response = await request('operator', 'POST', '/v1/runs', { name, channel: 'production', prompt: `live-soak-${i}` }, `live-run-${name}-${i}`);
    assert.equal(response.statusCode, 202);
    const job = await waitJob((await response.json()).id);
    assert.equal(job.state, 'completed');
    latencies.push(Date.now() - started);
  }
  console.log(JSON.stringify({ passed: true, model, runs, evaluation: evaluated.id, latencies_ms: latencies, p95_ms: latencies.slice().sort((a, b) => a - b)[Math.min(latencies.length - 1, Math.ceil(latencies.length * 0.95) - 1)] }));
} finally { await env.app.close(); await queue.close(); }
