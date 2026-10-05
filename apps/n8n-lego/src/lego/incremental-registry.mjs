/**
 * Incremental registry compilation + the discovery/runtime split — P6.13.
 *
 * PUBLIC CONTRACT (`registry.incremental@0.1.0`, domain `node-registry`).
 *
 * `registry.compiler@0.1.0` (P6.2) compiles an epoch from a full declaration set.
 * That is the correct thing for a genesis epoch and the wrong thing for the tenth
 * one: a registry that recompiles the whole catalogue to add one node pays for the
 * catalogue every time, and a registry that "only patches what changed" without
 * proof turns a cache into a hypothesis.
 *
 * This contract is a NEW contract rather than a minor bump to the compiler,
 * deliberately: the compiler's job is "given declarations, produce the canonical
 * epoch", and that job did not change. What is added here is a different job —
 * given a previous epoch and a CHANGE SET, produce the next epoch while proving it
 * is the same epoch a full compile would have produced.
 *
 * THE EQUIVALENCE IS THE CONTRACT. Every incremental epoch carries a reuse ledger
 * (which identities were reused untouched, which were recompiled, which were
 * removed) AND can be checked against a full recompile:
 *
 *     verifyIncremental(state, declarations).equivalent === true
 *
 * An optimisation that cannot be verified is a guess with better latency.
 *
 * THE DISCOVERY/RUNTIME SPLIT. One epoch, two views, because they are asked
 * different questions by different callers:
 *
 *   DISCOVERY  what an editor, a catalogue page or a search needs: identity, type,
 *              typeVersion, display name, group, description, capability names.
 *              Never the implementation digest and never the resource profile.
 *   RUNTIME    what execution needs: identity, content digest, runtime locality,
 *              resource profile, capability names. Never the display metadata.
 *
 * The two views carry their OWN digests, so a worker can hold the runtime view of
 * an epoch and a UI can hold the discovery view of the same epoch without either
 * shipping the other's bytes — and without either being able to claim it holds
 * the epoch. A view is a projection, never the epoch: the tests assert both
 * directions (runtime facts absent from discovery, and vice versa).
 *
 * WHAT THIS IS NOT (P6.13 scope walls, enforced by tests):
 *   - it does not change P6.2's rules: validity, duplicates, canonical form and
 *     epoch numbering are the compiler's, quoted here;
 *   - it does not publish, roll back or freeze an epoch (P6.2 owns publish and
 *     rollback; this only produces the next content);
 *   - it does not resolve workflows (P6.5), does not load implementations (P6.7),
 *     does not admit (P6.11) and does not converge workers (P6.14);
 *   - no filesystem, no network, no clock, no randomness, no mutation: an
 *     incremental state is data, and "what changed" is a value.
 *
 * Authority: producing an epoch is not publishing one. This contract says what the
 * next epoch's CONTENT is and what it cost; the decision to serve it belongs to
 * the compiler's publish path and, above that, to a human.
 */
import { createHash } from 'node:crypto';

import {
  REGISTRY_COMPILER_CONTRACT,
  REGISTRY_COMPILER_CONTRACT_VERSION,
  compileRegistryEpoch,
  isFrozenRegistryEpoch,
} from './registry-compiler.mjs';

export const INCREMENTAL_REGISTRY_CONTRACT = 'registry.incremental@0.1.0';
export const INCREMENTAL_REGISTRY_CONTRACT_VERSION = '0.1.0';
export const INCREMENTAL_REGISTRY_SCHEMA_VERSION = 1;

export const INCREMENTAL_REGISTRY_OPERATIONS = Object.freeze(['plan', 'apply', 'verify', 'project', 'describe']);
export const INCREMENTAL_REGISTRY_PERMISSIONS = Object.freeze(['node:read']);

/** What happened to one identity between two epochs. */
export const CHANGE_KINDS = Object.freeze(['added', 'recompiled', 'reused', 'removed']);

/** Which side of the split a caller is asking about. */
export const REGISTRY_VIEWS = Object.freeze(['discovery', 'runtime']);

/** Fields the discovery view is allowed to carry, and only these. */
export const DISCOVERY_FIELDS = Object.freeze(['identity', 'type', 'typeVersion', 'displayName', 'group', 'description', 'capabilities', 'trustClass']);

/** Fields the runtime view is allowed to carry, and only these. */
export const RUNTIME_FIELDS = Object.freeze(['identity', 'digest', 'runtimeLocality', 'capabilities', 'resourceProfile']);

export const INCREMENTAL_REGISTRY_REASONS = Object.freeze([
  'registry.incremental.input',
  'registry.incremental.epoch',
  'registry.incremental.parent',
  'registry.incremental.number',
  'registry.incremental.unchanged',
  'registry.incremental.equivalence',
  'registry.incremental.view',
]);

export const INCREMENTAL_REGISTRY_RULES = Object.freeze({
  equivalence: 'an incremental epoch must be the same epoch a full compile would have produced: an optimisation that cannot be verified is a guess with better latency',
  reuse: 'a reused identity keeps the digest it had, byte for byte; "we recompiled it and it matched" is not reuse, it is luck with a nicer story',
  removals: 'a removal is data about this epoch, not a tombstone: retiring a NAME is P6.10\'s permanent decision, and a compiler that could not remove anything could not fix a mistake',
  split: 'the discovery view never carries an implementation digest and the runtime view never carries display metadata: an editor does not need the bytes and a worker does not need the prose',
  views: 'a view is a projection, never the epoch: its digest identifies the projection, so nobody can present half an epoch as the whole one',
  authority: 'producing an epoch is not publishing one: this contract says what the next epoch\'s content is and what it cost',
});

/* ------------------------------------------------------------------ *
 * Errors
 * ------------------------------------------------------------------ */

/** Raised for API misuse. Refusals are returned as data. */
export class IncrementalRegistryError extends Error {
  constructor(message, meta = {}) {
    super(message);
    this.name = 'IncrementalRegistryError';
    this.code = 'lego.contract_violation';
    this.meta = Object.freeze({ ...meta });
  }
}

const fail = (message, meta) => { throw new IncrementalRegistryError(message, meta); };
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
 * State
 * ------------------------------------------------------------------ */

const requireEpoch = (epoch, fn) => {
  if (!isFrozenRegistryEpoch(epoch)) fail(`${fn} expects an epoch compiled by registry.compiler`, { code: 'registry.incremental.epoch', field: 'epoch' });
  return epoch;
};

const declarationsOf = (epoch) => {
  const declarations = new Map();
  for (const identity of epoch.identities) {
    const entry = epoch.byIdentity[identity];
    if (!entry || !isPlainObject(entry.declaration)) {
      fail(`epoch ${epoch.epochNumber} does not expose the declaration of '${identity}': an incremental compiler needs the declarations it is reusing`, { code: 'registry.incremental.epoch', field: 'epoch' });
    }
    declarations.set(identity, entry.declaration);
  }
  return declarations;
};

/**
 * Adopt a compiled epoch as the starting point for incremental work: its
 * declarations, their digests, and the epoch number the next one must exceed.
 */
export function createIncrementalState(epoch) {
  requireEpoch(epoch, 'createIncrementalState');
  const declarations = declarationsOf(epoch);
  const digests = {};
  for (const identity of epoch.identities) digests[identity] = epoch.byIdentity[identity].digest;
  return deepFreeze({
    ok: true,
    schemaVersion: INCREMENTAL_REGISTRY_SCHEMA_VERSION,
    contract: INCREMENTAL_REGISTRY_CONTRACT,
    epochNumber: epoch.epochNumber,
    epochDigest: epoch.epochDigest,
    source: epoch.source,
    declarations: Object.freeze(Object.fromEntries(declarations)),
    digests: Object.freeze(digests),
    changes: Object.freeze([]),
  });
}

/** @returns {boolean} whether `value` is an incremental state this contract produced. */
export function isIncrementalState(value) {
  return (
    isPlainObject(value) &&
    value.ok === true &&
    value.contract === INCREMENTAL_REGISTRY_CONTRACT &&
    value.schemaVersion === INCREMENTAL_REGISTRY_SCHEMA_VERSION &&
    isPlainObject(value.declarations) &&
    Object.isFrozen(value)
  );
}

const requireState = (state, fn) => {
  if (!isIncrementalState(state)) fail(`${fn} expects a state from createIncrementalState`, { got: typeof state });
};

/* ------------------------------------------------------------------ *
 * Planning: what changed, as a value
 * ------------------------------------------------------------------ */

const identityOf = (declaration) => {
  if (!isPlainObject(declaration) || !isNonEmptyString(declaration.type) || declaration.typeVersion === undefined) {
    fail('a declaration needs a type and a typeVersion: the identity is the key an incremental compile reuses', { code: 'registry.incremental.input', field: 'declaration' });
  }
  return `${declaration.type}@${Number(declaration.typeVersion)}`;
};

/**
 * Compare a desired declaration set with the state: what to add, what to drop and
 * what is untouched. This is the value a caller reviews before anything is built.
 */
export function planRegistryChanges(state, declarations) {
  requireState(state, 'planRegistryChanges');
  if (!Array.isArray(declarations)) {
    fail('planRegistryChanges expects an array of declarations', { code: 'registry.incremental.input', field: 'declarations' });
  }
  const desired = new Map();
  for (const declaration of declarations) {
    const identity = identityOf(declaration);
    if (desired.has(identity)) {
      return deepFreeze({
        ok: false,
        reason: 'registry.incremental.input',
        added: Object.freeze([]), removed: Object.freeze([]), reused: Object.freeze([]), changed: Object.freeze([]),
        message: `two declarations share the identity '${identity}': the compiler refuses duplicates, and a plan must not hide one`,
      });
    }
    desired.set(identity, declaration);
  }
  const current = Object.keys(state.declarations);
  const added = [];
  const reused = [];
  const changed = [];
  for (const [identity, declaration] of desired) {
    if (!(identity in state.declarations)) added.push(identity);
    else if (stableJson(declaration) === stableJson(state.declarations[identity])) reused.push(identity);
    else changed.push(identity);
  }
  const removed = current.filter((identity) => !desired.has(identity));
  return deepFreeze({
    ok: true,
    reason: null,
    added: Object.freeze(added.sort()),
    changed: Object.freeze(changed.sort()),
    reused: Object.freeze(reused.sort()),
    removed: Object.freeze(removed.sort()),
    desiredCount: desired.size,
    unchanged: added.length === 0 && changed.length === 0 && removed.length === 0,
    message: null,
  });
}

/* ------------------------------------------------------------------ *
 * Applying: the next epoch, with a reuse ledger
 * ------------------------------------------------------------------ */

/**
 * Produce the next epoch from a change set.
 *
 * @param {object} state an incremental state
 * @param {{ declarations: object[], epochNumber: number, source: string }} input
 *   `declarations` is the DESIRED full set; the plan is derived, so a caller
 *   cannot hand in a change set that disagrees with the content it produces.
 */
export function applyRegistryChanges(state, { declarations, epochNumber, source } = {}) {
  requireState(state, 'applyRegistryChanges');
  if (!Number.isInteger(epochNumber) || epochNumber <= state.epochNumber) {
    fail(`epochNumber must be an integer greater than ${state.epochNumber}: epoch numbers only ever increase`, { code: 'registry.incremental.number', field: 'epochNumber' });
  }
  if (!isNonEmptyString(source)) {
    fail('an incremental compile must name its source: an epoch whose origin cannot be cited cannot be reviewed', { code: 'registry.incremental.input', field: 'source' });
  }
  const plan = planRegistryChanges(state, declarations);
  if (!plan.ok) {
    // The plan refusal is wrapped rather than forwarded: a caller of `apply` must
    // be able to read the same shape from every refusal, or every call site grows
    // a special case.
    return deepFreeze({ ok: false, reason: plan.reason, epoch: null, plan, message: plan.message });
  }
  if (plan.unchanged) {
    return deepFreeze({
      ok: false,
      reason: 'registry.incremental.unchanged',
      epoch: null,
      plan,
      message: 'nothing changed: compiling an epoch that would be identical to its parent is how a registry fills with noise, and epoch numbers are the only thing that must increase, not epochs',
    });
  }

  const compiled = compileRegistryEpoch({ declarations, epochNumber, source });
  if (!compiled.ok || compiled.errors?.length > 0) {
    return deepFreeze({
      ok: false,
      reason: compiled.reason ?? 'registry.incremental.input',
      epoch: null,
      plan,
      message: `the compiler refused the desired declaration set: ${(compiled.errors ?? []).map((error) => error.message).join('; ') || compiled.reason}`,
      errors: Object.freeze([...(compiled.errors ?? [])]),
    });
  }

  // The reuse ledger: for every identity that came through untouched, the digest
  // must be the SAME digest it had. This is asserted, not assumed — a compiler
  // that silently recompiled everything would produce the same epoch and a lying
  // ledger.
  const changes = [
    ...plan.added.map((identity) => ({ identity, kind: 'added', previousDigest: null, digest: compiled.byIdentity[identity].digest, reusedDigest: false })),
    ...plan.changed.map((identity) => ({ identity, kind: 'recompiled', previousDigest: state.digests[identity], digest: compiled.byIdentity[identity].digest, reusedDigest: false })),
    ...plan.reused.map((identity) => ({
      identity, kind: 'reused', previousDigest: state.digests[identity], digest: compiled.byIdentity[identity].digest,
      reusedDigest: state.digests[identity] === compiled.byIdentity[identity].digest,
    })),
    ...plan.removed.map((identity) => ({ identity, kind: 'removed', previousDigest: state.digests[identity], digest: null, reusedDigest: false })),
  ].sort((left, right) => (left.identity < right.identity ? -1 : left.identity > right.identity ? 1 : 0));

  const divergent = changes.filter((change) => change.kind === 'reused' && change.reusedDigest === false);
  const nextState = deepFreeze({
    ok: true,
    schemaVersion: INCREMENTAL_REGISTRY_SCHEMA_VERSION,
    contract: INCREMENTAL_REGISTRY_CONTRACT,
    epochNumber: compiled.epochNumber,
    epochDigest: compiled.epochDigest,
    source: compiled.source,
    declarations: Object.freeze(Object.fromEntries(compiled.identities.map((identity) => [identity, compiled.byIdentity[identity].declaration]))),
    digests: Object.freeze(Object.fromEntries(compiled.identities.map((identity) => [identity, compiled.byIdentity[identity].digest]))),
    changes: Object.freeze(changes.map((change) => Object.freeze(change))),
  });
  return deepFreeze({
    ok: true,
    reason: null,
    epoch: compiled,
    plan,
    state: nextState,
    ledger: deepFreeze({
      added: plan.added.length,
      recompiled: plan.changed.length,
      reused: plan.reused.length,
      removed: plan.removed.length,
      reusedDigestStable: divergent.length === 0,
      divergent: Object.freeze(divergent.map((change) => change.identity)),
      changes: nextState.changes,
    }),
    message: null,
  });
}

/** Which identities came through untouched, and did they keep their digest? */
export function reuseReport(state) {
  requireState(state, 'reuseReport');
  const byKind = {};
  for (const change of state.changes) byKind[change.kind] = (byKind[change.kind] ?? 0) + 1;
  const divergent = state.changes.filter((change) => change.kind === 'reused' && change.reusedDigest === false);
  const touched = state.changes.filter((change) => change.kind !== 'reused').length;
  return deepFreeze({
    epochNumber: state.epochNumber,
    epochDigest: state.epochDigest,
    byKind: Object.freeze(byKind),
    reusedIdentities: Object.freeze(state.changes.filter((change) => change.kind === 'reused').map((change) => change.identity)),
    touched, total: state.changes.length,
    reuseRatio: state.changes.length === 0 ? null : Number((byKind.reused ?? 0) / state.changes.length),
    reusedDigestStable: divergent.length === 0,
  });
}

/**
 * The proof: rebuild the same declaration set from scratch and compare. `true`
 * here is what lets an operator trust the cheaper path.
 */
export function verifyIncremental(state, declarations, { epochNumber, source } = {}) {
  requireState(state, 'verifyIncremental');
  if (!Array.isArray(declarations)) fail('verifyIncremental expects the desired declaration set', { code: 'registry.incremental.input', field: 'declarations' });
  const full = compileRegistryEpoch({ declarations, epochNumber, source });
  if (!full.ok) {
    return deepFreeze({
      ok: false, reason: 'registry.incremental.equivalence', equivalent: false,
      expected: null, actual: state.epochDigest,
      message: `the full compile refused this declaration set: ${(full.errors ?? []).map((error) => error.message).join('; ')}`,
    });
  }
  if (full.epochNumber !== state.epochNumber) {
    return deepFreeze({
      ok: false, reason: 'registry.incremental.number', equivalent: false,
      expected: full.epochDigest, actual: state.epochDigest,
      message: `the state is epoch ${state.epochNumber} and the full compile produced epoch ${full.epochNumber}: compare the same epoch or neither`,
    });
  }
  const equivalent = full.epochDigest === state.epochDigest;
  return deepFreeze({
    ok: equivalent,
    reason: equivalent ? null : 'registry.incremental.equivalence',
    equivalent,
    expected: full.epochDigest,
    actual: state.epochDigest,
    message: equivalent
      ? null
      : 'the incremental epoch differs from a full compile of the same declarations: the cheaper path is not a path, and it is not used',
  });
}

/* ------------------------------------------------------------------ *
 * The discovery/runtime split
 * ------------------------------------------------------------------ */

const viewFields = (view) => (view === 'discovery' ? DISCOVERY_FIELDS : RUNTIME_FIELDS);

/**
 * Project an epoch for one consumer. A view carries its own digest and never the
 * other side's facts: the tests assert both directions.
 */
export function projectEpochView(epoch, view) {
  requireEpoch(epoch, 'projectEpochView');
  if (!REGISTRY_VIEWS.includes(view)) {
    fail(`unknown view ${JSON.stringify(view)} — the views are ${REGISTRY_VIEWS.join(', ')}`, { code: 'registry.incremental.view', field: 'view' });
  }
  const entries = epoch.identities.map((identity) => {
    const entry = epoch.byIdentity[identity];
    const declaration = entry.declaration;
    if (view === 'discovery') {
      return Object.freeze({
        identity,
        type: declaration.type,
        typeVersion: declaration.typeVersion,
        displayName: declaration.discovery?.displayName ?? null,
        group: declaration.discovery?.group ?? null,
        description: declaration.discovery?.description ?? null,
        capabilities: Object.freeze([...(declaration.capabilities ?? [])]),
        trustClass: declaration.trustClass ?? null,
      });
    }
    return Object.freeze({
      identity,
      digest: entry.digest,
      runtimeLocality: declaration.runtimeLocality,
      capabilities: Object.freeze([...(declaration.capabilities ?? [])]),
      resourceProfile: declaration.resourceProfile ?? null,
    });
  });
  entries.sort((left, right) => (left.identity < right.identity ? -1 : left.identity > right.identity ? 1 : 0));
  return deepFreeze({
    ok: true,
    schemaVersion: INCREMENTAL_REGISTRY_SCHEMA_VERSION,
    contract: INCREMENTAL_REGISTRY_CONTRACT,
    view,
    fields: viewFields(view),
    epochNumber: epoch.epochNumber,
    epochDigest: epoch.epochDigest,
    count: entries.length,
    entries: Object.freeze(entries),
    viewDigest: digestOf(stableJson({ view, epochDigest: epoch.epochDigest, entries })),
  });
}

/** @returns {boolean} whether `value` is a view this contract produced. */
export function isEpochView(value) {
  return (
    isPlainObject(value) &&
    value.ok === true &&
    value.contract === INCREMENTAL_REGISTRY_CONTRACT &&
    REGISTRY_VIEWS.includes(value.view) &&
    Array.isArray(value.entries) &&
    typeof value.viewDigest === 'string' &&
    Object.isFrozen(value)
  );
}

/** Rebuild a view and compare: two runs of the same projection agree, or they do not. */
export function verifyEpochView(view, epoch) {
  if (!isEpochView(view)) fail('verifyEpochView expects a view from projectEpochView', { code: 'registry.incremental.view' });
  requireEpoch(epoch, 'verifyEpochView');
  const rebuilt = projectEpochView(epoch, view.view);
  if (rebuilt.viewDigest !== view.viewDigest) {
    return deepFreeze({
      ok: false, reason: 'registry.incremental.view', expected: view.viewDigest, actual: rebuilt.viewDigest,
      message: `the '${view.view}' view does not match this epoch: a view that cannot be rebuilt is not a projection of anything`,
    });
  }
  if (view.epochDigest !== epoch.epochDigest) {
    return deepFreeze({
      ok: false, reason: 'registry.incremental.view', expected: epoch.epochDigest, actual: view.epochDigest,
      message: `the view claims epoch ${view.epochDigest} and was checked against ${epoch.epochDigest}`,
    });
  }
  return deepFreeze({ ok: true, reason: null, expected: view.viewDigest, actual: rebuilt.viewDigest, message: null });
}

/* ------------------------------------------------------------------ *
 * Reads
 * ------------------------------------------------------------------ */

/** What the state is, what it cost, and which epoch it can be checked against. */
export function describeIncremental(state) {
  requireState(state, 'describeIncremental');
  const reuse = reuseReport(state);
  return deepFreeze({
    contract: state.contract,
    schemaVersion: state.schemaVersion,
    epochNumber: state.epochNumber,
    epochDigest: state.epochDigest,
    source: state.source,
    nodeCount: Object.keys(state.declarations).length,
    byKind: reuse.byKind,
    reuseRatio: reuse.reuseRatio,
    reusedDigestStable: reuse.reusedDigestStable,
    changes: state.changes,
  });
}

/** A sentence an operator can check: what changed, and what it cost. */
export function explainIncremental(result) {
  if (isIncrementalState(result)) {
    const described = describeIncremental(result);
    return `epoch ${described.epochNumber}: ${described.nodeCount} node(s); ${described.byKind.added ?? 0} added, ${described.byKind.recompiled ?? 0} recompiled, ${described.byKind.reused ?? 0} reused, ${described.byKind.removed ?? 0} removed`;
  }
  if (!isPlainObject(result) || typeof result.ok !== 'boolean') {
    fail('explainIncremental expects an incremental state or an apply result', { got: typeof result });
  }
  if (result.ok && result.ledger) {
    return `incremental compile accepted: ${result.ledger.added} added, ${result.ledger.recompiled} recompiled, ${result.ledger.reused} reused (digests stable: ${result.ledger.reusedDigestStable}), ${result.ledger.removed} removed`;
  }
  if (result.reason === 'registry.incremental.unchanged') {
    return 'incremental compile refused: nothing changed, and an epoch identical to its parent is noise';
  }
  return `incremental compile refused: ${result.message}`;
}

/** The compiler this contract builds on, quoted so a reader knows what is reused. */
export function registryCompilerIdentity() {
  return deepFreeze({ contract: REGISTRY_COMPILER_CONTRACT, version: REGISTRY_COMPILER_CONTRACT_VERSION });
}

export const INCREMENTAL_REGISTRY_INPUT_SCHEMA_VERSION = INCREMENTAL_REGISTRY_SCHEMA_VERSION;
