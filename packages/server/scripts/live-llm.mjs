import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ledger } from '../src/production/database.ts';
import { ProductionConfigSchema } from '../src/production/config.ts';
import { executeTurn, safeTools, SecureProvider, validateSpec } from '../src/production/runner.ts';
import { replayRecorded } from '../src/production/replay.ts';

// Explicit opt-in interactive development check. No listener, scheduler, live
// deployment or production approval is created. Never invoked by `pnpm test`.
process.umask(0o077);
const key = process.env.VERIDICAL_PROVIDER_KEY;
const baseUrl = process.env.VERIDICAL_LLM_BASE_URL;
const model = process.env.VERIDICAL_LLM_MODEL;
if (!key || !baseUrl || !model)
  throw new Error('local provider key, base URL and model are required in .env.local');
const thinking = process.env.VERIDICAL_LLM_ENABLE_THINKING;
if (thinking !== undefined && !['true', 'false'].includes(thinking))
  throw new Error('VERIDICAL_LLM_ENABLE_THINKING must be true or false');
const enableThinking = thinking === undefined ? undefined : thinking === 'true';
const maxOutputTokens = Number(process.env.VERIDICAL_LLM_MAX_OUTPUT_TOKENS ?? 1024);
const temp = mkdtempSync(join(tmpdir(), 'veridical-local-live-'));
const directory = fileURLToPath(
  new URL(`../../../.traces/live-${Date.now()}-${randomUUID()}/`, import.meta.url),
);
mkdirSync(directory, { recursive: true, mode: 0o700 });
const config = ProductionConfigSchema.parse({
  database: join(temp, 'ledger.db'),
  releaseId: 'local-interactive-test',
  dataKeyEnv: 'LOCAL_DATA_KEY',
  auditKeyEnv: 'LOCAL_AUDIT_KEY',
  tokens: [
    {
      hash: randomBytes(32).toString('hex'),
      tenant: 'local',
      actor: 'local-test',
      roles: ['operator'],
      expires: '2099-01-01T00:00:00Z',
    },
  ],
  providers: [
    {
      name: 'local',
      model,
      version: 'local-alias-unpinned',
      baseUrl,
      apiKeyEnv: 'VERIDICAL_PROVIDER_KEY',
      enableThinking,
    },
  ],
  maxOutputTokens,
});
const db = new Ledger(config.database, randomBytes(32), randomBytes(32));
const marker = 'VERIDICAL_LIVE_OK';
let currentJob, heartbeat;
const controller = new AbortController();
const deadline = setTimeout(() => controller.abort(new Error('live_test_deadline')), 45000);
const started = Date.now();
let requests = 0;
const report = {
  mode: 'local-interactive-development',
  model,
  base_url: baseUrl,
  model_version_pinned: false,
  passed: false,
};
const safeWrite = (name, value) =>
  writeFileSync(
    join(directory, name),
    JSON.stringify(value, null, 2).replaceAll(key, '[REDACTED]') + '\n',
    { flag: 'wx', mode: 0o600 },
  );
const claim = () => {
  currentJob = db.claim('local-cli', 60000, 1);
  assert.ok(currentJob);
  heartbeat = setInterval(() => {
    try {
      db.heartbeat(currentJob);
    } catch {
      controller.abort(new Error('execution_fenced'));
    }
  }, 1000);
  return currentJob;
};
try {
  const spec = validateSpec(
    {
      name: 'local-llm-check',
      version: '1.0.0',
      schema_version: 1,
      instruction: {
        system: `You are executing a local software integration test. On the first response call echo exactly once with args {"text":"${marker}"}; omit done or set it false. After receiving that tool observation, return {"text":"${marker}","done":true} without another tool call. Return only one JSON object per response; never Markdown fences.`,
      },
      flow: { mode: 'single-loop', max_steps: 2 },
      llm: { provider: 'local', model },
      tools: [{ name: 'echo', access: 'allow' }],
    },
    config,
    safeTools,
  );
  const ref = `${spec.name}@${spec.version}`;
  db.put('local', 'spec', ref, spec, 'local-test');
  db.enqueue('local', 'local-test', 'run', 'live-local-check', { ref });
  const source = claim();
  const provider = new SecureProvider(baseUrl, key, model, { enableThinking });
  const bounded = {
    complete: async (req) => {
      if (++requests > 2) throw new Error('live_call_budget_exceeded');
      return provider.complete(req);
    },
  };
  console.log('Running local LLM → read-only echo → LLM check (maximum two live calls).');
  const result = await executeTurn({
    ledger: db,
    job: source,
    session: source.session,
    spec,
    config,
    providers: new Map([['local', bounded]]),
    tools: safeTools,
    signal: controller.signal,
    input: 'Execute the two-step local integration check.',
    checkRelease: () => {},
  });
  const events = db.read('local', source.session);
  assert.equal(result.status, 'completed');
  assert.equal(result.outcome, marker);
  assert.equal(events.filter((e) => e.type === 'llm.request').length, 2);
  assert.equal(events.filter((e) => e.type === 'tool.result' && e.verb === 'response').length, 1);
  assert.ok(!events.some((e) => e.verb === 'error'));
  db.finish(source, 'completed', result);
  clearInterval(heartbeat);
  const checkpoint = db.verify('local', source.session);
  const usage = events
    .filter((e) => e.type === 'llm.response')
    .reduce(
      (sum, e) => ({
        input: sum.input + (e.tokens?.input ?? 0),
        output: sum.output + (e.tokens?.output ?? 0),
        total: sum.total + (e.tokens?.total ?? 0),
      }),
      { input: 0, output: 0, total: 0 },
    );
  safeWrite('trace.json', db.read('local', source.session));
  safeWrite('spec.json', spec);
  db.enqueue('local', 'local-test', 'replay', 'local-replay-check', {
    ref,
    source: source.session,
    checkpoint,
  });
  const replayJob = claim();
  const replay = await replayRecorded({
    db,
    job: replayJob,
    spec,
    config,
    tools: safeTools,
    signal: controller.signal,
    check: () => {},
  });
  db.finish(replayJob, 'completed', replay);
  safeWrite('replay.json', db.read('local', replayJob.session));
  Object.assign(report, {
    passed: true,
    live_calls: requests,
    usage,
    tool_calls: 1,
    outcome: marker,
    trace_integrity_verified: true,
    replay_matched: replay.matched,
    replay_external_calls: replay.external_calls,
  });
} catch (error) {
  const code = error?.code ?? error?.message;
  report.error =
    typeof code === 'string' && /^[a-zA-Z0-9_.-]{1,100}$/.test(code) ? code : 'live_check_failed';
  if (currentJob) {
    db.finish(currentJob, 'failed', { code: report.error });
    safeWrite('failed-trace.json', db.read('local', currentJob.session));
  }
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  clearInterval(heartbeat);
  Object.assign(report, {
    elapsed_ms: Date.now() - started,
    live_calls: requests,
    artifacts: directory,
  });
  safeWrite('summary.json', report);
  console.log(JSON.stringify(report, null, 2));
  db.close();
  rmSync(temp, { recursive: true, force: true });
}
