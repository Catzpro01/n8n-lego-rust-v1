/**
 * P6.31 — the acceptance of a milestone: criteria, evidence and who verified.
 * Contract `registry.acceptance@0.1.0`.
 *
 * Matrix: the surface, the subject and self-acceptance, criteria and evidence, an accepted
 * milestone, a rejected one, every way an omission shows up, multiple findings at once,
 * determinism and the reads, the walls, and the lock row.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  ACCEPTANCE_OPERATIONS,
  ACCEPTANCE_PERMISSIONS,
  ACCEPTANCE_REASONS,
  ACCEPTANCE_RULES,
  ACCEPTANCE_VERDICTS,
  CRITERION_KINDS,
  CRITERION_VERDICTS,
  REGISTRY_ACCEPTANCE_CONTRACT,
  REGISTRY_ACCEPTANCE_CONTRACT_VERSION,
  REGISTRY_ACCEPTANCE_FORMAT,
  REGISTRY_ACCEPTANCE_SCHEMA_VERSION,
  AcceptanceError,
  acceptanceDigest,
  assessAcceptance,
  createAcceptanceSubject,
  createCriterion,
  describeAcceptance,
  explainAcceptance,
  isAcceptanceSubject,
  isCriterion,
  stableJson,
} from '../src/lego/registry-acceptance.mjs';

/* ------------------------------------------------------------------ fixtures */

const COMMIT = '24032a0c';
const SLICES = ['P6.29', 'P6.30'];
const EVIDENCE = 'a'.repeat(64);

const SUBJECT = (overrides = {}) => createAcceptanceSubject({
  commit: COMMIT,
  slices: SLICES,
  implementedBy: 'agent-3',
  verifiedBy: 'manager',
  protectedMain: true,
  ...overrides,
});

const CRITERIA = ({ kinds = CRITERION_KINDS, slices = SLICES, commit = COMMIT, verdict = 'pass' } = {}) =>
  kinds.map((kind, index) => createCriterion({
    id: `${kind}-${index}`,
    kind,
    slice: slices[index % slices.length],
    commit,
    verdict,
    evidenceDigest: verdict === 'not-applicable' ? null : EVIDENCE,
    justification: verdict === 'not-applicable' ? 'nothing in this slice touches that surface' : null,
  }));

const throwsWith = (fn, code) => {
  let caught = null;
  try { fn(); } catch (error) { caught = error; }
  assert.ok(caught instanceof AcceptanceError, `expected an AcceptanceError carrying ${code}`);
  assert.equal(caught.code, 'lego.contract_violation');
  assert.equal(caught.meta.code, code);
  return caught;
};

/* ------------------------------------------------------------------ contract */

test('the contract surface is the published one: id, version, ops, closed vocabularies', () => {
  assert.equal(REGISTRY_ACCEPTANCE_CONTRACT, 'registry.acceptance@0.1.0');
  assert.equal(REGISTRY_ACCEPTANCE_CONTRACT_VERSION, '0.1.0');
  assert.equal(REGISTRY_ACCEPTANCE_SCHEMA_VERSION, 1);
  assert.equal(REGISTRY_ACCEPTANCE_FORMAT, 'lego-acceptance@1');
  assert.deepEqual([...ACCEPTANCE_OPERATIONS], ['declare', 'criterion', 'assess', 'describe', 'explain']);
  assert.deepEqual([...ACCEPTANCE_PERMISSIONS], ['node:read']);
  assert.deepEqual([...ACCEPTANCE_VERDICTS], ['accepted', 'rejected', 'incomplete']);
  assert.deepEqual([...CRITERION_VERDICTS], ['pass', 'fail', 'incomplete', 'not-applicable']);
  assert.deepEqual([...CRITERION_KINDS], ['focused', 'negative', 'boundary', 'determinism', 'security', 'resource', 'rollback', 'docs', 'evidence']);
  assert.equal(ACCEPTANCE_REASONS.length, 9);
  assert.match(ACCEPTANCE_RULES.compose, /never imports, re-runs or overrules them/);
  assert.match(ACCEPTANCE_RULES.weakest, /a failure is a fact and an incomplete is an absence/);
  assert.match(ACCEPTANCE_RULES.authority, /it does not merge and cannot make a failing criterion pass/);
});

test('an acceptance names the commit, the slices, the verifier and the integration', () => {
  const subject = SUBJECT();
  assert.equal(isAcceptanceSubject(subject), true);
  assert.equal(isAcceptanceSubject({ commit: COMMIT }), false);
  assert.equal(Object.isFrozen(subject), true);
  assert.deepEqual([...subject.slices], ['P6.29', 'P6.30']);
  assert.equal(subject.protectedMain, true);
  const { subjectDigest, ...body } = subject;
  assert.equal(subjectDigest, acceptanceDigest(body));

  const unstated = SUBJECT({ protectedMain: undefined });
  assert.equal(unstated.protectedMain, false, 'protected-main is false until it is reported, and it cannot be assumed');

  assert.match(
    throwsWith(() => SUBJECT({ verifiedBy: 'agent-3' }), 'acceptance.self').message,
    /'agent-3' implemented this and 'agent-3' is verifying it: a lane cannot accept itself/,
  );
  throwsWith(() => SUBJECT({ commit: '' }), 'acceptance.input');
  assert.match(throwsWith(() => SUBJECT({ slices: [] }), 'acceptance.slice').message, /an acceptance over nothing covers nothing/);
  throwsWith(() => SUBJECT({ slices: ['P6.29', 'P6.29'] }), 'acceptance.slice');
  throwsWith(() => SUBJECT({ slices: [1] }), 'acceptance.slice');
  throwsWith(() => SUBJECT({ implementedBy: '' }), 'acceptance.input');
  throwsWith(() => SUBJECT({ protectedMain: 'yes' }), 'acceptance.input');
});

test('a pass with nothing to point at is an opinion, and not-applicable has to say why', () => {
  const criterion = createCriterion({ id: 'c1', kind: 'negative', slice: 'P6.30', commit: COMMIT, verdict: 'pass', evidenceDigest: `sha256:${EVIDENCE}` });
  assert.equal(isCriterion(criterion), true);
  assert.equal(isCriterion({ id: 'c1' }), false);
  assert.equal(Object.isFrozen(criterion), true);
  assert.equal(criterion.evidenceDigest, EVIDENCE, 'a digest prefix is spelling, not content');
  const { criterionDigest, ...body } = criterion;
  assert.equal(criterionDigest, acceptanceDigest(body));
  assert.equal(stableJson({ b: 1, a: 2 }), stableJson({ a: 2, b: 1 }));

  const absence = createCriterion({ id: 'c2', kind: 'resource', slice: 'P6.30', commit: COMMIT, verdict: 'incomplete' });
  assert.equal(absence.evidenceDigest, null, 'an incomplete is the verdict for the absence of evidence, and that is what it is for');
  const na = createCriterion({ id: 'c3', kind: 'docs', slice: 'P6.30', commit: COMMIT, verdict: 'not-applicable', justification: 'a repair contract has no documentation surface of its own' });
  assert.equal(na.justification.length > 0, true);

  assert.match(
    throwsWith(() => createCriterion({ id: 'c4', kind: 'security', slice: 'P6.30', commit: COMMIT, verdict: 'pass' }), 'acceptance.evidence').message,
    /criterion 'c4' is 'pass' with nothing to point at: a criterion without evidence is an opinion with a verdict attached/,
  );
  throwsWith(() => createCriterion({ id: 'c5', kind: 'security', slice: 'P6.30', commit: COMMIT, verdict: 'fail' }), 'acceptance.evidence');
  assert.match(
    throwsWith(() => createCriterion({ id: 'c6', kind: 'docs', slice: 'P6.30', commit: COMMIT, verdict: 'not-applicable' }), 'acceptance.na').message,
    /not-applicable without saying why: not applicable is a claim about the subject/,
  );
  assert.match(
    throwsWith(() => createCriterion({ id: 'c7', kind: 'vibes', slice: 'P6.30', commit: COMMIT, verdict: 'pass', evidenceDigest: EVIDENCE }), 'acceptance.criterion').message,
    /criterion kind 'vibes' is one of focused, negative, boundary, determinism, security, resource, rollback, docs, evidence/,
  );
  throwsWith(() => createCriterion({ id: 'c8', kind: 'docs', slice: 'P6.30', commit: COMMIT, verdict: 'probably', evidenceDigest: EVIDENCE }), 'acceptance.criterion');
  throwsWith(() => createCriterion({ kind: 'docs', slice: 'P6.30', commit: COMMIT, verdict: 'incomplete' }), 'acceptance.criterion');
  throwsWith(() => createCriterion({ id: 'c9', kind: 'docs', commit: COMMIT, verdict: 'incomplete' }), 'acceptance.criterion');
  throwsWith(() => createCriterion({ id: 'c10', kind: 'docs', slice: 'P6.30', verdict: 'incomplete' }), 'acceptance.criterion');
  throwsWith(() => createCriterion({ id: 'c11', kind: 'docs', slice: 'P6.30', commit: COMMIT, verdict: 'pass', evidenceDigest: 'not-a-digest' }), 'acceptance.evidence');
  assert.match(
    throwsWith(() => createCriterion({ id: 'c12', kind: 'docs', slice: 'P6.30', commit: COMMIT, verdict: 'not-applicable', justification: '' }), 'acceptance.na').message,
    /not-applicable without saying why/,
  );
});

/* ---------------------------------------------------------------- assessment */

test('a milestone whose evidence adds up is accepted, and the verifier is not the implementer', () => {
  const report = assessAcceptance({ subject: SUBJECT(), criteria: CRITERIA() });
  assert.equal(report.ok, true);
  assert.equal(report.verdict, 'accepted');
  assert.equal(report.reason, null);
  assert.deepEqual({ ...report.counts }, { criteria: 9, passed: 9, failed: 0, incomplete: 0, notApplicable: 0, slices: 2, slicesCovered: 2 });
  assert.deepEqual([...report.findings], []);
  assert.equal(report.protectedMain, true);
  assert.equal(report.commit, COMMIT);
  assert.equal(report.subject, SUBJECT().subjectDigest);
  assert.match(report.message, /acceptance for commit 24032a0c is accepted: 9 criterion\(s\) over 2 slice\(s\), verified by manager and not by agent-3, with protected-main verification reported/);
  assert.match(report.acceptanceDigest, /^[0-9a-f]{64}$/);
  assert.match(explainAcceptance(report), /^ACCEPTED — acceptance for commit 24032a0c is accepted/);
});

test('a failure is a fact and an incomplete is an absence: the weaker one is what gets reported', () => {
  const failing = CRITERIA().map((criterion) => (criterion.kind === 'security' ? createCriterion({ id: criterion.id, kind: 'security', slice: criterion.slice, commit: COMMIT, verdict: 'fail', evidenceDigest: EVIDENCE }) : criterion));
  const rejected = assessAcceptance({ subject: SUBJECT(), criteria: failing });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.verdict, 'rejected');
  assert.equal(rejected.reason, 'acceptance.criterion');
  assert.deepEqual([...rejected.failures], ['security-4']);
  assert.match(rejected.message, /is rejected: security-4 failed$/);

  const mixed = CRITERIA().map((criterion) => {
    if (criterion.kind === 'security') return createCriterion({ id: criterion.id, kind: 'security', slice: criterion.slice, commit: COMMIT, verdict: 'fail', evidenceDigest: EVIDENCE });
    if (criterion.kind === 'resource') return createCriterion({ id: criterion.id, kind: 'resource', slice: criterion.slice, commit: COMMIT, verdict: 'incomplete' });
    return criterion;
  });
  const both = assessAcceptance({ subject: SUBJECT(), criteria: mixed });
  assert.equal(both.verdict, 'rejected', 'a rejection is not softened by an incomplete sitting beside it');
  assert.deepEqual([...both.incompletes], ['resource-5']);
  assert.match(both.message, /and 1 criterion\(s\) are incomplete: resource-5/);
});

test('an omission is not a smaller milestone: missing slices, kinds, stale commits and undeclared slices', () => {
  const missingSlice = assessAcceptance({ subject: SUBJECT(), criteria: CRITERIA({ slices: ['P6.29'] }) });
  assert.equal(missingSlice.verdict, 'incomplete');
  assert.equal(missingSlice.reason, 'acceptance.slice');
  assert.deepEqual([...missingSlice.missingSlices], ['P6.30']);
  assert.deepEqual({ ...missingSlice.counts }, { criteria: 9, passed: 9, failed: 0, incomplete: 0, notApplicable: 0, slices: 2, slicesCovered: 1 });
  assert.match(missingSlice.message, /is incomplete: 1 slice\(s\) have no criterion: P6\.30/);

  const missingKind = assessAcceptance({ subject: SUBJECT(), criteria: CRITERIA({ kinds: CRITERION_KINDS.filter((kind) => kind !== 'rollback') }) });
  assert.equal(missingKind.verdict, 'incomplete');
  assert.equal(missingKind.reason, 'acceptance.kind');
  assert.deepEqual([...missingKind.missingKinds], ['rollback']);
  assert.match(missingKind.findings.join(' '), /1 promised kind\(s\) are not covered by a verdict: rollback/);

  const stale = assessAcceptance({ subject: SUBJECT(), criteria: CRITERIA({ commit: 'deadbeef' }) });
  assert.equal(stale.verdict, 'incomplete');
  assert.equal(stale.reason, 'acceptance.subject');
  assert.equal(stale.stale.length, 9);
  assert.match(stale.message, /9 criterion\(s\) were checked on another commit/);

  const undeclared = assessAcceptance({ subject: SUBJECT(), criteria: [...CRITERIA(), createCriterion({ id: 'extra', kind: 'docs', slice: 'P6.99', commit: COMMIT, verdict: 'incomplete' })] });
  assert.equal(undeclared.verdict, 'incomplete');
  assert.equal(undeclared.reason, 'acceptance.subject');
  assert.deepEqual([...undeclared.unknownSlices], ['P6.99']);
  assert.match(undeclared.message, /criterion\(s\) are about slices this acceptance does not cover: P6\.99/);

  const unintegrated = assessAcceptance({ subject: SUBJECT({ protectedMain: false }), criteria: CRITERIA() });
  assert.equal(unintegrated.verdict, 'incomplete');
  assert.equal(unintegrated.reason, 'acceptance.protected');
  assert.deepEqual([...unintegrated.findings], ['protected-main verification has not been reported']);
  assert.match(unintegrated.message, /is incomplete: protected-main verification has not been reported/);

  const narrowed = assessAcceptance({ subject: SUBJECT(), criteria: CRITERIA({ kinds: ['focused', 'security'] }), policy: { requireAllKinds: false } });
  assert.equal(narrowed.verdict, 'accepted', 'a narrowed kind set is a declared decision rather than a silent omission');
  assert.deepEqual([...narrowed.missingKinds], []);

  const stillMissing = assessAcceptance({ subject: SUBJECT(), criteria: CRITERIA({ kinds: ['focused', 'security'], slices: ['P6.29'] }), policy: { requireAllKinds: false } });
  assert.equal(stillMissing.verdict, 'incomplete', 'narrowing the kinds does not narrow the slices');
});

test('a kind covered only by not-applicable criteria is not covered', () => {
  const criteria = CRITERIA().map((criterion) => (criterion.kind === 'resource'
    ? createCriterion({ id: criterion.id, kind: 'resource', slice: criterion.slice, commit: COMMIT, verdict: 'not-applicable', justification: 'this slice declares no runtime resource surface' })
    : criterion));
  const report = assessAcceptance({ subject: SUBJECT(), criteria });
  assert.equal(report.verdict, 'incomplete');
  assert.equal(report.reason, 'acceptance.kind');
  assert.deepEqual([...report.missingKinds], ['resource']);
  assert.deepEqual([...report.notApplicable], ['resource-5']);
  assert.equal(report.counts.notApplicable, 1);
  assert.match(report.message, /1 promised kind\(s\) are not covered by a verdict: resource/);
});

test('findings are collected rather than short-circuited, and the same inputs give the same report', () => {
  const criteria = [
    ...CRITERIA({ kinds: CRITERION_KINDS.filter((kind) => kind !== 'rollback' && kind !== 'docs'), slices: ['P6.29'] }),
    createCriterion({ id: 'docs-stale', kind: 'docs', slice: 'P6.30', commit: 'deadbeef', verdict: 'incomplete' }),
    createCriterion({ id: 'extra-slice', kind: 'rollback', slice: 'P6.99', commit: COMMIT, verdict: 'incomplete' }),
  ];
  const report = assessAcceptance({ subject: SUBJECT({ protectedMain: false }), criteria });
  assert.equal(report.verdict, 'incomplete');
  assert.deepEqual([...report.missingSlices], ['P6.30']);
  assert.deepEqual([...report.unknownSlices], ['P6.99']);
  assert.deepEqual([...report.stale], ['docs-stale']);
  assert.ok(report.findings.some((finding) => finding.startsWith('protected-main')), 'a milestone that fails four ways says four things');
  assert.equal(report.findings.length >= 5, true);

  const stable = assessAcceptance({ subject: SUBJECT({ protectedMain: false }), criteria });
  assert.equal(report.acceptanceDigest, stable.acceptanceDigest);
  const other = assessAcceptance({ subject: SUBJECT(), criteria });
  assert.notEqual(report.acceptanceDigest, other.acceptanceDigest, 'the report is about a subject: another subject is another report');

  const described = describeAcceptance(other);
  assert.equal(described.format, REGISTRY_ACCEPTANCE_FORMAT);
  assert.equal(described.verdict, 'incomplete');
  assert.equal(described.acceptanceDigest, other.acceptanceDigest);
  assert.match(described.message, /INCOMPLETE: 7\/9 criterion\(s\) passed over 1\/2 slice\(s\) at commit 24032a0c, with 4 finding\(s\)/);

  throwsWith(() => assessAcceptance({}), 'acceptance.input');
  throwsWith(() => assessAcceptance({ subject: SUBJECT(), criteria: [] }), 'acceptance.criterion');
  throwsWith(() => assessAcceptance({ subject: SUBJECT(), criteria: [...CRITERIA(), CRITERIA()[0]] }), 'acceptance.criterion');
  throwsWith(() => assessAcceptance({ subject: SUBJECT(), criteria: [{ id: 'x' }] }), 'acceptance.input');
  throwsWith(() => assessAcceptance({ subject: SUBJECT(), criteria: CRITERIA(), policy: [] }), 'acceptance.input');
  throwsWith(() => assessAcceptance({ subject: SUBJECT(), criteria: CRITERIA(), policy: { requireAllKinds: 'yes' } }), 'acceptance.input');
  throwsWith(() => assessAcceptance({ subject: {}, criteria: CRITERIA() }), 'acceptance.input');
  throwsWith(() => describeAcceptance({}), 'acceptance.input');
  throwsWith(() => explainAcceptance({ verdict: 'accepted' }), 'acceptance.input');
});

/* --------------------------------------------------------------------- walls */

test('acceptance composes the other verdicts as data: it runs nothing and merges nothing', () => {
  const source = readFileSync(new URL('../src/lego/registry-acceptance.mjs', import.meta.url), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const forbidden of ['node:fs', 'node:net', 'node:http', 'node:os', 'node:child_process', 'process.', 'Math.random', 'setTimeout', 'performance.', 'fetch(', 'node:vm', 'eval(', 'createSign', 'subtle']) {
    assert.equal(code.includes(forbidden), false, `the acceptance contract must not reference ${forbidden}`);
  }
  assert.deepEqual([...code.matchAll(/from '(node:[a-z_/]+)'/g)].map((match) => match[1]), ['node:crypto']);
  assert.equal(/\bnew Date\b|\bDate\.now\b/.test(code), false);
  for (const forbidden of ['./node-acceptance.mjs', './registry-repair.mjs', './freshness.mjs', './namespace-confusion.mjs', './node-registry.mjs', './registry-integrity.mjs', './admission-explain.mjs', './artifact-store.mjs']) {
    assert.equal(code.includes(forbidden), false, `P6.31 must not reach into ${forbidden}: the slice runner is P6.15 and the epoch chain is P6.16`);
  }
  for (const name of ['runAcceptance', 'verifyAcceptanceReport', 'planRepair', 'assessRegistry', 'NODE_TRUST_CLASSES', 'checkFreshness', 'evaluateFreshness', 'appendEpoch', 'resolveName']) {
    assert.equal(code.includes(name), false, `${name} belongs to another milestone: acceptance composes verdicts, it does not run them`);
  }
});

/* ------------------------------------------------------------------- lock row */

test('the contract-lock row is canonical: one row, version, ops, tests, exports, domain path', () => {
  const lock = JSON.parse(readFileSync(new URL('../src/lego/contracts/contract-lock.json', import.meta.url)));
  const rows = lock.contracts.filter((contract) => contract.id === 'registry.acceptance');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].version, REGISTRY_ACCEPTANCE_CONTRACT_VERSION);
  assert.equal(rows[0].domain, 'node-registry');
  assert.equal(rows[0].status, 'implemented');
  assert.deepEqual(rows[0].surface, ['src/lego/registry-acceptance.mjs']);
  assert.deepEqual(rows[0].tests, ['apps/n8n-lego/test/lego-registry-acceptance.test.mjs']);
  for (const name of ['createAcceptanceSubject', 'createCriterion', 'assessAcceptance', 'describeAcceptance', 'explainAcceptance']) {
    assert.equal(rows[0].exports['src/lego/registry-acceptance.mjs'].includes(name), true, `${name} must be locked`);
  }
  for (const id of ['node.registry', 'registry.repair', 'node.namespace', 'registry.freshness', 'node.provenance', 'node.abi', 'runtime.wasm-cache', 'node.acceptance']) {
    assert.equal(lock.contracts.find((contract) => contract.id === id).version, '0.1.0', `P6.31 must not re-version ${id}`);
  }
  const contractCount = lock.contracts.length;
  assert.equal(contractCount >= 75, true, `the lock holds the whole lane: ${contractCount} rows`);
  const domain = JSON.parse(readFileSync(new URL('../src/lego/manifest/domains.json', import.meta.url)))
    .domains.find((entry) => entry.id === 'node-registry');
  assert.equal(domain.contract.id, 'node.portability');
  assert.ok(domain.paths.includes('src/lego/registry-acceptance.mjs'));
});
