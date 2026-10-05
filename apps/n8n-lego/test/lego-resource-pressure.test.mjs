import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  RESOURCE_PRESSURE_CONTRACT, PRESSURE_STATES, VALUE_PROVENANCE, RESOURCE_DIMENSIONS,
  DEGRADATION_LEVELS, PRESSURE_LIMITS, DEFAULT_PRESSURE_THRESHOLDS,
  createResourcePressureMonitor,
} from '../src/lego/resource-pressure.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/p9/resource-pressure.json', import.meta.url), 'utf8'));

test('P9.9 contract, pressure states, provenance ladder, dimensions', () => {
  assert.equal(RESOURCE_PRESSURE_CONTRACT.id, 'observability.resource-pressure');
  assert.equal(RESOURCE_PRESSURE_CONTRACT.version, '1.0.0');
  assert.equal(RESOURCE_PRESSURE_CONTRACT.owner, 'agent-6');
  assert.deepEqual([...PRESSURE_STATES], fixture.states);
  assert.deepEqual([...PRESSURE_STATES], ['NORMAL', 'PRESSURED', 'CONSTRAINED', 'CRITICAL', 'UNKNOWN']);
  assert.deepEqual([...VALUE_PROVENANCE], fixture.provenance);
  assert.deepEqual([...RESOURCE_DIMENSIONS], fixture.dimensions);
  for (const dim of ['cpu', 'memory', 'disk', 'network']) {
    assert.ok(RESOURCE_DIMENSIONS.includes(dim), dim);
    assert.ok(DEFAULT_PRESSURE_THRESHOLDS[dim]);
  }
  assert.equal(DEGRADATION_LEVELS.NORMAL, 0);
  assert.equal(DEGRADATION_LEVELS.PRESSURED, 1);
  assert.equal(DEGRADATION_LEVELS.CONSTRAINED, 2);
  assert.equal(DEGRADATION_LEVELS.CRITICAL, 3);
  assert.equal(DEGRADATION_LEVELS.UNKNOWN, 0);
});

test('P9.9 resource fixtures: levels from policy thresholds', () => {
  const m = createResourcePressureMonitor({ historySize: 64 });
  assert.ok(m);
  for (const row of fixture.resourceFixtures) {
    const { expectLevel, ...reading } = row;
    const out = m.recordReading(reading);
    assert.ok(out, JSON.stringify(row));
    assert.equal(out.reading.level, expectLevel, `${row.dimension}=${row.value}`);
    assert.equal(out.reading.provenance, row.provenance);
    assert.ok(PRESSURE_STATES.includes(out.state));
  }
});

test('P9.9 observed vs estimated vs reported are distinguishable; fabricated provenance rejected', () => {
  const m = createResourcePressureMonitor();
  assert.ok(m);
  const obs = m.recordReading({ dimension: 'cpu', value: 0.4, provenance: 'OBSERVED' });
  const est = m.recordReading({ dimension: 'memory', value: 0.4, provenance: 'ESTIMATED' });
  const rep = m.recordReading({ dimension: 'queueDepth', value: 10, provenance: 'REPORTED' });
  assert.ok(obs && est && rep);
  assert.equal(obs.reading.provenance, 'OBSERVED');
  assert.equal(est.reading.provenance, 'ESTIMATED');
  assert.equal(rep.reading.provenance, 'REPORTED');
  const snap = m.latestSnapshot();
  assert.equal(snap.cpu.provenance, 'OBSERVED');
  assert.equal(snap.memory.provenance, 'ESTIMATED');
  assert.equal(snap.queueDepth.provenance, 'REPORTED');
  assert.equal(snap.disk, null);
  // fabrications rejected — REPORTED only when caller actually provides it
  for (const bad of fixture.provenanceMatrix.fabricatedRejected) {
    const out = m.recordReading({ dimension: 'cpu', value: 0.5, provenance: bad });
    assert.equal(out, null, String(bad));
  }
  assert.ok(m.stats().readingsRejected >= fixture.provenanceMatrix.fabricatedRejected.length);
});

test('P9.9 pressure transition test: state + degradation ladder', () => {
  const m = createResourcePressureMonitor({ historySize: 128 });
  assert.ok(m);
  for (const step of fixture.pressureTransitions) {
    for (const r of step.seq) {
      const out = m.recordReading(r);
      assert.ok(out, JSON.stringify(r));
    }
    const ev = m.evaluate();
    assert.equal(ev.state, step.expectState, JSON.stringify(step.seq));
    assert.equal(ev.degradation, step.expectDegradation, step.expectState);
    assert.equal(ev.degradation, DEGRADATION_LEVELS[step.expectState]);
  }
  // Transitions were recorded (NORMAL → … → NORMAL path has multiple changes)
  assert.ok(m.stats().transitions >= 3);
  assert.ok(m.stats().peakDegradation >= 3);
  const lt = m.stats().lastTransition;
  assert.ok(lt);
  assert.ok(PRESSURE_STATES.includes(lt.from));
  assert.ok(PRESSURE_STATES.includes(lt.to));
});

test('P9.9 thresholds are policy-driven (setThresholds changes classification)', () => {
  const m = createResourcePressureMonitor({ historySize: 32 });
  assert.ok(m);
  // Under defaults, 0.55 memory is NORMAL
  m.recordReading({ dimension: 'memory', value: 0.55, provenance: 'OBSERVED' });
  assert.equal(m.evaluate().state, 'NORMAL');
  // Tighter policy → PRESSURED (memory thresholds only; fixture.note stripped)
  assert.equal(m.setThresholds({ memory: fixture.policyThresholds.memory }), true);
  assert.equal(m.evaluate().state, 'PRESSURED');
  // Invalid policy rejected, state unchanged
  assert.equal(m.setThresholds({ memory: { warn: 0.9, high: 0.5, critical: 0.1 } }), false);
  assert.equal(m.setThresholds({ nope: {} }), false);
  assert.equal(m.evaluate().state, 'PRESSURED');
});

test('P9.9 pressure changes drive degradation hook (P9 boundary signal)', () => {
  const seen = [];
  const m = createResourcePressureMonitor({
    historySize: 16,
    degradationHook: (t) => { seen.push(t); },
  });
  assert.ok(m);
  m.recordReading({ dimension: 'cpu', value: 0.97, provenance: 'OBSERVED' });
  assert.ok(seen.length >= 1);
  assert.equal(seen[0].to, 'CRITICAL');
  assert.equal(seen[0].degradation, 3);
  m.recordReading({ dimension: 'cpu', value: 0.1, provenance: 'OBSERVED' });
  assert.ok(seen.some(t => t.to === 'NORMAL' && t.degradation === 0));
  // Hook throwing must not break monitor
  const m2 = createResourcePressureMonitor({
    degradationHook: () => { throw Error('hook boom'); },
  });
  assert.ok(m2);
  assert.ok(m2.recordReading({ dimension: 'cpu', value: 0.97, provenance: 'OBSERVED' }));
});

test('P9.9 collector failure test: fails safely to UNKNOWN', () => {
  const m = createResourcePressureMonitor({
    historySize: 8,
    collector: () => { throw Error('provider down'); },
  });
  assert.ok(m);
  const out = m.collect();
  assert.ok(out);
  assert.equal(out.error, true);
  assert.equal(out.state, 'UNKNOWN');
  assert.equal(m.stats().collectorFailures, 1);
  const ev = m.evaluate();
  assert.equal(ev.state, 'UNKNOWN');
  assert.equal(ev.collectorFailure, true);
  // Recovery: reading resets UNKNOWN path
  const back = m.recordReading({ dimension: 'memory', value: 0.2, provenance: 'OBSERVED' });
  assert.ok(back);
  assert.equal(back.state, 'NORMAL');
  // evaluate with still-broken collector returns failure snapshot without throw
  const ev2 = m.evaluate();
  assert.ok(ev2);
  assert.ok(['UNKNOWN', 'NORMAL', 'PRESSURED', 'CONSTRAINED', 'CRITICAL'].includes(ev2.state));
});

test('P9.9 unbounded guard: resource readings never grow history past cap', () => {
  const m = createResourcePressureMonitor({ historySize: fixture.unboundedGuard.historySize });
  assert.ok(m);
  for (let i = 0; i < fixture.unboundedGuard.readings; i++) {
    const ok = m.recordReading({ dimension: 'cpu', value: (i % 100) / 100, provenance: 'OBSERVED' });
    assert.ok(ok);
  }
  const st = m.stats();
  assert.equal(st.historyCount, fixture.unboundedGuard.expectHistoryCount);
  assert.equal(st.historyCount, st.historySize);
  assert.ok(st.historyOverflowDrops > 0);
  assert.equal(m.historySnapshot().length, fixture.unboundedGuard.expectHistoryCount);
  // invalid readings rejected without growing anything
  const before = m.stats().historyCount;
  assert.equal(m.recordReading(null), null);
  assert.equal(m.recordReading({ dimension: 'evil', value: 1, provenance: 'OBSERVED' }), null);
  assert.equal(m.recordReading({ dimension: 'cpu', value: -1, provenance: 'OBSERVED' }), null);
  assert.equal(m.recordReading({ dimension: 'cpu', value: NaN, provenance: 'OBSERVED' }), null);
  assert.equal(m.stats().historyCount, before);
});

test('P9.9 low-resource environment test: critical flood under tiny history', () => {
  const cfg = fixture.lowResource;
  const m = createResourcePressureMonitor({
    historySize: cfg.historySize,
    degradationHook: () => {}, // pressure can drive degradation without alloc growth
  });
  assert.ok(m);
  for (let i = 0; i < cfg.floodReadings; i++) {
    m.recordReading({
      dimension: i % 2 === 0 ? 'memory' : 'cpu',
      value: 0.97,
      provenance: 'OBSERVED',
    });
  }
  m.recordReading(cfg.critical);
  const st = m.stats();
  const ev = m.evaluate();
  assert.equal(st.historyCount, cfg.expectHistoryMax);
  assert.ok(st.historyOverflowDrops > 0);
  assert.equal(ev.state, 'CRITICAL');
  assert.equal(ev.degradation, 3);
  assert.equal(st.peakDegradation, 3);
  // Bounded: history + latest dims only — no unbounded queues in stats
  assert.ok(st.dimensionsTracked <= RESOURCE_DIMENSIONS.length);
  assert.ok(st.readingsAccepted >= cfg.floodReadings);
});

test('P9.9 invalid config fails closed; record/evaluate never throw', () => {
  // null/undefined config → defaults (allowed)
  assert.ok(createResourcePressureMonitor(null));
  assert.ok(createResourcePressureMonitor(undefined));
  assert.ok(createResourcePressureMonitor({}));
  // invalid shapes
  assert.equal(createResourcePressureMonitor('x'), null);
  assert.equal(createResourcePressureMonitor(42), null);
  assert.equal(createResourcePressureMonitor({ historySize: 0 }), null);
  assert.equal(createResourcePressureMonitor({ historySize: 99999 }), null);
  assert.equal(createResourcePressureMonitor({ historySize: 1.5 }), null);
  assert.equal(createResourcePressureMonitor({ unknown: true }), null);
  assert.equal(createResourcePressureMonitor({ thresholds: 'x' }), null);
  assert.equal(createResourcePressureMonitor({ thresholds: { bogus: {} } }), null);
  assert.equal(createResourcePressureMonitor({ thresholds: { cpu: { warn: 2, high: 1, critical: 0 } } }), null);
  assert.equal(createResourcePressureMonitor({ collector: 'not-a-fn' }), null);
  assert.equal(createResourcePressureMonitor({ degradationHook: 123 }), null);
  const m = createResourcePressureMonitor();
  assert.ok(m);
  // hostile inputs never throw
  for (const bad of [undefined, null, 42, 's', [], { dimension: 'cpu' }, { dimension: 'cpu', value: 'high', provenance: 'OBSERVED' }]) {
    const out = m.recordReading(bad);
    assert.ok(out === null || typeof out === 'object');
  }
  assert.ok(m.evaluate());
  assert.ok(m.historySnapshot());
  assert.ok(m.latestSnapshot());
  assert.ok(m.stats());
});

test('P9.9 source stays pure: no I/O, no clock; locked row documents the boundary', () => {
  const stringify = JSON.stringify, now = Date.now;
  try {
    JSON.stringify = () => { throw Error('encoding'); };
    Date.now = () => { throw Error('clock'); };
    const m = createResourcePressureMonitor({ historySize: 4 });
    assert.ok(m);
    assert.ok(m.recordReading({ dimension: 'cpu', value: 0.5, provenance: 'OBSERVED' }));
    assert.ok(m.evaluate());
  } finally {
    JSON.stringify = stringify; Date.now = now;
  }
  const source = readFileSync(new URL('../src/lego/resource-pressure.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\b(?:fetch|setTimeout|setInterval|writeFile|readFile|appendFile|console\.(?:log|error)|Date\.now|Math\.random)\s*\(/);
  const lock = JSON.parse(readFileSync(new URL('../src/lego/contracts/contract-lock.json', import.meta.url), 'utf8'));
  const rows = lock.contracts.filter(row => row.id === RESOURCE_PRESSURE_CONTRACT.id);
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.owner, 'agent-6');
  assert.equal(row.domain, 'observability');
  assert.equal(row.version, '1.0.0');
  assert.deepEqual(row.surface, ['src/lego/resource-pressure.mjs']);
  assert.deepEqual(row.exports['src/lego/resource-pressure.mjs'], [
    'RESOURCE_PRESSURE_CONTRACT', 'PRESSURE_STATES', 'VALUE_PROVENANCE',
    'RESOURCE_DIMENSIONS', 'DEGRADATION_LEVELS', 'PRESSURE_LIMITS',
    'DEFAULT_PRESSURE_THRESHOLDS', 'createResourcePressureMonitor',
  ]);
  assert.deepEqual(row.tests, ['apps/n8n-lego/test/lego-resource-pressure.test.mjs']);
  assert.equal(lock.contracts.length, 100); // P9.9 adds observability.resource-pressure@1.0.0; P9.10 adds observability.health-readiness@1.0.0; P9.11 adds observability.execution-diagnostics@1.0.0; P9.12 adds observability.diagnostic-bundle@1.0.0; P9.13 adds observability.failure-correlation@1.0.0; P9.14 adds observability.replay-evidence@1.0.0; P9.15 adds observability.telemetry-retention@1.0.0; P9.16 adds observability.operator-inspection@1.0.0; P9.17 adds observability.low-resource-mode@1.0.0; P9.18 adds observability.self-observability@1.0.0; P9.19 adds observability.tenant-isolation@1.0.0; P9.20 adds observability.contract-oracle@1.0.0; P9.21 adds observability.advanced-diagnostics@1.0.0; P9.22 adds observability.p9-acceptance@1.0.0; count-pins say 75 // P9 integration (Agent 1): P9.5-P9.22 add 18 observability.* rows on top of protected main 76 -> 94 (union, zero id collisions); P9 was developed on 24032a0c (57 rows). P5.1 adds the ninety-fifth (auth.principal). P5.2 adds the ninety-sixth (auth.session). P5.3 adds the ninety-seventh (auth.authorization). P5.5 adds the ninety-eighth (auth.credential-crypto). P5.6 adds the ninety-ninth (auth.account-security). P5.7 adds the hundredth (auth.machine-identity).
  const doc = readFileSync(new URL('../../../docs/architecture/p9/P9.9-RESOURCE-PRESSURE.md', import.meta.url), 'utf8');
  assert.match(doc, /CRITICAL/);
  assert.match(doc, /OBSERVED/);
  assert.match(doc, /ESTIMATED/);
  assert.match(doc, /REPORTED/);
  assert.match(doc, /threshold/i);
});
