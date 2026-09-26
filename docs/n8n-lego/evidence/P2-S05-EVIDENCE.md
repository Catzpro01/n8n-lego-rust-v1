# P2-S05 — dialogs / overlays pilot

Second dedicated per-surface slice of P2-S03's Layers 3–5. Delivered in the
#241/#245/#240 shape: one additional low-risk surface, `mode: pilot`,
`rollback: pilot-not-primary`, the original editor stays the default path.

## 1. What this slice adds

`packages/frontend-lego/src/dialog-surface.mjs` — a bounded view-model for a
modal/overlay. It is a view-model plus an observation, never a framework
component. It declares, requests and renders metadata; it never authorizes and
never executes.

- `createDialogSurface(init)` — the view-model.
- `dialogSurfaceContract()` / `validateDialogSurfaceContract()` — the closed
  migration contract.
- `referencePreparingObservation()` / `referenceClosedObservation()` /
  `referenceErrorObservation()` / `referenceReadyObservation()` — deterministic
  reference fixtures for the parity harness.
- `test/42-dialog-surface.test.mjs` — 43 tests.
- `manifest/capabilities.json` (+`dialogs`), `manifest/surface-migrations.json`
  (+`ui.primitives.dialogs`, +`dialogs-overlay-surface` category),
  `.ai` pack (curated capability index + card), `test/37` + `test/39` pilot
  closed-set gates, `src/surface-migration.mjs` (the split-umbrella slice rule).

## 2. The design decision the tests defend

**The content is handed over, never fetched.** The `dialogs` surface is
frontend-owned: it carries no backend capability of its own
(`surfaces.json`: `backend.capability: "none"`, `contract: null`), it renders
content whose capability belongs to another surface (the workflow settings, the
credential modal, a confirmation). The pilot does not fetch: the content is
handed over (`inputBoundary.source: "hand-over"`). Fetching would give the UI a
private data path and a second source of truth for the content's owning
capability, which the compatibility boundary exists to prevent.
`openDialog()` is the only content entry point.

**Four region states, reused not forked.** The contract keys its `states` on
the closed `REGION_STATES` (loading / empty / error / ready), the same
vocabulary the parity harness compares against the pinned reference. A closed
dialog — one that has no content to show — is `empty` at the region level, not
a fifth "closed" state: the region is what the harness compares, the
open/closed axis is carried in the display model's `open`. The test pins
`Object.keys(contract.states)` to `REGION_STATES` exactly so a fifth state
cannot be added quietly.

**The kind decides the declared actions.** A dialog's `kind` (confirmation /
form / notice, a closed set) decides which actions are *declared* for the
ready state — confirm/cancel, submit/cancel, or acknowledge. The kind is part
of the handed-over payload; the dialog does not interpret or validate the
content beyond the closed shape and the bounds. The actions are declared,
never executed.

## 3. Accessibility

Intent is derived once in `DIALOG_A11Y` so the contract's declared observables
and the view-model's rendered attributes cannot drift:

| state | role | aria-live | aria-busy | hidden |
|---|---|---|---|---|
| loading | status | polite | **true** | false |
| empty | region | polite | false | **true** |
| error | alert | **assertive** | false | false |
| ready | dialog | polite | false | false |

Only `error` is assertive — making a caution assertive trains users to dismiss
the live region without reading it. Only `loading` is busy. A closed (empty)
dialog is hidden: a dismissed dialog that still occupied a live region would
still be announced. `test/42` asserts role / aria-live / aria-busy / hidden per
state and the assertive / busy exclusivity.

## 4. Bounds (enforced, not declared)

- Title capped at `maxTitleLength` (120); an over-long title is refused, not
  silently truncated. A title at the bound is accepted.
- Body capped at `maxBodyLength` (4000); an over-long body is refused.
- `test/42` asserts the over-long title/body are refused and the at-the-bound
  value is accepted: the bounds are checked, not merely published.

## 5. Open / close is a real observable mutation

Unlike the purely declarative interactions, opening (handing over content) and
closing change what is VISIBLE: `openDialog(payload)` is `ready` and shows the
content; `closeDialog()` is `empty` and clears the payload; `setPreparing()` is
`loading` and retains the payload; `contentFailure(error)` is `error`. A
dismissed dialog is gone, not a hidden region that would still be announced.
`test/42` observes open / close / payload-cleared / preparing-retained /
closed-hidden end to end.

## 6. Parity (deterministic, fixture-based, fail-closed)

All four region states are parity-`equivalent` to deterministic reference
fixtures that mirror `observe()` field for field. The error kind is pinned
(equivalent when it matches, `migration-required` when it does not) and the
harness is fail-closed: a drifted field is `migration-required` and an
incomparable observation throws. No screenshots; the comparison is over
observable behaviour, not pixels. `test/42` asserts the four-state
parity-equivalence, the error-kind pinning, and the fail-closed behaviour.

## 7. The split-umbrella gate

The `dialogs` pilot is the second slice of the `#240` umbrella (P2-S03 Layer
3), the first being the dashboard (`P2-S04`). The "one pilot per slice"
invariant in `src/surface-migration.mjs` now keys on the originating **slice**
(a new optional `slice` field) rather than the source issue, so two pilots of
the same issue are not two pilots of the same slice; unsplit pilots fall back
to the issue. The `test/37` and `test/39` closed-set gates name the two `#240`
splits explicitly (dashboard `P2-S04`, dialogs `P2-S05`), so a third
undocumented split cannot appear quietly.

## 8. Gate + landing

`mode: pilot`, `rollback: pilot-not-primary`; the original editor stays the
default path. Delivered on `delivery/p2-s05-dialogs` (PR #339). Landed under
DEC-0025: the GitHub-hosted `n8n-lego.yml` jobs are the effective merge gate
while the self-hosted fleet is offline; the self-hosted DEC-0015 jobs are
excluded for the duration of the outage and are back-filled on restoration.
