import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  OPERATOR_CONTRACT, OPERATOR_SCHEMA_VERSION, OPERATOR_INTERFACES, OPERATOR_ROLES,
  OPERATOR_ERRORS, OPERATOR_LIMITS, OPERATOR_NOTES, OPERATOR_ROLE_GRANTS,
  createOperatorApi,
} from '../src/lego/operator-inspection.mjs';

const fixture = JSON.parse(readFileSync(
  new URL('./fixtures/p9/operator-inspection.json', import.meta.url), 'utf8'));

function api(cfg) {
  const a = createOperatorApi(fixture.dataset, {
    indexes: fixture.indexes, maxInFlight: 4, ...cfg,
  });
  assert.ok(a, 'api constructs');
  return a;
}

test('P9.16 contract: interfaces, roles, errors, limits, schema', () => {
  assert.equal(OPERATOR_CONTRACT.id, 'observability.operator-inspection');
  assert.equal(OPERATOR_CONTRACT.version, '1.0.0');
  assert.equal(OPERATOR_CONTRACT.owner, 'agent-6');
  assert.equal(OPERATOR_SCHEMA_VERSION, '1.0.0');
  assert.deepEqual([...OPERATOR_INTERFACES],
    ['health', 'readiness', 'logs', 'metrics', 'traces', 'diagnostics']);
  assert.deepEqual([...OPERATOR_ROLES], ['viewer', 'operator', 'admin']);
  assert.equal(OPERATOR_ERRORS.unauthorized, 'operator.unauthorized');
  assert.equal(OPERATOR_ERRORS.timeout, 'operator.timeout');
  assert.equal(OPERATOR_ERRORS.cancelled, 'operator.cancelled');
  assert.equal(OPERATOR_ERRORS.busy, 'operator.busy');
  assert.ok(OPERATOR_LIMITS.maxLimit >= 1);
  assert.ok(OPERATOR_NOTES.includes('stable-error-codes'));
  assert.ok(OPERATOR_ROLE_GRANTS.viewer.includes('health'));
  assert.equal(OPERATOR_ROLE_GRANTS.guest, undefined);
});

test('P9.16 normal query: authorized interface returns bounded page', () => {
  const a = api();
  const resp = a.query(fixture.normalQuery);
  assert.equal(resp.ok, true);
  assert.equal(resp.result.count, fixture.expect.normalCount);
  assert.equal(resp.result.iface, 'logs');
  assert.equal(resp.result.bounded, true);
  assert.ok(resp.result.count <= fixture.normalQuery.limit);
  for (const iface of OPERATOR_INTERFACES) {
    const r = a.query({ iface, role: 'operator', limit: 5 });
    assert.equal(r.ok, true, iface + ' ok');
    assert.ok(r.result.count <= 5);
  }
});

test('P9.16 large query: pagination + hard limit + index strategy', () => {
  const a = api();
  const first = a.query({ iface: 'logs', role: 'admin', limit: 25 });
  assert.equal(first.ok, true);
  assert.equal(first.result.count, 25);
  assert.equal(first.result.hasMore, true);
  assert.ok(typeof first.result.nextCursor === 'number');

  let cursor = 0;
  let total = 0;
  let pages = 0;
  const pageSize = 25; // deliberately smaller than dataset so multi-page is required
  for (;;) {
    const r = a.query({ iface: 'logs', role: 'admin', limit: pageSize, cursor });
    assert.equal(r.ok, true);
    total += r.result.count;
    pages++;
    assert.ok(r.result.count <= pageSize, 'page bounded');
    assert.ok(r.result.count <= OPERATOR_LIMITS.maxLimit, 'under global max');
    if (!r.result.hasMore) break;
    cursor = r.result.nextCursor;
    assert.ok(pages < 100, 'pagination terminates');
  }
  assert.equal(total, fixture.dataset.logs.length, 'pagination covers dataset once');
  assert.ok(pages >= 2, 'large result required multiple pages');
  // maxLimit page still accepted and bounded
  const bigPage = a.query({ iface: 'logs', role: 'admin', limit: OPERATOR_LIMITS.maxLimit });
  assert.equal(bigPage.ok, true);
  assert.ok(bigPage.result.count <= OPERATOR_LIMITS.maxLimit);

  const tooBig = a.query({ iface: 'logs', role: 'admin', limit: OPERATOR_LIMITS.maxLimit + 1 });
  assert.equal(tooBig.ok, false);
  assert.equal(tooBig.error.code, OPERATOR_ERRORS.invalidQuery);

  const indexed = a.query({
    iface: 'logs', role: 'admin', limit: 100,
    where: { field: 'level', equals: 'error' },
  });
  assert.equal(indexed.ok, true);
  assert.equal(indexed.result.usedIndex, true);
  assert.equal(
    indexed.result.count,
    fixture.dataset.logs.filter(r => r.level === 'error').length,
  );
});

test('P9.16 timeout: stable operator.timeout when deadline exceeded', () => {
  const a = api();
  let t = 0;
  const ctl = { now: () => { t += 10; return t; }, cancelled: () => false };
  const resp = a.query({ iface: 'logs', role: 'viewer', limit: 50, timeoutMs: 5 }, ctl);
  assert.equal(resp.ok, false);
  assert.equal(resp.error.code, fixture.expect.timeoutCode);
  assert.equal(resp.error.code, OPERATOR_ERRORS.timeout);
  assert.equal(typeof resp.error.message, 'string');
  const bad = a.query({ iface: 'logs', role: 'viewer', timeoutMs: 0 });
  assert.equal(bad.error.code, OPERATOR_ERRORS.invalidQuery);
});

test('P9.16 cancellation: stable operator.cancelled mid-scan', () => {
  const a = api();
  let calls = 0;
  const ctl = { now: () => 0, cancelled: () => { calls++; return calls > 3; } };
  const resp = a.query({ iface: 'logs', role: 'viewer', limit: 50, cursor: 0 }, ctl);
  assert.equal(resp.ok, false);
  assert.equal(resp.error.code, fixture.expect.cancelledCode);
  assert.equal(resp.error.code, OPERATOR_ERRORS.cancelled);
});

test('P9.16 unauthorized query: access policy enforced with stable code', () => {
  const a = api();
  const resp = a.query(fixture.unauthorizedQuery);
  assert.equal(resp.ok, false);
  assert.equal(resp.error.code, fixture.expect.unauthorizedCode);
  assert.equal(resp.error.code, OPERATOR_ERRORS.unauthorized);
  assert.equal(resp.error.iface, 'logs');
  assert.equal(resp.error.role, 'guest');
  const r2 = a.query({ iface: 'health', role: 'root' });
  assert.equal(r2.error.code, OPERATOR_ERRORS.unauthorized);
  const r3 = a.query({ iface: 'health' });
  assert.equal(r3.error.code, OPERATOR_ERRORS.unauthorized);
  assert.ok(a.stats.unauthorized >= 3);
});

test('P9.16 concurrent query storm: bounded in-flight, stable busy errors', () => {
  const storm = fixture.storm;
  const a = api({ maxInFlight: 2 });
  const results = [];
  for (let i = 0; i < storm.n; i++) {
    results.push(a.query({ iface: storm.iface, role: storm.role, limit: storm.limit }));
  }
  assert.equal(results.length, storm.n, 'issued storm queries');
  for (const r of results) {
    if (r.ok) {
      assert.ok(r.result.count <= storm.limit);
    } else {
      assert.ok([
        OPERATOR_ERRORS.busy, OPERATOR_ERRORS.rateLimited, OPERATOR_ERRORS.unauthorized,
      ].includes(r.error && r.error.code), 'stable codes only');
    }
  }

  // maxInFlight=1: nested reentry during scan must yield operator.busy
  const b = createOperatorApi(fixture.dataset, { indexes: fixture.indexes, maxInFlight: 1 });
  assert.ok(b);
  let busySeen = false;
  let depth = 0;
  const ctl = {
    now: () => 0,
    cancelled: () => {
      if (depth < 5) {
        depth++;
        const inner = b.query({ iface: 'health', role: 'viewer', limit: 1 });
        if (!inner.ok && inner.error.code === OPERATOR_ERRORS.busy) busySeen = true;
        else if (inner.ok) {
          const inner2 = b.query({ iface: 'health', role: 'viewer', limit: 1 });
          if (!inner2.ok && inner2.error.code === OPERATOR_ERRORS.busy) busySeen = true;
        }
        depth--;
      }
      return false;
    },
  };
  b.query({ iface: 'health', role: 'viewer', limit: 5, cursor: 0 }, ctl);
  assert.equal(busySeen, true, 'storm produces operator.busy under maxInFlight=1');
});

test('P9.16 fail-closed errors + secret-safe dataset + health snapshot', () => {
  const a = api();
  assert.equal(a.query(null).error.code, OPERATOR_ERRORS.invalidQuery);
  assert.equal(a.query('x').error.code, OPERATOR_ERRORS.invalidQuery);
  assert.equal(a.query({ iface: 'nope', role: 'viewer' }).error.code, OPERATOR_ERRORS.invalidQuery);
  assert.equal(a.query({ iface: 'logs', role: 'viewer', cursor: -1 }).error.code,
    OPERATOR_ERRORS.invalidQuery);
  assert.equal(
    a.query({ iface: 'logs', role: 'viewer', where: { field: 'level', equals: 1, prefix: 'x' } })
      .error.code,
    OPERATOR_ERRORS.invalidQuery,
  );
  const h1 = a.healthSnapshot();
  const h2 = a.healthSnapshot();
  assert.equal(h1.result.schemaVersion, OPERATOR_SCHEMA_VERSION);
  assert.deepEqual(h1.result.interfaces, h2.result.interfaces);
  const bad = createOperatorApi({
    logs: [{ id: 'log-1', msg: 'bearer abcdef123secret' }],
  }, {});
  assert.equal(bad, null, 'secret-shaped dataset fails closed');
});

test('P9.16 lock pin: contracts length 75 after P9.22 row', () => {
  const lock = JSON.parse(readFileSync(
    new URL('../src/lego/contracts/contract-lock.json', import.meta.url), 'utf8'));
  assert.equal(lock.contracts.length, 100, // P9 integration (Agent 1): P9.5-P9.22 add 18 observability.* rows on top of protected main 76 -> 94 (union, zero id collisions); P9 was developed on 24032a0c (57 rows). P5.2 adds the ninety-sixth (auth.session). P5.3 adds the ninety-seventh (auth.authorization). P5.5 adds the ninety-eighth (auth.credential-crypto). P5.6 adds the ninety-ninth (auth.account-security). P5.7 adds the hundredth (auth.machine-identity).
    'P9.16 adds observability.operator-inspection@1.0.0; P9.17 adds observability.low-resource-mode@1.0.0; P9.18 adds observability.self-observability@1.0.0; P9.19 adds observability.tenant-isolation@1.0.0; P9.20 adds observability.contract-oracle@1.0.0; P9.21 adds observability.advanced-diagnostics@1.0.0; P9.22 adds observability.p9-acceptance@1.0.0; count-pins say 75');
  const row = lock.contracts.find(c => c.id === 'observability.operator-inspection');
  assert.ok(row, 'P9.16 row present');
  assert.equal(row.version, '1.0.0');
  assert.equal(row.owner, 'agent-6');
  assert.equal(row.domain, 'observability');
  assert.ok(Array.isArray(row.tests) && row.tests.length >= 1);
  assert.ok(String(row.notes).includes('P9.16'));
});
