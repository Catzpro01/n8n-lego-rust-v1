# P2-S18 Environments Surface Pilot - Delivery Evidence

**Slice:** P2-S18 (Layer 4 surface split out of P2-S03; master prompt REQ-0003
section 6: frontend surface migration only, one surface = one delivery scope)
**Scope:** packages/frontend-lego/src/environments.mjs + test/55-environments.test.mjs + manifests
**Mode:** pilot; rollback pilot-not-primary; the original n8n editor stays the default path

## Out of scope (stated, not touched)

Environment provisioning/creation/deletion and lifecycle transitions, server
or engine authority over environment values (they arrive only through
hand-over), secret material of any kind (refused at both envelopes),
expression evaluation (the surface never evaluates - strings pass through
verbatim to the app layer), workflow save, persistence of any kind (no
localStorage, no writes), routing/navigation between settings pages, and the
reference editor's environment-management chrome (divergence 1 below). No
backend dependency was built; rollback needs none.

## Security boundary (the load-bearing rule)

**There is no second source of truth for environment state.** The environments
list, the active id and the variable records arrive in one hand-over
(`loadSuccess({environments, active, variables})`); the surface performs no
fetch, never reads window/location, **never derives the active environment
locally** (only a fresh hand-over moves it - `request-switch` is a DECLARED
request whose acceptance is app-layer, never optimistic) and **never
persists** variables. A secret-bearing key (top level of the payload, of an
environment record or of a variable record) is refused with an explicit
security error on BOTH the hand-over and any later interaction, never
dropped. `issuesWorkflowSave: false`, `issuesEngineCall: false`.

## What shipped (one surface = one delivery scope)

- **Hand-over boundary (CP-01).** `inputBoundary` is
  `{source: hand-over, entryPoint: loadSuccess, issuesEngineCall: false,
  issuesWorkflowSave: false, carriesSecrets: false}`. Closed shapes: payload
  exactly `{environments, active, variables}` (unknown top-level keys
  refused), an environment is `{id, name, kind}` with kind a member of the
  declared subset `dev | preview | staging` (FUTURE-PLATFORM-F-P15-002), a
  variable is `{name, value, scope}` with scope `all | <environment id>`.
  `active` is a known environment id iff the list is non-empty, else `null`
  (unknown id or non-null with an empty list refuses). Closed vocabularies:
  actions `refresh | set-variable | set-scope | request-submit |
  request-switch`; results `accepted | unknown-variable | not-ready` (+  `invalid-scope` for set-scope, `unknown-environment` for switch);
  empty reason `none`. REGION_STATES pinned exactly. One dedicated test
  suite `packages/frontend-lego/test/55-environments.test.mjs` pins the
  boundary and closed shapes.
- **Pilot mode + rollback (CP-02).** Inventory entry `ui.settings.environments`
  (new, 22nd) with `migrationStatus pilot-available` / `contractStatus
  consuming` / `rollback pilot-not-primary` / `sourceIssue 240` /
  `slice P2-S18` / `surfaceIds [environments]` (the entry's own surfaceIds -
  no second catalog) and test/55 as evidence; capability `environments`
  (24th, `./src/environments.mjs`, degradation fallback `native-behavior` -
  without the capability the reference n8n environments settings remain
  primary). Category `environments` declared; surface migrations entries now
  22. Pinned by test/37 (pilot set, sources, rollback strategy) and test/39;
  pack budget gate green in test/12 (96 KB); boot payload baseline refreshed
  19,233 -> 19,574 bytes (measured, + the environments surface) in test/32 +
  test/34; frontend boundary 15 -> 16.
- **Parity against the reference (CP-03).** All four region states are
  parity-equivalent to the deterministic reference fixtures through the
  existing parity harness; the per-state action rule (`envActionsFor`) is
  SHARED by the view-model and the reference fixtures (reference fixtures
  call the same exported rule - a divergence fails closed to a recorded
  diff).
- **Accessibility (CP-04).** `ENV_A11Y` derived once: `form` landmark +
  polite on ready (empty when not ready), stable focus order `environment
  ids -> scoped variables -> submit iff dirty` (re-derived, never mutated in
  place), aria labels declared once in `ENV_LABELS`, submit announces the
  submitted variable set, loading/empty/error reuse the shared interaction
  primitives; `ready -> not-ready` is guarded (controls report `not-ready`,
  never a phantom success).
- **Budgets + failure behaviour (CP-05).** Bounded visible lists (variables
  default 30, hard max 100, truncation reported; environments max 30);
  measured render cost (200 variables x20 renders < 250 ms); failure is an
  explicit error region with a retry affordance and a recovery path, never a
  silent blank; degraded mode counts every undeliverable interaction; a
  configuration with no environments is empty with reason `none` - no fifth
  state; malformed arguments throw (programmer error), domain outcomes are
  the closed results.

## Divergences from the reference (recorded, never hidden)

1. **Active never moves locally.** The reference switches the active
   environment optimistically; the pilot issues `request-switch` and moves
   `active` only when a fresh hand-over delivers it (strict hand-over
   divergence - authority stays with the app layer).
2. **Expressions are inert strings.** The reference evaluates
   `={{ $env.X }}` in its expression chrome; the surface passes expression
   strings VERBATIM (no eval, no new Function, static check in test/55) -
   evaluation belongs to the engine/app layer.
3. **Submit only when dirty.** Dirty is computed against the last hand-over
   (`originalVariables`); a submit with no changes returns `no-changes` -
   the reference posts on every save click.
4. **Scope filter is active-scoped.** The variable table shows variables
   scoped to `all` or to the ACTIVE environment only; managing another
   environment's scope requires switching (app-layer hand-over) first.

## Verification

- test/55-environments.test.mjs: 18/18 (groups A-F map to CP-01..05 +
  expression-verbatim).
- Frontend suite after the change: 844 tests, 843 pass, 0 fail, 1 skip
  (includes refreshed pins: boot 19,574 in test/32 + test/34, pilot sets in
  test/37 + test/39, frontend boundary 16, card 8,258/8,704, capabilities 24
  declared, surface-migrations 22 entries).
- Battery: lego 3088/3088, engine 49/49, runtime 79/79, frontend 843/0/1,
  governance 117/117, gates 7/7.
