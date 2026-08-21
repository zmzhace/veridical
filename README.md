<div align="center">

# Veridical

**An enterprise-grade, trace-centric agent harness.**

Agents that are **evaluable**, **replayable**, **comparable**, and **governable** — built on a single, immutable event timeline as the source of truth.

</div>

---

## The idea

Most agent harnesses treat the *loop* as the system: model in → action out → repeat. Veridical inverts this. The **trace** is the spine. Every interaction a runtime makes — an LLM call, a tool invocation, an external API request, a memory read — is a first-class, immutable event on an append-only session timeline.

Everything that matters falls out of that timeline:

| Capability | What it means |
|---|---|
| **Evaluable** | Run an agent, then judge it against rules, golden answers, or LLM review — from the same recorded events. |
| **Replayable** | Reconstruct a run deterministically by replaying its events, with external interfaces mocked back to their recorded responses. |
| **Comparable** | Diff two runs of the same spec to see exactly where behavior changed. |
| **Governable** | Review, publish, and audit agent versions against a versioned agent spec — with feedback looping back into development. |

The guiding invariant is simple and enforced:

> **"Model-visible means logged."** Anything that reaches a model request must be reconstructable from the event log.

---

## What's here now (Phase 1)

Phase 1 is the **foundation**: a trace-centric core runtime. Not the eval engine, replay debugger, or governance layer yet — the primitives those will be built on.

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
└── demo        End-to-end smoke test wiring it all together
```

### The event

Every event shares one schema:

```
{ id, tenant_id, session_id, span_id, parent_span_id,
  seq,            // monotonic logical clock, not wall-clock
  type, verb,     // llm.request, tool.result, ... / request, response, error, stream_chunk
  attempt,        // retry counter — retries are events too
  duration_ms,    // every event carries it, so time is summable anywhere
  tokens, cost,   // carried by every token-bearing event
  payload,        // structured in/out
  call_id,        // external-interface handle, so responses replay deterministically
  spec_version }
```

The seq clock (not wall time) is what makes replay exact: a session replays step-for-step the way it ran. `seq` + `span_id`/`parent_span_id` give both ordering and causality, so even **interleaved, full-duplex streams** stay faithfully reproducible.

---

## Quick start

```bash
pnpm install
pnpm test        # runs every package's suite
pnpm build       # strict TypeScript build across the monorepo
```

Run the end-to-end demo (a full agent loop that persists to a JSONL timeline and rebuilds context from it):

```bash
pnpm -F @rt/demo test
```

> Package scope is currently `@rt/*`; it is being renamed to `@veridical/*` in an upcoming pass.

---

## Design principles

1. **The trace is the spine.** Every cross-boundary interaction is an event; nothing runs without being recorded.
2. **Deterministic by construction.** The only sources of nondeterminism (LLM calls, tools) are fully recorded, so any run can be replayed byte-for-byte.
3. **Derived, never duplicated.** Model context, UI, and eval inputs are *projected* from the event log — never stored separately — so replay and live runs can never diverge.
4. **Composable control flow.** A single-loop is one pluggable driver. Router, orchestrator, evaluator-loop, and chain modes plug into the same seam and trace model.
5. **Explicit failure.** Denied, blocked, and failed stages return explicit results and emit explicit events — nothing is silently swallowed.

---

## Roadmap

```
Phase 1   Core runtime + trace model + tool protocol + LLM gateway + storage   ← done
Phase 2   Agent spec system (declarative YAML, validated, versioned)
Phase 3   Evaluation engine (rules/golden + LLM-judge + scenario simulator)
Phase 4   Replay engine + time-travel debugger + run comparison
Phase 5   Memory (working / long-term semantic / procedural skills)
Phase 6   Multi-tenant platform (API / auth / audit / namespace isolation)
Phase 7   Release + review gate + data feedback loop
Phase 8   Natural-language → spec compiler
```

---

## License

MIT
