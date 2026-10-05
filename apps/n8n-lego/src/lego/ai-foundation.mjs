/**
 * AI Foundation — provider-neutral contract vocabulary (P2.10).
 *
 * PUBLIC CONTRACT (`ai.foundation`, v1.0.0, owner: manager).
 *
 * This module exposes `manifest/ai-foundation.json` as frozen data plus a few
 * pure lookup functions. It is the contract surface a future AI Foundation
 * would satisfy.
 *
 * WHAT THIS IS NOT
 * ----------------
 * There is no inference here, no agent loop, no gateway client, no MCP server
 * or client, no network call, no daemon and no new dependency. Nothing in this
 * file reaches the network or spawns anything. It is vocabulary.
 *
 * WHY VOCABULARY FIRST
 * --------------------
 * The failure mode this prevents is specific and common: an AI integration
 * arrives as one vendor's SDK, that SDK's shape becomes the internal model, and
 * from then on every other provider has to be bent to fit a competitor's
 * abstractions. Writing the neutral contract BEFORE any adapter means the first
 * vendor is an implementation rather than the architecture.
 *
 * THE FIVE CONCEPTS, KEPT SEPARATE
 * --------------------------------
 *   capability     WHAT the system can do        (owned by a LEGO, stable)
 *   implementation HOW it is realised            (JS or Rust, swappable)
 *   provider       WHERE it is sourced from      (model / tool / application)
 *   transport      HOW bytes move                (in-process/worker/remote/mcp)
 *   runtime        WHERE an agent executes       (agent / simulation runtime)
 *
 * Conflating any two of these is what makes an integration unreplaceable.
 *
 * Owner: manager (registered as such deliberately — these contracts are shared
 * and must not be owned accidentally by whoever wrote them first).
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** @type {object} the AI Foundation contract vocabulary */
export const AI_FOUNDATION = Object.freeze(
  JSON.parse(readFileSync(resolve(HERE, 'manifest', 'ai-foundation.json'), 'utf8')),
);

export const AI_FOUNDATION_VERSION = AI_FOUNDATION.version;

/* ------------------------------------------------------------- vocabularies */

/** The five distinct concepts. Kept separate on purpose — see the module note. */
export const AI_CONCEPTS = Object.freeze(Object.keys(AI_FOUNDATION.taxonomy.concepts));

/** Provider kinds: model, tool, application, agent-runtime, simulation-runtime. */
export const PROVIDER_KINDS = Object.freeze(Object.keys(AI_FOUNDATION.providerKinds));

/** Transports an AI contract may bind to. `mcp` is an edge adapter, not an internal bus. */
export const AI_TRANSPORTS = Object.freeze([...AI_FOUNDATION.transportRouting.kinds]);

/** Where a runtime executes. */
export const RUNTIME_LOCALITIES = Object.freeze([...AI_FOUNDATION.agentRuntime.runtimeMetadata.locality]);

/** The authoritative agent event vocabulary. */
export const AGENT_EVENT_TYPES = Object.freeze([...AI_FOUNDATION.events.types]);

/** Session states. */
export const AGENT_SESSION_STATES = Object.freeze([...AI_FOUNDATION.agentSession.states]);

/** Context scopes, broadest first. */
export const CONTEXT_SCOPES = Object.freeze([...AI_FOUNDATION.context.scopes]);

/** Artifact kinds and retention classes. */
export const ARTIFACT_KINDS = Object.freeze([...AI_FOUNDATION.artifact.kinds]);
export const ARTIFACT_RETENTION = Object.freeze([...AI_FOUNDATION.artifact.retention]);

/** Risk levels used by the decision contract. */
export const RISK_LEVELS = Object.freeze([...AI_FOUNDATION.decision.risk]);

/** Resource profile names. */
export const AI_RESOURCE_PROFILES = Object.freeze(Object.keys(AI_FOUNDATION.resourceProfiles.profiles));

/** Tool side-effect classes. Drives the approval contract. */
export const TOOL_SIDE_EFFECTS = Object.freeze(['read-only', 'writes', 'destructive', 'external']);

/* ----------------------------------------------------------------- lookups */

/**
 * Operations declared by one AI contract.
 *
 * @param {string} contract e.g. 'ai.model-gateway'
 * @returns {ReadonlyArray<object>} operations, or [] when the contract is unknown
 */
export function operationsFor(contract) {
  const sections = [
    AI_FOUNDATION.modelGateway,
    AI_FOUNDATION.toolGateway,
    AI_FOUNDATION.agentRuntime,
  ];
  for (const section of sections) {
    if (section.contract !== contract) continue;
    return Object.freeze([...(section.operations ?? section.lifecycle ?? [])]);
  }
  return Object.freeze([]);
}

/** Every AI contract id declared in the vocabulary. */
export function listAiContracts() {
  const out = new Set();
  for (const value of Object.values(AI_FOUNDATION)) {
    if (value && typeof value === 'object' && typeof value.contract === 'string') out.add(value.contract);
  }
  for (const kind of Object.values(AI_FOUNDATION.providerKinds)) {
    if (kind.contract) out.add(kind.contract);
  }
  return Object.freeze([...out].sort());
}

/**
 * Describe a provider kind.
 *
 * @param {string} kind one of PROVIDER_KINDS
 * @returns {object|null}
 */
export function describeProviderKind(kind) {
  return AI_FOUNDATION.providerKinds[kind] ?? null;
}

/**
 * Is this deployment state the valid zero-install state?
 *
 * Zero-install is a SUPPORTED state, not an error: the foundation is ready and
 * no provider is connected. It is what allows a provider to be attached later
 * as configuration instead of as an architecture change.
 *
 * @param {{modelProvider?: string, toolProvider?: string, agentRuntime?: string}} state
 * @returns {boolean}
 */
export function isZeroInstallState(state = {}) {
  const unset = (value) => value === undefined || value === null || value === 'not-configured';
  return unset(state.modelProvider) && unset(state.toolProvider) && unset(state.agentRuntime);
}

/**
 * Can a transport carry an interaction class?
 *
 * The OPERATION owns its interaction class; a transport only advertises what it
 * can carry. A transport must never silently downgrade a STREAM to a CALL — the
 * caller asked for incremental output and would instead wait for one late
 * response, which looks like a hang rather than a refusal.
 *
 * @param {string} transport one of AI_TRANSPORTS
 * @param {string} interaction call | event | stream | batch
 * @returns {boolean}
 */
export function transportCanCarry(transport, interaction) {
  const matrix = {
    'in-process': ['call', 'event', 'stream', 'batch'],
    worker: ['call', 'event', 'stream', 'batch'],
    remote: ['call', 'event', 'stream', 'batch'],
    // MCP models tools and resources as request/response with notifications.
    // It carries no native batch, so a batch must be decomposed by the adapter
    // rather than pretended at this layer.
    mcp: ['call', 'event', 'stream'],
  };
  return (matrix[transport] ?? []).includes(interaction);
}

/**
 * Does an action require approval?
 *
 * FAIL-CLOSED. The three cases, in order:
 *
 *   1. the action is on the declared list          -> approval required
 *   2. the caller proves it is read-only           -> no approval required
 *   3. anything else, including unknown actions    -> approval required
 *
 * Case 3 is the important one. The tempting implementation is a plain
 * `list.includes(action)`, which returns false for an unknown action — so a
 * newly added destructive action silently needs no approval until someone
 * remembers to extend the list. That is fail-OPEN, and it fails exactly when a
 * new capability is introduced, which is precisely when review matters most.
 *
 * Proving read-only is explicit: the caller passes the tool's declared
 * `sideEffects`, which the tool gateway contract already requires.
 *
 * @param {string} action
 * @param {{sideEffects?: string}} [context] declared side effects, if known
 * @returns {boolean}
 */
export function requiresApproval(action, context = {}) {
  if (typeof action !== 'string' || action.length === 0) return true;
  if (AI_FOUNDATION.approval.actionsRequiringApproval.includes(action)) return true;
  if (context.sideEffects === 'read-only') return false;
  return true;
}

/**
 * Validate a delegation's authority grant against its parent.
 *
 * Parent authority never propagates automatically: a child receives only what
 * is explicitly listed, and only what the parent actually holds. Without this,
 * a delegation chain quietly terminates in an agent holding every permission in
 * the system.
 *
 * @param {string[]} parentCapabilities
 * @param {string[]} grantedCapabilities
 * @returns {{ok: boolean, escalated: string[]}}
 */
export function checkDelegationGrant(parentCapabilities = [], grantedCapabilities = []) {
  const parent = new Set(parentCapabilities);
  const escalated = grantedCapabilities.filter((capability) => !parent.has(capability));
  return { ok: escalated.length === 0, escalated };
}
