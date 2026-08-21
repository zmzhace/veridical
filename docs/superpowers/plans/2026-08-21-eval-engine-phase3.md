# Eval Engine (Phase 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the evaluation engine — rules/golden + LLM-judge + turn-based scenario simulator — that judges a completed agent run from its trace, with the runtime verify path sharing the same rule engine ("one yardstick").

**Architecture:** New package `@veridical/eval` layered on the Phase 1/2 packages (`schema`/`store`/`runtime`/`llm`/`spec`). Rule core: `Rule` = `(events: TraceEvent[]) => Verdict`, built-in rule factories, `RuleEngine`. Offline: `evaluateRun(result, config)` consuming `RunResult.events`; `LLMJudge` scores a trace against a natural-language rubric. Runtime integration: `verifyFromRules(rules)` returns `(events) => boolean`; `@veridical/spec`'s `SpecRunnerDeps` gains a single optional `verify?: (events: TraceEvent[]) => boolean` hook that `runSpec` uses in place of the current `verifyToolResult: () => true`. Scenario: `Scenario`/`ScenarioStep` (serializable rule decls) + `Simulator` driving `runSpec` turn-by-turn with per-turn `evaluateRun`.

**Tech Stack:** TypeScript (strict), pnpm workspaces, vitest, zod, `yaml` (parsing), node:fs/node:crypto.

## Global Constraints

- TypeScript strict mode throughout (`"strict": true`).
- Monorepo via pnpm workspaces under `packages/*`.
- Testing with vitest; every feature task uses TDD (write failing test → run → implement → run pass).
- No code comments unless they explain non-obvious logic.
- Node-API packages need `@types/node` + tsconfig `types: ["vitest/globals", "node"]`.
- New package name: `@veridical/eval` (version 0.0.1, `type: module`, `main: src/index.ts`).
- Runtime deps: `yaml` (scenario parsing). zod is available transitively but must be declared if imported directly.
- **Dependency direction is strictly `@veridical/eval` → `@veridical/spec` one-way.** `@veridical/spec` must NOT import from `@veridical/eval`. The `verify` hook on `SpecRunnerDeps` is typed as a plain function `(events: TraceEvent[]) => boolean` so spec stays eval-free.
- `@veridical/spec` change is minimal: add `verify?: (events: TraceEvent[]) => boolean` to `SpecRunnerDeps`, and use it in `runSpec` when provided.
- Runtime verify failures reuse the existing single-loop failure path (`tool.result` verb:error `blocked:true` + continue/retry).
- `LLMJudge` requires the LLM to return JSON `{ passed: boolean, reasoning: string }`; parse failure throws `JudgeParseError` (never a silent pass).
- `Simulator` throws `ScenarioError` on unresolved spec; a `runSpec` `SpecRunError` in any turn propagates (no `continue_on_error` in Phase 3).
- Commit after every task with a conventional message.

---

### Task 1: `@veridical/eval` scaffold + Rule core (types + built-in rules + RuleEngine)

**Files:**
- Create: `packages/eval/package.json`
- Create: `packages/eval/tsconfig.json`
- Create: `packages/eval/src/index.ts`
- Create: `packages/eval/src/rules.ts`
- Create: `packages/eval/src/engine.ts`
- Test: `packages/eval/test/rules.test.ts`

**Interfaces:**
- Consumes: `TraceEvent` (`@veridical/schema`).
- Produces:
  - `interface Verdict { passed: boolean; detail?: string }`
  - `interface Rule { name: string; check(events: TraceEvent[]): Verdict }`
  - Rule factories: `ruleOutcomeEquals(value: unknown): Rule`, `ruleTextContains(substring: string, role?: 'assistant' | 'user'): Rule`, `ruleToolCalled(name: string): Rule`, `ruleToolNotDenied(name: string): Rule`, `ruleNoErrors(): Rule`
  - `interface RuleReport { rules: { name: string; passed: boolean; detail?: string }[]; passed: boolean }`
  - `class RuleEngine { constructor(rules: Rule[]); evaluate(events: TraceEvent[]): RuleReport }` — `passed` is all-rules-pass (AND).

- [ ] **Step 1: Write the failing test**

```ts
// packages/eval/test/rules.test.ts
import { describe, it, expect } from 'vitest';
import {
  ruleOutcomeEquals, ruleTextContains, ruleToolCalled, ruleToolNotDenied, ruleNoErrors,
  RuleEngine, type TraceEvent,
} from '../src/index';

function evt(seq: number, type: string, verb: string, payload: any): TraceEvent {
  return { id: `e${seq}`, tenant_id: 't1', session_id: 's1', span_id: 'sp', parent_span_id: null, seq, type, verb, attempt: 1, duration_ms: 1, payload, spec_version: '0.0.1' };
}

function run(events: TraceEvent[]) {
  return [
    evt(1, 'turn/start', 'request', {}),
    ...events,
    evt(99, 'turn/end', 'response', { outcome: 'done' }),
  ];
}

describe('built-in rules', () => {
  it('ruleOutcomeEquals passes when turn/end outcome matches', () => {
    expect(ruleOutcomeEquals('done').check(run([]))).toEqual({ passed: true });
  });

  it('ruleOutcomeEquals fails on mismatch', () => {
    expect(ruleOutcomeEquals('nope').check(run([]))).toEqual({ passed: false });
  });

  it('ruleTextContains matches assistant text', () => {
    const evts = run([evt(2, 'assistant.message', 'response', { text: '您的保单号已收到' })]);
    expect(ruleTextContains('保单号').check(evts)).toEqual({ passed: true });
    expect(ruleTextContains('不存在的词').check(evts)).toEqual({ passed: false });
  });

  it('ruleToolCalled matches a tool.called event', () => {
    const evts = run([evt(2, 'tool.called', 'request', { name: 'lookup_policy', args: {} })]);
    expect(ruleToolCalled('lookup_policy').check(evts)).toEqual({ passed: true });
    expect(ruleToolCalled('other').check(evts)).toEqual({ passed: false });
  });

  it('ruleToolNotDenied passes when tool never denied', () => {
    const evts = run([evt(2, 'tool.result', 'response', { name: 'lookup_policy', result: 'ok' })]);
    expect(ruleToolNotDenied('lookup_policy').check(evts)).toEqual({ passed: true });
  });

  it('ruleToolNotDenied fails when tool was denied', () => {
    const evts = run([evt(2, 'tool.result', 'response', { name: 'lookup_policy', result: { ok: false, reason: 'denied' } })]);
    expect(ruleToolNotDenied('lookup_policy').check(evts)).toEqual({ passed: false });
  });

  it('ruleNoErrors passes on clean run and fails on an error event', () => {
    expect(ruleNoErrors().check(run([]))).toEqual({ passed: true });
    const bad = run([evt(2, 'llm.response', 'error', { message: 'boom' })]);
    expect(ruleNoErrors().check(bad)).toEqual({ passed: false });
  });
});

describe('RuleEngine', () => {
  it('passes when all rules pass', () => {
    const engine = new RuleEngine([ruleOutcomeEquals('done'), ruleNoErrors()]);
    expect(engine.evaluate(run([])).passed).toBe(true);
  });

  it('fails when any rule fails and reports which', () => {
    const engine = new RuleEngine([ruleOutcomeEquals('wrong'), ruleNoErrors()]);
    const report = engine.evaluate(run([]));
    expect(report.passed).toBe(false);
    expect(report.rules.find(r => r.name === 'outcome_equals')?.passed).toBe(false);
  });

  it('passes vacuously with no rules', () => {
    expect(new RuleEngine([]).evaluate(run([])).passed).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm install && pnpm -F @veridical/eval test`
Expected: FAIL — `@veridical/eval` package not found / `ruleOutcomeEquals` not exported.

- [ ] **Step 3: Write minimal implementation**

`packages/eval/package.json`:
```json
{
  "name": "@veridical/eval",
  "version": "0.0.1",
  "type": "module",
  "main": "src/index.ts",
  "dependencies": {
    "@veridical/schema": "workspace:*",
    "yaml": "^2.4.2"
  },
  "devDependencies": {
    "@types/node": "^26.2.0",
    "typescript": "^5.0.0",
    "vitest": "^3.0.0"
  },
  "scripts": { "build": "tsc -p tsconfig.json", "test": "vitest run" }
}
```

`packages/eval/tsconfig.json`:
```json
{ "extends": "../../tsconfig.base.json", "compilerOptions": { "outDir": "dist", "types": ["vitest/globals", "node"] }, "include": ["src"] }
```

`packages/eval/src/rules.ts`:
```ts
import type { TraceEvent } from '@veridical/schema';

export interface Verdict {
  passed: boolean;
  detail?: string;
}

export interface Rule {
  name: string;
  check(events: TraceEvent[]): Verdict;
}

const payloadOf = (e: TraceEvent) => e.payload as any;

export function ruleOutcomeEquals(value: unknown): Rule {
  return {
    name: 'outcome_equals',
    check(events) {
      const end = [...events].reverse().find(e => e.type === 'turn/end');
      const outcome = end ? payloadOf(end).outcome : undefined;
      return { passed: JSON.stringify(outcome) === JSON.stringify(value) };
    },
  };
}

export function ruleTextContains(substring: string, role: 'assistant' | 'user' = 'assistant'): Rule {
  const types = role === 'user' ? ['user.message'] : ['assistant.message'];
  return {
    name: 'text_contains',
    check(events) {
      const hit = events.some(e => types.includes(e.type) && String(payloadOf(e).text ?? '').includes(substring));
      return hit ? { passed: true } : { passed: false, detail: `no ${role}.message contains "${substring}"` };
    },
  };
}

export function ruleToolCalled(name: string): Rule {
  return {
    name: 'tool_called',
    check(events) {
      const hit = events.some(e => e.type === 'tool.called' && payloadOf(e).name === name);
      return hit ? { passed: true } : { passed: false, detail: `tool ${name} not called` };
    },
  };
}

export function ruleToolNotDenied(name: string): Rule {
  return {
    name: 'tool_not_denied',
    check(events) {
      const denied = events.some(e => e.type === 'tool.result' && payloadOf(e).name === name && payloadOf(e).result?.reason === 'denied');
      return denied ? { passed: false, detail: `tool ${name} was denied` } : { passed: true };
    },
  };
}

export function ruleNoErrors(): Rule {
  return {
    name: 'no_errors',
    check(events) {
      const err = events.find(e => (e.type === 'llm.response' || e.type === 'tool.result' || e.type === 'spec/run/end') && e.verb === 'error');
      return err ? { passed: false, detail: `${err.type} verb:error at seq ${err.seq}` } : { passed: true };
    },
  };
}
```

`packages/eval/src/engine.ts`:
```ts
import type { Rule } from './rules';

export interface RuleReport {
  rules: { name: string; passed: boolean; detail?: string }[];
  passed: boolean;
}

export class RuleEngine {
  constructor(private rules: Rule[]) {}

  evaluate(events: Parameters<Rule['check']>[0]): RuleReport {
    const results = this.rules.map(r => ({ name: r.name, ...r.check(events) }));
    return { rules: results, passed: results.every(r => r.passed) };
  }
}
```

`packages/eval/src/index.ts`:
```ts
export * from './rules';
export * from './engine';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm install && pnpm -F @veridical/eval test`
Expected: PASS (all 13 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/eval pnpm-lock.yaml
git commit -m "feat: rule core with built-in rules and engine"
```

---

### Task 2: `evaluateRun` (offline evaluation) + `LLMJudge`

**Files:**
- Create: `packages/eval/src/evaluate.ts`
- Create: `packages/eval/src/judge.ts`
- Modify: `packages/eval/src/index.ts` (add exports)
- Modify: `packages/eval/package.json` (add `@veridical/runtime` + `@veridical/llm` + `@veridical/spec` deps)
- Test: `packages/eval/test/evaluate.test.ts`
- Test: `packages/eval/test/judge.test.ts`

**Interfaces:**
- Consumes: `Rule`/`RuleEngine` (Task 1); `RunResult` (`@veridical/spec`); `LLMGateway`/`LLMProvider`/`LLMRequest`/`LLMResponse`/`LLMUsage` (`@veridical/llm`); `TraceEvent` (`@veridical/schema`).
- Produces:
  - `interface LLMJudgeConfig { provider: string; model: string; rubric: string }`
  - `interface EvalConfig { rules?: Rule[]; golden?: unknown; judge?: LLMJudgeConfig; pass_requirement?: 'all' | 'any' }`
  - `interface EvalReport { rules?: RuleReport; judge?: { passed: boolean; reasoning: string; tokens: LLMUsage }; passed: boolean }`
  - `function evaluateRun(result: RunResult, config: EvalConfig, judge?: LLMJudge): Promise<EvalReport>` — `golden` is sugar for `ruleOutcomeEquals(golden)`; `judge` runs only if both config.judge and an `LLMJudge` instance are provided; overall `passed` = rules AND judge (pass_requirement applies to rule aggregation).
  - `class JudgeParseError extends Error`
  - `class LLMJudge { constructor(llm: LLMGateway, provider: string, model: string, store: TraceStore); judge(run: RunResult, rubric: string): Promise<{ passed: boolean; reasoning: string; tokens: LLMUsage }> }` — builds a transcript from `RunResult.events`, asks the LLM for JSON `{ passed, reasoning }`, parses it; parse failure throws `JudgeParseError`. The judge constructs its own `Session`/`Recorder` over `store` so its LLM calls are evented (trace invariant — "model-visible means logged").

- [ ] **Step 1: Write the failing test**

```ts
// packages/eval/test/evaluate.test.ts
import { describe, it, expect } from 'vitest';
import { LLMGateway } from '@veridical/llm';
import { InMemoryTraceStore } from '@veridical/store';
import type { TraceEvent } from '@veridical/schema';
import { evaluateRun, ruleOutcomeEquals, ruleNoErrors, type RunResult } from '../src/index';

function evt(seq: number, type: string, verb: string, payload: any): TraceEvent {
  return { id: `e${seq}`, tenant_id: 't1', session_id: 's1', span_id: 'sp', parent_span_id: null, seq, type, verb, attempt: 1, duration_ms: 1, payload, spec_version: '0.0.1' };
}

function result(outcome: unknown, extra: TraceEvent[] = []): RunResult {
  const events: TraceEvent[] = [
    evt(1, 'turn/start', 'request', {}),
    ...extra,
    evt(99, 'turn/end', 'response', { outcome }),
  ];
  return { session_id: 's1', spec_name: 'n', spec_version: '1.0.0', outcome, events };
}

describe('evaluateRun', () => {
  it('passes when all rules pass', async () => {
    const report = await evaluateRun(result('done'), { rules: [ruleOutcomeEquals('done')] });
    expect(report.passed).toBe(true);
    expect(report.rules?.passed).toBe(true);
  });

  it('fails when a rule fails', async () => {
    const report = await evaluateRun(result('wrong'), { rules: [ruleOutcomeEquals('done')] });
    expect(report.passed).toBe(false);
  });

  it('treats golden as ruleOutcomeEquals sugar', async () => {
    const report = await evaluateRun(result('done'), { golden: 'done' });
    expect(report.passed).toBe(true);
  });

  it('supports pass_requirement any', async () => {
    const report = await evaluateRun(result('wrong'), { rules: [ruleOutcomeEquals('done'), ruleNoErrors()], pass_requirement: 'any' });
    expect(report.passed).toBe(true);
  });

  it('combines rules and judge', async () => {
    const provider: import('@veridical/llm').LLMProvider = {
      complete: async () => ({ text: JSON.stringify({ passed: true, reasoning: 'looks good' }), usage: { input: 1, output: 1, cached: 0, total: 2 } }),
    };
    const gw = new LLMGateway(new Map([['j', provider]]));
    const judge = new (await import('../src/judge')).LLMJudge(gw, 'j', 'j', new InMemoryTraceStore());
    const report = await evaluateRun(result('done'), { judge: { provider: 'j', model: 'j', rubric: 'r' } }, judge);
    expect(report.passed).toBe(true);
    expect(report.judge?.reasoning).toBe('looks good');
  });

  it('judge failure makes the report fail when judge provided', async () => {
    const provider: import('@veridical/llm').LLMProvider = {
      complete: async () => ({ text: JSON.stringify({ passed: false, reasoning: 'bad' }), usage: { input: 1, output: 1, cached: 0, total: 2 } }),
    };
    const gw = new LLMGateway(new Map([['j', provider]]));
    const judge = new (await import('../src/judge')).LLMJudge(gw, 'j', 'j', new InMemoryTraceStore());
    const report = await evaluateRun(result('done'), { judge: { provider: 'j', model: 'j', rubric: 'r' } }, judge);
    expect(report.passed).toBe(false);
  });
});
```

```ts
// packages/eval/test/judge.test.ts
import { describe, it, expect } from 'vitest';
import { LLMGateway } from '@veridical/llm';
import type { LLMProvider } from '@veridical/llm';
import { InMemoryTraceStore } from '@veridical/store';
import type { TraceEvent } from '@veridical/schema';
import { LLMJudge, JudgeParseError, type RunResult } from '../src/index';

const usage = { input: 1, output: 1, cached: 0, total: 2 };

function result(events: TraceEvent[]): RunResult {
  return { session_id: 's1', spec_name: 'n', spec_version: '1.0.0', outcome: undefined, events };
}

function evt(seq: number, type: string, verb: string, payload: any): TraceEvent {
  return { id: `e${seq}`, tenant_id: 't1', session_id: 's1', span_id: 'sp', parent_span_id: null, seq, type, verb, attempt: 1, duration_ms: 1, payload, spec_version: '0.0.1' };
}

function judgeWith(text: string): LLMJudge {
  const provider: LLMProvider = { complete: async () => ({ text, usage }) };
  return new LLMJudge(new LLMGateway(new Map([['j', provider]])), 'j', 'j', new InMemoryTraceStore());
}

describe('LLMJudge', () => {
  const run = result([
    evt(1, 'user.message', 'request', { text: 'hello' }),
    evt(2, 'assistant.message', 'response', { text: 'hi there' }),
  ]);

  it('parses a valid JSON verdict', async () => {
    const j = judgeWith(JSON.stringify({ passed: true, reasoning: 'good' }));
    const v = await j.judge(run, 'rubric');
    expect(v.passed).toBe(true);
    expect(v.reasoning).toBe('good');
    expect(v.tokens).toEqual(usage);
  });

  it('throws JudgeParseError on invalid JSON', async () => {
    const j = judgeWith('not json at all');
    await expect(j.judge(run, 'rubric')).rejects.toThrow(JudgeParseError);
  });

  it('throws JudgeParseError on missing passed field', async () => {
    const j = judgeWith(JSON.stringify({ reasoning: 'no passed' }));
    await expect(j.judge(run, 'rubric')).rejects.toThrow(JudgeParseError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm install && pnpm -F @veridical/eval test`
Expected: FAIL — `evaluateRun` / `LLMJudge` / `JudgeParseError` not exported.

- [ ] **Step 3: Write minimal implementation**

`packages/eval/package.json` — add deps:
```json
{
  "name": "@veridical/eval",
  "version": "0.0.1",
  "type": "module",
  "main": "src/index.ts",
  "dependencies": {
    "@veridical/schema": "workspace:*",
    "@veridical/store": "workspace:*",
    "@veridical/runtime": "workspace:*",
    "@veridical/llm": "workspace:*",
    "@veridical/spec": "workspace:*",
    "yaml": "^2.4.2"
  },
  "devDependencies": {
    "@types/node": "^26.2.0",
    "typescript": "^5.0.0",
    "vitest": "^3.0.0"
  },
  "scripts": { "build": "tsc -p tsconfig.json", "test": "vitest run" }
}
```

`packages/eval/src/judge.ts`:
```ts
import type { TraceEvent } from '@veridical/schema';
import type { TraceStore } from '@veridical/store';
import { Session, Recorder } from '@veridical/runtime';
import type { LLMGateway, LLMUsage } from '@veridical/llm';
import type { RunResult } from '@veridical/spec';

export class JudgeParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JudgeParseError';
  }
}

function transcriptOf(events: TraceEvent[]): string {
  return events
    .filter(e => ['user.message', 'assistant.message', 'tool.called', 'tool.result'].includes(e.type))
    .map(e => {
      const p = e.payload as any;
      switch (e.type) {
        case 'user.message': return `user: ${p.text}`;
        case 'assistant.message': return `assistant: ${p.text}`;
        case 'tool.called': return `tool_called: ${p.name}(${JSON.stringify(p.args)})`;
        default: return `tool_result: ${JSON.stringify(p.result)}`;
      }
    })
    .join('\n');
}

export class LLMJudge {
  constructor(private llm: LLMGateway, private provider: string, private model: string, private store: TraceStore) {}

  async judge(run: RunResult, rubric: string): Promise<{ passed: boolean; reasoning: string; tokens: LLMUsage }> {
    const session = new Session({ session_id: `judge_${run.session_id}`, tenant_id: 't1', spec_version: run.spec_version });
    const recorder = new Recorder(this.store, session);
    const req = {
      provider: this.provider,
      model: this.model,
      messages: [
        { role: 'system', content: 'You are a rigorous evaluator. Judge the agent run against the rubric. Respond with JSON only: {"passed": boolean, "reasoning": string}.' },
        { role: 'user', content: `Rubric:\n${rubric}\n\nTranscript:\n${transcriptOf(run.events)}` },
      ],
    };
    const res = await this.llm.complete(req, recorder);
    const parsed = this.parseVerdict(res.text);
    return { ...parsed, tokens: res.usage };
  }

  private parseVerdict(text: string): { passed: boolean; reasoning: string } {
    try {
      const obj = JSON.parse(text);
      if (typeof obj.passed !== 'boolean' || typeof obj.reasoning !== 'string') {
        throw new Error('missing passed or reasoning');
      }
      return { passed: obj.passed, reasoning: obj.reasoning };
    } catch (err) {
      throw new JudgeParseError(`could not parse judge verdict: ${text}`);
    }
  }
}
```

`packages/eval/src/evaluate.ts`:
```ts
import { ruleOutcomeEquals, type Rule, type RuleReport } from './rules';
import { RuleEngine } from './engine';
import type { RunResult } from '@veridical/spec';
import type { LLMUsage } from '@veridical/llm';
import type { LLMJudge } from './judge';

export interface LLMJudgeConfig { provider: string; model: string; rubric: string }
export interface EvalConfig {
  rules?: Rule[];
  golden?: unknown;
  judge?: LLMJudgeConfig;
  pass_requirement?: 'all' | 'any';
}
export interface EvalReport {
  rules?: RuleReport;
  judge?: { passed: boolean; reasoning: string; tokens: LLMUsage };
  passed: boolean;
}

export async function evaluateRun(result: RunResult, config: EvalConfig, judge?: LLMJudge): Promise<EvalReport> {
  const rules = [...(config.rules ?? []), ...(config.golden !== undefined ? [ruleOutcomeEquals(config.golden)] : [])];
  const rulesReport = rules.length > 0 ? new RuleEngine(rules).evaluate(result.events) : undefined;

  let judgeReport: EvalReport['judge'];
  if (config.judge && judge) {
    const v = await judge.judge(result, config.judge.rubric);
    judgeReport = { passed: v.passed, reasoning: v.reasoning, tokens: v.tokens };
  }

  const rulePassed = rulesReport ? (config.pass_requirement === 'any' ? rulesReport.rules.some(r => r.passed) : rulesReport.passed) : true;
  const passed = rulePassed && (judgeReport ? judgeReport.passed : true);

  return { rules: rulesReport, judge: judgeReport, passed };
}
```

`packages/eval/src/index.ts` (add):
```ts
export * from './rules';
export * from './engine';
export * from './evaluate';
export * from './judge';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm install && pnpm -F @veridical/eval test`
Expected: PASS (all tests in both files).

- [ ] **Step 5: Commit**

```bash
git add packages/eval pnpm-lock.yaml
git commit -m "feat: offline evaluation with rules and LLM judge"
```

---

### Task 3: Runtime verify integration — `verifyFromRules` + `runSpec` `verify` hook

**Files:**
- Create: `packages/eval/src/verify.ts`
- Modify: `packages/eval/src/index.ts` (add export)
- Modify: `packages/spec/src/runner.ts` (add `verify` hook to `SpecRunnerDeps` + use it in `runSpec`)
- Test: `packages/eval/test/verify.test.ts`

**Interfaces:**
- Consumes: `Rule`/`RuleEngine` (Task 1); `runSpec`/`SpecRunnerDeps`/`SpecRunError` (`@veridical/spec`); `TraceEvent` (`@veridical/schema`); `InMemoryTraceStore` (`@veridical/store`).
- Produces:
  - `function verifyFromRules(rules: Rule[]): (events: TraceEvent[]) => boolean` — returns `(events) => new RuleEngine(rules).evaluate(events).passed`.
  - `@veridical/spec` change: `SpecRunnerDeps` gains `verify?: (events: TraceEvent[]) => boolean`. In `runSpec`, when `verify` is provided, `ctx.verifyToolResult` becomes a function that snapshots the current `tool.result` event (the latest event written by the broker call, via `readBySession`) plus all prior events, feeds them to `verify`, and returns the boolean; failure flows through the existing single-loop path (`tool.result` verb:error `blocked:true` + continue). When `verify` is absent, behavior is unchanged (`() => true`).

- [ ] **Step 1: Write the failing test**

```ts
// packages/eval/test/verify.test.ts
import { describe, it, expect } from 'vitest';
import { InMemoryTraceStore } from '@veridical/store';
import { MockProvider, fingerprint } from '@veridical/llm';
import { parseSpecYaml, runSpec } from '@veridical/spec';
import { verifyFromRules, ruleToolCalled, ruleNoErrors } from '../src/index';

const SPEC = `
name: verify-test
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

function provider(text: string): MockProvider {
  const p = new MockProvider();
  p.record(fingerprint({ provider: 'mock', model: 'm', messages: [{ role: 'system', content: 'You are a test agent.' }, { role: 'user', content: 'hello' }] }), text, { input: 1, output: 1, cached: 0, total: 2 });
  return p;
}

const echo = { id: 'echo', name: 'echo', description: '', deterministic: true, execute: async (a: unknown) => a };

describe('verifyFromRules', () => {
  it('passes when rules pass, fails otherwise', () => {
    const v = verifyFromRules([ruleNoErrors()]);
    expect(v([])).toBe(true);
  });
});

describe('runSpec with verify hook', () => {
  it('fails the tool step (blocked) when verify rules fail', async () => {
    const store = new InMemoryTraceStore();
    const spec = parseSpecYaml(SPEC);
    // verify requires the tool to have been called twice — never true on first call → blocked
    const result = await runSpec(
      {
        store,
        providers: new Map([['mock', provider('hi')]]),
        tools: [echo],
        tenant_id: 't1',
        session_id: 's1',
        verify: verifyFromRules([ruleToolCalled('echo')]),
        runStep: async () => ({ text: '', tool: { name: 'echo', args: {} } }),
      },
      spec,
      'hello',
    );
    const blocked = result.events.filter(e => e.type === 'tool.result' && (e.payload as any)?.blocked === true);
    expect(blocked.length).toBeGreaterThan(0);
  });

  it('passes the tool step when verify rules are satisfied', async () => {
    const store = new InMemoryTraceStore();
    const spec = parseSpecYaml(SPEC);
    const result = await runSpec(
      {
        store,
        providers: new Map([['mock', provider('hi')]]),
        tools: [echo],
        tenant_id: 't1',
        session_id: 's1',
        verify: verifyFromRules([ruleNoErrors()]),
        runStep: async () => ({ text: '', tool: { name: 'echo', args: {} } }),
      },
      spec,
      'hello',
    );
    expect(result.events.some(e => e.type === 'tool.result' && (e.payload as any)?.blocked === true)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm install && pnpm -F @veridical/eval test`
Expected: FAIL — `verifyFromRules` not exported / `verify` not on `SpecRunnerDeps`.

- [ ] **Step 3: Write minimal implementation**

`packages/eval/src/verify.ts`:
```ts
import type { TraceEvent } from '@veridical/schema';
import { RuleEngine } from './engine';
import type { Rule } from './rules';

export function verifyFromRules(rules: Rule[]): (events: TraceEvent[]) => boolean {
  const engine = new RuleEngine(rules);
  return (events) => engine.evaluate(events).passed;
}
```

`packages/eval/src/index.ts` (add):
```ts
export * from './verify';
```

`packages/spec/src/runner.ts` — modify:
- Add `verify?: (events: TraceEvent[]) => boolean;` to `SpecRunnerDeps`.
- Replace the `ctx.verifyToolResult` line. Note: the runtime `single-loop` writes the `tool.result` event itself *after* calling `executeTool`/`verifyToolResult` — so this hook snapshots the events *before* the result is appended, synthesizes the pending `tool.result` event carrying the result, and feeds `verify`. The net effect: rules see the current step's result. This matches the "当前步事件快照" design.

Replace the `ctx` block in `runSpec`:
```ts
  const ctx: FlowContext = {
    recorder,
    runStep: (p) => stepRun({ llm, spec, recorder, prompt: p }),
    executeTool: async (name, args) => {
      const r = await broker.call(name, args);
      return r.ok ? r.result : { ok: false, reason: r.reason };
    },
    shouldStop: () => false,
    verifyToolResult: deps.verify
      ? async (result: unknown) => {
          const events = await deps.store.readBySession(session_id);
          const pendingResult = {
            id: `vr_${session_id}_${events.length + 1}`,
            tenant_id: deps.tenant_id,
            session_id,
            span_id: 'loop',
            parent_span_id: null,
            seq: events.length + 1,
            type: 'tool.result',
            verb: 'response',
            attempt: 1,
            duration_ms: 0,
            payload: { result },
            spec_version: spec.version,
          } satisfies TraceEvent;
          return deps.verify!([...events, pendingResult]);
        }
      : () => true,
    maxSteps: spec.flow.max_steps,
  };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm install && pnpm -F @veridical/spec test && pnpm -F @veridical/eval test`
Expected: PASS (both packages; spec suite unaffected, eval verify tests pass).

- [ ] **Step 5: Commit**

```bash
git add packages/eval packages/spec pnpm-lock.yaml
git commit -m "feat: runtime verify hook sharing the rule engine"
```

---

### Task 4: Scenario + Simulator

**Files:**
- Create: `packages/eval/src/scenario.ts`
- Create: `packages/eval/src/simulator.ts`
- Modify: `packages/eval/src/index.ts` (add exports)
- Test: `packages/eval/test/simulator.test.ts`

**Interfaces:**
- Consumes: `RuleDecl`→`Rule` mapping (Task 1 factories); `evaluateRun`/`EvalReport` (Task 2); `runSpec`/`RunResult`/`SpecRunnerDeps`/`SpecRunError` (`@veridical/spec`); `SpecRegistry` (`@veridical/spec`).
- Produces:
  - `type RuleDecl = { outcome_equals: unknown } | { text_contains: string; role?: 'assistant' | 'user' } | { tool_called: string } | { tool_not_denied: string } | { no_errors: true }`
  - `function ruleFromDecl(decl: RuleDecl): Rule`
  - `function ruleDeclsToRules(decls: RuleDecl[]): Rule[]`
  - `interface ScenarioStep { user: string; expect_rules?: Rule[] }`
  - `interface Scenario { name: string; description?: string; spec: { name: string; version?: string }; rules?: Rule[]; steps: ScenarioStep[] }`
  - `function parseScenarioYaml(yaml: string): Scenario` — YAML → RuleDecl → Rule; unknown rule kind throws `ScenarioError`.
  - `class ScenarioError extends Error`
  - `interface ScenarioReport { name: string; steps: { index: number; user: string; run: RunResult; report: EvalReport }[]; passed: boolean }`
  - `class Simulator { constructor(deps: SpecRunnerDeps); run(scenario: Scenario, registry: SpecRegistry): Promise<ScenarioReport> }` — per turn: resolve spec, `runSpec(deps, spec, step.user)`, `evaluateRun(result, { rules: step.expect_rules ?? scenario.rules ?? [] })`, record `eval/run/start` + `eval/step/end` on its own Session/Recorder over `deps.store` (so `run` matches the design signature — no recorder param); throws `ScenarioError` on unresolved spec; propagates `SpecRunError`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/eval/test/simulator.test.ts
import { describe, it, expect } from 'vitest';
import { InMemoryTraceStore } from '@veridical/store';
import { InMemorySpecRegistry, parseSpecYaml } from '@veridical/spec';
import { MockProvider, fingerprint } from '@veridical/llm';
import { parseScenarioYaml, Simulator, ScenarioError, ruleToolCalled, ruleNoErrors, type SpecRunnerDeps } from '../src/index';

const SPEC = `
name: claim
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
tools:
  - name: echo
    access: allow
`;

const SCENARIO = `
name: claim-scenario
description: two turns
spec:
  name: claim
  version: 1.0.0
rules:
  - no_errors: true
steps:
  - user: "hello"
    expect_rules:
      - tool_called: echo
  - user: "world"
`;

function setup() {
  const store = new InMemoryTraceStore();
  const registry = new InMemorySpecRegistry();
  const spec = parseSpecYaml(SPEC);
  void registry.register(spec);
  const mock = new MockProvider();
  mock.record(fingerprint({ provider: 'mock', model: 'm', messages: [{ role: 'system', content: 'You are a claim assistant.' }, { role: 'user', content: 'hello' }] }), 'a', { input: 1, output: 1, cached: 0, total: 2 });
  mock.record(fingerprint({ provider: 'mock', model: 'm', messages: [{ role: 'system', content: 'You are a claim assistant.' }, { role: 'user', content: 'world' }] }), 'b', { input: 1, output: 1, cached: 0, total: 2 });
  const deps: SpecRunnerDeps = {
    store,
    providers: new Map([['mock', mock]]),
    tools: [{ id: 'echo', name: 'echo', description: '', deterministic: true, execute: async (a: unknown) => a }],
    tenant_id: 't1',
  };
  return { store, registry, deps };
}

describe('parseScenarioYaml', () => {
  it('parses a scenario with rule decls into Rule functions', () => {
    const s = parseScenarioYaml(SCENARIO);
    expect(s.name).toBe('claim-scenario');
    expect(s.steps).toHaveLength(2);
    expect(s.steps[0].expect_rules?.[0].name).toBe('tool_called');
    expect(s.rules?.[0].name).toBe('no_errors');
  });

  it('throws ScenarioError on unknown rule kind', () => {
    const bad = SCENARIO.replace('- no_errors: true', '- unknown_rule: 1');
    expect(() => parseScenarioYaml(bad)).toThrow(ScenarioError);
  });
});

describe('Simulator', () => {
  it('runs each turn and reports per-turn evaluation', async () => {
    const { store, registry, deps } = setup();
    const sim = new Simulator(deps);
    const scenario = parseScenarioYaml(SCENARIO);
    const report = await sim.run(scenario, registry);
    expect(report.name).toBe('claim-scenario');
    expect(report.steps).toHaveLength(2);
    expect(report.steps[0].report.passed).toBe(true);   // echo called, no_errors
    expect(report.passed).toBe(true);
    const types = (await store.readBySession('eval_s1')).map(e => e.type);
    expect(types).toContain('eval/run/start');
    expect(types).toContain('eval/step/end');
  });

  it('throws ScenarioError when the spec is not registered', async () => {
    const { deps } = setup();
    const sim = new Simulator(deps);
    const scenario = parseScenarioYaml(SCENARIO);
    const empty = new InMemorySpecRegistry();
    await expect(sim.run(scenario, empty)).rejects.toThrow(ScenarioError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm install && pnpm -F @veridical/eval test`
Expected: FAIL — `parseScenarioYaml` / `Simulator` / `ScenarioError` not exported.

- [ ] **Step 3: Write minimal implementation**

`packages/eval/src/scenario.ts`:
```ts
import { parse as parseYaml } from 'yaml';
import { ruleOutcomeEquals, ruleTextContains, ruleToolCalled, ruleToolNotDenied, ruleNoErrors, type Rule } from './rules';

export class ScenarioError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScenarioError';
  }
}

export type RuleDecl =
  | { outcome_equals: unknown }
  | { text_contains: string; role?: 'assistant' | 'user' }
  | { tool_called: string }
  | { tool_not_denied: string }
  | { no_errors: true };

export function ruleFromDecl(decl: RuleDecl): Rule {
  if ('outcome_equals' in decl) return ruleOutcomeEquals(decl.outcome_equals);
  if ('text_contains' in decl) return ruleTextContains(decl.text_contains, decl.role);
  if ('tool_called' in decl) return ruleToolCalled(decl.tool_called);
  if ('tool_not_denied' in decl) return ruleToolNotDenied(decl.tool_not_denied);
  if ('no_errors' in decl) return ruleNoErrors();
  throw new ScenarioError(`unknown rule decl: ${JSON.stringify(decl)}`);
}

export function ruleDeclsToRules(decls: RuleDecl[]): Rule[] {
  return decls.map(ruleFromDecl);
}

export interface ScenarioStep {
  user: string;
  expect_rules?: Rule[];
}
export interface Scenario {
  name: string;
  description?: string;
  spec: { name: string; version?: string };
  rules?: Rule[];
  steps: ScenarioStep[];
}

export function parseScenarioYaml(yaml: string): Scenario {
  const raw = parseYaml(yaml) as any;
  if (!raw || typeof raw.name !== 'string' || !raw.spec?.name || !Array.isArray(raw.steps)) {
    throw new ScenarioError('scenario must have name, spec.name, and steps[]');
  }
  return {
    name: raw.name,
    description: raw.description,
    spec: { name: raw.spec.name, version: raw.spec.version },
    rules: raw.rules ? ruleDeclsToRules(raw.rules as RuleDecl[]) : undefined,
    steps: (raw.steps as any[]).map((s) => ({
      user: s.user,
      expect_rules: s.expect_rules ? ruleDeclsToRules(s.expect_rules as RuleDecl[]) : undefined,
    })),
  };
}
```

`packages/eval/src/simulator.ts`:
```ts
import { Session, Recorder } from '@veridical/runtime';
import { runSpec, type RunResult, type SpecRunnerDeps } from '@veridical/spec';
import type { SpecRegistry } from '@veridical/spec';
import { evaluateRun, type EvalReport } from './evaluate';
import { ScenarioError, type Scenario } from './scenario';

export interface ScenarioReport {
  name: string;
  steps: { index: number; user: string; run: RunResult; report: EvalReport }[];
  passed: boolean;
}

export class Simulator {
  constructor(private deps: SpecRunnerDeps) {}

  async run(scenario: Scenario, registry: SpecRegistry): Promise<ScenarioReport> {
    const spec = await registry.resolve(scenario.spec.name, scenario.spec.version);
    if (!spec) throw new ScenarioError(`spec not found: ${scenario.spec.name}@${scenario.spec.version ?? 'latest'}`);

    const session = new Session({ session_id: 'eval_s1', tenant_id: this.deps.tenant_id, spec_version: spec.version });
    const recorder = new Recorder(this.deps.store, session);

    const steps: ScenarioReport['steps'] = [];
    for (let i = 0; i < scenario.steps.length; i++) {
      const step = scenario.steps[i];
      await recorder.record({ span_id: 'eval', parent_span_id: null, type: 'eval/run/start', verb: 'request', attempt: 1, duration_ms: 0, payload: { scenario: scenario.name, index: i, user: step.user } });
      const run = await runSpec(this.deps, spec, step.user);
      const rules = step.expect_rules ?? scenario.rules ?? [];
      const report = await evaluateRun(run, { rules });
      await recorder.record({ span_id: 'eval', parent_span_id: null, type: 'eval/step/end', verb: 'response', attempt: 1, duration_ms: 0, payload: { scenario: scenario.name, index: i, passed: report.passed } });
      steps.push({ index: i, user: step.user, run, report });
    }

    return { name: scenario.name, steps, passed: steps.every(s => s.report.passed) };
  }
}
```

`packages/eval/src/index.ts` (add):
```ts
export * from './scenario';
export * from './simulator';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm install && pnpm -F @veridical/eval test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/eval
git commit -m "feat: turn-based scenario simulator"
```

---

### Task 5: Demo — eval-driven run

**Files:**
- Create: `packages/demo/src/eval-demo.ts`
- Create: `packages/demo/test/eval-smoke.test.ts`
- Modify: `packages/demo/package.json` (add `@veridical/eval` dep)

**Interfaces:**
- Consumes: `parseScenarioYaml`/`Simulator`/`evaluateRun` (`@veridical/eval`); `parseSpecYaml`/`InMemorySpecRegistry`/`runSpec` (`@veridical/spec`); `MockProvider`/`fingerprint` (`@veridical/llm`); `JsonlTraceStore` (`@veridical/store`); `Recorder` (`@veridical/runtime`).
- Produces:
  - `function runEvalDemo(dir: string): Promise<{ store: JsonlTraceStore; report: ScenarioReport }>` — registers a claim spec + a two-turn scenario, runs the simulator, persists trace to JSONL.

- [ ] **Step 1: Write the failing test**

```ts
// packages/demo/test/eval-smoke.test.ts
import { describe, it, expect } from 'vitest';
import { runEvalDemo } from '../src/eval-demo';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('eval-driven demo', () => {
  it('runs a simulator scenario and reports evaluation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rt-eval-'));
    const { store, report } = await runEvalDemo(dir);
    expect(report.name).toBe('claim-scenario');
    expect(report.steps.length).toBeGreaterThan(0);
    const events = await store.readBySession('eval_s1');
    const types = events.map(e => e.type);
    for (const t of ['eval/run/start', 'eval/step/end']) {
      expect(types).toContain(t);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm install && pnpm -F @veridical/demo test`
Expected: FAIL — `runEvalDemo` not exported / `@veridical/eval` not found.

- [ ] **Step 3: Write minimal implementation**

`packages/demo/package.json` — add `"@veridical/eval": "workspace:*"` to `dependencies`.

`packages/demo/src/eval-demo.ts`:
```ts
import { JsonlTraceStore } from '@veridical/store';
import { InMemorySpecRegistry, parseSpecYaml } from '@veridical/spec';
import { parseScenarioYaml, Simulator } from '@veridical/eval';
import { MockProvider, fingerprint } from '@veridical/llm';

const SPEC = `
name: claim
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
tools:
  - name: echo
    access: allow
`;

const SCENARIO = `
name: claim-scenario
description: two turns
spec:
  name: claim
  version: 1.0.0
rules:
  - no_errors: true
steps:
  - user: "hello"
    expect_rules:
      - tool_called: echo
  - user: "world"
`;

export async function runEvalDemo(dir: string) {
  const store = new JsonlTraceStore(dir);

  const registry = new InMemorySpecRegistry();
  const spec = parseSpecYaml(SPEC);
  await registry.register(spec);

  const mock = new MockProvider();
  const fp = (user: string) => fingerprint({ provider: 'mock', model: 'm', messages: [{ role: 'system', content: 'You are a claim assistant.' }, { role: 'user', content: user }] });
  mock.record(fp('hello'), 'a', { input: 1, output: 1, cached: 0, total: 2 });
  mock.record(fp('world'), 'b', { input: 1, output: 1, cached: 0, total: 2 });

  const sim = new Simulator({
    store,
    providers: new Map([['mock', mock]]),
    tools: [{ id: 'echo', name: 'echo', description: '', deterministic: true, execute: async (a: unknown) => a }],
    tenant_id: 't1',
  });

  const scenario = parseScenarioYaml(SCENARIO);
  const report = await sim.run(scenario, registry);
  return { store, report };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm install && pnpm -F @veridical/demo test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/demo pnpm-lock.yaml
git commit -m "feat: eval-driven demo"
```

---

### Task 6: Full suite + acceptance verification

**Files:**
- None (verification only).

**Interfaces:**
- Consumes: all packages.

- [ ] **Step 1: Run the entire test suite**

Run: `pnpm test`
Expected: all packages PASS (schema, store, runtime, tools, llm, spec, eval, demo).

- [ ] **Step 2: Run the strict build**

Run: `pnpm build`
Expected: all packages compile clean under `"strict": true`.

- [ ] **Step 3: Verify acceptance criterion — offline evaluation**

`evaluate.test.ts` + `judge.test.ts` assert rule/golden evaluation, pass_requirement, judge combination, and `JudgeParseError` on bad LLM output.

- [ ] **Step 4: Verify acceptance criterion — shared rule engine**

`verify.test.ts` asserts `verifyFromRules` plugged into `runSpec` blocks non-conforming tool steps (verb:error `blocked:true`) and passes conforming ones — the runtime verify and offline `evaluateRun` share `RuleEngine`.

- [ ] **Step 5: Verify acceptance criterion — scenario simulator**

`simulator.test.ts` + `eval-smoke.test.ts` assert per-turn `RunResult` + `EvalReport`, overall pass, `eval/run/start` + `eval/step/end` events in the trace, and `ScenarioError` on unresolved spec.

- [ ] **Step 6: Commit (if any fixes were needed)**

```bash
git add -A
git commit -m "test: verify Phase 3 acceptance criteria"
```
