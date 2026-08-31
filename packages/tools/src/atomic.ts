import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import type { ToolObservation } from './types';

const ok = <T>(data: T, text: string, started: number): ToolObservation<T> => ({ status: (Array.isArray(data) && data.length === 0) || (data && typeof data === 'object' && Object.values(data as Record<string, unknown>).some((v) => Array.isArray(v) && v.length === 0)) ? 'empty' : 'success', data, text, metadata: { duration_ms: Date.now() - started, truncated: false } });
const fail = <T = unknown>(code: string, message: string, started: number): ToolObservation<T> => ({ status: 'error', text: message, error: { code, message, retryable: code === 'TIMEOUT' }, metadata: { duration_ms: Date.now() - started, truncated: false } });
function safe(root: string, candidate = '') { const base = resolve(root); const target = resolve(base, candidate); const rel = relative(base, target); if (rel.startsWith('..') || rel.startsWith('/') || rel.startsWith('\\')) throw new Error('path outside workspace'); return target; }

export async function listFiles(root: string, path = ''): Promise<ToolObservation<{ entries: string[] }>> {
  const started = Date.now(); try { const entries = (await readdir(safe(root, path), { withFileTypes: true })).map((e) => `${e.name}${e.isDirectory() ? '/' : ''}`).sort(); return ok({ entries }, entries.length ? `${entries.length} entries` : 'No entries', started); } catch (e) { return fail<{ entries: string[] }>((e as NodeJS.ErrnoException).code === 'ENOENT' ? 'NOT_FOUND' : 'INVALID_ARGUMENT', e instanceof Error ? e.message : String(e), started); }
}

export async function readText(root: string, path: string, maxChars = 100_000): Promise<ToolObservation<{ path: string; content: string }>> {
  const started = Date.now(); try { const target = safe(root, path); const content = await readFile(target, 'utf8'); const truncated = content.length > maxChars; const value = truncated ? content.slice(0, maxChars) : content; return { ...ok({ path: relative(resolve(root), target), content: value }, truncated ? 'Content truncated' : 'Read successfully', started), status: truncated ? 'partial' : 'success', metadata: { duration_ms: Date.now() - started, truncated, content_hash: createHash('sha256').update(content).digest('hex') } }; } catch (e) { return fail((e as NodeJS.ErrnoException).code === 'ENOENT' ? 'NOT_FOUND' : 'INVALID_ARGUMENT', e instanceof Error ? e.message : String(e), started) as ToolObservation<{ path: string; content: string }>; }
}

export async function globFiles(root: string, pattern = '**/*'): Promise<ToolObservation<{ paths: string[] }>> {
  const started = Date.now(); const suffix = pattern.replace(/^\*\*\//, '').replace(/^\*\./, '.'); const found: string[] = [];
  async function walk(dir: string) { for (const entry of await readdir(dir, { withFileTypes: true })) { const absolute = join(dir, entry.name); const rel = relative(resolve(root), absolute); if (entry.isDirectory()) await walk(absolute); else if (pattern === '**/*' || rel.endsWith(suffix) || rel === pattern) found.push(rel); } }
  try { await walk(resolve(root)); found.sort(); return ok({ paths: found }, found.length ? `${found.length} files` : 'No files matched', started); } catch (e) { return fail('NOT_FOUND', e instanceof Error ? e.message : String(e), started) as ToolObservation<{ paths: string[] }>; }
}

export async function grepFiles(root: string, pattern: string, path = ''): Promise<ToolObservation<{ matches: { file: string; line: number; text: string }[] }>> {
  const started = Date.now(); const matches: { file: string; line: number; text: string }[] = [];
  try {
    const target = safe(root, path); const files = (await globFiles(target, '**/*')).data?.paths ?? [];
    const regex = new RegExp(pattern);
    for (const file of files) { const content = await readFile(join(target, file), 'utf8').catch(() => ''); content.split(/\r?\n/).forEach((text, index) => { regex.lastIndex = 0; if (regex.test(text)) matches.push({ file: relative(resolve(root), join(target, file)), line: index + 1, text }); }); }
    return ok({ matches }, matches.length ? `${matches.length} matches` : 'No matches', started);
  } catch (e) { return fail<{ matches: { file: string; line: number; text: string }[] }>((e as Error).message.includes('outside') ? 'INVALID_ARGUMENT' : 'INVALID_ARGUMENT', e instanceof Error ? e.message : String(e), started); }
}

export async function writeText(root: string, path: string, content: string, expectedHash?: string): Promise<ToolObservation<{ path: string; content_hash: string }>> {
  const started = Date.now();
  try {
    const target = safe(root, path); const current = await readFile(target).catch(() => undefined);
    if (expectedHash && current && createHash('sha256').update(current).digest('hex') !== expectedHash) return fail<{ path: string; content_hash: string }>('CONFLICT', 'File changed since it was read', started);
    await mkdir(dirname(target), { recursive: true }); await writeFile(target, content, 'utf8'); const hash = createHash('sha256').update(content).digest('hex');
    return { status: 'success', data: { path: relative(resolve(root), target), content_hash: hash }, text: 'File written successfully', metadata: { duration_ms: Date.now() - started, truncated: false, content_hash: hash } };
  } catch (e) { return fail<{ path: string; content_hash: string }>((e as NodeJS.ErrnoException).code === 'ENOENT' ? 'NOT_FOUND' : 'INVALID_ARGUMENT', e instanceof Error ? e.message : String(e), started); }
}

export async function editText(root: string, path: string, oldText: string, newText: string, expectedHash?: string): Promise<ToolObservation<{ path: string; content_hash: string; replacements: number }>> {
  const started = Date.now();
  try {
    const target = safe(root, path); const current = await readFile(target, 'utf8'); const currentHash = createHash('sha256').update(current).digest('hex');
    if (expectedHash && expectedHash !== currentHash) return fail('CONFLICT', 'File changed since it was read', started);
    const count = current.split(oldText).length - 1;
    if (count === 0) return fail('NOT_FOUND', 'old_text was not found', started);
    if (count > 1) return fail('CONFLICT', 'old_text matched more than once', started);
    const content = current.replace(oldText, newText); await writeFile(target, content, 'utf8'); const hash = createHash('sha256').update(content).digest('hex');
    return { status: 'success', data: { path: relative(resolve(root), target), content_hash: hash, replacements: 1 }, text: 'File edited successfully', metadata: { duration_ms: Date.now() - started, truncated: false, content_hash: hash } };
  } catch (e) { return fail<{ path: string; content_hash: string; replacements: number }>((e as NodeJS.ErrnoException).code === 'ENOENT' ? 'NOT_FOUND' : 'INVALID_ARGUMENT', e instanceof Error ? e.message : String(e), started); }
}

export async function multiEditText(root: string, path: string, edits: { old_text: string; new_text: string }[], expectedHash?: string): Promise<ToolObservation<{ path: string; content_hash: string; replacements: number }>> {
  const started = Date.now();
  try {
    const target = safe(root, path); let content = await readFile(target, 'utf8'); const initial = createHash('sha256').update(content).digest('hex');
    if (expectedHash && expectedHash !== initial) return fail('CONFLICT', 'File changed since it was read', started);
    for (const edit of edits) { const count = content.split(edit.old_text).length - 1; if (count === 0) return fail('NOT_FOUND', 'old_text was not found', started); if (count > 1) return fail('CONFLICT', 'old_text matched more than once', started); content = content.replace(edit.old_text, edit.new_text); }
    await writeFile(target, content, 'utf8'); const hash = createHash('sha256').update(content).digest('hex');
    return { status: 'success', data: { path: relative(resolve(root), target), content_hash: hash, replacements: edits.length }, text: `${edits.length} edits applied`, metadata: { duration_ms: Date.now() - started, truncated: false, content_hash: hash } };
  } catch (e) { return fail<{ path: string; content_hash: string; replacements: number }>((e as NodeJS.ErrnoException).code === 'ENOENT' ? 'NOT_FOUND' : 'INVALID_ARGUMENT', e instanceof Error ? e.message : String(e), started); }
}
