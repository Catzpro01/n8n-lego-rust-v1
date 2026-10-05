import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  SAMPLING_CONTRACT, SAMPLING_MODES, SAMPLING_MODE_DESCRIPTIONS, SAMPLING_DECISIONS,
  SAMPLING_REASONS, SAMPLING_LIMITS, createTelemetrySampler,
} from '../src/lego/telemetry-sampling.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/p9/sampling.json', import.meta.url), 'utf8'));

test('P9.8 contract, exact mode vocabulary, and descriptions cover every DoD mode', () => {
  assert.equal(SAMPLING_CONTRACT.id, 'observability.telemetry-sampling');
  assert.equal(SAMPLING_CONTRACT.version, '1.0.0');
  assert.equal(SAMPLING_CONTRACT.owner, 'agent-6');
  assert.deepEqual([...SAMPLING_MODES], fixture.modes);
  assert.deepEqual([...SAMPLING_MODES], ['OFF', 'HEAD', 'TAIL', 'ERROR_PRIORITY', 'LATENCY_PRIORITY', 'ADAPTIVE']);
  // RATE_LIMITED explicitly scoped out of 1.0.0 (DoD allows scoped-out modes).
  assert.equal(SAMPLING_MODES.includes('RATE_LIMITED'), false);
  for (const mode of SAMPLING_MODES) {
    assert.equal(typeof SAMPLING_MODE_DESCRIPTIONS[mode], 'string', mode);
  }
  assert.deepEqual([...SAMPLING_DECISIONS], ['keep', 'drop']);
  assert.equal(SAMPLING_LIMITS.rateMin, 0);
  assert.equal(SAMPLING_LIMITS.rateMax, 1);
});

test('P9.8 mode matrix: representative success/error/slow outcomes per mode', () => {
  const { success, error, slow } = fixture.representative;
  for (const row of fixture.modeMatrix) {
    const sampler = createTelemetrySampler({
      mode: row.mode, seed: 11, rate: 0.5, slowMs: 1000,
      baselineRate: 0.5, minRate: 0.1, maxRate: 1,
    });
    assert.ok(sampler, row.mode);
    if (row.mode === 'OFF') {
      for (const sig of [success, error, slow]) {
        const d = sampler.decide(sig);
        assert.equal(d.decision, 'keep', `${row.mode}/${sig.key}`);
        assert.equal(d.reason, 'mode_off');
      }
    }
    if (row.mode === 'ERROR_PRIORITY') {
      const d = sampler.decide(error);
      assert.equal(d.decision, 'keep');
      assert.equal(d.reason, 'error_priority');
      const s = sampler.decide(success);
      assert.equal(s.reason, 'error_priority');
    }
    if (row.mode === 'LATENCY_PRIORITY') {
      const d = sampler.decide(slow);
      assert.equal(d.decision, 'keep');
      assert.equal(d.reason, 'latency_priority');
      assert.ok(slow.durationMs >= 1000);
    }
    if (row.mode === 'TAIL') {
      const hErr = sampler.begin('t-err');
      assert.equal(hErr.accepted, true);
      const dErr = sampler.end(hErr, error);
      assert.equal(dErr.decision, 'keep');
      assert.equal(dErr.reason, 'tail_error');
      const hSlow = sampler.begin('t-slow');
      const dSlow = sampler.end(hSlow, slow);
      assert.equal(dSlow.decision, 'keep');
      assert.equal(dSlow.reason, 'tail_latency');
      const hOk = sampler.begin('t-ok');
      const dOk = sampler.end(hOk, success);
      assert.equal(dOk.reason, 'tail_summary');
      assert.ok(SAMPLING_DECISIONS.includes(dOk.decision));
    }
    if (row.mode === 'ADAPTIVE') {
      const before = sampler.stats().currentRate;
      const d = sampler.decide(error);
      assert.equal(d.decision, 'keep');
      const after = sampler.stats().currentRate;
      assert.ok(after >= before, 'error must not lower adaptive rate');
    }
    if (row.mode === 'HEAD') {
      const d = sampler.decide(success);
      assert.equal(d.reason, 'head_hash');
      assert.ok(['keep', 'drop'].includes(d.decision));
    }
  }
});

test('P9.8 deterministic decisions under fixed policy/seed', () => {
  const seed = fixture.determinism.seed;
  const keys = Array.from({ length: 40 }, (_, i) => `exec-${i}`);
  const a = createTelemetrySampler({ mode: 'HEAD', rate: 0.5, seed });
  const b = createTelemetrySampler({ mode: 'HEAD', rate: 0.5, seed });
  assert.ok(a && b);
  const seqA = keys.map(k => a.decide({ key: k, outcome: 'success' }).decision);
  const seqB = keys.map(k => b.decide({ key: k, outcome: 'success' }).decision);
  assert.deepEqual(seqA, seqB, 'same seed+policy → identical sequence');
  const c = createTelemetrySampler({ mode: 'HEAD', rate: 0.5, seed: seed + 99 });
  const seqC = keys.map(k => c.decide({ key: k, outcome: 'success' }).decision);
  assert.notDeepEqual(seqA, seqC, 'different seeds should diverge');
  assert.ok(seqA.includes('keep') && seqA.includes('drop'));
  const dropAll = createTelemetrySampler({ mode: 'HEAD', rate: 0, seed: 1 });
  const keepAll = createTelemetrySampler({ mode: 'HEAD', rate: 1, seed: 1 });
  for (const key of fixture.determinism.keys) {
    assert.equal(dropAll.decide({ key }).decision, 'drop');
    assert.equal(keepAll.decide({ key }).decision, 'keep');
  }
});

test('P9.8 adaptive controller: raise on error, decay after cooldown, min/max bounds', () => {
  const cfg = fixture.adaptiveTransition.config;
  const sampler = createTelemetrySampler(cfg);
  assert.ok(sampler);
  const s0 = sampler.stats();
  assert.equal(s0.currentRate, cfg.baselineRate);
  assert.equal(s0.minRate, cfg.minRate);
  assert.equal(s0.maxRate, cfg.maxRate);
  sampler.decide({ key: 'e1', outcome: 'error' });
  const s1 = sampler.stats();
  assert.ok(s1.currentRate > s0.currentRate, 'error raises rate');
  assert.ok(s1.currentRate <= cfg.maxRate, 'never exceeds maxRate');
  for (let i = 0; i < 50; i++) sampler.decide({ key: `e${i}`, outcome: 'error' });
  const s2 = sampler.stats();
  assert.equal(s2.currentRate, cfg.maxRate);
  assert.ok(s2.counts.adaptiveClampMax >= 1);
  const rateBeforeHealthy = sampler.stats().currentRate;
  for (let i = 0; i < cfg.cooldownDecisions - 1; i++) {
    sampler.decide({ key: `h${i}`, outcome: 'success' });
    assert.equal(sampler.stats().currentRate, rateBeforeHealthy,
      `no decay before cooldown (i=${i})`);
  }
  sampler.decide({ key: 'h-final', outcome: 'success' });
  const s3 = sampler.stats();
  assert.ok(s3.currentRate < rateBeforeHealthy, 'decays after cooldown');
  for (let i = 0; i < 500; i++) sampler.decide({ key: `d${i}`, outcome: 'success' });
  const s4 = sampler.stats();
  assert.equal(s4.currentRate, cfg.baselineRate);
  assert.ok(s4.currentRate >= cfg.minRate);
});

test('P9.8 hysteresis: cooldown blocks oscillation', () => {
  const cfg = fixture.hysteresis.config;
  const sampler = createTelemetrySampler(cfg);
  assert.ok(sampler);
  sampler.decide({ key: 'boom', outcome: 'error' });
  const raised = sampler.stats().currentRate;
  assert.ok(raised > cfg.baselineRate);
  for (let i = 0; i < fixture.hysteresis.healthyBurstBeforeDecay; i++) {
    sampler.decide({ key: `ok${i}`, outcome: 'success' });
    assert.equal(sampler.stats().currentRate, raised,
      `hysteresis holds at decision ${i}`);
  }
  sampler.decide({ key: 'ok-cooldown', outcome: 'success' });
  const after = sampler.stats().currentRate;
  assert.ok(after <= raised - cfg.downStep + 1e-12);
  assert.ok(after < raised, 'exactly one step after cooldown');
  sampler.decide({ key: 'ok-next', outcome: 'success' });
  assert.equal(sampler.stats().currentRate, after, 'no double-decay');
});

test('P9.8 overload fallback: tail in-flight hard bound + head fallback', () => {
  const cfg = fixture.overloadFallback.config;
  const sampler = createTelemetrySampler(cfg);
  assert.ok(sampler);
  const handles = [];
  for (let i = 0; i < fixture.overloadFallback.beginCount; i++) {
    handles.push(sampler.begin(`trace-${i}`));
  }
  const st = sampler.stats();
  assert.equal(st.inFlight, fixture.overloadFallback.expectPeakInFlight);
  assert.ok(st.counts.peakInFlight <= cfg.maxInFlight, 'peak never exceeds bound');
  assert.equal(st.counts.tailOverloadFallback, fixture.overloadFallback.expectFallbacks);
  const fallbacks = handles.filter(h => h.fallback);
  assert.equal(fallbacks.length, fixture.overloadFallback.expectFallbacks);
  for (const h of fallbacks) {
    assert.equal(h.accepted, false);
    assert.equal(typeof h.headKeep, 'boolean');
    const settled = sampler.end(h, { outcome: 'success' });
    assert.equal(settled.reason, 'tail_overload_fallback');
  }
  for (const h of handles) {
    if (!h.fallback) sampler.end(h, { outcome: 'error' });
  }
  assert.equal(sampler.stats().inFlight, 0);
});

test('P9.8 tail memory bound: open without end never exceeds maxInFlight', () => {
  const cfg = fixture.tailMemoryBound.config;
  const sampler = createTelemetrySampler(cfg);
  assert.ok(sampler);
  let accepted = 0;
  for (let i = 0; i < fixture.tailMemoryBound.openWithoutEnd; i++) {
    const h = sampler.begin(`leak-${i}`);
    if (h.accepted) accepted++;
  }
  const st = sampler.stats();
  assert.equal(st.inFlight, fixture.tailMemoryBound.expectInFlight);
  assert.equal(st.inFlight, cfg.maxInFlight);
  assert.equal(accepted, cfg.maxInFlight);
  assert.ok(st.counts.tailOverloadFallback > 0);
  assert.equal(st.maxInFlight, cfg.maxInFlight);
});

test('P9.8 invalid config fails closed; decide never throws', () => {
  assert.equal(createTelemetrySampler(null), null);
  assert.equal(createTelemetrySampler({}), null);
  assert.equal(createTelemetrySampler({ mode: 'NOPE' }), null);
  assert.equal(createTelemetrySampler({ mode: 'RATE_LIMITED' }), null);
  assert.equal(createTelemetrySampler({ mode: 'HEAD', rate: 2 }), null);
  assert.equal(createTelemetrySampler({ mode: 'HEAD', rate: -0.1 }), null);
  assert.equal(createTelemetrySampler({ mode: 'HEAD', seed: -1 }), null);
  assert.equal(createTelemetrySampler({ mode: 'HEAD', maxInFlight: 0 }), null);
  assert.equal(createTelemetrySampler({ mode: 'ADAPTIVE', minRate: 0.9, maxRate: 0.2 }), null);
  assert.equal(createTelemetrySampler({ mode: 'ADAPTIVE', baselineRate: 0.99, minRate: 0.1, maxRate: 0.5 }), null);
  assert.equal(createTelemetrySampler({ mode: 'HEAD', unexpected: 1 }), null);
  assert.equal(createTelemetrySampler({ mode: 'HEAD', rate: NaN }), null);
  const ok = createTelemetrySampler({ mode: 'HEAD', rate: 0.5, seed: 1 });
  assert.ok(ok);
  for (const sig of [undefined, null, 42, Symbol('x'), () => {}, { durationMs: Infinity }]) {
    const d = ok.decide(sig);
    assert.ok(d);
    assert.ok(['keep', 'drop'].includes(d.decision));
  }
  const badEnd = ok.end({ key: 'x' }, 'not-a-summary');
  assert.ok(badEnd);
  assert.equal(badEnd.decision, 'keep');
});

test('P9.8 source stays pure: no I/O, no clock; locked row documents the boundary', () => {
  const stringify = JSON.stringify, now = Date.now, rnd = Math.random;
  try {
    JSON.stringify = () => { throw Error('encoding'); };
    Date.now = () => { throw Error('clock'); };
    Math.random = () => { throw Error('random'); };
    const s = createTelemetrySampler({ mode: 'ADAPTIVE', seed: 5, baselineRate: 0.2, minRate: 0.1, maxRate: 0.9 });
    assert.ok(s);
    assert.ok(s.decide({ key: 'a', outcome: 'error' }));
    assert.ok(s.decide({ key: 'b', outcome: 'success' }));
    const h = s.begin('t');
    assert.ok(s.end(h, { outcome: 'success', durationMs: 10 }));
  } finally {
    JSON.stringify = stringify; Date.now = now; Math.random = rnd;
  }
  const source = readFileSync(new URL('../src/lego/telemetry-sampling.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\b(?:fetch|setTimeout|setInterval|writeFile|readFile|appendFile|console\.(?:log|error)|Math\.random|Date\.now)\s*\(/);
  const lock = JSON.parse(readFileSync(new URL('../src/lego/contracts/contract-lock.json', import.meta.url), 'utf8'));
  const rows = lock.contracts.filter(row => row.id === SAMPLING_CONTRACT.id);
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.owner, 'agent-6');
  assert.equal(row.domain, 'observability');
  assert.equal(row.version, '1.0.0');
  assert.deepEqual(row.surface, ['src/lego/telemetry-sampling.mjs']);
  assert.deepEqual(row.exports['src/lego/telemetry-sampling.mjs'], [
    'SAMPLING_CONTRACT', 'SAMPLING_MODES', 'SAMPLING_MODE_DESCRIPTIONS',
    'SAMPLING_DECISIONS', 'SAMPLING_REASONS', 'SAMPLING_LIMITS',
    'createTelemetrySampler',
  ]);
  assert.deepEqual(row.tests, ['apps/n8n-lego/test/lego-telemetry-sampling.test.mjs']);
  assert.equal(lock.contracts.length, 100); // P9.8 adds observability.telemetry-sampling@1.0.0; P9.9 adds observability.resource-pressure@1.0.0; P9.10 adds observability.health-readiness@1.0.0; P9.11 adds observability.execution-diagnostics@1.0.0; P9.12 adds observability.diagnostic-bundle@1.0.0; P9.13 adds observability.failure-correlation@1.0.0; P9.14 adds observability.replay-evidence@1.0.0; P9.15 adds observability.telemetry-retention@1.0.0; P9.16 adds observability.operator-inspection@1.0.0; P9.17 adds observability.low-resource-mode@1.0.0; P9.18 adds observability.self-observability@1.0.0; P9.19 adds observability.tenant-isolation@1.0.0; P9.20 adds observability.contract-oracle@1.0.0; P9.21 adds observability.advanced-diagnostics@1.0.0; P9.22 adds observability.p9-acceptance@1.0.0; count-pins say 75 // P9 integration (Agent 1): P9.5-P9.22 add 18 observability.* rows on top of protected main 76 -> 94 (union, zero id collisions); P9 was developed on 24032a0c (57 rows). P5.1 adds the ninety-fifth (auth.principal). P5.2 adds the ninety-sixth (auth.session). P5.3 adds the ninety-seventh (auth.authorization). P5.5 adds the ninety-eighth (auth.credential-crypto). P5.6 adds the ninety-ninth (auth.account-security). P5.7 adds the hundredth (auth.machine-identity).
  const doc = readFileSync(new URL('../../../docs/architecture/p9/P9.8-SAMPLING.md', import.meta.url), 'utf8');
  assert.match(doc, /ERROR_PRIORITY/);
  assert.match(doc, /hysteresis/i);
  assert.match(doc, /overload/i);
  assert.match(doc, /RATE_LIMITED/);
});
