/**
 * P6.17 — Admission explain plan + dependency blast radius.
 * Contract `node.admission@0.1.0`.
 *
 * Matrix: the question as a value, the ordered argument with citations, the three
 * verdicts with INCOMPLETE failing closed, the plan that does not re-decide (it
 * composes other contracts' verdicts), the blast radius over a reverse index
 * (depth, cycles, truncation, unknown target), the reads, and the scope walls.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { compileRegistryEpoch } from '../src/lego/registry-compiler.mjs';
import {
  ADMISSION_CHECKS,
  ADMISSION_CITATIONS,
  ADMISSION_CONTRACT,
  ADMISSION_CONTRACT_VERSION,
  ADMISSION_INPUT_SCHEMA_VERSION,
  ADMISSION_OPERATIONS,
  ADMISSION_PERMISSIONS,
  ADMISSION_REASONS,
  ADMISSION_RULES,
  ADMISSION_SCHEMA_VERSION,
  ADMISSION_VERDICTS,
  AdmissionError,
  admissionQuestion,
  computeBlastRadius,
  dependentsFrom,
  describeAdmission,
  explainAdmission,
  explainBlastRadius,
  explainPlan,
  isAdmissionPlan,
  isAdmissionQuestion,
  isDependentIndex,
  planAdmission,
} from '../src/lego/admission-explain.mjs';

/* ------------------------------------------------------------------ fixtures */

const declaration = (type, typeVersion, overrides = {}) => ({
  type,
  typeVersion,
  package: type.split('.')[0],
  packageVersion: '1.0.0',
  vendor: 'n8n',
  contractVersion: '0.1.0',
  implementationVersion: '0.1.0',
  digest: `sha256:${'a'.repeat(64)}`,
  provenance: { kind: 'package-registry', source: 'npm:n8n-nodes-base@1.0.0' },
  capabilities: ['network'],
  trustClass: 'core',
  runtimeLocality: 'js-compat',
  resourceProfile: { cpu: 'low', memory: 'medium', disk: 'none', network: true, concurrency: 'parallel-safe', startup: 'fast' },
  compatibility: { contractRange: '^0.1.0', portabilityTargets: ['JS'] },
  lifecycle: 'declared',
  health: 'unknown',
  discovery: { displayName: type, group: 'transform', description: `about ${type}` },
  ...overrides,
});

const SET = declaration('n8n-nodes-base.set', 3.4);
const EPOCH = compileRegistryEpoch({ declarations: [SET], source: 'p6.17-test' });
const question = (overrides = {}) => admissionQuestion({ identity: 'n8n-nodes-base.set@3.4', epoch: EPOCH, ...overrides });

const EVIDENCE = () => ({
  lifecycle: { state: 'declared', tombstone: null },
  supply: { ok: true, primaryReason: null, message: null },
  capability: { ok: true, granted: ['network'], denied: [], locality: 'ISOLATED PROCESS', planDigest: `sha256:${'b'.repeat(64)}` },
  semantics: { verdict: 'MATCH', impact: 'none', changedAxes: [] },
  health: { ok: true, reason: null, probe: false },
  closure: { ok: true, order: ['n8n-nodes-base'], digest: `sha256:${'c'.repeat(64)}` },
  residency: 'hot',
});

const codeOf = (error) => [error.code, error.meta?.code, error.meta?.field].filter(Boolean);
const throwsWith = (fn, codes) => {
  const want = [].concat(codes);
  assert.throws(fn, (error) => {
    assert.ok(
      codeOf(error).some((code) => want.includes(code)),
      `expected ${want.join('|')}, got ${codeOf(error).join('|')}: ${error.message}`,
    );
    return true;
  });
};

/* ---------------------------------------------------------- contract surface */

test('the contract identifies itself and fixes the order of the argument', () => {
  assert.equal(ADMISSION_CONTRACT, 'node.admission@0.1.0');
  assert.equal(ADMISSION_CONTRACT_VERSION, '0.1.0');
  assert.equal(ADMISSION_SCHEMA_VERSION, 1);
  assert.equal(ADMISSION_INPUT_SCHEMA_VERSION, 1);
  assert.deepEqual([...ADMISSION_OPERATIONS], ['ask', 'explain', 'blast', 'describe']);
  assert.deepEqual([...ADMISSION_PERMISSIONS], ['node:read']);
  assert.deepEqual([...ADMISSION_VERDICTS], ['admit', 'refuse', 'incomplete']);
  assert.deepEqual([...ADMISSION_CHECKS], ['identity', 'lifecycle', 'supply', 'capability', 'semantics', 'health', 'closure', 'residency']);
  assert.equal(Object.keys(ADMISSION_CITATIONS).length, ADMISSION_CHECKS.length);
  for (const check of ADMISSION_CHECKS) assert.match(ADMISSION_CITATIONS[check], /^[a-z-]+\.[a-z-]+@0\.1\.0$/);
  for (const reason of ADMISSION_REASONS) assert.match(reason, /^admission\.[a-z_]+$/);
  assert.equal(Object.isFrozen(ADMISSION_RULES), true);
  assert.match(ADMISSION_RULES.citation, /uncited pass is not a pass/);
  assert.match(ADMISSION_RULES.compose, /does not re-decide/);
  assert.match(ADMISSION_RULES.radius, /descriptive, never a permission/);
  assert.match(ADMISSION_RULES.authority, /still decide whether anything runs/);
});

/* ----------------------------------------------------------------- question */

test('a question is a value: identity, epoch and a digest', () => {
  const q = question();
  assert.equal(isAdmissionQuestion(q), true);
  assert.equal(q.identity, 'n8n-nodes-base.set@3.4');
  assert.equal(q.epochNumber, EPOCH.epochNumber);
  assert.equal(q.epochDigest, EPOCH.epochDigest);
  assert.match(q.questionDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(question({ context: { ticket: 'OPS-9' } }).context.ticket, 'OPS-9');
  throwsWith(() => admissionQuestion({ epoch: EPOCH }), 'admission.identity');
  throwsWith(() => admissionQuestion({ identity: 'a.b@1' }), 'admission.input');
  throwsWith(() => admissionQuestion({ identity: 'a.b@1', epoch: EPOCH, context: 'x' }), 'admission.input');
});

/* --------------------------------------------------------------------- plan */

test('the argument is ordered, cited and complete when every check has evidence', () => {
  const plan = planAdmission(question(), EPOCH, { evidence: EVIDENCE() });
  assert.equal(isAdmissionPlan(plan), true);
  assert.equal(plan.ok, true);
  assert.equal(plan.verdict, 'admit');
  assert.equal(plan.steps.length, 8);
  assert.deepEqual(plan.steps.map((step) => step.check), [...ADMISSION_CHECKS]);
  assert.deepEqual(plan.steps.map((step) => step.order), [0, 1, 2, 3, 4, 5, 6, 7]);
  for (const step of plan.steps) {
    assert.equal(step.outcome, 'pass', `${step.check} did not pass: ${step.message}`);
    assert.equal(step.citation.contract, ADMISSION_CITATIONS[step.check], 'every step cites the contract that owns the check');
  }
  assert.equal(plan.steps[3].citation.digest, EVIDENCE().capability.planDigest, 'a pass carries the evidence it passed on');
  assert.match(plan.planDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(plan.message, null);
  assert.match(explainPlan(plan), /an explanation, not a grant/);
});

test('a failed check refuses, and the plan says which contract refused', () => {
  const evidence = { ...EVIDENCE(), supply: { ok: false, primaryReason: 'supply.revoked', message: 'artifact is revoked: malware' } };
  const plan = planAdmission(question(), EPOCH, { evidence });
  assert.equal(plan.verdict, 'refuse');
  assert.equal(plan.ok, false);
  assert.equal(plan.failures.length, 1);
  assert.equal(plan.failures[0].check, 'supply');
  assert.equal(plan.failures[0].citation, 'node.supply-chain@0.1.0');
  assert.match(plan.failures[0].message, /supply\.revoked/);
  assert.match(explainPlan(plan), /refused: supply by node\.supply-chain@0\.1\.0/);

  const tombstoned = planAdmission(question(), EPOCH, { evidence: { ...EVIDENCE(), lifecycle: { state: 'retired', tombstone: { reason: 'vulnerability', atEpoch: 4 } } } });
  assert.equal(tombstoned.verdict, 'refuse');
  assert.match(tombstoned.failures[0].message, /tombstoned \(vulnerability\)/);

  const disabled = planAdmission(question(), EPOCH, { evidence: { ...EVIDENCE(), lifecycle: { state: 'disabled', tombstone: null } } });
  assert.equal(disabled.failures[0].check, 'lifecycle');

  const partial = planAdmission(question(), EPOCH, { evidence: { ...EVIDENCE(), capability: { ok: true, granted: ['network'], denied: ['subprocess'], planDigest: null } } });
  assert.equal(partial.verdict, 'refuse');
  assert.match(partial.failures[0].message, /not all-or-nothing: denied subprocess/);
});

test('missing evidence makes the plan INCOMPLETE, which fails closed', () => {
  const plan = planAdmission(question(), EPOCH, { evidence: EVIDENCE() });
  const withoutHealth = planAdmission(question(), EPOCH, {
    evidence: { ...EVIDENCE(), health: undefined },
  });
  assert.equal(withoutHealth.verdict, 'incomplete');
  assert.equal(withoutHealth.ok, false);
  assert.deepEqual([...withoutHealth.unknowns], ['health']);
  assert.equal(withoutHealth.failures.length, 0);
  assert.match(withoutHealth.message, /worse than no plan at all/);
  assert.match(explainPlan(withoutHealth), /INCOMPLETE/);

  const nothingChecked = planAdmission(question(), EPOCH, {});
  assert.equal(nothingChecked.verdict, 'incomplete');
  assert.deepEqual([...nothingChecked.unknowns], ['lifecycle', 'supply', 'capability', 'semantics', 'health', 'closure', 'residency']);
  assert.equal(nothingChecked.steps.filter((step) => step.outcome === 'unknown').length, 7);
  assert.equal(plan.verdict, 'admit', 'the control: the same question with evidence admits');

  const noBaseline = planAdmission(question(), EPOCH, { evidence: { ...EVIDENCE(), semantics: { verdict: 'MISSING', impact: null } } });
  assert.equal(noBaseline.verdict, 'incomplete', 'a node with no semantics baseline is not admitted on semantics');
  assert.deepEqual([...noBaseline.unknowns], ['semantics']);

  const nondeterministic = planAdmission(question(), EPOCH, { evidence: { ...EVIDENCE(), semantics: { verdict: 'NON_DETERMINISTIC', impact: null } } });
  assert.equal(nondeterministic.verdict, 'incomplete');
});

test('a behaviour change refuses; a cosmetic one does not', () => {
  const breaking = planAdmission(question(), EPOCH, {
    evidence: { ...EVIDENCE(), semantics: { verdict: 'DIFF', impact: 'breaking', changedAxes: ['parameters', 'outputs'] } },
  });
  assert.equal(breaking.verdict, 'refuse');
  assert.match(breaking.failures[0].message, /axes: parameters, outputs/);
  const behavioral = planAdmission(question(), EPOCH, { evidence: { ...EVIDENCE(), semantics: { verdict: 'DIFF', impact: 'behavioral' } } });
  assert.equal(behavioral.verdict, 'refuse');
  const cosmetic = planAdmission(question(), EPOCH, { evidence: { ...EVIDENCE(), semantics: { verdict: 'DIFF', impact: 'cosmetic' } } });
  assert.equal(cosmetic.verdict, 'admit');
  assert.match(cosmetic.steps.find((step) => step.check === 'semantics').message, /impact 'cosmetic'/);
});

test('the identity check is run against the real epoch, and unknown identities fail closed', () => {
  const unknown = planAdmission(admissionQuestion({ identity: 'n8n-nodes-base.slack@2.1', epoch: EPOCH }), EPOCH, { evidence: EVIDENCE() });
  assert.equal(unknown.verdict, 'refuse');
  assert.equal(unknown.failures[0].check, 'identity');
  assert.match(unknown.failures[0].message, /is not in epoch 1/);

  const other = compileRegistryEpoch({ declarations: [SET], epochNumber: 2, source: 'p6.17-other' });
  throwsWith(() => planAdmission(question(), other, { evidence: EVIDENCE() }), 'admission.input');
  throwsWith(() => planAdmission(question(), null, { evidence: EVIDENCE() }), 'admission.input');
  throwsWith(() => explainAdmission({}, { evidence: EVIDENCE() }), 'lego.contract_violation');
  throwsWith(() => explainAdmission(question(), { evidence: 'all of it' }), 'admission.evidence');
  throwsWith(() => explainPlan({ verdict: 'admit' }), 'lego.contract_violation');
});

test('the plan composes other contracts rather than re-deciding their answers', () => {
  // The health verdict comes from P6.11's mayServe: this contract copies the
  // reason verbatim instead of inventing its own.
  const refused = planAdmission(question(), EPOCH, {
    evidence: { ...EVIDENCE(), health: { ok: false, reason: 'health.quarantined', message: 'quarantined by operator: malware' } },
  });
  assert.equal(refused.verdict, 'refuse');
  assert.match(refused.failures[0].message, /^health\.quarantined: quarantined by operator: malware$/);
  const probing = planAdmission(question(), EPOCH, { evidence: { ...EVIDENCE(), health: { ok: true, reason: null, probe: true } } });
  assert.match(probing.steps.find((step) => step.check === 'health').message, /allows a probe/);
  const brokenClosure = planAdmission(question(), EPOCH, { evidence: { ...EVIDENCE(), closure: { ok: false, reason: 'closure.missing' } } });
  assert.equal(brokenClosure.verdict, 'refuse');
  assert.match(brokenClosure.failures[0].message, /closure\.missing/);
});

/* ------------------------------------------------------------ blast radius */

test('a reverse index is built from edges, and a self-dependency is refused', () => {
  const index = dependentsFrom([
    { from: 'b', to: 'a' },
    { from: 'c', to: 'a' },
    { from: 'c', to: 'b' },
    { from: 'c', to: 'b' },
  ]);
  assert.equal(isDependentIndex(index), true);
  assert.deepEqual([...index.dependents.a], ['b', 'c']);
  assert.deepEqual([...index.dependents.b], ['c'], 'duplicate edges collapse');
  assert.equal(index.edgeCount, 4);
  assert.equal(Object.isFrozen(index.dependents.a), true);
  throwsWith(() => dependentsFrom('nope'), 'admission.input');
  throwsWith(() => dependentsFrom([{ from: 'a' }]), 'admission.input');
  throwsWith(() => dependentsFrom([{ from: 'a', to: 'a' }]), 'admission.input');
});

test('the blast radius walks the reverse index, once, with its depth', () => {
  const index = dependentsFrom([
    { from: 'mid', to: 'leaf' },
    { from: 'top', to: 'mid' },
    { from: 'side', to: 'leaf' },
    { from: 'top', to: 'side' },
  ], { packages: ['top', 'mid', 'side', 'leaf'] });
  const radius = computeBlastRadius({ target: 'leaf', dependents: index });
  assert.equal(radius.ok, true);
  assert.equal(radius.count, 3);
  assert.equal(radius.deepest, 2);
  assert.deepEqual(radius.affected.map((entry) => entry.name), ['mid', 'side', 'top'], 'sorted by depth then name');
  assert.deepEqual(radius.affected.map((entry) => entry.depth), [1, 1, 2]);
  assert.equal(radius.byDepth['1'], 2);
  assert.equal(radius.byDepth['2'], 1);
  assert.equal(radius.truncated, false);
  assert.match(radius.radiusDigest, /^sha256:[0-9a-f]{64}$/);
  assert.match(explainBlastRadius(radius), /affects 3 package\(s\) to depth 2/);

  const none = computeBlastRadius({ target: 'top', dependents: index });
  assert.equal(none.ok, true, 'a package the index knows about with no dependents is a real answer, not an unknown one');
  assert.equal(none.count, 0);
  assert.equal(none.deepest, 0);
  assert.match(explainBlastRadius(none), /no dependents in this index/);
  // Without the package universe, an absent key means "not in the registry" and
  // fails closed even though the answer would have looked harmless.
  const blind = computeBlastRadius({ target: 'top', dependents: dependentsFrom([{ from: 'mid', to: 'leaf' }]) });
  assert.equal(blind.ok, false);
  assert.equal(blind.reason, 'admission.target');
});

test('a cycle is walked once, a depth ceiling is declared, and an unknown target fails closed', () => {
  const cyclic = dependentsFrom([
    { from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'c', to: 'a' },
  ]);
  const radius = computeBlastRadius({ target: 'a', dependents: cyclic });
  assert.equal(radius.ok, true);
  assert.deepEqual(radius.affected.map((entry) => entry.name), ['c', 'b'], 'each package appears once, at its first depth');
  assert.equal(radius.count, 2);

  const deep = dependentsFrom([
    { from: 'd1', to: 'root' }, { from: 'd2', to: 'd1' }, { from: 'd3', to: 'd2' },
  ]);
  const shallow = computeBlastRadius({ target: 'root', dependents: deep, maxDepth: 1 });
  assert.equal(shallow.count, 1);
  assert.equal(shallow.truncated, true, 'a report that stopped at the ceiling says so');
  assert.match(explainBlastRadius(shallow), /TRUNCATED/);
  const limited = computeBlastRadius({ target: 'root', dependents: deep, limit: 1 });
  assert.equal(limited.count, 1);
  assert.equal(limited.truncated, true);

  const unknown = computeBlastRadius({ target: 'ghost', dependents: deep });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.reason, 'admission.target');
  assert.match(unknown.message, /unknown fails closed/);
  assert.match(explainBlastRadius(unknown), /is UNKNOWN/);

  throwsWith(() => computeBlastRadius({ dependents: deep }), 'admission.target');
  const emptyMap = computeBlastRadius({ target: 'root', dependents: {} });
  assert.equal(emptyMap.ok, false);
  assert.equal(emptyMap.reason, 'admission.target', 'an empty index knows nothing, and knowing nothing is not the same as knowing there are no dependents');
  throwsWith(() => computeBlastRadius({ target: 'a', dependents: cyclic, maxDepth: 0 }), 'admission.input');
  throwsWith(() => computeBlastRadius({ target: 'a', dependents: cyclic, limit: 0 }), 'admission.input');
});

/* ------------------------------------------------------------ reads, walls */

test('describing an admission puts the argument and the consequence side by side', () => {
  const plan = planAdmission(question(), EPOCH, { evidence: EVIDENCE() });
  const radius = computeBlastRadius({ target: 'n8n-nodes-base', dependents: dependentsFrom([{ from: 'n8n-nodes-base.set', to: 'n8n-nodes-base' }]) });
  const described = describeAdmission({ plan, radius });
  assert.equal(described.plan.verdict, 'admit');
  assert.equal(described.plan.passed.length, 8);
  assert.deepEqual([...described.plan.failed], []);
  assert.equal(described.radius.count, 1);
  assert.equal(Object.isFrozen(described), true);
  assert.deepEqual({ ...describeAdmission({}) }, {});
  const refused = planAdmission(question(), EPOCH, { evidence: {} });
  assert.deepEqual([...describeAdmission({ plan: refused }).plan.unknown], ['lifecycle', 'supply', 'capability', 'semantics', 'health', 'closure', 'residency']);
  throwsWith(() => describeAdmission({ plan: { verdict: 'admit' } }), 'admission.plan');
  throwsWith(() => describeAdmission({ radius: 7 }), 'admission.radius');
  const error = new AdmissionError('x');
  assert.equal(error instanceof Error, true);
  assert.equal(error.code, 'lego.contract_violation');
  assert.equal(Object.isFrozen(error.meta), true);
});

test('P6.17 is pure: the only node import is the hash, and it decides nothing itself', () => {
  const source = readFileSync(new URL('../src/lego/admission-explain.mjs', import.meta.url), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const forbidden of ['node:fs', 'node:net', 'node:http', 'node:os', 'node:child_process', 'process.', 'Math.random', 'setTimeout', 'performance.', 'fetch(', 'node:vm', 'eval(']) {
    assert.equal(code.includes(forbidden), false, `the admission plan must not reference ${forbidden}`);
  }
  assert.deepEqual([...code.matchAll(/from '(node:[a-z_/]+)'/g)].map((match) => match[1]), ['node:crypto']);
  assert.equal(/\bnew Date\b|\bDate\.now\b/.test(code), false);
  for (const forbidden of ['./node-health.mjs', './capability-compiler.mjs', './node-lifecycle.mjs', './supply-chain.mjs', './semantic-fingerprint.mjs', './dependency-closure.mjs', './node-residency.mjs', './package-transaction.mjs', './runtime-lease.mjs']) {
    assert.equal(code.includes(forbidden), false, `P6.17 composes verdicts as DATA; importing ${forbidden} would be re-deciding`);
  }
  assert.ok(code.includes("from './registry-compiler.mjs'"), 'only the epoch guard is reused');
});

/* ------------------------------------------------------------------- lock row */

test('the contract-lock row is canonical: one row, version, ops, tests, exports, domain path', () => {
  const lock = JSON.parse(readFileSync(new URL('../src/lego/contracts/contract-lock.json', import.meta.url)));
  const rows = lock.contracts.filter((contract) => contract.id === 'node.admission');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].version, ADMISSION_CONTRACT_VERSION);
  assert.equal(rows[0].domain, 'node-registry');
  assert.equal(rows[0].status, 'implemented');
  assert.deepEqual(rows[0].surface, ['src/lego/admission-explain.mjs']);
  assert.deepEqual(rows[0].tests, ['apps/n8n-lego/test/lego-admission-explain.test.mjs']);
  for (const name of ['admissionQuestion', 'explainAdmission', 'planAdmission', 'computeBlastRadius', 'dependentsFrom']) {
    assert.equal(rows[0].exports['src/lego/admission-explain.mjs'].includes(name), true, `${name} must be locked`);
  }
  for (const id of ['node.registry', 'registry.compiler', 'package.transaction', 'registry.closure', 'node.resolution', 'runtime.lease', 'node.residency', 'node.capability', 'node.semantics', 'node.lifecycle', 'node.health', 'node.supply-chain', 'registry.incremental', 'node.worker-convergence', 'node.acceptance', 'registry.integrity']) {
    assert.equal(lock.contracts.find((contract) => contract.id === id).version, '0.1.0', `P6.17 must not re-version ${id}`);
  }
  const domain = JSON.parse(readFileSync(new URL('../src/lego/manifest/domains.json', import.meta.url)))
    .domains.find((entry) => entry.id === 'node-registry');
  assert.equal(domain.contract.id, 'node.portability');
  assert.ok(domain.paths.includes('src/lego/admission-explain.mjs'));
});
