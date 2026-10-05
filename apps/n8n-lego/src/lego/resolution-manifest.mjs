/**
 * Workflow node resolution manifest — P6.5.
 *
 * PUBLIC CONTRACT (`node.resolution@0.1.0`, domain `node-registry`).
 *
 * An epoch (P6.2) answers "what does the registry contain right now". It does
 * not answer the question a running system actually asks: "what does THIS
 * workflow run against, and did that change since I last looked?". Between those
 * two questions sits the classic outage: the registry is upgraded, half the
 * workflows silently start executing a version nobody tested, and the only
 * evidence is a support ticket.
 *
 * A resolution manifest is the answer. It pins, per workflow, the exact node
 * identity (`type@typeVersion`), the declaration digest and the epoch digest the
 * workflow resolved against — so "which implementation did this run use" is a
 * fact stored next to the workflow instead of a guess reconstructed afterwards.
 *
 * Three rules make it worth having:
 *
 *   1. A PIN IS EXACT. There is no "latest", no floating tag and no silent
 *      adoption of a newer version: a manifest names identities, and identities
 *      are what P6.1 defined them to be.
 *
 *   2. UPGRADE IS EXPLICIT AND TWO-PHASE. `planNodeUpgrade` produces a proposal
 *      and changes NOTHING; `applyNodeUpgrade` requires an authorization flag, a
 *      revision that still matches, and a plan that still equals the plan the
 *      current epoch would produce. A stale plan is refused rather than merged,
 *      which is how an upgrade approved yesterday against a different registry
 *      stops being applied today.
 *
 *   3. NOTHING IS SILENTLY DROPPED. If a node a workflow pins has disappeared
 *      from the epoch, resolution reports it as missing and refuses; if it is
 *      present under the same identity with a DIFFERENT digest, that is not an
 *      upgrade, it is a registry integrity violation — a node's identity never
 *      changes because its implementation changed — and it is refused as such.
 *
 * WHAT THIS IS NOT (P6.5 scope walls, enforced by tests):
 *   - no workflow graph, no execution, no frontier: this reads a list of node
 *     identities handed in (P3 owns the graph and P3's internals are untouched);
 *   - no runtime lease or drain (P6.6): a manifest says what SHOULD run, not what
 *     is currently executing;
 *   - no residency tier (P6.7), no capability compilation (P6.8), no fingerprint
 *     or replay (P6.9), no health (P6.11);
 *   - no compilation of its own: epochs come from P6.2, declarations from P6.1;
 *   - no clock, no filesystem, no network, no randomness, and no mutation:
 *     every operation returns a new frozen value, and the manifest in front of an
 *     operator cannot change under them.
 *
 * Authority: pinning grants nothing. A manifest records what a workflow resolved
 * against; trust, capability and permission are decided elsewhere and are never
 * inferred from a pin.
 */
import { createHash } from 'node:crypto';

import { NODE_REGISTRY_SCHEMA_VERSION, nodeIdentity, parseNodeIdentity } from './node-registry.mjs';
import { isFrozenRegistryEpoch } from './registry-compiler.mjs';

export const RESOLUTION_MANIFEST_CONTRACT = 'node.resolution@0.1.0';
export const RESOLUTION_MANIFEST_CONTRACT_VERSION = '0.1.0';
export const RESOLUTION_MANIFEST_SCHEMA_VERSION = 1;

export const RESOLUTION_MANIFEST_OPERATIONS = Object.freeze(['pin', 'resolve', 'upgrade', 'describe']);
export const RESOLUTION_MANIFEST_PERMISSIONS = Object.freeze(['node:read']);

/**
 * How far an EXPLICIT upgrade may move a pin — never implicit, never unbounded.
 * The n8n typeVersion model is `major.minor` (`4.4`), so the meaningful choices
 * are "stay" (`exact`), "move within the same major line" (`minor`) and "cross a
 * version line" (`major`).
 */
export const UPGRADE_POLICIES = Object.freeze(['exact', 'minor', 'major']);

/** What a resolution says about one pinned node. */
export const RESOLUTION_STATES = Object.freeze(['match', 'missing', 'changed']);

export const RESOLUTION_MANIFEST_REASONS = Object.freeze([
  'resolution.workflow',
  'resolution.node',
  'resolution.epoch',
  'resolution.unresolved',
  'resolution.missing',
  'resolution.changed',
  'resolution.policy',
  'resolution.plan',
  'resolution.stale',
  'resolution.authorization',
  'resolution.revision',
  'resolution.history',
]);

export const RESOLUTION_MANIFEST_RULES = Object.freeze({
  exact: 'a pin is an exact identity; there is no latest, no floating tag and no silent adoption of a newer version',
  explicit: 'upgrade is two-phase: planning changes nothing, and applying needs authorization, a current revision and a plan that still matches the epoch',
  integrity: 'the same identity with a different digest is a registry integrity violation, not an upgrade, and is refused as such',
  completeness: 'a node that disappeared from the epoch is reported missing; nothing is ever silently dropped from a workflow',
  epoch: 'a manifest records the epoch digest it resolved against, so which implementation a workflow ran is a stored fact, not a reconstruction',
  append: 'upgrade history is append-only and revisions only increase; a manifest cannot be edited back into an earlier state',
  authority: 'pinning grants nothing: trust, capability and permission are decided elsewhere and are never inferred from a pin',
});

/* ------------------------------------------------------------------ *\n * Errors\n * ------------------------------------------------------------------ */

export class ResolutionManifestError extends Error {
  constructor(message, meta = {}) {
    super(message);
    this.name = 'ResolutionManifestError';
    this.code = 'lego.contract_violation';
    this.meta = Object.freeze({ ...meta });
  }
}

const fail = (message, meta) => { throw new ResolutionManifestError(message, meta); };
const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const isNonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0;

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

const requireEpoch = (epoch, fn) => {
  if (!isFrozenRegistryEpoch(epoch)) fail(`${fn} expects a frozen epoch compiled by registry.compiler`, { got: typeof epoch });
};

const requireManifest = (manifest, fn) => {
  if (!isResolutionManifest(manifest)) fail(`${fn} expects a manifest produced by createResolutionManifest`, { got: typeof manifest });
};

/** The nodes an operator asked to pin, normalized and sorted, with duplicates refused. */
function normalizeNodes(nodes) {
  if (!Array.isArray(nodes)) fail('createResolutionManifest expects a nodes array of { type, typeVersion } entries', { code: 'resolution.node' });
  const seen = new Map();
  for (const [position, entry] of nodes.entries()) {
    if (!isPlainObject(entry)) fail(`nodes[${position}] is not an object`, { code: 'resolution.node', position });
    const identity = nodeIdentity(entry);
    if (seen.has(identity)) {
      fail(`identity '${identity}' is listed twice (positions ${seen.get(identity).position} and ${position}); a workflow resolves a node once`, { code: 'resolution.node', identity });
    }
    const parsed = parseNodeIdentity(identity);
    seen.set(identity, { identity, type: parsed.type, typeVersion: parsed.typeVersion, position });
  }
  return [...seen.values()].sort((a, b) => (a.identity < b.identity ? -1 : 1));
}

/* ------------------------------------------------------------------ *\n * Pin\n * ------------------------------------------------------------------ */

/**
 * Pin a workflow's nodes against an epoch.
 *
 * @param {{ workflowId?: string, nodes?: unknown[], epoch?: object, policy?: string }} input
 * @returns {Readonly<object>} a frozen manifest, or a frozen refusal — no partial pinning.
 */
export function createResolutionManifest(input = {}) {
  const { workflowId, nodes, epoch, policy = 'exact', note = null } = isPlainObject(input) ? input : {};

  if (!isNonEmptyString(workflowId)) {
    fail('a resolution manifest must name the workflow it pins; an anonymous manifest cannot be found again', { code: 'resolution.workflow', field: 'workflowId' });
  }
  if (!UPGRADE_POLICIES.includes(policy)) {
    fail(`policy '${policy}' is unknown; policies are ${UPGRADE_POLICIES.join(', ')}`, { code: 'resolution.policy', field: 'policy' });
  }
  requireEpoch(epoch, 'createResolutionManifest');

  const requested = normalizeNodes(nodes);
  const unresolved = requested.filter((entry) => !Object.hasOwn(epoch.byIdentity, entry.identity));
  if (unresolved.length > 0) {
    return deepFreeze({
      ok: false,
      schemaVersion: RESOLUTION_MANIFEST_SCHEMA_VERSION,
      contract: RESOLUTION_MANIFEST_CONTRACT,
      workflowId,
      reason: 'resolution.unresolved',
      pins: null,
      errors: unresolved.map((entry) => ({
        code: 'resolution.unresolved',
        identity: entry.identity,
        message: `'${entry.identity}' is not in epoch ${epoch.epochNumber} (${epoch.source}); a workflow cannot pin what the registry does not have`,
      })),
    });
  }

  const pins = requested.map((entry) => Object.freeze({
    identity: entry.identity,
    type: entry.type,
    typeVersion: entry.typeVersion,
    digest: epoch.byIdentity[entry.identity].digest,
    epochNumber: epoch.epochNumber,
  }));

  const revision = 1;
  const manifestDigest = digestOf(stableJson({
    workflowId, revision, policy, epochDigest: epoch.epochDigest,
    pins: pins.map((pin) => [pin.identity, pin.digest]),
  }));

  return deepFreeze({
    ok: true,
    schemaVersion: RESOLUTION_MANIFEST_SCHEMA_VERSION,
    contract: RESOLUTION_MANIFEST_CONTRACT,
    workflowId,
    revision,
    policy,
    note,
    epochNumber: epoch.epochNumber,
    epochDigest: epoch.epochDigest,
    epochSource: epoch.source,
    pins,
    pinCount: pins.length,
    manifestDigest,
    history: [],
    errors: [],
    reason: null,
  });
}

/** @returns {boolean} whether `value` is a manifest this contract produced. */
export function isResolutionManifest(value) {
  return (
    isPlainObject(value) &&
    value.ok === true &&
    value.contract === RESOLUTION_MANIFEST_CONTRACT &&
    value.schemaVersion === RESOLUTION_MANIFEST_SCHEMA_VERSION &&
    isNonEmptyString(value.workflowId) &&
    Number.isInteger(value.revision) &&
    value.revision >= 1 &&
    Array.isArray(value.pins) &&
    typeof value.manifestDigest === 'string' &&
    Array.isArray(value.history) &&
    Object.isFrozen(value)
  );
}

/* ------------------------------------------------------------------ *\n * Resolve\n * ------------------------------------------------------------------ */

/**
 * Resolve every pin against an epoch.
 *
 * `changed` is a refusal, not a note: the same identity carrying a different
 * digest means the registry rewrote a node under its own name, which P6.1 forbids.
 *
 * @returns {Readonly<object>} `{ ok, states, changed, missing, epochDigest }`
 */
export function resolveWorkflowNodes(manifest, epoch) {
  requireManifest(manifest, 'resolveWorkflowNodes');
  requireEpoch(epoch, 'resolveWorkflowNodes');

  const states = manifest.pins.map((pin) => {
    const entry = epoch.byIdentity[pin.identity];
    if (!entry) return Object.freeze({ identity: pin.identity, state: 'missing', digest: pin.digest, epochDigest: null });
    if (entry.digest !== pin.digest) return Object.freeze({ identity: pin.identity, state: 'changed', digest: pin.digest, epochDigest: entry.digest });
    return Object.freeze({ identity: pin.identity, state: 'match', digest: pin.digest, epochDigest: entry.digest });
  });

  const missing = states.filter((state) => state.state === 'missing').map((state) => state.identity);
  const changed = states.filter((state) => state.state === 'changed').map((state) => state.identity);
  const ok = missing.length === 0 && changed.length === 0;

  return deepFreeze({
    ok,
    workflowId: manifest.workflowId,
    revision: manifest.revision,
    epochNumber: epoch.epochNumber,
    epochDigest: epoch.epochDigest,
    pinnedEpochDigest: manifest.epochDigest,
    resolvedAgainstPinnedEpoch: epoch.epochDigest === manifest.epochDigest,
    states,
    missing: Object.freeze(missing),
    changed: Object.freeze(changed),
    matched: states.filter((state) => state.state === 'match').length,
    reason: ok ? null : missing.length > 0 ? 'resolution.missing' : 'resolution.changed',
    messages: Object.freeze([
      ...missing.map((identity) => `'${identity}' is pinned by workflow '${manifest.workflowId}' but is absent from epoch ${epoch.epochNumber}; nothing is silently dropped from a workflow`),
      ...changed.map((identity) => `'${identity}' carries a different digest in epoch ${epoch.epochNumber}; the same identity with different bytes is a registry integrity violation, not an upgrade`),
    ]),
  });
}

/* ------------------------------------------------------------------ *\n * Upgrade\n * ------------------------------------------------------------------ */

/** Is `candidate` a move the policy permits from `current`? Never downwards, never a no-op. */
const isUpgradeCandidate = (candidate, current, policy) => {
  if (policy === 'exact') return false;
  if (compareTypeVersion(candidate, current) <= 0) return false;
  if (policy === 'minor') return candidate.major === current.major;
  return true;
};

function compareTypeVersion(a, b) {
  if (a.major !== b.major) return a.major - b.major;
  return a.minor - b.minor;
}

/** Split a `type@typeVersion` pin into its parts and a comparable version. */
const versionParts = (typeVersion) => {
  const text = String(typeVersion);
  const [major, minor] = text.split('.');
  return { major: Number(major), minor: minor === undefined ? 0 : Number(minor), raw: text };
};

/**
 * PROPOSE an upgrade. Changes nothing: the manifest handed in is returned
 * untouched, and the proposal carries the manifest digest it was computed from.
 */
export function planNodeUpgrade(manifest, epoch, { policy = manifest.policy } = {}) {
  requireManifest(manifest, 'planNodeUpgrade');
  requireEpoch(epoch, 'planNodeUpgrade');
  if (!UPGRADE_POLICIES.includes(policy)) {
    fail(`policy '${policy}' is unknown; policies are ${UPGRADE_POLICIES.join(', ')}`, { code: 'resolution.policy', field: 'policy' });
  }

  const changes = [];
  const unavailable = [];
  const unchanged = [];
  const candidatesByType = new Map();
  for (const identity of epoch.identities) {
    const parsed = parseNodeIdentity(identity);
    const list = candidatesByType.get(parsed.type) ?? [];
    list.push({ identity, ...versionParts(parsed.typeVersion) });
    candidatesByType.set(parsed.type, list);
  }

  for (const pin of manifest.pins) {
    // A pin the epoch no longer has is FATAL, whatever candidates exist: turning
    // "the node you pinned is gone" into "here is a different version instead" is
    // exactly the silent drop this contract exists to prevent.
    if (!Object.hasOwn(epoch.byIdentity, pin.identity)) {
      unavailable.push(Object.freeze({
        identity: pin.identity,
        message: `'${pin.identity}' is pinned but absent from epoch ${epoch.epochNumber}; an upgrade must not drop a node`,
      }));
      continue;
    }

    const current = versionParts(pin.typeVersion);
    const candidates = (candidatesByType.get(pin.type) ?? [])
      .filter((candidate) => isUpgradeCandidate(candidate, current, policy))
      .sort((a, b) => compareTypeVersion(b, a));

    if (candidates.length === 0) {
      unchanged.push(pin.identity);
      continue;
    }
    const target = candidates[0];
    changes.push(Object.freeze({
      type: pin.type,
      from: pin.identity,
      to: target.identity,
      fromDigest: pin.digest,
      toDigest: epoch.byIdentity[target.identity].digest,
      policy,
    }));
  }

  const ok = unavailable.length === 0;
  return deepFreeze({
    ok,
    workflowId: manifest.workflowId,
    revision: manifest.revision,
    policy,
    currentPolicy: manifest.policy,
    fromEpochDigest: manifest.epochDigest,
    toEpochNumber: epoch.epochNumber,
    toEpochDigest: epoch.epochDigest,
    changes,
    unchanged,
    unavailable,
    planDigest: digestOf(stableJson({
      workflowId: manifest.workflowId, revision: manifest.revision, policy,
      toEpochDigest: epoch.epochDigest, changes: changes.map((change) => [change.from, change.to]),
    })),
    reason: ok ? null : 'resolution.unresolved',
  });
}

/**
 * APPLY an upgrade proposal.
 *
 * Refused unless: the call is explicitly authorized, the manifest revision is
 * still current, no node is unavailable, and the proposal still equals what the
 * epoch would produce now (a stale plan is not merged).
 *
 * @returns {{ ok: true, manifest: object, applied: object[] }} or a frozen refusal
 */
export function applyNodeUpgrade(manifest, epoch, plan, { authorized = false } = {}) {
  requireManifest(manifest, 'applyNodeUpgrade');
  requireEpoch(epoch, 'applyNodeUpgrade');

  if (authorized !== true) {
    return deepFreeze({
      ok: false, reason: 'resolution.authorization', manifest,
      errors: [{ code: 'resolution.authorization', message: 'applying an upgrade changes what a workflow runs; it requires an explicit authorization, never a default' }],
    });
  }
  if (!isPlainObject(plan) || typeof plan.planDigest !== 'string') {
    return deepFreeze({
      ok: false, reason: 'resolution.plan', manifest,
      errors: [{ code: 'resolution.plan', message: 'applyNodeUpgrade expects a proposal from planNodeUpgrade' }],
    });
  }
  if (plan.workflowId !== manifest.workflowId) {
    return deepFreeze({ ok: false, reason: 'resolution.plan', manifest, errors: [{ code: 'resolution.plan', message: `the proposal is for '${plan.workflowId}', not '${manifest.workflowId}'` }] });
  }
  if (plan.revision !== manifest.revision) {
    return deepFreeze({ ok: false, reason: 'resolution.revision', manifest, errors: [{ code: 'resolution.revision', message: `the proposal was computed at revision ${plan.revision}; the manifest is at ${manifest.revision}` }] });
  }

  if (!UPGRADE_POLICIES.includes(plan.policy)) {
    return deepFreeze({ ok: false, reason: 'resolution.policy', manifest, errors: [{ code: 'resolution.policy', message: `the proposal names policy '${plan.policy}', which is not one of ${UPGRADE_POLICIES.join(', ')}` }] });
  }

  const fresh = planNodeUpgrade(manifest, epoch, { policy: plan.policy });
  if (fresh.planDigest !== plan.planDigest) {
    return deepFreeze({
      ok: false, reason: 'resolution.stale', manifest,
      errors: [{
        code: 'resolution.stale',
        message: `the proposal no longer matches what epoch ${epoch.epochNumber} would produce (${plan.planDigest.slice(0, 12)}… vs ${fresh.planDigest.slice(0, 12)}…); an upgrade approved against a different registry is not applied`,
      }],
    });
  }
  if (fresh.unavailable.length > 0) {
    return deepFreeze({
      ok: false, reason: 'resolution.unresolved', manifest,
      errors: fresh.unavailable.map((entry) => ({ code: 'resolution.unresolved', identity: entry.identity, message: entry.message })),
    });
  }
  if (fresh.changes.length === 0) {
    return Object.freeze({ ok: true, manifest, applied: Object.freeze([]), reason: 'resolution.plan' });
  }

  const byPin = new Map(manifest.pins.map((pin) => [pin.identity, pin]));
  for (const change of fresh.changes) byPin.delete(change.from);
  for (const change of fresh.changes) {
    const parsed = parseNodeIdentity(change.to);
    byPin.set(change.to, Object.freeze({
      identity: change.to,
      type: parsed.type,
      typeVersion: parsed.typeVersion,
      digest: change.toDigest,
      epochNumber: epoch.epochNumber,
    }));
  }
  const pins = [...byPin.values()].sort((a, b) => (a.identity < b.identity ? -1 : 1));
  const revision = manifest.revision + 1;
  const historyEntry = Object.freeze({
    revision,
    fromRevision: manifest.revision,
    fromEpochDigest: manifest.epochDigest,
    toEpochDigest: epoch.epochDigest,
    policyFrom: manifest.policy,
    policyTo: fresh.policy,
    planDigest: fresh.planDigest,
    changes: Object.freeze(fresh.changes.map((change) => Object.freeze({ from: change.from, to: change.to, fromDigest: change.fromDigest, toDigest: change.toDigest }))),
  });

  const manifestDigest = digestOf(stableJson({
    workflowId: manifest.workflowId, revision, policy: fresh.policy, epochDigest: epoch.epochDigest,
    pins: pins.map((pin) => [pin.identity, pin.digest]),
  }));

  const upgraded = deepFreeze({
    ...manifest,
    revision,
    policy: fresh.policy,
    epochNumber: epoch.epochNumber,
    epochDigest: epoch.epochDigest,
    epochSource: epoch.source,
    pins,
    pinCount: pins.length,
    manifestDigest,
    history: [...manifest.history, historyEntry],
  });
  return Object.freeze({ ok: true, manifest: upgraded, applied: historyEntry.changes, reason: null });
}

/* ------------------------------------------------------------------ *\n * Reads\n * ------------------------------------------------------------------ */

/** Serializable projection, safe for storage next to a workflow definition. */
export function resolutionManifestView(manifest) {
  requireManifest(manifest, 'resolutionManifestView');
  return deepFreeze({
    contract: manifest.contract,
    schemaVersion: manifest.schemaVersion,
    workflowId: manifest.workflowId,
    revision: manifest.revision,
    policy: manifest.policy,
    note: manifest.note,
    epochNumber: manifest.epochNumber,
    epochDigest: manifest.epochDigest,
    epochSource: manifest.epochSource,
    manifestDigest: manifest.manifestDigest,
    pinCount: manifest.pinCount,
    pins: manifest.pins.map((pin) => ({ identity: pin.identity, digest: pin.digest })),
    historyLength: manifest.history.length,
    revisions: manifest.history.map((entry) => entry.revision),
  });
}

export function describeResolutionManifest(manifest) {
  requireManifest(manifest, 'describeResolutionManifest');
  return deepFreeze({
    workflowId: manifest.workflowId,
    revision: manifest.revision,
    policy: manifest.policy,
    pinCount: manifest.pinCount,
    epochNumber: manifest.epochNumber,
    epochDigest: manifest.epochDigest,
    manifestDigest: manifest.manifestDigest,
    identities: Object.freeze(manifest.pins.map((pin) => pin.identity)),
    upgrades: manifest.history.length,
  });
}

/** `workflow-7 rev 2 (minor) 3 nodes @ epoch 4 9f21…`. */
export function formatResolutionManifest(manifest) {
  requireManifest(manifest, 'formatResolutionManifest');
  return `workflow '${manifest.workflowId}' rev ${manifest.revision} (${manifest.policy}) ${manifest.pinCount} node${manifest.pinCount === 1 ? '' : 's'} @ epoch ${manifest.epochNumber} ${manifest.manifestDigest.slice(0, 12)}`;
}

/** The identities a manifest pins, and the digest each is pinned to. */
export function pinnedIdentities(manifest) {
  requireManifest(manifest, 'pinnedIdentities');
  return deepFreeze(Object.fromEntries(manifest.pins.map((pin) => [pin.identity, pin.digest])));
}

/** What changed between two revisions of the same workflow's manifest. */
export function resolutionDiff(left, right) {
  requireManifest(left, 'resolutionDiff');
  requireManifest(right, 'resolutionDiff');
  if (left.workflowId !== right.workflowId) {
    fail(`resolutionDiff compares two revisions of ONE workflow ('${left.workflowId}' vs '${right.workflowId}')`, { code: 'resolution.workflow' });
  }
  const leftPins = new Map(left.pins.map((pin) => [pin.identity, pin.digest]));
  const rightPins = new Map(right.pins.map((pin) => [pin.identity, pin.digest]));
  const added = [...rightPins.keys()].filter((identity) => !leftPins.has(identity)).sort();
  const removed = [...leftPins.keys()].filter((identity) => !rightPins.has(identity)).sort();
  const replaced = [...leftPins.keys()].filter((identity) => rightPins.has(identity) && rightPins.get(identity) !== leftPins.get(identity)).sort();
  const unchanged = [...leftPins.keys()].filter((identity) => leftPins.get(identity) === rightPins.get(identity)).length;
  return deepFreeze({ added, removed, replaced, unchanged, fromRevision: left.revision, toRevision: right.revision });
}

export const RESOLUTION_MANIFEST_INPUT_SCHEMA_VERSION = NODE_REGISTRY_SCHEMA_VERSION;
