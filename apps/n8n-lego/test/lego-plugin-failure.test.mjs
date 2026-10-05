/**
 * P2.27.8 — circuit breaker + deadline propagation (§16/§17).
 *
 * Proves: the three breaker states with lazy clock-driven transitions,
 * threshold opening with retryAfterMs, single-flight half-open probe,
 * probe success closes / failure re-opens, published `lego.unavailable` on
 * denial (retryable), knob bounds; withDeadline clamps child ≤ parent via
 * the canonical deriveEnvelope, fails closed on exhausted/cancelled parents
 * with published codes; checkDeadlineRemaining maps remaining/none/past/
 * aborted onto null | ms | deadline_exceeded | cancelled.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CIRCUIT_BREAKER_STATES,
  CIRCUIT_BREAKER_BOUNDS,
  createCircuitBreaker,
  withDeadline,
  checkDeadlineRemaining,
} from '../src/lego/plugin-failure.mjs';
import { createEnvelope } from '../src/lego/envelope.mjs';
import { PluginRuntimeError } from '../src/lego/plugin-runtime.mjs';

const APP_ROOT = fileURLToPath(new URL('../', import.meta.url));

const breakerAt = (options = {}) => {
  let t = 100_000;
  const breaker = createCircuitBreaker({ now: () => t, ...options });
  return { breaker, advance: (ms) => { t += ms; }, now: () => t };
};

test('the breaker vocabulary is exactly the three design §16 states, frozen and bounded', () => {
  assert.deepEqual([...CIRCUIT_BREAKER_STATES], ['CLOSED', 'OPEN', 'HALF_OPEN']);
  assert.ok(Object.isFrozen(CIRCUIT_BREAKER_STATES));
  assert.equal(CIRCUIT_BREAKER_BOUNDS.failureThresholdMax, 1000);
  assert.equal(CIRCUIT_BREAKER_BOUNDS.halfOpenAfterMsMax, 86_400_000);
});

test('failures open the breaker at the threshold; success before it resets the count', () => {
  const { breaker } = breakerAt({ failureThreshold: 3, halfOpenAfterMs: 500 });
  assert.equal(breaker.state(), 'CLOSED');
  breaker.recordFailure();
  breaker.recordFailure();
  assert.equal(breaker.state(), 'CLOSED', 'two of three');
  breaker.recordSuccess();
  assert.equal(breaker.stats().consecutiveFailures, 0, 'success resets the window');
  breaker.recordFailure();
  breaker.recordFailure();
  breaker.recordFailure();
  assert.equal(breaker.state(), 'OPEN');
  assert.equal(breaker.stats().openedAt, 100_000);
});

test('OPEN denies with published lego.unavailable (retryable + retryAfterMs) until cooldown, then HALF_OPEN admits one probe', () => {
  const { breaker, advance } = breakerAt({ failureThreshold: 1, halfOpenAfterMs: 500 });
  breaker.recordFailure();
  assert.equal(breaker.state(), 'OPEN');
  const denied = breaker.canInvoke();
  assert.equal(denied.allowed, false);
  assert.equal(denied.state, 'OPEN');
  assert.equal(denied.retryAfterMs, 500);
  assert.throws(
    () => breaker.assertCanInvoke(),
    (error) =>
      error instanceof PluginRuntimeError &&
      error.code === 'lego.unavailable' &&
      error.retryable === true &&
      error.details.state === 'OPEN' &&
      error.details.retryAfterMs === 500,
  );
  advance(499);
  assert.equal(breaker.state(), 'OPEN', 'one ms short stays open');
  advance(1);
  assert.equal(breaker.state(), 'HALF_OPEN');
  assert.equal(breaker.canInvoke().allowed, true, 'first probe admitted');
  breaker.assertCanInvoke();
  assert.equal(breaker.canInvoke().allowed, false, 'second concurrent call denied while probe in flight');
  assert.match(breaker.canInvoke().reason, /probe already in flight/);
});

test('half-open probe: success closes (counters reset), failure re-opens with a fresh cooldown', () => {
  const { breaker, advance } = breakerAt({ failureThreshold: 2, halfOpenAfterMs: 100 });
  breaker.recordFailure();
  breaker.recordFailure();
  assert.equal(breaker.state(), 'OPEN');
  advance(100);
  assert.equal(breaker.state(), 'HALF_OPEN');
  breaker.assertCanInvoke();
  breaker.recordSuccess();
  assert.equal(breaker.state(), 'CLOSED');
  assert.equal(breaker.stats().consecutiveFailures, 0);
  assert.equal(breaker.stats().openedAt, null);

  // re-open via failures, cooldown, then a failed probe re-opens immediately
  breaker.recordFailure();
  breaker.recordFailure();
  assert.equal(breaker.state(), 'OPEN');
  advance(100);
  breaker.assertCanInvoke();
  breaker.recordFailure();
  assert.equal(breaker.state(), 'OPEN');
  assert.equal(breaker.canInvoke().retryAfterMs, 100, 'fresh cooldown from the failed probe');
  assert.ok(breaker.stats().probeCount >= 1);
});

test('breaker knobs and clock fail closed at construction', () => {
  for (const options of [
    { failureThreshold: 0 },
    { failureThreshold: 1001 },
    { failureThreshold: 2.5 },
    { halfOpenAfterMs: 0 },
    { halfOpenAfterMs: 86_400_001 },
    { now: 1 },
  ]) {
    assert.throws(() => createCircuitBreaker(options), TypeError, `rejects ${JSON.stringify(options)}`);
  }
  assert.ok(Object.isFrozen(createCircuitBreaker().stats()));
});

test('withDeadline: child deadline = min(parent, requested) — §17 clamp via canonical deriveEnvelope', () => {
  const parent = createEnvelope({ legoId: 'acme.pipe', operation: 'run', deadline: 2_000 });
  const childShort = withDeadline(parent, { timeoutMs: 500 }, { now: () => 1_000 });
  assert.equal(childShort.deadline, 1_500, 'child asks less: honored');
  const childLong = withDeadline(parent, { timeoutMs: 99_000 }, { now: () => 1_000 });
  assert.equal(childLong.deadline, 2_000, 'child asks more: clamped to the parent — never outlives it');
  assert.equal(childLong.correlationId, parent.correlationId, 'correlation propagates');
  assert.equal(childLong.actor, parent.actor);
});

test('withDeadline: exhausted or cancelled parents fail closed with published codes before any work', () => {
  const parent = createEnvelope({ legoId: 'acme.pipe', operation: 'run', deadline: 1_000 });
  assert.throws(
    () => withDeadline(parent, { timeoutMs: 100 }, { now: () => 1_000 }),
    (error) => error instanceof PluginRuntimeError && error.code === 'lego.deadline_exceeded' && error.details.deadline === 1_000,
  );
  const controller = new AbortController();
  controller.abort();
  const cancelledParent = createEnvelope({ legoId: 'acme.pipe', operation: 'run', deadline: 5_000, signal: controller.signal });
  assert.throws(
    () => withDeadline(cancelledParent, { timeoutMs: 100 }, { now: () => 1_000 }),
    (error) => error.code === 'lego.cancelled',
  );
  assert.throws(
    () => withDeadline({}, { timeoutMs: 1 }, { now: () => 1 }),
    (error) => error.code === 'lego.contract_violation',
  );
});

test('withDeadline: no-deadline parents pass the request through; explicit deadline specs honored', () => {
  const open = createEnvelope({ legoId: 'acme.pipe', operation: 'run' });
  assert.equal(open.deadline, null);
  const child = withDeadline(open, { timeoutMs: 50 }, { now: () => 10_000 });
  assert.equal(child.deadline, 10_050);
  const childExact = withDeadline(open, { deadline: 12_000 }, { now: () => 10_000 });
  assert.equal(childExact.deadline, 12_000);
});

test('checkDeadlineRemaining maps remaining | none | past | aborted onto published outcomes', () => {
  const at1000 = { now: () => 1_000 };
  const live = createEnvelope({ legoId: 'acme.pipe', operation: 'run', deadline: 1_400 });
  assert.equal(checkDeadlineRemaining(live, at1000), 400);
  const none = createEnvelope({ legoId: 'acme.pipe', operation: 'run' });
  assert.equal(checkDeadlineRemaining(none, at1000), null, 'no deadline = unbounded budget reported honestly as null');
  const past = createEnvelope({ legoId: 'acme.pipe', operation: 'run', deadline: 999 });
  assert.throws(
    () => checkDeadlineRemaining(past, at1000),
    (error) => error.code === 'lego.deadline_exceeded' && error.details.deadline === 999,
  );
  const edge = createEnvelope({ legoId: 'acme.pipe', operation: 'run', deadline: 1_000 });
  assert.throws(() => checkDeadlineRemaining(edge, at1000), (e) => e.code === 'lego.deadline_exceeded', 'deadline is inclusive');
  const controller = new AbortController();
  controller.abort();
  const aborted = createEnvelope({ legoId: 'acme.pipe', operation: 'run', deadline: 9_999, signal: controller.signal });
  assert.throws(() => checkDeadlineRemaining(aborted, at1000), (e) => e.code === 'lego.cancelled');
  assert.throws(() => checkDeadlineRemaining(null), (e) => e.code === 'lego.contract_violation');
});

test('the lock row keeps the failure modules locked (exact surface pins live in the newest suite)', () => {
  const lock = JSON.parse(readFileSync(join(APP_ROOT, 'src/lego/contracts/contract-lock.json'), 'utf8'));
  const row = lock.contracts.find((entry) => entry.id === 'lego.plugin-runtime');
  assert.match(row.version, /^\d+\.\d+\.\d+$/);
  assert.ok(row.surface.includes('src/lego/plugin-failure.mjs'));
  const source = readFileSync(join(APP_ROOT, 'src/lego/plugin-failure.mjs'), 'utf8');
  const exported = [...source.matchAll(/^export (?:const|class|function) (\w+)/gm)].map((m) => m[1]).sort();
  assert.deepEqual([...row.exports['src/lego/plugin-failure.mjs']].sort(), exported, 'lock ⇄ module exports for plugin-failure.mjs');
});
