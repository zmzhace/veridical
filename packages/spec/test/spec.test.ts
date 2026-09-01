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
    expect(spec.tools.map((t) => t.name)).toEqual(['get_map', 'send_notice']);
    expect(spec.tools[1].access).toBe('ask');
    expect(spec.tools[1].deterministic).toBe(false);
    expect(spec.output).toMatchObject({ profile: 'conversational', message_format: 'markdown', strict: true });
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

describe('supervisor spec', () => {
  it('parses agents list and supervisor flow mode', () => {
    const spec = parseSpecYaml(`
name: hub
version: 1.0.0
schema_version: 1
instruction: { system: you are a hub }
flow: { mode: supervisor, max_steps: 2 }
llm: { provider: mock, model: m, fallback: [] }
tools: []
agents:
  - name: claims-agent
    spec_ref: claims@1.0.0
    when: 客户询问理赔
`);
    expect(spec.flow.mode).toBe('supervisor');
    expect(spec.agents).toHaveLength(1);
    expect(spec.agents[0].name).toBe('claims-agent');
    expect(spec.agents[0].spec_ref).toBe('claims@1.0.0');
  });

  it('defaults agents to empty when omitted (single-loop unchanged)', () => {
    const spec = parseSpecYaml(`
name: plain
version: 1.0.0
schema_version: 1
instruction: { system: hi }
flow: { mode: single-loop, max_steps: 1 }
llm: { provider: mock, model: m, fallback: [] }
tools: []
`);
    expect(spec.flow.mode).toBe('single-loop');
    expect(spec.agents).toEqual([]);
  });

  it('rejects supervisor mode without agents', () => {
    expect(() =>
      parseSpecYaml(`
name: hub
version: 1.0.0
schema_version: 1
instruction: { system: you are a hub }
flow: { mode: supervisor, max_steps: 2 }
llm: { provider: mock, model: m, fallback: [] }
tools: []
`),
    ).toThrow();
  });

  it('accepts an inline child agent without a separate spec file', () => {
    const spec = parseSpecYaml(`
name: inline-hub
version: 1.0.0
schema_version: 1
instruction: { system: you are a hub }
flow: { mode: supervisor, max_steps: 2 }
llm: { provider: mock, model: m, fallback: [] }
tools: []
agents:
  - name: order-helper
    inline:
      instruction: { system: check the order and explain the result }
      llm: { provider: mock, model: m }
`);
    expect(spec.agents[0].spec_ref).toBeUndefined();
    expect(spec.agents[0].inline?.tools[0].name).toBe('finish');
  });
});

import { parseSpecYaml } from '../src/spec';

describe('stage-gate spec', () => {
  it('parses stages with gates', () => {
    const spec = parseSpecYaml(`
name: transfer-advisor
version: 1.0.0
schema_version: 1
instruction: { system: 你是转保顾问 }
flow:
  mode: stage-gate
  max_steps: 3
  stages:
    - id: health_check
      gate: { tool_called: verify_health }
    - id: close
llm: { provider: mock, model: m, fallback: [] }
tools:
  - name: verify_health
    access: allow
  - name: submit_transfer
    access: allow
`);
    expect(spec.flow.mode).toBe('stage-gate');
    expect(spec.flow.stages).toHaveLength(2);
    expect(spec.flow.stages[0].gate?.tool_called).toBe('verify_health');
    expect(spec.flow.stages[1].gate).toBeUndefined();
  });

  it('rejects stage-gate without stages', () => {
    expect(() =>
      parseSpecYaml(`
name: bad
version: 1.0.0
schema_version: 1
instruction: { system: hi }
flow: { mode: stage-gate, max_steps: 3 }
llm: { provider: mock, model: m, fallback: [] }
tools: []
`),
    ).toThrow();
  });

  it('rejects stage-gate gate tool not in tools', () => {
    expect(() =>
      parseSpecYaml(`
name: bad2
version: 1.0.0
schema_version: 1
instruction: { system: hi }
flow:
  mode: stage-gate
  max_steps: 3
  stages:
    - id: s1
      gate: { tool_called: ghost_tool }
llm: { provider: mock, model: m, fallback: [] }
tools: []
`),
    ).toThrow();
  });

  it('single-loop without stages still parses (compat)', () => {
    const spec = parseSpecYaml(`
name: plain
version: 1.0.0
schema_version: 1
instruction: { system: hi }
flow: { mode: single-loop, max_steps: 1 }
llm: { provider: mock, model: m, fallback: [] }
tools: []
`);
    expect(spec.flow.mode).toBe('single-loop');
    expect(spec.flow.stages).toBeUndefined();
  });
});
