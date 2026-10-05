/**
 * Backend LEGO foundation — P2.27 circuit breaker + deadline propagation.
 *
 * PUBLIC CONTRACT (`lego.plugin-runtime`, v0.8.0, owner: agent-1).
 *
 * Design §16 (circuit breaker) and §17 (deadline propagation), composed on
 * the canonical primitives instead of reinventing them:
 *
 * - **Breaker**: CLOSED → OPEN → HALF_OPEN → CLOSED. Repeated failures open
 *   the breaker (fail closed with the published `lego.unavailable`, retryable,
 *   with `retryAfterMs`); after `halfOpenAfterMs` a SINGLE half-open probe is
 *   admitted — success closes, failure re-opens. No timers, no background
 *   loops: state transitions are evaluated lazily on `state()`/`canInvoke()`
 *   against the injected clock (deterministic, testable, nothing to leak).
 * - **Deadline**: children derive from `lego.envelope`'s `deriveEnvelope`,
 *   which already clamps child ≤ parent — the §17 rule verbatim. This module
 *   adds the plugin-facing error mapping onto the published vocabulary:
 *   exhausted parent → `lego.deadline_exceeded`, aborted signal →
 *   `lego.cancelled`, so consumers branch on published codes, never on
 *   envelope internals.
 */
import { deriveEnvelope, remainingMs } from './envelope.mjs';
import { PluginRuntimeError } from './plugin-runtime.mjs';

/** Breaker states — exactly the three of design §16. */
export const CIRCUIT_BREAKER_STATES = Object.freeze(['CLOSED', 'OPEN', 'HALF_OPEN']);

/** Bounds for breaker knobs (§63: everything bounded). */
export const CIRCUIT_BREAKER_BOUNDS = Object.freeze({
  failureThresholdMax: 1000,
  halfOpenAfterMsMax: 86_400_000,
});

/**
 * Create a circuit breaker over an injected clock — no timers, no loops.
 *
 * @param {{ failureThreshold?: number, halfOpenAfterMs?: number, now?: () => number }} [options]
 */
export function createCircuitBreaker({
  failureThreshold = 5,
  halfOpenAfterMs = 30_000,
  now = Date.now,
} = {}) {
  if (!Number.isInteger(failureThreshold) || failureThreshold < 1 || failureThreshold > CIRCUIT_BREAKER_BOUNDS.failureThresholdMax) {
    throw new TypeError(`failureThreshold must be an integer in [1, ${CIRCUIT_BREAKER_BOUNDS.failureThresholdMax}]`);
  }
  if (!Number.isInteger(halfOpenAfterMs) || halfOpenAfterMs < 1 || halfOpenAfterMs > CIRCUIT_BREAKER_BOUNDS.halfOpenAfterMsMax) {
    throw new TypeError(`halfOpenAfterMs must be an integer in [1, ${CIRCUIT_BREAKER_BOUNDS.halfOpenAfterMsMax}]`);
  }
  if (typeof now !== 'function') throw new TypeError('createCircuitBreaker requires now() to be a function');

  let state = 'CLOSED';
  let consecutiveFailures = 0;
  let openedAt = null;
  let probeInFlight = false;
  let probeCount = 0;

  /** Lazy OPEN → HALF_OPEN when the cooldown elapsed (evaluated on read). */
  const evaluate = () => {
    if (state === 'OPEN' && openedAt !== null && now() - openedAt >= halfOpenAfterMs) {
      state = 'HALF_OPEN';
      probeInFlight = false;
    }
  };

  const stateNow = () => {
    evaluate();
    return state;
  };

  const canInvoke = () => {
    const current = stateNow();
    if (current === 'CLOSED') {
      return Object.freeze({ allowed: true, state: current, reason: 'breaker closed', retryAfterMs: 0 });
    }
    if (current === 'OPEN') {
      const retryAfterMs = Math.max(0, openedAt + halfOpenAfterMs - now());
      return Object.freeze({ allowed: false, state: current, reason: 'breaker open', retryAfterMs });
    }
    // HALF_OPEN: exactly one probe at a time
    if (probeInFlight) {
      return Object.freeze({ allowed: false, state: current, reason: 'half-open probe already in flight', retryAfterMs: 0 });
    }
    return Object.freeze({ allowed: true, state: current, reason: 'half-open probe admitted', retryAfterMs: 0 });
  };

  const assertCanInvoke = () => {
    const verdict = canInvoke();
    if (!verdict.allowed) {
      throw new PluginRuntimeError('lego.unavailable', `circuit breaker ${verdict.state}: ${verdict.reason}`, {
        details: { state: verdict.state, retryAfterMs: verdict.retryAfterMs },
        retryable: true,
      });
    }
    if (verdict.state === 'HALF_OPEN') probeInFlight = true;
    return true;
  };

  const recordSuccess = () => {
    const current = stateNow();
    if (current === 'HALF_OPEN') {
      state = 'CLOSED';
      consecutiveFailures = 0;
      openedAt = null;
      probeInFlight = false;
      return;
    }
    if (current === 'CLOSED') consecutiveFailures = 0;
    // OPEN + success: no admitted call should report here; ignore honestly.
  };

  const recordFailure = () => {
    const current = stateNow();
    if (current === 'HALF_OPEN') {
      state = 'OPEN';
      openedAt = now();
      consecutiveFailures = failureThreshold;
      probeInFlight = false;
      probeCount += 1;
      return;
    }
    if (current === 'OPEN') return; // already open; cooldown governs
    consecutiveFailures += 1;
    if (consecutiveFailures >= failureThreshold) {
      state = 'OPEN';
      openedAt = now();
    }
  };

  const stats = () => {
    const current = stateNow();
    return Object.freeze({
      state: current,
      consecutiveFailures,
      failureThreshold,
      halfOpenAfterMs,
      openedAt,
      probeCount,
      probesInFlight: probeInFlight ? 1 : 0,
    });
  };

  return Object.freeze({
    state: stateNow,
    canInvoke,
    assertCanInvoke,
    recordSuccess,
    recordFailure,
    stats,
  });
}

/**
 * Derive a child envelope for a plugin-to-plugin call (§17). The parent may
 * never be outlived: `deriveEnvelope` clamps child ≤ parent, and an already
 * exhausted parent fails closed with the published `lego.deadline_exceeded`
 * instead of starting doomed work.
 *
 * @param {object} parent envelope from `lego.envelope`
 * @param {{ timeoutMs?: number, operation?: string, legoId?: string, deadline?: number }} spec
 * @param {{ now?: () => number }} [options]
 */
export function withDeadline(parent, spec = {}, { now = Date.now } = {}) {
  if (!parent || typeof parent !== 'object' || !('deadline' in parent)) {
    throw new PluginRuntimeError('lego.contract_violation', 'withDeadline requires a parent envelope', {});
  }
  const at = now();
  if (parent.deadline !== null && parent.deadline !== undefined && parent.deadline <= at) {
    throw new PluginRuntimeError('lego.deadline_exceeded', `parent deadline already exhausted for ${parent.legoId}.${parent.operation}`, {
      details: { legoId: parent.legoId, operation: parent.operation, deadline: parent.deadline, now: at },
    });
  }
  if (parent.signal?.aborted) {
    throw new PluginRuntimeError('lego.cancelled', 'parent envelope is cancelled', {
      details: { legoId: parent.legoId, operation: parent.operation },
    });
  }
  const requested =
    spec.deadline !== undefined
      ? spec.deadline
      : spec.timeoutMs !== undefined
        ? at + spec.timeoutMs
        : parent.deadline;
  return deriveEnvelope(parent, { ...spec, deadline: requested });
}

/**
 * Remaining budget on a plugin envelope, mapped onto published codes:
 * `null` = no deadline set · positive ms = budget left ·
 * exhausted → `lego.deadline_exceeded` · aborted signal → `lego.cancelled`.
 *
 * @param {object} envelope
 * @param {{ now?: () => number }} [options]
 * @returns {number | null}
 */
export function checkDeadlineRemaining(envelope, { now = Date.now } = {}) {
  if (!envelope || typeof envelope !== 'object') {
    throw new PluginRuntimeError('lego.contract_violation', 'checkDeadlineRemaining requires an envelope', {});
  }
  if (envelope.signal?.aborted) {
    throw new PluginRuntimeError('lego.cancelled', `cancelled: ${envelope.legoId}.${envelope.operation}`, {
      details: { legoId: envelope.legoId, operation: envelope.operation },
    });
  }
  const remaining = remainingMs(envelope, now());
  if (remaining === null) return null;
  if (remaining <= 0) {
    throw new PluginRuntimeError('lego.deadline_exceeded', `deadline exceeded for ${envelope.legoId}.${envelope.operation}`, {
      details: { legoId: envelope.legoId, operation: envelope.operation, deadline: envelope.deadline },
    });
  }
  return remaining;
}
