# P2-S15 Node Configuration Surface Pilot - Delivery Evidence

**Slice:** P2-S15 (Layer 3 surface split out of P2-S03; master prompt REQ-0003
section 6: frontend surface migration only)
**Scope:** packages/frontend-lego/src/node-config.mjs + test/52-node-config.test.mjs + manifests
**Mode:** pilot; rollback pilot-not-primary; the original n8n editor stays the default path

## Out of scope (stated, not touched)

Expression evaluation (the engine evaluates behind the declared boundary; this
surface renders expression strings verbatim and marks them), workflow
persistence (requestSubmit is a DECLARED request; the app layer writes),
dynamic/P7 parameters (Issue #241 non-scope, kept in the inventory note),
collections and nested parameter objects (primitives only - recorded as
evidence), the full n8n parameter type zoo beyond the declared subset, the
NDV overlay chrome of the reference editor, and the node catalog itself (the
node registry owns it). No backend dependency was built; rollback needs none.

## Security boundary (the load-bearing rule)

**The evaluator never reaches the surface.** Parameter definitions and
current values arrive in ONE hand-over payload
(`loadSuccess({parameters, values})`); the surface performs no fetch (the node
registry owns the schema catalog), **evaluates no expression** - there is no
`eval(` and no `new Function` in the module (pinned by the static
no-private-path check) and an expression value is rendered as exactly the
string the hand-over carried, marked `expression`, never executed - and
**never posts the workflow** (`setParameter` / `requestSubmit` are DECLARED
interactions with closed result vocabularies: `accepted | unknown-parameter |
invalid-value | not-ready` and `accepted | no-changes | not-ready`). A payload
envelope carrying secret or session material is refused with an explicit
security error; values are primitives only (objects and code refused); a
values key the definitions do not know is refused (hand-over consistency).

## What shipped (one surface = one delivery scope)

- **Hand-over boundary (CP-01).** The panel renders the handed-over
  definitions and values only; `inputBoundary` is
  `{source: hand-over, entryPoint: loadSuccess, issuesExpressionEvaluation:
  false, issuesWorkflowSave: false, carriesSecrets: false}`. Closed shapes:
  definition `displayName, name, options, required, type` (unique names,
  options only for `type: options`, option `name,value` pairs), values keyed
  by known names, primitives only. Closed vocabularies: parameter types
  `string | number | boolean | options`, value kinds `literal | expression |
  unset`, actions `refresh | set-parameter | request-submit`, empty reason
  `none`. REGION_STATES pinned exactly.
- **Pilot mode + rollback (CP-02).** `ui.nodes.parameters` moved from
  `reference-only` to `pilot-available` / `consuming` /
  `rollback pilot-not-primary` with `sourceIssue 240`, `slice P2-S15`,
  `surfaceIds [node-config]` and the test path as evidence; surface
  `node-config` declared in `manifest/surfaces.json` (kind panel, backend
  node-registry - the schema authority stays there); capability `node-config`
  (`./src/node-config.mjs`, degradation fallback `native-behavior` - without
  the capability the reference n8n parameter panel remains primary). Pinned
  by group B; boot descriptor baseline refreshed 18,477 -> 18,855 bytes
  (measured, pinned in test/32 + test/34); card budget 8,192 -> 8,704
  (measured: card carries every module name, 8,206 B today).
- **Parity against the reference (CP-03).** All four region states are
  parity-equivalent to the deterministic reference fixtures through the
  existing parity harness; the per-state action rule (`paramActionsFor`) is
  SHARED by the view-model and the reference fixtures. A divergence fails
  closed to a recorded diff (tampered interaction -> non-equivalent with
  diffs; invalid observations throw `ParityError`).
- **Accessibility (CP-04).** `PARAM_A11Y` derived once: `form` landmark +
  polite on ready, `status` + assertive only on error, busy only on loading;
  focus order is stable and complete (every visible parameter in definition
  order, `submit` appended only while the form is dirty); aria labels
  declared once in `PARAM_LABELS`; loading/empty/error reuse the shared
  interaction primitives (error -> exactly the retry affordance, empty ->
  refresh only); a change announces the parameter's display name.
- **Budgets + failure behaviour (CP-05).** Bounded visible list (default 30,
  hard max 100, truncation reported); measured render cost for a typical
  payload (200 parameters x20 renders < 250 ms, recorded in test/52);
  failure is an explicit error region with a retry affordance and a recovery
  path, never a silent blank; degraded mode counts every undeliverable
  interaction instead of failing silently; a parameterless node is empty with
  reason `none` - no fifth state; values are type-checked against the
  handed-over definition (`invalid-value`), expressions accepted verbatim.

## Divergences from the reference (recorded, never hidden)

1. **Declared type subset.** The reference parameter contract carries a large
   type zoo (collections, fixedCollection, json, resourceLocator, ...); this
   slice pins the declared subset `string | number | boolean | options` and
   refuses other types fail-closed. The remaining types stay with the
   reference until an authorized slice extends the vocabulary.
2. **Primitives only.** The reference stores nested parameter objects; the
   pilot hands over primitives (null, string, finite number, boolean) and
   refuses objects at the boundary - no partial nested rendering, no hidden
   coercion.
3. **No evaluator here.** The reference evaluates `={{...}}` expressions
   inside the editor; the pilot never does (statically pinned: no `eval(`,
   no `new Function`) - expressions pass through as strings for the engine to
   evaluate behind the boundary. This is a safety divergence in the strict
   direction, not a feature parity claim.

## Verification

- test/52-node-config.test.mjs: 18/18 (groups A-E map to CP-01..05).
- Frontend suite after the change: 790 tests, 789 pass, 0 fail, 1 skip
  (includes refreshed pins: pilot sets in test/37 + test/39, boot payload
  baseline 18,855 in test/32 + test/34, surface catalog 14 in
  frontend.boundary, card budget 8,704, curated capability index in test/12).
