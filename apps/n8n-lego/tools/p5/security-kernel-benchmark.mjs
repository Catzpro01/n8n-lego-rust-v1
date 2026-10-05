#!/usr/bin/env node
/**
 * P5.1 — Security kernel benchmark.
 *
 * MEASURED, NOT ESTIMATED. Every number printed by this script is produced by
 * running the code in this process. Nothing here is a target, a goal or a
 * projection: if the run is slow on your machine, that is the result.
 *
 * WHAT IS MEASURED, and why each one matters for a hot path:
 *
 *  1. PrincipalSnapshot construction — paid once per authentication (control path).
 *  2. SecurityContext construction   — paid once per request (hot path).
 *  3. SecurityStamp comparison       — paid per cached-decision check (hot path).
 *  4. Tenant binding check           — paid per resource access (hot path).
 *  5. Permission lookup              — paid per authorization check (hot path).
 *  6. Fail-closed rejection          — an attacker-reachable path; a denial must
 *                                      stay cheap or it becomes a DoS lever.
 *  7. Allocation / byte profile      — bounded allocations are an acceptance
 *                                      criterion (Issue #214), not a nicety.
 *
 * The single-tenant case (`tenantId = 'default'`) is measured separately from the
 * multi-tenant case because the architecture promises it stays the cheapest valid
 * path, and that claim has to be measurable rather than asserted.
 */
import { performance } from 'node:perf_hooks';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_TENANT,
  checkTenantBinding,
  createPrincipalSnapshot,
  createSecurityContext,
  createSecurityStamp,
  evaluateStampAuthority,
  hasPermission,
} from '../../src/auth/security/index.mjs';

const ITERATIONS = 200_000;
const WARMUP = 20_000;

/** Times `fn` over ITERATIONS calls after WARMUP, returning ns/op + alloc deltas. */
function bench(label, fn) {
  for (let i = 0; i < WARMUP; i += 1) fn(i);
  global.gc?.();
  const before = process.memoryUsage();
  const start = performance.now();
  for (let i = 0; i < ITERATIONS; i += 1) fn(i);
  const elapsedMs = performance.now() - start;
  const after = process.memoryUsage();
  const nsPerOp = (elapsedMs * 1e6) / ITERATIONS;
  const heapBytesPerOp =
    Math.max(0, after.heapUsed - before.heapUsed) / ITERATIONS;
  return {
    label,
    nsPerOp: Number(nsPerOp.toFixed(1)),
    opsPerSec: Math.round(ITERATIONS / (elapsedMs / 1000)),
    heapBytesPerOp: Number(heapBytesPerOp.toFixed(1)),
  };
}

function percentiles(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
  return {
    p50: Number(at(50).toFixed(0)),
    p95: Number(at(95).toFixed(0)),
    p99: Number(at(99).toFixed(0)),
    max: Number(sorted[sorted.length - 1].toFixed(0)),
  };
}

/** Latency distribution for one operation, in nanoseconds per call. */
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

const PERMISSIONS = [
  'workflow:create', 'workflow:read', 'workflow:update', 'workflow:delete', 'workflow:list',
  'credential:create', 'credential:read', 'credential:update', 'credential:list',
  'user:read', 'user:list', 'execution:read', 'execution:list',
  'project:read', 'project:list', 'tag:read', 'tag:list',
];

const single = createPrincipalSnapshot({
  principalId: 'principal-1', identityId: 'identity-1', tenantId: DEFAULT_TENANT,
  principalType: 'user', authMethod: 'password', authStrength: 'password',
  permissions: PERMISSIONS, principalVersion: 3, sessionId: 'session-1',
});
const multi = createPrincipalSnapshot({
  principalId: 'principal-2', identityId: 'identity-2', tenantId: 'tenant-a',
  principalType: 'service', authMethod: 'service-credential', authStrength: 'mfa',
  permissions: PERMISSIONS, principalVersion: 7, sessionId: 'session-2',
});

const currentStamp = createSecurityStamp({ principalVersion: 3, tenantVersion: 1, policyVersion: 2, sessionVersion: 4 });
const ctxSingle = createSecurityContext({ principal: single, requestId: 'r', tenantVersion: 1, policyVersion: 2, sessionVersion: 4 });

const results = [];
results.push(bench('PrincipalSnapshot construction (18 permissions)', () =>
  createPrincipalSnapshot({
    principalId: 'p', identityId: 'i', tenantId: DEFAULT_TENANT, principalType: 'user',
    authMethod: 'password', authStrength: 'password', permissions: PERMISSIONS,
    principalVersion: 1, sessionId: 's',
  })));
results.push(bench('SecurityContext construction (single-tenant)', () =>
  createSecurityContext({ principal: single, requestId: 'r', tenantVersion: 1, policyVersion: 2, sessionVersion: 4 })));
results.push(bench('SecurityStamp comparison (CURRENT)', () => evaluateStampAuthority(ctxSingle.stamp, currentStamp)));
results.push(bench('Tenant binding check (single-tenant, matching)', () => checkTenantBinding(ctxSingle, DEFAULT_TENANT)));
results.push(bench('Permission lookup (hit, 18 permissions)', () => hasPermission(single, 'credential:read')));
results.push(bench('Permission lookup (miss)', () => hasPermission(single, 'workflow:execute')));
results.push(bench('Fail-closed rejection (malformed principal)', () => {
  try {
    createPrincipalSnapshot({ principalId: 'p', identityId: 'i', principalType: 'robot',
      authMethod: 'password', authStrength: 'password', permissions: [], principalVersion: 1 });
  } catch { /* the denial itself is the measured work */ }
}));

const dists = [];
dists.push(distribution('SecurityContext construction', () =>
  createSecurityContext({ principal: single, requestId: 'r', tenantVersion: 1, policyVersion: 2, sessionVersion: 4 })));
dists.push(distribution('SecurityStamp comparison', () => evaluateStampAuthority(ctxSingle.stamp, currentStamp)));
dists.push(distribution('Tenant binding (single-tenant)', () => checkTenantBinding(ctxSingle, DEFAULT_TENANT)));

// Single-tenant vs multi-tenant: the architecture claims default stays cheapest.
const multiCtx = createSecurityContext({ principal: multi, requestId: 'r', tenantVersion: 1, policyVersion: 2, sessionVersion: 4 });
const st = bench('Tenant binding: single-tenant default', () => checkTenantBinding(ctxSingle, DEFAULT_TENANT));
const mt = bench('Tenant binding: multi-tenant match', () => checkTenantBinding(multiCtx, 'tenant-a'));
const cross = bench('Tenant binding: multi-tenant mismatch (deny)', () => checkTenantBinding(multiCtx, 'tenant-b'));

const report = {
  generatedAt: new Date().toISOString(),
  environment: {
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    iterations: ITERATIONS,
    gcExposed: typeof global.gc === 'function',
    note: 'heapBytesPerOp is a coarse heapUsed delta; run with --expose-gc for a stable figure.',
  },
  throughput: results,
  latencyNs: dists,
  tenantComparison: { singleTenant: st, multiTenantMatch: mt, multiTenantMismatch: cross },
};

const pad = (s, n) => String(s).padEnd(n);
console.log('\nP5.1 SECURITY KERNEL — MEASURED BENCHMARK (no fabricated numbers)');
console.log(`node ${process.version}  ${process.platform}/${process.arch}  iterations=${ITERATIONS.toLocaleString()}`);
console.log(`generated: ${report.generatedAt}\n`);
console.log(pad('operation', 46) + pad('ns/op', 12) + pad('ops/sec', 14) + 'heap B/op');
console.log('-'.repeat(84));
for (const r of [...results, st, mt, cross]) {
  console.log(pad(r.label, 46) + pad(r.nsPerOp, 12) + pad(r.opsPerSec.toLocaleString(), 14) + r.heapBytesPerOp);
}
console.log('\nlatency distribution (ns per call)');
console.log(pad('operation', 46) + pad('p50', 10) + pad('p95', 10) + pad('p99', 10) + 'max');
console.log('-'.repeat(84));
for (const d of dists) {
  console.log(pad(d.label, 46) + pad(d.p50, 10) + pad(d.p95, 10) + pad(d.p99, 10) + d.max);
}

const dir = mkdtempSync(join(tmpdir(), 'p5-bench-'));
const out = join(dir, 'security-kernel-benchmark.json');
writeFileSync(out, JSON.stringify(report, null, 2));
console.log(`\nJSON: ${out}`);
console.log('(artifact is written to a temp dir on purpose: benchmark output must not ship in the repo)');
rmSync(dir, { recursive: true, force: true });
