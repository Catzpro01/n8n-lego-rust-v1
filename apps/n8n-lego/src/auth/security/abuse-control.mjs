/**
 * P5.6 — bounded abuse controls: rate limiting and failure back-off.
 *
 * WHY THIS SHAPE
 * A rate limiter is itself an attack surface. A limiter that allocates one
 * entry per distinct key is a memory-exhaustion vector: an attacker who sprays
 * random e-mail addresses or spoofed forwarding headers grows the table without
 * bound. So every structure here has a HARD capacity, and what happens at that
 * capacity is a declared policy, not an accident:
 *
 *   1. reclaim — scan a small, bounded number of the oldest entries for one
 *      whose window has expired and reuse its slot (O(evictScan), constant);
 *   2. degrade — if nothing is reclaimable the table is under a key flood. New
 *      keys are then charged to ONE shared overflow bucket with its own limit.
 *      A flood therefore throttles itself instead of evicting the counters of
 *      real accounts (which would reset their limits) or growing memory.
 *
 * Memory is `maxKeys` fixed-size entries whatever the traffic. Keys are
 * HMAC digests (see `abuseKey`), so the tables never hold an e-mail address or
 * an IP in the clear and every entry is the same size.
 *
 * Nothing here is persisted and nothing is shared between processes: a restart
 * resets the counters, which is the same process-local stance the session
 * store takes (P5.2). Documented as scale-out debt with the session store.
 */
import { createHmac } from 'node:crypto';

/**
 * Upstream-derived limits (n8n `RateLimitService` defaults and the per-route
 * decorators on the pinned reference). Values are the reference values so the
 * product throttles exactly where n8n does — no tighter, no looser.
 */
export const ABUSE_POLICY = Object.freeze({
  /** `@Post('/login')` ipRateLimit */
  loginIp: Object.freeze({ limit: 1000, windowMs: 5 * 60_000 }),
  /** `@Post('/login')` keyedRateLimit on `emailOrLdapLoginId` */
  loginAccount: Object.freeze({ limit: 5, windowMs: 60_000 }),
  /** `@Post('/forgot-password')` ipRateLimit */
  forgotIp: Object.freeze({ limit: 20, windowMs: 5 * 60_000 }),
  /** `@Post('/forgot-password')` keyedRateLimit on `email` (default window) */
  forgotAccount: Object.freeze({ limit: 3, windowMs: 5 * 60_000 }),
  /** `ipRateLimit: true` on resolve-password-token / change-password (defaults) */
  resetIp: Object.freeze({ limit: 5, windowMs: 5 * 60_000 }),
  /** `createUserKeyedRateLimiter({})` on /mfa/enable, /mfa/disable, /mfa/verify, PATCH /me/password */
  userAction: Object.freeze({ limit: 5, windowMs: 5 * 60_000 }),
  /**
   * Consecutive-failure back-off per account (P5.6 addition, not in upstream).
   * After `threshold` straight failures each further failure doubles the lock,
   * capped at `maxMs`. A success clears it. Applied identically to accounts
   * that do not exist, so it discloses nothing.
   */
  loginBackoff: Object.freeze({ threshold: 5, baseMs: 30_000, maxMs: 15 * 60_000 }),
  /** Hard capacity of every table. */
  maxKeys: 10_000,
  /** Oldest entries inspected for a reclaimable slot before degrading. */
  evictScan: 32,
  /** Overflow bucket: the shared limit for keys that arrive during a flood, per window. */
  overflowFactor: 4,
});

/** Response text upstream's limiter sends with the 429. */
export const RATE_LIMIT_MESSAGE = 'Too many requests';

/**
 * Stable, fixed-size, non-reversible key for a (kind, value) pair.
 * Normalises case and surrounding whitespace so `A@x.io ` and `a@x.io` share a
 * counter — otherwise case variation would multiply an attacker's budget.
 *
 * @param {string} kind e.g. 'login-account', 'ip'
 * @param {unknown} value raw identifier
 * @param {string} secret instance secret (keys are unlinkable across instances)
 */
export function abuseKey(kind, value, secret) {
  const normalized = String(value ?? '').trim().toLowerCase();
  return createHmac('sha256', String(secret)).update(`${kind}\u241f${normalized}`).digest('base64url').slice(0, 22);
}

function positiveInt(value, name) {
  if (!Number.isInteger(value) || value < 1) throw new TypeError(`${name} must be a positive integer`);
  return value;
}

/**
 * Bounded table with reclaim-then-degrade semantics shared by both controls.
 * `isReclaimable(entry, now)` says whether an entry's slot may be reused.
 */
function boundedTable({ maxKeys, evictScan, isReclaimable }) {
  const entries = new Map();
  let reclaimed = 0;
  return {
    get: (key) => entries.get(key),
    delete: (key) => entries.delete(key),
    get size() {
      return entries.size;
    },
    stats: () => ({ size: entries.size, maxKeys, reclaimed }),
    /** Returns true when stored, false when the table is saturated. */
    set(key, entry, now) {
      if (entries.has(key) || entries.size < maxKeys) {
        entries.set(key, entry);
        return true;
      }
      let scanned = 0;
      for (const [candidate, value] of entries) {
        if (scanned >= evictScan) break;
        scanned += 1;
        if (isReclaimable(value, now)) {
          entries.delete(candidate);
          entries.set(key, entry);
          reclaimed += 1;
          return true;
        }
      }
      return false;
    },
  };
}

/**
 * Fixed-window counter per key, bounded.
 *
 * @param {object} options
 * @param {number} options.limit requests allowed per window per key
 * @param {number} options.windowMs window length
 * @param {number} [options.maxKeys]
 * @param {number} [options.evictScan]
 * @param {number} [options.overflowLimit] shared limit for keys arriving while saturated
 */
export function createRateLimiter({
  limit,
  windowMs,
  maxKeys = ABUSE_POLICY.maxKeys,
  evictScan = ABUSE_POLICY.evictScan,
  overflowLimit = limit * ABUSE_POLICY.overflowFactor,
} = {}) {
  positiveInt(limit, 'limit');
  positiveInt(windowMs, 'windowMs');
  positiveInt(maxKeys, 'maxKeys');
  positiveInt(overflowLimit, 'overflowLimit');
  const table = boundedTable({ maxKeys, evictScan, isReclaimable: (entry, now) => entry.resetAt <= now });
  const overflow = { count: 0, resetAt: 0 };
  let degraded = 0;

  function charge(entry, cap, now) {
    if (entry.resetAt <= now) {
      entry.count = 0;
      entry.resetAt = now + windowMs;
    }
    entry.count += 1;
    const allowed = entry.count <= cap;
    return { allowed, retryAfterMs: allowed ? 0 : entry.resetAt - now, remaining: Math.max(0, cap - entry.count) };
  }

  return {
    limit,
    windowMs,
    /**
     * Count one attempt for `key`.
     * @returns {{ allowed: boolean, retryAfterMs: number, remaining: number, degraded: boolean }}
     */
    hit(key, now = Date.now()) {
      let entry = table.get(key);
      if (!entry) {
        entry = { count: 0, resetAt: now + windowMs };
        if (!table.set(key, entry, now)) {
          degraded += 1;
          return { ...charge(overflow, overflowLimit, now), degraded: true };
        }
      }
      return { ...charge(entry, limit, now), degraded: false };
    },
    /** Forget a key (e.g. after a successful login clears the account counter). */
    reset(key) {
      table.delete(key);
    },
    stats() {
      return { ...table.stats(), degraded, overflowCount: overflow.count };
    },
  };
}

/**
 * Consecutive-failure back-off, bounded. Exponential lock after a threshold,
 * capped; a success clears the key.
 *
 * Why back-off and not a hard lockout: a hard lockout lets anyone who knows an
 * e-mail address lock that user out indefinitely. A capped, self-expiring
 * back-off bounds both the attacker's guess rate and the victim's worst case.
 */
export function createFailureBackoff({
  threshold = ABUSE_POLICY.loginBackoff.threshold,
  baseMs = ABUSE_POLICY.loginBackoff.baseMs,
  maxMs = ABUSE_POLICY.loginBackoff.maxMs,
  maxKeys = ABUSE_POLICY.maxKeys,
  evictScan = ABUSE_POLICY.evictScan,
} = {}) {
  positiveInt(threshold, 'threshold');
  positiveInt(baseMs, 'baseMs');
  positiveInt(maxMs, 'maxMs');
  // An entry is reclaimable once it is not locked and has been quiet for the
  // longest lock: at that point forgetting it cannot shorten any lock.
  const table = boundedTable({
    maxKeys,
    evictScan,
    isReclaimable: (entry, now) => entry.lockedUntil <= now && entry.lastFailureAt + maxMs <= now,
  });

  return {
    /** @returns {{ locked: boolean, retryAfterMs: number }} */
    check(key, now = Date.now()) {
      const entry = table.get(key);
      if (!entry || entry.lockedUntil <= now) return { locked: false, retryAfterMs: 0 };
      return { locked: true, retryAfterMs: entry.lockedUntil - now };
    },
    /** @returns {{ failures: number, lockedForMs: number, tracked: boolean }} */
    recordFailure(key, now = Date.now()) {
      const entry = table.get(key) ?? { failures: 0, lockedUntil: 0, lastFailureAt: now };
      entry.failures += 1;
      entry.lastFailureAt = now;
      let lockedForMs = 0;
      if (entry.failures >= threshold) {
        const exponent = Math.min(entry.failures - threshold, 20);
        lockedForMs = Math.min(maxMs, baseMs * 2 ** exponent);
        entry.lockedUntil = now + lockedForMs;
      }
      // When saturated the failure is not tracked; the account and IP rate
      // limiters (which degrade into their overflow bucket) still bound the
      // guess rate, so saturation weakens the back-off, never the limit.
      const tracked = table.set(key, entry, now);
      return { failures: entry.failures, lockedForMs, tracked };
    },
    recordSuccess(key) {
      table.delete(key);
    },
    stats() {
      return table.stats();
    },
  };
}
