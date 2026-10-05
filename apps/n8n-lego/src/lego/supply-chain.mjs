/**
 * Supply-chain attestation, revocation, offline mirror — P6.12.
 *
 * PUBLIC CONTRACT (`node.supply-chain@0.1.0`, domain `node-registry`).
 *
 * An artifact digest answers one question — *"is this the same bytes?"* — and a
 * registry that stops there has proven nothing about those bytes. This contract
 * is the next question: **who says so, about what, and may they?**
 *
 *   STATEMENT    a builder attests a PREDICATE about a SUBJECT digest
 *   SIGNATURE    the statement is bound to its own bytes by a keyed digest
 *   POLICY       which builders may attest which packages, and which predicates
 *                are mandatory — data, not code, because a trust decision that is
 *                not written down is a preference
 *   REVOCATION   monotone by construction: an artifact, or a builder's key, can be
 *                revoked and NEVER un-revoked
 *   MIRROR       an air-gapped copy is still a copy: it is verified with exactly
 *                the same policy, and "we are offline" is not a reason to accept
 *                something
 *
 * THE TWO FAILURES ARE SEPARATE, ON PURPOSE. "The signature does not cover these
 * bytes" and "this builder was never allowed to assert this" are different
 * answers, and collapsing them into one boolean is how a supply-chain check
 * becomes a formality. Every verdict here names the failures it found, with the
 * code that says which kind it was.
 *
 * FAIL CLOSED MEANS THE ABSENCE IS DECIDED, NOT IGNORED. `allowUnattested: false`
 * is the default: no attestation is a refusal, not a shrug. An operator who
 * genuinely needs to run unattested artifacts (a local build, an air-gapped
 * import) says so in the policy — and then the decisions are marked
 * `unattested: true` so that the exemption is visible in the report instead of
 * invisible in the behaviour.
 *
 * REVOCATION IS THE ONE-WAY DOOR. A revocation list only grows: revoke is
 * idempotent, re-revoking with a different reason is refused (a revocation is
 * evidence, and evidence is not edited), and there is no `unrevoke` — a builder
 * whose key was compromised gets a new key, not their old reputation back.
 *
 * WHAT THIS IS NOT (P6.12 scope walls, enforced by tests):
 *   - it does not SIGN on behalf of anyone: `signAttestation` exists so a caller
 *     can produce a statement with a key IT holds, which is what makes the
 *     verification testable; the registry never invents a builder identity;
 *   - no asymmetric PKI, no certificate chains, no TUF freshness (P6.28) and no
 *     transparency log (P6.27): the binding is verified with a keyed digest, and
 *     where a caller needs signatures of another shape it verifies them itself
 *     and hands the statement in already marked;
 *   - no network, no mirror transport, no artifact store (P6.4), no health
 *     (P6.11) and no lifecycle (P6.10): a revoked artifact is reported here and
 *     the decision to quarantine the node stays with those contracts;
 *   - no clock: `tick` and validity windows are data.
 *
 * Authority: this contract reports what the evidence supports. It refuses an
 * installation decision when the evidence fails; it never grants trust.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const SUPPLY_CHAIN_CONTRACT = 'node.supply-chain@0.1.0';
export const SUPPLY_CHAIN_CONTRACT_VERSION = '0.1.0';
export const SUPPLY_CHAIN_SCHEMA_VERSION = 1;

export const SUPPLY_CHAIN_OPERATIONS = Object.freeze(['attest', 'verify', 'revoke', 'mirror', 'describe']);
export const SUPPLY_CHAIN_PERMISSIONS = Object.freeze(['node:read']);

/** What a builder may attest. A closed vocabulary: a new predicate is a decision. */
export const ATTESTATION_PREDICATES = Object.freeze([
  'build-provenance',
  'source-review',
  'vulnerability-scan',
  'reproducible-build',
  'ai-generation',
]);

/** Revocation applies to an artifact's bytes or to the builder that signed them. */
export const REVOCATION_TARGETS = Object.freeze(['artifact', 'builder']);

export const REVOCATION_ORIGINS = Object.freeze(['operator', 'vendor', 'scan', 'policy']);

export const SUPPLY_CHAIN_REASONS = Object.freeze([
  'supply.input',
  'supply.statement',
  'supply.subject',
  'supply.signature',
  'supply.builder',
  'supply.predicate',
  'supply.window',
  'supply.revoked',
  'supply.policy',
  'supply.mirror',
]);

export const SUPPLY_CHAIN_RULES = Object.freeze({
  binding: 'a statement is bound to its own bytes by a keyed digest: "the signature does not cover these bytes" and "this builder was never allowed to assert this" stay separate answers, because collapsing them is how a supply-chain check becomes a formality',
  subject: 'a statement is about a digest, and a statement about another digest is about another artifact — this is checked before anything else is believed',
  policy: 'which builders may attest which packages, and which predicates are mandatory, is DATA: a trust decision that is not written down is a preference',
  failClosed: 'an absent attestation is a refusal, not a shrug: allowUnattested is false by default, and where an operator allows it the decisions are marked so the exemption is visible in the report',
  revocation: 'revocation is the one-way door: the list only grows, re-revoking with a different reason is refused, and there is no unrevoke — a compromised key gets a new key, not its reputation back',
  mirror: 'an air-gapped copy is still a copy: it is verified with exactly the same policy, because "we are offline" is not a reason to accept something',
  authority: 'this contract reports what the evidence supports; it never grants trust and never invents a builder identity',
});

/* ------------------------------------------------------------------ *
 * Errors
 * ------------------------------------------------------------------ */

/** Raised for API misuse. Verification failures are returned as data. */
export class SupplyChainError extends Error {
  constructor(message, meta = {}) {
    super(message);
    this.name = 'SupplyChainError';
    this.code = 'lego.contract_violation';
    this.meta = Object.freeze({ ...meta });
  }
}

const fail = (message, meta) => { throw new SupplyChainError(message, meta); };
const isPlainObject = (value) => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};
const isNonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0;

function deepFreeze(value) {
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
    return Object.freeze(value);
  }
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    return Object.freeze(value);
  }
  return value;
}

const stableJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
};

const digestOf = (canonicalJson) => `sha256:${createHash('sha256').update(canonicalJson, 'utf8').digest('hex')}`;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

const requireDigest = (digest, field) => {
  if (typeof digest !== 'string' || !DIGEST_RE.test(digest)) {
    fail(`${field} must be a 'sha256:<64 hex>' digest: an unverifiable digest is not a digest`, { code: 'supply.input', field });
  }
  return digest;
};

const requireTick = (tick, field) => {
  if (!Number.isInteger(tick) || tick < 0) {
    fail(`${field} must be a non-negative integer tick: this contract has no clock`, { code: 'supply.input', field });
  }
  return tick;
};

/* ------------------------------------------------------------------ *
 * Statements and signing
 * ------------------------------------------------------------------ */

/** The bytes a signature covers: the statement without its signature. */
export function statementPayload(statement) {
  if (!isPlainObject(statement)) fail('statementPayload expects an attestation statement', { code: 'supply.statement' });
  const { signature, ...payload } = statement;
  return deepFreeze(payload);
}

const statementFailures = (statement) => {
  const failures = [];
  const push = (code, field, message) => failures.push({ code, field, message });
  if (!isPlainObject(statement)) {
    push('supply.statement', 'statement', 'an attestation statement must be an object');
    return failures;
  }
  if (!isNonEmptyString(statement.builder)) {
    push('supply.statement', 'builder', 'a statement must name the builder that makes it: an anonymous attestation attests nothing');
  }
  if (!ATTESTATION_PREDICATES.includes(statement.predicate)) {
    push('supply.predicate', 'predicate', `unknown predicate ${JSON.stringify(statement.predicate)} — expected one of ${ATTESTATION_PREDICATES.join(', ')}`);
  }
  if (!isPlainObject(statement.subject) || typeof statement.subject.digest !== 'string' || !DIGEST_RE.test(statement.subject.digest)) {
    push('supply.subject', 'subject.digest', "the subject must carry a 'sha256:<64 hex>' digest: a statement about an artifact is about those bytes");
  }
  if (!Number.isInteger(statement.issuedAtTick) || statement.issuedAtTick < 0) {
    push('supply.statement', 'issuedAtTick', 'a statement is issued at a tick, and the tick is data');
  }
  if (statement.expiresAtTick !== null && statement.expiresAtTick !== undefined
    && (!Number.isInteger(statement.expiresAtTick) || statement.expiresAtTick <= statement.issuedAtTick)) {
    push('supply.window', 'expiresAtTick', 'expiresAtTick must be an integer after issuedAtTick, or null for a statement that does not expire');
  }
  if (!isNonEmptyString(statement.keyId)) {
    push('supply.signature', 'keyId', 'a statement must name the key that signed it: a signature nobody can look up cannot be verified');
  }
  return failures;
};

/**
 * Produce a signed statement with a key the CALLER holds. The registry never
 * signs on anyone's behalf; this exists so that verification is testable and so
 * that a builder inside the platform has a defined way to speak.
 */
export function signAttestation(statement, { keyId, secret } = {}) {
  const failures = statementFailures({ keyId, issuedAtTick: 0, ...statement });
  if (failures.length > 0) {
    fail(`the statement cannot be signed: ${failures.map((entry) => entry.message).join('; ')}`, { code: 'supply.statement', field: 'statement' });
  }
  if (!isNonEmptyString(keyId)) fail('signAttestation needs a keyId', { code: 'supply.input', field: 'keyId' });
  if (!isNonEmptyString(secret)) fail('signAttestation needs the secret it signs with: a signature without a key is a claim', { code: 'supply.input', field: 'secret' });
  const payload = stableJson(statementPayload({ ...statement, keyId }));
  const signature = `hmac-sha256:${createHmac('sha256', secret).update(payload, 'utf8').digest('hex')}`;
  return deepFreeze({ ...statementPayload({ ...statement, keyId }), keyId, signature });
}

const signatureCovers = (statement, { keyId, secret }) => {
  const payload = stableJson(statementPayload(statement));
  const expected = `hmac-sha256:${createHmac('sha256', secret).update(payload, 'utf8').digest('hex')}`;
  const given = statement.signature;
  if (typeof given !== 'string' || given.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(given, 'utf8'), Buffer.from(expected, 'utf8'));
};

/* ------------------------------------------------------------------ *
 * Policy
 * ------------------------------------------------------------------ */

/**
 * Which builders may attest what. `builders` maps a builder id to the packages
 * it may attest (`'*'` for any package, which is a decision an operator makes
 * deliberately and never a default), plus the predicates it may assert.
 */
export function createAttestationPolicy({
  policyId, builders = {}, requiredPredicates = [], allowUnattested = false,
} = {}) {
  if (!isNonEmptyString(policyId)) {
    fail('an attestation policy must name itself: an anonymous policy cannot be cited when a decision is questioned', { code: 'supply.policy', field: 'policyId' });
  }
  if (!isPlainObject(builders) || Object.keys(builders).length === 0) {
    fail('a policy must name at least one builder: a policy that trusts nobody is not a policy, it is a refusal to build one', { code: 'supply.policy', field: 'builders' });
  }
  const normalized = {};
  for (const builder of Object.keys(builders).sort()) {
    const entry = builders[builder];
    if (!isPlainObject(entry)) fail(`builder '${builder}' rules must be an object`, { code: 'supply.policy', field: 'builders' });
    const packages = Array.isArray(entry.packages) ? [...new Set(entry.packages)] : null;
    if (!packages || packages.length === 0) {
      fail(`builder '${builder}' must declare which packages it may attest: an unrestricted builder is a decision, not an omission (say ['*'])`, { code: 'supply.policy', field: 'builders' });
    }
    const predicates = Array.isArray(entry.predicates) ? [...new Set(entry.predicates)] : null;
    if (!predicates || predicates.length === 0) {
      fail(`builder '${builder}' must declare which predicates it may assert`, { code: 'supply.policy', field: 'builders' });
    }
    for (const predicate of predicates) {
      if (!ATTESTATION_PREDICATES.includes(predicate)) {
        fail(`builder '${builder}' claims an unknown predicate ${JSON.stringify(predicate)}`, { code: 'supply.predicate', field: 'builders' });
      }
    }
    normalized[builder] = Object.freeze({
      packages: Object.freeze(packages.sort()),
      predicates: Object.freeze(predicates.sort()),
      keyIds: Object.freeze(Array.isArray(entry.keyIds) ? [...new Set(entry.keyIds)].sort() : []),
    });
  }
  for (const predicate of requiredPredicates) {
    if (!ATTESTATION_PREDICATES.includes(predicate)) {
      fail(`requiredPredicates names an unknown predicate ${JSON.stringify(predicate)}`, { code: 'supply.predicate', field: 'requiredPredicates' });
    }
  }
  return deepFreeze({
    ok: true,
    schemaVersion: SUPPLY_CHAIN_SCHEMA_VERSION,
    contract: SUPPLY_CHAIN_CONTRACT,
    policyId,
    builders: Object.freeze(normalized),
    requiredPredicates: Object.freeze([...new Set(requiredPredicates)].sort()),
    allowUnattested,
    policyDigest: digestOf(stableJson({ policyId, builders: normalized, requiredPredicates: [...new Set(requiredPredicates)].sort(), allowUnattested })),
  });
}

/** @returns {boolean} whether `value` is an attestation policy this contract produced. */
export function isAttestationPolicy(value) {
  return (
    isPlainObject(value) &&
    value.ok === true &&
    value.contract === SUPPLY_CHAIN_CONTRACT &&
    isPlainObject(value.builders) &&
    typeof value.policyDigest === 'string' &&
    Object.isFrozen(value)
  );
}

/** May this builder assert this predicate about this package at all? */
export function mayBuilderAttest(policy, { builder, packageName, predicate } = {}) {
  if (!isAttestationPolicy(policy)) fail('mayBuilderAttest expects a policy from createAttestationPolicy', { code: 'supply.policy' });
  const rules = policy.builders[builder];
  if (!rules) {
    return deepFreeze({ allowed: false, reason: 'supply.builder', message: `builder '${builder}' is not named by policy '${policy.policyId}': an unnamed builder is not a partially trusted one, it is an unknown one` });
  }
  if (!rules.packages.includes('*') && !rules.packages.includes(packageName)) {
    return deepFreeze({ allowed: false, reason: 'supply.builder', message: `builder '${builder}' may not attest package '${packageName}' (it attests ${rules.packages.join(', ')})` });
  }
  if (!rules.predicates.includes(predicate)) {
    return deepFreeze({ allowed: false, reason: 'supply.predicate', message: `builder '${builder}' may not assert '${predicate}' (it may assert ${rules.predicates.join(', ')})` });
  }
  return deepFreeze({ allowed: true, reason: null, message: null });
}

/* ------------------------------------------------------------------ *
 * Verification
 * ------------------------------------------------------------------ */

/**
 * Which failure a report leads with, when there is more than one. `reasons` stays
 * sorted so two runs agree byte for byte; `primaryReason` picks the one a reader
 * has to act on first — a revoked artifact is not primarily a missing attestation.
 */
export const SUPPLY_REASON_PRIORITY = Object.freeze([
  'supply.revoked', 'supply.signature', 'supply.subject', 'supply.window',
  'supply.builder', 'supply.statement', 'supply.predicate', 'supply.policy', 'supply.mirror', 'supply.input',
]);

/** The most consequential of a set of failure reasons. */
export function primarySupplyReason(reasons = []) {
  if (!Array.isArray(reasons)) fail('primarySupplyReason expects an array of reasons', { code: 'supply.input', field: 'reasons' });
  for (const reason of SUPPLY_REASON_PRIORITY) if (reasons.includes(reason)) return reason;
  return reasons[0] ?? null;
}

/**
 * Verify one statement against one artifact digest.
 *
 * @param {object} statement a signed attestation (or a bare statement, which fails)
 * @param {{ digest: string, policy: object, keyring?: object, revocations?: object, tick: number, packageName?: string }} options
 * @returns {Readonly<object>} a verdict that names every failure it found
 */
export function verifyAttestation(statement, { digest, policy, keyring = {}, revocations = null, tick, packageName = null } = {}) {
  if (!isAttestationPolicy(policy)) fail('verifyAttestation expects a policy from createAttestationPolicy', { code: 'supply.policy' });
  requireDigest(digest, 'digest');
  requireTick(tick, 'tick');

  // The statement carries the package it is about; a caller that passes one is
  // asserting the same fact twice, and a caller that does not is never asked to
  // repeat what the evidence already says.
  const targetPackage = packageName ?? (isPlainObject(statement?.subject) ? statement.subject.packageName ?? null : null);

  const failures = [];
  const structural = statementFailures(statement);
  failures.push(...structural);
  if (structural.length > 0) {
    return verdictOf(statement, digest, failures, { packageName: targetPackage });
  }

  // 1. The statement must be about THESE bytes. Checked before anything else is
  //    believed, because a perfectly signed statement about another artifact is
  //    perfectly useless.
  if (statement.subject.digest !== digest) {
    failures.push({
      code: 'supply.subject', field: 'subject.digest',
      message: `the statement is about ${statement.subject.digest} and the artifact is ${digest}: a statement about another artifact is about another artifact`,
    });
  }

  // 2. The signature must cover exactly the statement's own bytes.
  const secret = keyring[statement.keyId];
  if (!isNonEmptyString(secret)) {
    failures.push({
      code: 'supply.signature', field: 'keyId',
      message: `no key '${statement.keyId}' in the keyring: an unverifiable signature is not a verified one`,
    });
  } else if (!signatureCovers(statement, { keyId: statement.keyId, secret })) {
    failures.push({
      code: 'supply.signature', field: 'signature',
      message: 'the signature does not cover these bytes: the statement was edited after it was signed, or signed with another key',
    });
  }

  // 3. The builder must have been allowed to say it in the first place.
  const allowed = mayBuilderAttest(policy, { builder: statement.builder, packageName: targetPackage, predicate: statement.predicate });
  if (!allowed.allowed) failures.push({ code: allowed.reason, field: 'builder', message: allowed.message });
  const rules = policy.builders[statement.builder];
  if (rules && rules.keyIds.length > 0 && !rules.keyIds.includes(statement.keyId)) {
    failures.push({
      code: 'supply.signature', field: 'keyId',
      message: `builder '${statement.builder}' does not hold key '${statement.keyId}': a key is not transferable evidence`,
    });
  }

  // 4. The window, then revocation: an expired statement is stale evidence, and a
  //    revoked subject is not evidence at all.
  if (statement.expiresAtTick !== null && statement.expiresAtTick !== undefined && tick > statement.expiresAtTick) {
    failures.push({
      code: 'supply.window', field: 'expiresAtTick',
      message: `the statement expired at tick ${statement.expiresAtTick} and this is tick ${tick}: stale evidence is not evidence`,
    });
  }
  if (revocations) {
    if (isRevoked(revocations, digest)) {
      failures.push({ code: 'supply.revoked', field: 'subject.digest', message: `artifact ${digest} is revoked: ${revocationOf(revocations, digest).reason}` });
    }
    if (isBuilderRevoked(revocations, statement.builder)) {
      failures.push({ code: 'supply.revoked', field: 'builder', message: `builder '${statement.builder}' is revoked: ${revocationOfBuilder(revocations, statement.builder).reason}` });
    }
  }
  return verdictOf(statement, digest, failures, { packageName: targetPackage });
}

const verdictOf = (statement, digest, failures, { packageName }) => deepFreeze({
  ok: failures.length === 0,
  schemaVersion: SUPPLY_CHAIN_SCHEMA_VERSION,
  contract: SUPPLY_CHAIN_CONTRACT,
  digest,
  builder: isPlainObject(statement) ? statement.builder ?? null : null,
  predicate: isPlainObject(statement) ? statement.predicate ?? null : null,
  packageName,
  verified: failures.length === 0,
  failures: Object.freeze(failures.map((failure) => Object.freeze({ ...failure }))),
  reasons: Object.freeze([...new Set(failures.map((failure) => failure.code))].sort()),
  primaryReason: failures.length === 0 ? null : primarySupplyReason([...new Set(failures.map((failure) => failure.code))]),
  message: failures.length === 0 ? null : failures.map((failure) => failure.message).join('; '),
});

/** Verify a set of statements: all required predicates must be covered, and each must verify. */
export function verifyAttestations(statements, { digest, policy, keyring = {}, revocations = null, tick, packageName = null } = {}) {
  if (!isAttestationPolicy(policy)) fail('verifyAttestations expects a policy from createAttestationPolicy', { code: 'supply.policy' });
  if (!Array.isArray(statements)) fail('statements must be an array: a set of attestations is a set, and an empty one is not a set', { code: 'supply.input', field: 'statements' });
  requireDigest(digest, 'digest');
  requireTick(tick, 'tick');

  const verdicts = statements.map((statement) => verifyAttestation(statement, { digest, policy, keyring, revocations, tick, packageName }));
  const verifiedPredicates = [...new Set(verdicts.filter((verdict) => verdict.verified).map((verdict) => verdict.predicate))].sort();
  const missing = policy.requiredPredicates.filter((predicate) => !verifiedPredicates.includes(predicate));
  const failures = [];
  // Revocation is checked on the SUBJECT, not only on the statements: an artifact
  // with no attestations at all is exactly the case an exemption would otherwise
  // wave through, and a revoked artifact is revoked whether or not anyone signed
  // anything about it.
  if (revocations && isRevoked(revocations, digest)) {
    failures.push({
      code: 'supply.revoked', field: 'digest',
      message: `artifact ${digest} is revoked: ${revocationOf(revocations, digest).reason}`,
    });
  }
  if (statements.length === 0 && policy.requiredPredicates.length > 0) {
    failures.push({
      code: 'supply.statement', field: 'statements',
      message: `no attestation was supplied and policy '${policy.policyId}' requires ${policy.requiredPredicates.join(', ')}: an absent attestation is a refusal, not a shrug`,
    });
  }
  if (missing.length > 0) {
    failures.push({
      code: 'supply.predicate', field: 'requiredPredicates',
      message: `required predicate(s) ${missing.join(', ')} are not covered by any VERIFIED statement: an unverified statement covers nothing`,
    });
  }
  return deepFreeze({
    ok: failures.length === 0,
    schemaVersion: SUPPLY_CHAIN_SCHEMA_VERSION,
    contract: SUPPLY_CHAIN_CONTRACT,
    digest,
    packageName,
    verdicts: Object.freeze(verdicts),
    verifiedPredicates: Object.freeze(verifiedPredicates),
    missingPredicates: Object.freeze(missing),
    failures: Object.freeze(failures.map((failure) => Object.freeze({ ...failure }))),
    reasons: Object.freeze([...new Set([...failures.map((failure) => failure.code), ...verdicts.flatMap((verdict) => verdict.reasons)])].sort()),
    message: failures.length === 0 ? null : failures.map((failure) => failure.message).join('; '),
  });
}

/* ------------------------------------------------------------------ *
 * Revocation: the one-way door
 * ------------------------------------------------------------------ */

const emptyRevocations = () => ({
  ok: true,
  schemaVersion: SUPPLY_CHAIN_SCHEMA_VERSION,
  contract: SUPPLY_CHAIN_CONTRACT,
  artifacts: Object.freeze({}),
  builders: Object.freeze({}),
  events: Object.freeze([]),
});

/** A revocation list: artifacts and builders, and it only ever grows. */
export function createRevocationList(entries = {}) {
  if (!isPlainObject(entries)) fail('createRevocationList expects an object of entries', { code: 'supply.input', field: 'entries' });
  let list = emptyRevocations();
  for (const entry of Array.isArray(entries) ? entries : []) {
    list = revokeArtifact(list, entry).list ?? list;
  }
  return deepFreeze(list);
}

/** @returns {boolean} whether `value` is a revocation list this contract produced. */
export function isRevocationList(value) {
  return isPlainObject(value) && value.contract === SUPPLY_CHAIN_CONTRACT && isPlainObject(value.artifacts) && isPlainObject(value.builders) && Object.isFrozen(value);
}

const requireRevocations = (list, fn) => {
  if (!isRevocationList(list)) fail(`${fn} expects a revocation list from createRevocationList`, { code: 'supply.input', field: 'revocations' });
};

const revoke = (list, target, subject, { reason, origin = 'operator', tick }) => {
  requireRevocations(list, 'revoke');
  if (!REVOCATION_TARGETS.includes(target)) {
    fail(`unknown revocation target ${JSON.stringify(target)} — expected one of ${REVOCATION_TARGETS.join(', ')}`, { code: 'supply.input', field: 'target' });
  }
  if (!REVOCATION_ORIGINS.includes(origin)) {
    fail(`unknown revocation origin ${JSON.stringify(origin)} — expected one of ${REVOCATION_ORIGINS.join(', ')}`, { code: 'supply.input', field: 'origin' });
  }
  if (!isNonEmptyString(reason)) {
    fail('a revocation needs a reason: evidence is not edited, and an unexplained revocation cannot be reviewed', { code: 'supply.input', field: 'reason' });
  }
  requireTick(tick, 'tick');
  if (target === 'artifact') requireDigest(subject, 'digest');
  const bucket = target === 'artifact' ? list.artifacts : list.builders;
  const existing = bucket[subject];
  if (existing) {
    if (existing.reason === reason && existing.origin === origin) {
      return deepFreeze({ ok: true, changed: false, target, subject, list, message: null });
    }
    return deepFreeze({
      ok: false, changed: false, target, subject, list, reason: 'supply.revoked',
      message: `'${subject}' is already revoked (${existing.origin}: ${existing.reason}); a revocation is evidence and evidence is not edited — revoke the new thing instead`,
    });
  }
  const next = deepFreeze({
    ...list,
    artifacts: target === 'artifact' ? Object.freeze({ ...list.artifacts, [subject]: Object.freeze({ reason, origin, tick }) }) : list.artifacts,
    builders: target === 'builder' ? Object.freeze({ ...list.builders, [subject]: Object.freeze({ reason, origin, tick }) }) : list.builders,
    events: Object.freeze([...list.events, Object.freeze({ target, subject, reason, origin, tick })]),
  });
  return deepFreeze({ ok: true, changed: true, target, subject, list: next, message: null });
};

/** Revoke an artifact's bytes. Permanent, idempotent, and never editable. */
export function revokeArtifact(list, { digest, reason, origin = 'operator', tick } = {}) {
  return revoke(list, 'artifact', digest, { reason, origin, tick });
}

/** Revoke a builder. A compromised key gets a new key, not its reputation back. */
export function revokeBuilder(list, { builder, reason, origin = 'operator', tick } = {}) {
  if (!isNonEmptyString(builder)) fail('revokeBuilder needs a builder id', { code: 'supply.input', field: 'builder' });
  return revoke(list, 'builder', builder, { reason, origin, tick });
}

/** @returns {boolean} whether an artifact's bytes are revoked. */
export function isRevoked(list, digest) {
  requireRevocations(list, 'isRevoked');
  return Object.prototype.hasOwnProperty.call(list.artifacts, digest);
}

/** @returns {boolean} whether a builder is revoked. */
export function isBuilderRevoked(list, builder) {
  requireRevocations(list, 'isBuilderRevoked');
  return Object.prototype.hasOwnProperty.call(list.builders, builder);
}

const revocationOf = (list, digest) => list.artifacts[digest];
const revocationOfBuilder = (list, builder) => list.builders[builder];

/** The reasons a subject is revoked, or null. Reads do not create entries. */
export function revocationReason(list, { digest, builder } = {}) {
  requireRevocations(list, 'revocationReason');
  if (isNonEmptyString(digest) && isRevoked(list, digest)) return revocationOf(list, digest).reason;
  if (isNonEmptyString(builder) && isBuilderRevoked(list, builder)) return revocationOfBuilder(list, builder).reason;
  return null;
}

/* ------------------------------------------------------------------ *
 * Offline mirror
 * ------------------------------------------------------------------ */

/**
 * Describe an air-gapped copy. A mirror is DATA: no transport, no directory, no
 * network. Whatever a caller copies onto a disk, this is what it must be able to
 * say about it.
 */
export function mirrorManifest({ mirrorId, source, artifacts = [] } = {}) {
  if (!isNonEmptyString(mirrorId)) fail('a mirror must name itself: an anonymous mirror cannot be cited when a decision is questioned', { code: 'supply.mirror', field: 'mirrorId' });
  if (!isNonEmptyString(source)) fail('a mirror must name its source: a copy of an unknown origin is not evidence', { code: 'supply.mirror', field: 'source' });
  if (!Array.isArray(artifacts)) fail('artifacts must be an array', { code: 'supply.input', field: 'artifacts' });
  const entries = [];
  for (const artifact of artifacts) {
    if (!isPlainObject(artifact)) fail('each artifact must be an object', { code: 'supply.mirror', field: 'artifacts' });
    if (!isNonEmptyString(artifact.packageName)) fail('each artifact must name its package', { code: 'supply.mirror', field: 'artifacts' });
    requireDigest(artifact.digest, 'artifacts[].digest');
    if (artifact.attestations !== undefined && !Array.isArray(artifact.attestations)) {
      fail('artifacts[].attestations must be an array when present', { code: 'supply.mirror', field: 'artifacts' });
    }
    entries.push(Object.freeze({
      packageName: artifact.packageName,
      digest: artifact.digest,
      attestations: Object.freeze([...(artifact.attestations ?? [])]),
    }));
  }
  entries.sort((left, right) => (left.packageName === right.packageName ? (left.digest < right.digest ? -1 : 1) : (left.packageName < right.packageName ? -1 : 1)));
  return deepFreeze({
    ok: true,
    schemaVersion: SUPPLY_CHAIN_SCHEMA_VERSION,
    contract: SUPPLY_CHAIN_CONTRACT,
    mirrorId,
    source,
    artifacts: Object.freeze(entries),
    manifestDigest: digestOf(stableJson({ mirrorId, source, artifacts: entries.map((entry) => [entry.packageName, entry.digest, entry.attestations.length]) })),
  });
}

/** @returns {boolean} whether `value` is a mirror manifest this contract produced. */
export function isMirrorManifest(value) {
  return isPlainObject(value) && value.ok === true && value.contract === SUPPLY_CHAIN_CONTRACT && Array.isArray(value.artifacts) && typeof value.manifestDigest === 'string' && Object.isFrozen(value);
}

/**
 * Decide what an offline import may install. The SAME policy verifies it, because
 * being offline is not a reason to accept something — it is a reason to keep the
 * policy on the disk next to the mirror.
 */
export function verifyMirror(mirror, { policy, keyring = {}, revocations = null, tick } = {}) {
  if (!isMirrorManifest(mirror)) fail('verifyMirror expects a manifest from mirrorManifest', { code: 'supply.mirror' });
  if (!isAttestationPolicy(policy)) fail('verifyMirror expects a policy from createAttestationPolicy', { code: 'supply.policy' });
  requireTick(tick, 'tick');

  const decisions = mirror.artifacts.map((artifact) => {
    const verdict = verifyAttestations(artifact.attestations, {
      digest: artifact.digest, policy, keyring, revocations, tick, packageName: artifact.packageName,
    });
    if (verdict.ok) {
      return Object.freeze({
        packageName: artifact.packageName, digest: artifact.digest, install: true, unattested: false,
        reason: null, verifiedPredicates: verdict.verifiedPredicates, message: null,
      });
    }
    if (policy.allowUnattested && artifact.attestations.length === 0 && !verdict.reasons.includes('supply.revoked')) {
      return Object.freeze({
        packageName: artifact.packageName, digest: artifact.digest, install: true, unattested: true,
        reason: null, verifiedPredicates: Object.freeze([]),
        message: `policy '${policy.policyId}' allows unattested artifacts; this one installs UNATTESTED and is marked so`,
      });
    }
    return Object.freeze({
      packageName: artifact.packageName, digest: artifact.digest, install: false, unattested: false,
      reason: primarySupplyReason([...verdict.reasons]), verifiedPredicates: verdict.verifiedPredicates, message: verdict.message,
    });
  });

  const refusals = decisions.filter((decision) => !decision.install);
  const unattested = decisions.filter((decision) => decision.unattested);
  return deepFreeze({
    ok: refusals.length === 0,
    schemaVersion: SUPPLY_CHAIN_SCHEMA_VERSION,
    contract: SUPPLY_CHAIN_CONTRACT,
    mirrorId: mirror.mirrorId,
    source: mirror.source,
    manifestDigest: mirror.manifestDigest,
    decisions: Object.freeze(decisions),
    installable: Object.freeze(decisions.filter((decision) => decision.install).map((decision) => decision.packageName)),
    refused: Object.freeze(refusals.map((decision) => decision.packageName)),
    unattested: Object.freeze(unattested.map((decision) => decision.packageName)),
    reasons: Object.freeze([...new Set(refusals.map((decision) => decision.reason))].sort()),
    primaryReason: primarySupplyReason(refusals.map((decision) => decision.reason)),
    message: refusals.length === 0
      ? (unattested.length > 0 ? `${unattested.length} artifact(s) install unattested under an explicit policy exemption` : null)
      : `${refusals.length} artifact(s) refused: ${refusals.map((decision) => `${decision.packageName} (${decision.reason})`).join(', ')}`,
  });
}

/* ------------------------------------------------------------------ *
 * Reads
 * ------------------------------------------------------------------ */

/** A sentence a human can check, and a rollout can be stopped by. */
export function explainSupplyVerdict(result) {
  if (!isPlainObject(result) || result.contract !== SUPPLY_CHAIN_CONTRACT) {
    fail('explainSupplyVerdict expects a verdict, a set of verdicts or a mirror verification', { got: typeof result });
  }
  if (Array.isArray(result.decisions)) {
    if (result.ok) return `mirror '${result.mirrorId}' verified: ${result.installable.length} artifact(s) installable`;
    return `mirror '${result.mirrorId}' refused: ${result.message}`;
  }
  if (Array.isArray(result.verdicts)) {
    if (result.ok) return `attested: ${result.verifiedPredicates.join(', ')} cover ${result.digest}`;
    return `not attested: ${result.message}`;
  }
  if (result.verified) return `'${result.builder}' attests '${result.predicate}' about ${result.digest}`;
  return `unverified: ${result.message}`;
}

/** Counts, policy identity and refusal kinds — the shape an operations page wants. */
export function describeSupplyChain({ policy, revocations, mirror } = {}) {
  const described = {};
  if (isAttestationPolicy(policy)) {
    described.policy = Object.freeze({
      policyId: policy.policyId,
      policyDigest: policy.policyDigest,
      builders: Object.keys(policy.builders).sort(),
      requiredPredicates: policy.requiredPredicates,
      allowUnattested: policy.allowUnattested,
    });
  }
  if (isRevocationList(revocations)) {
    described.revocations = Object.freeze({
      artifacts: Object.keys(revocations.artifacts).sort(),
      builders: Object.keys(revocations.builders).sort(),
      eventCount: revocations.events.length,
    });
  }
  if (isMirrorManifest(mirror)) {
    described.mirror = Object.freeze({
      mirrorId: mirror.mirrorId,
      source: mirror.source,
      manifestDigest: mirror.manifestDigest,
      artifactCount: mirror.artifacts.length,
      packages: Object.freeze(mirror.artifacts.map((artifact) => artifact.packageName)),
    });
  }
  return deepFreeze(described);
}

export const SUPPLY_CHAIN_INPUT_SCHEMA_VERSION = SUPPLY_CHAIN_SCHEMA_VERSION;
