/**
 * P5.6 (#219) — password recovery, abuse controls, MFA and step-up.
 *
 * Three layers:
 *   1. primitives (abuse-control, password-hash, reset-token, mfa, step-up) in isolation;
 *   2. the real auth route handlers behind a minimal HTTP harness, so the flows
 *      that need an injected mail-delivery port or controlled limits run end to end;
 *   3. the real server (`startServer`), including a restart against the on-disk
 *      keyring, for the flows the editor exercises.
 *
 * Acceptance mapping (#219):
 *   reset replay fails ............................ "reset: single use"
 *   old sessions revoked after reset .............. "reset: kills every existing session"
 *   MFA recovery-code replay fails ................ "mfa: a recovery code works once"
 *   rate limiter bounded, not a memory DoS ........ "limiter: memory is bounded under a key flood"
 *   no account disclosure via recovery ............ "forgot-password: identical answers"
 *   sensitive changes require declared strength ... "step-up: …" + route coverage test
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, scryptSync } from 'node:crypto';

import { startServer } from '../src/server.mjs';
import { createStore } from '../src/store.mjs';
import { HttpError } from '../src/compat/error.mjs';
import { readBody, sendError } from '../src/compat/response.mjs';
import { authRoutes } from '../src/auth/routes.mjs';
import { createAccountSecurity, MFA_REQUIRED_CODE, MFA_EXPIRED_CODE } from '../src/auth/account-routes.mjs';
import { authenticate, createOwner, createSession, currentUser, hashPassword } from '../src/auth.mjs';
import {
  ABUSE_POLICY,
  RATE_LIMIT_MESSAGE,
  abuseKey,
  createFailureBackoff,
  createRateLimiter,
} from '../src/auth/security/abuse-control.mjs';
import {
  LEGACY_SCRYPT,
  PASSWORD_HASH_POLICY,
  hashPassword as hashWithPolicy,
  needsRehash,
  parsePasswordHash,
  passwordPolicyViolation,
  verifyPassword,
} from '../src/auth/security/password-hash.mjs';
import {
  RESET_TOKEN_POLICY,
  RESET_TOKEN_VERDICT,
  createResetTokenStore,
  credentialFingerprint,
} from '../src/auth/security/reset-token.mjs';
import {
  MFA_EVENTS,
  MFA_SECRET_TYPE,
  MFA_STATES,
  TOTP_WINDOW,
  base32Decode,
  base32Encode,
  consumeRecoveryCode,
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  mfaSecretCollection,
  mfaSecretRecord,
  mfaStateOf,
  mfaTransition,
  timeStep,
  totpAt,
  totpUri,
  verifyTotp,
} from '../src/auth/security/mfa.mjs';
import { PROOF, STEP_UP_REQUIREMENTS, evaluateStepUp, requiredProofs } from '../src/auth/security/step-up.mjs';
import { bootCredentialVault, createCredentialVault } from '../src/auth/security/credential-vault.mjs';
import { createMemoryKeyProvider } from '../src/auth/security/key-provider.mjs';
import { createSession as createSessionRecord, createSessionStore, rotateSession } from '../src/auth/security/session.mjs';

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_CATALOG = join(APP_ROOT, '..', '..', 'catalog');
const PASSWORD = 'Correct-Horse-9';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ======================================================================= 1 */
/*                                 PRIMITIVES                                */
/* ======================================================================= */

describe('abuse-control: bounded rate limiting', () => {
  test('counts per key inside a window and resets after it', () => {
    const limiter = createRateLimiter({ limit: 3, windowMs: 1000 });
    const results = [0, 1, 2, 3].map(() => limiter.hit('k', 0).allowed);
    assert.deepEqual(results, [true, true, true, false]);
    assert.equal(limiter.hit('k', 999).allowed, false, 'still inside the window');
    assert.equal(limiter.hit('k', 1000).allowed, true, 'new window');
    assert.equal(limiter.hit('other', 0).allowed, true, 'keys are independent');
  });

  test('a refused hit reports how long until the window resets', () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 5000 });
    limiter.hit('k', 1000);
    const refused = limiter.hit('k', 3000);
    assert.equal(refused.allowed, false);
    assert.equal(refused.retryAfterMs, 3000);
  });

  test('limiter: memory is bounded under a key flood (100k distinct keys, capacity 1k)', () => {
    const limiter = createRateLimiter({ limit: 5, windowMs: 60_000, maxKeys: 1000, overflowLimit: 50 });
    let allowedDuringFlood = 0;
    for (let i = 0; i < 100_000; i += 1) {
      if (limiter.hit(`flood-${i}`, 0).allowed) allowedDuringFlood += 1;
    }
    const stats = limiter.stats();
    assert.equal(stats.size, 1000, 'the table never grows past maxKeys');
    assert.equal(stats.degraded, 99_000, 'every key past capacity went to the overflow bucket');
    // 1000 table keys each allowed once, plus the overflow bucket's own limit.
    assert.equal(allowedDuringFlood, 1000 + 50, 'the flood throttles itself instead of being served');
  });

  test('a flood does not reset the counter of a real account already in the table', () => {
    const limiter = createRateLimiter({ limit: 2, windowMs: 60_000, maxKeys: 10, overflowLimit: 5 });
    limiter.hit('victim', 0);
    limiter.hit('victim', 0);
    for (let i = 0; i < 1000; i += 1) limiter.hit(`noise-${i}`, 1);
    assert.equal(limiter.hit('victim', 2).allowed, false, 'victim is still limited: no eviction of live counters');
  });

  test('expired entries are reclaimed before degrading', () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 100, maxKeys: 2 });
    limiter.hit('a', 0);
    limiter.hit('b', 0);
    const fresh = limiter.hit('c', 500);
    assert.equal(fresh.degraded, false, 'an expired slot was reused');
    assert.equal(limiter.stats().reclaimed, 1);
    assert.equal(limiter.stats().size, 2);
  });

  test('keys are fixed-size HMAC digests, case/space-normalised, never the raw identifier', () => {
    const a = abuseKey('login-account', 'Alice@Example.COM ', 's1');
    const b = abuseKey('login-account', 'alice@example.com', 's1');
    assert.equal(a, b, 'case and whitespace variants share one budget');
    assert.equal(a.length, 22);
    assert.ok(!a.includes('alice'));
    assert.notEqual(a, abuseKey('login-account', 'alice@example.com', 's2'), 'unlinkable across instances');
    assert.notEqual(a, abuseKey('forgot-account', 'alice@example.com', 's1'), 'kinds are separated');
  });

  test('bad configuration is refused', () => {
    assert.throws(() => createRateLimiter({ limit: 0, windowMs: 1 }), TypeError);
    assert.throws(() => createRateLimiter({ limit: 1, windowMs: -5 }), TypeError);
  });

  test('the policy reproduces the upstream limits', () => {
    assert.deepEqual({ ...ABUSE_POLICY.loginIp }, { limit: 1000, windowMs: 300_000 });
    assert.deepEqual({ ...ABUSE_POLICY.loginAccount }, { limit: 5, windowMs: 60_000 });
    assert.deepEqual({ ...ABUSE_POLICY.forgotIp }, { limit: 20, windowMs: 300_000 });
    assert.equal(ABUSE_POLICY.forgotAccount.limit, 3);
    assert.equal(RATE_LIMIT_MESSAGE, 'Too many requests');
  });
});

describe('abuse-control: failure back-off', () => {
  test('locks after the threshold, doubles, caps, and clears on success', () => {
    const backoff = createFailureBackoff({ threshold: 3, baseMs: 1000, maxMs: 4000 });
    assert.equal(backoff.recordFailure('k', 0).lockedForMs, 0);
    assert.equal(backoff.recordFailure('k', 0).lockedForMs, 0);
    assert.equal(backoff.recordFailure('k', 0).lockedForMs, 1000);
    assert.equal(backoff.check('k', 500).locked, true);
    assert.equal(backoff.check('k', 1000).locked, false, 'self-expiring: never a permanent lockout');
    assert.equal(backoff.recordFailure('k', 1000).lockedForMs, 2000);
    assert.equal(backoff.recordFailure('k', 3000).lockedForMs, 4000);
    assert.equal(backoff.recordFailure('k', 7000).lockedForMs, 4000, 'capped at maxMs');
    backoff.recordSuccess('k');
    assert.equal(backoff.check('k', 7001).locked, false);
  });

  test('bounded: saturation stops tracking new keys instead of growing', () => {
    const backoff = createFailureBackoff({ maxKeys: 100 });
    for (let i = 0; i < 10_000; i += 1) backoff.recordFailure(`k${i}`, 0);
    assert.equal(backoff.stats().size, 100);
  });
});

describe('password-hash: compatibility and agility', () => {
  const legacyHash = (password) => {
    // Byte-for-byte the pre-P5.6 algorithm from src/auth.mjs.
    const salt = randomBytes(16).toString('hex');
    const hash = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex');
    return `scrypt$${salt}$${hash}`;
  };

  test('every pre-P5.6 hash still verifies — no forced reset', () => {
    const stored = legacyHash(PASSWORD);
    assert.equal(verifyPassword(PASSWORD, stored), true);
    assert.equal(verifyPassword('wrong', stored), false);
    assert.equal(needsRehash(stored), false, 'current policy equals the legacy parameters');
  });

  test('new hashes keep the legacy format while the policy is legacy (rollback safety)', () => {
    const stored = hashWithPolicy(PASSWORD);
    assert.match(stored, /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
    assert.deepEqual({ N: PASSWORD_HASH_POLICY.N, r: PASSWORD_HASH_POLICY.r, p: PASSWORD_HASH_POLICY.p }, { N: LEGACY_SCRYPT.N, r: LEGACY_SCRYPT.r, p: LEGACY_SCRYPT.p });
    // The exact verifier that shipped before P5.6 accepts it:
    const [, salt, hash] = stored.split('$');
    assert.equal(scryptSync(PASSWORD, salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex'), hash);
  });

  test('a stronger policy emits self-describing scrypt-v2 and flags legacy hashes for rehash', () => {
    const stronger = { ...PASSWORD_HASH_POLICY, N: 32768 };
    const upgraded = hashWithPolicy(PASSWORD, stronger);
    assert.match(upgraded, /^scrypt-v2\$32768\$8\$1\$64\$/);
    assert.equal(verifyPassword(PASSWORD, upgraded), true);
    assert.equal(needsRehash(legacyHash(PASSWORD), stronger), true);
    assert.equal(needsRehash(upgraded, stronger), false);
  });

  test('authenticate() rehashes on success only when needed and keeps the user logged in', () => {
    const store = createStore({ storage: 'memory' });
    const owner = createOwner(store, { email: 'r@x.io', password: PASSWORD });
    const before = store.users.get(owner.id).password;
    assert.equal(authenticate(store, 'r@x.io', PASSWORD).id, owner.id);
    assert.equal(store.users.get(owner.id).password, before, 'no rewrite under the current policy');
  });

  test('corrupt or hostile stored hashes verify false without running unbounded scrypt', () => {
    assert.equal(parsePasswordHash('scrypt-v2$1073741824$8$1$64$aa$bb'), null, 'N above bound');
    assert.equal(parsePasswordHash('scrypt-v2$1000$8$1$64$aa$bb'), null, 'N not a power of two');
    assert.equal(parsePasswordHash('bcrypt$whatever'), null);
    assert.equal(verifyPassword(PASSWORD, 'garbage'), false);
    assert.equal(verifyPassword('x'.repeat(5000), hashWithPolicy(PASSWORD)), false, 'oversized input refused');
    assert.equal(verifyPassword(undefined, hashWithPolicy(PASSWORD)), false);
  });

  test('the password policy returns the upstream messages', () => {
    assert.equal(passwordPolicyViolation('Abcdefg1'), null);
    assert.equal(passwordPolicyViolation('short1A'), 'Password must be 8 to 64 characters long.');
    assert.equal(passwordPolicyViolation('abcdefgh1'), 'Password must contain at least 1 uppercase letter.');
    assert.equal(
      passwordPolicyViolation('abcdefgh'),
      'Password must contain at least 1 number. Password must contain at least 1 uppercase letter.',
    );
    assert.equal(passwordPolicyViolation(`A1${'x'.repeat(63)}`), 'Password must be 8 to 64 characters long.');
  });

  test('unknown accounts spend the same scrypt cost as wrong passwords (no timing enumeration)', () => {
    const store = createStore({ storage: 'memory' });
    createOwner(store, { email: 't@x.io', password: PASSWORD });
    const time = (fn) => {
      const samples = [];
      for (let i = 0; i < 5; i += 1) {
        const start = process.hrtime.bigint();
        fn();
        samples.push(Number(process.hrtime.bigint() - start));
      }
      return samples.sort((a, b) => a - b)[2];
    };
    const known = time(() => authenticate(store, 't@x.io', 'Wrong-pass-1'));
    const unknown = time(() => authenticate(store, 'nobody@x.io', 'Wrong-pass-1'));
    assert.ok(unknown > known * 0.5, `unknown ${unknown}ns vs known ${known}ns: unknown must also run scrypt`);
  });
});

describe('reset-token: single use, bounded, fingerprint-bound', () => {
  const fp = (map) => (userId) => map.get(userId) ?? null;

  test('resolve does not consume; consume works exactly once (replay fails)', () => {
    const store = createResetTokenStore();
    const prints = new Map([['u1', 'F1']]);
    const { token } = store.issue({ userId: 'u1', fingerprint: 'F1' }, 0);
    assert.match(token, /^[A-Za-z0-9_-]{43}$/, '256-bit url-safe token');
    assert.equal(store.resolve(token, fp(prints), 1).verdict, RESET_TOKEN_VERDICT.OK);
    assert.equal(store.resolve(token, fp(prints), 2).verdict, RESET_TOKEN_VERDICT.OK, 'resolve is repeatable');
    assert.deepEqual(store.consume(token, fp(prints), 3), { verdict: 'OK', userId: 'u1' });
    assert.equal(store.consume(token, fp(prints), 4).verdict, RESET_TOKEN_VERDICT.UNKNOWN, 'replay finds nothing');
    assert.equal(store.resolve(token, fp(prints), 5).verdict, RESET_TOKEN_VERDICT.UNKNOWN);
  });

  test('bounded lifetime: default is the upstream 20 minutes; config cannot exceed 1 hour', () => {
    assert.equal(RESET_TOKEN_POLICY.ttlMs, 20 * 60_000);
    const store = createResetTokenStore();
    const { token, expiresAt } = store.issue({ userId: 'u', fingerprint: 'F' }, 1000);
    assert.equal(expiresAt, 1000 + 20 * 60_000);
    assert.equal(store.consume(token, () => 'F', expiresAt).verdict, RESET_TOKEN_VERDICT.EXPIRED);
    assert.throws(() => createResetTokenStore({ ttlMs: 2 * 60 * 60_000 }), TypeError);
  });

  test('a password or e-mail change invalidates outstanding tokens (stale fingerprint)', () => {
    const store = createResetTokenStore();
    const user = { id: 'u', email: 'a@x.io', password: 'scrypt$aa$bb' };
    const { token } = store.issue({ userId: 'u', fingerprint: credentialFingerprint(user, 's') }, 0);
    const changed = { ...user, password: 'scrypt$cc$dd' };
    assert.equal(store.consume(token, () => credentialFingerprint(changed, 's'), 1).verdict, RESET_TOKEN_VERDICT.STALE);
    assert.notEqual(credentialFingerprint(user, 's'), credentialFingerprint({ ...user, email: 'b@x.io' }, 's'));
    assert.notEqual(
      credentialFingerprint(user, 's'),
      credentialFingerprint({ ...user, mfa: { state: 'enabled', secret: { keyRef: 'k', iv: 'i' } } }, 's'),
    );
  });

  test('one live token per user: issuing again revokes the previous link', () => {
    const store = createResetTokenStore();
    const first = store.issue({ userId: 'u', fingerprint: 'F' }, 0).token;
    const second = store.issue({ userId: 'u', fingerprint: 'F' }, 1).token;
    assert.equal(store.resolve(first, () => 'F', 2).verdict, RESET_TOKEN_VERDICT.UNKNOWN);
    assert.equal(store.resolve(second, () => 'F', 2).verdict, RESET_TOKEN_VERDICT.OK);
    assert.equal(store.size(), 1);
  });

  test('bounded memory: the table never exceeds maxTokens', () => {
    const store = createResetTokenStore({ maxTokens: 50 });
    for (let i = 0; i < 5000; i += 1) store.issue({ userId: `u${i}`, fingerprint: 'F' }, i);
    assert.equal(store.size(), 50);
  });

  test('malformed, unknown and deleted-user tokens are all refused', () => {
    const store = createResetTokenStore();
    assert.equal(store.resolve('short', () => 'F').verdict, RESET_TOKEN_VERDICT.MALFORMED);
    assert.equal(store.resolve(undefined, () => 'F').verdict, RESET_TOKEN_VERDICT.MALFORMED);
    assert.equal(store.resolve('A'.repeat(43), () => 'F').verdict, RESET_TOKEN_VERDICT.UNKNOWN);
    const { token } = store.issue({ userId: 'gone', fingerprint: 'F' });
    assert.equal(store.consume(token, () => null).verdict, RESET_TOKEN_VERDICT.STALE);
  });
});

describe('mfa: TOTP, recovery codes, state machine', () => {
  test('RFC 6238 SHA-1 test vectors (6-digit truncation)', () => {
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    const vectors = [
      [59, '287082'],
      [1111111109, '081804'],
      [1111111111, '050471'],
      [1234567890, '005924'],
      [2000000000, '279037'],
      [20000000000, '353130'],
    ];
    for (const [seconds, code] of vectors) assert.equal(totpAt(secret, seconds * 1000), code, `t=${seconds}`);
  });

  test('secrets match the otpauth defaults upstream uses; URI layout matches OTPAuth', () => {
    const secret = generateTotpSecret();
    assert.match(secret, /^[A-Z2-7]{32}$/, '20 bytes, base32, no padding');
    assert.equal(base32Decode(secret).length, 20);
    assert.equal(
      totpUri({ secret: 'JBSWY3DPEHPK3PXP', label: 'a@b.io' }),
      'otpauth://totp/n8n:a%40b.io?issuer=n8n&secret=JBSWY3DPEHPK3PXP&algorithm=SHA1&digits=6&period=30',
    );
    assert.deepEqual([...base32Decode('jbsw y3dp ehpk 3pxp==')], [...base32Decode('JBSWY3DPEHPK3PXP')], 'tolerant decode');
    assert.throws(() => base32Decode('JBSW!'), TypeError);
  });

  test('window: ±2 steps by default, ±10 at enrolment, nothing beyond', () => {
    const secret = generateTotpSecret();
    const now = 1_700_000_000_000;
    const at = (steps) => totpAt(secret, now + steps * 30_000);
    assert.equal(verifyTotp(secret, at(-2), { now }).ok, true);
    assert.equal(verifyTotp(secret, at(2), { now }).ok, true);
    assert.equal(verifyTotp(secret, at(3), { now }).ok, false);
    assert.equal(verifyTotp(secret, at(10), { now, window: TOTP_WINDOW.enrolment }).ok, true);
    assert.equal(verifyTotp(secret, at(11), { now, window: TOTP_WINDOW.enrolment }).ok, false);
    assert.throws(() => verifyTotp(secret, at(0), { now, window: 11 }), TypeError);
  });

  test('replay: a code for the last used step (or earlier) is refused', () => {
    const secret = generateTotpSecret();
    const now = 1_700_000_000_000;
    const first = verifyTotp(secret, totpAt(secret, now), { now });
    assert.equal(first.ok, true);
    const again = verifyTotp(secret, totpAt(secret, now), { now, lastUsedStep: first.step });
    assert.deepEqual([again.ok, again.reason], [false, 'replay']);
    const older = verifyTotp(secret, totpAt(secret, now - 30_000), { now, lastUsedStep: first.step });
    assert.equal(older.ok, false);
    const next = verifyTotp(secret, totpAt(secret, now + 30_000), { now, lastUsedStep: first.step });
    assert.equal(next.ok, true, 'the next step is fine');
    assert.equal(first.step, timeStep(now));
  });

  test('malformed codes never match', () => {
    const secret = generateTotpSecret();
    for (const bad of ['', '12345', '1234567', 'abcdef', null, undefined, {}, '12 34 5']) {
      assert.equal(verifyTotp(secret, bad).ok, false, JSON.stringify(bad));
    }
  });

  test('mfa: a recovery code works once', () => {
    const codes = generateRecoveryCodes();
    assert.equal(codes.length, 10);
    for (const code of codes) assert.match(code, /^[0-9a-f-]{36}$/, 'v4 UUIDs like upstream');
    const digests = codes.map(hashRecoveryCode);
    const used = consumeRecoveryCode(digests, codes[3]);
    assert.equal(used.ok, true);
    assert.equal(used.remaining.length, 9);
    const replay = consumeRecoveryCode(used.remaining, codes[3]);
    assert.equal(replay.ok, false, 'replay fails');
    assert.equal(consumeRecoveryCode(used.remaining, ` ${codes[4].toUpperCase()} `).ok, true, 'normalised');
    assert.equal(consumeRecoveryCode(digests, 'not-a-code').ok, false);
    assert.equal(consumeRecoveryCode(digests, 'x'.repeat(500)).ok, false);
  });

  test('state machine: only the declared transitions exist', () => {
    const { DISABLED, PENDING, ENABLED } = MFA_STATES;
    assert.equal(mfaTransition(DISABLED, MFA_EVENTS.SETUP), PENDING);
    assert.equal(mfaTransition(PENDING, MFA_EVENTS.SETUP), PENDING);
    assert.equal(mfaTransition(PENDING, MFA_EVENTS.ENABLE), ENABLED);
    assert.equal(mfaTransition(PENDING, MFA_EVENTS.DISABLE), DISABLED);
    assert.equal(mfaTransition(ENABLED, MFA_EVENTS.DISABLE), DISABLED);
    for (const [state, event] of [
      [DISABLED, MFA_EVENTS.ENABLE],
      [DISABLED, MFA_EVENTS.DISABLE],
      [ENABLED, MFA_EVENTS.SETUP],
      [ENABLED, MFA_EVENTS.ENABLE],
      ['bogus', MFA_EVENTS.SETUP],
    ]) {
      assert.throws(() => mfaTransition(state, event), (e) => e.details?.reason === 'invalid-transition', `${state} -${event}->`);
    }
    assert.equal(mfaStateOf({}), DISABLED);
    assert.equal(mfaStateOf({ mfa: { state: 'weird' } }), DISABLED);
  });

  test('the MFA view exposes vault records and writes back only the envelope', () => {
    const store = createStore({ storage: 'memory' });
    const user = store.users.insert({ id: 'u1', email: 'v@x.io', mfa: { state: 'enabled', secret: { keyRef: 'old' }, recoveryCodes: ['d1'] } });
    store.users.insert({ id: 'u2', email: 'w@x.io' });
    const view = mfaSecretCollection(store.users);
    assert.deepEqual(view.all(), [{ id: 'user:u1', tenantId: 'default', type: MFA_SECRET_TYPE, secret: { keyRef: 'old' } }]);
    view.update('user:u1', (record) => ({ ...record, secret: { keyRef: 'new' }, email: 'hijack@x.io' }));
    const after = store.users.get(user.id);
    assert.deepEqual(after.mfa, { state: 'enabled', secret: { keyRef: 'new' }, recoveryCodes: ['d1'] });
    assert.equal(after.email, 'v@x.io', 'nothing but the envelope is writable through the view');
    assert.equal(view.update('u1', (r) => r), null, 'ids outside the view are refused');
  });
});

describe('step-up: declared auth strength', () => {
  test('every sensitive operation declares its bar', () => {
    assert.deepEqual(Object.keys(STEP_UP_REQUIREMENTS).sort(), [
      'account.email.change',
      'account.mfa.disable',
      'account.mfa.enable',
      'account.mfa.setup',
      'account.password.change',
      'account.password.reset',
    ]);
  });

  test('missing proof is refused; the right proof raises the request to step-up', () => {
    const denied = evaluateStepUp('account.password.change', { sessionStrength: 'password', enrolled: false, proofs: [] });
    assert.deepEqual([denied.ok, denied.reason, denied.missing], [false, 'proof-missing', [PROOF.CURRENT_PASSWORD]]);
    const ok = evaluateStepUp('account.password.change', { sessionStrength: 'password', enrolled: false, proofs: [PROOF.CURRENT_PASSWORD] });
    assert.deepEqual([ok.ok, ok.strength], [true, 'step-up']);
  });

  test('when MFA is enrolled the bar rises: password alone is not enough', () => {
    const noTotp = evaluateStepUp('account.password.change', { sessionStrength: 'mfa', enrolled: true, proofs: [PROOF.CURRENT_PASSWORD] });
    assert.equal(noTotp.ok, false);
    assert.deepEqual(requiredProofs('account.password.change', { enrolled: true }), [[PROOF.CURRENT_PASSWORD, PROOF.TOTP]]);
    const weakSession = evaluateStepUp('account.password.change', {
      sessionStrength: 'password',
      enrolled: true,
      proofs: [PROOF.CURRENT_PASSWORD, PROOF.TOTP],
    });
    assert.deepEqual([weakSession.ok, weakSession.reason], [false, 'session-too-weak'], 'a password-only session of an enrolled user cannot step up');
  });

  test('alternatives: MFA disable accepts a TOTP or a recovery code', () => {
    for (const proof of [PROOF.TOTP, PROOF.RECOVERY_CODE]) {
      assert.equal(evaluateStepUp('account.mfa.disable', { sessionStrength: 'mfa', enrolled: true, proofs: [proof] }).ok, true);
    }
    assert.equal(evaluateStepUp('account.mfa.disable', { sessionStrength: 'mfa', enrolled: true, proofs: [PROOF.CURRENT_PASSWORD] }).ok, false);
  });

  test('API keys, service principals and agents can never perform account-security operations', () => {
    for (const principalType of ['api-key', 'service', 'agent']) {
      const verdict = evaluateStepUp('account.password.change', {
        sessionStrength: 'password',
        principalType,
        enrolled: false,
        proofs: [PROOF.CURRENT_PASSWORD],
      });
      assert.deepEqual([verdict.ok, verdict.reason], [false, 'interactive-session-required'], principalType);
    }
    assert.equal(evaluateStepUp('account.mfa.setup', { sessionStrength: 'api-key', enrolled: false }).ok, false);
  });

  test('an undeclared operation fails closed', () => {
    assert.deepEqual(evaluateStepUp('account.delete', { sessionStrength: 'step-up', enrolled: false }).reason, 'undeclared-operation');
  });

  test('sessions carry password|mfa only; rotation keeps strength and auth time (never raises it)', () => {
    const store = createSessionStore();
    const s = createSessionRecord(store, { userId: 'u', authStrength: 'mfa', now: 1000 });
    assert.deepEqual([s.authStrength, s.authTime], ['mfa', 1000]);
    const rotated = rotateSession(store, s.sessionId, { now: 5000 });
    assert.deepEqual([rotated.authStrength, rotated.authTime], ['mfa', 1000]);
    assert.throws(() => createSessionRecord(store, { userId: 'u', authStrength: 'step-up' }), /password or mfa/);
    assert.equal(createSessionRecord(store, { userId: 'u' }).authStrength, 'password', 'default is password');
  });
});

describe('vault: MFA secrets share the credential key lineage', () => {
  test('rotation re-encrypts MFA secrets with the credentials; nothing is stranded on retire', () => {
    const store = createStore({ storage: 'memory' });
    const provider = createMemoryKeyProvider();
    const vault = createCredentialVault({ provider });
    const user = store.users.insert({ id: 'u1', email: 'k@x.io' });
    const sealed = vault.sealSecret(mfaSecretRecord(user), { totp: 'JBSWY3DPEHPK3PXP' });
    store.users.update('u1', { mfa: { state: 'enabled', secret: sealed, recoveryCodes: [] } });
    store.credentials.insert({ id: 'c1', type: 'httpHeaderAuth', ...vault.sealData({ id: 'c1', type: 'httpHeaderAuth' }, { value: 'v' }) });
    const before = provider.currentKeyRef();
    const view = mfaSecretCollection(store.users);
    const result = vault.rotate([store.credentials, view]);
    assert.equal(result.retired, before);
    const after = store.users.get('u1');
    assert.equal(after.mfa.secret.keyRef, provider.currentKeyRef());
    assert.deepEqual(vault.open(mfaSecretRecord(after)), { totp: 'JBSWY3DPEHPK3PXP' });
    assert.deepEqual(vault.verify([store.credentials, view]).unreadable, []);
  });

  test('retiring is refused while an MFA secret still sits on the previous key', () => {
    const store = createStore({ storage: 'memory' });
    const provider = createMemoryKeyProvider();
    const vault = createCredentialVault({ provider });
    const user = store.users.insert({ id: 'u1', email: 'k@x.io' });
    store.users.update('u1', { mfa: { state: 'enabled', secret: vault.sealSecret(mfaSecretRecord(user), { totp: 'X' }) } });
    const previous = provider.currentKeyRef();
    vault.startRotation();
    const sets = [store.credentials, mfaSecretCollection(store.users)];
    assert.throws(() => vault.finishRotation(sets), (e) => e.details?.reason === 'rotation-incomplete');
    assert.ok(provider.readableKeyRefs().includes(previous), 'the previous key was NOT retired');
    // Completing the step over both sets moves the MFA secret; then retiring is allowed.
    assert.equal(vault.stepRotation(sets).moved, 1);
    assert.equal(vault.finishRotation(sets).retired, previous);
    assert.deepEqual(vault.open(mfaSecretRecord(store.users.get('u1'))), { totp: 'X' });
  });

  test('the MFA secret envelope is AAD-bound to its user: moving it to another user fails', () => {
    const vault = createCredentialVault({ provider: createMemoryKeyProvider() });
    const alice = { id: 'alice', email: 'a@x.io' };
    const envelope = vault.sealSecret(mfaSecretRecord(alice), { totp: 'SECRET' });
    assert.throws(() => vault.open(mfaSecretRecord({ id: 'mallory', mfa: { secret: envelope } })));
    assert.deepEqual(vault.open(mfaSecretRecord({ ...alice, mfa: { secret: envelope } })), { totp: 'SECRET' });
  });

  test('boot never mints a fresh key over sealed MFA secrets (keyring missing => fail closed)', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'p56-boot-'));
    try {
      const store = createStore({ storage: 'memory' });
      store.users.insert({ id: 'u1', email: 'z@x.io', mfa: { state: 'enabled', secret: { cryptoVersion: 1, alg: 'x', keyRef: 'k', iv: 'i', ct: 'c', tag: 't' } } });
      const booted = await bootCredentialVault({ config: { storage: 'file', dataDir }, store, secretFieldsFor: () => null });
      assert.equal(booted.vault, null, 'no vault: MFA and secrets fail closed');
      assert.ok(booted.error);
      assert.deepEqual(readdirSync(dataDir), [], 'no keyring was minted');
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

/* ======================================================================= 2 */
/*                     ROUTE HANDLERS BEHIND AN HTTP HARNESS                 */
/* ======================================================================= */

/**
 * The real `authRoutes` handlers, real `sendData`/`sendError`, real sessions,
 * over a real socket — minus only the CSRF gate (covered by the real-server
 * block below and by the P5.2 suite). Lets tests inject a delivery port and
 * limiter state, which the production composition root does not expose.
 */
async function harness({ delivery = null, vault = createCredentialVault({ provider: createMemoryKeyProvider() }), security = createAccountSecurity() } = {}) {
  const logs = [];
  const logger = {
    info: (m, d) => logs.push(JSON.stringify([m, d])),
    warn: (m, d) => logs.push(JSON.stringify([m, d])),
    error: (m, d) => logs.push(JSON.stringify([m, d])),
    debug: () => {},
  };
  const config = {
    secret: randomBytes(16).toString('hex'),
    protocol: 'http',
    port: 0,
    publicUrl: 'http://127.0.0.1',
    storage: 'memory',
    catalogDir: process.env.N8N_LEGO_CATALOG_DIR ?? REPO_CATALOG,
  };
  const store = createStore({ storage: 'memory' });
  const routes = authRoutes({ logger, vault, delivery, security });
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://h');
    const route = routes.find((r) => (Array.isArray(r.method) ? r.method.includes(req.method) : r.method === req.method) && r.path === url.pathname);
    const ctx = { req, res, config, logger, store, method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), params: {}, body: undefined, user: null };
    try {
      ctx.user = currentUser(store, config, req);
      if (!route) throw new HttpError(404, 'Not found');
      if (!route.public && !ctx.user) throw new HttpError(401, 'Unauthorized');
      if (['POST', 'PATCH'].includes(req.method)) ctx.body = await readBody(req, { limit: 1e6 });
      await route.handler(ctx);
    } catch (error) {
      sendError(res, error);
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  config.publicUrl = base;
  return { base, store, config, security, vault, logs, close: () => new Promise((r) => server.close(r)) };
}

/** A browser: keeps its own n8n-auth cookie. */
function browser(base) {
  let cookie = '';
  return {
    get cookie() {
      return cookie;
    },
    async call(method, path, body) {
      const res = await fetch(base + path, {
        method,
        headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      for (const c of res.headers.getSetCookie()) if (c.startsWith('n8n-auth=')) cookie = c.split(';')[0];
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null, raw: text };
    },
  };
}

function seedUser(h, { email = 'owner@p56.test', password = PASSWORD } = {}) {
  return createOwner(h.store, { email, firstName: 'Ada', lastName: 'L', password });
}

async function loggedIn(h, email = 'owner@p56.test', extra = {}) {
  const b = browser(h.base);
  const r = await b.call('POST', '/rest/login', { emailOrLdapLoginId: email, password: PASSWORD, ...extra });
  assert.equal(r.status, 200, r.raw);
  return b;
}

async function enrol(h, b) {
  const qr = await b.call('GET', '/rest/mfa/qr');
  assert.equal(qr.status, 200, qr.raw);
  const { secret, recoveryCodes } = qr.body.data;
  const code = totpAt(secret);
  assert.equal((await b.call('POST', '/rest/mfa/enable', { mfaCode: code })).status, 200);
  return { secret, recoveryCodes, usedAt: Date.now() };
}

describe('forgot-password: enumeration resistance', () => {
  test('without a delivery port it is the upstream no-SMTP 500 — identical for every address', async () => {
    const h = await harness();
    try {
      seedUser(h);
      const known = await browser(h.base).call('POST', '/rest/forgot-password', { email: 'owner@p56.test' });
      const unknown = await browser(h.base).call('POST', '/rest/forgot-password', { email: 'ghost@p56.test' });
      assert.equal(known.status, 500);
      assert.equal(known.body.message, 'Email sending must be set up in order to request a password reset email');
      assert.deepEqual([unknown.status, unknown.raw], [known.status, known.raw]);
    } finally {
      await h.close();
    }
  });

  test('forgot-password: identical answers for existing and unknown accounts; delivery never awaited', async () => {
    const sent = [];
    let release;
    const gate = new Promise((r) => (release = r));
    const h = await harness({ delivery: { passwordReset: async (input) => { sent.push(input); await gate; } } });
    try {
      seedUser(h);
      const t0 = Date.now();
      const known = await browser(h.base).call('POST', '/rest/forgot-password', { email: 'OWNER@p56.test' });
      const elapsed = Date.now() - t0;
      const unknown = await browser(h.base).call('POST', '/rest/forgot-password', { email: 'ghost@p56.test' });
      assert.deepEqual([known.status, known.raw], [200, '{}']);
      assert.deepEqual([unknown.status, unknown.raw], [known.status, known.raw], 'same status, same body');
      assert.ok(elapsed < 1000, 'the response did not wait for delivery (which is still blocked)');
      assert.equal(sent.length, 1, 'only the real account got a link');
      assert.match(sent[0].passwordResetUrl, new RegExp(`^${h.base}/change-password\\?token=[A-Za-z0-9_-]{43}&mfaEnabled=false$`));
      release();
      assert.ok(!h.logs.join('\n').includes(new URL(sent[0].passwordResetUrl).searchParams.get('token')), 'the token is never logged');
    } finally {
      await h.close();
    }
  });

  test('per-address limit (3) applies the same to unknown addresses; invalid input is 400', async () => {
    const h = await harness({ delivery: { passwordReset: async () => {} } });
    try {
      seedUser(h);
      for (const email of ['owner@p56.test', 'ghost@p56.test']) {
        const statuses = [];
        for (let i = 0; i < 4; i += 1) statuses.push((await browser(h.base).call('POST', '/rest/forgot-password', { email })).status);
        assert.deepEqual(statuses, [200, 200, 200, 429], email);
      }
      assert.equal((await browser(h.base).call('POST', '/rest/forgot-password', { email: 'nope' })).status, 400);
    } finally {
      await h.close();
    }
  });
});

describe('reset: token lifecycle over HTTP', () => {
  async function requestLink(h, email = 'owner@p56.test') {
    const sent = h.sent;
    await browser(h.base).call('POST', '/rest/forgot-password', { email });
    await sleep(5);
    return new URL(sent.at(-1).passwordResetUrl).searchParams.get('token');
  }
  async function resetHarness(options = {}) {
    const sent = [];
    const h = await harness({ delivery: { passwordReset: async (i) => sent.push(i) }, ...options });
    h.sent = sent;
    return h;
  }

  test('reset: single use — replaying the token fails with the same 404', async () => {
    const h = await resetHarness();
    try {
      seedUser(h);
      const token = await requestLink(h);
      assert.equal((await browser(h.base).call('GET', `/rest/resolve-password-token?token=${token}`)).status, 200);
      const done = await browser(h.base).call('POST', '/rest/change-password', { token, password: 'Brand-New-Pass-1' });
      assert.equal(done.status, 200, done.raw);
      const replay = await browser(h.base).call('POST', '/rest/change-password', { token, password: 'Another-Pass-2' });
      assert.deepEqual([replay.status, replay.body.message], [404, '']);
      assert.equal((await browser(h.base).call('GET', `/rest/resolve-password-token?token=${token}`)).status, 404);
    } finally {
      await h.close();
    }
  });

  test('reset: kills every existing session, issues one new session, swaps the password', async () => {
    const h = await resetHarness();
    try {
      seedUser(h);
      const laptop = await loggedIn(h);
      const phone = await loggedIn(h);
      assert.equal((await laptop.call('GET', '/rest/login')).status, 200);
      const token = await requestLink(h);
      const resetter = browser(h.base);
      assert.equal((await resetter.call('POST', '/rest/change-password', { token, password: 'Brand-New-Pass-1' })).status, 200);
      assert.equal((await laptop.call('GET', '/rest/login')).status, 401, 'old session revoked');
      assert.equal((await phone.call('GET', '/rest/login')).status, 401, 'old session revoked');
      assert.equal((await resetter.call('GET', '/rest/login')).status, 200, 'the resetting browser got a fresh session');
      const oldPw = await browser(h.base).call('POST', '/rest/login', { emailOrLdapLoginId: 'owner@p56.test', password: PASSWORD });
      assert.equal(oldPw.status, 401);
      const newPw = await browser(h.base).call('POST', '/rest/login', { emailOrLdapLoginId: 'owner@p56.test', password: 'Brand-New-Pass-1' });
      assert.equal(newPw.status, 200);
    } finally {
      await h.close();
    }
  });

  test('a link dies when the password changes through another path, and when it expires', async () => {
    const h = await resetHarness({ security: createAccountSecurity({ resetTtlMs: 150 }) });
    try {
      seedUser(h);
      const token = await requestLink(h);
      const b = await loggedIn(h);
      assert.equal((await b.call('PATCH', '/rest/me/password', { currentPassword: PASSWORD, newPassword: 'Changed-Pass-1' })).status, 200);
      assert.equal((await browser(h.base).call('POST', '/rest/change-password', { token, password: 'Brand-New-Pass-1' })).status, 404);
    } finally {
      await h.close();
    }
    const h2 = await resetHarness({ security: createAccountSecurity({ resetTtlMs: 150 }) });
    try {
      seedUser(h2);
      const token = await requestLink(h2);
      await sleep(200);
      assert.equal((await browser(h2.base).call('GET', `/rest/resolve-password-token?token=${token}`)).status, 404, 'expired');
    } finally {
      await h2.close();
    }
  });

  test('with MFA enrolled: a missing code is 400 and does NOT burn the link; a valid code completes', async () => {
    const h = await resetHarness();
    try {
      seedUser(h);
      const { secret } = await enrol(h, await loggedIn(h));
      const token = await requestLink(h);
      assert.match(h.sent.at(-1).passwordResetUrl, /mfaEnabled=true$/);
      const noCode = await browser(h.base).call('POST', '/rest/change-password', { token, password: 'Brand-New-Pass-1' });
      assert.deepEqual([noCode.status, noCode.body.message], [400, 'If MFA enabled, mfaCode is required.']);
      const badCode = await browser(h.base).call('POST', '/rest/change-password', { token, password: 'Brand-New-Pass-1', mfaCode: '000000' });
      assert.deepEqual([badCode.status, badCode.body.message], [400, 'Invalid MFA token.']);
      const ok = await browser(h.base).call('POST', '/rest/change-password', {
        token,
        password: 'Brand-New-Pass-1',
        mfaCode: totpAt(secret, Date.now() + 30_000),
      });
      assert.equal(ok.status, 200, ok.raw);
    } finally {
      await h.close();
    }
  });

  test('weak new passwords are refused before the token is touched', async () => {
    const h = await resetHarness();
    try {
      seedUser(h);
      const token = await requestLink(h);
      const weak = await browser(h.base).call('POST', '/rest/change-password', { token, password: 'weak' });
      assert.equal(weak.status, 400);
      assert.equal((await browser(h.base).call('GET', `/rest/resolve-password-token?token=${token}`)).status, 200, 'still valid');
    } finally {
      await h.close();
    }
  });
});

describe('login: abuse controls and second factor', () => {
  test('per-account limit (5/min) counts case variants together and returns the upstream 429', async () => {
    const h = await harness();
    try {
      seedUser(h);
      const statuses = [];
      for (const email of ['owner@p56.test', 'OWNER@p56.test', ' owner@p56.test', 'Owner@P56.test', 'owner@p56.test', 'owner@p56.test']) {
        const r = await browser(h.base).call('POST', '/rest/login', { emailOrLdapLoginId: email, password: 'Wrong-pass-1' });
        statuses.push(r.status);
        if (r.status === 429) assert.equal(r.body.message, 'Too many requests');
      }
      assert.deepEqual(statuses, [401, 401, 401, 401, 401, 429]);
    } finally {
      await h.close();
    }
  });

  test('failure back-off locks even the right password until it expires (unknown accounts alike)', async () => {
    const security = createAccountSecurity();
    security.limits.loginAccount = createRateLimiter({ limit: 1000, windowMs: 60_000 });
    const h = await harness({ security });
    try {
      seedUser(h);
      for (let i = 0; i < 5; i += 1) {
        await browser(h.base).call('POST', '/rest/login', { emailOrLdapLoginId: 'owner@p56.test', password: 'Wrong-pass-1' });
        await browser(h.base).call('POST', '/rest/login', { emailOrLdapLoginId: 'ghost@p56.test', password: 'Wrong-pass-1' });
      }
      const right = await browser(h.base).call('POST', '/rest/login', { emailOrLdapLoginId: 'owner@p56.test', password: PASSWORD });
      assert.equal(right.status, 429, 'locked out for the back-off period');
      const ghost = await browser(h.base).call('POST', '/rest/login', { emailOrLdapLoginId: 'ghost@p56.test', password: 'x' });
      assert.equal(ghost.status, 429, 'the same answer for an account that does not exist');
    } finally {
      await h.close();
    }
  });

  test('MFA-enrolled login: 998 without a code, a valid TOTP logs in, the same code cannot be replayed', async () => {
    const h = await harness();
    try {
      seedUser(h);
      const { secret } = await enrol(h, await loggedIn(h));
      const noCode = await browser(h.base).call('POST', '/rest/login', { emailOrLdapLoginId: 'owner@p56.test', password: PASSWORD });
      assert.deepEqual([noCode.status, noCode.body.code, noCode.body.message], [401, MFA_REQUIRED_CODE, 'MFA Error']);
      const code = totpAt(secret, Date.now() + 30_000);
      const b = browser(h.base);
      const ok = await b.call('POST', '/rest/login', { emailOrLdapLoginId: 'owner@p56.test', password: PASSWORD, mfaCode: code });
      assert.equal(ok.status, 200, ok.raw);
      assert.equal(ok.body.data.mfaEnabled, true);
      assert.equal(ok.body.data.mfaAuthenticated, true);
      assert.equal((await b.call('GET', '/rest/login')).body.data.mfaAuthenticated, true);
      const replay = await browser(h.base).call('POST', '/rest/login', { emailOrLdapLoginId: 'owner@p56.test', password: PASSWORD, mfaCode: code });
      assert.deepEqual([replay.status, replay.body.message], [401, 'Invalid mfa token or recovery code']);
    } finally {
      await h.close();
    }
  });

  test('mfa: a recovery code logs in exactly once', async () => {
    const h = await harness();
    try {
      seedUser(h);
      const { recoveryCodes } = await enrol(h, await loggedIn(h));
      const first = await browser(h.base).call('POST', '/rest/login', { emailOrLdapLoginId: 'owner@p56.test', password: PASSWORD, mfaRecoveryCode: recoveryCodes[0] });
      assert.equal(first.status, 200);
      const replay = await browser(h.base).call('POST', '/rest/login', { emailOrLdapLoginId: 'owner@p56.test', password: PASSWORD, mfaRecoveryCode: recoveryCodes[0] });
      assert.equal(replay.status, 401, 'recovery-code replay fails');
      const user = h.store.users.find((u) => u.email === 'owner@p56.test');
      assert.equal(user.mfa.recoveryCodes.length, 9);
    } finally {
      await h.close();
    }
  });

  test('without a vault an enrolled user cannot log in (503, fail closed); others are unaffected', async () => {
    const h = await harness();
    try {
      seedUser(h);
      await enrol(h, await loggedIn(h));
      seedUser(h, { email: 'plain@p56.test' });
      const offline = await harness({ vault: null });
      try {
        for (const u of h.store.users.all()) offline.store.users.insert(u);
        offline.config.secret = h.config.secret;
        const mfaUser = await browser(offline.base).call('POST', '/rest/login', { emailOrLdapLoginId: 'owner@p56.test', password: PASSWORD, mfaCode: '123456' });
        assert.equal(mfaUser.status, 503);
        const plain = await browser(offline.base).call('POST', '/rest/login', { emailOrLdapLoginId: 'plain@p56.test', password: PASSWORD });
        assert.equal(plain.status, 200);
        const b = await loggedIn(offline, 'plain@p56.test');
        assert.equal((await b.call('GET', '/rest/mfa/qr')).status, 503, 'no enrolment without the vault — no plaintext fallback');
      } finally {
        await offline.close();
      }
    } finally {
      await h.close();
    }
  });
});

describe('mfa: enrolment and disable over HTTP', () => {
  test('qr is stable while pending; verify does not consume the code that enable then uses', async () => {
    const h = await harness();
    try {
      seedUser(h);
      const b = await loggedIn(h);
      const first = await b.call('GET', '/rest/mfa/qr');
      const second = await b.call('GET', '/rest/mfa/qr');
      assert.deepEqual(second.body.data, first.body.data, 'same secret and codes until enabled (upstream)');
      assert.equal(first.body.data.qrCode, totpUri({ secret: first.body.data.secret, label: 'owner@p56.test' }));
      const code = totpAt(first.body.data.secret);
      assert.equal((await b.call('POST', '/rest/mfa/verify', { mfaCode: code })).status, 200);
      assert.equal((await b.call('POST', '/rest/mfa/enable', { mfaCode: code })).status, 200, 'the editor sends the same code twice');
      assert.equal((await b.call('GET', '/rest/login')).body.data.mfaEnabled, true);
      const again = await b.call('GET', '/rest/mfa/qr');
      assert.deepEqual([again.status, again.body.message], [400, 'MFA already enabled. Disable it to generate new secret and recovery codes']);
    } finally {
      await h.close();
    }
  });

  test('enabling kills other sessions; the enabling browser gets an mfa-strength session', async () => {
    const h = await harness();
    try {
      seedUser(h);
      const other = await loggedIn(h);
      const b = await loggedIn(h);
      await enrol(h, b);
      assert.equal((await other.call('GET', '/rest/login')).status, 401, 'password-only session of an enrolled user is gone');
      const me = await b.call('GET', '/rest/login');
      assert.deepEqual([me.status, me.body.data.mfaAuthenticated], [200, true]);
    } finally {
      await h.close();
    }
  });

  test('upstream error contract: missing code, wrong code (997), no secret, both codes', async () => {
    const h = await harness();
    try {
      seedUser(h);
      const b = await loggedIn(h);
      assert.deepEqual((await b.call('POST', '/rest/mfa/enable', {})).body.message, 'Token is required to enable MFA feature');
      assert.deepEqual((await b.call('POST', '/rest/mfa/enable', { mfaCode: '123456' })).body.message, 'Cannot enable MFA without generating secret and recovery codes');
      const { secret } = (await b.call('GET', '/rest/mfa/qr')).body.data;
      const wrong = totpAt(secret, Date.now() + 20 * 30_000);
      const bad = await b.call('POST', '/rest/mfa/enable', { mfaCode: wrong });
      assert.deepEqual([bad.status, bad.body.code], [400, MFA_EXPIRED_CODE]);
      const both = await b.call('POST', '/rest/mfa/disable', { mfaCode: '1', mfaRecoveryCode: '2' });
      assert.deepEqual([both.status, both.body.message], [400, 'Either MFA code or recovery code is required to disable MFA feature']);
      assert.equal((await b.call('POST', '/rest/mfa/verify', {})).body.message, 'MFA code is required to enable MFA feature');
      assert.equal((await b.call('POST', '/rest/mfa/can-enable')).status, 200);
    } finally {
      await h.close();
    }
  });

  test('disable: wrong code 403, recovery code works once, sessions reissued at password strength', async () => {
    const h = await harness();
    try {
      seedUser(h);
      const b = await loggedIn(h);
      const { recoveryCodes } = await enrol(h, b);
      const wrong = await b.call('POST', '/rest/mfa/disable', { mfaCode: '000000' });
      assert.deepEqual([wrong.status, wrong.body.message], [403, 'Invalid two-factor code.']);
      const badRecovery = await b.call('POST', '/rest/mfa/disable', { mfaRecoveryCode: 'nope' });
      assert.deepEqual([badRecovery.status, badRecovery.body.message], [403, 'Invalid MFA recovery code']);
      assert.equal((await b.call('POST', '/rest/mfa/disable', { mfaRecoveryCode: recoveryCodes[1] })).status, 200);
      const me = await b.call('GET', '/rest/login');
      assert.deepEqual([me.body.data.mfaEnabled, me.body.data.mfaAuthenticated], [false, false]);
      const stored = h.store.users.find((u) => u.email === 'owner@p56.test');
      assert.deepEqual(stored.mfa, { state: 'disabled' }, 'secret and digests are gone');
      const login = await browser(h.base).call('POST', '/rest/login', { emailOrLdapLoginId: 'owner@p56.test', password: PASSWORD });
      assert.equal(login.status, 200, 'no second factor needed any more');
    } finally {
      await h.close();
    }
  });
});

describe('password change and e-mail change: step-up over HTTP', () => {
  test('password change: upstream errors, then success revokes other sessions and keeps the caller', async () => {
    const h = await harness();
    try {
      seedUser(h);
      const other = await loggedIn(h);
      const b = await loggedIn(h);
      const wrong = await b.call('PATCH', '/rest/me/password', { currentPassword: 'nope', newPassword: 'Changed-Pass-1' });
      assert.deepEqual([wrong.status, wrong.body.message], [400, 'Provided current password is incorrect.']);
      const weak = await b.call('PATCH', '/rest/me/password', { currentPassword: PASSWORD, newPassword: 'weakpass' });
      assert.equal(weak.status, 400);
      const ok = await b.call('PATCH', '/rest/me/password', { currentPassword: PASSWORD, newPassword: 'Changed-Pass-1' });
      assert.deepEqual([ok.status, ok.body.data], [200, { success: true }]);
      assert.equal((await other.call('GET', '/rest/login')).status, 401, 'other sessions revoked');
      assert.equal((await b.call('GET', '/rest/login')).status, 200, 'caller keeps a fresh session');
    } finally {
      await h.close();
    }
  });

  test('password change with MFA requires a TOTP (400 missing, 403 wrong)', async () => {
    const h = await harness();
    try {
      seedUser(h);
      const b = await loggedIn(h);
      const { secret } = await enrol(h, b);
      const missing = await b.call('PATCH', '/rest/me/password', { currentPassword: PASSWORD, newPassword: 'Changed-Pass-1' });
      assert.deepEqual([missing.status, missing.body.message], [400, 'Two-factor code is required to change password.']);
      const wrong = await b.call('PATCH', '/rest/me/password', { currentPassword: PASSWORD, newPassword: 'Changed-Pass-1', mfaCode: '000000' });
      assert.deepEqual([wrong.status, wrong.body.message], [403, 'Invalid two-factor code.']);
      const ok = await b.call('PATCH', '/rest/me/password', {
        currentPassword: PASSWORD,
        newPassword: 'Changed-Pass-1',
        mfaCode: totpAt(secret, Date.now() + 30_000),
      });
      assert.equal(ok.status, 200, ok.raw);
      assert.equal((await b.call('GET', '/rest/login')).body.data.mfaAuthenticated, true, 'strength preserved');
    } finally {
      await h.close();
    }
  });

  test('e-mail change needs the current password (closes stolen-session → takeover), and revokes sessions', async () => {
    const h = await harness();
    try {
      seedUser(h);
      seedUser(h, { email: 'taken@p56.test' });
      const other = await loggedIn(h);
      const b = await loggedIn(h);
      const bare = await b.call('PATCH', '/rest/me', { email: 'attacker@evil.test' });
      assert.deepEqual([bare.status, bare.body.message], [400, 'Current password is required to change email']);
      const wrong = await b.call('PATCH', '/rest/me', { email: 'attacker@evil.test', currentPassword: 'nope' });
      assert.deepEqual([wrong.status, wrong.body.message], [400, 'Unable to update profile. Please check your credentials and try again.']);
      const dup = await b.call('PATCH', '/rest/me', { email: 'taken@p56.test', currentPassword: PASSWORD });
      assert.equal(dup.status, 400, 'cannot take over another account by e-mail collision');
      assert.equal(h.store.users.find((u) => u.id === h.store.users.all()[0].id).email, 'owner@p56.test', 'unchanged');
      const ok = await b.call('PATCH', '/rest/me', { email: 'new@p56.test', currentPassword: PASSWORD });
      assert.deepEqual([ok.status, ok.body.data.email], [200, 'new@p56.test']);
      assert.equal((await other.call('GET', '/rest/login')).status, 401);
      assert.equal((await b.call('GET', '/rest/login')).status, 200);
      const names = await b.call('PATCH', '/rest/me', { firstName: 'Grace' });
      assert.deepEqual([names.status, names.body.data.firstName], [200, 'Grace'], 'name-only edits need no proof (upstream)');
    } finally {
      await h.close();
    }
  });

  test('e-mail change with MFA requires a TOTP instead', async () => {
    const h = await harness();
    try {
      seedUser(h);
      const b = await loggedIn(h);
      const { secret } = await enrol(h, b);
      const missing = await b.call('PATCH', '/rest/me', { email: 'new@p56.test', currentPassword: PASSWORD });
      assert.deepEqual([missing.status, missing.body.message], [400, 'Two-factor code is required to change email']);
      const ok = await b.call('PATCH', '/rest/me', { email: 'new@p56.test', mfaCode: totpAt(secret, Date.now() + 30_000) });
      assert.equal(ok.status, 200, ok.raw);
    } finally {
      await h.close();
    }
  });

  test('every mutating account route names a declared step-up operation (route coverage)', () => {
    const routes = authRoutes({ logger: console, vault: null, security: createAccountSecurity() });
    const expected = {
      'PATCH /rest/me/password': 'account.password.change',
      'POST /rest/change-password': 'account.password.reset',
      'GET /rest/mfa/qr': 'account.mfa.setup',
      'POST /rest/mfa/enable': 'account.mfa.enable',
      'POST /rest/mfa/disable': 'account.mfa.disable',
    };
    for (const [key, operation] of Object.entries(expected)) {
      const [method, path] = key.split(' ');
      const route = routes.find((r) => r.method === method && r.path === path);
      assert.ok(route, `${key} is mounted`);
      assert.ok(route.handler.toString().includes(`'${operation}'`), `${key} evaluates '${operation}'`);
      assert.ok(STEP_UP_REQUIREMENTS[operation], `${operation} is declared`);
    }
    const source = readFileSync(join(APP_ROOT, 'src/auth/account-routes.mjs'), 'utf8');
    assert.ok(source.includes("stepUpOrThrow('account.email.change'"), 'the e-mail guard evaluates its operation');
    const used = [...source.matchAll(/stepUpOrThrow\('([^']+)'/g)].map((m) => m[1]);
    for (const operation of used) assert.ok(STEP_UP_REQUIREMENTS[operation], `'${operation}' is declared`);
  });
});

describe('no leakage of second-factor material', () => {
  test('neither the stored user nor any API response contains the TOTP secret or recovery codes', async () => {
    const h = await harness();
    try {
      seedUser(h);
      const b = await loggedIn(h);
      const { secret, recoveryCodes } = await enrol(h, b);
      const stored = JSON.stringify(h.store.users.all());
      assert.ok(!stored.includes(secret), 'TOTP secret is sealed');
      for (const code of recoveryCodes) assert.ok(!stored.includes(code), 'recovery codes are digests');
      const responses = [
        await b.call('GET', '/rest/login'),
        await b.call('GET', '/rest/me'),
        await b.call('GET', '/rest/users'),
      ];
      for (const r of responses) {
        assert.ok(!r.raw.includes(secret));
        assert.ok(!/recoveryCodes|lastUsedStep|"mfa"\s*:/.test(r.raw), `no MFA internals in ${r.raw.slice(0, 80)}`);
      }
      const logs = h.logs.join('\n');
      assert.ok(!logs.includes(secret));
      for (const code of recoveryCodes) assert.ok(!logs.includes(code));
    } finally {
      await h.close();
    }
  });
});

/* ======================================================================= 3 */
/*                                REAL SERVER                                */
/* ======================================================================= */

describe('real server: MFA end to end across a restart (file storage, on-disk keyring)', () => {
  const USER_FOLDER = mkdtempSync(join(tmpdir(), 'n8n-lego-p56-'));
  let running = null;
  let base = '';
  const env = () => ({
    ...process.env,
    N8N_LEGO_PORT: '0',
    N8N_LEGO_HOST: '127.0.0.1',
    N8N_LEGO_STORAGE: 'file',
    N8N_LEGO_LOG_LEVEL: 'error',
    N8N_LEGO_PROTOCOL: 'http',
    N8N_LEGO_USER_FOLDER: USER_FOLDER,
    N8N_LEGO_CATALOG_DIR: process.env.N8N_LEGO_CATALOG_DIR ?? REPO_CATALOG,
  });
  async function boot() {
    const { server } = await startServer({ env: env() });
    running = server;
    base = `http://127.0.0.1:${server.address().port}`;
  }
  async function stop() {
    if (running) await new Promise((r) => running.close(r));
    running = null;
  }
  /** Real browser semantics: auth + CSRF cookies, CSRF header, Origin. */
  function client() {
    const jar = {};
    return async (method, path, body) => {
      const headers = { 'content-type': 'application/json', origin: base };
      const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
      if (cookie) headers.cookie = cookie;
      if (jar['n8n-csrf']) headers['x-n8n-csrf-token'] = jar['n8n-csrf'];
      const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      for (const c of res.headers.getSetCookie()) {
        const [pair] = c.split(';');
        const i = pair.indexOf('=');
        jar[pair.slice(0, i)] = pair.slice(i + 1);
      }
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null, raw: text };
    };
  }

  let secret = '';
  before(boot);
  after(async () => {
    await stop();
    rmSync(USER_FOLDER, { recursive: true, force: true });
  });

  test('the editor is told MFA is available (settings)', async () => {
    const call = client();
    const settings = await call('GET', '/rest/settings');
    assert.equal(settings.body.data.mfa.enabled, true);
    assert.equal(settings.body.data.mfa.enforced, false);
  });

  test('owner enrols MFA through the editor flow (CSRF enforced)', async () => {
    const call = client();
    assert.equal((await call('POST', '/rest/owner/setup', { email: 'owner@real.test', firstName: 'O', lastName: 'W', password: PASSWORD })).status, 200);
    const qr = await call('GET', '/rest/mfa/qr');
    assert.equal(qr.status, 200, qr.raw);
    secret = qr.body.data.secret;
    const code = totpAt(secret);
    assert.equal((await call('POST', '/rest/mfa/verify', { mfaCode: code })).status, 200);
    assert.equal((await call('POST', '/rest/mfa/enable', { mfaCode: code })).status, 200);
    const forged = await fetch(`${base}/rest/mfa/disable`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: JSON.stringify({ mfaCode: totpAt(secret) }),
    });
    assert.equal(forged.status === 401 || forged.status === 403, true, 'cross-site request cannot touch MFA');
  });

  test('the TOTP secret is sealed on disk', () => {
    const files = [];
    const walk = (dir) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else files.push(full);
      }
    };
    walk(USER_FOLDER);
    for (const file of files) assert.ok(!readFileSync(file, 'latin1').includes(secret), `${file} holds no TOTP secret`);
  });

  test('after a restart the keyring opens the sealed secret: 998, then TOTP login, mfaAuthenticated', async () => {
    await stop();
    await boot();
    const call = client();
    const noCode = await call('POST', '/rest/login', { emailOrLdapLoginId: 'owner@real.test', password: PASSWORD });
    assert.deepEqual([noCode.status, noCode.body.code], [401, 998]);
    const ok = await call('POST', '/rest/login', { emailOrLdapLoginId: 'owner@real.test', password: PASSWORD, mfaCode: totpAt(secret, Date.now() + 30_000) });
    assert.equal(ok.status, 200, ok.raw);
    assert.equal((await call('GET', '/rest/login')).body.data.mfaAuthenticated, true);
  });
});

test('the auth domain session helper still issues password-strength sessions by default', () => {
  const store = createStore({ storage: 'memory' });
  const owner = createOwner(store, { email: 'd@x.io', password: PASSWORD });
  const issued = createSession(owner, { secret: 's', protocol: 'http', port: 1 });
  assert.ok(issued.token && issued.csrfToken);
  assert.equal(typeof hashPassword(PASSWORD), 'string');
});
