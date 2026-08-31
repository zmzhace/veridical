import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { resolveCredential } from '../src/production/credentials';

describe('production credentials', () => {
  it('resolves Vault KV v2 and v1 payloads without exposing tokens', async () => {
    const server = createServer((req, res) => {
      expect(req.headers['x-vault-token']).toBe('token');
      res.setHeader('content-type', 'application/json');
      res.end(
        req.url?.includes('v2')
          ? JSON.stringify({ data: { data: { key: 'secret-v2' } } })
          : JSON.stringify({ data: { key: 'secret-v1' } }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    process.env.TEST_VAULT_TOKEN = 'token';
    await expect(
      resolveCredential({
        kind: 'vault',
        address: base,
        tokenEnv: 'TEST_VAULT_TOKEN',
        path: 'v2',
        field: 'key',
      }),
    ).resolves.toBe('secret-v2');
    await expect(
      resolveCredential({
        kind: 'vault',
        address: base,
        tokenEnv: 'TEST_VAULT_TOKEN',
        path: 'v1',
        field: 'key',
      }),
    ).resolves.toBe('secret-v1');
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  it('fails closed on missing fields and timeouts', async () => {
    const server = createServer((_req, res) => {
      res.statusCode = 200;
      res.end(JSON.stringify({ data: {} }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    process.env.TEST_VAULT_TOKEN = 'token';
    await expect(
      resolveCredential({
        kind: 'vault',
        address: base,
        tokenEnv: 'TEST_VAULT_TOKEN',
        path: 'missing',
        field: 'key',
      }),
    ).rejects.toThrow('vault_field_missing');
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await expect(
      resolveCredential(
        {
          kind: 'vault',
          address: 'http://127.0.0.1:1',
          tokenEnv: 'TEST_VAULT_TOKEN',
          path: 'x',
          field: 'key',
        },
        20,
      ),
    ).rejects.toThrow('vault_unavailable');
  });
});
