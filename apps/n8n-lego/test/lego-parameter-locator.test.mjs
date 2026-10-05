/**
 * P7-S05 — Resource Locator & Search (Issue #223 §12-13, §24-27, §34; DEC-0024).
 *
 * Unit rules pin the resourceLocator canonical model (the four modes + n8n-compatible
 * stored value), the bounded targeted search with deterministic ordering, the bounded
 * pagination (page size / next-page token / pages-per-session cap), race protection +
 * coalescing + cancellation, and the marked failure vocabulary + resource budgets on an
 * explicit, replaceable search provider (the local/static provider for tests).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LOCATOR_MODES, LOCATOR_LIMITS, LOCATOR_FAILURE_CODES, ResourceLocatorError,
  normalizeLocatorValue, parseResourceLocator, createStaticLocatorProvider,
  createCancelToken, ResourceLocatorSession,
} from '../src/lego/parameter-locator.mjs';

const ITEMS = [
  { name: 'Zeta', value: 'zeta' },
  { name: 'Alpha', value: 'alpha' },
  { name: 'Mid', value: 'mid' },
  { name: 'Beta', value: 'beta' },
  { name: 'Gamma', value: 'gamma' },
];

const CTX = { nodeType: 'test.node', nodeVersion: 1, parameterPath: 'resource', schemaVersion: 1 };

function session(items, extra = {}) {
  return new ResourceLocatorSession({ provider: createStaticLocatorProvider(items, extra), ...extra.session });
}

/* ------------------------------------------------------------------ CP-01 canonical model */

test('CP-01: parseResourceLocator parses all four modes into the canonical { mode, value }', () => {
  assert.deepEqual(parseResourceLocator({ mode: 'list', value: 'alpha' }), { mode: 'list', value: 'alpha' });
  assert.deepEqual(parseResourceLocator({ mode: 'name', value: '  My Project  ' }), { mode: 'name', value: 'My Project' });
  assert.deepEqual(parseResourceLocator({ mode: 'id', value: 42 }), { mode: 'id', value: '42' });
  assert.deepEqual(parseResourceLocator({ mode: 'url', value: 'https://example.com/x' }), { mode: 'url', value: 'https://example.com/x' });
});

test('CP-01: stored values stay n8n-compatible (extra fields ignored, canonical shape returned)', () => {
  const parsed = parseResourceLocator({ mode: 'list', value: 'beta', cachable: true, fixedCollection: false });
  assert.deepEqual(parsed, { mode: 'list', value: 'beta' });
  assert.ok(Object.isFrozen(parsed), 'the canonical value is immutable');
});

test('CP-01: an unknown mode is rejected, never coerced', () => {
  assert.throws(() => parseResourceLocator({ mode: 'email', value: 'a@b.c' }), (err) =>
    err instanceof ResourceLocatorError && err.code === 'SCHEMA_INVALID');
});

test('CP-01: a malformed locator value (non-object / missing mode) is rejected', () => {
  assert.throws(() => parseResourceLocator('alpha'), (err) => err.code === 'SCHEMA_INVALID');
  assert.throws(() => parseResourceLocator({ value: 'alpha' }), (err) => err.code === 'SCHEMA_INVALID');
  assert.throws(() => parseResourceLocator(null), (err) => err.code === 'SCHEMA_INVALID');
});

test('CP-01: url mode validates the URL (a non-URL is INVALID_URL, not SCHEMA_INVALID)', () => {
  assert.throws(() => normalizeLocatorValue('url', 'not a url'), (err) => err.code === 'INVALID_URL');
  assert.equal(normalizeLocatorValue('url', 'https://example.com/path?q=1'), 'https://example.com/path?q=1');
});

test('CP-01: values are length-bounded (an overlong value is rejected)', () => {
  const long = 'a'.repeat(LOCATOR_LIMITS.maxQueryLength + 1);
  assert.throws(() => normalizeLocatorValue('name', long), (err) =>
    err.code === 'SCHEMA_INVALID' && err.details.limit === LOCATOR_LIMITS.maxQueryLength);
  assert.throws(() => normalizeLocatorValue('id', { not: 'a string' }), (err) => err.code === 'SCHEMA_INVALID');
});

/* ------------------------------------------------------------------ CP-02 bounded search */

test('CP-02: list search returns normalized, deterministically ordered items (value then name)', async () => {
  const s = session(ITEMS);
  const r = await s.search('', { context: CTX });
  assert.equal(r.error, undefined);
  // sorted by value: alpha, beta, gamma, mid, zeta
  assert.deepEqual(r.items.map((i) => i.value), ['alpha', 'beta', 'gamma', 'mid', 'zeta']);
  for (const item of r.items) {
    assert.equal(typeof item.name, 'string');
    assert.equal(typeof item.value, 'string');
  }
});

test('CP-02: a query performs a targeted search (only matching items, not the full catalog)', async () => {
  const s = session(ITEMS);
  const r = await s.search('be', { context: CTX });
  // only "beta" contains "be"
  assert.deepEqual(r.items.map((i) => i.value), ['beta']);
  assert.equal(r.hasMore, false);
});

test('CP-02: the page size bounds the returned result count', async () => {
  const s = session(ITEMS);
  const r = await s.search('', { context: CTX, pageSize: 2 });
  assert.equal(r.items.length, 2);
  assert.equal(r.hasMore, true);
  assert.ok(r.nextToken !== null);
});

test('CP-02: the page size is capped at the limit (a huge requested page size is clamped)', async () => {
  const s = session(ITEMS);
  const r = await s.search('', { context: CTX, pageSize: 10_000_000 });
  // clamped to maxPageSize, but the static list only has 5 items
  assert.ok(r.items.length <= LOCATOR_LIMITS.maxPageSize);
  assert.equal(r.items.length, ITEMS.length);
});

test('CP-02: an overlong query is rejected (query length limit)', () => {
  const s = session(ITEMS);
  assert.rejects(
    s.search('q'.repeat(LOCATOR_LIMITS.maxQueryLength + 1), { context: CTX }),
    (err) => err.code === 'SCHEMA_INVALID',
  );
});

test('CP-02: malformed provider data is rejected (INVALID_PROVIDER_DATA), never passed downstream', async () => {
  const bad = { id: 'bad', version: '1', locality: 'local', async search() { return { items: [{ name: 'x' }], nextToken: null }; } };
  const s = new ResourceLocatorSession({ provider: bad });
  const r = await s.search('', { context: CTX });
  assert.ok(r.error, 'a malformed provider page is a marked failure');
  assert.equal(r.error.code, 'INVALID_PROVIDER_DATA');
  assert.deepEqual(r.items, []);
});

/* ------------------------------------------------------------------ CP-03 bounded pagination */

test('CP-03: next-page token walks the list without duplicates, then exhausts', async () => {
  const s = session(ITEMS);
  const first = await s.search('', { context: CTX, pageSize: 2 });
  assert.equal(first.hasMore, true);
  const second = await s.nextPage(first.nextToken, '', { context: CTX, pageSize: 2 });
  assert.equal(second.hasMore, true);
  const third = await s.nextPage(second.nextToken, '', { context: CTX, pageSize: 2 });
  assert.equal(third.hasMore, false);
  const all = [...first.items, ...second.items, ...third.items].map((i) => i.value);
  assert.deepEqual(all, ['alpha', 'beta', 'gamma', 'mid', 'zeta']);
  assert.equal(new Set(all).size, all.length, 'no duplicates across pages');
});

test('CP-03: a missing or overlong page token is rejected (STALE_REQUEST)', async () => {
  const s = session(ITEMS);
  await assert.rejects(s.nextPage(null, '', { context: CTX }), (err) => err.code === 'STALE_REQUEST');
  await assert.rejects(
    s.nextPage('t'.repeat(LOCATOR_LIMITS.maxPageTokenLength + 1), '', { context: CTX }),
    (err) => err.code === 'STALE_REQUEST',
  );
});

test('CP-03: the pages-per-session cap stops unbounded enumeration (marked OVERLOADED)', async () => {
  const s = session(ITEMS, { session: { limits: { maxPagesPerSession: 2, maxPageSize: 1 } } });
  const p1 = await s.search('', { context: CTX, pageSize: 1 });
  const p2 = await s.nextPage(p1.nextToken, '', { context: CTX, pageSize: 1 });
  assert.ok(!p1.error && !p2.error);
  // the third page exceeds the cap of 2
  const p3 = await s.nextPage(p2.nextToken, '', { context: CTX, pageSize: 1 });
  assert.ok(p3.error, 'the cap is a marked failure, not a silent empty page');
  assert.equal(p3.error.code, 'OVERLOADED');
  assert.deepEqual(p3.items, []);
});

/* ------------------------------------------------------------------ CP-04 race / coalesce / cancel */

test('CP-04: each issued provider call bumps the generation, carried on the result', async () => {
  const s = session(ITEMS);
  const a = await s.search('alpha', { context: CTX });
  const b = await s.search('beta', { context: CTX });
  assert.ok(Number.isInteger(a.generation) && Number.isInteger(b.generation));
  assert.notEqual(a.generation, b.generation, 'distinct searches carry distinct generations');
});

test('CP-04: identical concurrent searches coalesce onto one in-flight provider op', async () => {
  let calls = 0;
  const slow = {
    id: 'slow', version: '1', locality: 'local',
    async search(_c, page) {
      calls += 1;
      await new Promise((r) => setTimeout(r, 10));
      const query = (page.query ?? '').toLowerCase();
      const items = ITEMS.filter((i) => i.name.toLowerCase().includes(query) || i.value.toLowerCase().includes(query));
      return { items, nextToken: null };
    },
  };
  const s = new ResourceLocatorSession({ provider: slow });
  const [r1, r2] = await Promise.all([
    s.search('m', { context: CTX }),
    s.search('m', { context: CTX }),
  ]);
  assert.equal(calls, 1, 'coalesced: one provider call for two identical searches');
  assert.deepEqual(r1.items.map((i) => i.value), r2.items.map((i) => i.value));
  assert.equal(r1.cache, 'miss');
  assert.equal(r2.cache, 'coalesced');
});

test('CP-04: a cancelled search is reported as a marked CANCELLED failure', async () => {
  let calls = 0;
  const slow = {
    id: 'slow', version: '1', locality: 'local',
    async search(_c, page) {
      calls += 1;
      await new Promise((r) => setTimeout(r, 15));
      return { items: ITEMS, nextToken: null };
    },
  };
  const s = new ResourceLocatorSession({ provider: slow });
  const token = createCancelToken();
  const pending = s.search('', { context: CTX, token });
  token.cancel(); // cancel while in flight
  const r = await pending;
  assert.ok(r.error, 'a cancelled search is a marked failure');
  assert.equal(r.error.code, 'CANCELLED');
  assert.deepEqual(r.items, []);
  assert.equal(calls, 1, 'the provider was still called once; the result is discarded');
});

test('CP-04: session.cancel(requestId) marks that request cancelled (marked CANCELLED)', async () => {
  const slow = {
    id: 'slow', version: '1', locality: 'local',
    async search() { await new Promise((r) => setTimeout(r, 10)); return { items: ITEMS, nextToken: null }; },
  };
  const s = new ResourceLocatorSession({ provider: slow });
  const pending = s.search('', { context: CTX, requestId: 'req-77' });
  s.cancel('req-77');
  const r = await pending;
  assert.ok(r.error && r.error.code === 'CANCELLED');
  assert.deepEqual(r.items, []);
});

/* ------------------------------------------------------------------ CP-05 failures + budgets */

test('CP-05: a failing provider is a marked failure (never a fake unmarked empty success)', async () => {
  const failing = { id: 'fail', version: '1', locality: 'local', async search() { throw new ResourceLocatorError('UNAVAILABLE', 'provider down'); } };
  const s = new ResourceLocatorSession({ provider: failing });
  const r = await s.search('', { context: CTX });
  assert.ok(r.error, 'the failure is marked');
  assert.equal(r.error.code, 'UNAVAILABLE');
  assert.deepEqual(r.items, []);
  assert.notEqual(r.error, null, 'items=[] only together with a non-null error');
});

test('CP-05: a real empty provider result is a SUCCESS (not a fake failure)', async () => {
  const empty = { id: 'empty', version: '1', locality: 'local', async search() { return { items: [], nextToken: null }; } };
  const s = new ResourceLocatorSession({ provider: empty });
  const r = await s.search('nothing', { context: CTX });
  assert.equal(r.error, undefined, 'a genuine empty result has no error');
  assert.deepEqual(r.items, []);
  assert.equal(r.hasMore, false);
});

test('CP-05: a provider timeout is reported as a marked TIMEOUT', async () => {
  const stalling = { id: 'stall', version: '1', locality: 'local', async search() { await new Promise((r) => setTimeout(r, 200)); return { items: [], nextToken: null }; } };
  const s = new ResourceLocatorSession({ provider: stalling, limits: { timeoutMs: 15 } });
  const r = await s.search('', { context: CTX });
  assert.ok(r.error && r.error.code === 'TIMEOUT');
  assert.deepEqual(r.items, []);
});

test('CP-05: the concurrency bound is a marked OVERLOADED (one slow provider cannot consume the budget)', async () => {
  let calls = 0;
  const slow = { id: 'slow', version: '1', locality: 'local', async search() { calls += 1; await new Promise((r) => setTimeout(r, 20)); return { items: [], nextToken: null }; } };
  const s = new ResourceLocatorSession({ provider: slow, limits: { maxConcurrency: 1 } });
  const p1 = s.search('a', { context: { ...CTX, searchQuery: 'a' } });
  // while p1 holds the only concurrency slot, a second distinct search is bounded
  const p2 = s.search('b', { context: { ...CTX, searchQuery: 'b' } });
  const [r1, r2] = await Promise.all([p1, p2]);
  const bounded = [r1, r2].some((r) => r.error && r.error.code === 'OVERLOADED');
  assert.ok(bounded, 'the second concurrent search hits the concurrency bound');
});

test('CP-05: the closed failure vocabulary is frozen and a cached failure is served as a marked negative-hit', async () => {
  assert.ok(Object.isFrozen(LOCATOR_FAILURE_CODES));
  assert.ok(LOCATOR_FAILURE_CODES.includes('CANCELLED') && LOCATOR_FAILURE_CODES.includes('STALE_REQUEST'));
  const failing = { id: 'fail', version: '1', locality: 'local', async search() { throw new ResourceLocatorError('RATE_LIMITED', 'slow down'); } };
  const s = new ResourceLocatorSession({ provider: failing });
  const first = await s.search('', { context: CTX });
  assert.equal(first.error.code, 'RATE_LIMITED');
  const second = await s.search('', { context: CTX });
  assert.equal(second.cache, 'negative-hit');
  assert.equal(second.error.code, 'RATE_LIMITED');
  assert.equal(second.items.length, 0);
});

test('CP-05: a provider failure is negatively cached (a retry storm is stopped)', async () => {
  let calls = 0;
  const flaky = { id: 'flaky', version: '1', locality: 'local', async search() { calls += 1; throw new ResourceLocatorError('UNAVAILABLE', 'down'); } };
  const s = new ResourceLocatorSession({ provider: flaky });
  await s.search('', { context: CTX });
  await s.search('', { context: CTX });
  await s.search('', { context: CTX });
  assert.equal(calls, 1, 'subsequent identical searches are served from the negative cache');
});
