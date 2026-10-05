/**
 * Capability compiler + runtime locality — P6.8.
 *
 * PUBLIC CONTRACT (`node.capability@0.1.0`, domain `node-registry`).
 *
 * A declaration says what a node NEEDS (P6.1: capabilities, runtime locality,
 * resource profile). It does not say what a node GETS. The foundation's rule is
 * explicit about who decides — *"a node declares what it NEEDS; the host decides
 * what it GETS"* — and this contract is that decision, made once, in one place,
 * deterministically, so that "why did this node run in-process?" has an answer
 * that is a document instead of an interrogation.
 *
 * Four things happen here, in this order:
 *
 *   1. THE DECLARATION IS VALIDATED (P6.1's rules, quoted, not re-derived). An
 *      invalid declaration has no plan: there is nothing to compile.
 *
 *   2. THE HOST IS VALIDATED, and this is the part that usually does not exist.
 *      A host profile names, as data: which capabilities it can authorize, which
 *      runtimes it has, and the STRONGEST isolation it can offer. Unknown
 *      capability, unknown runtime, unknown failure boundary: refused. A host
 *      that cannot say what it is cannot be trusted with the decision.
 *
 *   3. CAPABILITIES ARE GRANTED OR THE PLAN IS REFUSED. `granted = declared ∩
 *      host`. A node that needs `subprocess` on a host that authorizes only
 *      `network` does not get a reduced plan — it gets no plan. There is no
 *      partial grant, because a node running with half its declared capabilities
 *      is a node whose failure modes were never written down.
 *
 *   4. RUNTIME SELECTION IS DELEGATED, OR THE PLAN SAYS IT WAS NOT.
 *      `node.portability@1.0.0` owns runtime selection. When the caller supplies
 *      the node's OWN portability declaration, this module validates it, binds it
 *      to the same node, calls `selectRuntime` and quotes the answer (selected
 *      target, candidates, rejected, policy), naming the delegate by
 *      `NODE_PORTABILITY_CONTRACT` so the quoted name is the domain's own and not
 *      a copy that can drift. It never re-implements the matrix.
 *
 *      MEASURED, NOT ASSUMED: the two contracts describe DIFFERENT capability
 *      axes. P6.1's `capabilities` quotes the foundation's trust capabilities
 *      (`network`, `filesystem`, `subprocess`, `secrets`, `native`, `env`), while
 *      `node.portability` validates `requiredCapabilities` against the registry's
 *      own capability ids (`ai.model-gateway`, `node-registry.catalog`, …) and
 *      demands class-specific permission ids from the published registry
 *      vocabulary (`webhook:receive`, `storage:read`, `worker:read`, …). There is
 *      no faithful projection between those vocabularies, so none is fabricated
 *      here: a declared `network` is a TRUST capability, and writing it into
 *      `requiredCapabilities` would be a lie that happens to compile. When no
 *      portability declaration is supplied the plan records
 *      `delegation.performed: false` and derives the target from the runtime
 *      locality model. A plan never pretends a delegation happened.
 *
 * Then one safety rule ties 3 and 4 together, and it is the reason this module
 * is worth its size:
 *
 *   CAPABILITIES CONSTRAIN LOCALITY.
 *
 * A node needing `native` or `subprocess` is not executed in-process, however
 * convenient that would be, and a host that cannot offer anything stronger than
 * `in-process-safe` refuses the plan and says why. Convenience is not an
 * argument when the answer is "run it in the same address space anyway".
 *
 * TRUST IS NOT AN INPUT. `trustClass` is carried in the plan as a LABEL for
 * policy, never as an authority: this module never grants a capability because a
 * node is `verified`, and never denies one because it is `community`. The label
 * is excluded even from `planDigest`, so two nodes differing only in trust class
 * compile to the same decision AND the same fingerprint of that decision; a test
 * proves both.
 *
 * WHAT THIS IS NOT (P6.8 scope walls, enforced by tests):
 *   - no capability LEASE and no attenuation (P6.22): this compiles what a node
 *     may have at admission, not what it holds at call time;
 *   - no admission decision, no quarantine (P6.11) and no attestation (P6.12):
 *     a plan is a compiled decision, not an authorization;
 *   - no sandbox, worker, pool or process (P6.24): the locality is a decision
 *     about where code WOULD run;
 *   - no filesystem, no network, no clock, no randomness, no mutation.
 *
 * Authority: compiling a plan grants nothing by itself. It records what the host
 * has agreed to authorize for one node, and refuses to guess when the host has
 * not said.
 */
import { createHash } from 'node:crypto';

import {
  NODE_CAPABILITIES,
  NODE_FAILURE_BOUNDARIES,
  NODE_RUNTIME_LOCALITIES,
  NODE_REGISTRY_SCHEMA_VERSION,
  RUNTIME_LOCALITY_MODEL,
  nodeIdentity,
  validateNodeRegistryDeclaration,
} from './node-registry.mjs';
import {
  NODE_PORTABILITY_CONTRACT,
  PORTABILITY_TARGETS,
  canPort,
  selectRuntime,
  validateNodeDeclaration,
} from './node-portability.mjs';

export const CAPABILITY_COMPILER_CONTRACT = 'node.capability@0.1.0';
export const CAPABILITY_COMPILER_CONTRACT_VERSION = '0.1.0';
export const CAPABILITY_COMPILER_SCHEMA_VERSION = 1;

export const CAPABILITY_COMPILER_OPERATIONS = Object.freeze(['compile', 'explain', 'delegate']);
export const CAPABILITY_COMPILER_PERMISSIONS = Object.freeze(['node:read']);

/** Per-capability verdict. `denied` is fatal; there is no partial grant. */
export const CAPABILITY_DECISIONS = Object.freeze(['granted', 'denied']);

/** Where the portability decision came from. `none` means nothing was delegated. */
export const DELEGATION_SOURCES = Object.freeze(['caller', 'none']);

/** Isolation, weakest to strongest. A boundary must be at least what a capability requires. */
export const FAILURE_BOUNDARY_ORDER = Object.freeze([...NODE_FAILURE_BOUNDARIES]);

/**
 * The minimum isolation each foundation capability demands.
 * `subprocess` and `native` are the two that cannot share an address space with
 * the host: everything else is a data access, they are code execution.
 */
export const CAPABILITY_ISOLATION_REQUIREMENTS = Object.freeze({
  network: 'in-process-safe',
  filesystem: 'in-process-safe',
  secrets: 'in-process-safe',
  env: 'in-process-safe',
  subprocess: 'sandboxed',
  native: 'worker-isolated',
});

/** Which portability class a capability set implies, strongest need wins. */
export const CAPABILITY_CLASS_PRECEDENCE = Object.freeze([
  'PURE', 'ENVIRONMENT_SPECIFIC', 'API', 'NETWORK', 'FILESYSTEM', 'NATIVE_PROCESS',
]);

export const CAPABILITY_COMPILER_REASONS = Object.freeze([
  'capability.declaration',
  'capability.host',
  'capability.unknown',
  'capability.denied',
  'capability.runtime',
  'capability.locality',
  'capability.boundary',
  'capability.delegation',
  'capability.plan',
]);

export const CAPABILITY_COMPILER_RULES = Object.freeze({
  declared: 'a node declares what it NEEDS; the host decides what it GETS — the plan is that decision, written down',
  host: 'a host profile must name its capabilities, its runtimes and the strongest isolation it can offer; a host that cannot say what it is cannot be trusted with the decision',
  closure: 'an unknown capability, runtime or failure boundary is refused: the vocabulary is the foundation manifest, quoted, not extended',
  allOrNothing: 'capabilities are granted in full or the plan is refused — a node running with half its declared capabilities has failure modes nobody wrote down',
  locality: 'runtime selection belongs to node.portability, which this module delegates to and quotes rather than re-implementing',
  delegation: 'a plan either delegated to node.portability and quotes its answer, or states that it did not delegate — a fabricated declaration would make a lie look like a decision',
  bounds: 'capabilities constrain locality: code execution capabilities require isolation, and a host that cannot offer it refuses the plan',
  trust: 'trust is a label for policy, never an authority: this module never grants or denies a capability because of a trust class',
  authority: 'a plan is a compiled decision, not an authorization, and grants nothing by itself',
});

/* ------------------------------------------------------------------ *
 * Errors\n * ------------------------------------------------------------------ */

export class CapabilityCompilerError extends Error {
  constructor(message, meta = {}) {
    super(message);
    this.name = 'CapabilityCompilerError';
    this.code = 'lego.contract_violation';
    this.meta = Object.freeze({ ...meta });
  }
}

const fail = (message, meta) => { throw new CapabilityCompilerError(message, meta); };
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

const boundaryRank = (boundary) => FAILURE_BOUNDARY_ORDER.indexOf(boundary);

/* ------------------------------------------------------------------ *
 * Host profile\n * ------------------------------------------------------------------ */

/**
 * Validate a host profile. Everything is data; nothing is assumed.
 * @returns {Readonly<object>} a frozen, normalized profile
 */
function acceptHostProfile(profile, fn) {
  if (!isPlainObject(profile)) fail(`${fn} expects a host profile from hostProfile()` , { code: 'capability.host', field: 'host' });
  const { hostId, capabilities, runtimes, failureBoundary, environment = {} } = profile;
  if (!isNonEmptyString(hostId)) fail('a host profile must name the host; an anonymous host cannot be held to what it said', { code: 'capability.host', field: 'hostId' });
  if (!Array.isArray(capabilities)) fail('host.capabilities must be an array of foundation capabilities', { code: 'capability.host', field: 'capabilities' });
  for (const capability of capabilities) {
    if (!NODE_CAPABILITIES.includes(capability)) {
      fail(`host declares capability '${capability}', which is not in the foundation vocabulary (${NODE_CAPABILITIES.join(', ')})`, { code: 'capability.unknown', field: 'capabilities' });
    }
  }
  if (!Array.isArray(runtimes)) fail('host.runtimes must be an array of foundation runtimes', { code: 'capability.host', field: 'runtimes' });
  for (const runtime of runtimes) {
    if (!NODE_RUNTIME_LOCALITIES.includes(runtime)) {
      fail(`host declares runtime '${runtime}', which is not in the foundation vocabulary (${NODE_RUNTIME_LOCALITIES.join(', ')})`, { code: 'capability.unknown', field: 'runtimes' });
    }
  }
  if (!NODE_FAILURE_BOUNDARIES.includes(failureBoundary)) {
    fail(`host declares failure boundary ${JSON.stringify(failureBoundary)}; the foundation boundaries are ${NODE_FAILURE_BOUNDARIES.join(', ')}`, { code: 'capability.unknown', field: 'failureBoundary' });
  }
  if (!isPlainObject(environment)) fail('host.environment must be a plain object of primitive values', { code: 'capability.host', field: 'environment' });
  for (const [key, value] of Object.entries(environment)) {
    if (!['string', 'number', 'boolean'].includes(typeof value)) {
      fail(`host.environment['${key}'] must be a primitive`, { code: 'capability.host', field: 'environment' });
    }
  }
  if (runtimes.length === 0) fail('a host with no runtime cannot execute anything; an empty runtime list is a refusal, not a plan', { code: 'capability.runtime', field: 'runtimes' });

  return deepFreeze({
    hostId,
    capabilities: Object.freeze([...new Set(capabilities)].sort()),
    runtimes: Object.freeze([...new Set(runtimes)].sort()),
    failureBoundary,
    environment: Object.freeze(Object.fromEntries(Object.entries(environment).sort())),
  });
}

/**
 * A host profile: what a host can authorize, what it can run, and the STRONGEST
 * isolation it can offer. Validated once, here, and reused everywhere else —
 * `compileCapabilityPlan` and `candidateLocalities` accept nothing weaker.
 */
export function hostProfile(input = {}) {
  return acceptHostProfile(input, 'hostProfile');
}

/* ------------------------------------------------------------------ *
 * Projection + delegation\n * ------------------------------------------------------------------ */

const targetForRuntime = (runtime) => {
  const entry = RUNTIME_LOCALITY_MODEL.find((candidate) => candidate.runtime === runtime);
  return entry ? entry.portabilityTargets[0] : null;
};

/** The strongest isolation a declaration's capabilities demand. */
export function requiredIsolationOf(declaration) {
  return [...declaration.capabilities].reduce(
    (strongest, capability) => {
      const need = CAPABILITY_ISOLATION_REQUIREMENTS[capability] ?? 'in-process-safe';
      return boundaryRank(need) > boundaryRank(strongest) ? need : strongest;
    },
    'in-process-safe',
  );
}

/**
 * The portability class the FOUNDATION capability axis corresponds to, recorded
 * for the reader. This is a classifier over P6.1's six capabilities, not a
 * projected portability declaration — see the header note on the two axes.
 */
export function portabilityClassOf(declaration) {
  const needs = new Set(declaration.capabilities);
  if (declaration.runtimeLocality === 'remote-worker') return 'REMOTE_BRIDGE';
  if (needs.has('native') || needs.has('subprocess')) return 'NATIVE_PROCESS';
  if (needs.has('filesystem')) return 'FILESYSTEM';
  if (needs.has('network')) return 'NETWORK';
  if (needs.has('secrets')) return 'API';
  if (needs.has('env')) return 'ENVIRONMENT_SPECIFIC';
  return 'PURE';
}

/**
 * Decide what to delegate WITH. No projection is fabricated (the capability axes
 * are different vocabularies); the caller may hand in the node's own
 * `node.portability` declaration instead, and this binds it to the same node.
 *
 * @param {object} declaration a P6.1 registry declaration
 * @param {{ portability?: object|null }} [options]
 * @returns {Readonly<{ declaration: object|null, source: string, reason: string|null, nodeId: string, contract: string|null }>}
 */
export function portabilityDeclarationOf(declaration, { portability = null } = {}) {
  const nodeId = nodeIdentity(declaration).split('@')[0];
  if (portability === null || portability === undefined) {
    return deepFreeze({
      declaration: null, source: 'none', reason: 'capability.delegation.none', nodeId, contract: null,
    });
  }
  const accepted = validateNodeDeclaration(portability);
  if (accepted.nodeId !== nodeId) {
    fail(`a portability declaration for '${accepted.nodeId}' cannot be delegated for '${nodeId}': runtime selection is delegated for the node being compiled, not for its neighbour`, { code: 'capability.delegation', field: 'portability' });
  }
  return deepFreeze({
    declaration: accepted, source: 'caller', reason: null, nodeId, contract: accepted.contract,
  });
}

/* ------------------------------------------------------------------ *
 * Compile\n * ------------------------------------------------------------------ */

/**
 * Compile a capability plan for one declaration on one host.
 *
 * @param {{ declaration?: object, host?: object, context?: object, portability?: object|null }} input
 *   `portability` is the node's OWN `node.portability` declaration, when it has
 *   one: supplying it is what makes step 4 a real delegation instead of a note.
 * @returns {Readonly<object>} a frozen plan, or a frozen refusal — never a partial plan
 */
export function compileCapabilityPlan(input = {}) {
  const { declaration, host, context = {}, portability = null } = isPlainObject(input) ? input : {};
  const schemaVersion = CAPABILITY_COMPILER_SCHEMA_VERSION;

  const refusal = (reason, errors) => deepFreeze({
    ok: false, schemaVersion, contract: CAPABILITY_COMPILER_CONTRACT, reason,
    identity: null, granted: Object.freeze([]), denied: Object.freeze([]), locality: null,
    errors: Object.freeze(errors), planDigest: null,
  });

  const validated = validateNodeRegistryDeclaration(declaration);
  if (!validated.ok) {
    return refusal('capability.declaration', validated.errors.map((error) => ({
      ...error, code: 'capability.declaration', message: `declaration is not compilable: ${error.message}`,
    })));
  }
  const profile = acceptHostProfile(host, 'compileCapabilityPlan');

  const identity = nodeIdentity(declaration);

  // 1. Capabilities: granted in full, or the plan does not exist.
  const declared = [...declaration.capabilities].sort();
  const denied = declared.filter((capability) => !profile.capabilities.includes(capability));
  if (denied.length > 0) {
    return refusal('capability.denied', denied.map((capability) => ({
      code: 'capability.denied',
      field: 'capabilities',
      message: `'${identity}' needs '${capability}' and host '${profile.hostId}' does not authorize it; capabilities are granted in full or the plan is refused`,
    })));
  }
  const granted = declared.filter((capability) => profile.capabilities.includes(capability));

  // 2. Runtime selection is the domain's primary contract's job, not ours.
  const resolved = portabilityDeclarationOf(declaration, { portability });
  let selection = null;
  if (resolved.source === 'caller') {
    try {
      selection = selectRuntime(resolved.declaration, { ...context });
    } catch (error) {
      return refusal('capability.delegation', [{
        code: 'capability.delegation',
        message: `node.portability refused the declaration of '${identity}': ${error.message}`,
        detail: error.meta ?? null,
      }]);
    }
    if (!selection.selected) {
      return refusal('capability.runtime', [{
        code: 'capability.runtime',
        message: `node.portability selected no runtime target for '${identity}': ${selection.rejected.map((entry) => entry.reason).join(', ')}`,
        rejected: selection.rejected,
      }]);
    }
  }
  const target = selection ? selection.selected.target : targetForRuntime(declaration.runtimeLocality);
  const portabilityClass = selection ? resolved.declaration.portability.class : portabilityClassOf(declaration);

  const offered = profile.runtimes
    .map((runtime) => ({ runtime, entry: RUNTIME_LOCALITY_MODEL.find((candidate) => candidate.runtime === runtime) }))
    .filter((candidate) => candidate.entry && candidate.entry.portabilityTargets.includes(target));

  if (offered.length === 0) {
    return refusal('capability.runtime', [{
      code: 'capability.runtime',
      message: `no runtime on host '${profile.hostId}' can run '${identity}': the runtime decision is target ${target} and the host offers ${profile.runtimes.join(', ')}`,
      rejected: selection ? selection.rejected : [],
    }]);
  }

  // 3. Capabilities constrain locality: code execution needs isolation.
  const required = requiredIsolationOf(declaration);
  if (boundaryRank(required) > boundaryRank(profile.failureBoundary)) {
    return refusal('capability.boundary', [{
      code: 'capability.boundary',
      message: `'${identity}' needs '${required}' isolation (capabilities: ${declared.join(', ')}) and host '${profile.hostId}' can offer only '${profile.failureBoundary}'; convenience is not an argument when the answer is sharing an address space`,
      required, offered: profile.failureBoundary,
    }]);
  }
  const usable = offered.filter((candidate) => boundaryRank(candidate.entry.failureBoundary) >= boundaryRank(required));
  if (usable.length === 0) {
    return refusal('capability.boundary', [{
      code: 'capability.boundary',
      message: `the runtimes on host '${profile.hostId}' that can run '${identity}' all sit below the '${required}' isolation its capabilities demand (${declared.join(', ')}); an isolation floor is not a preference`,
      required, offered: offered.map((candidate) => candidate.entry.failureBoundary),
    }]);
  }

  // Strongest isolation the host actually offers for this node wins: the plan
  // never trades isolation for locality preference.
  const chosen = [...usable].sort((a, b) =>
    boundaryRank(b.entry.failureBoundary) - boundaryRank(a.entry.failureBoundary)
    || (a.runtime < b.runtime ? -1 : 1))[0];

  const plan = {
    ok: true,
    schemaVersion,
    contract: CAPABILITY_COMPILER_CONTRACT,
    identity,
    type: declaration.type,
    typeVersion: declaration.typeVersion,
    hostId: profile.hostId,
    declared: Object.freeze(declared),
    granted: Object.freeze(granted),
    denied: Object.freeze([]),
    decisions: Object.freeze(Object.fromEntries(declared.map((capability) => [capability, 'granted']))),
    runtime: chosen.runtime,
    locality: chosen.entry.locality,
    failureBoundary: chosen.entry.failureBoundary,
    requiredBoundary: required,
    portabilityTarget: target,
    portabilityClass,
    delegation: Object.freeze({
      contract: NODE_PORTABILITY_CONTRACT,
      performed: selection !== null,
      source: resolved.source,
      reason: resolved.reason,
      declaration: resolved.declaration,
      selected: selection ? selection.selected : null,
      candidates: selection ? selection.candidates : Object.freeze([]),
      rejected: selection ? selection.rejected : Object.freeze([]),
      policy: selection ? selection.policy : null,
    }),
    // A LABEL for policy, never an authority: it does not appear in any decision above.
    trustClass: declaration.trustClass,
    resourceProfile: declaration.resourceProfile,
    errors: Object.freeze([]),
    reason: null,
  };
  // The fingerprint covers the DECISION: the trust label is deliberately outside
  // it, so two nodes that differ only in trust class cannot be told apart by the
  // digest either — there is nothing there to tell apart.
  return deepFreeze({
    ...plan,
    planDigest: digestOf(stableJson({
      ...plan, planDigest: undefined, delegation: undefined, trustClass: undefined,
    })),
  });
}

/** @returns {boolean} whether `value` is a plan this contract produced. */
export function isCapabilityPlan(value) {
  return (
    isPlainObject(value) &&
    value.ok === true &&
    value.contract === CAPABILITY_COMPILER_CONTRACT &&
    value.schemaVersion === CAPABILITY_COMPILER_SCHEMA_VERSION &&
    isNonEmptyString(value.identity) &&
    typeof value.locality === 'string' &&
    typeof value.planDigest === 'string' &&
    Object.isFrozen(value)
  );
}

const requirePlan = (plan, fn) => {
  if (!isCapabilityPlan(plan)) fail(`${fn} expects a plan produced by compileCapabilityPlan`, { got: typeof plan });
};

/* ------------------------------------------------------------------ *
 * Reads\n * ------------------------------------------------------------------ */

/** The whole decision as a sentence a human can check: needs, gets, runs where. */
export function explainCapabilityPlan(plan) {
  requirePlan(plan, 'explainCapabilityPlan');
  const needs = plan.declared.length > 0 ? plan.declared.join(', ') : 'no capabilities';
  const where = plan.delegation.performed
    ? `runtime target ${plan.portabilityTarget} selected by node.portability (class ${plan.portabilityClass})`
    : `runtime target ${plan.portabilityTarget} derived from the runtime locality model, no portability declaration supplied so nothing was delegated (class ${plan.portabilityClass} classified from the capability axis)`;
  return `'${plan.identity}' needs ${needs}; host '${plan.hostId}' grants ${plan.granted.length > 0 ? plan.granted.join(', ') : 'none'}; runs as ${plan.locality} (${plan.runtime}) behind '${plan.failureBoundary}'; ${where}`;
}

/** Machine summary: no delegation graph, safe to store or log. */
export function describeCapabilityPlan(plan) {
  requirePlan(plan, 'describeCapabilityPlan');
  return deepFreeze({
    contract: plan.contract,
    schemaVersion: plan.schemaVersion,
    identity: plan.identity,
    hostId: plan.hostId,
    declared: plan.declared,
    granted: plan.granted,
    locality: plan.locality,
    runtime: plan.runtime,
    failureBoundary: plan.failureBoundary,
    requiredBoundary: plan.requiredBoundary,
    portabilityTarget: plan.portabilityTarget,
    portabilityClass: plan.portabilityClass,
    delegated: plan.delegation.performed,
    delegationSource: plan.delegation.source,
    delegationReason: plan.delegation.reason,
    trustClass: plan.trustClass,
    planDigest: plan.planDigest,
  });
}

/** The same decision, recompiled: two hosts agree, or they do not. */
export function verifyCapabilityPlan(plan, { declaration, host, context, portability } = {}) {
  requirePlan(plan, 'verifyCapabilityPlan');
  const recompiled = compileCapabilityPlan({ declaration, host, context, portability });
  if (!recompiled.ok) {
    return deepFreeze({ ok: false, reason: 'capability.plan', expected: plan.planDigest, actual: null, message: `recompiling refused the plan: ${recompiled.reason}` });
  }
  if (recompiled.planDigest !== plan.planDigest) {
    return deepFreeze({
      ok: false, reason: 'capability.plan', expected: plan.planDigest, actual: recompiled.planDigest,
      message: 'the recompiled plan differs from the plan presented; the same declaration and host must compile to the same decision',
    });
  }
  return deepFreeze({ ok: true, reason: null, expected: plan.planDigest, actual: recompiled.planDigest, message: null });
}

/** Which of the host's runtimes could run this node, strongest isolation first. */
export function candidateLocalities(declaration, host) {
  const validated = validateNodeRegistryDeclaration(declaration);
  if (!validated.ok) fail('candidateLocalities expects a valid registry declaration', { code: 'capability.declaration' });
  const profile = acceptHostProfile(host, 'candidateLocalities');
  const required = declaration.capabilities.reduce(
    (strongest, capability) => (boundaryRank(CAPABILITY_ISOLATION_REQUIREMENTS[capability]) > boundaryRank(strongest) ? CAPABILITY_ISOLATION_REQUIREMENTS[capability] : strongest),
    'in-process-safe',
  );
  const hostRank = boundaryRank(profile.failureBoundary);
  return deepFreeze(profile.runtimes
    .map((runtime) => ({ runtime, entry: RUNTIME_LOCALITY_MODEL.find((candidate) => candidate.runtime === runtime) }))
    .filter((candidate) => candidate.entry)
    .filter((candidate) => boundaryRank(candidate.entry.failureBoundary) <= hostRank)
    .filter((candidate) => boundaryRank(candidate.entry.failureBoundary) >= boundaryRank(required))
    .sort((a, b) => boundaryRank(b.entry.failureBoundary) - boundaryRank(a.entry.failureBoundary) || (a.runtime < b.runtime ? -1 : 1))
    .map((candidate) => ({ runtime: candidate.runtime, locality: candidate.entry.locality, failureBoundary: candidate.entry.failureBoundary })));
}

/**
 * `canPort` is the domain's; this asks it about the declaration the plan
 * actually delegated with. When the plan performed no delegation there is no
 * declaration to ask about, so the read says so instead of guessing.
 */
export function canPortPlan(plan, target) {
  requirePlan(plan, 'canPortPlan');
  if (!PORTABILITY_TARGETS.includes(target)) {
    fail(`'${target}' is not a portability target; targets are ${PORTABILITY_TARGETS.join(', ')}`, { code: 'capability.runtime', field: 'target' });
  }
  if (!plan.delegation.performed) {
    return deepFreeze({
      ok: false, target, source: plan.delegation.source, reason: 'capability.delegation.none',
      portable: null, overall: null, matrixStatus: null,
    });
  }
  const answer = canPort(plan.delegation.declaration, target);
  return deepFreeze({
    ok: true, target, source: plan.delegation.source, reason: answer.reason ?? null,
    portable: answer.portable, overall: answer.overall, matrixStatus: answer.matrixStatus,
  });
}

/** The foundation's own selection policy, quoted so a reviewer can check the ordering. */
export function capabilitySelectionPolicy() {
  return deepFreeze([...PORTABILITY_TARGETS]);
}

export const CAPABILITY_COMPILER_INPUT_SCHEMA_VERSION = NODE_REGISTRY_SCHEMA_VERSION;
