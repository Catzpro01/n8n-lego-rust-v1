# P2-S04 — dashboard workflow-list pilot

First dedicated per-surface slice of P2-S03's Layers 3–5. Delivered in the
#241/#245 shape: one additional low-risk surface, `mode: pilot`,
`rollback: pilot-not-primary`, the original editor stays the default path.

## 1. What this slice adds

`packages/frontend-lego/src/workflow-list.mjs` — a bounded, client-filtered
view-model for the Home workflow list. It is a view-model plus an observation,
never a framework component. It declares, requests and renders metadata; it
never authorizes and never executes.

- `createWorkflowListSurface(init)` — the view-model.
- `workflowListSurfaceContract()` / `validateWorkflowListSurfaceContract()` —
  the closed migration contract.
- `referenceLoadingObservation()` / `referenceEmptyObservation()` /
  `referenceErrorObservation()` / `referenceReadyObservation()` — deterministic
  reference fixtures for the parity harness.
- `test/41-workflow-list.test.mjs` — 41 tests.
- `manifest/capabilities.json` (+`dashboard`), `manifest/surface-migrations.json`
  (+`ui.pages.dashboard`), `index.mjs` (exports), `.ai` pack (curated index + card).

## 2. The design decision the tests defend

**The list is handed over, never fetched.** The dashboard surface's backend is
the `workflow` capability (`contracts/workflow.contract.md`, `/rest/workflows`).
The pilot does not fetch: entries are handed over (`inputBoundary.source:
"hand-over"`). Fetching would give the UI a private data path and a second
source of truth for the workflow catalog, which the compatibility boundary
exists to prevent. `loadSuccess()` is the only row entry point.

**Four region states, reused not forked.** The contract keys its `states` on
the closed `REGION_STATES` (loading / empty / error / ready), the same
vocabulary the parity harness compares against the pinned reference. "The user
filtered to nothing" and "there are no workflows" are BOTH `empty` at the
region level — the difference is carried in the display model's `reason`
(`none` vs `filtered`), not invented as a fifth region state. The test pins
`Object.keys(contract.states)` to `REGION_STATES` exactly so a fifth state
cannot be added quietly.

## 3. Accessibility

Intent is derived once in `WORKFLOW_LIST_A11Y` so the contract's declared
observables and the view-model's rendered attributes cannot drift:

| state | role | aria-live | aria-busy |
|---|---|---|---|
| loading | status | polite | **true** |
| empty | region | polite | false |
| error | alert | **assertive** | false |
| ready | list | polite | false |

Only `error` is assertive — making a caution assertive trains users to dismiss
the live region without reading it. Only `loading` is busy. `test/41` asserts
role / aria-live / aria-busy per state and the assertive / busy exclusivity.

## 4. Bounds (enforced, not declared)

- Visible rows capped at `maxVisible` (default 20, hard max 50); the data is
  retained, `truncated` is observable, "show more" is a declared interaction.
- Filter length bounded at 64 chars.
- A row with an unknown field is refused (closed shape: `id`, `name`, `active`,
  `updatedAt`); a row missing a required field is refused; an over-long filter
  throws. A bound that is published but not checked moves the failure onto
  whoever trusted it — the `maxParams` lesson from #245.

## 5. The client filter is a real mutation

The name filter is the one behaviour a test can observe end to end: narrow,
clear, filter-to-zero. It is case-insensitive and trimmed. Filtering to zero is
`empty` with `reason: 'filtered'` and the loaded data is retained (`count`
preserved). A load clears a stale filter; a filter during loading is inert
until data arrives.

## 6. Parity (fail-closed)

All four region states are parity-`equivalent` to the deterministic reference
fixtures. The error kind is **pinned**: `equivalent` when it matches,
`migration-required` when it does not (a real `timeout` error read against a
`network` reference is not a silent pass). The harness is fail-closed: a
drifted field is `migration-required` and an incomparable observation throws.
The reference fixtures mirror `observe()` field for field; a fixture that
drifts from the candidate is a bug. `observe()` is a snapshot, not a replay of
the cumulative history.

## 7. Seam and rollback

The surface reaches consumers only through the existing registry/adapter seam:
it is declared in `manifest/capabilities.json` (`activation: lazy`), registers
through `createFrontendRegistry` + `register()`, and is `available` in the
registry vocabulary without being installed or loaded. The pilot gate's closed
set now includes `ui.pages.dashboard` as the third pilot, and the migration
inventory entry is `pilot-available` with `rollbackStrategy:
pilot-not-primary` — the reference UI stays the default.

## 8. Verification

| Gate | Result |
|---|---|
| `frontend-lego:test` | 527 / 528 (1 pre-existing twin-tree skip) |
| `test/41-workflow-list` | 41 / 41 |
| `apps/n8n-lego` (catalog fetched) | 2730 / 2730 |
| `governance-register` | 74 / 74 (KPI tripwire refreshed to 133/153, 132/147) |
| `lego:ai:check`, `lego:arch`, `lego:foundation`, `lego:capabilities`, `lego:scaleout` | all OK |

## 9. The `.ai` pack budget

`.ai/index/capabilities.json` (curated) + the `dashboard` entry.
`.ai/frontend/card.md` names the module and updates the capability count,
8129 B, inside the L1 budget of 8192 B (63 B headroom). No budget raise was
needed.

## 10. Register

`P2-S04` added to `docs/n8n-lego/milestones.json`: in-progress, 6 checkpoints
(all completed — the work is done and locally green), weights 20/20/15/15/15/15
= 100, `activeSlices`. The `P2-S03` umbrella stays blocked (remaining Layers
3–5 surfaces + the not-authorized Layer 6); its `blockedBy` records the split.
The completion KPI tripwire in `governance-register.test.mjs` was refreshed for
the new slice.

## 11. Scope compliance

Confined to `packages/frontend-lego/**` (module, tests, manifests, index), the
`.ai` pack, and the milestone register — the same zero-touch paths as #241/#245.
No workflow, Cargo, runner-config, `crates/`, `contracts/` or `apps/` changes.
The register split and its KPI tripwire are reconciled in this governance PR
per DEC-0021.

## 12. Checkpoints

All six completed: handed-over boundary (20), closed contract / no fifth state
(20), enforced bounds (15), the client filter mutation (15), a11y derived once
(15), parity fail-closed (15).

## 13. Merge blocker

The self-hosted runner fleet is offline — the same outage blocking PRs #331
and #332. The six required self-hosted jobs cannot run, so this PR (PR #338)
sits `unstable` on GitHub-hosted-green / self-hosted-queued. It will not be
merged while those required checks are un-run — the #312 `unstable` pattern
this marathon has refused to repeat. The code is delivered and locally proven;
the merge waits on the fleet.
