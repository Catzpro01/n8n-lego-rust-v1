# P7-S08 — Differential Certification

**Issue:** #223 §37-38, §40-41, §42 rung P7.8 (authorized by DEC-0024)
**Status:** in-progress until delivery merge + post-merge verification (DEC-0014, DEC-0015)
**Branch:** `delivery/p7-s08-differential-certification`
**Contract:** domain `dynamic-parameters` (owner `agent-4`), module `src/lego/parameter-certify.mjs`
**Gate:** DEC-0025 temporary gate in force (self-hosted fleet offline; GitHub-hosted green is the effective merge gate)

## 1. What was delivered

`apps/n8n-lego/src/lego/parameter-certify.mjs`: the **certification** slice — it makes P7's
correctness a repeatable, deterministic record by comparing P7 output against pinned n8n behavior
(the differential oracle, §40), pinning the 20-case mandatory negative/security matrix (§41), and
enforcing the low-resource performance target (§37-38). P7 never hardcodes vendor internals: the
oracle is an explicit, injectable, pinned reference (pinned n8n-workflow 2.9.1).

| #223 § | Requirement | Where it is met |
|---|---|---|
| §40 | compare P7 against pinned n8n for the 12 aspects (visibility, defaults, options, dynamic options, dependent fields, resourceLocator, pagination, validation, error behavior, normalization, expression-dependent fields, credential-aware lookups); classify every difference as equivalent / compatible-improvement / migration-required / breaking | `DIFFERENTIAL_ASPECTS` (the 12) + `classifyDifference`: canonical-JSON equal → EQUIVALENT; P7 a strict superset of the oracle → COMPATIBLE_IMPROVEMENT; P7 drops oracle data (subset) → BREAKING; same shape, different value → MIGRATION_REQUIRED. The oracle is an injectable, pinned reference |
| §40 | a certification is a record, not a hand-wave | `certify(cases)` → a frozen report `{ format, pinnedN8nVersion, certified, total, differences, breaking }`; `certified` is true ONLY when no difference is BREAKING (the breaking set is explicitly enumerated) |
| §41 | the 20 mandatory negative/security cases | `NEGATIVE_CASES`: a frozen registry of all 20 (cyclic dependency, invalid path, malformed/oversized provider response, excessive result count, timeout, cancellation, stale overlapping response, cache scope collision, wrong tenant, missing capability, provider without permission, credential access without P5, secret leakage through cache, secret leakage through logs, provider forged permission metadata, schema version mismatch, incompatible node definition, unbounded pagination, provider retry storm); `verifyNegativeResult` + `runNegativeMatrix` check each is a marked failure / expected behavior and report coverage + pass |
| §37-38 | the low-resource target (1 vCPU / 1 GB): amortized compilation, bounded cache, bounded provider concurrency, small pages, bounded responses, no persistent polling; P7 degrades before process-level memory pressure | `LOW_RESOURCE_BUDGET` (1 vCPU / 1 GB, compile-once, no persistent polling, bounded cache/concurrency/pages/results/responses) + `checkLowResourceBudget` (verifies a config fits; enumerates violations) |
| (record) | a certification is deterministic + pinned to the n8n version | `certificationFingerprint(report)`: a deterministic fingerprint of the report basis (re-running the same cases + oracle gives an identical fingerprint; a value difference or version change changes the record) |

## 2. Design decisions worth recording

- **The differential oracle is injectable and pinned (§40).** P7 never hardcodes vendor internals —
  the oracle is an explicit, pinned reference (`PINNED_N8N_VERSION = '2.9.1'`). `classifyDifference`
  uses a canonical-JSON superset/subset rule: a strict superset is a *compatible improvement* (P7
  adds, changes nothing observable), dropping oracle data is *breaking* (observable data loss), and
  a same-shape value change is *migration required*. This is the §40 classification, made
  deterministic.
- **Certification is a record, not a boolean (§40).** `certify` returns a frozen report with the
  full difference list and an explicit `breaking` set. `certified` is true only when `breaking` is
  empty — so a certification can be inspected, not just trusted.
- **The negative matrix is a frozen registry of the 20 mandatory cases (§41).** It is not an
  optional list. `runNegativeMatrix` reports coverage + pass and is `complete` only when all 20 are
  covered and passing. Code-based cases check the marked failure code (an unmarked empty success is
  explicitly NOT a pass); behavioral cases (no-leak, no-retry, forged-metadata) check an expected
  behavioral marker.
- **The low-resource budget is a hard target (§37-38).** `LOW_RESOURCE_BUDGET` pins 1 vCPU / 1 GB
  with compile-once, no persistent polling, and bounded cache/concurrency/pages/results/responses.
  `checkLowResourceBudget` enumerates violations so a config that would make P7 a process-level
  memory-pressure source is rejected, not tolerated.
- **Reproducibility (§40 as a gate).** `certificationFingerprint` gives a deterministic fingerprint
  of the report basis, so a certification is a repeatable gate: same cases + oracle → identical
  fingerprint; a value difference or a pinned-version change changes the record.

## 3. Verification

- **New unit suite** `test/lego-parameter-certify.test.mjs`: **16/16 pass**
  (`node --test apps/n8n-lego/test/lego-parameter-certify.test.mjs`).
- **Architecture gate** `npm run lego:arch`: OK — the module is registered in the
  `dynamic-parameters` domain (`manifest/domains.json` `paths` + `contract.tests`), 100 locked
  public contracts, every import respects its declared boundary.
- **Full LEGO gate** `npm run lego:gate`: arch / scaleout / ai:check green (the `lego:test`
  quoted-glob step is a local Node 20 limitation; CI's Node expands it — the full backend suite is
  run directly and is clean).
- **Full backend suite** `node --test apps/n8n-lego/test/`: clean except the pre-existing
  catalog/REST tests that require `N8N_LEGO_CATALOG_DIR` (CI-provided).

## 4. Boundary

P7-S08 is the **certification** semantics (differential oracle, negative matrix, low-resource
budget). It does NOT run the pinned n8n oracle itself (the oracle is injected at the composition
root / CI), does not change Rust, workflow, Cargo, runner, contract, or `packages/` files, and
completes the P7 ladder (P7.1-P7.8).
