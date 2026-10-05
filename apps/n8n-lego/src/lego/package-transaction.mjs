/**
 * Package transaction — P6.3 (Transactional Package + Single-Flight Install).
 *
 * PUBLIC CONTRACT (`package.transaction@0.1.0`, domain `node-registry`).
 *
 * P6.1 says what a node declaration IS, P6.2 compiles declarations into an
 * immutable epoch. Neither of them says how a node package gets from "a tarball
 * on a disk" to "the registry the host is serving" — and that gap is where the
 * damage happens. An install that is interrupted mid-copy leaves a half-written
 * package; two installs of the same package racing each other produce a mixture
 * of both; a rollback that is applied to a stale view silently undoes someone
 * else's upgrade.
 *
 * This module is the protocol that closes those three holes. It owns the
 * ORDERING, the JOURNAL, the ATTEMPTS, the VISIBILITY BOUNDARY and the
 * single-flight arbitration — and deliberately not the bytes. Every step result
 * is reported back by the caller: the host does the IO, this contract says what
 * a valid history looks like and refuses anything else. That split is what makes
 * an installer testable without a filesystem, and it is the same split the rest
 * of P6 already uses (P6.1 hands back declarations, P6.2 hands back epochs).
 *
 * The steps, in order — every one of them must be recorded, none may be skipped:
 *
 *   resolve → prepare → verify → stage → publish → activate
 *
 * `resolve`   the package identity and version were resolved, and it exists.
 * `prepare`   the artifact was fetched/extracted to a private working area.
 * `verify`    content matched the declared digest, provenance and trust inputs.
 * `stage`     the payload was placed where an activation would find it.
 * `publish`   THE VISIBILITY BOUNDARY. Before this step nothing outside the
 *             transaction can see the package; after it, the payload is part of
 *             the registry. This is the only point at which a recovery decision
 *             changes shape, which is why it is a named constant, not a comment.
 * `activate`  the published payload became the live implementation (an epoch
 *             publication, P6.2). Failure here is recoverable: the bytes are
 *             already published, so the registry is inconsistent until the
 *             activation completes or is explicitly rolled back — never silently
 *             ignored.
 *
 * Single-flight: `createInstallGate()` returns a gate that admits ONE lease per
 * package identity at a time. Each admission increments the gate's FENCE, and a
 * lease publishes under the fence it was admitted with. A lease that comes back
 * after a newer one was admitted is refused (`package.transaction.fence`) rather
 * than allowed to publish over the newer holder — the classic fencing-token rule
 * without which "the lock was released" is only a story about the past.
 *
 * WHAT THIS IS NOT (P6.3 scope walls, enforced by tests):
 *   - no dependency closure, no content-addressed artifact store          (P6.4)
 *   - no workflow pinning, no runtime lease, no residency tier         (P6.5-P6.7)
 *   - no health, no quarantine, no supply-chain attestation            (P6.11+)
 *   - no epoch numbering of its own: it is composed WITH P6.2, never a
 *     replacement for it (`publish` names an epoch digest; it does not mint one)
 *   - no filesystem, no network, no timers, no wall clock, no randomness, and no
 *     mutation of anything: every function returns a new frozen value, so a
 *     transaction that a UI is rendering cannot be edited under it.
 *
 * Authority: nothing here grants trust or capability, and nothing here installs.
 * The host holds the write authority; this contract plans the work, judges the
 * history it is told about, and refuses a history that could not have happened.
 */
import { createHash } from 'node:crypto';

import {
  NODE_REGISTRY_SCHEMA_VERSION,
} from './node-registry.mjs';

export const PACKAGE_TRANSACTION_CONTRACT = 'package.transaction@0.1.0';
export const PACKAGE_TRANSACTION_CONTRACT_VERSION = '0.1.0';
export const PACKAGE_TRANSACTION_SCHEMA_VERSION = 1;

/** Operations: plan the work, judge a step result, commit, decide recovery, lease. */
export const PACKAGE_TRANSACTION_OPERATIONS = Object.freeze(['plan', 'record', 'commit', 'recover', 'lease']);

/** Permission vocabulary is P6.1's. The host holds write authority; this reads and judges. */
export const PACKAGE_TRANSACTION_PERMISSIONS = Object.freeze(['node:read']);

/** The install pipeline, in the only order it may happen. */
export const PACKAGE_TRANSACTION_STEPS = Object.freeze(['resolve', 'prepare', 'verify', 'stage', 'publish', 'activate']);

/** The step after which the package is visible outside the transaction. */
export const PACKAGE_TRANSACTION_VISIBILITY_BOUNDARY = 'publish';

/** Per-step attempt ceiling: a failing step is retried once, then the step fails. */
export const PACKAGE_TRANSACTION_MAX_ATTEMPTS = 2;

export const PACKAGE_TRANSACTION_STEP_STATUSES = Object.freeze(['pending', 'done', 'failed']);

export const PACKAGE_TRANSACTION_STATUSES = Object.freeze(['open', 'committed', 'failed', 'aborted']);

/** What recovery must do, given the one thing that matters: where the history stopped. */
export const PACKAGE_RECOVERY_ACTIONS = Object.freeze(['abort', 'resume', 'rollback', 'none']);

export const PACKAGE_TRANSACTION_REASONS = Object.freeze([
  'package.transaction.identity',
  'package.transaction.digest',
  'package.transaction.source',
  'package.transaction.order',
  'package.transaction.attempts',
  'package.transaction.replay',
  'package.transaction.closed',
  'package.transaction.unknown_step',
  'package.transaction.inflight',
  'package.transaction.fence',
]);

export const PACKAGE_TRANSACTION_RULES = Object.freeze({
  order: `steps happen in the fixed order ${'resolve → prepare → verify → stage → publish → activate'}; a step result for a later step before an earlier one is refused, never reordered`,
  visibility: "`publish` is the visibility boundary: before it a failure costs nothing, after it the registry is inconsistent until activation completes or is rolled back",
  idempotence: "attempt numbers are explicit: replaying a recorded attempt is a no-op, reporting the next attempt counts, and a step that already succeeded can never be re-recorded",
  attempts: 'a step gets at most two attempts; exhausting them closes the transaction as failed and recovery decides, instead of looping',
  singleflight: 'one install per package identity at a time, and a lease publishes only under the fence it was admitted with',
  immutability: 'every step returns a new frozen transaction; a history in front of an operator cannot change under them',
  authority: 'the host does the IO and holds the write authority; this contract plans, judges and refuses',
});

/* ------------------------------------------------------------------ *
 * Errors
 * ------------------------------------------------------------------ */

export class PackageTransactionError extends Error {
  constructor(message, meta = {}) {
    super(message);
    this.name = 'PackageTransactionError';
    this.code = 'lego.contract_violation';
    this.meta = Object.freeze({ ...meta });
  }
}

const fail = (message, meta) => { throw new PackageTransactionError(message, meta); };
const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const isNonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0;

const PACKAGE_NAME_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const PACKAGE_VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

const digestOf = (text) => createHash('sha256').update(text).digest('hex');

function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value;
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return Object.freeze(value);
}

const stepIndex = (step) => PACKAGE_TRANSACTION_STEPS.indexOf(step);
const isVisibilityBoundaryOrLater = (step) => stepIndex(step) >= stepIndex(PACKAGE_TRANSACTION_VISIBILITY_BOUNDARY);

/* ------------------------------------------------------------------ *
 * Plan
 * ------------------------------------------------------------------ */

/**
 * Plan a transactional install of one package version.
 *
 * @param {{ package?: string, version?: string, digest?: string, source?: string }} intent
 * @returns {Readonly<object>} a frozen, open transaction with every step pending
 *   and a deterministic id — the same intent always plans the same transaction.
 */
export function planPackageTransaction(intent = {}) {
  const { package: name, version, digest, source } = isPlainObject(intent) ? intent : {};

  if (!isNonEmptyString(name) || !PACKAGE_NAME_RE.test(name)) {
    fail(`package name ${JSON.stringify(name)} is not a valid package identity`, { code: 'package.transaction.identity', field: 'package' });
  }
  if (!isNonEmptyString(version) || !PACKAGE_VERSION_RE.test(version)) {
    fail(`version ${JSON.stringify(version)} is not a valid semver version`, { code: 'package.transaction.identity', field: 'version' });
  }
  if (!isNonEmptyString(digest) || !DIGEST_RE.test(digest)) {
    fail(`digest ${JSON.stringify(digest)} is not 'sha256:<64 hex>'; an unverifiable digest is not a digest`, { code: 'package.transaction.digest', field: 'digest' });
  }
  if (!isNonEmptyString(source)) {
    fail('an install must name where the artifact came from; an unnamed install cannot be audited', { code: 'package.transaction.source', field: 'source' });
  }

  const identity = `${name}@${version}`;
  const transactionId = `install:${digestOf(stableJson({ identity, digest, source })).slice(0, 32)}`;
  const steps = PACKAGE_TRANSACTION_STEPS.map((step) => Object.freeze({
    step, status: 'pending', attempts: 0, seq: null, detail: null,
  }));

  return deepFreeze({
    ok: true,
    schemaVersion: PACKAGE_TRANSACTION_SCHEMA_VERSION,
    contract: PACKAGE_TRANSACTION_CONTRACT,
    transactionId,
    identity,
    package: name,
    version,
    digest,
    source,
    status: 'open',
    steps,
    seq: 0,
    epochDigest: null,
    leaseFence: null,
    reason: null,
  });
}

/** @returns {boolean} whether `value` is a transaction this contract produced. */
export function isPackageTransaction(value) {
  return (
    isPlainObject(value) &&
    value.ok === true &&
    value.contract === PACKAGE_TRANSACTION_CONTRACT &&
    value.schemaVersion === PACKAGE_TRANSACTION_SCHEMA_VERSION &&
    typeof value.transactionId === 'string' &&
    Array.isArray(value.steps) &&
    value.steps.length === PACKAGE_TRANSACTION_STEPS.length &&
    PACKAGE_TRANSACTION_STATUSES.includes(value.status) &&
    Object.isFrozen(value)
  );
}

function requireTransaction(transaction, fn) {
  if (!isPackageTransaction(transaction)) fail(`${fn} expects a transaction produced by planPackageTransaction`, { got: typeof transaction });
}

/* ------------------------------------------------------------------ *
 * Record
 * ------------------------------------------------------------------ */

/**
 * Record what a step did. Returns a NEW transaction; the input is untouched.
 *
 * @param {object} transaction
 * @param {{ step: string, status?: 'done'|'failed', detail?: string, epochDigest?: string, lease?: object }} result
 */
export function recordPackageStep(transaction, result = {}) {
  requireTransaction(transaction, 'recordPackageStep');
  const { step, status = 'done', detail = null, epochDigest = null, lease = null, gate = null, attempt = null } = isPlainObject(result) ? result : {};

  if (!PACKAGE_TRANSACTION_STEPS.includes(step)) {
    fail(`'${step}' is not an install step; the steps are ${PACKAGE_TRANSACTION_STEPS.join(', ')}`, { code: 'package.transaction.unknown_step', field: 'step' });
  }
  if (!PACKAGE_TRANSACTION_STEP_STATUSES.includes(status) || status === 'pending') {
    fail(`status must be 'done' or 'failed', got ${JSON.stringify(status)}`, { code: 'package.transaction.replay', field: 'status' });
  }
  if (attempt !== null && (!Number.isInteger(attempt) || attempt < 1)) {
    fail(`attempt must be a positive integer, got ${JSON.stringify(attempt)}`, { code: 'package.transaction.replay', step, field: 'attempt' });
  }

  const position = stepIndex(step);
  const current = transaction.steps[position];

  // Attempt numbering is explicit, because "the same failure twice" is ambiguous
  // in a way that matters: a driver re-sending an old report must not consume an
  // attempt, and a driver retrying in a loop must not escape the ceiling by
  // reporting the same error text forever. So the caller says which attempt it
  // is (`attempt`); an omitted number means "this is the next attempt" —
  // fail-safe, because over-counting a retry ends the transaction while
  // under-counting it loops.
  //
  // Replay first, before any closed check: re-delivering a report that was
  // already accepted is a no-op even after the transaction is closed, or a
  // crashed driver could never reconcile its own journal.
  if (attempt !== null && current.status !== 'pending' && attempt === current.attempts && current.status === status && current.detail === detail) {
    return transaction;
  }

  if (current.status === 'failed' && current.attempts >= PACKAGE_TRANSACTION_MAX_ATTEMPTS) {
    fail(
      `step '${step}' has used all ${PACKAGE_TRANSACTION_MAX_ATTEMPTS} attempts; a dead step is not retried, it is recovered (${decidePackageRecovery(transaction).action})`,
      { code: 'package.transaction.attempts', step, attempts: current.attempts },
    );
  }

  if (transaction.status !== 'open') {
    fail(`transaction ${transaction.transactionId} is ${transaction.status}; a closed history is not extended`, { code: 'package.transaction.closed', status: transaction.status });
  }

  if (current.status === 'done') {
    fail(
      `step '${step}' already succeeded${current.detail ? ` (${current.detail})` : ''} and cannot be re-recorded as ${status}; a journal is evidence, not a draft`,
      { code: 'package.transaction.replay', step, recorded: current.status, attempted: status },
    );
  }
  if (attempt !== null && attempt !== current.attempts + 1) {
    fail(
      `step '${step}' report claims attempt ${attempt} but the next attempt is ${current.attempts + 1}; attempt numbers are sequential and a gap is a lost report, not a new attempt`,
      { code: 'package.transaction.replay', step, claimed: attempt, expected: current.attempts + 1 },
    );
  }

  // Order: every earlier step must be done. This is the rule that makes the
  // journal a proof rather than a log.
  for (const earlier of transaction.steps.slice(0, position)) {
    if (earlier.status !== 'done') {
      fail(
        `step '${step}' cannot be recorded before '${earlier.step}' is done (it is ${earlier.status}); install steps happen in order`,
        { code: 'package.transaction.order', step, blockedBy: earlier.step },
      );
    }
  }

  if (step === PACKAGE_TRANSACTION_VISIBILITY_BOUNDARY && status === 'done') {
    // Publication binds the epoch it makes visible...
    if (typeof epochDigest !== 'string' || !/^[0-9a-f]{64}$/.test(epochDigest)) {
      fail("a successful 'publish' must name the 64-hex epoch digest it made visible; publish without a digest is not a publication", { code: 'package.transaction.order', step, field: 'epochDigest' });
    }
    // ...and the authority to make it visible, checked here because this is the
    // step that leaves the transaction's private world.
    if (lease || gate) {
      if (!lease || !gate) {
        fail('a fenced publication needs both the lease and the gate it was admitted by; a lease that cannot be checked is not a fence', { code: 'package.transaction.fence', step });
      }
      if (!holdsInstallLease(gate, lease)) {
        fail(
          `lease fence ${lease.fence} (owner '${lease.owner}') no longer holds the install gate; the publication is refused`,
          { code: 'package.transaction.fence', step, offeredFence: lease.fence, heldFence: gate.holder ? gate.holder.fence : null },
        );
      }
    } else if (transaction.leaseFence === null) {
      fail('a publication must be fenced by an install lease; an unfenced publish is a race with no referee', { code: 'package.transaction.fence', step });
    }
  }

  const steps = transaction.steps.map((entry, index) => (index === position
    ? Object.freeze({
      step,
      status,
      attempts: entry.attempts + 1,
      seq: transaction.seq + 1,
      detail: status === 'failed' ? (detail ?? 'step failed') : detail,
    })
    : entry));

  // A failed attempt keeps the transaction open while attempts remain: recovery
  // can resume it. Exhausting the attempts is what closes it as `failed`.
  const exhausted = status === 'failed' && current.attempts + 1 >= PACKAGE_TRANSACTION_MAX_ATTEMPTS;
  return deepFreeze({
    ...transaction,
    status: exhausted ? 'failed' : transaction.status,
    steps,
    seq: transaction.seq + 1,
    epochDigest: step === PACKAGE_TRANSACTION_VISIBILITY_BOUNDARY && status === 'done' ? epochDigest : transaction.epochDigest,
    leaseFence: lease && typeof lease.fence === 'number' ? lease.fence : transaction.leaseFence,
    reason: status === 'failed' ? `step-failed:${step}` : null,
  });
}

/* ------------------------------------------------------------------ *
 * Commit
 * ------------------------------------------------------------------ */

/**
 * Commit a transaction whose every step is done.
 * @returns {{ ok: true, committed: object, journal: object }} or throws with the reason.
 */
export function commitPackageTransaction(transaction) {
  requireTransaction(transaction, 'commitPackageTransaction');
  if (transaction.status !== 'open') {
    fail(`transaction ${transaction.transactionId} is already ${transaction.status}`, { code: 'package.transaction.closed', status: transaction.status });
  }
  for (const entry of transaction.steps) {
    if (entry.status !== 'done') {
      fail(
        `transaction ${transaction.transactionId} cannot be committed: step '${entry.step}' is ${entry.status}`,
        { code: 'package.transaction.order', step: entry.step, status: entry.status },
      );
    }
  }
  const committed = deepFreeze({ ...transaction, status: 'committed' });
  return Object.freeze({ ok: true, committed, journal: transactionJournal(committed) });
}

/** Abandon a transaction that has not passed the visibility boundary. */
export function abortPackageTransaction(transaction, reason = 'aborted') {
  requireTransaction(transaction, 'abortPackageTransaction');
  if (transaction.status !== 'open' && transaction.status !== 'failed') {
    fail(`transaction ${transaction.transactionId} is ${transaction.status}; only an open or failed transaction can be aborted`, { code: 'package.transaction.closed', status: transaction.status });
  }
  const published = transaction.steps.find((entry) => entry.step === PACKAGE_TRANSACTION_VISIBILITY_BOUNDARY && entry.status === 'done');
  if (published) {
    fail(
      `transaction ${transaction.transactionId} is past the visibility boundary ('publish' is done); it cannot be aborted, it must be rolled back`,
      { code: 'package.transaction.order', boundary: PACKAGE_TRANSACTION_VISIBILITY_BOUNDARY },
    );
  }
  return deepFreeze({ ...transaction, status: 'aborted', reason });
}

/* ------------------------------------------------------------------ *
 * Recovery
 * ------------------------------------------------------------------ */

/**
 * Decide what recovery must do, from the journal alone.
 *
 * The rule is asymmetric on purpose:
 *   - nothing published yet  → `abort`: the transaction never existed for anyone
 *     else, so finishing it would be inventing work;
 *   - published, not activated → `resume`: the bytes are already visible, so the
 *     registry is inconsistent and the only honest options are to finish the
 *     activation or to roll the publication back, in that order of preference;
 *   - committed → `none`: there is nothing to recover, and pretending otherwise
 *     is how a recovery tool becomes an outage.
 *
 * @returns {Readonly<object>} `{ action, reason, resumeFrom, publishedAt, detail }`
 */
export function decidePackageRecovery(transaction) {
  requireTransaction(transaction, 'decidePackageRecovery');
  const failed = transaction.steps.filter((entry) => entry.status === 'failed');
  const published = transaction.steps.find((entry) => entry.step === PACKAGE_TRANSACTION_VISIBILITY_BOUNDARY && entry.status === 'done');
  const nextPending = transaction.steps.find((entry) => entry.status === 'pending');

  if (transaction.status === 'committed') {
    return deepFreeze({ ok: true, action: 'none', reason: 'committed', resumeFrom: null, publishedAt: published?.seq ?? null, failedStep: null, exhausted: false, steps: [...PACKAGE_TRANSACTION_STEPS] });
  }
  if (transaction.status === 'aborted') {
    return deepFreeze({ ok: true, action: 'none', reason: 'aborted', resumeFrom: null, publishedAt: null, failedStep: null, exhausted: false, steps: [...PACKAGE_TRANSACTION_STEPS] });
  }
  if (failed.length > 0) {
    const failedStep = failed[0].step;
    const attemptsLeft = transaction.steps[stepIndex(failedStep)].attempts < PACKAGE_TRANSACTION_MAX_ATTEMPTS;
    // Symmetric on both sides of the boundary, and the asymmetry only shows up
    // when the attempts are gone: before the boundary there is nothing to undo,
    // after it there is nothing to leave half-done.
    const action = attemptsLeft ? 'resume' : (published ? 'rollback' : 'abort');
    return deepFreeze({
      ok: true,
      action,
      reason: `${action}-after:${failedStep}`,
      resumeFrom: attemptsLeft ? failedStep : null,
      publishedAt: published?.seq ?? null,
      failedStep,
      exhausted: !attemptsLeft,
      steps: [...PACKAGE_TRANSACTION_STEPS],
    });
  }
  return deepFreeze({
    ok: true,
    action: 'resume',
    reason: nextPending ? `resume-at:${nextPending.step}` : 'resume-incomplete',
    resumeFrom: nextPending?.step ?? null,
    publishedAt: published?.seq ?? null,
    failedStep: null,
    exhausted: false,
    steps: [...PACKAGE_TRANSACTION_STEPS],
  });
}

/* ------------------------------------------------------------------ *
 * Single-flight
 * ------------------------------------------------------------------ */

/**
 * Create a single-flight gate. One install per package identity at a time.
 * @returns {Readonly<object>} a frozen gate with fence 0 and no holder
 */
export function createInstallGate() {
  return deepFreeze({ ok: true, contract: PACKAGE_TRANSACTION_CONTRACT, fence: 0, holder: null, admitted: 0, refused: 0 });
}

const requireGate = (gate, fn) => {
  if (!isPlainObject(gate) || gate.ok !== true || gate.contract !== PACKAGE_TRANSACTION_CONTRACT || typeof gate.fence !== 'number') {
    fail(`${fn} expects a gate produced by createInstallGate`, { got: typeof gate });
  }
};

/**
 * Admit ONE holder for a package identity, or refuse and name who holds it.
 *
 * @returns {{ ok: true, gate: object, lease: object } | { ok: false, gate: object, lease: null, reason: string, error: object }}
 */
export function acquireInstallLease(gate, { owner, package: name } = {}) {
  requireGate(gate, 'acquireInstallLease');
  if (!isNonEmptyString(owner)) fail('an install lease needs an owner; an anonymous holder cannot be asked to release', { code: 'package.transaction.identity', field: 'owner' });
  if (gate.holder && gate.holder.owner === owner) {
    // Same owner asking twice gets the SAME lease back: re-entrancy must not
    // consume a fence, or a retrying driver would fence itself out.
    return Object.freeze({ ok: true, gate, lease: gate.holder, reason: 'already-held-by-owner' });
  }
  if (gate.holder) {
    const error = {
      code: 'package.transaction.inflight',
      heldBy: gate.holder.owner,
      fence: gate.holder.fence,
      message: `an install of ${gate.holder.package ?? 'this package'} is already in flight (owner '${gate.holder.owner}', fence ${gate.holder.fence}); installing twice at once is how a package becomes a mixture of two`,
    };
    return Object.freeze({ ok: false, gate: deepFreeze({ ...gate, refused: gate.refused + 1 }), lease: null, reason: error.code, error: Object.freeze(error) });
  }
  const fence = gate.fence + 1;
  const lease = deepFreeze({
    ok: true,
    kind: 'install-lease',
    owner,
    package: name ?? null,
    fence,
    admittedAt: null,
  });
  return Object.freeze({ ok: true, gate: deepFreeze({ ...gate, fence, holder: lease, admitted: gate.admitted + 1 }), lease, reason: 'admitted' });
}

/**
 * Release a lease. A STALE lease cannot release the gate: if a newer holder was
 * admitted, the release is refused, because acting on a lease you no longer hold
 * is exactly the race this contract exists to stop.
 */
export function releaseInstallLease(gate, lease) {
  requireGate(gate, 'releaseInstallLease');
  if (!isPlainObject(lease) || typeof lease.fence !== 'number' || !isNonEmptyString(lease.owner)) {
    fail('releaseInstallLease expects a lease returned by acquireInstallLease', { got: typeof lease });
  }
  if (!gate.holder || gate.holder.fence !== lease.fence) {
    const error = {
      code: 'package.transaction.fence',
      message: `lease fence ${lease.fence} (owner '${lease.owner}') is stale: the gate now holds fence ${gate.holder ? gate.holder.fence : 'none'}; a stale holder has no authority over the gate`,
      heldFence: gate.holder ? gate.holder.fence : null,
      offeredFence: lease.fence,
    };
    return Object.freeze({ ok: false, gate, reason: error.code, error: Object.freeze(error) });
  }
  return Object.freeze({ ok: true, gate: deepFreeze({ ...gate, holder: null }), reason: 'released' });
}

/** Whether `lease` may act on `gate` right now — the check a publisher must make. */
export function holdsInstallLease(gate, lease) {
  requireGate(gate, 'holdsInstallLease');
  return Boolean(gate.holder && isPlainObject(lease) && gate.holder.fence === lease.fence && gate.holder.owner === lease.owner);
}

/* ------------------------------------------------------------------ *
 * Journal
 * ------------------------------------------------------------------ */

/** The serializable journal: the steps as they happened, in order, with attempts. */
export function transactionJournal(transaction) {
  requireTransaction(transaction, 'transactionJournal');
  return deepFreeze({
    contract: PACKAGE_TRANSACTION_CONTRACT,
    schemaVersion: PACKAGE_TRANSACTION_SCHEMA_VERSION,
    transactionId: transaction.transactionId,
    identity: transaction.identity,
    digest: transaction.digest,
    source: transaction.source,
    status: transaction.status,
    epochDigest: transaction.epochDigest,
    leaseFence: transaction.leaseFence,
    reason: transaction.reason,
    steps: transaction.steps.map((entry) => ({ step: entry.step, status: entry.status, attempts: entry.attempts, seq: entry.seq, detail: entry.detail })),
  });
}

/** Deterministic digest of a journal — two identical histories have one digest. */
export function journalDigest(transaction) {
  return digestOf(stableJson(transactionJournal(transaction)));
}

/** `install:@scope/name@1.2.3 via npm:… 5/6 steps 4f2a…`. */
export function formatPackageTransaction(transaction) {
  requireTransaction(transaction, 'formatPackageTransaction');
  const done = transaction.steps.filter((entry) => entry.status === 'done').length;
  return `${transaction.transactionId} ${transaction.identity} via ${transaction.source} ${done}/${transaction.steps.length} steps ${transaction.status} ${journalDigest(transaction).slice(0, 12)}`;
}

/** Which steps are still owed, in order. */
export function pendingPackageSteps(transaction) {
  requireTransaction(transaction, 'pendingPackageSteps');
  return Object.freeze(transaction.steps.filter((entry) => entry.status === 'pending').map((entry) => entry.step));
}

/** The schema version this contract expects from its inputs (P6.1's). */
export const PACKAGE_TRANSACTION_INPUT_SCHEMA_VERSION = NODE_REGISTRY_SCHEMA_VERSION;
