# P2-S29 Approvals and Artifacts Pilot - Delivery Evidence

**Slice:** P2-S29 (Layer 5 surface split out of P2-S03; master prompt REQ-0003
section 6: frontend surface migration only, one surface = one delivery scope.
FINAL P2 slice of the queue.)
**Scope:** packages/frontend-lego/src/approvals-artifacts.mjs + test/66-approvals-artifacts.test.mjs + manifests
**Mode:** pilot; rollback pilot-not-primary; the original n8n editor stays the default path

## Out of scope (stated, not touched)

**Writing a decision anywhere.** `request-approve` / `request-reject` are
DECLARED actions that go "through the declared action path" (CP-01): the
surface records the request and announces it; it NEVER flips an approval's
status, never persists a decision, and the fresh hand-over carries the new
state (outcome arrives from the approval capability, never from this
surface). Artifact bytes are never read, uploaded or deleted: the review
list is a handed-over index. No backend dependency; rollback needs none.

## Security boundary (the load-bearing rule)

**There is no second source of truth for approval or artifact state.**
Everything is HANDED OVER; the surface performs no fetch, never reads
window/location/history, never mutates a record (field-write scan count 0;
records byte-identical after every declared request), never shells out,
never dynamically imports a driver, contains no evaluator, and never
writes a decision to any store. Secret-bearing envelope keys (tokens,
credentials, cookies) are refused with an explicit security error, never
dropped. `issuesWorkflowSave: false`, `issuesEngineCall: false`.

## What shipped (one surface = one delivery scope)

- **Hand-over boundary (CP-01).** `inputBoundary`
  `{source: hand-over, entryPoint: loadSuccess, issuesEngineCall: false,
  issuesWorkflowSave: false, carriesSecrets: false}`. Closed shapes: payload
  exactly `{approvals, artifacts}`; an approval exactly
  `{approvalId, artifactId, status}` with `status` QUOTED from
  `decisionApprovalState` (not-required | pending | granted | denied);
  an artifact exactly `{artifactId, name, kind, retention}` with `kind`
  QUOTED from `artifactKind` (8 locked kinds) and `retention` QUOTED from
  `artifactRetention` (ephemeral | session | retained | pinned); name <=
  120; unique ids. Closed actions `refresh | request-approve |
  request-reject`; request results `accepted | unknown-approval |
  invalid-state | not-ready` (only a `pending` approval is actionable);
  empty reason `none`. REGION_STATES pinned exactly (4 states).
  One dedicated test suite `packages/frontend-lego/test/66-approvals-artifacts.test.mjs`
  pins the boundary and the closed shapes (18/18, tests A-E).
- **Pilot mode + rollback (CP-02).** Inventory entry `ui.approvals.artifacts`
  (32nd, NEW category `approvals-artifacts`) with `migrationStatus
  pilot-available` / `contractStatus consuming` / `rollback
  pilot-not-primary` / `sourceIssue 240` / `slice P2-S29` / `surfaceIds
  [approvals-artifacts]`, no dependencies, test/66 as evidence; capability
  `approvals-artifacts` (35th, `./src/approvals-artifacts.mjs`, fallback
  `native-behavior`). Surface `approvals-artifacts` declared (27th, backend
  none, route `/approvals`).
- **Parity vs reference (CP-03).** Four fixtures - loading, empty
  (reason `none`), ready, error - compared fail-closed by
  `compareObservations`; a tampered interaction set reports a
  non-equivalent status with the diff kept as evidence; non-member
  vocabularies throw.
- **Accessibility (CP-04).** `APPROVALS_ARTIFACTS_A11Y` derived once per
  state (ready = form / polite / not busy; error = status / assertive;
  loading = busy) and read back by the view-model; focus order =
  `view:approvals`, `view:artifacts`, `approval:<approvalId>`,
  `artifact:<artifactId>` in hand-over order - rows never reorder; labels
  declared once (approve/reject/refresh + views); shared primitives:
  approve/reject never offered unless ready, error offers exactly
  `refresh`.
- **Bounds + failure (CP-05).** Approval queue window 30 visible / hard
  cap 100 keeping the NEWEST rows with truncation REPORTED (the artifact
  review index is shown in full with `artifactCount`); name <= 120;
  measured render: 200 approvals x 20 displayModel() < 250 ms;
  `loadFailure` yields an explicit error region with kind + retry, never a
  blank; degraded render counts every lost load/approve/reject as
  `degradedEvents`.

## Verification (all measured, not asserted from memory)

- test/66: 18/18 pass (A x6, B x2, C x2, D x3, E x5).
- FE battery: 1042 tests - 1041 pass / 1 skipped / 0 fail (1024 -> 1042, +18).
- Boot payload: re-measured after the manifest injections = 23_262
  (baseline 22_923 -> 23_262, +339), pinned in test32 and test34.
- Manifests: surfaces 26 -> 27, capabilities 34 -> 35, migrations 31 -> 32;
  curated index 34 -> 35 (boot boundary 26 -> 27); categories +1
  (`approvals-artifacts`).
- lego battery: 3088 tests, 0 fail (with N8N_LEGO_CATALOG_DIR set).
- engine battery: run-lego-tests.sh 19/19, 0 fail (after local
  `npm install` in packages/workflow-lego + scripts/setup-reference-runtime.sh
  + workflow-lego:build; environment prerequisites restored, not code).
- runtime battery: 79 tests, 0 fail.
- ai-pack projection regenerated from milestones.json after cp_done
  (README + .ai/master views are generated, never hand-edited).

## Divergences from the reference n8n (4, each justified)

1. **Decisions are never written locally.** The reference applies an
   approval immediately in the UI. This surface only DECLARES
   `request-approve` / `request-reject` (results `accepted |
   unknown-approval | invalid-state | not-ready`, only for `pending`
   rows) and reports the announcement; the status change arrives via a
   fresh hand-over from the approval capability - no local flip, no
   optimistic state, no persistence (CP-01's declared action path).
2. **Quoted vocabularies instead of a local view vocabulary.** Approval
   state, artifact kind and retention are re-exported verbatim from
   vocabulary.mjs (`decisionApprovalState`, `artifactKind`,
   `artifactRetention`) - no second status architecture.
3. **Settings are hand-over options, not persisted.** `maxVisible`
   (default 30, clamped to 100) and `nameLimit` (120) are constructor
   options; nothing writes to n8n settings.
4. **Ordering is hand-over order.** The reference sorts the queue by
   wall-clock/risk. The surface keeps the handed-over order for focus
   stability; the deliverer owns the ordering and the window takes the
   newest tail of whatever order arrives.

## Rollback

One-line: remove the `approvals-artifacts` capability row +
`approvals-artifacts` surface row + flip `ui.approvals.artifacts.migrationStatus`
to `pilot-unavailable` (and drop the `approvals-artifacts` category if it
carries no other entry). No data migration, no backend dependency; the
reference editor remains the default path throughout.
