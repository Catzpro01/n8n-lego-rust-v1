# P5-M04 — Rotation work-list: measure-first finding

**Task (register):** "Key-rotation work list without an O(n) scan: measure first
(per-batch scan vs the O(n) replaceAll persist), index only if the scan dominates."
**Debt source:** `P5.8-CERTIFICATION-EVIDENCE.md` §7 — P5.5: "rotation work-list is an
O(n) filter."
**Kind:** maintenance (measure-first). **Decision: NO work-list index for the
production (file-backed) path — the scan does not dominate; the persist does.**

## The two O(n) costs in one rotation step

`vault.stepRotation` runs, per batch, two O(n) passes over the collection:

1. **The scan** — `recordsNotOnCurrent(collection)` = `collection.all().filter(r => r.secret.keyRef !== current)`. An in-memory O(n) filter (a full read is O(1): `all()` returns the record array).
2. **The persist** — `commitBatch` = `collection.replaceAll(collection.all().map(...))`. For a file-backed `Collection`, `replaceAll` is a **full-file tmp+rename rewrite of ALL n records on every batch**, even though only `batchSize` records changed.

Over ≈ `n/batchSize` batches, both are O(n²/batchSize) — but with very different
constants. P5-M04 measures which constant dominates.

## Method

`tools/p5/rotation-worklist-benchmark.mjs` (`measureRotation` + `shouldIndex`, both
importable; CLI prints JSON). For each scale it measures, on a real file-backed
`Collection` and on an in-memory collection:

- `perBatchScanMs` — one work-list filter over n records;
- `perBatchPersistMs` — one `all().map() + replaceAll()` over n records;
- `perRecordCryptoMs` — one seal+open (re-encrypt proxy).

and projects to a full rotation: `steps = ceil(n/batchSize)`,
`estScanMs = steps × perBatchScanMs`, `estPersistMs = steps × perBatchPersistMs`.
The decision rule is `shouldIndex = estScanMs > estPersistMs` (a strictly-greater
scan is required, so a near-tie does not trigger an index). Every number is from
the running process on the running machine — nothing is estimated. Reproduce:
`node tools/p5/rotation-worklist-benchmark.mjs`.

## Measured (node v20.20.2 linux/x64, batchSize 256)

**File-backed (production — real I/O):**

| n | perBatch scan | perBatch persist | est scan | est persist | persist/scan | indexJustified |
|---|---|---|---|---|---|---|
| 1,000 | 0.48 ms | 2.38 ms | 1.9 ms | 9.5 ms | **5×** | false |
| 10,000 | 1.70 ms | 22.60 ms | 68 ms | 904 ms | **13×** | false |
| 50,000 | 13.08 ms | 155.44 ms | 2,564 ms | 30,465 ms | **12×** | false |
| 100,000 | 22.06 ms | 326.85 ms | 8,625 ms | 127,800 ms | **15×** | false |

**In-memory (cheap writes):**

| n | perBatch scan | perBatch persist | indexJustified |
|---|---|---|---|
| 1,000 | 0.58 ms | 0.012 ms | true |
| 10,000 | 3.79 ms | 0.275 ms | true |
| 50,000 | 9.70 ms | 1.06 ms | true |
| 100,000 | 32.37 ms | 2.38 ms | true |

(The exact figures drift run-to-run with the machine; the **direction** is stable —
a full-file rewrite is always far costlier than an in-memory filter over the same data.)

## Finding

- **File-backed (the current production storage — per-host local file keyring, P5.5):**
  the **persist dominates the scan by 5–15×** and the gap widens with scale. The
  O(n) work-list **scan is NOT the bottleneck**; it is a small fraction of rotation
  cost. Indexing it would buy almost nothing.
- **In-memory (cheap writes, e.g. tests / a future in-RAM store):** the **scan
  dominates** (the O(n) filter vs a near-free array splice). An index *would* help
  there — but that is not the production path.

## Decision (P5-M04)

**Do not index the rotation work-list.** Per the measure-first rule, an index is
justified only when the scan dominates the persist; on the production (file-backed)
storage the persist dominates by an order of magnitude, so an index would not
reduce rotation cost. The O(n) filter stays. (The in-memory result is recorded as a
data point: a cheap-write backend *would* make the scan the bottleneck.)

## The real P5.5 rotation debt (clarified by this measurement)

The production bottleneck is **not** the work-list filter but the **persist**:
`commitBatch` rewrites the **entire file on every batch** (`replaceAll` of all n
records) even though only `batchSize` changed, making rotation **O(n²/batchSize)
in I/O** (100,000 records → ≈128 s of file I/O at batchSize 256). The
higher-leverage follow-up is to make the persist incremental (partial/multi-record
update, a larger effective batch, or a write-ahead log) rather than to index the
scan. That work is a separate slice; it is recorded here so the debt points at the
actual bottleneck.

## Tests

`test/rotation-worklist-measure.test.mjs` (3/3): pins the `shouldIndex` rule
(index only on a strictly-greater scan), asserts the `measureRotation` breakdown is
valid and self-consistent, and pins the production finding (file-backed persist
dominates the scan → `indexJustified=false`).
