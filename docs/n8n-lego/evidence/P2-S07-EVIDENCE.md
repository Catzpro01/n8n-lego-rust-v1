# P2-S07 Node Picker / Catalog Pilot - Delivery Evidence

**Slice:** P2-S07 (first Layer 3 surface split out of P2-S03, owner master prompt REQ-0003 section 6)
**Scope:** packages/frontend-lego/src/node-picker.mjs + test/44-node-picker.test.mjs + manifests
**Mode:** pilot; rollback pilot-not-primary; the original n8n editor stays the default path

## What shipped

A bounded, query-filterable view-model of the node picker palette, one surface =
one delivery scope:

- **Hand-over boundary (CP-01).** Node types enter only through `loadSuccess()`;
  the surface never fetches `/rest/types/nodes.json` or `/types/nodes.json`, so it
  holds no private data path to the node catalog (issue #240 invariant 5). A row
  outside the closed shape or with a non-vocabulary category is refused, not
  dropped. The contract's states are pinned to REGION_STATES exactly; filtering to
  zero is `empty` with reason `filtered` - no fifth state (invariants 4 and 7).
- **Pilot + rollback (CP-02).** `ui.nodes.picker` upgraded to `pilot-available`,
  `contractStatus: consuming`, `rollbackStrategy: pilot-not-primary`, with the
  `node-picker` capability degrading to `native-behavior` (the reference picker
  remains primary). Rollback = switch the pilot off, no residual state (invariants 1 and 9).
- **Parity, fail-closed (CP-03).** All four region states are parity-equivalent to
  deterministic reference fixtures through the shared parity harness
  (`compareObservations`); a drifted field is `migration-required`, an
  incomparable observation throws (invariant 8).
- **Accessibility (CP-04).** `NODE_PICKER_A11Y` derives the intent once; only
  error is aria-live assertive, only loading is aria-busy; ready is announced
  politely.
- **Bounds, mutation, failure, selection (CP-05).** `maxVisible` default 20, hard
  max 50, truncation observable (view limit, not data loss; invariant 12). The
  query filter is the one observable mutation (narrow/clear). Failure is explicit:
  error region with a `refresh` retry action, `loadFailure` requires an error
  object. Selection is a declared interaction returning the closed
  `selected | unknown-id | not-ready` vocabulary, never a silent no-op.

## Test evidence

`packages/frontend-lego/test/44-node-picker.test.mjs` - 19 tests covering the five
checkpoints. Frontend LEGO suite: 632/632 green with the manifest tripwires
(one pilot per slice, capability index, inventory validity) updated to declare
this pilot.

## Verified on

main parent `a97a433d`; delivery merges as recorded in the slice's mergeSha.
