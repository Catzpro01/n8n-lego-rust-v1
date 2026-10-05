# COMPATIBILITY MATRIX — Phase 2

**Maintainer:** Agent 5
**Reference:** n8n 2.9.4
**Rule:** never write `PASS` without evidence. `NOT RUN` is a legitimate and required value.

Evidence sources:
* **[B]** `tests/reference/baseline/SMOKE_TEST_RESULTS.md` — live 11/11 run on VPS `157.10.160.95`, 2026-09-17.
* **[C]** `node tests/compatibility/contract_conformance.mjs` — offline, re-run 2026-09-16, **21/21 PASS**.
* **[A]** `python3 tests/integration/boundary_audit.py` — offline static audit, re-run 2026-09-16, **PASS**.
* **[G]** `python3 tests/integration/regression_gate.py` — live gate, requires running n8n + PostgreSQL.

---

## 1. Behavior matrix

"Isolated" = behavior as described by the LEGO contracts / isolation docs.
Phase 2 produces **no replacement implementation**, so "Isolated" can only be
verified at the contract-conformance level, never at the runtime level yet.

| Behavior | Original n8n | Isolated | Compatible | Evidence |
| :--- | :--- | :--- | :--- | :--- |
| Empty workflow | PASS | PASS | PASS | [B]#4, [C] `01-empty-workflow` 5/5 |
| One node | PASS | PASS | PASS | [B]#8, [C] `02-one-node` 5/5 |
| Linear workflow | PASS | PASS | PASS | [B]#9, [C] `03-linear` 5/5 (1 edge, acyclic) |
| Manual execution | PASS | NOT RUN | NOT VERIFIED | [B]#7 only; no isolated execution path exists in Phase 2 |
| Webhook | PASS | NOT RUN | NOT VERIFIED | [B]#10 only; webhook has no contract yet |
| Execution persistence | PASS | NOT RUN | NOT VERIFIED | [B]#11 only; persistence has no contract yet |
| Expression | PASS | NOT RUN | NOT VERIFIED | not covered by any golden fixture — **gap** |

## 2. Contract-invariant matrix

| Invariant | Contract | Automated | Result | Evidence |
| :--- | :--- | :--- | :--- | :--- |
| Workflow schema (`id`,`name`,`nodes`,`connections`) | workflow | yes | PASS 3/3 fixtures | [C] |
| Unique node names | workflow + validation `NodeUniqueness` | yes | PASS 3/3 | [C] |
| Node schema (`id`,`name`,`type`,`typeVersion`,`position`,`parameters`) | node | yes | PASS 3/3 | [C] |
| Connection type ∈ {main, ai_tool, ai_memory, ai_languageModel} | connection | yes | PASS | [C] |
| Output/input index integer ≥ 0 | connection | yes | PASS | [C] |
| No dangling connections | validation `DanglingConnections` | yes | PASS 3/3 | [C] |
| Graph acyclic | workflow + validation `CycleDetection` | yes | PASS 3/3 | [C] |
| Disabled-node handling | validation `DisabledHandling` | **no** | **NOT RUN** | no fixture contains a disabled node — **gap, ISSUE-005** |
| `typeVersion` matches an available spec schema | node | **no** | **NOT RUN** | requires node-type registry; out of offline scope |

## 3. Structural / governance matrix

| Check | Result | Evidence |
| :--- | :--- | :--- |
| All 4 assigned contracts present | PASS | [C] |
| All cross-LEGO edges documented | PASS (28/28) | [A] |
| Circular deps enumerated | PASS (16 found, 3 flagged) | [A], `DEPENDENCY-GRAPH.md` |
| Hidden coupling enumerated | PASS (8 signals found) | [A] |
| No Rust in Phase 2 | PASS | [A] + [C] |
| Golden reference unmodified | PASS | `git log reference/n8n` — untouched since import |
| Isolation docs for all 4 LEGOs | **FAIL (1/4)** | only `docs/isolation/workflow.md` |

## 4. 11/11 regression baseline

Baseline `tests/reference/baseline/SMOKE_TEST_RESULTS.md` = **11/11 PASS** (recorded, live VPS).

| # | Test | Baseline | This cycle |
| ---: | :--- | :--- | :--- |
| 1 | n8n starts | PASS | NOT RUN |
| 2 | editor opens | PASS | NOT RUN |
| 3 | login / owner setup | PASS | NOT RUN |
| 4 | workflow create | PASS | NOT RUN |
| 5 | workflow save / import | PASS | NOT RUN |
| 6 | workflow load | PASS | NOT RUN |
| 7 | simple manual execution | PASS | NOT RUN |
| 8 | 1-node workflow | PASS | NOT RUN |
| 9 | linear workflow | PASS | NOT RUN |
| 10 | webhook workflow | PASS | NOT RUN |
| 11 | execution recorded | PASS | NOT RUN |

**Re-run status: NOT RUN.** The verification sandbox has Node 22 but no Docker,
no pnpm, and no running n8n/PostgreSQL instance, so `regression_gate.py` cannot
reach `http://127.0.0.1:5678` or `n8n-db-1`. Per §12 of the Agent-5 brief, an
unverified regression gate is **not** a pass. The 11/11 must be re-executed on the
VPS before any integration is declared VERIFIED.

**Important:** no source change has been made to `reference/n8n/` in this cycle, so
no regression is *expected* — but "not expected" is not evidence.
