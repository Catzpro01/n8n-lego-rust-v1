# P2-S10 Settings Panels Pilot - Delivery Evidence

**Slice:** P2-S10 (Layer 4 surface split out of P2-S03; master prompt REQ-0003
section 6: frontend surface migration only)
**Scope:** packages/frontend-lego/src/settings.mjs + test/47-settings.test.mjs + manifests
**Mode:** pilot; rollback pilot-not-primary; the original n8n editor stays the default path

## Out of scope (stated, not touched)

The settings write runtime, secret-valued settings (SMTP credentials, API keys,
MFA material), the P2.27/P5 secret-handling boundary (finding-only here - never
modified), users/admin pages beyond the panels view-model, localization and
theme (later authorized slices per the inventory note). No backend dependency
was built.

## Security boundary (the load-bearing rule)

**Secret material never reaches the surface.** An entry carrying a
secret-bearing field (`password`, `token`, `apiKey`, `secret`, `smtpPass`,
`privateKey`, ...) is refused with an explicit security error, never silently
dropped; a non-scalar `value` is refused for the same reason (a structured value
could smuggle secret material). Settings values arrive through declared
settings capabilities only (hand-over), and the surface holds no private data
path and no second source of truth. Pinned by the refusal tests in
test/47-settings.test.mjs (group A).

## What shipped (one surface = one delivery scope)

- **Hand-over boundary (CP-01).** Entries enter only through `loadSuccess()`;
  the surface never fetches settings and never mutates settings data - save and
  reset are declared interactions with the closed
  `requested | unknown-id | not-ready` result vocabulary. States pinned to
  REGION_STATES exactly (a panel with no entries is empty/filtered, no fifth
  state). Closed vocabularies: panels `instance | personal`, actions, request
  results, empty reasons.
- **Pilot + rollback (CP-02).** `ui.settings.pages` upgraded
  `reference-only -> pilot-available` / `contractStatus: consuming` /
  `rollbackStrategy: pilot-not-primary` in surface-migrations.json (the entry
  pre-existed the slice; this upgrades it in place, keeping its
  `ui.shell.navigation` dependency). The `settings` capability is declared in
  capabilities.json (`entry: ./src/settings.mjs`, degrades to
  `native-behavior`, message slot `settings` - the slot is owned exclusively,
  matching the catalog rule). Both manifests are pinned by the group-B tests
  and the closed pilot set in test/37 and test/39.
- **Parity, fail-closed (CP-03).** Loading/empty/ready/error parity-equivalent
  to deterministic reference fixtures for every declared region; drift =
  migration-required; incomparable throws. The reference fixtures derive their
  interactions from the SAME `settingsActionsFor` rule the view-model uses, so
  the two sides cannot drift by construction.
- **Accessibility (CP-04).** `SETTINGS_A11Y` derived once; only error is
  aria-live assertive, only loading is aria-busy; the ready form is announced
  politely.
- **Bounds, panel switch, requests, failure (CP-05).** Bounded visible list
  (maxVisible 20 default, hard max 50) with observable truncation; the panel
  switch (instance / personal) is the one observable mutation (closed
  vocabulary, narrow/back, filtered-to-zero = empty reason `filtered`); failure
  is explicit (error region + refresh retry; loadFailure requires an error
  object); degraded mode observable; history deterministic.

## Test evidence

`packages/frontend-lego/test/47-settings.test.mjs` - 21 tests covering the five
checkpoints (including the secret-refusal security tests). Frontend LEGO suite:
694/694 green (673 + 21). `.ai/frontend/card.md` names the module (8190 B of
its 8192 B budget); the curated capability index `.ai/index/capabilities.json`
declares the pilot (curated files are hand-maintained by design).

## Findings recorded (finding-only, not fixed here)

1. **Declaration shadows backend advertisement** (negotiation resolve order:
   registered > declared > backend-advertised). The P2-S09 credentials pilot
   already declared `credentials` over the backend-advertised `credentials`;
   P2-S10 does the same for `settings`. The negotiation/degradation fixtures
   that used `settings` as a backend-only probe moved to `workflow` (still
   backend-only) with the same assertions - the tests' intent (exercise the
   backend-advertised path) is unchanged. A future slice may want explicit
   merge semantics for dual-origin capabilities; that is a negotiation contract
   change and is out of this slice.
2. **Register writer fidelity gate caught a format drift**: the START commit's
   `latestUpdate` text used a literal em-dash where the surgical writer emits
   `\u2014`; the round-trip test (live-progress.test.mjs) failed and the text
   was repaired to the as-filed convention in this delivery. The START commit
   had been validated only with the register suite (not the full battery) -
   recorded so the gap is not repeated.

## Verified on

full battery on the delivery worktree: lego 3071/3071, engine 19/19, runtime
79/79, frontend 694/694, gates 7/7, ai-pack in sync, register validate clean;
delivery merges as recorded in the slice's mergeSha.
