<div align="center">

# Veridical

**A trace-centric agent harness with a guarded production API profile.**

Agents that are **evaluable**, **replayable**, **comparable**, and **governable** — built on a single, immutable event timeline as the source of truth.

</div>

---

> **Two explicit profiles:** `/v1` is the guarded, authenticated production API:
> encrypted transactional storage, tenant isolation, approval-gated releases,
> recorded-response replay and candidate-only automatic improvement. Its supported
> scope is **single host, local disk, read-only tools, single-loop / stage-gate**.
> The legacy `/api` console, JSONL, memory and RL demos remain **research-only**;
> `pnpm dev` explicitly selects that mode. Production is the default for the built
> server and refuses to start without secure configuration.
> Read the [production runbook and launch gates](docs/production-profile.md),
> [API workflow](docs/production-api.md) and [verification record](docs/production-verification.md).
> This is not a claim of HA, regulatory certification or proven autonomous learning.

## The idea

Most agent harnesses treat the *loop* as the system: model in → action out → repeat. Veridical inverts this. The **trace** is the spine. Every interaction a runtime makes — an LLM call, a tool invocation, an external API request, a memory read — is a first-class, immutable event on an append-only session timeline.

Everything that matters falls out of that timeline:

| Capability | What it means |
|---|---|
| **Evaluable** | Run an agent, then judge it against rules, golden answers, or LLM review — from the same recorded events. |
| **Replayable** | Reconstruct a run deterministically by replaying its events, with external interfaces mocked back to their recorded responses. |
| **Comparable** | Diff two runs of the same spec to see exactly where behavior changed. |
| **Governable** | Review, publish, and audit agent versions against a versioned agent spec — with feedback looping back into development. |
| **Memoryful** | Working, long-term semantic, and procedural-skill memory — all event-log-driven and replayable. |

The guiding invariant is simple and enforced:

> **"Model-visible means logged."** Anything that reaches a model request must be reconstructable from the event log.

---

## What's here now

Veridical is built in phases; every phase is merged and test-covered. Beyond the numbered phases, the platform ships an **interactive conversation runtime** — see the [conversation section](#10-conversation--交互对话运行时--interactive-conversation-runtime) below.

```
packages/
├── schema      The unified TraceEvent schema (zod) — single source of truth
├── store       TraceStore abstraction: append-only event log
│               · InMemoryTraceStore   (tests, fast iteration)
│               · JsonlTraceStore      (local persistence, one file per session)
├── runtime     Session + Recorder (monotonic seq clock)
│               · deriveMessages — rebuild model context purely from events
│               · composable flow engine: runSingleLoop (gather → act → verify)
├── tools       ToolBroker — five-stage execution pipeline
│               pre-execute(approval) → guard → execute → verify → frozen result
├── llm         LLMGateway — live / mock dual mode keyed by request fingerprint
├── spec        Agent Spec system — declarative YAML + zod validation + semver registry
│               · InMemorySpecRegistry / JsonlSpecRegistry
│               · SpecRunner (runSpec) — read a spec, drive the runtime
├── eval        Evaluation engine — rules / golden / LLM-judge / scenario simulator
│               · RuleEngine — shared "one yardstick" with runtime verify
│               · LLMJudge · Simulator (turn-based scenarios)
├── replay      Replay engine — re-execute a run from recorded responses
│               · ReplayEngine (ReplayPlan) · TraceProjection (time-travel state)
│               · RunComparator (event-level diff)
├── memory      Memory system — event-log-driven working / semantic / skill memory
│               · MemoryStore · Memory facade · memoryToSystemPrompt
├── rl          Agentic RL — trains decision policies over recorded traces
├── server      Fastify HTTP layer — sessions / run / turn(SSE) / specs / eval / compare / RL
│               · POST /api/run/turn — streaming conversation turns (token + event frames)
├── demo        End-to-end demo specs (insurance policy-switch, transfer advisor)
└── web         React observation console — traces, replay, eval, compare, RL
                · conversation UI — interactive multi-turn dialog with token streaming,
                  per-step checkpoints, and full-trajectory review
```

---

## Quick start

The commands below launch the **local research console**, not the production profile.
Production requires Node 22.14+ (22/24 LTS recommended), separate credentials and keys;
follow the [runbook](docs/production-profile.md).

```bash
pnpm install
pnpm test        # runs every package's suite
pnpm build       # strict TypeScript build across the monorepo
pnpm dev         # Fastify API (server) + React console (web), wired together
```

Run the end-to-end demos (each persists a real JSONL timeline):

```bash
pnpm -F @veridical/demo test    # runs all demo smoke tests
```

Open the conversation console at the dev URL: **＋ 新对话 → pick a spec → chat**. Every turn is recorded as events on one `conv_` session — checkpoints are taken per step, and the whole conversation is a replayable trajectory.

---

## 中文入门 / Getting Started (中文) / 日本語ガイド (日本語)

### 中文 (Chinese)

**Veridical 是什么？** 一套以**事件轨迹（trace）为中心**的 agent 框架。受限生产 API 与研究控制台分开运行；具体支持范围和上线验收要求见上方说明。

**核心不变式**：*"模型可见必须可记录"*——任何到达模型请求的内容，都必须能从事件日志重建。

**快速上手**：
```bash
pnpm install && pnpm test
```

**一个最小 spec 驱动的 agent**（声明式 YAML → 运行 → 判定）：
```yaml
# agent.yaml
name: claim-filing
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
  - name: echo
    access: allow
```

```ts
import { JsonlTraceStore } from '@veridical/store';
import { InMemorySpecRegistry, parseSpecYaml, runSpec } from '@veridical/spec';
import { MockProvider, fingerprint } from '@veridical/llm';

const store = new JsonlTraceStore('.traces');
const spec = parseSpecYaml(`
name: claim-filing
version: 1.0.0
schema_version: 1
instruction:
  system: You are a claim assistant.
flow:
  mode: single-loop
  max_steps: 3
llm:
  provider: mock
  model: m
  fallback: []
tools: []
`);
await new InMemorySpecRegistry().register(spec);

const prompt = '我要报案';
const mock = new MockProvider();
mock.record(
  fingerprint({ provider: 'mock', model: 'm', messages: [{ role: 'system', content: 'You are a claim assistant.' }, { role: 'user', content: prompt }] }),
  'I collected policy_no.',
  { input: 1, output: 1, cached: 0, total: 2 },
);

const result = await runSpec(
  { store, providers: new Map([['mock', mock]]), tools: [], tenant_id: 't1' },
  spec,
  prompt,
);
// result.events 是完整 trace；可以重放、评测、比较
```

---

### English

**What is Veridical?** A **trace-centric** agent framework. The guarded production API and research console run separately; their capabilities and limitations differ as described above.

**The core invariant**: *"Model-visible means logged."* Anything that reaches a model request must be reconstructable from the event log.

**Quick start**:
```bash
pnpm install && pnpm test
```

**A minimal spec-driven agent** (declarative YAML → run → evaluate):
```yaml
# agent.yaml
name: claim-filing
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
  - name: echo
    access: allow
```

```ts
import { JsonlTraceStore } from '@veridical/store';
import { InMemorySpecRegistry, parseSpecYaml, runSpec } from '@veridical/spec';
import { MockProvider, fingerprint } from '@veridical/llm';

const store = new JsonlTraceStore('.traces');
const spec = parseSpecYaml(`
name: claim-filing
version: 1.0.0
schema_version: 1
instruction:
  system: You are a claim assistant.
flow:
  mode: single-loop
  max_steps: 3
llm:
  provider: mock
  model: m
  fallback: []
tools: []
`);
await new InMemorySpecRegistry().register(spec);

const prompt = 'I want to file a claim';
const mock = new MockProvider();
mock.record(
  fingerprint({ provider: 'mock', model: 'm', messages: [{ role: 'system', content: 'You are a claim assistant.' }, { role: 'user', content: prompt }] }),
  'I collected policy_no.',
  { input: 1, output: 1, cached: 0, total: 2 },
);

const result = await runSpec(
  { store, providers: new Map([['mock', mock]]), tools: [], tenant_id: 't1' },
  spec,
  prompt,
);
// result.events is the full trace; replayable, evaluable, comparable
```

---

### 日本語 (Japanese)

**Veridical とは？** トレース（イベント軌跡）中心のエンタープライズ向けエージェントフレームワークです。LLM 呼び出し・ツール実行・メモリ読み書きといったすべてのやり取りが、追記専用のイベントログ上の不変の第一級イベントとして記録されます。

**中核の不変条件**: *「モデルに見えるものはすべて記録されなければならない」* — モデルリクエストに届くものはすべて、イベントログから再構築できなければなりません。

**クイックスタート**:
```bash
pnpm install && pnpm test
```

**最小の spec 駆動エージェント**（宣言的 YAML → 実行 → 評価）:
```yaml
# agent.yaml
name: claim-filing
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
  - name: echo
    access: allow
```

```ts
import { JsonlTraceStore } from '@veridical/store';
import { InMemorySpecRegistry, parseSpecYaml, runSpec } from '@veridical/spec';
import { MockProvider, fingerprint } from '@veridical/llm';

const store = new JsonlTraceStore('.traces');
const spec = parseSpecYaml(`
name: claim-filing
version: 1.0.0
schema_version: 1
instruction:
  system: You are a claim assistant.
flow:
  mode: single-loop
  max_steps: 3
llm:
  provider: mock
  model: m
  fallback: []
tools: []
`);
await new InMemorySpecRegistry().register(spec);

const prompt = '保険を申請したいです';
const mock = new MockProvider();
mock.record(
  fingerprint({ provider: 'mock', model: 'm', messages: [{ role: 'system', content: 'You are a claim assistant.' }, { role: 'user', content: prompt }] }),
  'I collected policy_no.',
  { input: 1, output: 1, cached: 0, total: 2 },
);

const result = await runSpec(
  { store, providers: new Map([['mock', mock]]), tools: [], tenant_id: 't1' },
  spec,
  prompt,
);
// result.events が完全なトレース。リプレイ・評価・比較が可能
```

---

## Feature examples (全功能示例)

Every subsystem ships a runnable example. Below, each capability is shown with a minimal, self-contained snippet.

### 1. Schema — 统一事件模型 / Unified event model

```ts
import { parseEvent } from '@veridical/schema';

const evt = parseEvent({
  id: 'evt_1', tenant_id: 't1', session_id: 's1', span_id: 'sp', parent_span_id: null,
  seq: 1, type: 'llm.request', verb: 'request', attempt: 1, duration_ms: 12,
  payload: { model: 'gpt-4o' }, spec_version: '0.0.1',
});
// seq is a monotonic logical clock (not wall time) — exact replay
```

### 2. Store — 事件存储 / Event storage

```ts
import { InMemoryTraceStore, JsonlTraceStore } from '@veridical/store';

const mem = new InMemoryTraceStore();      // tests / fast iteration
const jsonl = new JsonlTraceStore('.traces'); // one file per session

await mem.append(evt);
const all = await mem.readBySession('s1');   // events in seq order
const one = await mem.bySeq('s1', 7);        // single event by seq
```

### 3. Runtime — 会话与录制 / Sessions & recording

```ts
import { Session, Recorder, deriveMessages } from '@veridical/runtime';

const session = new Session({ session_id: 's1', tenant_id: 't1', spec_version: '1.0.0' });
const recorder = new Recorder(store, session);

await recorder.record({ span_id: 'sp', parent_span_id: null, type: 'user.message', verb: 'request', attempt: 1, duration_ms: 0, payload: { text: 'hello' } });

const messages = await deriveMessages(store, 's1');   // "model-visible means logged"
```

### 4. Tools — 五段工具管线 / Five-stage tool pipeline

```ts
import { ToolBroker, type ToolDef } from '@veridical/tools';

const broker = new ToolBroker(
  [{ id: 'echo', name: 'echo', description: 'echo', deterministic: true, execute: async (a) => a }],
  { decide: async () => 'allow' },
);

const r = await broker.call('echo', { x: 1 });   // { ok: true, result: { x: 1 } }
const denied = await broker.call('unknown', {});  // { ok: false, reason: 'not_found' }
```

### 5. LLM — 实时/模拟双模式 / Live & mock dual mode

```ts
import { LLMGateway, MockProvider, fingerprint } from '@veridical/llm';

const mock = new MockProvider();
mock.record(fingerprint(req), 'recorded answer', { input: 1, output: 1, cached: 0, total: 2 });

const gateway = new LLMGateway(new Map([['mock', mock]]));
const res = await gateway.complete(req, recorder);   // replays by fingerprint
```

### 6. Spec — 声明式 Agent + 注册表 / Declarative agents & registry

```ts
import { InMemorySpecRegistry, JsonlSpecRegistry, parseSpecYaml, runSpec } from '@veridical/spec';

const registry = new InMemorySpecRegistry();
await registry.register(parseSpecYaml(agentYaml));
await registry.register(parseSpecYaml(agentYamlV2));

const v1 = await registry.resolve('claim-filing', '1.0.0');  // exact version
const latest = await registry.resolve('claim-filing');        // highest semver
// duplicate (name, version) registration is rejected (immutable registry)

const result = await runSpec(deps, latest, 'hello');  // drives the single-loop
```

### 7. Eval — 规则/黄金/LLM 评审 / Rules, golden, LLM-judge

```ts
import { evaluateRun, ruleOutcomeEquals, ruleNoErrors } from '@veridical/eval';

const report = await evaluateRun(result, {
  rules: [ruleNoErrors()],           // deterministic rules over the event log
  golden: '完成',                     // outcome-equality sugar
});
if (!report.passed) {
  console.error(report.rules?.rules);  // per-rule verdicts with detail
}
```

**Scenario simulator — 多轮脚本压测** / turn-based scenario:

```yaml
name: claim-scenario
spec: { name: claim-filing, version: 1.0.0 }
rules: [{ no_errors: true }]
steps:
  - user: "我要报案，保单号 P12345"
    expect_rules: [{ tool_called: lookup_policy }]
  - user: "地点在建设路 88 号"
    expect_rules: [{ outcome_equals: "完成" }]
```

```ts
import { parseScenarioYaml, Simulator } from '@veridical/eval';

const sim = new Simulator(deps);
const report = await sim.run(parseScenarioYaml(scenarioYaml), registry);
report.passed;   // every turn's per-turn evaluation must pass
```

### 8. Replay — 确定性回放 / Deterministic replay

```ts
import { ReplayEngine } from '@veridical/replay';

const engine = new ReplayEngine(store, registry);
const replay = await engine.replay('s1', { spec: { name: 'claim-filing' } }, tools);
replay.identical;   // true if the re-run matches the recorded trace event-for-event
// assert_trace_identical (default true) throws TraceDivergenceError on drift
```

**Time-travel projection — 任意 seq 点状态** / state at any point:

```ts
import { TraceProjection } from '@veridical/replay';

const projection = new TraceProjection(store);
const atSeq5 = await projection.projectAt('s1', 5);   // model context + events up to seq 5
for await (const snap of projection.cursor('s1')) { /* step through the run */ }
```

**Run comparison — 运行 diff**:

```ts
import { RunComparator } from '@veridical/replay';

const diff = await new RunComparator(store).compare('s1', 's2');
diff.summary.first_divergence;   // first divergent seq
diff.summary.outcomes_equal;     // did both runs end the same?
```

### 9. Memory — 记忆系统 / Memory system

```ts
import { Session, Recorder } from '@veridical/runtime';
import { Memory, MemoryStore } from '@veridical/memory';

const memory = new Memory(
  new MemoryStore(), store, 's1',
  new Recorder(store, new Session({ session_id: 's1', tenant_id: 't1', spec_version: '1.0.0' })),
  new Recorder(store, new Session({ session_id: '_memory', tenant_id: 't1', spec_version: '1.0.0' })),
);

await memory.remember('last_slot', 'policy_no');               // working memory (session-scoped)
await memory.rememberSemantic('policy', 'P12345', ['claim']);  // long-term (cross-session, tagged)
await memory.rememberSkill('echo_helper', { name: 'echo', description: 'echo', procedure: 'return args' });

const hits = await memory.recall('claim policy');              // deterministic recall (tag + keyword + recency)
const skills = await memory.listSkills();
await memory.forget('policy', 'semantic');                     // tombstone write
```

**Memory in runSpec — 记忆注入上下文**:

```ts
const result = await runSpec({ store, providers, tools, tenant_id: 't1', memory }, spec, 'hello');
// defaultRunStep recalls memory for the prompt and injects a "## 记忆" system block
```

### 10. Conversation — 交互对话运行时 / Interactive conversation runtime

A conversation is one `conv_` session; each user message is a *turn* appended to the same event timeline. Every step records a `state.checkpoint` frame, so the whole conversation is inspectable and replayable — checkpoints, tool capsules, and stage gates are all clickable in the web console.

```ts
import { runSpec, runSpecTurn } from '@veridical/spec';

// Turn 1 — starts the conversation (records spec/run/start once)
await runSpec({ ...deps, session_id: 'conv_abc', turn: true, firstTurn: true }, spec, '我要转保');

// Turn 2+ — continues the same session; prior turns are injected as LLM context
// (per-turn deduped, last 10 turns)
await runSpecTurn({ ...deps, session_id: 'conv_abc' }, spec, '那退保损失呢？');
// · single-loop turns: free-form multi-turn chat
// · stage-gate turns: gate checks are scoped to the current turn; the flow resumes
//   at the first incomplete stage and ends the turn gracefully when blocked
```

Over HTTP, `POST /api/run/turn` streams a turn over SSE — `token` frames (typewriter), `event` frames (tool/checkpoint as they land), then `turn_end` / `done`:

```bash
curl -N -X POST localhost:8787/api/run/turn \
  -H 'Content-Type: application/json' \
  -d '{"specName":"transfer-advisor","prompt":"我要转保","mode":"mock"}'
# data: {"type":"token","session_id":"conv_...","text":"…"}
# data: {"type":"event","event":{"type":"tool.called",…}}
# data: {"type":"done","session_id":"conv_...","event_count":14,…}
```

The React console renders the live stream (bubbles + tool capsules + ↺ checkpoint anchors), and the same trajectory can be reviewed afterwards — switch to the timeline view or open any event.

---

## Roadmap

```
Phase 1   Core runtime + trace model + tool protocol + LLM gateway + storage   ✓ done
Phase 2   Agent spec system (declarative YAML, validated, versioned)           ✓ done
Phase 3   Evaluation engine (rules/golden + LLM-judge + scenario simulator)    ✓ done
Phase 4   Replay engine + time-travel debugger + run comparison                ✓ done
Phase 5   Memory (working / long-term semantic / procedural skills)            ✓ done
  +       Stage-gate + supervisor flows · agentic RL over traces · web console ✓ done
  +       Conversation runtime — streaming multi-turn dialog, per-step         ✓ done
          checkpoints, single-session turn continuation (conv_ timeline)
Phase 6   Multi-tenant platform (API / auth / audit / namespace isolation)
Phase 7   Release + review gate + data feedback loop
Phase 8   Natural-language → spec compiler
```

---

## Design principles

1. **The trace is the spine.** Every cross-boundary interaction is an event; nothing runs without being recorded.
2. **Recorded-response replay.** Supported sequential runs can be re-executed from recorded responses. Full failure, streaming, multi-turn and environment replay remain work in progress; comparisons cover selected event fields, not byte-for-byte identity.
3. **Trace-derived state as the target.** UI and evaluation consume the event log. Some runtime paths still build model context separately; a canonical trace-derived runtime is a hardening milestone.
4. **Composable control flow.** A single-loop is one pluggable driver. Router, orchestrator, evaluator-loop, and chain modes plug into the same seam and trace model.
5. **Explicit failure.** Denied, blocked, and failed stages return explicit results and emit explicit events — nothing is silently swallowed.
6. **One yardstick.** Runtime single-step verify and offline evaluation share the same `RuleEngine`.

---

## License

MIT
