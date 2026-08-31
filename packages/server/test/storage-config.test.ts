import { describe, expect, test } from 'vitest';
import { ProductionConfigSchema } from '../src/production/config';

const base = {
  database: '/tmp/veridical.db',
  releaseId: 'release-2026',
  dataKeyEnv: 'DATA_KEY',
  auditKeyEnv: 'AUDIT_KEY',
  tokens: [
    {
      hash: 'a'.repeat(64),
      tenant: 'acme',
      actor: 'tester',
      roles: ['admin'],
      expires: '2099-01-01T00:00:00Z',
    },
  ],
  providers: [
    {
      name: 'qwen',
      model: 'qwen3',
      version: 'v1',
      baseUrl: 'https://example.com/v1',
      apiKeyEnv: 'QWEN_KEY',
    },
  ],
};

describe('production storage profile', () => {
  test('defaults to the explicitly supported single-host profile', () => {
    expect(ProductionConfigSchema.parse(base).storage).toEqual({
      database: 'sqlite',
      objectStore: 'local',
      queue: 'in_process',
    });
  });
  test('requires endpoints for managed dependencies', () => {
    expect(() =>
      ProductionConfigSchema.parse({ ...base, storage: { database: 'postgres' } }),
    ).toThrow();
    expect(() => ProductionConfigSchema.parse({ ...base, storage: { queue: 'redis' } })).toThrow();
    expect(() =>
      ProductionConfigSchema.parse({ ...base, storage: { objectStore: 's3' } }),
    ).toThrow();
  });
  test('accepts Vault credential references and rejects malformed ones', () => {
    expect(
      ProductionConfigSchema.parse({
        ...base,
        providers: [
          { ...base.providers[0], apiKeyEnv: 'vault:secret/data/veridical/qwen#api_key' },
        ],
      }).providers[0].apiKeyEnv,
    ).toBe('vault:secret/data/veridical/qwen#api_key');
    expect(() =>
      ProductionConfigSchema.parse({
        ...base,
        providers: [{ ...base.providers[0], apiKeyEnv: 'vault:missing-field' }],
      }),
    ).toThrow();
  });
  test('requires S3 bucket and credential references', () => {
    expect(() =>
      ProductionConfigSchema.parse({
        ...base,
        storage: { objectStore: 's3', s3Endpoint: 'https://s3.example.com' },
      }),
    ).toThrow();
    expect(
      ProductionConfigSchema.parse({
        ...base,
        storage: {
          objectStore: 's3',
          s3Endpoint: 'https://s3.example.com',
          s3Bucket: 'veridical',
          s3AccessKeyEnv: 'S3_ACCESS',
          s3SecretKeyEnv: 'S3_SECRET',
        },
      }).storage.s3Bucket,
    ).toBe('veridical');
  });
});
