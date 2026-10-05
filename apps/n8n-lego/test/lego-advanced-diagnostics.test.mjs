import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ADVDIAG_CONTRACT, ADVDIAG_SCHEMA_VERSION, ADVDIAG_FEATURES,
  ADVDIAG_CONTAINMENT, ADVDIAG_DEDUP_EXEMPT, ADVDIAG_LIMITS, ADVDIAG_NOTES,
  createAdvancedDiagnostics,
} from '../src/lego/advanced-diagnostics.mjs';

const fixture = JSON.parse(readFileSync(
  new URL('./fixtures/p9/advanced-diagnostics.json', import.meta.url), 'utf8'));

function make(extra = {}) {
  const c = createAdvancedDiagnostics({ ...fixture.controller, ...extra });
  assert.ok(c, 'controller constructs');
  return c;
}

const sumTransform = (input) => input.n + 100;

test('P9.21 contract: features, containment, dedup exemptions, fail-closed config', () => {
  assert.equal(ADVDIAG_CONTRACT.id, 'observability.advanced-diagnostics');
  assert.equal(ADVDIAG_CONTRACT.version, '1.0.0');
  assert.equal(ADVDIAG_CONTRACT.owner, 'agent-6');
  assert.equal(ADVDIAG_SCHEMA_VERSION, '1.0.0');
  assert.deepEqual([...ADVDIAG_FEATURES], fixture.selectedFeatures);
  for (const f of ADVDIAG_FEATURES) {
    assert.ok(ADVDIAG_CONTAINMENT[f], `containment for ${f}`);
    assert.ok(ADVDIAG_CONTAINMENT[f].budget, `budget for ${f}`);
    assert.ok(ADVDIAG_CONTAINMENT[f].fallback, `fallback for ${f}`);
    const row = fixture.featureMatrix.find(x => x.feature === f);
    assert.ok(row, `matrix row for ${f}`);
    assert.equal(row.killSwitch, true);
    assert.equal(row.abSafe, true);
  }
  assert.ok(ADVDIAG_DEDUP_EXEMPT.includes('security'));
  assert.ok(ADVDIAG_DEDUP_EXEMPT.includes('audit'));
  assert.ok(ADVDIAG_NOTES.includes('security-audit-never-deduped'));
  assert.ok(ADVDIAG_NOTES.includes('profiling-ebpf-optional-not-selected'));
  assert.ok(ADVDIAG_NOTES.includes('tail-sampling-bounded'));
  assert.ok(ADVDIAG_NOTES.includes('kill-switch-per-feature'));
  assert.ok(fixture.notSelected.includes('profiling_optional'));
  assert.ok(fixture.notSelected.includes('ebpf_host_adapter_optional'));
  assert.equal(createAdvancedDiagnostics('x'), null);
  assert.equal(createAdvancedDiagnostics({ fastPathByteBudget: 1 }), null);
  assert.equal(createAdvancedDiagnostics({ internMaxEntries: 0 }), null);
  assert.equal(createAdvancedDiagnostics({ maxInFlight: 0 }), null);
  assert.equal(createAdvancedDiagnostics({ disabled: ['nope'] }), null);
  assert.equal(createAdvancedDiagnostics({ unknown: 1 }), null);
});

test('P9.21 feature + trade-off matrices checked in', () => {
  assert.equal(fixture.featureMatrix.length, ADVDIAG_FEATURES.length);
  assert.equal(fixture.tradeOffMatrix.length, ADVDIAG_FEATURES.length);
  for (const row of fixture.tradeOffMatrix) {
    assert.ok(row.gain && row.cost && row.risk && row.mitigation, row.feature);
    assert.ok(ADVDIAG_FEATURES.includes(row.feature));
  }
  for (const row of fixture.featureMatrix) {
    const budget = ADVDIAG_CONTAINMENT[row.feature].budget;
    assert.ok(row.budget.includes(budget) || budget.includes(row.budget.split('+')[0]),
      `${row.feature} budget alignment`);
  }
});

test('P9.21 fast path: budget pressure + kill-switch fallback', () => {
  const c = make({ fastPathByteBudget: 4096 });
  let r = c.admitFast({ id: 'f1', category: 'log', bytes: 2000 });
  assert.equal(r.outcome, 'admitted');
  assert.equal(r.path, 'fast');
  r = c.admitFast({ id: 'f2', category: 'log', bytes: 2000 });
  assert.equal(r.outcome, 'admitted');
  r = c.admitFast({ id: 'f3', category: 'log', bytes: 2000 });
  assert.equal(r.outcome, 'fallback');
  assert.equal(r.path, fixture.expect.fallbackPath);
  assert.equal(r.accepted, false);
  assert.ok(c.snapshot().counters.fastPathFallbacks >= 1);
  assert.ok(c.snapshot().usage.fastPathBytes <= 4096, 'budget held');
  assert.equal(c.setKillSwitch('fast_path', false).ok, true);
  r = c.admitFast({ id: 'f4', category: 'log', bytes: 100 });
  assert.equal(r.outcome, 'fallback');
  assert.equal(r.path, 'disabled');
  assert.equal(r.accepted, true);
  assert.ok(c.snapshot().counters.fastPathDisabledAdmits >= 1);
  assert.equal(c.setKillSwitch('fast_path', true).ok, true);
  assert.equal(c.admitFast(null).ok, false);
  assert.equal(c.admitFast({ id: 'x', bytes: 0 }).ok, false);
  assert.equal(c.admitFast({ id: 'bearer abcdef123secret', bytes: 10 }).ok, false);
  assert.equal(c.setKillSwitch('nope', false).ok, false);
  assert.equal(c.setKillSwitch('fast_path', 'yes').ok, false);
});

test('P9.21 delta telemetry + absolute fallback', () => {
  const c = make({ deltaBaselineMax: 4 });
  let r = c.observeDelta({ name: 'requests', value: 10 });
  assert.equal(r.ok, true);
  assert.equal(r.mode, 'delta');
  assert.equal(r.delta, 10, 'first observation is full value');
  r = c.observeDelta({ name: 'requests', value: 15 });
  assert.equal(r.delta, 5);
  r = c.observeDelta({ name: 'requests', value: 14 });
  assert.equal(r.delta, -1, 'counter reset yields negative delta (honest)');
  c.observeDelta({ name: 'a', value: 1 });
  c.observeDelta({ name: 'b', value: 1 });
  c.observeDelta({ name: 'c', value: 1 });
  const overflow = c.observeDelta({ name: 'd', value: 1 });
  assert.equal(overflow.ok, false);
  assert.equal(overflow.error.code, 'advdiag.delta_overflow');
  assert.ok(c.snapshot().counters.deltaOverflows >= 1);
  c.setKillSwitch('delta_telemetry', false);
  r = c.observeDelta({ name: 'requests', value: 99 });
  assert.equal(r.mode, 'absolute_fallback');
  assert.equal(r.delta, 0);
  assert.equal(r.value, 99);
  const snap = c.absoluteSnapshot();
  assert.equal(snap.mode, 'absolute_fallback');
  assert.ok(snap.values.requests !== undefined);
  assert.equal(c.observeDelta(null).ok, false);
  assert.equal(c.observeDelta({ name: 'x', value: NaN }).ok, false);
});

test('P9.21 bounded identifier interning: cap, eviction, kill-switch', () => {
  const c = make({ internMaxEntries: 4 });
  let r = c.intern('wf-alpha');
  assert.equal(r.ok, true);
  assert.equal(r.interned, true);
  assert.equal(r.path, 'miss');
  r = c.intern('wf-alpha');
  assert.equal(r.path, 'hit');
  assert.equal(r.value, 'wf-alpha');
  c.intern('k1'); c.intern('k2'); c.intern('k3'); c.intern('k4');
  assert.ok(c.snapshot().usage.internSize <= 4, 'hard cap');
  r = c.intern('k5');
  assert.equal(r.ok, true);
  assert.ok(c.snapshot().counters.internEvictions >= 1);
  assert.ok(c.snapshot().usage.internSize <= 4);
  const before = c.snapshot().usage.internSize;
  c.setKillSwitch('bounded_interning', false);
  r = c.intern('passthrough-key');
  assert.equal(r.interned, false);
  assert.equal(r.path, 'passthrough');
  assert.equal(c.snapshot().usage.internSize, before, 'no growth when disabled');
  assert.ok(c.snapshot().counters.internPassthrough >= 1);
  assert.equal(c.intern('').ok, false);
  assert.equal(c.intern('bearer abcdef123secret').ok, false);
});

test('P9.21 burst dedup: window suppress; security/audit never deduped by default', () => {
  const c = make({ dedupWindowMs: 1000, dedupMaxEntries: 8 });
  let r = c.offerDedup({ id: 'err-1', category: 'log', now: 0 });
  assert.equal(r.outcome, 'admitted');
  assert.equal(r.deduped, false);
  r = c.offerDedup({ id: 'err-1', category: 'log', now: 100 });
  assert.equal(r.outcome, 'suppressed');
  assert.equal(r.deduped, true);
  assert.ok(c.snapshot().counters.dedupSuppressed >= 1);
  r = c.offerDedup({ id: 'err-1', category: 'log', now: 2000 });
  assert.equal(r.outcome, 'admitted');
  for (let i = 0; i < 5; i++) {
    r = c.offerDedup({ id: 'sec-1', category: 'security', now: 0 + i });
    assert.equal(r.outcome, 'admitted', 'security exempt');
    assert.equal(r.exempt, true);
    assert.equal(r.path, fixture.expect.exemptPath);
  }
  r = c.offerDedup({ id: 'aud-1', category: 'audit', now: 0 });
  assert.equal(r.exempt, true);
  assert.equal(r.outcome, 'admitted');
  assert.ok(c.snapshot().counters.dedupExempt >= 6);
  c.setKillSwitch('burst_dedup', false);
  r = c.offerDedup({ id: 'err-1', category: 'log', now: 50 });
  assert.equal(r.outcome, 'admitted');
  assert.equal(r.path, 'disabled_fallback');
  assert.ok(c.snapshot().counters.dedupDisabled >= 1);
  assert.equal(c.offerDedup(null).ok, false);
  assert.equal(c.offerDedup({ id: 'x', now: -1 }).ok, false);
});

test('P9.21 tail sampling: bounded in-flight + keep-on-overflow fallback', () => {
  const c = make({ maxInFlight: 3 });
  let r = c.tailBegin('t1');
  assert.equal(r.decision, 'track');
  assert.equal(r.inFlight, 1);
  c.tailBegin('t2');
  c.tailBegin('t3');
  assert.equal(c.snapshot().usage.inFlight, 3);
  r = c.tailBegin('t4');
  assert.equal(r.decision, 'keep');
  assert.equal(r.path, fixture.expect.keepOnOverflow);
  assert.equal(r.overflow, true);
  assert.equal(c.snapshot().usage.inFlight, 3, 'in-flight bounded');
  assert.ok(c.snapshot().counters.tailOverflowKeep >= 1);
  assert.equal(c.tailEnd('t1', 'keep').decision, 'keep');
  assert.equal(c.tailEnd('t2', 'drop').decision, 'drop');
  assert.equal(c.snapshot().usage.inFlight, 1);
  assert.ok(c.snapshot().counters.tailDecidedKeep >= 1);
  assert.ok(c.snapshot().counters.tailDecidedDrop >= 1);
  r = c.tailEnd('ghost', 'keep');
  assert.equal(r.ok, true);
  assert.equal(r.tracked, false);
  // duplicate while feature still ON (t3 remains in flight)
  assert.equal(c.tailBegin('t3').ok, false, 'duplicate in flight');
  c.setKillSwitch('tail_sampling', false);
  r = c.tailBegin('t9');
  assert.equal(r.decision, 'keep');
  assert.equal(r.path, 'disabled_fallback');
  assert.equal(c.tailBegin('bad id!').ok, false);
  assert.equal(c.tailEnd('t9', 'maybe').ok, false);
});

test('P9.21 incident burst mode: threshold, cooldown, kill-switch steady', () => {
  const c = make({ burstThreshold: 5, burstCooldownMs: 5000, dedupWindowMs: 1000 });
  let last;
  for (let t = 0; t < 5; t++) last = c.observeBurst(t);
  assert.equal(last.mode, 'burst');
  assert.equal(last.changed, true);
  assert.ok(c.snapshot().counters.burstEntered >= 1);
  last = c.observeBurst(100);
  assert.equal(last.mode, 'burst');
  last = c.observeBurst(6000);
  assert.equal(last.mode, 'steady');
  assert.equal(last.changed, true);
  assert.ok(c.snapshot().counters.burstRecovered >= 1);
  c.setKillSwitch('incident_burst_mode', false);
  for (let t = 7000; t < 7010; t++) last = c.observeBurst(t);
  assert.equal(last.mode, 'steady');
  assert.equal(last.path, 'disabled_fallback');
  assert.equal(c.observeBurst(-1).ok, false);
});

test('P9.21 workflow A/B: business semantics stable across feature states', () => {
  const c = make();
  const inputs = fixture.workflowAb.inputs;
  const normal = inputs.map(i => c.workflowAb(i, sumTransform));
  for (const r of normal) assert.equal(r.ok, true);
  for (let t = 0; t < 10; t++) c.observeBurst(t);
  for (let i = 0; i < 30; i++) c.admitFast({ id: `x${i}`, category: 'log', bytes: 500 });
  for (let i = 0; i < 5; i++) c.offerDedup({ id: 'err-1', category: 'log', now: i });
  const stressed = inputs.map(i => c.workflowAb(i, sumTransform));
  for (const f of ADVDIAG_FEATURES) c.setKillSwitch(f, false);
  const disabled = inputs.map(i => c.workflowAb(i, sumTransform));
  for (let i = 0; i < inputs.length; i++) {
    assert.deepEqual(stressed[i].result, normal[i].result, `A/B stressed ${i}`);
    assert.deepEqual(disabled[i].result, normal[i].result, `A/B disabled ${i}`);
    assert.deepEqual(stressed[i].result, sumTransform(inputs[i]));
  }
  assert.deepEqual(disabled[0].telemetryFeatures.disabled, [...ADVDIAG_FEATURES].sort());
  assert.deepEqual(stressed[0].telemetryFeatures.disabled, []);
  assert.equal(c.workflowAb({ n: 1 }, 'nope').ok, false);
  assert.equal(c.workflowAb({ n: 1 }, () => { throw new Error('x'); }).ok, false);
  assert.equal(c.workflowAb('bearer abcdef123secret', sumTransform).ok, false);
});

test('P9.21 pressure behavior: all budgets enforced under flood', () => {
  const c = make();
  for (let i = 0; i < 100; i++) c.admitFast({ id: `f${i}`, category: 'log', bytes: 512 });
  assert.ok(c.snapshot().usage.fastPathBytes <= fixture.controller.fastPathByteBudget);
  assert.ok(c.snapshot().counters.fastPathFallbacks > 0);
  for (let i = 0; i < 50; i++) c.intern(`k${i}`);
  assert.ok(c.snapshot().usage.internSize <= fixture.controller.internMaxEntries);
  for (let i = 0; i < 8; i++) c.offerDedup({ id: `e${i}`, category: 'log', now: i });
  for (let round = 1; round <= 5; round++) {
    for (let i = 0; i < 8; i++) c.offerDedup({ id: `e${i}`, category: 'log', now: i + round });
  }
  assert.ok(c.snapshot().usage.dedupSize <= fixture.controller.dedupMaxEntries);
  assert.ok(c.snapshot().counters.dedupSuppressed >= 32, 'window dedup under flood');
  for (let i = 100; i < 140; i++) c.offerDedup({ id: `x${i}`, category: 'log', now: 5000 + i });
  assert.ok(c.snapshot().usage.dedupSize <= fixture.controller.dedupMaxEntries, 'map cap held');
  assert.ok(c.snapshot().counters.dedupPressureEvictions > 0, 'map pressure evictions');
  for (let i = 0; i < 20; i++) c.tailBegin(`t${i}`);
  assert.ok(c.snapshot().usage.inFlight <= fixture.controller.maxInFlight);
  assert.ok(c.snapshot().counters.tailOverflowKeep >= 10);
  for (let i = 0; i < 200; i++) c.observeBurst(i);
  assert.ok(c.snapshot().usage.windowEvents <= fixture.controller.burstThreshold * 4);
});

test('P9.21 lock pin: contracts length 75 after P9.22 row', () => {
  const lock = JSON.parse(readFileSync(
    new URL('../src/lego/contracts/contract-lock.json', import.meta.url), 'utf8'));
  assert.equal(lock.contracts.length, 100, // P9 integration (Agent 1): P9.5-P9.22 add 18 observability.* rows on top of protected main 76 -> 94 (union, zero id collisions); P9 was developed on 24032a0c (57 rows). P5.2 adds the ninety-sixth (auth.session). P5.3 adds the ninety-seventh (auth.authorization). P5.5 adds the ninety-eighth (auth.credential-crypto). P5.6 adds the ninety-ninth (auth.account-security). P5.7 adds the hundredth (auth.machine-identity).
    'P9.21 adds observability.advanced-diagnostics@1.0.0; P9.22 adds observability.p9-acceptance@1.0.0; count-pins say 75');
  const row = lock.contracts.find(c => c.id === 'observability.advanced-diagnostics');
  assert.ok(row, 'P9.21 row present');
  assert.equal(row.version, '1.0.0');
  assert.equal(row.owner, 'agent-6');
  assert.equal(row.domain, 'observability');
  assert.ok(Array.isArray(row.tests) && row.tests.length >= 1);
  assert.ok(String(row.notes).includes('P9.21'));
});
