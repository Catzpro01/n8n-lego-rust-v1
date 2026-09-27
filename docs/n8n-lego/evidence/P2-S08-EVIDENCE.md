# P2-S08 Workflow Editor Host Pilot - Delivery Evidence

**Slice:** P2-S08 (second Layer 3 surface split out of P2-S03, owner master prompt
REQ-0003 section 6; continued under the explicit owner direction to keep
delivering P2 while the five P5 blockers are maintained honestly)
**Scope:** packages/frontend-lego/src/workflow-editor.mjs + test/45-workflow-editor.test.mjs + manifests
**Mode:** pilot; rollback pilot-not-primary; the original n8n editor stays the default path

## Scope boundary (issue #241 exclusion preserved)

This pilot covers the editor HOST chrome AROUND the canvas: the name/tags/
active-state header and the workflow-level actions panel. The canvas/editor
rewrite itself stays out of scope - `ui.editor.canvas` remains `reference-only`
(the #241 exclusion that the pre-existing inventory entry recorded is preserved;
the entry note now states exactly which part became a pilot and why).

## What shipped (one surface = one delivery scope)

- **Read-only hand-over (CP-01).** The workflow record enters only through
  `loadSuccess()`; the surface never fetches /rest/workflows/:id and NEVER
  mutates workflow data - rename/activate are declared interactions returning the
  closed `requested | no-draft | not-ready | unchanged` result vocabulary, and the
  handed-over record stays a frozen snapshot (issue #240 invariant 5). Unknown
  record/tag shapes are refused, not dropped. States pinned to REGION_STATES
  exactly (no-workflow-in-context is `empty`, not a fifth state).
- **Pilot + rollback (CP-02).** `ui.editor.workflow` upgraded to
  `pilot-available` / `consuming` / `rollbackStrategy: pilot-not-primary`, with
  the `workflow-editor` capability degrading to `native-behavior`.
- **Parity, fail-closed (CP-03).** Loading/empty/ready(active)/ready(inactive)/
  error are parity-equivalent to deterministic reference fixtures through the
  shared harness; a drifted field is `migration-required`, an incomparable
  observation throws (invariant 8).
- **Accessibility (CP-04).** `WORKFLOW_EDITOR_A11Y` derives the intent once; only
  error is aria-live assertive, only loading is aria-busy.
- **Bounds, draft, requests, failure (CP-05).** Tag chips bounded (maxVisible
  20 default, hard max 50) with observable truncation. The rename draft is a
  LOCAL mutation (bounded at 128 chars, refused not truncated) that never touches
  workflow data; a new hand-over clears a stale draft. Failure is explicit: error
  region with a `refresh` retry action; degraded mode is observable.

## Test evidence

`packages/frontend-lego/test/45-workflow-editor.test.mjs` - 20 tests covering the
five checkpoints. Frontend LEGO suite: 652/652 green with the manifest tripwires
(one pilot per slice, capability index, inventory pins, knowledge budgets)
updated to declare this pilot.

## P5 blockers (maintained honestly, per owner direction)

P5-M02, P5-M05, P5-M06, P5-M10 (and the P2-S03 Layer 6 gate) stay blocked with
their corrected blockers and prepared foundation paths; nothing about them was
touched by this delivery.

## Verified on

main parent `528e59a2`; delivery merges as recorded in the slice's mergeSha.
