# P2-S14 Canvas Surface Pilot - Delivery Evidence

**Slice:** P2-S14 (Layer 3 surface split out of P2-S03; master prompt REQ-0003
section 6: frontend surface migration only)
**Scope:** packages/frontend-lego/src/canvas.mjs + test/51-canvas.test.mjs + manifests
**Mode:** pilot; rollback pilot-not-primary; the original n8n editor stays the default path

## Out of scope (stated, not touched)

Node execution, run data and workflow state (the workflow engine owns them),
the workflow document itself (create/edit/save nodes and edges), multi-select
and lasso interactions (the reference editor keeps them; this slice pins
single selection), pan gestures and minimap (viewport zoom only, bounds
pinned), the NDV/parameter panel (`ui.nodes.parameters` stays reference-only),
and the reference `n8n-editor-ui` canvas implementation. No backend dependency
was built; rollback needs none.

## Security boundary (the load-bearing rule)

**Engine authority never reaches the surface.** The graph model arrives in
ONE hand-over payload (`loadSuccess({nodes, edges})`); the surface performs no
fetch, **issues no engine call** (selection and zoom are DECLARED view-state
interactions with closed result vocabularies - `selected | unknown-node |
same-node | not-ready`, `cleared | no-selection | not-ready`, `zoomed |
out-of-bounds | not-ready`) and never mutates the graph: after any
interaction the rendered nodes are byte-identical to what the hand-over
carried (pinned in test/51 group A). A payload or node carrying a secret or
engine field (`password`, `token`, `credentials`, `runData`, `workflowId`,
`staticData`, ...) is refused with an explicit security error, never dropped.
Edges must connect known nodes, ids are unique, `__proto__`-class ids are
reserved and refused. Pinned by group A including the static no-private-path
check (exactly one table install site, no `fetch(`/`window.`/`location`/
`pushState`/`XMLHttpRequest` in code).

## What shipped (one surface = one delivery scope)

- **Hand-over boundary (CP-01).** Nodes, edges, viewport and selection render
  from the handed-over graph only; `inputBoundary` is
  `{source: hand-over, entryPoint: loadSuccess, issuesEngineCall: false,
  ownsEngineAuthority: false, carriesSecrets: false}`. Closed shapes: node
  `id, type, name, position` (finite `[x, y]`, catalog type is a non-empty
  string - the node registry stays backend authority), edge
  `id, source, target`. Closed vocabularies: actions `refresh | select-node |
  clear-selection | set-zoom`, empty reason `none`, zoom `[0.25, 4]`.
- **Pilot mode + rollback (CP-02).** `ui.editor.canvas` moved from
  `reference-only` to `pilot-available` / `consuming` /
  `rollback pilot-not-primary` with `sourceIssue 240`, `slice P2-S14`,
  `surfaceIds [canvas]` and the test path as evidence; surface `canvas`
  declared in `manifest/surfaces.json` (kind panel, backend workflow);
  capability `canvas` (`./src/canvas.mjs`, degradation fallback
  `native-behavior` - without the capability the reference n8n canvas remains
  primary). Both manifests pinned by group B; boot descriptor baseline
  refreshed 18,126 -> 18,477 bytes (measured, pinned in test/32 + test/34).
- **Parity against the reference (CP-03).** All four region states are
  parity-equivalent to the deterministic reference fixtures through the
  existing parity harness; the per-state action rule (`canvasActionsFor`) is
  SHARED by the view-model and the reference fixtures. A divergence fails
  closed to a recorded diff (tampered interaction -> non-equivalent with
  diffs; invalid observations throw `ParityError`; the empty fixture refuses
  unknown reasons).
- **Accessibility (CP-04).** `CANVAS_A11Y` derived once: `application`
  landmark + polite on ready (the graph handles its own keyboard
  interaction), `status` + assertive only on error, busy only on loading;
  focus order is stable and complete (every visible node in graph order,
  `clear-selection` appended only while something is selected); aria labels
  declared once in `CANVAS_LABELS`; loading/empty/error reuse the shared
  interaction primitives (error -> exactly the retry affordance, empty ->
  refresh only); the selection announces the node name.
- **Budgets + failure behaviour (CP-05).** Bounded visible list (default 30,
  hard max 100, truncation reported with shown/total edges); measured render
  cost for a typical payload (250 nodes + 249 edges x20 renders < 250 ms,
  recorded in test/51); zoom is bounded with an explicit out-of-bounds
  result, never silently clamped; failure is an explicit error region with a
  retry affordance and a recovery path, never a silent blank; degraded mode
  counts every undeliverable interaction instead of failing silently; an
  empty graph is empty with reason `none` - no fifth state.

## Divergences from the reference (recorded, never hidden)

1. **Graph source.** The reference canvas builds its model from the workflow
   document inside the editor bundle; the pilot receives the same model
   through the declared hand-over (the app layer serves it). Parity compares
   the declared behaviours and region states, not the bundle's data flow -
   recorded as a strangler-model divergence (invariant 8).
2. **Single selection is a deliberate closed scope.** The reference editor
   supports multi-select/lasso; this slice pins single selection with a
   closed result vocabulary. Multi-select stays with the reference until an
   authorized slice extends the vocabulary (out-of-scope statement above).
3. **Zoom bounds pinned, not inherited.** The pilot declares [0.25, 4] with
   an explicit `out-of-bounds` result instead of silently clamping like a
   free canvas. If the reference range differs, that delta is this evidence
   line - never a hidden behaviour.

## Verification

- test/51-canvas.test.mjs: 18/18 (groups A-E map to CP-01..05).
- Frontend suite after the change: 772 tests, 771 pass, 0 fail, 1 skip
  (includes refreshed pins: pilot sets in test/37 + test/39, workflow-editor
  sibling pin in test/45, workflow backend surfaces in test/14, boot payload
  baselines 18,477 in test/32 + test/34, curated capability index in test/12).
