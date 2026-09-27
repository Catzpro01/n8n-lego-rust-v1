# P8-S01 Storage Foundation - Provider-Neutral Contract (REQ-0003 section 8)

**Status:** specification prepared (P8-S01 remains a placeholder; P8-S02..P8-S07 PROPOSED)
**Purpose:** define the smallest provider-neutral persistence contract required by
P5-M05 and by every backing model in P5-M10-DECOMPOSITION.md. This document is the
authorization path artifact; it is **not** delivery.

## Contract semantics (mandatory definitions)

1. **Key/value semantics.** Namespaced keys (`namespace` + `key`), values opaque to the
   provider. Operations: `get`, `put`, `delete`, `list(namespace, cursor, limit)`.
   `list` is bounded; unbounded enumeration is not part of the contract.
2. **Namespace.** Every key lives in exactly one namespace. Namespace names are
   caller-declared and provider-validated (charset + length). Cross-namespace reads
   do not exist.
3. **Atomicity.** Single-key `put`/`delete` are atomic. Multi-key batch apply is
   all-or-nothing (`applyBatch(ops)`), or the contract explicitly reports partial
   failure with the exact failed ops (never silent partial apply).
4. **TTL.** Per-key expiry (`ttlSeconds` at `put`; `touch` to refresh). Expired keys
   behave as absent for `get` and are excluded from `list`. Eviction timing is
   provider-defined but visibility is contract-defined: expiry is observed by
   callers, never silently kept readable past TTL.
5. **Compare-and-set (CAS).** `putIfVersion(key, value, expectedVersion)` and
   `deleteIfVersion`. Versions are opaque monotonic tokens per key. CAS failure is a
   first-class result (not an error to swallow), enabling locks and counters safely.
6. **Serialization.** Values are byte blobs to the provider. Callers own
   serialization format and versioning; the contract never interprets value bytes.
   (Serialization of store records is a store-layer concern, defined per model.)
7. **Failure behavior.** Every operation returns success or an explicit typed error
   (TIMEOUT, UNAVAILABLE, CONFLICT, NOT_FOUND, INVALID). No silent retries inside the
   contract; retry policy is a caller concern. Errors never masquerade as empty reads.
8. **Consistency.** Baseline: read-your-writes per key within a session. Monotonic
   reads per key. Cross-key ordering is not promised outside `applyBatch`.
9. **Concurrency.** `put` last-writer-wins per key with version bump; mutual exclusion
   is built from CAS (documented pattern), not assumed. Multi-host race outcomes are
   the same as single-host outcomes at the contract level.
10. **Recovery.** After provider restart, committed writes that were acknowledged
    remain visible (durable acknowledgement semantics). If a provider cannot promise
    durability it must declare that in its capability profile; callers relying on
    durability must check the profile. Local-only storage MUST NOT claim multi-host
    semantics (owner condition).

## Test harness (P8-S07)

A conformance suite any provider must pass: TTL visibility, CAS success/conflict,
batch atomicity (including mid-batch failure injection), list bounds, typed error
mapping, restart/recovery behavior. The harness is the acceptance gate for P8-S06
(local reference provider) and for any future provider.

## Decomposition

P8-S01 stays the umbrella placeholder. The parts are P8-S02 (key/value semantics),
P8-S03 (TTL), P8-S04 (atomic operations), P8-S05 (concurrency semantics), P8-S06
(local reference provider), P8-S07 (conformance harness) - all **PROPOSED**.

## Authorization request

P8 placeholders need a Manager Master Prompt / owner authorization before any work.
Requested: authorize P8-S02 + P8-S03 + P8-S07 first (contract core + TTL + harness)
as the smallest testable vertical; P8-S04/P8-S05 semantics land with it; P8-S06 is
the provider that proves the contract. Until then P5-M05 and P5-M11..P5-M16 stay
blocked on this contract.
