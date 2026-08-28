import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { Key, Roles } from './contracts';

export const ProductionConfigSchema = z
  .object({
    database: z.string().min(1),
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
            apiKeyEnv: Key,
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
  config.database = resolve(config.database);
  const key = (name: string) => {
    const raw = process.env[name];
    if (!raw || !/^[a-fA-F0-9]{64}$/.test(raw))
      throw new Error(`32-byte hex key required in ${name}`);
    return Buffer.from(raw, 'hex');
  };
  return { config, dataKey: key(config.dataKeyEnv), auditKey: key(config.auditKeyEnv) };
}
