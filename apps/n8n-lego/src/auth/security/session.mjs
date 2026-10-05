/**
 * P5.2 — Session kernel: records, rotation, revocation, lifetimes.
 *
 * PUBLIC CONTRACT (`auth.session`, v1.0.0, owner: agent-1).
 *
 * WHY THIS EXISTS: the baseline session is a stateless HMAC token carrying
 * `{sub, iat, exp}`. That token is unforgeable but **unrevocable** — it is valid
 * until it expires, and nothing on the server can cut it short. A user who is
 * disabled, has their password changed, or simply logs out keeps a working
 * credential in every cookie already issued. Issue #215 exists to close that.
 *
 * THE TRADE-OFF, STATED HONESTLY: revocation requires server-side state, and
 * server-side state means a lookup. The rule this module is built around is
 * Issue #215's own:
 *
 * > No session DB lookup per workflow-node execution.
 *
 * So the cost is paid **once per HTTP request** at the authentication boundary,
 * never per node. A session is resolved into a `PrincipalSnapshot` (P5.1) at the
 * edge and the execution path then runs on that immutable, already-validated
 * projection. The lookup is O(1) on a Map, and the store is bounded.
 *
 * WHAT THE TOKEN CARRIES: `{sid, ver, exp}` — a session id, a session version
 * and an expiry. Deliberately NOT a user id, role, profile, permission list or
 * any secret. The token is a *pointer*; authority lives in the record behind it.
 */
import { randomBytes } from 'node:crypto';
import { SecurityError, SECURITY_REASON } from './security-error.mjs';
import { DEFAULT_TENANT } from './principal.mjs';

/** Terminal state machine. A session moves forward only; it never returns. */
export const SESSION_STATES = Object.freeze({
  /** Issued and currently valid. */
  ACTIVE: 'ACTIVE',
  /** Superseded by a rotation. The old token is dead the moment this is set. */
  ROTATED: 'ROTATED',
  /** Explicitly killed (logout, revoke, revokeAll, security mutation). */
  REVOKED: 'REVOKED',
  /** Reached its absolute or idle lifetime. Recorded so we can answer "why". */
  EXPIRED: 'EXPIRED',
});

/**
 * P5.6: strengths a SESSION can carry. `step-up` is deliberately absent — it is
 * earned per request by presenting fresh proof, never stored on a session.
 */
const SESSION_AUTH_STRENGTHS = Object.freeze(['password', 'mfa']);

/** Default lifetime policy. Bounded, and both bounds are enforced. */
export const SESSION_POLICY = Object.freeze({
  /** Absolute lifetime: a session cannot be refreshed past this. */
  absoluteMs: 7 * 24 * 60 * 60 * 1000,
  /** Idle lifetime: inactivity window before the session lapses. */
  idleMs: 24 * 60 * 60 * 1000,
  /** Hard cap on concurrent tracked sessions — memory is bounded. */
  maxSessions: 10_000,
  /**
   * How many entries to scan for a reclaimable (terminal) session before
   * falling back to evicting the oldest entry outright. Keeps eviction O(1)
   * with a small bounded constant instead of O(n) — see `store.set`.
   */
  evictScan: 32,
  /** Id under this length is not a session id we generated. */
  idBytes: 16,
});

/** Why a session validation refused. Each maps to a published error code. */
export const SESSION_VERDICT = Object.freeze({
  VALID: 'VALID',
  UNKNOWN: 'UNKNOWN',
  REVOKED: 'REVOKED',
  ROTATED: 'ROTATED',
  EXPIRED: 'EXPIRED',
  STALE_VERSION: 'STALE_VERSION',
});

/**
 * A bounded, in-memory session store.
 *
 * Memory is bounded two ways: a hard cap on tracked sessions, and opportunistic
 * eviction of terminal sessions (REVOKED/ROTATED/EXPIRED) whenever we are over
 * budget. A session flood therefore costs bounded memory rather than growing
 * without limit.
 */
export function createSessionStore(policy = {}) {
  const options = { ...SESSION_POLICY, ...policy };
  const sessions = new Map();

  function sweep(now = Date.now()) {
    // Drop sessions that are both terminal AND past their absolute expiry: they
    // can no longer be revived and only exist to answer "why was I rejected",
    // which stops mattering once the absolute window has passed.
    for (const [id, session] of sessions) {
      if (session.state !== SESSION_STATES.ACTIVE && session.absoluteExpiresAt <= now) {
        sessions.delete(id);
      }
    }
  }

  return {
    /** @returns {Readonly<object>} the effective policy */
    policy: () => ({ ...options }),
    size: () => sessions.size,
    get: (id) => sessions.get(id) ?? null,
    set(session) {
      // Eviction applies only when a NEW key is inserted. Updating an existing
      // session (the idle-window touch on every request) must never trigger it:
      // a read path that evicts live sessions would let ordinary traffic delete
      // other users' sessions.
      if (!sessions.has(session.sessionId) && sessions.size >= options.maxSessions) {
        // Bounded reclaim: Map preserves insertion order, so the front is the
        // oldest. Look for a terminal session to drop first — that costs the
        // caller nothing in security terms. Only if no terminal session turns up
        // within a small bounded window do we evict the oldest entry outright.
        //
        // This is O(evictScan), not O(n). Scanning the whole map here made every
        // insert — and every touching validate at capacity — cost O(n), which is
        // how a session flood turned into a latency attack.
        let reclaimed = false;
        let scanned = 0;
        for (const [id, candidate] of sessions) {
          if (scanned >= options.evictScan) break;
          scanned += 1;
          if (candidate.state !== SESSION_STATES.ACTIVE) {
            sessions.delete(id);
            reclaimed = true;
            break;
          }
        }
        if (!reclaimed) {
          const oldest = sessions.keys().next();
          if (!oldest.done) sessions.delete(oldest.value);
        }
      }
      sessions.set(session.sessionId, session);
      return session;
    },
    delete(id) {
      return sessions.delete(id);
    },
    deleteWhere(predicate) {
      let removed = 0;
      for (const [id, session] of sessions) {
        if (predicate(session)) {
          sessions.delete(id);
          removed += 1;
        }
      }
      return removed;
    },
    all: () => [...sessions.values()],
    sweep,
  };
}

/**
 * Issues a new session record. The returned object is the authoritative
 * server-side state; the caller is responsible for putting only `sessionId`
 * into the token.
 *
 * @param {ReturnType<createSessionStore>} store
 * @param {object} params
 * @param {string} params.userId
 * @param {string} [params.tenantId]
 * @param {number} [params.securityVersion] authority version this session is bound to
 * @param {string} [params.authStrength] P5.6: how the session was established — 'password' or
 *   'mfa' (one of the P5.1 AUTH_STRENGTHS; 'step-up' is per-request, never a session property)
 * @param {number} [params.authTime] P5.6: when that authentication happened (kept across rotation)
 * @param {number} [params.now]
 * @returns {Readonly<object>} frozen session record
 */
export function createSession(store, params) {
  const { userId, tenantId = DEFAULT_TENANT, securityVersion = 0, authStrength = 'password', now = Date.now() } = params;
  const authTime = params.authTime ?? now;
  if (!SESSION_AUTH_STRENGTHS.includes(authStrength)) {
    throw new SecurityError(SECURITY_REASON.MALFORMED_INPUT, 'a session authStrength must be password or mfa', {
      details: { authStrength: String(authStrength) },
    });
  }
  if (typeof userId !== 'string' || userId === '') {
    throw new SecurityError(SECURITY_REASON.MALFORMED_INPUT, 'a session requires a non-empty userId');
  }
  if (!Number.isInteger(securityVersion) || securityVersion < 0) {
    throw new SecurityError(SECURITY_REASON.MALFORMED_INPUT, 'securityVersion must be a non-negative integer');
  }
  const policy = store.policy();
  const session = Object.freeze({
    sessionId: randomBytes(policy.idBytes).toString('hex'),
    userId,
    tenantId,
    state: SESSION_STATES.ACTIVE,
    /** Bumped on each rotation; the token carries it so replay is detectable. */
    sessionVersion: 1,
    /** Authority version this session was issued against. */
    securityVersion,
    /** P5.6: 'password' | 'mfa' — what the login proved. Rotation keeps it; it never rises in place. */
    authStrength,
    authTime,
    createdAt: now,
    lastSeenAt: now,
    absoluteExpiresAt: now + policy.absoluteMs,
    idleExpiresAt: now + policy.idleMs,
    /** Set on rotation: where this session's authority moved to. */
    rotatedTo: null,
    revokedAt: null,
  });
  return store.set(session);
}

/**
 * Validates a presented session id against the store and current authority.
 *
 * Never throws for a *security* outcome — it returns a verdict. It throws only
 * when `now`/arguments are malformed, which is a programming error.
 *
 * `touch` advances the idle window; pass `false` for a pure read (e.g. a
 * background check) that must not extend a session's life.
 *
 * @param {ReturnType<createSessionStore>} store
 * @param {unknown} sessionId
 * @param {object} [options]
 * @param {number} [options.now]
 * @param {number} [options.securityVersion] authority version currently in force
 * @param {boolean} [options.touch] extend the idle window (default true)
 * @returns {{ valid: boolean, verdict: string, reasonCode: string|null, session: Readonly<object>|null }}
 */
export function validateSession(store, sessionId, options = {}) {
  const { now = Date.now(), securityVersion = null, touch = true } = options;
  const deny = (verdict, reasonCode, session = null) =>
    Object.freeze({ valid: false, verdict, reasonCode, session });

  if (typeof sessionId !== 'string' || sessionId === '') {
    return deny(SESSION_VERDICT.UNKNOWN, SECURITY_REASON.SESSION_INVALID);
  }
  const session = store.get(sessionId);
  if (!session) {
    // An unknown session is indistinguishable from a revoked one to the caller
    // on purpose — no oracle for "does this session id exist".
    return deny(SESSION_VERDICT.UNKNOWN, SECURITY_REASON.SESSION_INVALID);
  }
  if (session.state === SESSION_STATES.REVOKED) {
    return deny(SESSION_VERDICT.REVOKED, SECURITY_REASON.SESSION_INVALID, session);
  }
  if (session.state === SESSION_STATES.ROTATED) {
    // Rotation kills the old token immediately: this is the replay protection.
    return deny(SESSION_VERDICT.ROTATED, SECURITY_REASON.SESSION_INVALID, session);
  }
  if (session.state === SESSION_STATES.EXPIRED || now >= session.absoluteExpiresAt || now >= session.idleExpiresAt) {
    return deny(SESSION_VERDICT.EXPIRED, SECURITY_REASON.SESSION_INVALID, session);
  }
  if (securityVersion !== null && session.securityVersion < securityVersion) {
    // The account's authority moved on (password change, disable, revokeAll).
    // This session was issued against older authority and must not be honoured.
    return deny(SESSION_VERDICT.STALE_VERSION, SECURITY_REASON.STALE_AUTHORITY, session);
  }

  if (touch) {
    const policy = store.policy();
    // The idle window slides, but the absolute deadline never moves: a session
    // cannot be refreshed into immortality.
    const touched = Object.freeze({
      ...session,
      lastSeenAt: now,
      idleExpiresAt: Math.min(now + policy.idleMs, session.absoluteExpiresAt),
    });
    store.set(touched);
    // Return the record as it now stands, not as it was read: a caller that
    // validates and then uses the result must see the slid window.
    return Object.freeze({ valid: true, verdict: SESSION_VERDICT.VALID, reasonCode: null, session: touched });
  }
  return Object.freeze({ valid: true, verdict: SESSION_VERDICT.VALID, reasonCode: null, session });
}

/**
 * Rotates a session: issues a new session id and kills the old one atomically.
 *
 * This is both the **fixation** defence (the id a pre-auth attacker knew is not
 * the id that carries authority) and the **replay** defence (the old token stops
 * working the instant rotation happens, rather than at some grace window).
 *
 * @param {ReturnType<createSessionStore>} store
 * @param {string} sessionId
 * @param {object} [options]
 * @param {number} [options.securityVersion] override the carried authority version
 * @param {number} [options.now]
 * @returns {Readonly<object>} the new ACTIVE session
 */
export function rotateSession(store, sessionId, options = {}) {
  const { securityVersion = null, now = Date.now() } = options;
  const current = store.get(sessionId);
  if (!current) {
    throw new SecurityError(SECURITY_REASON.SESSION_INVALID, 'cannot rotate an unknown session');
  }
  if (current.state === SESSION_STATES.REVOKED) {
    throw new SecurityError(SECURITY_REASON.SESSION_INVALID, 'cannot rotate a revoked session');
  }
  const next = createSession(store, {
    userId: current.userId,
    tenantId: current.tenantId,
    securityVersion: securityVersion ?? current.securityVersion,
    // Rotation is a fixation defence, not re-authentication: the new session
    // inherits exactly the strength and auth time of the old one.
    authStrength: current.authStrength ?? 'password',
    authTime: current.authTime ?? current.createdAt,
    now,
  });
  store.set(
    Object.freeze({
      ...current,
      state: SESSION_STATES.ROTATED,
      rotatedTo: next.sessionId,
      revokedAt: now,
    }),
  );
  return next;
}

/**
 * Revokes one session.
 *
 * Idempotent: revoking twice is not an error. Returns `true` only when this call
 * actually killed a live session — an unknown id and an already-revoked session
 * both return `false`, deliberately indistinguishable, because for every caller
 * that matters the answer is the same: no live session was stopped just now.
 */
export function revokeSession(store, sessionId, { now = Date.now() } = {}) {
  const session = store.get(sessionId);
  if (!session) return false;
  if (session.state === SESSION_STATES.REVOKED) return false;
  store.set(
    Object.freeze({ ...session, state: SESSION_STATES.REVOKED, revokedAt: now }),
  );
  return true;
}

/**
 * Revokes every session for a user, optionally only those below an authority
 * version. Returns how many were killed — the caller needs that number for audit.
 *
 * @param {ReturnType<createSessionStore>} store
 @param {object} params
 * @param {string} params.userId
 * @param {number} [params.belowVersion] only revoke sessions older than this authority
 */
export function revokeAllSessions(store, { userId, belowVersion = null, now = Date.now() } = {}) {
  if (typeof userId !== 'string' || userId === '') {
    throw new SecurityError(SECURITY_REASON.MALFORMED_INPUT, 'revokeAllSessions requires a userId');
  }
  let revoked = 0;
  for (const session of store.all()) {
    if (session.userId !== userId) continue;
    if (session.state !== SESSION_STATES.ACTIVE) continue;
    if (belowVersion !== null && session.securityVersion >= belowVersion) continue;
    // Rewritten in place rather than deleted: a rejected session must still be
    // able to answer "why" for as long as the absolute window holds.
    store.set(Object.freeze({ ...session, state: SESSION_STATES.REVOKED, revokedAt: now }));
    revoked += 1;
  }
  return revoked;
}

/**
 * Inspection: what the operator/owner UI is allowed to see about a session.
 * Contains no token material and no user profile.
 */
export function inspectSession(store, sessionId) {
  const session = store.get(sessionId);
  if (!session) return null;
  return Object.freeze({
    sessionId: session.sessionId,
    userId: session.userId,
    tenantId: session.tenantId,
    state: session.state,
    sessionVersion: session.sessionVersion,
    securityVersion: session.securityVersion,
    createdAt: session.createdAt,
    lastSeenAt: session.lastSeenAt,
    idleExpiresAt: session.idleExpiresAt,
    absoluteExpiresAt: session.absoluteExpiresAt,
    rotatedTo: session.rotatedTo,
  });
}

/** Every session for a user, as inspectable projections. */
export function sessionsForUser(store, userId) {
  return store
    .all()
    .filter((session) => session.userId === userId)
    .map((session) => inspectSession(store, session.sessionId));
}

/**
 * Marks a session EXPIRED without deleting it. Used by the sweeper so a
 * rejection can still explain itself inside the absolute window.
 */
export function expireSessions(store, now = Date.now()) {
  let expired = 0;
  for (const session of store.all()) {
    if (session.state !== SESSION_STATES.ACTIVE) continue;
    if (now < session.absoluteExpiresAt && now < session.idleExpiresAt) continue;
    store.set(Object.freeze({ ...session, state: SESSION_STATES.EXPIRED, revokedAt: now }));
    expired += 1;
  }
  return expired;
}

/**
 * Builds the compact token payload. Three fields, nothing else.
 *
 * @param {Readonly<object>} session
 * @returns {{ sid: string, ver: number, exp: number }}
 */
export function sessionTokenPayload(session) {
  return Object.freeze({
    sid: session.sessionId,
    ver: session.sessionVersion,
    exp: session.absoluteExpiresAt,
  });
}
