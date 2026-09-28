# P2-S17 Import/Export Surface Pilot - Delivery Evidence

**Slice:** P2-S17 (Layer 3 surface split out of P2-S03; master prompt REQ-0003
section 6: frontend surface migration only)
**Scope:** packages/frontend-lego/src/import-export.mjs + test/54-import-export.test.mjs + manifests
**Mode:** pilot; rollback pilot-not-primary; the original n8n editor stays the default path

## Out of scope (stated, not touched)

Workflow persistence (both flows are DECLARED requests; the app layer writes),
file-system and download mechanics (the app layer reads/writes bytes; the
surface receives strings), engine execution, credential/secret material of any
kind (refused at both envelopes), workflow editing, import deduplication /
conflict resolution policy (app layer), and the reference editor's
export-format chrome (divergence 3 below). No backend dependency was built;
rollback needs none.

## Security boundary (the load-bearing rule)

**The workflow document never changes inside this surface.** The document is
handed over (`loadSuccess({workflow})`); the surface performs no fetch, never
reads window/location, **never writes the workflow**
(`issuesWorkflowSave: false`, `issuesEngineCall: false`): `request-export`
serializes exactly the handed-over document, `import-document` parses the
candidate with **JSON.parse only** (no `eval`, no `new Function` - static
check in test/54) and holds the validated result as a PENDING hand-off for
the app layer. A secret-bearing envelope is refused with an explicit security
error on BOTH the hand-over and the import candidate, never dropped.

## What shipped (one surface = one delivery scope)

- **Hand-over boundary (CP-01).** `inputBoundary` is
  `{source: hand-over, entryPoint: loadSuccess, issuesEngineCall: false,
  issuesWorkflowSave: false, carriesSecrets: false}`. Closed shapes: a
  document is a plain object carrying `nodes` (array) + `connections`
  (object); **compatibility-critical (#240 invariant): unknown top-level keys
  pass through untouched** - no key stripped, no value rewritten, and the
  export round-trips to a deep-equal document. Closed vocabularies: actions
  `refresh | request-export | import-document`, export results `accepted |
  not-ready`, import results `accepted | invalid-json | invalid-document |
  not-ready`, empty reason `none`. REGION_STATES pinned exactly.
- **Pilot mode + rollback (CP-02).** Inventory entry `ui.io.import-export`
  moved from `reference-only` / `declared` / `reference-remains-default` to
  `pilot-available` / `consuming` / `rollback pilot-not-primary` with
  `sourceIssue 240`, `slice P2-S17`, `surfaceIds [workflow-editor, dashboard]`
  (the entry's own surfaceIds - no second catalog) and test/54 as evidence;
  capability `import-export` (`./src/import-export.mjs`, degradation fallback
  `native-behavior` - without the capability the reference n8n import/export
  flow remains primary) declared for the same surfaces. Pinned by group B;
  pack budget raised 86 -> 96 KB (measured 88,293 B at S17 with the
  remaining P2-S18..S29 capability tail evidenced in the transition
  comment); boot payload baseline unchanged (no new surface declared).
- **Parity against the reference (CP-03).** All four region states are
  parity-equivalent to the deterministic reference fixtures through the
  existing parity harness; the per-state action rule (`ioActionsFor`) is
  SHARED by the view-model and the reference fixtures. A divergence fails
  closed to a recorded diff.
- **Accessibility (CP-04).** `IO_A11Y` derived once: `form` landmark +
  polite on ready, `status` + assertive only on error, busy only on loading;
  focus order is `['export', 'import']`, stable across interactions; aria
  labels declared once in `IO_LABELS`; import announces the imported
  workflow name; loading/empty/error reuse the shared interaction primitives.
- **Budgets + failure behaviour (CP-05).** Bounded node-name preview
  (default 30, hard max 100, truncation reported); measured render cost
  (300 nodes x20 renders < 250 ms); failure is an explicit error region with
  a retry affordance and a recovery path, never a silent blank; degraded mode
  counts every undeliverable interaction; a workflow with no nodes is empty
  with reason `none` - no fifth state; malformed arguments throw (programmer
  error), domain outcomes are the closed results.

## Divergences from the reference (recorded, never hidden)

1. **Pending, not installed.** The reference editor installs an imported
   workflow directly; the pilot parses, validates and hands the candidate
   PENDING to the app layer - the on-screen document is byte-identical after
   every interaction (strict-direction safety divergence).
2. **Empty-region actions.** The reference can export/import from an empty
   workflow; the pilot's empty region offers `refresh` only (shared per-state
   primitive) until an authorized slice extends the rule.
3. **Export serialization is ours.** The reference writes JSON with its own
   formatting; the pilot serializes the handed-over document exactly
   (round-trip semantic identity is pinned, byte-identity with a reference
   file is not claimed).
4. **Minimal document contract.** Nodes/connections are required; inner node
   objects are opaque pass-through (no interpretation, no coercion) - richer
   per-node validation stays with the workflow registry.

## Verification

- test/54-import-export.test.mjs: 18/18 (groups A-E map to CP-01..05).
- Frontend suite after the change: 826 tests, 825 pass, 0 fail, 1 skip
  (includes refreshed pins: pilot sets in test/37 + test/39, pack budget
  96 KB in test/12, card 8,242/8,704, curated capability index 23 declared).
