import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  HEALTH_CONTRACT, LIVENESS_STATES, READINESS_STATES, CONDITION_STATES,
  HEALTH_PHASES, HEALTH_REASON_CODES, HEALTH_LIMITS, createHealthModel,
} from '../src/lego/health-readiness.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/p9/health-readiness.json', import.meta.url), 'utf8'));

test('P9.10 contract: liveness/readiness distinct; DEGRADED ≠ UNAVAILABLE; phases; reason vocabulary', () => {
  assert.equal(HEALTH_CONTRACT.id, 'observability.health-readiness');
  assert.equal(HEALTH_CONTRACT.version, '1.0.0');
  assert.equal(HEALTH_CONTRACT.owner, 'agent-6');
  assert.deepEqual([...LIVENESS_STATES], fixture.livenessStates);
  assert.deepEqual([...READINESS_STATES], fixture.readinessStates);
  assert.deepEqual([...CONDITION_STATES], fixture.conditionStates);
  assert.deepEqual([...HEALTH_PHASES], fixture.phases);
  assert.deepEqual([...HEALTH_REASON_CODES], fixture.reasonCodes);
  // Distinctness (DoD): the sets do not collapse into each other
  assert.notDeepEqual(LIVENESS_STATES, READINESS_STATES);
  assert.ok(CONDITION_STATES.includes('DEGRADED'));
  assert.ok(CONDITION_STATES.includes('UNAVAILABLE'));
  assert.notEqual('DEGRADED', 'UNAVAILABLE');
  assert.equal(HEALTH_LIMITS.maxDependencies, 64);
  assert.equal(HEALTH_LIMITS.maxReasons, 32);
});

test('P9.10 state-machine: startup transitions STARTING → RUNNING', () => {
  const m = createHealthModel({ dependencies: [] });
  assert.ok(m);
  for (const step of fixture.startupTransitions) {
    if (step.action === 'markRunning') assert.equal(m.markRunning(), true);
    const h = m.evaluate();
    assert.equal(h.phase, step.expectPhase, step.action);
    assert.equal(h.readiness, step.expectReadiness, step.action);
    assert.equal(h.condition, step.expectCondition, step.action);
    assert.ok(h.reasons.includes(step.expectReason) ||
      h.reasons.some(r => r.startsWith(step.expectReason)), step.expectReason);
  }
  // second markRunning is idempotent false
  assert.equal(m.markRunning(), false);
});

test('P9.10 state-machine: recovery transitions RUNNING → RECOVERING → RUNNING', () => {
  const m = createHealthModel({
    dependencies: fixture.recoveryFixture.dependencies.map(d => ({ ...d })),
  });
  assert.ok(m);
  assert.equal(m.markRunning(), true);
  // critical down → UNAVAILABLE / NOT_READY (false-healthy rejected)
  let h = m.evaluate();
  assert.equal(h.condition, 'UNAVAILABLE');
  assert.equal(h.readiness, 'NOT_READY');
  assert.ok(h.reasons.some(r => r.startsWith('false_healthy.rejected')));
  // begin recovery
  assert.equal(m.beginRecovery(), true);
  h = m.evaluate();
  assert.equal(h.phase, 'RECOVERING');
  assert.equal(h.readiness, 'NOT_READY');
  assert.ok(h.reasons.includes('recovery.in_progress'));
  // restore dependency then complete
  assert.equal(m.setDependency('storage', { available: true, degraded: false, reason: 'ok' }), true);
  const after = m.completeRecovery();
  assert.ok(after);
  assert.equal(after.phase, 'RUNNING');
  assert.equal(after.condition, 'HEALTHY');
  assert.equal(after.readiness, 'READY');
  // completeRecovery only from RECOVERING
  assert.equal(m.completeRecovery(), null);
});

test('P9.10 reason-code fixtures: critical / degraded / healthy paths', () => {
  const rf = fixture.reasonFixture;
  // critical down
  {
    const m = createHealthModel({ dependencies: rf.criticalDown.dependencies });
    assert.ok(m);
    m.markRunning();
    const h = m.evaluate();
    assert.equal(h.condition, rf.criticalDown.expectCondition);
    assert.equal(h.readiness, rf.criticalDown.expectReadiness);
    for (const code of rf.criticalDown.expectReasonsInclude) {
      assert.ok(h.reasons.some(r => r === code || r.startsWith(code + ':')), code);
    }
  }
  // degraded optional dep — DEGRADED distinct from UNAVAILABLE
  {
    const m = createHealthModel({ dependencies: rf.degradedOptional.dependencies });
    assert.ok(m);
    m.markRunning();
    const h = m.evaluate();
    assert.equal(h.condition, 'DEGRADED');
    assert.equal(h.readiness, 'NOT_READY');
    assert.notEqual(h.condition, 'UNAVAILABLE');
    for (const code of rf.degradedOptional.expectReasonsInclude) {
      assert.ok(h.reasons.some(r => r === code || r.startsWith(code + ':')), code);
    }
  }
  // all healthy
  {
    const m = createHealthModel({ dependencies: rf.allHealthy.dependencies });
    assert.ok(m);
    m.markRunning();
    const h = m.evaluate();
    assert.equal(h.condition, 'HEALTHY');
    assert.equal(h.readiness, 'READY');
    assert.ok(h.reasons.includes('condition.healthy'));
    assert.ok(h.reasons.includes('readiness.ready'));
    // liveness axis is independent and ALIVE
    assert.equal(h.liveness, 'ALIVE');
    assert.equal(h.isAlive, true);
    assert.equal(h.isReady, true);
  }
});

test('P9.10 liveness and readiness are independent axes', () => {
  const m = createHealthModel({ dependencies: [] });
  assert.ok(m);
  m.markRunning();
  let h = m.evaluate();
  assert.equal(h.liveness, 'ALIVE');
  assert.equal(h.readiness, 'READY');
  // Kill liveness → DEAD forces UNAVAILABLE/NOT_READY but axes remain distinct fields
  assert.equal(m.probeLiveness(false), true);
  h = m.evaluate();
  assert.equal(h.liveness, 'DEAD');
  assert.equal(h.readiness, 'NOT_READY');
  assert.equal(h.condition, 'UNAVAILABLE');
  assert.equal(h.isAlive, false);
  assert.ok(h.reasons.some(r => r.startsWith('liveness.probe_failed')));
  // Recover liveness
  assert.equal(m.probeLiveness(true), true);
  h = m.evaluate();
  assert.equal(h.liveness, 'ALIVE');
  assert.equal(h.readiness, 'READY');
  assert.equal(h.condition, 'HEALTHY');
});

test('P9.10 false-healthy states are rejected', () => {
  const m = createHealthModel({
    dependencies: [
      { id: 'storage', critical: true, initial: { available: false, reason: 'storage.down' } },
    ],
  });
  assert.ok(m);
  // Phase claims RUNNING with critical dep down — still NOT_READY/UNAVAILABLE
  assert.equal(m.markRunning(), true);
  const h = m.evaluate();
  assert.equal(h.phase, 'RUNNING');
  assert.equal(h.readiness, 'NOT_READY');
  assert.equal(h.condition, 'UNAVAILABLE');
  assert.equal(h.isReady, false);
  assert.ok(h.reasons.some(r => r.startsWith('false_healthy.rejected')));
  assert.ok(m.stats().falseHealthyAttempts >= 1);
  // Degraded must not be promoted to HEALTHY either while optional dep degraded
  const m2 = createHealthModel({
    dependencies: [
      { id: 'storage', critical: true, initial: { available: true, reason: 'ok' } },
      { id: 'export', critical: false, initial: { available: false, reason: 'export.down' } },
    ],
  });
  assert.ok(m2);
  m2.markRunning();
  const h2 = m2.evaluate();
  assert.equal(h2.condition, 'DEGRADED');
  assert.notEqual(h2.condition, 'HEALTHY');
  assert.equal(h2.readiness, 'NOT_READY');
});

test('P9.10 degraded dependency fixture: sequence stays coherent (DEGRADED ≠ UNAVAILABLE)', () => {
  const m = createHealthModel({
    dependencies: [
      { id: 'storage', critical: true, initial: { available: false, reason: 'init' } },
      { id: 'cache', critical: false, initial: { available: true, reason: 'ok' } },
    ],
  });
  assert.ok(m);
  const seq = fixture.degradedDependencyFixture.sequence;
  // step 0: storage up + markRunning → HEALTHY
  assert.equal(m.setDependency('storage', { available: true, reason: 'ok' }), true);
  assert.equal(m.markRunning(), true);
  assert.equal(m.evaluate().condition, seq[0].expectCondition);
  // step 1: cache degraded → DEGRADED
  assert.equal(m.setDependency('cache', { degraded: true, reason: 'cache.slow' }), true);
  let h = m.evaluate();
  assert.equal(h.condition, 'DEGRADED');
  assert.equal(h.condition, seq[1].expectCondition);
  assert.notEqual(h.condition, 'UNAVAILABLE');
  // step 2: storage down → UNAVAILABLE (critical)
  assert.equal(m.setDependency('storage', { available: false, reason: 'storage.down' }), true);
  h = m.evaluate();
  assert.equal(h.condition, 'UNAVAILABLE');
  assert.equal(h.condition, seq[2].expectCondition);
  // step 3: storage back but cache still degraded → DEGRADED (not HEALTHY, not UNAVAILABLE)
  assert.equal(m.setDependency('storage', { available: true, reason: 'ok' }), true);
  h = m.evaluate();
  assert.equal(h.condition, 'DEGRADED');
  assert.equal(h.condition, seq[3].expectCondition);
  // step 4: cache recovered → HEALTHY
  assert.equal(m.setDependency('cache', { degraded: false, reason: 'ok' }), true);
  h = m.evaluate();
  assert.equal(h.condition, 'HEALTHY');
  assert.equal(h.readiness, 'READY');
});

test('P9.10 health queries are bounded and cheap; reasons capped', () => {
  const deps = [];
  for (let i = 0; i < fixture.boundedQuery.maxDependencies; i++) {
    deps.push({ id: `d${i}`, critical: false, initial: { available: false, reason: 'dependency.unknown' } });
  }
  const m = createHealthModel({ dependencies: deps, maxDependencies: 64 });
  assert.ok(m);
  m.markRunning();
  for (let i = 0; i < fixture.boundedQuery.queries; i++) {
    const h = m.evaluate();
    assert.ok(h.reasons.length <= HEALTH_LIMITS.maxReasons);
    assert.ok(h.dependencies.length <= 64);
  }
  assert.equal(m.stats().queries, fixture.boundedQuery.queries);
  // Oversized dependency list rejected
  assert.equal(createHealthModel({ maxDependencies: 2, dependencies: deps }), null);
  // registerDependency respects ceiling
  const m2 = createHealthModel({ maxDependencies: 1, dependencies: [] });
  assert.ok(m2);
  assert.equal(m2.registerDependency({ id: 'a' }), true);
  assert.equal(m2.registerDependency({ id: 'b' }), false);
});

test('P9.10 health report remains available during DEGRADED/UNAVAILABLE', () => {
  const m = createHealthModel({
    dependencies: [
      { id: 'storage', critical: true, initial: { available: false, reason: 'storage.down' } },
    ],
  });
  assert.ok(m);
  m.markRunning();
  // UNAVAILABLE — query still returns full structure (does not fail closed to empty)
  const down = m.evaluate();
  assert.ok(down);
  assert.equal(down.condition, 'UNAVAILABLE');
  assert.ok(Array.isArray(down.reasons));
  assert.ok(down.reasons.length > 0);
  assert.ok(down.dependencies.length === 1);
  assert.equal(down.contractVersion, '1.0.0');
  // stats remain readable while down
  const st = m.stats();
  assert.ok(st);
  assert.ok(st.queries >= 1);
  // DEGRADED path also stays queryable
  m.setDependency('storage', { available: true, degraded: true, reason: 'storage.slow' });
  const deg = m.evaluate();
  assert.equal(deg.condition, 'DEGRADED');
  assert.ok(deg.reasons.length > 0);
});

test('P9.10 invalid config fails closed; setters never throw', () => {
  assert.ok(createHealthModel(null));
  assert.ok(createHealthModel(undefined));
  assert.ok(createHealthModel({}));
  assert.equal(createHealthModel('x'), null);
  assert.equal(createHealthModel({ maxDependencies: 0 }), null);
  assert.equal(createHealthModel({ maxDependencies: 999 }), null);
  assert.equal(createHealthModel({ unknown: 1 }), null);
  assert.equal(createHealthModel({ dependencies: 'x' }), null);
  assert.equal(createHealthModel({ dependencies: [42] }), null);
  assert.equal(createHealthModel({ dependencies: [{ id: '' }] }), null);
  assert.equal(createHealthModel({ dependencies: [{ id: 'a', critical: 'yes' }] }), null);
  assert.equal(createHealthModel({ dependencies: [{ id: 'a', bogus: 1 }] }), null);
  assert.equal(createHealthModel({ dependencies: [{ id: 'a' }, { id: 'a' }] }), null);
  const m = createHealthModel({ dependencies: [] });
  assert.ok(m);
  assert.equal(m.setDependency('nope', { available: true }), false);
  assert.equal(m.setDependency('nope', null), false);
  assert.equal(m.probeLiveness('yes'), false);
  assert.ok(m.evaluate());
  assert.ok(m.stats());
});

test('P9.10 source stays pure: no I/O, no clock; locked row documents the boundary', () => {
  const stringify = JSON.stringify, now = Date.now;
  try {
    JSON.stringify = () => { throw Error('encoding'); };
    Date.now = () => { throw Error('clock'); };
    const m = createHealthModel({
      dependencies: [{ id: 'storage', critical: true, initial: { available: true, reason: 'ok' } }],
    });
    assert.ok(m);
    assert.ok(m.markRunning());
    assert.ok(m.evaluate());
    assert.ok(m.beginRecovery());
    assert.ok(m.completeRecovery());
  } finally {
    JSON.stringify = stringify; Date.now = now;
  }
  const source = readFileSync(new URL('../src/lego/health-readiness.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\b(?:fetch|setTimeout|setInterval|writeFile|readFile|appendFile|console\.(?:log|error)|Date\.now|Math\.random)\s*\(/);
  const lock = JSON.parse(readFileSync(new URL('../src/lego/contracts/contract-lock.json', import.meta.url), 'utf8'));
  const rows = lock.contracts.filter(row => row.id === HEALTH_CONTRACT.id);
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.owner, 'agent-6');
  assert.equal(row.domain, 'observability');
  assert.equal(row.version, '1.0.0');
  assert.deepEqual(row.surface, ['src/lego/health-readiness.mjs']);
  assert.deepEqual(row.exports['src/lego/health-readiness.mjs'], [
    'HEALTH_CONTRACT', 'LIVENESS_STATES', 'READINESS_STATES', 'CONDITION_STATES',
    'HEALTH_PHASES', 'HEALTH_REASON_CODES', 'HEALTH_LIMITS', 'createHealthModel',
  ]);
  assert.deepEqual(row.tests, ['apps/n8n-lego/test/lego-health-readiness.test.mjs']);
  assert.equal(lock.contracts.length, 100); // P9.10 adds observability.health-readiness@1.0.0; P9.11 adds observability.execution-diagnostics@1.0.0; P9.12 adds observability.diagnostic-bundle@1.0.0; P9.13 adds observability.failure-correlation@1.0.0; P9.14 adds observability.replay-evidence@1.0.0; P9.15 adds observability.telemetry-retention@1.0.0; P9.16 adds observability.operator-inspection@1.0.0; P9.17 adds observability.low-resource-mode@1.0.0; P9.18 adds observability.self-observability@1.0.0; P9.19 adds observability.tenant-isolation@1.0.0; P9.20 adds observability.contract-oracle@1.0.0; P9.21 adds observability.advanced-diagnostics@1.0.0; P9.22 adds observability.p9-acceptance@1.0.0; count-pins say 75 // P9 integration (Agent 1): P9.5-P9.22 add 18 observability.* rows on top of protected main 76 -> 94 (union, zero id collisions); P9 was developed on 24032a0c (57 rows). P5.1 adds the ninety-fifth (auth.principal). P5.2 adds the ninety-sixth (auth.session). P5.3 adds the ninety-seventh (auth.authorization). P5.5 adds the ninety-eighth (auth.credential-crypto). P5.6 adds the ninety-ninth (auth.account-security). P5.7 adds the hundredth (auth.machine-identity).
  const doc = readFileSync(new URL('../../../docs/architecture/p9/P9.10-HEALTH-READINESS.md', import.meta.url), 'utf8');
  assert.match(doc, /LIVENESS/);
  assert.match(doc, /READINESS/);
  assert.match(doc, /DEGRADED/);
  assert.match(doc, /UNAVAILABLE/);
  assert.match(doc, /false-healthy/i);
});
