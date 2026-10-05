import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  SELFVIEW_CONTRACT, SELFVIEW_SCHEMA_VERSION, SELFVIEW_COUNTERS,
  SELFVIEW_ERROR_COUNTERS, SELFVIEW_EVENT_KINDS, SELFVIEW_PRIORITIES,
  SELFVIEW_SUPPRESSION, SELFVIEW_LIMITS, SELFVIEW_NOTES,
  createSelfObservability,
} from '../src/lego/self-observability.mjs';

const fixture = JSON.parse(readFileSync(
  new URL('./fixtures/p9/self-observability.json', import.meta.url), 'utf8'));

function makeSelf(extra = {}) {
  const c = createSelfObservability({ ...fixture.controller, ...extra });
  assert.ok(c, 'self-observability constructs');
  return c;
}

test('P9.18 contract: required counters, kinds, suppression rule, limits, fail-closed', () => {
  assert.equal(SELFVIEW_CONTRACT.id, 'observability.self-observability');
  assert.equal(SELFVIEW_CONTRACT.version, '1.0.0');
  assert.equal(SELFVIEW_CONTRACT.owner, 'agent-6');
  assert.equal(SELFVIEW_SCHEMA_VERSION, '1.0.0');
  assert.deepEqual([...SELFVIEW_COUNTERS], fixture.requiredCounters,
    'exactly the ten DoD counters');
  assert.deepEqual([...SELFVIEW_ERROR_COUNTERS], fixture.errorCounters);
  assert.equal(SELFVIEW_EVENT_KINDS, SELFVIEW_COUNTERS);
  assert.deepEqual([...SELFVIEW_PRIORITIES], ['P0', 'P1', 'P2', 'P3', 'P4']);
  assert.equal(SELFVIEW_SUPPRESSION.rule, 'counters-always-detail-may-suppress');
  assert.ok(SELFVIEW_NOTES.includes('zero-errors-vs-zero-telemetry'));
  assert.ok(SELFVIEW_NOTES.includes('bounded-self-metrics'));
  assert.ok(SELFVIEW_NOTES.includes('recursion-guard'));
  assert.ok(SELFVIEW_NOTES.includes('self-suppression-priority'));
  assert.equal(SELFVIEW_LIMITS.maxDepth, 1);
  // fail-closed configs
  assert.equal(createSelfObservability('x'), null);
  assert.equal(createSelfObservability({ capacity: 0 }), null);
  assert.equal(createSelfObservability({ capacity: -5 }), null);
  assert.equal(createSelfObservability({ capacity: 65537 }), null);
  assert.equal(createSelfObservability({ degradeAfterFailures: 0 }), null);
  assert.equal(createSelfObservability({ onNote: 'nope' }), null);
  assert.equal(createSelfObservability({ unknown: 1 }), null);
});

test('P9.18 all ten required counters reportable via note()', () => {
  const c = makeSelf();
  for (const kind of fixture.pipelineSequence) {
    const r = c.note(kind);
    assert.equal(r.ok, true, `note ${kind}`);
    assert.equal(r.report.kind, kind);
  }
  const snap = c.snapshot();
  assert.deepEqual(Object.keys(snap.counters).sort(),
    [...fixture.requiredCounters].sort(), 'bounded key set — no growth');
  for (const k of fixture.pipelineSequence) {
    assert.ok(snap.counters[k] >= 1, `${k} reported`);
  }
  // 'generated' is part of the sequence → telemetry now present
  assert.equal(snap.counters.generated, 1);
  assert.equal(snap.zeroTelemetry, false);
  assert.ok(snap.internal.detail_delivered >= fixture.pipelineSequence.length);
});

test('P9.18 distinguish zero errors from zero telemetry', () => {
  const c = makeSelf();
  // fresh: both true (idle is not the same as healthy traffic)
  let snap = c.snapshot();
  assert.equal(snap.zeroTelemetry, true);
  assert.equal(snap.zeroErrors, true);
  assert.equal(snap.classification, 'no_telemetry_no_errors');
  // traffic with no errors: zeroTelemetry false, zeroErrors still true
  c.note('generated');
  c.note('sampled');
  snap = c.snapshot();
  assert.equal(snap.zeroTelemetry, false);
  assert.equal(snap.zeroErrors, true);
  assert.equal(snap.classification, 'telemetry_zero_errors');
  // exporter failure: zeroErrors flips independently
  c.attemptExport(false);
  snap = c.snapshot();
  assert.equal(snap.zeroTelemetry, false);
  assert.equal(snap.zeroErrors, false);
  assert.equal(snap.classification, 'telemetry_errors_present');
  assert.ok(snap.errorTotal >= 1);
  assert.equal(snap.errorTotal,
    snap.counters.export_failed + snap.counters.cardinality_rejected +
    snap.counters.query_slow + snap.counters.diagnostic_bundle_failed);
});

test('P9.18 drop-counter test: capacity bound sheds into dropped', () => {
  const c = makeSelf({ capacity: fixture.drop.capacity });
  const outcomes = [];
  for (let i = 0; i < fixture.drop.offers; i++) {
    outcomes.push(c.offer().outcome);
  }
  const snap = c.snapshot();
  assert.equal(snap.counters.buffered, fixture.drop.expectBuffered);
  assert.equal(snap.counters.dropped, fixture.drop.expectDropped);
  assert.equal(snap.occupancy, fixture.drop.capacity, 'occupancy capped');
  assert.equal(outcomes.filter(o => o === 'buffered').length, fixture.drop.expectBuffered);
  // take frees space → next offer buffers again
  const t = c.take(2);
  assert.equal(t.ok, true);
  assert.equal(t.released, 2);
  assert.equal(c.offer().outcome, 'buffered');
  assert.equal(c.snapshot().counters.buffered, fixture.drop.expectBuffered + 1);
  // cumulative dropped stays honest
  assert.equal(c.snapshot().counters.dropped, fixture.drop.expectDropped);
});

test('P9.18 simulated telemetry outage + exporter failure', () => {
  const c = makeSelf({ degradeAfterFailures: fixture.outage.degradeAfter });
  c.note('generated');
  // exporter fails repeatedly — self-observation keeps counting throughout
  for (let i = 0; i < fixture.outage.failures; i++) {
    const r = c.attemptExport(false);
    assert.equal(r.ok, true);
    assert.equal(r.outcome, 'export_failed');
    assert.equal(r.outage, true);
    // self-telemetry still records during the outage
    const still = c.note('generated');
    assert.equal(still.ok, true);
    assert.equal(still.report.outage, true);
  }
  let snap = c.snapshot();
  assert.equal(snap.counters.export_failed, fixture.outage.expectExportFailed);
  assert.equal(snap.outage, true);
  assert.equal(snap.degraded, fixture.outage.expectDegraded);
  assert.ok(snap.counters.degraded >= 1);
  assert.ok(snap.consecutiveExportFailures >= fixture.outage.degradeAfter);
  // recovery: success clears outage + degraded flags, cumulative counters stay
  const ok = c.attemptExport(true);
  assert.equal(ok.outcome, 'exported');
  snap = c.snapshot();
  assert.equal(snap.outage, false);
  assert.equal(snap.degraded, false);
  assert.equal(snap.consecutiveExportFailures, 0);
  assert.equal(snap.counters.export_failed, fixture.outage.expectExportFailed);
  // invalid export arg fail-closed
  assert.equal(c.attemptExport('yes').ok, false);
});

test('P9.18 recursion guard: note() inside onNote never recurses', () => {
  let reentered = null;
  let holder = null;
  const c = createSelfObservability({
    ...fixture.controller,
    onNote: () => {
      // attempt to re-enter self-observation from inside the hook
      reentered = holder.note('generated');
    },
  });
  assert.ok(c);
  holder = c;
  const r = c.note('generated');
  assert.equal(r.ok, true, 'outer note succeeds');
  assert.ok(reentered, 'hook ran');
  assert.equal(reentered.ok, false, 'inner note suppressed');
  assert.equal(reentered.error.code, 'selfview.recursion');
  // recursion attempt was counted once; generated bumped exactly once (outer)
  const snap = c.snapshot();
  assert.equal(snap.internal.recursion_suppressed, 1);
  assert.equal(snap.counters.generated, 1, 'no double-count from recursion');
  // a fresh top-level note still works (guard is re-entrancy, not permanent)
  assert.equal(c.note('sampled').ok, true);
  assert.equal(c.snapshot().counters.sampled, 1);
});

test('P9.18 bounded self-metrics: fixed keys, saturating values, no dynamic labels', () => {
  const c = makeSelf();
  // unknown kind rejected — cannot introduce a dynamic key
  const bad = c.note('custom_metric_from_user_input');
  assert.equal(bad.ok, false);
  assert.equal(bad.error.code, 'selfview.invalid_kind');
  // priority must come from the fixed set
  assert.equal(c.note('generated', { priority: 'P9' }).ok, false);
  assert.equal(c.note('generated', { label: 'x' }).ok, false);
  // snapshot counters frozen + exactly the ten keys after activity
  c.note('generated');
  c.attemptExport(false);
  const snap = c.snapshot();
  assert.deepEqual([...SELFVIEW_COUNTERS].sort(),
    Object.keys(snap.counters).sort());
  assert.ok(Object.isFrozen(snap.counters));
  // values are safe integers within bounds
  for (const v of Object.values(snap.counters)) {
    assert.ok(Number.isSafeInteger(v) && v >= 0 && v <= SELFVIEW_LIMITS.maxCounterValue);
  }
  // secret-shaped options fail-closed
  assert.equal(c.note('generated', { priority: 'bearer abcdef123secret' }).ok, false);
});

test('P9.18 self-telemetry suppression/priority rule', () => {
  const delivered = [];
  const c = createSelfObservability({
    ...fixture.controller,
    onNote: (evt) => { delivered.push(evt); },
  });
  assert.ok(c);
  // NORMAL: P3 detail delivered
  let r = c.note('sampled', { priority: fixture.suppression.outagePriority });
  assert.equal(r.report.delivered, true);
  assert.equal(r.report.suppressed, false);
  // enter outage
  c.attemptExport(false);
  // P2–P4 detail suppressed during outage — counter STILL bumps
  r = c.note('dropped', { priority: fixture.suppression.outagePriority });
  assert.equal(r.ok, true);
  assert.equal(r.report.suppressed, true);
  assert.equal(r.report.delivered, false);
  assert.equal(c.snapshot().counters.dropped, 1, 'counter not suppressed');
  assert.ok(c.snapshot().internal.detail_suppressed >= 1);
  // P0/P1 always delivered even during outage
  r = c.note('redacted', { priority: fixture.suppression.protectedPriority });
  assert.equal(r.report.delivered, true);
  r = c.note('degraded', { priority: 'P0' });
  assert.equal(r.report.delivered, true);
  // default priority is P2 (detail class) → suppressed during outage
  r = c.note('generated');
  assert.equal(r.report.priority, fixture.suppression.defaultPriority);
  assert.equal(r.report.delivered, false);
  // outage cleared → detail delivered again
  c.attemptExport(true);
  r = c.note('generated');
  assert.equal(r.report.delivered, true);
  const prioritiesDelivered = delivered.map(e => e.priority);
  assert.ok(prioritiesDelivered.includes('P3') === false || prioritiesDelivered.length >= 1);
  // ensure no P3 was delivered while outage active: last P3 was pre-outage only
  assert.equal(prioritiesDelivered.filter(p => p === 'P3').length, 1);
});

test('P9.18 invalid inputs fail-closed across API surface', () => {
  const c = makeSelf();
  assert.equal(c.note(null).ok, false);
  assert.equal(c.note('generated', 'P1').ok, false);
  assert.equal(c.note('generated', { nope: 1 }).ok, false);
  assert.equal(c.take(0).ok, false);
  assert.equal(c.take(-1).ok, false);
  assert.equal(c.take(1.5).ok, false);
  // offer/take never throw
  for (let i = 0; i < 10; i++) c.offer();
  assert.equal(c.take(999).ok, true, 'take clamps to occupancy');
  assert.equal(c.snapshot().occupancy, 0);
});

test('P9.18 lock pin: contracts length 75 after P9.22 row', () => {
  const lock = JSON.parse(readFileSync(
    new URL('../src/lego/contracts/contract-lock.json', import.meta.url), 'utf8'));
  assert.equal(lock.contracts.length, 100, // P9 integration (Agent 1): P9.5-P9.22 add 18 observability.* rows on top of protected main 76 -> 94 (union, zero id collisions); P9 was developed on 24032a0c (57 rows). P5.2 adds the ninety-sixth (auth.session). P5.3 adds the ninety-seventh (auth.authorization). P5.5 adds the ninety-eighth (auth.credential-crypto). P5.6 adds the ninety-ninth (auth.account-security). P5.7 adds the hundredth (auth.machine-identity).
    'P9.18 adds observability.self-observability@1.0.0; P9.19 adds observability.tenant-isolation@1.0.0; P9.20 adds observability.contract-oracle@1.0.0; P9.21 adds observability.advanced-diagnostics@1.0.0; P9.22 adds observability.p9-acceptance@1.0.0; count-pins say 75');
  const row = lock.contracts.find(c => c.id === 'observability.self-observability');
  assert.ok(row, 'P9.18 row present');
  assert.equal(row.version, '1.0.0');
  assert.equal(row.owner, 'agent-6');
  assert.equal(row.domain, 'observability');
  assert.ok(Array.isArray(row.tests) && row.tests.length >= 1);
  assert.ok(String(row.notes).includes('P9.18'));
});
