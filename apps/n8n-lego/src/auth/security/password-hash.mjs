/**
 * P5.6 — password hashing with algorithm agility and rehash-on-success.
 *
 * COMPATIBILITY FIRST
 * Every password stored before P5.6 has the form `scrypt$<salt-hex>$<hash-hex>`
 * with N=16384, r=8, p=1, keylen=64. Those hashes keep verifying unchanged, and
 * nobody is forced to reset a password.
 *
 * AGILITY WITHOUT A ROLLBACK TRAP
 * The current policy IS the legacy parameter set, and while it is, new hashes
 * are written in the legacy format too. That is deliberate: if P5.6 is rolled
 * back, the old `verifyPassword` only understands `scrypt$salt$hash`, so writing
 * a new format today would lock out every user who logged in after the upgrade.
 *
 * The agility is real but dormant: a stronger policy (a higher N, say) makes
 * `hashPassword` emit the self-describing `scrypt-v2$N$r$p$keylen$salt$hash`
 * form, and `needsRehash` reports legacy hashes as stale so they are upgraded
 * transparently on the user's next successful login. Tests exercise that path
 * with an injected policy.
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/** The parameter set every pre-P5.6 hash uses. */
export const LEGACY_SCRYPT = Object.freeze({ N: 16384, r: 8, p: 1, keylen: 64 });

/** Policy in force. Equal to LEGACY_SCRYPT — see the module comment. */
export const PASSWORD_HASH_POLICY = Object.freeze({ scheme: 'scrypt', ...LEGACY_SCRYPT, saltBytes: 16 });

/**
 * Verification refuses inputs longer than this before running scrypt, so an
 * oversized password cannot be used to burn CPU. Generous: new passwords are
 * capped at 64 characters by the upstream policy below.
 */
export const MAX_PASSWORD_BYTES = 1024;

/** Upper bounds on parameters read from a stored hash (a corrupt row must not DoS). */
const PARAM_BOUNDS = Object.freeze({ maxN: 2 ** 20, maxR: 32, maxP: 16, maxKeylen: 128 });

const sameParams = (a, b) => a.N === b.N && a.r === b.r && a.p === b.p && a.keylen === b.keylen;

function scryptMaxmem({ N, r, p }) {
  return 128 * N * r * p + 1024 * 1024 * 32;
}

/** Parse a stored hash into scheme + parameters, or null when unrecognised. */
export function parsePasswordHash(stored) {
  if (typeof stored !== 'string' || stored.length > 1024) return null;
  const parts = stored.split('$');
  if (parts[0] === 'scrypt' && parts.length === 3 && parts[1] && parts[2]) {
    return { scheme: 'scrypt', params: LEGACY_SCRYPT, salt: parts[1], hash: parts[2] };
  }
  if (parts[0] === 'scrypt-v2' && parts.length === 7) {
    const [, n, r, p, keylen, salt, hash] = parts;
    const params = { N: Number(n), r: Number(r), p: Number(p), keylen: Number(keylen) };
    const ok =
      Number.isInteger(params.N) && params.N > 1 && params.N <= PARAM_BOUNDS.maxN && (params.N & (params.N - 1)) === 0 &&
      Number.isInteger(params.r) && params.r >= 1 && params.r <= PARAM_BOUNDS.maxR &&
      Number.isInteger(params.p) && params.p >= 1 && params.p <= PARAM_BOUNDS.maxP &&
      Number.isInteger(params.keylen) && params.keylen >= 32 && params.keylen <= PARAM_BOUNDS.maxKeylen &&
      salt && hash;
    return ok ? { scheme: 'scrypt-v2', params, salt, hash } : null;
  }
  return null;
}

/**
 * Hash a password under `policy`. Emits the legacy format while the policy
 * equals the legacy parameters (rollback safety), `scrypt-v2` otherwise.
 */
export function hashPassword(password, policy = PASSWORD_HASH_POLICY) {
  const salt = randomBytes(policy.saltBytes ?? 16).toString('hex');
  const params = { N: policy.N, r: policy.r, p: policy.p, keylen: policy.keylen };
  const hash = scryptSync(String(password), salt, params.keylen, { ...params, maxmem: scryptMaxmem(params) }).toString('hex');
  if (sameParams(params, LEGACY_SCRYPT)) return `scrypt$${salt}$${hash}`;
  return `scrypt-v2$${params.N}$${params.r}$${params.p}$${params.keylen}$${salt}$${hash}`;
}

/** Constant-time verification. Unknown formats and oversized input verify false. */
export function verifyPassword(password, stored) {
  if (typeof password !== 'string' || Buffer.byteLength(password) > MAX_PASSWORD_BYTES) return false;
  const parsed = parsePasswordHash(stored);
  if (!parsed) return false;
  const expected = Buffer.from(parsed.hash, 'hex');
  if (expected.length !== parsed.params.keylen) return false;
  const candidate = scryptSync(password, parsed.salt, parsed.params.keylen, {
    ...parsed.params,
    maxmem: scryptMaxmem(parsed.params),
  });
  return timingSafeEqual(candidate, expected);
}

/** True when a stored hash was made under weaker/different parameters than `policy`. */
export function needsRehash(stored, policy = PASSWORD_HASH_POLICY) {
  const parsed = parsePasswordHash(stored);
  if (!parsed) return false; // unverifiable; never "upgrade" something we cannot check
  return !sameParams(parsed.params, policy);
}

// @scale-out-safe: lazily-built hash of a random throwaway password, used only
// to spend the same scrypt cost when an account does not exist. It carries no
// authority and never verifies anything real; two processes holding different
// dummies behave identically (both always answer "no match"). No state crosses
// a process boundary.
let dummyHash = null;
/**
 * Burn the same scrypt cost as a real verification. Called when the account
 * does not exist so "no such user" and "wrong password" take the same time —
 * otherwise response latency enumerates accounts.
 */
export function verifyAgainstDummy(password) {
  if (dummyHash === null) dummyHash = hashPassword(randomBytes(16).toString('hex'));
  verifyPassword(typeof password === 'string' ? password : '', dummyHash);
  return false;
}

/**
 * Upstream `passwordSchema` (`@n8n/api-types`): 8–64 characters, at least one
 * digit and one uppercase letter. Returns the upstream messages joined by a
 * space (exactly what `me.controller.updatePassword` sends), or null when valid.
 */
export function passwordPolicyViolation(password) {
  if (typeof password !== 'string') return 'Password must be 8 to 64 characters long.';
  const messages = [];
  if (password.length < 8 || password.length > 64) messages.push('Password must be 8 to 64 characters long.');
  if (!/\d/.test(password)) messages.push('Password must contain at least 1 number.');
  if (!/[A-Z]/.test(password)) messages.push('Password must contain at least 1 uppercase letter.');
  return messages.length === 0 ? null : messages.join(' ');
}
