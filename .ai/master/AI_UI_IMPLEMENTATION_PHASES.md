# AI UI — implementation phases

**Status:** specification (sequencing, not a schedule). **Owner:** agent-01.

> **Namespace note (vocabulary separation, `docs/engineering-operations/VOCABULARY.md`).**
> The phases in this document are **AI-UI implementation phases**, namespaced `UI-PHASE-nn`.
> They are **not** canonical Programs. They were previously written as bare `P3`–`P10`, which
> collided token-for-token with canonical Programs `P3`–`P11` in
> `docs/n8n-lego/milestones.json` — two different meanings for the same string in the same
> `.ai/master/` folder. The crosswalk below is the only thing that changed; no scope, no
> dependency, no exit gate and no definition of done was altered.
>
> | Before (ambiguous) | After (namespaced) | Canonical Program with the same token — **unrelated** |
> | --- | --- | --- |
> | `P3` | `UI-PHASE-03` | `P3` = Workflow + Execution + Unlimited Nodes |
> | `P4` | `UI-PHASE-04` | `P4` = Trigger / Webhook / Ingress |
> | `P5` | `UI-PHASE-05` | `P5` = Identity / Authentication / Authorization / Credentials |
> | `P6` | `UI-PHASE-06` | `P6` = Node Registry / Node Runtime |
> | `P7` | `UI-PHASE-07` | `P7` = Dynamic Parameters / Schema Runtime |
> | `P8` | `UI-PHASE-08` | `P8` = Storage / Data Layer |
> | `P9` | `UI-PHASE-09` | `P9` = Observability / Diagnostics / Operations |
> | `P10` | `UI-PHASE-10` | `P10` = Multi-Tenant / Isolation / Quota |
>
> Older evidence, PR bodies, issues and chat that say "AI UI P5" mean `UI-PHASE-05`. Those
> historical records are **not** rewritten (`GOVERNANCE SAFETY`: no historical evidence rewrite);
> this table is how they are read. The `P2.5` / `P2.10` references in this file are canonical
> historical **sub-milestones of Program P2** and are deliberately unchanged.

This document says **in what order the AI experience is built, what each phase depends on, and what
proves it**. It is deliberately conservative: a phase that needs vocabulary nobody publishes yet
waits, because building UI against an invented word is how a second vocabulary is born.

The foundation gate (P2.5 / P2.10 parity, this repository) is **finished**: vocabulary lock,
seam, identity, negotiation, AI contracts, event contract, trace contract, localization, gates.
Everything below builds *on* it and adds no new foundation.

---

## 1. Dependency rule

```
UI-PHASE-03 skeleton ──┬─► UI-PHASE-04 Assistant (GLOBAL)
              ├─► UI-PHASE-05 Copilot chat + context/session
              │        ├─► UI-PHASE-06 trace · agents · approvals · artifacts
              │        │        ├─► UI-PHASE-07 skills · memory                    (waits for XA-11, XA-12)
              │        │        └─► UI-PHASE-08 MCP · runtimes · workspace        (waits for XA-16, XA-13)
              │        └───────────────────────────────────────────► UI-PHASE-09 node creator · translation · usage (waits for XA-15, XA-14, XA-17)
              └───────────────────────────────────────────────────► UI-PHASE-10 hardening (a11y · performance · mobile · i18n · evidence)
```

A phase may start when its dependencies are *published*, not when they are merely planned. While a
dependency is `publicationPending` (XA-11 … XA-17), the surface renders its state as
`capability-unavailable` / `feature-unsupported` with the reason — never a mock.

## 2. Common definition of done (applies to every phase)

1. Every surface it adds renders **all ten states** from `AI_UI_STATES_AND_FLOWS.md`.
2. Every string is a message key in the six locales; `ar` verified RTL; keyboard path verified.
3. No new vocabulary: anything backend-visible exists in the lock, or is a documented
   presentation name with a declared mapping.
4. The boot descriptor does not grow (18,126 B JSON today, budget 32 KB); AI metadata never enters
   the payload.
5. Evidence regenerated (`apps/n8n-lego/scripts/capture-frontend-evidence.mjs`), conformance rules
   covering the new behaviour, and the pack/master documents updated in the same change.
6. Lazy discipline holds: nothing above disclosure level L1 loads before it is opened.

---

## 3. Phases

### UI-PHASE-03 — AI experience skeleton (no inference)

**Delivers.** The shell-level entry points (`AI Assistant`, `Copilot`, `Ask AI`,
`Analyze Execution`), the right-side panel with its stable tab strip (Chat · Trace · Agents ·
Files · More), the responsive behavior (panel / drawer / full screen), the AI status bar with its
four shapes, disclosure levels L0–L4 as a mechanism, and the copy/key space.

**Depends on.** The foundation gate only. **No model call, no provider, no agent.**

**Tests.** Panel mounts and disposes without a subscription leak; tab strip is keyboard driven;
breakpoints at 1280 / 1024 / 640 px; status bar renders working/completed/blocked/valid-absent;
copy keys resolve in all six locales.

**Exit gate.** Entry points and status bar are live on a build with no AI configured, and the
zero-install copy is the honest one (`AI Foundation ready · no provider configured`).

### UI-PHASE-04 — AI Assistant (`GLOBAL`)

**Delivers.** Session creation (`ai.agent-session`), context load (`ai.context`), streaming answers
through `ai.model-gateway` (`generate`, `stream`), per-message token chips with `source`, the usage
detail view, and the action-proposal path (`ai.decision` + `ai.approval`).

**Depends on.** UI-PHASE-03. **XA-17** for usage beyond `countTokens` (until then: `estimated` or absent).

**Tests.** Zero-install state; `capability-unavailable` never rendered as an error; refused
permission shows the missing grant; streaming announces completion once; a proposed action never
executes without an approval decision.

**Exit gate.** An instance with no provider is a *valid* instance: the Assistant explains what is
missing and the editor keeps working.

### UI-PHASE-05 — Copilot chat, context and session

**Delivers.** The context ladder (`GLOBAL → WORKFLOW → NODE → EXECUTION → EVENT`) with the scope
chip, the context panel (`used`, `budget`, `remaining`, session, previous session, continuation,
memory loaded, tools loaded, reserved output), the session line, and the rollover flow
(`NORMAL → PREPARE → ROLLOVER`, `context.compact`, `context.compacted`).

**Depends on.** UI-PHASE-03, UI-PHASE-04.

**Tests.** Rollover produces a new session with `continuationOf` linked and no data loss visible to
the user; a filled window never renders as an error; scope changes are visible in the chip; the
panel keeps the canvas scroll position in drawer mode.

**Exit gate.** A long conversation survives a rollover without the user seeing a failure.

### UI-PHASE-06 — Trace, agents, approvals, artifacts

**Delivers.** The Trace tab (operational rows, bounded and virtualized, ordered by
`(timestamp, sequence)`), the Agents tab (single agent line, `Agents n`, delegation tree), the
approval card in chat/trace/status bar, the Files tab with per-kind preview and the
`Preview · Apply · Open · Download · Compare · Revert` actions (gated by approval where declared),
and decision cards with reason summaries and evidence references.

**Depends on.** UI-PHASE-05. Consumes `ai.agent-events` (26 types), `ai.agent-runtime`,
`ai.agent-delegation`, `ai.approval`, `ai.artifact`.

**Tests.** Trace ordering and drop counting; a paused run is never "completed"; a child agent shows
only its granted capabilities; an expired approval resolves as `denied`; a failed artifact apply
reports partial state; artifacts render no payload inline.

**Exit gate.** One full delegated run is reconstructable from the Trace tab alone, with references
instead of payloads.

### UI-PHASE-07 — Skills and memory *(waits for XA-11, XA-12)*

**Delivers.** `Skills n active` → skill list → skill detail (procedure, capabilities, validators,
references, token budget, version), and `Memory n relevant` → relevant items by kind → `Open Memory
Graph`. Until the decisions resolve: both surfaces render `capability-unavailable` with the reason
and no mock data.

**Depends on.** UI-PHASE-06, plus a manager decision publishing `ai.skill` / `ai.memory` (or an explicit
statement that the frontend owns them as presentation-only).

**Tests.** No skill/memory state is sent to the backend while unpublished; counts come from data
already loaded; the graph is L3-only and paged.

**Exit gate.** The chips render truthful counts or an honest "not published" state.

### UI-PHASE-08 — MCP, runtimes, workspace *(waits for XA-16, XA-13)*

**Delivers.** Capability-first MCP presentation (`github.search — MCP`) with lazy advanced details
(server, transport, health, tools loaded, availability), the runtime line in agent detail
(kind, version, availability, locality, supports) with lazy resource cost, and the workspace view
(project, status, runtime, terminal state, tree) with explicit scope.

**Depends on.** UI-PHASE-06, plus the MCP capability decision and the workspace contract (today
`workspace.projects` is `unsupported`, contract `0.0.0`).

**Tests.** No MCP tool dump (capability first); a runtime with `supports.cancellation: false` has no
cancel action; workspace renders `feature-unsupported` until a declaration exists; no host path is
ever shown.

**Exit gate.** An external runtime is optional in every flow: local-only and remote-only instances
both render complete, non-degraded surfaces.

### UI-PHASE-09 — Node creator, translation, token & usage *(waits for XA-15, XA-14, XA-17)*

**Delivers.** `Create with AI` (Describe → Draft → Validate → Test → Preview → Install) with the
seven creation methods as peers (Visual, Declarative, OpenAPI, Script, Subworkflow, Native,
Rust/WASM), the compact language control (`Language`, `Response language: Auto`, `Translate
response`), and the usage view (`Message`, `Context`, `Output`, `Total`, `Source`) fed by whatever
is *reported*.

**Depends on.** UI-PHASE-06; each sub-surface gated by its decision.

**Tests.** The AI flow never bypasses `workflow.validate`; Rust/WASM is never the default;
`source: estimated` is visibly different from `reported`; a translation action is absent while
XA-14 is open.

**Exit gate.** Creating a node with AI produces a validated draft and an installable preview, or
explains which declared step is missing.

### UI-PHASE-10 — Hardening

**Delivers.** Accessibility and localization completeness across every surface (keyboard map,
live-region behaviour, RTL pass, contrast, reduced motion, 200% zoom, touch targets), the
performance pass (lazy discipline audited per surface, virtualization limits, no polling,
boot-payload confirmation), the mobile pass, and the final evidence set.

**Depends on.** UI-PHASE-04–UI-PHASE-09.

**Tests.** The full state matrix has no blank cell; every string resolves in all six locales with
`ar` RTL; a trace of 200 rows renders within the interactive budget; the boot descriptor is
unchanged; conformance and evidence are green.

**Exit gate.** The AI experience ships as an extension of n8n — keyboard only, Arabic, on a laptop
and on a phone — with the editor unaffected when AI is absent.

---

## 4. What no phase does

- No model inference, no provider client, no tool-gateway client, no GitHub client.
- No external agent runtime, no simulation runtime, no Rust Agent Machine.
- No second chat surface, no second event stream, no second approval path.
- No vocabulary invented for the backend; no version guessed for an unpublished contract.
- No feature that requires every runtime to be local.
- No AI surface that can block the workflow editor.

Each of these maps to a hard stop in the brief: if a phase appears to need one of them, it stops and
goes to the manager as a decision record, like XA-11 … XA-18.
