/**
 * P7-S08 — Differential Certification (Issue #223 §37-38, §40-41; DEC-0024).
 *
 * Unit rules pin the differential oracle (the four difference classes over canonical-JSON
 * superset/subset rules), the certification report (certified only when no difference is
 * breaking), the 20-case negative/security matrix, the low-resource (1 vCPU / 1 GB) budget, and
 * the reproducibility of a certification record pinned to n8n-workflow 2.9.1.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PINNED_N8N_VERSION, DIFFERENTIAL_ASPECTS, DIFFERENCE_CLASSES, CertificationError,
  classifyDifference, certify, NEGATIVE_CASES, verifyNegativeResult, runNegativeMatrix,
  LOW_RESOURCE_BUDGET, checkLowResourceBudget, certificationFingerprint,
} from '../src/lego/parameter-certify.mjs';

/* ------------------------------------------------------------------ CP-01 differential oracle */

test('CP-01: an identical P7 output and oracle output is EQUIVALENT', () => {
  const d = classifyDifference({ options: [{ name: 'A', value: 'a' }] }, { options: [{ name: 'A', value: 'a' }] }, 'options');
  assert.equal(d.differenceClass, DIFFERENCE_CLASSES.EQUIVALENT);
  assert.equal(d.aspect, 'options');
});

test('CP-01: P7 adding to the oracle (strict superset) is a COMPATIBLE_IMPROVEMENT', () => {
  const oracle = { options: [{ name: 'A', value: 'a' }] };
  const p7 = { options: [{ name: 'A', value: 'a' }], meta: { source: 'p7' } };
  const d = classifyDifference(p7, oracle, 'options');
  assert.equal(d.differenceClass, DIFFERENCE_CLASSES.COMPATIBLE_IMPROVEMENT);
  assert.ok(d.detail);
});

test('CP-01: P7 dropping oracle data (subset) is BREAKING', () => {
  const oracle = { options: [{ name: 'A', value: 'a' }, { name: 'B', value: 'b' }] };
  const p7 = { options: [{ name: 'A', value: 'a' }] };
  const d = classifyDifference(p7, oracle, 'options');
  assert.equal(d.differenceClass, DIFFERENCE_CLASSES.BREAKING);
  assert.ok(d.detail);
});

test('CP-01: same shape, different value is MIGRATION_REQUIRED', () => {
  const oracle = { default: 'x' };
  const p7 = { default: 'y' };
  const d = classifyDifference(p7, oracle, 'defaults');
  assert.equal(d.differenceClass, DIFFERENCE_CLASSES.MIGRATION_REQUIRED);
});

test('CP-01: an unknown differential aspect is rejected', () => {
  assert.throws(() => classifyDifference({}, {}, 'not-an-aspect'), (err) => err instanceof CertificationError);
  assert.equal(DIFFERENTIAL_ASPECTS.length, 12, 'the twelve aspects are pinned');
  assert.ok(DIFFERENTIAL_ASPECTS.includes('resource-locator') && DIFFERENTIAL_ASPECTS.includes('credential-aware-lookups'));
});

/* ------------------------------------------------------------------ CP-02 certification report */

test('CP-02: certified is true when no difference is breaking (equivalent/improvement/migration tolerated)', () => {
  const report = certify([
    { aspect: 'options', p7: { a: 1 }, oracle: { a: 1 } },
    { aspect: 'defaults', p7: { d: 1, extra: 2 }, oracle: { d: 1 } },
    { aspect: 'normalization', p7: { v: 'b' }, oracle: { v: 'a' } },
  ]);
  assert.equal(report.certified, true);
  assert.equal(report.total, 3);
  assert.equal(report.breaking.length, 0);
  assert.equal(report.pinnedN8nVersion, PINNED_N8N_VERSION);
  assert.ok(Object.isFrozen(report));
});

test('CP-02: certified is false when a difference is breaking (the breaking set is enumerated)', () => {
  const report = certify([
    { aspect: 'options', p7: { a: 1 }, oracle: { a: 1 } },
    { aspect: 'pagination', p7: { items: [1] }, oracle: { items: [1, 2] } },
  ]);
  assert.equal(report.certified, false);
  assert.equal(report.breaking.length, 1);
  assert.equal(report.breaking[0].aspect, 'pagination');
});

test('CP-02: certify rejects malformed input', () => {
  assert.throws(() => certify('nope'), (err) => err.code === 'CERTIFICATION_INVALID');
  assert.throws(() => certify([{ aspect: 'options', p7: {} }]), (err) => err.code === 'CERTIFICATION_INVALID');
});

/* ------------------------------------------------------------------ CP-03 negative/security matrix */

test('CP-03: the negative matrix is a frozen registry of exactly the 20 mandatory cases', () => {
  assert.ok(Object.isFrozen(NEGATIVE_CASES));
  assert.equal(NEGATIVE_CASES.length, 20);
  const ids = NEGATIVE_CASES.map((c) => c.id);
  for (const required of ['cyclic-dependency', 'invalid-path', 'malformed-provider-response', 'timeout', 'cancellation', 'stale-overlapping-response', 'cache-scope-collision', 'wrong-tenant', 'missing-capability', 'provider-without-permission', 'credential-access-without-p5', 'secret-leakage-through-cache', 'secret-leakage-through-logs', 'provider-forged-permission-metadata', 'schema-version-mismatch', 'incompatible-node-definition', 'unbounded-pagination', 'provider-retry-storm']) {
    assert.ok(ids.includes(required), `missing mandatory case "${required}"`);
  }
});

test('CP-03: verifyNegativeResult checks a marked failure code for code-based cases', () => {
  const pass = verifyNegativeResult('timeout', { error: { code: 'TIMEOUT', message: 'x' } });
  assert.equal(pass.pass, true);
  const wrong = verifyNegativeResult('timeout', { error: { code: 'UNAVAILABLE' } });
  assert.equal(wrong.pass, false);
  const missing = verifyNegativeResult('missing-capability', { options: [] });
  assert.equal(missing.pass, false, 'an unmarked empty success is NOT the expected CAPABILITY_DENIED failure');
});

test('CP-03: verifyNegativeResult checks a behavioral marker for no-leak/no-retry cases', () => {
  const leak = verifyNegativeResult('secret-leakage-through-cache', { behavior: 'secret-leakage-through-cache' });
  assert.equal(leak.pass, true);
  const retry = verifyNegativeResult('provider-retry-storm', { behavior: 'provider-retry-storm' });
  assert.equal(retry.pass, true);
  assert.throws(() => verifyNegativeResult('not-a-case', {}), (err) => err.code === 'CERTIFICATION_INVALID');
});

test('CP-03: runNegativeMatrix reports coverage + pass; complete only when all 20 are covered and passing', () => {
  const probes = {};
  for (const c of NEGATIVE_CASES) {
    probes[c.id] = c.expectedCode !== null ? { error: { code: c.expectedCode } } : { behavior: c.id };
  }
  const full = runNegativeMatrix(probes);
  assert.equal(full.total, 20);
  assert.equal(full.covered, 20);
  assert.equal(full.passed, 20);
  assert.equal(full.complete, true);
  // drop one case -> not complete
  const partial = { ...probes };
  delete partial['timeout'];
  const report = runNegativeMatrix(partial);
  assert.equal(report.covered, 19);
  assert.equal(report.complete, false);
  const uncovered = report.results.find((r) => r.id === 'timeout');
  assert.equal(uncovered.covered, false);
});

/* ------------------------------------------------------------------ CP-04 low-resource budget */

test('CP-04: a config that fits the 1 vCPU / 1 GB budget is accepted', () => {
  const r = checkLowResourceBudget({ compileStrategy: 'once', persistentPolling: false, maxCacheEntries: 512, maxProviderConcurrency: 4, maxPageSize: 100, maxResponseBytes: 512 * 1024 });
  assert.equal(r.fits, true);
  assert.equal(r.violations.length, 0);
  assert.equal(LOW_RESOURCE_BUDGET.vcpu, 1);
  assert.equal(LOW_RESOURCE_BUDGET.memoryBytes, 1024 * 1024 * 1024);
});

test('CP-04: a config that violates the budget is rejected with enumerated violations', () => {
  const r = checkLowResourceBudget({ compileStrategy: 'per-request', persistentPolling: true, maxCacheEntries: 100000, maxProviderConcurrency: 64, maxPageSize: 10000, maxResponseBytes: 100 * 1024 * 1024 });
  assert.equal(r.fits, false);
  assert.ok(r.violations.length >= 5, `expected >= 5 violations, got ${r.violations.length}`);
  assert.ok(r.violations.some((v) => v.includes('persistent polling')));
  assert.ok(r.violations.some((v) => v.includes('compile')));
  assert.ok(r.violations.some((v) => v.includes('cache')));
});

/* ------------------------------------------------------------------ CP-05 reproducibility */

test('CP-05: a certification fingerprint is deterministic (same cases -> same fingerprint)', () => {
  const cases = [
    { aspect: 'options', p7: { a: 1 }, oracle: { a: 1 } },
    { aspect: 'defaults', p7: { d: 1, x: 2 }, oracle: { d: 1 } },
  ];
  const r1 = certificationFingerprint(certify(cases));
  const r2 = certificationFingerprint(certify(cases));
  assert.equal(r1.fingerprint, r2.fingerprint, 're-running the same cases gives an identical fingerprint');
  assert.equal(r1.pinnedN8nVersion, PINNED_N8N_VERSION);
  assert.ok(r1.basisBytes > 0);
});

test('CP-05: a different pinned version (or a different result) changes the record', () => {
  const a = certificationFingerprint(certify([{ aspect: 'options', p7: { a: 1 }, oracle: { a: 1 } }]));
  const b = certificationFingerprint(certify([{ aspect: 'options', p7: { a: 2 }, oracle: { a: 1 } }]));
  assert.notEqual(a.fingerprint, b.fingerprint, 'a value difference changes the record');
});
