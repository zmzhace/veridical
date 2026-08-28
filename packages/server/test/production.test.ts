import { afterEach, beforeEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { buildProductionApp } from '../src/production/app';
import { ProductionConfigSchema } from '../src/production/config';
import { Ledger } from '../src/production/database';
import { tokenDigest, type Principal } from '../src/production/contracts';
import type { LLMRequest, LLMResponse } from '@veridical/llm';
import { safeTools } from '../src/production/runner';

let dir: string;
let env: Awaited<ReturnType<typeof buildProductionApp>>;
let answer: (req: LLMRequest) => Promise<LLMResponse>;
let requests: LLMRequest[];
const dataKey = randomBytes(32),
  auditKey = randomBytes(32);
const tokens = Object.fromEntries(
  ['developer', 'reviewer', 'publisher', 'operator', 'viewer', 'admin', 'foreign', 'expired'].map(
    (role) => [role, randomBytes(32).toString('hex')],
  ),
);
const principal = (role: string): Principal => ({
  tenant: role === 'foreign' ? 'other' : 'acme',
  actor: role,
  roles: [role === 'foreign' ? 'admin' : (role as any)],
  tokenHash: tokenDigest(tokens[role]),
});
const reply = (text = 'OK'): LLMResponse => ({
  text,
  usage: { input: 2, output: 1, cached: 0, total: 3 },
});
const yaml = (version = '1.0.0', access = 'allow', steps = 3) =>
  `name: probe\nversion: ${version}\nschema_version: 1\ninstruction: {system: Be useful}\nflow: {mode: single-loop, max_steps: ${steps}}\nllm: {provider: fixture, model: fixture-model}\ntools: [{name: echo, access: ${access}}, {name: finish, access: allow}]`;
const suite = (contains = 'OK') => ({
  name: 'acceptance',
  cases: [1, 2, 3].map((i) => ({ input: `heldout-secret-${i}`, contains: [contains] })),
});
const request = (role: string, method: any, url: string, payload?: any, key?: string) =>
  env.app.inject({
    method,
    url,
    payload,
    headers: {
      authorization: `Bearer ${tokens[role]}`,
      ...(key ? { 'idempotency-key': key } : {}),
    },
  });
async function drain(id: string, tenant = 'acme') {
  for (let i = 0; i < 500; i++) {
    env.service.kick();
    const job = env.db.job(tenant, id)!;
    if (!['queued', 'running'].includes(job.state)) return job;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('job did not terminate');
}
async function publish(version = '1.0.0', spec = yaml(version)) {
  env.service.createSpec(principal('developer'), spec);
  if (!env.db.pointer('acme', 'suite', 'probe'))
    env.service.setSuite(principal('reviewer'), 'probe', suite());
  const evaluation = env.service.evaluate(
    principal('developer'),
    `probe@${version}`,
    `evaluate_${version}`,
  );
  expect(await drain(evaluation.id)).toMatchObject({
    state: 'completed',
    result: { passed: true },
  });
  env.service.approve(principal('reviewer'), `probe@${version}`, 'independent review completed');
  env.service.deploy(
    principal('publisher'),
    'probe',
    `probe@${version}`,
    'production',
    'approved rollout',
  );
}
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'veridical-production-test-'));
  requests = [];
  answer = async () => reply();
  const config = ProductionConfigSchema.parse({
    database: join(dir, 'ledger.db'),
    releaseId: 'test-release-1',
    dataKeyEnv: 'DATA_KEY',
    auditKeyEnv: 'AUDIT_KEY',
    requestsPerMinute: 1000,
    tokens: Object.entries(tokens).map(([role, token]) => ({
      hash: tokenDigest(token),
      tenant: role === 'foreign' ? 'other' : 'acme',
      actor: role,
      roles: [role === 'foreign' || role === 'expired' ? 'admin' : role],
      expires: role === 'expired' ? '2000-01-01T00:00:00Z' : '2099-01-01T00:00:00Z',
    })),
    providers: [
      {
        name: 'fixture',
        model: 'fixture-model',
        version: 'model-v1',
        baseUrl: 'https://provider.invalid/v1',
        apiKeyEnv: 'FIXTURE_KEY',
      },
    ],
  });
  env = await buildProductionApp({
    config,
    dataKey,
    auditKey,
    worker: false,
    logger: false,
    tools: safeTools.map((t) => ({ ...t })),
    providers: new Map([
      [
        'fixture',
        {
          complete: async (req) => {
            requests.push(req);
            return answer(req);
          },
        },
      ],
    ]),
  });
});
afterEach(async () => {
  await env?.app.close();
  rmSync(dir, { recursive: true, force: true });
});

test('production is authenticated, has no research routes, and never trusts a caller tenant', async () => {
  expect((await env.app.inject('/health/live')).statusCode).toBe(200);
  expect((await env.app.inject('/health/ready')).statusCode).toBe(401);
  expect((await request('expired', 'GET', '/v1/me')).statusCode).toBe(401);
  expect((await request('viewer', 'GET', '/api/specs')).statusCode).toBe(404);
  expect((await request('viewer', 'POST', '/v1/specs', { yaml: yaml() })).statusCode).toBe(403);
  expect(
    (await request('developer', 'POST', '/v1/specs', { yaml: yaml(), tenant: 'other' })).statusCode,
  ).toBe(400);
  const response = await request('viewer', 'GET', '/v1/me');
  expect(response.json()).toMatchObject({ tenant: 'acme', actor: 'viewer' });
  expect(response.headers['access-control-allow-origin']).toBeUndefined();
  expect(response.headers['cache-control']).toBe('no-store');
});
test('revoked tokens remain revoked and admin cannot revoke another tenant token', async () => {
  expect(
    (
      await request('admin', 'POST', '/v1/tokens/revoke', {
        hash: tokenDigest(tokens.foreign),
        reason: 'revoke external token',
      })
    ).statusCode,
  ).toBe(404);
  expect(
    (
      await request('admin', 'POST', '/v1/tokens/revoke', {
        hash: tokenDigest(tokens.viewer),
        reason: 'credential compromised',
      })
    ).statusCode,
  ).toBe(200);
  expect((await request('viewer', 'GET', '/v1/me')).statusCode).toBe(401);
  expect(env.db.read('acme', '_audit').some((e) => e.type === 'token.revoked')).toBe(true);
});
test('publication requires evidence, independent reviewer and publisher; versions are immutable', async () => {
  expect((await request('developer', 'POST', '/v1/specs', { yaml: yaml() })).statusCode).toBe(201);
  expect((await request('developer', 'POST', '/v1/specs', { yaml: yaml() })).statusCode).toBe(409);
  expect(
    (
      await request('publisher', 'POST', '/v1/deployments/probe', {
        ref: 'probe@1.0.0',
        reason: 'try unevaluated release',
      })
    ).statusCode,
  ).toBe(409);
  expect(
    (
      await request('reviewer', 'POST', '/v1/approvals', {
        ref: 'probe@1.0.0',
        reason: 'no evidence available',
      })
    ).statusCode,
  ).toBe(409);
  expect(
    (await request('reviewer', 'POST', '/v1/suites/probe', { name: 'empty', cases: [] }))
      .statusCode,
  ).toBe(400);
  env.service.setSuite(principal('reviewer'), 'probe', suite());
  const job = env.service.evaluate(principal('developer'), 'probe@1.0.0', 'evaluation-key');
  expect((await drain(job.id)).result.passed).toBe(true);
  expect(() =>
    env.service.approve(
      { ...principal('reviewer'), actor: 'developer' },
      'probe@1.0.0',
      'self review',
    ),
  ).toThrow('independent_reviewer_required');
  expect(
    (
      await request('reviewer', 'POST', '/v1/approvals', {
        ref: 'probe@1.0.0',
        reason: 'independent review done',
      })
    ).statusCode,
  ).toBe(200);
  expect(
    (
      await request('developer', 'POST', '/v1/deployments/probe', {
        ref: 'probe@1.0.0',
        reason: 'cannot self publish',
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await request('publisher', 'POST', '/v1/deployments/probe', {
        ref: 'probe@1.0.0',
        reason: 'release approved evidence',
      })
    ).statusCode,
  ).toBe(200);
});
test('failed evaluation, changed suite and changed runtime invalidate release eligibility', async () => {
  env.service.createSpec(principal('developer'), yaml());
  env.service.setSuite(principal('reviewer'), 'probe', suite('MISSING'));
  const job = env.service.evaluate(principal('developer'), 'probe@1.0.0', 'bad-evaluation');
  expect((await drain(job.id)).result.passed).toBe(false);
  expect(() =>
    env.service.approve(principal('reviewer'), 'probe@1.0.0', 'review failing run'),
  ).toThrow('current_passing_evaluation_required');
  env.service.setSuite(principal('reviewer'), 'probe', suite());
  await publish('1.0.1');
  env.service.config.releaseId = 'changed-runtime';
  expect(() => env.service.assertApproved('acme', 'probe@1.0.1')).toThrow(
    'release_not_approved_for_environment',
  );
  env.service.config.releaseId = 'test-release-1';
  env.service.setSuite(principal('reviewer'), 'probe', suite());
  expect(() => env.service.assertApproved('acme', 'probe@1.0.1')).toThrow(
    'release_acceptance_suite_changed',
  );
});
test('idempotent API execution, tenant isolation and pinned sessions', async () => {
  await publish();
  const body = { name: 'probe', prompt: 'customer confidential input' };
  const a = await request('operator', 'POST', '/v1/runs', body, 'unique-run-key');
  const b = await request('operator', 'POST', '/v1/runs', body, 'unique-run-key');
  expect(a.statusCode).toBe(202);
  expect(b.json().id).toBe(a.json().id);
  expect(
    (
      await request(
        'operator',
        'POST',
        '/v1/runs',
        { ...body, prompt: 'different' },
        'unique-run-key',
      )
    ).statusCode,
  ).toBe(409);
  const job = await drain(a.json().id);
  expect(job.state).toBe('completed');
  expect((await request('foreign', 'GET', `/v1/jobs/${job.id}`)).statusCode).toBe(404);
  expect((await request('foreign', 'GET', `/v1/sessions/${job.session}/events`)).statusCode).toBe(
    404,
  );
  expect((await request('foreign', 'GET', '/v1/specs')).json()).toEqual([]);
  expect(
    (await request('viewer', 'GET', `/v1/sessions/${job.session}/events`))
      .json()
      .some((e: any) => e.type === 'llm.request'),
  ).toBe(true);
  expect(
    (await request('viewer', 'GET', `/v1/sessions/${job.session}/integrity`)).json().seq,
  ).toBeGreaterThan(5);
  await publish('1.0.1');
  expect(
    (
      await request(
        'operator',
        'POST',
        '/v1/runs',
        { ...body, session: job.session },
        'pinned-session-key',
      )
    ).statusCode,
  ).toBe(409);
});
test('tool observations feed the next model request and history is recorded once', async () => {
  await publish();
  let count = 0;
  requests = [];
  answer = async () =>
    reply(
      ++count === 1
        ? JSON.stringify({ tool: { name: 'echo', args: { observation: 'unique-tool-result' } } })
        : 'OK',
    );
  const job = env.service.run(
    principal('operator'),
    { name: 'probe', channel: 'production', prompt: 'one user turn' },
    'tool-loop-key',
  );
  expect((await drain(job.id)).state).toBe('completed');
  expect(JSON.stringify(requests[1].messages)).toContain('unique-tool-result');
  const events = env.db.read('acme', job.session);
  expect(events.filter((e) => e.type === 'user.message')).toHaveLength(1);
  expect(events.filter((e) => e.type === 'tool.called')[0].call_id).toBe(
    events.filter((e) => e.type === 'tool.result')[0].call_id,
  );
  expect(events.find((e) => e.type === 'run.provenance')?.payload).toMatchObject({
    spec_digest: env.service.spec('acme', 'probe@1.0.0').digest,
  });
});
test('denied tools and malformed output fail closed with error evidence', async () => {
  await publish('1.0.0', yaml('1.0.0', 'deny'));
  for (const [i, text] of [
    '{"tool":{"name":"echo","args":{}}}',
    '{"not_a_decision":true}',
    '{invalid',
  ].entries()) {
    answer = async () => reply(text);
    const job = env.service.run(
      principal('operator'),
      { name: 'probe', channel: 'production', prompt: 'test' },
      `invalid-output-${i}`,
    );
    expect((await drain(job.id)).state).toBe('failed');
    expect(env.db.read('acme', job.session).some((e) => e.verb === 'error')).toBe(true);
  }
});
test('cancellation fences late provider responses and overlapping sessions', async () => {
  await publish();
  let release!: (value: LLMResponse) => void;
  answer = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const job = env.service.run(
    principal('operator'),
    { name: 'probe', channel: 'production', prompt: 'pending' },
    'pending-run-key',
  );
  while (!release) await new Promise((resolve) => setTimeout(resolve, 1));
  expect(() =>
    env.service.run(
      principal('operator'),
      { name: 'probe', channel: 'production', prompt: 'overlap', session: job.session },
      'overlap-run-key',
    ),
  ).toThrow('session_busy');
  env.service.cancel(principal('operator'), job.id);
  const count = env.db.read('acme', job.session).length;
  release(reply());
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(env.db.job('acme', job.id)?.state).toBe('cancelled');
  expect(env.db.read('acme', job.session)).toHaveLength(count);
  expect(env.db.read('acme', job.session).at(-1)?.type).toBe('job.cancelled');
});
test('revoking a release stops in-flight work before another tool can run', async () => {
  await publish();
  let release!: (value: LLMResponse) => void;
  answer = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const job = env.service.run(
    principal('operator'),
    { name: 'probe', channel: 'production', prompt: 'pending' },
    'revoked-run-key',
  );
  while (!release) await new Promise((resolve) => setTimeout(resolve, 1));
  env.service.revoke(principal('reviewer'), 'probe@1.0.0', 'emergency stop');
  release(reply('{"tool":{"name":"echo","args":{}}}'));
  expect((await drain(job.id)).state).toBe('failed');
  expect(env.db.read('acme', job.session).some((e) => e.type === 'tool.called')).toBe(false);
  expect(() =>
    env.service.run(
      principal('operator'),
      { name: 'probe', channel: 'production', prompt: 'blocked' },
      'revoked-again',
    ),
  ).toThrow('release_not_approved_for_environment');
});
test('controlled improvement generates and evaluates a candidate but cannot publish itself', async () => {
  await publish();
  requests = [];
  answer = async (req) =>
    reply(
      JSON.stringify(req.messages).includes('Propose an improved system instruction')
        ? '{"system":"Improved instruction preserving safety"}'
        : 'OK',
    );
  const job = env.service.improve(
    principal('developer'),
    'probe',
    '1.1.0',
    'improve clarity',
    'improvement-key',
  );
  const result = await drain(job.id);
  expect(result.state).toBe('completed');
  expect((await drain(result.result.evaluation_job)).result.passed).toBe(true);
  const candidate = env.service.spec('acme', 'probe@1.1.0');
  expect(candidate.status).toBe('evaluated');
  expect(candidate.meta.baseline).toBe('probe@1.0.0');
  expect(candidate.body.tools).toEqual(env.service.spec('acme', 'probe@1.0.0').body.tools);
  expect(env.db.pointer('acme', 'deployment', 'production.probe')).toBe('probe@1.0.0');
  expect(JSON.stringify(requests[0].messages)).not.toContain('heldout-secret');
  expect(() =>
    env.service.deploy(
      principal('publisher'),
      'probe',
      'probe@1.1.0',
      'production',
      'skip candidate review',
    ),
  ).toThrow('release_not_approved_for_environment');
});
test('audit data encrypted at rest; backup reopens and append-only guards reject tampering', async () => {
  await publish();
  const job = env.service.run(
    principal('operator'),
    { name: 'probe', channel: 'production', prompt: 'VERY_PRIVATE_CUSTOMER_STRING' },
    'encrypted-run-key',
  );
  await drain(job.id);
  expect(() =>
    env.db.sql.prepare("UPDATE events SET blob='bad' WHERE tenant='acme'").run(),
  ).toThrow('immutable events');
  expect(() => env.db.sql.prepare("DELETE FROM events WHERE tenant='acme'").run()).toThrow(
    'immutable events',
  );
  expect(() =>
    env.db.sql.prepare("UPDATE artifacts SET blob='bad' WHERE tenant='acme'").run(),
  ).toThrow('immutable artifact');
  const checkpoint = env.db.verify('acme', job.session);
  const backup = join(dir, 'backup.db');
  await env.db.backup(backup);
  expect(readFileSync(backup).includes(Buffer.from('VERY_PRIVATE_CUSTOMER_STRING'))).toBe(false);
  const restored = new Ledger(backup, dataKey, auditKey);
  expect(restored.verify('acme', job.session, checkpoint)).toEqual(checkpoint);
  restored.close();
  expect(() => new Ledger(backup, randomBytes(32), auditKey)).toThrow();
  env.db.sql.exec('DROP TRIGGER events_no_update');
  env.db.sql
    .prepare("UPDATE events SET blob='bad' WHERE tenant=? AND session=? AND seq=1")
    .run('acme', job.session);
  expect(() => env.db.verify('acme', job.session)).toThrow('broken audit chain');
});
test('guarded profile rejects unsupported or undeclared tools and unknown model configuration', async () => {
  for (const spec of [
    yaml().replace('name: echo', 'name: shell'),
    yaml().replace('access: allow', 'access: ask'),
    yaml().replace('fixture-model', 'arbitrary-model'),
  ]) {
    expect((await request('developer', 'POST', '/v1/specs', { yaml: spec })).statusCode).toBe(422);
  }
});
test('production replay verifies the checkpoint and reproduces history with zero live calls', async () => {
  await publish();
  let count = 0;
  answer = async () =>
    reply(++count === 1 ? '{"tool":{"name":"echo","args":{"value":"recorded"}}}' : 'OK');
  const source = env.service.run(
    principal('operator'),
    { name: 'probe', channel: 'production', prompt: 'replay this' },
    'replay-source-key',
  );
  await drain(source.id);
  const continued = env.service.run(
    principal('operator'),
    { name: 'probe', channel: 'production', prompt: 'second turn', session: source.session },
    'replay-second-key',
  );
  await drain(continued.id);
  answer = async () => {
    throw new Error('replay must not call live models');
  };
  const before = requests.length;
  const response = await request(
    'operator',
    'POST',
    '/v1/replays',
    { session: source.session },
    'replay-check-key',
  );
  expect(response.statusCode).toBe(202);
  const replay = await drain(response.json().id);
  expect(replay).toMatchObject({
    state: 'completed',
    result: { matched: true, external_calls: 0 },
  });
  expect(requests).toHaveLength(before);
  expect(replay.session).not.toBe(source.session);
});
test('expired deadline terminates a provider that ignores abort', async () => {
  env.service.config.timeoutMs = 1000;
  await publish();
  answer = () => new Promise(() => {});
  const job = env.service.run(
    principal('operator'),
    { name: 'probe', channel: 'production', prompt: 'hang' },
    'timeout-run-key',
  );
  expect((await drain(job.id)).state).toBe('failed');
  expect(env.db.read('acme', job.session).at(-1)?.type).toBe('job.failed');
});
test('token revocation also fences an already running job', async () => {
  await publish();
  let release!: (value: LLMResponse) => void;
  answer = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const job = env.service.run(
    principal('operator'),
    { name: 'probe', channel: 'production', prompt: 'pending' },
    'token-fenced-key',
  );
  while (!release) await new Promise((resolve) => setTimeout(resolve, 1));
  await request('admin', 'POST', '/v1/tokens/revoke', {
    hash: tokenDigest(tokens.operator),
    reason: 'compromised credential',
  });
  release(reply('{"tool":{"name":"echo","args":{}}}'));
  expect((await drain(job.id)).state).toBe('failed');
  expect(env.db.read('acme', job.session).some((e) => e.type === 'tool.called')).toBe(false);
});
test('rollback and canary use independently approved immutable versions', async () => {
  await publish();
  await publish('1.0.1');
  env.service.deploy(
    principal('publisher'),
    'probe',
    'probe@1.0.0',
    'production',
    'roll back to known release',
  );
  env.service.deploy(
    principal('publisher'),
    'probe',
    'probe@1.0.1',
    'canary',
    'explicit opt-in canary',
  );
  expect(env.db.pointer('acme', 'deployment', 'production.probe')).toBe('probe@1.0.0');
  expect(env.db.pointer('acme', 'deployment', 'canary.probe')).toBe('probe@1.0.1');
  expect(() =>
    env.service.evaluate(principal('developer'), 'probe@1.0.0', 'mutate-evidence-key'),
  ).toThrow('immutable_release_requires_new_version');
});
test('invalid tool arguments and structured failures produce paired failed results', async () => {
  await publish();
  env.service.tools[0].schema = z.object({ required: z.string() }).strict();
  answer = async () => reply('{"tool":{"name":"echo","args":{}}}');
  const invalid = env.service.run(
    principal('operator'),
    { name: 'probe', channel: 'production', prompt: 'invalid' },
    'invalid-args-key',
  );
  expect((await drain(invalid.id)).state).toBe('failed');
  const events = env.db.read('acme', invalid.session);
  expect(events.find((e) => e.type === 'tool.result')).toMatchObject({
    verb: 'error',
    call_id: events.find((e) => e.type === 'tool.called')?.call_id,
  });
  env.service.tools[0].schema = z.unknown();
  env.service.tools[0].execute = async () => ({ ok: false });
  const failed = env.service.run(
    principal('operator'),
    { name: 'probe', channel: 'production', prompt: 'failed' },
    'structured-failure-key',
  );
  expect((await drain(failed.id)).state).toBe('failed');
});
test('stage gates require ordered tools and survive a successful strict replay', async () => {
  const staged = yaml().replace(
    'flow: {mode: single-loop, max_steps: 3}',
    'flow: {mode: stage-gate, max_steps: 3, stages: [{id: first, gate: {tool_called: echo}}, {id: second, gate: {tool_called: finish}}]}',
  );
  let count = 0;
  answer = async () =>
    reply(
      JSON.stringify({ text: 'OK', tool: { name: ++count % 2 ? 'echo' : 'finish', args: {} } }),
    );
  await publish('1.0.0', staged);
  const source = env.service.run(
    principal('operator'),
    { name: 'probe', channel: 'production', prompt: 'staged' },
    'staged-run-key',
  );
  expect((await drain(source.id)).state).toBe('completed');
  const replay = env.service.replay(principal('operator'), source.session, 'staged-replay-key');
  expect(await drain(replay.id)).toMatchObject({ state: 'completed', result: { matched: true } });
  answer = async () => reply('{"tool":{"name":"finish","args":{}}}');
  const bypass = env.service.run(
    principal('operator'),
    { name: 'probe', channel: 'production', prompt: 'skip first' },
    'staged-bypass-key',
  );
  expect((await drain(bypass.id)).state).toBe('failed');
  expect(env.db.read('acme', bypass.session).some((e) => e.type === 'stage/end')).toBe(false);
});
test('unknown policy fields are rejected rather than silently stripped', async () => {
  for (const spec of [
    yaml() + '\nunknown_policy: allow',
    yaml().replace('max_steps: 3', 'max_steps: 3, dangerous: true'),
  ]) {
    expect((await request('developer', 'POST', '/v1/specs', { yaml: spec })).statusCode).toBe(400);
  }
});
test('storage pressure rejects new work and readiness but preserves emergency revocation', async () => {
  await publish();
  env.service.config.minFreeDiskBytes = Number.MAX_SAFE_INTEGER;
  expect(
    (
      await request(
        'operator',
        'POST',
        '/v1/runs',
        { name: 'probe', prompt: 'capacity' },
        'storage-full-key',
      )
    ).statusCode,
  ).toBe(507);
  expect((await request('admin', 'GET', '/health/ready')).statusCode).toBe(507);
  expect(
    (
      await request('reviewer', 'POST', '/v1/revocations', {
        ref: 'probe@1.0.0',
        reason: 'emergency revoke',
      })
    ).statusCode,
  ).toBe(200);
});
test('provider faults never get silently approved and caller receives a sanitized error', async () => {
  await publish();
  answer = async () => {
    throw new Error('sensitive-provider-diagnostic');
  };
  const response = await request(
    'operator',
    'POST',
    '/v1/runs',
    { name: 'probe', prompt: 'failed provider' },
    'provider-failure-key',
  );
  const job = await drain(response.json().id);
  expect(job.state).toBe('failed');
  const status = await request('operator', 'GET', `/v1/jobs/${job.id}`);
  expect(status.body).not.toContain('sensitive-provider-diagnostic');
  expect(env.db.read('acme', job.session).find((e) => e.type === 'llm.response')?.verb).toBe(
    'error',
  );
});
test('retrying completed improvement returns its original idempotent job', async () => {
  await publish();
  answer = async (req) =>
    reply(
      JSON.stringify(req.messages).includes('Propose an improved system instruction')
        ? '{"system":"new system"}'
        : 'OK',
    );
  const job = env.service.improve(
    principal('developer'),
    'probe',
    '2.0.0',
    'clearer',
    'retry-improvement-key',
  );
  await drain(job.id);
  expect(
    env.service.improve(
      principal('developer'),
      'probe',
      '2.0.0',
      'clearer',
      'retry-improvement-key',
    ).id,
  ).toBe(job.id);
});
