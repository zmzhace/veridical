import { Pool } from 'pg';
import Redis from 'ioredis';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Ledger } from './database';
import { PostgresTraceLedger } from './postgres-ledger';
import type { ProductionConfig } from './config';
import { S3ObjectStore } from './object-store';

/** PostgreSQL connectivity primitive used by deployment probes and the future Ledger adapter. */
export async function probePostgres(
  connectionString: string,
  timeoutMs = 1500,
): Promise<{ ok: true; server_version: string } | { ok: false; error: string }> {
  const pool = new Pool({
    connectionString,
    max: 1,
    connectionTimeoutMillis: timeoutMs,
    idleTimeoutMillis: timeoutMs,
  });
  try {
    const result = await pool.query<{ server_version: string }>(
      "select current_setting('server_version') as server_version",
    );
    return { ok: true, server_version: result.rows[0]?.server_version ?? 'unknown' };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    await pool.end().catch(() => undefined);
  }
}

/** Apply the checked-in baseline schema atomically. A session advisory lock makes startup safe across replicas. */
export async function migratePostgres(connectionString: string): Promise<void> {
  const pool = new Pool({ connectionString, max: 1 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [71938401]);
    const migration = await readFile(
      join(dirname(fileURLToPath(import.meta.url)), 'migrations', '001_initial_postgres.sql'),
      'utf8',
    );
    await client.query(migration);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

export async function probeRedis(
  connectionString: string,
  timeoutMs = 1500,
): Promise<{ ok: true; version: string } | { ok: false; error: string }> {
  const client = new Redis(connectionString, {
    connectTimeout: timeoutMs,
    maxRetriesPerRequest: 1,
    lazyConnect: true,
  });
  try {
    await client.connect();
    const pong = await client.ping();
    const info = await client.info('server');
    const version = info.match(/^redis_version:([^\r\n]+)/m)?.[1] ?? 'unknown';
    return pong === 'PONG' ? { ok: true, version } : { ok: false, error: 'unexpected_ping' };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    client.disconnect();
  }
}

/** Select the durable ledger explicitly; production never falls back to SQLite. */
export async function buildLedger(config: ProductionConfig, dataKey: Buffer, auditKey: Buffer) {
  if (config.storage.database === 'postgres') {
    if (!config.storage.postgresUrl) throw new Error('postgres_url_required');
    await migratePostgres(config.storage.postgresUrl);
    const ledger = new PostgresTraceLedger(config.storage.postgresUrl, dataKey, auditKey);
    await ledger.pool.query('SELECT 1');
    return ledger;
  }
  return new Ledger(config.database, dataKey, auditKey);
}

export function buildObjectStore(config: ProductionConfig) {
  if (config.storage.objectStore !== 's3') return undefined;
  const accessKey = process.env[config.storage.s3AccessKeyEnv!];
  const secretKey = process.env[config.storage.s3SecretKeyEnv!];
  if (!accessKey || !secretKey || !config.storage.s3Endpoint || !config.storage.s3Bucket)
    throw new Error('s3_credentials_or_config_missing');
  return new S3ObjectStore({
    endpoint: config.storage.s3Endpoint,
    bucket: config.storage.s3Bucket,
    accessKey,
    secretKey,
  });
}
