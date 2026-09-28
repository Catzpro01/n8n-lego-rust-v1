# P2-S16 Connections Surface Pilot - Delivery Evidence

**Slice:** P2-S16 (Layer 3 surface split out of P2-S03; master prompt REQ-0003
section 6: frontend surface migration only)
**Scope:** packages/frontend-lego/src/connections.mjs + test/53-connections.test.mjs + manifests
**Mode:** pilot; rollback pilot-not-primary; the original n8n editor stays the default path

## Out of scope (stated, not touched)

Workflow-graph persistence (reconnect/remove are DECLARED requests; the app
layer writes), engine execution and run state, the canvas rendering region
(Issue #240 ui.editor.canvas, delivered as P2-S14 - this slice is the
connection list/inspector over the handed-over records), dynamic connection
rules beyond the declared type subset (the full n8n connection type zoo stays
with the reference - recorded as evidence), auto-layout and connection
pathfinding geometry, and the workflow record itself (the workflow capability
owns it). No backend dependency was built; rollback needs none.

## Security boundary (the load-bearing rule)

**The workflow document never changes inside this surface.** Connection
records and the node-id vocabulary arrive in ONE hand-over payload
(`loadSuccess({connections, nodeIds})`); the surface performs no fetch,
**issues no engine call** (`issuesEngineCall: false`) and **never writes the
workflow** (`issuesWorkflowSave: false`): `select-connection` is view state,
while `reconnect` / `remove-connection` are DECLARED requests with closed
result vocabularies (`accepted | unknown-connection | unknown-node |
duplicate-connection | not-ready` and `accepted | unknown-connection |
not-ready`) - the handed-over connection list is byte-identical after every
interaction (pinned by group A/E). A payload envelope carrying secret or
session material is refused with an explicit security error; there is no
`eval(` and no `new Function` in the module (static check).

## What shipped (one surface = one delivery scope)

- **Hand-over boundary (CP-01).** The panel renders the handed-over records
  only; `inputBoundary` is `{source: hand-over, entryPoint: loadSuccess,
  issuesEngineCall: false, issuesWorkflowSave: false, carriesSecrets: false}`.
  Closed shapes: connection `{id, source, target, type}` (unique ids; endpoint
  `{node, port}` with non-negative integer port; every endpoint resolves
  against the handed-over node vocabulary or the hand-over is refused);
  closed vocabularies: connection types `main | ai_tool | ai_memory |
  ai_embedding | ai_vector`, actions `refresh | select-connection | reconnect
  | remove-connection`, empty reason `none`. REGION_STATES pinned exactly.
- **Pilot mode + rollback (CP-02).** New inventory entry `ui.editor.connections`
  (category `connections`) in `pilot-available` / `consuming` / `rollback
  pilot-not-primary` with `sourceIssue 240`, `slice P2-S16`, `surfaceIds
  [connections]` and test/53 as evidence; surface `connections` declared in
  `manifest/surfaces.json` (kind panel, backend workflow - the graph record
  stays behind the capability); capability `connections`
  (`./src/connections.mjs`, degradation fallback `native-behavior` - without
  the capability the reference n8n connection list remains primary). Pinned
  by group B; boot descriptor baseline refreshed 18,855 -> 19,233 bytes
  (measured, pinned in test/32 + test/34); surface catalog 14 -> 15
  (frontend.boundary); derived workflow-capability surface set +connections
  (test/14 negotiation).
- **Parity against the reference (CP-03).** All four region states are
  parity-equivalent to the deterministic reference fixtures through the
  existing parity harness; the per-state action rule (`connectionActionsFor`)
  is SHARED by the view-model and the reference fixtures. A divergence fails
  closed to a recorded diff (tampered interaction -> non-equivalent with
  diffs; invalid observations throw `ParityError`).
- **Accessibility (CP-04).** `CONNECTION_A11Y` derived once: `list` landmark
  + polite on ready, `status` + assertive only on error, busy only on
  loading; focus order is stable and complete (every visible connection in
  handed-over order, selection never reorders); aria labels declared once in
  `CONNECTION_LABELS`; loading/empty/error reuse the shared interaction
  primitives (error -> exactly the retry affordance, empty -> refresh only);
  a change announces the selected connection id.
- **Budgets + failure behaviour (CP-05).** Bounded visible list (default 30,
  hard max 100, truncation reported); measured render cost (300 connections
  x20 renders < 250 ms, recorded in test/53); failure is an explicit error
  region with a retry affordance and a recovery path, never a silent blank;
  degraded mode counts every undeliverable interaction instead of failing
  silently; a workflow with no connections is empty with reason `none` - no
  fifth state; malformed arguments throw (programmer error), domain outcomes
  are the closed results (unknown node, duplicate, not-ready).

## Divergences from the reference (recorded, never hidden)

1. **Declared type subset.** The reference carries a larger connection-type
   zoo; this slice pins the declared subset `main | ai_tool | ai_memory |
   ai_embedding | ai_vector` and refuses other types fail-closed. Remaining
   types stay with the reference until an authorized slice extends the
   vocabulary.
2. **Requests are declared, not executed.** The reference editor rebinds and
   removes edges directly on the graph; the pilot never touches the records -
   `reconnect` / `remove-connection` answer with closed results and the app
   layer performs the write. The connection list on screen is byte-identical
   after every interaction (safety divergence in the strict direction).
3. **Endpoint ports are integer indexes.** The reference models main-output /
   input indexes plus type-specific payloads; the pilot pins
   `{node, port: non-negative integer}` for every connection type and refuses
   type-specific endpoint payloads (no hidden coercion).

## Verification

- test/53-connections.test.mjs: 18/18 (groups A-E map to CP-01..05).
- Frontend suite after the change: 808 tests, 807 pass, 0 fail, 1 skip
  (includes refreshed pins: pilot sets in test/37 + test/39, boot payload
  baseline 19,233 in test/32 + test/34, surface catalog 15 in
  frontend.boundary, workflow-capability surfaces in test/14, card budget
  8,704 with card.md 8,222 B, curated capability index 22 declared).
