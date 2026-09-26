# P2-S06 — executions history pilot

Third dedicated per-surface slice of P2-S03's Layers 3–5. Delivered in the
#241/#245/#240 shape: one additional low-risk surface, `mode: pilot`,
`rollback: pilot-not-primary`, the original editor stays the default path.

## 1. What this slice adds

`packages/frontend-lego/src/execution-list.mjs` — a bounded, status-filterable
view-model for the executions page list. It is a view-model plus an
observation, never a framework component. It declares, requests and renders
metadata; it never authorizes and never executes.

- `createExecutionListSurface(init)` — the view-model.
- `executionListSurfaceContract()` / `validateExecutionListSurfaceContract()`
  — the closed migration contract for `ui.executions.history@1.0.0`.
- `referenceLoadingObservation()` / `referenceEmptyObservation()` /
  `referenceErrorObservation()` / `referenceReadyObservation()` — deterministic
  reference fixtures for the parity harness.
- `test/43-execution-list.test.mjs` — 43 tests (groups A–H, mirroring
  `test/41`).
- `manifest/capabilities.json` (+`executions`),
  `manifest/surface-migrations.json` (advances the declared
  `ui.executions.history` entry from `reference-only` to `pilot-available`),
  `.ai` pack (curated capability index + card), `test/37` + `test/39` +
  `test/12` pilot closed-set and catalog gates.

## 2. The design decision the tests defend

**The rows are handed over, never fetched by the view-model.** The `executions`
surface is backend-backed — `surfaces.json` binds it to the `execution`
capability (`/rest/executions`, `contracts/execution.contract.md`) — but that
authority belongs to the app layer, not to the view-model. The pilot receives
the already-resolved rows (`inputBoundary.source: "hand-over"`) and renders
them; it performs no request of its own. Fetching would give the view-model a
private data path and a second source of truth for the execution catalog, which
the compatibility boundary exists to prevent. The row shape is closed
(`id`, `workflowName`, `status`, `lastExecutedAt`) and `status` is drawn from
the engine vocabulary.

**The transient state is not a filterable status.** `EXECUTION_STATUSES` is the
closed set `success, error, canceled, crashed, running, waiting`. The engine's
`new` state is transient (the run has been created but not yet picked up) and is
excluded from the filterable vocabulary, so a filter can only name a status the
list can actually be grouped by. The filter values are the closed set
`'all'` + those six; an unknown value is refused, not coerced.

**Four region states, reused not forked.** The contract keys its `states` on the
closed `REGION_STATES` (loading / empty / error / ready), the same vocabulary the
parity harness compares against the pinned reference. A list filtered down to
nothing is `empty` at the region level, not a fifth state: the display model
carries `reason` (`none` vs `filtered`) so a first-time user and a user who
narrowed the list apart are told the difference, while the region the harness
compares stays the same. The test pins `Object.keys(contract.states)` to
`REGION_STATES` exactly so a fifth state cannot be added quietly.

**Opening is declared, never executed.** `open` and `refresh` are *declared*
interactions on the ready state, and `clear-filter` is declared only when the
list is empty *because of the filter* (not when there is simply nothing). The
surface never performs the open, the refresh or the clear — it names them.

## 3. Accessibility

Intent is derived once in `EXECUTION_LIST_A11Y` so the contract's declared
observables and the view-model's rendered attributes cannot drift:

| state | role | aria-live | aria-busy | hidden |
|---|---|---|---|---|
| loading | status | polite | **true** | false |
| empty | region | polite | false | false |
| error | alert | **assertive** | false | false |
| ready | list | polite | false | false |

Only `error` is assertive — making a load failure assertive is the one place a
list should interrupt; a caution would train users to dismiss the live region
without reading it. Only `loading` is busy. `test/43` asserts role / aria-live /
aria-busy per state and the assertive / busy exclusivity.

## 4. Bounds (enforced, not declared)

- Visible rows capped at `maxVisible` (20); the cap is clamped to the hard max
  (50) and a larger requested bound cannot be raised past it.
- The data is retained past the cap: `truncated` is observable when the matched
  set exceeds the visible bound, so the bound is a view limit, not a data loss.
- An unknown row field and a non-vocabulary `status` are refused, not dropped.
- `test/43` asserts the cap, the clamp, the retention (`truncated`) and the
  closed row shape end to end.

## 5. The status filter is a real observable mutation

Filtering is not metadata: it changes what is VISIBLE. Narrowing to a status the
list contains is `ready`; narrowing to a status with no matches is `empty` with
`reason: 'filtered'` (and declares `clear-filter`); clearing back to `'all'` is
`ready` again (or `empty`/`none` if there truly is nothing). `test/43` observes
narrow / clear / filter-to-zero / reason end to end.

## 6. Parity (deterministic, fixture-based, fail-closed)

All four region states are parity-`equivalent` to deterministic reference
fixtures that mirror `observe()` field for field. The error kind is pinned
(equivalent when it matches, `migration-required` when it does not) and the
harness is fail-closed: a drifted field is `migration-required` and an
incomparable observation throws. No screenshots; the comparison is over
observable behaviour, not pixels. `test/43` asserts the four-state
parity-equivalence, the error-kind pinning, and the fail-closed behaviour.

## 7. The split-umbrella gate

The `executions` pilot is the third slice of the `#240` umbrella (P2-S03 Layer
3), after the dashboard (`P2-S04`) and the dialogs (`P2-S05`). The "one pilot
per slice" invariant keys on the originating **slice** (the `slice` field on the
inventory entry), so three pilots of the same issue are not three pilots of the
same slice. The `test/37` and `test/39` closed-set gates now name all three `#240`
splits explicitly (dashboard `P2-S04`, dialogs `P2-S05`, executions `P2-S06`),
so a fourth undocumented split cannot appear quietly. `test/12` keeps the
declared capability index and the card in lockstep with the shipped modules.

## 8. Gate + landing

`mode: pilot`, `rollback: pilot-not-primary`; the original editor stays the
default path. Delivered on `delivery/p2-s06-executions-surface`. Landed under
DEC-0025: the GitHub-hosted `n8n-lego.yml` jobs are the effective merge gate
while the self-hosted fleet is offline; the self-hosted DEC-0015 jobs are
excluded for the duration of the outage and are back-filled on restoration.
