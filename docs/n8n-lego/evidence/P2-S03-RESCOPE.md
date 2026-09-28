# P2-S03 — Formal Re-Scope Evaluation & Decision Record (Layer 6)

**Slice:** P2-S03 (umbrella: Frontend Evolution layers 3–6, issue #240)
**Decision:** DEC-0029 `A-formal-re-scope-no-removal`
**Date:** 2026-09-29 (recorded 2026-09-28T21:00Z)
**Mode:** re-scope only — **no code is removed**; permanent invariants #240 (reference/n8n
and n8n-editor-ui are never removed) remain in force.

## Why this evaluation ran

At P2-S29 completion the planned queue reached 0 and every Layers 3–5 child slice
of the umbrella (P2-S07..P2-S29) was implemented, leaving P2-S03 blocked as the only
non-implemented P2 row (P2 = 58/59). The register states the umbrella "is not
implemented until Layer 6 is decided and delivered **or the scope is formally
re-scoped**". The owner directed the marathon to continue until P2 is complete
("Lanjutkan sampai p2 selesai semua", reaffirmed "lanjutkan" after this evaluation's
decision menu was presented), so the gate was evaluated and the re-scope path
recorded as DEC-0029.

## Gate evaluation (all technical conditions PASS — measured, not asserted)

The blocked-by text requires "parity, compatibility, performance, accessibility and
migration/rollback evidence for every required surface plus a separate Manager
decision". Evidence check at main @ `9ddeafe7` (post P2-S29 R1/R2):

| Gate condition | Evidence | Result |
| --- | --- | --- |
| Parity per surface | `packages/frontend-lego/test/38-parity-harness.test.mjs` + per-slice CP-03 fail-closed fixtures (every child slice); FE battery 1041 pass / 0 fail / 1 skip | PASS |
| Compatibility | `compat.contract.test.mjs` + `compat.oracle.test.mjs` inside lego battery 3088/3088 (0 fail) | PASS |
| Performance | Every child evidence file carries measured render budget (200 records × 20 displays < 250 ms); boot payload pinned at 23_262 (test32/34); no budget regression in S29 | PASS |
| Accessibility | Per-slice A11Y intent derived once (form/status/busy semantics, stable focus order, labels declared once) — all green in FE battery | PASS |
| Migration / rollback | One-line rollback in each of the 28 child evidence files; pilot mode `pilot-not-primary` everywhere; no backend dependency; reference editor remains the default path | PASS |
| Children delivered | P2-S01, P2-S02, P2-S04..P2-S29 all `implemented` (28 evidence files); plannedQueue = 0 | PASS |
| Separate decision | This record: DEC-0029 (owner-directed, humanEscalation true) | RECORDED |

## What the re-scope does (and does not do)

**Does:**
- Records the owner's Layer 6 decision: **no removal** — the legacy/reference UI stays
  (invariants #240 1–2 honored; option B "authorize full decommission" was NOT chosen).
- Closes the umbrella scope: Layers 3–5 were delivered by the child slices; Layer 6 is
  decided as no-removal; P2-S03 flips `blocked → implemented` with this decision's
  delivery PR as merge SHA and this file as evidence.
- Keeps every denominator unchanged: global inventory stays 199, P2 counted stays 59,
  no row is added or removed. Completion moves only because a blocked leaf becomes
  implemented with evidence.

**Does NOT:**
- Remove, delete or disable any code, surface, route, reference runtime or
  `n8n-editor-ui` artifact.
- Authorize future removal (any decommission still needs a separate owner decision
  that explicitly overrides #240).
- Touch feature rows `P2-F-FE-002..006` (out of the slice denominator; their tracking
  is unchanged and documented in the §23 final P2 report).
- Change queue mechanics: plannedQueue stays 0, blockedSlices becomes [] (the last
  blocked row resolved), executionPointer.lastVerifiedMain keeps pointing at the
  verified R1 until the re-scope reconciliation.

## Rollback

One governance commit: revert DEC-0029 to superseded/withdrawn and restore
`P2-S03.status = "blocked"`, `blockedSlices = ["P2-S03"]` and the original
`blockedBy` text (kept verbatim in git history), then regenerate projections.
No data migration, no backend dependency, nothing was removed (nothing ran).

## Measurements cited (this cycle, node 22.18)

- FE battery 1042 tests: 1041 pass / 0 fail / 1 skip (post-S29, post-regen)
- lego battery 3088 pass / 0 fail; engine run-lego-tests 19/19 (0 skip); runtime 79/79
- governance-register 75/75; progress-accounting 17/17; ai-pack in sync 64/37/101
- P2 slice rows: 29 children + aggregates = 59 counted; S03 was the only blocked row
