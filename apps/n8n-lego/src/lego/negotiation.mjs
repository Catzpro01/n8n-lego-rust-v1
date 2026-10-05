/**
 * Backend LEGO foundation — capability negotiation and lifecycle.
 *
 * PUBLIC CONTRACT (`lego.negotiation`, v1.0.0, owner: agent-2).
 *
 * A consumer must be able to ask, before it commits to a call: does this
 * capability exist, does it speak a version I understand, which operations does
 * it offer, is it actually usable right now, and if not — what exactly is wrong?
 *
 * TWO RULES SHAPE THIS MODULE.
 *
 * 1. **Nesting never grants access.** `reference-lego.validation` living inside
 *    `reference-lego` gives a third party no right to call it. Composition is a
 *    parent's private business; access is always an explicit declaration. This
 *    is enforced here as well as in the import gate, because the import gate
 *    only sees static imports — negotiation is where a *dynamic* lookup would
 *    otherwise sneak past.
 *
 * 2. **Negotiation reads the existing registry.** It does not keep its own copy
 *    of who owns what. A second registry would drift, and the whole foundation
 *    is built on there being exactly one.
 */
import { satisfies } from './compat.mjs';
import { getProvider } from './interaction.mjs';
import { getAncestors, getDomain, isDependencyAllowed, listCapabilities, loadRegistry } from './registry.mjs';

/**
 * Lifecycle states (§10).
 *
 * The contract model is deliberately richer than any runtime will implement:
 * `declared` (in the manifest) through `deprecated` (still callable, scheduled
 * for removal). A runtime that only ever reports three of these is fine; what
 * matters is that a state a LEGO *can* be in has a name, so "it is broken" and
 * "it is switched off" are never the same signal.
 */
export const LIFECYCLE_STATES = Object.freeze({
  declared: { runtime: false, callable: false, summary: 'exists in the manifest; no implementation registered' },
  available: { runtime: false, callable: false, summary: 'an implementation exists and could be loaded' },
  installed: { runtime: false, callable: false, summary: 'present on disk, not yet loaded into the process' },
  loaded: { runtime: true, callable: false, summary: 'in memory, not yet accepting calls' },
  active: { runtime: true, callable: true, summary: 'accepting calls' },
  idle: { runtime: true, callable: true, summary: 'loaded and callable but doing nothing; may be unloaded' },
  degraded: { runtime: true, callable: true, summary: 'callable with reduced guarantees it must declare' },
  disabled: { runtime: true, callable: false, summary: 'switched off deliberately' },
  failed: { runtime: true, callable: false, summary: 'switched off by a failure' },
  unloaded: { runtime: false, callable: false, summary: 'released from memory; returns to available' },
  deprecated: { runtime: true, callable: true, summary: 'callable but scheduled for removal' },
});

/**
 * Legal transitions. Everything else is rejected — an unenforced state machine
 * is just a diagram.
 */
export const LIFECYCLE_TRANSITIONS = Object.freeze({
  declared: ['available', 'disabled'],
  available: ['installed', 'loaded', 'disabled'],
  installed: ['loaded', 'disabled', 'unloaded'],
  loaded: ['active', 'failed', 'unloaded', 'disabled'],
  active: ['idle', 'degraded', 'disabled', 'failed', 'deprecated', 'unloaded'],
  idle: ['active', 'unloaded', 'disabled', 'failed'],
  degraded: ['active', 'failed', 'disabled', 'unloaded'],
  disabled: ['available', 'unloaded'],
  failed: ['disabled', 'unloaded', 'available'],
  unloaded: ['available', 'installed'],
  deprecated: ['active', 'disabled', 'unloaded'],
});

export function canTransitionLifecycle(from, to) {
  if (!(from in LIFECYCLE_STATES)) return { allowed: false, reason: `unknown lifecycle state '${from}'` };
  if (!(to in LIFECYCLE_STATES)) return { allowed: false, reason: `unknown lifecycle state '${to}'` };
  const allowed = LIFECYCLE_TRANSITIONS[from];
  return allowed.includes(to)
    ? { allowed: true, reason: `${from} -> ${to}` }
    : { allowed: false, reason: `${from} -> ${to} is not legal (allowed from '${from}': ${allowed.join(', ')})` };
}

/** Is a LEGO in this state callable? Used to turn lifecycle into a degradation state. */
export function isCallable(state) {
  return LIFECYCLE_STATES[state]?.callable === true;
}

/**
 * Runtime lifecycle state, kept separate from the manifest.
 * The manifest says what *should* exist; this says what is true right now.
 */
const runtimeStates = new Map();

export function setLifecycleState(legoId, to, { force = false } = {}) {
  const from = runtimeStates.get(legoId) ?? 'declared';
  if (!force) {
    const verdict = canTransitionLifecycle(from, to);
    if (!verdict.allowed) throw new Error(`illegal lifecycle transition for '${legoId}': ${verdict.reason}`);
  }
  runtimeStates.set(legoId, to);
  return { legoId, from, to };
}

export function getLifecycleState(legoId) {
  return runtimeStates.get(legoId) ?? 'declared';
}

export function resetLifecycleStates() {
  runtimeStates.clear();
}

/**
 * Everything a consumer needs to decide whether it can call something.
 *
 * @returns {{
 *   capability: string, found: boolean, domain: string|null, owner: string|null,
 *   contractVersion: string|null, operations: string[], optional: string[],
 *   lifecycle: string, callable: boolean, degradation: string,
 *   implementation: string|null, transport: string|null, trust: string|null
 * }}
 */
export function describeCapability(capabilityId, registry = loadRegistry()) {
  const entry = listCapabilities(registry).find((candidate) => candidate.id === capabilityId);
  if (!entry) {
    return {
      capability: capabilityId,
      found: false,
      domain: null,
      owner: null,
      contractVersion: null,
      operations: [],
      optional: [],
      lifecycle: 'declared',
      callable: false,
      degradation: 'capability-unavailable',
      implementation: null,
      transport: null,
      trust: null,
    };
  }

  const domain = getDomain(entry.domain, registry);
  const provider = getProvider(entry.domain);
  const lifecycle = getLifecycleState(entry.domain);
  const callable = provider !== null && isCallable(lifecycle);

  return {
    capability: capabilityId,
    found: true,
    domain: entry.domain,
    owner: entry.owner,
    status: entry.status,
    contractVersion: provider?.contractVersion ?? entry.contractVersion,
    operations: provider ? Object.keys(provider.operations) : [],
    optional: domain?.optionalCapabilities ?? [],
    lifecycle,
    callable,
    degradation: callable ? 'available' : provider === null ? 'capability-unavailable' : lifecycleDegradation(lifecycle),
    implementation: provider?.implementation ?? null,
    transport: provider?.transport ?? null,
    trust: domain?.trust ?? null,
  };
}

function lifecycleDegradation(state) {
  if (state === 'disabled') return 'dependency-disabled';
  if (state === 'failed') return 'capability-unavailable';
  if (state === 'degraded') return 'degraded';
  return 'capability-unavailable';
}

/**
 * The full negotiation: may this consumer call this capability, at a version it
 * understands, right now?
 *
 * Checks in order — access, existence, version, liveness — because the answers
 * are differently actionable. "You are not allowed" is an architecture bug in
 * the caller; "it is disabled" is an operational state; "wrong version" is a
 * migration. Collapsing them into one boolean would throw away the only useful
 * information.
 *
 * @param {{ consumer: string, capability: string, requires?: string, operations?: string[] }} request
 */
export function negotiate(request, registry = loadRegistry()) {
  const { consumer, capability, requires = '*', operations = [] } = request;
  const description = describeCapability(capability, registry);

  const deny = (code, reason, extra = {}) => ({
    ok: false,
    code,
    reason,
    capability,
    consumer,
    ...extra,
    description,
  });

  if (!description.found) {
    return deny('lego.capability_unavailable', `no capability '${capability}' is declared by any LEGO`);
  }

  // Access first: a consumer with no declared dependency must not learn whether
  // the capability is healthy, let alone call it.
  if (consumer && consumer !== description.domain) {
    const access = isDependencyAllowed(consumer, description.domain, registry);
    if (!access.allowed) {
      return deny('lego.access_denied', `'${consumer}' may not use '${description.domain}': ${access.reason}`, { access });
    }

    // Nesting grants nothing. Reaching a descendant of another LEGO requires a
    // declaration naming that descendant — being inside an allowed parent is
    // not enough.
    const ancestors = getAncestors(description.domain, registry).map((ancestor) => ancestor.id);
    if (ancestors.length > 0 && !ancestors.includes(consumer)) {
      const consumerDomain = getDomain(consumer, registry);
      const declared = consumerDomain?.dependsOn?.includes(description.domain) ?? false;
      if (!declared) {
        return deny(
          'lego.access_denied',
          `'${description.domain}' is nested inside ${ancestors.join(' -> ')}; nesting does not grant access — '${consumer}' must declare it explicitly`,
          { nested: true, ancestors },
        );
      }
    }
  }

  if (description.contractVersion && requires !== '*') {
    const version = satisfies(description.contractVersion, requires);
    if (!version.satisfied) {
      return deny('lego.version_incompatible', version.reason, { required: requires, actual: description.contractVersion });
    }
  }

  const missing = operations.filter((operation) => !description.operations.includes(operation));
  if (missing.length > 0) {
    return deny('lego.operation_unsupported', `'${description.domain}' does not implement: ${missing.join(', ')}`, { missing });
  }

  if (!description.callable) {
    return deny(
      description.degradation === 'dependency-disabled' ? 'lego.dependency_disabled' : 'lego.capability_unavailable',
      `'${description.domain}' is '${description.lifecycle}' and not accepting calls`,
      { lifecycle: description.lifecycle },
    );
  }

  return {
    ok: true,
    capability,
    consumer,
    contractVersion: description.contractVersion,
    operations: description.operations,
    implementation: description.implementation,
    transport: description.transport,
    lifecycle: description.lifecycle,
    description,
  };
}

/** Everything a consumer is allowed to see, for discovery UIs and AI agents. */
export function discoverFor(consumer, registry = loadRegistry()) {
  return listCapabilities(registry)
    .map((entry) => negotiate({ consumer, capability: entry.id }, registry))
    .filter((result) => result.ok || result.code !== 'lego.access_denied')
    .map((result) => ({
      capability: result.capability,
      usable: result.ok === true,
      reason: result.ok ? null : result.reason,
      domain: result.description.domain,
      owner: result.description.owner,
      contractVersion: result.description.contractVersion,
      lifecycle: result.description.lifecycle,
    }));
}
