/**
 * P3 Slice M — Resource guard (#75 required architecture #7: enforced
 * resource budgets; #79 burst/overload groundwork): mandatory budgets, five
 * priority lanes, three-tier pressure, admit|defer|reject, NO clock.
 * Contract `execution.guard@1.0.0` (lock row 39), owner agent-1.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  EXECUTION_GUARD_CONTRACT, EXECUTION_GUARD_CONTRACT_VERSION,
  GUARD_LANES, GUARD_BUDGETS, GUARD_DECISIONS, ResourceGuardError,
  createResourceGuard,
} from '../src/lego/resource-guard.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const LOCK = JSON.parse(readFileSync(path.join(ROOT, 'src/lego/contracts/contract-lock.json'), 'utf8'));
const ROWS = LOCK.contracts;
const moduleSource = readFileSync(path.join(ROOT, 'src/lego/resource-guard.mjs'), 'utf8');

function caught(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw that never happened');
}

const BUDGETS = Object.freeze({
  memoryBytes: 512 * 1024 * 1024,
  maxConcurrency: 4,
  queueDepth: 1000,
  outputBytes: 64 * 1024 * 1024,
  timeoutMs: 30_000,
  ioOps: 10_000,
});

function observed(overrides = {}) {
  return {
    memoryBytes: 0,
    activeConcurrency: 0,
    queuedItems: 0,
    outputBytes: 0,
    overdueMs: 0,
    ioOps: 0,
    ...overrides,
  };
}

/* ============================================ A. CONTRACT / LOCK ROW 39 */

test('the lock row is the thirty-ninth: execution.guard@1.0.0, owner agent-1, exports byte-parity', () => {
  const row = ROWS.find((r) => r.id === 'execution.guard');
  assert.ok(row, 'execution.guard is locked');
  // P9.1 envelope + P3 optimizer are merged; P9.2 structured-log adds row 42.
  assert.equal(ROWS.length, 100, 'P3 Slice L added the thirty-eighth (compatibility.oracle); P3 Slice M adds the thirty-ninth (execution.guard); P3 Slice K the forty-first (execution.optimizer) — P6.1 adds node.registry@0.1.0; P6.2 adds registry.compiler@0.1.0; P6.3 adds package.transaction@0.1.0; P6.4 adds registry.closure@0.1.0; P6.5 adds node.resolution@0.1.0; P6.6 adds runtime.lease@0.1.0; P6.7 adds node.residency@0.1.0; P6.8 adds node.capability@0.1.0; P6.9 adds node.semantics@0.1.0; P6.10 adds node.lifecycle@0.1.0; P6.11 adds node.health@0.1.0; P6.12 adds node.supply-chain@0.1.0; P6.13 adds registry.incremental@0.1.0; P6.14 adds node.worker-convergence@0.1.0; P6.15 adds node.acceptance@0.1.0; P6.16 adds registry.integrity@0.1.0; P6.17 adds node.admission@0.1.0; P6.18 adds node.sbom@0.1.0; P6.19 adds node.canary@0.1.0; P6.20 adds node.revocation@0.1.0; P6.21 adds node.io@0.1.0; P6.22 adds runtime.jit@0.1.0; P6.23 adds runtime.cancel@0.1.0; P6.24 adds runtime.pool@0.1.0; P6.25 adds node.abi@0.1.0; P6.26 adds runtime.wasm-cache@0.1.0; P6.27 adds node.provenance@0.1.0; P6.28 adds registry.freshness@0.1.0; P6.29 adds node.namespace@0.1.0; P6.30 adds registry.repair@0.1.0; P6.31 adds registry.acceptance@0.1.0; count-pins say 76; P2.27.1 adds lego.plugin-runtime@0.1.0 (seventy-sixth); P5.1 adds the ninety-fifth (auth.principal)'); // P9 integration (Agent 1): P9.5-P9.22 add 18 observability.* rows on top of protected main 76 -> 94 (union, zero id collisions); P9 was developed on 24032a0c (57 rows). P5.2 adds the ninety-sixth (auth.session). P5.3 adds the ninety-seventh (auth.authorization). P5.5 adds the ninety-eighth (auth.credential-crypto). P5.6 adds the ninety-ninth (auth.account-security). P5.7 adds the hundredth (auth.machine-identity).
  assert.equal(row.owner, 'agent-1', 'Issue #98: Agent 1 owns resource protection');
  assert.equal(row.domain, 'execution');
  assert.equal(row.version, '1.0.0');
  assert.equal(row.status, 'implemented');
  assert.deepEqual(row.surface, ['src/lego/resource-guard.mjs']);
  const module_ = {
    EXECUTION_GUARD_CONTRACT, EXECUTION_GUARD_CONTRACT_VERSION,
    GUARD_LANES, GUARD_BUDGETS, GUARD_DECISIONS, ResourceGuardError,
    createResourceGuard,
  };
  const exported = Object.keys(module_).sort();
  const locked = Object.values(row.exports).flat().sort();
  assert.deepEqual(exported, locked, 'file exports match the lock');
  for (const key of locked) assert.notEqual(module_[key], undefined, key);
  assert.equal(EXECUTION_GUARD_CONTRACT_VERSION, '1.0.0');
});

/* ============================================ B. SHAPE: lanes/budgets/decisions */

test('five priority lanes, six mandatory budgets, three decisions — frozen vocabularies', () => {
  assert.deepEqual([...GUARD_LANES], ['system', 'interactive', 'background', 'bulk', 'deferred']);
  assert.equal(GUARD_LANES.length, 5);
  assert.deepEqual([...GUARD_BUDGETS], ['memoryBytes', 'maxConcurrency', 'queueDepth', 'outputBytes', 'timeoutMs', 'ioOps']);
  assert.deepEqual([...GUARD_DECISIONS], ['admit', 'defer', 'reject']);
  assert.ok(Object.isFrozen(GUARD_LANES) && Object.isFrozen(GUARD_BUDGETS) && Object.isFrozen(GUARD_DECISIONS));
});

/* ============================================ C. FAIL-CLOSED BUDGETS */

test('budgets are mandatory: missing/invalid/unknown budgets fail closed (one error family)', () => {
  assert.equal(caught(() => createResourceGuard()).details.field, 'budgets');
  assert.equal(caught(() => createResourceGuard({})).details.budget, 'memoryBytes', 'first missing budget named');
  assert.equal(caught(() => createResourceGuard({ ...BUDGETS, queueDepth: 0 })).details.budget, 'queueDepth');
  assert.equal(caught(() => createResourceGuard({ ...BUDGETS, timeoutMs: Infinity })).details.budget, 'timeoutMs');
  assert.equal(caught(() => createResourceGuard({ ...BUDGETS, maxConcurrency: -1 })).details.budget, 'maxConcurrency');
  assert.equal(caught(() => createResourceGuard({ ...BUDGETS, gpu: 1 })).details.reason, 'unknown-budget');
  const err = caught(() => createResourceGuard({}));
  assert.ok(err instanceof ResourceGuardError);
  assert.equal(err.name, 'ResourceGuardError');
  assert.equal(err.code, 'lego.contract_violation');
  // thresholds validation
  assert.equal(caught(() => createResourceGuard({ ...BUDGETS, pressureThresholds: 0.5 })).details.field, 'pressureThresholds');
  assert.equal(caught(() => createResourceGuard({ ...BUDGETS, pressureThresholds: { elevated: 0.5, critical: 0.4 } })).details.field, 'pressureThresholds');
  assert.equal(caught(() => createResourceGuard({ ...BUDGETS, pressureThresholds: { elevated: 0, critical: 0.9 } })).details.threshold, 'elevated');
  const g = createResourceGuard({ ...BUDGETS, pressureThresholds: { elevated: 0.6, critical: 0.8 } });
  assert.deepEqual(g.thresholds, { elevated: 0.6, critical: 0.8 });
  assert.deepEqual(g.budgets, BUDGETS);
  assert.ok(Object.isFrozen(g) && Object.isFrozen(g.budgets));
});

/* ============================================ D. NO CLOCK — observed state only */

test('the guard holds no clock: every observation is passed in, mandatory dimensions enforced', () => {
  const source = moduleSource;
  assert.equal(/Date\.now|performance\.now|new Date\(/.test(source), false, 'no clock reads in source');
  assert.equal(/^\s*import\s/m.test(source), false, 'zero imports');
  const g = createResourceGuard(BUDGETS);
  assert.equal(caught(() => g.admit('system', { memoryBytes: 0 })).details.observedKey, 'activeConcurrency', 'mandatory observation');
  assert.equal(caught(() => g.admit('system', observed({ queuedItems: -1 }))).details.observedKey, 'queuedItems');
  assert.equal(caught(() => g.pressure('nope')).details.field, 'observed');
  assert.equal(caught(() => g.admit('hero', observed())).details.reason, 'unknown-lane');
  assert.equal(caught(() => g.admit(0, observed())).details.field, 'lane');
});

/* ============================================ E. PRESSURE + DECISIONS */

test('pressure tiers: worst dimension wins, default thresholds 0.7 / 0.9, boundaries exact', () => {
  const g = createResourceGuard(BUDGETS);
  // all zero → normal
  assert.equal(g.pressure(observed()).tier, 'normal');
  // 70% memory → elevated (boundary inclusive)
  const mem70 = observed({ memoryBytes: Math.ceil(BUDGETS.memoryBytes * 0.7) }); // ceil → ratio ≥ 0.7 exactly
  assert.equal(g.pressure(mem70).tier, 'elevated');
  // 90% concurrency (3.6/4) → critical; another dim lower cannot downgrade it
  const crit = observed({ activeConcurrency: 3.6, queuedItems: 100 });
  const p = g.pressure(crit);
  assert.equal(p.tier, 'critical', 'worst dimension wins');
  assert.equal(p.ratios.maxConcurrency, 0.9);
  assert.ok(Object.isFrozen(p) && Object.isFrozen(p.ratios));
  // 89.9% → elevated only
  const almost = observed({ outputBytes: Math.floor(BUDGETS.outputBytes * 0.899) });
  assert.equal(g.pressure(almost).tier, 'elevated');
});

test('admission matrix: five lanes × three tiers (admit|defer|reject) exactly as specified', () => {
  const g = createResourceGuard(BUDGETS);
  const normal = observed();
  const elevated = observed({ queuedItems: 700 }); // 700/1000 = 0.7 → elevated
  const critical = observed({ queuedItems: 900 }); // 0.9 → critical

  // normal: every lane admitted
  for (const lane of GUARD_LANES) {
    assert.equal(g.admit(lane, normal).decision, 'admit', `${lane}@normal`);
  }
  // elevated: system + interactive admit; background/bulk/deferred defer
  assert.equal(g.admit('system', elevated).decision, 'admit');
  assert.equal(g.admit('interactive', elevated).decision, 'admit');
  assert.equal(g.admit('background', elevated).decision, 'defer');
  assert.equal(g.admit('bulk', elevated).decision, 'defer');
  assert.equal(g.admit('deferred', elevated).decision, 'defer');
  // critical: system admit; interactive/background defer; bulk/deferred reject
  assert.equal(g.admit('system', critical).decision, 'admit');
  assert.equal(g.admit('interactive', critical).decision, 'defer');
  assert.equal(g.admit('background', critical).decision, 'defer');
  assert.equal(g.admit('bulk', critical).decision, 'reject');
  assert.equal(g.admit('deferred', critical).decision, 'reject');
  const row = g.admit('bulk', critical);
  assert.equal(row.pressure, 'critical');
  assert.equal(row.hardLimit, null);
  assert.match(row.reason, /critical/);
  assert.ok(Object.isFrozen(row));
});

test('hard limits: budget exhaustion = backpressure wall for EVERY lane (system not exempt)', () => {
  const g = createResourceGuard(BUDGETS);
  // queue full (100% of queueDepth)
  const full = observed({ queuedItems: 1000 });
  for (const lane of GUARD_LANES) {
    const d = g.admit(lane, full);
    assert.equal(d.decision, 'reject', `${lane} rejected at wall`);
    assert.equal(d.hardLimit, 'queueDepth');
    assert.match(d.reason, /backpressure wall/);
  }
  // concurrency cap (system included)
  const capped = observed({ activeConcurrency: 4 });
  assert.equal(g.admit('system', capped).decision, 'reject');
  assert.equal(g.admit('system', capped).hardLimit, 'maxConcurrency');
  // overdue time counts as timeoutMs budget exhausted
  const overdue = observed({ overdueMs: 30_000 });
  assert.equal(g.admit('background', overdue).decision, 'reject');
  assert.equal(g.admit('background', overdue).hardLimit, 'timeoutMs');
  // memory wall
  const memWall = observed({ memoryBytes: BUDGETS.memoryBytes });
  assert.equal(g.admit('bulk', memWall).decision, 'reject');
  assert.equal(g.admit('bulk', memWall).hardLimit, 'memoryBytes');
});

test('remaining() reports headroom per budget (negative = over budget) from observed state', () => {
  const g = createResourceGuard(BUDGETS);
  const r = g.remaining(observed({ queuedItems: 250, activeConcurrency: 1 }));
  assert.equal(r.queueDepth, 750);
  assert.equal(r.maxConcurrency, 3);
  assert.equal(r.memoryBytes, BUDGETS.memoryBytes);
  const over = g.remaining(observed({ queuedItems: 1200 }));
  assert.equal(over.queueDepth, -200, 'negative headroom is honest, not clamped');
  assert.ok(Object.isFrozen(r));
});
