/**
 * Orphan / tombstone / alias / deprecation — P6.10.
 *
 * PUBLIC CONTRACT (`node.lifecycle@0.1.0`, domain `node-registry`).
 *
 * An epoch is a set of identities. What an epoch cannot say is what has been
 * REMOVED, what has been RENAMED, what nobody uses any more, and which names must
 * never come back. Those four questions are what makes a registry safe to live
 * with, because the alternative to answering them is a name that gets re-used:
 *
 *   ORPHAN      a node nobody references — the honest answer to "can we remove
 *               this?", and a report, never an automatic uninstall;
 *   DEPRECATION a node that still resolves and still runs, with a replacement
 *               and the epoch it was deprecated at — the way out of a name;
 *   ALIAS       the OLD name continuing to work by pointing at the new one. One
 *               hop, deliberately: a chain is a redirect nobody can audit;
 *   TOMBSTONE   the name is retired. A tombstoned identity can never be
 *               re-declared, because the alternative is a supply-chain attack
 *               with a familiar name.
 *
 * THE ONE IRREVERSIBLE STATE. Every other transition here is a set of data on a
 * new frozen ledger — states can move back and forth, because registries are
 * governed by people who change their minds. A tombstone is permanent *within the
 * ledger*, and re-declaration is refused with the tombstone named. That asymmetry
 * is the whole point: the cost of an irreversible tombstone is a naming decision
 * made twice, and the cost of a reversible one is an attacker who waits.
 *
 * VOCABULARY IS QUOTED, NOT INVENTED. The states are P6.1's
 * `NODE_LIFECYCLE_STATES` (which quotes the P2 negotiation contract — eleven
 * words, `deprecated` among them). This contract adds EVENTS and RECORDS on top;
 * it does not add a twelfth word for something the foundation already names.
 *
 * WHAT THIS IS NOT (P6.10 scope walls, enforced by tests):
 *   - it does not ADMIT or health-check anything (P6.11) and does not quarantine:
 *     `failed` is a word here only because P6.1 publishes it;
 *   - it does not resolve workflows (P6.5) and does not uninstall (P6.3): an
 *     orphan report is an input to that decision, not the decision;
 *   - it does not read a catalog, a database or a clock: `atEpoch` is data the
 *     caller supplies, which is what makes a ledger reproducible;
 *   - no network, no randomness, no mutation.
 *
 * Authority: a ledger records what governance decided. It greys out names; it
 * never refuses a workflow by itself.
 */
import { createHash } from 'node:crypto';

import { NODE_LIFECYCLE_STATES } from './node-registry.mjs';

export const NODE_LIFECYCLE_CONTRACT = 'node.lifecycle@0.1.0';
export const NODE_LIFECYCLE_CONTRACT_VERSION = '0.1.0';
export const NODE_LIFECYCLE_SCHEMA_VERSION = 1;

export const NODE_LIFECYCLE_OPERATIONS = Object.freeze(['transition', 'deprecate', 'alias', 'tombstone', 'describe']);
export const NODE_LIFECYCLE_PERMISSIONS = Object.freeze(['node:read']);

/** The eleven foundation lifecycle states, re-exported so a reader has one source. */
export const LIFECYCLE_STATES = Object.freeze([...NODE_LIFECYCLE_STATES]);

export const LIFECYCLE_EVENTS = Object.freeze(['declare', 'transition', 'deprecate', 'alias', 'tombstone']);

/** The state every identity of a fresh epoch starts in. */
export const LIFECYCLE_INITIAL_STATE = 'declared';

/** A name retired here is retired everywhere, and this is the list of reasons. */
export const TOMBSTONE_GROUNDS = Object.freeze([
  'removed',
  'renamed',
  'compromised',
  'superseded',
  'policy',
]);

export const NODE_LIFECYCLE_REASONS = Object.freeze([
  'lifecycle.input',
  'lifecycle.epoch',
  'lifecycle.identity',
  'lifecycle.state',
  'lifecycle.replacement',
  'lifecycle.alias',
  'lifecycle.alias_chain',
  'lifecycle.tombstoned',
  'lifecycle.ledger',
]);

export const NODE_LIFECYCLE_RULES = Object.freeze({
  vocabulary: 'the states are P6.1\'s, which are the negotiation contract\'s: this contract adds events and records, never a twelfth word for something the foundation already names',
  orphan: 'an orphan is a report, never an automatic uninstall: the registry says which names nobody references, and a human decides what that means',
  deprecation: 'a deprecation names its replacement and the epoch it happened at: a name that can be retired without saying what replaces it is a name that will be re-used by whoever asks last',
  alias: 'an alias is one hop, and it may only exist for a retired name: a chain of redirects is a rename nobody can audit',
  tombstone: 'a tombstone is the only irreversible thing here, and re-declaring a tombstoned identity is refused with the tombstone named — the cost of that rule is a naming decision made twice, and the cost of the alternative is an attacker who waits',
  ledger: 'a ledger is data: every transition returns a new frozen ledger, the previous one is untouched, and the digest is what makes tampering visible',
  authority: 'a ledger records what governance decided; it greys out names and never refuses a workflow by itself',
});

/* ------------------------------------------------------------------ *
 * Errors
 * ------------------------------------------------------------------ */

/** Raised for API misuse. Governance refusals are returned as data. */
export class NodeLifecycleError extends Error {
  constructor(message, meta = {}) {
    super(message);
    this.name = 'NodeLifecycleError';
    this.code = 'lego.contract_violation';
    this.meta = Object.freeze({ ...meta });
  }
}

const fail = (message, meta) => { throw new NodeLifecycleError(message, meta); };
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

/* ------------------------------------------------------------------ *
 * Ledger
 * ------------------------------------------------------------------ */

const requireEpoch = (epoch) => {
  if (!isPlainObject(epoch) || !Number.isInteger(epoch.epochNumber) || !isNonEmptyString(epoch.epochDigest)) {
    fail('a lifecycle ledger is built for one compiled epoch (P6.2): pass the epoch, not an epoch number', { code: 'lifecycle.epoch', field: 'epoch' });
  }
  if (!isPlainObject(epoch.byIdentity) && !Array.isArray(epoch.identities)) {
    fail('the epoch must expose byIdentity or identities: an unreadable epoch cannot be governed', { code: 'lifecycle.epoch', field: 'epoch' });
  }
  return epoch;
};

const identitiesOf = (epoch) => (
  Array.isArray(epoch.identities) ? [...epoch.identities] : Object.keys(epoch.byIdentity)
);

const ledgerDigestOf = (epochNumber, epochDigest, entries) => digestOf(stableJson({
  epochNumber,
  epochDigest,
  entries: Object.keys(entries).sort().map((identity) => [identity, entries[identity]]),
}));

/** Build the lifecycle ledger of one compiled epoch: every identity starts `declared`. */
export function createLifecycleLedger(epoch) {
  const source = requireEpoch(epoch);
  const entries = {};
  for (const identity of identitiesOf(source).sort()) {
    entries[identity] = {
      identity,
      state: LIFECYCLE_INITIAL_STATE,
      aliasOf: null,
      deprecated: null,
      tombstone: null,
    };
  }
  return deepFreeze({
    ok: true,
    schemaVersion: NODE_LIFECYCLE_SCHEMA_VERSION,
    contract: NODE_LIFECYCLE_CONTRACT,
    epochNumber: source.epochNumber,
    epochDigest: source.epochDigest,
    entries: Object.freeze(entries),
    events: Object.freeze([]),
    ledgerDigest: ledgerDigestOf(source.epochNumber, source.epochDigest, entries),
  });
}

/** @returns {boolean} whether `value` is a ledger this contract produced. */
export function isLifecycleLedger(value) {
  return (
    isPlainObject(value) &&
    value.ok === true &&
    value.contract === NODE_LIFECYCLE_CONTRACT &&
    value.schemaVersion === NODE_LIFECYCLE_SCHEMA_VERSION &&
    isPlainObject(value.entries) &&
    typeof value.ledgerDigest === 'string' &&
    Object.isFrozen(value)
  );
}

const requireLedger = (ledger, fn) => {
  if (!isLifecycleLedger(ledger)) fail(`${fn} expects a ledger from createLifecycleLedger`, { got: typeof ledger });
};

const requireIdentity = (ledger, identity) => {
  if (!isNonEmptyString(identity)) {
    fail('an identity is required: a ledger is addressed by identity, not by index', { code: 'lifecycle.identity', field: 'identity' });
  }
  const entry = ledger.entries[identity];
  if (!entry) {
    fail(`'${identity}' is not in this epoch: a lifecycle ledger cannot govern a node the epoch does not contain`, { code: 'lifecycle.identity', field: 'identity' });
  }
  return entry;
};

const requireReason = (reason) => {
  if (!isNonEmptyString(reason)) {
    fail('a lifecycle change needs a reason: a name is retired for a reason, and the reason is the audit trail', { code: 'lifecycle.input', field: 'reason' });
  }
  return reason;
};

const atEpochOf = (ledger, atEpoch) => {
  if (atEpoch === undefined) return ledger.epochNumber;
  if (!Number.isInteger(atEpoch) || atEpoch < ledger.epochNumber) {
    fail(`atEpoch must be an integer at or after the ledger's epoch (${ledger.epochNumber})`, { code: 'lifecycle.epoch', field: 'atEpoch' });
  }
  return atEpoch;
};

const nextLedger = (ledger, entries, event) => deepFreeze({
  ok: true,
  schemaVersion: NODE_LIFECYCLE_SCHEMA_VERSION,
  contract: NODE_LIFECYCLE_CONTRACT,
  epochNumber: ledger.epochNumber,
  epochDigest: ledger.epochDigest,
  entries: Object.freeze(entries),
  events: Object.freeze([...ledger.events, Object.freeze(event)]),
  ledgerDigest: ledgerDigestOf(ledger.epochNumber, ledger.epochDigest, entries),
});

const withEntry = (ledger, identity, changes, event) => {
  const entries = { ...ledger.entries, [identity]: Object.freeze({ ...ledger.entries[identity], ...changes }) };
  return nextLedger(ledger, entries, event);
};

/** The entry for one identity: its state, its alias, its deprecation, its tombstone. */
export function lifecycleOf(ledger, identity) {
  requireLedger(ledger, 'lifecycleOf');
  return requireIdentity(ledger, identity);
}

/** @returns {boolean} whether the identity is retired and must never be re-declared. */
export function isTombstoned(ledger, identity) {
  requireLedger(ledger, 'isTombstoned');
  return requireIdentity(ledger, identity).tombstone !== null;
}

/** @returns {boolean} whether the name may be re-used by a future declaration. */
export function mayReuseName(ledger, identity) {
  return !isTombstoned(ledger, identity);
}

/* ------------------------------------------------------------------ *
 * Transitions
 * ------------------------------------------------------------------ */

/**
 * Move a node's lifecycle state. Any of the eleven foundation states is allowed,
 * including backwards: registries are governed by people who change their minds.
 * A tombstoned identity is the single exception.
 */
export function transitionNode(ledger, identity, { state, reason, atEpoch } = {}) {
  requireLedger(ledger, 'transitionNode');
  const entry = requireIdentity(ledger, identity);
  if (!LIFECYCLE_STATES.includes(state)) {
    fail(`unknown lifecycle state ${JSON.stringify(state)} — expected one of ${LIFECYCLE_STATES.join(', ')}`, { code: 'lifecycle.state', field: 'state' });
  }
  requireReason(reason);
  if (entry.tombstone) {
    return deepFreeze({
      ok: false,
      reason: 'lifecycle.tombstoned',
      identity,
      state: null,
      message: `'${identity}' is tombstoned (${entry.tombstone.reason} at epoch ${entry.tombstone.atEpoch}); a retired name does not come back to life, and that is the point`,
      errors: Object.freeze([{ code: 'lifecycle.tombstoned', field: 'identity', message: `tombstoned ${entry.tombstone.reason} at epoch ${entry.tombstone.atEpoch}` }]),
    });
  }
  if (entry.state === state) {
    return deepFreeze({ ok: true, reason: null, identity, state, ledger, changed: false, message: null });
  }
  const changed = withEntry(ledger, identity, { state }, {
    event: 'transition', identity, state, reason, atEpoch: atEpochOf(ledger, atEpoch),
  });
  return deepFreeze({ ok: true, reason: null, identity, state, ledger: changed, changed: true, message: null });
}

/**
 * Deprecate a node: it still resolves and still runs, it has a replacement, and
 * the record says when. The replacement must be a node this epoch actually
 * contains, or the deprecation is a redirect to nowhere.
 */
export function deprecateNode(ledger, identity, { replacedBy, reason, atEpoch } = {}) {
  requireLedger(ledger, 'deprecateNode');
  const entry = requireIdentity(ledger, identity);
  requireReason(reason);
  if (entry.tombstone) {
    return deepFreeze({
      ok: false,
      reason: 'lifecycle.tombstoned',
      identity,
      message: `'${identity}' is tombstoned: a retired name does not get a deprecation notice`,
      errors: Object.freeze([{ code: 'lifecycle.tombstoned', field: 'identity', message: 'already tombstoned' }]),
    });
  }
  if (!isNonEmptyString(replacedBy)) {
    fail('a deprecation must name its replacement: a name retired without saying what replaces it will be re-used by whoever asks last', { code: 'lifecycle.replacement', field: 'replacedBy' });
  }
  if (replacedBy === identity) {
    fail('a node cannot replace itself: that is not a deprecation, it is a typo', { code: 'lifecycle.replacement', field: 'replacedBy' });
  }
  if (!ledger.entries[replacedBy]) {
    return deepFreeze({
      ok: false,
      reason: 'lifecycle.replacement',
      identity,
      message: `the replacement '${replacedBy}' is not in this epoch: a deprecation may only point at a node that exists`,
      errors: Object.freeze([{ code: 'lifecycle.replacement', field: 'replacedBy', message: `'${replacedBy}' is absent from epoch ${ledger.epochNumber}` }]),
    });
  }
  const at = atEpochOf(ledger, atEpoch);
  const changed = withEntry(ledger, identity, {
    state: 'deprecated',
    deprecated: { atEpoch: at, replacedBy, reason },
  }, { event: 'deprecate', identity, replacedBy, reason, atEpoch: at });
  return deepFreeze({ ok: true, reason: null, identity, replacedBy, atEpoch: at, ledger: changed, changed: true, message: null });
}

/**
 * Point a retired name at its successor — one hop, and only for a name that has
 * actually been retired (`deprecated` or `disabled`). An alias is how an old
 * workflow keeps working across a rename; a chain is how nobody can tell what it
 * now runs.
 */
export function aliasNode(ledger, identity, { to, reason, atEpoch } = {}) {
  requireLedger(ledger, 'aliasNode');
  const entry = requireIdentity(ledger, identity);
  requireReason(reason);
  if (!isNonEmptyString(to)) {
    fail('an alias needs a target: this is a redirect, and a redirect to nothing is a deletion', { code: 'lifecycle.alias', field: 'to' });
  }
  if (to === identity) {
    fail('a node cannot alias itself: an alias to itself is a rename that never happened', { code: 'lifecycle.alias', field: 'to' });
  }
  const target = ledger.entries[to];
  if (!target) {
    return deepFreeze({
      ok: false,
      reason: 'lifecycle.alias',
      identity,
      to,
      message: `the alias target '${to}' is not in this epoch: an alias may only point at a node that exists`,
      errors: Object.freeze([{ code: 'lifecycle.alias', field: 'to', message: `'${to}' is absent from epoch ${ledger.epochNumber}` }]),
    });
  }
  if (target.aliasOf) {
    return deepFreeze({
      ok: false,
      reason: 'lifecycle.alias_chain',
      identity,
      to,
      message: `'${to}' is itself an alias (of '${target.aliasOf}'): aliases do not chain, because a rename nobody can audit is not a rename`,
      errors: Object.freeze([{ code: 'lifecycle.alias_chain', field: 'to', message: `'${to}' points at '${target.aliasOf}'` }]),
    });
  }
  if (target.tombstone) {
    return deepFreeze({
      ok: false,
      reason: 'lifecycle.tombstoned',
      identity,
      to,
      message: `the alias target '${to}' is tombstoned: a retired name cannot be the destination of anything`,
      errors: Object.freeze([{ code: 'lifecycle.tombstoned', field: 'to', message: 'target is tombstoned' }]),
    });
  }
  if (!(entry.deprecated || entry.state === 'deprecated' || entry.state === 'disabled')) {
    return deepFreeze({
      ok: false,
      reason: 'lifecycle.alias',
      identity,
      to,
      message: `'${identity}' is '${entry.state}': an alias exists for a name that has been retired, not for one that is still in service (deprecate or disable it first)`,
      errors: Object.freeze([{ code: 'lifecycle.alias', field: 'identity', message: `state is '${entry.state}'` }]),
    });
  }
  const changed = withEntry(ledger, identity, { aliasOf: to }, {
    event: 'alias', identity, target: to, reason, atEpoch: atEpochOf(ledger, atEpoch),
  });
  return deepFreeze({ ok: true, reason: null, identity, to, ledger: changed, changed: true, message: null });
}

/**
 * Retire a name permanently. After this, the identity cannot be re-declared, its
 * state cannot move, and nothing may alias TO it. The ledger keeps the record
 * forever; the epoch simply never grows this identity again.
 */
export function tombstoneNode(ledger, identity, { reason, grounds = 'removed', atEpoch } = {}) {
  requireLedger(ledger, 'tombstoneNode');
  const entry = requireIdentity(ledger, identity);
  requireReason(reason);
  if (!TOMBSTONE_GROUNDS.includes(grounds)) {
    fail(`unknown tombstone ground ${JSON.stringify(grounds)} — expected one of ${TOMBSTONE_GROUNDS.join(', ')}`, { code: 'lifecycle.input', field: 'grounds' });
  }
  const at = atEpochOf(ledger, atEpoch);
  if (entry.tombstone) {
    if (entry.tombstone.reason === reason && entry.tombstone.grounds === grounds && entry.tombstone.atEpoch === at) {
      return deepFreeze({ ok: true, reason: null, identity, ledger, changed: false, message: null });
    }
    return deepFreeze({
      ok: false,
      reason: 'lifecycle.tombstoned',
      identity,
      message: `'${identity}' is already tombstoned (${entry.tombstone.reason}); a tombstone is not edited, it is honoured`,
      errors: Object.freeze([{ code: 'lifecycle.tombstoned', field: 'identity', message: 'already tombstoned' }]),
    });
  }
  const changed = withEntry(ledger, identity, {
    state: 'disabled',
    tombstone: { atEpoch: at, reason, grounds },
  }, { event: 'tombstone', identity, reason, grounds, atEpoch: at });
  return deepFreeze({ ok: true, reason: null, identity, atEpoch: at, ledger: changed, changed: true, message: null });
}

/** One hop, or nothing: an alias never resolves through another alias. */
export function resolveAlias(ledger, identity) {
  requireLedger(ledger, 'resolveAlias');
  const entry = requireIdentity(ledger, identity);
  if (!entry.aliasOf) return deepFreeze({ identity, aliased: false, target: null, state: entry.state });
  return deepFreeze({ identity, aliased: true, target: entry.aliasOf, state: entry.state });
}

/* ------------------------------------------------------------------ *
 * Reports: orphans and dangling references
 * ------------------------------------------------------------------ */

/**
 * Which identities nobody references. `referenced` is the caller's fact (a
 * resolution manifest, a workflow scan); this is a report, never an uninstall.
 */
export function orphanNodes(ledger, { referenced = [] } = {}) {
  requireLedger(ledger, 'orphanNodes');
  if (!Array.isArray(referenced)) fail('referenced must be an array of identities', { code: 'lifecycle.input', field: 'referenced' });
  const wanted = new Set(referenced);
  return deepFreeze(Object.keys(ledger.entries).sort().filter((identity) => {
    const entry = ledger.entries[identity];
    if (wanted.has(identity)) return false;
    return !entry.tombstone && !entry.aliasOf;
  }));
}

/**
 * The two halves of the same question, and the second half is the dangerous one:
 * a node nobody references is a candidate for removal, while a REFERENCE nobody
 * provides is a workflow that cannot resolve.
 */
export function orphanReport(ledger, { referenced = [] } = {}) {
  requireLedger(ledger, 'orphanReport');
  const orphans = orphanNodes(ledger, { referenced });
  const known = new Set(Object.keys(ledger.entries));
  const dangling = [...new Set(referenced)].filter((identity) => !known.has(identity)).sort();
  return deepFreeze({
    epochNumber: ledger.epochNumber,
    epochDigest: ledger.epochDigest,
    orphans,
    dangling,
    referencedCount: new Set(referenced).size,
    nodeCount: Object.keys(ledger.entries).length,
  });
}

/* ------------------------------------------------------------------ *
 * Reads
 * ------------------------------------------------------------------ */

/** Counts by state, plus the retired names — the shape an operations page wants. */
export function describeLifecycle(ledger) {
  requireLedger(ledger, 'describeLifecycle');
  const byState = {};
  const deprecated = [];
  const aliases = {};
  const tombstones = [];
  for (const identity of Object.keys(ledger.entries).sort()) {
    const entry = ledger.entries[identity];
    byState[entry.state] = (byState[entry.state] ?? 0) + 1;
    if (entry.deprecated) deprecated.push(identity);
    if (entry.aliasOf) aliases[identity] = entry.aliasOf;
    if (entry.tombstone) tombstones.push(identity);
  }
  return deepFreeze({
    contract: ledger.contract,
    schemaVersion: ledger.schemaVersion,
    epochNumber: ledger.epochNumber,
    epochDigest: ledger.epochDigest,
    nodeCount: Object.keys(ledger.entries).length,
    byState: Object.freeze(byState),
    deprecated: Object.freeze(deprecated),
    aliases: Object.freeze(aliases),
    tombstones: Object.freeze(tombstones),
    eventCount: ledger.events.length,
    ledgerDigest: ledger.ledgerDigest,
  });
}

/**
 * Recompute the ledger's own digest and compare: an edited ledger cannot survive
 * this. When an epoch is supplied, the ledger must also belong to it, because a
 * lifecycle decision is attached to the epoch it was made in.
 */
export function verifyLifecycleLedger(ledger, epoch) {
  requireLedger(ledger, 'verifyLifecycleLedger');
  if (epoch !== undefined) {
    requireEpoch(epoch);
    if (ledger.epochDigest !== epoch.epochDigest || ledger.epochNumber !== epoch.epochNumber) {
      return deepFreeze({
        ok: false,
        reason: 'lifecycle.epoch',
        expected: ledger.epochDigest,
        actual: epoch.epochDigest,
        message: 'the ledger belongs to a different epoch: a lifecycle decision is attached to the epoch it was made in',
      });
    }
  }
  const recomputed = ledgerDigestOf(ledger.epochNumber, ledger.epochDigest, ledger.entries);
  if (recomputed !== ledger.ledgerDigest) {
    return deepFreeze({
      ok: false,
      reason: 'lifecycle.ledger',
      expected: ledger.ledgerDigest,
      actual: recomputed,
      message: 'the ledger digest does not match its own entries: the digest is what makes an edited ledger visible',
    });
  }
  return deepFreeze({ ok: true, reason: null, expected: ledger.ledgerDigest, actual: recomputed, message: null });
}

export const NODE_LIFECYCLE_INPUT_SCHEMA_VERSION = NODE_LIFECYCLE_SCHEMA_VERSION;
