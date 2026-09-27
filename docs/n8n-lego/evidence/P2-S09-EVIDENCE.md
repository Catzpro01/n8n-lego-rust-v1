# P2-S09 Credentials List Pilot - Delivery Evidence

**Slice:** P2-S09 (Layer 4 surface split out of P2-S03; master prompt REQ-0004
sections 2-3: frontend surface migration only)
**Scope:** packages/frontend-lego/src/credentials.mjs + test/46-credentials.test.mjs + manifests
**Mode:** pilot; rollback pilot-not-primary; the original n8n editor stays the default path

## Out of scope (REQ-0004 section 3) - stated, not touched

P5 credential runtime, SecretRef runtime, the credential broker implementation,
credential persistence architecture, the P6 credential-consuming node, P8
storage, and any backend Rust credential implementation are NOT part of this
slice. No backend dependency was built. The P5 credential security boundary is
finding-only here - never modified.

## Security boundary (the load-bearing rule)

**Credential values never reach the surface.** The handed-over row shape is
identity metadata only (id, name, type, createdAt, shared). A row carrying a
value-bearing field (value/values/data/password/token/secret/oauthToken/
encrypted/key) is refused with an explicit security error, never silently
dropped. The value-entry editor and the P5/P2.27 envelope stay with the
reference UI and the credential runtime. Pinned by the three refusal tests in
test/46-credentials.test.mjs.

## What shipped (one surface = one delivery scope)

- **Hand-over boundary (CP-01).** Rows enter only through `loadSuccess()`; the
  surface never fetches /rest/credentials and never mutates credential data -
  create/delete/share are declared interactions with the closed
  `requested | unknown-id | not-ready` result vocabulary. States pinned to
  REGION_STATES exactly (filtered-to-zero = empty/filtered, no fifth state).
- **Pilot + rollback (CP-02).** `ui.credentials.list` upgraded to
  `pilot-available` / `consuming` / `rollbackStrategy: pilot-not-primary` (the
  notes keep the P5 finding-only boundary statement); `credentials` capability
  degrades to `native-behavior`.
- **Parity, fail-closed (CP-03).** Loading/empty/ready/error parity-equivalent
  to deterministic reference fixtures; drift = migration-required; incomparable
  throws.
- **Accessibility (CP-04).** `CREDENTIALS_A11Y` derived once; only error is
  aria-live assertive, only loading is aria-busy.
- **Bounds, filter, requests, failure (CP-05).** Bounded list (maxVisible 20
  default, hard max 50) with observable truncation; the visibility filter
  (all/shared/private) is the one observable mutation (closed vocabulary,
  narrow/clear); failure is explicit (error region + refresh retry; loadFailure
  requires an error object); degraded mode observable.

## Test evidence

`packages/frontend-lego/test/46-credentials.test.mjs` - 20 tests covering the
five checkpoints (including the three value-refusal security tests). Frontend
LEGO suite: 672/672 green with the manifest tripwires updated to declare this
pilot; .ai/frontend/card.md kept within its 8192 B budget (budget untouched).

## Verified on

main parent `1ad9e2c4` (pointer-repair baseline); delivery merges as recorded in
the slice's mergeSha.
