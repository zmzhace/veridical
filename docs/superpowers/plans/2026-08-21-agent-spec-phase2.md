# Agent Spec System (Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the agent spec system — declarative YAML spec (metadata, instruction, flow, LLM routing, tool whitelist) with zod validation, semver versioning + registry (in-memory and JSONL), and a `SpecRunner` that reads a spec and drives the Phase 1 single-loop flow engine with spec-bound trace events.

**Architecture:** New package `@veridical/spec` layered on the Phase 1 packages (`schema`/`store`/`runtime`/`tools`/`llm`). Declaration layer: `AgentSpecSchema` (zod) + `parseSpecYaml`; registry layer: `SpecRegistry` interface with `InMemorySpecRegistry` and `JsonlSpecRegistry` (immutable registration, semver `latest` resolution); execution layer: `SpecRunner` (`runSpec`) that assembles Session/Recorder/LLMGateway/ToolBroker from the spec, runs `runSingleLoop`, and emits `spec/run/start` + `spec/run/end` events.

**Tech Stack:** TypeScript (strict), pnpm workspaces, vitest, zod, `yaml` (parsing), `semver` (version comparison), node:fs/node:crypto.

## Global Constraints

- TypeScript strict mode throughout (`"strict": true`).
- Monorepo via pnpm workspaces under `packages/*`.
- Testing with vitest; every feature task uses TDD (write failing test → run → implement → run pass).
- No code comments unless they explain non-obvious logic.
- Node-API packages (use `node:fs`/`node:crypto`) need `@types/node` devDep + tsconfig `types: ["vitest/globals", "node"]` (Phase 1 pattern, see `packages/llm/tsconfig.json`).
- New package name: `@veridical/spec` (version 0.0.1, `type: module`, `main: src/index.ts`).
- New runtime deps: `yaml` and `semver` (only in `@veridical/spec`).
- Event schema stays single-sourced in `@veridical/schema`.
- spec registration is **immutable**: duplicate `(name, version)` registration throws `DuplicateSpecError`.
- `resolve(name, version?)`: explicit version → exact match; omitted → `latest` (highest semver for that name).
- `flow.mode` supports only `single-loop` in Phase 2 (enum reserved for more).
- Commit after every task with a conventional message.
- Node >= 20.19, pnpm >= 9.

---

### Task 1: `@veridical/spec` scaffold + AgentSpec schema + parseSpecYaml

**Files:**
- Create: `packages/spec/package.json`
- Create: `packages/spec/tsconfig.json`
- Create: `packages/spec/src/index.ts`
- Create: `packages/spec/src/spec.ts`
- Test: `packages/spec/test/spec.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks (only `yaml`, `semver`, `zod`).
- Produces:
  - `type AgentSpec` — the zod-inferred spec object (fields: `name`, `description?`, `version`, `schema_version`, `instruction.system`, `flow.{mode,max_steps}`, `llm.{provider,model,fallback[]}`, `tools[]`).
  - `function parseSpecYaml(yamlText: string): AgentSpec` — YAML → zod-validated `AgentSpec`, throws on invalid.

- [ ] **Step 1: Write the failing test**

```ts
// packages/spec/test/spec.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm install && pnpm -F @veridical/spec test`
Expected: FAIL — `@veridical/spec` package not found / `parseSpecYaml` not exported.

- [ ] **Step 3: Write minimal implementation**

`packages/spec/package.json`:
```json
{
  "name": "@veridical/spec",
  "version": "0.0.1",
  "type": "module",
  "main": "src/index.ts",
  "dependencies": {
    "yaml": "^2.4.2",
    "semver": "^7.6.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@types/node": "^26.2.0",
    "@types/semver": "^7.5.0",
    "typescript": "^5.0.0",
    "vitest": "^3.0.0"
  },
  "scripts": { "build": "tsc -p tsconfig.json", "test": "vitest run" }
}
```

`packages/spec/tsconfig.json`:
```json
{ "extends": "../../tsconfig.base.json", "compilerOptions": { "outDir": "dist", "types": ["vitest/globals", "node"] }, "include": ["src"] }
```

`packages/spec/src/spec.ts`:
```ts
import { z } from 'zod';
import { parse as parseYaml } from 'yaml';
import { valid } from 'semver';

export const AccessSchema = z.enum(['allow', 'deny', 'ask']);
export type Access = z.infer<typeof AccessSchema>;

export const FlowModeSchema = z.enum(['single-loop']);
export type FlowMode = z.infer<typeof FlowModeSchema>;

const FallbackSchema = z.object({ provider: z.string().min(1), model: z.string().min(1) });

export const AgentSpecSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  version: z.string().min(1),
  schema_version: z.number().int().positive(),
  instruction: z.object({ system: z.string() }),
  flow: z.object({ mode: FlowModeSchema, max_steps: z.number().int().positive() }),
  llm: z.object({
    provider: z.string().min(1),
    model: z.string().min(1),
    fallback: z.array(FallbackSchema).default([]),
  }),
  tools: z.array(z.object({
    name: z.string().min(1),
    access: AccessSchema,
    deterministic: z.boolean().optional(),
  })),
}).superRefine((spec, ctx) => {
  if (!valid(spec.version)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['version'], message: `invalid semver: ${spec.version}` });
  }
  const names = spec.tools.map(t => t.name);
  if (new Set(names).size !== names.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['tools'], message: 'duplicate tool name' });
  }
});

export type AgentSpec = z.infer<typeof AgentSpecSchema>;

export function parseSpecYaml(yamlText: string): AgentSpec {
  return AgentSpecSchema.parse(parseYaml(yamlText));
}
```

`packages/spec/src/index.ts`:
```ts
export * from './spec';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm install && pnpm -F @veridical/spec test`
Expected: PASS (all 6 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/spec pnpm-lock.yaml
git commit -m "feat: agent spec schema with YAML parsing and validation"
```

---

### Task 2: SpecRegistry interface + InMemorySpecRegistry

**Files:**
- Create: `packages/spec/src/registry.ts`
- Create: `packages/spec/src/in-memory.ts`
- Modify: `packages/spec/src/index.ts` (add exports)
- Test: `packages/spec/test/registry.test.ts`

**Interfaces:**
- Consumes: `AgentSpec`, `parseSpecYaml` from Task 1.
- Produces:
  - `class DuplicateSpecError extends Error` — thrown on duplicate registration.
  - `interface SpecRegistry { register(spec: AgentSpec): Promise<void>; resolve(name: string, version?: string): Promise<AgentSpec | undefined>; list(): Promise<AgentSpec[]> }`
  - `class InMemorySpecRegistry implements SpecRegistry`

- [ ] **Step 1: Write the failing test**

```ts
// packages/spec/test/registry.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @veridical/spec test`
Expected: FAIL — `InMemorySpecRegistry` / `DuplicateSpecError` not exported.

- [ ] **Step 3: Write minimal implementation**

`packages/spec/src/registry.ts`:
```ts
import type { AgentSpec } from './spec';

export class DuplicateSpecError extends Error {
  constructor(name: string, version: string) {
    super(`spec already registered: ${name}@${version}`);
    this.name = 'DuplicateSpecError';
  }
}

export interface SpecRegistry {
  register(spec: AgentSpec): Promise<void>;
  resolve(name: string, version?: string): Promise<AgentSpec | undefined>;
  list(): Promise<AgentSpec[]>;
}
```

`packages/spec/src/in-memory.ts`:
```ts
import { gt } from 'semver';
import type { AgentSpec } from './spec';
import { DuplicateSpecError, type SpecRegistry } from './registry';

export class InMemorySpecRegistry implements SpecRegistry {
  private specs = new Map<string, AgentSpec>();

  private key(name: string, version: string): string {
    return `${name}@${version}`;
  }

  async register(spec: AgentSpec): Promise<void> {
    const k = this.key(spec.name, spec.version);
    if (this.specs.has(k)) throw new DuplicateSpecError(spec.name, spec.version);
    this.specs.set(k, spec);
  }

  async resolve(name: string, version?: string): Promise<AgentSpec | undefined> {
    if (version) return this.specs.get(this.key(name, version));
    let best: AgentSpec | undefined;
    for (const spec of this.specs.values()) {
      if (spec.name !== name) continue;
      if (!best || gt(spec.version, best.version)) best = spec;
    }
    return best;
  }

  async list(): Promise<AgentSpec[]> {
    return [...this.specs.values()];
  }
}
```

`packages/spec/src/index.ts` (add):
```ts
export * from './spec';
export * from './registry';
export * from './in-memory';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -F @veridical/spec test`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add packages/spec
git commit -m "feat: spec registry with in-memory implementation"
```

---

### Task 3: JsonlSpecRegistry

**Files:**
- Create: `packages/spec/src/jsonl.ts`
- Modify: `packages/spec/src/index.ts` (add export)
- Test: `packages/spec/test/jsonl.test.ts`

**Interfaces:**
- Consumes: `AgentSpecSchema` (Task 1), `DuplicateSpecError` / `SpecRegistry` (Task 2).
- Produces:
  - `class JsonlSpecRegistry implements SpecRegistry` — one file per `(name, version)` at `<dir>/<name>@<version>.jsonl`, one JSON line per registration; reuses the same resolve semantics as `InMemorySpecRegistry`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/spec/test/jsonl.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @veridical/spec test`
Expected: FAIL — `JsonlSpecRegistry` not exported.

- [ ] **Step 3: Write minimal implementation**

`packages/spec/src/jsonl.ts`:
```ts
import { mkdirSync, readdirSync, readFileSync, appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { gt } from 'semver';
import { AgentSpecSchema, type AgentSpec } from './spec';
import { DuplicateSpecError, type SpecRegistry } from './registry';

export class JsonlSpecRegistry implements SpecRegistry {
  constructor(private dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  private file(name: string, version: string): string {
    return join(this.dir, `${name}@${version}.jsonl`);
  }

  async register(spec: AgentSpec): Promise<void> {
    const f = this.file(spec.name, spec.version);
    if (existsSync(f)) throw new DuplicateSpecError(spec.name, spec.version);
    appendFileSync(f, JSON.stringify(spec) + '\n', 'utf8');
  }

  async resolve(name: string, version?: string): Promise<AgentSpec | undefined> {
    const all = await this.list();
    if (version) return all.find(s => s.name === name && s.version === version);
    let best: AgentSpec | undefined;
    for (const s of all) {
      if (s.name !== name) continue;
      if (!best || gt(s.version, best.version)) best = s;
    }
    return best;
  }

  async list(): Promise<AgentSpec[]> {
    const out: AgentSpec[] = [];
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith('.jsonl')) continue;
      for (const line of readFileSync(join(this.dir, f), 'utf8').split('\n')) {
        if (line.trim() === '') continue;
        out.push(AgentSpecSchema.parse(JSON.parse(line)));
      }
    }
    return out;
  }
}
```

`packages/spec/src/index.ts` (add):
```ts
export * from './spec';
export * from './registry';
export * from './in-memory';
export * from './jsonl';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -F @veridical/spec test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/spec
git commit -m "feat: JSONL spec registry"
```

---

### Task 4: SpecRunner (runSpec + SpecApprovalPolicy + SpecRunError)

**Files:**
- Create: `packages/spec/src/runner.ts`
- Modify: `packages/spec/src/index.ts` (add exports)
- Modify: `packages/spec/package.json` (add `@veridical/*` workspace deps)
- Test: `packages/spec/test/runner.test.ts`

**Interfaces:**
- Consumes: `AgentSpec` (Task 1); Phase 1 packages — `TraceStore` (`@veridical/store`), `TraceEvent` (`@veridical/schema`), `Session`/`Recorder`/`runSingleLoop`/`FlowContext` (`@veridical/runtime`), `ToolBroker`/`ToolDef`/`ApprovalPolicy`/`ApprovalDecision` (`@veridical/tools`), `LLMGateway`/`LLMProvider`/`LLMRequest`/`LLMResponse` (`@veridical/llm`).
- Produces:
  - `class SpecRunError extends Error`
  - `class SpecApprovalPolicy implements ApprovalPolicy` — whitelist + access enforcement.
  - `interface RunnerStepCtx { llm: LLMGateway; spec: AgentSpec; recorder: Recorder; prompt: string }`
  - `interface SpecRunnerDeps { store: TraceStore; providers: Map<string, LLMProvider>; tools: ToolDef[]; policy?: ApprovalPolicy; onAsk?: (tool: ToolDef, args: unknown) => Promise<boolean> | boolean; runStep?: (ctx: RunnerStepCtx) => Promise<{ text: string; tool?: { name: string; args: unknown } }>; session_id?: string; tenant_id: string }`
  - `interface RunResult { session_id: string; spec_name: string; spec_version: string; outcome: unknown; events: TraceEvent[] }`
  - `function runSpec(deps: SpecRunnerDeps, spec: AgentSpec, prompt: string): Promise<RunResult>`

- [ ] **Step 1: Write the failing test**

```ts
// packages/spec/test/runner.test.ts
import { describe, it, expect } from 'vitest';
import { InMemoryTraceStore } from '@veridical/store';
import { ToolBroker, type ToolDef } from '@veridical/tools';
import type { LLMProvider } from '@veridical/llm';
import { parseSpecYaml, runSpec, SpecRunError, SpecApprovalPolicy } from '../src/index';

const SPEC_YAML = `
name: runner-test
version: 1.0.0
schema_version: 1
instruction:
  system: You are a test agent.
flow:
  mode: single-loop
  max_steps: 2
llm:
  provider: main
  model: m
  fallback:
    - provider: backup
      model: b
tools:
  - name: echo
    access: allow
`;

const usage = { input: 1, output: 1, cached: 0, total: 2 };
function provider(text: string): LLMProvider {
  return { complete: async () => ({ text, usage }) };
}
function echoTool(): ToolDef {
  return { id: 'echo', name: 'echo', description: '', deterministic: true, execute: async (a) => a };
}

describe('runSpec', () => {
  it('runs a single-loop spec and records spec-bound events', async () => {
    const store = new InMemoryTraceStore();
    const spec = parseSpecYaml(SPEC_YAML);
    const result = await runSpec(
      { store, providers: new Map([['main', provider('hi')], ['backup', provider('boo')]]), tools: [], tenant_id: 't1', session_id: 's1' },
      spec,
      'hello',
    );
    const types = result.events.map(e => e.type);
    for (const t of ['spec/run/start', 'turn/start', 'llm.request', 'llm.response', 'turn/end', 'spec/run/end']) {
      expect(types).toContain(t);
    }
    expect(result.spec_name).toBe('runner-test');
    expect(result.spec_version).toBe('1.0.0');
    expect(result.outcome).toBe('hi');
  });

  it('records a denied event for a library tool excluded by the spec whitelist', async () => {
    const store = new InMemoryTraceStore();
    const spec = parseSpecYaml(SPEC_YAML);
    const otherTool: ToolDef = { id: 'other', name: 'other', description: '', deterministic: true, execute: async (a) => a };
    const result = await runSpec(
      {
        store,
        providers: new Map([['main', provider('x')]]),
        tools: [echoTool(), otherTool],
        tenant_id: 't1',
        session_id: 's1',
        runStep: async () => ({ text: '', tool: { name: 'other', args: {} } }),
      },
      spec,
      'hello',
    );
    const denied = result.events.find(e => e.type === 'tool.result' && (e.payload as any)?.result?.reason === 'denied');
    expect(denied).toBeDefined();
  });

  it('falls back when the primary provider fails', async () => {
    const store = new InMemoryTraceStore();
    const spec = parseSpecYaml(SPEC_YAML);
    const boom: LLMProvider = { complete: async () => { throw new Error('boom'); } };
    const result = await runSpec(
      { store, providers: new Map([['main', boom], ['backup', provider('saved')]]), tools: [], tenant_id: 't1', session_id: 's1' },
      spec,
      'hello',
    );
    expect(result.outcome).toBe('saved');
    expect(result.events.some(e => e.type === 'llm.response' && e.verb === 'error')).toBe(true);
  });

  it('throws SpecRunError when all providers fail', async () => {
    const store = new InMemoryTraceStore();
    const spec = parseSpecYaml(SPEC_YAML);
    const boom: LLMProvider = { complete: async () => { throw new Error('boom'); } };
    await expect(
      runSpec({ store, providers: new Map([['main', boom], ['backup', boom]]), tools: [], tenant_id: 't1', session_id: 's1' }, spec, 'hello'),
    ).rejects.toThrow(SpecRunError);
  });

  it('throws SpecRunError when the primary provider is not registered', async () => {
    const store = new InMemoryTraceStore();
    const spec = parseSpecYaml(SPEC_YAML);
    await expect(
      runSpec({ store, providers: new Map([['other', provider('x')]]), tools: [], tenant_id: 't1', session_id: 's1' }, spec, 'hello'),
    ).rejects.toThrow(SpecRunError);
  });

  it('stops at max_steps', async () => {
    const store = new InMemoryTraceStore();
    const spec = parseSpecYaml(SPEC_YAML);
    const result = await runSpec(
      { store, providers: new Map([['main', provider('hi')]]), tools: [], tenant_id: 't1', session_id: 's1' },
      spec,
      'hello',
    );
    expect(result.events.filter(e => e.type === 'llm.request').length).toBe(2);
  });
});

describe('SpecApprovalPolicy', () => {
  it('allows whitelisted tools and denies others', async () => {
    const spec = parseSpecYaml(SPEC_YAML);
    const policy = new SpecApprovalPolicy(spec);
    expect(await policy.decide(echoTool(), {})).toBe('allow');
    expect(await policy.decide({ id: 'x', name: 'x', description: '', deterministic: true, execute: async (a) => a }, {})).toBe('deny');
  });

  it('delegates ask to the injected callback', async () => {
    const spec = parseSpecYaml(SPEC_YAML.replace('- name: echo\n    access: allow', '- name: echo\n    access: ask'));
    const policy = new SpecApprovalPolicy(spec, async () => true);
    expect(await policy.decide(echoTool(), {})).toBe('ask');
    expect(await policy.onAsk!(echoTool(), {})).toBe(true);
  });
});

describe('ToolBroker integration', () => {
  it('broker returns denied for a library tool excluded by the spec whitelist', async () => {
    const spec = parseSpecYaml(SPEC_YAML);
    const otherTool: ToolDef = { id: 'other', name: 'other', description: '', deterministic: true, execute: async (a) => a };
    const broker = new ToolBroker([echoTool(), otherTool], new SpecApprovalPolicy(spec));
    const r = await broker.call('other', {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('denied');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm install && pnpm -F @veridical/spec test`
Expected: FAIL — `runSpec` / `SpecApprovalPolicy` / `SpecRunError` not exported.

- [ ] **Step 3: Write minimal implementation**

`packages/spec/package.json` — add the `@veridical/*` workspace deps to `dependencies`:
```json
{
  "name": "@veridical/spec",
  "version": "0.0.1",
  "type": "module",
  "main": "src/index.ts",
  "dependencies": {
    "@veridical/schema": "workspace:*",
    "@veridical/store": "workspace:*",
    "@veridical/runtime": "workspace:*",
    "@veridical/tools": "workspace:*",
    "@veridical/llm": "workspace:*",
    "yaml": "^2.4.2",
    "semver": "^7.6.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@types/node": "^26.2.0",
    "@types/semver": "^7.5.0",
    "typescript": "^5.0.0",
    "vitest": "^3.0.0"
  },
  "scripts": { "build": "tsc -p tsconfig.json", "test": "vitest run" }
}
```

`packages/spec/src/runner.ts`:
```ts
import { randomUUID } from 'node:crypto';
import type { TraceStore } from '@veridical/store';
import type { TraceEvent } from '@veridical/schema';
import { Session, Recorder, runSingleLoop, type FlowContext } from '@veridical/runtime';
import { ToolBroker, type ApprovalDecision, type ApprovalPolicy, type ToolDef } from '@veridical/tools';
import { LLMGateway, type LLMProvider, type LLMRequest, type LLMResponse } from '@veridical/llm';
import type { AgentSpec } from './spec';

export class SpecRunError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'SpecRunError';
  }
}

export class SpecApprovalPolicy implements ApprovalPolicy {
  constructor(private spec: AgentSpec, private ask?: (tool: ToolDef, args: unknown) => Promise<boolean> | boolean) {}

  async decide(tool: ToolDef, _args: unknown): Promise<ApprovalDecision> {
    const entry = this.spec.tools.find(t => t.name === tool.name);
    return entry?.access ?? 'deny';
  }

  async onAsk(tool: ToolDef, args: unknown): Promise<boolean> {
    return this.ask ? await this.ask(tool, args) : false;
  }
}

export interface RunnerStepCtx {
  llm: LLMGateway;
  spec: AgentSpec;
  recorder: Recorder;
  prompt: string;
}

export interface SpecRunnerDeps {
  store: TraceStore;
  providers: Map<string, LLMProvider>;
  tools: ToolDef[];
  policy?: ApprovalPolicy;
  onAsk?: (tool: ToolDef, args: unknown) => Promise<boolean> | boolean;
  runStep?: (ctx: RunnerStepCtx) => Promise<{ text: string; tool?: { name: string; args: unknown } }>;
  session_id?: string;
  tenant_id: string;
}

export interface RunResult {
  session_id: string;
  spec_name: string;
  spec_version: string;
  outcome: unknown;
  events: TraceEvent[];
}

function requestFor(spec: AgentSpec, prompt: string): LLMRequest {
  return {
    provider: spec.llm.provider,
    model: spec.llm.model,
    messages: [
      { role: 'system', content: spec.instruction.system },
      { role: 'user', content: prompt },
    ],
  };
}

async function completeWithFallback(
  llm: LLMGateway,
  providers: Map<string, LLMProvider>,
  spec: AgentSpec,
  req: LLMRequest,
  recorder: Recorder,
): Promise<LLMResponse> {
  const chain = [{ provider: spec.llm.provider, model: spec.llm.model }, ...spec.llm.fallback];
  let lastErr: unknown;
  for (const r of chain) {
    if (!providers.has(r.provider)) continue;
    try {
      return await llm.complete({ ...req, provider: r.provider, model: r.model }, recorder);
    } catch (err) {
      lastErr = err;
      await recorder.record({
        span_id: 'llm', parent_span_id: null, type: 'llm.response', verb: 'error', attempt: 1, duration_ms: 0,
        payload: { provider: r.provider, model: r.model, message: err instanceof Error ? err.message : String(err) },
      });
    }
  }
  throw new SpecRunError(`all LLM providers failed: ${chain.map(c => c.provider).join(', ')}`, lastErr);
}

export async function runSpec(deps: SpecRunnerDeps, spec: AgentSpec, prompt: string): Promise<RunResult> {
  if (!deps.providers.has(spec.llm.provider)) {
    throw new SpecRunError(`llm provider not registered: ${spec.llm.provider}`);
  }
  const session_id = deps.session_id ?? `s_${randomUUID()}`;
  const session = new Session({ session_id, tenant_id: deps.tenant_id, spec_version: spec.version });
  const recorder = new Recorder(deps.store, session);
  const llm = new LLMGateway(deps.providers);
  const policy = deps.policy ?? new SpecApprovalPolicy(spec, deps.onAsk);
  const broker = new ToolBroker(deps.tools, policy);

  await recorder.record({
    span_id: 'spec', parent_span_id: null, type: 'spec/run/start', verb: 'request', attempt: 1, duration_ms: 0,
    payload: { spec_name: spec.name, spec_version: spec.version, input: prompt },
  });

  const defaultRunStep = async ({ llm, spec, recorder, prompt }: RunnerStepCtx) => {
    const res = await completeWithFallback(llm, deps.providers, spec, requestFor(spec, prompt), recorder);
    return { text: res.text };
  };
  const stepRun = deps.runStep ?? defaultRunStep;

  const ctx: FlowContext = {
    recorder,
    runStep: (p) => stepRun({ llm, spec, recorder, prompt: p }),
    executeTool: async (name, args) => {
      const r = await broker.call(name, args);
      return r.ok ? r.result : { ok: false, reason: r.reason };
    },
    shouldStop: () => false,
    verifyToolResult: () => true,
    maxSteps: spec.flow.max_steps,
  };

  await runSingleLoop(ctx, prompt);

  const events = await deps.store.readBySession(session_id);
  const endTurn = [...events].reverse().find(e => e.type === 'turn/end');
  const outcome = (endTurn?.payload as { outcome?: unknown } | undefined)?.outcome;

  await recorder.record({
    span_id: 'spec', parent_span_id: null, type: 'spec/run/end', verb: 'response', attempt: 1, duration_ms: 0,
    payload: { outcome },
  });

  return {
    session_id,
    spec_name: spec.name,
    spec_version: spec.version,
    outcome,
    events: await deps.store.readBySession(session_id),
  };
}
```

`packages/spec/src/index.ts` (add):
```ts
export * from './spec';
export * from './registry';
export * from './in-memory';
export * from './jsonl';
export * from './runner';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm install && pnpm -F @veridical/spec test`
Expected: PASS (all tests, including the `ToolBroker integration` block).

- [ ] **Step 5: Commit**

```bash
git add packages/spec pnpm-lock.yaml
git commit -m "feat: spec runner driving the single-loop flow"
```

---

### Task 5: Demo — spec-driven run

**Files:**
- Create: `packages/demo/src/spec-demo.ts`
- Create: `packages/demo/test/spec-smoke.test.ts`
- Modify: `packages/demo/package.json` (add `@veridical/spec` dep)

**Interfaces:**
- Consumes: `runSpec`/`parseSpecYaml`/`InMemorySpecRegistry` from `@veridical/spec`; `MockProvider`/`fingerprint` from `@veridical/llm`; `JsonlTraceStore` from `@veridical/store`.
- Produces:
  - `function runSpecDemo(dir: string): Promise<{ store: JsonlTraceStore; result: RunResult }>` — registers a claim-filing spec, runs it via `runSpec` with an injected tool-calling `runStep`, persists trace to JSONL.

- [ ] **Step 1: Write the failing test**

```ts
// packages/demo/test/spec-smoke.test.ts
import { describe, it, expect } from 'vitest';
import { runSpecDemo } from '../src/spec-demo';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('spec-driven demo', () => {
  it('runs a spec-driven agent and records spec-bound events', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rt-spec-'));
    const { store, result } = await runSpecDemo(dir);
    const events = await store.readBySession('spec_s1');
    const types = events.map(e => e.type);
    for (const t of ['spec/run/start', 'turn/start', 'llm.request', 'llm.response', 'tool.result', 'turn/end', 'spec/run/end']) {
      expect(types).toContain(t);
    }
    expect(result.spec_name).toBe('claim-filing');
    expect(result.spec_version).toBe('1.0.0');
    expect(result.events.length).toBe(events.length);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm install && pnpm -F @veridical/demo test`
Expected: FAIL — `runSpecDemo` not exported / `@veridical/spec` module not found.

- [ ] **Step 3: Write minimal implementation**

`packages/demo/package.json` — add `"@veridical/spec": "workspace:*"` to `dependencies`.

`packages/demo/src/spec-demo.ts`:
```ts
import { JsonlTraceStore } from '@veridical/store';
import { InMemorySpecRegistry, parseSpecYaml, runSpec, type RunResult } from '@veridical/spec';
import { MockProvider, fingerprint } from '@veridical/llm';

const SPEC_YAML = `
name: claim-filing
description: 报案场景：收集槽位并出报告
version: 1.0.0
schema_version: 1
instruction:
  system: |
    You are a claim filing assistant. Collect slots: policy_no, date, location.
flow:
  mode: single-loop
  max_steps: 3
llm:
  provider: mock
  model: m
  fallback: []
tools:
  - name: echo
    access: allow
`;

export async function runSpecDemo(dir: string): Promise<{ store: JsonlTraceStore; result: RunResult }> {
  const store = new JsonlTraceStore(dir);
  const registry = new InMemorySpecRegistry();
  const spec = parseSpecYaml(SPEC_YAML);
  await registry.register(spec);

  const messages = [
    { role: 'system', content: spec.instruction.system },
    { role: 'user', content: 'hello' },
  ];
  const mock = new MockProvider();
  mock.record(fingerprint({ provider: 'mock', model: 'm', messages }), 'call echo', { input: 1, output: 1, cached: 0, total: 2 });

  let calls = 0;
  const result = await runSpec(
    {
      store,
      providers: new Map([['mock', mock]]),
      tools: [{ id: 'echo', name: 'echo', description: 'echo', deterministic: true, execute: async (a) => a }],
      tenant_id: 't1',
      session_id: 'spec_s1',
      runStep: async ({ llm, spec, recorder, prompt }) => {
        const res = await llm.complete({ provider: 'mock', model: 'm', messages: [{ role: 'system', content: spec.instruction.system }, { role: 'user', content: prompt }] }, recorder);
        if (calls++ === 0) return { text: res.text, tool: { name: 'echo', args: { x: 1 } } };
        return { text: res.text };
      },
    },
    spec,
    'hello',
  );

  return { store, result };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm install && pnpm -F @veridical/demo test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/demo pnpm-lock.yaml
git commit -m "feat: spec-driven demo"
```

---

### Task 6: Full suite + acceptance verification

**Files:**
- None (verification only).

**Interfaces:**
- Consumes: all packages.

- [ ] **Step 1: Run the entire test suite**

Run: `pnpm test`
Expected: all packages PASS (schema, store, runtime, tools, llm, spec, demo).

- [ ] **Step 2: Run the strict build**

Run: `pnpm build`
Expected: all packages compile clean under `"strict": true`.

- [ ] **Step 3: Verify acceptance criterion — spec drives a real trace**

The demo smoke test (`spec-smoke.test.ts`) asserts `spec/run/start`, `spec/run/end`, and the Phase 1 flow events are present in the JSONL trace, and that `RunResult.events` matches what persisted.

- [ ] **Step 4: Verify acceptance criterion — versioned registration**

`registry.test.ts` + `jsonl.test.ts` assert exact-version resolution, `latest` by highest semver, multi-version coexistence, and immutable duplicate registration.

- [ ] **Step 5: Verify acceptance criterion — spec governs execution**

`runner.test.ts` asserts the default path (LLM-only, `max_steps` honored), tool whitelist denial via `SpecApprovalPolicy` + `ToolBroker`, and LLM fallback (primary fail → backup; all fail → `SpecRunError`).

- [ ] **Step 6: Commit (if any fixes were needed)**

```bash
git add -A
git commit -m "test: verify Phase 2 acceptance criteria"
```
