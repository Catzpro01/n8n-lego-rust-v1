/**
 * registry.freshness@0.1.0 — update metadata freshness: rollback, freeze, mix-and-match.
 *
 * P6 milestone 28 of 31 (Issue #100). Signed metadata is not enough: a signature says who wrote a
 * sentence, not when the sentence stopped being true. The three attacks this contract exists for
 * are the three that survive a valid signature —
 *
 *   ROLLBACK   an old, correctly signed statement served in place of the current one;
 *   FREEZE     the current statement withheld until it expires, so a stale one keeps working;
 *   MIX-AND-MATCH  metadata from two different snapshots, each internally consistent, combined.
 *
 * What it adds:
 *
 *  - A VERSION THAT GOES BACKWARDS IS REFUSED by name, and so is the quieter version of it: the
 *    same version arriving with different bytes. A fork is not an update.
 *  - EXPIRY IS A VERDICT, NOT A TIMESTAMP. Expired metadata says yesterday's truth; it is refused
 *    rather than used, and a clock that goes backwards relative to the last check is refused too,
 *    because that is how a freeze is hidden.
 *  - SILENCE IS NOT A SIGNATURE. Thresholds are supplied as counts by the caller (who owns
 *    verification); metadata below its threshold is `incomplete`, which is not a pass.
 *  - METADATA FROM TWO SNAPSHOTS IS ONE SNAPSHOT TOO MANY: the snapshot names the version and
 *    digest of everything below it, and a targets file that is not the one the snapshot names is a
 *    mismatch however well it verifies on its own.
 *  - A DELEGATION MAY NARROW, NEVER WIDEN: a delegated role signs inside the paths its parent
 *    already covers, may not lower the bar its parent set, and inherits that bar when it is not
 *    stated.
 *  - A REFRESH IS A PLAN AND IT STOPS: ask for the timestamp first, and if it did not move, do not
 *    ask for anything below it — asking anyway is how a freeze goes unnoticed for a year.
 *
 * This contract performs NO CRYPTOGRAPHY. Signatures, keys, roots and attestations belong to
 * P6.12; the caller verifies and hands in counts. Nor does it decide trust (P6.1), admission
 * (P6.17) or registry state (P6.16): what the epoch chain calls freshness over epochs is the chain's
 * business.
 *
 * Scope walls (enforced by tests): no other module of this repository, no signature checking, no
 * network (a refresh is a PLAN, not a fetch), no filesystem, no clock — every answer takes the
 * tick it answers for, and a check with no tick is refused.
 *
 * Authority: this contract decides whether metadata is current enough to use. It never decides
 * whether the artifact it describes may run.
 */
import { createHash } from 'node:crypto';

export const FRESHNESS_CONTRACT = 'registry.freshness@0.1.0';
export const FRESHNESS_CONTRACT_VERSION = '0.1.0';
export const FRESHNESS_SCHEMA_VERSION = 1;
export const FRESHNESS_FORMAT = 'lego-freshness@1';

export const FRESHNESS_OPERATIONS = Object.freeze(['trust', 'evaluate', 'refresh', 'delegate', 'describe']);
export const FRESHNESS_PERMISSIONS = Object.freeze(['node:read']);

/** The four roles of an update framework. Delegated roles are named by the caller. */
export const UPDATE_ROLES = Object.freeze(['root', 'timestamp', 'snapshot', 'targets']);

/** `unchanged` is the good outcome for a role: same version, same bytes, nothing to say. */
export const FRESHNESS_VERDICTS = Object.freeze(['fresh', 'rollback', 'frozen', 'mismatch', 'incomplete']);

export const FRESHNESS_REASONS = Object.freeze([
  'freshness.input', 'freshness.role', 'freshness.version', 'freshness.digest', 'freshness.expiry',
  'freshness.threshold', 'freshness.snapshot', 'freshness.delegation', 'freshness.tick', 'freshness.refresh',
]);

export const FRESHNESS_RULES = Object.freeze({
  monotone: 'a version that goes backwards is the attack the number exists to stop, and the same version with different bytes is a fork, not an update',
  freeze: 'expired metadata says yesterday\'s truth, so it is refused rather than used',
  clock: 'a clock that goes backwards relative to the last check is how a freeze is hidden, so it is refused too',
  threshold: 'silence is not a signature: metadata below the threshold the caller supplies is incomplete, and incomplete is not a pass',
  binding: 'metadata from two snapshots is one snapshot too many: what a snapshot names is what the role below it must be',
  delegation: 'a delegation may narrow what it can sign, never widen it, and may not lower the bar its parent set',
  refresh: 'ask the timestamp first, and if it did not move, do not ask for anything below it',
  authority: 'this contract decides whether metadata is current enough to use; it never decides whether the artifact it describes may run',
});

export class FreshnessError extends Error {
  constructor(message, { code = 'freshness.input', meta = {} } = {}) {
    super(message);
    this.name = 'FreshnessError';
    this.code = 'lego.contract_violation';
    this.meta = { code, ...meta };
  }
}

const fail = (message, detail = {}) => { throw new FreshnessError(message, detail); };

const isNonEmptyString = (value) => typeof value === 'string' && value.length > 0;
const isTick = (value) => Number.isInteger(value) && value >= 0;
const isCount = (value) => Number.isInteger(value) && value >= 0;
const isDigest = (value) => isNonEmptyString(value) && /^[0-9a-f]{64}$/.test(value.replace(/^sha256:/, ''));

/** Canonical JSON: key order must not change a digest. */
export function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

export function freshnessDigest(fields) {
  return sha256(stableJson(fields ?? {}));
}

/* ------------------------------------------------------------------- roles */

/**
 * Ciphertext counts, digests, versions and expiry, all of them supplied. This contract never sees
 * a key and never checks a signature: the caller, who owns verification, reports how many held.
 */
export function createRoleMetadata({
  role, version, digest, expiresAt, signatures = { valid: 1, required: 1 }, meta = null,
} = {}) {
  if (!isNonEmptyString(role)) fail('metadata names its role', { code: 'freshness.role', field: 'role' });
  if (!Number.isInteger(version) || version < 1) fail(`metadata version '${String(version)}' is not a whole number from 1: a role that has never been published has no version`, { code: 'freshness.version', field: 'version' });
  if (!isDigest(digest)) fail(`the digest '${String(digest)}' is not a digest: metadata identified by nothing cannot be compared with anything`, { code: 'freshness.digest', field: 'digest' });
  if (!isTick(expiresAt)) fail('metadata says when it expires, as a whole tick', { code: 'freshness.expiry', field: 'expiresAt' });
  if (signatures === null || typeof signatures !== 'object') fail('signatures are reported as counts', { code: 'freshness.threshold', field: 'signatures' });
  if (!isCount(signatures.valid)) fail('the valid signature count is a whole number', { code: 'freshness.threshold', field: 'signatures.valid' });
  if (!Number.isInteger(signatures.required) || signatures.required < 1) {
    fail(`a threshold of ${String(signatures.required)} is a signature nobody has to give`, { code: 'freshness.threshold', field: 'signatures.required' });
  }
  if (signatures.valid > signatures.required) {
    fail(`metadata reports ${signatures.valid} valid signature(s) against a threshold of ${signatures.required}: more signatures than the role accepts is a reporting mistake, not a surplus`, { code: 'freshness.threshold', field: 'signatures.valid' });
  }
  if (meta !== null) {
    if (role !== 'snapshot') fail(`only a snapshot names the versions below it, and '${role}' is not a snapshot`, { code: 'freshness.snapshot', field: 'meta' });
    if (typeof meta !== 'object' || Array.isArray(meta)) fail('snapshot metadata is a map of role to version and digest', { code: 'freshness.snapshot', field: 'meta' });
    for (const [name, entry] of Object.entries(meta)) {
      if (name === 'snapshot') fail('a snapshot does not name itself: that is what a version is for', { code: 'freshness.snapshot', field: `meta.${name}` });
      if (entry === null || typeof entry !== 'object') fail(`the snapshot names '${name}' without a version and digest`, { code: 'freshness.snapshot', field: `meta.${name}` });
      if (!Number.isInteger(entry.version) || entry.version < 1) fail(`the snapshot names '${name}' at version '${String(entry.version)}'`, { code: 'freshness.snapshot', field: `meta.${name}.version` });
      if (!isDigest(entry.digest)) fail(`the snapshot names '${name}' without a digest: a version alone does not say which bytes`, { code: 'freshness.snapshot', field: `meta.${name}.digest` });
    }
  }

  const body = {
    contract: FRESHNESS_CONTRACT,
    schemaVersion: FRESHNESS_SCHEMA_VERSION,
    role,
    version,
    digest,
    expiresAt,
    signatures: Object.freeze({ valid: signatures.valid, required: signatures.required }),
    meta: meta === null ? null : Object.freeze(Object.fromEntries(
      Object.entries(meta).map(([name, entry]) => [name, Object.freeze({ version: entry.version, digest: entry.digest })]),
    )),
  };
  return Object.freeze({ ...body, metadataDigest: freshnessDigest(body) });
}

export function isRoleMetadata(value) {
  return Boolean(value) && typeof value === 'object' && value.contract === FRESHNESS_CONTRACT && isNonEmptyString(value.role) && isNonEmptyString(value.metadataDigest);
}

export function createTrustedState({ roles = {}, checkedAt } = {}) {
  if (roles === null || typeof roles !== 'object' || Array.isArray(roles)) fail('trusted state is a map of role to what is already trusted', { code: 'freshness.input', field: 'roles' });
  if (!isTick(checkedAt)) fail('trusted state records the tick it was last checked at, because a check with no clock is a wish', { code: 'freshness.tick', field: 'checkedAt' });
  const normalized = {};
  for (const [role, entry] of Object.entries(roles)) {
    if (!isNonEmptyString(role)) fail('a trusted role has a name', { code: 'freshness.role', field: 'roles' });
    if (entry === null || typeof entry !== 'object') fail(`trusted role '${role}' has no version and digest`, { code: 'freshness.input', field: `roles.${role}` });
    if (!Number.isInteger(entry.version) || entry.version < 1) fail(`trusted role '${role}' has version '${String(entry.version)}'`, { code: 'freshness.version', field: `roles.${role}.version` });
    if (!isDigest(entry.digest)) fail(`trusted role '${role}' has no digest`, { code: 'freshness.digest', field: `roles.${role}.digest` });
    if (entry.expiresAt !== undefined && !isTick(entry.expiresAt)) fail(`trusted role '${role}' has an expiry that is not a tick`, { code: 'freshness.expiry', field: `roles.${role}.expiresAt` });
    normalized[role] = Object.freeze({ version: entry.version, digest: entry.digest, expiresAt: entry.expiresAt ?? null });
  }
  const body = { contract: FRESHNESS_CONTRACT, schemaVersion: FRESHNESS_SCHEMA_VERSION, roles: Object.freeze(normalized), checkedAt };
  return Object.freeze({ ...body, stateDigest: freshnessDigest(body) });
}

export function isTrustedState(value) {
  return Boolean(value) && typeof value === 'object' && value.contract === FRESHNESS_CONTRACT && value.roles !== undefined && isNonEmptyString(value.stateDigest);
}

/* --------------------------------------------------------------- evaluation */

const DEFAULT_POLICY = Object.freeze({ requiredRoles: UPDATE_ROLES, maxClockSkew: 0, threshold: {}, requireSnapshotBinding: true });

const verdictOf = (verdict, reason, message, extra = {}) => Object.freeze({ ok: verdict === 'fresh', verdict, reason, message, ...extra });

/**
 * The one decision. Order matters: what cannot be checked is refused first, then what is known to
 * be old, then what is known to be wrong.
 */
export function evaluateFreshness({ trusted, candidate, tick, policy = {} } = {}) {
  if (!isTrustedState(trusted)) fail('evaluateFreshness reads a trusted state made by createTrustedState', { code: 'freshness.input', field: 'trusted' });
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) fail('evaluateFreshness reads a candidate map of role to metadata', { code: 'freshness.input', field: 'candidate' });
  if (!isTick(tick)) fail('evaluateFreshness takes the tick it is answering for: a freshness check with no clock is a wish', { code: 'freshness.tick', field: 'tick' });
  const merged = { ...DEFAULT_POLICY, ...policy };
  if (!Array.isArray(merged.requiredRoles) || merged.requiredRoles.length === 0) fail('requiredRoles is a non-empty list: requiring nothing is not a policy', { code: 'freshness.input', field: 'policy.requiredRoles' });
  if (!isCount(merged.maxClockSkew)) fail('maxClockSkew is a whole number of ticks', { code: 'freshness.input', field: 'policy.maxClockSkew' });
  if (merged.threshold === null || typeof merged.threshold !== 'object' || Array.isArray(merged.threshold)) fail('thresholds are a map of role to count', { code: 'freshness.threshold', field: 'policy.threshold' });
  for (const [role, count] of Object.entries(merged.threshold)) {
    if (!Number.isInteger(count) || count < 1) fail(`threshold for '${role}' is ${String(count)}: a threshold below one is a signature nobody has to give`, { code: 'freshness.threshold', field: `policy.threshold.${role}` });
  }
  for (const role of merged.requiredRoles) {
    if (!isNonEmptyString(role)) fail('a required role has a name', { code: 'freshness.role', field: 'policy.requiredRoles' });
  }

  const context = { tick, maxClockSkew: merged.maxClockSkew, thresholds: merged.threshold, trusted };
  const metadata = {};
  for (const [role, value] of Object.entries(candidate)) {
    if (!isRoleMetadata(value)) fail(`the candidate metadata for '${role}' was not made by createRoleMetadata`, { code: 'freshness.input', field: `candidate.${role}` });
    if (value.role !== role) fail(`the candidate is keyed '${role}' and the metadata inside says '${value.role}'`, { code: 'freshness.role', field: `candidate.${role}` });
    metadata[role] = value;
  }

  // 1. A clock that goes backwards is how a freeze is hidden.
  if (tick < trusted.checkedAt) {
    return verdictOf('frozen', 'freshness.tick', `this check is at tick ${tick} and the trusted state was last checked at ${trusted.checkedAt}: a clock that goes backwards relative to the last check is how a freeze is hidden`, { tick, decisionDigest: freshnessDigest({ trusted: trusted.stateDigest, tick, verdict: 'frozen' }) });
  }

  // 2. What cannot be checked: a role that is not here, and a threshold nobody met.
  const missing = merged.requiredRoles.filter((role) => metadata[role] === undefined);
  if (missing.length > 0) {
    return verdictOf('incomplete', 'freshness.role', `an update that arrives without its ${missing.join(', ')} cannot be said to be current: ${missing.length} required role(s) are absent, and absent is not fresh`, { missing: Object.freeze(missing), decisionDigest: freshnessDigest({ trusted: trusted.stateDigest, missing, tick, verdict: 'incomplete' }) });
  }
  for (const role of merged.requiredRoles) {
    const required = merged.threshold[role] ?? metadata[role].signatures.required;
    if (metadata[role].signatures.valid < required) {
      return verdictOf('incomplete', 'freshness.threshold', `silence is not a signature: '${role}' carries ${metadata[role].signatures.valid} of ${required} valid signature(s) for this policy`, { role, valid: metadata[role].signatures.valid, required, decisionDigest: freshnessDigest({ trusted: trusted.stateDigest, role, valid: metadata[role].signatures.valid, required, tick, verdict: 'incomplete' }) });
    }
  }

  // 3. Expiry: yesterday's truth, refused rather than used.
  const expired = merged.requiredRoles.filter((role) => tick > metadata[role].expiresAt + merged.maxClockSkew);
  if (expired.length > 0) {
    const role = expired[0];
    const slack = merged.maxClockSkew > 0 ? ` (allowing a clock skew of ${merged.maxClockSkew})` : '';
    return verdictOf('frozen', 'freshness.expiry', `'${role}' expired at tick ${metadata[role].expiresAt} and it is now ${tick}${slack}: expired metadata says yesterday's truth, so it is refused rather than used`, { roles: Object.freeze(expired), decisionDigest: freshnessDigest({ trusted: trusted.stateDigest, expired, tick, verdict: 'frozen' }) });
  }

  // 4. Versions: backwards is a rollback, sideways with different bytes is a fork.
  const unchanged = [];
  for (const role of Object.keys(metadata).sort()) {
    const known = trusted.roles[role];
    if (!known) continue;
    const current = metadata[role];
    if (current.version < known.version) {
      return verdictOf('rollback', 'freshness.version', `'${role}' went from version ${known.version} back to ${current.version}: a version that goes backwards is the attack the number exists to stop`, { role, from: known.version, to: current.version, decisionDigest: freshnessDigest({ trusted: trusted.stateDigest, role, from: known.version, to: current.version, tick, verdict: 'rollback' }) });
    }
    if (current.version === known.version && current.digest !== known.digest) {
      return verdictOf('mismatch', 'freshness.digest', `'${role}' version ${known.version} is already trusted as ${String(known.digest).slice(0, 12)}… and now arrives as ${String(current.digest).slice(0, 12)}…: the same version with different bytes is a fork, not an update`, { role, version: known.version, decisionDigest: freshnessDigest({ trusted: trusted.stateDigest, role, version: known.version, tick, verdict: 'mismatch' }) });
    }
    if (current.version === known.version && current.digest === known.digest) unchanged.push(role);
  }

  // 5. Binding: what the snapshot names is what the roles below it have to be.
  const snapshot = metadata.snapshot;
  if (snapshot && snapshot.meta !== null && merged.requireSnapshotBinding !== false) {
    for (const [role, named] of Object.entries(snapshot.meta)) {
      const current = metadata[role];
      if (current === undefined) continue;
      if (current.version !== named.version || current.digest !== named.digest) {
        return verdictOf('mismatch', 'freshness.snapshot', `the snapshot names '${role}' at version ${named.version} (${String(named.digest).slice(0, 12)}…) and what is in hand is version ${current.version} (${String(current.digest).slice(0, 12)}…): metadata from two snapshots is one snapshot too many`, { role, named: Object.freeze({ version: named.version, digest: named.digest }), found: Object.freeze({ version: current.version, digest: current.digest }), decisionDigest: freshnessDigest({ trusted: trusted.stateDigest, role, named, tick, verdict: 'mismatch' }) });
      }
    }
  }

  const versions = Object.fromEntries(Object.entries(metadata).sort().map(([role, value]) => [role, value.version]));
  return verdictOf('fresh', null, `metadata is current at tick ${tick}: ${Object.entries(versions).map(([role, version]) => `${role} v${version}`).join(', ')}${unchanged.length > 0 ? ` (${unchanged.length} unchanged)` : ''}`, {
    versions: Object.freeze(versions),
    unchanged: Object.freeze(unchanged.sort()),
    decisionDigest: freshnessDigest({ trusted: trusted.stateDigest, versions, unchanged: [...unchanged].sort(), tick, verdict: 'fresh' }),
  });
}

/* ------------------------------------------------------------------ refresh */

/**
 * A refresh is a plan, not a fetch: this contract has no network. The plan stops at the first role
 * that did not move, because asking below it cannot reveal anything new — and asking anyway is how
 * a freeze goes unnoticed.
 */
export function planRefresh({ trusted, candidate = null, policy = {} } = {}) {
  if (!isTrustedState(trusted)) fail('planRefresh reads a trusted state made by createTrustedState', { code: 'freshness.input', field: 'trusted' });
  if (candidate !== null && (typeof candidate !== 'object' || Array.isArray(candidate))) fail('the candidate, when given, is a map of role to metadata', { code: 'freshness.input', field: 'candidate' });
  const includeRoot = policy.includeRoot ?? true;
  if (typeof includeRoot !== 'boolean') fail('includeRoot is a boolean', { code: 'freshness.input', field: 'policy.includeRoot' });

  const roles = includeRoot ? ['root'] : [];
  const timestamp = candidate?.timestamp ?? null;
  const knownTimestamp = trusted.roles.timestamp ?? null;
  if (timestamp !== null && knownTimestamp !== null && timestamp.version === knownTimestamp.version && timestamp.digest === knownTimestamp.digest) {
    roles.push('timestamp');
    return Object.freeze({
      ok: true,
      roles: Object.freeze(roles),
      stopAt: 'timestamp',
      unchanged: true,
      message: `the timestamp is still version ${timestamp.version}, so nothing below it can have changed: the refresh stops here rather than asking for metadata that cannot be newer`,
    });
  }
  roles.push('timestamp', 'snapshot');
  const snapshot = candidate?.snapshot ?? null;
  const knownSnapshot = trusted.roles.snapshot ?? null;
  if (snapshot !== null && knownSnapshot !== null && snapshot.version === knownSnapshot.version && snapshot.digest === knownSnapshot.digest) {
    return Object.freeze({
      ok: true,
      roles: Object.freeze(roles),
      stopAt: 'snapshot',
      unchanged: false,
      message: `the timestamp moved to version ${timestamp === null ? 'unknown' : timestamp.version}; the snapshot is still version ${snapshot.version}, so the targets cannot have changed`,
    });
  }
  roles.push('targets');
  return Object.freeze({
    ok: true,
    roles: Object.freeze(roles),
    stopAt: null,
    unchanged: false,
    message: snapshot === null && timestamp === null
      ? 'no timestamp was supplied, so nothing can be short-circuited: the plan asks for the whole chain'
      : 'the metadata below the timestamp moved as well, so the plan asks for everything the roles cover',
  });
}

/* --------------------------------------------------------------- delegation */

const stripWildcard = (pattern) => String(pattern).replace(/\*+$/, '');

/** The prefix rule, spelled out: a path is covered by a prefix when it starts with it. */
export function isCoveredBy(path, prefixes) {
  if (!Array.isArray(prefixes)) fail('isCoveredBy reads a list of prefixes', { code: 'freshness.delegation', field: 'prefixes' });
  const target = String(path);
  return prefixes.some((prefix) => {
    const base = stripWildcard(prefix);
    return target === base || target.startsWith(base.endsWith('/') || base === '' ? base : `${base}/`);
  });
}

/**
 * A delegation is a narrowing. The child signs inside the parent's paths — a child that asks for
 * more than its parent covers is asking for authority its parent never had.
 */
export function createDelegation({ from, to, parentPaths, paths, parentThreshold = 1, threshold = parentThreshold } = {}) {
  if (!isNonEmptyString(from)) fail('a delegation names the role it comes from', { code: 'freshness.delegation', field: 'from' });
  if (!isNonEmptyString(to)) fail('a delegation names the role it goes to', { code: 'freshness.delegation', field: 'to' });
  if (from === to) fail(`'${from}' cannot delegate to itself: authority handed to itself is authority widened`, { code: 'freshness.delegation', field: 'to' });
  if (!Array.isArray(parentPaths) || parentPaths.length === 0) fail('the parent covers at least one path', { code: 'freshness.delegation', field: 'parentPaths' });
  if (!Array.isArray(paths) || paths.length === 0) fail(`'${to}' covers at least one path: a role that can sign nothing is not a delegation`, { code: 'freshness.delegation', field: 'paths' });
  if (new Set(paths).size !== paths.length) fail(`'${to}' names the same path twice`, { code: 'freshness.delegation', field: 'paths' });
  if (!Number.isInteger(threshold) || threshold < 1) fail(`threshold ${String(threshold)} is a signature nobody has to give`, { code: 'freshness.delegation', field: 'threshold' });
  if (!Number.isInteger(parentThreshold) || parentThreshold < 1) fail('the parent threshold is a whole number from 1', { code: 'freshness.delegation', field: 'parentThreshold' });
  if (threshold < parentThreshold) {
    fail(`'${to}' asks for ${threshold} signature(s) where its parent '${from}' asks for ${parentThreshold}: a delegation may not lower the bar its parent set`, { code: 'freshness.delegation', field: 'threshold' });
  }
  for (const path of paths) {
    if (!isCoveredBy(path, parentPaths)) {
      fail(`'${to}' asks to sign '${path}' and '${from}' covers ${parentPaths.join(', ')}: a delegation may narrow what it can sign, never widen it`, { code: 'freshness.delegation', field: 'paths' });
    }
  }
  const body = {
    contract: FRESHNESS_CONTRACT,
    schemaVersion: FRESHNESS_SCHEMA_VERSION,
    from,
    to,
    paths: Object.freeze([...paths].sort()),
    threshold,
    parentPaths: Object.freeze([...parentPaths]),
  };
  return Object.freeze({ ...body, delegationDigest: freshnessDigest(body) });
}

/** Thresholds are counts handed in by the caller, who owns verification. */
export function meetsThreshold(metadata, { thresholds = {} } = {}) {
  if (!isRoleMetadata(metadata)) fail('meetsThreshold reads metadata made by createRoleMetadata', { code: 'freshness.input', field: 'metadata' });
  const required = thresholds[metadata.role] ?? metadata.signatures.required;
  if (!Number.isInteger(required) || required < 1) fail(`threshold for '${metadata.role}' is '${String(required)}'`, { code: 'freshness.threshold', field: `thresholds.${metadata.role}` });
  return Object.freeze({
    ok: metadata.signatures.valid >= required,
    role: metadata.role,
    valid: metadata.signatures.valid,
    required,
    message: metadata.signatures.valid >= required
      ? `'${metadata.role}' carries ${metadata.signatures.valid} of ${required} valid signature(s)`
      : `silence is not a signature: '${metadata.role}' carries ${metadata.signatures.valid} of ${required}`,
  });
}

/* -------------------------------------------------------------------- reads */

export function describeFreshness(trusted) {
  if (!isTrustedState(trusted)) fail('describeFreshness reads a trusted state made by createTrustedState', { code: 'freshness.input', field: 'trusted' });
  const roles = Object.keys(trusted.roles).sort();
  const expiries = roles.map((role) => trusted.roles[role].expiresAt).filter((value) => value !== null);
  const body = {
    contract: FRESHNESS_CONTRACT,
    format: FRESHNESS_FORMAT,
    checkedAt: trusted.checkedAt,
    roles: Object.freeze(roles),
    versions: Object.freeze(Object.fromEntries(roles.map((role) => [role, trusted.roles[role].version]))),
    nextExpiryAt: expiries.length === 0 ? null : Math.min(...expiries),
    message: roles.length === 0
      ? 'nothing is trusted yet, so every role is a first contact'
      : `${roles.length} role(s) trusted, checked at tick ${trusted.checkedAt}`,
  };
  return Object.freeze({ ...body, stateDigest: trusted.stateDigest });
}

export function explainFreshness(result) {
  if (!result || typeof result !== 'object' || !FRESHNESS_VERDICTS.includes(result.verdict)) {
    fail('explainFreshness reads a result made by evaluateFreshness', { code: 'freshness.input', field: 'result' });
  }
  return `${result.verdict.toUpperCase()} — ${result.message}`;
}
