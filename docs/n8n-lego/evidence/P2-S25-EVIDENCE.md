# P2-S25 Work Trace Surfaces Pilot - Delivery Evidence

**Slice:** P2-S25 (Layer 5 surface split out of P2-S03; master prompt REQ-0003
section 6: frontend surface migration only, one surface = one delivery scope)
**Scope:** packages/frontend-lego/src/work-trace.mjs + test/62-work-trace.test.mjs + manifests
**Mode:** pilot; rollback pilot-not-primary; the original n8n editor stays the default path

## Out of scope (stated, not touched)

Execution data acquisition, navigation, and persistence of any kind - the
trace arrives via `loadSuccess({events})` and `request-open-event` is
DECLARED with closed results; the capability that owns navigation performs
it. The Workflows/Executions routes, the run detail pane, and every other
trace surface stay with the reference editor (divergences 1, 3, 4). Workflow
data and settings persistence are not touched. No backend dependency;
rollback needs none.

## Security boundary (the load-bearing rule)

**There is no second source of truth for the trace.** Every event is HANDED
OVER; the surface performs no fetch, never reads window/location/history,
never mutates a record (`.(kind|at|label)=(?!=)` count 0, trace byte-identical
after every declared request), never shells out, never dynamically imports a
driver, and contains no evaluator. Secret-bearing envelope and event keys
(session ids, bearer tokens, credentials) are refused with an explicit
security error, never dropped. `issuesWorkflowSave: false`,
`issuesEngineCall: false`.

## What shipped (one surface = one delivery scope)

- **Hand-over boundary (CP-01).** `inputBoundary` is
  `{source: hand-over, entryPoint: loadSuccess, issuesEngineCall: false,
  issuesWorkflowSave: false, carriesSecrets: false}`. Closed shapes: payload
  exactly `{events}`; an event exactly `{id, kind, at, label}` with kind in
  the declared set `run | node | error | manual`, ISO `at`, label <= 200,
  unique ids. Closed vocabularies: actions
  `refresh | request-open-event`; open results
  `accepted | unknown-event | not-ready`; empty reason `none`.
  REGION_STATES pinned exactly (4 states). One dedicated test suite
  `packages/frontend-lego/test/62-work-trace.test.mjs` pins the boundary and
  the closed shapes (18/18, tests A-E).
- **Pilot mode + rollback (CP-02).** Inventory entry `ui.trace.work-trace`
  (new, 28th, category `execution-history` - existing vocabulary) with
  `migrationStatus pilot-available` / `contractStatus consuming` /
  `rollback pilot-not-primary` / `sourceIssue 240` / `slice P2-S25` /
  `surfaceIds [work-trace]` and test/62 as evidence; capability `work-trace`
  (31st, `./src/work-trace.mjs`, degradation fallback `native-behavior`).
  Surface `work-trace` declared (23rd surface, backend none, route
  `/executions/trace`).
- **Parity vs reference (CP-03).** Four fixtures - reference loading,
  reference empty (reason `none`), reference ready, reference error - each
  compared fail-closed by `compareObservations`; a tampered interaction set
  reports a non-equivalent status with the diff kept as evidence; non-member
  vocabularies throw.
- **Accessibility (CP-04).** `WORK_TRACE_A11Y` derived once per state
  (ready = form role / polite / not busy; error = status / assertive;
  loading = busy) and read back by the view-model; focus order =
  `event:<id>` for every visible event in hand-over order (rows never
  reorder), labels declared once; shared primitives: actions never include
  open unless ready, error offers exactly `refresh`.
- **Bounds + failure (CP-05).** Default window 30 visible / hard cap 100
  with the window keeping the newest events and truncation REPORTED;
  label <= 200; measured render: 200 events x 20 displayModel() < 250 ms;
  `loadFailure` yields an explicit error region with kind + retry, never a
  blank; degraded render (`renderAvailable: false`) counts every lost
  event/request (load, open, failure) as `degradedEvents`.

## Verification (all measured, not asserted from memory)

- test/62: 18/18 pass (identical content across all workspace recoveries).
- FE battery: 970 tests (969 pass / 0 fail / 1 skip = 952 baseline + 18).
- Boot payload: pinned in test32 and test34 against the measured baseline
  after the manifest injections (see the pin commit).
- Manifests: surfaces 22 -> 23, capabilities 30 -> 31, migrations 27 -> 28;
  curated rows 30 -> 31 (boot boundary 22 -> 23).
- Workspace incident: the tree was replaced repeatedly mid-slice by an older
  snapshot; recovery per procedure (origin/main verified = `e7af8748`,
  fresh clone, test62 + work-trace.mjs reconstructed from the workspace
  backup, injections re-run idempotently). Root cause of the snapshot swap
  is NOT in this slice's scope.

## Divergences from the reference n8n (4, each justified)

1. **Read-only interaction model.** The reference's timeline is wired into
   the executions view (drag/pan the gutter, `mark run unread`, opening the
   run detail navigates `/execution/:id` through the router). The surface
   performs the open only as a DECLARED request with closed results
   (`accepted | unknown-event | not-ready`); navigation stays with the
   owning capability. No router access, no history writes.
2. **No empty-filter vocabulary.** The reference's empty trace can carry
   active date/status filters. The pilot's empty region uses the closed
   reason `none` only - filtering is out of scope, so an empty trace always
   means "no events were handed over".
3. **Settings are hand-over options, not persisted.** `maxVisible`
   (default 30, clamped to 100) and `labelLimit` (200) are constructor
   options; nothing writes to n8n settings - persistence stays with the
   owning capability.
4. **Timeline ordering is hand-over order.** The reference sorts events by
   timestamp in the viewport. The surface keeps the handed-over order for
   focus stability (`event:<id>` rows never reorder); the deliverer of the
   payload owns chronological sorting.

## Rollback

One-line: remove the `work-trace` capability row + `work-trace` surface
row + flip `ui.trace.work-trace.migrationStatus` to
`pilot-unavailable`. No data migration, no backend dependency; the
reference executions timeline remains the default path throughout.
