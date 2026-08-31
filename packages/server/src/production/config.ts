import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { Key, Roles } from './contracts';

export const ProductionConfigSchema = z
  .object({
    database: z.string().min(1),
    storage: z
      .object({
        database: z.enum(['sqlite', 'postgres']).default('sqlite'),
        objectStore: z.enum(['local', 's3']).default('local'),
        queue: z.enum(['in_process', 'redis']).default('in_process'),
        postgresUrl: z.string().url().optional(),
        redisUrl: z.string().url().optional(),
        s3Endpoint: z.string().url().optional(),
        s3Bucket: z.string().min(1).max(180).optional(),
        s3AccessKeyEnv: Key.optional(),
        s3SecretKeyEnv: Key.optional(),
      })
      .strict()
      .default({}),
    releaseId: z.string().min(7).max(128),
    dataKeyEnv: Key,
    auditKeyEnv: Key,
    host: z.string().default('127.0.0.1'),
    port: z.number().int().min(0).max(65535).default(8787),
    tokens: z
      .array(
        z
          .object({
            hash: z.string().regex(/^[a-f0-9]{64}$/),
            tenant: Key,
            actor: Key,
            roles: z.array(Roles).min(1),
            expires: z.string().datetime(),
          })
          .strict(),
      )
      .min(1)
      .max(500),
    oidc: z
      .object({
        issuer: z.string().url(),
        audience: z.string().min(1).max(200),
        jwksUrl: z.string().url(),
        tenantClaim: z.string().min(1).max(80).default('tenant'),
        actorClaim: z.string().min(1).max(80).default('sub'),
        rolesClaim: z.string().min(1).max(80).default('roles'),
      })
      .strict()
      .optional(),
    providers: z
      .array(
        z
          .object({
            name: Key,
            model: z.string().min(1).max(150),
            version: Key,
            baseUrl: z
              .string()
              .url()
              .refine((url) => {
                const u = new URL(url);
                return (
                  u.protocol === 'https:' && !u.username && !u.password && !u.search && !u.hash
                );
              }, 'HTTPS provider URL required'),
            apiKeyEnv: z
              .string()
              .min(1)
              .max(260)
              .refine(
                (value) =>
                  Key.safeParse(value).success || /^vault:[^#]+#[A-Za-z0-9_.-]+$/.test(value),
                'environment key or vault:path#field required',
              ),
            enableThinking: z.boolean().optional(),
          })
          .strict(),
      )
      .min(1)
      .max(20),
    timeoutMs: z.number().int().min(1000).max(300000).default(60000),
    concurrency: z.number().int().min(1).max(4).default(2),
    maxOutputTokens: z.number().int().min(64).max(4096).default(1024),
    requestsPerMinute: z.number().int().min(10).max(1000).default(120),
    maxDatabaseBytes: z.number().int().min(1048576).max(1099511627776).default(4294967296),
    minFreeDiskBytes: z.number().int().min(1048576).default(268435456),
  })
  .strict()
  .superRefine((c, ctx) => {
    if (c.storage.database === 'postgres' && !c.storage.postgresUrl)
      ctx.addIssue({
        code: 'custom',
        path: ['storage', 'postgresUrl'],
        message: 'postgresUrl is required for postgres storage',
      });
    if (c.storage.queue === 'redis' && !c.storage.redisUrl)
      ctx.addIssue({
        code: 'custom',
        path: ['storage', 'redisUrl'],
        message: 'redisUrl is required for redis queue',
      });
    if (c.storage.objectStore === 's3' && !c.storage.s3Endpoint)
      ctx.addIssue({
        code: 'custom',
        path: ['storage', 's3Endpoint'],
        message: 's3Endpoint is required for S3 object storage',
      });
    if (c.storage.objectStore === 's3' && !c.storage.s3Bucket)
      ctx.addIssue({
        code: 'custom',
        path: ['storage', 's3Bucket'],
        message: 's3Bucket is required for S3 object storage',
      });
    if (c.storage.objectStore === 's3' && (!c.storage.s3AccessKeyEnv || !c.storage.s3SecretKeyEnv))
      ctx.addIssue({
        code: 'custom',
        path: ['storage'],
        message: 'S3 credential environment references are required',
      });
    if (new Set(c.tokens.map((t) => t.hash)).size !== c.tokens.length)
      ctx.addIssue({ code: 'custom', message: 'duplicate token hashes' });
    if (new Set(c.providers.map((p) => p.name)).size !== c.providers.length)
      ctx.addIssue({ code: 'custom', message: 'duplicate provider names' });
  });
export type ProductionConfig = z.infer<typeof ProductionConfigSchema>;
export function loadProductionConfig() {
  const file = process.env.VERIDICAL_CONFIG;
  if (!file)
    throw new Error('VERIDICAL_CONFIG is required; development mode must be explicitly selected');
  const config = ProductionConfigSchema.parse(JSON.parse(readFileSync(resolve(file), 'utf8')));
  if (process.env.VERIDICAL_ALLOW_LOCAL_STORAGE !== '1') {
    if (config.storage.database !== 'postgres')
      throw new Error('production_requires_postgres_ledger');
    if (config.storage.queue !== 'redis') throw new Error('production_requires_redis_queue');
    if (config.storage.objectStore !== 's3') throw new Error('production_requires_s3_object_store');
  }
  config.database = resolve(config.database);
  const key = (name: string) => {
    const raw = process.env[name];
    if (!raw || !/^[a-fA-F0-9]{64}$/.test(raw))
      throw new Error(`32-byte hex key required in ${name}`);
    return Buffer.from(raw, 'hex');
  };
  return { config, dataKey: key(config.dataKeyEnv), auditKey: key(config.auditKeyEnv) };
}
