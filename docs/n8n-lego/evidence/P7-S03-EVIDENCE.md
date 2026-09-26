# P7-S03 — Local Validation & Normalization

**Issue:** #223 §20-21, §27, §29-30, §41, §44, §42 rung P7.3 (authorized by DEC-0024)
**Status:** in-progress until delivery merge + post-merge verification (DEC-0014, DEC-0015)
**Branch:** `delivery/p7-s03-validation`
**Contract:** domain `dynamic-parameters` (owner `agent-4`), module `src/lego/parameter-validate.mjs`
**Gate:** DEC-0025 temporary gate in force (self-hosted fleet offline; GitHub-hosted green is the effective merge gate)

## 1. What was delivered

`apps/n8n-lego/src/lego/parameter-validate.mjs`: stage 5 (**VALIDATE**) of the five-stage
P7 pipeline (#223 §4). It is the last *local* stage — it consumes a compiled
`ParameterPlan` plus raw parameter values and performs a cheap, deterministic, pure
local operation. It never crosses a provider/network boundary and never treats a cached
UI value as authority.

| #223 § | Requirement | Where it is met |
|---|---|---|
| §21 | raw → canonicalization → type normalization → validation → canonical value; explicit and testable; no heuristic normalization that changes observable n8n behavior | `normalizeValue`: only the two safe canonicalizations (finite numeric string → number, `'true'`/`'false'` → boolean). Every other value passes through unchanged. Pinned by 4 unit tests. |
| §20 | compact canonical validation vocabulary (type, required, enum, pattern, min/max, length, object property rules); structured errors carry path + code + expected/actual class; no secret material | `validateValue` + `applyRules` + `TYPE_OK`. Every issue is `{ path, code, rule, expected, actual, message }`. The offending value is never embedded (length only, class only, or the declared regex/option). Pinned by 10 unit tests. |
| §27 | closed failure vocabulary; a validation failure is never converted into a fake empty success | `FAILURE_CODES` (11 codes, frozen); `LOCAL_FAILURE_CODES = [SCHEMA_INVALID, DEPENDENCY_INVALID]` are the only codes this stage emits. A failing input keeps its actual values in `normalized` (not blanked). Pinned by 3 unit tests. |
| §29 | compact immutable execution snapshot: schema version, normalized values, unresolved expression refs where allowed, validation status, dependency digest | `buildExecutionSnapshot`: deep-frozen snapshot with `schemaVersion`, `values` (normalized), `unresolvedExpressions`, `validationStatus`, `issueCount`, `dependencyDigest` (SHA-256 over the canonical normalized values). Pinned by 4 unit tests. |
| §30 | canonical vs derived; derived state always reconstructible | the snapshot is DERIVED execution input, never the canonical workflow definition; `reconstructSnapshot` proves a byte-identical re-derivation and that the canonical input is never rewritten. Pinned by a dedicated test. |
| §41, §44 | negative/security matrix; deterministic, pure local operation | absent/missing containers fail safely (no throw, no false success); oversized forms are bounded; sensitive (password) values are validated by shape only and never echoed; the operation is idempotent and pure (input never mutated or frozen). Pinned by 4 unit tests. |

## 2. Design decisions worth recording

- **Absent is not a type error.** A missing value (`undefined`/`null`) is only ever a
  `required` problem, never a `type` problem. This keeps `{ c: {} }` reporting a single
  `required` issue on `c.f` rather than a misleading `type` issue for the absent child.
- **Normalization is two canonicalizations, nothing else.** n8n already stores number
  fields as numbers and boolean fields as booleans; the editor is the only place a
  numeric string or `'true'`/`'false'` appears. Coercing exactly those (and only finite,
  round-tripping numeric strings) preserves observable behavior. Everything else —
  including `'0x10'`, `'42.5.5'`, `'yes'`, `'1'` for a boolean — is left untouched and
  left to the validator to reject, so no silent semantic change can sneak in.
- **The snapshot never aliases the caller's input.** Object/array leaves are deep-copied
  into `normalized` before the snapshot is deep-frozen. Freezing the derived snapshot must
  never freeze (and thereby corrupt) the canonical workflow values. A regression test
  re-derives twice and asserts the input is still mutable and byte-identical.
- **`changed` is bounded.** The list of paths whose value was normalized is capped
  (`maxChanges`, default 4096) so a huge form cannot balloon the telemetry surface.

## 3. Verification

- **New unit suite** `test/lego-parameter-validate.test.mjs`: **30/30 pass**
  (`node --test apps/n8n-lego/test/lego-parameter-validate.test.mjs`).
- **Architecture gate** `npm run lego:arch`: OK — the module is registered in the
  `dynamic-parameters` domain (`src/lego/manifest/domains.json` `paths` + `contract.tests`).
- **Full LEGO gate** `npm run lego:gate`: arch / arch:selftest / foundation /
  foundation:selftest / capabilities / scaleout / ai:check all green.
- **Full backend suite** `node --test apps/n8n-lego/test/`: 2794 pass, 5 fail — the 5 are
  the pre-existing catalog/REST tests that require `N8N_LEGO_CATALOG_DIR` (the fetched
  catalog), which CI provides and this sandbox does not (`N8N_LEGO_CATALOG_DIR must point
  at the fetched catalog (npm run lego:catalog); CI provides it`). Unrelated to this slice.
- **Purity/idempotence:** two calls over the same input give identical normalized values
  and digests; the input is never mutated or frozen (asserted in the suite).

## 4. Boundary

P7-S03 is pure local validation/normalization. It does NOT mount any REST surface (the
`/rest/dynamic-node-parameters` 501 stays until P7-S04), does not touch providers,
credentials, caching, or the expression engine, and changes no Rust, workflow,
Cargo, runner, contract, or `packages/` file.
