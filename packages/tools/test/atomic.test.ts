import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { editText, globFiles, listFiles, readText, writeText } from '../src';

describe('atomic file tools', () => {
  it('distinguishes empty results and missing paths while enforcing workspace boundaries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'veridical-tools-')); await mkdir(join(root, 'src')); await writeFile(join(root, 'src', 'a.ts'), 'hello');
    expect((await listFiles(root, 'src')).status).toBe('success');
    expect((await globFiles(root, '**/*.xyz')).status).toBe('empty');
    expect((await readText(root, 'missing.txt')).error?.code).toBe('NOT_FOUND');
    expect((await readText(root, '../outside')).error?.code).toBe('INVALID_ARGUMENT');
  });
  it('uses expected hashes to prevent lost updates', async () => {
    const root = await mkdtemp(join(tmpdir(), 'veridical-tools-')); const file = join(root, 'a.txt'); await writeFile(file, 'one');
    const hash = (await readText(root, 'a.txt')).metadata.content_hash!;
    expect((await writeText(root, 'a.txt', 'two', 'bad')).error?.code).toBe('CONFLICT');
    expect((await writeText(root, 'a.txt', 'two', hash)).status).toBe('success');
  });
  it('requires exactly one edit match', async () => {
    const root = await mkdtemp(join(tmpdir(), 'veridical-tools-')); const file = join(root, 'a.txt'); await writeFile(file, 'a\na');
    expect((await editText(root, 'a.txt', 'b', 'c')).error?.code).toBe('NOT_FOUND');
    expect((await editText(root, 'a.txt', 'a', 'c')).error?.code).toBe('CONFLICT');
  });
});
