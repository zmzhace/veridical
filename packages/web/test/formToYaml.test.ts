import { test, expect } from 'vitest';
import { formToYaml, type SpecFormState } from '../src/spec/formToYaml';

function base(): SpecFormState {
  return {
    name: 'n', version: '0.1.0', schemaVersion: 1, description: '',
    system: 'hi', llmProvider: 'mock', llmModel: 'm', fallbacks: [],
    mode: 'single-loop', maxSteps: 10, stages: [], agents: [], tools: [],
  };
}

test('serializes minimal single-loop spec', () => {
  const y = formToYaml(base());
  expect(y).toContain('name: "n"');
  expect(y).toContain('version: "0.1.0"');
  expect(y).toContain('schema_version: 1');
  expect(y).toContain('mode: single-loop');
  expect(y).toContain('tools: []');
});

test('serializes tools, fallbacks, stage-gate stages, supervisor agents', () => {
  const f = base();
  f.tools = [{ name: 't1', access: 'allow', deterministic: true }];
  f.fallbacks = [{ provider: 'p', model: 'm2' }];
  f.mode = 'stage-gate';
  f.stages = [{ id: 's1', tool: 't1' }];
  f.agents = [{ name: 'a1', specRef: 'a-spec', when: 'always' }];
  const y = formToYaml(f);
  expect(y).toContain('- name: "t1"');
  expect(y).toContain('access: allow');
  expect(y).toContain('deterministic: true');
  expect(y).toContain('tool_called: "t1"');
  expect(y).toContain('provider: "p"');
  expect(y).toContain('spec_ref: "a-spec"');
});

test('omits empty description and filters blank tool rows', () => {
  const f = base();
  f.tools = [{ name: '', access: 'allow', deterministic: false }, { name: 't2', access: 'deny', deterministic: false }];
  const y = formToYaml(f);
  expect(y).not.toContain('description:');
  expect(y).toContain('- name: "t2"');
  expect(y).toContain('access: deny');
  expect(y.match(/- name:/g)?.length).toBe(1);
});