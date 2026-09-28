# PROGRESS ACCOUNTING AUDIT - P0-P11 global traceability repair

Slice: governance accounting repair (no feature scope). Evidence for the
accounting model: classification of every register row, deterministic
denominators, projection reconciliation and the progress-delta record.
All figures below are generated from `docs/n8n-lego/milestones.json` through
`tools/lego/governance-register.mjs` - no manual numbers.

## Baseline (before the repair)

```
MAIN_SHA            f419cfba594b1af3b9473a5fcdf243cf38c1b40e
REGISTER_SHA        bd267447cae2d7dd05f2b9d62ca844591dfa3b5bb1b49f760b389177dc642aa8
README_PROGRESS     global 171/200 = 85.5% | current 170/194 | future 1/6
CANONICAL_PROGRESS  identical (README block == generator output)
PROGRESS_DRIFT      0
GOVERNANCE_ERRORS   0
```

## Counting semantics (decisions PPA-1..PPA-5)

- **PPA-1 aggregate parents.** A row that other rows name as `parentSlice` is
  the aggregate of its children: its `pr`/`mergeSha` is the children's
  delivery (`P2.27` and `P2.27.10` share PR 197). Parent and children must not
  both count. The aggregate parent is EXCLUDED from the denominator (reason
  recorded per row); the children are the counted leaves. Explicit opt-in/out:
  `countedInProgress: true|false`. **Delta: P2 40/60 -> 39/59; global
  171/200 -> 170/199 = 85.4%.** Before: 40/60. After: 39/59. Reason: P2.27
  reclassified aggregate (its delivery is P2.27.0..P2.27.10, 11 leaves with
  own PRs 183..197).
- **PPA-2 leaves count once.** Range rollups (`P2.1-P2.4`, `P2.6-P2.10`) are
  the SOLE representation of their pre-register milestones (none of those
  milestone ids exist as separate rows) - one row, one unit. Ids are unique.
- **PPA-3 verified.** `verified` = implemented rows carrying a 40-hex
  `postMergeVerified` verification SHA (subset of implemented). The completion
  numerator stays `implemented` (DEC-0014/0015): post-merge verification is
  the R1 GATE for reaching implemented (updateRule), not a second numerator.
  Currently verified: P2-S01 (P2), FUTURE-RELIABILITY-S01 (future).
- **PPA-4 shared deliveries.** Several rows sharing one `pr`/`mergeSha` are
  legitimate multi-item PRs when scopes differ: (41) P0.1+P1.1 baseline+inventory;
  (42) P1.2 contract layer + P2.1-P2.4 rollup (cross-program scope); (44)
  P2.6-P2.10 + P2.12 Skill; (355) P5-M02 + P6-S05 (consumer pair); (356)
  P8-S01..S07 storage vertical (7 scopes, one PR). Only PPA-1 double counted.
- **PPA-5 queue != inventory.** `plannedQueue` (18 executable P2 tails) is an
  execution queue; the denominator is the inventory (199 counted rows). Queue
  membership changes ONLY at START; accounting never touches it.

- **unauthorized** = status `proposed` (P6-S03, P6-S04: no owner authorization).
  `P10-S01`/`P11-S01` are planned placeholders ("planned is not authorized by
  itself") - scope-counted, execution-ineligible until authorized. Not mixed
  with "not completed".
- **historical** rows (122) are completed pre-register work with PR/SHA/evidence
  lineage; counted as implemented leaves (backward compatibility, no fake
  migration). **future** rows live in their own denominators (FUTURE-*), never
  inside current P0-P11 progress.

## Per-P accounting (deterministic; every number decomposes into counted ids)

| P | Total Scope | Verified | Implemented | In Progress | Planned | Blocked | Unauthorized | Progress |
|---|---|---|---|---|---|---|---|---|
| P0 | 2 | 0 | 2 | 0 | 0 | 0 | 0 | 100% |
| P1 | 2 | 0 | 2 | 0 | 0 | 0 | 0 | 100% |
| P2 | 59 | 1 | 39 | 1 | 18 | 1 | 0 | 66.1% |
| P3 | 18 | 0 | 18 | 0 | 0 | 0 | 0 | 100% |
| P4 | 10 | 0 | 10 | 0 | 0 | 0 | 0 | 100% |
| P5 | 26 | 0 | 26 | 0 | 0 | 0 | 0 | 100% |
| P6 | 36 | 0 | 34 | 0 | 0 | 0 | 2 | 94.4% |
| P7 | 8 | 0 | 8 | 0 | 0 | 0 | 0 | 100% |
| P8 | 7 | 0 | 7 | 0 | 0 | 0 | 0 | 100% |
| P9 | 23 | 0 | 23 | 0 | 0 | 0 | 0 | 100% |
| P10 | 1 | 0 | 0 | 0 | 1 | 0 | 0 | 0% |
| P11 | 1 | 0 | 0 | 0 | 1 | 0 | 0 | 0% |

Global (current P0-P11): 169/193 = 87.6%
Future programs (separate denominator): 1/6 = 16.7%
Combined inventory total: 170/199 = 85.4%

### P2 detail (the example that motivated the repair)

- seluruh item P2 yang ditemukan: 60 rows
- total inventory (counted denominator): 59 leaves
- item yang dihitung: P2.1-P2.4, P2.5, P2.6-P2.10, P2.11, P2.12, P2.13, P2.14, P2.15, P2.16, P2.17, P2.18, P2.19, P2.20, P2.21, P2.22, P2.23, P2.24, P2.25, P2.26, P2.27.0, P2.27.1, P2.27.2, P2.27.3, P2.27.4, P2.27.5, P2.27.6, P2.27.7, P2.27.8, P2.27.9, P2.27.10, P2-S01, P2-S02, P2-S03, P2-S04, P2-S05, P2-S06, P2-S07, P2-S08, P2-S09, P2-S10, P2-S11, P2-S12, P2-S13, P2-S14, P2-S15, P2-S16, P2-S17, P2-S18, P2-S19, P2-S20, P2-S21, P2-S22, P2-S23, P2-S24, P2-S25, P2-S26, P2-S27, P2-S28, P2-S29
- item yang tidak dihitung + alasan:
  - P2.27: aggregate parent of its parentSlice children (delivery represented by the children)
- verified items: P2-S01
- remaining items: P2-S03, P2-S11, P2-S12, P2-S13, P2-S14, P2-S15, P2-S16, P2-S17, P2-S18, P2-S19, P2-S20, P2-S21, P2-S22, P2-S23, P2-S24, P2-S25, P2-S26, P2-S27, P2-S28, P2-S29
- blocked items: P2-S03 (blocked, authorized for resolution only by owner decommission)
- queue items (execution queue only): P2-S12, P2-S13, P2-S14, P2-S15, P2-S16, P2-S17, P2-S18, P2-S19, P2-S20, P2-S21, P2-S22, P2-S23, P2-S24, P2-S25, P2-S26, P2-S27, P2-S28, P2-S29
- README value: P2 39/59 = 66.1% (generated block)
- derived value: identical (renderReadmeMilestoneSection from this register)
- discrepancy: 0 after PPA-1 (before the repair the aggregate P2.27 inflated
  both sides identically: 40/60 everywhere - projection-consistent but
  double-counted against the delivery lineage)

## Classification table (all rows: shape, role, counting, trace)

| id | program | shape | status | counted | role | verified | trace |
|---|---|---|---|---|---|---|---|
| P0.1 | P0 | layer-numbered | implemented | yes | leaf | no | PR 41 93078360 |
| P0.2 | P0 | layer-numbered | implemented | yes | leaf | no | 465d8560 |
| P1.1 | P1 | layer-numbered | implemented | yes | leaf | no | PR 41 93078360 |
| P1.2 | P1 | layer-numbered | implemented | yes | leaf | no | PR 42 cb71dbb2 |
| P2.1-P2.4 | P2 | range-rollup | implemented | yes | leaf | no | PR 42 cb71dbb2 |
| P2.5 | P2 | layer-numbered | implemented | yes | leaf | no | PR 43 a1495ed3 |
| P2.6-P2.10 | P2 | range-rollup | implemented | yes | leaf | no | PR 44 e754c5df |
| P2.11 | P2 | layer-numbered | implemented | yes | leaf | no | 0c320742 |
| P2.12 | P2 | layer-numbered | implemented | yes | leaf | no | PR 44 e754c5df |
| P2.13 | P2 | layer-numbered | implemented | yes | leaf | no | PR 46 67e638ef |
| P2.14 | P2 | layer-numbered | implemented | yes | leaf | no | PR 48 0d9466f1 |
| P2.15 | P2 | layer-numbered | implemented | yes | leaf | no | PR 49 ce65851b |
| P2.16 | P2 | layer-numbered | implemented | yes | leaf | no | PR 52 f2188223 |
| P2.17 | P2 | layer-numbered | implemented | yes | leaf | no | PR 53 8da4d00c |
| P2.18 | P2 | layer-numbered | implemented | yes | leaf | no | PR 54 b3bdaab9 |
| P2.19 | P2 | layer-numbered | implemented | yes | leaf | no | PR 56 393622e3 |
| P2.20 | P2 | layer-numbered | implemented | yes | leaf | no | PR 58 84337490 |
| P2.21 | P2 | layer-numbered | implemented | yes | leaf | no | PR 61 7d964fd6 |
| P2.22 | P2 | layer-numbered | implemented | yes | leaf | no | PR 65 389c6b5d |
| P2.23 | P2 | layer-numbered | implemented | yes | leaf | no | PR 67 82f4d305 |
| P2.24 | P2 | layer-numbered | implemented | yes | leaf | no | PR 69 a409d930 |
| P2.25 | P2 | layer-numbered | implemented | yes | leaf | no | PR 71 9cc6ba88 |
| P2.26 | P2 | layer-numbered | implemented | yes | leaf | no | PR 73 6d70bcfb |
| P2.27 | P2 | aggregate-parent | implemented | no | aggregate-parent | no | PR 197 7d4eae8d |
| P2.27.0 | P2 | child | implemented | yes | leaf | no | PR 183 87580224 |
| P2.27.1 | P2 | child | implemented | yes | leaf | no | PR 185 fb490f42 |
| P2.27.2 | P2 | child | implemented | yes | leaf | no | PR 186 34a79376 |
| P2.27.3 | P2 | child | implemented | yes | leaf | no | PR 187 171da893 |
| P2.27.4 | P2 | child | implemented | yes | leaf | no | PR 188 a3f1b947 |
| P2.27.5 | P2 | child | implemented | yes | leaf | no | PR 189 8c506bd6 |
| P2.27.6 | P2 | child | implemented | yes | leaf | no | PR 190 ae48a4e4 |
| P2.27.7 | P2 | child | implemented | yes | leaf | no | PR 192 f338418f |
| P2.27.8 | P2 | child | implemented | yes | leaf | no | PR 193 5f00e933 |
| P2.27.9 | P2 | child | implemented | yes | leaf | no | PR 195 63aadb19 |
| P2.27.10 | P2 | child | implemented | yes | leaf | no | PR 197 7d4eae8d |
| P2-S01 | P2 | S | implemented | yes | leaf | yes | PR 244 c77c3dba |
| P2-S02 | P2 | S | implemented | yes | leaf | no | 0c2c5a7c |
| P2-S03 | P2 | S | blocked | yes | leaf | no | - |
| P2-S04 | P2 | S | implemented | yes | leaf | no | 1cab18c2 |
| P2-S05 | P2 | S | implemented | yes | leaf | no | 1f89499c |
| P2-S06 | P2 | S | implemented | yes | leaf | no | b3aba728 |
| P2-S07 | P2 | S | implemented | yes | leaf | no | 0bc35abd |
| P2-S08 | P2 | S | implemented | yes | leaf | no | 8a957ee8 |
| P2-S09 | P2 | S | implemented | yes | leaf | no | edc3e960 |
| P2-S10 | P2 | S | implemented | yes | leaf | no | PR 368 60763a5e |
| P2-S11 | P2 | S | in-progress | yes | leaf | no | - |
| P2-S12 | P2 | S | planned | yes | leaf | no | - |
| P2-S13 | P2 | S | planned | yes | leaf | no | - |
| P2-S14 | P2 | S | planned | yes | leaf | no | - |
| P2-S15 | P2 | S | planned | yes | leaf | no | - |
| P2-S16 | P2 | S | planned | yes | leaf | no | - |
| P2-S17 | P2 | S | planned | yes | leaf | no | - |
| P2-S18 | P2 | S | planned | yes | leaf | no | - |
| P2-S19 | P2 | S | planned | yes | leaf | no | - |
| P2-S20 | P2 | S | planned | yes | leaf | no | - |
| P2-S21 | P2 | S | planned | yes | leaf | no | - |
| P2-S22 | P2 | S | planned | yes | leaf | no | - |
| P2-S23 | P2 | S | planned | yes | leaf | no | - |
| P2-S24 | P2 | S | planned | yes | leaf | no | - |
| P2-S25 | P2 | S | planned | yes | leaf | no | - |
| P2-S26 | P2 | S | planned | yes | leaf | no | - |
| P2-S27 | P2 | S | planned | yes | leaf | no | - |
| P2-S28 | P2 | S | planned | yes | leaf | no | - |
| P2-S29 | P2 | S | planned | yes | leaf | no | - |
| P3 Slice A | P3 | legacy | implemented | yes | leaf | no | PR 110 ef751c5b |
| P3 Slice B | P3 | legacy | implemented | yes | leaf | no | PR 112 454ef1d3 |
| P3.2 | P3 | layer-numbered | implemented | yes | leaf | no | PR 113 adb94b2b |
| P3.3 | P3 | layer-numbered | implemented | yes | leaf | no | PR 114 75189576 |
| P3.4 | P3 | layer-numbered | implemented | yes | leaf | no | PR 118 4e70e821 |
| P3.5 | P3 | layer-numbered | implemented | yes | leaf | no | PR 119 2b90bf73 |
| P3.6 | P3 | layer-numbered | implemented | yes | leaf | no | PR 120 a3a0237b |
| P3.7 | P3 | layer-numbered | implemented | yes | leaf | no | PR 122 d43b6530 |
| P3.8 | P3 | layer-numbered | implemented | yes | leaf | no | PR 123 99c39009 |
| P3.9 | P3 | layer-numbered | implemented | yes | leaf | no | PR 125 b5b5e587 |
| P3.10 | P3 | layer-numbered | implemented | yes | leaf | no | PR 126 2277693d |
| P3.11 | P3 | layer-numbered | implemented | yes | leaf | no | PR 127 af64f861 |
| P3.12 | P3 | layer-numbered | implemented | yes | leaf | no | PR 129 46956d3e |
| P3.13 | P3 | layer-numbered | implemented | yes | leaf | no | PR 132 e164f059 |
| P3.14 | P3 | layer-numbered | implemented | yes | leaf | no | PR 134 9f6625b9 |
| P3.15 | P3 | layer-numbered | implemented | yes | leaf | no | PR 135 f833a5a5 |
| P3.15-fix | P3 | legacy | implemented | yes | leaf | no | PR 136 6e31854d |
| P3-S01 | P3 | S | implemented | yes | leaf | no | 048f5bf5 |
| P4.1 | P4 | layer-numbered | implemented | yes | leaf | no | PR 117 d3952379 |
| P4.2 | P4 | layer-numbered | implemented | yes | leaf | no | PR 131 320dd762 |
| P4.3 | P4 | layer-numbered | implemented | yes | leaf | no | PR 137 83f6218e |
| P4.4 | P4 | layer-numbered | implemented | yes | leaf | no | b4fc673b |
| P4.5 | P4 | layer-numbered | implemented | yes | leaf | no | 26acc10f |
| P4.6 | P4 | layer-numbered | implemented | yes | leaf | no | 677c7142 |
| P4.7 | P4 | layer-numbered | implemented | yes | leaf | no | a7ec39e0 |
| P4.8 | P4 | layer-numbered | implemented | yes | leaf | no | 57c473a5 |
| P4.9 | P4 | layer-numbered | implemented | yes | leaf | no | 7dbbf2c6 |
| P4-S01 | P4 | S | implemented | yes | leaf | no | PR 323 a32e9b80 |
| P5.1 | P5 | layer-numbered | implemented | yes | leaf | no | PR 226 0842a05f |
| P5.2 | P5 | layer-numbered | implemented | yes | leaf | no | PR 242 d8f18174 |
| P5.3 | P5 | layer-numbered | implemented | yes | leaf | no | PR 247 57606b52 |
| P5.4 | P5 | layer-numbered | implemented | yes | leaf | no | PR 249 ae99e980 |
| P5.5 | P5 | layer-numbered | implemented | yes | leaf | no | PR 250 260b838d |
| P5.6 | P5 | layer-numbered | implemented | yes | leaf | no | PR 251 4e6802c8 |
| P5.7 | P5 | layer-numbered | implemented | yes | leaf | no | PR 252 5310bf31 |
| P5.8 | P5 | layer-numbered | implemented | yes | leaf | no | PR 253 87099dc0 |
| P5-M01 | P5 | M | implemented | yes | leaf | no | PR 289 27191091 |
| P5-M02 | P5 | M | implemented | yes | leaf | no | PR 355 d549d40d |
| P5-M03 | P5 | M | implemented | yes | leaf | no | PR 291 cf52701c |
| P5-M04 | P5 | M | implemented | yes | leaf | no | 3ba8f339 |
| P5-M05 | P5 | M | implemented | yes | leaf | no | PR 357 b7fb9ea4 |
| P5-M06 | P5 | M | implemented | yes | leaf | no | PR 367 49103ac9 |
| P5-M07 | P5 | M | implemented | yes | leaf | no | PR 317 0845c25f |
| P5-M08 | P5 | M | implemented | yes | leaf | no | PR 304 600a2145 |
| P5-M09 | P5 | M | implemented | yes | leaf | no | c13ba6dc |
| P5-M10 | P5 | M | implemented | yes | leaf | no | PR 366 c95a0fae |
| P5-M11 | P5 | M | implemented | yes | leaf | no | PR 358 3cb5d356 |
| P5-M12 | P5 | M | implemented | yes | leaf | no | PR 359 8d86e657 |
| P5-M13 | P5 | M | implemented | yes | leaf | no | PR 360 cb4143d6 |
| P5-M14 | P5 | M | implemented | yes | leaf | no | PR 361 a6daad8a |
| P5-M15 | P5 | M | implemented | yes | leaf | no | PR 362 5cb23602 |
| P5-M16 | P5 | M | implemented | yes | leaf | no | PR 363 b8798bbf |
| P5-M17 | P5 | M | implemented | yes | leaf | no | PR 364 b616be84 |
| P5-M18 | P5 | M | implemented | yes | leaf | no | PR 365 97f03df9 |
| P6.1 | P6 | layer-numbered | implemented | yes | leaf | no | PR 124 8a8195bd |
| P6.2 | P6 | layer-numbered | implemented | yes | leaf | no | PR 138 0d2bf016 |
| P6.3 | P6 | layer-numbered | implemented | yes | leaf | no | PR 139 89cc56df |
| P6.4 | P6 | layer-numbered | implemented | yes | leaf | no | PR 140 2b07ef34 |
| P6.5 | P6 | layer-numbered | implemented | yes | leaf | no | PR 142 fe53e933 |
| P6.6 | P6 | layer-numbered | implemented | yes | leaf | no | PR 143 42ceebf3 |
| P6.7 | P6 | layer-numbered | implemented | yes | leaf | no | PR 144 e2b00eeb |
| P6.8 | P6 | layer-numbered | implemented | yes | leaf | no | PR 146 3228d180 |
| P6.9 | P6 | layer-numbered | implemented | yes | leaf | no | PR 148 e5203c2f |
| P6.10 | P6 | layer-numbered | implemented | yes | leaf | no | PR 149 2607ef08 |
| P6.11 | P6 | layer-numbered | implemented | yes | leaf | no | PR 150 a8522f5c |
| P6.12 | P6 | layer-numbered | implemented | yes | leaf | no | PR 151 8d210dc5 |
| P6.13 | P6 | layer-numbered | implemented | yes | leaf | no | PR 152 24032a0c |
| P6.14 | P6 | layer-numbered | implemented | yes | leaf | no | PR 153 ee387a58 |
| P6.15 | P6 | layer-numbered | implemented | yes | leaf | no | 7a52b883 |
| P6.16 | P6 | layer-numbered | implemented | yes | leaf | no | 70cdea80 |
| P6.17 | P6 | layer-numbered | implemented | yes | leaf | no | 7a2e7f09 |
| P6.18 | P6 | layer-numbered | implemented | yes | leaf | no | 7bafa638 |
| P6.19 | P6 | layer-numbered | implemented | yes | leaf | no | 9528a5db |
| P6.20 | P6 | layer-numbered | implemented | yes | leaf | no | 40013e48 |
| P6.21 | P6 | layer-numbered | implemented | yes | leaf | no | 86b8072c |
| P6.22 | P6 | layer-numbered | implemented | yes | leaf | no | 720345ba |
| P6.23 | P6 | layer-numbered | implemented | yes | leaf | no | 6d901676 |
| P6.24 | P6 | layer-numbered | implemented | yes | leaf | no | 3d7b52ee |
| P6.25 | P6 | layer-numbered | implemented | yes | leaf | no | 9a3b2cb2 |
| P6.26 | P6 | layer-numbered | implemented | yes | leaf | no | 9f881366 |
| P6.27 | P6 | layer-numbered | implemented | yes | leaf | no | 5bb9cdb2 |
| P6.28 | P6 | layer-numbered | implemented | yes | leaf | no | 0db07362 |
| P6.29 | P6 | layer-numbered | implemented | yes | leaf | no | b6ca2413 |
| P6.30 | P6 | layer-numbered | implemented | yes | leaf | no | 7c7aa028 |
| P6.31 | P6 | layer-numbered | implemented | yes | leaf | no | 40dc5b00 |
| P6-S01 | P6 | S | implemented | yes | leaf | no | fce988e7 |
| P6-S02 | P6 | S | implemented | yes | leaf | no | d3c35c73 |
| P6-S03 | P6 | S | proposed | yes | leaf | no | - |
| P6-S04 | P6 | S | proposed | yes | leaf | no | - |
| P6-S05 | P6 | S | implemented | yes | leaf | no | PR 355 d549d40d |
| P7-S01 | P7 | S | implemented | yes | leaf | no | PR 334 8aedbfa2 |
| P7-S02 | P7 | S | implemented | yes | leaf | no | PR 336 d58dfaeb |
| P7-S03 | P7 | S | implemented | yes | leaf | no | d4243a94 |
| P7-S04 | P7 | S | implemented | yes | leaf | no | 568bcad8 |
| P7-S05 | P7 | S | implemented | yes | leaf | no | 05374e9f |
| P7-S06 | P7 | S | implemented | yes | leaf | no | aea9db18 |
| P7-S07 | P7 | S | implemented | yes | leaf | no | f3f98aaa |
| P7-S08 | P7 | S | implemented | yes | leaf | no | 88435ead |
| P8-S01 | P8 | S | implemented | yes | leaf | no | PR 356 3e0f621d |
| P8-S02 | P8 | S | implemented | yes | leaf | no | PR 356 3e0f621d |
| P8-S03 | P8 | S | implemented | yes | leaf | no | PR 356 3e0f621d |
| P8-S04 | P8 | S | implemented | yes | leaf | no | PR 356 3e0f621d |
| P8-S05 | P8 | S | implemented | yes | leaf | no | PR 356 3e0f621d |
| P8-S06 | P8 | S | implemented | yes | leaf | no | PR 356 3e0f621d |
| P8-S07 | P8 | S | implemented | yes | leaf | no | PR 356 3e0f621d |
| P9.1 | P9 | layer-numbered | implemented | yes | leaf | no | PR 128 1a7fc1aa |
| P9.2 | P9 | layer-numbered | implemented | yes | leaf | no | PR 133 a4565eff |
| P9.3 | P9 | layer-numbered | implemented | yes | leaf | no | PR 141 b76b6758 |
| P9.4 | P9 | layer-numbered | implemented | yes | leaf | no | PR 147 8aabd126 |
| P9.5 | P9 | layer-numbered | implemented | yes | leaf | no | PR 176 0b8bd9e2 |
| P9.6 | P9 | layer-numbered | implemented | yes | leaf | no | PR 177 f3a8a01a |
| P9.7 | P9 | layer-numbered | implemented | yes | leaf | no | PR 178 9de5de85 |
| P9.8 | P9 | layer-numbered | implemented | yes | leaf | no | PR 179 d80c73f0 |
| P9.9 | P9 | layer-numbered | implemented | yes | leaf | no | PR 180 9b17949e |
| P9.10 | P9 | layer-numbered | implemented | yes | leaf | no | PR 181 9c2d1d2e |
| P9.11 | P9 | layer-numbered | implemented | yes | leaf | no | f63a91e7 |
| P9.12 | P9 | layer-numbered | implemented | yes | leaf | no | f63a91e7 |
| P9.13 | P9 | layer-numbered | implemented | yes | leaf | no | f63a91e7 |
| P9.14 | P9 | layer-numbered | implemented | yes | leaf | no | f63a91e7 |
| P9.15 | P9 | layer-numbered | implemented | yes | leaf | no | f63a91e7 |
| P9.16 | P9 | layer-numbered | implemented | yes | leaf | no | f63a91e7 |
| P9.17 | P9 | layer-numbered | implemented | yes | leaf | no | f63a91e7 |
| P9.18 | P9 | layer-numbered | implemented | yes | leaf | no | f63a91e7 |
| P9.19 | P9 | layer-numbered | implemented | yes | leaf | no | f63a91e7 |
| P9.20 | P9 | layer-numbered | implemented | yes | leaf | no | f63a91e7 |
| P9.21 | P9 | layer-numbered | implemented | yes | leaf | no | f63a91e7 |
| P9.22 | P9 | layer-numbered | implemented | yes | leaf | no | f63a91e7 |
| P9-S01 | P9 | S | implemented | yes | leaf | no | abe81c33 |
| P10-S01 | P10 | S | planned | yes | leaf | no | - |
| P11-S01 | P11 | S | planned | yes | leaf | no | - |
| FUTURE-EVENT-S01 | FUTURE-EVENT | future | planned | yes | leaf | no | - |
| FUTURE-RELIABILITY-S01 | FUTURE-RELIABILITY | future | implemented | yes | leaf | yes | PR 246 aba5a0e4 |
| FUTURE-RELIABILITY-S02 | FUTURE-RELIABILITY | future | planned | yes | leaf | no | - |
| FUTURE-PLATFORM-S01 | FUTURE-PLATFORM | future | planned | yes | leaf | no | - |
| FUTURE-DISTRIBUTION-S01 | FUTURE-DISTRIBUTION | future | planned | yes | leaf | no | - |
| FUTURE-AI-ECOSYSTEM-S01 | FUTURE-AI-ECOSYSTEM | future | planned | yes | leaf | no | - |

## Queue vs inventory (explicit)

- P2 total inventory = 60 rows (59 counted leaves + 1 excluded aggregate)
- plannedQueue = 18 (execution queue: P2-S12..P2-S29)
- plannedQueue.length is NEVER the program total; queue changes only at START.

## Projection reconciliation (README / .ai)

- README generated block == renderReadmeMilestoneSection(register): YES (gate E)
- .ai projections regenerated by npm run lego:ai from the same register: YES
- per-P values in the block decompose into the counted ids listed above: YES (gate I)

## Governance tests (A-J)

apps/n8n-lego/test/progress-accounting.test.mjs - 17 tests covering
inventory completeness, no-orphan, no-double-counting, deterministic
aggregation, projection consistency, evidence consistency, queue
independence, progress delta, zero unexplained progress, zero invisible
completion.

