# P2-S26 Memory/Context/Session Views Pilot - Delivery Evidence

**Slice:** P2-S26 (Layer 5 surface split out of P2-S03; master prompt REQ-0003
section 6: frontend surface migration only, one surface = one delivery scope)
**Scope:** packages/frontend-lego/src/memory-views.mjs + test/63-memory-views.test.mjs + manifests
**Mode:** pilot; rollback pilot-not-primary; the original n8n editor stays the default path

## Out of scope (stated, not touched)

Session data acquisition, persistence of any kind, and navigation - the
inspection state arrives via `loadSuccess({memory, context, session})` and
`request-open-entry` is DECLARED with closed results; the capability that
owns navigation performs it. The session store is never touched directly
(CP-01): no store reads, no store writes, no direct session mutation. The
reference editor's own developer/inspector chrome stays with the reference
(divergences 1, 3, 4). No backend dependency; rollback needs none.

## Security boundary (the load-bearing rule)

**There is no second source of truth for the session state.** The records
are HANDED OVER; the surface performs no fetch, never reads
window/location/history, never mutates a record
(`.(kind|text|used|limit|turns|status)=(?!=)` count 0, the memory list is
byte-identical after every declared request), never shells out, never
dynamically imports a driver, and contains no evaluator. Secret-bearing
envelope and item keys (session ids, tokens, credentials) are refused with
an explicit security error, never dropped. `issuesWorkflowSave: false`,
`issuesEngineCall: false`.

## What shipped (one surface = one delivery scope)

- **Hand-over boundary (CP-01).** `inputBoundary` is
  `{source: hand-over, entryPoint: loadSuccess, issuesEngineCall: false,
  issuesWorkflowSave: false, carriesSecrets: false}`. Closed shapes: payload
  exactly `{memory, context, session}`; a memory item exactly
  `{id, kind, text}` with kind in `short-term | long-term | retrieved`,
  text <= 500, unique ids; context exactly `{limit, used}` with
  `0 <= used`, `limit >= 1`, `used <= limit`; session exactly
  `{id, status, turns}` with status in `active | idle | closed`, turns >= 0.
  Closed vocabularies: actions `refresh | request-open-entry`; open results
  `accepted | unknown-entry | not-ready`; empty reason `none`.
  REGION_STATES pinned exactly (4 states). One dedicated test suite
  `packages/frontend-lego/test/63-memory-views.test.mjs` pins the boundary
  and the closed shapes (18/18, tests A-E).
- **Pilot mode + rollback (CP-02).** Inventory entry `ui.memory.views`
  (new, 29th, category `memory-session-views` - new vocabulary, listed in
  the manifest's own `categories` and covered by the required-category
  check) with `migrationStatus pilot-available` / `contractStatus consuming`
  / `rollback pilot-not-primary` / `sourceIssue 240` / `slice P2-S26` /
  `surfaceIds [memory-views]`, no dependencies, and test/63 as evidence;
  capability `memory-views` (32nd, `./src/memory-views.mjs`, degradation
  fallback `native-behavior`). Surface `memory-views` declared (24th
  surface, backend none, route `/inspector/session`).
- **Parity vs reference (CP-03).** Four fixtures - reference loading,
  reference empty (reason `none`), reference ready, reference error - each
  compared fail-closed by `compareObservations`; a tampered interaction set
  reports a non-equivalent status with the diff kept as evidence; non-member
  vocabularies throw.
- **Accessibility (CP-04).** `MEMORY_VIEWS_A11Y` derived once per state
  (ready = form role / polite / not busy; error = status / assertive;
  loading = busy) and read back by the view-model; focus order =
  `view:session`, `view:context`, then `entry:<id>` for every memory entry
  in hand-over order (rows never reorder), labels declared once; shared
  primitives: actions never include open unless ready, error offers exactly
  `refresh`.
- **Bounds + failure (CP-05).** Default window 30 visible / hard cap 100
  with the window keeping the newest memory entries and truncation
  REPORTED; text <= 500; measured render: 200 entries x 20 displayModel()
  < 250 ms; `loadFailure` yields an explicit error region with kind + retry,
  never a blank; degraded render (`renderAvailable: false`) counts every
  lost load/open/failure as `degradedEvents`.

## Verification (all measured, not asserted from memory)

- test/63: 18/18 pass.
- FE battery: 970 -> 988 tests expected (952 + 18 for S25 + 18 for S26).
- Boot payload: re-measured after the manifest injections and pinned in
  test32 and test34 (previous baseline 21_913).
- Manifests: surfaces 23 -> 24, capabilities 31 -> 32, migrations 28 -> 29;
  curated index 31 -> 32 (boot boundary 23 -> 24); categories +1.

## Divergences from the reference n8n (4, each justified)

1. **Read-only inspection.** The reference inspector can edit/resume the
   session and reorders memory live. The surface renders handed-over state
   and performs the open only as a DECLARED request with closed results
   (`accepted | unknown-entry | not-ready`); navigation and any session
   action stay with the owning capability. No store access, no router
   writes.
2. **No store-backed refresh.** `refresh` is declared as an affordance;
   the capability behind it performs the reload and a NEW hand-over
   arrives. The surface never reads the session store itself (CP-01).
3. **Settings are hand-over options, not persisted.** `maxVisible`
   (default 30, clamped to 100) and `textLimit` (500) are constructor
   options; nothing writes to n8n settings.
4. **Ordering is hand-over order.** The reference sorts memory by
   recency/score. The surface keeps the handed-over order for focus
   stability (`entry:<id>` rows never reorder); the deliverer of the
   payload owns the ordering.

## Rollback

One-line: remove the `memory-views` capability row + `memory-views`
surface row + flip `ui.memory.views.migrationStatus` to
`pilot-unavailable` (and drop the `memory-session-views` category if it
carries no other entry). No data migration, no backend dependency; the
reference inspector remains the default path throughout.
