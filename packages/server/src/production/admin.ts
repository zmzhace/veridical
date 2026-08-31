import { existsSync, openSync, closeSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { Ledger } from './database';
import { loadProductionConfig } from './config';
import { BUILD_ID } from './build';
import { buildLedger } from './storage';

const Manifest = z.object({
  format: z.literal(1),
  created: z.string().datetime(),
  build: z.string(),
  sessions: z.array(
    z.object({
      tenant: z.string(),
      session: z.string(),
      seq: z.number().int().nonnegative(),
      head: z.string(),
      signature: z.string(),
    }),
  ),
});
async function main() {
  process.umask(0o077);
  const [command, argument] = process.argv.slice(2);
  if (!['backup', 'checkpoint', 'verify'].includes(command))
    throw new Error(
      'usage: admin.cjs backup <new-file> | checkpoint <new-file> | verify [checkpoint-file]',
    );
  const { config, dataKey, auditKey } = loadProductionConfig();
  if (config.storage.database === 'postgres') {
    const db: any = await buildLedger(config, dataKey, auditKey);
    try {
      if (command === 'backup') throw new Error('postgres_backup_requires_pg_dump');
      const rows = await db.pool.query('SELECT tenant,id FROM sessions ORDER BY created');
      const sessions = [];
      for (const row of rows.rows) sessions.push({ tenant: row.tenant, session: row.id, ...(await db.verify(row.tenant, row.id)) });
      if (command === 'verify' && argument) {
        const anchors = Manifest.parse(JSON.parse(readFileSync(resolve(argument), 'utf8')));
        for (const anchor of anchors.sessions) await db.verify(anchor.tenant, anchor.session, anchor);
      }
      const manifest = { format: 1, created: new Date().toISOString(), build: BUILD_ID, sessions };
      if (command === 'checkpoint') {
        if (!argument) throw new Error('new checkpoint file required');
        writeFileSync(resolve(argument), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      }
      console.log(JSON.stringify({ verified: true, sessions: sessions.length, ...(command === 'checkpoint' ? { checkpoint: resolve(argument) } : {}) }));
    } finally { await db.close(); }
    return;
  }
  if (!existsSync(config.database))
    throw new Error('existing database required; start the server first');
  const db = new Ledger(config.database, dataKey, auditKey);
  try {
    if (command === 'backup') {
      if (!argument) throw new Error('new backup file required');
      const target = resolve(argument);
      // Refuse to overwrite any existing file, including symlinks.
      const fd = openSync(target, 'wx', 0o600);
      closeSync(fd);
      await db.backup(target);
      console.log(JSON.stringify({ backup: target, encrypted: true }));
    } else {
      const manifest = {
        format: 1 as const,
        created: new Date().toISOString(),
        build: BUILD_ID,
        sessions: [] as z.infer<typeof Manifest>['sessions'],
      };
      db.tx(() => {
        if (db.sql.pragma('integrity_check', { simple: true }) !== 'ok')
          throw new Error('SQLite integrity check failed');
        if (command === 'verify' && argument) {
          const anchors = Manifest.parse(JSON.parse(readFileSync(resolve(argument), 'utf8')));
          for (const anchor of anchors.sessions) db.verify(anchor.tenant, anchor.session, anchor);
        }
        for (const row of db.sql.prepare('SELECT tenant,id FROM sessions').all() as any[])
          manifest.sessions.push({
            tenant: row.tenant,
            session: row.id,
            ...db.verify(row.tenant, row.id),
          });
        for (const row of db.sql.prepare('SELECT tenant,kind,key FROM artifacts').all() as any[])
          db.get(row.tenant, row.kind, row.key);
        for (const row of db.sql.prepare('SELECT tenant,kind,name FROM pointers').all() as any[])
          db.pointer(row.tenant, row.kind, row.name);
        for (const row of db.sql.prepare('SELECT tenant,id FROM jobs').all() as any[])
          db.job(row.tenant, row.id);
      });
      if (command === 'checkpoint') {
        if (!argument) throw new Error('new checkpoint file required');
        writeFileSync(resolve(argument), JSON.stringify(manifest, null, 2) + '\n', {
          flag: 'wx',
          mode: 0o600,
        });
      }
      console.log(
        JSON.stringify({
          verified: true,
          sessions: manifest.sessions.length,
          ...(command === 'checkpoint' ? { checkpoint: resolve(argument!) } : {}),
        }),
      );
    }
  } finally {
    db.close();
  }
}
void main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'administration failed');
  process.exitCode = 1;
});
