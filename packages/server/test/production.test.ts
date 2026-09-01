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
test('production capabilities expose only configured models and registered tools', async () => {
  const response = await request('viewer', 'GET', '/v1/capabilities');
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({
    models: [{ provider: 'fixture', model: 'fixture-model', configured: true }],
    tools: expect.arrayContaining([
      expect.objectContaining({ name: 'finish', approved: true }),
      expect.objectContaining({ name: 'echo', approved: true }),
    ]),
    mcp_servers: [],
    skills: [],
  });
});

test('production supervisor records an isolated child-agent invocation path', async () => {
  answer = async (req) => {
    const hasChildTask = req.messages.some((message) => message.content.includes('child-task'));
    const hasPriorAssistant = req.messages.some((message) => message.role === 'assistant');
    if (hasChildTask) return reply('child-result');
    if (!hasPriorAssistant)
      return reply(JSON.stringify({ delegate: 'researcher', task: 'child-task' }));
    return reply('parent-result');
  };
  const supervisor = `name: hub\nversion: 1.0.0\nschema_version: 1\ninstruction: {system: Delegate safely}\nflow: {mode: supervisor, max_steps: 4}\nllm: {provider: fixture, model: fixture-model}\ntools: [{name: finish, access: allow}]\nskills: []\nagents:\n  - name: researcher\n    inline:\n      instruction: {system: Return the child result}\n      llm: {provider: fixture, model: fixture-model}\n      tools: [{name: finish, access: allow}]`;
  env.service.createSpec(principal('developer'), supervisor);
  env.service.setSuite(principal('reviewer'), 'hub', suite('child-result'));
  const evaluation = env.service.evaluate(principal('developer'), 'hub@1.0.0', 'evaluate-hub');
  expect(await drain(evaluation.id)).toMatchObject({
    state: 'completed',
    result: { passed: true },
  });
  env.service.approve(principal('reviewer'), 'hub@1.0.0', 'supervisor review');
  env.service.deploy(
    principal('publisher'),
    'hub',
    'hub@1.0.0',
    'production',
    'supervisor rollout',
  );
  const job = env.service.run(
    principal('operator'),
    { name: 'hub', channel: 'production', prompt: 'delegate this' },
    'supervisor-run',
  );
  expect(await drain(job.id)).toMatchObject({ state: 'completed' });
  const events = env.db.read('acme', job.session);
  expect(events.some((event) => event.path === 'root/delegate:researcher')).toBe(true);
  expect(events.some((event) => event.type === 'agent.result')).toBe(true);
  const replay = await request(
    'operator',
    'POST',
    '/v1/replay',
    { session: job.session },
    'supervisor-replay',
  );
  expect(replay.statusCode).toBe(202);
  expect((await drain(replay.json().id)).result).toMatchObject({
    mode: 'strict',
    identical: true,
    degraded: false,
  });
});
test('production model profile never exposes browser credentials', async () => {
  const response = await request('viewer', 'GET', '/v1/model-profile');
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({
    configured: true,
    provider: 'fixture',
    model: 'fixture-model',
    source: 'server',
  });
  expect(JSON.stringify(response.json())).not.toContain('FIXTURE_KEY');
});
test('knowledge backends are versioned capabilities and require approval', async () => {
  const created = await request('developer', 'POST', '/v1/knowledge/backends', {
    name: 'project-index',
    version: '1.0.0',
    type: 'native',
    config_hash: 'a'.repeat(64),
    capabilities: ['search'],
  });
  expect(created.statusCode).toBe(201);
  expect(created.json()).toMatchObject({
    id: 'project-index@1.0.0',
    status: 'draft',
  });
  const capabilityList = await request('viewer', 'GET', '/v1/capabilities');
  expect(capabilityList.json().knowledge_backends).toEqual([]);
  expect(
    (
      await request('reviewer', 'POST', '/v1/knowledge/backends/project-index@1.0.0/decision', {
        status: 'approved',
      })
    ).statusCode,
  ).toBe(200);
  const listed = await request('viewer', 'GET', '/v1/knowledge/backends');
  expect(listed.json()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: 'project-index@1.0.0', status: 'approved' }),
    ]),
  );
  expect((await request('viewer', 'GET', '/v1/capabilities')).json().knowledge_backends).toEqual(
    expect.arrayContaining([expect.objectContaining({ id: 'project-index@1.0.0' })]),
  );
  expect(
    (
      await request('developer', 'POST', '/v1/knowledge/backends', {
        name: 'project-index',
        version: '1.0.0',
        type: 'native',
        config_hash: 'b'.repeat(64),
      })
    ).statusCode,
  ).toBe(409);
});
test('knowledge search never falls back to an unapproved or remote backend', async () => {
  const created = await request('developer', 'POST', '/v1/knowledge/backends', {
    name: 'remote-index',
    version: '1.0.0',
    type: 'gbrain',
    config_hash: 'c'.repeat(64),
  });
  expect(created.statusCode).toBe(201);
  expect(
    (
      await request(
        'operator',
        'GET',
        '/v1/knowledge/search?project_id=proj&q=test&backend_id=remote-index@1.0.0',
      )
    ).json().error.code,
  ).toBe('knowledge_backend_not_approved');
  expect(
    (
      await request('reviewer', 'POST', '/v1/knowledge/backends/remote-index@1.0.0/decision', {
        status: 'approved',
      })
    ).statusCode,
  ).toBe(200);
  const response = await request(
    'operator',
    'GET',
    '/v1/knowledge/search?project_id=proj&q=test&backend_id=remote-index@1.0.0',
  );
  expect(response.statusCode).toBe(501);
  expect(response.json().error.code).toBe('knowledge_backend_runtime_unavailable');
});
test('production memories use candidate approval and tenant-scoped deletion', async () => {
  const created = await request('operator', 'POST', '/v1/memories', {
    project_id: 'proj-a',
    scope: 'project',
    kind: 'fact',
    content: { term: 'veridical' },
    sensitivity: 'normal',
  });
  expect(created.statusCode).toBe(201);
  const id = created.json().id;
  expect(created.json().status).toBe('candidate');
  expect((await request('viewer', 'GET', '/v1/memories?project_id=proj-a')).json()).toHaveLength(1);
  expect(
    (await request('reviewer', 'POST', `/v1/memories/${id}/decision`, { status: 'active' }))
      .statusCode,
  ).toBe(200);
  expect((await request('developer', 'DELETE', `/v1/memories/${id}`)).json()).toMatchObject({
    deleted: true,
    id,
  });
  expect((await request('viewer', 'GET', '/v1/memories?project_id=proj-a')).json()).toHaveLength(0);
});
test('production turns inject only organization or matching project memory', async () => {
  await publish();
  const created = await request('operator', 'POST', '/v1/memories', {
    project_id: 'proj-a',
    scope: 'project',
    kind: 'fact',
    content: 'PROJECT_A_SECRET_CONTEXT',
    sensitivity: 'normal',
  });
  const memoryId = created.json().id;
  await request('reviewer', 'POST', `/v1/memories/${memoryId}/decision`, { status: 'active' });
  const first = env.service.run(
    principal('operator'),
    { name: 'probe', channel: 'production', prompt: 'hello', project_id: 'proj-a' },
    'memory-run-a',
  );
  expect((await drain(first.id)).state).toBe('completed');
  const firstRequest = requests.at(-1);
  expect(firstRequest?.messages?.[0]?.content).toContain('PROJECT_A_SECRET_CONTEXT');
  const before = requests.length;
  const second = env.service.run(
    principal('operator'),
    { name: 'probe', channel: 'production', prompt: 'hello', project_id: 'proj-b' },
    'memory-run-b',
  );
  expect((await drain(second.id)).state).toBe('completed');
  expect(requests.slice(before).at(-1)?.messages?.[0]?.content).not.toContain(
    'PROJECT_A_SECRET_CONTEXT',
  );
  const userMemory = await request('operator', 'POST', '/v1/memories', {
    project_id: 'proj-a',
    user_id: 'another-user',
    scope: 'user',
    kind: 'preference',
    content: 'OTHER_USER_SECRET_CONTEXT',
    sensitivity: 'normal',
  });
  await request('reviewer', 'POST', `/v1/memories/${userMemory.json().id}/decision`, {
    status: 'active',
  });
  const beforeUser = requests.length;
  const third = env.service.run(
    principal('operator'),
    { name: 'probe', channel: 'production', prompt: 'hello', project_id: 'proj-a' },
    'memory-run-user',
  );
  expect((await drain(third.id)).state).toBe('completed');
  expect(requests.slice(beforeUser).at(-1)?.messages?.[0]?.content).not.toContain(
    'OTHER_USER_SECRET_CONTEXT',
  );
});
test('production skills are immutable versioned artifacts requiring approval', async () => {
  const created = await request('developer', 'POST', '/v1/skills', {
    name: 'research',
    version: '1.0.0',
    description: 'research workflow',
    content: '# Research\nUse cited sources.',
    tool_dependencies: ['echo'],
  });
  expect(created.statusCode).toBe(201);
  expect(created.json()).toMatchObject({ id: 'research@1.0.0', status: 'draft' });
  expect(
    (
      await request('reviewer', 'POST', '/v1/skills/research@1.0.0/decision', {
        status: 'approved',
      })
    ).statusCode,
  ).toBe(200);
  const listed = await request('viewer', 'GET', '/v1/skills');
  expect(listed.json()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: 'research@1.0.0',
        status: 'approved',
        content_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    ]),
  );
  expect(
    (
      await request('developer', 'POST', '/v1/skills', {
        name: 'research',
        version: '1.0.0',
        content: 'changed',
      })
    ).statusCode,
  ).toBe(409);
});
test('production MCP servers are versioned artifacts with transport validation and approval', async () => {
  const created = await request('developer', 'POST', '/v1/mcp/servers', {
    name: 'research-tools',
    version: '1.0.0',
    transport: 'streamable-http',
    endpoint: 'https://mcp.example.test/mcp',
    tool_names: ['search'],
  });
  expect(created.statusCode).toBe(201);
  expect(created.json()).toMatchObject({ id: 'research-tools@1.0.0', status: 'draft' });
  expect(
    (
      await request('reviewer', 'POST', '/v1/mcp/servers/research-tools@1.0.0/decision', {
        status: 'approved',
      })
    ).statusCode,
  ).toBe(200);
  expect((await request('viewer', 'GET', '/v1/mcp/servers')).json()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: 'research-tools@1.0.0', status: 'approved' }),
    ]),
  );
  const discovery = await request(
    'developer',
    'POST',
    '/v1/mcp/servers/research-tools@1.0.0/discover',
  );
  expect(discovery.statusCode).toBe(503);
  expect(discovery.json().error.code).toBe('mcp_fixed_bindings_missing');
  expect(
    (
      await request('developer', 'POST', '/v1/mcp/servers', {
        name: 'bad',
        version: '1.0.0',
        transport: 'streamable-http',
      })
    ).statusCode,
  ).toBe(400);
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
  const manifest = await request('viewer', 'GET', '/v1/releases/probe@1.0.0/manifest');
  expect(manifest.statusCode).toBe(200);
  expect(manifest.json()).toMatchObject({
    spec_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
    tool_versions: expect.objectContaining({
      echo: expect.any(Object),
      finish: expect.any(Object),
    }),
  });
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
test('production Task and Turn aliases reuse the pinned run session', async () => {
  await publish();
  const created = await request(
    'operator',
    'POST',
    '/v1/agents/probe/tasks',
    { prompt: 'first task turn', project_id: 'proj-a' },
    'task-create-1',
  );
  expect(created.statusCode).toBe(202);
  const task = created.json();
  expect((await drain(task.id)).state).toBe('completed');
  const detail = await request('viewer', 'GET', `/v1/tasks/${task.session}`);
  expect(detail.statusCode).toBe(200);
  expect(detail.json()).toMatchObject({ session_id: task.session, turns: 1 });
  const next = await request(
    'operator',
    'POST',
    `/v1/tasks/${task.session}/turns`,
    { prompt: 'second task turn', project_id: 'proj-a' },
    'task-turn-2',
  );
  expect(next.statusCode).toBe(202);
  expect((await drain(next.json().id)).state).toBe('completed');
  expect((await request('viewer', 'GET', `/v1/tasks/${task.session}`)).json().turns).toBe(2);
});
test('production Agent catalog and Studio draft are backed by governed artifacts', async () => {
  await publish();
  const agents = await request('viewer', 'GET', '/v1/agents');
  expect(agents.statusCode).toBe(200);
  expect(agents.json()).toEqual(
    expect.arrayContaining([expect.objectContaining({ id: 'probe', status: 'published' })]),
  );
  const saved = await request('developer', 'PUT', '/v1/agents/probe/draft', {
    graph: { nodes: [{ id: 'agent' }] },
    yaml: yaml('1.0.1'),
  });
  expect(saved.statusCode).toBe(200);
  expect(saved.json()).toMatchObject({ revision: 1, graph: { nodes: [{ id: 'agent' }] } });
  const loaded = await request('developer', 'GET', '/v1/agents/probe/draft');
  expect(loaded.json()).toMatchObject({ revision: 1, yaml: yaml('1.0.1') });
  const candidate = await request('developer', 'POST', '/v1/agents/probe/publish', {
    graph: {},
    yaml: yaml('1.0.1'),
  });
  expect(candidate.statusCode).toBe(202);
  expect(candidate.json()).toMatchObject({ status: 'pending_review', ref: 'probe@1.0.1' });
  const deployment = await request('viewer', 'GET', '/v1/agents/probe/deployment');
  expect(deployment.statusCode).toBe(200);
  expect(deployment.json()).toMatchObject({
    deployed: true,
    ref: 'probe@1.0.0',
    channel: 'production',
  });
});
test('production Agent creation creates a safe draft candidate', async () => {
  const created = await request('developer', 'POST', '/v1/agents', {
    name: 'new-agent',
    description: 'A focused production assistant',
    model: 'server-default',
  });
  expect(created.statusCode).toBe(201);
  expect(created.json()).toMatchObject({
    id: 'new-agent',
    status: 'draft',
    model: 'fixture-model',
  });
  const candidate = env.db.get('acme', 'spec', 'new-agent@0.1.0');
  expect(candidate?.status).toBe('draft');
  expect(candidate?.body.tools).toEqual([{ name: 'finish', access: 'allow' }]);
  expect((await request('developer', 'GET', '/v1/agents/new-agent')).json()).toMatchObject({
    id: 'new-agent',
    status: 'draft',
  });
  expect((await request('viewer', 'GET', '/v1/agents/new-agent')).statusCode).toBe(404);
});
test('production Agent duplication creates an un-deployed draft', async () => {
  await publish();
  const response = await request('developer', 'POST', '/v1/agents/probe/duplicate');
  expect(response.statusCode).toBe(201);
  const copy = response.json();
  expect(copy.status).toBe('draft');
  expect(copy.id).toMatch(/^probe-copy-/);
  expect((await request('viewer', 'GET', `/v1/agents/${copy.id}`)).statusCode).toBe(404);
});
test('production Agent archive revokes the immutable release with audit semantics', async () => {
  await publish();
  const response = await request('reviewer', 'PATCH', '/v1/agents/probe', {
    status: 'archived',
    reason: 'retired for replacement',
  });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ id: 'probe', status: 'archived' });
  expect((await request('viewer', 'GET', '/v1/agents')).json()).not.toEqual(
    expect.arrayContaining([expect.objectContaining({ id: 'probe' })]),
  );
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
  const terminal = await drain(job.id);
  // Depending on whether the deadline fence or the provider abort wins the race,
  // production may classify this as failed or interrupted; both are terminal and audited.
  expect(['failed', 'interrupted']).toContain(terminal.state);
  expect(['job.failed', 'job.interrupted']).toContain(
    env.db.read('acme', job.session).at(-1)?.type,
  );
});

test('production provenance and replay alias enforce tenant, mode and artifact boundaries', async () => {
  await publish();
  const source = env.service.run(
    principal('operator'),
    { name: 'probe', channel: 'production', prompt: 'provenance' },
    'provenance-source',
  );
  expect((await drain(source.id)).state).toBe('completed');
  const provenance = await request('viewer', 'GET', `/v1/runs/${source.session}/provenance`);
  expect(provenance.statusCode).toBe(200);
  expect(provenance.json().provenance[0]).toMatchObject({ path: 'root' });
  expect(provenance.json().provenance[0].payload.release_artifact_hash).toMatch(/^[a-f0-9]{64}$/);
  expect(provenance.json().manifest).toMatchObject({
    replay_mode: 'strict',
    spec_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
    loop: expect.objectContaining({ engine: 'orchestrator' }),
  });
  const taskProvenance = await request('viewer', 'GET', `/v1/tasks/${source.session}/provenance`);
  expect(taskProvenance.statusCode).toBe(200);
  expect(taskProvenance.json().manifest).toMatchObject({ replay_mode: 'strict' });
  const invocations = await request('viewer', 'GET', `/v1/sessions/${source.session}/invocations`);
  expect(invocations.statusCode).toBe(200);
  expect(invocations.json().invocations[0]).toMatchObject({
    path: 'root',
    run_id: expect.any(String),
  });
  const taskInvocations = await request('viewer', 'GET', `/v1/tasks/${source.session}/invocations`);
  expect(taskInvocations.statusCode).toBe(200);
  expect(taskInvocations.json().invocations).toHaveLength(invocations.json().invocations.length);
  const trajectory = await request('viewer', 'GET', `/v1/sessions/${source.session}/trajectory`);
  expect(trajectory.statusCode).toBe(200);
  expect(trajectory.json().steps.length).toBeGreaterThan(0);
  const exportResponse = await request(
    'reviewer',
    'POST',
    `/v1/sessions/${source.session}/trajectory/export`,
    { format: 'jsonl' },
  );
  expect(exportResponse.statusCode).toBe(200);
  expect(exportResponse.headers['content-type']).toContain('application/x-ndjson');
  expect(
    (await request('foreign', 'GET', `/v1/runs/${source.session}/provenance`)).statusCode,
  ).toBe(404);
  expect(
    (await request('foreign', 'GET', `/v1/tasks/${source.session}/provenance`)).statusCode,
  ).toBe(404);
  expect(
    (
      await request(
        'operator',
        'POST',
        '/v1/replay',
        { session: source.session, mode: 'semantic' },
        'forbidden-semantic',
      )
    ).statusCode,
  ).toBe(400);
  const replay = await request(
    'operator',
    'POST',
    '/v1/replay',
    { session: source.session },
    'strict-replay-alias',
  );
  expect(replay.statusCode).toBe(202);
  expect((await drain(replay.json().id)).result).toMatchObject({
    mode: 'strict',
    identical: true,
    degraded: false,
    external_calls: 0,
  });
  env.service.tools[0].schema = z.object({ changed: z.string() });
  expect(() =>
    env.service.run(
      principal('operator'),
      { name: 'probe', channel: 'production', prompt: 'changed schema' },
      'changed-schema-source',
    ),
  ).toThrow();
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
  env.service.tools[0].schema = z.object({ required: z.string() }).strict();
  await publish();
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
  answer = async () => reply();
  await publish('1.0.1');
  answer = async () => reply('{"tool":{"name":"echo","args":{}}}');
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
