# P2-S20 Execution Management Surface Pilot - Delivery Evidence

**Slice:** P2-S20 (Layer 4 surface split out of P2-S03; master prompt REQ-0003
section 6: frontend surface migration only, one surface = one delivery scope)
**Scope:** packages/frontend-lego/src/execution-mgmt.mjs + test/57-execution-mgmt.test.mjs + manifests
**Mode:** pilot; rollback pilot-not-primary; the original n8n editor stays the default path

## Out of scope (stated, not touched)

Execution engine mechanics (retry/stop are DECLARED requests - the execution
capability / app layer performs them), workflow data of any kind, execution
payloads and logs beyond the closed record shape, persistence of any kind
(no localStorage, no writes), routing, and the reference editor's execution
chrome beyond this panel (divergence 3 below). No backend dependency was
built; rollback needs none.

## Security boundary (the load-bearing rule)

**There is no second source of truth for execution state.** The execution
records arrive in one hand-over (`loadSuccess({executions})`); the surface
performs no fetch, never reads window/location, **never mutates a record**
(no status is ever written locally - status changes arrive only through a
fresh hand-over), never calls the execution capability itself and never
persists. The selection is VIEW state only: it never leaves the surface and
is cleared by every fresh hand-over. Secret-bearing keys are refused with an
explicit security error on the hand-over, never dropped.
`issuesWorkflowSave: false`, `issuesEngineCall: false`.

## What shipped (one surface = one delivery scope)

- **Hand-over boundary (CP-01).** `inputBoundary` is
  `{source: hand-over, entryPoint: loadSuccess, issuesEngineCall: false,
  issuesWorkflowSave: false, carriesSecrets: false}`. Closed shapes: payload
  exactly `{executions}`; a record is `{id, workflowName, status}` with
  status a member of the declared subset
  `success | error | running | waiting`. Closed vocabularies: actions
  `refresh | select | request-retry | request-stop | request-bulk-retry |
  request-bulk-stop`; select/retry/stop results
  `accepted | unknown-execution | invalid-state | not-ready`; bulk results
  `accepted | no-selection | no-retryable | no-stoppable | not-ready`;
  empty reason `none`. REGION_STATES pinned exactly. Retry targets only
  `error`, stop targets only `running | waiting` (both enforced as closed
  results, never silently accepted). One dedicated test suite
  `packages/frontend-lego/test/57-execution-mgmt.test.mjs` pins the boundary
  and closed shapes (18/18).
- **Pilot mode + rollback (CP-02).** Inventory entry `ui.executions.manage`
  (new, 24th, category `execution-history` - existing vocabulary) with
  `migrationStatus pilot-available` / `contractStatus consuming` /
  `rollback pilot-not-primary` / `sourceIssue 240` / `slice P2-S20` /
  `surfaceIds [execution-mgmt]` and test/57 as evidence; capability
  `execution-mgmt` (26th, `./src/execution-mgmt.mjs`, degradation fallback
  `native-behavior`). Surface `execution-mgmt` declared (18th surface,
  backend none/endpoints [] - dialogs precedent, route
  `/executions/manage`). Pinned by test/37 and test/39; curated index 26
  declared; boot payload baseline refreshed 19,934 -> 20,271 bytes
  (measured, + the execution-mgmt surface) in test/32 + test/34; frontend
  boundary 17 -> 18; card 8,294/8,704.
- **Parity against the reference (CP-03).** All four region states are
  parity-equivalent to the deterministic reference fixtures through the
  existing parity harness; the per-state action rule (`execMgmtActionsFor`)
  is SHARED by the view-model and the reference fixtures - a divergence
  fails closed to a recorded diff.
- **Accessibility (CP-04).** `EXEC_MGMT_A11Y` derived once: `form` landmark
  + polite on ready, `status` + assertive only on error, busy only on
  loading; focus order is `execution ids (hand-over order) -> bulk-retry ->
  bulk-stop iff a selection exists`, stable across interactions; aria labels
  declared once in `EXEC_MGMT_LABELS`; selections and requests announce the
  execution id; loading/empty/error reuse the shared interaction primitives;
  `ready -> not-ready` is guarded.
- **Budgets + failure behaviour (CP-05).** Bounded list (default 30, hard
  max 100, truncation reported); measured render cost (200 executions x20
  renders < 250 ms); failure is an explicit error region with a retry
  affordance and a recovery path, never a silent blank; degraded mode counts
  every undeliverable interaction; a workflow with no executions is empty
  with reason `none` - no fifth state; malformed arguments throw
  (programmer error), domain outcomes are the closed results.

## Divergences from the reference (recorded, never hidden)

1. **Declared, not executed.** The reference editor retries/stops an
   execution inline; the pilot issues `request-retry` / `request-stop` /
   `request-bulk-*` and the execution capability (app layer) performs the
   action - the handed-over records are byte-identical after every
   interaction (strict divergence - authority stays outside the surface).
2. **Selection never persists.** The reference keeps a bulk selection
   across navigation; the pilot's selection is view state cleared by every
   fresh hand-over (no second source of truth).
3. **Closed record shape.** The reference renders queue position, timestamps
   and payload previews; the pilot renders `{id, workflowName, status}` with
   the declared status subset only - richer execution detail stays with the
   reference.
4. **Empty-region actions.** The reference can start a workflow from an
   empty execution list; the pilot's empty region offers `refresh` only
   (shared per-state primitive) until an authorized slice extends the rule.

## Verification

- test/57-execution-mgmt.test.mjs: 18/18 (groups A-F map to CP-01..05 +
  declared-never-mutates).
- Frontend suite after the change: 880 tests, 879 pass, 0 fail, 1 skip
  (includes refreshed pins: boot 20,271 in test/32 + test/34, pilot sets in
  test/37 + test/39, frontend boundary 18, curated index 26, card
  8,294/8,704).
