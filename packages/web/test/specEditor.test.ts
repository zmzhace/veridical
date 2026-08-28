import { describe, expect, test } from 'vitest';
import {
  blankSpec,
  editorYaml,
  formToSpec,
  nextVersion,
  readEditorYaml,
  specToForm,
  suggestTools,
  validateSpec,
} from '../src/spec/editor';

const form = () => ({
  ...blankSpec(),
  name: 'assistant',
  system: 'Only answer the task.',
  llmProvider: 'mock',
  llmModel: 'mock-v1',
});

test('round trips all supported fields without dropping inactive flow configuration', () => {
  const f = {
    ...form(),
    description: '配置测试',
    tools: [{ name: 'echo', access: 'allow' as const, deterministic: true }],
    fallbacks: [{ provider: 'backup', model: 'b' }],
    stages: [{ id: 's1', tool: 'echo' }],
    agents: [{ name: 'helper', specRef: 'helper@1.0.0', when: 'review' }],
  };
  const parsed = readEditorYaml(editorYaml(f));
  expect(parsed.errors).toEqual({});
  expect(specToForm(parsed.spec!)).toEqual(f);
});

test('a child agent can be authored inline and compiled without a child spec reference', () => {
  const f = {
    ...form(),
    mode: 'supervisor' as const,
    agents: [{ name: '订单专家', specRef: '', when: '', system: '检查订单状态并解释异常。' }],
  };
  const parsed = readEditorYaml(editorYaml(f));
  expect(parsed.errors).toEqual({});
  expect(parsed.spec?.agents[0].spec_ref).toBeUndefined();
  expect(parsed.spec?.agents[0].inline?.instruction.system).toContain('订单');
});

describe('validates against the shared server schema', () => {
  test.each([
    ['version', { version: 'latest' }],
    ['schema_version', { schemaVersion: 0 }],
    ['flow.max_steps', { maxSteps: 0 }],
    ['flow.max_steps', { maxSteps: 1.5 }],
    ['flow.max_steps', { maxSteps: NaN }],
    ['instruction.system', { system: '   ' }],
    ['name', { name: '../unsafe' }],
    ['llm.fallback.0.model', { fallbacks: [{ provider: 'backup', model: '' }] }],
    ['tools.0.name', { tools: [{ name: '', access: 'deny', deterministic: false }] }],
    [
      'tools',
      {
        tools: [
          { name: 'echo', access: 'allow' },
          { name: 'echo', access: 'deny' },
        ],
      },
    ],
    ['agents', { mode: 'supervisor' }],
    ['flow.stages', { mode: 'stage-gate' }],
    ['flow.stages', { mode: 'stage-gate', stages: [{ id: 's1', tool: 'missing' }] }],
    [
      'flow.stages',
      {
        mode: 'stage-gate',
        stages: [
          { id: 'same', tool: '' },
          { id: 'same', tool: '' },
        ],
      },
    ],
  ])('rejects invalid %s', (field, patch) => {
    expect(
      validateSpec(formToSpec({ ...form(), ...patch } as ReturnType<typeof form>)).errors[field],
    ).toBeTruthy();
  });
});

test('YAML syntax errors and duplicate keys are not silently accepted', () => {
  expect(readEditorYaml('name: [').errors.yaml).toContain('YAML 格式错误');
  expect(readEditorYaml(`${editorYaml(form())}\nname: duplicate`).errors.yaml).toContain(
    'YAML 格式错误',
  );
});

test('unknown top-level and nested YAML fields cannot be silently stripped', () => {
  expect(readEditorYaml(`${editorYaml(form())}\napi_key: do-not-store-here`).errors.yaml).toContain(
    'api_key',
  );
  expect(
    readEditorYaml(editorYaml(form()).replace('  model:', '  temperature: 0.5\n  model:')).errors
      .yaml,
  ).toContain('llm.temperature');
});

test('next version avoids collisions and never changes the original', () => {
  expect(nextVersion('1.2.3', ['1.2.3', '1.2.4', '1.2.5'])).toBe('1.2.6');
  expect(nextVersion('1.2.3-beta.1', [])).toBe('1.2.4');
});

test('tool suggestions are deterministic, deduplicated and conservative for writes', () => {
  expect(suggestTools('查询订单并计算金额，必要时更新订单')).toEqual([
    { name: 'search', access: 'ask', deterministic: false },
    { name: 'calculator', access: 'allow', deterministic: true },
    { name: 'write', access: 'ask', deterministic: false },
    { name: 'finish', access: 'allow', deterministic: true },
  ]);
  expect(suggestTools('写写写')).toEqual([
    { name: 'write', access: 'ask', deterministic: false },
    { name: 'finish', access: 'allow', deterministic: true },
  ]);
});
