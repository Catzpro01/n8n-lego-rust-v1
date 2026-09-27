# P5-M05 Delivery Evidence — Multi-host shared session + rate-limiter state

Date: 2026-09-27. Owner authorization: marathon BLOCKER-ZERO prompt (P5-M05 delivery after P8-S01)
+ acceptance list from the continuation prompt (10 items, mapped below).

## 1. What changed

| Artifact | Path |
|----------|------|
| Session state | `apps/n8n-lego/src/lego/session-state.mjs` — `createSessionState(storage, {clock, idFactory, ttl})`: create/get/refresh/revoke + session state kv + CAS counter |
| Rate-limiter state | `apps/n8n-lego/src/lego/rate-limit-state.mjs` — `createRateLimiter(storage, {clock, windowSeconds, maxRequests})`: fixed-window shared counters |
| Tests | `apps/n8n-lego/test/lego-session-state.test.mjs` (9) + `lego-rate-limit-state.test.mjs` (8) = 17 |

## 2. Acceptance mapping (continuation prompt)

| # | Acceptance | Evidence |
|---|------------|----------|
| 1 | session state via storage facade, not memory-local simulation | session records + session kv persist only through the `storage` facade handle (namespace `session`); a restart with a fresh provider over the same persistence sees the same sessions (durability cases); NO in-memory map exists in the module |
| 2 | rate-limiter state via storage facade | fixed-window counters in namespace `rate-limit` via the facade; `lego-rate-limit-state.test.mjs` "two hosts share one limit" |
| 3 | provider internals never leak to consumers | modules import ONLY `storage/contract.mjs` (StorageError types); consumer surface pinned by tests (`Object.keys` assertions); providers are injected from outside |
| 4 | CAS for mutual exclusion / race-sensitive state | `refresh` (session TTL extension), `setState` (with version), `incrementState` and `consume` (counters) all go through `putIfVersion`; multi-host races proven: one refresh winner + explicit CONFLICT for the loser; 74 interleaved consumes = exactly 40 admitted, every attempt counted exactly once |
| 5 | multi-host behavior follows the storage contract | two `createSessionState`/`createRateLimiter` instances (logical hosts) share one storage; outcomes = contract outcomes (LWW create of identical convergent bytes + CAS increments); local provider `multiHost:false` honesty flows through `capabilities` |
| 6 | deterministic tests | injected `clock` (createTestClock) + injected `idFactory`; determinism test asserts byte-identical outcomes across runs |
| 7 | explicit failure/error semantics | closed error sets `SESSION_INVALID/NOT_FOUND/EXPIRED/CONFLICT` + `RATE_LIMIT_INVALID/CONFLICT`; storage errors propagate as `STORAGE_*` untouched |
| 8 | no silent fallback | storage outage test: `consume`/`incrementState` throw `STORAGE_UNAVAILABLE` (never a silent pass, never memory fallback); failed writes roll back at the storage boundary (verified); contention exhaustion is an explicit CONFLICT |
| 9 | Rust-friendly boundary | facade-only side effects, no hidden global state, JSON records with `tag: 1` (upgrade compatibility), stable closed codes, deterministic given injected clock/idFactory/storage |
| 10 | regression suite green | full battery recorded in the delivery PR + post-merge reconcile (lego incl. the 17 new tests, engine 49/49, runtime 79/79, lego:gate, isolation, decisions, ai:check) |

## 3. Concurrency semantics (documented, tested)

- **Session refresh**: caller reads a version (`get`) and passes it to `refresh`. Exactly one of two
  concurrent refreshes applies; the other receives `SESSION_CONFLICT` with reason `version_conflict`
  and recovers by re-reading (documented CAS pattern).
- **Counters (session state + rate-limit)**: a missing counter is established with a **convergent**
  `put(0)` (every racer writes identical bytes, so the storage contract's last-writer-wins create
  cannot lose an increment), then the increment is a pure CAS step with a bounded retry loop
  (`maxRetries` default 3). Exhaustion = explicit `*_CONFLICT`, never a silent drop.
- **Rate-limit admission**: exactly `maxRequests` consumes pass per window across all hosts
  (decision derived from the post-increment CAS value); rejected attempts still bump the real usage
  counter so accounting stays exact (`used` can exceed `maxRequests`).

## 4. Deviations / known limits (explicit)

- Session `create` and `setState(version: null)` (create path) use the storage contract's
  last-writer-wins create semantics (P8 item 9). For strict create-if-absent semantics a future
  `putIfAbsent` contract op (MINOR change) would be required; race-sensitive updates already use CAS.
- Fixed-window rate limiting (not sliding window) — deterministic and storage-cheap; documented.

## 5. Rollback path

Remove `session-state.mjs` + `rate-limit-state.mjs` + the two test files; no data migration (namespaced
keys `session`/`rate-limit` are simply abandoned), no consumer depends on them yet.
