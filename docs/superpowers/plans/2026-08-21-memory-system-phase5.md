# Memory System (Phase 5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the memory system — working memory (session-scoped KV), long-term semantic memory (cross-session, tag/keyword recall), and procedural skills (cross-session entries), all event-log-driven (memory-writes are `memory.*` events reconstructable from the log), injected into `runSpec`'s context via an optional `memory` hook.

**Architecture:** New package `@veridical/memory` layered on `@veridical/schema`/`@veridical/store`/`@veridical/runtime`/`@veridical/spec`. `MemoryStore` writes `memory.*` events via a `Recorder` and reconstructs state via a pure `snapshot` projection. `Memory` facade exposes working/semantic/skill operations with deterministic recall (tag match + keyword contains + recency sort). `runSpec` gains an optional `memory?: MemoryLike` field (spec stays memory-free via a minimal structural interface); `defaultRunStep` injects recalled entries into the system message. Dependency direction: `@veridical/memory` → `@veridical/spec` → downstream, one-way.

**Tech Stack:** TypeScript (strict), pnpm workspaces, vitest.

## Global Constraints

- TypeScript strict mode throughout (`"strict": true`).
- Monorepo via pnpm workspaces under `packages/*`.
- Testing with vitest; every feature task uses TDD (write failing test → run → implement → run pass).
- No code comments unless they explain non-obvious logic.
- Node-API packages need `@types/node` + tsconfig `types: ["vitest/globals", "node"]`.
- New package name: `@veridical/memory` (version 0.0.1, `type: module`, `main: src/index.ts`).
- **Dependency direction strictly `@veridical/memory` → `@veridical/spec` → downstream one-way.** `@veridical/spec` must NOT import from `@veridical/memory`. The `memory` hook on `SpecRunnerDeps` is typed as a plain minimal interface `MemoryLike` so spec stays memory-free.
- `@veridical/spec` change is minimal: add `memory?: MemoryLike` to `SpecRunnerDeps`, use it in `runSpec`'s default step when provided.
- Memory state is **event-log-driven**: every write/read/recall is a `memory.*` event; `snapshot` reconstructs state purely from events. No independent KV storage.
- Working memory is session-scoped (current `session_id`); long-term memory (semantic/skill) is cross-session, written to the shared `_memory` session.
- Recall is deterministic: tag exact-match + keyword contains (`/\W+/` tokenization, tokens length ≥ 2) + recency sort (higher write seq first), top-N (default 5). No external vector DB.
- `deriveMessages` is unchanged — memory enters the **request** (system block), not the event reconstruction.
- `memory.recall` throwing in `runSpec` degrades to "no memory" (skip injection, don't crash the loop) — memory is augmentation, not a dependency.
- Commit after every task with a conventional message.

---

### Task 1: `@veridical/memory` scaffold + MemoryStore (event-driven write/read/snapshot)

**Files:**
- Create: `packages/memory/package.json`
- Create: `packages/memory/tsconfig.json`
- Create: `packages/memory/src/index.ts`
- Create: `packages/memory/src/events.ts`
- Create: `packages/memory/src/store.ts`
- Test: `packages/memory/test/store.test.ts`

**Interfaces:**
- Consumes: `TraceEvent` (`@veridical/schema`); `TraceStore` (`@veridical/store`); `Recorder` (`@veridical/runtime`).
- Produces:
  - `type MemoryScope = 'working' | 'semantic' | 'skill'`
  - `interface MemoryEntry { key: string; value: unknown; scope: MemoryScope; tags?: string[] }`
  - `interface MemorySnapshot { entries: MemoryEntry[] }`
  - `class MemoryStore { write(recorder: Recorder, entry: MemoryEntry): Promise<void>; read(recorder: Recorder, key: string): Promise<unknown>; snapshot(store: TraceStore, session_id: string): Promise<MemorySnapshot> }`
    - `write` records a `memory.write` event (type `memory.write`, verb `request`, payload `{ action:'write', key, value, scope, tags? }`).
    - `read` records a `memory.read` event, then returns the snapshot's current value for `key` (undefined if absent).
    - `snapshot` reads `memory.write` events, last-write-wins per key, carrying scope/tags.
  - `const MEMORY_SESSION = '_memory'` — the shared cross-session session id for long-term memory.

- [ ] **Step 1: Write the failing test**

```ts
// packages/memory/test/store.test.ts
import { describe, it, expect } from 'vitest';
import { InMemoryTraceStore } from '@veridical/store';
import { Session, Recorder } from '@veridical/runtime';
import { MemoryStore, MEMORY_SESSION, type MemoryScope } from '../src/index';

function session(id: string, spec_version = '0.0.1'): Session {
  return new Session({ session_id: id, tenant_id: 't1', spec_version });
}

async function newRecorder(store: InMemoryTraceStore, id = 's1'): Promise<Recorder> {
  return new Recorder(store, session(id));
}

describe('MemoryStore', () => {
  it('writes a memory.write event and reconstructs it via snapshot', async () => {
    const store = new InMemoryTraceStore();
    const rec = await newRecorder(store);
    const ms = new MemoryStore();
    await ms.write(rec, { key: 'k1', value: 'v1', scope: 'working' });
    const snap = await ms.snapshot(store, 's1');
    expect(snap.entries).toContainEqual({ key: 'k1', value: 'v1', scope: 'working' });
    const types = (await store.readBySession('s1')).map(e => e.type);
    expect(types).toContain('memory.write');
  });

  it('last-write-wins on the same key', async () => {
    const store = new InMemoryTraceStore();
    const rec = await newRecorder(store);
    const ms = new MemoryStore();
    await ms.write(rec, { key: 'k', value: 1, scope: 'working' });
    await ms.write(rec, { key: 'k', value: 2, scope: 'working' });
    const snap = await ms.snapshot(store, 's1');
    expect(snap.entries.find(e => e.key === 'k')?.value).toBe(2);
    expect(snap.entries.length).toBe(1);
  });

  it('keeps tags and multiple scopes', async () => {
    const store = new InMemoryTraceStore();
    const rec = await newRecorder(store);
    const ms = new MemoryStore();
    await ms.write(rec, { key: 'a', value: 'x', scope: 'semantic', tags: ['claim', 'policy'] });
    await ms.write(rec, { key: 'b', value: 'y', scope: 'skill', tags: ['procedure'] });
    const snap = await ms.snapshot(store, 's1');
    expect(snap.entries).toHaveLength(2);
    expect(snap.entries.find(e => e.key === 'a')?.tags).toEqual(['claim', 'policy']);
  });

  it('read returns the current value and records a memory.read event', async () => {
    const store = new InMemoryTraceStore();
    const rec = await newRecorder(store);
    const ms = new MemoryStore();
    await ms.write(rec, { key: 'k', value: 'val', scope: 'working' });
    const rec2 = await newRecorder(store);
    expect(await ms.read(rec2, 'k')).toBe('val');
    expect(await ms.read(rec2, 'missing')).toBeUndefined();
    const types = (await store.readBySession('s1')).map(e => e.type);
    expect(types.filter(t => t === 'memory.read').length).toBeGreaterThanOrEqual(1);
  });

  it('snapshot from the shared MEMORY_SESSION holds long-term entries', async () => {
    const store = new InMemoryTraceStore();
    const rec = await newRecorder(store, MEMORY_SESSION);
    const ms = new MemoryStore();
    await ms.write(rec, { key: 'lt', value: 'long', scope: 'semantic', tags: ['shared'] });
    const snap = await ms.snapshot(store, MEMORY_SESSION);
    expect(snap.entries.find(e => e.key === 'lt')?.value).toBe('long');
  });

  it('snapshot returns empty for an unknown session', async () => {
    const store = new InMemoryTraceStore();
    const ms = new MemoryStore();
    expect((await ms.snapshot(store, 'nope')).entries).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm install && pnpm -F @veridical/memory test`
Expected: FAIL — `@veridical/memory` package not found / `MemoryStore` not exported.

- [ ] **Step 3: Write minimal implementation**

`packages/memory/package.json`:
```json
{
  "name": "@veridical/memory",
  "version": "0.0.1",
  "type": "module",
  "main": "src/index.ts",
  "dependencies": {
    "@veridical/schema": "workspace:*",
    "@veridical/store": "workspace:*",
    "@veridical/runtime": "workspace:*"
  },
  "devDependencies": {
    "@types/node": "^26.2.0",
    "typescript": "^5.0.0",
    "vitest": "^3.0.0"
  },
  "scripts": { "build": "tsc -p tsconfig.json", "test": "vitest run" }
}
```

`packages/memory/tsconfig.json`:
```json
{ "extends": "../../tsconfig.base.json", "compilerOptions": { "outDir": "dist", "types": ["vitest/globals", "node"] }, "include": ["src"] }
```

`packages/memory/src/events.ts`:
```ts
export type MemoryScope = 'working' | 'semantic' | 'skill';

export type MemoryEventPayload =
  | { action: 'write'; key: string; value: unknown; scope: MemoryScope; tags?: string[] }
  | { action: 'read'; key: string; scope: MemoryScope }
  | { action: 'recall'; query: string; scope: 'semantic' | 'skill'; hits: { key: string }[] };
```

`packages/memory/src/store.ts`:
```ts
import type { TraceStore } from '@veridical/store';
import type { TraceEvent } from '@veridical/schema';
import type { Recorder } from '@veridical/runtime';
import type { MemoryScope } from './events';

export const MEMORY_SESSION = '_memory';

export interface MemoryEntry {
  key: string;
  value: unknown;
  scope: MemoryScope;
  tags?: string[];
}

export interface MemorySnapshot {
  entries: MemoryEntry[];
}

const payloadOf = (e: TraceEvent) => e.payload as any;

export class MemoryStore {
  async write(recorder: Recorder, entry: MemoryEntry): Promise<void> {
    await recorder.record({
      span_id: 'memory', parent_span_id: null, type: 'memory.write', verb: 'request', attempt: 1, duration_ms: 0,
      payload: { action: 'write', key: entry.key, value: entry.value, scope: entry.scope, ...(entry.tags ? { tags: entry.tags } : {}) },
    });
  }

  async read(recorder: Recorder, key: string): Promise<unknown> {
    await recorder.record({
      span_id: 'memory', parent_span_id: null, type: 'memory.read', verb: 'request', attempt: 1, duration_ms: 0,
      payload: { action: 'read', key, scope: 'working' },
    });
    const snap = await this.snapshot((recorder as any).store as TraceStore, (recorder as any).session.session_id);
    return snap.entries.find(e => e.key === key)?.value;
  }

  async snapshot(store: TraceStore, session_id: string): Promise<MemorySnapshot> {
    const events = await store.readBySession(session_id);
    const byKey = new Map<string, MemoryEntry>();
    for (const e of events) {
      if (e.type !== 'memory.write') continue;
      const p = payloadOf(e);
      byKey.set(p.key, { key: p.key, value: p.value, scope: p.scope, ...(p.tags ? { tags: p.tags } : {}) });
    }
    return { entries: [...byKey.values()] };
  }
}
```

`packages/memory/src/index.ts`:
```ts
export * from './events';
export * from './store';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm install && pnpm -F @veridical/memory test`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/memory pnpm-lock.yaml
git commit -m "feat: event-driven memory store with snapshot projection"
```

---

### Task 2: Memory facade (working/semantic/skill + recall/forget) + memoryToSystemPrompt

**Files:**
- Create: `packages/memory/src/memory.ts`
- Create: `packages/memory/src/prompt.ts`
- Modify: `packages/memory/src/index.ts` (add exports)
- Test: `packages/memory/test/memory.test.ts`
- Test: `packages/memory/test/prompt.test.ts`

**Interfaces:**
- Consumes: `MemoryStore`/`MemoryEntry`/`MEMORY_SESSION` (Task 1); `Recorder` (`@veridical/runtime`); `TraceStore` (`@veridical/store`).
- Produces:
  - `class Memory { constructor(store: MemoryStore, session_id: string, recorder: Recorder) }` — working ops on current session, semantic/skill ops on `MEMORY_SESSION`:
    - `remember(key, value): Promise<void>` — working, current session.
    - `workingGet(key): Promise<unknown>` — working, current session.
    - `rememberSemantic(key, value, tags?): Promise<void>` — semantic on `_memory`.
    - `recall(query, opts?: { tags?: string[]; limit?: number }): Promise<MemoryEntry[]>` — from `_memory` semantic+skill entries; deterministic (tag match + keyword contains + recency); records a `memory.recalled` event.
    - `rememberSkill(name, procedure, tags?): Promise<void>` — skill on `_memory`, value `{ name, description, procedure }` (description = name for now).
    - `listSkills(): Promise<MemoryEntry[]>` — skill entries from `_memory`.
    - `forget(key, scope): Promise<void>` — records a `memory.write` with a tombstone? No — forget is a no-op if absent; when present it writes a new `memory.write` with `value: undefined` to mark deletion (last-write-wins makes it disappear from snapshot). Simpler: write `{ key, value: undefined, scope }` (snapshot treats undefined value as deletion).
  - `function memoryToSystemPrompt(memories: MemoryEntry[]): string` — builds the `## 记忆` block.

- [ ] **Step 1: Write the failing test**

```ts
// packages/memory/test/memory.test.ts
import { describe, it, expect } from 'vitest';
import { InMemoryTraceStore } from '@veridical/store';
import { Session, Recorder } from '@veridical/runtime';
import { Memory, MemoryStore, MEMORY_SESSION } from '../src/index';

function session(id: string, spec_version = '0.0.1'): Session {
  return new Session({ session_id: id, tenant_id: 't1', spec_version });
}

describe('Memory', () => {
  it('working memory is session-scoped', async () => {
    const store = new InMemoryTraceStore();
    const m = new Memory(new MemoryStore(), 's1', new Recorder(store, session('s1')));
    await m.remember('k', 'v');
    expect(await m.workingGet('k')).toBe('v');
    // A different session sees nothing
    const m2 = new Memory(new MemoryStore(), 's2', new Recorder(store, session('s2')));
    expect(await m2.workingGet('k')).toBeUndefined();
  });

  it('semantic memory persists across sessions via _memory', async () => {
    const store = new InMemoryTraceStore();
    await new Memory(new MemoryStore(), 's1', new Recorder(store, session('s1'))).rememberSemantic('policy', 'P12345', ['claim']);
    const m2 = new Memory(new MemoryStore(), 's2', new Recorder(store, session('s2')));
    const hits = await m2.recall('claim policy');
    expect(hits.map(h => h.key)).toContain('policy');
  });

  it('recall matches tags and keywords, sorts by recency, respects limit', async () => {
    const store = new InMemoryTraceStore();
    const m = new Memory(new MemoryStore(), 's1', new Recorder(store, session('s1')));
    await m.rememberSemantic('a', 'first thing', ['x']);
    await m.rememberSemantic('b', 'second alpha', ['y']);
    await m.rememberSemantic('c', 'third alpha', ['z']);
    const hits = await m.recall('alpha');
    expect(hits.map(h => h.key)).toEqual(['c', 'b']);   // both contain 'alpha', newest-first (c written later)
    const limited = await m.recall('alpha', { limit: 1 });
    expect(limited.map(h => h.key)).toEqual(['c']);
    const byTag = await m.recall('', { tags: ['z'] });
    expect(byTag.map(h => h.key)).toEqual(['c']);
  });

  it('skills are listed and rememberable', async () => {
    const store = new InMemoryTraceStore();
    const m = new Memory(new MemoryStore(), 's1', new Recorder(store, session('s1')));
    await m.rememberSkill('echo_helper', { name: 'echo_helper', description: 'echo', procedure: 'return args' });
    const skills = await m.listSkills();
    expect(skills.map(s => s.value)).toContainEqual({ name: 'echo_helper', description: 'echo', procedure: 'return args' });
  });

  it('forget removes a memory (undefined tombstone)', async () => {
    const store = new InMemoryTraceStore();
    const m = new Memory(new MemoryStore(), 's1', new Recorder(store, session('s1')));
    await m.remember('k', 'v');
    await m.forget('k', 'working');
    expect(await m.workingGet('k')).toBeUndefined();
  });

  it('recall records a memory.recalled event', async () => {
    const store = new InMemoryTraceStore();
    const m = new Memory(new MemoryStore(), 's2', new Recorder(store, session('s2')));
    await m.recall('nothing');
    const types = (await store.readBySession('s2')).map(e => e.type);
    expect(types).toContain('memory.recalled');
  });
});
```

```ts
// packages/memory/test/prompt.test.ts
import { describe, it, expect } from 'vitest';
import { memoryToSystemPrompt } from '../src/index';

describe('memoryToSystemPrompt', () => {
  it('builds a memory block from entries', () => {
    const out = memoryToSystemPrompt([
      { key: 'policy', value: 'P12345', scope: 'semantic', tags: ['claim'] },
      { key: 'echo', value: { name: 'echo', description: 'echo', procedure: 'x' }, scope: 'skill' },
    ]);
    expect(out).toContain('## 记忆');
    expect(out).toContain('[semantic] policy: P12345');
    expect(out).toContain('[skill] echo: echo');
  });

  it('returns empty for no memories', () => {
    expect(memoryToSystemPrompt([])).toBe('');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @veridical/memory test`
Expected: FAIL — `Memory` / `memoryToSystemPrompt` not exported.

- [ ] **Step 3: Write minimal implementation**

`packages/memory/src/memory.ts`:
```ts
import type { Recorder } from '@veridical/runtime';
import { MemoryStore, MEMORY_SESSION, type MemoryEntry } from './store';
import type { MemoryScope } from './events';

function stringify(v: unknown): string {
  return typeof v === 'string' ? v : JSON.stringify(v);
}

function tokenize(query: string): string[] {
  return query.split(/\W+/).map(t => t.trim().toLowerCase()).filter(t => t.length >= 2);
}

`packages/memory/src/memory.ts`:
```ts
import type { Recorder } from '@veridical/runtime';
import { MemoryStore, MEMORY_SESSION, type MemoryEntry } from './store';
import type { MemoryScope } from './events';

function stringify(v: unknown): string {
  return typeof v === 'string' ? v : JSON.stringify(v);
}

function tokenize(query: string): string[] {
  return query.split(/\W+/).map(t => t.trim().toLowerCase()).filter(t => t.length >= 2);
}

export class Memory {
  constructor(
    private store: MemoryStore,
    private session_id: string,
    private recorder: Recorder,          // bound to current session (working memory)
    private longRecorder: Recorder,      // bound to MEMORY_SESSION (long-term memory)
  ) {}

  async remember(key: string, value: unknown): Promise<void> {
    await this.store.write(this.recorder, { key, value, scope: 'working' });
  }

  async workingGet(key: string): Promise<unknown> {
    const snap = await this.store.snapshot((this.recorder as any).store, this.session_id);
    return snap.entries.find(e => e.key === key)?.value;
  }

  async rememberSemantic(key: string, value: unknown, tags?: string[]): Promise<void> {
    await this.store.write(this.longRecorder, { key, value, scope: 'semantic', ...(tags ? { tags } : {}) });
  }

  async rememberSkill(name: string, procedure: unknown, tags?: string[]): Promise<void> {
    await this.store.write(this.longRecorder, {
      key: `skill:${name}`,
      value: { name, description: name, procedure },
      scope: 'skill',
      ...(tags ? { tags } : {}),
    });
  }

  async listSkills(): Promise<MemoryEntry[]> {
    const snap = await this.store.snapshot((this.longRecorder as any).store, MEMORY_SESSION);
    return snap.entries.filter(e => e.scope === 'skill');
  }

  async recall(query: string, opts?: { tags?: string[]; limit?: number }): Promise<MemoryEntry[]> {
    const snap = await this.store.snapshot((this.longRecorder as any).store, MEMORY_SESSION);
    const limit = opts?.limit ?? 5;
    const keywords = tokenize(query);
    const byKey = new Map<string, MemoryEntry>();
    const seqOrder: string[] = [];
    // Rebuild with write order (recency): iterate events in seq order.
    const events = await (this.longRecorder as any).store.readBySession(MEMORY_SESSION);
    for (const e of events) {
      if (e.type !== 'memory.write') continue;
      const p = (e.payload as any);
      if (p.scope !== 'semantic' && p.scope !== 'skill') continue;
      if (p.value === undefined) { byKey.delete(p.key); continue; }  // tombstone
      byKey.set(p.key, { key: p.key, value: p.value, scope: p.scope, ...(p.tags ? { tags: p.tags } : {}) });
      seqOrder.push(p.key);
    }
    let matches = [...byKey.values()].filter(entry => {
      const tagHit = opts?.tags ? (entry.tags ?? []).some(t => opts.tags!.includes(t)) : false;
      const kwHit = keywords.some(kw => stringify(entry.value).toLowerCase().includes(kw));
      return tagHit || kwHit;
    });
    // Recency: order by last-write seq descending. We approximate by re-sorting entries
    // according to the seqOrder (last occurrence per key).
    const lastSeq = new Map<string, number>();
    seqOrder.forEach((k, i) => lastSeq.set(k, i));
    matches.sort((a, b) => (lastSeq.get(b.key) ?? 0) - (lastSeq.get(a.key) ?? 0));
    matches = matches.slice(0, limit);

    await this.recorder.record({
      span_id: 'memory', parent_span_id: null, type: 'memory.recalled', verb: 'response', attempt: 1, duration_ms: 0,
      payload: { action: 'recall', query, scope: 'semantic', hits: matches.map(m => ({ key: m.key })) },
    });
    return matches;
  }

  async forget(key: string, scope: MemoryScope): Promise<void> {
    const target = scope === 'working' ? this.recorder : this.longRecorder;
    await this.store.write(target, { key, value: undefined, scope });
  }
}
```

`packages/memory/src/prompt.ts`:
```ts
import type { MemoryEntry } from './store';

function stringify(v: unknown): string {
  return typeof v === 'string' ? v : JSON.stringify(v);
}

export function memoryToSystemPrompt(memories: MemoryEntry[]): string {
  if (memories.length === 0) return '';
  const lines = memories.map(m => {
    if (m.scope === 'skill') {
      const v = m.value as { name?: string; description?: string } | undefined;
      return `- [skill] ${v?.name ?? m.key}: ${v?.description ?? ''}`;
    }
    return `- [${m.scope}] ${m.key}: ${stringify(m.value)}`;
  });
  return `\n## 记忆\n${lines.join('\n')}`;
}
```

`packages/memory/src/index.ts` (add):
```ts
export * from './events';
export * from './store';
export * from './memory';
export * from './prompt';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -F @veridical/memory test`
Expected: PASS (memory tests + prompt tests).

- [ ] **Step 5: Commit**

```bash
git add packages/memory
git commit -m "feat: memory facade with recall and prompt builder"
```

---

### Task 3: runSpec memory hook + default step injection

**Files:**
- Modify: `packages/spec/src/runner.ts` (add `memory?: MemoryLike` to `SpecRunnerDeps`, inject into default step)
- Modify: `packages/memory/src/index.ts` (add a `MemoryLike`-compatible helper if needed)
- Test: `packages/memory/test/runSpec.test.ts`

**Interfaces:**
- Consumes: `SpecRunnerDeps`/`runSpec`/`RunResult` (`@veridical/spec`); `Memory` (`@veridical/memory`); `memoryToSystemPrompt` (`@veridical/memory`).
- Produces:
  - `@veridical/spec`: `interface MemoryLike { recall(query: string, opts?: { tags?: string[]; limit?: number }): Promise<{ key: string; value: unknown; scope: string; tags?: string[] }[]>; onStep?: (step: number, ctx: { prompt: string }) => Promise<void> }` added to `SpecRunnerDeps` as `memory?: MemoryLike`.
  - In `runSpec`'s `defaultRunStep`, when `deps.memory` is provided: `const recalled = await deps.memory.recall(prompt)` (catch → treat as empty); if non-empty, the system message = `spec.instruction.system + memoryToSystemPrompt(recalled)`; if `deps.memory.onStep` provided, call it each step.
  - `@veridical/memory`: `Memory` satisfies `MemoryLike` structurally (its `recall` returns `MemoryEntry[]` which is assignable to the `MemoryLike.recall` return shape).

- [ ] **Step 1: Write the failing test**

```ts
// packages/memory/test/runSpec.test.ts
import { describe, it, expect } from 'vitest';
import { InMemoryTraceStore } from '@veridical/store';
import { Session, Recorder } from '@veridical/runtime';
import { MockProvider, fingerprint } from '@veridical/llm';
import { InMemorySpecRegistry, parseSpecYaml, runSpec } from '@veridical/spec';
import { Memory, MemoryStore } from '../src/index';

const SPEC = `
name: mem-test
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

function providerFor(prompt: string, withMemory: boolean): MockProvider {
  const p = new MockProvider();
  const system = withMemory ? 'You are a test agent.\n## 记忆\n- [semantic] policy: P12345' : 'You are a test agent.';
  p.record(fingerprint({ provider: 'mock', model: 'm', messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }] }), 'answer', { input: 1, output: 1, cached: 0, total: 2 });
  return p;
}

describe('runSpec with memory hook', () => {
  it('injects recalled memory into the system message when present', async () => {
    const store = new InMemoryTraceStore();
    const spec = parseSpecYaml(SPEC);
    const registry = new InMemorySpecRegistry();
    await registry.register(spec);

    const session = new Session({ session_id: 's1', tenant_id: 't1', spec_version: '1.0.0' });
    const longSession = new Session({ session_id: '_memory', tenant_id: 't1', spec_version: '1.0.0' });
    const memory = new Memory(new MemoryStore(), 's1', new Recorder(store, session), new Recorder(store, longSession));
    await memory.rememberSemantic('policy', 'P12345', ['claim']);

    const mock = providerFor('hello claim', true);
    const result = await runSpec(
      { store, providers: new Map([['mock', mock]]), tools: [], tenant_id: 't1', session_id: 's1', memory },
      spec,
      'hello claim',
    );
    expect(result.outcome).toBe('answer');
    // The memory.recalled event was recorded during the run
    const types = (await store.readBySession('s1')).map(e => e.type);
    expect(types).toContain('memory.recalled');
  });

  it('degrades to no memory when recall throws', async () => {
    const store = new InMemoryTraceStore();
    const spec = parseSpecYaml(SPEC);
    const registry = new InMemorySpecRegistry();
    await registry.register(spec);
    const mock = providerFor('hello', false);
    const badMemory = {
      recall: async () => { throw new Error('memory down'); },
    };
    const result = await runSpec(
      { store, providers: new Map([['mock', mock]]), tools: [], tenant_id: 't1', session_id: 's1', memory: badMemory },
      spec,
      'hello',
    );
    expect(result.outcome).toBe('answer');
  });

  it('calls onStep each loop step', async () => {
    const store = new InMemoryTraceStore();
    const spec = parseSpecYaml(SPEC);
    const registry = new InMemorySpecRegistry();
    await registry.register(spec);
    const mock = providerFor('hello', false);
    const steps: number[] = [];
    const memory = { recall: async () => [], onStep: async (s: number) => { steps.push(s); } };
    await runSpec(
      { store, providers: new Map([['mock', mock]]), tools: [], tenant_id: 't1', session_id: 's1', memory },
      spec,
      'hello',
    );
    expect(steps.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm install && pnpm -F @veridical/spec test && pnpm -F @veridical/memory test`
Expected: FAIL — `memory` not on `SpecRunnerDeps` / injection not implemented.

- [ ] **Step 3: Write minimal implementation**

`packages/spec/src/runner.ts` — modify:

Add to `SpecRunnerDeps`:
```ts
export interface MemoryLike {
  recall(query: string, opts?: { tags?: string[]; limit?: number }): Promise<{ key: string; value: unknown; scope: string; tags?: string[] }[]>;
  onStep?: (step: number, ctx: { prompt: string }) => Promise<void>;
}
```
and `memory?: MemoryLike;` to `SpecRunnerDeps`.

Replace `requestFor` with a memory-aware version and update `defaultRunStep`:
```ts
async function buildRequest(spec: AgentSpec, prompt: string, memory?: MemoryLike): Promise<LLMRequest> {
  let system = spec.instruction.system;
  if (memory) {
    try {
      const recalled = await memory.recall(prompt);
      if (recalled.length > 0) {
        system = system + memorySystemBlock(recalled);
      }
    } catch {
      // memory is augmentation; degrade to no-memory
    }
  }
  return { provider: spec.llm.provider, model: spec.llm.model, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }] };
}

function memorySystemBlock(recalled: { key: string; value: unknown; scope: string; tags?: string[] }[]): string {
  const lines = recalled.map(m => {
    const v = typeof m.value === 'string' ? m.value : JSON.stringify(m.value);
    return `- [${m.scope}] ${m.key}: ${v}`;
  });
  return `\n## 记忆\n${lines.join('\n')}`;
}
```

In `defaultRunStep`, use `buildRequest`:
```ts
  const defaultRunStep = async ({ llm, spec, recorder, prompt }: RunnerStepCtx) => {
    const req = await buildRequest(spec, prompt, deps.memory);
    const res = await completeWithFallback(llm, deps.providers, spec, req, recorder);
    return { text: res.text };
  };
```

And in the `runStep` wrapper, call `onStep` (the `FlowContext` doesn't thread the step number through `runStep`, so the hook receives a running counter captured in `runSpec`'s closure):
```ts
  let stepCount = 0;
  const ctx: FlowContext = {
    ...
    runStep: async (p) => {
      stepCount += 1;
      if (deps.memory?.onStep) await deps.memory.onStep(stepCount, { prompt: p });
      return stepRun({ llm, spec, recorder, prompt: p });
    },
    ...
  };
```
This threads the actual step number (1-based) via a closure counter — no `FlowContext` change needed.

`packages/memory/src/index.ts` — no change needed (`Memory.recall` returns `MemoryEntry[]`, structurally assignable to `MemoryLike.recall`'s return).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm install && pnpm -F @veridical/spec test && pnpm -F @veridical/memory test`
Expected: PASS (spec 26 + memory tests including runSpec).

- [ ] **Step 5: Commit**

```bash
git add packages/spec packages/memory
git commit -m "feat: runSpec memory hook with default step injection"
```

---

### Task 4: Demo — memory-driven run

**Files:**
- Create: `packages/demo/src/memory-demo.ts`
- Create: `packages/demo/test/memory-smoke.test.ts`
- Modify: `packages/demo/package.json` (add `@veridical/memory` dep)

**Interfaces:**
- Consumes: `parseSpecYaml`/`InMemorySpecRegistry`/`runSpec` (`@veridical/spec`); `MockProvider`/`fingerprint` (`@veridical/llm`); `JsonlTraceStore` (`@veridical/store`); `Session`/`Recorder` (`@veridical/runtime`); `Memory`/`MemoryStore` (`@veridical/memory`).
- Produces:
  - `function runMemoryDemo(dir: string): Promise<{ store: JsonlTraceStore; outcome: unknown }>` — writes a semantic memory, runs a memory-aware spec (recall injects into system), persists to JSONL.

- [ ] **Step 1: Write the failing test**

```ts
// packages/demo/test/memory-smoke.test.ts
import { describe, it, expect } from 'vitest';
import { runMemoryDemo } from '../src/memory-demo';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('memory-driven demo', () => {
  it('runs a memory-aware agent and records memory events', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rt-mem-'));
    const { store, outcome } = await runMemoryDemo(dir);
    expect(outcome).toBeDefined();
    const events = await store.readBySession('s1');
    const types = events.map(e => e.type);
    for (const t of ['memory.write', 'memory.recalled']) {
      expect(types).toContain(t);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm install && pnpm -F @veridical/demo test`
Expected: FAIL — `runMemoryDemo` not exported / `@veridical/memory` not found.

- [ ] **Step 3: Write minimal implementation**

`packages/demo/package.json` — add `"@veridical/memory": "workspace:*"` to `dependencies`.

`packages/demo/src/memory-demo.ts`:
```ts
import { JsonlTraceStore } from '@veridical/store';
import { Session, Recorder } from '@veridical/runtime';
import { InMemorySpecRegistry, parseSpecYaml, runSpec } from '@veridical/spec';
import { MockProvider, fingerprint } from '@veridical/llm';
import { Memory, MemoryStore } from '@veridical/memory';

const SPEC = `
name: memory-demo
version: 1.0.0
schema_version: 1
instruction:
  system: You are a claim assistant.
flow:
  mode: single-loop
  max_steps: 2
llm:
  provider: mock
  model: m
  fallback: []
tools: []
`;

export async function runMemoryDemo(dir: string) {
  const store = new JsonlTraceStore(dir);

  const spec = parseSpecYaml(SPEC);
  const registry = new InMemorySpecRegistry();
  await registry.register(spec);

  const session = new Session({ session_id: 's1', tenant_id: 't1', spec_version: '1.0.0' });
  const longSession = new Session({ session_id: '_memory', tenant_id: 't1', spec_version: '1.0.0' });
  const memory = new Memory(new MemoryStore(), 's1', new Recorder(store, session), new Recorder(store, longSession));
  await memory.rememberSemantic('policy', 'P12345', ['claim']);

  const mock = new MockProvider();
  const sys = 'You are a claim assistant.\n## 记忆\n- [semantic] policy: P12345';
  const fp = (p: string) => fingerprint({ provider: 'mock', model: 'm', messages: [{ role: 'system', content: sys }, { role: 'user', content: p }] });
  mock.record(fp('hello claim'), 'answer', { input: 1, output: 1, cached: 0, total: 2 });

  const result = await runSpec(
    { store, providers: new Map([['mock', mock]]), tools: [], tenant_id: 't1', session_id: 's1', memory },
    spec,
    'hello claim',
  );
  return { store, outcome: result.outcome };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm install && pnpm -F @veridical/demo test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/demo pnpm-lock.yaml
git commit -m "feat: memory-driven demo"
```

---

### Task 5: Full suite + acceptance verification

**Files:**
- None (verification only).

**Interfaces:**
- Consumes: all packages.

- [ ] **Step 1: Run the entire test suite**

Run: `pnpm test`
Expected: all packages PASS (schema, store, runtime, tools, llm, spec, eval, replay, memory, demo).

- [ ] **Step 2: Run the strict build**

Run: `pnpm build`
Expected: all packages compile clean under `"strict": true`.

- [ ] **Step 3: Verify acceptance criterion — event-driven memory**

`store.test.ts` + `memory.test.ts` assert `memory.write`/`read`/`recalled` events land in the store and snapshot reconstructs state (last-write-wins, tags, scopes, `_memory` shared session).

- [ ] **Step 4: Verify acceptance criterion — deterministic recall**

`memory.test.ts` asserts tag match + keyword contains + recency sort + limit (no external vector DB).

- [ ] **Step 5: Verify acceptance criterion — runSpec injection**

`runSpec.test.ts` asserts recalled memory injected into the system message, `memory.recalled` events recorded, and recall-failure degradation.

- [ ] **Step 6: Commit (if any fixes were needed)**

```bash
git add -A
git commit -m "test: verify Phase 5 acceptance criteria"
```
