/**
 * P5.7 — API-key credentials: generation, hashed storage, verification,
 * lifecycle verdicts and scope attenuation. HTTP-free and storage-free.
 *
 * WHAT CHANGES FROM UPSTREAM, AND WHAT DOES NOT
 * Pinned n8n stores the raw key (a JWT) in `api_key.apiKey` and looks it up by
 * equality. Anyone who reads the table holds every key. Here the raw value
 * exists exactly once — in the create response — and the server keeps only:
 *
 *   digest  SHA-256 of the raw key (base64url). A key carries 256 bits of
 *           entropy, so a fast hash is the right tool: there is nothing to
 *           brute-force, and verification stays microseconds (no scrypt on
 *           the request path).
 *   hint    the last four characters, which is exactly what upstream's
 *           `redactApiKey` ever shows (`******abcd`).
 *
 * The wire contract is unchanged: the editor still receives `apiKey` redacted
 * and `rawApiKey` once.
 *
 * FORMAT  `n8n_api_<ownerId>.<keyId>.<secret>`
 *   ownerId  lets the verifier load ONE owner record (O(1)) instead of scanning
 *            or keeping a process-local index — the index would be exactly the
 *            kind of per-process state the scale-out gate forbids. The owner id
 *            is not a secret: the key is the owner's own credential.
 *   keyId    names the record inside the owner.
 *   secret   32 random bytes, base64url.
 * The `n8n_api_` prefix is upstream's legacy (non-JWT) key prefix, so tooling
 * that recognises n8n keys keeps recognising these.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const API_KEY_PREFIX = 'n8n_api_';

/** Upstream `API_KEY_AUDIENCE`; a service credential uses its own audience. */
export const API_KEY_AUDIENCE = Object.freeze({ PUBLIC_API: 'public-api', SERVICE: 'service-principal' });

export const API_KEY_POLICY = Object.freeze({
  /** Keys per owner. Bounded: a record that grows per request is an allocation an attacker can drive. */
  maxKeysPerOwner: 50,
  /**
   * Revoked keys are kept as tombstones (P5-M01): the record stays with `revokedAt`, so a presented
   * revoked credential is reported REVOKED (not UNKNOWN) and the audit row survives. Bounded: at most
   * this many tombstones per owner and credential kind; the oldest are pruned first.
   */
  maxRevokedTombstonesPerOwner: 50,
  /** Upstream label schema: 1..50 characters. */
  maxLabelLength: 50,
  /** Hard input bound checked before any parsing or hashing. */
  maxPresentedLength: 256,
  /** last-used is written at most this often per key (upstream updateLastActiveIfStale idea). */
  lastUsedWriteIntervalMs: 60_000,
  /** Upstream `redactApiKey`: 10 characters, last 4 visible. */
  redactedLength: 10,
  revealCount: 4,
});

export const API_KEY_VERDICT = Object.freeze({
  OK: 'ok',
  MALFORMED: 'malformed',
  UNKNOWN: 'unknown',
  REVOKED: 'revoked',
  EXPIRED: 'expired',
  OWNER_UNAVAILABLE: 'owner-unavailable',
  AUDIENCE_MISMATCH: 'audience-mismatch',
});

const ID_SHAPE = /^[A-Za-z0-9_-]{1,64}$/;
const SECRET_SHAPE = /^[A-Za-z0-9_-]{43}$/;

function digestOf(raw) {
  return createHash('sha256').update(raw, 'utf8').digest('base64url');
}

/**
 * Mints a key. The returned `raw` must be shown once and then dropped.
 *
 * @param {{ ownerId: string, keyId: string }} input
 * @returns {{ raw: string, keyId: string, digest: string, hint: string }}
 */
export function generateApiKey({ ownerId, keyId }) {
  if (typeof ownerId !== 'string' || !ID_SHAPE.test(ownerId)) throw new TypeError('ownerId must be a short opaque id');
  if (typeof keyId !== 'string' || !ID_SHAPE.test(keyId)) throw new TypeError('keyId must be a short opaque id');
  if (ownerId.includes('.') || keyId.includes('.')) throw new TypeError('ids must not contain the separator');
  const raw = `${API_KEY_PREFIX}${ownerId}.${keyId}.${randomBytes(32).toString('base64url')}`;
  return { raw, keyId, digest: digestOf(raw), hint: raw.slice(-API_KEY_POLICY.revealCount) };
}

/**
 * Splits a presented key. Pure shape check: no lookup, no hashing, bounded.
 *
 * @param {unknown} presented
 * @returns {{ ownerId: string, keyId: string } | null}
 */
export function parseApiKey(presented) {
  if (typeof presented !== 'string' || presented.length > API_KEY_POLICY.maxPresentedLength) return null;
  if (!presented.startsWith(API_KEY_PREFIX)) return null;
  const parts = presented.slice(API_KEY_PREFIX.length).split('.');
  if (parts.length !== 3) return null;
  const [ownerId, keyId, secret] = parts;
  if (!ID_SHAPE.test(ownerId) || !ID_SHAPE.test(keyId) || !SECRET_SHAPE.test(secret)) return null;
  return { ownerId, keyId };
}

/** Constant-time comparison of a presented key against a stored digest. */
export function apiKeyMatches(presented, storedDigest) {
  if (typeof presented !== 'string' || typeof storedDigest !== 'string') return false;
  const left = Buffer.from(digestOf(presented));
  const right = Buffer.from(storedDigest);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Upstream `redactApiKey`, applied to the stored hint (the raw key is gone). */
export function redactApiKey(hint) {
  const visible = String(hint ?? '').slice(-API_KEY_POLICY.revealCount);
  return '*'.repeat(API_KEY_POLICY.redactedLength - API_KEY_POLICY.revealCount) + visible;
}

/**
 * Lifecycle verdict for a stored key record. Order matters only for the reason
 * reported; every non-OK verdict is a denial.
 *
 * @param {object|null} record stored key record
 * @param {{ now?: number, owner?: object|null, audience?: string }} [context]
 * @returns {string} an API_KEY_VERDICT value
 */
export function apiKeyVerdict(record, { now = Date.now(), owner = null, audience = API_KEY_AUDIENCE.PUBLIC_API } = {}) {
  if (!record) return API_KEY_VERDICT.UNKNOWN;
  if (!owner || owner.disabled === true) return API_KEY_VERDICT.OWNER_UNAVAILABLE;
  if (record.audience !== audience) return API_KEY_VERDICT.AUDIENCE_MISMATCH;
  if (record.revokedAt) return API_KEY_VERDICT.REVOKED;
  // Upstream expiresAt is a unix timestamp in SECONDS, or null for "never".
  if (typeof record.expiresAt === 'number' && now >= record.expiresAt * 1000) return API_KEY_VERDICT.EXPIRED;
  return API_KEY_VERDICT.OK;
}

/**
 * Scope attenuation. `requested` must be a subset of `grantable`; anything
 * outside is an ESCALATION and is reported, never silently dropped — a caller
 * that asked for more than it holds must be told no, not handed less.
 *
 * @param {unknown} requested
 * @param {Iterable<string>} grantable
 * @returns {{ ok: boolean, scopes: string[], escalated: string[] }}
 */
export function attenuateScopes(requested, grantable) {
  const allowed = grantable instanceof Set ? grantable : new Set(grantable);
  if (!Array.isArray(requested) || requested.length === 0) return { ok: false, scopes: [], escalated: [] };
  const scopes = [...new Set(requested.map(String))];
  const escalated = scopes.filter((scope) => !allowed.has(scope));
  return { ok: escalated.length === 0, scopes: escalated.length === 0 ? scopes.sort() : [], escalated };
}

/**
 * Effective authority at request time: the key's scopes intersected with what
 * the owner may grant NOW. A demoted owner's keys shrink immediately — no
 * background job has to find and rewrite them (upstream does that with
 * `removeOwnerOnlyScopesFromApiKeys`; here it is structural).
 *
 * @param {readonly string[]} keyScopes
 * @param {Iterable<string>} ownerGrantable
 * @returns {string[]} sorted
 */
export function effectiveScopes(keyScopes, ownerGrantable) {
  const allowed = ownerGrantable instanceof Set ? ownerGrantable : new Set(ownerGrantable);
  return (keyScopes ?? []).filter((scope) => allowed.has(scope)).sort();
}

/** Is the last-used timestamp stale enough to be worth one write? */
export function lastUsedIsStale(record, now = Date.now()) {
  const last = record?.lastUsedAt ? Date.parse(record.lastUsedAt) : 0;
  return !Number.isFinite(last) || now - last >= API_KEY_POLICY.lastUsedWriteIntervalMs;
}

/**
 * Tombstone revocation (P5-M01). Marks the ACTIVE record `id` revoked and keeps it, pruning the
 * oldest tombstones beyond `API_KEY_POLICY.maxRevokedTombstonesPerOwner`. Returns `null` when no
 * active record has that id (unknown or already revoked), so callers stay idempotent and never
 * confirm that an id exists.
 *
 * @param {ReadonlyArray<object>} records stored key or service-principal records of one owner
 * @param {string} id
 * @param {{ reason?: string, now?: number }} [options]
 * @returns {{ records: object[], revoked: object } | null}
 */
export function revokeWithTombstone(records, id, { reason = 'revoked-by-owner', now = Date.now() } = {}) {
  const list = records ?? [];
  const target = list.find((record) => record.id === id && !record.revokedAt);
  if (!target) return null;
  const at = new Date(now).toISOString();
  const revoked = { ...target, revokedAt: at, revokedReason: reason, updatedAt: at };
  return { records: pruneTombstones(list.map((record) => (record === target ? revoked : record))), revoked };
}

/** Keeps every active record and at most the newest `maxRevokedTombstonesPerOwner` tombstones. */
export function pruneTombstones(records) {
  const list = records ?? [];
  const tombstones = list.filter((record) => record.revokedAt);
  const excess = tombstones.length - API_KEY_POLICY.maxRevokedTombstonesPerOwner;
  if (excess <= 0) return [...list];
  const drop = new Set([...tombstones].sort((a, b) => String(a.revokedAt).localeCompare(String(b.revokedAt))).slice(0, excess));
  return list.filter((record) => !drop.has(record));
}
