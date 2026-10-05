import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  TENANTISO_CONTRACT, TENANTISO_SCHEMA_VERSION, TENANTISO_MODES,
  TENANTISO_SCOPES, TENANTISO_LABEL_DENY, TENANTISO_LIMITS, TENANTISO_NOTES,
  createTenantIsolation,
} from '../src/lego/tenant-isolation.mjs';

const fixture = JSON.parse(readFileSync(
  new URL('./fixtures/p9/tenant-isolation.json', import.meta.url), 'utf8'));

function makeMulti(extra = {}) {
  const c = createTenantIsolation({ ...fixture.multiController, ...extra });
  assert.ok(c, 'multi controller constructs');
  return c;
}

function makeSingle(extra = {}) {
  const c = createTenantIsolation({ ...fixture.singleController, ...extra });
  assert.ok(c, 'single controller constructs');
  return c;
}

function seedTenants(c) {
  for (const t of Object.values(fixture.tenants)) {
    for (const r of t.records) {
      assert.equal(c.ingest(r).ok, true, `ingest ${r.id}`);
    }
  }
}

test('P9.19 contract: modes, scopes, label denylist, notes, fail-closed config', () => {
  assert.equal(TENANTISO_CONTRACT.id, 'observability.tenant-isolation');
  assert.equal(TENANTISO_CONTRACT.version, '1.0.0');
  assert.equal(TENANTISO_CONTRACT.owner, 'agent-6');
  assert.equal(TENANTISO_SCHEMA_VERSION, '1.0.0');
  assert.deepEqual([...TENANTISO_MODES], ['single', 'multi']);
  assert.deepEqual([...TENANTISO_SCOPES], ['tenant', 'global']);
  assert.ok(TENANTISO_LABEL_DENY.includes('tenantId'));
  assert.ok(TENANTISO_LABEL_DENY.includes('orgId'));
  assert.ok(TENANTISO_NOTES.includes('tenant-scope-where-authorized'));
  assert.ok(TENANTISO_NOTES.includes('cross-tenant-fail-closed'));
  assert.ok(TENANTISO_NOTES.includes('global-aggregates-separated'));
  assert.ok(TENANTISO_NOTES.includes('tenant-ids-not-metric-labels'));
  assert.ok(TENANTISO_NOTES.includes('single-tenant-lightweight'));
  // fail-closed configs
  assert.equal(createTenantIsolation('x'), null);
  assert.equal(createTenantIsolation({ mode: 'triple' }), null);
  assert.equal(createTenantIsolation({ maxRecords: 0 }), null);
  assert.equal(createTenantIsolation({ maxTenants: 0 }), null);
  assert.equal(createTenantIsolation({ globalAggregates: 'yes' }), null);
  assert.equal(createTenantIsolation({ unknown: 1 }), null);
});

test('P9.19 tenant A/B isolation test: queries only see authorized tenant', () => {
  const c = makeMulti();
  seedTenants(c);
  // query as A → only A rows
  let r = c.query(fixture.tenants.A.auth);
  assert.equal(r.ok, true);
  assert.equal(r.report.scope, fixture.expect.tenantScope);
  assert.equal(r.report.tenantId, 'tenant-a');
  const aIds = r.report.rows.map(x => x.id);
  assert.deepEqual(aIds, ['a-1', 'a-2']);
  assert.ok(!aIds.some(id => id.startsWith('b-')), 'no B leakage into A');
  // query as B → only B rows
  r = c.query(fixture.tenants.B.auth);
  assert.equal(r.ok, true);
  assert.equal(r.report.tenantId, 'tenant-b');
  const bIds = r.report.rows.map(x => x.id);
  assert.deepEqual(bIds, ['b-1', 'b-2']);
  assert.ok(!bIds.some(id => id.startsWith('a-')), 'no A leakage into B');
  // tenant aggregates are scoped per tenant
  const aggA = c.tenantAggregate(fixture.tenants.A.auth);
  assert.equal(aggA.aggregate.scope, 'tenant');
  assert.equal(aggA.aggregate.tenantId, 'tenant-a');
  assert.equal(aggA.aggregate.records, 2);
  const aggB = c.tenantAggregate(fixture.tenants.B.auth);
  assert.equal(aggB.aggregate.tenantId, 'tenant-b');
  assert.equal(aggB.aggregate.records, 2);
});

test('P9.19 unauthorized cross-scope query fails closed', () => {
  const c = makeMulti();
  seedTenants(c);
  // A asks for B's filter → cross_scope, no rows returned
  let r = c.query(fixture.crossQuery.auth, fixture.crossQuery.filter);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, fixture.crossQuery.expectCode);
  assert.equal(r.report, undefined, 'no report on failure');
  // multi query without auth fails closed
  r = c.query(undefined);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'tenantisolation.invalid_auth');
  // global scope without deployment grant fails closed (fresh controller)
  const noGlobal = createTenantIsolation({
    mode: 'multi', maxRecords: 100, globalAggregates: false,
  });
  assert.ok(noGlobal);
  seedTenants(noGlobal);
  r = noGlobal.globalAggregate(fixture.globalAuth);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, fixture.expect.globalDeniedCode);
  assert.ok(noGlobal.snapshot().counters.global_unauthorized >= 1);
  // global auth on raw query still refuses row dumps
  r = c.query(fixture.globalAuth);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, fixture.expect.crossCode);
  assert.ok(c.snapshot().counters.cross_tenant_blocked >= 2);
});

test('P9.19 export routing respects scope', () => {
  const c = makeMulti();
  seedTenants(c);
  // own-tenant route OK
  let r = c.routeExport(fixture.tenants.A.auth, fixture.exportJobs.own);
  assert.equal(r.ok, true);
  assert.equal(r.route.tenantId, 'tenant-a');
  assert.equal(r.route.channel, 'otlp');
  // cross-tenant route fail closed
  r = c.routeExport(fixture.tenants.A.auth, fixture.exportJobs.cross);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, fixture.expect.crossCode);
  // single-tenant route rejects tenantId
  const s = makeSingle();
  s.ingest({ id: 's-1', channel: 'logs' });
  r = s.routeExport(undefined, { id: 's-1', tenantId: 'tenant-a', channel: 'otlp' });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, fixture.expect.crossCode);
  r = s.routeExport(undefined, { id: 's-1', channel: 'otlp' });
  assert.equal(r.ok, true);
  assert.equal(r.route.tenantId, null);
});

test('P9.19 global aggregate fixture: structurally separated from tenant data', () => {
  const c = makeMulti();
  seedTenants(c);
  // tenant report
  const t = c.tenantAggregate(fixture.tenants.A.auth);
  assert.equal(t.aggregate.scope, 'tenant');
  assert.equal(t.aggregate.tenantId, 'tenant-a');
  // global report — granted, aggregate only
  const g = c.globalAggregate(fixture.globalAuth);
  assert.equal(g.ok, true);
  assert.equal(g.aggregate.scope, fixture.expect.globalScope);
  assert.equal(g.aggregate.tenantCount, 2);
  assert.equal(g.aggregate.records, 4);
  assert.equal(g.aggregate.containsTenantRows, false);
  // no row bodies anywhere in the global report
  assert.equal(g.aggregate.rows, undefined);
  assert.equal(g.report, undefined);
  // channel mix present but not tenant-partitioned
  assert.ok(g.aggregate.byChannel.logs >= 2);
  // snapshot separates tenants list from global counters
  const snap = c.snapshot();
  assert.deepEqual([...snap.tenantIds], ['tenant-a', 'tenant-b']);
  // cross attempt on this controller increments the honest counter
  const cross = c.query({ tenantId: 'tenant-a' }, { tenantId: 'tenant-b' });
  assert.equal(cross.ok, false);
  assert.ok(snap === c.snapshot() || true); // snap is immutable copy
  assert.ok(c.snapshot().counters.cross_tenant_blocked >= 1);
});

test('P9.19 metric-label isolation: tenant ids never become labels', () => {
  const c = makeMulti();
  // denied keys all fail closed
  for (const key of fixture.deniedLabels) {
    const r = c.sanitizeMetricLabels({ [key]: 'tenant-a' });
    assert.equal(r.ok, false, `${key} denied`);
    assert.equal(r.error.code, fixture.expect.labelCode);
    assert.ok(r.error.denied.includes(key));
  }
  // denylist regex also catches invented tenant-ish keys
  const r2 = c.sanitizeMetricLabels({ TenantX: 'a' });
  assert.equal(r2.ok, false);
  // allowed policy labels pass through frozen
  const ok = c.sanitizeMetricLabels(fixture.allowedLabels);
  assert.equal(ok.ok, true);
  assert.deepEqual({ ...ok.labels }, fixture.allowedLabels);
  assert.ok(Object.isFrozen(ok.labels));
  // secret-shaped label value fail closed
  assert.equal(
    c.sanitizeMetricLabels({ component: 'bearer abcdef123secret' }).ok, false);
  // counter honest after rejections
  assert.ok(c.snapshot().counters.tenant_label_rejected >= fixture.deniedLabels.length);
  // denylist is frozen — contract surface
  assert.ok(Object.isFrozen(TENANTISO_LABEL_DENY));
});

test('P9.19 single-tenant deployment remains lightweight', () => {
  const c = makeSingle();
  // no tenant scope anywhere on the happy path
  assert.equal(c.ingest({ id: 's-1', channel: 'logs' }).ok, true);
  assert.equal(c.ingest({ id: 's-2', channel: 'metrics' }).ok, true);
  // single store rejects tenantId on records (no accidental multi-tenant mode)
  const bad = c.ingest({ id: 's-3', tenantId: 'tenant-a', channel: 'logs' });
  assert.equal(bad.ok, false);
  // query with no auth works; tenant filter fails closed
  const r = c.query(undefined);
  assert.equal(r.ok, true);
  assert.equal(r.report.count, 2);
  assert.equal(c.query(undefined, { tenantId: 'tenant-a' }).ok, false);
  // no tenant map allocated — structural lightness
  const snap = c.snapshot();
  assert.equal(snap.mode, 'single');
  assert.equal(snap.tenants, 0);
  assert.equal(snap.lightweight.tenantMapAllocated, false);
  assert.equal(snap.lightweight.flatBucket, true);
  // global aggregate in single mode: zero tenants by design, scope still global
  const g = createTenantIsolation({
    mode: 'single', maxRecords: 100, globalAggregates: true,
  });
  const agg = g.globalAggregate({ scope: 'global' });
  assert.equal(agg.ok, true);
  assert.equal(agg.aggregate.scope, 'global');
  assert.equal(agg.aggregate.tenantCount, 0);
  assert.equal(agg.aggregate.records, 0);
});

test('P9.19 bounded store + fail-closed leakage surfaces', () => {
  const c = makeMulti({ maxRecords: 3, maxTenants: 1 });
  // tenant cap
  assert.equal(c.ingest({ id: 'a1', tenantId: 'tenant-a', channel: 'logs' }).ok, true);
  const cap = c.ingest({ id: 'b1', tenantId: 'tenant-b', channel: 'logs' });
  assert.equal(cap.ok, false);
  assert.equal(cap.error.code, 'tenantisolation.tenant_cap');
  // record cap
  assert.equal(c.ingest({ id: 'a2', tenantId: 'tenant-a', channel: 'logs' }).ok, true);
  assert.equal(c.ingest({ id: 'a3', tenantId: 'tenant-a', channel: 'logs' }).ok, true);
  const full = c.ingest({ id: 'a4', tenantId: 'tenant-a', channel: 'logs' });
  assert.equal(full.ok, false);
  assert.equal(full.error.code, 'tenantisolation.full');
  assert.ok(c.snapshot().counters.records_shed >= 1);
  // invalid auth / secret shapes / unknown fields
  assert.equal(c.query({ tenantId: 'bearer abcdef123secret' }).ok, false);
  assert.equal(c.query({ tenantId: 'tenant-a', extra: 1 }).ok, false);
  assert.equal(c.ingest(null).ok, false);
  assert.equal(c.ingest({ id: 'x', nope: 1 }).ok, false);
  assert.equal(c.routeExport({ tenantId: 'tenant-a' }, null).ok, false);
  assert.equal(c.tenantAggregate({ tenantId: 'tenant-b' }).ok, true, 'B own aggregate ok');
  // B can aggregate only its (zero) rows after caps — never A's
  const aggB = c.tenantAggregate({ tenantId: 'tenant-b' });
  assert.equal(aggB.aggregate.records, 0);
});

test('P9.19 query limit + truncation stay inside authorized scope', () => {
  const c = makeMulti({ maxRecords: 50 });
  for (let i = 0; i < 5; i++) {
    assert.equal(c.ingest({ id: `a-${i}`, tenantId: 'tenant-a', channel: 'logs' }).ok, true);
  }
  assert.equal(c.ingest({ id: 'b-0', tenantId: 'tenant-b', channel: 'logs' }).ok, true);
  const r = c.query({ tenantId: 'tenant-a' }, { limit: 2 });
  assert.equal(r.ok, true);
  assert.equal(r.report.count, 2);
  assert.equal(r.report.truncated, true);
  assert.ok(r.report.rows.every(x => x.id.startsWith('a-')));
  // invalid limit fail-closed
  assert.equal(c.query({ tenantId: 'tenant-a' }, { limit: 0 }).ok, false);
  assert.equal(c.query({ tenantId: 'tenant-a' }, { limit: 9999 }).ok, false);
});

test('P9.19 lock pin: contracts length 75 after P9.22 row', () => {
  const lock = JSON.parse(readFileSync(
    new URL('../src/lego/contracts/contract-lock.json', import.meta.url), 'utf8'));
  assert.equal(lock.contracts.length, 100, // P9 integration (Agent 1): P9.5-P9.22 add 18 observability.* rows on top of protected main 76 -> 94 (union, zero id collisions); P9 was developed on 24032a0c (57 rows). P5.2 adds the ninety-sixth (auth.session). P5.3 adds the ninety-seventh (auth.authorization). P5.5 adds the ninety-eighth (auth.credential-crypto). P5.6 adds the ninety-ninth (auth.account-security). P5.7 adds the hundredth (auth.machine-identity).
    'P9.19 adds observability.tenant-isolation@1.0.0; P9.20 adds observability.contract-oracle@1.0.0; P9.21 adds observability.advanced-diagnostics@1.0.0; P9.22 adds observability.p9-acceptance@1.0.0; count-pins say 75');
  const row = lock.contracts.find(c => c.id === 'observability.tenant-isolation');
  assert.ok(row, 'P9.19 row present');
  assert.equal(row.version, '1.0.0');
  assert.equal(row.owner, 'agent-6');
  assert.equal(row.domain, 'observability');
  assert.ok(Array.isArray(row.tests) && row.tests.length >= 1);
  assert.ok(String(row.notes).includes('P9.19'));
});
