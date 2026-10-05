import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  TELEMETRY_BUFFER_CONTRACT, TELEMETRY_PRIORITY_CLASSES, TELEMETRY_PRIORITY_DESCRIPTIONS,
  BUFFER_LIMITS, BUFFER_OUTCOMES, BUFFER_OVERFLOW_POLICIES, createTelemetryBuffer,
} from '../src/lego/telemetry-buffer.mjs';

const rec = (priority, id = 0) => Object.freeze({ priority, payload: Object.freeze({ id }) });

test('P9.6 contract, priority classes and required capacity match the deep-design vocabulary', () => {
  assert.equal(TELEMETRY_BUFFER_CONTRACT.id, 'observability.telemetry-buffer');
  assert.equal(TELEMETRY_BUFFER_CONTRACT.version, '1.0.0');
  assert.equal(TELEMETRY_BUFFER_CONTRACT.owner, 'agent-6');
  assert.deepEqual([...TELEMETRY_PRIORITY_CLASSES], ['P0', 'P1', 'P2', 'P3', 'P4']);
  assert.deepEqual([...BUFFER_OUTCOMES], ['buffered', 'shed', 'rejected']);
  assert.deepEqual([...BUFFER_OVERFLOW_POLICIES], ['shed_lowest', 'reject_incoming']);
  assert.equal(TELEMETRY_PRIORITY_DESCRIPTIONS.P0, 'security/audit/safety evidence');
  assert.equal(TELEMETRY_PRIORITY_DESCRIPTIONS.P4, 'debug/verbose telemetry');
  // Capacity is REQUIRED: no default that could be forgotten → no silent unbounded queue.
  for (const bad of [undefined, null, {}, { capacity: 0 }, { capacity: -1 }, { capacity: 1.5 },
    { capacity: BUFFER_LIMITS.capacityMax + 1 }, { capacity: '10' },
    { capacity: 10, overflowPolicy: 'drop_all' }, { capacity: 10, extra: 1 }, { capacity: 10, spill: true }]) {
    assert.equal(createTelemetryBuffer(bad), null, JSON.stringify(bad));
  }
  const ok = createTelemetryBuffer({ capacity: 4 });
  assert.ok(ok);
  assert.equal(ok.capacity, 4);
  assert.equal(ok.overflowPolicy, 'shed_lowest');
});

test('P9.6 queue saturation: size never exceeds hard capacity (memory ceiling)', () => {
  const buf = createTelemetryBuffer({ capacity: 8 });
  const results = [];
  for (let i = 0; i < 1000; i++) results.push(buf.offer(rec('P3', i)));
  const stats = buf.stats();
  assert.equal(stats.size, 8);
  assert.equal(stats.capacity, 8);
  assert.ok(stats.size <= stats.capacity);
  assert.equal(stats.peakSize, 8);
  assert.equal(stats.buffered + stats.droppedTotal, 1000);
  // Under shed_lowest with only P3 present, equal priority never evicts equal → sheds.
  assert.equal(stats.buffered, 8);
  assert.equal(stats.shed, 992);
  assert.equal(stats.evicted, 0);
  assert.equal(stats.shedP3, 992);
  // Every offer answered an explicit outcome; none threw.
  assert.ok(results.every(r => BUFFER_OUTCOMES.includes(r)));
  const drained = buf.take();
  assert.equal(drained.length, 8);
  assert.equal(buf.stats().size, 0);
  // FIFO order preserved for the survivors (first 8 admits).
  assert.deepEqual(drained.map(e => e.payload.id), [0, 1, 2, 3, 4, 5, 6, 7]);
});

test('P9.6 priority shedding: low-priority records shed before critical evidence', () => {
  const buf = createTelemetryBuffer({ capacity: 4, overflowPolicy: 'shed_lowest' });
  // Fill with P3/P4 performance/debug telemetry.
  assert.equal(buf.offer(rec('P4', 1)), 'buffered');
  assert.equal(buf.offer(rec('P3', 2)), 'buffered');
  assert.equal(buf.offer(rec('P4', 3)), 'buffered');
  assert.equal(buf.offer(rec('P3', 4)), 'buffered');
  // Critical P0 arrives → evicts exactly one lowest (a P4), never a P0/P1.
  assert.equal(buf.offer(rec('P0', 5)), 'buffered');
  let stats = buf.stats();
  assert.equal(stats.evicted, 1);
  assert.equal(stats.evictedP4, 1);
  assert.equal(stats.shed, 0);
  assert.equal(stats.size, 4);
  // Another P0 → evicts the remaining P4 (still strictly lower).
  assert.equal(buf.offer(rec('P0', 6)), 'buffered');
  stats = buf.stats();
  assert.equal(stats.evicted, 2);
  assert.equal(stats.evictedP4, 2);
  assert.equal(stats.size, 4);
  // Buffer now: P3, P3, P0, P0 (eviction scans lowest class first).
  const contents = buf.take();
  const priorities = contents.map(e => e.priority);
  assert.ok(priorities.includes('P0'));
  assert.equal(priorities.filter(p => p === 'P0').length, 2);
  assert.equal(priorities.filter(p => p === 'P3').length, 2);
  // Now fill with only P0s; a P0 cannot evict a P0 → sheds incoming.
  const p0buf = createTelemetryBuffer({ capacity: 2, overflowPolicy: 'shed_lowest' });
  assert.equal(p0buf.offer(rec('P0', 1)), 'buffered');
  assert.equal(p0buf.offer(rec('P0', 2)), 'buffered');
  assert.equal(p0buf.offer(rec('P0', 3)), 'shed');
  assert.equal(p0buf.stats().evicted, 0);
  assert.equal(p0buf.stats().shedP0, 1);
  // P1 arriving at full-P0 buffer sheds (equal-or-higher criticality stays).
  assert.equal(p0buf.offer(rec('P1', 4)), 'shed');
  assert.equal(p0buf.stats().shedP1, 1);
  // But P0 arriving at full-P1 buffer evicts a P1.
  const p1buf = createTelemetryBuffer({ capacity: 1, overflowPolicy: 'shed_lowest' });
  assert.equal(p1buf.offer(rec('P1', 1)), 'buffered');
  assert.equal(p1buf.offer(rec('P0', 2)), 'buffered');
  assert.equal(p1buf.stats().evicted, 1);
  assert.equal(p1buf.take()[0].priority, 'P0');
});

test('P9.6 reject_incoming policy is deterministic FIFO protection', () => {
  const buf = createTelemetryBuffer({ capacity: 2, overflowPolicy: 'reject_incoming' });
  assert.equal(buf.offer(rec('P4', 1)), 'buffered');
  assert.equal(buf.offer(rec('P0', 2)), 'buffered');
  // Even a more critical record cannot enter or evict under this policy.
  assert.equal(buf.offer(rec('P0', 3)), 'shed');
  assert.equal(buf.stats().evicted, 0);
  assert.equal(buf.stats().size, 2);
  assert.equal(buf.stats().shedP0, 1);
  assert.deepEqual(buf.take().map(e => e.payload.id), [1, 2]);
});

test('P9.6 drop observability: counters expose every non-admitted record by class', () => {
  const buf = createTelemetryBuffer({ capacity: 2 });
  buf.offer(rec('P3'));
  buf.offer(rec('P4'));
  buf.offer(rec('P4')); // shed (equal)
  buf.offer(rec('P2')); // evict a P4 (lowest strictly lower than P2)
  buf.offer(null);      // rejected
  buf.offer({});        // rejected
  buf.offer({ priority: 'PX', payload: 1 }); // rejected
  const s = buf.stats();
  assert.equal(s.size, 2);
  assert.ok(s.droppedTotal >= 2);
  assert.equal(s.shed + s.rejected, s.droppedTotal);
  assert.equal(s.shedP4, 1); // equal-priority incoming shed
  assert.equal(s.evicted, 1);
  assert.equal(s.evictedP4, 1); // P4 resident evicted for P2
  assert.equal(s.offerTotal, 7); // every offer accounted exactly once
  // Occupancy is exposed for the telemetry.buffered/queue_depth metric seam.
  assert.ok(s.occupancy > 0 && s.occupancy <= 1);
  assert.equal(s.overflowPolicy, 'shed_lowest');
});

test('P9.6 malformed records reject without reading payload accessors or throwing', () => {
  const buf = createTelemetryBuffer({ capacity: 2 });
  const throwing = { priority: 'P0' };
  Object.defineProperty(throwing, 'payload', { enumerable: true, get() { throw Error('secret'); } });
  // Descriptor without value → rejected before payload is read.
  assert.equal(buf.offer(throwing), 'rejected');
  assert.equal(buf.offer({ priority: 'P0' }), 'rejected'); // missing payload key
  assert.equal(buf.offer({ priority: 'P0', payload: 1, extra: 2 }), 'rejected'); // unknown key
  assert.equal(buf.offer({ priority: 'P0', payload: undefined }), 'rejected');
  assert.equal(buf.offer({ priority: 'P0', payload: () => {} }), 'rejected');
  assert.equal(buf.offer({ priority: 7, payload: 1 }), 'rejected');
  assert.equal(buf.offer(Object.assign(Object.create(null), { priority: 'P0', payload: 1 }) && { priority: 'P0', payload: { ok: 1 } }), 'buffered');
  // Proxy that throws on ownKeys → rejected, never throws to caller.
  const evil = new Proxy({}, { ownKeys() { throw Error('x'); } });
  assert.equal(buf.offer(evil), 'rejected');
  assert.equal(buf.stats().rejected >= 6, true);
  // take bounds
  assert.equal(buf.take(-1), null);
  assert.equal(buf.take(1.5), null);
  assert.equal(buf.take(BUFFER_LIMITS.takeMax + 1), null);
  assert.equal(createTelemetryBuffer({ capacity: 1 }).take(0).length, 0);
});

test('P9.6 workflow A/B under saturation: business result identical with buffer present, full, or absent', () => {
  const business = (input) => input.map(x => x * 2).reduce((a, b) => a + b, 0);
  const input = Object.freeze([1, 2, 3, 4, 5]);
  const baseline = business(input);
  // A: no buffer in scope.
  assert.equal(business(input), baseline);
  // B: healthy buffer absorbs lifecycle telemetry.
  const healthy = createTelemetryBuffer({ capacity: 64 });
  for (let i = 0; i < 32; i++) healthy.offer(rec('P2', i));
  assert.equal(business(input), baseline);
  // C: saturated buffer — every offer returns a string, none throws; result unchanged.
  const sat = createTelemetryBuffer({ capacity: 4 });
  let outcomes = [];
  for (let i = 0; i < 10000; i++) outcomes.push(sat.offer(rec(i % 5 === 0 ? 'P0' : 'P4', i)));
  assert.equal(business(input), baseline);
  assert.ok(outcomes.every(o => BUFFER_OUTCOMES.includes(o)));
  assert.ok(sat.stats().size <= 4);
  // Business call does not depend on drain: buffer may be full or emptied.
  sat.take();
  assert.equal(business(input), baseline);
  // D: invalid config (null) is simply absent — caller holds no queue.
  assert.equal(createTelemetryBuffer({ capacity: 0 }), null);
  assert.equal(business(input), baseline);
});

test('P9.6 overload stays within memory budget: multi-cycle fill/drain never exceeds capacity', () => {
  const capacity = 16;
  const buf = createTelemetryBuffer({ capacity });
  let maxSeen = 0;
  for (let cycle = 0; cycle < 50; cycle++) {
    for (let i = 0; i < 100; i++) buf.offer(rec(i % 2 ? 'P3' : 'P1', i));
    const s = buf.stats();
    assert.equal(s.size <= capacity, true);
    if (s.size > maxSeen) maxSeen = s.size;
    assert.equal(s.peakSize <= capacity, true);
    const batch = buf.take(7);
    assert.ok(batch.length <= 7);
    assert.equal(buf.stats().size, s.size - batch.length);
  }
  assert.equal(maxSeen, capacity);
  const final = buf.stats();
  assert.equal(final.buffered + final.droppedTotal, 50 * 100);
  assert.equal(final.offerTotal, 50 * 100);
  // No code path created a second implicit queue: only capacity slots exist.
  const source = readFileSync(new URL('../src/lego/telemetry-buffer.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\b(?:fetch|setTimeout|setInterval|writeFile|readFile|appendFile|console\.(?:log|error))\s*\(/);
  assert.match(source, /new Array\(capacity\)/);
});

test('P9.6 schema-adjacent doc + locked row describe the buffer contract', () => {
  const lock = JSON.parse(readFileSync(new URL('../src/lego/contracts/contract-lock.json', import.meta.url), 'utf8'));
  const rows = lock.contracts.filter(row => row.id === TELEMETRY_BUFFER_CONTRACT.id);
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.owner, 'agent-6');
  assert.equal(row.domain, 'observability');
  assert.equal(row.version, '1.0.0');
  assert.deepEqual(row.surface, ['src/lego/telemetry-buffer.mjs']);
  assert.deepEqual(row.exports['src/lego/telemetry-buffer.mjs'], [
    'TELEMETRY_BUFFER_CONTRACT', 'TELEMETRY_PRIORITY_CLASSES', 'TELEMETRY_PRIORITY_DESCRIPTIONS',
    'BUFFER_LIMITS', 'BUFFER_OUTCOMES', 'BUFFER_OVERFLOW_POLICIES', 'createTelemetryBuffer',
  ]);
  assert.deepEqual(row.tests, ['apps/n8n-lego/test/lego-telemetry-buffer.test.mjs']);
  assert.equal(lock.contracts.length, 100); // P9.7 adds observability.telemetry-redaction@1.0.0; P9.8 adds observability.telemetry-sampling@1.0.0; P9.9 adds observability.resource-pressure@1.0.0; P9.10 adds observability.health-readiness@1.0.0; P9.11 adds observability.execution-diagnostics@1.0.0; P9.12 adds observability.diagnostic-bundle@1.0.0; P9.13 adds observability.failure-correlation@1.0.0; P9.14 adds observability.replay-evidence@1.0.0; P9.15 adds observability.telemetry-retention@1.0.0; P9.16 adds observability.operator-inspection@1.0.0; P9.17 adds observability.low-resource-mode@1.0.0; P9.18 adds observability.self-observability@1.0.0; P9.19 adds observability.tenant-isolation@1.0.0; P9.20 adds observability.contract-oracle@1.0.0; P9.21 adds observability.advanced-diagnostics@1.0.0; P9.22 adds observability.p9-acceptance@1.0.0; count-pins say 75 // P9.6 adds observability.telemetry-buffer=59 // P9 integration (Agent 1): P9.5-P9.22 add 18 observability.* rows on top of protected main 76 -> 94 (union, zero id collisions); P9 was developed on 24032a0c (57 rows). P5.1 adds the ninety-fifth (auth.principal). P5.2 adds the ninety-sixth (auth.session). P5.3 adds the ninety-seventh (auth.authorization). P5.5 adds the ninety-eighth (auth.credential-crypto). P5.6 adds the ninety-ninth (auth.account-security). P5.7 adds the hundredth (auth.machine-identity).
  const doc = readFileSync(new URL('../../../docs/architecture/p9/P9.6-TELEMETRY-BUFFER.md', import.meta.url), 'utf8');
  assert.match(doc, /P0/);
  assert.match(doc, /shed_lowest/);
  assert.match(doc, /hard maximum|hard capacity/i);
});
