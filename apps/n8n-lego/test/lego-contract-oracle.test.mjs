import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  CORACLE_CONTRACT, CORACLE_SCHEMA_VERSION, CORACLE_FINDINGS,
  CORACLE_PHASES, CORACLE_LIMITS, CORACLE_NOTES,
  createContractOracle,
} from '../src/lego/contract-oracle.mjs';

const fixture = JSON.parse(readFileSync(
  new URL('./fixtures/p9/contract-oracle.json', import.meta.url), 'utf8'));

function oracleFor(phase) {
  const o = createContractOracle(fixture.schemas[phase]);
  assert.ok(o, `oracle constructs for ${phase}`);
  return o;
}

function codesOf(report) {
  return [...new Set(report.findings.map(f => f.code))].sort();
}

test('P9.20 contract: findings vocabulary, phases, notes, fail-closed config', () => {
  assert.equal(CORACLE_CONTRACT.id, 'observability.contract-oracle');
  assert.equal(CORACLE_CONTRACT.version, '1.0.0');
  assert.equal(CORACLE_CONTRACT.owner, 'agent-6');
  assert.equal(CORACLE_SCHEMA_VERSION, '1.0.0');
  assert.deepEqual([...CORACLE_FINDINGS],
    ['missing_field', 'invented_field', 'vocabulary_drift', 'version_incompatible']);
  assert.deepEqual([...CORACLE_PHASES], ['P3', 'P4', 'P6', 'P8']);
  assert.ok(CORACLE_NOTES.includes('deterministic-output'));
  assert.ok(CORACLE_NOTES.includes('cross-domain-fixtures'));
  assert.ok(CORACLE_NOTES.includes('version-incompatibility-detected'));
  // fail-closed schemas
  assert.equal(createContractOracle('x'), null);
  assert.equal(createContractOracle({}), null);
  assert.equal(createContractOracle({ id: 'a', phase: 'P9', versionRange: '^1.0.0', fields: { f: {} } }), null);
  assert.equal(createContractOracle({ id: 'a', phase: 'P3', versionRange: '', fields: { f: {} } }), null);
  assert.equal(createContractOracle({
    id: 'a', phase: 'P3', versionRange: '^1.0.0', fields: {},
  }), null, 'fields must be non-empty');
  assert.equal(createContractOracle({
    id: 'a', phase: 'P3', versionRange: '^1.0.0',
    fields: { f: { nope: 1 } },
  }), null);
  assert.equal(createContractOracle({
    id: 'a', phase: 'P3', versionRange: '^1.0.0', fields: { f: {} }, extra: 1,
  }), null);
});

test('P9.20 P3 matrix: workflow producer contracts validated', () => {
  const o = oracleFor('P3');
  const m = o.validateMatrix(fixture.matrices.P3.map(x => x.specimen));
  assert.equal(m.ok, true);
  assert.equal(m.matrix.phase, 'P3');
  assert.equal(m.matrix.count, fixture.matrices.P3.length);
  fixture.matrices.P3.forEach((row, i) => {
    const r = m.matrix.reports[i];
    assert.equal(r.valid, row.expectValid, row.name);
    if (!row.expectValid) {
      assert.deepEqual(codesOf(r), [...row.expectCodes].sort(), row.name);
    } else {
      assert.equal(r.findingCount, 0, row.name);
    }
  });
  const snap = o.snapshot();
  assert.ok(snap.validated >= fixture.matrices.P3.length);
  assert.ok(snap.clean >= 2);
  assert.ok(snap.withFindings >= 1);
});

test('P9.20 P4 matrix: webhook producer contracts validated', () => {
  const o = oracleFor('P4');
  const m = o.validateMatrix(fixture.matrices.P4.map(x => x.specimen));
  assert.equal(m.ok, true);
  assert.equal(m.matrix.phase, 'P4');
  fixture.matrices.P4.forEach((row, i) => {
    const r = m.matrix.reports[i];
    assert.equal(r.valid, row.expectValid, row.name);
    if (!row.expectValid) {
      assert.deepEqual(codesOf(r), [...row.expectCodes].sort(), row.name);
    }
  });
  assert.equal(m.matrix.validCount, 1);
  assert.equal(m.matrix.invalidCount, 2);
});

test('P9.20 P6 matrix: node-registry producer contracts validated', () => {
  const o = oracleFor('P6');
  const m = o.validateMatrix(fixture.matrices.P6.map(x => x.specimen));
  assert.equal(m.ok, true);
  assert.equal(m.matrix.phase, 'P6');
  fixture.matrices.P6.forEach((row, i) => {
    const r = m.matrix.reports[i];
    assert.equal(r.valid, row.expectValid, row.name);
    if (!row.expectValid) {
      assert.deepEqual(codesOf(r), [...row.expectCodes].sort(), row.name);
    }
  });
  // ^0.1.0 accepts 0.1.x only — major jump fails closed
  const jump = m.matrix.reports[2];
  assert.equal(jump.findings.some(f => f.code === 'version_incompatible'), true);
});

test('P9.20 P8 matrix: storage producer contracts validated (where available)', () => {
  const o = oracleFor('P8');
  const m = o.validateMatrix(fixture.matrices.P8.map(x => x.specimen));
  assert.equal(m.ok, true);
  assert.equal(m.matrix.phase, 'P8');
  fixture.matrices.P8.forEach((row, i) => {
    const r = m.matrix.reports[i];
    assert.equal(r.valid, row.expectValid, row.name);
    if (!row.expectValid) {
      assert.deepEqual(codesOf(r), [...row.expectCodes].sort(), row.name);
    }
  });
  assert.equal(m.matrix.count, 2);
});

test('P9.20 missing-field test: required fields detected', () => {
  const o = oracleFor('P3');
  const r = o.validate({
    contractVersion: '1.0.0',
    event: 'execution.started',
    status: 'running',
    // workflowId missing
  });
  assert.equal(r.ok, true);
  assert.equal(r.report.valid, false);
  const missing = r.report.findings.filter(f => f.code === 'missing_field');
  assert.equal(missing.length, 1);
  assert.equal(missing[0].field, 'workflowId');
  // type mismatch also classified under missing_field with type_mismatch value
  const badType = o.validate({
    contractVersion: '1.0.0',
    event: 'execution.started',
    status: 'running',
    workflowId: 'wf-1',
    durationMs: 'slow',
  });
  assert.equal(badType.ok, true);
  assert.ok(badType.report.findings.some(f =>
    f.code === 'missing_field' && f.field === 'durationMs' && f.value === 'type_mismatch'));
});

test('P9.20 invented-field test: unknown fields detected', () => {
  const o = oracleFor('P3');
  const r = o.validate({
    contractVersion: '1.0.0',
    event: 'execution.completed',
    status: 'completed',
    workflowId: 'wf-1',
    totallyMadeUpField: { nested: true },
  });
  assert.equal(r.ok, true);
  assert.equal(r.report.valid, false);
  const inv = r.report.findings.filter(f => f.code === 'invented_field');
  assert.equal(inv.length, 1);
  assert.equal(inv[0].field, 'totallyMadeUpField');
});

test('P9.20 intentional drift test: vocabulary + version drift detected', () => {
  const o = oracleFor('P3');
  // vocabulary drift: status misspelled outside enum
  const r1 = o.validate({
    contractVersion: '1.0.0',
    event: 'execution.completed',
    status: 'compleet',
    workflowId: 'wf-1',
  });
  assert.equal(r1.ok, true);
  const drift = r1.report.findings.filter(f => f.code === 'vocabulary_drift');
  assert.equal(drift.length, 1);
  assert.equal(drift[0].field, 'status');
  assert.equal(drift[0].value, 'compleet');
  assert.ok(Array.isArray(drift[0].allowed) && drift[0].allowed.includes('completed'));
  // version incompatibility: 0.9.0 fails ^1.0.0
  const r2 = o.validate({
    version: '0.9.0',
    event: 'execution.started',
    status: 'running',
    workflowId: 'wf-1',
  });
  assert.equal(r2.ok, true);
  const ver = r2.report.findings.filter(f => f.code === 'version_incompatible');
  assert.equal(ver.length, 1);
  assert.equal(ver[0].value, '0.9.0');
  assert.equal(ver[0].expected, '^1.0.0');
  // missing version key entirely → version_incompatible missing
  const r3 = o.validate({
    event: 'execution.started',
    status: 'running',
    workflowId: 'wf-1',
  });
  assert.equal(r3.ok, true);
  assert.ok(r3.report.findings.some(f =>
    f.code === 'version_incompatible' && f.value === 'missing'));
});

test('P9.20 oracle output is deterministic', () => {
  const o1 = oracleFor('P3');
  const o2 = oracleFor('P3');
  const specimens = fixture.matrices.P3.map(x => x.specimen);
  const m1 = o1.validateMatrix(specimens);
  const m2 = o2.validateMatrix(specimens);
  assert.deepEqual(m1.matrix.reports, m2.matrix.reports,
    'fresh oracles, same input → deep-equal reports');
  // re-running on the same oracle: individual reports stay stable
  const a = o1.validate(specimens[2]);
  const b = o1.validate(specimens[2]);
  assert.deepEqual(a.report, b.report);
  assert.equal(a.report.fingerprint, b.report.fingerprint);
  // findings sorted by (code, field, value)
  const codes = a.report.findings.map(f => f.code);
  assert.deepEqual(codes, [...codes].sort());
  // fingerprint joins code:field:value in order
  assert.equal(typeof a.report.fingerprint, 'string');
  assert.ok(a.report.fingerprint.includes('missing_field:'));
  // invalid matrix input fail-closed deterministically
  assert.equal(o1.validateMatrix([]).ok, false);
  assert.equal(o1.validateMatrix([null]).ok, false);
  assert.equal(o1.validate(null).ok, false);
});

test('P9.20 lock pin: contracts length 75 after P9.22 row', () => {
  const lock = JSON.parse(readFileSync(
    new URL('../src/lego/contracts/contract-lock.json', import.meta.url), 'utf8'));
  assert.equal(lock.contracts.length, 100, // P9 integration (Agent 1): P9.5-P9.22 add 18 observability.* rows on top of protected main 76 -> 94 (union, zero id collisions); P9 was developed on 24032a0c (57 rows). P5.2 adds the ninety-sixth (auth.session). P5.3 adds the ninety-seventh (auth.authorization). P5.5 adds the ninety-eighth (auth.credential-crypto). P5.6 adds the ninety-ninth (auth.account-security). P5.7 adds the hundredth (auth.machine-identity).
    'P9.20 adds observability.contract-oracle@1.0.0; P9.21 adds observability.advanced-diagnostics@1.0.0; P9.22 adds observability.p9-acceptance@1.0.0; count-pins say 75');
  const row = lock.contracts.find(c => c.id === 'observability.contract-oracle');
  assert.ok(row, 'P9.20 row present');
  assert.equal(row.version, '1.0.0');
  assert.equal(row.owner, 'agent-6');
  assert.equal(row.domain, 'observability');
  assert.ok(Array.isArray(row.tests) && row.tests.length >= 1);
  assert.ok(String(row.notes).includes('P9.20'));
});
