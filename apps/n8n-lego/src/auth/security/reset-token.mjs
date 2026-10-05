/**
 * P5.6 — password-reset tokens: single-use, short-lived, bounded, unlinkable.
 *
 * Upstream n8n issues a 20-minute JWT carrying `{ sub, hash }` where `hash` is a
 * digest of (email, password hash, part of the MFA secret). That token cannot be
 * consumed: it stays valid for its whole lifetime until the password actually
 * changes, so it can be REPLAYED until then (e.g. from a mail relay log, a
 * browser history entry or a Referer header).
 *
 * P5.6 keeps the upstream wire shape (an opaque `token` string in the
 * `/change-password?token=…` URL) and strengthens the semantics:
 *
 *   - random 256-bit token; only its SHA-256 digest is held server-side, so the
 *     table never contains a usable token;
 *   - SINGLE USE: `consume` removes the entry atomically before returning, so a
 *     replay — even a concurrent one — finds nothing;
 *   - bounded lifetime (default 20 min, the upstream value; hard cap 1 h);
 *   - one live token per user: issuing a new one revokes the previous;
 *   - bound to a credential fingerprint (email, password hash, MFA state), so a
 *     password or e-mail change invalidates every outstanding token even if it
 *     was never used — the upstream `hash` property, kept;
 *   - bounded memory (`maxTokens`), reclaiming expired entries first.
 *
 * Process-local on purpose, like sessions: a restart invalidates outstanding
 * reset links, which is the safe direction to fail.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const RESET_TOKEN_POLICY = Object.freeze({
  /** Upstream `generatePasswordResetToken(user, expiresIn = '20m')`. */
  ttlMs: 20 * 60_000,
  /** No configuration may make a reset link live longer than this. */
  maxTtlMs: 60 * 60_000,
  tokenBytes: 32,
  maxTokens: 10_000,
  evictScan: 32,
});

/** Why a token did not resolve. Internal only — the HTTP answer is always the same 404. */
export const RESET_TOKEN_VERDICT = Object.freeze({
  OK: 'OK',
  MALFORMED: 'MALFORMED',
  UNKNOWN: 'UNKNOWN',
  EXPIRED: 'EXPIRED',
  STALE: 'STALE',
});

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const digestOf = (token) => createHash('sha256').update(token).digest('base64url');

/**
 * Credential fingerprint: changes whenever the account's authentication
 * material changes. Mirrors upstream `createJWTHash` inputs (email, password
 * hash, MFA state) but keyed with the instance secret and never truncated to
 * something guessable.
 */
export function credentialFingerprint(user, secret) {
  const mfa = user?.mfa ?? {};
  const material = JSON.stringify([
    String(user?.email ?? ''),
    String(user?.password ?? ''),
    mfa.state ?? 'disabled',
    mfa.secret?.keyRef ?? null,
    mfa.secret?.iv ?? null,
  ]);
  return createHmac('sha256', String(secret)).update(material).digest('base64url');
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * @param {object} [options]
 * @param {number} [options.ttlMs]
 * @param {number} [options.maxTokens]
 */
export function createResetTokenStore({ ttlMs = RESET_TOKEN_POLICY.ttlMs, maxTokens = RESET_TOKEN_POLICY.maxTokens } = {}) {
  if (!Number.isInteger(ttlMs) || ttlMs < 1 || ttlMs > RESET_TOKEN_POLICY.maxTtlMs) {
    throw new TypeError(`reset token ttl must be 1..${RESET_TOKEN_POLICY.maxTtlMs} ms`);
  }
  if (!Number.isInteger(maxTokens) || maxTokens < 1) throw new TypeError('maxTokens must be a positive integer');
  /** digest -> { userId, fingerprint, expiresAt } */
  const byDigest = new Map();
  /** userId -> digest (one live token per user) */
  const byUser = new Map();

  function drop(digest) {
    const entry = byDigest.get(digest);
    if (!entry) return;
    byDigest.delete(digest);
    if (byUser.get(entry.userId) === digest) byUser.delete(entry.userId);
  }

  function makeRoom(now) {
    if (byDigest.size < maxTokens) return;
    let scanned = 0;
    for (const [digest, entry] of byDigest) {
      if (scanned++ >= RESET_TOKEN_POLICY.evictScan) break;
      if (entry.expiresAt <= now) {
        drop(digest);
        return;
      }
    }
    // Nothing expired within the scan: evict the oldest live token. Bounded
    // memory wins over keeping a stranger's link alive; the per-account and
    // per-IP forgot-password limits keep this from being cheap to trigger.
    drop(byDigest.keys().next().value);
  }

  function lookup(token, currentFingerprint, now) {
    if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) return { verdict: RESET_TOKEN_VERDICT.MALFORMED };
    const digest = digestOf(token);
    const entry = byDigest.get(digest);
    if (!entry) return { verdict: RESET_TOKEN_VERDICT.UNKNOWN };
    if (entry.expiresAt <= now) {
      drop(digest);
      return { verdict: RESET_TOKEN_VERDICT.EXPIRED };
    }
    const fingerprint = currentFingerprint(entry.userId);
    if (fingerprint === null || !safeEqual(fingerprint, entry.fingerprint)) {
      drop(digest);
      return { verdict: RESET_TOKEN_VERDICT.STALE };
    }
    return { verdict: RESET_TOKEN_VERDICT.OK, digest, userId: entry.userId };
  }

  return {
    ttlMs,
    /**
     * Issue a token for a user; revokes that user's previous token.
     * @returns {{ token: string, expiresAt: number }}
     */
    issue({ userId, fingerprint }, now = Date.now()) {
      if (typeof userId !== 'string' || userId === '' || typeof fingerprint !== 'string' || fingerprint === '') {
        throw new TypeError('issue requires userId and fingerprint');
      }
      const previous = byUser.get(userId);
      if (previous) drop(previous);
      makeRoom(now);
      const token = randomBytes(RESET_TOKEN_POLICY.tokenBytes).toString('base64url');
      const digest = digestOf(token);
      const expiresAt = now + ttlMs;
      byDigest.set(digest, { userId, fingerprint, expiresAt });
      byUser.set(userId, digest);
      return { token, expiresAt };
    },
    /**
     * Check a token WITHOUT consuming it (the editor calls
     * `GET /resolve-password-token` when the reset page opens).
     * @param {(userId: string) => string|null} currentFingerprint
     */
    resolve(token, currentFingerprint, now = Date.now()) {
      const { verdict, userId } = lookup(token, currentFingerprint, now);
      return { verdict, userId: verdict === RESET_TOKEN_VERDICT.OK ? userId : null };
    },
    /**
     * Validate and consume in one step. The entry is removed BEFORE returning,
     * so a second presentation of the same token can never succeed.
     */
    consume(token, currentFingerprint, now = Date.now()) {
      const found = lookup(token, currentFingerprint, now);
      if (found.verdict !== RESET_TOKEN_VERDICT.OK) return { verdict: found.verdict, userId: null };
      drop(found.digest);
      return { verdict: RESET_TOKEN_VERDICT.OK, userId: found.userId };
    },
    /** Revoke every token of a user (password changed through another path). */
    revokeForUser(userId) {
      const digest = byUser.get(userId);
      if (digest) drop(digest);
    },
    size: () => byDigest.size,
  };
}
