import { describe, it, expect } from 'vitest';
import { parseSpecYaml } from '../src/index';

const VALID = `
name: claim-filing
description: 报案场景
version: 1.0.0
schema_version: 1
instruction:
  system: |
    You are a claim filing assistant. Collect slots: policy_no, date, location.
flow:
  mode: single-loop
  max_steps: 8
llm:
  provider: mock
  model: m
  fallback: []
tools:
  - name: get_map
    access: allow
  - name: send_notice
    access: ask
    deterministic: false
`;

describe('parseSpecYaml', () => {
  it('parses a valid spec', () => {
    const spec = parseSpecYaml(VALID);
    expect(spec.name).toBe('claim-filing');
    expect(spec.version).toBe('1.0.0');
    expect(spec.flow.mode).toBe('single-loop');
    expect(spec.flow.max_steps).toBe(8);
    expect(spec.llm.provider).toBe('mock');
    expect(spec.tools.map(t => t.name)).toEqual(['get_map', 'send_notice']);
    expect(spec.tools[1].access).toBe('ask');
    expect(spec.tools[1].deterministic).toBe(false);
  });

  it('defaults fallback to empty array when omitted', () => {
    const spec = parseSpecYaml(VALID.replace('\n  fallback: []\n', '\n'));
    expect(spec.llm.fallback).toEqual([]);
  });

  it('rejects a missing name', () => {
    const bad = VALID.replace('name: claim-filing\n', '');
    expect(() => parseSpecYaml(bad)).toThrow();
  });

  it('rejects an invalid semver version', () => {
    const bad = VALID.replace('version: 1.0.0', 'version: not-a-version');
    expect(() => parseSpecYaml(bad)).toThrow();
  });

  it('rejects duplicate tool names', () => {
    const bad = VALID.replace('- name: send_notice\n', '- name: get_map\n');
    expect(() => parseSpecYaml(bad)).toThrow();
  });

  it('rejects an unknown flow mode', () => {
    const bad = VALID.replace('mode: single-loop', 'mode: router');
    expect(() => parseSpecYaml(bad)).toThrow();
  });
});
