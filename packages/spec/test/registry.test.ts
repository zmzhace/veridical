import { describe, it, expect } from 'vitest';
import { InMemorySpecRegistry, DuplicateSpecError, parseSpecYaml } from '../src/index';

function specAt(version: string, name = 'svc') {
  return parseSpecYaml(`
name: ${name}
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

describe('InMemorySpecRegistry', () => {
  it('resolves an exact version', async () => {
    const reg = new InMemorySpecRegistry();
    await reg.register(specAt('1.0.0'));
    expect((await reg.resolve('svc', '1.0.0'))?.version).toBe('1.0.0');
  });

  it('resolves latest by highest semver', async () => {
    const reg = new InMemorySpecRegistry();
    await reg.register(specAt('1.0.0'));
    await reg.register(specAt('1.1.0'));
    await reg.register(specAt('2.0.0'));
    expect((await reg.resolve('svc'))?.version).toBe('2.0.0');
  });

  it('returns undefined when nothing is registered', async () => {
    const reg = new InMemorySpecRegistry();
    expect(await reg.resolve('nope')).toBeUndefined();
    expect(await reg.resolve('svc', '9.9.9')).toBeUndefined();
  });

  it('keeps multiple versions coexisting', async () => {
    const reg = new InMemorySpecRegistry();
    await reg.register(specAt('1.0.0'));
    await reg.register(specAt('1.0.1'));
    expect((await reg.resolve('svc', '1.0.0'))?.version).toBe('1.0.0');
    expect((await reg.resolve('svc', '1.0.1'))?.version).toBe('1.0.1');
  });

  it('rejects duplicate registration', async () => {
    const reg = new InMemorySpecRegistry();
    await reg.register(specAt('1.0.0'));
    await expect(reg.register(specAt('1.0.0'))).rejects.toThrow(DuplicateSpecError);
  });

  it('lists all registered specs', async () => {
    const reg = new InMemorySpecRegistry();
    await reg.register(specAt('1.0.0'));
    await reg.register(specAt('1.0.1'));
    expect((await reg.list()).length).toBe(2);
  });
});
