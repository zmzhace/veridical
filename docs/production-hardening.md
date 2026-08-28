# Production hardening — first implementation slice

> Historical report for the first slice only. The subsequent guarded production
> profile is described in [the current runbook](production-profile.md), with
> [verification evidence](production-verification.md). The limitations below still
> apply to the legacy research `/api` and JSONL paths, not to the separate `/v1` API.

Baseline: `e8dd138a4269e831e0518db5b55c422ac750676b` (reviewed 2026-08-28).

Status: research preview, **not a production readiness certification**. This slice
addresses reproducible correctness defects; authentication and governed deployment
remain separate work. Do not expose the API publicly or load sensitive business data.

## Implemented

| Area | Guarantee added | Regression coverage |
| --- | --- | --- |
| Recording | `TraceStore.appendNext` owns identity allocation and insertion; next sequence uses the maximum existing sequence | Concurrent calls, multiple JSONL store instances in one process, imported sequence gaps |
| Integrity | Reject duplicate IDs/sequences and mixed-tenant writes to one session; JSONL reads reject identity corruption | Duplicate writes, corrupt files, invalid input leaves sequence unchanged |
| Memory store | Store and read defensive copies | Input, returned event, and read result mutation |
| Paths | Reject path separators, NUL, and dot-directory storage keys | Session reads/writes and Spec registration traversal attempts |
| Spec registration | Exclusive file creation prevents duplicate registration races | Concurrent registry instances |
| LLM trace | Registered provider errors have paired error responses; single-run HTTP uses the gateway | Complete failures, interrupted streams, fallback has no duplicate error events, HTTP trace |
| Replay | Repeated LLM requests consume recorded responses in order; tools validate paired request arguments; replay runs have unique IDs | Exhaustion, changed arguments, blocked results, ambiguous traces, repeated replay |
| Evaluation | Empty evaluation or unavailable configured judge fails closed; rejected tools produce errors; legacy denied results fail `no_errors` | Unit tests and HTTP evaluation |
| Packaging | Server is bundled for plain Node, defaults to loopback, and closes on termination signals | Spawn built artifact from a fresh temporary working directory and probe health |
| CI | Full tests, build, production smoke on Node 20.19, 22, 24 | Workflow added locally; remote execution requires pushing it |

## Compatibility changes

- Custom `TraceStore` implementations must implement `appendNext(NewTraceEvent)`.
  Allocation and insertion must share the backend's atomic boundary. A database
  implementation should use a transaction and unique session/sequence constraints,
  not copy an unlocked read-then-write implementation.
- `append` now validates events and rejects duplicate IDs/sequences within a
  session. Imported logs with duplicate identities fail on read; they are never
  silently rewritten. Existing identifiers and gaps are preserved.
- `evaluateRun` returns `passed: false` and `reason: no_checks` for an empty
  evaluation, or `judge_unavailable` if a requested judge is not provided.
- HTTP evaluation explicitly runs `no_errors`, plus a supplied golden check.
  Passing this baseline is **not** proof of task success, completeness, or compliance.
- Replay responses are consumable recordings, not an unlimited response cache.
  Tool replay rejects unpaired/ambiguous records and argument mismatches instead of
  guessing. Failed tool executions and full multi-turn/stream replay are not yet supported.
- Production start uses `dist/server.cjs`. Run `pnpm build` before `pnpm start`
  in the server package. Production dependencies (`fastify`, `@fastify/cors` and
  their dependencies) are still required. `tsx` is not required for startup.
- The server binds `127.0.0.1` by default. `VERIDICAL_HOST` can override this, but
  doing so does not add authentication or make public exposure safe.

## Explicit limitations

- JSONL allocation is atomic only inside one JavaScript process (including
  separate store instances). Multiple processes, worker threads, or hosts writing
  the same directory remain unsupported. There is no database transaction, fsync
  durability contract, tamper-proof ledger, WORM storage, or automatic crash recovery.
- Rejecting mixed tenants in one session is an integrity check, **not tenant
  isolation**. Reads are still addressed only by session ID; HTTP tenant identity
  and the shared `_memory` namespace have not been redesigned.
- Filesystem writers remain trusted. Key validation is not protection against a
  malicious local administrator or filesystem/symlink replacement.
- JSONL appends still read the session history; large trajectories and streaming
  chunks require a different persistence/read model before scaling.
- No change here claims a canonical trace-driven runtime, resumable side effects,
  complete failure replay, or byte-for-byte trace equivalence. `RunComparator`
  continues to compare selected event fields.
- MockPolicy training and automatic skill writes are unchanged. Training output
  is not validated for production use; no automatic deployment is authorized.

## Next milestones and acceptance gates

1. **Identity and isolation**: authenticated actor/tenant context; tenant-qualified
   trace, Spec and memory keys; role/policy checks on every API; adversarial cross-tenant tests.
2. **Durable ledger**: transactional sequence allocation, idempotency keys, schema
   versions, timestamps and immutable release/tool/model provenance; restart,
   concurrent-worker, storage-failure and recovery tests.
3. **Canonical execution**: tool observations feed subsequent model requests;
   complete/failed/cancelled states; bounded retries, timeouts and cancellation;
   pinned-version, multi-turn replay with memory and external side-effect boundaries.
4. **Governed releases**: draft/review/approved/published/revoked lifecycle,
   actor-bound approval evidence, immutable artifacts, canary rollout and rollback.
5. **Controlled improvement**: isolated candidate storage, held-out evaluation,
   safety regression gates, approval before promotion, and online monitoring.
   Never let a reward increase directly change production permissions or skills.

## Verification commands

Local verification on 2026-08-28 (Node 23.11.0, pnpm 9.0.0): all 257 tests
passed (40 added), full monorepo build passed, and the bundled server passed
startup, HTTP health, and graceful shutdown checks. Frozen-lockfile installation
and `git diff --check` passed. The GitHub Actions matrix has not been run remotely.

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm build
node packages/server/scripts/smoke-production.mjs
git diff --check
```
