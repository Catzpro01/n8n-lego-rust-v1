# P2-S28 Agent/Runtime Views Pilot - Delivery Evidence

**Slice:** P2-S28 (Layer 5 surface split out of P2-S03; master prompt REQ-0003
section 6: frontend surface migration only, one surface = one delivery scope)
**Scope:** packages/frontend-lego/src/agent-runtime.mjs + test/65-agent-runtime.test.mjs + manifests
**Mode:** pilot; rollback pilot-not-primary; the original n8n editor stays the default path

## Out of scope (stated, not touched)

**Runtime control of any kind** - the surface CANNOT start, stop, pause,
resume or cancel a runtime or an agent session (CP-01: "runtime events
handed over, the surface cannot start or stop runtimes"). Control verbs
(ai:agent:control / agentMachine.start|pause|resume|cancel) belong to the
backend contract and never appear as surface actions or affordances;
`request-open-agent` is DECLARED with closed results for navigation only.
No backend dependency; the supervision state arrives via
`loadSuccess({agents, events})` only; rollback needs none.

## Security boundary (the load-bearing rule)

**There is no second source of truth for supervision state.** Every agent
row and runtime event is HANDED OVER; the surface performs no fetch, never
reads window/location/history, never mutates a record (field-write scan
count 0; records byte-identical after every declared request), never shells
out, never dynamically imports a driver, contains no evaluator, and never
calls an agent or runtime operation. Secret-bearing envelope keys
(sessionId cookies, tokens, credentials) are refused with an explicit
security error, never dropped. `issuesWorkflowSave: false`,
`issuesEngineCall: false`.

## What shipped (one surface = one delivery scope)

- **Hand-over boundary (CP-01).** `inputBoundary`
  `{source: hand-over, entryPoint: loadSuccess, issuesEngineCall: false,
  issuesWorkflowSave: false, carriesSecrets: false}`. Closed shapes: payload
  exactly `{agents, events}`; an agent exactly `{agentId, runtimeId, status}`
  with `status` QUOTED from `agentSessionState` (created | running | waiting
  | paused | completed | failed | cancelled, vocabulary.mjs lock - no local
  vocabulary); an event exactly `{eventId, timestamp, type, agentId,
  summary}` with `type` QUOTED from `agentEventType` (26 locked types
  incl. runtime.connected | runtime.disconnected | runtime.unavailable),
  ISO timestamp, summary <= 400, unique ids. Closed actions
  `refresh | request-open-agent` (NO start/stop/pause/resume/cancel exists
  in the vocabulary); open results `accepted | unknown-agent | not-ready`;
  empty reason `none`. REGION_STATES pinned exactly (4 states).
  One dedicated test suite `packages/frontend-lego/test/65-agent-runtime.test.mjs`
  pins the boundary and the closed shapes (18/18, tests A-E).
- **Pilot mode + rollback (CP-02).** Inventory entry `ui.agent.runtime`
  (31st, category `ai-surfaces` - REUSED existing vocabulary) with
  `migrationStatus pilot-available` / `contractStatus consuming` /
  `rollback pilot-not-primary` / `sourceIssue 240` / `slice P2-S28` /
  `surfaceIds [agent-runtime]`, no dependencies, test/65 as evidence;
  capability `agent-runtime` (34th, `./src/agent-runtime.mjs`, fallback
  `native-behavior`). Surface `agent-runtime` declared (26th, backend none,
  route `/agent`).
- **Parity vs reference (CP-03).** Four fixtures - loading, empty
  (reason `none`), ready, error - compared fail-closed by
  `compareObservations`; a tampered interaction set reports a
  non-equivalent status with the diff kept as evidence; non-member
  vocabularies throw.
- **Accessibility (CP-04).** `AGENT_RUNTIME_A11Y` derived once per state
  (ready = form / polite / not busy; error = status / assertive; loading =
  busy) and read back by the view-model; focus order =
  `view:agents`, `view:events`, `agent:<agentId>` (hand-over order),
  `event:<eventId>` (hand-over order) - rows never reorder; labels
  declared once; shared primitives: actions never include open unless
  ready, error offers exactly `refresh`.
- **Bounds + failure (CP-05).** Event window 30 visible / hard cap 100
  keeping the NEWEST events with truncation REPORTED (agents are a bounded
  supervision list, fully shown with `agentCount`); summary <= 400;
  measured render: 200 events x 20 displayModel() < 250 ms;
  `loadFailure` yields an explicit error region with kind + retry, never a
  blank; degraded render counts every lost load/open/failure as
  `degradedEvents`.

## Verification (all measured, not asserted from memory)

- test/65: 18/18 pass.
- FE battery: 1006 -> 1024 expected (952 baseline + 18x5 S23-S27 + 18 S28).
- Boot payload: re-measured after the manifest injections and pinned in
  test32 and test34 (previous baseline 22_593).
- Manifests: surfaces 25 -> 26, capabilities 33 -> 34, migrations 30 -> 31;
  curated index 33 -> 34 (boot boundary 25 -> 26); categories unchanged
  (ai-surfaces reused).

## Divergences from the reference n8n (4, each justified)

1. **No runtime/agent control verbs whatsoever.** The reference can start
   and stop executions/agents from the UI. This surface offers only
   `refresh` and the DECLARED `request-open-agent` (results
   `accepted | unknown-agent | not-ready`); start/stop/pause/resume/cancel
   are contract operations with their own permissions and never become
   surface actions (CP-01).
2. **Quoted vocabularies instead of a local view vocabulary.** Agent
   status and event type are re-exported verbatim from vocabulary.mjs
   (`agentSessionState`, `agentEventType`) rather than mapped into
   display-only states, so no second status architecture can drift from
   the contract lock.
3. **Settings are hand-over options, not persisted.** `maxVisible`
   (default 30, clamped to 100) and `summaryLimit` (400) are constructor
   options; nothing writes to n8n settings.
4. **Ordering is hand-over order.** The reference sorts streams by wall
   clock and agents by name. The surface keeps the handed-over order for
   focus stability; the deliverer of the payload owns the ordering, and
   the window takes the newest tail of whatever order arrives.

## Rollback

One-line: remove the `agent-runtime` capability row + `agent-runtime`
surface row + flip `ui.agent.runtime.migrationStatus` to
`pilot-unavailable`. No data migration, no backend dependency; the
reference editor remains the default path throughout.
