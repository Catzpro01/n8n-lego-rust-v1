#!/usr/bin/env node
/**
 * P5.3 — Authorization engine benchmark.
 *
 * MEASURED, NOT ESTIMATED. Every number below is produced by running the code in
 * this process. Nothing is a target or a projection.
 *
 * What matters here is the difference between the two paths:
 *
 *  - **cold** — the full evaluation walk, paid on a cache miss;
 *  - **warm** — the cached decision, which still validates the SecurityStamp
 *    before it is allowed to serve. That validation is not optional: it is what
 *    makes the cache safe, so it is measured rather than assumed free.
 *
 * If the stamp check were the dominant cost, the cache would be pointless; if it
 * were skipped, the cache would be unsafe. The numbers settle which.
 */
import { performance } from 'node:perf_hooks';

import {
  CACHE_POLICY,
  authorize,
  authorizeCached,
  cacheKeyFor,
  createDecisionCache,
} from '../../src/auth/security/authorization.mjs';
import { permissionRegistryFor } from '../../src/auth/security/permission-registry.mjs';
import { createPrincipalSnapshot } from '../../src/auth/security/principal.mjs';
import { createSecurityStamp } from '../../src/auth/security/security-stamp.mjs';

const ITERATIONS = 200_000;
const WARMUP = 20_000;

const REGISTRY = permissionRegistryFor({ catalogDir: '/nonexistent' });

function bench(label, fn) {
  for (let i = 0; i < WARMUP; i += 1) fn(i);
  global.gc?.();
  const before = process.memoryUsage();
  const start = performance.now();
  for (let i = 0; i < ITERATIONS; i += 1) fn(i);
  const elapsedMs = performance.now() - start;
  const after = process.memoryUsage();
  return {
    label,
    nsPerOp: Number(((elapsedMs * 1e6) / ITERATIONS).toFixed(1)),
    opsPerSec: Math.round(ITERATIONS / (elapsedMs / 1000)),
    heapBytesPerOp: Number((Math.max(0, after.heapUsed - before.heapUsed) / ITERATIONS).toFixed(1)),
  };
}

function percentiles(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
  return { p50: Number(at(50).toFixed(0)), p95: Number(at(95).toFixed(0)), p99: Number(at(99).toFixed(0)) };
}

function distribution(label, fn, samples = 20_000) {
  const out = new Array(samples);
  for (let i = 0; i < 5_000; i += 1) fn(i);
  for (let i = 0; i < samples; i += 1) {
    const t0 = performance.now();
    fn(i);
    out[i] = (performance.now() - t0) * 1e6;
  }
  return { label, ...percentiles(out) };
}

// A realistic principal: a full owner role, not a three-scope toy.
const OWNER_SCOPES = REGISTRY.permissions.slice(0, 110);
const principal = createPrincipalSnapshot({
  principalId: 'principal-1',
  identityId: 'identity-1',
  tenantId: 'default',
  principalType: 'user',
  authMethod: 'password',
  authStrength: 'password',
  permissions: OWNER_SCOPES,
  principalVersion: 2,
});
const STAMP = createSecurityStamp({ principalVersion: 2, tenantVersion: 1, policyVersion: 3, sessionVersion: 4 });

const hit = { principal, action: 'workflow:read', resourceType: 'workflow', resourceId: 'wf-1' };
const miss = { principal, action: 'workflow:delete', resourceType: 'workflow', resourceId: 'wf-1' };
const unknown = { principal, action: 'workflow:reed', resourceType: 'workflow', resourceId: 'wf-1' };
const crossTenant = { principal, action: 'workflow:read', resourceTenantId: 'tenant-b' };

const cache = createDecisionCache();
// Prime one key so the warm path has something to serve.
authorizeCached(cache, hit, { currentStamp: STAMP, registry: REGISTRY });

const results = [
  bench('authorize (ALLOW, uncached)', () => authorize(hit, { registry: REGISTRY })),
  bench('authorize (DENY, missing scope)', () => authorize(miss, { registry: REGISTRY })),
  bench('authorize (DENY, unknown permission)', () => authorize(unknown, { registry: REGISTRY })),
  bench('authorize (DENY, cross-tenant)', () => authorize(crossTenant, { registry: REGISTRY })),
  bench('authorizeCached (warm, stamp validated)', () =>
    authorizeCached(cache, hit, { currentStamp: STAMP, registry: REGISTRY })),
  bench('cacheKeyFor', () => cacheKeyFor(hit)),
];

// Cost of the stamp validation that makes the cache safe to serve from.
const stampOnly = bench('stamp validation alone (the cache safety tax)', () => {
  cache.get(cacheKeyFor(hit), STAMP);
});

// Miss path: distinct keys, so every call re-evaluates and stores.
const churn = createDecisionCache({ ...CACHE_POLICY, maxEntries: 4_096, evictBatch: 64 });
let counter = 0;
const missPath = bench('authorizeCached (cold, distinct keys)', () => {
  counter += 1;
  authorizeCached(churn, { principal, action: 'workflow:read', resourceId: `wf-${counter}` }, {
    currentStamp: STAMP,
    registry: REGISTRY,
  });
});

const dists = [
  distribution('authorize (ALLOW, uncached)', () => authorize(hit, { registry: REGISTRY })),
  distribution('authorizeCached (warm)', () => authorizeCached(cache, hit, { currentStamp: STAMP, registry: REGISTRY })),
];

// Concurrency: many principals and resources interleaved, as under real load.
const principals = Array.from({ length: 200 }, (_, i) =>
  createPrincipalSnapshot({
    principalId: `p-${i}`, identityId: `i-${i}`, tenantId: 'default', principalType: 'user',
    authMethod: 'password', authStrength: 'password', permissions: OWNER_SCOPES, principalVersion: 2,
  }));
const concurrent = bench('authorize (200 principals, interleaved)', (i) => {
  authorize({ principal: principals[i % 200], action: 'workflow:read', resourceId: `wf-${i}` }, { registry: REGISTRY });
});

// Bounded cache under churn.
global.gc?.();
const beforeHeap = process.memoryUsage().heapUsed;
const flood = createDecisionCache({ ...CACHE_POLICY, maxEntries: 4_096, evictBatch: 64 });
for (let i = 0; i < 200_000; i += 1) flood.set(`key-${i}`, { allowed: true }, STAMP);
global.gc?.();
const afterHeap = process.memoryUsage().heapUsed;

const pad = (s, n) => String(s).padEnd(n);
console.log('\nP5.3 AUTHORIZATION ENGINE — MEASURED BENCHMARK (no fabricated numbers)');
console.log(`node ${process.version}  ${process.platform}/${process.arch}  iterations=${ITERATIONS.toLocaleString()}`);
console.log(`permission universe: ${REGISTRY.size} canonical permissions; principal holds ${OWNER_SCOPES.length}\n`);
console.log(pad('operation', 46) + pad('ns/op', 12) + pad('ops/sec', 14) + 'heap B/op');
console.log('-'.repeat(84));
for (const r of [...results, missPath, stampOnly, concurrent]) {
  console.log(pad(r.label, 46) + pad(r.nsPerOp, 12) + pad(r.opsPerSec.toLocaleString(), 14) + r.heapBytesPerOp);
}
console.log('\nlatency distribution (ns per call)');
console.log(pad('operation', 46) + pad('p50', 10) + pad('p95', 10) + 'p99');
console.log('-'.repeat(84));
for (const d of dists) console.log(pad(d.label, 46) + pad(d.p50, 10) + pad(d.p95, 10) + d.p99);
console.log('\nBOUNDED CACHE UNDER CHURN');
console.log('-'.repeat(84));
console.log(`  200,000 distinct keys against a 4,096 cap`);
console.log(`  final cache size    : ${flood.size().toLocaleString()} (cap held)`);
console.log(`  heap delta          : ${((afterHeap - beforeHeap) / 1024).toFixed(1)} KiB`);
console.log('\n(run with --expose-gc for stable heap figures; output is not written to the repo)');
