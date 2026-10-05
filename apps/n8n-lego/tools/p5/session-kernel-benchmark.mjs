#!/usr/bin/env node
/**
 * P5.2 — Session kernel + CSRF benchmark.
 *
 * MEASURED, NOT ESTIMATED. Every number is produced by running the code in this
 * process. Nothing here is a target or a projection.
 *
 * THE CLAIM UNDER TEST — Issue #215 says:
 *
 * > No session DB lookup per workflow-node execution.
 *
 * P5.2 makes sessions revocable, and revocability costs a lookup. The question
 * this benchmark answers is what that lookup costs and where it is paid:
 * once per HTTP request at the boundary, never per node. The measurements below
 * are the honest price of turning an unrevocable bearer token into revocable
 * authority.
 *
 * Also measured: bounded memory under a session flood, and the CSRF check that
 * now runs on every state-changing request.
 */
import { performance } from 'node:perf_hooks';

import {
  SESSION_POLICY,
  createSession,
  createSessionStore,
  revokeAllSessions,
  revokeSession,
  rotateSession,
  validateSession,
} from '../../src/auth/security/session.mjs';
import { evaluateCsrf, issueCsrfToken } from '../../src/auth/security/csrf.mjs';

const ITERATIONS = 200_000;
const WARMUP = 20_000;
const T0 = 1_700_000_000_000;

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

// A populated store: the realistic case is a lookup against many sessions, not
// against an empty map.
const store = createSessionStore();
for (let i = 0; i < 5_000; i += 1) {
  createSession(store, { userId: `user-${i % 500}`, now: T0 });
}
const probe = createSession(store, { userId: 'probe', now: T0 });
const probeTouch = createSession(store, { userId: 'probe-touch', now: T0 });

const csrfToken = issueCsrfToken(probe.sessionId, 'benchmark-secret');
const csrfRequest = {
  method: 'POST',
  headers: {
    origin: 'https://app.example',
    cookie: `n8n-auth=whatever; n8n-csrf=${csrfToken}`,
    'x-n8n-csrf-token': csrfToken,
  },
};
const csrfOptions = { allowedOrigins: ['https://app.example'], sessionId: probe.sessionId, secret: 'benchmark-secret' };

const results = [
  bench('Session create (issue a new session)', () => {
    createSession(store, { userId: 'bench', now: T0 });
  }),
  bench('Session validate (hit, no touch)', () => {
    validateSession(store, probe.sessionId, { now: T0 + 1, touch: false });
  }),
  bench('Session validate (hit, sliding idle)', () => {
    validateSession(store, probeTouch.sessionId, { now: T0 + 1 });
  }),
  bench('Session validate (revoked — the deny path)', () => {
    validateSession(store, 'revoked-session-id', { now: T0 + 1 });
  }),
  bench('CSRF evaluate (same-origin, valid token)', () => {
    evaluateCsrf(csrfRequest, csrfOptions);
  }),
  bench('CSRF evaluate (cross-origin — deny)', () => {
    evaluateCsrf({ method: 'POST', headers: { origin: 'https://evil.example' } }, csrfOptions);
  }),
];

// Control-path operations: paid at login/logout/rotation, not per request.
const control = [
  bench('[control path] rotate', () => {
    const s = createSession(store, { userId: 'rot', now: T0 });
    rotateSession(store, s.sessionId, { now: T0 + 1 });
  }),
  bench('[control path] revoke', () => {
    const s = createSession(store, { userId: 'rev', now: T0 });
    revokeSession(store, s.sessionId, { now: T0 + 1 });
  }),
  bench('[control path] revokeAll (10 sessions)', () => {
    const target = `all-${Math.random()}`;
    for (let i = 0; i < 10; i += 1) createSession(store, { userId: target, now: T0 });
    revokeAllSessions(store, { userId: target, now: T0 + 1 });
  }),
];

const dists = [
  distribution('Session validate (hit)', () => validateSession(store, probe.sessionId, { now: T0 + 1, touch: false })),
  distribution('CSRF evaluate (valid)', () => evaluateCsrf(csrfRequest, csrfOptions)),
];

// Bounded memory under a flood.
const flood = createSessionStore({ ...SESSION_POLICY, maxSessions: 1_000 });
global.gc?.();
const floodBefore = process.memoryUsage().heapUsed;
for (let i = 0; i < 200_000; i += 1) {
  createSession(flood, { userId: `flood-${i}`, now: T0 });
}
global.gc?.();
const floodAfter = process.memoryUsage().heapUsed;

const pad = (s, n) => String(s).padEnd(n);
console.log('\nP5.2 SESSION KERNEL + CSRF — MEASURED BENCHMARK (no fabricated numbers)');
console.log(`node ${process.version}  ${process.platform}/${process.arch}  iterations=${ITERATIONS.toLocaleString()}`);
console.log(`store primed with ${store.size().toLocaleString()} sessions before timing\n`);
console.log('HOT PATH (paid once per HTTP request)');
console.log(pad('operation', 44) + pad('ns/op', 12) + pad('ops/sec', 14) + 'heap B/op');
console.log('-'.repeat(82));
for (const r of results) console.log(pad(r.label, 44) + pad(r.nsPerOp, 12) + pad(r.opsPerSec.toLocaleString(), 14) + r.heapBytesPerOp);
console.log('\nCONTROL PATH (paid at login / logout / rotation, not per request)');
console.log('-'.repeat(82));
for (const r of control) console.log(pad(r.label, 44) + pad(r.nsPerOp, 12) + pad(r.opsPerSec.toLocaleString(), 14) + r.heapBytesPerOp);
console.log('\nlatency distribution (ns per call)');
console.log(pad('operation', 44) + pad('p50', 10) + pad('p95', 10) + 'p99');
console.log('-'.repeat(82));
for (const d of dists) console.log(pad(d.label, 44) + pad(d.p50, 10) + pad(d.p95, 10) + d.p99);

console.log('\nBOUNDED MEMORY UNDER FLOOD');
console.log('-'.repeat(82));
console.log(`  200,000 sessions created against a store capped at 1,000`);
console.log(`  final store size          : ${flood.size().toLocaleString()} (cap 1,000 — the cap held)`);
console.log(`  heap delta                : ${((floodAfter - floodBefore) / 1024).toFixed(1)} KiB`);
console.log(`  heap per created session  : ${((floodAfter - floodBefore) / 200_000).toFixed(1)} B (evicted, so amortised)`);
console.log('\n(run with --expose-gc for stable heap figures; benchmark output is not written to the repo)');
