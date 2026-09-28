# P2-S27 Skills/Capabilities Views Pilot - Delivery Evidence

**Slice:** P2-S27 (Layer 5 surface split out of P2-S03; master prompt REQ-0003
section 6: frontend surface migration only, one surface = one delivery scope)
**Scope:** packages/frontend-lego/src/skills-capabilities.mjs + test/64-skills-capabilities.test.mjs + manifests
**Mode:** pilot; rollback pilot-not-primary; the original n8n editor stays the default path

## Out of scope (stated, not touched)

Capability grants of ANY kind - the surface enables, installs, loads or
elevates nothing (CP-01: "the surface grants nothing"). The capability
registry owns every grant and is never accessed directly: the catalog
arrives via `loadSuccess({skills, capabilities})`. `request-open-skill` is
DECLARED with closed results; the capability that owns navigation performs
it. Skill execution, registry writes, persistence of any kind, and the
reference editor's catalog chrome stay with the reference (divergences 1,
3, 4). No backend dependency; rollback needs none.

## Security boundary (the load-bearing rule)

**There is no second source of truth for the catalog.** Every record is
HANDED OVER; the surface performs no fetch, never reads
window/location/history, never mutates a record
(`.(name|status|state)=(?!=)` count 0, the skill list is byte-identical
after every declared request), never shells out, never dynamically imports
a driver, and contains no evaluator. Secret-bearing envelope and item keys
(session ids, registry tokens, credentials) are refused with an explicit
security error, never dropped. `issuesWorkflowSave: false`,
`issuesEngineCall: false`.

## What shipped (one surface = one delivery scope)

- **Hand-over boundary (CP-01).** `inputBoundary` is
  `{source: hand-over, entryPoint: loadSuccess, issuesEngineCall: false,
  issuesWorkflowSave: false, carriesSecrets: false}`. Closed shapes: payload
  exactly `{skills, capabilities}`; a skill exactly `{id, name, status}`
  with name <= 120 and unique ids; a capability exactly `{id, state}` with
  unique ids. Vocabularies are QUOTED, never redefined: `skillStatuses` =
  `SKILL_STATUSES` from `src/skills.mjs` (implemented | contract-only |
  planned | blocked | deferred | in-progress), `capabilityStates` =
  `CAPABILITY_STATES` from `src/lifecycle.mjs` (available | installed |
  loaded | active | idle | unloaded | disabled). Closed actions
  `refresh | request-open-skill`; open results
  `accepted | unknown-skill | not-ready`; empty reason `none`.
  REGION_STATES pinned exactly (4 states). One dedicated test suite
  `packages/frontend-lego/test/64-skills-capabilities.test.mjs` pins the
  boundary and the closed shapes (18/18, tests A-E).
- **Pilot mode + rollback (CP-02).** Inventory entry `ui.skills.catalog`
  (new, 30th, category `skills-capabilities` - new vocabulary, listed in
  the manifest's own `categories`) with `migrationStatus pilot-available` /
  `contractStatus consuming` / `rollback pilot-not-primary` /
  `sourceIssue 240` / `slice P2-S27` / `surfaceIds [skills-capabilities]`,
  no dependencies, and test/64 as evidence; capability `skills-capabilities`
  (33rd, `./src/skills-capabilities.mjs`, degradation fallback
  `native-behavior`). Surface `skills-capabilities` declared (25th surface,
  backend none, route `/skills`).
- **Parity vs reference (CP-03).** Four fixtures - reference loading,
  reference empty (reason `none`), reference ready, reference error - each
  compared fail-closed by `compareObservations`; a tampered interaction set
  reports a non-equivalent status with the diff kept as evidence; non-member
  vocabularies throw.
- **Accessibility (CP-04).** `SKILLS_CAPABILITIES_A11Y` derived once per
  state (ready = form role / polite / not busy; error = status /
  assertive; loading = busy) and read back by the view-model; focus order
  = `view:skills`, `view:capabilities`, then `skill:<id>` for every skill
  in hand-over order (rows never reorder), labels declared once; shared
  primitives: actions never include open unless ready, error offers exactly
  `refresh`.
- **Bounds + failure (CP-05).** Default window 30 visible / hard cap 100
  with the window keeping the newest skills and truncation REPORTED;
  name <= 120; measured render: 200 skills x 20 displayModel() < 250 ms;
  `loadFailure` yields an explicit error region with kind + retry, never a
  blank; degraded render (`renderAvailable: false`) counts every lost
  load/open/failure as `degradedEvents`.

## Verification (all measured, not asserted from memory)

- test/64: 18/18 pass.
- FE battery: 988 -> 1006 tests expected (952 baseline + 18 S25 + 18 S26
  + 18 S27).
- Boot payload: re-measured after the manifest injections and pinned in
  test32 and test34 (previous baseline 22_256).
- Manifests: surfaces 24 -> 25, capabilities 32 -> 33, migrations 29 -> 30;
  curated index 32 -> 33 (boot boundary 24 -> 25); categories +1.

## Divergences from the reference n8n (4, each justified)

1. **No grant affordances whatsoever.** The reference catalog can enable or
   install a capability from the UI. This surface offers only `refresh` and
   the DECLARED `request-open-skill` (results `accepted | unknown-skill |
   not-ready`); capability grants stay with the registry - the surface
   grants nothing, by contract (CP-01).
2. **Quoted vocabularies instead of a local view vocabulary.** The surface
   re-exports SKILL_STATUSES and CAPABILITY_STATES verbatim (frozen,
   quoted) rather than mapping them into display-only states, so no second
   status architecture can drift from the registry's own.
3. **Settings are hand-over options, not persisted.** `maxVisible`
   (default 30, clamped to 100) and `nameLimit` (120) are constructor
   options; nothing writes to n8n settings.
4. **Ordering is hand-over order.** The reference sorts the catalog by
   name/popularity. The surface keeps the handed-over order for focus
   stability (`skill:<id>` rows never reorder); the deliverer of the
   payload owns the ordering.

## Rollback

One-line: remove the `skills-capabilities` capability row +
`skills-capabilities` surface row + flip `ui.skills.catalog.migrationStatus`
to `pilot-unavailable` (and drop the `skills-capabilities` category if it
carries no other entry). No data migration, no backend dependency; the
reference catalog remains the default path throughout.
