# P8-S01 Delivery Evidence — Storage contract foundation (P8-S01..S07 vertical)

Date: 2026-09-27. Owner authorization: master prompt marathon BLOCKER-ZERO section 6
("Prioritaskan: P8-S01 ... contract eksplisit ... testable ... Rust-friendly") and the earlier
REQ-0003 section 8 authorization path (P8-S01-FOUNDATION.md, which requested exactly this
vertical: contract core + TTL + harness, semantics landed with it, local provider included).

## 1. What changed (the delivery)

| Artifact | Path | Covers |
|----------|------|--------|
| Contract + facade | `apps/n8n-lego/src/lego/storage/contract.mjs` | P8-S02 (kv semantics, namespace, serialization, failure, consistency), typed error taxonomy, capability profile, batch/CAS result shapes |
| Local reference provider | `apps/n8n-lego/src/lego/storage/local-provider.mjs` | P8-S06; TTL (P8-S03), CAS + batch atomicity (P8-S04), concurrency semantics (P8-S05), durability/recovery (item 10) |
| Conformance harness | `apps/n8n-lego/src/lego/storage/conformance.mjs` | P8-S07 — the acceptance gate every provider must pass |
| Unit + boundary tests | `apps/n8n-lego/test/lego-storage-contract.test.mjs` | facade validation parity, consumer boundary, durability, fault behaviour, upgrade compatibility |
| Conformance tests | `apps/n8n-lego/test/lego-storage-conformance.test.mjs` | harness runs against the local provider + meta-proof the harness detects a broken provider |

## 2. Why (root-cause chain)

P5-M05 (multi-host shared session/rate-limit state) is blocked on the provider-neutral storage
contract "to genuinely exist" (its `blockedBy` names P8-S01-FOUNDATION.md items 1-10). Every
backing model in P5-M10-DECOMPOSITION.md needs the same persistence semantics. This delivery is
the dependency, not a test-green prop: the contract is the boundary future providers (shared,
multi-host, Rust) plug into without touching consumers.

## 3. Contract semantics (all 10 mandatory definitions implemented + pinned)

1. **Key/value** — `get/put/delete/list`; values opaque bytes; `list` bounded (limit ≤ profile.maxListLimit, default 100, cap 1000); unbounded enumeration does not exist.
2. **Namespace** — closed pattern `[a-z0-9][a-z0-9._-]{0,63}`; cross-namespace reads do not exist (tested).
3. **Atomicity** — single put/delete atomic; `applyBatch` is **all-or-nothing**: semantic conflict returns `{applied:false, failedOpIndex, reason}` and NOTHING lands (tested mid-batch); provider faults roll back and throw UNAVAILABLE (tested).
4. **TTL** — `ttlSeconds` at put; `touch` refreshes; expired keys are absent for `get`/`touch`/CAS and excluded from `list`; visibility is contract-defined even though eviction timing is provider-defined (tested with an injected clock).
5. **CAS** — `putIfVersion`/`deleteIfVersion` with opaque monotonic version tokens; failure is a first-class result `{applied:false, reason:'version_conflict'|'absent'}` (tested; expired key = 'absent').
6. **Serialization** — values are byte blobs; the contract never interprets value bytes (typed INVALID on non-bytes).
7. **Failure behavior** — closed error codes `STORAGE_TIMEOUT|UNAVAILABLE|CONFLICT|NOT_FOUND|INVALID`; a miss is `{found:false}` (result), never an error; an unmapped provider throw becomes UNAVAILABLE at the facade, never a fake result (tested); no hidden retries.
8. **Consistency** — read-your-writes per key and monotonic reads hold in the reference implementation; cross-key ordering is promised only inside `applyBatch` (documented; the harness pins the per-key behaviour).
9. **Concurrency** — last-writer-wins per key with version bump; mutual exclusion is built from CAS (documented pattern in tests: lock = `putIfVersion` on a lock key); multi-host races must produce contract-level outcomes — a provider claiming multiHost=true must prove it under the same harness (the local provider declares `multiHost: false` and the harness enforces that local providers never claim it).
10. **Recovery** — acknowledged writes survive restart iff `capabilities.durable` (write-through persistence adapter, `{v:1, namespaces}` payload, tag checked on load — foreign payloads are rejected as UNAVAILABLE, tested). Memory-only provider declares `durable:false` and promises nothing (tested). Local-only storage never claims multi-host (owner condition, tested).

## 4. Rust-readiness (contract-first)

- Explicit interface (`assertProvider` structural check at the boundary), no hidden global state
  (**injected clock is mandatory** — `createLocalStorage({})` throws; persistence injected),
  deterministic given clock + inputs, stable typed error codes, values opaque bytes.
- Parity replay: the conformance battery in `conformance.mjs` is the executable spec a Rust port
  must pass unchanged; persistence payload format `{v: 1, namespaces}` is the migration/parity
  representation (upgrade-compatible: version tag, explicit rejection of foreign shapes).

## 5. Consumer boundary (owner requirement: consumers never import provider internals)

The storage handle exposes exactly: `get, put, delete, list, putIfVersion, deleteIfVersion,
applyBatch, touch, capabilities` (pinned by test). Providers are wired through `createStorage`
(validation + error mapping at the boundary). P5-M05 will consume this handle only.

## 6. Test counts + verification

New: `lego-storage-contract.test.mjs` 14 tests + `lego-storage-conformance.test.mjs` 2 tests
(1 full battery of 15 named conformance cases incl. mid-batch atomicity + TTL visibility + CAS +
list bounds + capability honesty; 1 meta-proof that a broken provider FAILS the harness).
Regression: lego suite 2925/2925 (2909 + 16), engine 49/49, runtime 79/79, frontend 672/672,
lego:gate 0, isolation:check 0, decisions-check 0, ai:check 0 (post-merge counts recorded in the
register reconcile).

## 7. Deviations / known limits (explicit)

- `list` cursor is per-namespace opaque; cursors are positional (fine for the local provider; a
  shared provider may re-shape the token as long as it stays opaque — contract-compatible).
- Multi-key cross-namespace batches are allowed (ops carry their own namespace) but atomicity
  covers the batch as a whole.
- The conformance harness checks durability/restart only when a persistence adapter is supplied
  (memory-only providers honestly promise nothing).

## 8. Rollback path

Remove `src/lego/storage/` + the two test files; no schema/data migration, no consumer depends on
it yet (P5-M05 wires in its own slice).
