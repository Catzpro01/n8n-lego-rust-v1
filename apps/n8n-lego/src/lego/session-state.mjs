/**
 * P5-M05 — shared session state over the P8 storage facade (REQ-0003 sections 7, 10).
 *
 * Session records and session-scoped state live ONLY behind the storage facade
 * handle: this module never imports a provider, never falls back to process
 * memory, and never simulates multi-host behaviour locally. Two logical hosts
 * are two createSessionState() instances over storage handles; their race
 * outcomes follow the storage contract (CAS for race-sensitive updates).
 *
 * Rust-readiness: injected clock and idFactory (no hidden global state), closed
 * error model, JSON store records with a version tag (upgrade compatibility),
 * deterministic given the same injected clock/idFactory/storage.
 *
 * Errors: SESSION_INVALID / SESSION_NOT_FOUND / SESSION_CONFLICT / SESSION_EXPIRED
 * (undotted codes, closed set) plus STORAGE_* propagated from the facade
 * unchanged (never remapped, never swallowed, never "continue without state").
 */

import { StorageError, STORAGE_ERROR_CODES } from './storage/contract.mjs';

export const SESSION_ERROR_CODES = Object.freeze({
  INVALID: 'SESSION_INVALID',
  NOT_FOUND: 'SESSION_NOT_FOUND',
  EXPIRED: 'SESSION_EXPIRED',
  CONFLICT: 'SESSION_CONFLICT',
});

export class SessionStateError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'SessionStateError';
    this.code = code;
    this.details = options.details ?? {};
    if (!Object.values(SESSION_ERROR_CODES).includes(code)) {
      throw new TypeError(`SessionStateError: unknown code ${String(code)}`);
    }
  }
}

const invalid = (message, details) => new SessionStateError(SESSION_ERROR_CODES.INVALID, message, { details });
const notFound = (message, details) => new SessionStateError(SESSION_ERROR_CODES.NOT_FOUND, message, { details });
const conflict = (message, details) => new SessionStateError(SESSION_ERROR_CODES.CONFLICT, message, { details });

const RECORD_TAG = 1;

const assertSessionId = (sessionId) => {
  if (typeof sessionId !== 'string' || sessionId.length < 8 || sessionId.length > 128) {
    throw invalid('sessionId must be an opaque string of 8..128 characters');
  }
  return sessionId;
};

const assertTtl = (ttlSeconds) => {
  if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) throw invalid('ttlSeconds must be a positive integer');
  return ttlSeconds;
};

/**
 * @param {object} storage storage facade handle (createStorage(...)) - the ONLY persistence boundary
 * @param {object} options
 * @param {{ now: () => number }} options.clock REQUIRED deterministic clock (ms)
 * @param {() => string} options.idFactory REQUIRED opaque session id factory (deterministic in tests)
 * @param {string} [options.namespace='session']
 * @param {number} [options.defaultTtlSeconds=3600]
 */
export function createSessionState(storage, { clock, idFactory, namespace = 'session', defaultTtlSeconds = 3600 } = {}) {
  if (!storage || typeof storage.get !== 'function' || typeof storage.putIfVersion !== 'function') {
    throw invalid('createSessionState requires a storage facade handle');
  }
  if (!clock || typeof clock.now !== 'function') throw invalid('an injected clock is required');
  if (typeof idFactory !== 'function') throw invalid('an injected idFactory is required');
  assertTtl(defaultTtlSeconds);

  const keyOf = (sessionId) => `s:${sessionId}`;
  const stateKeyOf = (sessionId, stateKey) => `d:${sessionId}:${stateKey}`;

  const readRecord = (sessionId) => {
    const got = storage.get(namespace, keyOf(sessionId));
    if (!got.found) return null;
    let record;
    try {
      record = JSON.parse(got.value.toString('utf8'));
    } catch (error) {
      throw conflict(`session record for ${sessionId.slice(0, 8)} is unreadable`, { cause: error });
    }
    if (record.tag !== RECORD_TAG) throw conflict('session record has an unsupported shape');
    return { record, version: got.version };
  };

  return Object.freeze({
    capabilities: storage.capabilities,

    /** Create a session record. Returns the opaque id and its expiry. */
    create({ principal, ttlSeconds = defaultTtlSeconds, metadata = {} } = {}) {
      if (typeof principal !== 'string' || principal.length === 0) throw invalid('principal must be a non-empty string');
      assertTtl(ttlSeconds);
      const sessionId = idFactory();
      assertSessionId(sessionId);
      const now = clock.now();
      const record = {
        tag: RECORD_TAG,
        principal,
        metadata,
        createdAt: now,
        lastSeenAt: now,
      };
      storage.put(namespace, keyOf(sessionId), Buffer.from(JSON.stringify(record), 'utf8'), { ttlSeconds });
      return Object.freeze({ sessionId, expiresAt: now + ttlSeconds * 1000 });
    },

    /** Read a session. Expired or missing sessions are explicit NOT_FOUND results, never empty successes. */
    get(sessionId) {
      assertSessionId(sessionId);
      const found = readRecord(sessionId);
      if (!found) throw notFound('session not found or expired', { sessionId: sessionId.slice(0, 8) });
      return Object.freeze({ ...found.record, version: found.version });
    },

    /**
     * Extend the session TTL through CAS: the caller passes the version it read
     * (from get()). A concurrent refresh on another host yields an explicit
     * CONFLICT - exactly one extension wins (multi-host behaviour follows the
     * storage contract).
     */
    refresh(sessionId, { version, ttlSeconds = defaultTtlSeconds } = {}) {
      assertSessionId(sessionId);
      assertTtl(ttlSeconds);
      if (typeof version !== 'string' || version.length === 0) throw invalid('refresh requires the version token read by get()');
      const found = readRecord(sessionId);
      if (!found) throw notFound('session not found or expired', { sessionId: sessionId.slice(0, 8) });
      const now = clock.now();
      const record = { ...found.record, lastSeenAt: now };
      const applied = storage.putIfVersion(
        namespace, keyOf(sessionId), Buffer.from(JSON.stringify(record), 'utf8'),
        version, { ttlSeconds },
      );
      if (!applied.applied) {
        throw conflict('session refresh lost a concurrent update', { reason: applied.reason });
      }
      return Object.freeze({ sessionId, expiresAt: now + ttlSeconds * 1000, version: applied.version });
    },

    /** Revoke (delete) a session and its state. Deleting an already-gone session is idempotent. */
    revoke(sessionId) {
      assertSessionId(sessionId);
      const result = storage.delete(namespace, keyOf(sessionId));
      return Object.freeze({ revoked: result.deleted });
    },

    /* ---------------------------------------------------- session-scoped state */

    getState(sessionId, stateKey) {
      assertSessionId(sessionId);
      if (typeof stateKey !== 'string' || stateKey.length === 0) throw invalid('stateKey must be a non-empty string');
      const got = storage.get(namespace, stateKeyOf(sessionId, stateKey));
      if (!got.found) return Object.freeze({ found: false });
      return Object.freeze({
        found: true,
        value: JSON.parse(got.value.toString('utf8')),
        version: got.version,
      });
    },

    /** CAS-guarded state write: pass the version from getState() (or null to create). */
    setState(sessionId, stateKey, value, { version = null } = {}) {
      assertSessionId(sessionId);
      if (typeof stateKey !== 'string' || stateKey.length === 0) throw invalid('stateKey must be a non-empty string');
      const payload = Buffer.from(JSON.stringify(value), 'utf8');
      if (version === null) {
        const existing = storage.get(namespace, stateKeyOf(sessionId, stateKey));
        if (existing.found) throw conflict('state key already exists; pass its version to update', { stateKey });
        storage.put(namespace, stateKeyOf(sessionId, stateKey), payload);
        return Object.freeze({ version: storage.get(namespace, stateKeyOf(sessionId, stateKey)).version });
      }
      const applied = storage.putIfVersion(namespace, stateKeyOf(sessionId, stateKey), payload, version);
      if (!applied.applied) throw conflict('state update lost a concurrent write', { reason: applied.reason, stateKey });
      return Object.freeze({ version: applied.version });
    },

    deleteState(sessionId, stateKey) {
      assertSessionId(sessionId);
      const result = storage.delete(namespace, stateKeyOf(sessionId, stateKey));
      return Object.freeze({ deleted: result.deleted });
    },

    /**
     * Atomic counter inside session state (race-sensitive): increments through
     * CAS with a bounded retry loop. A missing key is established with a
     * CONVERGENT put of 0 first (every racer writes the same bytes, so the
     * storage contract's last-writer-wins create cannot lose an increment),
     * then the increment is a pure CAS step. Concurrent increments on two hosts
     * never lose updates; exhaustion of retries is an explicit CONFLICT error
     * (never a silent drop or a memory fallback).
     */
    incrementState(sessionId, stateKey, { delta = 1, maxRetries = 3 } = {}) {
      assertSessionId(sessionId);
      if (!Number.isInteger(delta)) throw invalid('delta must be an integer');
      const key = stateKeyOf(sessionId, stateKey);
      for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        let got = storage.get(namespace, key);
        if (!got.found) {
          storage.put(namespace, key, Buffer.from('0', 'utf8')); // convergent initialise
          got = storage.get(namespace, key);
        }
        const current = JSON.parse(got.value.toString('utf8'));
        if (typeof current !== 'number') throw conflict('counter state holds a non-number', { stateKey });
        const next = current + delta;
        const applied = storage.putIfVersion(namespace, key, Buffer.from(JSON.stringify(next), 'utf8'), got.version);
        if (applied.applied) return Object.freeze({ value: next, version: applied.version });
      }
      throw conflict('counter increment exhausted retries under contention', { stateKey, maxRetries });
    },
  });
}

export { StorageError, STORAGE_ERROR_CODES };
