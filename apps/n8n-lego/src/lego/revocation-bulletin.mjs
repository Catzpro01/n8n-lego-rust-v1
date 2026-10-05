/**
 * node.revocation@0.1.0 — emergency revocation bulletins.
 *
 * P6 milestone 20 of 31 (Issue #100). Normal change reaches the runtime through epochs:
 * compiled, hash-linked, witnessed (P6.13, P6.16). A security emergency cannot wait for
 * that path. This contract is the other channel — and the whole difficulty is keeping it
 * from becoming a second registry with weaker rules.
 *
 * What that means in practice:
 *
 *  - A BULLETIN BINDS TO A BASELINE EPOCH. It is issued against an epoch digest, so it is
 *    dated evidence about a specific registry state, not a floating accusation. Applying a
 *    bulletin to an epoch OLDER than its baseline is refused: you cannot un-see a change.
 *  - OFF-BAND, NOT OUT-OF-CONTROL. Bulletins arrive outside the epoch chain, so they carry
 *    their own monotone sequence and their own client-side witness; a replayed or forked
 *    bulletin is refused by a client that has seen a newer one, without the registry's
 *    help. Fail closed without an explicit `firstContact`.
 *  - TIME-BOXED AUTHORITY, NOT TIME-BOXED EFFECT. A bulletin is `pending`, `active`, or
 *    `lapsed` at a tick, and the window is bounded — an emergency is not a standing policy.
 *    BUT A LAPSED BULLETIN STILL DENIES. It stops being authority and starts being an
 *    undecided matter: somebody must dispose of it (`uphold` into something durable, or
 *    `lift` on the record). An emergency that silently expires is a rollback nobody decided.
 *  - UPHOLDING MUST LAND SOMEWHERE DURABLE. `uphold` requires a `durableRef` — this contract
 *    cannot make a revocation permanent, and a disposition that claims otherwise is refused.
 *  - THE DECISION IS ONE FUNCTION. `decideSubject` answers deny/allow for a subject at a
 *    tick; unknown subject kinds, subjects named by an undisposed lapsed bulletin, and
 *    anything it cannot read fail closed.
 *
 * Scope walls (enforced by tests): no epoch mutation (P6.13/P6.16), no attestation or
 * signature verification (P6.12), no admission verdict (P6.8/P6.17), no rollout (P6.19), no
 * health or lease decisions (P6.10/P6.11). No filesystem, network, clock, randomness or
 * shared-state mutation — the only `node:` import is the hash. Nothing here reads a clock:
 * every answer takes the tick it answers for.
 *
 * Authority: a bulletin denies work. It never grants it, never repairs a registry, and
 * never becomes a permanent rule by being left lying around.
 */
import { createHash } from 'node:crypto';
import { isFrozenRegistryEpoch } from './registry-compiler.mjs';

export const BULLETIN_CONTRACT = 'node.revocation@0.1.0';
export const BULLETIN_CONTRACT_VERSION = '0.1.0';
export const BULLETIN_SCHEMA_VERSION = 1;

export const BULLETIN_OPERATIONS = Object.freeze(['issue', 'evaluate', 'dispose', 'witness', 'describe']);
export const BULLETIN_PERMISSIONS = Object.freeze(['node:read']);

/** What can be named in a bulletin. A bulletin that named nothing would deny nothing. */
export const SUBJECT_KINDS = Object.freeze(['identity', 'package', 'artifact']);

/** How a bulletin stands at a given tick, before any disposition. */
export const BULLETIN_STATES = Object.freeze(['pending', 'active', 'lapsed']);

/** The two ways an emergency may end. There is no third, and neither is silent. */
export const DISPOSITIONS = Object.freeze(['uphold', 'lift']);

/** How a subject stands once the dispositions are read. */
export const SUBJECT_DECISIONS = Object.freeze(['deny', 'allow']);

/** An emergency window is bounded: beyond this, the durable path is the answer, not a bulletin. */
export const MAX_BULLETIN_TICKS = 720;
export const MAX_SUBJECTS = 100;

export const BULLETIN_REASONS = Object.freeze([
  'revocation.input', 'revocation.epoch', 'revocation.window', 'revocation.subject', 'revocation.sequence', 'revocation.disposition', 'revocation.state',
]);

export const BULLETIN_RULES = Object.freeze({
  baseline: 'a bulletin is issued against an epoch digest; applying it to an older epoch is refused, because a change cannot be un-seen',
  offBand: 'bulletins arrive outside the epoch chain, so they carry their own sequence and their own witness',
  window: 'a bulletin is pending, then active, then lapsed; the window is bounded, because an emergency is not a standing policy',
  lapse: 'a lapsed bulletin stops being authority and starts being an undecided matter: it keeps denying until somebody disposes of it',
  uphold: 'upholding requires a durable reference; this contract cannot make a revocation permanent and will not pretend to',
  lift: 'lifting is recorded with an actor, a reason and a tick, because reopening is a decision like any other',
  replay: 'a client that has seen a newer bulletin refuses an older one without asking the registry',
  unknown: 'an unreadable subject, an unknown kind or a bulletin nobody can verify denies by default',
  authority: 'a bulletin denies work; it never grants it, and it never repairs a registry',
});

export class BulletinError extends Error {
  constructor(message, { code = 'revocation.input', meta = {} } = {}) {
    super(message);
    this.name = 'BulletinError';
    this.code = 'lego.contract_violation';
    this.meta = { code, ...meta };
  }
}

const fail = (message, detail = {}) => { throw new BulletinError(message, detail); };

const isNonEmptyString = (value) => typeof value === 'string' && value.length > 0;
const isTick = (value) => Number.isInteger(value) && value >= 0;

/** Canonical JSON: key order must not change a digest. */
export function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

/** A digest over a set of fields, so a bulletin is identifiable by content. */
export function bulletinDigest(fields) {
  return sha256(stableJson(fields ?? {}));
}

/**
 * Two digests are the same digest whichever spelling they arrived in. A chain compared by
 * raw string would report a perfectly linked bulletin as unlinked, which is a false alarm
 * on the one channel that cannot afford one.
 */
const sameDigest = (left, right) => {
  try {
    return normalizeDigest(left) === normalizeDigest(right);
  } catch {
    return false;
  }
};

/** P6.2 publishes bare hex in one place and `sha256:`-prefixed hex in another; both mean one digest. */
export function normalizeDigest(value) {
  if (!isNonEmptyString(value)) fail('a digest is a value, not a hope', { code: 'revocation.input', field: 'digest' });
  const bare = value.startsWith('sha256:') ? value.slice('sha256:'.length) : value;
  if (!/^[0-9a-f]{64}$/.test(bare)) fail(`'${value}' is not a sha256 digest`, { code: 'revocation.input', field: 'digest' });
  return `sha256:${bare}`;
}

/**
 * A bulletin is data: who issued it, what it names, why, and the window it is authority in.
 * `previousDigest` links it to the bulletin before it, which is what makes a replay visible.
 */
export function issueBulletin({
  id, sequence, issuedBy, issuedAt, effectiveFrom, expiresAt, subjects, reason, baseline, previousDigest = null, durableRef = null,
} = {}) {
  if (!isNonEmptyString(id)) fail('a bulletin needs an id: an unnamed emergency cannot be cited later', { code: 'revocation.input', field: 'id' });
  if (!isNonEmptyString(issuedBy)) fail('a bulletin names who issued it: an anonymous emergency is a rumour', { code: 'revocation.input', field: 'issuedBy' });
  if (!Number.isInteger(sequence) || sequence < 1) fail('a bulletin carries a sequence starting at 1', { code: 'revocation.sequence', field: 'sequence' });
  if (!isTick(issuedAt)) fail('a bulletin records the tick it was issued at', { code: 'revocation.input', field: 'issuedAt' });
  if (sequence === 1 && previousDigest !== null) {
    fail('the first bulletin in a sequence has nothing before it: a previousDigest here would point at nothing', { code: 'revocation.sequence', field: 'previousDigest' });
  }
  if (sequence > 1 && !isNonEmptyString(previousDigest)) {
    fail(`sequence ${sequence} must link to the bulletin before it: an unlinked bulletin cannot be ordered against a replay`, { code: 'revocation.sequence', field: 'previousDigest' });
  }
  if (!isFrozenRegistryEpoch(baseline)) {
    fail('a bulletin is issued against a compiled epoch: without a baseline it is an accusation with no registry behind it', { code: 'revocation.epoch', field: 'baseline' });
  }
  const baselineDigest = normalizeDigest(baseline.epochDigest ?? baseline.digest);
  const window = normalizeWindow({ effectiveFrom, expiresAt });
  const named = normalizeSubjects(subjects);
  if (!isNonEmptyString(reason)) fail('a bulletin states a reason a human can read', { code: 'revocation.input', field: 'reason' });

  const body = {
    contract: BULLETIN_CONTRACT,
    schemaVersion: BULLETIN_SCHEMA_VERSION,
    id,
    sequence,
    issuedBy,
    issuedAt,
    effectiveFrom: window.effectiveFrom,
    expiresAt: window.expiresAt,
    baselineDigest,
    baselineNumber: Number.isInteger(baseline.epochNumber) ? baseline.epochNumber : null,
    subjects: named,
    reason,
    previousDigest: previousDigest === null ? null : normalizeDigest(previousDigest),
    durableRef: isNonEmptyString(durableRef) ? durableRef : null,
  };
  return Object.freeze({ ...body, bulletinDigest: bulletinDigest(body) });
}

function normalizeWindow({ effectiveFrom, expiresAt }) {
  if (!isTick(effectiveFrom) || !isTick(expiresAt)) {
    fail('a bulletin declares effectiveFrom and expiresAt: an emergency without a window never ends', { code: 'revocation.window', field: 'window' });
  }
  if (expiresAt <= effectiveFrom) {
    fail(`the window ends before it starts (${effectiveFrom} → ${expiresAt})`, { code: 'revocation.window', field: 'expiresAt' });
  }
  if (expiresAt - effectiveFrom > MAX_BULLETIN_TICKS) {
    fail(`an emergency window of ${expiresAt - effectiveFrom} ticks exceeds ${MAX_BULLETIN_TICKS}: a standing policy belongs on the durable path`, { code: 'revocation.window', field: 'expiresAt' });
  }
  return { effectiveFrom, expiresAt };
}

function normalizeSubjects(subjects) {
  if (!Array.isArray(subjects) || subjects.length === 0) {
    fail('a bulletin names at least one subject: a bulletin that denies nothing is a memo', { code: 'revocation.subject', field: 'subjects' });
  }
  if (subjects.length > MAX_SUBJECTS) {
    fail(`a bulletin naming ${subjects.length} subjects exceeds ${MAX_SUBJECTS}: at that size the durable path is the answer`, { code: 'revocation.subject', field: 'subjects' });
  }
  const seen = new Set();
  return Object.freeze(subjects.map((subject, index) => {
    const kind = subject?.kind;
    if (!SUBJECT_KINDS.includes(kind)) {
      fail(`subject ${index} has kind '${String(kind)}': a bulletin denies identities, packages or artifacts, and nothing else`, { code: 'revocation.subject', field: `subjects[${index}].kind` });
    }
    const key = subject?.key;
    if (!isNonEmptyString(key)) fail(`subject ${index} has no key`, { code: 'revocation.subject', field: `subjects[${index}].key` });
    if (kind === 'identity' && !(key.includes('@') && key.split('@').every((part) => part.length > 0))) {
      fail(`subject ${index} is not an identity 'type@typeVersion': got '${key}'`, { code: 'revocation.subject', field: `subjects[${index}].key` });
    }
    const digest = kind === 'artifact' ? normalizeDigest(key) : null;
    const canonical = `${kind}:${digest ?? key}`;
    if (seen.has(canonical)) {
      fail(`subject ${index} repeats '${canonical}': a bulletin that names the same thing twice is a bulletin nobody proofread`, { code: 'revocation.subject', field: `subjects[${index}].key` });
    }
    seen.add(canonical);
    return Object.freeze({
      kind,
      key,
      digest,
      package: isNonEmptyString(subject?.package) ? subject.package : null,
      note: isNonEmptyString(subject?.note) ? subject.note : null,
    });
  }));
}

export function isBulletin(value) {
  return Boolean(value) && typeof value === 'object'
    && value.contract === BULLETIN_CONTRACT
    && isNonEmptyString(value.id)
    && Array.isArray(value.subjects)
    && isNonEmptyString(value.bulletinDigest);
}

/* --------------------------------------------------------------------- chain */

/**
 * Bulletins are ordered by sequence and linked by digest. A gap is refused because it means
 * something was dropped; a fork — two bulletins claiming one sequence — is refused because
 * it means two people believe they hold the emergency channel.
 */
export function verifyBulletinSequence(bulletins) {
  if (!Array.isArray(bulletins)) fail('verifyBulletinSequence reads a list of bulletins', { code: 'revocation.input', field: 'bulletins' });
  const ordered = [...bulletins].sort((left, right) => left.sequence - right.sequence);
  const details = [];
  let expectedSequence = null;
  let previous = null;
  for (const bulletin of ordered) {
    if (!isBulletin(bulletin)) fail('verifyBulletinSequence reads bulletins made by issueBulletin', { code: 'revocation.input', field: 'bulletins' });
    if (expectedSequence === null) {
      expectedSequence = bulletin.sequence;
    } else if (bulletin.sequence === previous.sequence) {
      details.push({ kind: 'fork', sequence: bulletin.sequence, digests: [previous.bulletinDigest, bulletin.bulletinDigest] });
      continue;
    } else if (bulletin.sequence !== previous.sequence + 1) {
      details.push({ kind: 'gap', expected: previous.sequence + 1, found: bulletin.sequence });
    }
    if (bulletin.sequence > 1 && previous === null) {
      // A sequence that starts in the middle was either truncated or assembled from parts.
      // Either way the channel cannot be ordered, and the answer must not be a crash.
      details.push({ kind: 'orphan', sequence: bulletin.sequence, expected: null, found: bulletin.previousDigest });
    } else if (bulletin.sequence > 1 && !sameDigest(bulletin.previousDigest, previous.bulletinDigest)) {
      details.push({ kind: 'unlinked', sequence: bulletin.sequence, expected: previous.bulletinDigest, found: bulletin.previousDigest });
    }
    previous = bulletin;
  }
  if (details.length === 0) {
    return Object.freeze({ ok: true, length: ordered.length, head: ordered.length === 0 ? null : ordered[ordered.length - 1].bulletinDigest });
  }
  return Object.freeze({
    ok: false,
    reason: 'revocation.sequence',
    message: 'the bulletin sequence does not hold together: something was dropped, replayed or replaced',
    detail: Object.freeze(details.map((entry) => Object.freeze(entry))),
  });
}

/* ------------------------------------------------------------------- witness */

/**
 * A witness is what a client keeps so it can refuse an older bulletin by itself. Without an
 * explicit `firstContact` it fails closed: a client that does not know where the sequence
 * started cannot tell a fresh bulletin from a replay.
 */
export function createBulletinWitness() {
  return { contract: BULLETIN_CONTRACT, sequences: new Map(), firstContact: null };
}

export function isBulletinWitness(value) {
  return Boolean(value) && typeof value === 'object' && value.contract === BULLETIN_CONTRACT && value.sequences instanceof Map;
}

/**
 * Recording a bulletin is what makes replay detectable. `firstContact` must be declared
 * once — the sequence the client has decided to trust as its starting point.
 */
export function witnessBulletin(witness, bulletin, { firstContact = null } = {}) {
  if (!isBulletinWitness(witness)) fail('witnessBulletin reads a witness made by createBulletinWitness', { code: 'revocation.input', field: 'witness' });
  if (!isBulletin(bulletin)) fail('witnessBulletin reads a bulletin made by issueBulletin', { code: 'revocation.input', field: 'bulletin' });
  if (Number.isInteger(firstContact)) {
    if (witness.firstContact !== null && witness.firstContact !== firstContact) {
      fail(`this witness already began at sequence ${witness.firstContact}: a second contact point would hide a replay in between`, { code: 'revocation.state', field: 'firstContact' });
    }
    witness.firstContact = firstContact;
  }
  if (witness.firstContact === null) {
    fail('a witness that has not declared its first contact cannot tell a replay from a first bulletin', { code: 'revocation.state', field: 'firstContact' });
  }
  const seen = witness.sequences.get(bulletin.id) ?? null;
  if (seen && bulletin.sequence < seen.sequence) {
    return Object.freeze({ ok: false, witnessed: false, reason: 'revocation.sequence', message: `bulletin '${bulletin.id}' sequence ${bulletin.sequence} is behind the witnessed ${seen.sequence}: this is a replay`, detail: Object.freeze({ seen: seen.sequence, received: bulletin.sequence }) });
  }
  if (seen && bulletin.sequence === seen.sequence && seen.digest !== bulletin.bulletinDigest) {
    return Object.freeze({ ok: false, witnessed: false, reason: 'revocation.sequence', message: `bulletin '${bulletin.id}' sequence ${bulletin.sequence} was already witnessed with a different digest: two bulletins claim one place in the sequence`, detail: Object.freeze({ witnessed: seen.digest, received: bulletin.bulletinDigest }) });
  }
  witness.sequences.set(bulletin.id, { sequence: bulletin.sequence, digest: bulletin.bulletinDigest });
  return Object.freeze({ ok: true, witnessed: true, sequence: bulletin.sequence, digest: bulletin.bulletinDigest });
}

/* ---------------------------------------------------------------- evaluation */

/** Where a bulletin stands at a tick, before any disposition. */
export function evaluateBulletin(bulletin, { tick } = {}) {
  if (!isBulletin(bulletin)) fail('evaluateBulletin reads a bulletin made by issueBulletin', { code: 'revocation.input', field: 'bulletin' });
  if (!isTick(tick)) fail('a bulletin is evaluated at a tick: an untimed answer is not an answer', { code: 'revocation.input', field: 'tick' });
  if (tick < bulletin.issuedAt) {
    fail(`tick ${tick} is before this bulletin was issued at ${bulletin.issuedAt}: a bulletin cannot act in the past`, { code: 'revocation.window', field: 'tick' });
  }
  if (tick < bulletin.effectiveFrom) {
    return Object.freeze({ ok: true, state: 'pending', bulletin, tick, message: `takes effect at ${bulletin.effectiveFrom}` });
  }
  if (tick < bulletin.expiresAt) {
    return Object.freeze({ ok: true, state: 'active', bulletin, tick, message: `active until ${bulletin.expiresAt}` });
  }
  return Object.freeze({ ok: true, state: 'lapsed', bulletin, tick, message: `lapsed at ${bulletin.expiresAt} and not yet disposed of` });
}

/**
 * Disposing of a bulletin is how an emergency ends. `uphold` lands it on the durable path and
 * must name where; `lift` reopens the subject on the record. Neither happens by itself.
 */
export function disposeBulletin(bulletin, { disposition, tick, actor, reason, durableRef = null } = {}) {
  if (!isBulletin(bulletin)) fail('disposeBulletin reads a bulletin made by issueBulletin', { code: 'revocation.input', field: 'bulletin' });
  if (!DISPOSITIONS.includes(disposition)) {
    fail(`'${String(disposition)}' is not a disposition: an emergency ends by being upheld or lifted, and nothing else`, { code: 'revocation.disposition', field: 'disposition' });
  }
  if (!isTick(tick)) fail('a disposition records the tick it was made at', { code: 'revocation.disposition', field: 'tick' });
  if (!isNonEmptyString(actor)) fail('a disposition names the actor: an anonymous decision to reopen is not a decision', { code: 'revocation.disposition', field: 'actor' });
  if (!isNonEmptyString(reason)) fail('a disposition states a reason a human can read', { code: 'revocation.disposition', field: 'reason' });
  if (tick < bulletin.issuedAt) fail(`a disposition at tick ${tick} predates the bulletin issued at ${bulletin.issuedAt}`, { code: 'revocation.disposition', field: 'tick' });
  if (disposition === 'uphold' && !isNonEmptyString(durableRef)) {
    fail('upholding requires a durableRef: this contract denies work, it does not make a revocation permanent', { code: 'revocation.disposition', field: 'durableRef' });
  }
  const body = {
    contract: BULLETIN_CONTRACT,
    schemaVersion: BULLETIN_SCHEMA_VERSION,
    bulletinId: bulletin.id,
    bulletinDigest: bulletin.bulletinDigest,
    disposition,
    tick,
    actor,
    reason,
    durableRef: disposition === 'uphold' ? durableRef : null,
  };
  return Object.freeze({ ...body, dispositionDigest: bulletinDigest(body) });
}

export function isDisposition(value) {
  return Boolean(value) && typeof value === 'object' && value.contract === BULLETIN_CONTRACT && DISPOSITIONS.includes(value.disposition) && isNonEmptyString(value.dispositionDigest);
}

/**
 * A view is where everything meets: the bulletins, their dispositions, the client witness and
 * the tick being answered for. It is built once and read many times, so a decision cannot see
 * half a picture.
 */
export function createBulletinView({ bulletins = [], dispositions = [], witness = null, tick } = {}) {
  if (!Array.isArray(bulletins) || bulletins.length === 0) {
    fail('a view is built from the bulletins that exist: an empty channel is not a clean bill of health', { code: 'revocation.input', field: 'bulletins' });
  }
  if (!isTick(tick)) fail('a view answers for a tick: an untimed view is not a view', { code: 'revocation.input', field: 'tick' });
  const sequence = verifyBulletinSequence(bulletins);
  const evaluated = bulletins.map((bulletin) => Object.freeze({ bulletin, standing: evaluateBulletin(bulletin, { tick }) }));
  const byBulletin = new Map();
  for (const disposition of dispositions) {
    if (!isDisposition(disposition)) fail('a view reads dispositions made by disposeBulletin', { code: 'revocation.disposition', field: 'dispositions' });
    const existing = byBulletin.get(disposition.bulletinId) ?? null;
    if (existing && disposition.tick < existing.tick) {
      fail(`disposition at tick ${disposition.tick} is older than the one at ${existing.tick}: a view that accepted it would resurrect a decision`, { code: 'revocation.disposition', field: 'dispositions' });
    }
    byBulletin.set(disposition.bulletinId, disposition);
  }
  return {
    contract: BULLETIN_CONTRACT,
    tick,
    entries: Object.freeze(evaluated),
    dispositions: byBulletin,
    witness: isBulletinWitness(witness) ? witness : null,
    sequenceOk: sequence.ok,
    sequenceDetail: sequence.ok ? null : sequence,
  };
}

export function isBulletinView(value) {
  return Boolean(value) && typeof value === 'object' && value.contract === BULLETIN_CONTRACT && Array.isArray(value.entries) && value.dispositions instanceof Map;
}

/**
 * The one decision this contract makes. It answers deny or allow for one subject, and the
 * only path to `allow` is that nothing in the channel names it. Anything unreadable denies.
 */
export function decideSubject(view, { kind, key, package: packageName = null } = {}) {
  if (!isBulletinView(view)) fail('decideSubject reads a view made by createBulletinView', { code: 'revocation.input', field: 'view' });
  if (!SUBJECT_KINDS.includes(kind)) {
    fail(`'${String(kind)}' is not a subject kind: an unknown kind is not a subject that can be cleared`, { code: 'revocation.subject', field: 'kind' });
  }
  if (!isNonEmptyString(key)) fail('a decision answers for a named subject', { code: 'revocation.subject', field: 'key' });
  const digest = kind === 'artifact' ? normalizeDigest(key) : null;
  const canon = `${kind}:${digest ?? key}`;
  const naming = view.entries.filter((entry) => entry.bulletin.subjects.some((subject) => `${subject.kind}:${subject.digest ?? subject.key}` === canon));

  if (naming.length === 0) {
    return Object.freeze({ ok: true, decision: 'allow', subject: Object.freeze({ kind, key, package: packageName }), basis: 'nothing in the revocation channel names this subject', cites: Object.freeze([]) });
  }
  if (!view.sequenceOk) {
    return Object.freeze({
      ok: true,
      decision: 'deny',
      reason: 'revocation.sequence',
      subject: Object.freeze({ kind, key, package: packageName }),
      basis: 'the subject is named, and the bulletin sequence does not hold together, so no bulletin here can be given the benefit of the doubt',
      cites: Object.freeze(naming.map((entry) => entry.bulletin.bulletinDigest)),
    });
  }

  const cites = [];
  let lapsed = null;
  for (const entry of naming) {
    const disposition = view.dispositions.get(entry.bulletin.id) ?? null;
    cites.push(entry.bulletin.bulletinDigest);
    if (disposition?.disposition === 'lift') continue;
    if (disposition?.disposition === 'uphold') {
      return Object.freeze({
        ok: true,
        decision: 'deny',
        subject: Object.freeze({ kind, key, package: packageName }),
        basis: `upheld at tick ${disposition.tick} by ${disposition.actor} into ${disposition.durableRef}`,
        cites: Object.freeze(cites),
      });
    }
    if (entry.standing.state === 'active') {
      return Object.freeze({
        ok: true,
        decision: 'deny',
        subject: Object.freeze({ kind, key, package: packageName }),
        basis: `active bulletin '${entry.bulletin.id}' (sequence ${entry.bulletin.sequence}): ${entry.bulletin.reason}`,
        cites: Object.freeze(cites),
      });
    }
    if (entry.standing.state === 'lapsed') {
      if (lapsed === null || entry.bulletin.sequence > lapsed.bulletin.sequence) lapsed = entry;
    }
  }
  if (lapsed) {
    return Object.freeze({
      ok: true,
      decision: 'deny',
      subject: Object.freeze({ kind, key, package: packageName }),
      basis: `bulletin '${lapsed.bulletin.id}' lapsed at ${lapsed.bulletin.expiresAt} and nobody disposed of it: an emergency that expires without a disposition is a decision nobody made`,
      cites: Object.freeze(cites),
    });
  }
  return Object.freeze({
    ok: true,
    decision: 'allow',
    subject: Object.freeze({ kind, key, package: packageName }),
    basis: 'every bulletin naming this subject was lifted on the record',
    cites: Object.freeze(cites),
  });
}

/**
 * A bulletin issued against one registry state must not be applied to an older one: an
 * operator who has seen the newer epoch and then reverted to the older one would otherwise be
 * able to lose the emergency along with the epoch.
 */
export function appliesToEpoch(bulletin, epoch) {
  if (!isBulletin(bulletin)) fail('appliesToEpoch reads a bulletin made by issueBulletin', { code: 'revocation.input', field: 'bulletin' });
  if (!isFrozenRegistryEpoch(epoch)) {
    fail('appliesToEpoch reads a compiled epoch: a claim about an epoch needs an epoch', { code: 'revocation.epoch', field: 'epoch' });
  }
  const digest = normalizeDigest(epoch.epochDigest ?? epoch.digest);
  if (digest === bulletin.baselineDigest) {
    return Object.freeze({ ok: true, applies: true, basis: 'the baseline is this epoch' });
  }
  const epochNumber = Number.isInteger(epoch.epochNumber) ? epoch.epochNumber : null;
  if (bulletin.baselineNumber !== null && epochNumber !== null && epochNumber < bulletin.baselineNumber) {
    return Object.freeze({
      ok: false,
      reason: 'revocation.epoch',
      message: `bulletin '${bulletin.id}' was issued against epoch ${bulletin.baselineNumber} and epoch ${epochNumber} is older: a change cannot be un-seen by going back`,
      detail: Object.freeze({ baseline: bulletin.baselineNumber, epoch: epochNumber }),
    });
  }
  return Object.freeze({ ok: true, applies: true, basis: `issued against epoch ${bulletin.baselineNumber ?? 'unknown'}, and this epoch is not older` });
}

/** The counts an incident review opens with. */
export function describeBulletin(bulletin, { dispositions = [], tick = null } = {}) {
  if (!isBulletin(bulletin)) fail('describeBulletin reads a bulletin made by issueBulletin', { code: 'revocation.input', field: 'bulletin' });
  const latest = dispositions.filter((entry) => isDisposition(entry) && entry.bulletinId === bulletin.id)
    .sort((left, right) => left.tick - right.tick)
    .pop() ?? null;
  const standing = isTick(tick) ? evaluateBulletin(bulletin, { tick }).state : null;
  return Object.freeze({
    contract: BULLETIN_CONTRACT,
    id: bulletin.id,
    sequence: bulletin.sequence,
    issuedBy: bulletin.issuedBy,
    reason: bulletin.reason,
    window: Object.freeze({ from: bulletin.effectiveFrom, to: bulletin.expiresAt, ticks: bulletin.expiresAt - bulletin.effectiveFrom }),
    standing,
    subjects: Object.freeze(bulletin.subjects.map((subject) => `${subject.kind}:${subject.digest ?? subject.key}`)),
    disposed: latest ? Object.freeze({ disposition: latest.disposition, tick: latest.tick, actor: latest.actor }) : null,
    digest: bulletin.bulletinDigest,
  });
}

/** One readable line, because an incident is read by people who were not there. */
export function explainBulletin(bulletin, { dispositions = [], tick = null } = {}) {
  const described = describeBulletin(bulletin, { dispositions, tick });
  const subjects = described.subjects.length === 1 ? described.subjects[0] : `${described.subjects.length} subjects`;
  const standing = described.standing ? ` [${described.standing}]` : '';
  if (described.disposed) {
    return `bulletin ${described.id}#${described.sequence}${standing} names ${subjects} and was ${described.disposed.disposition}ed at tick ${described.disposed.tick} by ${described.disposed.actor}`;
  }
  return `bulletin ${described.id}#${described.sequence}${standing} names ${subjects} until tick ${described.window.to} — ${described.reason}`;
}
