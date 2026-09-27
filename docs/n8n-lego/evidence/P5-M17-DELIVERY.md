# P5-M17 — Execution retry model (P5-M10-G)

Scope mapping (register P5-M17):

| Scope | Delivered | Evidence |
| --- | --- | --- |
| retry-request record bound to an original execution | `apps/n8n-lego/src/lego/execution-retry-model.mjs` — `createExecutionRetryModel(storage,{clock,idFactory,executionLookup,namespace})`; record `{tag, retryId, originalExecutionId, requestedBy, reason, state, ...}`; linkage + uniqueness in ONE authoritative key `x:<originalExecutionId>` + pointer `r:<retryId>` | test 1 |
| idempotency (no silent second run) | **double-retry refusal**: at most ONE retry request per original execution EVER; second `createRetry` → `RETRY_CONFLICT` on any host; `executed` terminal recorded exactly once via CAS | test 2 |
| terminal-state rules | original execution must be retry-eligible (closed set `failed\|cancelled`): `running` refused (parallel hidden run), `succeeded` refused (hidden second run), unknown execution → `RETRY_NOT_FOUND`; retry lifecycle closed `created→approved→executed` (+`rejected\|aborted`), end states terminal | tests 3–4 |
| persistence = execution store extension (P8) | storage facade only (namespace `exec-retry`); multi-host shared state | test 6 |
| API gated until the model exists | no HTTP surface added; model layer only | surface pin test 9 |
| tests: double-retry refusal + linkage | tests 1–2; linkage enforced (record bound to `originalExecutionId`; lookup by retryId OR executionId) | tests 1–2 |
| rollback: unmount | no destructive API; namespace isolation leaves history intact but hidden | test 8 |
| deps: engine execution records | dependency-injected `executionLookup(id)` → `{state}\|null` (provider-neutral; engine records live outside this model) | test 3 |

Model surface (closed, pinned in test 9): `createRetry/getRetry`, `approveRetry/executeRetry/rejectRetry/abortRetry`, `listRetries`, `capabilities/namespace`.

## Semantics recorded (explicit)

1. **The model never runs anything** — it records retry intent + terminal outcome only; the "no second run" guarantee is structural (one record ever + `executed` exactly once).
2. Create-if-absent pattern (documented P8-S01 deviation family, P5-M12..M16).
3. CAS transitions require the explicit version token.

## Impl bug caught pre-commit (impl fixed, tests unchanged)

`createRetry` initially returned the record without its CAS `version` token, making every subsequent transition fail the token requirement. Fixed: the create result carries the authoritative key's version.

## Battery

See PR CI + post-merge battery (lego suite + engine + runtime + lego:gate + isolation + decisions).
