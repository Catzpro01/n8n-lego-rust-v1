# P2-S24 AI Node Surfaces Pilot - Delivery Evidence

**Slice:** P2-S24 (Layer 5 surface split out of P2-S03; master prompt REQ-0003
section 6: frontend surface migration only, one surface = one delivery scope)
**Scope:** packages/frontend-lego/src/ai-node.mjs + test/61-ai-node.test.mjs + manifests
**Mode:** pilot; rollback pilot-not-primary; the original n8n editor stays the default path

## Out of scope (stated, not touched)

Inference of any kind and the parameter write itself - `request-select-model`
is DECLARED and the capability that owns the node parameter performs it. The
pre-existing `ai-agent-node` vocabulary capability (phase P2.10) is
untouched: the six AI capabilities stay `status declared` with no entry
module (test/26 + conformance A20 pin this - the pilot ships as a
**separate** `ai-node` capability beside it). Workflow data, persistence of
any kind, routing, and the reference editor's AI-node chrome beyond this
panel (divergence 3). No backend dependency; rollback needs none.

## Security boundary (the load-bearing rule)

**There is no second source of truth for the model catalog or the selection.**
Both are HANDED OVER (`loadSuccess({models, selectedModelId})`); the surface
performs no fetch, never reads window/location, never mutates a record,
**never writes the selection locally** - the new value arrives only via a
fresh hand-over. Secret-bearing envelope keys (provider API keys included)
are refused with an explicit security error, never dropped.
`issuesWorkflowSave: false`, `issuesEngineCall: false`.

## What shipped (one surface = one delivery scope)

- **Hand-over boundary (CP-01).** `inputBoundary` is
  `{source: hand-over, entryPoint: loadSuccess, issuesEngineCall: false,
  issuesWorkflowSave: false, carriesSecrets: false}`. Closed shapes: payload
  exactly `{models, selectedModelId}` (selectedModelId null or a handed-over
  id); a model is `{id, name, provider}` with provider a member of the
  declared subset `hosted | local | custom`, ids unique. Closed vocabularies:
  actions `refresh | request-select-model`; select results
  `accepted | unknown-model | not-ready`; empty reason `none`.
  REGION_STATES pinned exactly. One dedicated test suite
  `packages/frontend-lego/test/61-ai-node.test.mjs` pins the boundary and
  the closed shapes (18/18).
- **Pilot mode + rollback (CP-02).** Inventory entry `ui.ai.node` (new,
  27th, category `ai-surfaces` - existing vocabulary) with
  `migrationStatus pilot-available` / `contractStatus consuming` /
  `rollback pilot-not-primary` / `sourceIssue 240` / `slice P2-S24` /
  `surfaceIds [ai-node]` and test/61 as evidence; capability `ai-node`
  (30th, `./src/ai-node.mjs`, degradation fallback `native-behavior`) while
  the pre-existing `ai-agent-node` vocabulary capability stays exactly as
  declared (status `declared`, no entry - asserted by test/61). Surface
  `ai-node` declared (22nd surface, backend none, route `/nodes/ai`).
  Curated index 30 declared; boot baseline 21,262 -> 21,589 bytes
  (measured); frontend boundary 21 -> 22; card 8,353/8,704.
- **Parity against the reference (CP-03).** All four region states are
  parity-equivalent to the deterministic reference fixtures through the
  existing parity harness; the per-state action rule (`aiNodeActionsFor`) is
  SHARED by the view-model and the reference fixtures - a divergence fails
  closed to a recorded diff.
- **Accessibility (CP-04).** `AI_NODE_A11Y` derived once: `form` landmark +
  polite on ready, `status` + assertive only on error, busy only on loading;
  focus order is `model ids in hand-over order` (stable, no reorder); aria
  labels declared once in `AI_NODE_LABELS`; requests announce the model id;
  loading/empty/error reuse the shared interaction primitives;
  `ready -> not-ready` is guarded.
- **Budgets + failure behaviour (CP-05).** Bounded model list (default 30,
  hard max 100, truncation reported); measured render cost (200 models x20
  renders < 250 ms); failure is an explicit error region with a retry
  affordance and a recovery path, never a silent blank; degraded mode counts
  every undeliverable interaction; a node with no models is empty with
  reason `none` - no fifth state; malformed arguments throw (programmer
  error), domain outcomes are the closed results.

## Divergences from the reference (recorded, never hidden)

1. **Declared, not executed.** The reference picker writes the parameter
   inline; the pilot issues `request-select-model` and the owning capability
   performs it - the handed-over records are byte-identical after every
   interaction and `selectedModelId` never moves locally (strict
   divergence - authority stays outside the surface).
2. **Surface id differs from the AI vocabulary id.** The surface and its
   pilot capability are named `ai-node`, deliberately NOT `ai-agent-node`:
   the six AI vocabulary capabilities must never claim an implementation or
   leak metadata into the boot payload (test/26, conformance A20).
3. **Closed model shape.** The reference renders capabilities, pricing and
   model cards; the pilot renders `{id, name, provider}` only - richer model
   detail stays with the reference until an authorized slice extends the
   record shape.
4. **Empty-region actions.** The reference can browse a built-in catalog
   from an empty state; the pilot's empty region offers `refresh` only
   (shared per-state primitive) until an authorized slice extends the rule.

## Verification

- test/61-ai-node.test.mjs: 18/18 (groups A-E map to CP-01..05).
- Frontend suite after the change: 952 tests, 951 pass, 0 fail, 1 skip
  (boot 21,589 in test/32 + test/34, pilot sets +1, boundary 22, index 30,
  card 8,353/8,704; AI boundary tests 19/26 + A20 green).
