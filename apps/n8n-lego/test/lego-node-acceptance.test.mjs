/**
 * P6.15 — Core acceptance.
 * Contract `node.acceptance@0.1.0`.
 *
 * Matrix: the claims as data, the full run over the real contracts (no mocks), the
 * report's refusal to be cherry-picked (partial runs are marked partial and
 * refused as evidence), fail-closed missing evidence, the digest that makes the
 * evidence tamper-evident, the reads, and the scope walls.
 *
 * The evidence this suite injects is exactly what a release engineer would attach:
 * the P6 core sources and the contract lock.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  ACCEPTANCE_CATEGORIES,
  ACCEPTANCE_CLAIMS,
  ACCEPTANCE_CONTRACT,
  ACCEPTANCE_CONTRACT_VERSION,
  ACCEPTANCE_COVERS,
  ACCEPTANCE_FORBIDDEN_IMPORTS,
  ACCEPTANCE_INPUT_SCHEMA_VERSION,
  ACCEPTANCE_OPERATIONS,
  ACCEPTANCE_PERMISSIONS,
  ACCEPTANCE_REASONS,
  ACCEPTANCE_RULES,
  ACCEPTANCE_SCHEMA_VERSION,
  AcceptanceError,
  claimById,
  describeAcceptance,
  explainAcceptance,
  isAcceptanceReport,
  listClaims,
  runAcceptance,
  verifyAcceptanceReport,
} from '../src/lego/node-acceptance.mjs';

/* ------------------------------------------------------------------ evidence */

const CORE_MODULES = [
  'node-registry', 'registry-compiler', 'package-transaction', 'dependency-closure',
  'resolution-manifest', 'runtime-lease', 'node-residency', 'capability-compiler',
  'semantic-fingerprint', 'node-lifecycle', 'node-health', 'supply-chain',
  'incremental-registry', 'worker-convergence', 'node-acceptance',
];

const sourcesFor = (modules = CORE_MODULES) => Object.fromEntries(
  modules.map((name) => [`src/lego/${name}.mjs`, readFileSync(new URL(`../src/lego/${name}.mjs`, import.meta.url), 'utf8')]),
);
const lockOf = () => JSON.parse(readFileSync(new URL('../src/lego/contracts/contract-lock.json', import.meta.url), 'utf8'));
const evidence = () => ({ sources: sourcesFor(), lock: lockOf() });

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

test('the contract identifies itself and names the core it accepts', () => {
  assert.equal(ACCEPTANCE_CONTRACT, 'node.acceptance@0.1.0');
  assert.equal(ACCEPTANCE_CONTRACT_VERSION, '0.1.0');
  assert.equal(ACCEPTANCE_SCHEMA_VERSION, 1);
  assert.equal(ACCEPTANCE_INPUT_SCHEMA_VERSION, 1);
  assert.deepEqual([...ACCEPTANCE_OPERATIONS], ['list', 'run', 'verify', 'describe']);
  assert.deepEqual([...ACCEPTANCE_PERMISSIONS], ['node:read']);
  assert.equal(ACCEPTANCE_COVERS.length, 15, 'P6.1 through P6.15: fourteen contracts plus this one');
  assert.equal(ACCEPTANCE_COVERS[0], 'node.registry@0.1.0');
  assert.equal(ACCEPTANCE_COVERS.at(-1), ACCEPTANCE_CONTRACT);
  for (const identity of ACCEPTANCE_COVERS) assert.match(identity, /^[a-z-]+\.[a-z-]+@0\.1\.0$/);
  for (const reason of ACCEPTANCE_REASONS) assert.match(reason, /^acceptance\.[a-z_]+$/);
  assert.equal(Object.isFrozen(ACCEPTANCE_RULES), true);
  assert.match(ACCEPTANCE_RULES.complete, /omission detectable/);
  assert.match(ACCEPTANCE_RULES.evidence, /failure, not a skip/);
  assert.match(ACCEPTANCE_RULES.authority, /never permission to ship/);
  assert.ok(ACCEPTANCE_FORBIDDEN_IMPORTS.includes('execution-ir.mjs'));
});

test('the claims are data: an id, a category, a sentence and the contracts they cover', () => {
  assert.equal(ACCEPTANCE_CLAIMS.length, 16);
  const ids = ACCEPTANCE_CLAIMS.map((claim) => claim.id);
  assert.deepEqual(ids, [...new Set(ids)], 'claim ids are unique');
  for (const claim of ACCEPTANCE_CLAIMS) {
    assert.ok(ACCEPTANCE_CATEGORIES.includes(claim.category), `${claim.id} has an undeclared category`);
    assert.ok(claim.statement.length > 40, `${claim.id} has no statement worth reading`);
    assert.ok(claim.covers.length > 0, `${claim.id} covers nothing`);
    assert.equal(Object.isFrozen(claim.covers), true);
    for (const covered of claim.covers) assert.ok(ACCEPTANCE_COVERS.includes(covered), `${claim.id} covers an unknown contract ${covered}`);
  }
  const covered = new Set(ACCEPTANCE_CLAIMS.flatMap((claim) => [...claim.covers]));
  for (const identity of ACCEPTANCE_COVERS) assert.ok(covered.has(identity), `${identity} is accepted by no claim`);
  assert.equal(claimById('health.breaker').category, 'health');
  assert.equal(claimById('nope.nope'), null);
  assert.equal(listClaims({ category: 'supply' }).length, 1);
  assert.equal(listClaims().length, 16);
  assert.equal(Object.isFrozen(listClaims()), true);
  throwsWith(() => claimById(''), 'acceptance.input');
  throwsWith(() => listClaims({ category: 'vibes' }), 'acceptance.input');
});

/* ----------------------------------------------------------------- the run */

test('the full run accepts the core: sixteen claims over fifteen contracts', () => {
  const report = runAcceptance({ evidence: evidence() });
  assert.equal(report.ok, true, explainAcceptance(report));
  assert.equal(report.complete, true);
  assert.equal(report.claimCount, 16);
  assert.equal(report.totalClaims, 16);
  assert.equal(report.passed, 16);
  assert.equal(report.failed, 0);
  assert.equal(report.message, null);
  assert.equal(isAcceptanceReport(report), true);
  assert.equal(Object.isFrozen(report.results), true);
  assert.match(report.reportDigest, /^sha256:[0-9a-f]{64}$/);
  assert.match(explainAcceptance(report), /acceptance passed: 16\/16 claim\(s\)/);
  for (const result of report.results) {
    assert.equal(result.ok, true, `${result.id} failed: ${result.failures.map((entry) => entry.message).join('; ')}`);
    assert.equal(typeof result.evidence, 'string');
    assert.ok(result.evidence.length > 20, `${result.id} produced no usable evidence`);
    assert.equal(result.error, null, `${result.id} threw instead of reporting`);
  }
});

test('every claim is a real check, not a formality: each cites what it actually observed', () => {
  const report = runAcceptance({ evidence: evidence() });
  const byId = Object.fromEntries(report.results.map((result) => [result.id, result.evidence]));
  assert.match(byId['identity.canonical'], /duplicate refused=true/);
  assert.match(byId['identity.canonical'], /two typeVersions are two identities=true/);
  assert.match(byId['install.atomic'], /commit refused \(package\.transaction\.order\)/);
  assert.match(byId['closure.deterministic'], /tamper detected=true/);
  assert.match(byId['resolution.pinned'], /own=match, other epoch=changed, absent=missing/);
  assert.match(byId['lease.pinned'], /drained only after release=true/);
  assert.match(byId['residency.tiers'], /cold load refused/);
  assert.match(byId['capability.all-or-nothing'], /subprocess refused=true/);
  assert.match(byId['semantics.equivalence'], /implementation-only=MATCH\/none reported=true/);
  assert.match(byId['lifecycle.irreversible'], /name reusable=false/);
  assert.match(byId['health.breaker'], /still refused=health\.quarantined/);
  assert.match(byId['supply.revocation'], /revocation wins=true/);
  assert.match(byId['incremental.equivalence'], /equivalent=true/);
  assert.match(byId['convergence.separation'], /behind=UPGRADE_REQUIRED/);
  assert.match(byId['boundary.scope-walls'], /15 module source\(s\) scanned, 0 forbidden import\(s\)/);
  assert.match(byId['surface.lock-rows'], /15\/15 core contract\(s\) locked at 0\.1\.0/);
});

test('a subset is a partial run, and a partial run says so', () => {
  const partial = runAcceptance({ include: ['epoch.deterministic', 'health.breaker'], evidence: evidence() });
  assert.equal(partial.complete, false);
  assert.equal(partial.claimCount, 2);
  assert.equal(partial.ok, false, 'a partial run cannot be acceptance');
  assert.match(partial.message, /partial: 2 of 16 claim\(s\), and a partial run is not acceptance/);
  assert.match(explainAcceptance(partial), /PARTIAL/);
  const excluded = runAcceptance({ exclude: ['boundary.scope-walls', 'surface.lock-rows'] });
  assert.equal(excluded.complete, false);
  assert.equal(excluded.claimCount, 14);
  throwsWith(() => runAcceptance({ include: ['not.a.claim'] }), 'acceptance.input');
  throwsWith(() => runAcceptance({ exclude: 'boundary.scope-walls' }), 'acceptance.input');
  throwsWith(() => runAcceptance({ include: 'health.breaker' }), 'acceptance.input');
  throwsWith(() => runAcceptance({ evidence: 'files' }), 'acceptance.evidence');
});

/* --------------------------------------------------- evidence is fail-closed */

test('missing evidence is a failure, not a skip', () => {
  const report = runAcceptance({});
  assert.equal(report.ok, false);
  assert.equal(report.failed, 2, 'both injected-evidence claims must fail without their evidence');
  const failedIds = report.results.filter((result) => !result.ok).map((result) => result.id);
  assert.deepEqual(failedIds, ['boundary.scope-walls', 'surface.lock-rows']);
  const boundary = report.results.find((result) => result.id === 'boundary.scope-walls');
  assert.equal(boundary.failures[0].code, 'acceptance.evidence');
  assert.match(boundary.failures[0].message, /has not checked the boundary/);
  const surface = report.results.find((result) => result.id === 'surface.lock-rows');
  assert.equal(surface.failures[0].code, 'acceptance.evidence');
});

test('an injected source that reaches outside the boundary fails the boundary claim', () => {
  const sources = sourcesFor();
  sources['src/lego/incremental-registry.mjs'] = `${sources['src/lego/incremental-registry.mjs']}\nimport { x } from './execution-ir.mjs';\n`;
  const report = runAcceptance({ include: ['boundary.scope-walls'], evidence: { sources, lock: lockOf() } });
  const [result] = report.results;
  assert.equal(result.ok, false);
  assert.match(result.failures[0].message, /reaches outside its boundary/);
  assert.match(result.failures[0].message, /incremental-registry\.mjs → execution-ir\.mjs/);

  const thin = runAcceptance({ include: ['boundary.scope-walls'], evidence: { sources: { 'src/lego/node-health.mjs': 'x' }, lock: lockOf() } });
  assert.equal(thin.results[0].ok, false);
  assert.match(thin.results[0].failures[0].message, /only 1 module source\(s\) supplied/);
});

test('a lock that has lost a row, or moved a version, fails the surface claim', () => {
  const lock = lockOf();
  const withoutHealth = { contracts: lock.contracts.filter((row) => row.id !== 'node.health') };
  const dropped = runAcceptance({ include: ['surface.lock-rows'], evidence: { sources: sourcesFor(), lock: withoutHealth } });
  assert.equal(dropped.results[0].ok, false);
  assert.match(dropped.results[0].failures[0].message, /node\.health@0\.1\.0 has 0 locked row\(s\)/);

  const bumped = { contracts: lock.contracts.map((row) => (row.id === 'node.health' ? { ...row, version: '0.2.0' } : row)) };
  const moved = runAcceptance({ include: ['surface.lock-rows'], evidence: { sources: sourcesFor(), lock: bumped } });
  assert.equal(moved.results[0].ok, false);
  assert.match(moved.results[0].failures[0].message, /is locked at 0\.2\.0/);

  const doubled = { contracts: [...lock.contracts, { ...lock.contracts.find((row) => row.id === 'node.health'), version: '0.1.0' }] };
  const twice = runAcceptance({ include: ['surface.lock-rows'], evidence: { sources: sourcesFor(), lock: doubled } });
  assert.equal(twice.results[0].ok, false);
  assert.match(twice.results[0].failures[0].message, /has 2 locked row\(s\)/);
});

/* ----------------------------------------------------------- verification */

test('a report proves its own content, and refuses to stand in for the missing', () => {
  const report = runAcceptance({ evidence: evidence() });
  const verified = verifyAcceptanceReport(report);
  assert.equal(verified.ok, true);
  assert.equal(verified.complete, true);
  assert.equal(verified.expected, verified.actual);
  assert.equal(verified.message, null);

  const edited = Object.freeze({ ...report, reportDigest: `sha256:${'0'.repeat(64)}` });
  const tampered = verifyAcceptanceReport(edited);
  assert.equal(tampered.ok, false);
  assert.equal(tampered.reason, 'acceptance.report');
  assert.match(tampered.message, /edited after it was produced/);

  const partial = runAcceptance({ include: ['epoch.deterministic'], evidence: evidence() });
  const partialVerified = verifyAcceptanceReport(partial);
  assert.equal(partialVerified.ok, false);
  assert.match(partialVerified.message, /partial run cannot stand in for acceptance/);
  assert.ok(partialVerified.missing.includes('health.breaker'));

  const lied = Object.freeze({
    ...runAcceptance({ include: ['epoch.deterministic'], evidence: evidence() }),
    complete: true, claimCount: 16, totalClaims: 16,
  });
  const caught = verifyAcceptanceReport(lied);
  assert.equal(caught.ok, false);
  assert.match(caught.message, /omits/);
  throwsWith(() => verifyAcceptanceReport({ nope: true }), 'lego.contract_violation');
  throwsWith(() => verifyAcceptanceReport(null), 'lego.contract_violation');
});

test('describing a report gives counts per category and the claims that failed', () => {
  const report = runAcceptance({ evidence: evidence() });
  const described = describeAcceptance(report);
  assert.equal(described.passed, 16);
  assert.equal(described.failed, 0);
  assert.deepEqual([...described.failedClaims], []);
  assert.equal(described.byCategory.health.passed, 1);
  assert.equal(described.byCategory.boundary.passed, 1);
  assert.equal(Object.keys(described.byCategory).length, ACCEPTANCE_CATEGORIES.length, 'every category has a claim');
  assert.equal(Object.isFrozen(described), true);

  const failing = runAcceptance({});
  const withFailures = describeAcceptance(failing);
  assert.deepEqual([...withFailures.failedClaims], ['boundary.scope-walls', 'surface.lock-rows']);
  assert.match(explainAcceptance(failing), /acceptance FAILED: 2 of 16 claim\(s\)/);
  assert.equal(explainAcceptance(failing).includes('surface.lock-rows (acceptance.evidence)'), true);
  throwsWith(() => describeAcceptance({}), 'lego.contract_violation');
  throwsWith(() => explainAcceptance({}), 'lego.contract_violation');
});

test('the error type is exported, and a failing claim is data rather than an exception', () => {
  const error = new AcceptanceError('x');
  assert.equal(error instanceof Error, true);
  assert.equal(error.code, 'lego.contract_violation');
  assert.equal(Object.isFrozen(error.meta), true);
  assert.doesNotThrow(() => runAcceptance({}));
  assert.doesNotThrow(() => runAcceptance({ include: ['install.atomic'] }));
});

/* -------------------------------------------------------------- scope walls */

test('P6.15 is pure: the only node import is the hash, and nothing is executed blindly', () => {
  const source = readFileSync(new URL('../src/lego/node-acceptance.mjs', import.meta.url), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const forbidden of ['node:fs', 'node:net', 'node:http', 'node:os', 'node:child_process', 'process.', 'Math.random', 'setTimeout', 'performance.', 'fetch(', 'node:vm', 'eval(']) {
    assert.equal(code.includes(forbidden), false, `the acceptance contract must not reference ${forbidden}`);
  }
  assert.deepEqual([...code.matchAll(/from '(node:[a-z_/]+)'/g)].map((match) => match[1]), ['node:crypto']);
  assert.equal(/\bnew Date\b|\bDate\.now\b/.test(code), false);
});

test('P6.15 checks the core through the contracts, never through private internals', () => {
  const source = readFileSync(new URL('../src/lego/node-acceptance.mjs', import.meta.url), 'utf8');
  const imports = [...source.matchAll(/from '\.\/([a-z-]+)\.mjs'/g)].map((match) => match[1]);
  assert.deepEqual(imports, CORE_MODULES.slice(0, 14), 'the acceptance contract imports exactly the fourteen core contracts');
  for (const forbidden of ['execution-ir', 'workflow-graph', 'envelope', 'transport-kernel', 'state-stream', 'agent-machine']) {
    assert.equal(imports.includes(forbidden), false, `the acceptance contract must not import ${forbidden}`);
  }
  assert.equal(source.includes('const fail'), true, 'API misuse still fails loudly');
});

/* -------------------------------------------------------------- lock row */

test('the contract-lock row is canonical: one row, version, ops, tests, exports, domain path', () => {
  const lock = lockOf();
  const rows = lock.contracts.filter((contract) => contract.id === 'node.acceptance');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].version, ACCEPTANCE_CONTRACT_VERSION);
  assert.equal(rows[0].domain, 'node-registry');
  assert.equal(rows[0].status, 'implemented');
  assert.deepEqual(rows[0].surface, ['src/lego/node-acceptance.mjs']);
  assert.deepEqual(rows[0].tests, ['apps/n8n-lego/test/lego-node-acceptance.test.mjs']);
  for (const name of ['runAcceptance', 'verifyAcceptanceReport', 'listClaims', 'describeAcceptance']) {
    assert.equal(rows[0].exports['src/lego/node-acceptance.mjs'].includes(name), true, `${name} must be locked`);
  }
  for (const id of ['node.registry', 'registry.compiler', 'package.transaction', 'registry.closure', 'node.resolution', 'runtime.lease', 'node.residency', 'node.capability', 'node.semantics', 'node.lifecycle', 'node.health', 'node.supply-chain', 'registry.incremental', 'node.worker-convergence']) {
    assert.equal(lock.contracts.find((contract) => contract.id === id).version, '0.1.0', `P6.15 must not re-version ${id}`);
  }
  const domain = JSON.parse(readFileSync(new URL('../src/lego/manifest/domains.json', import.meta.url)))
    .domains.find((entry) => entry.id === 'node-registry');
  assert.equal(domain.contract.id, 'node.portability');
  assert.ok(domain.paths.includes('src/lego/node-acceptance.mjs'));
});
