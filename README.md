# n8n-rust-v.4

High-Performance Rust Port of n8n with Arena AI Virtual SSH Engine.

The port never rewrites n8n from guesswork: n8n 2.9.4 is the behavioral
reference, every component is isolated behind an explicit contract, and only then
is a Rust replacement attempted.

## Project status

| Stage | State |
| :--- | :--- |
| ANATOMY (`docs/anatomy/`) | ✅ Completed |
| CONTRACT (`contracts/`) | ✅ Completed |
| REFERENCE SOURCE (`reference/n8n/`, n8n 2.9.4) | ✅ Completed |
| REFERENCE RUNTIME (baseline 11/11 smoke test) | ✅ Completed |
| WORKFLOW ISOLATION & LEGOS (01–04) | ✅ VERIFIED |
| **CURRENT PHASE** | **🚀 PHASE 3 — RUST RUNTIME (ACTIVE)** |
| RUST IMPLEMENTATION (8 Workspace Crates) | ✅ **ACTIVE** (`crates/` compiled & passing all tests) |

## Governance & Single Source of Truth (P0 Constitution)

Proyek ini berada di bawah tata kelola arsitektur tunggal (P0 Governance):
1. **Fase Resmi: PHASE 3 — RUST RUNTIME (ACTIVE)**. Fase isolasi Phase 2 telah selesai dan terverifikasi. Seluruh pengembangan runtime saat ini berada di Phase 3.
2. **Status Rust: ACTIVE**. Status Rust bukan lagi "not started" atau "reserved". Cargo workspace mendefinisikan dan mengompilasi 8 crates aktif (`n8n-common`, `n8n-workflow`, `n8n-connection`, `n8n-validation`, `n8n-node-model`, `n8n-execution-data`, `n8n-expression`, `n8n-nodes-rust`).
3. **Single Source of Truth**: Branch `main` adalah satu-satunya acuan kebenaran mutlak bagi semua agen. Dilarang melakukan rollback ke zero-Rust atau mengklaim fase sebelum Phase 3.
4. **Compatibility Baseline (n8n v2.9.4)**: Perilaku referensi n8n v2.9.4 dan kontrak formal dipertahankan penuh sebagai standar keabsahan perilaku engine.
5. **LEGO = Development Boundary, Bukan Runtime Overhead**: Pembagian LEGO hanya berfungsi sebagai batas modul dan pemisahan tugas saat isolasi/pengembangan. Pada hot-path runtime, engine tidak memecah eksekusi menjadi lapisan serialisasi JSON / IPC antar-crate yang berat, melainkan menggunakan representasi Runtime IR terpadu dengan alokasi minimal/zero-copy.
6. **Feature & Node Freeze**: Penambahan node baru dibekukan sementara hingga arsitektur Kernel Runtime IR (P1: `ExecutionContext`, `ExecutionFrame`, `NodeExecutor`, Data Plane) dibakukan.

<!-- BEGIN GENERATED milestone-governance: npm run lego:ai renders this block from docs/n8n-lego/milestones.json; do not edit by hand -->
## Overall Milestone Progress

Status is not progress. Both percentages below are generated from [`docs/n8n-lego/milestones.json`](docs/n8n-lego/milestones.json). They are not estimated from time, PR count or lines of code. Rounding is half-up to one decimal, never a ceiling.

### Realtime Delivery Progress

**85.6%**

`█████████████████░░░ 85.6%`

Checkpoint-weighted earned points / current-delivery points: 16600 / 19400. Denominator: programs P0–P11 only (194 active slices). Future programs are excluded. 57 slice(s) declare checkpoints. 129 implemented slice(s) have no checkpoint list and contribute 100 each. 8 slice(s) have no checkpoint model and contribute 0. A 0 from a missing model is not a measured fraction of that slice.

### Slice Completion

**85.6%**

`█████████████████░░░ 85.6%`

**166 / 194 slices implemented** in the same P0–P11 denominator. Only `implemented` increases this numerator. Verifying, blocked, in-progress, planned, proposed and deferred contribute 0. Superseded, retired and rejected stay out of the denominator.

| | |
| --- | ---: |
| Current-delivery slices | 194 |
| Implemented (completion numerator) | 166 |
| Verifying (display status; completion contribution 0) | 0 |
| In progress, not verifying | 0 |
| Planned | 24 |
| Blocked | 2 |
| Proposed | 2 |
| Deferred | 0 |
| Future-program slices excluded from both denominators | 6 |

```text
P0   realtime ████████████████████ 100.0%  completion 100.0%  2/2  status complete
P1   realtime ████████████████████ 100.0%  completion 100.0%  2/2  status complete
P2   realtime █████████████░░░░░░░  65.0%  completion  65.0%  39/60  status complete
P3   realtime ████████████████████ 100.0%  completion 100.0%  18/18  status complete
P4   realtime ████████████████████ 100.0%  completion 100.0%  10/10  status complete
P5   realtime ██████████████████░░  88.5%  completion  88.5%  23/26  status complete
P6   realtime ███████████████████░  94.4%  completion  94.4%  34/36  status complete
P7   realtime ████████████████████ 100.0%  completion 100.0%  8/8  status in-progress
P8   realtime ████████████████████ 100.0%  completion 100.0%  7/7  status planned
P9   realtime ████████████████████ 100.0%  completion 100.0%  23/23  status complete
P10  realtime ░░░░░░░░░░░░░░░░░░░░   0.0%  completion   0.0%  0/1  status planned
P11  realtime ░░░░░░░░░░░░░░░░░░░░   0.0%  completion   0.0%  0/1  status planned
```

## Program Overview

| Program | Focus | Realtime | Slice completion | Implemented | State |
| --- | --- | ---: | ---: | ---: | --- |
| P0 | Core Application Bootstrap | 100.0% | 100.0% | 2/2 | complete |
| P1 | n8n Compatibility / Behavioral Baseline | 100.0% | 100.0% | 2/2 | complete |
| P2 | LEGO / AI / Plugin Foundation | 65.0% | 65.0% | 39/60 | complete |
| P3 | Workflow + Execution + Unlimited Nodes | 100.0% | 100.0% | 18/18 | complete |
| P4 | Trigger / Webhook / Ingress | 100.0% | 100.0% | 10/10 | complete |
| P5 | Identity / Authentication / Authorization / Credentials (Security) | 88.5% | 88.5% | 23/26 | complete |
| P6 | Node Registry / Node Runtime | 94.4% | 94.4% | 34/36 | complete |
| P7 | Dynamic Parameters / Schema Runtime | 100.0% | 100.0% | 8/8 | in-progress |
| P8 | Storage / Data Layer | 100.0% | 100.0% | 7/7 | planned |
| P9 | Observability / Diagnostics / Operations | 100.0% | 100.0% | 23/23 | complete |
| P10 | Multi-Tenant / Isolation / Quota | 0.0% | 0.0% | 0/1 | planned |
| P11 | Worker / Distributed Scaling / HA | 0.0% | 0.0% | 0/1 | planned |

A program state of `complete` is not numeric 100%. Read the two percentage columns.

## Active Execution

### Active work

The queue is `executionPointer` only. Historical `P2.27` is not the next slice, and there is no `P2.28`.

```text
 1. `P5-M18` planned; realtime 0.0%; completion contribution 0.0%
 2. `P5-M06` planned; realtime 0.0%; completion contribution 0.0%
 3. `P2-S10` planned; realtime 0.0%; completion contribution 0.0%; updated 2026-09-27T09:30:00Z
 4. `P2-S11` planned; realtime 0.0%; completion contribution 0.0%; updated 2026-09-27T09:30:00Z
 5. `P2-S12` planned; realtime 0.0%; completion contribution 0.0%; updated 2026-09-27T09:30:00Z
 6. `P2-S13` planned; realtime 0.0%; completion contribution 0.0%; updated 2026-09-27T09:30:00Z
 7. `P2-S14` planned; realtime 0.0%; completion contribution 0.0%; updated 2026-09-27T09:30:00Z
 8. `P2-S15` planned; realtime 0.0%; completion contribution 0.0%; updated 2026-09-27T09:30:00Z
 9. `P2-S16` planned; realtime 0.0%; completion contribution 0.0%; updated 2026-09-27T09:30:00Z
10. `P2-S17` planned; realtime 0.0%; completion contribution 0.0%; updated 2026-09-27T09:30:00Z
11. `P2-S18` planned; realtime 0.0%; completion contribution 0.0%; updated 2026-09-27T09:30:00Z
12. `P2-S19` planned; realtime 0.0%; completion contribution 0.0%; updated 2026-09-27T09:30:00Z
13. `P2-S20` planned; realtime 0.0%; completion contribution 0.0%; updated 2026-09-27T09:30:00Z
14. `P2-S21` planned; realtime 0.0%; completion contribution 0.0%; updated 2026-09-27T09:30:00Z
15. `P2-S22` planned; realtime 0.0%; completion contribution 0.0%; updated 2026-09-27T09:30:00Z
16. `P2-S23` planned; realtime 0.0%; completion contribution 0.0%; updated 2026-09-27T09:30:00Z
17. `P2-S24` planned; realtime 0.0%; completion contribution 0.0%; updated 2026-09-27T09:30:00Z
18. `P2-S25` planned; realtime 0.0%; completion contribution 0.0%; updated 2026-09-27T09:30:00Z
19. `P2-S26` planned; realtime 0.0%; completion contribution 0.0%; updated 2026-09-27T09:30:00Z
20. `P2-S27` planned; realtime 0.0%; completion contribution 0.0%; updated 2026-09-27T09:30:00Z
21. `P2-S28` planned; realtime 0.0%; completion contribution 0.0%; updated 2026-09-27T09:30:00Z
22. `P2-S29` planned; realtime 0.0%; completion contribution 0.0%; updated 2026-09-27T09:30:00Z
```

Latest completed slice: `P5-M17` (PR #364, merge `b616be84`).

_No verifying slice._

### Blocked

- 🔴 **P2-S03** — Frontend Evolution layers 3-6. Status: BLOCKED. Realtime 0.0%. No checkpoint model is declared, so realtime progress stays 0.0%. That 0 is not a measured fraction of the work, and evidenced work is not converted into a percentage. Current checkpoint: none declared. Latest checkpoint: none declared. Checkpoint evidence: — (no completed checkpoint). Blocker: Layers 3-5 are split into dedicated child slices P2-S07..P2-S29 (node-picker, workflow-editor, credentials, settings, webhooks, auth, navigation plus the remaining #240 Layer 3-5 surfaces: canvas, node configuration, connections, import/export, environments, integrations, execution management, project/workspace administration and the eight AI/advanced surfaces), owner-authorized for split and delivery (REQ-0003 section 6) and executing via plannedQueue. What remains blocked is the Layer 6 component this umbrella carries: legacy UI decommission is gated on parity, compatibility, performance, accessibility and migration/rollback evidence for every required surface plus a separate Manager decision (#240 authorizes no removal of reference/n8n or n8n-editor-ui; permanent invariants 1-2). The umbrella stays blocked on that Layer 6 gate and tracks its children; it is not implemented until Layer 6 is decided and delivered or the scope is formally re-scoped.. Last progress update: —. Completion contribution: 0%.
- 🔴 **P5-M10** — Public /api/v1 resources that need a backing model this product does not have yet. Status: BLOCKED. Realtime 0.0%. No checkpoint model is declared, so realtime progress stays 0.0%. That 0 is not a measured fraction of the work, and evidenced work is not converted into a percentage. Current checkpoint: none declared. Latest checkpoint: none declared. Checkpoint evidence: — (no completed checkpoint). Blocker: Backing models are decomposed into P5-M11..P5-M18 (proposed) with per-model definitions (model, contract, persistence boundary, API gating, compatibility, tests, rollback, dependencies) in docs/n8n-lego/evidence/P5-M10-DECOMPOSITION.md (REQ-0003 section 10). The umbrella stays blocked until the declared resource scope is delivered or formally re-scoped.. Last progress update: —. Completion contribution: 0%.

Planned queue (planned ≠ authorized): `P5-M18` → `P5-M06` → `P2-S10` → `P2-S11` → `P2-S12` → `P2-S13` → `P2-S14` → `P2-S15` → `P2-S16` → `P2-S17` → `P2-S18` → `P2-S19` → `P2-S20` → `P2-S21` → `P2-S22` → `P2-S23` → `P2-S24` → `P2-S25` → `P2-S26` → `P2-S27` → `P2-S28` → `P2-S29`.

Not authorized: planned is not authorized by itself: the Manager starts a queued slice by moving it to in-progress in a PR on main. AUTHORIZED FOR DELIVERY NOW (owner master prompt marathon BLOCKER-ZERO): P8-S01 storage contract foundation (queue head, blocker-clearing for P5-M05); P5-M06 password recovery with provider-neutral injected mail transport (DEC-0028 ACTIVE option A); P5-M05 multi-host state once the P8 storage contract lands; P5-M11..P5-M18 backing models one by one after P5-M05; P5-M10 audit after the models; P2-S10..P2-S29 Layers 3-5 child slices (one surface per slice, pilot mode, parity evidence). COMPLETED: P6-S05 (PR #355, merge d549d40d) and P5-M02 (same chain). NOT AUTHORIZED: the P2-S03 Layer 6 legacy UI decommission (owner-authorized decommission only after ALL gates pass); P6-S03, P6-S04 (proposed, no owner authorization for their scope); P10-S01 and P11-S01 (placeholders).

## Status Legend

- ✅ Implemented — realtime 100% when no checkpoint list is declared; the only status that adds to Slice Completion
- 🟠 Verifying — display status for a merged slice whose post-merge verification has not passed. Checkpoint progress is kept. Completion contribution 0%
- 🔵 In progress — checkpoint progress if declared, otherwise 0%. Completion contribution 0%
- 🟡 Planned — 0% until an evidenced checkpoint exists. Completion contribution 0%
- 🔴 Blocked — last evidenced checkpoint progress is kept. The blocker stays visible. Completion contribution 0%
- ⚪ Proposed — 0%. Completion contribution 0%
- Deferred — prior evidenced checkpoint progress if declared, otherwise 0%. Completion contribution 0%

## P0–P11

## P0 — Core Application Bootstrap

- **Realtime Delivery Progress:** **100.0%** `████████████████████ 100.0%`
- **Slice Completion:** **100.0%** (2 / 2 implemented). Remaining 0. 2 implemented.
- **Program status:** complete. Program status is not a percentage and is not 100% just because the word is complete.
- **Purpose:** Application bootstrap, runtime host, configuration edge, packaging baseline, process lifecycle, minimal compatibility shell (#90).
- **Checkpoint model:** 0 slice(s) declare checkpoints; 2 implemented slice(s) use the legacy 100 rule; 0 slice(s) have no checkpoint model and stay at 0.0%.

<details><summary>Slices (2)</summary>

| Slice | Title | Purpose | Status | Realtime | Completion | Current checkpoint | Latest checkpoint | Blocker |
| --- | --- | --- | --- | ---: | ---: | --- | --- | --- |
| `P0.1` | Baseline runtime | clean clone -> start -> browser smoke | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P0.2` | Distribution channels + release script | Distribution channels + release script (tarball installer, INSTALL.md) | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |

</details>

## P1 — n8n Compatibility / Behavioral Baseline

- **Realtime Delivery Progress:** **100.0%** `████████████████████ 100.0%`
- **Slice Completion:** **100.0%** (2 / 2 implemented). Remaining 0. 2 implemented.
- **Program status:** complete. Program status is not a percentage and is not 100% just because the word is complete.
- **Purpose:** Original n8n UI compatibility, workflow JSON compatibility, node catalog/behavior baseline, REST compatibility baseline, regression oracle (#90).
- **Checkpoint model:** 0 slice(s) declare checkpoints; 2 implemented slice(s) use the legacy 100 rule; 0 slice(s) have no checkpoint model and stay at 0.0%.

<details><summary>Slices (2)</summary>

| Slice | Title | Purpose | Status | Realtime | Completion | Current checkpoint | Latest checkpoint | Blocker |
| --- | --- | --- | --- | ---: | ---: | --- | --- | --- |
| `P1.1` | Phase 1 compatibility inventory | Phase 1 compatibility inventory | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P1.2` | Compatibility contract layer | Compatibility contract layer (REST/settings compatibility contracts) | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |

</details>

## P2 — LEGO / AI / Plugin Foundation

- **Realtime Delivery Progress:** **65.0%** `█████████████░░░░░░░ 65.0%`
- **Slice Completion:** **65.0%** (39 / 60 implemented). Remaining 21. 39 implemented, 20 planned, 1 blocked.
- **Program status:** complete. Program status is not a percentage and is not 100% just because the word is complete.
- **Purpose:** Contract-driven LEGO architecture, FE/BE domain boundaries, AI foundation, Agent Machine, Context/Session/Memory, Workspace, MCP boundary, portability, Node Creator, translation, usage integrity, provider adapters, readiness, P2.27 pluggable runtime/security foundation (#90).
- **Checkpoint model:** 27 slice(s) declare checkpoints; 32 implemented slice(s) use the legacy 100 rule; 1 slice(s) have no checkpoint model and stay at 0.0%.

<details><summary>Slices (60)</summary>

| Slice | Title | Purpose | Status | Realtime | Completion | Current checkpoint | Latest checkpoint | Blocker |
| --- | --- | --- | --- | ---: | ---: | --- | --- | --- |
| `P2.1-P2.4` | LEGO compatibility contract layer | LEGO compatibility contract layer (historical, pre-register) | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P2.5` | Frontend LEGO | Frontend LEGO (historical, pre-register) | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P2.6-P2.10` | Backend LEGO P2.6-P2.10 | Backend LEGO P2.6-P2.10 (historical, pre-register) | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P2.11` | Reconciliation / foundation cleanup | Reconciliation / foundation cleanup | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P2.12` | Skill | Skill | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P2.13` | Context & Session | Context & Session | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P2.14` | Memory | Memory | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P2.15` | Workspace | Workspace | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P2.16` | Agent Machine / execution foundation | Agent Machine / execution foundation | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P2.17` | Agent Machine Runtime Foundation | Agent Machine Runtime Foundation | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P2.18` | Universal Transport & Envelope Kernel | Universal Transport & Envelope Kernel | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P2.19` | Artifact, Approval & Audit Foundation | Artifact, Approval & Audit Foundation | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P2.20` | MCP vs Agent Control Boundary | MCP vs Agent Control Boundary | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P2.21` | Runtime Adapter & Harness Stack | Runtime Adapter & Harness Stack | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P2.22` | Node Compatibility & Portability | Node Compatibility & Portability | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P2.23` | Node Creator & Translation | Node Creator & Translation | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P2.24` | Token & Usage - honest accounting | Token & Usage - honest accounting | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P2.25` | External provider integration - the first real adapters | External provider integration - the first real adapters | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P2.26` | Provider, Workspace & GitHub Integration + Foundation Readiness | Provider, Workspace & GitHub Integration + Foundation Readiness | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P2.27` | Contract-Driven Pluggable Runtime & Security Foundation | Contract-Driven Pluggable Runtime & Security Foundation | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P2.27.0` | preflight & mainBaseline reconciliation to actual protected main 20ae0c1a | preflight & mainBaseline reconciliation to actual protected main 20ae0c1a | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P2.27.1` | tiny Core kernel — plugin-runtime.mjs + lego.plugin-runtime@0.1.0 | tiny Core kernel — plugin-runtime.mjs + lego.plugin-runtime@0.1.0 | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P2.27.2` | manifest + plugin registry + contract resolver | manifest + plugin registry + contract resolver (lego.plugin-runtime 0.2.0) | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P2.27.3` | capability + permission policy | capability + permission policy (lego.plugin-runtime 0.3.0) | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P2.27.4` | runtime locality policy | runtime locality policy (lego.plugin-runtime 0.4.0) | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P2.27.5` | secret broker — scoped short-lived one-shot grants | secret broker — scoped short-lived one-shot grants (0.5.0) | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P2.27.6` | resource budgets — declared limits enforced | resource budgets — declared limits enforced (0.6.0) | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P2.27.7` | supervisor — lifecycle machine + quarantine | supervisor — lifecycle machine + quarantine (0.7.0) | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P2.27.8` | circuit breaker + deadline + contract replay oracle | circuit breaker + deadline + contract replay oracle | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P2.27.9` | side-by-side upgrade + rollback + supply-chain admission | side-by-side upgrade + rollback + supply-chain admission | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P2.27.10` | frontend plugin boundary | frontend plugin boundary (final implementation slice) | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P2-S01` | Frontend LEGO migration foundation + parity harness + status-region pilot | Frontend LEGO migration foundation + parity harness + status-region pilot | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P2-S02` | Frontend LEGO shared notification surface + accessibility parity | Frontend LEGO shared notification surface + accessibility parity | ✅ Implemented | 100.0% | 100.0% | — | CP-06 Gate staleness fixed and the single-pilot rule generalized (completed, 10) | — |
| `P2-S03` | Frontend Evolution layers 3-6 | Frontend Evolution layers 3-6 (core workflow, platform, AI surfaces, legacy UI decommission) | 🔴 Blocked | 0.0% | 0.0% | none declared | none declared | Layers 3-5 are split into dedicated child slices P2-S07..P2-S29 (node-picker, workflow-editor, credentials, settings, webhooks, auth, navigation plus the remaining #240 Layer 3-5 surfaces: canvas, node configuration, connections, import/export, environments, integrations, execution management, project/workspace administration and the eight AI/advanced surfaces), owner-authorized for split and delivery (REQ-0003 section 6) and executing via plannedQueue. What remains blocked is the Layer 6 component this umbrella carries: legacy UI decommission is gated on parity, compatibility, performance, accessibility and migration/rollback evidence for every required surface plus a separate Manager decision (#240 authorizes no removal of reference/n8n or n8n-editor-ui; permanent invariants 1-2). The umbrella stays blocked on that Layer 6 gate and tracks its children; it is not implemented until Layer 6 is decided and delivered or the scope is formally re-scoped. |
| `P2-S04` | Dashboard workflow list | Dashboard workflow list (first Layer 3 surface split out of P2-S03) | ✅ Implemented | 100.0% | 100.0% | — | CP-06 Parity equivalent against reference fixtures, fail-closed (completed, 15) | — |
| `P2-S05` | Dialogs / overlays | Dialogs / overlays (workflow settings, credential modal, confirmations) — second Layer 3 surface split out of P2-S03 | ✅ Implemented | 100.0% | 100.0% | — | CP-06 Parity equivalent against reference fixtures, fail-closed (completed, 15) | — |
| `P2-S06` | Executions list | Executions list (third Layer 3 surface split out of P2-S03) | ✅ Implemented | 100.0% | 100.0% | — | CP-06 Parity equivalent against reference fixtures, fail-closed (completed, 15) | — |
| `P2-S07` | Node picker/catalog | Node picker/catalog (Layer 3 surface split out of P2-S03) | ✅ Implemented | 100.0% | 100.0% | — | CP-05 Performance/resource budget and failure behavior (completed, 15) | — |
| `P2-S08` | Workflow editor | Workflow editor (Layer 3 surface split out of P2-S03) | ✅ Implemented | 100.0% | 100.0% | — | CP-05 Performance/resource budget and failure behavior (completed, 15) | — |
| `P2-S09` | Credentials | Credentials (Layer 4 surface split out of P2-S03) | ✅ Implemented | 100.0% | 100.0% | — | CP-05 Performance/resource budget and failure behavior (completed, 15) | — |
| `P2-S10` | Settings | Settings (Layer 4 surface split out of P2-S03) | 🟡 Planned | 0.0% | 0.0% | — | — | — |
| `P2-S11` | Webhooks | Webhooks (Layer 4 surface split out of P2-S03) | 🟡 Planned | 0.0% | 0.0% | — | — | — |
| `P2-S12` | Auth | Auth (users/identity) (Layer 4 surface split out of P2-S03) | 🟡 Planned | 0.0% | 0.0% | — | — | — |
| `P2-S13` | Navigation | Navigation (Layer 3 surface split out of P2-S03) | 🟡 Planned | 0.0% | 0.0% | — | — | — |
| `P2-S14` | Canvas | Canvas (Layer 3 surface split out of P2-S03) | 🟡 Planned | 0.0% | 0.0% | — | — | — |
| `P2-S15` | Node configuration | Node configuration (Layer 3 surface split out of P2-S03) | 🟡 Planned | 0.0% | 0.0% | — | — | — |
| `P2-S16` | Connections | Connections (Layer 3 surface split out of P2-S03) | 🟡 Planned | 0.0% | 0.0% | — | — | — |
| `P2-S17` | Import/export | Import/export (Layer 3 surface split out of P2-S03) | 🟡 Planned | 0.0% | 0.0% | — | — | — |
| `P2-S18` | Environments | Environments (Layer 4 surface split out of P2-S03) | 🟡 Planned | 0.0% | 0.0% | — | — | — |
| `P2-S19` | Integrations | Integrations (Layer 4 surface split out of P2-S03) | 🟡 Planned | 0.0% | 0.0% | — | — | — |
| `P2-S20` | Execution management | Execution management (Layer 4 surface split out of P2-S03) | 🟡 Planned | 0.0% | 0.0% | — | — | — |
| `P2-S21` | Project/workspace administration | Project/workspace administration (Layer 4 surface split out of P2-S03) | 🟡 Planned | 0.0% | 0.0% | — | — | — |
| `P2-S22` | AI Assistant | AI Assistant (Layer 5 surface split out of P2-S03) | 🟡 Planned | 0.0% | 0.0% | — | — | — |
| `P2-S23` | AI Copilot | AI Copilot (Layer 5 surface split out of P2-S03) | 🟡 Planned | 0.0% | 0.0% | — | — | — |
| `P2-S24` | AI Node surfaces | AI Node surfaces (Layer 5 surface split out of P2-S03) | 🟡 Planned | 0.0% | 0.0% | — | — | — |
| `P2-S25` | Work Trace | Work Trace (Layer 5 surface split out of P2-S03) | 🟡 Planned | 0.0% | 0.0% | — | — | — |
| `P2-S26` | Memory/Context/Session views | Memory/Context/Session views (Layer 5 surface split out of P2-S03) | 🟡 Planned | 0.0% | 0.0% | — | — | — |
| `P2-S27` | Skills/Capabilities | Skills/Capabilities (Layer 5 surface split out of P2-S03) | 🟡 Planned | 0.0% | 0.0% | — | — | — |
| `P2-S28` | Agent/Runtime views | Agent/Runtime views (Layer 5 surface split out of P2-S03) | 🟡 Planned | 0.0% | 0.0% | — | — | — |
| `P2-S29` | Approvals and artifacts | Approvals and artifacts (Layer 5 surface split out of P2-S03) | 🟡 Planned | 0.0% | 0.0% | — | — | — |

</details>

## P3 — Workflow + Execution + Unlimited Nodes

- **Realtime Delivery Progress:** **100.0%** `████████████████████ 100.0%`
- **Slice Completion:** **100.0%** (18 / 18 implemented). Remaining 0. 18 implemented.
- **Program status:** complete. Program status is not a percentage and is not 100% just because the word is complete.
- **Purpose:** Workflow and Execution as first-class LEGO domains; logical workflow size decoupled from runtime working set (#75, #90).
- **Checkpoint model:** 0 slice(s) declare checkpoints; 18 implemented slice(s) use the legacy 100 rule; 0 slice(s) have no checkpoint model and stay at 0.0%.

<details><summary>Slices (18)</summary>

| Slice | Title | Purpose | Status | Realtime | Completion | Current checkpoint | Latest checkpoint | Blocker |
| --- | --- | --- | --- | ---: | ---: | --- | --- | --- |
| `P3 Slice A` | Persistent logical graph | Persistent logical graph (workflow.graph@0.1.0) | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P3 Slice B` | Indexed edge access | Indexed edge access (lazy reverse index) | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P3.2` | Slice C | lazy materialization — store port + bounded HOT cache + lifecycle/residency | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P3.3` | Slice D | bounded runtime — capacity-bounded frontier with explicit backpressure | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P3.4` | Slice E | bounded streaming execution state (execution.state-stream) | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P3.5` | Slice F | fail-closed sha256 checkpoint/resume on the state-stream seam | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P3.6` | Slice G | tier pressure — residencySummary + applyPressure hot/warm/cold relief | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P3.7` | Slice H | bounded Workflow DNA (workflow.dna@0.1.0) | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P3.8` | Slice I | execution-as-query (readyAfter/initialReady + fan bounds) | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P3.9` | Slice J | execution IR + disableable optimization toggles + LRU cache | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P3.10` | Slice L | compatibility oracle (#91 four modes, nine observables, toggle sweep) | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P3.11` | Slice M | resource guard (mandatory budgets, five lanes, three-tier pressure) | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P3.12` | Slice N | 1M scale stress suite + mandatory #75 documents | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P3.13` | Slice K | execution optimizer (semantics-safe fusion + proven-pure cache) | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P3.14` | Slice O | hardening (seeded property, byte-flip fuzz, error-family scans) | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P3.15` | Slice P | closeout evidence, matrix reconciliation, mainBaseline refresh | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P3.15-fix` | Restore immutable mainBaseline + correct P3 closeout evidence | Restore immutable mainBaseline + correct P3 closeout evidence | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P3-S01` | Execution optimizer extensions | Execution optimizer extensions (semantic node elimination, content-addressed subgraph cache, resource-aware compilation, incremental execution, self-profiling, hot/cold path split) | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |

</details>

## P4 — Trigger / Webhook / Ingress

- **Realtime Delivery Progress:** **100.0%** `████████████████████ 100.0%`
- **Slice Completion:** **100.0%** (10 / 10 implemented). Remaining 0. 10 implemented.
- **Program status:** complete. Program status is not a percentage and is not 100% just because the word is complete.
- **Purpose:** Trigger model, webhook ingress, forms, schedules, event ingress, bounded ingress queues, safe admission, trigger observability and failure behavior (#90, #99).
- **Checkpoint model:** 1 slice(s) declare checkpoints; 9 implemented slice(s) use the legacy 100 rule; 0 slice(s) have no checkpoint model and stay at 0.0%.

<details><summary>Slices (10)</summary>

| Slice | Title | Purpose | Status | Realtime | Completion | Current checkpoint | Latest checkpoint | Blocker |
| --- | --- | --- | --- | ---: | ---: | --- | --- | --- |
| `P4.1` | Canonical ingress contracts | Canonical ingress contracts | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P4.2` | Activation + generation lifecycle runtime | Activation + generation lifecycle runtime | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P4.3` | Webhook route table, registration lifecycle, serving gate, ACK | Webhook route table, registration lifecycle, serving gate, ACK | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P4.4` | Cron semantics, DST policy contract, duplicate-tick control | Cron semantics, DST policy contract, duplicate-tick control | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P4.5` | Admission / backpressure / idempotency receipt machine | Admission / backpressure / idempotency receipt machine | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P4.6` | Event / manual / test / waiting ingress orchestration | Event / manual / test / waiting ingress orchestration | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P4.7` | Recovery / reconciliation / race safety | Recovery / reconciliation / race safety (journal, lease, recovery plan) | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P4.8` | Advanced ingress efficiency | route atlas + atomic swap, adaptive clamp, payload capsule, burst fusion, brownout QoS, flight recorder | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P4.9` | Compatibility + performance acceptance | compat matrix, deterministic replay capsule, acceptance suite | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P4-S01` | Ingress innovation remainder | predictive admission controller (full), shadow compatibility path, P4 self-profiling, dedicated webhook/ingress plane | ✅ Implemented | 100.0% | 100.0% | — | CP-04 Dedicated webhook/ingress plane: separated planes, bounded buffering, admission control, response offload (completed, 22) | — |

</details>

## P5 — Identity / Authentication / Authorization / Credentials (Security)

- **Realtime Delivery Progress:** **88.5%** `██████████████████░░ 88.5%`
- **Slice Completion:** **88.5%** (23 / 26 implemented). Remaining 3. 23 implemented, 2 planned, 1 blocked.
- **Program status:** complete. Program status is not a percentage and is not 100% just because the word is complete.
- **Purpose:** Identity, sessions, authorization, credential boundary, key management, account security, API keys/service identity, certification (#85, #90).
- **Checkpoint model:** 13 slice(s) declare checkpoints; 10 implemented slice(s) use the legacy 100 rule; 3 slice(s) have no checkpoint model and stay at 0.0%.

<details><summary>Slices (26)</summary>

| Slice | Title | Purpose | Status | Realtime | Completion | Current checkpoint | Latest checkpoint | Blocker |
| --- | --- | --- | --- | ---: | ---: | --- | --- | --- |
| `P5.1` | Security Kernel | PrincipalSnapshot, SecurityContext, SecurityStamp | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P5.2` | Session Kernel, Rotation, Revocation and CSRF Boundary | Session Kernel, Rotation, Revocation and CSRF Boundary | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P5.3` | authorization engine, canonical permission universe, version-aware decision cache | authorization engine, canonical permission universe, version-aware decision cache | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P5.4` | credential security boundary — SecretRef over the P2.27 broker, n8n redaction contract, canonical authorization | credential security boundary — SecretRef over the P2.27 broker, n8n redaction contract, canonical authorization | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P5.5` | KeyProvider, authenticated envelope encryption, rotation, recovery and encrypted backup | KeyProvider, authenticated envelope encryption, rotation, recovery and encrypted backup | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P5.6` | password recovery, bounded abuse controls, TOTP MFA, step-up | password recovery, bounded abuse controls, TOTP MFA, step-up | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P5.7` | API keys | API keys (hashed), service principals, tenant policy, agent delegation | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P5.8` | security plane certification, operator credential CLI, benchmark, runbook | security plane certification, operator credential CLI, benchmark, runbook | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P5-M01` | Security hardening | soft-revoke API keys and service principals (bounded tombstones, REVOKED verdict, audit row kept); REST decision cache deferred on measured evidence (P5.8 finding 1: warm hit 438 ns p50 is not faster than uncached authorize 384 ns p50) | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P5-M02` | Credential runtime integration | execution path resolves credentials via SecretRef over the P2.27 broker | ✅ Implemented | 100.0% | 100.0% | — | CP-04 Integration regression before and after + round-trips + lifetime (completed, 25) | — |
| `P5-M03` | Public /api/v1 first surface | API-key boundary in upstream order (recorded 401 goldens), key scopes always enforced through the P5.3 kernel, offset-cursor pagination, workflows resource (9 operations). Re-planned by the Manager: email recovery moved to P5-M06, service-principal REST/UI to P5-M07, remaining /api/v1 resources to P5-M08 (one delivery PR per slice) | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P5-M04` | Key-rotation work list without an O(n) scan | measure first (per-batch scan vs the O(n) replaceAll persist), index only if the scan dominates | ✅ Implemented | 100.0% | 100.0% | — | CP-03 Decision + evidence + debt clarification: encode the shouldIndex rule, document NO index (scan does not dominate), record the real bottleneck (full-file rewrite per batch, O(n^2/batchSize)) as the actual remaining P5.5 rotation debt. (completed, 30) | — |
| `P5-M05` | Multi-host key storage and shared session + rate-limiter state | PR #356, merge 3e0f621d) | ✅ Implemented | 100.0% | 100.0% | — | CP-05 Delivery: evidence + regression + merge (completed, 20) | — |
| `P5-M06` | Email-based password recovery | needs a mail transport decision first (Node has no built-in SMTP: a dependency or an injected transport contract), then upstream /rest/forgot-password delivery over the P5 reset-token primitive (split out of P5-M03) | 🟡 Planned | 0.0% | 0.0% | none declared | none declared | — |
| `P5-M07` | Service-principal REST + UI management over the P5.7 programmatic lifecycle | Service-principal REST + UI management over the P5.7 programmatic lifecycle (create shown once, redacted list, revoke with tombstone) (split out of P5-M03) | ✅ Implemented | 100.0% | 100.0% | — | CP-06 DEC-0015 required self-hosted runner verification (completed, 10) | — |
| `P5-M08` | Public /api/v1 second surface | tags (5 operations), variables (4, licence-gated 403 like the community edition), executions list/get/delete (lastId cursor), GET /api/v1/openapi.yml of exactly the mounted operations. Re-planned by the Manager: credentials, users and /docs to P5-M09; resources without a backing model to P5-M10 (one delivery PR per slice) | ✅ Implemented | 100.0% | 100.0% | — | CP-05 DEC-0015 self-hosted runner verification on main (Level 0, Level 1, Level 2 linux, post-merge verification) (completed, 30) | — |
| `P5-M09` | Public /api/v1 credentials | Public /api/v1 credentials (list, create, update, delete, schema; secrets never returned, data validated against the credential type) and users (list, get, create, delete, change role), plus /api/v1/docs (needs a decision on serving Swagger UI without a runtime dependency). Split out of P5-M08 | ✅ Implemented | 100.0% | 100.0% | — | CP-05 /api/v1/docs decision and the OpenAPI spec of exactly the mounted operations (completed, 15) | — |
| `P5-M10` | Public /api/v1 resources that need a backing model this product does not have yet | projects, audit, source-control, data-tables, workflow and credential transfer, workflow versions, execution retry, execution tags (upstream AnnotationTag). Blocked until those models exist; split out of P5-M08 | 🔴 Blocked | 0.0% | 0.0% | none declared | none declared | Backing models are decomposed into P5-M11..P5-M18 (proposed) with per-model definitions (model, contract, persistence boundary, API gating, compatibility, tests, rollback, dependencies) in docs/n8n-lego/evidence/P5-M10-DECOMPOSITION.md (REQ-0003 section 10). The umbrella stays blocked until the declared resource scope is delivered or formally re-scoped. |
| `P5-M11` | Project / sharing backing model | project, membership and share records for /api/v1/projects | ✅ Implemented | 100.0% | 100.0% | — | CP-05 Delivery: evidence + regression + merge (completed, 20) | — |
| `P5-M12` | Audit backing model | security-audit event generation and store for /api/v1/audit | ✅ Implemented | 100.0% | 100.0% | — | CP-05 Evidence + delivery notes committed; battery green (completed, 20) | — |
| `P5-M13` | Source-control backing model | repository/branch/changeset records for /api/v1/source-control | ✅ Implemented | 100.0% | 100.0% | — | CP-05 Evidence + delivery notes committed; battery green (completed, 20) | — |
| `P5-M14` | Data-table backing model | column/row store for /api/v1/data-tables | ✅ Implemented | 100.0% | 100.0% | — | CP-05 Evidence + delivery notes committed; battery green (completed, 20) | — |
| `P5-M15` | Workflow/credential transfer backing model | export bundles and transfer records | ✅ Implemented | 100.0% | 100.0% | — | CP-05 Evidence + delivery notes committed; battery green (completed, 20) | — |
| `P5-M16` | Workflow-version backing model | immutable workflow version records for /api/v1/workflow-versions | ✅ Implemented | 100.0% | 100.0% | — | CP-05 Evidence + delivery notes committed; battery green (completed, 20) | — |
| `P5-M17` | Execution retry model | retry path over execution records | ✅ Implemented | 100.0% | 100.0% | — | CP-05 Evidence + delivery notes committed; battery green (completed, 20) | — |
| `P5-M18` | Execution annotation/tag model | upstream-equivalent AnnotationTag entities | 🟡 Planned | 0.0% | 0.0% | none declared | none declared | — |

</details>

## P6 — Node Registry / Node Runtime

- **Realtime Delivery Progress:** **94.4%** `███████████████████░ 94.4%`
- **Slice Completion:** **94.4%** (34 / 36 implemented). Remaining 2. 34 implemented, 2 proposed.
- **Program status:** complete. Program status is not a percentage and is not 100% just because the word is complete.
- **Purpose:** Node registry, lifecycle, installation/admission, runtime selection, official/community compatibility, plugin trust/runtime locality, native node migration where beneficial (#90, #100).
- **Checkpoint model:** 3 slice(s) declare checkpoints; 31 implemented slice(s) use the legacy 100 rule; 2 slice(s) have no checkpoint model and stay at 0.0%.

<details><summary>Slices (36)</summary>

| Slice | Title | Purpose | Status | Realtime | Completion | Current checkpoint | Latest checkpoint | Blocker |
| --- | --- | --- | --- | ---: | ---: | --- | --- | --- |
| `P6.1` | Canonical node registry contract | Canonical node registry contract | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P6.2` | Registry Compiler + Immutable Epoch | Registry Compiler + Immutable Epoch (registry.compiler@0.1.0) | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P6.3` | Transactional Package + Single-Flight Install | Transactional Package + Single-Flight Install (package.transaction@0.1.0) | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P6.4` | Dependency Closure + Content-Addressed Store | Dependency Closure + Content-Addressed Store (registry.closure@0.1.0) | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P6.5` | Workflow Node Resolution Manifest | Workflow Node Resolution Manifest (node.resolution@0.1.0) | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P6.6` | Runtime Lease + Side-by-Side Upgrade | Runtime Lease + Side-by-Side Upgrade (runtime.lease@0.1.0) | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P6.7` | Manifest/Implementation Split + HOT/WARM/COLD Residency | Manifest/Implementation Split + HOT/WARM/COLD Residency (node.residency@0.1.0) | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P6.8` | Capability Compilation + Runtime Locality | Capability Compilation + Runtime Locality (node.capability@0.1.0) | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P6.9` | Semantic Fingerprint + Compatibility Replay | Semantic Fingerprint + Compatibility Replay (node.semantics@0.1.0) | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P6.10` | Orphan / Tombstone / Alias / Deprecation | Orphan / Tombstone / Alias / Deprecation (node.lifecycle@0.1.0) | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P6.11` | Health + Crash Circuit Breaker + Quarantine | Health + Crash Circuit Breaker + Quarantine (node.health@0.1.0) | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P6.12` | Supply-Chain Attestation + Revocation + Offline Mirror | Supply-Chain Attestation + Revocation + Offline Mirror (node.supply-chain@0.1.0) | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P6.13` | Incremental Registry Compiler + Discovery/Runtime Split | Incremental Registry Compiler + Discovery/Runtime Split (registry.incremental@0.1.0) | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P6.14` | Worker Registry Convergence + Handshake | Worker Registry Convergence + Handshake (node.worker-convergence@0.1.0) | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P6.15` | Core Acceptance | Core Acceptance (node.acceptance@0.1.0) | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P6.16` | Registry Integrity Chain + Freshness/Anti-Rollback | Registry Integrity Chain + Freshness/Anti-Rollback (registry.integrity@0.1.0) | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P6.17` | Admission Explain Plan + Dependency Blast Radius | Admission Explain Plan + Dependency Blast Radius (node.admission@0.1.0) | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P6.18` | SBOM/VEX + Policy Diff Gate | SBOM/VEX + Policy Diff Gate (node.sbom@0.1.0) | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P6.19` | Canary Rollout + Side-by-Side Upgrade + Rollback | Canary Rollout + Side-by-Side Upgrade + Rollback (node.canary@0.1.0) | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P6.20` | Emergency Revocation Bulletins | Emergency Revocation Bulletins (node.revocation@0.1.0) | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P6.21` | The Node I/O Compiler | The Node I/O Compiler (node.io@0.1.0) | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P6.22` | Just-in-Time Slot Leases | Just-in-Time Slot Leases (runtime.jit@0.1.0) | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P6.23` | Cancellation + Accounting | Cancellation + Accounting (runtime.cancel@0.1.0) | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P6.24` | Runtime Pools | Runtime Pools (runtime.pool@0.1.0) | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P6.25` | Native ABI + Dual Artifacts | Native ABI + Dual Artifacts (node.abi@0.1.0) | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P6.26` | The WASM Compilation Cache | The WASM Compilation Cache (runtime.wasm-cache@0.1.0) | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P6.27` | Provenance Statements and the Transparency Log | Provenance Statements and the Transparency Log (node.provenance@0.1.0) | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P6.28` | Metadata Freshness — Rollback, Freeze and Mix-and-Match | Metadata Freshness — Rollback, Freeze and Mix-and-Match (registry.freshness@0.1.0) | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P6.29` | Name Claims, Handovers and Confusion | Name Claims, Handovers and Confusion (node.namespace@0.1.0) | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P6.30` | Repair, Ordered Restoration and Offline Recovery | Repair, Ordered Restoration and Offline Recovery (registry.repair@0.1.0) | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P6.31` | The Acceptance of the Milestone | The Acceptance of the Milestone (registry.acceptance@0.1.0) | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P6-S01` | Live community / private / custom node installation path over the P6 admission pipeline | Live community / private / custom node installation path over the P6 admission pipeline | ✅ Implemented | 100.0% | 100.0% | — | CP-06 DEC-0015 required self-hosted runner verification (completed, 15) | — |
| `P6-S02` | Production WASM node/plugin sandbox engine | Production WASM node/plugin sandbox engine (P6.26 compilation cache and P2.27.4 locality are the foundation) | ✅ Implemented | 100.0% | 100.0% | — | CP-06 DEC-0015 required self-hosted runner verification (completed, 10) | — |
| `P6-S03` | Universal resilient scraper node | Universal resilient scraper node (candidate sub-slices S1-S21 in #115) | ⚪ Proposed | 0.0% | 0.0% | none declared | none declared | — |
| `P6-S04` | Native high-performance node catalog | Native high-performance node catalog (candidates N1-N12 in #116) | ⚪ Proposed | 0.0% | 0.0% | none declared | none declared | — |
| `P6-S05` | Minimal credential-consuming node for the SecretRef integration path | Minimal credential-consuming node for the SecretRef integration path (smallest consumer for P5-M02, not a native-performance node) | ✅ Implemented | 100.0% | 100.0% | — | CP-05 Delivery: registry + evidence + regression + merge (completed, 15) | — |

</details>

## P7 — Dynamic Parameters / Schema Runtime

- **Realtime Delivery Progress:** **100.0%** `████████████████████ 100.0%`
- **Slice Completion:** **100.0%** (8 / 8 implemented). Remaining 0. 8 implemented.
- **Program status:** in-progress. Program status is not a percentage and is not 100% just because the word is complete.
- **Purpose:** Dynamic parameter schemas, option discovery, schema validation, caching, provider-backed lookup, parameter plugin boundaries (#90, #223).
- **Checkpoint model:** 6 slice(s) declare checkpoints; 2 implemented slice(s) use the legacy 100 rule; 0 slice(s) have no checkpoint model and stay at 0.0%.

<details><summary>Slices (8)</summary>

| Slice | Title | Purpose | Status | Realtime | Completion | Current checkpoint | Latest checkpoint | Blocker |
| --- | --- | --- | --- | ---: | ---: | --- | --- | --- |
| `P7-S01` | Parameter Contract & Compiler | canonical n8n parameter definitions compiled once into an immutable ParameterPlan with stable parameter identity and plan versioning (#223 §4-6, §31, §42 P7.1) | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P7-S02` | Visibility & Dependency Graph | displayOptions visibility engine, parameter dependency graph, incremental recomputation of only affected fields, expression boundary (#223 §7-10, §42 P7.2) | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P7-S03` | Local Validation & Normalization | schema validation, normalization, failure vocabulary and the immutable execution-ready parameter snapshot with canonical vs derived representation (#223 §20-21, §27, §29-30, §42 P7.3) | ✅ Implemented | 100.0% | 100.0% | — | CP-05 Negative/security matrix & determinism: malformed/oversized/missing inputs, circular/invalid dependencies, sensitive-value handling; idempotent, pure, no side effects (#223 §41, §44) (completed, 15) | — |
| `P7-S04` | Dynamic Options Runtime | /rest/dynamic-node-parameters options, bounded dynamic cache classes with stale-while-revalidate, dependent-field race protection, request coalescing, provider backpressure and resource budgets (#223 §11, §14-16, §23-26, §34, §42 P7.4) | ✅ Implemented | 100.0% | 100.0% | — | CP-05 Backpressure + resource budgets: concurrency bound, deadline, timeout, max page size, max result count, max response bytes, retry budget, cancellation, negative cache; one slow provider cannot consume the whole process budget (#223 §26, §34) (completed, 15) | — |
| `P7-S05` | Resource Locator & Search | resourceLocator modes, list search with pagination and search (#223 §12-13, §42 P7.5) | ✅ Implemented | 100.0% | 100.0% | — | CP-05 Failure vocabulary + resource budgets (no fake empty success) (completed, 15) | — |
| `P7-S06` | Credential-Aware Resolution | credential/security composition through scoped SecretRefs and security-sensitive dynamic values that never leak into caches, snapshots or logs (#223 §18, §28, §42 P7.6) | ✅ Implemented | 100.0% | 100.0% | — | CP-05 Security-sensitive dynamic values: authoritative values require revalidation; cached UI option never becomes authority (completed, 15) | — |
| `P7-S07` | Plugin/Provider Runtime Boundary | provider boundary, capability boundary, provider-backed schema, community node compatibility, plugin, storage and observability boundaries (#223 §17, §19, §22, §32-33, §35-36, §42 P7.7) | ✅ Implemented | 100.0% | 100.0% | — | CP-05 Bounded observability: the closed P9 event set, with no secret material or full sensitive payloads (completed, 20) | — |
| `P7-S08` | Differential Certification | differential oracle against pinned n8n-workflow 2.9.1, negative/security test matrix and the low-resource performance target (#223 §37-38, §40-41, §42 P7.8) | ✅ Implemented | 100.0% | 100.0% | — | CP-05 Certification is a record: deterministic, reproducible, and tied to the pinned n8n version (completed, 15) | — |

</details>

## P8 — Storage / Data Layer

- **Realtime Delivery Progress:** **100.0%** `████████████████████ 100.0%`
- **Slice Completion:** **100.0%** (7 / 7 implemented). Remaining 0. 7 implemented.
- **Program status:** planned. Program status is not a percentage and is not 100% just because the word is complete.
- **Purpose:** Provider-neutral storage contracts, workflow/execution persistence, graph segments, indexes, transactions, migrations, backup/recovery, SQLite/PostgreSQL/object-store providers (#90).
- **Checkpoint model:** 7 slice(s) declare checkpoints; 0 implemented slice(s) use the legacy 100 rule; 0 slice(s) have no checkpoint model and stay at 0.0%.

<details><summary>Slices (7)</summary>

| Slice | Title | Purpose | Status | Realtime | Completion | Current checkpoint | Latest checkpoint | Blocker |
| --- | --- | --- | --- | ---: | ---: | --- | --- | --- |
| `P8-S01` | Storage contract foundation | Storage contract foundation (not authorized) | ✅ Implemented | 100.0% | 100.0% | — | CP-05 Conformance harness + delivery (completed, 20) | — |
| `P8-S02` | Storage contract | provider-neutral key/value semantics (namespace, serialization, failure behavior, consistency) | ✅ Implemented | 100.0% | 100.0% | — | CP-01 Storage contract: provider-neutral key/value semantics (namespace, serialization, failure behavior, consistency) (completed, 100) | — |
| `P8-S03` | Storage TTL semantics | Storage TTL semantics (expiry, refresh, eviction contract) | ✅ Implemented | 100.0% | 100.0% | — | CP-01 Storage TTL semantics (expiry, refresh, eviction contract) (completed, 100) | — |
| `P8-S04` | Storage atomic operations | Storage atomic operations (compare-and-set, atomic counters, batch atomicity) | ✅ Implemented | 100.0% | 100.0% | — | CP-01 Storage atomic operations (compare-and-set, atomic counters, batch atomicity) (completed, 100) | — |
| `P8-S05` | Storage concurrency semantics | Storage concurrency semantics (race behavior, isolation expectations) | ✅ Implemented | 100.0% | 100.0% | — | CP-01 Storage concurrency semantics (race behavior, isolation expectations) (completed, 100) | — |
| `P8-S06` | Local reference provider | Local reference provider (in-memory/local implementation of the storage contract) | ✅ Implemented | 100.0% | 100.0% | — | CP-01 Local reference provider (in-memory/local implementation of the storage contract) (completed, 100) | — |
| `P8-S07` | Storage test harness | Storage test harness (contract conformance suite every provider must pass) | ✅ Implemented | 100.0% | 100.0% | — | CP-01 Storage test harness (contract conformance suite every provider must pass) (completed, 100) | — |

</details>

## P9 — Observability / Diagnostics / Operations

- **Realtime Delivery Progress:** **100.0%** `████████████████████ 100.0%`
- **Slice Completion:** **100.0%** (23 / 23 implemented). Remaining 0. 23 implemented.
- **Program status:** complete. Program status is not a percentage and is not 100% just because the word is complete.
- **Purpose:** Logs, metrics, traces, execution diagnostics, resource-pressure telemetry, replay diagnostics, plugin health, operator tooling, audit integration (#90, #101).
- **Checkpoint model:** 0 slice(s) declare checkpoints; 23 implemented slice(s) use the legacy 100 rule; 0 slice(s) have no checkpoint model and stay at 0.0%.

<details><summary>Slices (23)</summary>

| Slice | Title | Purpose | Status | Realtime | Completion | Current checkpoint | Latest checkpoint | Blocker |
| --- | --- | --- | --- | ---: | ---: | --- | --- | --- |
| `P9.1` | Canonical telemetry envelope and correlation context | Canonical telemetry envelope and correlation context | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P9.2` | Structured logs and versioned severity/error taxonomy | Structured logs and versioned severity/error taxonomy | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P9.3` | Metric contract and cardinality governance | Metric contract and cardinality governance | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P9.4` | Trace contract and cross-boundary propagation | Trace contract and cross-boundary propagation | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P9.5` | Semantic event contract + lifecycle events | Semantic event contract + lifecycle events (observability.semantic-event@1.0.0) | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P9.6` | Bounded telemetry buffer + P0–P4 backpressure | Bounded telemetry buffer + P0–P4 backpressure (observability.telemetry-buffer@1.0.0) | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P9.7` | fail-closed telemetry redaction + data classification | fail-closed telemetry redaction + data classification (observability.telemetry-redaction@1.0.0) | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P9.8` | sampling + adaptive telemetry policy | sampling + adaptive telemetry policy (observability.telemetry-sampling@1.0.0) | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P9.9` | resource/pressure telemetry | resource/pressure telemetry (observability.resource-pressure@1.0.0) | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P9.10` | health/readiness model | health/readiness model (observability.health-readiness@1.0.0) | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P9.11` | execution diagnostics contract | execution diagnostics contract (observability.execution-diagnostics@1.0.0) | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P9.12` | Diagnostic Bundle Compiler | Diagnostic Bundle Compiler (observability.diagnostic-bundle@1.0.0) | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P9.13` | Failure Correlation + Causal Evidence | Failure Correlation + Causal Evidence (observability.failure-correlation@1.0.0) | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P9.14` | replay/compatibility evidence integration | replay/compatibility evidence integration (observability.replay-evidence@1.0.0) | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P9.15` | retention + HOT/WARM/COLD policy | retention + HOT/WARM/COLD policy (observability.telemetry-retention@1.0.0) | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P9.16` | operator inspection API | operator inspection API (observability.operator-inspection@1.0.0) | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P9.17` | Low-Resource Observability Mode | Low-Resource Observability Mode (stacked on P9.16) | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P9.18` | Telemetry Self-Observability | Telemetry Self-Observability (stacked on P9.17) | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P9.19` | Multi-Tenant Telemetry Isolation Readiness | Multi-Tenant Telemetry Isolation Readiness (stacked on P9.18) | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P9.20` | Observability Contract Oracle + Cross-Domain Acceptance | Observability Contract Oracle + Cross-Domain Acceptance (stacked on P9.19) | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P9.21` | Advanced Diagnostics / Incident Intelligence | Advanced Diagnostics / Incident Intelligence (stacked on P9.20) | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P9.22` | Full P9 Acceptance | Full P9 Acceptance (stacked on P9.21, final slice) | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `P9-S01` | Per-node execution cost/resource ledger correlated with P9 telemetry | Per-node execution cost/resource ledger correlated with P9 telemetry (#224 item 20) | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |

</details>

## P10 — Multi-Tenant / Isolation / Quota

- **Realtime Delivery Progress:** **0.0%** `░░░░░░░░░░░░░░░░░░░░ 0.0%`
- **Slice Completion:** **0.0%** (0 / 1 implemented). Remaining 1. 0 implemented, 1 planned.
- **Program status:** planned. Program status is not a percentage and is not 100% just because the word is complete.
- **Purpose:** Only when required: tenant lifecycle, storage/compute/capability isolation, per-tenant budgets, noisy-neighbor protection, tenant administration (#90, #78). Single-tenant remains the first target.
- **Checkpoint model:** 0 slice(s) declare checkpoints; 0 implemented slice(s) use the legacy 100 rule; 1 slice(s) have no checkpoint model and stay at 0.0%.

<details><summary>Slices (1)</summary>

| Slice | Title | Purpose | Status | Realtime | Completion | Current checkpoint | Latest checkpoint | Blocker |
| --- | --- | --- | --- | ---: | ---: | --- | --- | --- |
| `P10-S01` | Tenant-aware contracts beyond the P5 "default" tenant | Tenant-aware contracts beyond the P5 "default" tenant (not authorized) | 🟡 Planned | 0.0% | 0.0% | none declared | none declared | — |

</details>

## P11 — Worker / Distributed Scaling / HA

- **Realtime Delivery Progress:** **0.0%** `░░░░░░░░░░░░░░░░░░░░ 0.0%`
- **Slice Completion:** **0.0%** (0 / 1 implemented). Remaining 1. 0 implemented, 1 planned.
- **Program status:** planned. Program status is not a percentage and is not 100% just because the word is complete.
- **Purpose:** Independent worker pools, queue/scheduler integration, remote plugin scaling, HA, recovery, distributed execution, horizontal scaling — never microservice-per-node (#90).
- **Checkpoint model:** 0 slice(s) declare checkpoints; 0 implemented slice(s) use the legacy 100 rule; 1 slice(s) have no checkpoint model and stay at 0.0%.

<details><summary>Slices (1)</summary>

| Slice | Title | Purpose | Status | Realtime | Completion | Current checkpoint | Latest checkpoint | Blocker |
| --- | --- | --- | --- | ---: | ---: | --- | --- | --- |
| `P11-S01` | Worker pool + queue integration foundation | Worker pool + queue integration foundation (not authorized) | 🟡 Planned | 0.0% | 0.0% | none declared | none declared | — |

</details>

## Future programs (legacy P12–P23 consolidated)

These programs stay visible. They are not in the Realtime Delivery Progress denominator and not in the Slice Completion denominator.

| Future program | Legacy milestones | Realtime | Slice completion | Slices implemented | State |
| --- | --- | ---: | ---: | ---: | --- |
| FUTURE-EVENT | P12 | 0.0% | 0.0% | 0/1 | planned |
| FUTURE-RELIABILITY | P13, P16, P17, P21 | 50.0% | 50.0% | 1/2 | planned |
| FUTURE-PLATFORM | P14, P15, P22 | 0.0% | 0.0% | 0/1 | planned |
| FUTURE-DISTRIBUTION | P19, P20 | 0.0% | 0.0% | 0/1 | planned |
| FUTURE-AI-ECOSYSTEM | P18, P23 | 0.0% | 0.0% | 0/1 | planned |

## FUTURE-EVENT — Event & Automation Control Plane

Excluded from the current-delivery denominator. Realtime **0.0%**. Slice completion **0.0%** (0 / 1). Program status: planned.

<details><summary>Slices (1)</summary>

| Slice | Title | Purpose | Status | Realtime | Completion | Current checkpoint | Latest checkpoint | Blocker |
| --- | --- | --- | --- | ---: | ---: | --- | --- | --- |
| `FUTURE-EVENT-S01` | Durable signals, timers and external-event resume | Durable signals, timers and external-event resume (not authorized) | 🟡 Planned | 0.0% | 0.0% | none declared | none declared | — |

</details>

## FUTURE-RELIABILITY — Execution Reliability, Data Plane, Scheduling & Certification

Excluded from the current-delivery denominator. Realtime **50.0%**. Slice completion **50.0%** (1 / 2). Program status: planned.

<details><summary>Slices (2)</summary>

| Slice | Title | Purpose | Status | Realtime | Completion | Current checkpoint | Latest checkpoint | Blocker |
| --- | --- | --- | --- | ---: | ---: | --- | --- | --- |
| `FUTURE-RELIABILITY-S01` | Standalone benchmark / reproducibility certification tooling | Standalone benchmark / reproducibility certification tooling (legacy P21) | ✅ Implemented | 100.0% | 100.0% | none declared | legacy implemented (100, no checkpoint list) | — |
| `FUTURE-RELIABILITY-S02` | Side-effect reliability | effect ledger, outbox/inbox, idempotency before retry (legacy P13; not authorized) | 🟡 Planned | 0.0% | 0.0% | none declared | none declared | — |

</details>

## FUTURE-PLATFORM — Release, Collaboration & Operator Platform

Excluded from the current-delivery denominator. Realtime **0.0%**. Slice completion **0.0%** (0 / 1). Program status: planned.

<details><summary>Slices (1)</summary>

| Slice | Title | Purpose | Status | Realtime | Completion | Current checkpoint | Latest checkpoint | Blocker |
| --- | --- | --- | --- | ---: | ---: | --- | --- | --- |
| `FUTURE-PLATFORM-S01` | Schema/compatibility gateway + upgrade simulator | Schema/compatibility gateway + upgrade simulator (legacy P14; not authorized) | 🟡 Planned | 0.0% | 0.0% | none declared | none declared | — |

</details>

## FUTURE-DISTRIBUTION — Worker Fabric, Storage Lifecycle & Disaster Recovery

Excluded from the current-delivery denominator. Realtime **0.0%**. Slice completion **0.0%** (0 / 1). Program status: planned.

<details><summary>Slices (1)</summary>

| Slice | Title | Purpose | Status | Realtime | Completion | Current checkpoint | Latest checkpoint | Blocker |
| --- | --- | --- | --- | ---: | ---: | --- | --- | --- |
| `FUTURE-DISTRIBUTION-S01` | Execution leases, fencing and stalled-worker recovery | Execution leases, fencing and stalled-worker recovery (legacy P19; not authorized) | 🟡 Planned | 0.0% | 0.0% | none declared | none declared | — |

</details>

## FUTURE-AI-ECOSYSTEM — AI Runtime Optimization & Ecosystem Interoperability

Excluded from the current-delivery denominator. Realtime **0.0%**. Slice completion **0.0%** (0 / 1). Program status: planned.

<details><summary>Slices (1)</summary>

| Slice | Title | Purpose | Status | Realtime | Completion | Current checkpoint | Latest checkpoint | Blocker |
| --- | --- | --- | --- | ---: | ---: | --- | --- | --- |
| `FUTURE-AI-ECOSYSTEM-S01` | Lazy tool/skill discovery + token-aware capability budgets | Lazy tool/skill discovery + token-aware capability budgets (legacy P18; not authorized) | 🟡 Planned | 0.0% | 0.0% | none declared | none declared | — |

</details>

## Historical P2 ladder

17 completed milestones (`P2.11` … `P2.27`, with the `P2.27.x` sub-slices under program P2) are immutable implementation history. Historical pointers: current `P2.27`, previous completed `P2.26` (history, not active work). The generic `P2.17+` (planned) row is a historical placeholder label; it authorizes no work.

## Milestone Governance

- **Milestone authority:** `main` owns milestone truth (DEC-0020). Canonical register: [`docs/n8n-lego/milestones.json`](docs/n8n-lego/milestones.json); generated projections: this section of `README.md`, `.ai/master/MILESTONE_REGISTER.md` and `.ai/master/CURRENT_STATUS.md`. `arena-manager` is Manager planning memory only (canonical: false); `docs/n8n-lego/ROADMAP.md` is strategy narrative and owns no status.
- **Live progress (DEC-0021, LIVE-MILESTONE EXCEPTION):** checkpoint progress, checkpoint status, checkpoint evidence, current checkpoint, slice / program / overall progress and the milestone evidence of a slice still in flight are operational telemetry. The Manager may reconcile them straight to `main` in a `governance(progress):` commit, without a governance PR, with `node tools/lego/progress-event.mjs record --slice <id> --checkpoint <CP-nn> --status <status> --evidence <reference>`. The tool runs the whole atomic chain: validate evidence and weights → write the register → regenerate `README.md` and `.ai` → run `npm run lego:ai:check` → commit → push → verify `main`. One measurable event is one commit; live progress is never batched and a partial state is never published. The Manager never types a percentage: `resolve` derives the state from evidence — `--fetch` reads the DEC-0015 jobs and the runner availability from the GitHub API, `--jobs <file.json>` reads an export, and `verify --cmd` derives completed / blocked from a verification command's exit code. A checkpoint that declares `requires` is earned only when every named check has passed; an absent self-hosted check is never PASS and `WAITING_RUNNER` is never PASS, so a head that never ran the suite cannot look green. Two paths, never mixed: delivery state is implementation → delivery PR → merge → post-merge verification → one governance PR reconciling status, merge SHA, evidence and projections; telemetry is evidence → checkpoint update → register → README → .ai → a `governance(progress):` commit → main. A slice status becoming `implemented` is delivery state and is never telemetry. The exception never covers source code, tests, runtime behaviour, API / frontend / backend / contract / schema implementation, dependencies, packages, Rust code, CI workflows, security policy, permissions, infrastructure, database schema or production configuration — those still go through a delivery PR. Live telemetry never bypasses a completion gate: 100% realtime progress with a completion contribution of 0% is a legitimate state, and only `implemented` (DEC-0014 + DEC-0015) moves Slice Completion.
- **Rule:** Milestone truth is main-owned. A milestone design found or developed in Manager memory becomes authoritative only when reconciled into main through a PR. arena-manager is not an alternate milestone authority, and its docs/ tree is a stale snapshot that is never copied over main.
- **Pending reconciliation:** A milestone change that exists only on arena-manager, a local worktree, a handoff, an issue, a PR body or chat is a proposal (pending reconciliation), never authoritative truth. A PR proposes a milestone state; only the merged state on main is authoritative.
- **Freshness:** generated by `npm run lego:ai` from register 2.4.0 (fingerprint `146551b07ab1f7f0`); `npm run lego:ai:check` fails when this section, the `.ai` pack or the register disagree.
- **Progress model (Issue #307):** Realtime Delivery Progress is checkpoint-weighted across P0-P11. Slice Completion is implemented / active in that same denominator. Future programs stay visible and are excluded from the current-delivery denominator. Illustrations of the status/progress split are not register measurements and must not be copied into slice checkpoints. The generator counts only weights declared on slice.checkpoints. It does not invent weights. A completed checkpoint requires evidence. Weights on a slice must sum to 100. A slice with no checkpoint model stays at 0 unless it is implemented, in which case the legacy rule contributes 100. This projection is not canonical until the change is on main.
- **Completion KPI:** Slice Completion is implemented slices / active slices in P0–P11. A verifying or blocked slice never increases that numerator. Realtime Delivery Progress is a separate checkpoint-weighted figure and can move while Slice Completion stays still.
- **Purpose field:** a slice purpose is `slice.purpose` when present, otherwise the text after the first `: ` in the canonical title, otherwise the title. No purpose is invented.
- **Top level:** programs P0–P11 only. There is no P12+ or P24+ and no P5.9; legacy P12–P23 are consolidated into future programs. New work is `Pn-Snn`, `Pn-Mnn` or `FUTURE-<THEME>-Snn`.
- **Post-merge sequence:** delivery PR → merge to main → post-merge verification → register status and evidence update → README milestone projection (generated) → .ai regeneration → governance PR → merge governance PR → final main verification.
- **No batching:** Nothing is batched into a later roadmap cleanup. A delivery-state change (planned -> in-progress at slice start, in-progress -> implemented, a split or a new blocker) is recorded by the next governance PR; every evidenced progress event is recorded immediately in its own governance(progress): commit, because the repository is the live project monitor (DEC-0021).
- **Completion rule:** Immediately after merge + post-merge verification, the slice and its features become implemented with PR, merge SHA, tests and evidence; remaining debt is recorded as Pn-Mnn. An open PR means in-progress, never implemented.
- One delivery PR per slice (DEC-0014); the post-merge register/README/.ai reconciliation of a delivery is a separate governance PR, not a second delivery PR. Progress telemetry is the other path (DEC-0021) and never carries delivery state.
- A slice cycle is closed only when implementation, register, this README section, the generated `.ai` and evidence agree on `main`.
- Evidence lives in `docs/n8n-lego/evidence/`; each slice's `evidence` field names its file.
<!-- END GENERATED milestone-governance -->

## Structure

- `reference/n8n/` : pristine upstream n8n 2.9.4 source (read-only, hash-pinned)
- `docs/anatomy/` : system anatomy (18 documents)
- `contracts/` : formal LEGO contracts (`workflow`, `node`, `connection`, `validation`)
- `docs/isolation/` : Phase 2 isolation records, dependency map, port contract, verification report
- `packages/workflow-lego/` : the isolated Workflow Model LEGO (boundary, ports, tests, manifests)
- `tools/` : boundary mapper, kernel/port/reference gates, isolation extractor, model digest, gate runner, live engine harness
- `tests/reference/` : golden workflows + baseline smoke test evidence
- `tasks/`, `results/` : inbound task manifests and execution results
- `crates/` : active Rust implementation workspace (8 member crates)
- `docs/isolation/trigger-rust-port.md` : `trigger.lifecycle` port record (symbol map, divergences, evidence)
- `apps/n8n-rust/` : application entry point & runner

## Verify Rust Workspace

```bash
cargo check --workspace
cargo test --workspace
```

Without registry access (sandbox / review boxes) the offline rig builds the same crates
against the exact `Cargo.lock` versions; `n8n-nodes-rust` stays with the CI runner because
its `tokio` dev-dependency closure is not vendored:

```bash
tools/rust-offline-rig/setup.sh     # toolchain from npm + vendored crates from git
tools/rust-offline-rig/run.sh test
```

## Verify a Reference LEGO

```bash
scripts/setup-reference-runtime.sh        # n8n-workflow/core/nodes-base 2.9.1 == the n8n 2.9.4 dependency set
npm install --prefix packages/workflow-lego
npm run verify                            # 11 gates; writes docs/isolation/evidence/*

npm run verify:fast                       # same, without the live engine checks
npm run isolation:check                   # boundary + kernel + port + reference-integrity only
```

A failing gate means the isolation is void and must be rolled back — the records
are machine-readable in `docs/isolation/evidence/`.

## TypeScript baseline runtime (usable track)

Track terpisah yang membuat LEGO TypeScript bisa dipakai hari ini
(install → start → deploy VPS) sementara Rust tetap beku di track ini:

```bash
bash scripts/install.sh && bash scripts/start.sh && bash scripts/doctor.sh
npm run ts:test   # adapter (14) + runtime nyata (44) + integrasi (3)
```

Kontrak: `contracts/ts-baseline-runtime.contract.md` ·
Panduan: `docs/TS-BASELINE.md` · Bukti gate: `results/TS-BASELINE-GATES.md`.
