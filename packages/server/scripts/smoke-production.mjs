import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { randomBytes, createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = await mkdtemp(join(tmpdir(), 'veridical-production-'));
const bundle =
  process.env.VERIDICAL_SMOKE_BUNDLE ??
  fileURLToPath(new URL('../dist/server.cjs', import.meta.url));
// Fastify rejects duplicate method/path registrations at runtime. Keep this
// inexpensive source-level guard in the production smoke so route regressions
// fail before deployment rather than only when the server boots.
const sourceApp = await readFile(
  fileURLToPath(new URL('../src/production/app.ts', import.meta.url)),
  'utf8',
);
const routes = new Map();
for (const match of sourceApp.matchAll(/app\.(get|post|put|patch|delete)\((['"])([^'"]+)\2/g)) {
  const key = `${match[1]} ${match[3]}`;
  const count = (routes.get(key) ?? 0) + 1;
  routes.set(key, count);
  assert.ok(count === 1, `duplicate production route: ${key}`);
}
const token = randomBytes(32).toString('hex');
const configFile = join(dir, 'config.json');
await writeFile(
  configFile,
  JSON.stringify({
    database: join(dir, 'ledger.db'),
    releaseId: 'smoke-release',
    dataKeyEnv: 'SMOKE_DATA_KEY',
    auditKeyEnv: 'SMOKE_AUDIT_KEY',
    port: 0,
    tokens: [
      {
        hash: createHash('sha256').update(token).digest('hex'),
        tenant: 'smoke',
        actor: 'smoke-admin',
        roles: ['admin'],
        expires: '2099-01-01T00:00:00Z',
      },
    ],
    providers: [
      {
        name: 'fixture',
        model: 'fixture',
        version: 'fixture-v1',
        baseUrl: 'https://provider.invalid/v1',
        apiKeyEnv: 'SMOKE_PROVIDER_KEY',
      },
    ],
  }),
  { mode: 0o600 },
);
const env = {
  ...process.env,
  VERIDICAL_MODE: 'production',
  VERIDICAL_CONFIG: configFile,
  SMOKE_DATA_KEY: randomBytes(32).toString('hex'),
  SMOKE_AUDIT_KEY: randomBytes(32).toString('hex'),
  SMOKE_PROVIDER_KEY: 'not-used-no-model-calls',
  VERIDICAL_ALLOW_LOCAL_STORAGE: '1',
};
const rejected = await new Promise((resolve, reject) => {
  const probe = spawn(process.execPath, [bundle], {
    cwd: dir,
    env: { ...env, VERIDICAL_CONFIG: '' },
    stdio: 'ignore',
  });
  const timer = setTimeout(() => {
    probe.kill('SIGKILL');
    reject(new Error('unconfigured production did not exit'));
  }, 5000);
  probe.once('error', (error) => {
    clearTimeout(timer);
    reject(error);
  });
  probe.once('close', (code) => {
    clearTimeout(timer);
    resolve(code);
  });
});
assert.equal(rejected, 1, 'production must refuse startup without configuration');
const child = spawn(process.execPath, [bundle], {
  cwd: dir,
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
const exited = new Promise((resolve) =>
  child.once('close', (code, signal) => resolve({ code, signal })),
);
try {
  const address = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`startup timed out: ${output}`)), 10000);
    const fail = (error) => {
      clearTimeout(timer);
      reject(error);
    };
    child.once('error', fail);
    child.once('exit', (code) => fail(new Error(`server exited ${code}: ${output}`)));
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    child.stdout.on('data', (chunk) => {
      output += chunk;
      const match = output.match(/veridical server on (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
  });
  const response = await fetch(`${address}/health/live`, { signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal((await fetch(`${address}/health/ready`)).status, 401);
  const headers = { authorization: `Bearer ${token}` };
  const ready = await fetch(`${address}/health/ready`, { headers });
  assert.equal(ready.status, 200);
  assert.match((await ready.json()).build, /^[a-f0-9]{64}$/);
  assert.equal((await fetch(`${address}/api/specs`, { headers })).status, 404);
  const admin = join(dirname(bundle), 'admin.cjs');
  const runAdmin = (args, configuration = configFile) =>
    new Promise((resolve, reject) => {
      const process = spawn(globalThis.process.execPath, [admin, ...args], {
        env: { ...env, VERIDICAL_CONFIG: configuration },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      process.stdout.on('data', (b) => {
        output += b;
      });
      process.stderr.on('data', (b) => {
        output += b;
      });
      process.once('error', reject);
      process.once('close', (code) => (code === 0 ? resolve(output) : reject(new Error(output))));
    });
  await runAdmin(['checkpoint', join(dir, 'checkpoint.json')]);
  await runAdmin(['backup', join(dir, 'backup.db')]);
  await runAdmin(['verify', join(dir, 'checkpoint.json')]);
  const restored = JSON.parse(await readFile(configFile, 'utf8'));
  restored.database = join(dir, 'backup.db');
  const restoreConfig = join(dir, 'restore-config.json');
  await writeFile(restoreConfig, JSON.stringify(restored), { mode: 0o600 });
  await runAdmin(['verify', join(dir, 'checkpoint.json')], restoreConfig);
  console.log(
    'Production Node artifact: authentication, readiness, research-route exclusion, checkpoint, backup and integrity verification passed. No external model calls.',
  );
} finally {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  const status = await exited;
  clearTimeout(timer);
  await rm(dir, { recursive: true, force: true });
  assert.equal(status.code, 0, `server did not shut down cleanly (${status.signal}): ${output}`);
}
