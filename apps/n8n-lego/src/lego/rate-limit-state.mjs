/**
 * P5-M05 — shared rate-limiter state over the P8 storage facade (REQ-0003 sections 7, 10).
 *
 * Fixed-window counters persist ONLY behind the storage facade handle: no
 * process-memory simulation, no provider imports, no silent fallback. Two
 * logical hosts share the limit because the counter lives in storage; the
 * increment is a convergent initialise (identical bytes for every racer) plus a
 * pure CAS step, so concurrent consumes never lose updates - accounting stays
 * exact and multi-host behaviour follows the storage contract.
 *
 * Determinism: window boundaries come from the injected clock only.
 * Error model: RATE_LIMIT_INVALID (closed set) plus STORAGE_* propagated
 * unchanged. Contention that exhausts the bounded retry loop is an explicit
 * RATE_LIMIT_CONFLICT - never a silent pass, never a silent drop.
 */

import { StorageError, STORAGE_ERROR_CODES } from './storage/contract.mjs';

export const RATE_LIMIT_ERROR_CODES = Object.freeze({
  INVALID: 'RATE_LIMIT_INVALID',
  CONFLICT: 'RATE_LIMIT_CONFLICT',
});

export class RateLimitError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'RateLimitError';
    this.code = code;
    this.details = options.details ?? {};
    if (!Object.values(RATE_LIMIT_ERROR_CODES).includes(code)) {
      throw new TypeError(`RateLimitError: unknown code ${String(code)}`);
    }
  }
}

const invalid = (message, details) => new RateLimitError(RATE_LIMIT_ERROR_CODES.INVALID, message, { details });
const conflict = (message, details) => new RateLimitError(RATE_LIMIT_ERROR_CODES.CONFLICT, message, { details });

/**
 * @param {object} storage storage facade handle - the ONLY persistence boundary
 * @param {object} options
 * @param {{ now: () => number }} options.clock REQUIRED deterministic clock (ms)
 * @param {number} options.windowSeconds window size (positive integer)
 * @param {number} options.maxRequests allowed consumes per window (positive integer)
 * @param {string} [options.namespace='rate-limit']
 * @param {number} [options.defaultTtlSeconds] counter TTL (>= windowSeconds; default windowSeconds * 2)
 */
export function createRateLimiter(storage, { clock, windowSeconds, maxRequests, namespace = 'rate-limit', defaultTtlSeconds } = {}) {
  if (!storage || typeof storage.get !== 'function' || typeof storage.putIfVersion !== 'function') {
    throw invalid('createRateLimiter requires a storage facade handle');
  }
  if (!clock || typeof clock.now !== 'function') throw invalid('an injected clock is required');
  if (!Number.isInteger(windowSeconds) || windowSeconds <= 0) throw invalid('windowSeconds must be a positive integer');
  if (!Number.isInteger(maxRequests) || maxRequests <= 0) throw invalid('maxRequests must be a positive integer');
  const ttlSeconds = defaultTtlSeconds ?? windowSeconds * 2;
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < windowSeconds) throw invalid('defaultTtlSeconds must be an integer >= windowSeconds');

  const windowIndex = () => Math.floor(clock.now() / 1000 / windowSeconds);
  const keyOf = (key, index) => `r:${key}:${index}`;
  const resetAt = (index) => (index + 1) * windowSeconds * 1000;

  /** Convergent initialise + pure CAS increment (never loses an update). */
  const bump = (storageKey, delta, maxRetries) => {
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      let got = storage.get(namespace, storageKey);
      if (!got.found) {
        storage.put(namespace, storageKey, Buffer.from('0', 'utf8'), { ttlSeconds }); // convergent initialise
        got = storage.get(namespace, storageKey);
      }
      const current = JSON.parse(got.value.toString('utf8'));
      if (typeof current !== 'number') throw conflict('rate-limit counter is unreadable', { key: storageKey });
      const next = current + delta;
      const applied = storage.putIfVersion(namespace, storageKey, Buffer.from(JSON.stringify(next), 'utf8'), got.version, { ttlSeconds });
      if (applied.applied) return { value: next, version: applied.version };
    }
    throw conflict('rate-limit increment exhausted retries under contention', { key: storageKey, maxRetries });
  };

  /** Non-mutating status for the current window. */
  const peek = (key) => {
    if (typeof key !== 'string' || key.length === 0) throw invalid('key must be a non-empty string');
    const index = windowIndex();
    const got = storage.get(namespace, keyOf(key, index));
    const used = got.found ? JSON.parse(got.value.toString('utf8')) : 0;
    return Object.freeze({
      key,
      used,
      remaining: Math.max(0, maxRequests - used),
      limited: used >= maxRequests,
      resetAt: resetAt(index),
    });
  };

  return Object.freeze({
    capabilities: storage.capabilities,
    windowSeconds,
    maxRequests,

    peek,

    /**
     * Consume one unit. Returns an explicit decision - never a silent pass:
     *   { limited: false, used, remaining, resetAt }  - allowed
     *   { limited: true,  used, remaining, resetAt }  - over the limit (no counter lie: used is the real count)
     * The over-limit case still CAS-increments the real usage counter so
     * accounting stays exact (used can exceed maxRequests); the DECISION is
     * derived from the pre-increment value so exactly the allowed number of
     * consumes pass per window across all hosts.
     */
    consume(key, { maxRetries = 3 } = {}) {
      if (typeof key !== 'string' || key.length === 0) throw invalid('key must be a non-empty string');
      const index = windowIndex();
      const before = peek(key);
      if (before.limited) {
        // Record the rejected attempt as real usage (exact accounting), then refuse.
        const counted = bump(keyOf(key, index), 1, maxRetries);
        return Object.freeze({
          key, used: counted.value, remaining: 0, limited: true, resetAt: resetAt(index),
        });
      }
      const counted = bump(keyOf(key, index), 1, maxRetries);
      return Object.freeze({
        key,
        used: counted.value,
        remaining: Math.max(0, maxRequests - counted.value),
        limited: counted.value > maxRequests,
        resetAt: resetAt(index),
      });
    },

    /** Explicitly clear the current window's counter. */
    reset(key) {
      if (typeof key !== 'string' || key.length === 0) throw invalid('key must be a non-empty string');
      const index = windowIndex();
      const result = storage.delete(namespace, keyOf(key, index));
      return Object.freeze({ reset: result.deleted, resetAt: resetAt(index) });
    },
  });
}

export { StorageError, STORAGE_ERROR_CODES };
