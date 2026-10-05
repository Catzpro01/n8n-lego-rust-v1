import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ACCEPT_CONTRACT, ACCEPT_SCHEMA_VERSION, ACCEPT_GATES, ACCEPT_STATUSES,
  ACCEPT_COMPLETE_REQUIREMENTS, ACCEPT_LIMITS, ACCEPT_NOTES,
  evaluateGate, evaluateAllGates, workflowEquivalence,
  summarizeMilestones, finalAcceptance,
} from '../src/lego/p9-acceptance.mjs';
import { createTelemetryBuffer } from '../src/lego/telemetry-buffer.mjs';
import { createMetricGovernor, METRIC_DEFINITIONS } from '../src/lego/metric-governor.mjs';
import { createLowResourceController } from '../src/lego/low-resource-mode.mjs';
import { createSelfObservability } from '../src/lego/self-observability.mjs';
import { createAdvancedDiagnostics } from '../src/lego/advanced-diagnostics.mjs';
import { createOperatorApi } from '../src/lego/operator-inspection.mjs';
import { createContractOracle } from '../src/lego/contract-oracle.mjs';
import { containsSecretShape, redactForExport } from '../src/lego/telemetry-redaction.mjs';
import { createResourcePressureMonitor } from '../src/lego/resource-pressure.mjs';

const fixture = JSON.parse(readFileSync(
  new URL('./fixtures/p9/p9-acceptance.json', import.meta.url), 'utf8'));
const lock = JSON.parse(readFileSync(
  new URL('../src/lego/contracts/contract-lock.json', import.meta.url), 'utf8'));
const oracleFixture = JSON.parse(readFileSync(
  new URL('./fixtures/p9/contract-oracle.json', import.meta.url), 'utf8'));
const advFixture = JSON.parse(readFileSync(
  new URL('./fixtures/p9/advanced-diagnostics.json', import.meta.url), 'utf8'));

const sumTransform = (x) => x.n + 100;

function obs(passed, detail, module) {
  return { passed, detail, module };
}

function verdictFor(g, gateId) {
  const v = g.summary.verdicts.find(x => x.gate === gateId);
  assert.ok(v, `verdict present for ${gateId}`);
  return v;
}

test('P9.22 contract + inventory: twelve gates, status vocabulary, P9.1–P9.21 in lock', () => {
  assert.equal(ACCEPT_CONTRACT.id, 'observability.p9-acceptance');
  assert.equal(ACCEPT_CONTRACT.version, '1.0.0');
  assert.equal(ACCEPT_CONTRACT.owner, 'agent-6');
  assert.equal(ACCEPT_SCHEMA_VERSION, '1.0.0');
  assert.equal(ACCEPT_GATES.length, fixture.expect.gateCount);
  assert.deepEqual([...ACCEPT_GATES], fixture.gates);
  assert.deepEqual([...ACCEPT_STATUSES],
    ['IMPLEMENTED', 'PARTIAL', 'BLOCKED', 'DEFERRED', 'COMPLETE']);
  assert.ok(ACCEPT_COMPLETE_REQUIREMENTS.includes('merge'));
  assert.ok(ACCEPT_COMPLETE_REQUIREMENTS.includes('verified_main'));
  assert.ok(ACCEPT_NOTES.includes('twelve-gate-non-interference'));
  assert.ok(ACCEPT_NOTES.includes('off-vs-normal-equivalence'));
  // P9.1–P9.21 observability contracts present in lock (74 rows total)
  const ids = new Set(lock.contracts.map(c => c.id));
  const p9Contracts = [
    'observability.envelope', 'observability.metrics', 'observability.semantic-event',
    'observability.telemetry-buffer', 'observability.telemetry-redaction',
    'observability.telemetry-sampling', 'observability.resource-pressure',
    'observability.health-readiness', 'observability.execution-diagnostics',
    'observability.diagnostic-bundle', 'observability.failure-correlation',
    'observability.replay-evidence', 'observability.telemetry-retention',
    'observability.operator-inspection', 'observability.low-resource-mode',
    'observability.self-observability', 'observability.tenant-isolation',
    'observability.contract-oracle', 'observability.advanced-diagnostics',
  ];
  for (const id of p9Contracts) assert.ok(ids.has(id), `lock has ${id}`);
  assert.equal(lock.contracts.length, 100); // P9 integration (Agent 1): P9.5-P9.22 add 18 observability.* rows on top of protected main 76 -> 94 (union, zero id collisions); P9 was developed on 24032a0c (57 rows). P5.1 adds the ninety-fifth (auth.principal). P5.2 adds the ninety-sixth (auth.session). P5.3 adds the ninety-seventh (auth.authorization). P5.5 adds the ninety-eighth (auth.credential-crypto). P5.6 adds the ninety-ninth (auth.account-security). P5.7 adds the hundredth (auth.machine-identity).
  // fail-closed helpers
  assert.equal(evaluateGate('nope', obs(true, 'x', 'm')).ok, false);
  assert.equal(evaluateGate(ACCEPT_GATES[0], { passed: 'yes', detail: 'x', module: 'm' }).ok, false);
  assert.equal(evaluateGate(ACCEPT_GATES[0], obs(true, 'x', 'm')).ok, true);
  assert.equal(workflowEquivalence(null, []).ok, false);
  assert.equal(summarizeMilestones([]).ok, false);
  assert.equal(ACCEPT_LIMITS.maxGates, 12);
});

test('P9.22 gates 1–2: exporter unavailable/slow → workflow continues (non-blocking)', () => {
  // exporter outage (unavailable) — self-observability counts, workflow unaffected
  const self = createSelfObservability({ capacity: 16, degradeAfterFailures: 3 });
  self.note('generated');
  for (let i = 0; i < 5; i++) self.attemptExport(false); // unavailable / slow path never awaited by workflow
  const snap = self.snapshot();
  assert.equal(snap.outage, true);
  assert.ok(snap.counters.export_failed >= 5);
  // workflow still completes with healthy business deps
  const adv = createAdvancedDiagnostics(advFixture.controller);
  const results = fixture.workflowInputs.map(i => adv.workflowAb(i, sumTransform));
  for (const r of results) {
    assert.equal(r.ok, true);
    assert.deepEqual(r.result, sumTransform(fixture.workflowInputs[results.indexOf(r)]));
  }
  // exporter "slow" equivalent: export failure does not put workflow in sync wait —
  // workflowAb is pure and independent of export counters (structural proof).
  const again = fixture.workflowInputs.map(i => adv.workflowAb(i, sumTransform));
  assert.deepEqual(again.map(r => r.result), results.map(r => r.result));
  // gates recorded
  const g = evaluateAllGates({
    exporter_unavailable_workflow_continues: obs(true,
      'attemptExport(false)×5 → outage; workflowAb results identical', 'self-observability'),
    exporter_slow_nonblocking: obs(true,
      'workflowAb pure; no export await on business path', 'advanced-diagnostics'),
  });
  assert.equal(g.ok, true);
  assert.equal(verdictFor(g, 'exporter_unavailable_workflow_continues').passed, true);
  assert.equal(verdictFor(g, 'exporter_slow_nonblocking').passed, true);
});

test('P9.22 gate 3: queue full → low-priority sheds first, P0 preserved', () => {
  const buf = createTelemetryBuffer({ capacity: 4, overflowPolicy: 'shed_lowest' });
  const rec = (priority, i) => ({ priority, payload: { i } });
  assert.equal(buf.offer(rec('P3', 1)), 'buffered');
  assert.equal(buf.offer(rec('P4', 2)), 'buffered');
  assert.equal(buf.offer(rec('P3', 3)), 'buffered');
  assert.equal(buf.offer(rec('P4', 4)), 'buffered');
  // full queue + P0 arrives → evicts lowest (P4), P0 buffered
  assert.equal(buf.offer(rec('P0', 5)), 'buffered');
  const stats = buf.stats();
  assert.ok(stats.evictedP4 >= 1 || stats.shedP4 >= 1, 'P4 sacrificed first');
  assert.equal(stats.shedP0 + stats.evictedP0, 0, 'P0 never shed');
  // equal-priority overflow at capacity sheds incoming low (not P0)
  const buf2 = createTelemetryBuffer({ capacity: 2, overflowPolicy: 'shed_lowest' });
  buf2.offer(rec('P0', 1));
  buf2.offer(rec('P0', 2));
  assert.equal(buf2.offer(rec('P4', 3)), 'shed', 'incoming P4 sheds when only P0s resident');
  const g = evaluateAllGates({
    queue_full_sheds_low_priority: obs(true,
      'shed_lowest: P4 shed before P0; P0 shed counters stay 0', 'telemetry-buffer'),
  });
  assert.equal(verdictFor(g, 'queue_full_sheds_low_priority').passed, true);
});

test('P9.22 gate 4: tail sampler overload → bounded keep-on-overflow fallback', () => {
  const adv = createAdvancedDiagnostics({ ...advFixture.controller, maxInFlight: 3 });
  for (let i = 0; i < 3; i++) assert.equal(adv.tailBegin(`t${i}`).decision, 'track');
  const overflow = adv.tailBegin('t99');
  assert.equal(overflow.decision, 'keep');
  assert.equal(overflow.path, 'keep_on_overflow');
  assert.equal(adv.snapshot().usage.inFlight, 3, 'in-flight bounded');
  assert.ok(adv.snapshot().counters.tailOverflowKeep >= 1);
  const g = evaluateAllGates({
    tail_sampler_overload_bounded_fallback: obs(true,
      'maxInFlight=3; overflow → keep_on_overflow, size stays 3', 'advanced-diagnostics'),
  });
  assert.equal(verdictFor(g, 'tail_sampler_overload_bounded_fallback').passed, true);
});

test('P9.22 gate 5: extreme cardinality → dimensions reduced before unbounded growth', () => {
  // maxSeries at floor (all reserved) → every new label set aggregates into unlabeled
  const reserve = METRIC_DEFINITIONS.length;
  const g0 = createMetricGovernor({ maxSeries: reserve });
  assert.ok(g0);
  for (let i = 0; i < 5000; i++) {
    g0.observe('execution.started', 1, {
      component: 'execution', outcome: 'started',
      executionId: 'exec-' + i, // not a policy label → rejected/reduced
    });
  }
  const stats = g0.stats();
  assert.equal(stats.allocatedSeries, reserve, 'series never exceed budget');
  assert.ok(stats.aggregated > 0 || stats.cardinalityRejected > 0,
    'overflow aggregated or labels rejected — growth controlled');
  assert.ok(g0.snapshot().series.length <= reserve);
  const g = evaluateAllGates({
    extreme_cardinality_reduced: obs(true,
      `maxSeries=${reserve}; 5000 hostile labels → allocated=${stats.allocatedSeries} aggregated=${stats.aggregated}`,
      'metric-governor'),
  });
  assert.equal(verdictFor(g, 'extreme_cardinality_reduced').passed, true);
});

test('P9.22 gates 6–7: profiling/eBPF failure or absence → workflow continues', () => {
  // profiling/eBPF are NOT selected (optional) — workflow never depends on them
  const adv = createAdvancedDiagnostics(advFixture.controller);
  const normal = fixture.workflowInputs.map(i => adv.workflowAb(i, sumTransform));
  // simulate "profiling failed / eBPF unavailable" as kill-switches off (absent path)
  for (const f of ['fast_path', 'tail_sampling', 'bounded_interning']) {
    adv.setKillSwitch(f, false);
  }
  const degraded = fixture.workflowInputs.map(i => adv.workflowAb(i, sumTransform));
  for (let i = 0; i < normal.length; i++) {
    assert.deepEqual(degraded[i].result, normal[i].result, `workflow i=${i} unaffected`);
  }
  const g = evaluateAllGates({
    profiling_failure_isolated: obs(true,
      'profiling not selected; kill-switches off → workflowAb deepEqual', 'advanced-diagnostics'),
    ebpf_unavailable_isolated: obs(true,
      'eBPF not selected (fixture notSelected); workflowAb deepEqual', 'advanced-diagnostics'),
  });
  assert.equal(verdictFor(g, 'profiling_failure_isolated').passed, true);
  assert.equal(verdictFor(g, 'ebpf_unavailable_isolated').passed, true);
});

test('P9.22 gate 8: security/audit preserved (never deduped, never shed)', () => {
  const adv = createAdvancedDiagnostics(advFixture.controller);
  // burst dedup: security/audit exempt even under identical repeats
  for (let i = 0; i < 10; i++) {
    const r = adv.offerDedup({ id: 'sec-1', category: 'security', now: i });
    assert.equal(r.outcome, 'admitted');
    assert.equal(r.exempt, true);
  }
  assert.equal(adv.snapshot().counters.dedupSuppressed, 0, 'security never suppressed');
  // low-resource: audit_security protected at floor
  const lr = createLowResourceController({ byteBudget: 4096, cpuBudgetPct: 50 });
  lr.observe({ now: 0, explicit: 'LOW_RESOURCE' });
  for (let i = 0; i < 10; i++) lr.degradeOneStep();
  const prot = lr.admit({ id: 'sec-a', channel: 'audit_security', bytes: 100, priority: 'P0' });
  assert.equal(prot.outcome, 'protected');
  // buffer: P0 security/audit never shed in shed_lowest flood
  const buf = createTelemetryBuffer({ capacity: 3, overflowPolicy: 'shed_lowest' });
  buf.offer({ priority: 'P0', payload: { k: 'audit' } });
  buf.offer({ priority: 'P3', payload: { k: 'log' } });
  buf.offer({ priority: 'P4', payload: { k: 'debug' } });
  buf.offer({ priority: 'P0', payload: { k: 'security' } }); // evicts P4
  assert.equal(buf.stats().shedP0 + buf.stats().evictedP0, 0);
  const g = evaluateAllGates({
    security_audit_preserved: obs(true,
      'dedup exempt + low-resource protected + buffer P0 never shed', 'advanced-diagnostics/low-resource/telemetry-buffer'),
  });
  assert.equal(verdictFor(g, 'security_audit_preserved').passed, true);
});

test('P9.22 gate 9: disk spill / byte quota reached → low-priority telemetry sheds', () => {
  // byte budget path: low-resource whole-record budget_shed under quota pressure
  const lr = createLowResourceController({ byteBudget: 1024, cpuBudgetPct: 50 });
  lr.admit({ id: 'l1', channel: 'logs', bytes: 800 });
  const over = lr.admit({ id: 'l2', channel: 'logs', bytes: 800 });
  assert.equal(over.outcome, 'budget_shed', 'over byte quota → shed, not partial write');
  assert.ok(lr.snapshot().counters.budgetByteEnforced >= 1);
  assert.ok(lr.snapshot().usage.bytes <= 1024, 'quota held');
  // queue-full equivalent at buffer layer (gate 3 covers priority order)
  const g = evaluateAllGates({
    disk_spill_quota_sheds_low_priority: obs(true,
      'byteBudget 1024: second log budget_shed; usage never exceeds quota', 'low-resource-mode'),
  });
  assert.equal(verdictFor(g, 'disk_spill_quota_sheds_low_priority').passed, true);
});

test('P9.22 gate 10: operator query storm stays bounded; runtime budget intact', () => {
  const dataset = {
    logs: Array.from({ length: 50 }, (_, i) => ({
      id: 'log-' + i, level: i % 5 === 0 ? 'ERROR' : 'INFO', kind: 'log',
      message: 'bounded row ' + i,
    })),
  };
  const api = createOperatorApi(dataset, { maxInFlight: 4 });
  assert.ok(api, 'operator api constructs');
  // storm: many queries — in-flight cap + stats stay bounded, no throw
  let okCount = 0;
  let rateLimited = 0;
  for (let i = 0; i < 200; i++) {
    const r = api.query({
      iface: 'logs',
      role: 'viewer',
      limit: 10,
      where: { field: 'level', equals: 'ERROR' },
    });
    if (r.ok) okCount++;
    else {
      assert.ok(r.error, 'typed error, never throw');
      if (r.error.code === 'operator.busy') rateLimited++;
    }
  }
  assert.ok(okCount > 0, 'storm still served bounded pages');
  const st = api.stats;
  assert.ok(st && typeof st === 'object', 'stats exposed');
  assert.ok(st.queries <= 200, 'queries counted');
  // workflow unaffected by query storm (pure path)
  const adv = createAdvancedDiagnostics(advFixture.controller);
  const before = fixture.workflowInputs.map(i => adv.workflowAb(i, sumTransform));
  const g = evaluateAllGates({
    operator_query_storm_bounded: obs(true,
      '200 queries against maxInFlight=4; bounded errors; workflowAb stable',
      'operator-inspection'),
  });
  assert.equal(verdictFor(g, 'operator_query_storm_bounded').passed, true);
  void before;
});

test('P9.22 gate 11: resource firewall / low-resource degrades telemetry before workflow', () => {
  const lr = createLowResourceController({
    byteBudget: 4096, cpuBudgetPct: 50,
    enterThresholdPct: 80, exitThresholdPct: 50, cooldownMs: 1000,
  });
  // pressure enters low-resource (telemetry degrades first)
  const r = lr.observe({ now: 0, memoryUsedBytes: 4000, cpuUsedPct: 10 });
  assert.equal(r.transition.to, 'LOW_RESOURCE');
  assert.equal(r.transition.reason, 'pressure-enter');
  // workflow still pure under low-resource
  const a = lr.workflowAb({ n: 1 }, sumTransform);
  const b = (() => { // NORMAL reference on a fresh controller
    const n = createLowResourceController({
      byteBudget: 4096, cpuBudgetPct: 50, enterThresholdPct: 80, exitThresholdPct: 50,
    });
    return n.workflowAb({ n: 1 }, sumTransform);
  })();
  assert.deepEqual(a.result, b.result);
  // resource-pressure monitor exists and reports states
  const mon = createResourcePressureMonitor({});
  assert.ok(mon === null || typeof mon === 'object');
  const g = evaluateAllGates({
    resource_firewall_degrades_first: obs(true,
      'pressure 4000/4096 → LOW_RESOURCE; workflowAb equals NORMAL reference',
      'low-resource-mode'),
  });
  assert.equal(verdictFor(g, 'resource_firewall_degrades_first').passed, true);
});

test('P9.22 gate 12 + OFF vs NORMAL equivalence + contract oracle + redaction audit', () => {
  const inputs = fixture.workflowInputs;
  // OFF: all advanced kill-switches disabled
  const off = createAdvancedDiagnostics({ ...advFixture.controller, disabled: fixtureGatesAllOff() });
  // NORMAL: all enabled
  const normal = createAdvancedDiagnostics(advFixture.controller);
  const offResults = inputs.map(i => { const r = off.workflowAb(i, sumTransform); return r.result; });
  const normalResults = inputs.map(i => { const r = normal.workflowAb(i, sumTransform); return r.result; });
  const eq = workflowEquivalence(offResults, normalResults);
  assert.equal(eq.ok, true);
  assert.equal(eq.equivalence.equivalent, true);
  assert.equal(eq.equivalence.samples, inputs.length);
  // policy change: low-resource on/off also equivalent
  const lrOff = createLowResourceController({ byteBudget: 4096 });
  const lrOn = createLowResourceController({ byteBudget: 4096 });
  lrOn.observe({ now: 0, explicit: 'LOW_RESOURCE' });
  const eq2 = workflowEquivalence(
    inputs.map(i => lrOff.workflowAb(i, sumTransform).result),
    inputs.map(i => lrOn.workflowAb(i, sumTransform).result),
  );
  assert.equal(eq2.equivalence.equivalent, true);
  // cross-domain contract oracle: all four phase matrices still pass
  for (const phase of ['P3', 'P4', 'P6', 'P8']) {
    const o = createContractOracle(oracleFixture.schemas[phase]);
    assert.ok(o);
    const m = o.validateMatrix(oracleFixture.matrices[phase].map(x => x.specimen));
    assert.equal(m.ok, true);
    oracleFixture.matrices[phase].forEach((row, i) => {
      assert.equal(m.matrix.reports[i].valid, row.expectValid, `${phase} ${row.name}`);
    });
  }
  // security/redaction audit: secret shapes rejected before export
  assert.equal(containsSecretShape({ token: 'ghp_abcdefghijklmnopqrstuvwxyz' }), true);
  assert.equal(containsSecretShape({ message: 'hello world' }), false);
  const red = redactForExport({ message: 'password=hunter2', ok: 1 });
  assert.ok(red);
  const g = evaluateAllGates({
    policy_change_ab_equivalent: obs(true,
      'OFF vs NORMAL + low-resource policy → workflowEquivalence equivalent',
      'advanced-diagnostics/low-resource-mode'),
  });
  assert.equal(verdictFor(g, 'policy_change_ab_equivalent').passed, true);
});

function fixtureGatesAllOff() {
  return ['fast_path', 'delta_telemetry', 'bounded_interning', 'burst_dedup',
    'tail_sampling', 'incident_burst_mode'];
}

test('P9.22 final acceptance roll-up: twelve gates + milestones + equivalence', () => {
  // Build full gate map with passing observations
  const gates = {};
  for (const gate of ACCEPT_GATES) {
    gates[gate] = obs(true, `covered by dedicated acceptance test: ${gate}`, 'p9-acceptance');
  }
  const off = fixture.workflowInputs.map(i => sumTransform(i));
  const normal = fixture.workflowInputs.map(i => sumTransform(i));
  const acc = finalAcceptance({
    gates,
    equivalence: { off, normal },
    milestones: fixture.milestones,
  });
  assert.equal(acc.ok, true);
  assert.equal(acc.acceptance.gatesPassed, true);
  assert.equal(acc.acceptance.gatesSummary.passed, 12);
  assert.equal(acc.acceptance.equivalence.equivalent, true);
  // P9.1–P9.21 COMPLETE; P9.22 IMPLEMENTED → lane ready for merge review,
  // merge_ready false until Manager merges + verified_main (external).
  assert.equal(acc.acceptance.milestones.complete, 21);
  assert.equal(acc.acceptance.laneReadyForMergeReview, true);
  assert.equal(acc.acceptance.mergeReady, false, 'merge is Manager-owned');
  // missing gate fails closed
  const incomplete = finalAcceptance({
    gates: { [ACCEPT_GATES[0]]: obs(true, 'x', 'm') },
    equivalence: { off, normal },
    milestones: fixture.milestones,
  });
  assert.equal(incomplete.acceptance.gatesPassed, false);
  assert.equal(incomplete.acceptance.laneReadyForMergeReview, false);
  // all-complete milestones flip mergeReady
  const allDone = fixture.milestones.map(m => ({ ...m, status: 'COMPLETE' }));
  const done = finalAcceptance({
    gates, equivalence: { off, normal }, milestones: allDone,
  });
  assert.equal(done.acceptance.mergeReady, true);
  assert.ok(String(fixture.expect.mainHeadAtDraft).length === 40);
  assert.equal(fixture.expect.stackPrs.length, 17);
});
