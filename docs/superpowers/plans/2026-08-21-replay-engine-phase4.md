# Replay Engine + Time-Travel Debug + Run Comparison (Phase 4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the replay layer — a configurable `ReplayEngine` that re-executes an agent run with recorded responses (LLM by fingerprint, tools by call sequence), a read-only `TraceProjection` time-travel state API (any-seq model context + cursor), and a `RunComparator` for event-level diff of two runs.

**Architecture:** New package `@veridical/replay` layered on `@veridical/schema`/`@veridical/store`/`@veridical/runtime`/`@veridical/spec`. `ReplayPlan` declares per-provider/tool strategy (`replay`/`live`/`fixture`); `ReplayLLMProvider`/`ReplayToolProvider` serve recorded responses; `ReplayEngine.replay()` re-runs via `runSpec` and optionally asserts trace identity. `TraceProjection` projects state at any seq (extending `deriveMessages` with `upToSeq`). `RunComparator` diffs two sessions by seq-aligned events. Dependency direction: `@veridical/replay` → spec → runtime/store, one-way.

**Tech Stack:** TypeScript (strict), pnpm workspaces, vitest, node:crypto (fingerprint reuse).

## Global Constraints

- TypeScript strict mode throughout (`"strict": true`).
- Monorepo via pnpm workspaces under `packages/*`.
- Testing with vitest; every feature task uses TDD (write failing test → run → implement → run pass).
- No code comments unless they explain non-obvious logic.
- Node-API packages need `@types/node` + tsconfig `types: ["vitest/globals", "node"]`.
- New package name: `@veridical/replay` (version 0.0.1, `type: module`, `main: src/index.ts`).
- **Dependency direction strictly `@veridical/replay` → `@veridical/spec` → `@veridical/runtime`/`@veridical/store` one-way.** `@veridical/replay` may NOT be imported by spec/runtime/store.
- `@veridical/runtime` change is minimal: add optional `upToSeq?: number` to `deriveMessages` (backward-compatible; default = full).
- Replay sources responses ONLY from the event log (never re-calls real interfaces) unless strategy is `live`/`fixture`.
- Replay LLM lookup is by `fingerprint(req)` (matches `@veridical/llm`'s `fingerprint`); replay tool lookup is by call sequence (Nth call of a tool → Nth recorded result).
- Replay `prompt` is extracted from the recorded `spec/run/start` event payload's `input` field.
- `assert_trace_identical` compares seq-aligned `type`/`verb`/`payload`/`tokens`/`cost` (payload via `JSON.stringify` deep compare); divergence throws `TraceDivergenceError`.
- Replay miss throws `ReplayMissError`; unresolved spec throws `ReplayError`.
- TraceProjection/RunComparator are read-only and never throw (seq out-of-range truncates, empty session → empty/identical).
- Commit after every task with a conventional message.

---

### Task 1: `@veridical/replay` scaffold + ReplayPlan types + Replay providers

**Files:**
- Create: `packages/replay/package.json`
- Create: `packages/replay/tsconfig.json`
- Create: `packages/replay/src/index.ts`
- Create: `packages/replay/src/plan.ts`
- Create: `packages/replay/src/providers.ts`
- Test: `packages/replay/test/providers.test.ts`

**Interfaces:**
- Consumes: `TraceEvent` (`@veridical/schema`); `TraceStore` (`@veridical/store`); `LLMRequest`/`LLMResponse`/`LLMUsage`/`LLMProvider` (`@veridical/llm`); `fingerprint` (`@veridical/llm`); `ToolDef` (`@veridical/tools`).
- Produces:
  - `type ReplayStrategy = 'replay' | 'live' | 'fixture'`
  - `interface ReplayPlan { spec: { name: string; version?: string }; llm?: { [provider: string]: ReplayStrategy }; tools?: { [name: string]: ReplayStrategy }; fixtures?: { llm?: { provider: string; responses: { fingerprint: string; text: string; usage: LLMUsage }[] }[]; tools?: { name: string; responses: unknown[] }[] }; assert_trace_identical?: boolean }`
  - `class ReplayMissError extends Error`
  - `class ReplayLLMProvider implements LLMProvider { constructor(events: TraceEvent[]); complete(req: LLMRequest): Promise<LLMResponse> }` — looks up `fingerprint(req)` among recorded `llm.response` verb:response events; miss → `ReplayMissError`.
  - `class ReplayToolProvider { constructor(events: TraceEvent[]); execute(name: string, args: unknown): Promise<unknown> }` — serves the Nth recorded `tool.result` payload's `result` for the Nth call of `name`; exhaustion → `ReplayMissError`. Returns `Promise<unknown>` (the result, not the `{ok,...}` wrapper — it wraps like `ToolDef.execute`).

- [ ] **Step 1: Write the failing test**

```ts
// packages/replay/test/providers.test.ts
import { describe, it, expect } from 'vitest';
import type { TraceEvent } from '@veridical/schema';
import { fingerprint } from '@veridical/llm';
import { ReplayLLMProvider, ReplayToolProvider, ReplayMissError } from '../src/index';

function evt(seq: number, type: string, verb: string, payload: any): TraceEvent {
  return { id: `e${seq}`, tenant_id: 't1', session_id: 's1', span_id: 'sp', parent_span_id: null, seq, type, verb, attempt: 1, duration_ms: 1, payload, spec_version: '0.0.1' };
}

describe('ReplayLLMProvider', () => {
  const req = { provider: 'mock', model: 'm', messages: [{ role: 'user', content: 'hello' }] };
  const fp = fingerprint(req);
  const events = [
    evt(1, 'llm.request', 'request', { provider: 'mock', model: 'm', fingerprint: fp, messages: req.messages }),
    evt(2, 'llm.response', 'response', { provider: 'mock', model: 'm', fingerprint: fp, text: 'recorded answer' },),
  ];

  it('returns the recorded response for a matching fingerprint', async () => {
    const p = new ReplayLLMProvider(events);
    const res = await p.complete(req);
    expect(res.text).toBe('recorded answer');
    expect(res.usage).toEqual({ input: 0, output: 0, cached: 0, total: 0 });
  });

  it('throws ReplayMissError on an unknown fingerprint', async () => {
    const p = new ReplayLLMProvider(events);
    await expect(p.complete({ ...req, messages: [{ role: 'user', content: 'other' }] })).rejects.toThrow(ReplayMissError);
  });
});

describe('ReplayToolProvider', () => {
  const events = [
    evt(1, 'tool.called', 'request', { name: 'echo', args: { x: 1 } }),
    evt(2, 'tool.result', 'response', { name: 'echo', result: { echoed: 1 } }),
    evt(3, 'tool.called', 'request', { name: 'echo', args: { x: 2 } }),
    evt(4, 'tool.result', 'response', { name: 'echo', result: { echoed: 2 } }),
  ];

  it('serves the Nth recorded result for the Nth call', async () => {
    const p = new ReplayToolProvider(events);
    expect(await p.execute('echo', { x: 1 })).toEqual({ echoed: 1 });
    expect(await p.execute('echo', { x: 2 })).toEqual({ echoed: 2 });
  });

  it('throws ReplayMissError when the call sequence is exhausted', async () => {
    const p = new ReplayToolProvider(events);
    await p.execute('echo', { x: 1 });
    await p.execute('echo', { x: 2 });
    await expect(p.execute('echo', { x: 3 })).rejects.toThrow(ReplayMissError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm install && pnpm -F @veridical/replay test`
Expected: FAIL — `@veridical/replay` package not found / `ReplayLLMProvider` not exported.

- [ ] **Step 3: Write minimal implementation**

`packages/replay/package.json`:
```json
{
  "name": "@veridical/replay",
  "version": "0.0.1",
  "type": "module",
  "main": "src/index.ts",
  "dependencies": {
    "@veridical/schema": "workspace:*",
    "@veridical/store": "workspace:*",
    "@veridical/llm": "workspace:*",
    "@veridical/tools": "workspace:*"
  },
  "devDependencies": {
    "@types/node": "^26.2.0",
    "typescript": "^5.0.0",
    "vitest": "^3.0.0"
  },
  "scripts": { "build": "tsc -p tsconfig.json", "test": "vitest run" }
}
```

`packages/replay/tsconfig.json`:
```json
{ "extends": "../../tsconfig.base.json", "compilerOptions": { "outDir": "dist", "types": ["vitest/globals", "node"] }, "include": ["src"] }
```

`packages/replay/src/plan.ts`:
```ts
import type { LLMUsage } from '@veridical/llm';

export type ReplayStrategy = 'replay' | 'live' | 'fixture';

export interface ReplayPlan {
  spec: { name: string; version?: string };
  llm?: { [provider: string]: ReplayStrategy };
  tools?: { [name: string]: ReplayStrategy };
  fixtures?: {
    llm?: { provider: string; responses: { fingerprint: string; text: string; usage: LLMUsage }[] }[];
    tools?: { name: string; responses: unknown[] }[];
  };
  assert_trace_identical?: boolean;
}
```

`packages/replay/src/providers.ts`:
```ts
import type { TraceEvent } from '@veridical/schema';
import { fingerprint, type LLMProvider, type LLMRequest, type LLMResponse, type LLMUsage } from '@veridical/llm';

export class ReplayMissError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReplayMissError';
  }
}

const payloadOf = (e: TraceEvent) => e.payload as any;

export class ReplayLLMProvider implements LLMProvider {
  private byFingerprint = new Map<string, { text: string; usage: LLMUsage }>();

  constructor(events: TraceEvent[]) {
    for (const e of events) {
      if (e.type === 'llm.response' && e.verb === 'response') {
        const p = payloadOf(e);
        this.byFingerprint.set(p.fingerprint, { text: p.text ?? '', usage: e.tokens ?? { input: 0, output: 0, cached: 0, total: 0 } });
      }
    }
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    const fp = fingerprint(req);
    const hit = this.byFingerprint.get(fp);
    if (!hit) throw new ReplayMissError(`no recorded llm.response for fingerprint ${fp}`);
    return { text: hit.text, usage: hit.usage };
  }
}

export class ReplayToolProvider {
  private calls = new Map<string, { index: number; results: unknown[] }>();

  constructor(events: TraceEvent[]) {
    const byName = new Map<string, unknown[]>();
    for (const e of events) {
      if (e.type === 'tool.result') {
        const p = payloadOf(e);
        if (!byName.has(p.name)) byName.set(p.name, []);
        byName.get(p.name)!.push(p.result);
      }
    }
    for (const [name, results] of byName) this.calls.set(name, { index: 0, results });
  }

  async execute(name: string, _args: unknown): Promise<unknown> {
    const entry = this.calls.get(name);
    if (!entry || entry.index >= entry.results.length) throw new ReplayMissError(`no recorded tool.result left for ${name}`);
    return entry.results[entry.index++];
  }
}
```

`packages/replay/src/index.ts`:
```ts
export * from './plan';
export * from './providers';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm install && pnpm -F @veridical/replay test`
Expected: PASS (all 5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/replay pnpm-lock.yaml
git commit -m "feat: replay plan types and recorded-response providers"
```

---

### Task 2: `deriveMessages` `upToSeq` extension + TraceProjection

**Files:**
- Modify: `packages/runtime/src/projection.ts` (add optional `upToSeq`)
- Create: `packages/replay/src/projection.ts`
- Modify: `packages/replay/src/index.ts` (add export)
- Modify: `packages/replay/package.json` (add `@veridical/runtime` dep)
- Test: `packages/runtime/test/projection.test.ts` (add upToSeq cases)
- Test: `packages/replay/test/projection.test.ts`

**Interfaces:**
- Consumes: `TraceStore` (`@veridical/store`); `TraceEvent` (`@veridical/schema`); `deriveMessages` (`@veridical/runtime`); `ModelMessage` (`@veridical/runtime`).
- Produces:
  - `@veridical/runtime`: `function deriveMessages(store: TraceStore, session_id: string, upToSeq?: number): Promise<ModelMessage[]>` — truncates the event list to `seq <= upToSeq` before projecting (backward-compatible; omitted = all).
  - `interface ProjectionSnapshot { session_id: string; up_to_seq: number; messages: ModelMessage[]; events: TraceEvent[]; last_event?: TraceEvent }`
  - `class TraceProjection { constructor(store: TraceStore); projectAt(session_id: string, seq: number): Promise<ProjectionSnapshot>; cursor(session_id: string): AsyncIterable<ProjectionSnapshot>; count(session_id: string): Promise<number> }` — seq out-of-range truncates (seq > count → last; seq <= 0 → empty).

- [ ] **Step 1: Write the failing test**

```ts
// packages/runtime/test/projection.test.ts — ADD these cases to the existing file
import { deriveMessages } from '../src/index';

function evt(seq: number, type: string, verb: string, payload: any) {
  return { id: `e_${seq}`, tenant_id: 't1', session_id: 's1', span_id: 'sp', parent_span_id: null, seq, type, verb, attempt: 1, duration_ms: 1, payload, spec_version: '0.0.1' };
}

describe('deriveMessages upToSeq', () => {
  it('truncates to seq when upToSeq provided', async () => {
    const { InMemoryTraceStore } = await import('@veridical/store');
    const store = new InMemoryTraceStore();
    await store.append(evt(1, 'user.message', 'request', { text: 'a' }));
    await store.append(evt(2, 'assistant.message', 'response', { text: 'b' }));
    await store.append(evt(3, 'user.message', 'request', { text: 'c' }));
    const msgs = await deriveMessages(store, 's1', 2);
    expect(msgs.map(m => m.content)).toEqual(['a', 'b']);
  });

  it('defaults to full when upToSeq omitted', async () => {
    const { InMemoryTraceStore } = await import('@veridical/store');
    const store = new InMemoryTraceStore();
    await store.append(evt(1, 'user.message', 'request', { text: 'a' }));
    await store.append(evt(2, 'assistant.message', 'response', { text: 'b' }));
    const msgs = await deriveMessages(store, 's1');
    expect(msgs.map(m => m.content)).toEqual(['a', 'b']);
  });
});
```

```ts
// packages/replay/test/projection.test.ts
import { describe, it, expect } from 'vitest';
import { InMemoryTraceStore } from '@veridical/store';
import type { TraceEvent } from '@veridical/schema';
import { TraceProjection } from '../src/index';

function evt(seq: number, type: string, verb: string, payload: any): TraceEvent {
  return { id: `e${seq}`, tenant_id: 't1', session_id: 's1', span_id: 'sp', parent_span_id: null, seq, type, verb, attempt: 1, duration_ms: 1, payload, spec_version: '0.0.1' };
}

async function seed(): Promise<InMemoryTraceStore> {
  const store = new InMemoryTraceStore();
  await store.append(evt(1, 'user.message', 'request', { text: 'hello' }));
  await store.append(evt(2, 'assistant.message', 'response', { text: 'hi' }));
  await store.append(evt(3, 'tool.called', 'request', { name: 'echo', args: {} }));
  await store.append(evt(4, 'tool.result', 'response', { name: 'echo', result: 'ok' }));
  return store;
}

describe('TraceProjection', () => {
  it('projects state up to a seq', async () => {
    const p = new TraceProjection(await seed());
    const snap = await p.projectAt('s1', 2);
    expect(snap.up_to_seq).toBe(2);
    expect(snap.events.map(e => e.seq)).toEqual([1, 2]);
    expect(snap.messages.map(m => m.content)).toEqual(['hello', 'hi']);
    expect(snap.last_event?.seq).toBe(2);
  });

  it('truncates when seq exceeds the event count', async () => {
    const p = new TraceProjection(await seed());
    const snap = await p.projectAt('s1', 99);
    expect(snap.events.length).toBe(4);
    expect(snap.up_to_seq).toBe(4);
  });

  it('returns empty for seq 0 or negative', async () => {
    const p = new TraceProjection(await seed());
    const snap = await p.projectAt('s1', 0);
    expect(snap.events).toEqual([]);
    expect(snap.messages).toEqual([]);
  });

  it('count returns the number of events', async () => {
    const p = new TraceProjection(await seed());
    expect(await p.count('s1')).toBe(4);
  });

  it('cursor yields one snapshot per seq', async () => {
    const p = new TraceProjection(await seed());
    const seqs: number[] = [];
    for await (const snap of p.cursor('s1')) seqs.push(snap.up_to_seq);
    expect(seqs).toEqual([1, 2, 3, 4]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm install && pnpm -F @veridical/runtime test && pnpm -F @veridical/replay test`
Expected: FAIL — `deriveMessages` upToSeq not supported / `TraceProjection` not exported.

- [ ] **Step 3: Write minimal implementation**

`packages/runtime/src/projection.ts` — modify the signature and add the truncation:
```ts
export async function deriveMessages(store: TraceStore, session_id: string, upToSeq?: number): Promise<ModelMessage[]> {
  const all = await store.readBySession(session_id);
  const events = upToSeq === undefined ? all : all.filter(e => e.seq <= upToSeq);
  // ... rest unchanged (build `out` from `events` instead of `all`)
}
```

`packages/replay/src/projection.ts`:
```ts
import type { TraceStore } from '@veridical/store';
import type { TraceEvent } from '@veridical/schema';
import { deriveMessages, type ModelMessage } from '@veridical/runtime';

export interface ProjectionSnapshot {
  session_id: string;
  up_to_seq: number;
  messages: ModelMessage[];
  events: TraceEvent[];
  last_event?: TraceEvent;
}

export class TraceProjection {
  constructor(private store: TraceStore) {}

  async projectAt(session_id: string, seq: number): Promise<ProjectionSnapshot> {
    const all = await this.store.readBySession(session_id);
    const events = seq <= 0 ? [] : all.filter(e => e.seq <= seq);
    const up_to_seq = events.length > 0 ? events[events.length - 1].seq : 0;
    const messages = seq <= 0 ? [] : await deriveMessages(this.store, session_id, up_to_seq);
    return { session_id, up_to_seq, messages, events, last_event: events.length > 0 ? events[events.length - 1] : undefined };
  }

  async *cursor(session_id: string): AsyncIterable<ProjectionSnapshot> {
    const count = await this.count(session_id);
    for (let seq = 1; seq <= count; seq++) {
      yield await this.projectAt(session_id, seq);
    }
  }

  async count(session_id: string): Promise<number> {
    return (await this.store.readBySession(session_id)).length;
  }
}
```

`packages/replay/src/index.ts` (add):
```ts
export * from './plan';
export * from './providers';
export * from './projection';
```

`packages/replay/package.json` — add `"@veridical/runtime": "workspace:*"` to `dependencies`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm install && pnpm -F @veridical/runtime test && pnpm -F @veridical/replay test`
Expected: PASS (runtime existing + 2 new upToSeq cases; replay 5 projection tests).

- [ ] **Step 5: Commit**

```bash
git add packages/runtime packages/replay pnpm-lock.yaml
git commit -m "feat: deriveMessages upToSeq and time-travel projection"
```

---

### Task 3: RunComparator (event-level diff)

**Files:**
- Create: `packages/replay/src/comparator.ts`
- Modify: `packages/replay/src/index.ts` (add export)
- Test: `packages/replay/test/comparator.test.ts`

**Interfaces:**
- Consumes: `TraceStore` (`@veridical/store`); `TraceEvent` (`@veridical/schema`).
- Produces:
  - `interface DiffEntry { seq: number; field: 'type' | 'verb' | 'payload' | 'tokens' | 'cost'; left?: unknown; right?: unknown; kind: 'changed' | 'left_only' | 'right_only' }`
  - `interface RunDiff { session_a: string; session_b: string; differences: DiffEntry[]; summary: { events_a: number; events_b: number; first_divergence?: number; outcomes_equal: boolean; identical: boolean } }`
  - `class RunComparator { constructor(store: TraceStore); compare(a: string, b: string): Promise<RunDiff> }` — seq-aligned diff over `type`/`verb`/`payload`/`tokens`/`cost` (payload via `JSON.stringify` deep compare); outcome from `turn/end` payload.

- [ ] **Step 1: Write the failing test**

```ts
// packages/replay/test/comparator.test.ts
import { describe, it, expect } from 'vitest';
import { InMemoryTraceStore } from '@veridical/store';
import type { TraceEvent } from '@veridical/schema';
import { RunComparator } from '../src/index';

function evt(seq: number, type: string, verb: string, payload: any, session_id = 's'): TraceEvent {
  return { id: `e${seq}`, tenant_id: 't1', session_id, span_id: 'sp', parent_span_id: null, seq, type, verb, attempt: 1, duration_ms: 1, payload, spec_version: '0.0.1' };
}

async function seedA(): Promise<InMemoryTraceStore> {
  const store = new InMemoryTraceStore();
  await store.append(evt(1, 'user.message', 'request', { text: 'hello' }, 'a'));
  await store.append(evt(2, 'assistant.message', 'response', { text: 'hi' }, 'a'));
  await store.append(evt(99, 'turn/end', 'response', { outcome: 'done' }, 'a'));
  return store;
}

describe('RunComparator', () => {
  it('reports identical for two same sessions', async () => {
    const store = await seedA();
    const cmp = new RunComparator(store);
    const diff = await cmp.compare('a', 'a');
    expect(diff.summary.identical).toBe(true);
    expect(diff.differences).toEqual([]);
    expect(diff.summary.outcomes_equal).toBe(true);
  });

  it('reports changed for a differing payload', async () => {
    const store = await seedA();
    await store.append(evt(2, 'assistant.message', 'response', { text: 'bye' }, 'b'));
    await store.append(evt(1, 'user.message', 'request', { text: 'hello' }, 'b'));
    await store.append(evt(99, 'turn/end', 'response', { outcome: 'done' }, 'b'));
    const cmp = new RunComparator(store);
    const diff = await cmp.compare('a', 'b');
    expect(diff.summary.identical).toBe(false);
    const changed = diff.differences.find(d => d.field === 'payload');
    expect(changed).toBeDefined();
    expect(diff.summary.first_divergence).toBe(2);
  });

  it('reports left_only / right_only for differing event counts', async () => {
    const store = await seedA();
    await store.append(evt(1, 'user.message', 'request', { text: 'hello' }, 'c'));
    await store.append(evt(99, 'turn/end', 'response', { outcome: 'done' }, 'c'));
    const cmp = new RunComparator(store);
    const diff = await cmp.compare('a', 'c');
    expect(diff.summary.identical).toBe(false);
    expect(diff.summary.events_a).toBe(3);
    expect(diff.summary.events_b).toBe(2);
    expect(diff.differences.some(d => d.kind === 'right_only')).toBe(true);
  });

  it('reports unequal outcomes', async () => {
    const store = await seedA();
    await store.append(evt(1, 'user.message', 'request', { text: 'hello' }, 'd'));
    await store.append(evt(99, 'turn/end', 'response', { outcome: 'failed' }, 'd'));
    const cmp = new RunComparator(store);
    const diff = await cmp.compare('a', 'd');
    expect(diff.summary.outcomes_equal).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @veridical/replay test`
Expected: FAIL — `RunComparator` not exported.

- [ ] **Step 3: Write minimal implementation**

`packages/replay/src/comparator.ts`:
```ts
import type { TraceStore } from '@veridical/store';
import type { TraceEvent } from '@veridical/schema';

export interface DiffEntry {
  seq: number;
  field: 'type' | 'verb' | 'payload' | 'tokens' | 'cost';
  left?: unknown;
  right?: unknown;
  kind: 'changed' | 'left_only' | 'right_only';
}

export interface RunDiff {
  session_a: string;
  session_b: string;
  differences: DiffEntry[];
  summary: {
    events_a: number;
    events_b: number;
    first_divergence?: number;
    outcomes_equal: boolean;
    identical: boolean;
  };
}

const payloadOf = (e: TraceEvent) => e.payload as any;

function deepEq(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function outcomeOf(events: TraceEvent[]): unknown {
  const end = [...events].reverse().find(e => e.type === 'turn/end');
  return end ? payloadOf(end).outcome : undefined;
}

export class RunComparator {
  constructor(private store: TraceStore) {}

  async compare(a: string, b: string): Promise<RunDiff> {
    const evA = await this.store.readBySession(a);
    const evB = await this.store.readBySession(b);
    const bySeqA = new Map(evA.map(e => [e.seq, e]));
    const bySeqB = new Map(evB.map(e => [e.seq, e]));

    const differences: DiffEntry[] = [];
    const seqs = new Set([...bySeqA.keys(), ...bySeqB.keys()]);
    for (const seq of [...seqs].sort((x, y) => x - y)) {
      const ea = bySeqA.get(seq);
      const eb = bySeqB.get(seq);
      if (!ea) {
        differences.push({ seq, field: 'type', left: undefined, right: eb?.type, kind: 'right_only' });
      } else if (!eb) {
        differences.push({ seq, field: 'type', left: ea.type, right: undefined, kind: 'left_only' });
      } else {
        const fields: ('type' | 'verb' | 'payload' | 'tokens' | 'cost')[] = ['type', 'verb', 'payload', 'tokens', 'cost'];
        for (const field of fields) {
          const l = ea[field];
          const r = eb[field];
          if (!deepEq(l, r)) differences.push({ seq, field, left: l, right: r, kind: 'changed' });
        }
      }
    }

    const firstDivergence = differences.length > 0 ? differences[0].seq : undefined;
    return {
      session_a: a,
      session_b: b,
      differences,
      summary: {
        events_a: evA.length,
        events_b: evB.length,
        first_divergence,
        outcomes_equal: deepEq(outcomeOf(evA), outcomeOf(evB)),
        identical: differences.length === 0,
      },
    };
  }
}
```

`packages/replay/src/index.ts` (add):
```ts
export * from './comparator';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -F @veridical/replay test`
Expected: PASS (4 comparator tests + existing).

- [ ] **Step 5: Commit**

```bash
git add packages/replay
git commit -m "feat: event-level run comparator"
```

---

### Task 4: ReplayEngine (re-execution + trace identity assertion)

**Files:**
- Create: `packages/replay/src/engine.ts`
- Modify: `packages/replay/src/index.ts` (add export)
- Modify: `packages/replay/package.json` (add `@veridical/spec` dep)
- Test: `packages/replay/test/engine.test.ts`

**Interfaces:**
- Consumes: `ReplayPlan`/`ReplayStrategy` (Task 1); `ReplayLLMProvider`/`ReplayToolProvider`/`ReplayMissError` (Task 1); `parseSpecYaml`/`parseSpecYaml`/`InMemorySpecRegistry`/`SpecRegistry`/`runSpec`/`RunResult`/`SpecRunnerDeps` (`@veridical/spec`); `fingerprint` (`@veridical/llm`); `TraceStore` (`@veridical/store`).
- Produces:
  - `class TraceDivergenceError extends Error` — carries `seq` and `differences: DiffEntry[]`.
  - `class ReplayError extends Error`
  - `interface ReplayResult { session_id: string; spec_name: string; spec_version: string; outcome: unknown; events: TraceEvent[]; identical: boolean }`
  - `class ReplayEngine { constructor(store: TraceStore, registry: SpecRegistry); replay(session_id: string, plan: ReplayPlan, tools: ToolDef[]): Promise<ReplayResult> }` — loads recorded events for `session_id`; builds providers by strategy (default `replay`); extracts `prompt` from `spec/run/start`; resolves spec; `runSpec`; if `assert_trace_identical !== false`, compares new trace vs recorded (seq-aligned via `RunComparator` logic) and throws `TraceDivergenceError` on mismatch; returns `{ ..., identical }`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/replay/test/engine.test.ts
import { describe, it, expect } from 'vitest';
import { InMemoryTraceStore } from '@veridical/store';
import { InMemorySpecRegistry, parseSpecYaml, runSpec, type ToolDef } from '@veridical/spec';
import { MockProvider, fingerprint } from '@veridical/llm';
import { ReplayEngine, ReplayError, ReplayMissError, TraceDivergenceError } from '../src/index';

const SPEC = `
name: replay-test
version: 1.0.0
schema_version: 1
instruction:
  system: You are a test agent.
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

const usage = { input: 1, output: 1, cached: 0, total: 2 };
const echo: ToolDef = { id: 'echo', name: 'echo', description: '', deterministic: true, execute: async (a) => a };

async function recordRun(store: InMemoryTraceStore, prompt: string): Promise<string> {
  const spec = parseSpecYaml(SPEC);
  const mock = new MockProvider();
  const fp = (p: string) => fingerprint({ provider: 'mock', model: 'm', messages: [{ role: 'system', content: 'You are a test agent.' }, { role: 'user', content: p }] });
  mock.record(fp(prompt), 'answer', usage);
  await runSpec(
    { store, providers: new Map([['mock', mock]]), tools: [echo], tenant_id: 't1', session_id: 's1' },
    spec,
    prompt,
  );
  return 's1';
}

describe('ReplayEngine', () => {
  it('replays a recorded run identically', async () => {
    const store = new InMemoryTraceStore();
    await recordRun(store, 'hello');
    const registry = new InMemorySpecRegistry();
    await registry.register(parseSpecYaml(SPEC));
    const engine = new ReplayEngine(store, registry);
    const result = await engine.replay('s1', { spec: { name: 'replay-test', version: '1.0.0' } }, [echo]);
    expect(result.identical).toBe(true);
    expect(result.outcome).toBe('answer');
  });

  it('throws TraceDivergenceError when the recorded response changed', async () => {
    const store = new InMemoryTraceStore();
    await recordRun(store, 'hello');
    const registry = new InMemorySpecRegistry();
    await registry.register(parseSpecYaml(SPEC));
    const engine = new ReplayEngine(store, registry);
    // Override the recorded response via fixtures: replay a DIFFERENT response than recorded
    const fp = fingerprint({ provider: 'mock', model: 'm', messages: [{ role: 'system', content: 'You are a test agent.' }, { role: 'user', content: 'hello' }] });
    await expect(
      engine.replay('s1', { spec: { name: 'replay-test' }, llm: { mock: 'fixture' }, fixtures: { llm: [{ provider: 'mock', responses: [{ fingerprint: fp, text: 'DIFFERENT', usage }] }] } }, [echo]),
    ).rejects.toThrow(TraceDivergenceError);
  });

  it('throws ReplayError when the spec is not registered', async () => {
    const store = new InMemoryTraceStore();
    await recordRun(store, 'hello');
    const engine = new ReplayEngine(store, new InMemorySpecRegistry());
    await expect(engine.replay('s1', { spec: { name: 'missing' } }, [echo])).rejects.toThrow(ReplayError);
  });

  it('returns not identical when assertion disabled and responses differ', async () => {
    const store = new InMemoryTraceStore();
    await recordRun(store, 'hello');
    const registry = new InMemorySpecRegistry();
    await registry.register(parseSpecYaml(SPEC));
    const engine = new ReplayEngine(store, registry);
    const fp = fingerprint({ provider: 'mock', model: 'm', messages: [{ role: 'system', content: 'You are a test agent.' }, { role: 'user', content: 'hello' }] });
    const result = await engine.replay('s1', {
      spec: { name: 'replay-test' }, assert_trace_identical: false,
      llm: { mock: 'fixture' }, fixtures: { llm: [{ provider: 'mock', responses: [{ fingerprint: fp, text: 'DIFFERENT', usage }] }] },
    }, [echo]);
    expect(result.identical).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm install && pnpm -F @veridical/replay test`
Expected: FAIL — `ReplayEngine` / `TraceDivergenceError` / `ReplayError` not exported.

- [ ] **Step 3: Write minimal implementation**

`packages/replay/package.json` — add `"@veridical/spec": "workspace:*"` to `dependencies`.

`packages/replay/src/engine.ts`:
```ts
import type { TraceStore } from '@veridical/store';
import type { TraceEvent } from '@veridical/schema';
import { fingerprint, type LLMProvider } from '@veridical/llm';
import { runSpec, type SpecRegistry, type SpecRunnerDeps, type ToolDef } from '@veridical/spec';
import { ReplayLLMProvider, ReplayToolProvider, ReplayMissError } from './providers';
import type { ReplayPlan, ReplayStrategy } from './plan';
import { RunComparator, type DiffEntry } from './comparator';

export class TraceDivergenceError extends Error {
  constructor(public seq: number, public differences: DiffEntry[]) {
    super(`trace diverged at seq ${seq}`);
    this.name = 'TraceDivergenceError';
  }
}

export class ReplayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReplayError';
  }
}

export interface ReplayResult {
  session_id: string;
  spec_name: string;
  spec_version: string;
  outcome: unknown;
  events: TraceEvent[];
  identical: boolean;
}

const payloadOf = (e: TraceEvent) => e.payload as any;

export class ReplayEngine {
  constructor(private store: TraceStore, private registry: SpecRegistry) {}

  async replay(session_id: string, plan: ReplayPlan, tools: ToolDef[]): Promise<ReplayResult> {
    const recorded = await this.store.readBySession(session_id);
    const startEvt = recorded.find(e => e.type === 'spec/run/start');
    if (!startEvt) throw new ReplayError(`no spec/run/start found for session ${session_id}`);
    const prompt = payloadOf(startEvt).input;

    const spec = await this.registry.resolve(plan.spec.name, plan.spec.version);
    if (!spec) throw new ReplayError(`spec not found: ${plan.spec.name}@${plan.spec.version ?? 'latest'}`);

    // LLM providers: each recorded provider name maps to a strategy (default 'replay').
    const replayProvider = new ReplayLLMProvider(recorded);
    const providers = new Map<string, LLMProvider>();
    const providerNames = new Set<string>();
    for (const e of recorded) if (e.type === 'llm.request') providerNames.add(payloadOf(e).provider);
    const llmStrategy = (provider: string): ReplayStrategy => plan.llm?.[provider] ?? 'replay';
    for (const name of providerNames) {
      const strategy = llmStrategy(name);
      if (strategy === 'replay') {
        providers.set(name, replayProvider);
      } else if (strategy === 'fixture') {
        const f = plan.fixtures?.llm?.find(x => x.provider === name);
        if (!f || f.responses.length === 0) throw new ReplayMissError(`no fixture responses for llm provider ${name}`);
        const responses = new Map(f.responses.map(r => [r.fingerprint, { text: r.text, usage: r.usage }]));
        providers.set(name, {
          complete: async (req) => {
            const hit = responses.get(fingerprint(req));
            if (!hit) throw new ReplayMissError(`no fixture response for fingerprint`);
            return hit;
          },
        });
      }
      // 'live' (real provider) requires the caller to inject a live provider map; not wired here.
    }

    // Tools: per-name strategy wrapping the injected library.
    const replayTool = new ReplayToolProvider(recorded);
    const toolStrategy = (name: string): ReplayStrategy => plan.tools?.[name] ?? 'replay';
    const wrappedTools = tools.map(t => ({
      ...t,
      execute: async (args: unknown) => {
        const strategy = toolStrategy(t.name);
        if (strategy === 'replay') return replayTool.execute(t.name, args);
        if (strategy === 'fixture') {
          const f = plan.fixtures?.tools?.find(x => x.name === t.name);
          if (!f || f.responses.length === 0) throw new ReplayMissError(`no fixture responses for tool ${t.name}`);
          return f.responses.shift();
        }
        return t.execute(args); // 'live'
      },
    }));

    const replaySessionId = `replay_${session_id}`;
    const deps: SpecRunnerDeps = {
      store: this.store,
      providers,
      tools: wrappedTools,
      tenant_id: recorded[0]?.tenant_id ?? 't1',
      session_id: replaySessionId,
    };

    await runSpec(deps, spec, prompt);

    // Trace identity assertion: the replay events landed in the store under replaySessionId.
    const compare = new RunComparator(this.store);
    const diff = await compare.compare(session_id, replaySessionId);
    if (plan.assert_trace_identical !== false && !diff.summary.identical) {
      throw new TraceDivergenceError(diff.summary.first_divergence ?? 0, diff.differences);
    }

    const replayEvents = await this.store.readBySession(replaySessionId);
    const endTurn = [...replayEvents].reverse().find(e => e.type === 'turn/end');
    return {
      session_id: replaySessionId,
      spec_name: spec.name,
      spec_version: spec.version,
      outcome: endTurn ? payloadOf(endTurn).outcome : undefined,
      events: replayEvents,
      identical: diff.summary.identical,
    };
  }
}
```

`packages/replay/src/index.ts` (add):
```ts
export * from './engine';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm install && pnpm -F @veridical/replay test`
Expected: PASS (4 engine tests + existing).

- [ ] **Step 5: Commit**

```bash
git add packages/replay pnpm-lock.yaml
git commit -m "feat: replay engine with trace identity assertion"
```

---

### Task 5: Demo — replay-driven run

**Files:**
- Create: `packages/demo/src/replay-demo.ts`
- Create: `packages/demo/test/replay-smoke.test.ts`
- Modify: `packages/demo/package.json` (add `@veridical/replay` dep)

**Interfaces:**
- Consumes: `parseSpecYaml`/`InMemorySpecRegistry`/`runSpec` (`@veridical/spec`); `MockProvider`/`fingerprint` (`@veridical/llm`); `JsonlTraceStore` (`@veridical/store`); `ReplayEngine`/`TraceProjection`/`RunComparator` (`@veridical/replay`); `ToolDef` (`@veridical/tools`).
- Produces:
  - `function runReplayDemo(dir: string): Promise<{ store: JsonlTraceStore; replay: { identical: boolean } }>` — runs a spec (mock LLM + echo tool) to JSONL, then replays it identically via `ReplayEngine`, projects a seq via `TraceProjection`, and compares original vs replay via `RunComparator`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/demo/test/replay-smoke.test.ts
import { describe, it, expect } from 'vitest';
import { runReplayDemo } from '../src/replay-demo';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('replay-driven demo', () => {
  it('runs, replays identically, projects, and compares', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rt-replay-'));
    const { store, replay } = await runReplayDemo(dir);
    expect(replay.identical).toBe(true);
    const events = await store.readBySession('s1');
    expect(events.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm install && pnpm -F @veridical/demo test`
Expected: FAIL — `runReplayDemo` not exported / `@veridical/replay` not found.

- [ ] **Step 3: Write minimal implementation**

`packages/demo/package.json` — add `"@veridical/replay": "workspace:*"` to `dependencies`.

`packages/demo/src/replay-demo.ts`:
```ts
import { JsonlTraceStore } from '@veridical/store';
import { InMemorySpecRegistry, parseSpecYaml, runSpec } from '@veridical/spec';
import { MockProvider, fingerprint } from '@veridical/llm';
import { ReplayEngine } from '@veridical/replay';
import type { ToolDef } from '@veridical/tools';

const SPEC = `
name: replay-demo
version: 1.0.0
schema_version: 1
instruction:
  system: You are a test agent.
flow:
  mode: single-loop
  max_steps: 2
llm:
  provider: mock
  model: m
  fallback: []
tools:
  - name: echo
    access: allow
`;

const usage = { input: 1, output: 1, cached: 0, total: 2 };
const echo: ToolDef = { id: 'echo', name: 'echo', description: '', deterministic: true, execute: async (a) => a };

export async function runReplayDemo(dir: string) {
  const store = new JsonlTraceStore(dir);
  const spec = parseSpecYaml(SPEC);
  const mock = new MockProvider();
  const messages = [{ role: 'system', content: 'You are a test agent.' }, { role: 'user', content: 'hello' }];
  mock.record(fingerprint({ provider: 'mock', model: 'm', messages }), 'answer', usage);
  await runSpec({ store, providers: new Map([['mock', mock]]), tools: [echo], tenant_id: 't1', session_id: 's1' }, spec, 'hello');

  const registry = new InMemorySpecRegistry();
  await registry.register(spec);
  const engine = new ReplayEngine(store, registry);
  const replay = await engine.replay('s1', { spec: { name: 'replay-demo' } }, [echo]);
  return { store, replay };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm install && pnpm -F @veridical/demo test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/demo pnpm-lock.yaml
git commit -m "feat: replay-driven demo"
```

---

### Task 6: Full suite + acceptance verification

**Files:**
- None (verification only).

**Interfaces:**
- Consumes: all packages.

- [ ] **Step 1: Run the entire test suite**

Run: `pnpm test`
Expected: all packages PASS (schema, store, runtime, tools, llm, spec, eval, replay, demo).

- [ ] **Step 2: Run the strict build**

Run: `pnpm build`
Expected: all packages compile clean under `"strict": true`.

- [ ] **Step 3: Verify acceptance criterion — deterministic replay**

`engine.test.ts` asserts a recorded run replays identically (LLM by fingerprint, tool by call sequence), fixture responses produce divergence, `ReplayMissError` on miss, `ReplayError` on unresolved spec.

- [ ] **Step 4: Verify acceptance criterion — time-travel projection**

`projection.test.ts` + runtime upToSeq tests assert any-seq model context/event subset, truncation, cursor stepping, and backward-compatible `deriveMessages`.

- [ ] **Step 5: Verify acceptance criterion — run comparison**

`comparator.test.ts` asserts identical/changed/only diff entries, `first_divergence`, and outcome equality.

- [ ] **Step 6: Commit (if any fixes were needed)**

```bash
git add -A
git commit -m "test: verify Phase 4 acceptance criteria"
```
