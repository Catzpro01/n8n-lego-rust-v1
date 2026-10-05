/**
 * P6.18 — SBOM / VEX + policy diff gate.
 * Contract `node.sbom@0.1.0`.
 *
 * Matrix: the document as a READING of an epoch (one record per package version,
 * checksums, capabilities, declared licence, supplied dependencies), the diff that
 * names changed fields, the trust ladder quoted from P6.1, VEX as attributed
 * statements where silence is `under_investigation`, the gate where a rule with no
 * evidence yields INCOMPLETE and incomplete fails closed, the reads, and the walls.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { NODE_TRUST_CLASSES } from '../src/lego/node-registry.mjs';
import { compileRegistryEpoch } from '../src/lego/registry-compiler.mjs';
import {
  DIFF_KINDS,
  GATE_RULE_KINDS,
  GATE_VERDICTS,
  SBOM_CONTRACT,
  SBOM_CONTRACT_VERSION,
  SBOM_FORMAT,
  SBOM_INPUT_SCHEMA_VERSION,
  SBOM_OPERATIONS,
  SBOM_PERMISSIONS,
  SBOM_REASONS,
  SBOM_RELATIONSHIPS,
  SBOM_RULES,
  SBOM_SCHEMA_VERSION,
  SbomError,
  TRUST_ORDER,
  VEX_JUSTIFICATIONS,
  VEX_STATUSES,
  applyVex,
  createPolicyGate,
  createSbom,
  createVex,
  describeSbom,
  diffSbom,
  evaluateGate,
  explainDiff,
  explainGate,
  isGateResult,
  isPolicyGate,
  isSbom,
  isSbomDiff,
  isVex,
  sbomPackageOf,
  summarizeVex,
  trustRankOf,
  vexStatement,
} from '../src/lego/sbom-policy.mjs';

/* ------------------------------------------------------------------ fixtures */

const declaration = (type, typeVersion, overrides = {}) => ({
  type,
  typeVersion,
  package: 'n8n-nodes-base',
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
const IF = declaration('n8n-nodes-base.if', 2.2);
const SLACK = declaration('n8n-nodes-slack.slack', 2.1, { package: 'n8n-nodes-slack', trustClass: 'community' });

const EPOCH_BEFORE = compileRegistryEpoch({ declarations: [SET, IF], source: 'p6.18-before' });
const EPOCH_AFTER = compileRegistryEpoch({
  declarations: [
    declaration('n8n-nodes-base.set', 3.4, { capabilities: ['network', 'secrets'], trustClass: 'community' }),
    IF,
    SLACK,
  ],
  epochNumber: 2, source: 'p6.18-after',
});
/** A change to the same package version that touches only the licence field. */
const EPOCH_LICENCE_ONLY = compileRegistryEpoch({
  declarations: [SET, IF], epochNumber: 3, source: 'p6.18-licence',
});

const BEFORE = () => createSbom(EPOCH_BEFORE, { licenses: { 'n8n-nodes-base': 'MIT' } });
const AFTER = () => createSbom(EPOCH_AFTER, {
  licenses: { 'n8n-nodes-base': 'MIT', 'n8n-nodes-slack': 'Apache-2.0' },
  dependencies: { 'n8n-nodes-slack@1.0.0': ['n8n-nodes-base@1.0.0'] },
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

test('the contract identifies itself and quotes P6.1\'s trust vocabulary', () => {
  assert.equal(SBOM_CONTRACT, 'node.sbom@0.1.0');
  assert.equal(SBOM_CONTRACT_VERSION, '0.1.0');
  assert.equal(SBOM_SCHEMA_VERSION, 1);
  assert.equal(SBOM_INPUT_SCHEMA_VERSION, 1);
  assert.equal(SBOM_FORMAT, 'lego-sbom@1', 'the format is named honestly rather than claiming a conformance');
  assert.deepEqual([...SBOM_OPERATIONS], ['build', 'diff', 'gate', 'vex', 'describe']);
  assert.deepEqual([...SBOM_PERMISSIONS], ['node:read']);
  assert.deepEqual([...SBOM_RELATIONSHIPS], ['DEPENDS_ON']);
  assert.deepEqual([...DIFF_KINDS], ['added', 'removed', 'changed', 'unchanged']);
  assert.deepEqual([...GATE_VERDICTS], ['allow', 'deny', 'incomplete']);
  assert.equal(GATE_RULE_KINDS.length, 6);
  assert.deepEqual([...VEX_STATUSES], ['not_affected', 'affected', 'fixed', 'under_investigation']);
  assert.equal(VEX_JUSTIFICATIONS.length, 6);
  assert.deepEqual([...TRUST_ORDER].sort(), [...NODE_TRUST_CLASSES].sort(), 'the ladder is exactly P6.1\'s four classes');
  assert.equal(trustRankOf('untrusted'), 0);
  assert.equal(trustRankOf('core'), 3);
  throwsWith(() => trustRankOf('mostly-fine'), 'sbom.package');
  for (const reason of SBOM_REASONS) assert.match(reason, /^sbom\.[a-z_]+$/);
  assert.equal(Object.isFrozen(SBOM_RULES), true);
  assert.match(SBOM_RULES.reading, /never a second source of truth/);
  assert.match(SBOM_RULES.gate, /could not look is not a gate/);
  assert.match(SBOM_RULES.authority, /never a claim that the result is safe/);
});

/* ----------------------------------------------------------------- document */

test('an SBOM is a reading of an epoch: one record per package version', () => {
  const sbom = BEFORE();
  assert.equal(isSbom(sbom), true);
  assert.equal(sbom.format, SBOM_FORMAT);
  assert.equal(sbom.packageCount, 1, 'two nodes, one package version');
  assert.equal(sbom.identityCount, 2);
  assert.equal(sbom.registryEpochNumber, EPOCH_BEFORE.epochNumber);
  assert.equal(sbom.registryEpochDigest, EPOCH_BEFORE.epochDigest);
  const pkg = sbomPackageOf(sbom, 'n8n-nodes-base@1.0.0');
  assert.equal(pkg.license, 'MIT', 'a licence declared by the caller is carried');
  assert.deepEqual([...pkg.identities], ['n8n-nodes-base.if@2.2', 'n8n-nodes-base.set@3.4']);
  assert.deepEqual([...pkg.trustClasses], ['core']);
  assert.deepEqual([...pkg.capabilities], ['network']);
  assert.equal(pkg.checksums.length, 1, 'both nodes share one declaration digest, so the checksum list collapses');
  assert.match(pkg.spdxId, /^SPDXRef-Package-n8n-nodes-base-1\.0\.0$/);
  assert.equal(sbom.dependenciesDeclared, false);
  assert.deepEqual([...sbom.relationships], []);
  assert.match(sbom.sbomDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(Object.isFrozen(sbom.packages), true);
});

test('a licence nobody declared is NOASSERTION, and dependencies are supplied rather than invented', () => {
  const silent = createSbom(EPOCH_BEFORE);
  assert.equal(sbomPackageOf(silent, 'n8n-nodes-base@1.0.0').license, 'NOASSERTION');
  const after = AFTER();
  assert.equal(after.dependenciesDeclared, true);
  assert.deepEqual([...sbomPackageOf(after, 'n8n-nodes-slack@1.0.0').dependencies], ['n8n-nodes-base@1.0.0']);
  assert.equal(after.relationships.length, 1);
  assert.deepEqual({ ...after.relationships[0] }, { kind: 'DEPENDS_ON', from: 'SPDXRef-Package-n8n-nodes-slack-1.0.0', to: 'n8n-nodes-base@1.0.0' });
  assert.equal(after.packageCount, 2);

  throwsWith(() => createSbom({ epochNumber: 1 }), 'sbom.epoch');
  throwsWith(() => createSbom(EPOCH_BEFORE, { licenses: 'MIT' }), 'sbom.input');
  throwsWith(() => createSbom(EPOCH_BEFORE, { dependencies: { x: 'y' } }), 'sbom.input');
  throwsWith(() => createSbom(EPOCH_BEFORE, { tickets: 'OPS-1' }), 'sbom.input');
  // One package, two trust classes: P6.1 declares trust per declaration, and the
  // document records the SET rather than refusing to read a valid epoch. The
  // weakest member is what comparisons use.
  const twoTrustClasses = compileRegistryEpoch({
    declarations: [SET, declaration('n8n-nodes-base.set', 3.5, { trustClass: 'untrusted' })],
    source: 'p6.18-two-trust',
  });
  const mixed = createSbom(twoTrustClasses);
  assert.deepEqual([...sbomPackageOf(mixed, 'n8n-nodes-base@1.0.0').trustClasses], ['core', 'untrusted']);
  // An unknown trust class never reaches this contract: P6.1 refuses it at compile
  // time, which is the right place. The ladder guard still exists for callers that
  // hand a class in directly (asserted in the contract-surface test).
});

/* --------------------------------------------------------------------- diff */

test('the diff names the fields that changed, and says nothing else changed', () => {
  const diff = diffSbom(BEFORE(), AFTER());
  assert.equal(isSbomDiff(diff), true);
  assert.deepEqual([...diff.added], ['n8n-nodes-slack@1.0.0']);
  assert.deepEqual([...diff.removed], []);
  assert.equal(diff.changed.length, 1);
  const [entry] = diff.changed;
  assert.equal(entry.key, 'n8n-nodes-base@1.0.0');
  assert.deepEqual([...entry.fields].sort(), ['capabilities', 'trustClasses']);
  assert.equal(entry.trustDirection, 'downgraded');
  assert.deepEqual([...entry.capabilityDelta.added], ['secrets']);
  assert.deepEqual([...entry.capabilityDelta.removed], []);
  assert.deepEqual([...entry.before.trustClasses], ['core']);
  assert.deepEqual([...entry.after.trustClasses], ['community', 'core']);
  assert.equal(diff.changeCount, 2);
  assert.match(diff.diffDigest, /^sha256:[0-9a-f]{64}$/);
  assert.match(explainDiff(diff), /1 added \(n8n-nodes-slack@1\.0\.0\)/);
  assert.match(explainDiff(diff), /n8n-nodes-base@1\.0\.0: trustClasses\+capabilities/, 'the changed fields are named in the order the document defines them');

  const identical = diffSbom(BEFORE(), createSbom(EPOCH_BEFORE, { licenses: { 'n8n-nodes-base': 'MIT' } }));
  assert.equal(identical.changeCount, 0);
  assert.equal(identical.unchanged.length, 1);
  assert.equal(identical.beforeDigest, identical.afterDigest);
  assert.match(explainDiff(identical), /nothing changed/);

  const licenceOnly = diffSbom(BEFORE(), createSbom(EPOCH_LICENCE_ONLY, { licenses: { 'n8n-nodes-base': 'Apache-2.0' } }));
  assert.deepEqual([...licenceOnly.changed[0].fields], ['license']);
  assert.equal(licenceOnly.changed[0].trustDirection, null);
  assert.equal(licenceOnly.changed[0].capabilityDelta, null);

  throwsWith(() => diffSbom(BEFORE(), {}), 'lego.contract_violation');
  throwsWith(() => sbomPackageOf(BEFORE(), ''), 'sbom.input');
  assert.equal(sbomPackageOf(BEFORE(), 'ghost@9.9.9'), null);
  throwsWith(() => explainDiff({ added: [] }), 'lego.contract_violation');
});

/* ---------------------------------------------------------------------- VEX */

test('VEX is an attributed statement; silence is under_investigation, not a pass', () => {
  const statement = vexStatement({
    packageKey: 'n8n-nodes-base@1.0.0', vulnerability: 'CVE-2026-0001', status: 'not_affected',
    justification: 'vulnerable_code_not_present', assertedBy: 'security@example', tick: 12,
  });
  assert.equal(statement.ok, true);
  assert.match(statement.statementDigest, /^sha256:[0-9a-f]{64}$/);
  throwsWith(() => vexStatement({ packageKey: 'p', vulnerability: 'CVE-1', status: 'fine', assertedBy: 'a', tick: 1 }), 'sbom.vex');
  throwsWith(() => vexStatement({ packageKey: 'p', vulnerability: 'CVE-1', status: 'fixed', justification: 'vibes', assertedBy: 'a', tick: 1 }), 'sbom.vex');
  throwsWith(() => vexStatement({ packageKey: 'p', vulnerability: 'CVE-1', status: 'fixed', tick: 1 }), 'sbom.vex');
  throwsWith(() => vexStatement({ packageKey: 'p', vulnerability: 'CVE-1', status: 'fixed', assertedBy: 'a' }), 'sbom.vex');
  throwsWith(() => vexStatement({ packageKey: 'p', vulnerability: 'CVE-1', status: 'not_affected', assertedBy: 'a', tick: 1 }), 'sbom.vex');

  const vex = createVex([
    statement,
    vexStatement({ packageKey: 'n8n-nodes-base@1.0.0', vulnerability: 'CVE-2026-0002', status: 'fixed', justification: 'fixed_in_this_version', assertedBy: 'security@example', tick: 13 }),
  ]);
  assert.equal(isVex(vex), true);
  assert.equal(vex.count, 2);
  assert.deepEqual(vex.statements.map((entry) => entry.vulnerability), ['CVE-2026-0001', 'CVE-2026-0002']);
  const summary = summarizeVex(vex);
  assert.deepEqual({ ...summary.byStatus }, { not_affected: 1, fixed: 1 });
  assert.deepEqual([...summary.assertedBy], ['security@example']);

  const annotated = applyVex(AFTER(), vex);
  assert.equal(
    annotated.packages.find((pkg) => pkg.key === 'n8n-nodes-base@1.0.0').vulnerabilityStatus, 'fixed',
    'the rollup is the status that most needs attention: a package with a not_affected AND a fixed vulnerability is reported as fixed',
  );
  assert.equal(annotated.packages.find((pkg) => pkg.key === 'n8n-nodes-slack@1.0.0').vulnerabilityStatus, 'under_investigation', 'nobody spoke about slack, and silence is not a pass');
  const onlyNotAffected = applyVex(BEFORE(), createVex([statement]));
  assert.equal(onlyNotAffected.packages[0].vulnerabilityStatus, 'not_affected');
  assert.equal(onlyNotAffected.packages[0].statements.length, 1, 'the statements travel with the package, so a reader sees the evidence and not just the rollup');
  assert.equal(annotated.annulledDigest, AFTER().sbomDigest, 'annotating does not rewrite the document it annotated');

  throwsWith(() => createVex([statement, vexStatement({
    packageKey: 'n8n-nodes-base@1.0.0', vulnerability: 'CVE-2026-0001', status: 'affected', assertedBy: 'other@example', tick: 20,
  })]), 'sbom.vex');
  throwsWith(() => createVex([{ ok: true }]), 'sbom.vex');
  throwsWith(() => createVex('nope'), 'sbom.input');
  throwsWith(() => summarizeVex({ statements: [] }), 'sbom.vex');
});

/* --------------------------------------------------------------------- gate */

test('the gate is policy as data, and it refuses to be authored carelessly', () => {
  const policy = createPolicyGate({
    policyId: 'registry-default',
    rules: [
      { id: 'R1', kind: 'no-removals' },
      { id: 'R2', kind: 'no-trust-downgrade' },
      { id: 'R3', kind: 'no-new-capabilities' },
      { id: 'R4', kind: 'max-added-packages', limit: 3 },
    ],
  });
  assert.equal(isPolicyGate(policy), true);
  assert.equal(policy.ruleCount, 4);
  assert.equal(Object.isFrozen(policy.rules), true);
  throwsWith(() => createPolicyGate({ rules: [{ id: 'R', kind: 'no-removals' }] }), 'sbom.rule');
  throwsWith(() => createPolicyGate({ policyId: 'p', rules: [] }), 'sbom.rule');
  throwsWith(() => createPolicyGate({ policyId: 'p', rules: [{ kind: 'no-removals' }] }), 'sbom.rule');
  throwsWith(() => createPolicyGate({ policyId: 'p', rules: [{ id: 'R', kind: 'no-vibes' }] }), 'sbom.rule');
  throwsWith(() => createPolicyGate({ policyId: 'p', rules: [{ id: 'R', kind: 'max-added-packages' }] }), 'sbom.rule');
  throwsWith(() => createPolicyGate({ policyId: 'p', rules: [{ id: 'R', kind: 'no-removals' }, { id: 'R', kind: 'no-removals' }] }), 'sbom.rule');
});

test('the gate evaluates each rule against the diff and denies or falls incomplete', () => {
  const diff = diffSbom(BEFORE(), AFTER());
  const strict = createPolicyGate({
    policyId: 'strict',
    rules: [
      { id: 'R1', kind: 'no-new-packages' },
      { id: 'R2', kind: 'no-trust-downgrade' },
      { id: 'R3', kind: 'no-new-capabilities' },
    ],
  });
  const denied = evaluateGate({ diff, policy: strict });
  assert.equal(isGateResult(denied), true);
  assert.equal(denied.verdict, 'deny');
  assert.equal(denied.ok, false);
  assert.deepEqual([...denied.failed], ['R1', 'R2', 'R3']);
  assert.equal(denied.decisions.every((decision) => decision.outcome === 'fail'), true);
  assert.match(explainGate(denied), /DENIES this diff/);
  assert.match(denied.decisions[1].evidence, /core → community/);
  assert.match(denied.decisions[2].evidence, /gains secrets/);

  const permissive = createPolicyGate({
    policyId: 'permissive',
    rules: [
      { id: 'R4', kind: 'max-added-packages', limit: 3 },
      { id: 'R5', kind: 'no-removals' },
    ],
  });
  const allowed = evaluateGate({ diff, policy: permissive });
  assert.equal(allowed.verdict, 'allow');
  assert.equal(allowed.ok, true);
  assert.equal(allowed.message, null);
  assert.equal(allowed.decisions.filter((decision) => decision.outcome === 'pass').length, 2);
  assert.match(explainGate(allowed), /allows this diff/);

  const ceiling = evaluateGate({ diff, policy: createPolicyGate({ policyId: 'tight', rules: [{ id: 'R6', kind: 'max-added-packages', limit: 0 }] }) });
  assert.equal(ceiling.verdict, 'deny');
  assert.match(ceiling.decisions[0].evidence, /past the ceiling of 0/);
});

test('a rule with no evidence makes the gate INCOMPLETE, which fails closed', () => {
  const diff = diffSbom(BEFORE(), AFTER());
  const policy = createPolicyGate({ policyId: 'vuln-aware', rules: [{ id: 'R7', kind: 'no-affected-vulnerability' }] });
  const blind = evaluateGate({ diff, policy });
  assert.equal(blind.verdict, 'incomplete');
  assert.equal(blind.ok, false);
  assert.deepEqual([...blind.incomplete], ['R7']);
  assert.match(blind.message, /could not look is not a gate/);
  assert.match(explainGate(blind), /is INCOMPLETE/);

  const vex = createVex([vexStatement({
    packageKey: 'n8n-nodes-base@1.0.0', vulnerability: 'CVE-2026-0003', status: 'fixed',
    justification: 'fixed_in_this_version', assertedBy: 'security@example', tick: 12,
  })]);
  const happy = evaluateGate({ diff, policy, vex });
  assert.equal(happy.verdict, 'allow');

  const affected = createVex([vexStatement({
    packageKey: 'n8n-nodes-slack@1.0.0', vulnerability: 'CVE-2026-0004', status: 'affected', assertedBy: 'security@example', tick: 12,
  })]);
  const refused = evaluateGate({ diff, policy, vex: affected });
  assert.equal(refused.verdict, 'deny');
  assert.match(refused.decisions[0].evidence, /CVE-2026-0004, affected/);

  throwsWith(() => evaluateGate({ diff: {}, policy }), 'sbom.diff');
  throwsWith(() => evaluateGate({ diff, policy: {} }), 'sbom.rule');
  throwsWith(() => evaluateGate({ diff, policy, vex: { statements: [] } }), 'sbom.vex');
  throwsWith(() => explainGate({ verdict: 'allow' }), 'lego.contract_violation');
});

/* ------------------------------------------------------------ reads, walls */

test('describing a document gives the counts a review opens with', () => {
  const described = describeSbom(AFTER());
  assert.equal(described.format, SBOM_FORMAT);
  assert.equal(described.packageCount, 2);
  assert.equal(described.identityCount, 3);
  assert.deepEqual([...described.trustClasses], ['community', 'core']);
  assert.deepEqual([...described.capabilities], ['network', 'secrets']);
  assert.deepEqual([...described.packages], ['n8n-nodes-base@1.0.0 (community,core)', 'n8n-nodes-slack@1.0.0 (community)']);
  assert.equal(Object.isFrozen(described), true);
  throwsWith(() => describeSbom({ packages: [] }), 'lego.contract_violation');
  const error = new SbomError('x');
  assert.equal(error.code, 'lego.contract_violation');
  assert.equal(Object.isFrozen(error.meta), true);
});

test('P6.18 is pure: the only node import is the hash, and it scans nothing', () => {
  const source = readFileSync(new URL('../src/lego/sbom-policy.mjs', import.meta.url), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const forbidden of ['node:fs', 'node:net', 'node:http', 'node:os', 'node:child_process', 'process.', 'Math.random', 'setTimeout', 'performance.', 'fetch(', 'node:vm', 'eval(']) {
    assert.equal(code.includes(forbidden), false, `the SBOM contract must not reference ${forbidden}`);
  }
  assert.deepEqual([...code.matchAll(/from '(node:[a-z_/]+)'/g)].map((match) => match[1]), ['node:crypto']);
  assert.equal(/\bnew Date\b|\bDate\.now\b/.test(code), false);
  for (const forbidden of ['./node-health.mjs', './runtime-lease.mjs', './package-transaction.mjs', './admission-explain.mjs', './node-lifecycle.mjs', './supply-chain.mjs']) {
    assert.equal(code.includes(forbidden), false, `P6.18 must not reach into ${forbidden}: the gate answers one question and stops`);
  }
  assert.ok(code.includes("from './node-registry.mjs'"), 'the trust vocabulary is P6.1\'s, quoted');
  assert.ok(code.includes("from './registry-compiler.mjs'"), 'the epoch guard is P6.2\'s, reused');
});

/* ------------------------------------------------------------------- lock row */

test('the contract-lock row is canonical: one row, version, ops, tests, exports, domain path', () => {
  const lock = JSON.parse(readFileSync(new URL('../src/lego/contracts/contract-lock.json', import.meta.url)));
  const rows = lock.contracts.filter((contract) => contract.id === 'node.sbom');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].version, SBOM_CONTRACT_VERSION);
  assert.equal(rows[0].domain, 'node-registry');
  assert.equal(rows[0].status, 'implemented');
  assert.deepEqual(rows[0].surface, ['src/lego/sbom-policy.mjs']);
  assert.deepEqual(rows[0].tests, ['apps/n8n-lego/test/lego-sbom-policy.test.mjs']);
  for (const name of ['createSbom', 'diffSbom', 'createVex', 'applyVex', 'createPolicyGate', 'evaluateGate']) {
    assert.equal(rows[0].exports['src/lego/sbom-policy.mjs'].includes(name), true, `${name} must be locked`);
  }
  for (const id of ['node.registry', 'registry.compiler', 'package.transaction', 'registry.closure', 'node.resolution', 'runtime.lease', 'node.residency', 'node.capability', 'node.semantics', 'node.lifecycle', 'node.health', 'node.supply-chain', 'registry.incremental', 'node.worker-convergence', 'node.acceptance', 'registry.integrity', 'node.admission']) {
    assert.equal(lock.contracts.find((contract) => contract.id === id).version, '0.1.0', `P6.18 must not re-version ${id}`);
  }
  const domain = JSON.parse(readFileSync(new URL('../src/lego/manifest/domains.json', import.meta.url)))
    .domains.find((entry) => entry.id === 'node-registry');
  assert.equal(domain.contract.id, 'node.portability');
  assert.ok(domain.paths.includes('src/lego/sbom-policy.mjs'));
});
