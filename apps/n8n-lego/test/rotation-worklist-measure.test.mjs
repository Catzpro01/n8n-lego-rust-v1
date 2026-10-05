import test from 'node:test';
import assert from 'node:assert/strict';
import { measureRotation, shouldIndex } from '../tools/p5/rotation-worklist-benchmark.mjs';

test('shouldIndex: index ONLY when the scan strictly dominates the persist', () => {
  // persist dominates -> no index
  assert.equal(shouldIndex({ estScanMs: 5, estPersistMs: 10 }), false);
  // scan dominates -> index
  assert.equal(shouldIndex({ estScanMs: 10, estPersistMs: 5 }), true);
  // tie -> no index (strictly-greater required)
  assert.equal(shouldIndex({ estScanMs: 10, estPersistMs: 10 }), false);
  // scan dominates -> index
  assert.equal(shouldIndex({ estScanMs: 15, estPersistMs: 10 }), true);
  // zero persist (free writes) -> any scan dominates
  assert.equal(shouldIndex({ estScanMs: 1, estPersistMs: 0 }), true);
});

test('measureRotation: valid breakdown, consistent with shouldIndex (in-memory, fast)', () => {
  const row = measureRotation({ n: 200, batchSize: 64, backend: 'memory', runs: 3 });
  assert.equal(row.n, 200);
  assert.equal(row.batchSize, 64);
  assert.equal(row.backend, 'memory');
  assert.equal(row.steps, Math.ceil(200 / 64));
  for (const field of ['perBatchScanMs', 'perBatchPersistMs', 'perRecordCryptoMs', 'estScanMs', 'estPersistMs', 'estCryptoMs']) {
    assert.equal(Number.isFinite(row[field]), true, `${field} must be finite`);
    assert.equal(row[field] >= 0, true, `${field} must be >= 0`);
  }
  // the decision flag must agree with the rule applied to the same numbers
  assert.equal(row.indexJustified, shouldIndex({ estScanMs: row.estScanMs, estPersistMs: row.estPersistMs }));
});

test('measureRotation: file-backed production path -> the persist dominates the scan (P5-M04 finding)', () => {
  // A full-file replaceAll rewrite is always far costlier than an in-memory O(n)
  // filter for the same data, so the production (file-backed) rotation never
  // indexes the work-list: the persist is the bottleneck, not the scan.
  const row = measureRotation({ n: 500, batchSize: 64, backend: 'file', runs: 3 });
  assert.equal(row.backend, 'file');
  assert.equal(row.perBatchPersistMs > row.perBatchScanMs, true, 'file-backed persist must dominate the scan');
  assert.equal(row.indexJustified, false, 'no work-list index is justified for the file-backed production path');
});
