/**
 * Foundation 1.0 — the accessor for the architecture vocabulary (P2.8-B).
 *
 * PUBLIC CONTRACT (`lego.foundation`, v1.0.0, owner: manager).
 *
 * P2.6 answered "what are the boundaries?". P2.7 answered "do they survive
 * change?". P2.8-B answers "in what vocabulary does a LEGO describe itself?" —
 * communication modes, operation semantics, trust, runtimes, resources,
 * portability, activation, node creation routes.
 *
 * Like the rest of the foundation this is DATA plus pure functions:
 *   - `manifest/foundation.json`   the vocabulary
 *   - `manifest/node-contract.json` what a node is, and the 12 creation routes
 *   - `manifest/contract-schema.json` the language-neutral schema strategy
 *
 * No framework, no runtime cost, no registry duplication. Everything here is
 * readable by a tool, a test, or an AI agent that wants one small card instead
 * of the whole repository.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

function read(name) {
  return JSON.parse(readFileSync(resolve(HERE, 'manifest', name), 'utf8'));
}

/** @type {object} the Foundation 1.0 vocabulary */
export const FOUNDATION = Object.freeze(read('foundation.json'));

/** @type {object} the Node Contract definition + creation routes + decision model */
export const NODE_CONTRACT = Object.freeze(read('node-contract.json'));

/** @type {object} the language-neutral contract schema strategy */
export const CONTRACT_SCHEMA_STRATEGY = Object.freeze(read('contract-schema.json'));

export const FOUNDATION_VERSION = FOUNDATION.foundationVersion;

/* ------------------------------------------------------------- vocabularies */

export const COMMUNICATION_MODES = Object.freeze(Object.keys(FOUNDATION.communication.modes));
export const TRUST_LEVELS = Object.freeze(Object.keys(FOUNDATION.trust.levels));
export const CAPABILITIES = Object.freeze([...FOUNDATION.trust.capabilities]);
export const RUNTIMES = Object.freeze(Object.keys(FOUNDATION.runtimes));
export const PORTABILITY_PROFILES = Object.freeze([...FOUNDATION.portability.profiles]);
export const ACTIVATION_STATES = Object.freeze([...FOUNDATION.activation.states]);
export const FAILURE_BOUNDARIES = Object.freeze([...FOUNDATION.failureBoundaries.levels]);
export const STATE_CLASSES = Object.freeze(Object.keys(FOUNDATION.state.classes));
export const CREATION_ROUTES = Object.freeze(NODE_CONTRACT.creationRoutes.routes.map((route) => route.id));

/** Operation-semantics vocabularies, keyed by dimension. */
export const OPERATION_SEMANTICS = Object.freeze({
  idempotency: Object.freeze([...FOUNDATION.operationSemantics.idempotency.values]),
  determinism: Object.freeze([...FOUNDATION.operationSemantics.determinism.values]),
  atomicity: Object.freeze([...FOUNDATION.operationSemantics.atomicity.values]),
  concurrency: Object.freeze([...FOUNDATION.operationSemantics.concurrency.values]),
  backpressure: Object.freeze([...FOUNDATION.operationSemantics.backpressure.values]),
});

/* ----------------------------------------------------------------- queries */

/** @returns {object|null} a creation route by id */
export function getCreationRoute(id) {
  return NODE_CONTRACT.creationRoutes.routes.find((route) => route.id === id) ?? null;
}

/** Capabilities a trust level grants by default. Trust never implies more. */
export function defaultCapabilitiesFor(trust) {
  return Object.freeze([...(FOUNDATION.trust.defaultGrants[trust] ?? [])]);
}

/**
 * Is `capability` allowed for a LEGO at `trust`, given what it explicitly
 * requested? Trust and capability are separate axes: a request outside the
 * trust level's default grant must be granted deliberately, never implied.
 *
 * @returns {{ allowed: boolean, reason: string }}
 */
export function isCapabilityAllowed(trust, capability, { granted = [] } = {}) {
  if (!TRUST_LEVELS.includes(trust)) return { allowed: false, reason: `unknown trust level '${trust}'` };
  if (!CAPABILITIES.includes(capability)) return { allowed: false, reason: `unknown capability '${capability}'` };
  if (granted.includes(capability)) return { allowed: true, reason: 'explicitly granted' };
  const defaults = FOUNDATION.trust.defaultGrants[trust] ?? [];
  if (defaults.includes(capability)) return { allowed: true, reason: `default grant for trust '${trust}'` };
  return {
    allowed: false,
    reason: `trust '${trust}' does not grant '${capability}' by default and it was not explicitly granted`,
  };
}

/** Is this activation transition legal? Keeps the state machine honest. */
export function canTransition(from, to) {
  const allowed = FOUNDATION.activation.transitions[from];
  if (!allowed) return { allowed: false, reason: `unknown activation state '${from}'` };
  return allowed.includes(to)
    ? { allowed: true, reason: `${from} -> ${to}` }
    : { allowed: false, reason: `${from} -> ${to} is not a legal transition (allowed: ${allowed.join(', ')})` };
}

/**
 * The AI route decision, as an auditable function rather than a vibe.
 * Applies `NODE_CONTRACT.decisionModel.rules` in order and returns the first
 * match with the rule that fired — so a recommendation can always be explained.
 *
 * @param {{ existingCommunityNode?: boolean, isRestWrapper?: boolean,
 *           hasOpenApiSpec?: boolean, pureHotTransform?: boolean,
 *           portabilityCritical?: boolean, constrainedDevice?: boolean,
 *           heavy?: boolean, pythonEcosystem?: boolean }} facts
 */
export function decideCreationRoute(facts = {}) {
  const rules = NODE_CONTRACT.decisionModel.rules;
  const fire = (id, matched) => {
    const rule = rules.find((candidate) => candidate.id === id);
    return matched
      ? { route: rule.prefer.split(' or ')[0], ruleId: rule.id, because: rule.because, rule: rule.when }
      : null;
  };
  return (
    fire('D1', facts.existingCommunityNode === true) ??
    fire('D2', facts.isRestWrapper === true && facts.hasOpenApiSpec !== true) ??
    fire('D3', facts.hasOpenApiSpec === true) ??
    fire('D4', facts.pureHotTransform === true && facts.portabilityCritical !== true) ??
    fire('D5', facts.portabilityCritical === true) ??
    fire('D6', facts.constrainedDevice === true && facts.heavy === true) ??
    fire('D7', facts.pythonEcosystem === true) ??
    fire('D8', true)
  );
}

/**
 * Guard for the Rust policy: Rust is an implementation choice and must clear
 * four hard constraints. Returns why it is or is not justified — so "because
 * Rust" can never be the reason.
 */
export function isRustJustified({ highFrequency = false, materialResourceSaving = false, maintainability = false, prebuiltAvailable = false, sameContract = true, breaksJsCompat = false } = {}) {
  const reasons = [];
  if (highFrequency) reasons.push('high-frequency execution');
  if (materialResourceSaving) reasons.push('material CPU/memory saving');
  if (maintainability) reasons.push('long-term maintainability');
  const blockers = [];
  if (!prebuiltAvailable) blockers.push('no prebuilt artifact — a compiler must never be required on a user device');
  if (!sameContract) blockers.push('must implement the same Node Contract with unchanged identity');
  if (breaksJsCompat) blockers.push('must not break JS or community-node compatibility');
  if (reasons.length === 0) blockers.push('no material benefit declared — "it is Rust" is not a reason');
  return { justified: blockers.length === 0, reasons, blockers };
}
