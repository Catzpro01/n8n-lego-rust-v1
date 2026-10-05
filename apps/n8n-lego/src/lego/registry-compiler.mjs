/**
 * Registry compiler — P6.2 (Registry Compiler + Immutable Epoch).
 *
 * PUBLIC CONTRACT (`registry.compiler@0.1.0`, domain `node-registry`).
 *
 * P6.1 fixed what a node declaration IS (identity `type@typeVersion`, a closed
 * 17-field metadata schema, fail-closed validation, duplicate identity is a
 * conflict). It deliberately stopped there: it validates and indexes, but it
 * never publishes anything. P6.2 is the step that turns a pile of declarations
 * into a registry the rest of the system is allowed to depend on.
 *
 * A declaration is a CLAIM. An epoch is a COMMITMENT. Everything downstream —
 * workflow resolution (P6.5), runtime leases (P6.6), compat replay (P6.9),
 * rollback (P6.19) — reads a compiled epoch, never a source list.
 *
 * The four guarantees this module exists to provide:
 *
 *   1. DETERMINISTIC COMPILE. The epoch digest is a pure function of the
 *      declaration CONTENT and the lineage it is compiled onto. Key order,
 *      declaration order and capability order do not move it; a one-bit change
 *      to any declaration always does. Two hosts compiling the same source onto
 *      the same parent produce the same digest, with no clock and no network.
 *
 *   2. ALL-OR-NOTHING. A source that contains one invalid declaration, or two
 *      declarations of the same identity, compiles to nothing. There is no
 *      partial epoch, no "best effort" subset and no last-writer-wins: the
 *      compiler returns no epoch at all (P6.1's `registry.duplicate` reason,
 *      carried through unchanged rather than re-invented).
 *
 *   3. MONOTONIC, CHAINED HISTORY. An epoch carries its parent's digest and a
 *      chain of every digest before it. Epoch numbers only ever increase — a
 *      rollback is a NEW epoch that re-installs older CONTENT, never a rewind of
 *      the counter. That is what makes "which registry is deployed?" answerable
 *      after a rollback, and what makes a silent downgrade detectable (P6.16
 *      extends this into a signed freshness anchor; the ordering rule is fixed
 *      here because every later milestone reads it).
 *
 *   4. IMMUTABILITY. A compiled epoch is deep-frozen. Publication is a pointer
 *      move between frozen objects, not a mutation: the previous epoch is
 *      bit-identical after the next one is published, which is what allows an
 *      in-flight execution to keep serving from the epoch it started under
 *      while a new one becomes current (P6.6 drain, P6.19 canary).
 *
 * WHAT THIS IS NOT (P6.2 scope walls, enforced by tests):
 *   - no package mutation, no install journal, no single-flight         (P6.3)
 *   - no dependency closure, no content-addressed artifact store        (P6.4)
 *   - no workflow pinning, no runtime lease, no residency tier          (P6.5-P6.7)
 *   - no capability compilation, no semantic fingerprint, no replay     (P6.8/P6.9)
 *   - no health, no quarantine, no supply-chain attestation             (P6.11-P6.29)
 *   - no filesystem, no network, no timers, no wall clock, no randomness:
 *     `source` is a label the CALLER supplies, because a compiler that reads a
 *     clock is not reproducible, and reproducibility is the whole point.
 *
 * Authority: nothing here grants trust or capability. Compiling a declaration
 * makes it legible, not admissible; admission stays a later milestone's
 * decision. Unknown values keep failing closed exactly as P6.1 defined them —
 * the compiler adds no vocabulary of its own and quotes P6.1 for identity,
 * validation and per-declaration digests.
 */
import { createHash } from 'node:crypto';

import {
  NODE_REGISTRY_SCHEMA_VERSION,
  canonicalNodeRegistryDeclaration,
  indexNodeRegistryDeclarations,
  nodeIdentity,
} from './node-registry.mjs';

/** The contract this module publishes. Bumping it is a governance event. */
export const REGISTRY_COMPILER_CONTRACT = 'registry.compiler@0.1.0';
export const REGISTRY_COMPILER_CONTRACT_VERSION = '0.1.0';
export const REGISTRY_COMPILER_SCHEMA_VERSION = 1;

/** Operations this contract offers. `call` interaction, idempotent, in-process. */
export const REGISTRY_COMPILER_OPERATIONS = Object.freeze(['compile', 'publish', 'rollback', 'diff']);

/** Permission vocabulary is P6.1's; compilation reads the registry, it never writes it. */
export const REGISTRY_COMPILER_PERMISSIONS = Object.freeze(['node:read']);

/** The first epoch a registry can have. Zero is not an epoch number. */
export const REGISTRY_EPOCH_GENESIS = 1;

/** How an epoch came to exist. Both are monotonically numbered epochs. */
export const REGISTRY_EPOCH_ORIGINS = Object.freeze(['compile', 'rollback']);

/** Bounded label length for `source` — a provenance label, not a log line. */
export const REGISTRY_EPOCH_SOURCE_MAX_LENGTH = 200;

/** Closed refusal vocabulary, same `lego.*` family and same `registry.*` prefix as P6.1. */
export const REGISTRY_COMPILER_REASONS = Object.freeze([
  'registry.epoch.source',
  'registry.epoch.number',
  'registry.epoch.parent',
  'registry.epoch.monotonic',
  'registry.epoch.unknown_target',
  'registry.epoch.digest',
  'registry.epoch.invalid',
]);

export const REGISTRY_COMPILER_RULES = Object.freeze({
  identity: 'identity, validation and per-declaration digests are P6.1 facts; the compiler quotes them and never re-derives them',
  determinism: 'the epoch digest depends on content and lineage only — never on key order, declaration order or the host clock',
  atomicity: 'one invalid declaration or one duplicate identity compiles to no epoch at all; there is no partial publication',
  monotonic: 'epoch numbers increase even across a rollback: a rollback is a new epoch carrying older content',
  lineage: 'every epoch names its parent digest and carries the full chain, so a downgrade is visible instead of silent',
  immutability: 'a compiled epoch is deep-frozen; publication moves a pointer and leaves the previous epoch bit-identical',
  authority: 'compiling is not admitting: an epoch is legible, not trusted, and grants no capability',
});

/* ------------------------------------------------------------------ *
 * Errors — the same LEGO contract-violation family as P6.1
 * ------------------------------------------------------------------ */

export class RegistryCompilerError extends Error {
  constructor(message, meta = {}) {
    super(message);
    this.name = 'RegistryCompilerError';
    this.code = 'lego.contract_violation';
    this.meta = Object.freeze({ ...meta });
  }
}

const fail = (message, meta) => { throw new RegistryCompilerError(message, meta); };
const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const isPositiveInteger = (value) => Number.isInteger(value) && value >= 1;

/** Key-order-independent JSON, so digests are content hashes and not text hashes. */
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

const digestOf = (text) => createHash('sha256').update(text).digest('hex');

/** Recursive freeze: an epoch that can be edited is not an epoch. */
function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value;
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return Object.freeze(value);
}

/** The entries an epoch's content digest is built from: identity + declaration digest. */
function entryDigest(index) {
  return digestOf(stableJson(index.identities.map((identity) => [identity, index.byIdentity[identity].digest])));
}

function epochDigestOf({ epochNumber, origin, source, parentEpochDigest, contentDigest }) {
  return digestOf(stableJson({ epochNumber, origin, source, parentEpochDigest, contentDigest }));
}

/* ------------------------------------------------------------------ *
 * Compile
 * ------------------------------------------------------------------ */

function validateSource(source) {
  if (typeof source !== 'string' || source.trim().length === 0) {
    return { code: 'registry.epoch.source', field: 'source', message: 'an epoch must name the source it was compiled from; an unnamed registry cannot be audited' };
  }
  if (source.length > REGISTRY_EPOCH_SOURCE_MAX_LENGTH) {
    return { code: 'registry.epoch.source', field: 'source', message: `source is ${source.length} characters; the limit is ${REGISTRY_EPOCH_SOURCE_MAX_LENGTH}` };
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(source)) {
    return { code: 'registry.epoch.source', field: 'source', message: 'source contains control characters' };
  }
  return null;
}

function emptyEpochFailure(schemaVersion, errors, reason) {
  return Object.freeze({
    ok: false,
    schemaVersion,
    contract: REGISTRY_COMPILER_CONTRACT,
    epochNumber: null,
    epochDigest: null,
    contentDigest: null,
    count: 0,
    identities: Object.freeze([]),
    byIdentity: null,
    chain: Object.freeze([]),
    errors: Object.freeze(errors),
    reason,
  });
}

/**
 * Compile declarations into an immutable epoch.
 *
 * @param {{ declarations?: unknown[], epochNumber?: number, source?: string, parent?: object }} input
 *   `declarations` is a source list (P6.1 shape), `source` is the caller's
 *   provenance label (e.g. `catalog:n8n-nodes-base@2.9.1`), `parent` is the
 *   frozen epoch this one is compiled onto.
 * @returns {Readonly<object>} a frozen epoch, or a frozen `ok:false` refusal
 *   carrying every error and no epoch at all.
 */
export function compileRegistryEpoch(input = {}) {
  const { declarations, epochNumber = REGISTRY_EPOCH_GENESIS, source, parent = null } = isPlainObject(input) ? input : {};
  const schemaVersion = REGISTRY_COMPILER_SCHEMA_VERSION;

  if (!Array.isArray(declarations)) {
    return emptyEpochFailure(schemaVersion, [{ code: 'registry.epoch.invalid', field: 'declarations', message: 'compileRegistryEpoch expects an array of node declarations' }], 'registry.epoch.invalid');
  }

  const sourceError = validateSource(source);
  if (sourceError) return emptyEpochFailure(schemaVersion, [sourceError], sourceError.code);

  if (!isPositiveInteger(epochNumber)) {
    const error = { code: 'registry.epoch.number', field: 'epochNumber', message: `epochNumber must be an integer >= ${REGISTRY_EPOCH_GENESIS}; got ${JSON.stringify(epochNumber)}` };
    return emptyEpochFailure(schemaVersion, [error], error.code);
  }

  if (parent !== null && parent !== undefined) {
    if (!isFrozenRegistryEpoch(parent)) {
      const error = { code: 'registry.epoch.parent', field: 'parent', message: 'parent must be an epoch produced and frozen by this contract' };
      return emptyEpochFailure(schemaVersion, [error], error.code);
    }
    if (epochNumber <= parent.epochNumber) {
      const error = {
        code: 'registry.epoch.monotonic', field: 'epochNumber',
        message: `epoch ${epochNumber} cannot be compiled onto parent epoch ${parent.epochNumber}; epoch numbers only ever increase (a rollback is a new epoch carrying older content)`,
      };
      return emptyEpochFailure(schemaVersion, [error], error.code);
    }
  }

  // P6.1 decides validity, duplicates and canonical form. The compiler never
  // re-implements those rules — it inherits them, all-or-nothing.
  const index = indexNodeRegistryDeclarations(declarations);
  if (!index.ok) {
    return emptyEpochFailure(schemaVersion, index.errors, index.errors[0]?.code ?? 'registry.epoch.invalid');
  }

  return freezeRegistryEpoch(buildEpoch({
    index, epochNumber, source, origin: 'compile', parent, rollbackTarget: null,
  }));
}

function buildEpoch({ index, epochNumber, source, origin, parent, rollbackTarget }) {
  const contentDigest = entryDigest(index);
  const parentEpochDigest = parent ? parent.epochDigest : null;
  const epochDigest = epochDigestOf({ epochNumber, origin, source, parentEpochDigest, contentDigest });
  const parentChain = parent ? parent.chain : [];
  const entries = Object.fromEntries(
    index.identities.map((identity) => {
      const { declaration, digest } = index.byIdentity[identity];
      return [identity, Object.freeze({ identity, declaration, digest })];
    }),
  );

  return {
    ok: true,
    schemaVersion: REGISTRY_COMPILER_SCHEMA_VERSION,
    contract: REGISTRY_COMPILER_CONTRACT,
    epochNumber,
    origin,
    source,
    parentEpochNumber: parent ? parent.epochNumber : null,
    parentEpochDigest,
    rollbackTarget,
    contentDigest,
    epochDigest,
    count: index.count,
    identities: Object.freeze([...index.identities]),
    byIdentity: Object.freeze(entries),
    indexDigest: index.indexDigest,
    chain: Object.freeze([...parentChain, epochDigest]),
    errors: Object.freeze([]),
    reason: null,
  };
}

/** Freeze an epoch (deep, idempotent). Called by the compiler; exported because P6.4+ load epochs from disk. */
export function freezeRegistryEpoch(epoch) {
  if (!isPlainObject(epoch)) fail('freezeRegistryEpoch expects an epoch object', { got: typeof epoch });
  return deepFreeze(epoch);
}

/** @returns {boolean} whether `value` is a frozen epoch this contract produced. */
export function isFrozenRegistryEpoch(value) {
  return (
    isPlainObject(value) &&
    value.ok === true &&
    value.contract === REGISTRY_COMPILER_CONTRACT &&
    value.schemaVersion === REGISTRY_COMPILER_SCHEMA_VERSION &&
    isPositiveInteger(value.epochNumber) &&
    typeof value.epochDigest === 'string' &&
    isPlainObject(value.byIdentity) &&
    Object.isFrozen(value) &&
    Array.isArray(value.chain) &&
    Object.isFrozen(value.chain)
  );
}

/* ------------------------------------------------------------------ *
 * Lineage
 * ------------------------------------------------------------------ */

/**
 * Compile the next epoch onto `previous`.
 * @returns {Readonly<object>} the new epoch, or a frozen refusal — `previous` is unread, never mutated.
 */
export function nextRegistryEpoch(previous, { declarations, source } = {}) {
  if (!isFrozenRegistryEpoch(previous)) fail('nextRegistryEpoch expects a frozen previous epoch', { got: typeof previous });
  return compileRegistryEpoch({ declarations, source, epochNumber: previous.epochNumber + 1, parent: previous });
}

/** The full digest chain ending at this epoch, oldest first, as a copy. */
export function epochChainOf(epoch) {
  if (!isFrozenRegistryEpoch(epoch)) fail('epochChainOf expects a frozen epoch', { got: typeof epoch });
  return [...epoch.chain];
}

/**
 * Roll an epoch's CONTENT back onto a new, higher-numbered epoch.
 *
 * The counter never rewinds: the result is `current.epochNumber + 1` carrying
 * `target`'s declarations. A downgrade therefore leaves a mark instead of
 * restoring a number — the audit trail survives the rollback.
 *
 * @param {object} current the epoch being superseded
 * @param {object} target  an ancestor epoch in `current.chain`
 */
export function rollbackRegistryEpoch(current, target) {
  if (!isFrozenRegistryEpoch(current)) fail('rollbackRegistryEpoch expects a frozen current epoch', { got: typeof current });
  if (!isFrozenRegistryEpoch(target)) fail('rollbackRegistryEpoch expects a frozen target epoch', { got: typeof target });

  if (target.epochDigest === current.epochDigest) {
    const error = { code: 'registry.epoch.unknown_target', field: 'target', message: 'target is the current epoch; there is nothing to roll back' };
    return emptyEpochFailure(REGISTRY_COMPILER_SCHEMA_VERSION, [error], error.code);
  }
  if (!current.chain.includes(target.epochDigest)) {
    const error = {
      code: 'registry.epoch.unknown_target', field: 'target',
      message: `target epoch ${target.epochNumber} (${target.epochDigest.slice(0, 12)}…) is not in the chain of epoch ${current.epochNumber}; only an ancestor can be rolled back to`,
    };
    return emptyEpochFailure(REGISTRY_COMPILER_SCHEMA_VERSION, [error], error.code);
  }

  const identities = [...target.identities].sort();
  const declarations = identities.map((identity) => target.byIdentity[identity].declaration);

  // Re-validated rather than assumed: a target epoch that no longer validates is
  // corrupt, and re-installing corrupt content is exactly what fail-closed
  // means to prevent. Its content digest must also still be what it claims.
  const index = indexNodeRegistryDeclarations(declarations);
  if (!index.ok || entryDigest(index) !== target.contentDigest) {
    fail('rollback target failed re-validation; the epoch is corrupt and will not be re-installed', {
      code: 'registry.epoch.digest', target: target.epochNumber, errors: index.errors,
    });
  }

  return freezeRegistryEpoch(buildEpoch({
    index,
    epochNumber: current.epochNumber + 1,
    source: `rollback:${target.source}`,
    origin: 'rollback',
    parent: current,
    rollbackTarget: Object.freeze({ epochNumber: target.epochNumber, epochDigest: target.epochDigest, source: target.source }),
  }));
}

/* ------------------------------------------------------------------ *
 * Publication
 * ------------------------------------------------------------------ */

/**
 * Move the published pointer from `current` to `next`.
 *
 * Atomic by construction: `next` is already frozen, the pointers are checked
 * BEFORE anything is returned, and `current` is never touched — so a failed
 * publication leaves exactly the state it found, and a successful one leaves the
 * previous epoch fully usable for in-flight work.
 *
 * @returns {{ ok: true, published: object, previous: object, changed: object }}
 */
export function publishRegistryEpoch(current, next) {
  if (!isFrozenRegistryEpoch(current)) fail('publishRegistryEpoch expects a frozen current epoch', { got: typeof current });
  if (!isFrozenRegistryEpoch(next)) fail('publishRegistryEpoch expects a frozen next epoch', { got: typeof next });

  if (next.epochNumber <= current.epochNumber) {
    fail(`refusing to publish epoch ${next.epochNumber} over epoch ${current.epochNumber}: epoch numbers only ever increase`, {
      code: 'registry.epoch.monotonic', currentEpoch: current.epochNumber, nextEpoch: next.epochNumber,
    });
  }
  if (next.parentEpochDigest !== current.epochDigest) {
    fail(
      `refusing to publish epoch ${next.epochNumber}: it was compiled onto ${next.parentEpochDigest ?? 'nothing'}, not onto the current epoch ${current.epochNumber} (${current.epochDigest.slice(0, 12)}…)`,
      { code: 'registry.epoch.parent', expectedParent: current.epochDigest, gotParent: next.parentEpochDigest },
    );
  }

  return Object.freeze({
    ok: true,
    published: next,
    previous: epochManifest(current),
    changed: diffRegistryEpochs(current, next),
  });
}

/* ------------------------------------------------------------------ *
 * Reads
 * ------------------------------------------------------------------ */

/** Serializable projection of an epoch — Maps and frozen graphs do not travel well. */
export function epochManifest(epoch) {
  if (!isFrozenRegistryEpoch(epoch)) fail('epochManifest expects a frozen epoch', { got: typeof epoch });
  const digests = Object.fromEntries(epoch.identities.map((identity) => [identity, epoch.byIdentity[identity].digest]));
  return deepFreeze({
    schemaVersion: epoch.schemaVersion,
    contract: epoch.contract,
    epochNumber: epoch.epochNumber,
    origin: epoch.origin,
    source: epoch.source,
    parentEpochNumber: epoch.parentEpochNumber,
    parentEpochDigest: epoch.parentEpochDigest,
    rollbackTarget: epoch.rollbackTarget,
    contentDigest: epoch.contentDigest,
    epochDigest: epoch.epochDigest,
    count: epoch.count,
    identities: [...epoch.identities],
    digests,
    chain: [...epoch.chain],
  });
}

/**
 * Recompile `declarations` and compare the result with a manifest (or epoch).
 * This is the integrity half of determinism: any content that no longer matches
 * the published digest is refused rather than served.
 */
export function verifyRegistryEpoch(manifest, declarations) {
  if (!isPlainObject(manifest) || typeof manifest.epochDigest !== 'string') {
    return { ok: false, reason: 'registry.epoch.invalid', expected: null, actual: null, errors: [{ code: 'registry.epoch.invalid', field: 'manifest', message: 'verifyRegistryEpoch expects an epoch or a manifest with an epochDigest' }] };
  }
  const recompiled = compileRegistryEpoch({
    declarations,
    epochNumber: manifest.epochNumber,
    source: manifest.source,
    parent: null,
  });
  if (!recompiled.ok) return { ok: false, reason: recompiled.reason, expected: manifest.epochDigest, actual: null, errors: recompiled.errors };

  // Content is what has to match. An epoch's own digest also folds in its
  // lineage (number, origin, parent), so a recompile of the same content under a
  // different lineage is a different epoch — verified content-wise, reported as
  // such, and never mistaken for a tamper.
  const expected = manifest.contentDigest ?? manifest.epochDigest;
  if (recompiled.contentDigest !== expected) {
    return {
      ok: false,
      reason: 'registry.epoch.digest',
      expected,
      actual: recompiled.contentDigest,
      errors: [{ code: 'registry.epoch.digest', field: 'declarations', message: `content digest ${recompiled.contentDigest.slice(0, 12)}… does not match the published ${String(manifest.contentDigest ?? manifest.epochDigest).slice(0, 12)}…` }],
    };
  }
  return { ok: true, reason: null, expected, actual: recompiled.contentDigest, errors: [] };
}

/** Deterministic, sorted content diff between two epochs. */
export function diffRegistryEpochs(previous, next) {
  if (!isFrozenRegistryEpoch(previous) || !isFrozenRegistryEpoch(next)) {
    fail('diffRegistryEpochs expects two frozen epochs', { got: [typeof previous, typeof next] });
  }
  const added = [];
  const removed = [];
  const changed = [];
  let unchanged = 0;
  for (const identity of next.identities) {
    if (!Object.hasOwn(previous.byIdentity, identity)) added.push(identity);
    else if (previous.byIdentity[identity].digest === next.byIdentity[identity].digest) unchanged += 1;
    else changed.push(identity);
  }
  for (const identity of previous.identities) if (!Object.hasOwn(next.byIdentity, identity)) removed.push(identity);
  return Object.freeze({
    added: Object.freeze(added.sort()),
    removed: Object.freeze(removed.sort()),
    changed: Object.freeze(changed.sort()),
    unchanged,
    fromEpoch: previous.epochNumber,
    toEpoch: next.epochNumber,
  });
}

/** Operations summary: what an operator or a UI needs to answer "which registry is live?". */
export function describeRegistryEpoch(epoch) {
  if (!isFrozenRegistryEpoch(epoch)) fail('describeRegistryEpoch expects a frozen epoch', { got: typeof epoch });
  return deepFreeze({
    contract: epoch.contract,
    schemaVersion: epoch.schemaVersion,
    epochNumber: epoch.epochNumber,
    origin: epoch.origin,
    source: epoch.source,
    count: epoch.count,
    epochDigest: epoch.epochDigest,
    contentDigest: epoch.contentDigest,
    parentEpochNumber: epoch.parentEpochNumber,
    parentEpochDigest: epoch.parentEpochDigest,
    rollbackTarget: epoch.rollbackTarget,
    chainLength: epoch.chain.length,
    frozen: true,
    identities: [...epoch.identities],
  });
}

/** Human-readable identity for an epoch: `epoch 3 (compile, catalog:n8n-nodes-base@2.9.1) 483 nodes`. */
export function formatRegistryEpoch(epoch) {
  if (!isFrozenRegistryEpoch(epoch)) fail('formatRegistryEpoch expects a frozen epoch', { got: typeof epoch });
  return `epoch ${epoch.epochNumber} (${epoch.origin}, ${epoch.source}) ${epoch.count} node${epoch.count === 1 ? '' : 's'} ${epoch.epochDigest.slice(0, 12)}`;
}

/** The identity of a declaration as the registry keys it — P6.1's rule, quoted. */
export function epochIdentityOf(declaration) {
  return nodeIdentity(declaration);
}

/** Canonical form of one entry inside an epoch, for consumers that only hold a digest. */
export function epochEntryOf(epoch, identity) {
  if (!isFrozenRegistryEpoch(epoch)) fail('epochEntryOf expects a frozen epoch', { got: typeof epoch });
  if (!Object.hasOwn(epoch.byIdentity, identity)) return null;
  const { declaration, digest } = epoch.byIdentity[identity];
  return deepFreeze({ identity, digest, declaration, canonical: canonicalNodeRegistryDeclaration(declaration) });
}

/** Which schema version the registry compiler expects from its inputs. */
export const REGISTRY_COMPILER_INPUT_SCHEMA_VERSION = NODE_REGISTRY_SCHEMA_VERSION;
