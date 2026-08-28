import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';

const root = resolve('../..');
const hash = createHash('sha256');
function sources(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : 1,
  )) {
    if (['node_modules', 'dist', '.git'].includes(entry.name)) continue;
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) sources(path);
    else if (/\.(ts|json|mjs)$/.test(entry.name))
      hash.update(relative(root, path)).update('\0').update(readFileSync(path)).update('\0');
  }
}
sources(resolve(root, 'packages'));
hash.update(readFileSync(resolve(root, 'pnpm-lock.yaml')));
const buildId = hash.digest('hex');

// Bundle workspace TypeScript into a runnable artifact. Third-party server
// dependencies stay external; start needs Node and production dependencies, not tsx.
await build({
  entryPoints: { server: 'src/index.ts', admin: 'src/production/admin.ts' },
  outdir: 'dist',
  outExtension: { '.js': '.cjs' },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['fastify', '@fastify/cors', 'better-sqlite3'],
  sourcemap: true,
  define: { __VERIDICAL_BUILD_ID__: JSON.stringify(buildId) },
});
