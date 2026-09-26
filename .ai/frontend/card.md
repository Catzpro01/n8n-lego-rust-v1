# L1 — Frontend domain card

One page on how the frontend LEGO is built; everything here is derivable from the
manifests and the tests, which is why the card can stay one page.

## What this LEGO is

`ui-frontend` — the frontend LEGO Foundation. It owns the UI architecture, the
compatibility boundary, the UI capability registry and the frontend regression gates.
It does **not** own workflow, execution, auth, credentials, storage, the node registry
or Rust, and implements no feature of its own — no AI feature either: it declares the AI
vocabulary and performs no inference.

`apps/n8n-lego` serves the stock editor bundle unchanged and asks this LEGO for one
thing: the boot descriptor. The LEGO never renders, never injects markup beyond one
additive `<meta>` tag, never rewrites the bundle.

## Where things live

```
packages/frontend-lego/
  index.mjs                 the public surface (catalogs, registries, lifecycle, impact, adapter)
  manifest/                 surfaces.json 12 surfaces + the capability behind each
                            extension-points.json 15 hooks (1.1.0) + 7 future consumers
                            sub-legos.json 19 units · ownership · capabilities · skills
                            context-session.json · memory.json · workspace.json · agent-machine.json
  src/                      one module per concern, no utils dumping ground
    contract.mjs versions.mjs surface-capability.mjs registry.mjs sublegos.mjs lifecycle.mjs
    negotiation.mjs vocabulary.mjs seam.mjs backend-view.mjs envelope.mjs transport.mjs
    interactions.mjs conformance.mjs observability.mjs impact.mjs profiles.mjs i18n.mjs
    errors.mjs boot.mjs client.mjs manifests.mjs knowledge.mjs agents.mjs agent-events.mjs
    skills.mjs context-session.mjs memory.mjs workspace.mjs agent-machine.mjs lego.mjs
    surface-migration.mjs surface-contract.mjs parity.mjs pilot-status-region.mjs
    notification-surface.mjs
    adapters/ the framework adapter boundary (currently Vue; the only framework-aware code)
  test/                     01-contract … 40-notification-surface (numbered as added; 39/40 pilots)
```

What the odd ones own: `negotiation.mjs` discovery, access, degradation and operation
answers; `vocabulary.mjs` the shared vocabulary lock; `seam.mjs` the closed input list and
the one capability identity; `agents.mjs` the AI capability/provider/runtime kinds, the MCP
boundary and the installation layers; `agent-events.mjs` the event vocabulary, the work trace
and the delegation tree; `knowledge.mjs` the `.ai/` pack index; `skills.mjs` consumes
`ai.skill@1.0.0` — six states, four operations, no execution (`test/31`);
`context-session.mjs` is ONE LEGO, TWO contracts (`ai.context`, `ai.agent-session`), five and
three published operations (`test/32`); `memory.mjs` consumes `ai.memory@1.0.0` — a different
LEGO, nine quoted sets, four published operations, no write/ranking/persistence claim
(`test/34`). `workspace.mjs` consumes the bounded `ai.workspace@1.0.0` identity/lifecycle
contract (`test/35`): exact handed-over records only, never a provider, filesystem, terminal or
execution authority. `agent-machine.mjs` consumes the bounded `ai.agent-machine@1.0.0`
execution-foundation contract (`test/36`): exact handed-over machine records — identity,
canonical lifecycle, budgets, the bounded step ledger — and never start/step/pause/resume/cancel
affordances, an approval decision, or any execution, delegation or provider authority.
`notification-surface.mjs` declares ONE shared notification surface (`test/40`): severity and
disposition are separate axes from the `REGION_STATES` the parity harness compares. Memory is
what survives context
replacement; Context references it and never contains it, and the surfaces refuse each
other's payloads by name.

## Boot flow

1. `apps/n8n-lego` resolves the LEGO (checkout → sibling package, tarball → vendored copy).
2. `createFrontendLego({ app, ui })` loads the catalogs, builds both registries and validates
   the declared capability catalog **without registering it**.
3. The adapter encodes one payload twice: the `<meta name="n8n-lego:frontend-bootstrap">` tag
   and `GET /rest/frontend/bootstrap`.
4. Failure is **fail-soft** — the app warns and serves the stock editor without the descriptor.
   A *broken declaration* is fail-closed at the LEGO boundary: it stops the descriptor, not the UI.

## Numbers that matter

| Thing | Value |
| ----- | ----- |
| Architecture tests | 480 across 40 suites (measured with `node --test packages/frontend-lego/test/*.test.mjs`); backend comparisons skip *with a reason* unless the tree is present |
| Architecture rules | 29, as data (`frontend.conformance()`), mirrored in contract §19.16 |
| Surfaces / hooks / units | 12 / 15 (`1.1.0`) / 19 in a 3-level hierarchy |
| Boot payload | 18,126 B JSON / 24,168 B base64, budget **32 KB**, byte-pinned to P2.5 |
| Browser-visible delta | the one `<meta>` tag (24,268 B served) |
| Runtime dependencies | none |
| Locales | `id, en, ar, zh, ru, jv`; Arabic is RTL; 13 message slots |
| Declared capabilities | 9 (`translation` + 6 AI + 2 pilots), installed: 0 |
| Contract lock rows | 20 on this P2.16 implementation branch (`ai.skill`, `ai.context`, `ai.agent-session`, `ai.memory`, `ai.workspace`, `ai.agent-machine` published); protected main remains the pre-P2.16 baseline |
| Vocabularies | 72 quoted with provenance, 29 local, 0 pending publication (`XA-20` closed by publication) |
| Seam | 13 declared inputs, 7 forbidden sources, 16 identity fields |
| Agent events | 26 types / 7 namespaces; trace bound 200 rows, summary 280 chars |

## Rules worth remembering (the full list is data)

All 29 rules are data: `frontend.conformance()` checks each against a live assembly, each
names the vocabulary that enforces it and the suite that proves it, and
`contracts/frontend.contract.md` §19.16 mirrors the list as JSON. Read them there; these are
the ones a new agent gets wrong most often.

- A capability attaches only to a declared surface (fail-closed), operations are named
  `<domain>.<name>`, and registration is metadata: it still loads nothing.
- **Placement grants nothing**; trust is inherited and may only be *lowered*; the framework
  name appears only in `src/adapters/` (`test/14`, `test/16`).
- **A shared word is quoted, never re-invented**; a local word that competes with one
  declares its reason, and an operation that cannot run names the reason (`test/24`, `test/25`).
- **The seam is closed**: declarations cross, implementation does not — an implementation
  file, a route table, a port or a credential store is refused by name (`seam.mjs`, `test/28`).
- **AI is declared, not implemented**: a model-less installation is valid, an agent trace is
  bounded and reference-only, and a delegation tree grants nothing to a child (`test/26`, `test/27`).
- **A Skill is a registry entry, not an execution** (`skills.mjs`, `test/31`).
- **Conversation ≠ Session ≠ Context window ≠ Memory ≠ Execution**: every word quoted, an
  unlocked contract reported `declared-not-locked`, a declared-but-unregistered verb answered
  `operation-unpublished`, a usage figure rendered only with its kind, a 100% threshold
  refused, state carrying references not payloads (`context-session.mjs`, `test/32`).

## Evidence commands

```bash
npm run frontend-lego:test                          # 415 tests
node --test apps/n8n-lego/test/*.test.mjs           # app-side boundary, boot tag, alignment
node apps/n8n-lego/scripts/capture-frontend-evidence.mjs   # 55-check evidence JSON
python3 tools/sublego-audit/audit.py                # nested-LEGO + boundary audit
npm run verify:fast                                 # repo-wide fast gate
```

The browser gate (`tests/e2e/frontend-boundary.mjs`) needs Chromium and `n8n-editor-ui`: it
runs in CI, not in a bare checkout. Cross-agent questions and their arbiters live in
`docs/n8n-lego/decisions/cross-agent-decisions.json`; milestone status, boundaries and the
merge protocol live in `docs/n8n-lego/milestones.json` (`test/33`).
