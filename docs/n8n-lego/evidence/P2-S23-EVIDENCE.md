# P2-S23 AI Copilot Surface Pilot - Delivery Evidence

**Slice:** P2-S23 (Layer 5 surface split out of P2-S03; master prompt REQ-0003
section 6: frontend surface migration only, one surface = one delivery scope)
**Scope:** packages/frontend-lego/src/copilot.mjs + test/60-copilot.test.mjs + manifests
**Mode:** pilot; rollback pilot-not-primary; the original n8n editor stays the default path

## Out of scope (stated, not touched)

Inference of any kind - the surface contains no provider client, no stream,
no model call; request-accept / request-reject are DECLARED and the owning
capability performs them. The pre-existing `ai-copilot` vocabulary capability
(phase P2.10) is untouched: the six AI capabilities stay `status declared`
with no entry module (test/26 + conformance A20 pin this - the pilot ships
as a **separate** `copilot` capability beside it). Workflow data, persistence
of any kind, routing, and the reference editor's inline-chrome beyond this
panel (divergence 3). No backend dependency; rollback needs none.

## Security boundary (the load-bearing rule)

**A suggestion is never applied silently.** Suggestions ARRIVE as declared
events (`loadSuccess({suggestions})`); no method here writes a status or
mutates a record - the outcome arrives only via a fresh hand-over. The
surface performs no fetch, never reads window/location, opens no
EventSource/WebSocket, never persists and never carries an inference
credential: secret-bearing envelope keys are refused with an explicit
security error, never dropped. `issuesWorkflowSave: false`,
`issuesEngineCall: false`.

## What shipped (one surface = one delivery scope)

- **Hand-over boundary (CP-01).** `inputBoundary` is
  `{source: hand-over, entryPoint: loadSuccess, issuesEngineCall: false,
  issuesWorkflowSave: false, carriesSecrets: false}`. Closed shapes: payload
  exactly `{suggestions}`; a suggestion is `{id, target, text, status}` with
  status a member of the declared subset `pending | accepted | rejected`,
  text non-empty <= 4000 chars, ids unique. Closed vocabularies: actions
  `refresh | request-accept | request-reject`; accept/reject results
  `accepted | unknown-suggestion | invalid-state | not-ready` (only a
  pending suggestion is actionable); empty reason `none`. REGION_STATES
  pinned exactly. One dedicated test suite
  `packages/frontend-lego/test/60-copilot.test.mjs` pins the boundary, the
  never-silent-apply rule and the closed shapes (18/18).
- **Pilot mode + rollback (CP-02).** Inventory entry `ui.ai.copilot` (new,
  26th, category `ai-surfaces` - existing vocabulary) with
  `migrationStatus pilot-available` / `contractStatus consuming` /
  `rollback pilot-not-primary` / `sourceIssue 240` / `slice P2-S23` /
  `surfaceIds [copilot]` and test/60 as evidence; capability `copilot`
  (29th, `./src/copilot.mjs`, degradation fallback `native-behavior`) while
  the pre-existing `ai-copilot` vocabulary capability stays exactly as
  declared (status `declared`, no entry - asserted by test/60). Surface
  `copilot` declared (21st surface, backend none, route `/copilot`). Curated
  index 29 declared; boot baseline 20,942 -> 21,262 bytes (measured); frontal
  boundary 20 -> 21; card 8,341/8,704.
- **Parity against the reference (CP-03).** All four region states are
  parity-equivalent to the deterministic reference fixtures through the
  existing parity harness; the per-state action rule (`copilotActionsFor`)
  is SHARED by the view-model and the reference fixtures - a divergence
  fails closed to a recorded diff.
- **Accessibility (CP-04).** `COPILOT_A11Y` derived once: `form` landmark +
  polite on ready, `status` + assertive only on error, busy only on loading;
  focus order is `pending suggestion ids in hand-over order` (decided
  suggestions are not hidden tab stops; once all are decided the list is
  empty); aria labels declared once in `COPILOT_LABELS`; requests announce
  the suggestion id; loading/empty/error reuse the shared interaction
  primitives; `ready -> not-ready` is guarded.
- **Budgets + failure behaviour (CP-05).** Bounded suggestion list (default
  30, hard max 100, truncation reported); measured render cost (200
  suggestions x20 renders < 250 ms); failure is an explicit error region
  with a retry affordance and a recovery path, never a silent blank; degraded
  mode counts every undeliverable interaction; no suggestions is empty with
  reason `none` - no fifth state; malformed arguments throw (programmer
  error), domain outcomes are the closed results.

## Divergences from the reference (recorded, never hidden)

1. **Declared, not executed.** The reference copilot applies an accepted
   suggestion inline; the pilot issues `request-accept` / `request-reject`
   and the owning capability performs them - the handed-over records are
   byte-identical after every interaction and the status changes only via a
   fresh hand-over (strict divergence - nothing is applied silently).
2. **Surface id differs from the AI vocabulary id.** The surface and its
   pilot capability are named `copilot`, deliberately NOT `ai-copilot`: the
   six AI vocabulary capabilities must never claim an implementation or leak
   metadata into the boot payload (test/26, conformance A20).
3. **Closed suggestion shape.** The reference renders diffs, confidence and
   apply-context; the pilot renders `{id, target, text, status}` only - richer
   suggestion detail stays with the reference until an authorized slice
   extends the record shape.
4. **Empty-region actions.** The reference composer generates from an empty
   state; the pilot's empty region offers `refresh` only (shared per-state
   primitive) until an authorized slice extends the rule.

## Verification

- test/60-copilot.test.mjs: 18/18 (groups A-E map to CP-01..05 +
  never-silent-apply).
- Frontend suite after the change: 934 tests, 933 pass, 0 fail, 1 skip
  (boot 21,262 in test/32 + test/34, pilot sets +1, boundary 21, index 29,
  card 8,341/8,704; AI boundary tests 19/26 + A20 green).
