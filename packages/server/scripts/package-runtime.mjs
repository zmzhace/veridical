import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

// Copy the already installed, frozen-lockfile dependency graph. No install,
// resolution or network occurs while producing the runtime artifact.
const server = resolve(fileURLToPath(new URL('..', import.meta.url)));
const output = process.argv[2] && resolve(process.argv[2]);
if (!output || existsSync(output))
  throw new Error('usage: package-runtime.mjs <NEW-output-directory>');
if (!existsSync(join(server, 'dist/server.cjs'))) throw new Error('build the server first');
mkdirSync(output, { recursive: true, mode: 0o700 });
const copied = new Map();
const manifest = [];
function locate(from, name) {
  for (let directory = from; ; directory = dirname(directory)) {
    const candidate = join(directory, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate);
    if (dirname(directory) === directory) return undefined;
  }
}
function link(parent, name, target) {
  const entry = join(parent, 'node_modules', name);
  mkdirSync(dirname(entry), { recursive: true });
  symlinkSync(relative(dirname(entry), target), entry, 'dir');
}
function copy(source) {
  if (copied.has(source)) return copied.get(source);
  const pkg = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
  const id = createHash('sha256').update(relative(server, source)).digest('hex').slice(0, 20);
  const target = join(output, 'node_modules', '.store', id);
  copied.set(source, target);
  cpSync(source, target, {
    recursive: true,
    filter: (path) => !relative(source, path).split('/').includes('node_modules'),
  });
  manifest.push({ name: pkg.name, version: pkg.version });
  const dependencies = {
    ...pkg.peerDependencies,
    ...pkg.dependencies,
    ...pkg.optionalDependencies,
  };
  for (const name of Object.keys(dependencies ?? {})) {
    const dependency = locate(source, name);
    if (!dependency) {
      if (pkg.optionalDependencies?.[name] || pkg.peerDependenciesMeta?.[name]?.optional) continue;
      throw new Error(`missing installed dependency ${pkg.name} -> ${name}`);
    }
    link(target, name, copy(dependency));
  }
  return target;
}
for (const name of ['fastify', '@fastify/cors', 'better-sqlite3']) {
  const installed = locate(server, name);
  if (!installed) throw new Error(`missing external dependency ${name}`);
  link(output, name, copy(installed));
}
cpSync(join(server, 'dist'), join(output, 'dist'), { recursive: true });
writeFileSync(
  join(output, 'package.json'),
  JSON.stringify({ name: 'veridical-production-runtime', private: true, type: 'commonjs' }),
);
writeFileSync(
  join(output, 'runtime-dependencies.json'),
  JSON.stringify(
    manifest.sort((a, b) => a.name.localeCompare(b.name)),
    null,
    2,
  ) + '\n',
);
console.log(`Packaged ${manifest.length} installed production dependencies into ${output}`);
