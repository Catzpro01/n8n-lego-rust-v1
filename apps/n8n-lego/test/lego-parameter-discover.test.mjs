/**
 * P7-S04 — Dynamic Options Runtime (Issue #223 §11, §14-16, §23-26, §34; DEC-0024).
 *
 * Unit rules pin the normalization, the bounded classed cache, stale-while-revalidate,
 * race protection + request coalescing, and the backpressure/resource budgets on an
 * explicit, replaceable provider (the local/static provider for tests).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CACHE_CLASSES, DISCOVER_LIMITS, DynamicCache, DynamicOptionsError,
  DynamicOptionsSession, cacheKey, createStaticProvider, normalizeOptionList,
} from '../src/lego/parameter-discover.mjs';

const param = { path: 'account', dynamic: { loadOptionsMethod: 'loadAccounts' } };
const ctx = (extra = {}) => ({ nodeType: 'test.node', nodeVersion: 1, dependencyDigest: 'd1', schemaVersion: '1.0.0', ...extra });
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ CP-01 normalization + provider flow */

test('normalize: a valid provider list becomes the canonical { name, value, description? } shape', () => {
  const list = normalizeOptionList([
    { name: 'Acme', value: 'acme', description: 'Acme Corp' },
    { name: 'Beta', value: 'beta' },
  ]);
  assert.equal(list.length, 2);
  assert.deepEqual(list[0], { name: 'Acme', value: 'acme', description: 'Acme Corp' });
  assert.deepEqual(list[1], { name: 'Beta', value: 'beta' });
  assert.ok(Object.isFrozen(list));
});

test('normalize: malformed provider data is rejected, never passed to UI', () => {
  assert.throws(() => normalizeOptionList(null), (e) => e instanceof DynamicOptionsError && e.code === 'INVALID_PROVIDER_DATA');
  assert.throws(() => normalizeOptionList('not-a-list'), (e) => e.code === 'INVALID_PROVIDER_DATA');
  assert.throws(() => normalizeOptionList([{ name: 'A' }]), (e) => e.code === 'INVALID_PROVIDER_DATA', 'entry missing value');
  assert.throws(() => normalizeOptionList([{ value: 'a' }]), (e) => e.code === 'INVALID_PROVIDER_DATA', 'entry missing name');
  assert.throws(() => normalizeOptionList([42]), (e) => e.code === 'INVALID_PROVIDER_DATA', 'non-object entry');
});

test('normalize: an oversized result count is rejected (bounded)', () => {
  const big = Array.from({ length: DISCOVER_LIMITS.maxResultCount + 1 }, (_, i) => ({ name: `n${i}`, value: `v${i}` }));
  assert.throws(() => normalizeOptionList(big), (e) => e.code === 'INVALID_PROVIDER_DATA' && /max/.test(e.message));
  const ok = Array.from({ length: 3 }, (_, i) => ({ name: `n${i}`, value: `v${i}` }));
  assert.equal(normalizeOptionList(ok).length, 3);
});

test('resolve: the full flow (parameter -> provider -> normalized list) returns source=provider', async () => {
  const provider = createStaticProvider([{ name: 'A', value: 'a' }, { name: 'B', value: 'b' }]);
  const session = new DynamicOptionsSession({ provider });
  const result = await session.resolve(param, ctx());
  assert.equal(result.source, 'provider');
  assert.equal(result.cache, 'miss');
  assert.deepEqual(result.options, [{ name: 'A', value: 'a' }, { name: 'B', value: 'b' }]);
  assert.equal(result.error, undefined);
});

/* ------------------------------------------------------------------ CP-02 bounded classed cache */

test('cacheKey: deterministic over the field set; distinct fields -> distinct keys', () => {
  const a = { nodeType: 'n', nodeVersion: 1, parameterPath: 'p', methodName: 'm', normalizedDependencyDigest: 'd1', normalizedSearchQuery: null, providerVersion: '1.0.0', schemaVersion: '1.0.0' };
  assert.equal(cacheKey(a), cacheKey(a));
  assert.notEqual(cacheKey(a), cacheKey({ ...a, normalizedDependencyDigest: 'd2' }));
  assert.notEqual(cacheKey(a), cacheKey({ ...a, parameterPath: 'q' }));
});

test('DynamicCache: bounded LRU eviction + per-class TTL', () => {
  const cache = new DynamicCache({ maxCacheEntries: 2, providerTtlMs: 100, negativeTtlMs: 100 });
  let t = 1000;
  cache.set('k1', 'v1', CACHE_CLASSES.PROVIDER, t);
  cache.set('k2', 'v2', CACHE_CLASSES.PROVIDER, t);
  cache.set('k3', 'v3', CACHE_CLASSES.PROVIDER, t); // evicts k1 (LRU)
  assert.equal(cache.get('k1', t), null);
  assert.equal(cache.get('k2', t).value, 'v2');
  assert.equal(cache.get('k3', t).value, 'v3');
  // PROVIDER TTL expiry
  assert.notEqual(cache.get('k2', t + 50), null, 'still fresh within providerTtlMs');
  assert.equal(cache.get('k2', t + 101), null, 'PROVIDER entry expired after providerTtlMs');
  // NEGATIVE TTL
  cache.set('neg', { code: 'X', message: 'm' }, CACHE_CLASSES.NEGATIVE, t);
  assert.notEqual(cache.get('neg', t + 50), null);
  assert.equal(cache.get('neg', t + 101), null, 'NEGATIVE entry expired after negativeTtlMs');
});

test('resolve: a second identical request is a cache hit (no second provider call)', async () => {
  let calls = 0;
  const provider = { id: 't', version: '1.0.0', locality: 'local', async loadOptions() { calls += 1; return [{ name: 'A', value: 'a' }]; } };
  const session = new DynamicOptionsSession({ provider });
  const first = await session.resolve(param, ctx());
  const second = await session.resolve(param, ctx());
  assert.equal(first.source, 'provider');
  assert.equal(second.source, 'cache');
  assert.equal(second.cache, 'hit');
  assert.equal(calls, 1, 'the provider is called once; the second request is served from cache');
});

test('cache: a dependency-digest change produces a distinct key (no cross-contamination)', async () => {
  let calls = 0;
  const provider = { id: 't', version: '1.0.0', locality: 'local', async loadOptions(c) { calls += 1; return [{ name: c.dependencyDigest, value: c.dependencyDigest }]; } };
  const session = new DynamicOptionsSession({ provider });
  const a = await session.resolve(param, ctx({ dependencyDigest: 'res-a' }));
  const b = await session.resolve(param, ctx({ dependencyDigest: 'res-b' }));
  assert.equal(a.options[0].value, 'res-a');
  assert.equal(b.options[0].value, 'res-b');
  assert.equal(calls, 2, 'each dependency digest has its own cache entry');
});

/* ------------------------------------------------------------------ CP-03 stale-while-revalidate */

test('SWR: a display-only request serves a stale value + triggers revalidation', async () => {
  let current = 1_000_000;
  const now = () => current;
  let calls = 0;
  let value = 'v1';
  const provider = { id: 't', version: '1.0.0', locality: 'local', async loadOptions() { calls += 1; return [{ name: value, value }]; } };
  const session = new DynamicOptionsSession({ provider, now, limits: { providerTtlMs: 1000, staleWindowMs: 5000 } });
  const first = await session.resolve(param, ctx());
  assert.equal(first.source, 'provider');
  // Age past the PROVIDER TTL but within the SWR window.
  current += 2000;
  const stale = await session.resolve(param, ctx());
  assert.equal(stale.source, 'cache');
  assert.equal(stale.cache, 'stale');
  assert.equal(stale.stale, true);
  assert.equal(stale.revalidating, true);
  assert.equal(stale.options[0].value, 'v1', 'the stale (display-only) value is served');
  // The background revalidation refreshes the cache.
  await tick(5);
  assert.equal(calls, 2, 'a background revalidation ran');
  const fresh = await session.resolve(param, ctx());
  assert.equal(fresh.cache, 'hit', 'the revalidation refreshed the cache');
});

test('SWR: an authoritative (execution) resolution never serves stale', async () => {
  let current = 1_000_000;
  const now = () => current;
  let calls = 0;
  let value = 'v1';
  const provider = { id: 't', version: '1.0.0', locality: 'local', async loadOptions() { calls += 1; value = `v${calls}`; return [{ name: value, value }]; } };
  const session = new DynamicOptionsSession({ provider, now, limits: { providerTtlMs: 1000, staleWindowMs: 5000 } });
  await session.resolve(param, ctx());
  current += 2000;
  const authoritative = await session.resolve(param, ctx(), { authoritative: true });
  assert.notEqual(authoritative.cache, 'stale', 'authoritative resolution does not serve stale');
  assert.equal(authoritative.stale, false);
});

/* ------------------------------------------------------------------ CP-04 race protection + coalescing */

test('coalescing: two identical concurrent requests share one in-flight provider call', async () => {
  let calls = 0;
  const provider = { id: 't', version: '1.0.0', locality: 'local', async loadOptions() { calls += 1; await tick(10); return [{ name: 'A', value: 'a' }]; } };
  const session = new DynamicOptionsSession({ provider });
  const [r1, r2] = await Promise.all([session.resolve(param, ctx()), session.resolve(param, ctx())]);
  assert.equal(calls, 1, 'the two concurrent requests coalesced into one provider call');
  assert.deepEqual(r1.options, r2.options);
  assert.equal(r2.cache, 'coalesced');
});

test('race protection: a generation change invalidates the prior dependency state', async () => {
  let calls = 0;
  const provider = { id: 't', version: '1.0.0', locality: 'local', async loadOptions(c) { calls += 1; await tick(5); return [{ name: c.dependencyDigest, value: c.dependencyDigest }]; } };
  const session = new DynamicOptionsSession({ provider });
  // An older-generation request (res-a) is in flight; a newer one (res-b) is issued.
  const older = session.resolve(param, ctx({ dependencyDigest: 'res-a' }));
  await tick(1);
  const newer = session.resolve(param, ctx({ dependencyDigest: 'res-b' }));
  const [a, b] = await Promise.all([older, newer]);
  assert.equal(a.options[0].value, 'res-a');
  assert.equal(b.options[0].value, 'res-b');
  assert.equal(a.generation < b.generation, true, 'the newer request has a higher generation');
});

/* ------------------------------------------------------------------ CP-05 backpressure + resource budgets */

test('backpressure: exceeding the concurrency bound reports OVERLOADED (not a fake success)', async () => {
  let calls = 0;
  const release = [];
  const provider = {
    id: 't', version: '1.0.0', locality: 'local',
    loadOptions() { calls += 1; return new Promise((r) => release.push(() => r([{ name: 'A', value: 'a' }]))); },
  };
  const session = new DynamicOptionsSession({ provider, limits: { maxConcurrency: 1 } });
  const first = session.resolve(param, ctx({ dependencyDigest: 'x1' }));
  await tick(1); // let the first occupy the single slot
  const second = await session.resolve(param, ctx({ dependencyDigest: 'x2' }));
  assert.equal(second.error?.code, 'OVERLOADED');
  assert.equal(second.options.length, 0);
  assert.ok(second.error, 'an overloaded result is a marked failure, not an empty success');
  release.forEach((fn) => fn());
  await first;
});

test('backpressure: a slow provider times out (bounded), reported as TIMEOUT', async () => {
  const provider = { id: 't', version: '1.0.0', locality: 'local', loadOptions() { return new Promise((r) => setTimeout(() => r([{ name: 'A', value: 'a' }]), 200)); } };
  const session = new DynamicOptionsSession({ provider, limits: { timeoutMs: 20 } });
  const result = await session.resolve(param, ctx());
  assert.equal(result.error?.code, 'TIMEOUT');
  assert.equal(result.options.length, 0);
  assert.ok(result.error, 'a timeout is a marked failure, not an empty success');
});

test('backpressure: a failing provider is negatively cached (no retry storm)', async () => {
  let calls = 0;
  const provider = { id: 't', version: '1.0.0', locality: 'local', async loadOptions() { calls += 1; throw new DynamicOptionsError('UNAVAILABLE', 'provider down'); } };
  const session = new DynamicOptionsSession({ provider, limits: { negativeTtlMs: 1000 } });
  let current = 1_000_000;
  const first = await session.resolve(param, ctx());
  assert.equal(first.error?.code, 'UNAVAILABLE');
  assert.equal(calls, 1);
  // A second request within the negative TTL is served from the negative cache (no provider call).
  const second = await session.resolve(param, ctx());
  assert.equal(second.source, 'cache');
  assert.equal(second.cache, 'negative-hit');
  assert.equal(second.error?.code, 'UNAVAILABLE');
  assert.equal(calls, 1, 'the negative cache stops the retry storm (no second provider call)');
});

test('provider: an explicit, replaceable provider is required (no implicit default)', () => {
  assert.throws(() => new DynamicOptionsSession({}), (e) => e instanceof DynamicOptionsError && e.code === 'INVALID_PROVIDER');
  assert.throws(() => new DynamicOptionsSession({ provider: { id: 'x' } }), (e) => e.code === 'INVALID_PROVIDER');
});
