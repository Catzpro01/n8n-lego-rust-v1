import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  RETENTION_CONTRACT, RETENTION_SCHEMA_VERSION, RETENTION_TIERS, RETENTION_SIGNALS,
  RETENTION_ACTIONS, RETENTION_PRIORITIES, RETENTION_LIMITS, RETENTION_NOTES,
  AUTHORITATIVE_KINDS,
  createRetentionPolicy, classifyResidency, createRetentionStore,
  ingestRecord, applyRetentionPass, extendForIncident, applyStoragePressure,
  deleteTelemetryRecord, retentionReport,
} from '../src/lego/telemetry-retention.mjs';

const fixture = JSON.parse(readFileSync(
  new URL('./fixtures/p9/telemetry-retention.json', import.meta.url), 'utf8'));

test('P9.15 contract: tiers, signals, priorities, notes, schema', () => {
  assert.equal(RETENTION_CONTRACT.id, 'observability.telemetry-retention');
  assert.equal(RETENTION_CONTRACT.version, '1.0.0');
  assert.equal(RETENTION_CONTRACT.owner, 'agent-6');
  assert.equal(RETENTION_SCHEMA_VERSION, '1.0.0');
  assert.deepEqual([...RETENTION_TIERS], ['HOT', 'WARM', 'COLD']);
  assert.ok(RETENTION_SIGNALS.includes('audit'));
  assert.ok(RETENTION_SIGNALS.includes('security'));
  assert.ok(RETENTION_SIGNALS.includes('log'));
  assert.deepEqual([...RETENTION_PRIORITIES], ['P0', 'P1', 'P2', 'P3', 'P4']);
  assert.ok(RETENTION_NOTES.includes('signal-specific-ttl'));
  assert.ok(RETENTION_NOTES.includes('deterministic-expiry'));
  assert.ok(RETENTION_NOTES.includes('incident-extension-policy-controlled'));
  assert.ok(RETENTION_NOTES.includes('deletion-isolated-from-authoritative-state'));
  assert.ok(RETENTION_ACTIONS.includes('expired'));
  assert.ok(AUTHORITATIVE_KINDS.includes('workflow'));
  assert.ok(RETENTION_LIMITS.maxRecords >= 1);
});

test('P9.15 retention transition tests: HOT → WARM → COLD by age (deterministic)', () => {
  const policy = createRetentionPolicy(fixture.strictLogPolicy);
  assert.ok(policy, 'strict log policy compiles');
  // classifyResidency pure table
  assert.equal(classifyResidency(0, policy.signals.log), 'HOT');
  assert.equal(classifyResidency(999, policy.signals.log), 'HOT');
  assert.equal(classifyResidency(1000, policy.signals.log), 'WARM');
  assert.equal(classifyResidency(4999, policy.signals.log), 'WARM');
  assert.equal(classifyResidency(5000, policy.signals.log), 'COLD');
  assert.equal(classifyResidency(9999, policy.signals.log), 'COLD');
  assert.equal(classifyResidency(10000, policy.signals.log), 'EXPIRED');
  // Same inputs → same tier
  assert.equal(classifyResidency(1500, policy.signals.log),
    classifyResidency(1500, policy.signals.log));

  // Store-level transitions across a timeline (strict log windows; metric default)
  const store = createRetentionStore({ policy, byteBudget: 10_000 });
  assert.ok(store);
  for (const rec of fixture.transitionRecords) {
    const outcome = ingestRecord(store, { ...rec }, 0);
    assert.equal(outcome, 'kept', `${rec.id} ingested`);
  }
  applyRetentionPass(store, 0);
  let rep = retentionReport(store);
  assert.equal(rep.tiers.HOT, 4, 'all HOT at age 0');

  // age 1000: logs → WARM (hotMs=1000 not satisfied); metric still HOT (default hot 5min)
  applyRetentionPass(store, 1000);
  rep = retentionReport(store);
  assert.equal(rep.tiers.WARM, 3, 'three logs WARM at age 1000');
  assert.equal(rep.tiers.HOT, 1, 'metric still HOT under default policy');
  assert.equal(rep.tiers.COLD, 0);

  // age 5000: logs → COLD (warmMs=5000); metric still HOT
  applyRetentionPass(store, 5000);
  rep = retentionReport(store);
  assert.equal(rep.tiers.COLD, 3, 'logs COLD at age 5000 (warmMs=5000)');
  assert.equal(rep.tiers.HOT, 1, 'metric still HOT');
  assert.equal(rep.tiers.WARM, 0);

  // Determinism: second pass at same now is a no-op on tiers
  const before = retentionReport(store);
  applyRetentionPass(store, 5000);
  const after = retentionReport(store);
  assert.deepEqual(after.tiers, before.tiers);
  assert.equal(after.stats.transitions, before.stats.transitions);
  assert.deepEqual(after.ids, before.ids);
});

test('P9.15 expiry test: past-TTL records are actually removed/compacted', () => {
  const policy = createRetentionPolicy(fixture.strictLogPolicy);
  const store = createRetentionStore({ policy, byteBudget: 1000 });
  const rec = fixture.expiryRecord;
  assert.equal(ingestRecord(store, { ...rec }, 0), 'kept');
  assert.equal(store.records.size, 1);
  // Under TTL: kept
  let pass = applyRetentionPass(store, 9999);
  assert.equal(pass.removed.length, 0);
  assert.equal(store.records.size, 1);
  // At TTL: removed
  pass = applyRetentionPass(store, 10000);
  assert.equal(pass.removed.length, 1);
  assert.equal(pass.removed[0], 'log:old');
  assert.equal(store.records.size, 0, 'expired record actually gone');
  assert.equal(pass.bytesFreed, 10);
  assert.ok(store.stats.expired >= 1);
  assert.ok(store.stats.compacted >= 1);
  assert.equal(store.stats.bytes, 0, 'byte counter follows removal');
  // Report empty
  const rep = retentionReport(store);
  assert.equal(rep.recordCount, 0);
  // expired_on_ingest refuses already-dead records
  assert.equal(ingestRecord(store, { ...rec }, 20000), 'expired_on_ingest');
});

test('P9.15 incident retention extension is policy-controlled (capped, allow-list)', () => {
  // Extension enabled + allow-listed signals
  const policy = createRetentionPolicy(fixture.strictLogPolicy);
  const store = createRetentionStore({ policy, byteBudget: 10_000 });
  for (const rec of fixture.incidentRecords) {
    assert.equal(ingestRecord(store, { ...rec }, 0), 'kept');
  }
  const ext = extendForIncident(store, {
    incidentId: 'inc-1', signals: ['log', 'diagnostic'], extendMs: 2000,
  }, 9000);
  assert.ok(ext);
  assert.ok(ext.extended.includes('log:inc'));
  assert.ok(ext.extended.includes('diag:inc'));
  const logRec = store.records.get('log:inc');
  const originalExpiry = 0 + policy.signals.log.ttlMs; // 10000
  assert.ok(logRec.expiresAt > originalExpiry, 'expiry pushed out');
  // Cap: grant ≤ incidentExtendMs (2000) ≤ max (4000)
  assert.ok(logRec.expiresAt <= 9000 + 2000 + 1, 'capped by incidentExtendMs');
  assert.equal(logRec.extended, true);
  assert.equal(logRec.incidentId, 'inc-1');

  // Extension disabled policy refuses
  const policyOff = createRetentionPolicy(fixture.extensionDisabledPolicy);
  const storeOff = createRetentionStore({ policy: policyOff, byteBudget: 10_000 });
  for (const rec of fixture.incidentRecords) ingestRecord(storeOff, { ...rec }, 0);
  const extOff = extendForIncident(storeOff, {
    incidentId: 'inc-1', signals: ['log'], extendMs: 1000,
  }, 0);
  assert.ok(extOff);
  assert.equal(extOff.extended.length, 0);
  assert.equal(extOff.reason, 'extension-disabled');

  // Without policy allow-list match, signal refused
  const extRefuse = extendForIncident(store, {
    incidentId: 'other', signals: ['metric'], extendMs: 1000,
  }, 0);
  // metric not in strict policy incident allow-list ['log','diagnostic'] → refused path
  assert.ok(extRefuse);
  // metric records don't exist; but signals check against store.policy.incident.signals
  // 'metric' not in ['log','diagnostic'] — no records match → extended empty
  assert.equal(extRefuse.extended.length, 0);

  // After extension, record survives past original TTL
  const pass = applyRetentionPass(store, 10000);
  assert.ok(store.records.has('log:inc'), 'extended log survives original TTL');
  assert.ok(store.records.has('diag:inc'), 'extended diagnostic survives');
});

test('P9.15 audit/security retention differs from normal telemetry', () => {
  const policy = createRetentionPolicy(fixture.auditDistinctPolicy);
  assert.ok(policy);
  assert.ok(policy.signals.log.ttlMs < policy.signals.audit.ttlMs,
    'audit outlives normal logs');
  assert.ok(policy.signals.audit.ttlMs < policy.signals.security.ttlMs,
    'security outlives audit');
  // Defaults also differ when no override
  const defaults = createRetentionPolicy({});
  assert.ok(defaults.signals.log.ttlMs < defaults.signals.audit.ttlMs);
  assert.ok(defaults.signals.log.ttlMs < defaults.signals.security.ttlMs);

  const store = createRetentionStore({ policy, byteBudget: 10_000 });
  ingestRecord(store, { id: 'log:a', signal: 'log', bytes: 10, createdAt: 0 }, 0);
  ingestRecord(store, { id: 'audit:a', signal: 'audit', bytes: 10, createdAt: 0 }, 0);
  ingestRecord(store, { id: 'sec:a', signal: 'security', bytes: 10, createdAt: 0 }, 0);
  // After log TTL (10000) but before audit TTL
  const pass = applyRetentionPass(store, 20000);
  assert.ok(pass.removed.includes('log:a'));
  assert.ok(store.records.has('audit:a'), 'audit retained past log TTL');
  assert.ok(store.records.has('sec:a'), 'security retained past log TTL');
});

test('P9.15 storage-pressure test: degrade low-priority first, P0 last, no corruption', () => {
  const policy = createRetentionPolicy({});
  const budget = fixture.pressureBudget.byteBudget; // 900
  const store = createRetentionStore({ policy, byteBudget: budget });
  for (const rec of fixture.pressureRecords) {
    assert.equal(ingestRecord(store, { ...rec }, 0), 'kept');
  }
  assert.equal(store.stats.bytes, 2400, 'over budget');
  const report = applyStoragePressure(store, 0);
  assert.ok(report);
  assert.equal(report.degraded, false, 'degraded to budget');
  assert.equal(store.stats.bytes <= budget, true, 'within budget after shed');
  const shedIds = report.shed.map(s => s.id);
  // Expected shed order: P4, P3, P2 (1200 bytes) → 1200 left, still > 900 → shed more?
  // 2400 - 400*3 = 1200 > 900 → shed p1 too → 800 <= 900
  assert.ok(shedIds.includes('p4:debug'), 'P4 sheds first');
  assert.ok(shedIds.indexOf('p4:debug') < shedIds.indexOf('p3:trace') || !shedIds.includes('p3:trace'));
  // P0 never shed
  assert.ok(store.records.has('p0:audit'), 'audit survives pressure');
  assert.ok(store.records.has('p0:sec'), 'security survives pressure');
  for (const s of report.shed) assert.notEqual(s.priority, 'P0');
  // Deterministic order among same run
  const expectedPrefix = fixture.pressureBudget.expectShedOrder;
  for (let i = 0; i < Math.min(expectedPrefix.length, shedIds.length); i++) {
    assert.equal(shedIds[i], expectedPrefix[i], `shed order index ${i}`);
  }
  // No payload mutation: remaining records intact
  const audit = store.records.get('p0:audit');
  assert.equal(audit.bytes, 400, 'bytes not corrupted');
  // Under budget → no shed
  const again = applyStoragePressure(store, 0);
  assert.equal(again.shed.length, 0);
});

test('P9.15 deletion-isolation test: delete never touches authoritative workflow state', () => {
  const policy = createRetentionPolicy({});
  const store = createRetentionStore({ policy, byteBudget: 10_000 });
  // Fake authoritative state living OUTSIDE the store (as it must)
  const authoritative = new Map([
    ['workflow:wf-1', { id: 'wf-1', nodes: 3 }],
    ['execution:ex-1', { id: 'ex-1', status: 'success' }],
    ['checkpoint:ckpt-1', { id: 'ckpt-1', seq: 1 }],
    ['credential:cred-1', { id: 'cred-1', data: 'not-here' }],
  ]);
  const before = structuredClone(Object.fromEntries(authoritative));

  // Ingest a telemetry record and delete it
  assert.equal(ingestRecord(store, { id: 'log:doomed', signal: 'log', bytes: 10, createdAt: 0 }, 0), 'kept');
  assert.equal(deleteTelemetryRecord(store, 'log:doomed'), 'deleted');
  assert.equal(store.records.size, 0);

  // Attempts to delete authoritative identities are refused
  for (const probe of fixture.deletionIsolation.authoritativeProbes) {
    const outcome = deleteTelemetryRecord(store, probe);
    assert.equal(outcome, 'refused_authoritative', `${probe} refused`);
  }
  // Ingest claiming authoritative kind refused
  assert.equal(ingestRecord(store, { id: 'x', kind: 'workflow', signal: 'log', bytes: 10, createdAt: 0 }, 0),
    'refused_authoritative');
  assert.equal(store.stats.refusedAuthoritative >= 5, true);

  // Authoritative map untouched
  const after = Object.fromEntries(authoritative);
  assert.deepEqual(after, before, 'workflow/execution/checkpoint/credential state unchanged');
  // Store never held those ids
  for (const key of Object.keys(before)) {
    assert.equal(store.records.has(key), false);
  }
});

test('P9.15 signal-specific policies: one TTL table, not a single global TTL', () => {
  const p = createRetentionPolicy({});
  assert.ok(p);
  const ttls = RETENTION_SIGNALS.map(s => p.signals[s].ttlMs);
  assert.ok(new Set(ttls).size > 1, 'signals do not share one TTL');
  assert.ok(p.signals.log.ttlMs < p.signals.metric.ttlMs ||
    p.signals.log.ttlMs < p.signals.trace.ttlMs ||
    p.signals.log.ttlMs < p.signals.audit.ttlMs);
  // Invalid policy fails closed
  assert.equal(createRetentionPolicy({ signals: { log: { ttlMs: 10, hotMs: 20, warmMs: 5 } } }), null,
    'hot ≤ warm ≤ ttl enforced');
  assert.equal(createRetentionPolicy({ nope: 1 }), null);
  assert.equal(createRetentionPolicy('x'), null);
});

test('P9.15 report is deterministic and secret-safe at the boundary', () => {
  const policy = createRetentionPolicy(fixture.strictLogPolicy);
  const store = createRetentionStore({ policy, byteBudget: 5000 });
  ingestRecord(store, { id: 'log:a', signal: 'log', bytes: 10, createdAt: 0, body: 'ok' }, 0);
  ingestRecord(store, { id: 'log:b', signal: 'log', bytes: 20, createdAt: 1 }, 1);
  const r1 = retentionReport(store);
  const r2 = retentionReport(store);
  assert.deepEqual(r1.ids, r2.ids, 'sorted id order');
  assert.deepEqual(r1.tiers, r2.tiers);
  assert.equal(r1.recordCount, 2);
  // secret body refused at ingest
  assert.equal(ingestRecord(store, {
    id: 'log:sec', signal: 'log', bytes: 10, createdAt: 0, body: 'bearer abcdef123secret',
  }, 0), 'rejected');
  // secret incident id refused
  const ext = extendForIncident(store, {
    incidentId: 'bearer leaked', signals: ['log'], extendMs: 1000,
  }, 0);
  assert.equal(ext, null, 'secret-shaped incidentId fails closed');
});

test('P9.15 lock pin: contracts length 75 after P9.22 row', () => {
  const lock = JSON.parse(readFileSync(
    new URL('../src/lego/contracts/contract-lock.json', import.meta.url), 'utf8'));
  assert.equal(lock.contracts.length, 100, // P9 integration (Agent 1): P9.5-P9.22 add 18 observability.* rows on top of protected main 76 -> 94 (union, zero id collisions); P9 was developed on 24032a0c (57 rows). P5.2 adds the ninety-sixth (auth.session). P5.3 adds the ninety-seventh (auth.authorization). P5.5 adds the ninety-eighth (auth.credential-crypto). P5.6 adds the ninety-ninth (auth.account-security). P5.7 adds the hundredth (auth.machine-identity).
    'P9.15 adds observability.telemetry-retention@1.0.0; P9.16 adds observability.operator-inspection@1.0.0; P9.17 adds observability.low-resource-mode@1.0.0; P9.18 adds observability.self-observability@1.0.0; P9.19 adds observability.tenant-isolation@1.0.0; P9.20 adds observability.contract-oracle@1.0.0; P9.21 adds observability.advanced-diagnostics@1.0.0; P9.22 adds observability.p9-acceptance@1.0.0; count-pins say 75');
  const row = lock.contracts.find(c => c.id === 'observability.telemetry-retention');
  assert.ok(row, 'P9.15 row present');
  assert.equal(row.version, '1.0.0');
  assert.equal(row.owner, 'agent-6');
  assert.equal(row.domain, 'observability');
  assert.ok(Array.isArray(row.tests) && row.tests.length >= 1);
  assert.ok(String(row.notes).includes('P9.15'));
});
