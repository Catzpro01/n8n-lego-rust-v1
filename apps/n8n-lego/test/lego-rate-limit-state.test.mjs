/**
 * P5-M05 — rate-limiter state over the storage facade. Two logical hosts share
 * one storage; the accounting must stay exact under interleaved consumes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStorage } from '../src/lego/storage/contract.mjs';
import { createLocalStorage } from '../src/lego/storage/local-provider.mjs';
import { createTestClock } from '../src/lego/storage/conformance.mjs';
import { createRateLimiter, RateLimitError, RATE_LIMIT_ERROR_CODES } from '../src/lego/rate-limit-state.mjs';

const boundary = (clock, windowSeconds, windowsAhead = 1) => {
  const index = Math.floor(clock.now() / 1000 / windowSeconds);
  return (index + windowsAhead) * windowSeconds * 1000;
};

const setup = ({ windowSeconds = 60, maxRequests = 5 } = {}) => {
  const clock = createTestClock();
  const provider = createLocalStorage({ clock });
  const hostA = createRateLimiter(createStorage(provider), { clock, windowSeconds, maxRequests });
  const hostB = createRateLimiter(createStorage(provider), { clock, windowSeconds, maxRequests });
  return { clock, hostA, hostB };
};

test('rate-limit: exactly maxRequests pass per window; further consumes are explicit refusals', () => {
  const { clock, hostA } = setup();
  for (let i = 1; i <= 5; i += 1) {
    const r = hostA.consume('ip:10.0.0.1');
    assert.equal(r.limited, false, `consume ${i} allowed`);
    assert.equal(r.used, i);
    assert.equal(r.remaining, 5 - i);
    assert.equal(r.resetAt, boundary(clock, 60), 'resetAt is the window boundary from the injected clock');
  }
  const refused = hostA.consume('ip:10.0.0.1');
  assert.equal(refused.limited, true, 'explicit refusal, never a silent pass');
  assert.equal(refused.remaining, 0);
  assert.equal(refused.used, 6, 'the counter records real usage (exact accounting)');
});

test('rate-limit: two hosts share one limit - interleaved consumes never lose updates', () => {
  const { hostA, hostB } = setup({ maxRequests: 40 });
  for (let i = 0; i < 37; i += 1) {
    hostA.consume('user-1');
    hostB.consume('user-1');
  }
  // 74 consumes attempted against a limit of 40: exactly 40 allowed, 34 refused.
  let allowed = 0; let refused = 0;
  for (let i = 0; i < 74; i += 1) {
    const r = (i % 2 ? hostB : hostA).consume('user-1');
    if (r.limited) refused += 1; else allowed += 1;
  }
  const status = hostA.peek('user-1');
  assert.equal(status.used, 148, 'every attempt is counted exactly once (CAS, no lost updates)');
  assert.equal(allowed + refused, 74);
  assert.equal(hostB.peek('user-1').used, status.used, 'both hosts observe the same shared counter');
});

test('rate-limit: the first 40 of 74 interleaved attempts pass exactly - no over/under-admission', () => {
  const { hostA, hostB } = setup({ maxRequests: 40 });
  const decisions = [];
  for (let i = 0; i < 74; i += 1) decisions.push((i % 2 ? hostB : hostA).consume('k').limited);
  const passed = decisions.filter((d) => !d).length;
  assert.equal(passed, 40, 'exactly the allowed number of consumes pass across both hosts');
});

test('rate-limit: window rollover resets the decision deterministically from the clock', () => {
  const { clock, hostA } = setup({ windowSeconds: 60, maxRequests: 2 });
  hostA.consume('k'); hostA.consume('k');
  assert.equal(hostA.consume('k').limited, true);
  clock.advance(60_000);
  assert.equal(hostA.consume('k').limited, false, 'new window allows again');
  assert.equal(hostA.peek('k').used, 1, 'new window has its own counter');
  assert.equal(hostA.peek('k').resetAt, boundary(clock, 60), 'boundary moves one window forward');
});

test('rate-limit: peek is non-mutating; reset is explicit', () => {
  const { clock, hostA } = setup();
  const before = hostA.peek('k');
  assert.deepEqual(before, { key: 'k', used: 0, remaining: 5, limited: false, resetAt: boundary(clock, 60) });
  assert.deepEqual(hostA.peek('k'), before, 'peek does not count');
  hostA.consume('k');
  assert.deepEqual(hostA.reset('k'), { reset: true, resetAt: boundary(clock, 60) });
  assert.equal(hostA.peek('k').used, 0, 'reset clears the window counter');
});

test('rate-limit: invalid configuration and keys are typed INVALID', () => {
  const clock = createTestClock();
  const storage = createStorage(createLocalStorage({ clock }));
  assert.throws(() => createRateLimiter(storage, { clock, windowSeconds: 0, maxRequests: 1 }),
    (e) => e instanceof RateLimitError && e.code === RATE_LIMIT_ERROR_CODES.INVALID);
  assert.throws(() => createRateLimiter(storage, { clock, windowSeconds: 60, maxRequests: 0 }),
    (e) => e.code === RATE_LIMIT_ERROR_CODES.INVALID);
  assert.throws(() => createRateLimiter(storage, { windowSeconds: 60, maxRequests: 1 }),
    (e) => e.code === RATE_LIMIT_ERROR_CODES.INVALID, 'clock is required');
  const limiter = createRateLimiter(storage, { clock, windowSeconds: 60, maxRequests: 1 });
  assert.throws(() => limiter.consume(''), (e) => e.code === RATE_LIMIT_ERROR_CODES.INVALID);
});

test('rate-limit: storage failures propagate (STORAGE_*) - no silent pass, no memory fallback', () => {
  const clock = createTestClock();
  let explode = false;
  const persistence = { load: () => null, save: () => { if (explode) throw new Error('disk full'); } };
  const limiter = createRateLimiter(createStorage(createLocalStorage({ clock, persistence })),
    { clock, windowSeconds: 60, maxRequests: 5 });
  limiter.consume('k');
  explode = true;
  assert.throws(() => limiter.consume('k'),
    (e) => e.name === 'StorageError' && e.code === 'STORAGE_UNAVAILABLE', 'a broken store never becomes a silent pass');
  explode = false;
  assert.equal(limiter.peek('k').used, 1, 'the failed consume left no partial count (rollback)');
});

test('rate-limit: surface exposes no provider internals; capabilities travel through', () => {
  const { hostA } = setup();
  assert.deepEqual(Object.keys(hostA).sort(), ['capabilities', 'consume', 'maxRequests', 'peek', 'reset', 'windowSeconds']);
  assert.equal(hostA.capabilities.multiHost, false, 'local provider honesty flows through');
});
