/**
 * Registry integrity chain + freshness / anti-rollback — P6.16.
 *
 * PUBLIC CONTRACT (`registry.integrity@0.1.0`, domain `node-registry`).
 *
 * P6.2 compiles epochs and P6.13 makes them cheap to produce. Neither answers the
 * question a client actually asks before it serves anything: **"is this the
 * registry, and is it the newest one I should believe?"**
 *
 * THE CHAIN. Each epoch is appended as a LINK: `{ index, epochNumber, epochDigest,
 * origin, source, parentLinkDigest, linkDigest }`, where a link's digest covers its
 * own fields plus the previous link's digest. Rewriting one link therefore
 * rewrites every link after it, and a rewrite is DETECTED rather than argued about.
 *
 * THREE REFUSALS THAT MATTER MORE THAN THE HAPPY PATH:
 *
 *   MONOTONIC     an epoch number that does not increase is refused — and a number
 *                 that reappears with DIFFERENT bytes is a FORK, not a lag
 *   CONTINUITY    an epoch that declares a parent must declare THIS head as its
 *                 parent; a chain is not a pile of epochs that happen to be nearby
 *   IDEMPOTENT    re-appending the identical epoch is `changed: false`, because a
 *                 retrying replicator must not be able to grow a chain by accident
 *
 * ANTI-ROLLBACK IS A CLIENT PROPERTY, NOT A SERVER ONE. A server cannot tell that
 * it is old; only a client that REMEMBERS can. So this contract takes a WITNESS —
 * a small receipt of "the highest epoch I have seen, and its link digest" — and
 * answers three states and no fourth: `current` (the chain extends what the client
 * saw, with `behindBy` naming how far it has to catch up), `rollback` (the chain is
 * OLDER than the witness, or the witnessed link is gone or replaced — history was
 * rewritten), `unknown` (no recall exists).
 *
 * `unknown` FAILS CLOSED. A client with no recall cannot detect a rollback, and
 * calling that "fine" would defeat the mechanism: the caller must say
 * `firstContact: true` out loud, which is a statement that it is accepting a
 * registry it cannot compare to anything.
 *
 * AND A ROLLBACK CAN BE ACCEPTED, ON THE RECORD. Disaster recovery genuinely does
 * mean serving an older registry. That is allowed only through an explicit
 * exception — a reason, an actor and a tick — and the result says so in its own
 * field, so "we rolled back" is a decision somebody made rather than a drift nobody
 * noticed.
 *
 * A RECOVERY EPOCH IS NOT A ROLLBACK. P6.2's rule is quoted here: a rollback is a
 * NEW epoch carrying older content, so its NUMBER increases and the chain accepts
 * it, while its `origin` records what it is. The chain refuses going backwards; it
 * does not refuse going back to older content, which is exactly the difference
 * between a mechanism and a superstition.
 *
 * WHAT THIS IS NOT (P6.16 scope walls, enforced by tests):
 *   - it does not compile or publish epochs (P6.2/P6.13): it records the ones it is
 *     handed and refuses the ones that contradict its own history;
 *   - it does not verify signatures or attestations (P6.12/P6.27) and does not
 *     define delegated trust roles, snapshots or expiry windows (P6.28): the chain
 *     is a hash chain, and pretending a hash chain is a PKI is how people stop
 *     checking the signatures they do have;
 *   - it does not repair a chain (P6.30) and does not quarantine anyone (P6.11):
 *     a broken chain is REPORTED, and the decision to stop serving belongs to the
 *     caller;
 *   - no clock: a witness carries the tick it was taken at, and freshness is judged
 *     against a client's recall rather than against a wall clock.
 *
 * Authority: a verified chain says the registry's history is intact. It never says
 * the nodes are safe to run — that is capability, health and lease.
 */
import { createHash } from 'node:crypto';

import { isFrozenRegistryEpoch } from './registry-compiler.mjs';

export const REGISTRY_INTEGRITY_CONTRACT = 'registry.integrity@0.1.0';
export const REGISTRY_INTEGRITY_CONTRACT_VERSION = '0.1.0';
export const REGISTRY_INTEGRITY_SCHEMA_VERSION = 1;

export const REGISTRY_INTEGRITY_OPERATIONS = Object.freeze(['append', 'verify', 'freshness', 'witness', 'describe']);
export const REGISTRY_INTEGRITY_PERMISSIONS = Object.freeze(['node:read']);

/** What a client can conclude about a chain, given what it remembers. */
export const FRESHNESS_STATES = Object.freeze(['current', 'rollback', 'unknown']);

export const REGISTRY_INTEGRITY_REASONS = Object.freeze([
  'integrity.input',
  'integrity.epoch',
  'integrity.monotonic',
  'integrity.continuity',
  'integrity.fork',
  'integrity.link',
  'integrity.rollback',
  'integrity.witness',
]);

export const REGISTRY_INTEGRITY_RULES = Object.freeze({
  chain: 'a link\'s digest covers the previous link\'s digest: rewriting one link rewrites every link after it, and a rewrite is detected rather than argued about',
  monotonic: 'an epoch number that does not increase is refused, and a number that reappears with different bytes is a FORK rather than a lag — the two are told apart on purpose',
  continuity: 'an epoch that declares a parent must declare THIS head: a chain is not a pile of epochs that happen to be nearby',
  idempotent: 're-appending the identical epoch changes nothing, because a retrying replicator must not be able to grow a chain by accident',
  recovery: 'a recovery epoch is not a rollback: it is a NEW epoch carrying older content, so its number increases and its origin records what it is',
  witness: 'anti-rollback is a client property: a server cannot tell that it is old, so the caller brings a witness of what it has seen, and "no recall" must be stated as firstContact rather than assumed',
  exception: 'a rollback can be accepted on the record — a reason, an actor and a tick — so that "we rolled back" is a decision somebody made rather than a drift nobody noticed',
  broken: 'a chain that does not verify is not a rollback and cannot be excepted: an exception accepts an older registry, never a corrupt one, and a rewrite behind the head is caught by verifying the chain rather than by the witness',
  authority: 'a verified chain says the history is intact; it never says the nodes are safe to run',
});

/* ------------------------------------------------------------------ *
 * Errors, helpers
 * ------------------------------------------------------------------ */

/** Raised for API misuse. A refused append or a rollback is returned as data. */
export class RegistryIntegrityError extends Error {
  constructor(message, meta = {}) {
    super(message);
    this.name = 'RegistryIntegrityError';
    this.code = 'lego.contract_violation';
    this.meta = Object.freeze({ ...meta });
  }
}

const fail = (message, meta) => { throw new RegistryIntegrityError(message, meta); };
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

const requireTick = (tick, field) => {
  if (!Number.isInteger(tick) || tick < 0) fail(`${field} must be a non-negative integer tick: a witness records WHEN it was taken, and a clock is still not a witness`, { code: 'integrity.input', field });
  return tick;
};

/* ------------------------------------------------------------------ *
 * Links
 * ------------------------------------------------------------------ */

const linkPayload = ({ index, epochNumber, epochDigest, origin, source, parentLinkDigest }) =>
  ({ index, epochNumber, epochDigest, origin, source, parentLinkDigest });

const makeLink = (epoch, index, parentLinkDigest) => {
  const payload = linkPayload({
    index,
    epochNumber: epoch.epochNumber,
    epochDigest: epoch.epochDigest,
    origin: epoch.origin,
    source: epoch.source,
    parentLinkDigest,
  });
  return Object.freeze({ ...payload, linkDigest: digestOf(stableJson(payload)) });
};

/** @returns {boolean} whether `value` is a link this contract produced. */
export function isIntegrityLink(value) {
  return (
    isPlainObject(value) &&
    Number.isInteger(value.index) &&
    Number.isInteger(value.epochNumber) &&
    typeof value.epochDigest === 'string' &&
    typeof value.linkDigest === 'string' &&
    Object.isFrozen(value)
  );
}

const chainDigestOf = (links) => digestOf(stableJson(links.map((link) => link.linkDigest)));

/** An empty chain, ready for its first epoch. */
export function createIntegrityChain() {
  return deepFreeze({
    ok: true,
    schemaVersion: REGISTRY_INTEGRITY_SCHEMA_VERSION,
    contract: REGISTRY_INTEGRITY_CONTRACT,
    links: Object.freeze([]),
    head: null,
    chainDigest: chainDigestOf([]),
  });
}

/** @returns {boolean} whether `value` is a chain this contract produced. */
export function isIntegrityChain(value) {
  return (
    isPlainObject(value) &&
    value.ok === true &&
    value.contract === REGISTRY_INTEGRITY_CONTRACT &&
    value.schemaVersion === REGISTRY_INTEGRITY_SCHEMA_VERSION &&
    Array.isArray(value.links) &&
    typeof value.chainDigest === 'string' &&
    Object.isFrozen(value)
  );
}

const requireChain = (chain, fn) => {
  if (!isIntegrityChain(chain)) fail(`${fn} expects a chain from createIntegrityChain`, { got: typeof chain });
};

const requireEpoch = (epoch, fn) => {
  if (!isFrozenRegistryEpoch(epoch)) fail(`${fn} expects an epoch compiled by registry.compiler`, { code: 'integrity.epoch', field: 'epoch' });
};

/* ------------------------------------------------------------------ *
 * Appending
 * ------------------------------------------------------------------ */

const refusal = (reason, message, extra = {}) => deepFreeze({
  ok: false,
  schemaVersion: REGISTRY_INTEGRITY_SCHEMA_VERSION,
  contract: REGISTRY_INTEGRITY_CONTRACT,
  reason,
  chain: null,
  link: null,
  changed: false,
  message,
  ...extra,
});

/**
 * Append an epoch to the chain.
 *
 * The three refusals are the point: a number that does not increase, an epoch whose
 * declared parent is not this head, and a number that reappears with different
 * bytes (a fork).
 */
export function appendEpoch(chain, epoch) {
  requireChain(chain, 'appendEpoch');
  requireEpoch(epoch, 'appendEpoch');

  const existing = chain.links.find((link) => link.epochNumber === epoch.epochNumber);
  if (existing) {
    if (existing.epochDigest === epoch.epochDigest) {
      return deepFreeze({
        ok: true,
        schemaVersion: REGISTRY_INTEGRITY_SCHEMA_VERSION,
        contract: REGISTRY_INTEGRITY_CONTRACT,
        reason: null,
        chain,
        link: existing,
        changed: false,
        message: null,
      });
    }
    return refusal('integrity.fork', `epoch ${epoch.epochNumber} is already chained as ${existing.epochDigest} and this epoch is ${epoch.epochDigest}: two different registries claim one epoch number, and that is a fork rather than a lag`, { forkOf: existing.epochDigest });
  }

  const head = chain.head;
  if (head && epoch.epochNumber <= head.epochNumber) {
    return refusal('integrity.monotonic', `epoch ${epoch.epochNumber} does not increase on the chain head ${head.epochNumber}: a chain that accepts a lower number is a set, not a chain`);
  }

  if (head && epoch.parentEpochDigest !== head.epochDigest) {
    return refusal('integrity.continuity', `epoch ${epoch.epochNumber} declares parent ${JSON.stringify(epoch.parentEpochDigest)} and the chain head is ${head.epochDigest}: an epoch that does not continue this history is not part of it`, { expectedParent: head.epochDigest });
  }
  if (!head && epoch.parentEpochDigest !== null && epoch.parentEpochDigest !== undefined) {
    return refusal('integrity.continuity', `epoch ${epoch.epochNumber} declares a parent and the chain is empty: a first link with a parent points at a history this chain does not have`, { expectedParent: null });
  }

  const link = makeLink(epoch, chain.links.length + 1, head ? head.linkDigest : null);
  const links = Object.freeze([...chain.links, link]);
  const nextChain = deepFreeze({
    ok: true,
    schemaVersion: REGISTRY_INTEGRITY_SCHEMA_VERSION,
    contract: REGISTRY_INTEGRITY_CONTRACT,
    links,
    head: link,
    chainDigest: chainDigestOf(links),
  });
  return deepFreeze({
    ok: true,
    schemaVersion: REGISTRY_INTEGRITY_SCHEMA_VERSION,
    contract: REGISTRY_INTEGRITY_CONTRACT,
    reason: null,
    chain: nextChain,
    link,
    changed: true,
    message: null,
  });
}

/* ------------------------------------------------------------------ *
 * Verifying
 * ------------------------------------------------------------------ */

/** Recompute the chain from its own links: the digests, the continuity, the numbers. */
export function verifyChain(chain) {
  requireChain(chain, 'verifyChain');
  const failures = [];
  let parentLinkDigest = null;
  let previousEpochNumber = 0;
  for (const [offset, link] of chain.links.entries()) {
    const expectedIndex = offset + 1;
    if (link.index !== expectedIndex) failures.push({ code: 'integrity.link', field: 'index', message: `link ${offset} is indexed ${link.index}, expected ${expectedIndex}` });
    if (link.parentLinkDigest !== parentLinkDigest) {
      failures.push({ code: 'integrity.link', field: 'parentLinkDigest', message: `link ${link.index} points at ${JSON.stringify(link.parentLinkDigest)} and the previous link is ${JSON.stringify(parentLinkDigest)}: the chain was reassembled from parts` });
    }
    const recomputed = digestOf(stableJson(linkPayload(link)));
    if (recomputed !== link.linkDigest) {
      failures.push({ code: 'integrity.link', field: 'linkDigest', message: `link ${link.index} (epoch ${link.epochNumber}) has digest ${link.linkDigest} and its content hashes to ${recomputed}: the link was edited after it was appended` });
    }
    if (link.epochNumber <= previousEpochNumber) {
      failures.push({ code: 'integrity.monotonic', field: 'epochNumber', message: `link ${link.index} carries epoch ${link.epochNumber} after ${previousEpochNumber}: a verified chain only ever increases` });
    }
    previousEpochNumber = link.epochNumber;
    parentLinkDigest = link.linkDigest;
  }
  const expectedChainDigest = chainDigestOf(chain.links);
  if (expectedChainDigest !== chain.chainDigest) {
    failures.push({ code: 'integrity.link', field: 'chainDigest', message: `the chain digest is ${chain.chainDigest} and its links hash to ${expectedChainDigest}: the link list is not the one that was summarized` });
  }
  const head = chain.links.length === 0 ? null : chain.links[chain.links.length - 1];
  if (stableJson(head) !== stableJson(chain.head)) {
    failures.push({ code: 'integrity.link', field: 'head', message: 'the chain head is not the last link: a head that is not the end is how a truncation hides' });
  }
  return deepFreeze({
    ok: failures.length === 0,
    schemaVersion: REGISTRY_INTEGRITY_SCHEMA_VERSION,
    contract: REGISTRY_INTEGRITY_CONTRACT,
    verified: failures.length === 0,
    linkCount: chain.links.length,
    headEpochNumber: head ? head.epochNumber : null,
    chainDigest: chain.chainDigest,
    failures: Object.freeze(failures.map((entry) => Object.freeze(entry))),
    message: failures.length === 0 ? null : failures.map((entry) => entry.message).join('; '),
  });
}

/** Prove that one epoch is the epoch this link recorded. */
export function verifyLink(link, epoch) {
  if (!isIntegrityLink(link)) fail('verifyLink expects a link from appendEpoch', { code: 'integrity.link', field: 'link' });
  requireEpoch(epoch, 'verifyLink');
  const matches = link.epochNumber === epoch.epochNumber && link.epochDigest === epoch.epochDigest;
  return deepFreeze({
    ok: matches,
    schemaVersion: REGISTRY_INTEGRITY_SCHEMA_VERSION,
    contract: REGISTRY_INTEGRITY_CONTRACT,
    verified: matches,
    linkEpochNumber: link.epochNumber,
    epochNumber: epoch.epochNumber,
    linkEpochDigest: link.epochDigest,
    epochDigest: epoch.epochDigest,
    message: matches
      ? null
      : `the chain records epoch ${link.epochNumber} as ${link.epochDigest} and this epoch is ${epoch.epochNumber} as ${epoch.epochDigest}: an epoch that is not its link is not part of this history`,
  });
}

/* ------------------------------------------------------------------ *
 * Witnesses and freshness
 * ------------------------------------------------------------------ */

/**
 * A witness: what a client remembers about a chain it has seen. It is small on
 * purpose — it must be cheap to keep in a config file on a machine that is offline
 * for a year and still detects a rollback when it comes back.
 */
export function witnessChain(chain, { witnessId, tick, installationId = null } = {}) {
  requireChain(chain, 'witnessChain');
  if (!isNonEmptyString(witnessId)) fail('a witness must name itself: an anonymous receipt cannot be cited when a rollback is questioned', { code: 'integrity.witness', field: 'witnessId' });
  requireTick(tick, 'tick');
  if (chain.head === null) {
    fail('an empty chain cannot be witnessed: there is no history to remember yet', { code: 'integrity.witness', field: 'chain' });
  }
  const payload = {
    witnessId,
    installationId,
    epochNumber: chain.head.epochNumber,
    epochDigest: chain.head.epochDigest,
    linkDigest: chain.head.linkDigest,
    chainDigest: chain.chainDigest,
    linkCount: chain.links.length,
    tick,
  };
  return deepFreeze({ ok: true, schemaVersion: REGISTRY_INTEGRITY_SCHEMA_VERSION, contract: REGISTRY_INTEGRITY_CONTRACT, ...payload, witnessDigest: digestOf(stableJson(payload)) });
}

/** @returns {boolean} whether `value` is a witness this contract produced. */
export function isWitnessReceipt(value) {
  return (
    isPlainObject(value) &&
    value.ok === true &&
    value.contract === REGISTRY_INTEGRITY_CONTRACT &&
    Number.isInteger(value.epochNumber) &&
    typeof value.witnessDigest === 'string' &&
    Object.isFrozen(value)
  );
}

/**
 * Is this chain current, a rollback, or unknowable — given what the client saw?
 *
 * @param {object} chain the chain being presented
 * @param {{ witness?: object, firstContact?: boolean, rollbackException?: { reason: string, actor?: string, tick: number } }} [options]
 */
export function checkFreshness(chain, { witness = null, firstContact = false, rollbackException = null } = {}) {
  requireChain(chain, 'checkFreshness');
  if (!chain.head) fail('an empty chain has no freshness to check: there is nothing to serve and nothing to compare', { code: 'integrity.input', field: 'chain' });

  /**
   * A BROKEN chain is not a rollback and cannot be excepted: an exception accepts
   * an older registry, never a corrupt one. A rewrite behind the head is caught
   * here rather than by the witness, because a witness names the head and the
   * head's digest covers its ancestors — so the chain must first BE a chain.
   */
  const broken = (message, detail = {}) => deepFreeze({
    ok: false, schemaVersion: REGISTRY_INTEGRITY_SCHEMA_VERSION, contract: REGISTRY_INTEGRITY_CONTRACT,
    state: 'rollback', accepted: false, fresh: false, exception: null, witness: witness ?? null,
    detail: Object.freeze(detail), message,
  });

  const integrity = verifyChain(chain);
  if (!integrity.ok) {
    return broken(`the chain does not verify (${integrity.failures[0].code} at ${integrity.failures[0].field}): an exception accepts an older registry, never a corrupt one — ${integrity.failures[0].message}`, { reason: 'integrity.link', broken: true });
  }

  const rollback = (message, detail = {}) => {
    if (rollbackException === null) {
      return deepFreeze({
        ok: false, schemaVersion: REGISTRY_INTEGRITY_SCHEMA_VERSION, contract: REGISTRY_INTEGRITY_CONTRACT,
        state: 'rollback', accepted: false, fresh: false, exception: null, witness: witness ?? null, detail: Object.freeze(detail), message,
      });
    }
    if (!isPlainObject(rollbackException) || !isNonEmptyString(rollbackException.reason) || !Number.isInteger(rollbackException.tick) || rollbackException.tick < 0) {
      fail('a rollback exception needs a reason and a tick: an exception nobody wrote down is a drift', { code: 'integrity.input', field: 'rollbackException' });
    }
    const exception = Object.freeze({
      reason: rollbackException.reason,
      actor: rollbackException.actor ?? null,
      tick: rollbackException.tick,
    });
    return deepFreeze({
      ok: true, schemaVersion: REGISTRY_INTEGRITY_SCHEMA_VERSION, contract: REGISTRY_INTEGRITY_CONTRACT,
      state: 'rollback', accepted: true, fresh: false, exception, witness: witness ?? null, detail: Object.freeze(detail),
      message: `${message} — accepted under an explicit exception (${exception.actor ?? 'unnamed'}: ${exception.reason} at tick ${exception.tick}): "we rolled back" is a decision somebody made rather than a drift nobody noticed`,
    });
  };

  if (witness === null) {
    if (firstContact !== true) {
      return deepFreeze({
        ok: false, schemaVersion: REGISTRY_INTEGRITY_SCHEMA_VERSION, contract: REGISTRY_INTEGRITY_CONTRACT,
        state: 'unknown', accepted: false, fresh: false, exception: null, witness: null,
        detail: Object.freeze({ reason: 'integrity.witness' }),
        message: 'no witness was supplied: a client with no recall cannot detect a rollback, and calling that fine would defeat the mechanism — say firstContact if this installation genuinely has nothing to remember',
      });
    }
    return deepFreeze({
      ok: true, schemaVersion: REGISTRY_INTEGRITY_SCHEMA_VERSION, contract: REGISTRY_INTEGRITY_CONTRACT,
      state: 'unknown', accepted: true, fresh: false, exception: null, witness: null,
      detail: Object.freeze({ firstContact: true }),
      message: `first contact: this installation accepts epoch ${chain.head.epochNumber} with nothing to compare it against, and the witness it stores now is what makes the NEXT rollback detectable`,
    });
  }

  if (!isWitnessReceipt(witness)) fail('checkFreshness expects a witness from witnessChain (or null)', { code: 'integrity.witness', field: 'witness' });

  if (witness.epochNumber > chain.head.epochNumber) {
    return rollback(`the client has seen epoch ${witness.epochNumber} and this chain stops at ${chain.head.epochNumber}: a registry older than what the client remembers is a rollback, whatever it says about itself`, { witnessedEpochNumber: witness.epochNumber, headEpochNumber: chain.head.epochNumber });
  }

  const witnessedLink = chain.links.find((link) => link.epochNumber === witness.epochNumber);
  if (witnessedLink && witnessedLink.linkDigest !== witness.linkDigest) {
    return rollback(`epoch ${witness.epochNumber} is chained as ${witnessedLink.linkDigest} and the client's witness recorded ${witness.linkDigest}: the history was rewritten, which is worse than being old`, { witnessedEpochNumber: witness.epochNumber, rewritten: true });
  }
  if (!witnessedLink) {
    return rollback(`the client's witness names epoch ${witness.epochNumber} and this chain does not contain it: a history that lost a link it used to have is not a shorter history, it is a different one`, { witnessedEpochNumber: witness.epochNumber, missing: true });
  }

  const behindBy = chain.head.epochNumber - witness.epochNumber;
  const current = chain.head.linkDigest === witness.linkDigest || behindBy >= 0;
  if (!current) {
    return rollback('the chain head is not the witnessed head and the difference is negative', { witnessedEpochNumber: witness.epochNumber, headEpochNumber: chain.head.epochNumber });
  }
  return deepFreeze({
    ok: true, schemaVersion: REGISTRY_INTEGRITY_SCHEMA_VERSION, contract: REGISTRY_INTEGRITY_CONTRACT,
    state: 'current', accepted: true, fresh: behindBy === 0, exception: null, witness,
    detail: Object.freeze({ witnessedEpochNumber: witness.epochNumber, headEpochNumber: chain.head.epochNumber, behindBy, rewritten: false, missing: false }),
    message: behindBy === 0
      ? null
      : `the chain extends what the client saw: ${behindBy} epoch(s) to catch up`,
  });
}

/* ------------------------------------------------------------------ *
 * Reads
 * ------------------------------------------------------------------ */

/** The head link, or null for an empty chain. */
export function chainHead(chain) {
  requireChain(chain, 'chainHead');
  return chain.head;
}

/** The epoch number of the head, or null. */
export function headEpochNumber(chain) {
  requireChain(chain, 'headEpochNumber');
  return chain.head ? chain.head.epochNumber : null;
}

/** The link for an epoch number, or null. */
export function findLink(chain, epochNumber) {
  requireChain(chain, 'findLink');
  if (!Number.isInteger(epochNumber) || epochNumber < 1) fail('findLink expects an epoch number', { code: 'integrity.input', field: 'epochNumber' });
  return chain.links.find((link) => link.epochNumber === epochNumber) ?? null;
}

/** How many links the chain holds. */
export function linkCount(chain) {
  requireChain(chain, 'linkCount');
  return chain.links.length;
}

/** Counts, head and digest — the shape an operations page wants. */
export function describeChain(chain) {
  requireChain(chain, 'describeChain');
  return deepFreeze({
    contract: chain.contract,
    schemaVersion: chain.schemaVersion,
    linkCount: chain.links.length,
    firstEpochNumber: chain.links.length === 0 ? null : chain.links[0].epochNumber,
    headEpochNumber: chain.head ? chain.head.epochNumber : null,
    headEpochDigest: chain.head ? chain.head.epochDigest : null,
    headLinkDigest: chain.head ? chain.head.linkDigest : null,
    chainDigest: chain.chainDigest,
    origins: Object.freeze([...new Set(chain.links.map((link) => link.origin))].sort()),
  });
}

/** A sentence an operator can check, and a rollout can be stopped by. */
export function explainIntegrity(result) {
  if (isIntegrityChain(result)) {
    const described = describeChain(result);
    return described.linkCount === 0
      ? 'the integrity chain is empty'
      : `integrity chain: ${described.linkCount} link(s), epochs ${described.firstEpochNumber}…${described.headEpochNumber}, head ${described.headLinkDigest.slice(0, 18)}…`;
  }
  if (!isPlainObject(result)) fail('explainIntegrity expects a chain, an append result or a freshness check', { got: typeof result });
  if (result.state !== undefined) {
    if (result.state === 'current') return `freshness: current (${result.detail.behindBy} epoch(s) behind the head)`;
    if (result.state === 'unknown') return `freshness: unknown — ${result.message}`;
    return `freshness: ROLLBACK${result.accepted ? ' (accepted under an explicit exception)' : ' — refused'} — ${result.message}`;
  }
  // A refusal has no link and no chain: read the outcome before reading its parts,
  // or an explainer becomes the thing that throws.
  if (result.ok === false) return `append refused: ${result.reason} — ${result.message}`;
  if (result.changed === true && isIntegrityLink(result.link)) {
    return `epoch ${result.link.epochNumber} appended as link ${result.link.index} (${result.link.linkDigest.slice(0, 18)}…)`;
  }
  if (result.changed === false && isIntegrityLink(result.link)) return `epoch ${result.link.epochNumber} is already chained: nothing changed`;
  return `append returned neither a link nor a refusal: ${JSON.stringify({ ok: result.ok, changed: result.changed })}`;
}

export const REGISTRY_INTEGRITY_INPUT_SCHEMA_VERSION = REGISTRY_INTEGRITY_SCHEMA_VERSION;
