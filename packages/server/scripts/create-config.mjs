import { randomBytes, createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

// Run manually on a trusted administration workstation, not at every server boot.
process.umask(0o077);
const [directory, tenant, baseUrl, model, providerVersion] = process.argv.slice(2);
if (!directory || !tenant || !baseUrl || !model || !providerVersion)
  throw new Error(
    'usage: create-config.mjs <NEW-directory> <tenant> <https-provider-base-url> <model> <pinned-model-version>',
  );
const key = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,119}$/;
if (!key.test(tenant) || !key.test(providerVersion))
  throw new Error('invalid tenant or provider version');
const url = new URL(baseUrl);
if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
  throw new Error('HTTPS provider base URL without credentials/query required');
const output = resolve(directory);
mkdirSync(output, { mode: 0o700 });
const roles = ['developer', 'reviewer', 'publisher', 'operator', 'viewer', 'admin'];
const credentials = Object.fromEntries(
  roles.map((role) => [role, randomBytes(32).toString('hex')]),
);
const expires = new Date(Date.now() + 30 * 86400000).toISOString();
const config = {
  database: join(output, 'data', 'ledger.db'),
  releaseId: 'initial-release',
  dataKeyEnv: 'VERIDICAL_DATA_KEY',
  auditKeyEnv: 'VERIDICAL_AUDIT_KEY',
  host: '127.0.0.1',
  port: 8787,
  tokens: roles.map((role) => ({
    hash: createHash('sha256').update(credentials[role]).digest('hex'),
    tenant,
    actor: role,
    roles: [role],
    expires,
  })),
  providers: [
    {
      name: 'primary',
      model,
      version: providerVersion,
      baseUrl,
      apiKeyEnv: 'VERIDICAL_PROVIDER_KEY',
    },
  ],
  timeoutMs: 60000,
  concurrency: 2,
  maxOutputTokens: 1024,
  requestsPerMinute: 120,
};
const write = (name, value) =>
  writeFileSync(join(output, name), value, { flag: 'wx', mode: 0o600 });
write('config.json', JSON.stringify(config, null, 2) + '\n');
write('operator-credentials.json', JSON.stringify(credentials, null, 2) + '\n');
write(
  'ledger-keys.env',
  `VERIDICAL_DATA_KEY=${randomBytes(32).toString('hex')}\nVERIDICAL_AUDIT_KEY=${randomBytes(32).toString('hex')}\n`,
);
console.log(
  `Created protected configuration in ${output}. Assign distinct humans to author/reviewer/publisher, distribute only their token, and put ledger keys in your secret manager. Set VERIDICAL_PROVIDER_KEY separately. Tokens expire at ${expires}.`,
);
