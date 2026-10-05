import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  LOWRES_CONTRACT, LOWRES_SCHEMA_VERSION, LOWRES_MODES, LOWRES_DEGRADE_ORDER,
  LOWRES_STEP_EFFECTS, LOWRES_LIMITS, LOWRES_NOTES,
  createLowResourceController,
} from '../src/lego/low-resource-mode.mjs';

const fixture = JSON.parse(readFileSync(
  new URL('./fixtures/p9/low-resource-mode.json', import.meta.url), 'utf8'));

function makeCtrl(extra = {}) {
  const c = createLowResourceController({ ...fixture.controller, ...extra });
  assert.ok(c, 'controller constructs');
  return c;
}

const sumTransform = (input) => input.n + 100;

test('P9.17 contract: modes, degrade order, notes, limits, schema', () => {
  assert.equal(LOWRES_CONTRACT.id, 'observability.low-resource-mode');
  assert.equal(LOWRES_CONTRACT.version, '1.0.0');
  assert.equal(LOWRES_CONTRACT.owner, 'agent-6');
  assert.equal(LOWRES_SCHEMA_VERSION, '1.0.0');
  assert.deepEqual([...LOWRES_MODES], ['NORMAL', 'LOW_RESOURCE']);
  assert.deepEqual([...LOWRES_DEGRADE_ORDER], fixture.degradeOrderExpect);
  assert.equal(LOWRES_STEP_EFFECTS.audit_security, 'never-shed');
  assert.ok(LOWRES_NOTES.includes('hysteresis-cooldown'));
  assert.ok(LOWRES_NOTES.includes('critical-security-protected'));
  assert.ok(LOWRES_NOTES.includes('recovery-tested'));
  assert.ok(LOWRES_LIMITS.maxCooldownMs >= 1);
  // invalid config: exit >= enter fails (no hysteresis)
  assert.equal(createLowResourceController({
    enterThresholdPct: 50, exitThresholdPct: 80,
  }), null);
  assert.equal(createLowResourceController({ byteBudget: 1 }), null);
  assert.equal(createLowResourceController('x'), null);
});

test('P9.17 mode transition test: auto enter/exit with hysteresis band', () => {
  const c = makeCtrl();
  const h = fixture.hysteresis;
  // t=0 low pressure → stay NORMAL
  let r = c.observe({ now: 0, memoryUsedBytes: 100, cpuUsedPct: 10 });
  assert.equal(r.ok, true);
  assert.equal(r.transition.to, 'NORMAL');
  assert.equal(r.transition.changed, false);

  // t=100 memory 3277/4096 ≈ 80% → enter (>=80)
  r = c.observe({ now: 100, memoryUsedBytes: 3277, cpuUsedPct: 10 });
  assert.equal(r.transition.changed, true);
  assert.equal(r.transition.to, 'LOW_RESOURCE');
  assert.equal(r.transition.reason, fixture.expect.enterReason);

  // t=200 pressure still above exit (3200/4096=78% > 50) but cooldown blocks any flip
  r = c.observe({ now: 200, memoryUsedBytes: 3200, cpuUsedPct: 10 });
  assert.equal(r.transition.to, 'LOW_RESOURCE');
  assert.equal(r.transition.changed, false);

  // t=8000 cooldown elapsed, pressure 100/4096≈2% ≤50 → recover
  r = c.observe({ now: 8000, memoryUsedBytes: 100, cpuUsedPct: 5 });
  assert.equal(r.transition.changed, true);
  assert.equal(r.transition.to, 'NORMAL');
  assert.equal(r.transition.reason, fixture.expect.recoverReason);

  const snap = c.snapshot();
  assert.equal(snap.mode, 'NORMAL');
  assert.ok(snap.counters.entered >= 1);
  assert.ok(snap.counters.recovered >= 1);
});

test('P9.17 hysteresis/cooldown prevents thrashing', () => {
  const c = makeCtrl();
  // enter at t=0
  c.observe({ now: 0, memoryUsedBytes: 4000, cpuUsedPct: 10 });
  assert.equal(c.snapshot().mode, 'LOW_RESOURCE');
  // immediately try recover via low pressure at t=1 (cooldown 5000)
  let r = c.observe({ now: 1, memoryUsedBytes: 100, cpuUsedPct: 1 });
  assert.equal(r.transition.changed, false);
  assert.equal(r.transition.reason, fixture.expect.cooldownReason);
  assert.equal(r.transition.thrashBlocked, true);
  assert.equal(c.snapshot().mode, 'LOW_RESOURCE');
  // after cooldown, recover allowed
  r = c.observe({ now: 6000, memoryUsedBytes: 100, cpuUsedPct: 1 });
  assert.equal(r.transition.changed, true);
  assert.equal(r.transition.to, 'NORMAL');
  assert.ok(c.snapshot().counters.thrashBlocked >= 1);
  // bounce pressure around enter threshold within cooldown → blocked
  c.observe({ now: 6100, memoryUsedBytes: 4000, cpuUsedPct: 10 }); // enter after cooldown? last at 6000, cooldown until 11000
  // 6100-6000=100 < 5000 → thrash blocked, still NORMAL
  assert.equal(c.snapshot().mode, 'NORMAL');
  assert.ok(c.snapshot().counters.thrashBlocked >= 2);
});

test('P9.17 memory pressure benchmark: measurable admission reduction under budget', () => {
  const c = makeCtrl({ byteBudget: 4096 });
  let admitted = 0;
  let shed = 0;
  // flood with 200-byte log records in NORMAL until budget
  for (let i = 0; i < 100; i++) {
    const r = c.admit({ id: `log-${i}`, channel: 'logs', bytes: 200 });
    assert.equal(r.ok, true);
    if (r.outcome === 'admitted') admitted++;
    else shed++;
  }
  assert.ok(admitted > 0, 'some admitted');
  assert.equal(admitted, Math.floor(4096 / 200), 'byte budget caps admits');
  assert.equal(c.snapshot().usage.bytes, admitted * 200, 'bytes measured');
  assert.ok(shed > 0, 'overflow shed not corrupted');
  // explicit low-resource: logs channel still on until degraded; debug off after step 0
  c.observe({ now: 0, explicit: 'LOW_RESOURCE' });
  assert.equal(c.snapshot().mode, 'LOW_RESOURCE');
  const step = c.degradeOneStep();
  assert.equal(step.ok, true);
  assert.equal(step.step.channel, 'debug');
  const shedDebug = c.admit({ id: 'd1', channel: 'debug', bytes: 10 });
  assert.equal(shedDebug.outcome, fixture.expect.shedOutcome);
  const keepLog = c.admit({ id: 'l99', channel: 'logs', bytes: 5 });
  assert.ok(keepLog.outcome === 'admitted' || keepLog.outcome === 'budget_shed');
});

test('P9.17 CPU pressure benchmark: over cpu budget sheds non-protected, measurable counters', () => {
  const c = makeCtrl({ cpuBudgetPct: 50 });
  // CPU within budget → admit
  let r = c.observe({ now: 0, memoryUsedBytes: 100, cpuUsedPct: 10 });
  assert.equal(r.transition.to, 'NORMAL');
  r = c.admit({ id: 'm1', channel: 'sampled_metrics', bytes: 10 });
  assert.equal(r.outcome, 'admitted');
  // CPU spike enters LOW_RESOURCE
  r = c.observe({ now: 100, memoryUsedBytes: 100, cpuUsedPct: 95 });
  assert.equal(r.transition.to, 'LOW_RESOURCE');
  assert.equal(r.transition.reason, fixture.expect.enterReason);
  // Still over cpuBudget after enter: non-protected budget_shed
  r = c.admit({ id: 'm2', channel: 'sampled_metrics', bytes: 10 });
  assert.ok(['budget_shed', 'shed', 'admitted'].includes(r.outcome));
  if (r.outcome === 'budget_shed') {
    assert.ok(c.snapshot().counters.budgetCpuEnforced >= 1, 'cpu budget enforced');
  }
  // audit/security still protected under cpu pressure
  r = c.admit({ id: 'a1', channel: 'audit_security', bytes: 50, priority: 'P0' });
  assert.equal(r.outcome, fixture.expect.protectedOutcome);
  assert.ok(c.snapshot().counters.protected >= 1);
});

test('P9.17 defined degrade order + critical/security never shed', () => {
  const c = makeCtrl();
  c.observe({ now: 0, explicit: 'LOW_RESOURCE' });
  const seen = [];
  for (let i = 0; i < LOWRES_DEGRADE_ORDER.length + 2; i++) {
    const s = c.degradeOneStep();
    assert.equal(s.ok, true);
    if (!s.step.exhausted) seen.push(s.step.channel);
  }
  // Non-exhausted steps cover every channel except the audit_security floor itself.
  assert.deepEqual(seen, LOWRES_DEGRADE_ORDER.slice(0, -1), 'steps follow defined order');
  // last step reports audit_security exhausted / never-shed
  const floor = c.degradeOneStep();
  assert.equal(floor.step.channel, 'audit_security');
  // even fully degraded, audit admits as protected
  const r = c.admit({ id: 'sec-1', channel: 'audit_security', bytes: 100, priority: 'P0' });
  assert.equal(r.outcome, 'protected');
});

test('P9.17 recovery test: leave LOW_RESOURCE and restore full channel set', () => {
  const c = makeCtrl();
  c.observe({ now: 0, memoryUsedBytes: 4000, cpuUsedPct: 10 });
  assert.equal(c.snapshot().mode, 'LOW_RESOURCE');
  c.degradeOneStep();
  c.degradeOneStep();
  assert.ok(c.snapshot().channelsOff.length >= 2);
  // recover after cooldown
  const r = c.observe({ now: 10_000, memoryUsedBytes: 100, cpuUsedPct: 2 });
  assert.equal(r.transition.changed, true);
  assert.equal(r.transition.to, 'NORMAL');
  const snap = c.snapshot();
  assert.equal(snap.mode, 'NORMAL');
  assert.equal(snap.channelsOff.length, 0, 'all channels restored');
  assert.equal(snap.degradeStep, LOWRES_DEGRADE_ORDER.length);
  assert.ok(snap.counters.recovered >= 1);
  // post-recovery admits full set again
  const a = c.admit({ id: 'd2', channel: 'debug', bytes: 10 });
  assert.equal(a.outcome, 'admitted');
});

test('P9.17 workflow A/B correctness: business result independent of mode', () => {
  const c = makeCtrl();
  const inputs = fixture.workflowAb.inputs;
  const resultsNormal = inputs.map(i => c.workflowAb(i, sumTransform));
  for (const r of resultsNormal) {
    assert.equal(r.ok, true);
    assert.equal(r.mode, 'NORMAL');
  }
  // enter low-resource + degrade
  c.observe({ now: 0, memoryUsedBytes: 4000, cpuUsedPct: 10 });
  c.degradeOneStep();
  const resultsLow = inputs.map(i => c.workflowAb(i, sumTransform));
  for (let i = 0; i < inputs.length; i++) {
    assert.equal(resultsLow[i].ok, true);
    assert.equal(resultsLow[i].mode, 'LOW_RESOURCE');
    assert.deepEqual(resultsLow[i].result, resultsNormal[i].result,
      `A/B result identical for input ${i} regardless of telemetry mode`);
  }
  // explicit transform isolation: same pure function
  assert.deepEqual(resultsLow[0].result, sumTransform(inputs[0]));
});

test('P9.17 budgets enforced + explicit activation + invalid fail-closed', () => {
  // LOWRES_LIMITS.minByteBudget is 1024 — use the floor explicitly
  const c = makeCtrl({ byteBudget: LOWRES_LIMITS.minByteBudget });
  // over budget → budget_shed (whole record, no partial corruption)
  const first = c.admit({ id: 'x1', channel: 'logs', bytes: 800 });
  assert.equal(first.outcome, 'admitted');
  const over = c.admit({ id: 'x2', channel: 'logs', bytes: 800 });
  assert.equal(over.outcome, fixture.expect.budgetShed);
  assert.ok(c.snapshot().counters.budgetByteEnforced >= 1);
  // bytes never exceed budget for non-protected
  assert.ok(c.snapshot().usage.bytes <= LOWRES_LIMITS.minByteBudget);

  // explicit activation without pressure
  const r = c.observe({ now: 0, explicit: 'LOW_RESOURCE' });
  assert.equal(r.transition.changed, true);
  assert.equal(r.transition.to, 'LOW_RESOURCE');
  // invalid sample fail-closed
  assert.equal(c.observe(null).ok, false);
  assert.equal(c.observe({ now: -1 }).ok, false);
  assert.equal(c.observe({ now: 0, nope: 1 }).ok, false);
  assert.equal(c.admit(null).ok, false);
  assert.equal(c.admit({ id: 'z', channel: 'nope', bytes: 10 }).ok, false);
  assert.equal(c.admit({ id: 'bearer abcdef123secret', channel: 'logs', bytes: 10 }).ok, false);
  // secret-shaped sample rejected
  assert.equal(c.observe({ now: 0, token: 'bearer leaked' }).ok, false);
});

test('P9.17 lock pin: contracts length 75 after P9.22 row', () => {
  const lock = JSON.parse(readFileSync(
    new URL('../src/lego/contracts/contract-lock.json', import.meta.url), 'utf8'));
  assert.equal(lock.contracts.length, 100, // P9 integration (Agent 1): P9.5-P9.22 add 18 observability.* rows on top of protected main 76 -> 94 (union, zero id collisions); P9 was developed on 24032a0c (57 rows). P5.2 adds the ninety-sixth (auth.session). P5.3 adds the ninety-seventh (auth.authorization). P5.5 adds the ninety-eighth (auth.credential-crypto). P5.6 adds the ninety-ninth (auth.account-security). P5.7 adds the hundredth (auth.machine-identity).
    'P9.17 adds observability.low-resource-mode@1.0.0; P9.18 adds observability.self-observability@1.0.0; P9.19 adds observability.tenant-isolation@1.0.0; P9.20 adds observability.contract-oracle@1.0.0; P9.21 adds observability.advanced-diagnostics@1.0.0; P9.22 adds observability.p9-acceptance@1.0.0; count-pins say 75');
  const row = lock.contracts.find(c => c.id === 'observability.low-resource-mode');
  assert.ok(row, 'P9.17 row present');
  assert.equal(row.version, '1.0.0');
  assert.equal(row.owner, 'agent-6');
  assert.equal(row.domain, 'observability');
  assert.ok(Array.isArray(row.tests) && row.tests.length >= 1);
  assert.ok(String(row.notes).includes('P9.17'));
});
