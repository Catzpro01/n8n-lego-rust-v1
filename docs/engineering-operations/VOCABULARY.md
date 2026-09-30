# Vocabulary protocol — PROGRAM / MILESTONE / SLICE / PRIORITY are four namespaces

**Status:** authoritative. **Owner:** manager. **Anchor:** Owner Master Prompt "CANONICAL
VOCABULARY SEPARATION" (2026-09-29).
**Machine-readable twin:** `docs/n8n-lego/milestones.json` → `governance.terminology`.
**Regression gate:** `apps/n8n-lego/test/governance-vocabulary.test.mjs`.

> Scope boundary: this is ENGINEERING OPERATIONS (how the repository names its work), not n8n
> LEGO product architecture. Nothing here is a product domain or capability.

## 0. The absolute rule

```text
PROGRAM ID  ≠  PRIORITY ID

P0            = Program P0 (Core Application Bootstrap)      — identity
Priority-00   = operational urgency (Security / Trust)       — overlay

P5            = Program P5 (Identity / Auth / Credentials)   — identity
Priority-05   = root-cause hardening                         — overlay

P5-M05        = existing canonical slice inside Program P5   — identity
```

No operating report may read `P0` as "priority". No canonical governance record may read
`Priority-05` as "Program P5". A token that can be read two ways is a defect, not a shorthand.

The four concepts, in order:

```text
PROGRAM   ↓ owns        canonical identity, P0–P11, permanent
MILESTONE ↓ groups      delivery stage inside a program, historical, immutable
SLICE     ↓ delivers    one PR, canonical work identity, Pn-Snn / Pn-Mnn
PRIORITY  → overlays    urgency of acting on any of the above, Priority-00..06
```

**Urgency and identity are orthogonal dimensions.** One work item carries both:

```text
PRIORITY: Priority-01     (merge backlog — urgent)
PROGRAM:  P5              (Identity / Authentication / Authorization / Credentials)
SLICE:    P5-M05          (multi-host state)
```

---

## 1. PROGRAM — canonical identity, never renamed

```text
P0 … P11
```

Source of truth: `docs/n8n-lego/milestones.json` → `programs[].id`. Per
`governance.noNewTopLevelMilestones`, **P0–P11 is the complete top-level set**: no `P12+` is
created for features, optimization, hardening or debt, and `P24+` is forbidden.

| ID | Title |
| --- | --- |
| `P0` | Core Application Bootstrap |
| `P1` | n8n Compatibility / Behavioral Baseline |
| `P2` | LEGO / AI / Plugin Foundation |
| `P3` | Workflow + Execution + Unlimited Nodes |
| `P4` | Trigger / Webhook / Ingress |
| `P5` | Identity / Authentication / Authorization / Credentials (Security) |
| `P6` | Node Registry / Node Runtime |
| `P7` | Dynamic Parameters / Schema Runtime |
| `P8` | Storage / Data Layer |
| `P9` | Observability / Diagnostics / Operations |
| `P10` | Multi-Tenant / Isolation / Quota |
| `P11` | Worker / Distributed Scaling / HA |

**Never** rename `P5` → `PROGRAM-05`. Old Program IDs remain valid forever; historical
references (PRs, issues, evidence, decisions, merge SHAs) must keep resolving.

Legacy `P12`–`P23` were consolidated into `futurePrograms[]` as `FUTURE-*` with traceability.
A bare `P12`–`P23` in a historical document is a **legacy program reference**, not a priority.

## 2. MILESTONE — grouping inside a program, historical and immutable

Two milestone shapes already exist canonically. **Both are preserved; neither is renamed.**

| Shape | Example | Meaning | Mutable? |
| --- | --- | --- | --- |
| Sub-milestone dot notation | `P2.11` … `P2.27`, `P2.27.0` … `P2.27.10`, `P9.6`, `P6.23`, `P4.8` | The historical granular ladder inside a Program | **No** — `governance.rule`: "the `milestones[]` array is the historical P2 granular ladder and stays immutable" |
| Maintenance slice | `P5-M01` … `P5-M10` | P5 debt as maintenance slices | Identity frozen; status changes normally |

> **The letter `M` inside a historical slice ID (`P5-M05`) is NOT evidence of one global
> Milestone namespace.** It is part of that slice's canonical identifier. Do not "normalize" it.

**New** milestone groupings, if ever needed, use an explicitly labelled form and never a bare
`Pn`:

```text
MILESTONE-01   /   Milestone 01
```

Do not create a new Milestone to decorate nomenclature. If no canonical grouping exists for a
work item, report `MILESTONE: N/A` — **never invent one.**

## 3. SLICE — canonical work identity, never renamed

```text
P2-S07   P2-S29   P5-M05   P5-M06   P6-S05   P8-S01   P3 Slice A   P3 Slice M
```

A slice ID is the identity of one delivery (`DEC-0014`: exactly one delivery PR per slice).
`P2-S07` reads as "a slice inside Program P2". Slice IDs are **never** changed for vocabulary
reasons; changing one would orphan its PR, merge SHA, evidence file and checkpoint history.

## 4. PRIORITY — operational urgency overlay, `Priority-NN` only

The Manager urgency ladder. **This namespace may not use `P0`–`P6`.**

| Token | Meaning |
| --- | --- |
| `Priority-00` | Security / Trust |
| `Priority-01` | Merge Backlog |
| `Priority-02` | CI / Runner |
| `Priority-03` | Blocker Removal |
| `Priority-04` | Authorized Delivery |
| `Priority-05` | Root-Cause Hardening |
| `Priority-06` | Future / Optional |

In prose, `Priority-04` / `priority-04` are both acceptable renderings. `P4` is not.

**A priority never appears alone in a work record.** It is always paired with the identity it
overlays — see §5.

## 5. Required report format

Every Manager and Worker report about a work item uses these fields, in this order:

```text
PRIORITY:
PROGRAM:
MILESTONE:
SLICE:
BRANCH:
PR:
HEAD SHA:
STATUS:
EVIDENCE:
```

Worked example:

```text
PRIORITY:  Priority-04
PROGRAM:   P5
MILESTONE: N/A
SLICE:     P5-M05
BRANCH:    delivery/p5-m05-multi-host-state
PR:        #401
HEAD SHA:  0123abcd
STATUS:    in-progress
EVIDENCE:  docs/n8n-lego/evidence/P5-M05-EVIDENCE.md
```

Rules:
- `MILESTONE: N/A` when no canonical grouping exists. **Do not fabricate.**
- `STATUS` uses only `governance.statusVocabulary`: `implemented`, `in-progress`, `planned`,
  `proposed`, `blocked`, `deferred`, `superseded`, `retired`, `rejected`.
- `PRIORITY` is optional on a delivery record and **mandatory** on a Manager triage/backlog
  record. It never changes `STATUS` and never contributes to progress.

---

## 6. Collision register — every namespace that uses a `Pn`-shaped token

Found by exhaustive scan of 1.573 first-party files (13.688 `Pn` occurrences; 11.493 structural
IDs + 3.219 bare). **This table is the authority on how to read each one.**

| # | Namespace | Tokens | Where | Status under this protocol |
| --- | --- | --- | --- | --- |
| 1 | **PROGRAM** | `P0`–`P11` | `milestones.json` `programs[]`, README, `.ai/`, evidence | **Canonical. Never renamed.** |
| 2 | **LEGACY PROGRAM** | `P12`–`P23`, `P24` | historical docs, `futurePrograms[]` traceability | Historical reference. Read as legacy Program. Never a priority. |
| 3 | **SUB-MILESTONE** | `P2.11`–`P2.27.10`, `P9.6`, `P6.23`, `P4.8` | `milestones.json` `milestones[]`, contract-lock notes, evidence | Canonical + **immutable**. Distinguished by the dot. |
| 4 | **SLICE** | `P2-S07`, `P5-M05`, `P3 Slice A` | `milestones.json`, PRs, evidence | Canonical identity. Distinguished by `-S` / `-M` / ` Slice `. |
| 5 | **AI-UI IMPLEMENTATION PHASE** | formerly `P3`–`P10` | `.ai/master/AI_UI_IMPLEMENTATION_PHASES.md` | **COLLIDED with #1 — now namespaced `UI-PHASE-03`…`UI-PHASE-10`** with a crosswalk in that file. Curated doc; doc-only change; no scope/dependency/gate altered. |

The complete AI-UI phase namespace, enumerated so no reader has to infer the middle of a range:

```text
UI-PHASE-03   AI experience skeleton (no inference)
UI-PHASE-04   AI Assistant (GLOBAL)
UI-PHASE-05   Copilot chat, context and session
UI-PHASE-06   Trace, agents, approvals, artifacts
UI-PHASE-07   Skills and memory            (waits for XA-11, XA-12)
UI-PHASE-08   MCP, runtimes, workspace     (waits for XA-16, XA-13)
UI-PHASE-09   Node creator, translation, token & usage   (waits for XA-15, XA-14, XA-17)
UI-PHASE-10   Hardening
```

`UI-PHASE-01` and `UI-PHASE-02` do not exist: the sequence starts at 03 because it was written as
`P3`–`P10` and the crosswalk preserves the numbering so old references map one-to-one. The two
gaps are intentional and must not be filled.
| 6 | **TELEMETRY PRIORITY CLASS** | `P0`–`P4` | `telemetry-buffer.mjs`, `telemetry-retention.mjs`, `low-resource-mode.mjs`, `self-observability.mjs` + fixtures + tests | **COLLIDES with #1 — NOT renamed. See §7.** |
| 7 | **PROJECT PHASE** | `PHASE_1_ANATOMY` … `PHASE_5_PERFORMANCE_BENCHMARK` | `.arena/state/phases.yaml`, `PROJECT_RULES.md`, README | Distinct token shape; no `Pn` collision. The *word* "phase" is overloaded with #5 — always qualify it. |
| 8 | **DOMAIN PHASE (mislabel)** | `(phase P0)` … `(phase P8)` in prose; `phase: 'P3'`, `phase: 'P5'`, `CORACLE_PHASES`, `REPLAY_EVID_SOURCES` as **data values** | `.ai/domains/*.md`, `apps/n8n-lego/src/compat/capability.mjs`, `src/lego/contract-oracle.mjs`, `src/lego/replay-evidence.mjs` | **This is namespace #1** — a canonical Program ID rendered under the word "phase". Read as Program. Not renamed: these are contract-fed data fields (`capability-conformance` validates them against the LEGO registry). Registered in the sweep allowlist. See §8. |
| 9 | **MANAGER OPERATIONAL PRIORITY** | formerly `P0`–`P6` | Manager protocol / triage | **Now `Priority-00`…`Priority-06`** (§4). See §8 for the two surviving ambiguous literals. |
| 10 | **RESOURCE PRIORITY LANE** | `system`, `interactive`, `background`, `bulk`, `deferred` | `resource-guard.mjs` `GUARD_LANES` (contract `execution.guard@1.0.0`) | **Already clean** — named lanes, no `Pn`. Held up as the precedent for #6. |

## 7. Deliberately NOT changed: telemetry priority classes (namespace #6)

`P0`–`P4` are the **telemetry priority classes** of three contracts locked at v1.0.0:

| Contract | Version | Frozen export |
| --- | --- | --- |
| `observability.telemetry-buffer` | 1.0.0 | `TELEMETRY_PRIORITY_CLASSES = ['P0','P1','P2','P3','P4']`, `TELEMETRY_PRIORITY_DESCRIPTIONS` |
| `observability.telemetry-retention` | 1.0.0 | `RETENTION_PRIORITIES = ['P0','P1','P2','P3','P4']`, `RET_RANK`, `SIGNAL_DEFAULT_PRIORITY` |
| `observability.low-resource-mode` | 1.0.0 | `['P0','P1','P2','P3','P4']` |

Their meanings are **not** the Manager ladder and are not interchangeable with it:

| Token | Telemetry meaning (`#101` deep design §12) | Manager meaning under this protocol |
| --- | --- | --- |
| `P0` | security / audit / safety evidence — never shed by pressure | Security / Trust |
| `P1` | failure / error diagnostics | Merge Backlog |
| `P2` | execution lifecycle | CI / Runner |
| `P3` | performance telemetry | Blocker Removal |
| `P4` | debug / verbose telemetry — shed first | Authorized Delivery |

Blast radius measured: **10 files, ~178 occurrences**, including `contract-lock.json` (64),
serialized JSON fixtures (`apps/n8n-lego/test/fixtures/p9/*.json` — `"priority": "P0"` is a
**data format**, not a label), and 5 test files.

**Why this protocol does not rename them:**

1. They live in **locked contracts at v1.0.0**. Changing an exported frozen vocabulary is a
   contract-breaking change requiring a version bump and an ADR — that is *delivery*, and
   `GOVERNANCE SAFETY` states plainly: *vocabulary cleanup is not delivery.*
2. `ADR-0001` puts the contract above the runtime. A cleanup task does not outrank a locked
   contract.
3. The values are **serialized**. Renaming silently invalidates stored fixtures and any
   persisted telemetry record — a compatibility break with no measured benefit, which
   `ADR-0005`'s justification gate would reject.
4. The two scales are **different concepts** (5 values, record-shedding criticality vs 7 values,
   human urgency). Unifying them would be a semantic error, not a cleanup.

**Disambiguation actually applied instead (zero-risk):** the collision is now *documented and
scoped* — namespace #6 is registered in §6, pinned by the regression test in
`governance-vocabulary.test.mjs` (which asserts these three contracts are the **only** place
`P0`–`P4` may carry priority semantics), and cross-referenced from `governance.terminology` in
the canonical register. A reader or tool can now tell #1 from #6 deterministically without
touching a contract.

**If the owner wants them renamed anyway**, that is a separate, authorized delivery:
ADR + contract minor/major bump for all three contracts + fixture migration + test updates +
`CHANGE CONTRACT` recipe (`.ai/recipes/CHANGE_CONTRACT.md`). Recorded here as
`AMBIGUITY-01` in §9.

## 7b. The regression gate, and why it uses an allowlist

`apps/n8n-lego/test/governance-vocabulary.test.mjs` (23 tests) is the guard §14 requires. Its
central mechanism is a **declared allowlist of every first-party source file that carries a quoted
`Pn` data value**, each row naming the namespace that value means:

```js
const QUOTED_PN_ALLOWLIST = Object.freeze({
  'apps/n8n-lego/src/lego/telemetry-buffer.mjs':     'telemetryPriorityClass',
  'apps/n8n-lego/src/lego/telemetry-retention.mjs':  'telemetryPriorityClass',
  'apps/n8n-lego/src/lego/low-resource-mode.mjs':    'telemetryPriorityClass',
  'apps/n8n-lego/src/lego/self-observability.mjs':   'telemetryPriorityClass',
  'apps/n8n-lego/src/compat/capability.mjs':         'program',
  'apps/n8n-lego/src/lego/contract-oracle.mjs':      'program',
  'apps/n8n-lego/src/lego/replay-evidence.mjs':      'program',
  'packages/frontend-lego/test/03-errors.test.mjs':  'program',
  'packages/frontend-lego/test/14-negotiation.test.mjs': 'program',
});
```

Design decisions, each one deliberate:

- **Quoted literals only.** The sweep matches `(['"])P[0-6]\1`. A quoted `'P3'` is a serialized
  vocabulary value — a data format, the thing that actually collides. Prose and comments are left
  alone on purpose: they legitimately reference canonical Programs (`"no scheduler, queue or retry
  policy (P4)"` in `runtime-pool.mjs`) and slices (`"P3 Slice D"` in `bounded-frontier.mjs`,
  `"P3 Slice M"` in `resource-guard.mjs`). Sweeping prose produced three false positives in
  development and would make the guard unusable.
- **Fails in both directions.** An unregistered file fails; an allowlist row whose file no longer
  quotes any `Pn` also fails, so the list cannot rot into a lie.
- **Cross-checked against the register.** Every quoted `Pn` in a row marked `program` must be a
  real Program ID in `programs[]`, so the allowlist cannot launder an invented identifier.
- **Not vacuous.** One test asserts both registered namespaces are genuinely present, so a
  refactor that empties the files cannot make the guard pass by having nothing to check.
- **The Manager ladder is never serialized.** No source file anywhere may carry
  `'Priority-0n'` as a data value: `Priority-NN` is a *reporting* vocabulary, not a runtime one.
  This is the guard that stops the new namespace from becoming a sixth collision.
- **Reverse guard on the locked contracts.** A separate test asserts the three telemetry contracts
  are *still* `v1.0.0` and *still* freeze `['P0','P1','P2','P3','P4']`. If a future cleanup renames
  a locked contract without an ADR and a version bump, that test fails — the protection runs both
  ways.
- **Progress is pinned.** `headlineMetrics` and `accountingBreakdown` are asserted at
  189/193 = 97.9% and 190/199 = 95.5%, plus the raw 200-row census (191 implemented, 2 proposed,
  7 planned). A vocabulary PR that moves any of them is claiming delivery it did not make.

The gate found namespace #8 during its own development: `capability.mjs`, `contract-oracle.mjs`
and `replay-evidence.mjs` carry canonical Program IDs as quoted data values under a field the
codebase names `phase`. They are registered above rather than renamed, because
`capability-conformance.mjs` validates those values against the LEGO registry and they are
contract-fed.

## 8. Ambiguous literals that were NOT auto-fixed — authority required

Per `NO BLIND REFACTOR`: where a token's intended namespace could not be determined without
inventing meaning, it was **reported, not chosen**.

### AMBIGUITY-02 — `(P0 CONSTITUTION)` / `(P0 Governance)`

- **field:** heading label in `PROJECT_RULES.md` §0 and `README.md` §"Governance & Single Source of Truth"
- **current meaning:** primacy — "these are the highest-authority rules"
- **possible meanings:** (a) operational priority; (b) Program `P0`; (c) bare ordinal
- **evidence:** Program `P0` = *Core Application Bootstrap* (`milestones.json` `programs[0]`),
  which is about app bootstrap, runtime host, packaging — **not** a constitution. So reading (b)
  is demonstrably wrong. Reading (a) would map to `Priority-00` = *Security / Trust*, which is
  also not what a constitution is.
- **why not auto-fixed:** every available replacement asserts something false. Mapping to
  `Priority-00` mislabels the constitution as a security queue item; mapping to Program `P0`
  contradicts the register. `PROJECT_RULES.md` §0 is a constitutional clause and Issue #266
  reserves rule changes to Manager authority — the *label* can be changed, but the correct new
  label is an owner decision.
- **recommended schema:** drop the `Pn` token entirely — `## 0. GOVERNANCE & SINGLE SOURCE OF
  TRUTH (CONSTITUTIONAL — highest authority; not Program P0, not Priority-00)`. Meaning
  preserved, collision removed, nothing false asserted.
- **authority required:** owner confirmation of the wording (Manager may then apply it to both
  files in one commit; README lines 1–30 are hand-written, outside the generated block at
  lines 31–598, so the edit survives `npm run lego:ai`).

### AMBIGUITY-03 — `(P1: ExecutionContext, ExecutionFrame, NodeExecutor, Data Plane)`

- **field:** the `FEATURE & NODE FREEZE` clause — `PROJECT_RULES.md` §0.5 and `README.md` §29
- **current meaning:** an ordinal enumerator listing the Kernel Runtime IR spec items that must
  land before the freeze lifts
- **possible meanings:** (a) Program `P1`; (b) operational priority; (c) ordinal list marker
- **evidence:** Program `P1` = *n8n Compatibility / Behavioral Baseline* — unrelated to the
  Runtime IR. `Priority-01` = *Merge Backlog* — also unrelated. The four listed items exist as
  `crates/n8n-workflow/src/runtime/{ir,frame,executor,context}.rs`, i.e. this is a spec-item
  list.
- **why not auto-fixed:** this token sits inside a **freeze clause**. Editing the clause's text
  while its exit condition is contested (the audit notes the IR items may already have landed)
  risks changing what the freeze *means*. That is a rule change, not a vocabulary change.
- **recommended schema:** `(IR-1: ExecutionContext, ExecutionFrame, NodeExecutor, Data Plane)`
  — or drop the label: `(namely ExecutionContext, …)`.
- **authority required:** owner/Manager ruling on the freeze clause itself.

### AMBIGUITY-01 — telemetry `P0`–`P4` (see §7)

- **authority required:** owner decision to open a contract-change delivery, or explicit
  acceptance that namespace #6 stays as-is and is disambiguated by documentation only
  (**recommended**).

## 9. What this protocol changed, and what it did not

**Changed (documentation / projection only):**

| File | Change |
| --- | --- |
| `docs/engineering-operations/VOCABULARY.md` | **new** — this protocol |
| `.ai/master/AI_UI_IMPLEMENTATION_PHASES.md` | `P3`–`P10` → `UI-PHASE-03`–`UI-PHASE-10` (21 tokens) + namespace note + crosswalk. Curated doc. No scope, dependency, exit gate or definition of done altered. `P2.5` / `P2.10` sub-milestone references preserved. |
| `docs/n8n-lego/milestones.json` | **additive** `governance.terminology` block (+ `versionPolicy`, `documentationLayers`), and `registerVersion` 2.4.0 → 2.5.0 (§12 below). No Program ID, slice ID, status, DEC ID, merge SHA, denominator, checkpoint or queue entry touched. |
| `apps/n8n-lego/test/governance-vocabulary.test.mjs` | **new** — regression gate against future collision |
| `README.md` | **new curated section** `## How to read this register` (README v2.0 documentation layer, §11 below), inserted entirely *before* the generated markers; plus one regenerated line inside the block (freshness: register 2.4.0 → 2.5.0). The hand-written `(P0 Constitution)` / `(P1: …)` lines stay untouched pending AMBIGUITY-02/03. |

**Deliberately NOT changed:**

- Program IDs `P0`–`P11` — canonical, permanent
- Slice IDs (`P2-S07`, `P5-M05`, `P6-S05`, `P3 Slice A/M`) — canonical work identity
- Sub-milestone IDs (`P2.11`–`P2.27.10`, `P9.6`, `P6.23`) — immutable historical ladder
- Legacy `P12`–`P23` references — historical traceability
- DEC IDs, merge SHAs, evidence files — historical record, never rewritten
- Any `status`, denominator, checkpoint, completion figure or `plannedQueue` entry
- Telemetry `P0`–`P4` — locked contracts (AMBIGUITY-01)
- `PROJECT_RULES.md` §0 / §0.5 labels — constitutional/freeze clauses (AMBIGUITY-02/03)

**This work is not delivery.** It adds no slice, moves no status to `implemented`, and
contributes **0** to Realtime Delivery Progress and **0** to Slice Completion. The denominators
199 (global) and 193 (current) and the numerators 190 and 189 are unchanged by design.

## 10. Operating rule from here on

Every Manager cycle uses:

```text
Priority-00 … Priority-06     for urgency          (never P0…P6)
P0 … P11                      for canonical Program identity only
P2-S07 / P5-M05 / P6-S05      for canonical Slice identity only
P2.11 / P9.6 / P6.23          for immutable historical sub-milestones only
UI-PHASE-03 … UI-PHASE-10     for AI-UI implementation phases only
Milestone-XX                  only where a canonical grouping genuinely exists
```

Before writing any `Pn` token, answer: **is this identity or urgency?** If the answer is not
obvious from the sentence, the sentence needs the namespace written out.

## 11. Documentation layers, and the README v2.0 contract

Four layers carry this repository's state. They are registered machine-readably in
`governance.terminology.documentationLayers`, and the rule between them is one line:

> **A projection may restate canonical state but may never originate it; a curated
> document may add prose but may never contradict the register.**

| Layer | Where | Kind | Versioned by |
| --- | --- | --- | --- |
| Canonical register | `docs/n8n-lego/milestones.json` | AUTHORITY | `registerVersion` |
| Generated projection | `.ai/master/MILESTONE_REGISTER.md`, the 64 generated `.ai/` files, the marker-delimited block in `README.md` | GENERATED | re-rendered by `npm run lego:ai`, verified by `npm run lego:ai:check` |
| Curated prose | this document, `.ai/master/AI_UI_IMPLEMENTATION_PHASES.md`, `README.md` outside the markers | CURATED | by hand; the generator must never delete or replace it |
| README documentation layer | `README.md` → `## How to read this register` | CURATED | `README v2.0` |

### What "README v2.0" is a claim about

`README.md` on `main` declares **no version string of its own** — its only version marker
is the generated freshness line (`from register <registerVersion>, fingerprint <hash>`).
So "v2.0" is a *new* label, and section 2 of the owner directive permits a new version
string only together with a documented contract. This is that contract:

```text
README v2.0 ==
  the README states, in human-readable form and immediately before the generated
  register table, the five namespaces a reader meets there
      PROGRAM   P0-P11        with the canonical program titles
      PRIORITY  Priority-00..06 with the owner-defined meanings
      MILESTONE Pn.m          historical, immutable; N/A rather than invented
      SLICE     Pn-Snn / Pn-Mnn / Pn.m / <FUTURE-PROGRAM>-Snn
      STATUS    governance.statusVocabulary, exactly
  + the rule that a namespace must not be inferred from another namespace
  + an explicit statement that the README is a projection, not an authority
```

It is machine-checked, not merely asserted. `governance-vocabulary.test.mjs` verifies
that the section exists, that it sits **outside** the generated markers, that every
program title and priority meaning in it matches the register token-for-token, that the
status list matches `governance.statusVocabulary` exactly, and that the register version
the README declares equals `registerVersion`. A stale or self-promoting README fails the
gate — which is what keeps a version label from turning a projection into a second
authority.

Three corrections the gates caught while writing this section, all in the direction of
canonical state winning over prose:

- Program `P5` is `Identity / Authentication / Authorization / Credentials (Security)`.
  The directive's summary dropped the trailing `(Security)`; the register is canonical, and
  the gate compares the README table against `programs[].title` token-for-token.
- The directive rendered `Priority-02` as `CI / Runner` and this protocol keeps that
  spelling, because it is what `terminology.namespaces.priority.scale` already said.
- **The directive's illustrative record used concrete IDs (a `Slice:` written as a live
  `Pn-Snn`, and a `Milestone:` written as a live `Milestone-NN`). The README layer must not.** A pre-existing invariant on
  `main`, `apps/n8n-lego/test/governance-register.test.mjs:331` *"README states no
  milestone truth outside the generated block"*, rejects any `Pn.m` / `Pn-Snn` / `Pn-Mnn`
  outside the marker-delimited block — precisely so a curated layer cannot become a second
  authority or go stale. The first draft of this section listed `P2-S07`, `P5-M05`,
  `P2.11`, `P2.13` and `P2.27` as examples and failed that gate.

  The gate was **not** weakened to accommodate the new prose; the prose was corrected. The
  layer now teaches *shapes* — `Pn-Snn`, `Pn-Mnn`, `Pn.m`, `Milestone-nn` — and leaves
  every concrete ID to the generated table, which the generator keeps current. Bare
  `P0`–`P11` remain allowed outside the block, because a Program ID is permanent identity
  rather than state. `governance-vocabulary.test.mjs` now asserts the same invariant from
  the vocabulary side (*"the README layer teaches shapes and states no canonical slice or
  milestone fact"*), so the two gates cannot drift apart.

  This is the worked form of the layer rule: a projection may **explain** canonical state,
  it may not **restate** it.

## 12. The register version decision: 2.5.0, not 3.0.0

Section 2 of the directive asked for two things at once: hit `v3.0`, and *first* determine
from the repository's existing semantics whether the change is genuinely MAJOR, never
moving a version string cosmetically. The second instruction governs, because the evidence
is unambiguous.

Every `registerVersion` transition in the history of `docs/n8n-lego/milestones.json`:

| To | Commit | Subject | Class |
| --- | --- | --- | --- |
| `1.0.0` | `3d456a3f` | Implement P2.13 context and session foundation | creation |
| `2.0.0` | `8b7bd19b` | governance reset (#256): one canonical register for P0-P11, slices, future programs and features | **MAJOR — re-foundation** |
| `2.1.0` | `5468b2d4` | governance: milestone truth is Main-Owned (DEC-0020) | MINOR — additive rule |
| `2.2.0` | `7084a123` | governance: split realtime progress from slice completion | MINOR — additive rule |
| `2.3.0` | `c2b519d6` | governance: live milestone progress telemetry (DEC-0021) | MINOR — additive rule |
| `2.4.0` | `45733fa2` | governance(milestone): authorize P7 as P7-S01..S08 per #223 §42 (DEC-0024) | MINOR — additive authorization |

The protocol this establishes: **MAJOR means the register was re-founded and existing
identifiers or consumers were invalidated. MINOR means an additive governance rule that
invalidates nothing.** `registerVersion` is semver and
`packages/frontend-lego/test/33-milestones.test.mjs:55` enforces the shape.

This cycle adds two keys (`governance.terminology`, and inside it `versionPolicy` /
`documentationLayers`) plus one curated README section. It invalidates no identifier,
forces no consumer to migrate, and moves no canonical state — that is the whole point of
sections 7 and 15 of the directive. By the repository's own precedent it is a **MINOR**
bump: `2.4.0 → 2.5.0`.

Writing `3.0.0` instead would publish a claim that a canonical reset happened when one
deliberately did not. That is a false canonical-state assertion, and it is the specific
failure mode sections 15 and 16 exist to prevent.

**AUTHORITY — open, owner decision required.** If the owner wants the *label* `3.0.0`, the
honest route is to define the contract change that makes it MAJOR (for example: adopting
`Milestone-XX` as a real grouping namespace, which would be a genuine schema migration and
would touch `currentMilestone`, `previousCompletedMilestone`, `milestones[]` and
`governance.sliceNaming`). That is a delivery, with an ADR, not a rename of a string.
Until such a ruling, `2.5.0` stands and the question is recorded in
`governance.terminology.versionPolicy.v3Question` rather than silently resolved either way.

## 13. The word "vocabulary" is itself overloaded

The directive's target is *one term, one meaning*. The first pass of this protocol missed
one collision, and it is the word the protocol is named after.

| Sense | Where | What it governs |
| --- | --- | --- |
| **Capability vocabulary lock** | `packages/frontend-lego/src/vocabulary.mjs` — `VOCABULARIES`, `LOCAL_VOCABULARIES`, `DECLARED_OVERLAPS`, `QUOTED_FROM`, `assertTerm`, `compareVocabulary`, `detectCollisions`, `vocabularyDrift`; tested by `packages/frontend-lego/test/24-vocabulary.test.mjs` against `docs/n8n-lego/decisions/cross-agent-decisions.json` | Shared **capability terms** (availability states, operation states, capability IDs, change kinds, compatibility, sub-LEGO statuses, interaction classes), quoted with provenance so the frontend and the backend foundation do not grow two dialects for one concept |
| **Identifier namespaces** | this document + `governance.terminology` + `apps/n8n-lego/test/governance-vocabulary.test.mjs` | **Identifier shapes**: `P0`–`P11`, `Priority-00`–`06`, `Pn-Snn`, `Pn-Mnn`, `Pn.m`, `UI-PHASE-NN` |

The two are disjoint and stay that way: neither reads, renames, validates or versions the
other, and no term in the capability lock carries a `Pn` token. Both are named
"vocabulary" because both prevent one string from meaning two things — the same goal, at
two different layers. Registered here so that a future reader who greps for "vocabulary"
lands on both and does not conclude one of them is dead code.
