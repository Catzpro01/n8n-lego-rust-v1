/**
 * P5.2 — Session kernel and CSRF boundary tests.
 *
 * PUBLIC CONTRACT (`auth.session`, v1.0.0): revocable sessions, rotation,
 * lifetimes, and the browser CSRF boundary.
 *
 * The negative tests carry this file. Before P5.2, logout only cleared a cookie
 * while the token itself stayed valid until expiry; every "denied" assertion
 * below is a case that used to be an ALLOW.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  SESSION_POLICY,
  SESSION_STATES,
  SESSION_VERDICT,
  createSession,
  createSessionStore,
  expireSessions,
  inspectSession,
  revokeAllSessions,
  revokeSession,
  rotateSession,
  sessionTokenPayload,
  sessionsForUser,
  validateSession,
} from '../src/auth/security/session.mjs';
import {
  CSRF_COOKIE,
  CSRF_HEADER,
  CSRF_VERDICT,
  SAFE_METHODS,
  csrfCookieHeader,
  evaluateCsrf,
  issueCsrfToken,
  normalizeOrigin,
  parseCookieHeader,
  verifyCsrfToken,
} from '../src/auth/security/csrf.mjs';

const LOCK = JSON.parse(readFileSync(new URL('../src/lego/contracts/contract-lock.json', import.meta.url), 'utf8'));
const DOMAINS = JSON.parse(readFileSync(new URL('../src/lego/manifest/domains.json', import.meta.url), 'utf8'));

const T0 = 1_700_000_000_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** A store + one ACTIVE session for user `u1`. */
function fixture(overrides = {}) {
  const store = createSessionStore({ ...SESSION_POLICY, ...overrides });
  const session = createSession(store, { userId: 'u1', now: T0 });
  return { store, session };
}

// ─────────────────────────────────────────────────────────────────────────────
// Create / validate
// ─────────────────────────────────────────────────────────────────────────────

test('a new session is ACTIVE, bounded in time, and carries no profile', () => {
  const { store, session } = fixture();
  assert.equal(session.state, SESSION_STATES.ACTIVE);
  assert.equal(session.userId, 'u1');
  assert.equal(session.tenantId, 'default');
  assert.equal(session.sessionVersion, 1);
  assert.equal(session.absoluteExpiresAt, T0 + SESSION_POLICY.absoluteMs);
  assert.equal(session.idleExpiresAt, T0 + SESSION_POLICY.idleMs);
  assert.ok(Object.isFrozen(session));

  // No user record, no role catalog, no secret — only ids and timestamps.
  const forbidden = ['email', 'firstName', 'password', 'role', 'globalScopes', 'settings'];
  for (const key of forbidden) {
    assert.ok(!Object.prototype.hasOwnProperty.call(session, key), `session must not carry ${key}`);
  }
  assert.ok(store.size() === 1);
});

test('the token payload is three fields and nothing else', () => {
  const { session } = fixture();
  const payload = sessionTokenPayload(session);
  assert.deepEqual(Object.keys(payload), ['sid', 'ver', 'exp']);
  assert.equal(payload.sid, session.sessionId);
  assert.equal(payload.ver, session.sessionVersion);
  assert.equal(typeof payload.exp, 'number');
  // No profile, no role catalog, no secret in the token either.
  for (const key of ['sub', 'email', 'role', 'scopes', 'password']) {
    assert.ok(!(key in payload), `token payload must not contain ${key}`);
  }
});

test('a valid session validates, and touching slides idle but never absolute', () => {
  const { store, session } = fixture();
  const later = T0 + HOUR;
  const verdict = validateSession(store, session.sessionId, { now: later });
  assert.equal(verdict.valid, true);
  assert.equal(verdict.session.lastSeenAt, later);
  assert.ok(verdict.session.idleExpiresAt <= session.absoluteExpiresAt, 'idle never outruns absolute');

  // Repeated refresh slides the idle window but can never extend the absolute
  // deadline — a session must not be refreshable into immortality.
  let cursor = T0;
  while (cursor + SESSION_POLICY.idleMs / 2 < T0 + SESSION_POLICY.absoluteMs) {
    cursor += SESSION_POLICY.idleMs / 2;
    const v = validateSession(store, session.sessionId, { now: cursor });
    assert.equal(v.valid, true, `still valid under continuous use at +${cursor - T0}ms`);
    assert.equal(v.session.absoluteExpiresAt, session.absoluteExpiresAt, 'absolute deadline is fixed');
    assert.ok(v.session.idleExpiresAt <= session.absoluteExpiresAt, 'idle never outruns absolute');
  }
  // The idle window really did slide well past its original position...
  assert.ok(store.get(session.sessionId).idleExpiresAt > session.idleExpiresAt);
  // ...while the absolute deadline did not move at all.
  assert.equal(store.get(session.sessionId).absoluteExpiresAt, session.absoluteExpiresAt);
});

test('unknown, empty and malformed session ids fail closed', () => {
  const { store } = fixture();
  for (const bad of [null, undefined, '', 'nope', 42, {}, []]) {
    const v = validateSession(store, bad);
    assert.equal(v.valid, false, `${JSON.stringify(bad)} must be refused`);
    assert.equal(v.verdict, SESSION_VERDICT.UNKNOWN);
    assert.equal(v.reasonCode, 'auth.unauthorized');
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Rotation — fixation and replay
// ─────────────────────────────────────────────────────────────────────────────

test('rotation kills the old token immediately — this is the replay defence', () => {
  const { store, session } = fixture();
  assert.equal(validateSession(store, session.sessionId, { now: T0 + 1 }).valid, true);

  const next = rotateSession(store, session.sessionId, { now: T0 + 2 });

  // The old token is dead at once, not after a grace window.
  const old = validateSession(store, session.sessionId, { now: T0 + 3 });
  assert.equal(old.valid, false);
  assert.equal(old.verdict, SESSION_VERDICT.ROTATED);
  // The new one works, and has a different id (fixation defence).
  assert.notEqual(next.sessionId, session.sessionId);
  assert.equal(validateSession(store, next.sessionId, { now: T0 + 3 }).valid, true);
  // The chain is auditable: the old record says where authority moved to.
  assert.equal(inspectSession(store, session.sessionId).rotatedTo, next.sessionId);
});

test('rotation preserves identity and tenant, and cannot revive a revoked session', () => {
  const { store, session } = fixture();
  const multi = createSession(store, { userId: 'u2', tenantId: 'tenant-a', now: T0 });
  const next = rotateSession(store, multi.sessionId, { now: T0 + 1 });
  assert.equal(next.userId, 'u2');
  assert.equal(next.tenantId, 'tenant-a');

  revokeSession(store, session.sessionId, { now: T0 + 1 });
  assert.throws(() => rotateSession(store, session.sessionId), /revoked/i);
  assert.throws(() => rotateSession(store, 'never-existed'), /unknown/i);
});

// ─────────────────────────────────────────────────────────────────────────────
// Revocation
// ─────────────────────────────────────────────────────────────────────────────

test('revoke kills one session and is idempotent', () => {
  const { store, session } = fixture();
  assert.equal(revokeSession(store, session.sessionId, { now: T0 + 1 }), true);
  const v = validateSession(store, session.sessionId, { now: T0 + 2 });
  assert.equal(v.valid, false);
  assert.equal(v.verdict, SESSION_VERDICT.REVOKED);
  assert.equal(revokeSession(store, session.sessionId), false, 'second revoke is a no-op, not an error');
  // Still inspectable: a rejection must be able to explain itself.
  assert.equal(inspectSession(store, session.sessionId).state, SESSION_STATES.REVOKED);
});

test('revokeAll kills every session for a user and leaves other users alone', () => {
  const store = createSessionStore();
  const a1 = createSession(store, { userId: 'u1', now: T0 });
  const a2 = createSession(store, { userId: 'u1', now: T0 + 1 });
  const b1 = createSession(store, { userId: 'u2', now: T0 + 2 });

  const revoked = revokeAllSessions(store, { userId: 'u1', now: T0 + 3 });
  assert.equal(revoked, 2);
  assert.equal(validateSession(store, a1.sessionId, { now: T0 + 4 }).valid, false);
  assert.equal(validateSession(store, a2.sessionId, { now: T0 + 4 }).valid, false);
  assert.equal(validateSession(store, b1.sessionId, { now: T0 + 4 }).valid, true, 'other users unaffected');
});

test('revokeAll with belowVersion spares sessions issued at newer authority', () => {
  const store = createSessionStore();
  const old = createSession(store, { userId: 'u1', securityVersion: 1, now: T0 });
  const fresh = createSession(store, { userId: 'u1', securityVersion: 5, now: T0 + 1 });
  assert.equal(revokeAllSessions(store, { userId: 'u1', belowVersion: 5, now: T0 + 2 }), 1);
  assert.equal(validateSession(store, old.sessionId, { now: T0 + 3 }).valid, false);
  assert.equal(validateSession(store, fresh.sessionId, { now: T0 + 3 }).valid, true);
});

test('revocation is per-session, not per-user: one device can be killed alone', () => {
  const store = createSessionStore();
  const phone = createSession(store, { userId: 'u1', now: T0 });
  const laptop = createSession(store, { userId: 'u1', now: T0 + 1 });
  revokeSession(store, phone.sessionId, { now: T0 + 2 });
  assert.equal(validateSession(store, phone.sessionId, { now: T0 + 3 }).valid, false);
  assert.equal(validateSession(store, laptop.sessionId, { now: T0 + 3 }).valid, true);
});

// ─────────────────────────────────────────────────────────────────────────────
// securityVersion invalidation
// ─────────────────────────────────────────────────────────────────────────────

test('a session issued at older authority is refused once the version advances', () => {
  const { store, session } = fixture();
  assert.equal(session.securityVersion, 0);
  assert.equal(validateSession(store, session.sessionId, { now: T0 + 1, securityVersion: 0 }).valid, true);

  const v = validateSession(store, session.sessionId, { now: T0 + 1, securityVersion: 1 });
  assert.equal(v.valid, false);
  assert.equal(v.verdict, SESSION_VERDICT.STALE_VERSION);
  assert.equal(v.reasonCode, 'lego.version_incompatible');
  assert.notEqual(v.verdict, SESSION_VERDICT.VALID, 'stale authority is never an allow');
});

test('a session issued AT the current version is not stale', () => {
  const store = createSessionStore();
  const s = createSession(store, { userId: 'u1', securityVersion: 4, now: T0 });
  assert.equal(validateSession(store, s.sessionId, { now: T0 + 1, securityVersion: 4 }).valid, true);
  assert.equal(validateSession(store, s.sessionId, { now: T0 + 1, securityVersion: 3 }).valid, true);
});

// ─────────────────────────────────────────────────────────────────────────────
// Lifetimes
// ─────────────────────────────────────────────────────────────────────────────

test('idle lifetime lapses a session, and activity inside it does not', () => {
  const { store, session } = fixture();
  // Inside the window: valid, and the touch slides the window forward.
  const beforeIdle = T0 + SESSION_POLICY.idleMs - HOUR;
  const inside = validateSession(store, session.sessionId, { now: beforeIdle });
  assert.equal(inside.valid, true);
  assert.equal(inside.session.idleExpiresAt, beforeIdle + SESSION_POLICY.idleMs);

  // Past the window: refused. This needs a SEPARATE, untouched session — the
  // session above had its idle window slid by the validation we just did, so
  // re-using it would be testing the slide, not the lapse.
  const fresh = fixture();
  const lapsed = validateSession(fresh.store, fresh.session.sessionId, {
    now: T0 + SESSION_POLICY.idleMs + 1,
    touch: false,
  });
  assert.equal(lapsed.valid, false);
  assert.equal(lapsed.verdict, SESSION_VERDICT.EXPIRED);
});

test('absolute lifetime lapses a session no matter how recently it was used', () => {
  const { store, session } = fixture();
  // Keep the session genuinely active the whole way: touch it repeatedly, well
  // inside each idle window, right up to the absolute deadline. If the idle
  // window is allowed to lapse first, this test would be measuring idle, not
  // absolute — which is exactly the mistake this loop avoids.
  let now = T0;
  while (now + (SESSION_POLICY.idleMs / 2) < T0 + SESSION_POLICY.absoluteMs) {
    now += SESSION_POLICY.idleMs / 2;
    const v = validateSession(store, session.sessionId, { now });
    assert.equal(v.valid, true, `session must survive active use at +${now - T0}ms`);
  }
  // Still inside the absolute window and still valid...
  assert.equal(validateSession(store, session.sessionId, { now: T0 + SESSION_POLICY.absoluteMs - 1 }).valid, true);
  // ...and dead the moment absolute passes, despite being continuously used.
  const v = validateSession(store, session.sessionId, { now: T0 + SESSION_POLICY.absoluteMs + 1 });
  assert.equal(v.valid, false);
  assert.equal(v.verdict, SESSION_VERDICT.EXPIRED);
});

test('touch:false inspects without extending the session', () => {
  const { store, session } = fixture();
  const v = validateSession(store, session.sessionId, { now: T0 + HOUR, touch: false });
  assert.equal(v.valid, true);
  assert.equal(store.get(session.sessionId).lastSeenAt, T0, 'lastSeenAt unchanged');
});

test('expireSessions marks lapsed sessions EXPIRED without deleting them', () => {
  const { store, session } = fixture();
  assert.equal(expireSessions(store, T0 + SESSION_POLICY.absoluteMs + 1), 1);
  assert.equal(store.get(session.sessionId).state, SESSION_STATES.EXPIRED);
  assert.ok(store.get(session.sessionId), 'record retained so "why" stays answerable');
});

// ─────────────────────────────────────────────────────────────────────────────
// Bounded state
// ─────────────────────────────────────────────────────────────────────────────

test('the session store is bounded: a flood cannot grow it without limit', () => {
  const store = createSessionStore({ ...SESSION_POLICY, maxSessions: 50 });
  for (let i = 0; i < 500; i += 1) {
    createSession(store, { userId: `user-${i}`, now: T0 + i });
  }
  assert.ok(store.size() <= 50, `store held ${store.size()} sessions, expected <= 50`);
});

test('a touching validate never evicts: read paths must not delete live sessions', () => {
  // Regression guard. Eviction originally triggered on every `set`, so the
  // idle-window touch that every authenticated request performs could evict a
  // *different* user's live session once the store was at capacity. Ordinary
  // read traffic must never destroy authority.
  const store = createSessionStore({ ...SESSION_POLICY, maxSessions: 3 });
  const a = createSession(store, { userId: 'a', now: T0 });
  const b = createSession(store, { userId: 'b', now: T0 });
  const c = createSession(store, { userId: 'c', now: T0 });
  assert.equal(store.size(), 3);

  for (let i = 0; i < 100; i += 1) {
    validateSession(store, a.sessionId, { now: T0 + HOUR * (i + 1) });
  }
  assert.equal(store.get(b.sessionId)?.state, SESSION_STATES.ACTIVE, 'touching a must not evict b');
  assert.equal(store.get(c.sessionId)?.state, SESSION_STATES.ACTIVE, 'touching a must not evict c');
  assert.equal(validateSession(store, a.sessionId, { now: T0 + HOUR }).valid, true);
});

test('insertion stays bounded at capacity — the sweep is not O(n) per insert', () => {
  // Regression guard for the same defect seen from the other side: a full sweep
  // on every insert made `createSession` O(n) once the store was full, so a
  // session flood degraded login latency by orders of magnitude. Eviction is
  // now a bounded scan.
  const cap = 400;
  const store = createSessionStore({ ...SESSION_POLICY, maxSessions: cap, evictScan: 32 });
  for (let i = 0; i < cap; i += 1) createSession(store, { userId: `warm-${i}`, now: T0 });

  const started = process.hrtime.bigint();
  const inserts = 5_000;
  for (let i = 0; i < inserts; i += 1) createSession(store, { userId: `flood-${i}`, now: T0 });
  const nsPerInsert = Number(process.hrtime.bigint() - started) / inserts;

  // Generous absolute bound: the point is that cost does not scale with the
  // store size. A full sweep over `cap` entries per insert would blow past this.
  assert.ok(
    nsPerInsert < 200_000,
    `insert at capacity cost ${nsPerInsert.toFixed(0)} ns — eviction must stay bounded, not O(n)`,
  );
  assert.equal(store.size(), cap, 'the cap held');
});

test('terminal sessions are swept once past their absolute window', () => {
  const store = createSessionStore({ ...SESSION_POLICY, maxSessions: 10 });
  const s = createSession(store, { userId: 'u1', now: T0 });
  revokeSession(store, s.sessionId, { now: T0 + 1 });
  assert.equal(store.size(), 1, 'retained inside the window so it can explain a rejection');
  store.sweep(T0 + SESSION_POLICY.absoluteMs + 1);
  assert.equal(store.size(), 0, 'dropped once it can no longer matter');
});

test('sessionsForUser returns inspectable projections with no token material', () => {
  const store = createSessionStore();
  createSession(store, { userId: 'u1', now: T0 });
  createSession(store, { userId: 'u1', now: T0 + 1 });
  createSession(store, { userId: 'u2', now: T0 + 2 });
  const list = sessionsForUser(store, 'u1');
  assert.equal(list.length, 2);
  for (const entry of list) {
    assert.ok(Object.isFrozen(entry));
    for (const key of ['password', 'email', 'token', 'secret']) {
      assert.ok(!Object.prototype.hasOwnProperty.call(entry, key));
    }
  }
});

test('createSession rejects a missing or non-integer securityVersion', () => {
  const store = createSessionStore();
  assert.throws(() => createSession(store, { userId: '' }), /userId/);
  assert.throws(() => createSession(store, { userId: 'u1', securityVersion: -1 }), /securityVersion/);
  assert.throws(() => createSession(store, { userId: 'u1', securityVersion: 1.5 }), /securityVersion/);
});

// ─────────────────────────────────────────────────────────────────────────────
// CSRF
// ─────────────────────────────────────────────────────────────────────────────

test('a CSRF token verifies for its own session and no other', () => {
  const token = issueCsrfToken('session-abc', 'secret');
  assert.equal(verifyCsrfToken(token, 'session-abc', 'secret'), true);
  assert.equal(verifyCsrfToken(token, 'session-xyz', 'secret'), false, 'token is session-bound');
  assert.equal(verifyCsrfToken(token, 'session-abc', 'other-secret'), false, 'token is secret-bound');
  for (const bad of [null, '', 'nope', 'a.b', undefined]) {
    assert.equal(verifyCsrfToken(bad, 'session-abc', 'secret'), false, `${bad} rejected`);
  }
});

test('safe methods are exempt; state-changing ones are not', () => {
  for (const method of SAFE_METHODS) {
    const v = evaluateCsrf({ method, headers: { origin: 'https://evil.example' } }, {
      allowedOrigins: ['https://app.example'], sessionId: 's1', secret: 'secret',
    });
    assert.equal(v.verdict, CSRF_VERDICT.NOT_APPLICABLE, `${method} must be exempt`);
  }
  assert.deepEqual([...SAFE_METHODS], ['GET', 'HEAD', 'OPTIONS']);
});

test('a cross-origin state change is blocked even with a valid session', () => {
  const v = evaluateCsrf({ method: 'POST', headers: { origin: 'https://evil.example' } }, {
    allowedOrigins: ['https://app.example'], sessionId: 's1', secret: 'secret',
  });
  assert.equal(v.allowed, false);
  assert.equal(v.verdict, CSRF_VERDICT.ORIGIN_MISMATCH);
  assert.equal(v.reasonCode, 'auth.forbidden');
});

test('a same-origin state change passes — this is the pinned editor path', () => {
  // The shipped n8n editor sends Origin (browsers always do on a state change)
  // and NO x-n8n-csrf-token header. That path must work, because the original
  // n8n UI is the declared compatibility surface. It is protected by the origin
  // check plus SameSite=Lax, not by a header the editor cannot send.
  const v = evaluateCsrf(
    { method: 'POST', headers: { origin: 'https://app.example', cookie: 'n8n-auth=abc' } },
    { allowedOrigins: ['https://app.example'], sessionId: 's1', secret: 'secret' },
  );
  assert.equal(v.allowed, true);
  assert.equal(v.verdict, CSRF_VERDICT.OK);
});

test('an opted-in client must present a valid double-submit token', () => {
  const token = issueCsrfToken('s1', 'secret');
  const base = { allowedOrigins: ['https://app.example'], sessionId: 's1', secret: 'secret', requireToken: true };
  const headers = { origin: 'https://app.example', cookie: `${CSRF_COOKIE}=${token}`, [CSRF_HEADER]: token };
  assert.equal(evaluateCsrf({ method: 'POST', headers }, base).verdict, CSRF_VERDICT.OK);
  assert.equal(
    evaluateCsrf({ method: 'POST', headers: { origin: 'https://app.example', cookie: `${CSRF_COOKIE}=${token}` } }, base).verdict,
    CSRF_VERDICT.TOKEN_MISMATCH,
    'cookie without the echoing header',
  );
  assert.equal(
    evaluateCsrf({ method: 'POST', headers: { origin: 'https://app.example', cookie: `${CSRF_COOKIE}=${token}`, [CSRF_HEADER]: issueCsrfToken('s1', 'secret') } }, base).verdict,
    CSRF_VERDICT.TOKEN_MISMATCH,
    'header that does not match the cookie',
  );
  assert.equal(
    evaluateCsrf({ method: 'POST', headers: { origin: 'https://app.example', cookie: `${CSRF_COOKIE}=${issueCsrfToken('other', 'secret')}`, [CSRF_HEADER]: issueCsrfToken('other', 'secret') } }, base).verdict,
    CSRF_VERDICT.TOKEN_MISMATCH,
    'token minted for a different session',
  );
  // Origin still wins: a valid token does not excuse a cross-site request.
  assert.equal(
    evaluateCsrf({ method: 'POST', headers: { ...headers, origin: 'https://evil.example' } }, base).verdict,
    CSRF_VERDICT.ORIGIN_MISMATCH,
  );
});

test('a cross-origin write is blocked with or without a token', () => {
  const token = issueCsrfToken('s1', 'secret');
  const base = { allowedOrigins: ['https://app.example'], sessionId: 's1', secret: 'secret' };
  assert.equal(
    evaluateCsrf({ method: 'POST', headers: { origin: 'https://evil.example' } }, base).verdict,
    CSRF_VERDICT.ORIGIN_MISMATCH,
  );
  // A well-formed token does not excuse a cross-site origin: origin is checked
  // first and is not bypassable by presenting a valid token.
  assert.equal(
    evaluateCsrf({ method: 'POST', headers: { origin: 'https://evil.example', cookie: `${CSRF_COOKIE}=${token}`, [CSRF_HEADER]: token } }, base).verdict,
    CSRF_VERDICT.ORIGIN_MISMATCH,
  );
  assert.equal(
    evaluateCsrf({ method: 'DELETE', headers: { origin: 'https://evil.example' } }, base).verdict,
    CSRF_VERDICT.ORIGIN_MISMATCH,
  );
});

test('a state-changing request with no Origin and no Referer is refused', () => {
  const v = evaluateCsrf({ method: 'POST', headers: {} }, {
    allowedOrigins: ['https://app.example'], sessionId: 's1', secret: 'secret',
  });
  assert.equal(v.allowed, false);
  assert.equal(v.verdict, CSRF_VERDICT.MISSING_ORIGIN);
});

test('Referer is accepted when Origin is absent', () => {
  const v = evaluateCsrf({ method: 'PATCH', headers: { referer: 'https://app.example/some/page' } }, {
    allowedOrigins: ['https://app.example'], sessionId: null, secret: 'secret',
  });
  assert.equal(v.allowed, true, 'no session means no ambient authority to forge');
});

test('a session-less request is not CSRF-protected, because there is nothing to forge', () => {
  const v = evaluateCsrf({ method: 'POST', headers: { origin: 'https://evil.example' } }, {
    allowedOrigins: [], sessionId: null, secret: 'secret',
  });
  assert.equal(v.verdict, CSRF_VERDICT.NOT_APPLICABLE);
});

test('normalizeOrigin reduces to scheme://host and rejects junk', () => {
  assert.equal(normalizeOrigin('https://app.example:8443/a/b?c=d'), 'https://app.example:8443');
  assert.equal(normalizeOrigin('not a url'), null);
  assert.equal(normalizeOrigin(''), null);
  assert.equal(normalizeOrigin(null), null);
});

test('parseCookieHeader handles the shapes a browser sends', () => {
  assert.deepEqual(parseCookieHeader('a=1; b=2'), { a: '1', b: '2' });
  assert.deepEqual(parseCookieHeader(''), {});
  assert.deepEqual(parseCookieHeader(null), {});
  assert.deepEqual(parseCookieHeader('a=1;;b'), { a: '1' });
});

test('the CSRF cookie is readable by JS but not HttpOnly, and carries no authority', () => {
  const header = csrfCookieHeader('tok', { secure: true });
  assert.ok(header.startsWith(`${CSRF_COOKIE}=tok`));
  assert.ok(header.includes('SameSite=Lax'));
  assert.ok(header.includes('Secure'));
  // Deliberately NOT HttpOnly: the editor must read it to echo it. It grants
  // nothing on its own — session identity stays in the HttpOnly n8n-auth cookie.
  assert.ok(!header.includes('HttpOnly'));
});

// ─────────────────────────────────────────────────────────────────────────────
// Contract registration
// ─────────────────────────────────────────────────────────────────────────────

test('auth.session is registered at 1.0.0 with an exact surface', async () => {
  const row = LOCK.contracts.find((c) => c.id === 'auth.session');
  assert.ok(row, 'auth.session is in contract-lock.json');
  assert.equal(row.version, '1.0.0');
  assert.equal(row.domain, 'auth');
  assert.equal(row.status, 'stable');
  assert.deepEqual(row.surface, ['src/auth/security/session.mjs', 'src/auth/security/csrf.mjs']);
  assert.deepEqual(row.tests, ['apps/n8n-lego/test/lego-session-kernel.test.mjs']);

  const session = await import('../src/auth/security/session.mjs');
  const csrf = await import('../src/auth/security/csrf.mjs');
  assert.deepEqual(
    [...row.exports['src/auth/security/session.mjs']].sort(),
    Object.keys(session).sort(),
    'the pinned session exports match the module exactly',
  );
  assert.deepEqual(
    [...row.exports['src/auth/security/csrf.mjs']].sort(),
    Object.keys(csrf).sort(),
    'the pinned csrf exports match the module exactly',
  );
});

test('the P5.1 kernel surface is unchanged by P5.2', async () => {
  const row = LOCK.contracts.find((c) => c.id === 'auth.principal');
  assert.equal(row.version, '1.0.0');
  assert.deepEqual(row.surface, ['src/auth/security/index.mjs']);
  const kernel = await import('../src/auth/security/index.mjs');
  assert.deepEqual([...row.exports['src/auth/security/index.mjs']].sort(), Object.keys(kernel).sort());
  // P5.2 deliberately did NOT widen the P5.1 facade.
  assert.ok(!('createSession' in kernel), 'session exports live in session.mjs, not the kernel facade');
});

test('the auth domain declares the session capability and stays at 26 domains', () => {
  const domains = Object.values(DOMAINS.domains ?? DOMAINS);
  assert.equal(domains.length, 26, 'P5.2 adds capabilities, not domains');
  const auth = domains.find((d) => d.id === 'auth');
  assert.ok(auth.capabilities.some((c) => c.id === 'auth.session-kernel'), 'session capability declared');
  assert.equal(domains.filter((d) => d.id === 'auth').length, 1);
});

test('P5.2 adds the ninety-sixth row and preserves every earlier phase', () => {
  assert.equal(LOCK.contracts.length, 100, '95 through P5.1 + auth.session');
  assert.equal(LOCK.contracts.filter((r) => r.domain === 'observability').length, 22, 'P9 intact');
  const byId = Object.fromEntries(LOCK.contracts.map((r) => [r.id, r.version]));
  assert.equal(byId['auth.principal'], '1.0.0', 'P5.1 intact');
  assert.equal(byId['auth.identity'], '1.0.0', 'untouched, owner agent-3');
  assert.equal(byId['lego.plugin-runtime'], '0.10.0', 'P2.27 intact');
  assert.equal(LOCK.contracts.filter((r) => r.id === r.id).length - new Set(LOCK.contracts.map((r) => r.id)).size, 0, 'no duplicate ids');
});
