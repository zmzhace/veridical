import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonlSpecRegistry, DuplicateSpecError, parseSpecYaml } from '../src/index';

function specAt(version: string) {
  return parseSpecYaml(`
name: svc
version: ${version}
schema_version: 1
instruction:
  system: test
flow:
  mode: single-loop
  max_steps: 3
llm:
  provider: mock
  model: m
tools:
  - name: echo
    access: allow
`);
}

describe('JsonlSpecRegistry', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'rt-spec-')); });

  it('persists and reloads registered specs', async () => {
    const reg = new JsonlSpecRegistry(dir);
    await reg.register(specAt('1.0.0'));
    const reloaded = new JsonlSpecRegistry(dir);
    expect((await reloaded.resolve('svc', '1.0.0'))?.version).toBe('1.0.0');
  });

  it('resolves latest by highest semver', async () => {
    const reg = new JsonlSpecRegistry(dir);
    await reg.register(specAt('1.0.0'));
    await reg.register(specAt('2.0.0'));
    const reloaded = new JsonlSpecRegistry(dir);
    expect((await reloaded.resolve('svc'))?.version).toBe('2.0.0');
  });

  it('rejects duplicate registration', async () => {
    const reg = new JsonlSpecRegistry(dir);
    await reg.register(specAt('1.0.0'));
    await expect(new JsonlSpecRegistry(dir).register(specAt('1.0.0'))).rejects.toThrow(DuplicateSpecError);
  });

  it('lists all persisted specs', async () => {
    const reg = new JsonlSpecRegistry(dir);
    await reg.register(specAt('1.0.0'));
    await reg.register(specAt('1.0.1'));
    const reloaded = new JsonlSpecRegistry(dir);
    expect((await reloaded.list()).map(s => s.version).sort()).toEqual(['1.0.0', '1.0.1']);
  });
});
