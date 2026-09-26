# P2-S03 — proposed split into dedicated per-surface slices (PROPOSAL, awaiting Manager approval)

**Status: proposal. Nothing in this document changes canonical state.** It exists because
`docs/n8n-lego/milestones.json` records P2-S03 as *"blocked on being SPLIT, not on
authorization"*, and the responsive work is to produce the split for the Manager to approve
or reject — not to perform it. Performing it unilaterally would be inventing scope.

## 1. What is and is not authorized

Issue #240 is the requirement. The Manager Master Prompt names P2-S03 in its authorized
queue, which is exactly the authorization source #240 asks for — *"Implementation must be
split into dedicated milestone tasks with Manager Master Prompts."*

| Component | Authorized? | Basis |
| --- | --- | --- |
| Layer 3 — core workflow surfaces | **Yes** | Named in the authorized queue |
| Layer 4 — platform surfaces | **Yes** | Named in the authorized queue |
| Layer 5 — AI and advanced surfaces | **Yes** | Named in the authorized queue |
| Layer 6 — legacy UI decommission | **No** | #240 scope boundary declines to authorize removal of `reference/n8n` or `n8n-editor-ui`; invariant 1 forbids a big-bang rewrite; invariant 2 keeps original workflow JSON compatibility mandatory; Layer 6 is gated on *every* required surface having parity, compatibility, performance, accessibility and migration/rollback evidence first |

Layer 6 therefore needs its own Manager decision once that evidence exists. It is excluded
from every slice proposed below.

## 2. The decomposition is grounded, not invented

`packages/frontend-lego/manifest/surfaces.json` already declares a **12-surface catalog**,
each with a backend capability, a contract path and an endpoint list. The strangler
migration is per-surface *against that catalog* — so the split follows the declared
inventory rather than a list composed for this proposal.

| Surface id | Kind | Backend capability | Contract | Backend status |
| --- | --- | --- | --- | --- |
| `auth` | page | `auth` | `contracts/api.contract.md` | present |
| `navigation` | panel | `settings` | `contracts/settings.contract.md` | present |
| `dashboard` | page | `workflow` | `contracts/workflow.contract.md` | present |
| `settings` | page | `settings` | `contracts/settings.contract.md` | **partial** |
| `workflow-editor` | page | `workflow` | `contracts/workflow.contract.md` | present |
| `node-picker` | overlay | `node-registry` | `contracts/node.contract.md` | present |
| `credentials` | page | `credentials` | `contracts/credentials.contract.md` | present |
| `executions` | page | `execution` | `contracts/execution.contract.md` | present |
| `webhooks` | channel | `webhook` | `contracts/webhook.contract.md` | **partial** |
| `notifications` | channel | `push` | `contracts/realtime.contract.md` | present |
| `dialogs` | overlay | **none** | **none** | present |
| `error-surfaces` | inline | `compatibility` | `contracts/api.contract.md` | present |

Two are already partly migrated: `notifications` by P2-S02 (`ui.primitives.notification-surface`),
and `error-surfaces` in part by P2-S01 (#241's loading/empty/error status region).

## 3. Why `dialogs` should go first

It is the only surface in the catalog with **no backend capability and no contract**. Every
other migration has to isolate a data/API boundary against a declared contract; this one has
no boundary to isolate, which makes it the lowest-risk possible first step and the cheapest
place to prove the per-surface slice shape end to end.

It is also the surface most likely to be needed *by* later migrations — workflow settings,
the credential modal and confirmations are all declared as `dialogs` — so delivering it early
unblocks the others rather than competing with them.

## 4. Proposed order, with the reasoning and the blockers

Ordered by strangler risk, not by surface size. Each row is one slice in the #241/#245
shape: one module, one manifest entry, one test suite, `mode: pilot`,
`rollback: pilot-not-primary`, parity evidence against the reference, original editor still
the default path.

| # | Surface | Why here | Blocker |
| --- | --- | --- | --- |
| 1 | `dialogs` | No backend, no contract; needed by later slices | none |
| 2 | `dashboard` | Workflow list; contract present; read-mostly | none |
| 3 | `executions` | Execution list/detail; contract present | none |
| 4 | `node-picker` | Node menu/palette; contract present | **none** — see §8, which corrects an earlier version of this row |
| 5 | `workflow-editor` | Canvas, connections, node configuration — the largest and highest-blast-radius surface | Should follow 1–4, not precede them. Invariant 2 (original workflow JSON compatibility mandatory) makes this the slice where a mistake is least reversible. |
| 6 | `credentials` | Credential list/editor/modal | **Overlaps P5-M02**, blocked because the engine has no credential-consuming node. Migrating the credentials UI before the credential runtime exists builds a shell over nothing. |
| 7 | `settings` | Settings pages | Backend status **partial** |
| 8 | `webhooks` | Webhook/form endpoints | Backend status **partial** |
| 9 | `auth`, `navigation` | Shell-level surfaces, highest blast radius | Last, deliberately. A mistake here is visible on every screen. |
| — | Layer 5 AI surfaces | AI Assistant, Copilot, AI Node, Work Trace, Memory/Context/Session, Skills, Agent/Runtime | Not in the 12-surface catalog; depend on the declared AI capability contracts (`ai-assistant`, `ai-copilot`, `ai-agent-node`, `agent-work-trace` are declared in `capabilities.json` but have no surface entry yet). Needs its own catalog work before a slice. |
| — | Layer 6 | Legacy UI decommission | **Not authorized.** Separate Manager decision, gated on parity/compatibility/performance/accessibility/migration evidence for every required surface. |

## 5. The invariant each slice must hold

Carried from #241 and #245, and from #240's permanent invariants:

- **One additional low-risk surface per slice.** Not a batch, not a rewrite.
- **`mode: pilot`, `rollback: pilot-not-primary`.** The reference stays the default path.
- **Reuse the closed vocabularies.** `REGION_STATES`, `defineSurfaceContract`,
  `compareObservations`, `createFrontendRegistry`, the existing i18n slot grammar. No second
  registry, transport, lifecycle or authority model.
- **Parity evidence against the reference**, deterministic and fixture-based — never
  screenshots or pixel identity.
- **Degradation is observable, never silent**, and never throws.
- **Accessibility derived once**, so the contract's declared observables and the rendered
  attributes cannot drift.
- **Original workflow JSON compatibility remains mandatory** (invariant 2), and existing node
  behaviour keeps working through the stable contract boundary (invariant 3).
- **Browser payload stays bounded**; lazy loading and progressive disclosure preferred
  (invariant 12).

## 6. What is needed from the Manager

1. **Approve or amend the order** in §4 — particularly whether `dialogs` should lead, and
   whether `credentials` should wait for P5-M02 as proposed.
2. **Decide the Layer 6 boundary**: confirm it stays out of P2-S03's scope and needs its own
   Master Prompt.
3. **Split P2-S03 in the register** into the approved per-surface tasks. That is a canonical
   state change and a Manager action; this document deliberately does not perform it.
4. ~~Rule on the node-catalog compat failures~~ — **withdrawn**, see §8. There were none.

## 8. Correction — the node-catalog "failures" were never real

An earlier version of this proposal listed the three node-catalog REST tests
(`GET /rest/types/nodes.json`, `GET /rest/types/node-versions.json`,
`POST /rest/node-types`) as a blocker on slice 4, on the grounds that they "fail
identically on a clean clone of `main`". **That was wrong**, and it is corrected here
rather than left standing, because a proposal that gates an authorized slice on a
non-existent blocker causes work to be deferred for no reason.

The diagnosis:

- `.github/workflows/n8n-lego.yml` has a step **"Fetch the pinned node catalog
  (n8n-nodes-base + icons + roles)"** that runs `scripts/fetch-n8n-catalog.mjs` into
  `$RUNNER_TEMP/catalog` and sets `N8N_LEGO_CATALOG_DIR` to it. The node catalog is a
  **fetched artifact**, not a checked-in file.
- `apps/n8n-lego/data/` ships `api-key-scopes.json`, `public-api-openapi.json` and
  `roles.json` but **no `catalog/` directory**. A fresh clone has never run the fetch.
- With no catalog, `loadCatalog()` returns `null` and the routes throw 404 with
  *"Node catalog is not installed — run `npm run catalog`"*, so the tests assert
  `200 !== 404` and fail.

Verified directly: after `node scripts/fetch-n8n-catalog.mjs --dir /tmp/catalog`
(483 node types) and `N8N_LEGO_CATALOG_DIR=/tmp/catalog`, **`apps/n8n-lego` runs
2730 / 2730 green, zero failures**. The same 12 rest tests that failed now pass 12/12.

So these were never repo defects and never a blocker. They were a missing local setup
step that CI performs and I had not. The general lesson worth recording: a failure that
reproduces on a clean clone is not automatically a code defect — it can equally be an
artifact the test environment is expected to provide, and the CI workflow is the place
that says which.

The one genuine skip that remains is unrelated and deliberate: the frontend-lego
twin-tree guard, which skips *with a reason* because it asserts against the *other*
tree and its twin runs against this one. That is the documented house pattern, not a
defect.

## 7. Note on what is *not* claimed here

This proposal does not authorize any slice, does not change any slice's status, and does not
re-scope P2-S03's title. It records a decomposition grounded in the already-declared surface
catalog so that the decision is a review of concrete options rather than a blank page.
