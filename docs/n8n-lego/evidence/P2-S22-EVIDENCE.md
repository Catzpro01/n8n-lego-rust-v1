# P2-S22 AI Assistant Surface Pilot - Delivery Evidence

**Slice:** P2-S22 (Layer 5 surface split out of P2-S03; master prompt REQ-0003
section 6: frontend surface migration only, one surface = one delivery scope)
**Scope:** packages/frontend-lego/src/ai-assistant.mjs + test/59-ai-assistant.test.mjs + manifests
**Mode:** pilot; rollback pilot-not-primary; the original n8n editor stays the default path

## Out of scope (stated, not touched)

Inference of any kind - the surface contains **no provider client, no
stream, no model call**; request-send / request-stop-stream are DECLARED and
the capability that owns inference performs them. The pre-existing `ai-assistant`
vocabulary capability (phase P2.10) is untouched: the six AI capabilities
stay `status declared` with no entry module (the AI boundary tests and
conformance rule A20 pin this - the pilot ships as a **separate**
`assistant` capability beside it, not instead of it). Workflow data,
persistence of any kind (a conversation never lands on disk from here),
routing, and the reference editor's chat chrome beyond this panel
(divergence 3). No backend dependency was built; rollback needs none.

## Security boundary (the load-bearing rule)

**The surface never fabricates assistant output.** Turns are HANDED OVER as
events (`loadSuccess({turns, streaming})`); no method here writes a turn or
invents a reply - a new turn arrives only via a fresh hand-over. The
surface performs no fetch, never reads window/location, opens no
EventSource/WebSocket, never mutates a turn, never persists and never
carries an inference credential: secret-bearing envelope keys are refused
with an explicit security error, never dropped. `issuesWorkflowSave: false`,
`issuesEngineCall: false`.

## What shipped (one surface = one delivery scope)

- **Hand-over boundary (CP-01).** `inputBoundary` is
  `{source: hand-over, entryPoint: loadSuccess, issuesEngineCall: false,
  issuesWorkflowSave: false, carriesSecrets: false}`. Closed shapes: payload
  exactly `{turns, streaming}` (streaming boolean); a turn is
  `{id, role, text}` with role a member of the declared subset
  `user | assistant`, text non-empty <= 4000 chars, ids unique. Closed
  vocabularies: actions `refresh | request-send | request-stop-stream`;
  send results `accepted | invalid-text | not-ready` (composer: non-empty,
  <= 2000 chars); stop-stream results `accepted | not-streaming | not-ready`
  (the streaming flag is handed over and never toggled locally); empty
  reason `none`. REGION_STATES pinned exactly. One dedicated test suite
  `packages/frontend-lego/test/59-ai-assistant.test.mjs` pins the boundary,
  the never-fabricates rule and the closed shapes (18/18).
- **Pilot mode + rollback (CP-02).** Inventory entry `ui.ai.assistant`
  **converted** from `reference-only` to `pilot-available` (contractStatus
  `consuming`, rollback `pilot-not-primary`, `sourceIssue 240`,
  `slice P2-S22`, surfaceIds `["assistant"]`, evidence test/59; category
  `ai-surfaces` - existing vocabulary, no vocab change). Surface
  `assistant` declared (20th surface, backend none/endpoints [], route
  `/assistant`); capability `assistant` declared (28th,
  `./src/ai-assistant.mjs`, degradation fallback `native-behavior`)
  while the pre-existing `ai-assistant` vocabulary capability stays exactly
  as declared (status `declared`, no entry - asserted by test/59). Curated
  index 28 declared; boot payload baseline refreshed 20,624 -> 20,942 bytes
  (measured, + the assistant surface) in test/32 + test/34; frontend
  boundary 19 -> 20; card 8,329/8,704.
- **Parity against the reference (CP-03).** All four region states are
  parity-equivalent to the deterministic reference fixtures through the
  existing parity harness; the per-state action rule (`aiAssistantActionsFor`)
  is SHARED by the view-model and the reference fixtures - a divergence
  fails closed to a recorded diff.
- **Accessibility (CP-04).** `AI_ASSISTANT_A11Y` derived once: `form`
  landmark + polite on ready, `status` + assertive only on error, busy only
  on loading; focus order is `composer -> send -> stop-stream iff
  streaming` (turns are content, not controls; no hidden tab stops); aria
  labels declared once in `AI_ASSISTANT_LABELS`; the send announces its
  declared outcome; loading/empty/error reuse the shared interaction
  primitives; `ready -> not-ready` is guarded.
- **Budgets + failure behaviour (CP-05).** Bounded turn window (default 30,
  hard max 100, newest-first window, truncation reported); measured render
  cost (200 turns x20 renders < 250 ms); failure is an explicit error region
  with a retry affordance and a recovery path, never a silent blank; degraded
  mode counts every undeliverable interaction; an empty conversation is
  empty with reason `none` - no fifth state; malformed arguments throw
  (programmer error), domain outcomes are the closed results.

## Divergences from the reference (recorded, never hidden)

1. **Declared, not executed.** The reference assistant sends inline through
   its own client; the pilot issues `request-send` / `request-stop-stream`
   and the owning capability performs them - the handed-over turns are
   byte-identical after every interaction and the reply arrives only as a
   fresh hand-over (strict divergence - the surface never fabricates output).
2. **Surface id differs from the AI vocabulary id.** The surface and its
   pilot capability are named `assistant`, deliberately NOT `ai-assistant`:
   the six AI vocabulary capabilities must never claim an implementation or
   leak their metadata into the boot payload (test/26, conformance A20), so
   the pilot carries its own id beside the declared vocabulary.
3. **Closed turn shape.** The reference renders tool calls, sources and
   rich content blocks; the pilot renders `{id, role, text}` only - richer
   assistant content stays with the reference until an authorized slice
   extends the record shape.
4. **Empty-region actions.** The reference composer works from an empty
   thread; the pilot's empty region offers `refresh` only (shared
   per-state primitive) until an authorized slice extends the rule.

## Verification

- test/59-ai-assistant.test.mjs: 18/18 (groups A-E map to CP-01..05 +
  never-fabricates).
- Frontend suite after the change: 916 tests, 915 pass, 0 fail, 1 skip
  (includes refreshed pins: boot 20,942 in test/32 + test/34, pilot sets in
  test/37 + test/39, frontend boundary 20, curated index 28, card
  8,329/8,704; AI boundary tests 19/26 and conformance A20 green).
