import type { FastifyInstance } from 'fastify';
import { MEMORY_SESSION, MemoryStore } from '@veridical/memory';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile, realpath } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { rm } from 'node:fs/promises';
import { z } from 'zod';

const SkillInput = z.object({ name: z.string().min(1).max(80), version: z.string().min(1).max(40).default('1.0.0'), description: z.string().max(240).default(''), procedure: z.string().max(8000).default(''), tags: z.array(z.string().min(1).max(32)).max(12).default([]), source: z.string().max(240).default('local'), status: z.enum(['draft', 'approved', 'deprecated']).default('draft'), content_hash: z.string().regex(/^[a-f0-9]{64}$/).optional(), tool_dependencies: z.array(z.string()).default([]) });
type Skill = z.infer<typeof SkillInput> & { key: string; content_hash: string };
const digest = (skill: unknown) => createHash('sha256').update(JSON.stringify(skill)).digest('hex');
const runGit = promisify(execFile);

/** Read-only, governance-friendly skill catalog. Procedures are returned for explicit Spec pinning. */
export async function registerSkillRoutes(app: FastifyInstance, opts: { dataDir?: string } = {}) {
  const dataDir = opts.dataDir ?? process.cwd();
  const file = join(dataDir, 'skills.json');
  async function read(): Promise<Skill[]> { try { return JSON.parse(await readFile(file, 'utf8')) as Skill[]; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return []; } }
  async function write(skills: Skill[]) { await mkdir(dirname(file), { recursive: true }); const tmp = `${file}.${randomUUID()}.tmp`; await writeFile(tmp, JSON.stringify(skills, null, 2), { mode: 0o600 }); await rename(tmp, file); }
  app.get('/api/skills', async () => {
    const catalog = await read();
    const snapshot = await new MemoryStore().snapshot(app.store, MEMORY_SESSION);
    const legacy = snapshot.entries
      .filter((entry) => entry.scope === 'skill')
      .map((entry) => {
        const value = entry.value && typeof entry.value === 'object' ? entry.value as Record<string, unknown> : {};
        return {
          name: typeof value.name === 'string' ? value.name : entry.key.replace(/^skill:/, ''),
          description: typeof value.description === 'string' ? value.description : '',
          procedure: typeof value.procedure === 'string' ? value.procedure : '',
          tags: entry.tags ?? [],
          version: 'legacy', source: 'legacy-memory', status: 'approved' as const,
          key: entry.key,
          content_hash: digest(entry.value),
        };
      });
    return [...catalog, ...legacy.filter((item) => !catalog.some((skill) => skill.name === item.name && skill.version === item.version))];
  });
  app.post('/api/skills', async (req, reply) => {
    const parsed = SkillInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'invalid_skill', details: parsed.error.issues } });
    const skills = await read(); const key = `${parsed.data.name}@${parsed.data.version}`;
    if (skills.some((skill) => skill.key === key)) return reply.code(409).send({ error: { code: 'skill_exists' } });
    const { content_hash, ...body } = parsed.data;
    const row: Skill = { ...body, key, content_hash: content_hash ?? digest(body) };
    skills.push(row); await write(skills); return reply.code(201).send(row);
  });
  app.post('/api/skills/import-directory', async (req, reply) => {
    const parsed = z.object({ path: z.string().min(1).max(1000) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'invalid_skill_path' } });
    const allowedRoot = await realpath(process.env.VERIDICAL_SKILLS_DIR ?? join(dataDir, 'skills')).catch(() => null);
    if (!allowedRoot) return reply.code(409).send({ error: { code: 'skills_directory_not_configured' } });
    const target = await realpath(parsed.data.path).catch(() => null);
    const relativeTarget = target && relative(allowedRoot, target);
    if (!target || relativeTarget === null || (relativeTarget !== '' && (relativeTarget.startsWith('..') || relativeTarget.startsWith('/') || relativeTarget.startsWith('\\')))) return reply.code(403).send({ error: { code: 'skill_path_not_allowed' } });
    const manifest = await readFile(join(target, 'skill.json'), 'utf8').catch(() => null);
    const instructions = await readFile(join(target, 'SKILL.md'), 'utf8').catch(() => null);
    if (!manifest || !instructions) return reply.code(422).send({ error: { code: 'skill_package_incomplete', message: 'skill.json 和 SKILL.md 都是必需文件' } });
    let metadata: Record<string, unknown>;
    try { metadata = JSON.parse(manifest) as Record<string, unknown>; } catch { return reply.code(422).send({ error: { code: 'invalid_skill_manifest' } }); }
    const parsedSkill = SkillInput.safeParse({
      name: metadata.name, version: metadata.version, description: metadata.description ?? '', procedure: instructions,
      tags: metadata.tags ?? [], source: `local:${target}`, status: 'draft', tool_dependencies: metadata.tool_dependencies ?? [],
    });
    if (!parsedSkill.success) return reply.code(422).send({ error: { code: 'invalid_skill_manifest', details: parsedSkill.error.issues } });
    const skills = await read(); const key = `${parsedSkill.data.name}@${parsedSkill.data.version}`;
    if (skills.some((skill) => skill.key === key)) return reply.code(409).send({ error: { code: 'skill_exists' } });
    const row: Skill = { ...parsedSkill.data, key, content_hash: digest({ manifest, instructions }) };
    skills.push(row); await write(skills); return reply.code(201).send(row);
  });
  app.post('/api/skills/import-git', async (req, reply) => {
    const parsed = z.object({ repository: z.string().url(), commit: z.string().regex(/^[a-f0-9]{7,64}$/i), subdirectory: z.string().regex(/^[a-zA-Z0-9._/-]*$/).default('') }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'invalid_skill_repository' } });
    const url = new URL(parsed.data.repository);
    if (url.protocol !== 'https:' || !['github.com', 'gitlab.com', 'bitbucket.org'].includes(url.hostname)) return reply.code(403).send({ error: { code: 'skill_repository_not_allowed' } });
    const temp = await import('node:fs/promises').then(({ mkdtemp }) => mkdtemp(join(tmpdir(), 'veridical-skill-')));
    try {
      await runGit('git', ['clone', '--filter=blob:none', '--no-checkout', '--depth=1', parsed.data.repository, temp], { timeout: 60_000 });
      await runGit('git', ['fetch', '--depth=1', 'origin', parsed.data.commit], { cwd: temp, timeout: 60_000 });
      await runGit('git', ['checkout', '--detach', parsed.data.commit], { cwd: temp, timeout: 30_000 });
      const target = resolve(temp, parsed.data.subdirectory);
      const rel = relative(temp, target);
      if (rel.startsWith('..') || rel.startsWith('/') || rel.startsWith('\\')) return reply.code(403).send({ error: { code: 'skill_subdirectory_not_allowed' } });
      const manifest = await readFile(join(target, 'skill.json'), 'utf8').catch(() => null); const instructions = await readFile(join(target, 'SKILL.md'), 'utf8').catch(() => null);
      if (!manifest || !instructions) return reply.code(422).send({ error: { code: 'skill_package_incomplete' } });
      let metadata: Record<string, unknown>;
      try { metadata = JSON.parse(manifest) as Record<string, unknown>; } catch { return reply.code(422).send({ error: { code: 'invalid_skill_manifest' } }); }
      const skill = SkillInput.safeParse({ name: metadata.name, version: metadata.version, description: metadata.description ?? '', procedure: instructions, tags: metadata.tags ?? [], source: `${parsed.data.repository}#${parsed.data.commit}`, status: 'draft', tool_dependencies: metadata.tool_dependencies ?? [] });
      if (!skill.success) return reply.code(422).send({ error: { code: 'invalid_skill_manifest', details: skill.error.issues } });
      const skills = await read(); const key = `${skill.data.name}@${skill.data.version}`; if (skills.some((item) => item.key === key)) return reply.code(409).send({ error: { code: 'skill_exists' } });
      const row: Skill = { ...skill.data, key, content_hash: digest({ manifest, instructions, commit: parsed.data.commit }) }; skills.push(row); await write(skills); return reply.code(201).send(row);
    } catch (error) { return reply.code(502).send({ error: { code: 'skill_repository_fetch_failed', message: error instanceof Error ? error.message : String(error) } }); }
    finally { await rm(temp, { recursive: true, force: true }).catch(() => undefined); }
  });
}
