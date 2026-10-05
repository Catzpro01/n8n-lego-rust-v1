/**
 * P3 Slice L — Compatibility oracle (#91): the four modes, the nine
 * observables, fail-closed structural equivalence, and the #91(c)
 * optimization-toggle sweep with the identity-recovery property.
 * Contract `compatibility.oracle@1.0.0` (lock row 38), owner agent-1.
 * Zero-import module inside `src/compat/` (mustNotDependOn workflow/execution
 * is structural: no imports at all).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  COMPATIBILITY_ORACLE_CONTRACT, COMPATIBILITY_ORACLE_CONTRACT_VERSION,
  ORACLE_MODES, ORACLE_OBSERVABLES, CompatibilityOracleError,
  differentialPlan, compareCanonical, toggleSweep,
} from '../src/compat/oracle.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const LOCK = JSON.parse(readFileSync(path.join(ROOT, 'src/lego/contracts/contract-lock.json'), 'utf8'));
const ROWS = LOCK.contracts;
const moduleSource = readFileSync(path.join(ROOT, 'src/compat/oracle.mjs'), 'utf8');

function caught(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw that never happened');
}

/* ============================================ A. CONTRACT / LOCK ROW 38 */

test('the lock row is the thirty-eighth: compatibility.oracle@1.0.0, owner agent-1, exports byte-parity', () => {
  const row = ROWS.find((r) => r.id === 'compatibility.oracle');
  assert.ok(row, 'compatibility.oracle is locked');
  // P9.1 envelope + P3 optimizer are merged; P9.2 structured-log adds row 42.
  assert.equal(ROWS.length, 100, 'P3 Slice J added the thirty-seventh (execution.ir); P3 Slice L adds the thirty-eighth (compatibility.oracle); P3 Slice M adds the thirty-ninth (execution.guard); P3 Slice K the forty-first (execution.optimizer) — P6.1 adds node.registry@0.1.0; P6.2 adds registry.compiler@0.1.0; P6.3 adds package.transaction@0.1.0; P6.4 adds registry.closure@0.1.0; P6.5 adds node.resolution@0.1.0; P6.6 adds runtime.lease@0.1.0; P6.7 adds node.residency@0.1.0; P6.8 adds node.capability@0.1.0; P6.9 adds node.semantics@0.1.0; P6.10 adds node.lifecycle@0.1.0; P6.11 adds node.health@0.1.0; P6.12 adds node.supply-chain@0.1.0; P6.13 adds registry.incremental@0.1.0; P6.14 adds node.worker-convergence@0.1.0; P6.15 adds node.acceptance@0.1.0; P6.16 adds registry.integrity@0.1.0; P6.17 adds node.admission@0.1.0; P6.18 adds node.sbom@0.1.0; P6.19 adds node.canary@0.1.0; P6.20 adds node.revocation@0.1.0; P6.21 adds node.io@0.1.0; P6.22 adds runtime.jit@0.1.0; P6.23 adds runtime.cancel@0.1.0; P6.24 adds runtime.pool@0.1.0; P6.25 adds node.abi@0.1.0; P6.26 adds runtime.wasm-cache@0.1.0; P6.27 adds node.provenance@0.1.0; P6.28 adds registry.freshness@0.1.0; P6.29 adds node.namespace@0.1.0; P6.30 adds registry.repair@0.1.0; P6.31 adds registry.acceptance@0.1.0; count-pins say 76; P2.27.1 adds lego.plugin-runtime@0.1.0 (seventy-sixth); P5.1 adds the ninety-fifth (auth.principal)'); // P9 integration (Agent 1): P9.5-P9.22 add 18 observability.* rows on top of protected main 76 -> 94 (union, zero id collisions); P9 was developed on 24032a0c (57 rows). P5.2 adds the ninety-sixth (auth.session). P5.3 adds the ninety-seventh (auth.authorization). P5.5 adds the ninety-eighth (auth.credential-crypto). P5.6 adds the ninety-ninth (auth.account-security). P5.7 adds the hundredth (auth.machine-identity).
  assert.equal(row.owner, 'agent-1', 'Issue #98: Agent 1 owns the compatibility layer');
  assert.equal(row.domain, 'compatibility');
  assert.equal(row.version, '1.0.0');
  assert.equal(row.status, 'implemented');
  assert.deepEqual(row.surface, ['src/compat/oracle.mjs']);
  const module_ = {
    COMPATIBILITY_ORACLE_CONTRACT, COMPATIBILITY_ORACLE_CONTRACT_VERSION,
    ORACLE_MODES, ORACLE_OBSERVABLES, CompatibilityOracleError,
    differentialPlan, compareCanonical, toggleSweep,
  };
  const exported = Object.keys(module_).sort();
  const locked = Object.values(row.exports).flat().sort();
  assert.deepEqual(exported, locked, 'file exports match the lock');
  for (const key of locked) assert.notEqual(module_[key], undefined, key);
  assert.equal(COMPATIBILITY_ORACLE_CONTRACT_VERSION, '1.0.0');
  assert.equal(typeof differentialPlan, 'function');
  assert.equal(typeof compareCanonical, 'function');
  assert.equal(typeof toggleSweep, 'function');
});

/* ================================================ B. MODES / OBSERVABLES */

test('#91 publishes exactly the four required modes and nine observables', () => {
  assert.deepEqual([...ORACLE_MODES], [
    'differential',
    'virtualization-equivalence',
    'optimization-toggles',
    'metamorphic',
  ]);
  assert.equal(ORACLE_OBSERVABLES.length, 9, 'nine canonical observables from Issue #91');
  assert.ok(ORACLE_OBSERVABLES.includes('finalStatus'));
  assert.ok(ORACLE_OBSERVABLES.includes('errorClassMessage'));
  assert.ok(ORACLE_OBSERVABLES.includes('nodeExecutionOrder'));
  assert.ok(ORACLE_OBSERVABLES.includes('credentialBehavior'));
  assert.ok(ORACLE_OBSERVABLES.includes('partialFailureSemantics'));
  assert.ok(Object.isFrozen(ORACLE_MODES) && Object.isFrozen(ORACLE_OBSERVABLES));
});

/* ================================================ C. PLAN / COMPARE */

test('differentialPlan freezes ordered comparison intent (cheap, no walk)', () => {
  const reference = { finalStatus: 'success', outputs: [1] };
  const candidate = { finalStatus: 'success', outputs: [1] };
  const plan = differentialPlan(reference, candidate, { mode: 'metamorphic' });
  assert.equal(plan.mode, 'metamorphic');
  assert.equal(plan.pairs.length, 9, 'default = every observable');
  assert.equal(plan.pairs[0].observable, 'finalStatus');
  assert.ok(Object.isFrozen(plan) && Object.isFrozen(plan.pairs));
  const scoped = differentialPlan(reference, candidate, { mode: 'differential', observables: ['outputs'] });
  assert.deepEqual(scoped.observables, ['outputs']);
  assert.equal(scoped.pairs.length, 1);
  const err = caught(() => differentialPlan(null, candidate));
  assert.ok(err instanceof CompatibilityOracleError);
  assert.equal(caught(() => differentialPlan(reference, candidate, { mode: 'nope' })).details.reason, 'unknown-mode');
  assert.equal(caught(() => differentialPlan(reference, candidate, { observables: ['x'] })).details.reason, 'unknown-observable');
  assert.equal(caught(() => differentialPlan(reference, candidate, { observables: ['outputs', 'outputs'] })).details.reason, 'duplicate-observable');
  assert.equal(caught(() => differentialPlan(reference, candidate, { observables: [] })).details.field, 'observables');
});

test('compareCanonical: equivalent pass; differences report path/expected/actual; absent fails closed', () => {
  const base = {
    finalStatus: 'success',
    outputs: [{ json: { a: 1, b: [1, 2, 3] } }],
    errorClassMessage: null,
    nodeExecutionOrder: ['A', 'B', 'C'],
    retryBehavior: { attempts: 1 },
    sideEffectBoundaries: ['file:out.txt'],
    executionMetadata: { startedAt: 100 },
    credentialBehavior: 'none-required',
    partialFailureSemantics: 'stop',
  };
  // identical (key order differs → still equivalent: objects order-insensitive)
  const clone = JSON.parse(JSON.stringify({ ...base, outputs: [{ json: { b: [1, 2, 3], a: 1 } }] }));
  const ok = compareCanonical(base, clone);
  assert.equal(ok.equivalent, true);
  assert.equal(ok.failures.length, 0);

  // NODE ORDER IS OBSERVABLE → array order difference must fail (#91)
  const reordered = { ...base, nodeExecutionOrder: ['A', 'C', 'B'] };
  const bad = compareCanonical(base, reordered);
  assert.equal(bad.equivalent, false);
  const failure = bad.failures.find((f) => f.observable === 'nodeExecutionOrder');
  assert.equal(failure.reason, 'not-equivalent');
  assert.equal(failure.path, 'nodeExecutionOrder[1]');

  // absent observable on one side → fail closed, never silent skip
  const partial = { finalStatus: 'success' };
  const absent = compareCanonical(base, partial, { observables: ['finalStatus', 'outputs'] });
  assert.equal(absent.equivalent, false);
  assert.equal(absent.failures[0].reason, 'absent-observable');
  assert.match(absent.failures[0].detail, /reference:present candidate:absent/);
  assert.ok(Object.isFrozen(ok) && Object.isFrozen(bad.failures));
});

/* ================================================ D. TOGGLE SWEEP #91(c) */

test('toggleSweep: 2^n bounded rows, identityRecovered only when all-off reproduces canonical', () => {
  const canonical = { ir: 'raw', steps: ['A', 'B'] };
  const apply = (toggles) => {
    // honest optimizer: all-off = identity; ON subsets structurally shrink
    if (!toggles.noopPassthrough && !toggles.dedupeDeps) return { ir: 'raw', steps: ['A', 'B'] };
    return { ir: 'opt', steps: ['A'] };
  };
  const sweep = toggleSweep({
    canonical,
    apply,
    toggleNames: ['noopPassthrough', 'dedupeDeps'],
  });
  assert.equal(sweep.rows.length, 4, '2^2 subsets');
  assert.equal(sweep.identityRecovered, true, 'all-off row is exactly canonical');
  const allOff = sweep.rows.find((r) => r.off.length === 2);
  assert.ok(allOff);
  assert.equal(allOff.equivalentToCanonical, true);
  const onRow = sweep.rows.find((r) => r.off.length === 0);
  assert.equal(onRow.equivalentToCanonical, false, 'optimized structure may differ — reported honestly, not forced');
  assert.ok(Object.isFrozen(sweep) && Object.isFrozen(sweep.rows) && Object.isFrozen(onRow.toggles));

  // cheating apply (all-off does NOT recover canonical) → identityRecovered false
  const cheat = toggleSweep({
    canonical,
    apply: () => ({ ir: 'never-raw' }),
    toggleNames: ['noopPassthrough', 'dedupeDeps'],
  });
  assert.equal(cheat.identityRecovered, false, 'the sweep must expose broken recovery, not hide it');
  assert.equal(cheat.rows.every((r) => r.equivalentToCanonical === false), true);
});

test('toggleSweep fails closed: callbacks, names, duplicates, count cap (one error family)', () => {
  const canonical = {};
  assert.equal(caught(() => toggleSweep({ canonical, toggleNames: ['a'] })).details.field, 'apply');
  assert.equal(caught(() => toggleSweep({ apply: () => 0, canonical, toggleNames: [] })).details.field, 'toggleNames');
  assert.equal(caught(() => toggleSweep({ apply: () => 0, toggleNames: ['a'] })).details.field, 'canonical');
  assert.equal(caught(() => toggleSweep({ apply: () => 0, canonical, toggleNames: ['a', 'a'] })).details.reason, 'duplicate-toggle');
  const eight = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  const nine = [...eight, 'i'];
  assert.equal(caught(() => toggleSweep({ apply: () => 0, canonical, toggleNames: nine })).details.reason, 'too-many-toggles');
  const err = caught(() => toggleSweep({ canonical, toggleNames: ['a'] }));
  assert.ok(err instanceof CompatibilityOracleError);
  assert.equal(err.name, 'CompatibilityOracleError');
  assert.equal(err.code, 'lego.contract_violation');
  // 8 toggles = 256 rows still fine (bounded)
  const max = toggleSweep({ canonical: { v: 1 }, apply: (t) => (Object.values(t).every(Boolean) ? { v: 1 } : { v: 2 }), toggleNames: eight });
  assert.equal(max.rows.length, 256);
  assert.equal(max.identityRecovered, false); // all-off (all false) → {v:2} ≠ canonical
});

/* ================================================ E. PURITY — zero-import */

test('module is zero-import (mustNotDependOn workflow/execution is structural)', () => {
  assert.equal(/^\s*import\s/m.test(moduleSource), false, 'no import statements at all');
  assert.equal(moduleSource.includes("from 'node:"), false, 'no node: builtins');
  assert.equal(moduleSource.includes("from '../"), false, 'no relative imports (workflow/execution unreachable)');
  assert.equal(/require\(/.test(moduleSource), false, 'no require calls');
  assert.equal(/Date\.now|Math\.random|process\./.test(moduleSource), false, 'no clock/randomness/process — pure comparisons');
});
