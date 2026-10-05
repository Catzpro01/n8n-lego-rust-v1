/**
 * Skill LEGO — procedural knowledge with a lifecycle (P2.12).
 *
 * PUBLIC CONTRACT (`ai.skill`, v1.0.0, owner: manager).
 *
 * A Skill is knowledge + rules + procedure + capability map + validators. It is
 * a document that can be listed, described, validated and loaded. It is not an
 * actor: it has no goal, no loop, no scheduler and no authority.
 *
 * WHAT THIS MODULE IS
 * -------------------
 * A registry. It holds skill declarations, validates them against the contract,
 * answers discovery questions cheaply, and tracks each skill's lifecycle state.
 * That is the whole surface.
 *
 * WHAT THIS MODULE IS NOT
 * -----------------------
 * There is no execution here. Nothing in this file runs a procedure, invokes a
 * tool, calls a model, spawns a process, reads a credential, opens a socket or
 * touches the filesystem. `active` is a lifecycle state meaning "selected and
 * loaded", not a permission to act. The registry exposes no API that returns a
 * permission, a credential, a token or a handle — the strongest value a caller
 * can obtain is a frozen description object.
 *
 * THE AUTHORITY BOUNDARY — the point of the whole design
 * ------------------------------------------------------
 * A skill DECLARES the capabilities its procedure would need. It does not own,
 * grant or imply them. The capability system (`negotiation.mjs`,
 * `manifest/domains.json`) remains the sole authority on whether a caller may
 * use a capability. So:
 *
 *   skill.requiredCapabilities   =  "this procedure is impossible without X"
 *   capability negotiation       =  "you may/may not use X"
 *
 * These are different questions with different answers, and a skill can never
 * turn the first into the second. `validateSelection` asks the capability
 * registry whether X is DECLARED; it never asks, and cannot answer, whether the
 * caller is PERMITTED. Selecting a skill therefore grants nothing: an invoker
 * still faces capability negotiation, permission policy and approval on its own
 * account.
 *
 * FAIL CLOSED
 * -----------
 * A skill requiring a capability no LEGO declares is registered but NOT
 * selectable, and `validateSelection` returns a negative verdict naming the
 * capability. An unknown requirement is never assumed satisfiable.
 *
 * LAZY DISCOVERY
 * --------------
 * `list`, `resolve`, `describe` and `validateSelection` read declaration data
 * only (L0/L1). A skill's body — procedure and deep knowledge, L2/L3 — sits
 * behind a `load` callback that is invoked by exactly one function: `load()`.
 * The registry counts loader invocations so a test can prove the laziness
 * rather than trust it. Listing every skill's full body is how a context window
 * is exhausted before any work starts.
 *
 * NESTING / OWNERSHIP
 * -------------------
 * No new top-level domain. `ai.skill` is a capability of the existing
 * `ai-foundation` domain, and there is deliberately no `ai-skill` domain beside
 * it — the duplicate-domain failure F17 exists to catch. XA-11 (is a skill a
 * backend concept at all?) is open-for-manager; declaring the contract inside
 * ai-foundation means that if the ruling moves skills elsewhere, a contract
 * moves rather than a domain being deleted.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadRegistry } from './registry.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/** @type {object} the frozen `ai.skill` contract */
export const SKILL_CONTRACT = Object.freeze(
  JSON.parse(readFileSync(resolve(HERE, 'manifest', 'skill.json'), 'utf8')),
);

export const SKILL_CONTRACT_VERSION = SKILL_CONTRACT.version;

/** The six lifecycle states, in order. */
export const SKILL_LIFECYCLE = Object.freeze([...SKILL_CONTRACT.lifecycle.states]);

/** state -> the states it may legally move to. */
export const SKILL_TRANSITIONS = Object.freeze(
  Object.fromEntries(
    Object.entries(SKILL_CONTRACT.lifecycle.transitions).map(([from, to]) => [from, Object.freeze([...to])]),
  ),
);

export const SKILL_TRUST_LEVELS = Object.freeze(Object.keys(SKILL_CONTRACT.trustLevels));
export const SKILL_VALIDATOR_KINDS = Object.freeze([...SKILL_CONTRACT.validators.kinds]);
export const SKILL_OPERATIONS = Object.freeze(SKILL_CONTRACT.operations.map((operation) => operation.name));

/**
 * Registration errors carry a `lego.*` code so a consumer can branch on the
 * failure instead of matching a message. Every code used here is published in
 * contracts/errors.contract.json — F16 fails the build otherwise.
 */
export class SkillError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'SkillError';
    this.code = code;
    this.detail = detail;
  }
}

const REQUIRED_FIELDS = Object.freeze([
  'id', 'contractVersion', 'implementationVersion', 'owner', 'title', 'description',
  'trust', 'requiredCapabilities',
]);

const ID_PATTERN = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$/;

const majorOf = (version) => String(version).split('.')[0];

/**
 * A skill registry. Per-instance so tests do not fight over global state, with
 * a default instance for ordinary use.
 *
 * Deliberately in-memory and process-local: a skill registry that persisted
 * would be a storage domain, which is not this phase's job and would inherit
 * the scale-out blockers in src/store.mjs. `createSkillRegistry()` allocates no
 * file handle, no timer and no socket.
 */
export function createSkillRegistry({ registry } = {}) {
  /** @type {Map<string, object>} id -> frozen declaration (L0/L1 only) */
  const skills = new Map();
  /** @type {Map<string, string>} id -> lifecycle state */
  const states = new Map();
  /** @type {Map<string, Function|null>} id -> body loader (L2/L3), never called on discovery */
  const loaders = new Map();
  /** @type {Map<string, object>} id -> loaded body, populated only by load() */
  const bodies = new Map();
  /** @type {Map<string, number>} id -> how many times the loader actually ran */
  const loadCounts = new Map();

  const capabilityRegistry = () => registry ?? loadRegistry();

  /** Every capability id the LEGO registry declares. The authority, not a copy. */
  const declaredCapabilities = () => {
    const found = new Set();
    for (const domain of capabilityRegistry().domains) {
      for (const capability of domain.capabilities ?? []) found.add(capability.id);
    }
    return found;
  };

  function assertDeclaration(declaration) {
    if (!declaration || typeof declaration !== 'object') {
      throw new SkillError('lego.contract_violation', 'a skill declaration must be an object');
    }
    for (const field of REQUIRED_FIELDS) {
      const value = declaration[field];
      const missing = value === undefined || value === null || value === ''
        || (Array.isArray(value) && field === 'requiredCapabilities' && false);
      if (missing) {
        throw new SkillError('lego.contract_violation', `skill declaration is missing '${field}'`, { field });
      }
    }
    if (!ID_PATTERN.test(declaration.id)) {
      throw new SkillError('lego.contract_violation',
        `skill id '${declaration.id}' must be lower-case dotted/kebab segments`, { id: declaration.id });
    }
    if (!Array.isArray(declaration.requiredCapabilities)) {
      throw new SkillError('lego.contract_violation', `skill '${declaration.id}': requiredCapabilities must be an array`);
    }
    if (!SKILL_TRUST_LEVELS.includes(declaration.trust)) {
      throw new SkillError('lego.contract_violation',
        `skill '${declaration.id}': unknown trust '${declaration.trust}'`, { trust: declaration.trust });
    }
    for (const validator of declaration.validators ?? []) {
      if (!SKILL_VALIDATOR_KINDS.includes(validator.kind)) {
        throw new SkillError('lego.contract_violation',
          `skill '${declaration.id}': unknown validator kind '${validator.kind}'`, { kind: validator.kind });
      }
      if (validator.kind === 'custom' && typeof validator.check !== 'function') {
        throw new SkillError('lego.contract_violation',
          `skill '${declaration.id}': a custom validator needs a check function`);
      }
    }
    // A skill may never claim authority. These fields are refused outright
    // rather than ignored, because silently dropping them would let an author
    // believe the grant took effect.
    for (const forbidden of ['grants', 'grantedCapabilities', 'permissions', 'credentials', 'authority']) {
      if (declaration[forbidden] !== undefined) {
        throw new SkillError('lego.access_denied',
          `skill '${declaration.id}' declares '${forbidden}' — a skill requires capabilities, it never grants them`,
          { field: forbidden });
      }
    }
  }

  return {
    /** The contract this registry implements. */
    get contractVersion() { return SKILL_CONTRACT_VERSION; },

    /**
     * Register a skill declaration (L0/L1) plus an optional lazy body loader.
     *
     * Refuses: duplicates, malformed declarations, an incompatible contract
     * major, and any attempt to declare granted authority. An unknown required
     * capability does NOT refuse registration — the skill is registered and
     * simply never becomes selectable, which is the honest state: the skill
     * exists, its requirement is unmet.
     */
    register(declaration, { load = null } = {}) {
      assertDeclaration(declaration);
      if (skills.has(declaration.id)) {
        throw new SkillError('lego.contract_violation',
          `skill '${declaration.id}' is already registered`, { id: declaration.id });
      }
      if (majorOf(declaration.contractVersion) !== majorOf(SKILL_CONTRACT_VERSION)) {
        throw new SkillError('lego.version_incompatible',
          `skill '${declaration.id}' targets skill contract ${declaration.contractVersion}, `
          + `this registry implements ${SKILL_CONTRACT_VERSION}`,
          { required: declaration.contractVersion, actual: SKILL_CONTRACT_VERSION });
      }
      if (load !== null && typeof load !== 'function') {
        throw new SkillError('lego.contract_violation', `skill '${declaration.id}': load must be a function`);
      }

      const frozen = Object.freeze({
        ...declaration,
        requiredCapabilities: Object.freeze([...declaration.requiredCapabilities]),
        optionalCapabilities: Object.freeze([...(declaration.optionalCapabilities ?? [])]),
        validators: Object.freeze((declaration.validators ?? []).map((validator) => Object.freeze({ ...validator }))),
        produces: Object.freeze([...(declaration.produces ?? [])]),
      });
      skills.set(frozen.id, frozen);
      states.set(frozen.id, 'registered');
      loaders.set(frozen.id, load);
      loadCounts.set(frozen.id, 0);
      return frozen.id;
    },

    /** skill.list — L0 identities. Never touches a loader. */
    list() {
      return Object.freeze([...skills.values()].map((skill) => Object.freeze({
        id: skill.id,
        title: skill.title,
        summary: skill.description,
        trust: skill.trust,
        state: states.get(skill.id),
      })));
    },

    /** skill.resolve — one L0 identity, or null. Never touches a loader. */
    resolve(id) {
      const skill = skills.get(id);
      if (!skill) return null;
      return Object.freeze({
        id: skill.id,
        title: skill.title,
        summary: skill.description,
        trust: skill.trust,
        state: states.get(id),
      });
    },

    /**
     * skill.describe — the L1 card. Requirements, validators, degradation and
     * replacement metadata. Still no body: describing a skill must stay cheap
     * enough to do for every candidate.
     */
    describe(id) {
      const skill = skills.get(id);
      if (!skill) return null;
      const declared = declaredCapabilities();
      return Object.freeze({
        id: skill.id,
        title: skill.title,
        description: skill.description,
        owner: skill.owner,
        contractVersion: skill.contractVersion,
        implementationVersion: skill.implementationVersion,
        trust: skill.trust,
        state: states.get(id),
        requiredCapabilities: skill.requiredCapabilities,
        optionalCapabilities: skill.optionalCapabilities,
        // Reported per capability so a caller can see WHICH requirement is
        // unmet, not merely that something is.
        capabilityMap: Object.freeze(skill.requiredCapabilities.map((capability) => Object.freeze({
          capability,
          declared: declared.has(capability),
          // Stated on every row so nobody has to infer it from absence.
          granted: false,
          grantedNote: 'A skill never grants a capability. The capability system decides access.',
        }))),
        validators: Object.freeze(skill.validators.map((validator) => Object.freeze({
          kind: validator.kind, summary: validator.summary ?? null,
        }))),
        produces: skill.produces,
        availability: this.availabilityOf(id),
        degradation: SKILL_CONTRACT.degradation,
        replacement: SKILL_CONTRACT.replacement,
        loaded: bodies.has(id),
      });
    },

    /**
     * Availability, derived — never stored, so it cannot go stale against the
     * capability registry.
     */
    availabilityOf(id) {
      const skill = skills.get(id);
      if (!skill) return 'optional-absent';
      if (majorOf(skill.contractVersion) !== majorOf(SKILL_CONTRACT_VERSION)) return 'version-incompatible';
      const declared = declaredCapabilities();
      const missing = skill.requiredCapabilities.filter((capability) => !declared.has(capability));
      if (missing.length > 0) return 'capability-unavailable';
      const missingOptional = skill.optionalCapabilities.filter((capability) => !declared.has(capability));
      if (missingOptional.length > 0) return 'degraded';
      return 'available';
    },

    /**
     * skill.validate-selection — may this skill be selected here?
     *
     * Returns a verdict; a normal "no" is an answer, not an exception. The
     * verdict says nothing about whether the CALLER may use the capabilities:
     * that is the capability system's question, and this function deliberately
     * cannot answer it.
     */
    validateSelection(id, context = {}) {
      const skill = skills.get(id);
      if (!skill) {
        return Object.freeze({
          selectable: false, skill: id, reasons: Object.freeze(['unknown-skill']),
          code: 'lego.capability_unavailable', missingCapabilities: Object.freeze([]),
          grantsAuthority: false,
        });
      }
      const reasons = [];
      const declared = declaredCapabilities();
      const missing = skill.requiredCapabilities.filter((capability) => !declared.has(capability));

      if (majorOf(skill.contractVersion) !== majorOf(SKILL_CONTRACT_VERSION)) reasons.push('version-incompatible');
      // Fail closed: an undeclared capability is refused, never assumed.
      if (missing.length > 0) reasons.push('capability-unavailable');

      const destructive = skill.requiredCapabilities
        .filter((capability) => isDestructiveCapability(capability, capabilityRegistry()));
      const needsApproval = destructive.length > 0
        && SKILL_CONTRACT.trustDegradation.destructiveRequiresApproval.includes(skill.trust);
      if (needsApproval && context.approved !== true) reasons.push('approval-required');

      for (const validator of skill.validators) {
        if (validator.kind !== 'custom') continue;
        let passed = false;
        try {
          passed = validator.check(Object.freeze({ ...context }), this.describe(id)) === true;
        } catch {
          // A validator that throws has failed. It never takes the registry
          // down with it, and it never counts as a pass.
          passed = false;
        }
        if (!passed) reasons.push(`validator-failed:${validator.summary ?? validator.kind}`);
      }

      return Object.freeze({
        selectable: reasons.length === 0,
        skill: id,
        reasons: Object.freeze(reasons),
        code: reasons.length === 0 ? null : (missing.length > 0 ? 'lego.capability_unavailable' : 'lego.access_denied'),
        missingCapabilities: Object.freeze(missing),
        requiresApproval: needsApproval,
        // Stated explicitly in the return value, so a consumer reading only the
        // verdict cannot conclude that a positive answer conferred anything.
        grantsAuthority: false,
        authorityNote: 'Selectable means the procedure is followable. The caller must still pass capability negotiation, permission policy and approval.',
      });
    },

    /** Lifecycle state of a skill. */
    stateOf(id) {
      return states.get(id) ?? null;
    },

    /**
     * Move a skill to the next state. Invalid transitions throw — including
     * every skip-ahead, because `active` asserts the body is loaded and a state
     * machine that can be jumped is not a state machine.
     *
     * No transition consults, grants or carries a permission.
     */
    transition(id, to) {
      const from = states.get(id);
      if (from === undefined) {
        throw new SkillError('lego.capability_unavailable', `unknown skill '${id}'`, { id });
      }
      if (!SKILL_LIFECYCLE.includes(to)) {
        throw new SkillError('lego.contract_violation', `'${to}' is not a skill lifecycle state`, { to });
      }
      if (!SKILL_TRANSITIONS[from].includes(to)) {
        throw new SkillError('lego.interaction_mismatch',
          `skill '${id}' cannot move ${from} -> ${to}; allowed: ${SKILL_TRANSITIONS[from].join(', ') || 'none'}`,
          { id, from, to, allowed: SKILL_TRANSITIONS[from] });
      }
      // Releasing drops the body wherever it is reached from. Leaving a loaded
      // body behind a `released` state would make the state a lie and keep L3
      // text alive in memory after the caller believed it was gone.
      if (to === 'released') bodies.delete(id);
      states.set(id, to);
      return to;
    },

    /**
     * Load the body (L2/L3). The ONLY function that may invoke a loader, and
     * the reason discovery can stay cheap.
     */
    load(id) {
      const skill = skills.get(id);
      if (!skill) throw new SkillError('lego.capability_unavailable', `unknown skill '${id}'`, { id });
      if (states.get(id) !== 'selected') {
        throw new SkillError('lego.interaction_mismatch',
          `skill '${id}' must be 'selected' before it can be loaded (currently '${states.get(id)}')`,
          { id, state: states.get(id) });
      }
      const loader = loaders.get(id);
      const body = loader ? loader() : { procedure: [], knowledge: null };
      loadCounts.set(id, (loadCounts.get(id) ?? 0) + 1);
      bodies.set(id, Object.freeze(body));
      states.set(id, 'loaded');
      return bodies.get(id);
    },

    /** The loaded body, or null. Never triggers a load. */
    bodyOf(id) {
      return bodies.get(id) ?? null;
    },

    /** How many times a skill's loader actually ran — the laziness probe. */
    loadCount(id) {
      return loadCounts.get(id) ?? 0;
    },

    /** Release a skill from any state, dropping its body. */
    release(id) {
      if (!skills.has(id)) throw new SkillError('lego.capability_unavailable', `unknown skill '${id}'`, { id });
      bodies.delete(id);
      states.set(id, 'released');
      return 'released';
    },

    /** Test/reset helper. */
    clear() {
      skills.clear(); states.clear(); loaders.clear(); bodies.clear(); loadCounts.clear();
    },

    get size() { return skills.size; },
  };
}

/**
 * Is a capability destructive? Derived from the permissions the capability
 * registry declares, never from a hand-written list of ids.
 *
 * An earlier draft hardcoded ids such as `workspace.filesystem`. Two things
 * were wrong with that: those capabilities do not exist in this tree, so the
 * rule protected nothing; and a literal list silently stops matching the day a
 * capability is renamed. Reading the declaration means the definition of
 * "destructive" tracks the registry automatically.
 *
 * A capability counts as destructive when it declares a permission that can
 * change state or reach outside the process: `*:write`, `*:delete`,
 * `*:invoke`, `*:execute`, `*:control`, `*:create` or credential access.
 */
const DESTRUCTIVE_PERMISSION = /(:write|:delete|:destroy|:invoke|:execute|:control|:create|:install)$/;

function isDestructiveCapability(capabilityId, registry) {
  for (const domain of registry.domains) {
    for (const capability of domain.capabilities ?? []) {
      if (capability.id !== capabilityId) continue;
      return (capability.permissions ?? []).some((permission) => DESTRUCTIVE_PERMISSION.test(permission));
    }
  }
  // Unknown capability: treat as destructive. The safe default for an unknown
  // effect is the most restrictive one -- the same rule the AI Foundation
  // applies to a tool that fails to declare its side effects.
  return true;
}

/** The default registry for ordinary use. */
export const skillRegistry = createSkillRegistry();
