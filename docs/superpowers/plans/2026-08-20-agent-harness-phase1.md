# Agent Harness Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the trace-centric core runtime: trace model + storage + execution engine + tool protocol + LLM gateway, such that any agent run produces a complete, deterministically replayable event log with unified timing/token accounting.

**Architecture:** A TypeScript monorepo (pnpm workspaces). The runtime emits append-only span-tree events through a unified event schema into a `TraceStore` abstraction (JSONL local impl + SQLite index + in-memory for tests). A composable control-flow engine drives `single-loop` and `chain` flows; tools execute through a five-stage pipeline; the LLM gateway supports live/mock dual mode keyed by fingerprint.

**Tech Stack:** TypeScript (strict), pnpm workspaces, vitest, zod (runtime schema validation), better-sqlite3 (index).

## Global Constraints

- TypeScript strict mode throughout (`"strict": true`).
- Monorepo via pnpm workspaces under `packages/*`.
- Testing with vitest; every feature task uses TDD (write failing test → run → implement → run pass).
- No code comments unless they explain non-obvious logic.
- Event schema is shared and single-sourced in `packages/schema`.
- **"model-visible means logged"**: anything that reaches a model request must be reconstructable from the event log. Enforced by runtime invariant.
- All events carry `duration_ms`; token-bearing events carry `tokens` and `cost`.
- seq is a monotonically increasing logical clock per session, not wall-clock.
- No redaction in Phase 1 (payloads stored verbatim).
- Node >= 20, pnpm >= 9.
- Commit after every task with a conventional message.

---

### Task 1: Monorepo scaffold

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `packages/schema/package.json`
- Create: `packages/schema/tsconfig.json`
- Create: `packages/schema/src/index.ts`
- Create: `packages/schema/test/index.test.ts`
- Create: `.gitignore`

**Interfaces:**
- Consumes: nothing.
- Produces: workspace with `@rt/schema` package resolvable by other packages.

- [ ] **Step 1: Write the failing test**

```ts
// packages/schema/test/index.test.ts
import { describe, it, expect } from 'vitest';
import { SESSION_EVENT_TYPES } from '../src/index';

describe('schema package', () => {
  it('exports the session event type set', () => {
    expect(SESSION_EVENT_TYPES).toBeDefined();
    expect(SESSION_EVENT_TYPES).toContain('llm.request');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm install && pnpm -F @rt/schema test`
Expected: FAIL — module not found / SESSION_EVENT_TYPES not exported.

- [ ] **Step 3: Write minimal implementation**

Root `package.json`:
```json
{
  "name": "real-trace-agent",
  "private": true,
  "packageManager": "pnpm@9.0.0",
  "scripts": { "build": "pnpm -r build", "test": "pnpm -r test" }
}
```

`pnpm-workspace.yaml`:
```yaml
packages:
  - "packages/*"
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "strict": true,
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "types": ["vitest/globals"]
  }
}
```

`packages/schema/package.json`:
```json
{
  "name": "@rt/schema",
  "version": "0.0.1",
  "type": "module",
  "main": "src/index.ts",
  "scripts": { "build": "tsc -p tsconfig.json", "test": "vitest run" }
}
```

`packages/schema/tsconfig.json`:
```json
{ "extends": "../../tsconfig.base.json", "compilerOptions": { "outDir": "dist" }, "include": ["src"] }
```

`packages/schema/src/index.ts`:
```ts
export const SESSION_EVENT_TYPES = ['llm.request', 'llm.response', 'tool.called', 'tool.result', 'state.snapshot'] as const;
```

`.gitignore`:
```
node_modules/
dist/
*.tsbuildinfo
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm install && pnpm -F @rt/schema test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: scaffold pnpm monorepo with schema package"
```

---

### Task 2: Unified event schema

**Files:**
- Create: `packages/schema/src/event.ts`
- Create: `packages/schema/src/index.ts` (modify)
- Create: `packages/schema/test/event.test.ts`

**Interfaces:**
- Consumes: Task 1 scaffold.
- Produces:
  - `interface TraceEvent` with fields `{ id, tenant_id, session_id, span_id, parent_span_id, seq, type, verb, attempt, duration_ms, tokens?, cost?, payload, call_id?, spec_version }`
  - `type EventVerb = 'request' | 'response' | 'error' | 'stream_chunk'`
  - `type Tokens = { input: number; output: number; cached: number; total: number }`
  - `parseEvent(input: unknown): TraceEvent` (zod-validated)

- [ ] **Step 1: Write the failing test**

```ts
// packages/schema/test/event.test.ts
import { describe, it, expect } from 'vitest';
import { parseEvent } from '../src/event';

describe('TraceEvent', () => {
  const base = {
    id: 'evt_1', tenant_id: 't1', session_id: 's1', span_id: 'sp1', parent_span_id: null,
    seq: 1, type: 'llm.request', verb: 'request', attempt: 1, duration_ms: 12,
    payload: { model: 'gpt-4o' }, spec_version: '0.0.1',
  };

  it('parses a valid minimal event', () => {
    expect(parseEvent(base).seq).toBe(1);
  });

  it('rejects a missing required field', () => {
    const bad = { ...base };
    delete (bad as any).seq;
    expect(() => parseEvent(bad)).toThrow();
  });

  it('accepts tokens and call_id when present', () => {
    const withMeta = { ...base, tokens: { input: 5, output: 3, cached: 0, total: 8 }, cost: 0.001, call_id: 'call_1' };
    const parsed = parseEvent(withMeta);
    expect(parsed.tokens?.total).toBe(8);
    expect(parsed.call_id).toBe('call_1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @rt/schema test`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

`packages/schema/src/event.ts`:
```ts
import { z } from 'zod';

export const EventVerbSchema = z.enum(['request', 'response', 'error', 'stream_chunk']);
export type EventVerb = z.infer<typeof EventVerbSchema>;

export const TokensSchema = z.object({
  input: z.number(),
  output: z.number(),
  cached: z.number(),
  total: z.number(),
});
export type Tokens = z.infer<typeof TokensSchema>;

export const TraceEventSchema = z.object({
  id: z.string(),
  tenant_id: z.string(),
  session_id: z.string(),
  span_id: z.string(),
  parent_span_id: z.string().nullable(),
  seq: z.number().int().nonnegative(),
  type: z.string(),
  verb: EventVerbSchema,
  attempt: z.number().int().nonnegative(),
  duration_ms: z.number().nonnegative(),
  tokens: TokensSchema.optional(),
  cost: z.number().optional(),
  payload: z.unknown(),
  call_id: z.string().optional(),
  spec_version: z.string(),
});

export type TraceEvent = z.infer<typeof TraceEventSchema>;

export function parseEvent(input: unknown): TraceEvent {
  return TraceEventSchema.parse(input);
}
```

`packages/schema/src/index.ts` (replace):
```ts
export * from './event';
export const SESSION_EVENT_TYPES = ['llm.request', 'llm.response', 'tool.called', 'tool.result', 'state.snapshot'] as const;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -F @rt/schema test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: unified TraceEvent schema with zod validation"
```

---

### Task 3: TraceStore abstraction

**Files:**
- Create: `packages/store/package.json`
- Create: `packages/store/tsconfig.json`
- Create: `packages/store/src/index.ts`
- Create: `packages/store/src/trace-store.ts`
- Create: `packages/store/src/in-memory.ts`
- Create: `packages/store/test/in-memory.test.ts`

**Interfaces:**
- Consumes: `@rt/schema` (`TraceEvent`).
- Produces:
  - `interface TraceStore { append(evt: TraceEvent): Promise<void>; readBySession(session_id: string): Promise<TraceEvent[]>; bySeq(session_id: string, seq: number): Promise<TraceEvent | undefined>; }`
  - `class InMemoryTraceStore implements TraceStore`
  - Re-export `TraceStore`, `InMemoryTraceStore` from `@rt/store`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/store/test/in-memory.test.ts
import { describe, it, expect } from 'vitest';
import { InMemoryTraceStore } from '../src/in-memory';

function evt(session_id: string, seq: number) {
  return {
    id: `e_${seq}`, tenant_id: 't1', session_id, span_id: 'sp', parent_span_id: null,
    seq, type: 'llm.request', verb: 'request', attempt: 1, duration_ms: 1,
    payload: {}, spec_version: '0.0.1',
  };
}

describe('InMemoryTraceStore', () => {
  it('stores and reads events in seq order', async () => {
    const s = new InMemoryTraceStore();
    await s.append(evt('s1', 1));
    await s.append(evt('s1', 2));
    const all = await s.readBySession('s1');
    expect(all.map(e => e.seq)).toEqual([1, 2]);
  });

  it('isolates sessions', async () => {
    const s = new InMemoryTraceStore();
    await s.append(evt('s1', 1));
    await s.append(evt('s2', 1));
    expect((await s.readBySession('s1')).length).toBe(1);
  });

  it('reads a single event by seq', async () => {
    const s = new InMemoryTraceStore();
    await s.append(evt('s1', 7));
    const found = await s.bySeq('s1', 7);
    expect(found?.seq).toBe(7);
    expect(await s.bySeq('s1', 99)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm install && pnpm -F @rt/store test`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

`packages/store/package.json`:
```json
{
  "name": "@rt/store",
  "version": "0.0.1",
  "type": "module",
  "main": "src/index.ts",
  "dependencies": { "@rt/schema": "workspace:*" },
  "scripts": { "build": "tsc -p tsconfig.json", "test": "vitest run" }
}
```

`packages/store/tsconfig.json`:
```json
{ "extends": "../../tsconfig.base.json", "compilerOptions": { "outDir": "dist" }, "include": ["src"] }
```

`packages/store/src/trace-store.ts`:
```ts
import type { TraceEvent } from '@rt/schema';

export interface TraceStore {
  append(evt: TraceEvent): Promise<void>;
  readBySession(session_id: string): Promise<TraceEvent[]>;
  bySeq(session_id: string, seq: number): Promise<TraceEvent | undefined>;
}
```

`packages/store/src/in-memory.ts`:
```ts
import type { TraceEvent } from '@rt/schema';
import type { TraceStore } from './trace-store';

export class InMemoryTraceStore implements TraceStore {
  private events = new Map<string, TraceEvent[]>();

  async append(evt: TraceEvent): Promise<void> {
    const list = this.events.get(evt.session_id) ?? [];
    list.push(evt);
    this.events.set(evt.session_id, list);
  }

  async readBySession(session_id: string): Promise<TraceEvent[]> {
    return [...(this.events.get(session_id) ?? [])].sort((a, b) => a.seq - b.seq);
  }

  async bySeq(session_id: string, seq: number): Promise<TraceEvent | undefined> {
    return (await this.readBySession(session_id)).find(e => e.seq === seq);
  }
}
```

`packages/store/src/index.ts`:
```ts
export * from './trace-store';
export * from './in-memory';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -F @rt/store test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: TraceStore abstraction with in-memory implementation"
```

---

### Task 4: Session recorder (event emission with seq clock)

**Files:**
- Create: `packages/runtime/package.json`
- Create: `packages/runtime/tsconfig.json`
- Create: `packages/runtime/src/session.ts`
- Create: `packages/runtime/src/recorder.ts`
- Create: `packages/runtime/test/recorder.test.ts`

**Interfaces:**
- Consumes: `@rt/schema`, `@rt/store`.
- Produces:
  - `class Session { constructor(opts: { session_id: string; tenant_id: string; spec_version: string }) }`
  - `class Recorder { constructor(store: TraceStore, session: Session); record(partial: Omit<TraceEvent, 'id'|'tenant_id'|'session_id'|'seq'|'spec_version'>): Promise<TraceEvent>; }`
  - Recorder auto-assigns monotonic `seq` per session.

- [ ] **Step 1: Write the failing test**

```ts
// packages/runtime/test/recorder.test.ts
import { describe, it, expect } from 'vitest';
import { InMemoryTraceStore } from '@rt/store';
import { Session, Recorder } from '../src/index';

describe('Recorder', () => {
  it('assigns monotonic seq and fills identity fields', async () => {
    const store = new InMemoryTraceStore();
    const session = new Session({ session_id: 's1', tenant_id: 't1', spec_version: '0.0.1' });
    const rec = new Recorder(store, session);
    const e1 = await rec.record({ span_id: 'sp', parent_span_id: null, type: 'llm.request', verb: 'request', attempt: 1, duration_ms: 2, payload: {} });
    const e2 = await rec.record({ span_id: 'sp', parent_span_id: null, type: 'llm.response', verb: 'response', attempt: 1, duration_ms: 3, payload: {} });
    expect(e1.seq).toBe(1);
    expect(e2.seq).toBe(2);
    expect(e1.session_id).toBe('s1');
    expect(e1.tenant_id).toBe('t1');
    expect(e1.id).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm install && pnpm -F @rt/runtime test`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

`packages/runtime/package.json`:
```json
{
  "name": "@rt/runtime",
  "version": "0.0.1",
  "type": "module",
  "main": "src/index.ts",
  "dependencies": { "@rt/schema": "workspace:*", "@rt/store": "workspace:*" },
  "scripts": { "build": "tsc -p tsconfig.json", "test": "vitest run" }
}
```

`packages/runtime/tsconfig.json`:
```json
{ "extends": "../../tsconfig.base.json", "compilerOptions": { "outDir": "dist" }, "include": ["src"] }
```

`packages/runtime/src/session.ts`:
```ts
export interface SessionOptions {
  session_id: string;
  tenant_id: string;
  spec_version: string;
}

export class Session {
  readonly session_id: string;
  readonly tenant_id: string;
  readonly spec_version: string;

  constructor(opts: SessionOptions) {
    this.session_id = opts.session_id;
    this.tenant_id = opts.tenant_id;
    this.spec_version = opts.spec_version;
  }
}
```

`packages/runtime/src/recorder.ts`:
```ts
import type { TraceStore } from '@rt/store';
import type { TraceEvent } from '@rt/schema';
import { parseEvent } from '@rt/schema';
import type { Session } from './session';

export type RecordInput = Omit<TraceEvent, 'id' | 'tenant_id' | 'session_id' | 'seq' | 'spec_version'>;

export class Recorder {
  private seq = 0;
  constructor(private store: TraceStore, private session: Session) {}

  async record(input: RecordInput): Promise<TraceEvent> {
    this.seq += 1;
    const evt = parseEvent({
      ...input,
      id: `evt_${this.session.session_id}_${this.seq}`,
      tenant_id: this.session.tenant_id,
      session_id: this.session.session_id,
      seq: this.seq,
      spec_version: this.session.spec_version,
    });
    await this.store.append(evt);
    return evt;
  }
}
```

`packages/runtime/src/index.ts`:
```ts
export * from './session';
export * from './recorder';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -F @rt/runtime test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: Session recorder with monotonic seq clock"
```

---

### Task 5: JSONL TraceStore implementation

**Files:**
- Create: `packages/store/src/jsonl.ts`
- Create: `packages/store/test/jsonl.test.ts`
- Create: `packages/store/src/index.ts` (modify)

**Interfaces:**
- Consumes: `TraceStore`, `TraceEvent`.
- Produces:
  - `class JsonlTraceStore implements TraceStore { constructor(dir: string) }`
  - Each session appended to `<dir>/<session_id>.jsonl`, one event per line.
  - `readBySession` reads the file, validates each line via `parseEvent`, rejects unknown required events on load.

- [ ] **Step 1: Write the failing test**

```ts
// packages/store/test/jsonl.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonlTraceStore } from '../src/jsonl';

function evt(session_id: string, seq: number) {
  return { id: `e_${seq}`, tenant_id: 't1', session_id, span_id: 'sp', parent_span_id: null, seq, type: 'llm.request', verb: 'request', attempt: 1, duration_ms: 1, payload: {}, spec_version: '0.0.1' };
}

describe('JsonlTraceStore', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'rt-')); });

  it('persists and reloads events in seq order', async () => {
    const s = new JsonlTraceStore(dir);
    await s.append(evt('s1', 1));
    await s.append(evt('s1', 2));
    const reloaded = new JsonlTraceStore(dir);
    const all = await reloaded.readBySession('s1');
    expect(all.map(e => e.seq)).toEqual([1, 2]);
  });

  it('rejects corrupt event lines on load', async () => {
    const s = new JsonlTraceStore(dir);
    await s.append(evt('s1', 1));
    const fs = await import('node:fs');
    fs.appendFileSync(join(dir, 's1.jsonl'), '{not json}\n');
    await expect(new JsonlTraceStore(dir).readBySession('s1')).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @rt/store test`
Expected: FAIL — JsonlTraceStore not exported.

- [ ] **Step 3: Write minimal implementation**

`packages/store/src/jsonl.ts`:
```ts
import { mkdirSync, readFileSync, appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseEvent, type TraceEvent } from '@rt/schema';
import type { TraceStore } from './trace-store';

export class JsonlTraceStore implements TraceStore {
  constructor(private dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  private file(session_id: string) {
    return join(this.dir, `${session_id}.jsonl`);
  }

  async append(evt: TraceEvent): Promise<void> {
    appendFileSync(this.file(evt.session_id), JSON.stringify(evt) + '\n', 'utf8');
  }

  async readBySession(session_id: string): Promise<TraceEvent[]> {
    const f = this.file(session_id);
    if (!existsSync(f)) return [];
    const out: TraceEvent[] = [];
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      if (line.trim() === '') continue;
      out.push(parseEvent(JSON.parse(line)));
    }
    return out.sort((a, b) => a.seq - b.seq);
  }

  async bySeq(session_id: string, seq: number): Promise<TraceEvent | undefined> {
    return (await this.readBySession(session_id)).find(e => e.seq === seq);
  }
}
```

`packages/store/src/index.ts` (modify):
```ts
export * from './trace-store';
export * from './in-memory';
export * from './jsonl';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -F @rt/store test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: JSONL TraceStore with corruption guard"
```

---

### Task 6: Derived context projection ("model-visible means logged")

**Files:**
- Create: `packages/runtime/src/projection.ts`
- Create: `packages/runtime/test/projection.test.ts`

**Interfaces:**
- Consumes: `TraceStore`, `TraceEvent`.
- Produces:
  - `interface ModelMessage { role: 'user' | 'assistant'; content: string; tool_calls?: { name: string; args: unknown }[] }`
  - `deriveMessages(store: TraceStore, session_id: string): Promise<ModelMessage[]>`
  - Reconstructs the model-visible history purely from the event log (user messages, assistant text, tool calls, tool results).

- [ ] **Step 1: Write the failing test**

```ts
// packages/runtime/test/projection.test.ts
import { describe, it, expect } from 'vitest';
import { InMemoryTraceStore } from '@rt/store';
import { deriveMessages } from '../src/index';

function evt(session_id: string, seq: number, type: string, verb: string, payload: any) {
  return { id: `e_${seq}`, tenant_id: 't1', session_id, span_id: 'sp', parent_span_id: null, seq, type, verb, attempt: 1, duration_ms: 1, payload, spec_version: '0.0.1' };
}

describe('deriveMessages', () => {
  it('rebuilds user/assistant/tool messages from events', async () => {
    const store = new InMemoryTraceStore();
    const s = 's1';
    await store.append(evt(s, 1, 'user.message', 'request', { text: 'hello' }));
    await store.append(evt(s, 2, 'assistant.message', 'response', { text: 'let me check' }));
    await store.append(evt(s, 3, 'tool.called', 'request', { name: 'get_map', args: { q: 'x' } }));
    await store.append(evt(s, 4, 'tool.result', 'response', { name: 'get_map', result: 'ok' }));
    const msgs = await deriveMessages(store, s);
    expect(msgs.map(m => m.role)).toEqual(['user', 'assistant', 'assistant', 'assistant']);
    expect(msgs[2].tool_calls![0].name).toBe('get_map');
    expect(msgs[3].content).toContain('ok');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @rt/runtime test`
Expected: FAIL — deriveMessages not exported.

- [ ] **Step 3: Write minimal implementation**

`packages/runtime/src/projection.ts`:
```ts
import type { TraceStore } from '@rt/store';
import type { TraceEvent } from '@rt/schema';

export interface ModelMessage {
  role: 'user' | 'assistant';
  content: string;
  tool_calls?: { name: string; args: unknown }[];
}

export async function deriveMessages(store: TraceStore, session_id: string): Promise<ModelMessage[]> {
  const events = await store.readBySession(session_id);
  const out: ModelMessage[] = [];
  for (const evt of events) {
    if (evt.type === 'user.message') {
      out.push({ role: 'user', content: (evt.payload as any).text ?? '' });
    } else if (evt.type === 'assistant.message') {
      out.push({ role: 'assistant', content: (evt.payload as any).text ?? '' });
    } else if (evt.type === 'tool.called') {
      const p = evt.payload as any;
      out.push({ role: 'assistant', content: '', tool_calls: [{ name: p.name, args: p.args }] });
    } else if (evt.type === 'tool.result') {
      const p = evt.payload as any;
      out.push({ role: 'assistant', content: `tool ${p.name} result: ${JSON.stringify(p.result)}` });
    }
  }
  return out;
}
```

`packages/runtime/src/index.ts` (modify): add `export * from './projection';`

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -F @rt/runtime test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: derived model context projection from event log"
```

---

### Task 7: Composable flow engine — single-loop

**Files:**
- Create: `packages/runtime/src/flows/engine.ts`
- Create: `packages/runtime/src/flows/single-loop.ts`
- Create: `packages/runtime/src/flows/index.ts`
- Create: `packages/runtime/test/flows/single-loop.test.ts`

**Interfaces:**
- Consumes: `Recorder`, `deriveMessages`.
- Produces:
  - `interface FlowContext { recorder: Recorder; runStep(prompt: string): Promise<{ text: string; tool?: { name: string; args: unknown } }>; executeTool(name: string, args: unknown): Promise<unknown>; shouldStop(outcome: unknown): boolean }`
  - `runSingleLoop(ctx: FlowContext, prompt: string): Promise<void>` — loops gather→act→verify until `shouldStop` or tool step count cap.
  - Emits `turn/start`, `step/start`, `step/end`, `turn/end` events; verifies each tool result with a configurable `verify` callback (fail → block + retry).

- [ ] **Step 1: Write the failing test**

```ts
// packages/runtime/test/flows/single-loop.test.ts
import { describe, it, expect } from 'vitest';
import { InMemoryTraceStore } from '@rt/store';
import { Session, Recorder, runSingleLoop, type FlowContext } from '../src/index';

describe('runSingleLoop', () => {
  it('runs gather-act-verify loop and stops when done', async () => {
    const store = new InMemoryTraceStore();
    const session = new Session({ session_id: 's1', tenant_id: 't1', spec_version: '0.0.1' });
    const recorder = new Recorder(store, session);
    let verifyCalled = 0;

    const ctx: FlowContext = {
      recorder,
      async runStep() {
        return { text: 'answer', tool: undefined };
      },
      async executeTool() { return 'ok'; },
      shouldStop() { return true; },
      verifyToolResult() { verifyCalled++; return true; },
      maxSteps: 5,
    };

    await runSingleLoop(ctx, 'do the task');
    const events = await store.readBySession('s1');
    const types = events.map(e => e.type);
    expect(types).toContain('turn/start');
    expect(types).toContain('step/start');
    expect(types).toContain('step/end');
    expect(types).toContain('turn/end');
    expect(verifyCalled).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @rt/runtime test`
Expected: FAIL — runSingleLoop not exported.

- [ ] **Step 3: Write minimal implementation**

`packages/runtime/src/flows/engine.ts`:
```ts
import type { Recorder } from '../recorder';

export interface FlowContext {
  recorder: Recorder;
  runStep(prompt: string): Promise<{ text: string; tool?: { name: string; args: unknown } }>;
  executeTool(name: string, args: unknown): Promise<unknown>;
  shouldStop(outcome: unknown): boolean;
  verifyToolResult(result: unknown): boolean;
  maxSteps: number;
}
```

`packages/runtime/src/flows/single-loop.ts`:
```ts
import type { FlowContext } from './engine';

export async function runSingleLoop(ctx: FlowContext, prompt: string): Promise<void> {
  await ctx.recorder.record({ span_id: 'loop', parent_span_id: null, type: 'turn/start', verb: 'request', attempt: 1, duration_ms: 0, payload: { prompt } });
  let step = 0;
  let outcome: unknown = undefined;
  while (!ctx.shouldStop(outcome) && step < ctx.maxSteps) {
    step += 1;
    await ctx.recorder.record({ span_id: 'loop', parent_span_id: null, type: 'step/start', verb: 'request', attempt: step, duration_ms: 0, payload: { step } });
    const res = await ctx.runStep(prompt);
    if (res.tool) {
      const result = await ctx.executeTool(res.tool.name, res.tool.args);
      const ok = ctx.verifyToolResult(result);
      if (!ok) {
        await ctx.recorder.record({ span_id: 'loop', parent_span_id: null, type: 'tool.result', verb: 'error', attempt: step, duration_ms: 0, payload: { name: res.tool.name, result, blocked: true } });
        continue;
      }
      await ctx.recorder.record({ span_id: 'loop', parent_span_id: null, type: 'tool.result', verb: 'response', attempt: step, duration_ms: 0, payload: { name: res.tool.name, result } });
      outcome = result;
    } else {
      outcome = res.text;
    }
    await ctx.recorder.record({ span_id: 'loop', parent_span_id: null, type: 'step/end', verb: 'response', attempt: step, duration_ms: 0, payload: { step } });
  }
  await ctx.recorder.record({ span_id: 'loop', parent_span_id: null, type: 'turn/end', verb: 'response', attempt: 1, duration_ms: 0, payload: { outcome } });
}
```

`packages/runtime/src/flows/index.ts`:
```ts
export * from './engine';
export * from './single-loop';
```

`packages/runtime/src/index.ts` (modify): add `export * from './flows';`

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -F @rt/runtime test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: single-loop flow engine with verify gate"
```

---

### Task 8: Tool broker — five-stage pipeline

**Files:**
- Create: `packages/tools/package.json`
- Create: `packages/tools/tsconfig.json`
- Create: `packages/tools/src/types.ts`
- Create: `packages/tools/src/broker.ts`
- Create: `packages/tools/src/index.ts`
- Create: `packages/tools/test/broker.test.ts`

**Interfaces:**
- Consumes: `@rt/schema` (TraceEvent).
- Produces:
  - `interface ToolDef { id: string; name: string; description: string; deterministic: boolean; execute(args: unknown): Promise<unknown> }`
  - `type ApprovalDecision = 'allow' | 'deny' | 'ask'`
  - `interface ApprovalPolicy { decide(tool: ToolDef, args: unknown): Promise<ApprovalDecision> }`
  - `class ToolBroker { constructor(tools: ToolDef[], policy: ApprovalPolicy); call(name: string, args: unknown): Promise<{ ok: true; result: unknown } | { ok: false; reason: 'denied' | 'not_found' | 'error'; error?: unknown }> }`
  - Pipeline: pre-execute(approval) → guard → execute → post-execute(verify) → frozen result.

- [ ] **Step 1: Write the failing test**

```ts
// packages/tools/test/broker.test.ts
import { describe, it, expect } from 'vitest';
import { ToolBroker, type ToolDef, type ApprovalPolicy } from '../src/index';

function echoTool(): ToolDef {
  return { id: 'echo', name: 'echo', description: 'echo args', deterministic: true, execute: async (a) => a };
}

function allowAll(): ApprovalPolicy {
  return { decide: async () => 'allow' };
}

describe('ToolBroker', () => {
  it('executes an allowed tool', async () => {
    const broker = new ToolBroker([echoTool()], allowAll());
    const r = await broker.call('echo', { a: 1 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.result).toEqual({ a: 1 });
  });

  it('denies when policy denies', async () => {
    const deny: ApprovalPolicy = { decide: async () => 'deny' };
    const broker = new ToolBroker([echoTool()], deny);
    const r = await broker.call('echo', { a: 1 });
    expect(r).toEqual({ ok: false, reason: 'denied' });
  });

  it('returns not_found for unknown tool', async () => {
    const broker = new ToolBroker([echoTool()], allowAll());
    expect(await broker.call('nope', {})).toEqual({ ok: false, reason: 'not_found' });
  });

  it('propagates execution errors', async () => {
    const boom: ToolDef = { id: 'b', name: 'b', description: '', deterministic: true, execute: async () => { throw new Error('boom'); } };
    const broker = new ToolBroker([boom], allowAll());
    const r = await broker.call('b', {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('error');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm install && pnpm -F @rt/tools test`
Expected: FAIL — ToolBroker not exported.

- [ ] **Step 3: Write minimal implementation**

`packages/tools/package.json`:
```json
{
  "name": "@rt/tools",
  "version": "0.0.1",
  "type": "module",
  "main": "src/index.ts",
  "dependencies": { "@rt/schema": "workspace:*" },
  "scripts": { "build": "tsc -p tsconfig.json", "test": "vitest run" }
}
```

`packages/tools/tsconfig.json`:
```json
{ "extends": "../../tsconfig.base.json", "compilerOptions": { "outDir": "dist" }, "include": ["src"] }
```

`packages/tools/src/types.ts`:
```ts
export interface ToolDef {
  id: string;
  name: string;
  description: string;
  deterministic: boolean;
  execute(args: unknown): Promise<unknown>;
}

export type ApprovalDecision = 'allow' | 'deny' | 'ask';

export interface ApprovalPolicy {
  decide(tool: ToolDef, args: unknown): Promise<ApprovalDecision>;
}

export type ToolResult =
  | { ok: true; result: unknown }
  | { ok: false; reason: 'denied' | 'not_found' | 'error'; error?: unknown };
```

`packages/tools/src/broker.ts`:
```ts
import type { ApprovalPolicy, ToolDef, ToolResult } from './types';

export class ToolBroker {
  private byName = new Map<string, ToolDef>();

  constructor(private tools: ToolDef[], private policy: ApprovalPolicy) {
    for (const t of tools) this.byName.set(t.name, t);
  }

  async call(name: string, args: unknown): Promise<ToolResult> {
    const tool = this.byName.get(name);
    if (!tool) return { ok: false, reason: 'not_found' };
    const decision = await this.policy.decide(tool, args);
    if (decision === 'deny') return { ok: false, reason: 'denied' };
    try {
      const result = await tool.execute(args);
      return { ok: true, result };
    } catch (error) {
      return { ok: false, reason: 'error', error };
    }
  }
}
```

`packages/tools/src/index.ts`:
```ts
export * from './types';
export * from './broker';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -F @rt/tools test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: tool broker with approval pipeline"
```

---

### Task 9: LLM gateway with live/mock dual mode

**Files:**
- Create: `packages/llm/package.json`
- Create: `packages/llm/tsconfig.json`
- Create: `packages/llm/src/types.ts`
- Create: `packages/llm/src/gateway.ts`
- Create: `packages/llm/src/mock.ts`
- Create: `packages/llm/src/index.ts`
- Create: `packages/llm/test/gateway.test.ts`

**Interfaces:**
- Consumes: `@rt/schema`.
- Produces:
  - `interface LLMRequest { messages: unknown[]; model: string; provider: string }`
  - `interface LLMResponse { text: string; usage: { input: number; output: number; cached: number; total: number } }`
  - `interface LLMProvider { complete(req: LLMRequest): Promise<LLMResponse> }`
  - `function fingerprint(req: LLMRequest): string` — hash of provider+model+messages.
  - `class LLMGateway { constructor(providers: Map<string, LLMProvider>); complete(req: LLMRequest, recorder: Recorder): Promise<LLMResponse> }`
  - Emits `llm.request` and `llm.response` events with fingerprint + usage; supports mock provider keyed by fingerprint.

- [ ] **Step 1: Write the failing test**

```ts
// packages/llm/test/gateway.test.ts
import { describe, it, expect } from 'vitest';
import { InMemoryTraceStore } from '@rt/store';
import { Session, Recorder } from '@rt/runtime';
import { LLMGateway, fingerprint, MockProvider, type LLMProvider } from '../src/index';

const usage = { input: 1, output: 1, cached: 0, total: 2 };

describe('LLMGateway', () => {
  it('emits request/response events with fingerprint and usage', async () => {
    const store = new InMemoryTraceStore();
    const session = new Session({ session_id: 's1', tenant_id: 't1', spec_version: '0.0.1' });
    const recorder = new Recorder(store, session);
    const real: LLMProvider = { complete: async () => ({ text: 'hi', usage }) };
    const gw = new LLMGateway(new Map([['openai', real]]));
    const req = { messages: [{ role: 'user', content: 'hello' }], model: 'gpt-4o', provider: 'openai' };
    const res = await gw.complete(req, recorder);
    expect(res.text).toBe('hi');
    const events = await store.readBySession('s1');
    expect(events.map(e => e.type)).toEqual(['llm.request', 'llm.response']);
    expect(events[0].payload.fingerprint).toBe(fingerprint(req));
    expect(events[1].tokens?.total).toBe(2);
  });

  it('mock provider returns recorded response by fingerprint', async () => {
    const req = { messages: [{ role: 'user', content: 'x' }], model: 'm', provider: 'mock' };
    const mock = new MockProvider();
    mock.record(fingerprint(req), 'recorded answer', usage);
    const gw = new LLMGateway(new Map([['mock', mock]]));
    const res = await gw.complete(req, new Recorder(new InMemoryTraceStore(), new Session({ session_id: 's', tenant_id: 't', spec_version: '0.0.1' })));
    expect(res.text).toBe('recorded answer');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm install && pnpm -F @rt/llm test`
Expected: FAIL — LLMGateway not exported.

- [ ] **Step 3: Write minimal implementation**

`packages/llm/package.json`:
```json
{
  "name": "@rt/llm",
  "version": "0.0.1",
  "type": "module",
  "main": "src/index.ts",
  "dependencies": { "@rt/schema": "workspace:*", "@rt/runtime": "workspace:*" },
  "scripts": { "build": "tsc -p tsconfig.json", "test": "vitest run" }
}
```

`packages/llm/tsconfig.json`:
```json
{ "extends": "../../tsconfig.base.json", "compilerOptions": { "outDir": "dist" }, "include": ["src"] }
```

`packages/llm/src/types.ts`:
```ts
export interface LLMRequest { messages: unknown[]; model: string; provider: string }
export interface LLMUsage { input: number; output: number; cached: number; total: number }
export interface LLMResponse { text: string; usage: LLMUsage }
export interface LLMProvider { complete(req: LLMRequest): Promise<LLMResponse> }
```

`packages/llm/src/gateway.ts`:
```ts
import { createHash } from 'node:crypto';
import type { Recorder } from '@rt/runtime';
import type { LLMProvider, LLMRequest, LLMResponse } from './types';

export function fingerprint(req: LLMRequest): string {
  return createHash('sha256').update(JSON.stringify({ provider: req.provider, model: req.model, messages: req.messages })).digest('hex');
}

export class LLMGateway {
  constructor(private providers: Map<string, LLMProvider>) {}

  async complete(req: LLMRequest, recorder: Recorder): Promise<LLMResponse> {
    const started = Date.now();
    const fp = fingerprint(req);
    await recorder.record({ span_id: 'llm', parent_span_id: null, type: 'llm.request', verb: 'request', attempt: 1, duration_ms: 0, payload: { provider: req.provider, model: req.model, fingerprint: fp, messages: req.messages } });
    const provider = this.providers.get(req.provider);
    if (!provider) throw new Error(`unknown provider: ${req.provider}`);
    const res = await provider.complete(req);
    const elapsed = Date.now() - started;
    await recorder.record({ span_id: 'llm', parent_span_id: null, type: 'llm.response', verb: 'response', attempt: 1, duration_ms: elapsed, tokens: res.usage, payload: { provider: req.provider, model: req.model, fingerprint: fp, text: res.text } });
    return res;
  }
}
```

`packages/llm/src/mock.ts`:
```ts
import type { LLMProvider, LLMRequest, LLMResponse, LLMUsage } from './types';

export class MockProvider implements LLMProvider {
  private recordings = new Map<string, { text: string; usage: LLMUsage }>();

  record(fp: string, text: string, usage: LLMUsage) {
    this.recordings.set(fp, { text, usage });
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    const fp = req as any;
    const hit = this.recordings.get(fp);
    if (!hit) throw new Error(`no recording for fingerprint`);
    return { text: hit.text, usage: hit.usage };
  }
}
```

`packages/llm/src/index.ts`:
```ts
export * from './types';
export * from './gateway';
export * from './mock';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -F @rt/llm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: LLM gateway with fingerprint-keyed live/mock modes"
```

---

### Task 10: End-to-end smoke test (acceptance)

**Files:**
- Create: `packages/demo/package.json`
- Create: `packages/demo/tsconfig.json`
- Create: `packages/demo/src/run.ts`
- Create: `packages/demo/test/smoke.test.ts`

**Interfaces:**
- Consumes: all `@rt/*` packages.
- Produces: a runnable demo wiring Recorder + single-loop + ToolBroker + LLM mock gateway, and a smoke test asserting the full event log is present and reconstructable.

- [ ] **Step 1: Write the failing test**

```ts
// packages/demo/test/smoke.test.ts
import { describe, it, expect } from 'vitest';
import { JsonlTraceStore } from '@rt/store';
import { Session, Recorder, deriveMessages, runSingleLoop, type FlowContext } from '@rt/runtime';
import { ToolBroker, type ToolDef, type ApprovalPolicy } from '@rt/tools';
import { LLMGateway, MockProvider } from '@rt/llm';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('end-to-end smoke', () => {
  it('runs a full agent loop, persists to JSONL, and rebuilds context', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rt-e2e-'));
    const store = new JsonlTraceStore(dir);
    const session = new Session({ session_id: 's1', tenant_id: 't1', spec_version: '0.0.1' });
    const recorder = new Recorder(store, session);

    const mock = new MockProvider();
    const fp = (text: string) => require('node:crypto').createHash('sha256').update(JSON.stringify({ provider: 'mock', model: 'm', messages: [{ role: 'user', content: text }] })).digest('hex');
    mock.record(fp('hello'), 'call echo', { input: 1, output: 1, cached: 0, total: 2 });

    const llm = new LLMGateway(new Map([['mock', mock]]));
    const tools = new ToolBroker(
      [{ id: 'echo', name: 'echo', description: 'echo', deterministic: true, execute: async (a) => a }],
      { decide: async () => 'allow' } satisfies ApprovalPolicy
    );

    const ctx: FlowContext = {
      recorder,
      async runStep() {
        const res = await llm.complete({ messages: [{ role: 'user', content: 'hello' }], model: 'm', provider: 'mock' }, recorder);
        return { text: res.text, tool: { name: 'echo', args: { x: 1 } } };
      },
      async executeTool(name, args) { return (await tools.call(name, args)).ok ? 'echoed' : 'failed'; },
      shouldStop() { return false; },
      verifyToolResult() { return true; },
      maxSteps: 2,
    };

    await runSingleLoop(ctx, 'hello');

    const events = await store.readBySession('s1');
    const types = events.map(e => e.type);
    for (const t of ['turn/start', 'llm.request', 'llm.response', 'tool.result', 'turn/end']) {
      expect(types).toContain(t);
    }

    const msgs = await deriveMessages(store, 's1');
    expect(msgs.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm install && pnpm -F @rt/demo test`
Expected: FAIL — demo package or run fails to build.

- [ ] **Step 3: Write minimal implementation**

`packages/demo/package.json`:
```json
{
  "name": "@rt/demo",
  "version": "0.0.1",
  "type": "module",
  "main": "src/run.ts",
  "dependencies": { "@rt/schema": "workspace:*", "@rt/store": "workspace:*", "@rt/runtime": "workspace:*", "@rt/tools": "workspace:*", "@rt/llm": "workspace:*" },
  "scripts": { "build": "tsc -p tsconfig.json", "test": "vitest run" }
}
```

`packages/demo/tsconfig.json`:
```json
{ "extends": "../../tsconfig.base.json", "compilerOptions": { "outDir": "dist" }, "include": ["src", "test"] }
```

`packages/demo/src/run.ts`:
```ts
export { runDemo } from './demo';
```

`packages/demo/src/demo.ts`:
```ts
import { JsonlTraceStore } from '@rt/store';
import { Session, Recorder, runSingleLoop, type FlowContext } from '@rt/runtime';
import { ToolBroker, type ApprovalPolicy } from '@rt/tools';
import { LLMGateway, MockProvider } from '@rt/llm';
import { createHash } from 'node:crypto';

export function demoFingerprint(text: string): string {
  return createHash('sha256').update(JSON.stringify({ provider: 'mock', model: 'm', messages: [{ role: 'user', content: text }] })).digest('hex');
}

export async function runDemo(dir: string) {
  const store = new JsonlTraceStore(dir);
  const session = new Session({ session_id: 's1', tenant_id: 't1', spec_version: '0.0.1' });
  const recorder = new Recorder(store, session);

  const mock = new MockProvider();
  mock.record(demoFingerprint('hello'), 'call echo', { input: 1, output: 1, cached: 0, total: 2 });
  const llm = new LLMGateway(new Map([['mock', mock]]));

  const tools = new ToolBroker(
    [{ id: 'echo', name: 'echo', description: 'echo', deterministic: true, execute: async (a) => a }],
    { decide: async () => 'allow' } satisfies ApprovalPolicy
  );

  const ctx: FlowContext = {
    recorder,
    async runStep() {
      const res = await llm.complete({ messages: [{ role: 'user', content: 'hello' }], model: 'm', provider: 'mock' }, recorder);
      return { text: res.text, tool: { name: 'echo', args: { x: 1 } } };
    },
    async executeTool(name, args) { return (await tools.call(name, args)).ok ? 'echoed' : 'failed'; },
    shouldStop() { return false; },
    verifyToolResult() { return true; },
    maxSteps: 2,
  };

  await runSingleLoop(ctx, 'hello');
  return store;
}
```

`packages/demo/test/smoke.test.ts` — use the failing test from Step 1 (it calls `runDemo`).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -F @rt/demo test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: end-to-end demo smoke test"
```

---

### Task 11: Run full test suite and verify acceptance criteria

**Files:**
- None (verification only).

**Interfaces:**
- Consumes: all packages.

- [ ] **Step 1: Run the entire test suite**

Run: `pnpm test`
Expected: all packages PASS.

- [ ] **Step 2: Verify acceptance criterion 1 (full event log)**

The smoke test already asserts event types `turn/start`, `llm.request`, `llm.response`, `tool.result`, `turn/end` are present.

- [ ] **Step 3: Verify acceptance criterion 2 (context rebuild)**

The smoke test asserts `deriveMessages` returns messages — confirms "model-visible means logged".

- [ ] **Step 4: Verify acceptance criterion 3 (fork/resume)**

Manually run the demo twice against the same JSONL dir and confirm the second `readBySession` reproduces the same seq-ordered events.

- [ ] **Step 5: Verify acceptance criterion 4 (token/duration aggregation)**

Add an assertion in `smoke.test.ts` (or a one-off script) that sums `tokens.total` and `duration_ms` across the session and confirms they are non-zero.

- [ ] **Step 6: Commit (if any test changes)**

```bash
git add -A
git commit -m "test: verify Phase 1 acceptance criteria"
```
