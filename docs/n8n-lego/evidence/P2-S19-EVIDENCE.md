# P2-S19 Integrations Surface Pilot - Delivery Evidence

**Slice:** P2-S19 (Layer 4 surface split out of P2-S03; master prompt REQ-0003
section 6: frontend surface migration only, one surface = one delivery scope)
**Scope:** packages/frontend-lego/src/integrations.mjs + test/56-integrations.test.mjs + manifests
**Mode:** pilot; rollback pilot-not-primary; the original n8n editor stays the default path

## Out of scope (stated, not touched)

Package download/installation mechanics (the P6 admission path owns them -
this surface only declares the request), integration authentication and
credential material (refused at both envelopes), server-side integration
registries (they arrive only through hand-over), workflow data of any kind,
persistence of any kind (no localStorage, no writes), routing, and the
reference editor's community-nodes chrome (divergence 1 below). No backend
dependency was built; rollback needs none.

## Security boundary (the load-bearing rule)

**There is no second source of truth for integration state.** The integration
records and the active id arrive in one hand-over
(`loadSuccess({integrations, active})`); the surface performs no fetch, never
reads window/location, **never derives the active integration locally**
(only a fresh hand-over moves it - `request-activate` is a DECLARED request),
**never installs** (`request-install` is DECLARED: it has NO accepted result,
every install lands behind the P6 admission path, and the handed-over
`installed` flags never change inside the surface) and never persists
anything. Secret-bearing keys are refused with an explicit security error on
the hand-over, never dropped. `issuesWorkflowSave: false`,
`issuesEngineCall: false`.

## What shipped (one surface = one delivery scope)

- **Hand-over boundary (CP-01).** `inputBoundary` is
  `{source: hand-over, entryPoint: loadSuccess, issuesEngineCall: false,
  issuesWorkflowSave: false, carriesSecrets: false}`. Closed shapes: payload
  exactly `{integrations, active}`; a record is `{id, name, source,
  installed}` with source a member of the declared subset
  `community | private | custom` and installed a boolean. `active` is a known
  id iff the list is non-empty, else `null` (both directions refuse).
  Closed vocabularies: actions `refresh | request-activate |
  request-install`; activate results `accepted | unknown-integration |
  not-ready`; install results `admission-required | unknown-integration |
  already-installed | not-ready` (NO accepted - admission is never
  bypassable); empty reason `none`. REGION_STATES pinned exactly. One
  dedicated test suite `packages/frontend-lego/test/56-integrations.test.mjs`
  pins the boundary and closed shapes (18/18).
- **Pilot mode + rollback (CP-02).** Inventory entry `ui.integrations.manage`
  (new, 23rd, category `integrations` added to the closed category
  vocabulary) with `migrationStatus pilot-available` / `contractStatus
  consuming` / `rollback pilot-not-primary` / `sourceIssue 240` /
  `slice P2-S19` / `surfaceIds [integrations]` and test/56 as evidence;
  capability `integrations` (25th, `./src/integrations.mjs`, degradation
  fallback `native-behavior` - without the capability the reference n8n
  integrations view remains primary). Surface `integrations` declared
  (17th surface, backend none/endpoints [] - dialogs precedent, route
  `/settings/integrations`). Pinned by test/37 (pilot set, sources 16x240,
  rollback strategy) and test/39; curated index 25 declared; boot payload
  baseline refreshed 19,574 -> 19,934 bytes (measured, + the integrations
  surface) in test/32 + test/34; frontend boundary 16 -> 17; card
  8,275/8,704.
- **Parity against the reference (CP-03).** All four region states are
  parity-equivalent to the deterministic reference fixtures through the
  existing parity harness; the per-state action rule
  (`integrationsActionsFor`) is SHARED by the view-model and the reference
  fixtures - a divergence fails closed to a recorded diff.
- **Accessibility (CP-04).** `INTEGRATION_A11Y` derived once: `form`
  landmark + polite on ready, `status` + assertive only on error, busy only
  on loading; focus order is `integration ids (hand-over order) -> install
  iff the active integration is not installed`, stable across interactions;
  aria labels declared once in `INTEGRATION_LABELS`; activation announces
  the integration id; loading/empty/error reuse the shared interaction
  primitives; `ready -> not-ready` is guarded.
- **Budgets + failure behaviour (CP-05).** Bounded list (default 30, hard
  max 100, truncation reported); measured render cost (200 integrations x20
  renders < 250 ms); failure is an explicit error region with a retry
  affordance and a recovery path, never a silent blank; degraded mode counts
  every undeliverable interaction; a workflow with no integrations is empty
  with reason `none` - no fifth state; malformed arguments throw
  (programmer error), domain outcomes are the closed results.

## Divergences from the reference (recorded, never hidden)

1. **Admission, not install.** The reference editor installs a community
   package directly; the pilot issues `request-install` and answers
   `admission-required` - the P6 admission path (app layer) performs the
   installation and confirms via a fresh hand-over (strict divergence -
   authority stays outside the surface, `installed` is byte-identical after
   every interaction).
2. **Active never moves locally.** The reference switches selection
   optimistically; the pilot's `request-activate` is a DECLARED request and
   only a fresh hand-over moves `active` (no second source of truth).
3. **Source subset.** The reference renders the full source zoo (marketplace
   metadata, ratings, downloads); the pilot renders the declared subset
   community | private | custom with `{id, name, source, installed}` only -
   richer marketplace chrome stays with the reference.
4. **Empty-region actions.** The reference can search/install from an empty
   view; the pilot's empty region offers `refresh` only (shared per-state
   primitive) until an authorized slice extends the rule.

## Verification

- test/56-integrations.test.mjs: 18/18 (groups A-F map to CP-01..05 +
  admission boundary).
- Frontend suite after the change: 862 tests, 861 pass, 0 fail, 1 skip
  (includes refreshed pins: boot 19,934 in test/32 + test/34, pilot sets in
  test/37 + test/39, frontend boundary 17, curated index 25, card
  8,275/8,704, category vocabulary +integrations).
