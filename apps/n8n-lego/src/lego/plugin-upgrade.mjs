/**
 * P2.27.9 — side-by-side upgrade + rollback + supply-chain admission.
 *
 * Issue #83's two remaining security gates, composed from modules that already
 * exist — this file adds ordering and state, never a second implementation:
 *
 * - Supply-chain admission (fail-closed, exact order):
 *   signature → digest → provenance → contract → capabilities →
 *   resource policy → health → activate.
 *   Unverified plugins are never admitted: a missing verifier is a denial,
 *   not a skipped check. `activate` is the final step and only completes
 *   when the upgrade machine reaches ACTIVATED.
 * - Side-by-side upgrade track (#83):
 *   old version → new version → validate → health → contract test →
 *   activate → drain old → stop old, with rollback available from every
 *   state where the old version is still resident. Rollback swaps the
 *   serving pointer back to `fromVersion`; callers bind to the plugin id,
 *   so no workflow rewrite is ever required.
 *
 * Composition, not duplication: contract = `validateManifest` + `planUpgrade`
 * (P2.7 compatibility: downgrade never automatic, breaking needs recorded
 * sign-off, migration points and consumer blocks are enforced);
 * capabilities = `evaluateManifestPolicy` (deny-by-default);
 * resource policy = `createResourceBudget` (bounded declared limits);
 * contract test = a `replayFixture` report with `interchangeable === true`;
 * events stay inside the `.1` vocabulary (`PLUGIN_EVENT_TYPES`).
 */
import { PluginRuntimeError } from './plugin-runtime.mjs';
import { validateManifest } from './plugin-manifest.mjs';
import { evaluateManifestPolicy } from './plugin-policy.mjs';
import { createResourceBudget } from './plugin-resources.mjs';
import { planUpgrade } from './compat.mjs';

const violation = (message, details) =>
  new PluginRuntimeError('lego.contract_violation', message, { details });
const denied = (message, details) =>
  new PluginRuntimeError('lego.access_denied', message, { details });

/**
 * The admission pipeline in the exact order Issue #83 declares. `activate` is
 * part of the pipeline and is satisfied only by the upgrade machine reaching
 * ACTIVATED — a staged artifact that never activates never completes it.
 */
export const SUPPLY_CHAIN_STEPS = Object.freeze([
  'signature',
  'digest',
  'provenance',
  'contract',
  'capabilities',
  'resourcePolicy',
  'health',
  'activate',
]);

/**
 * The side-by-side upgrade track. STAGED = new version loaded next to the
 * old one; ACTIVATED = new version serving and old version draining;
 * STOPPED = old version stopped and the upgrade complete. ROLLED_BACK is a
 * one-way door for this attempt.
 */
export const UPGRADE_STATES = Object.freeze([
  'STAGED',
  'VALIDATED',
  'HEALTHY',
  'CONTRACT_TESTED',
  'ACTIVATED',
  'DRAINED',
  'STOPPED',
  'ROLLED_BACK',
]);

/** Exact transition table: forward along #83's sequence + rollback everywhere the old version is resident. */
export const UPGRADE_TRANSITIONS = Object.freeze({
  STAGED: Object.freeze(['VALIDATED', 'ROLLED_BACK']),
  VALIDATED: Object.freeze(['HEALTHY', 'ROLLED_BACK']),
  HEALTHY: Object.freeze(['CONTRACT_TESTED', 'ROLLED_BACK']),
  CONTRACT_TESTED: Object.freeze(['ACTIVATED', 'ROLLED_BACK']),
  ACTIVATED: Object.freeze(['DRAINED', 'ROLLED_BACK']),
  DRAINED: Object.freeze(['STOPPED', 'ROLLED_BACK']),
  STOPPED: Object.freeze([]),
  ROLLED_BACK: Object.freeze([]),
});

/**
 * Pure predicate — unknown states and illegal edges are simply `false`.
 *
 * @param {string} from
 * @param {string} to
 * @returns {boolean}
 */
export function canUpgradeTransition(from, to) {
  const allowed = UPGRADE_TRANSITIONS[from];
  return Array.isArray(allowed) && allowed.includes(to);
}

function freezePlan(plan) {
  return Object.freeze({
    ...plan,
    consumers: Object.freeze(plan.consumers.map((entry) => Object.freeze({ ...entry }))),
    steps: Object.freeze(plan.steps.map((entry) => Object.freeze({ ...entry }))),
    blockedBy: Object.freeze([...plan.blockedBy]),
  });
}

/**
 * Run the supply-chain admission pipeline (steps `signature` … `health`).
 * Fail-closed at every step: the first denial throws and nothing is
 * admitted. `activate` is reported as `nextStep` — only the upgrade
 * coordinator can complete it.
 *
 * Evidence for `signature`/`digest`/`provenance`/`health` must be supplied
 * by the caller as `true`/`false` or a synchronous verifier function; a
 * missing entry is "unverified" and is denied, never skipped. The
 * `contract`, `capabilities` and `resourcePolicy` steps always run from
 * existing modules — they are not overridable.
 *
 * @param {object} request
 * @param {string} request.pluginId
 * @param {string} request.fromVersion — version currently serving
 * @param {string} request.toVersion — staged candidate version
 * @param {object} request.manifest — the candidate's declared manifest
 * @param {{signature?: unknown, digest?: unknown, provenance?: unknown, health?: unknown}} [request.evidence]
 * @param {string[]} [request.grants] — capability grants for the `capabilities` step
 * @param {string[]} [request.migrations] — declared migration points (compat contract)
 * @param {Array<{id: string, requires: string}>} [request.consumers]
 * @param {boolean} [request.signedOff] — recorded operator sign-off for a breaking change
 * @param {boolean} [request.migrationApplied] — confirmation that the crossed migration ran
 * @param {() => number} [request.now]
 * @returns {Readonly<object>} frozen admission record (7 passed steps, plan, nextStep: 'activate')
 */
export function runSupplyChainAdmission({
  pluginId,
  fromVersion,
  toVersion,
  manifest,
  evidence = {},
  grants = [],
  migrations = [],
  consumers = [],
  signedOff = false,
  migrationApplied = false,
  now = Date.now,
} = {}) {
  if (typeof pluginId !== 'string' || pluginId.length === 0) {
    throw violation('admission requires a pluginId', { pluginId });
  }
  if (typeof fromVersion !== 'string' || typeof toVersion !== 'string' || fromVersion.length === 0 || toVersion.length === 0) {
    throw violation('admission requires fromVersion and toVersion strings', { fromVersion, toVersion });
  }
  if (fromVersion === toVersion) {
    throw violation('fromVersion and toVersion must differ — a side-by-side upgrade of identical versions is meaningless', {
      fromVersion,
      toVersion,
    });
  }
  if (evidence === null || typeof evidence !== 'object' || Array.isArray(evidence)) {
    throw violation('evidence must be an object of per-step verifiers', { evidence: typeof evidence });
  }

  const candidate = Object.freeze({ pluginId, fromVersion, toVersion, manifest });
  const steps = [];

  const verifyTrustStep = (step) => {
    if (!(step in evidence)) {
      throw denied(`supply-chain step '${step}' is unverified — no evidence supplied; unverified plugins are not admitted`, {
        pluginId,
        step,
      });
    }
    const raw = evidence[step];
    const value = typeof raw === 'function' ? raw(candidate) : raw;
    if (!value) {
      throw denied(`supply-chain step '${step}' verification failed`, { pluginId, step });
    }
    steps.push(Object.freeze({ step, status: 'pass', at: now() }));
  };

  // 1–3: artifact trust chain, in declared order.
  verifyTrustStep('signature');
  verifyTrustStep('digest');
  verifyTrustStep('provenance');

  // 4: contract — manifest schema + side-by-side version plan (P2.7).
  const validated = validateManifest(manifest);
  if (validated.version !== toVersion) {
    throw violation('toVersion must equal the staged manifest version', { toVersion, manifestVersion: validated.version });
  }
  let plan;
  try {
    plan = planUpgrade({
      id: validated.contract.id,
      from: fromVersion,
      to: validated.version,
      migrations,
      consumers,
    });
  } catch (error) {
    throw violation('fromVersion and toVersion must be major.minor.patch versions', {
      fromVersion,
      toVersion,
      cause: String(error?.message ?? error),
    });
  }
  if (plan.change === 'downgrade') {
    throw new PluginRuntimeError('lego.version_incompatible', plan.reason, {
      details: { pluginId, fromVersion, toVersion, change: plan.change },
    });
  }
  if (plan.requiresMigration && migrationApplied !== true) {
    throw new PluginRuntimeError('lego.migration_required', plan.reason, {
      details: { pluginId, fromVersion, toVersion, change: plan.change },
    });
  }
  if (!plan.safeToActivate) {
    throw new PluginRuntimeError('lego.version_incompatible', `upgrade blocked by consumer(s): ${plan.blockedBy.join(', ')}`, {
      details: { pluginId, blockedBy: [...plan.blockedBy] },
    });
  }
  const acked = signedOff === true || (migrationApplied === true && plan.requiresMigration);
  if (plan.requiresSignOff && !acked) {
    throw new PluginRuntimeError('lego.version_incompatible', `${plan.reason} — a breaking change requires recorded sign-off (signedOff: true)`, {
      details: { pluginId, fromVersion, toVersion, change: plan.change },
    });
  }
  steps.push(Object.freeze({ step: 'contract', status: 'pass', at: now() }));

  // 5: capabilities — deny-by-default evaluation against the declared grants.
  const verdict = evaluateManifestPolicy(validated, { grants });
  if (verdict.denied.length > 0) {
    throw denied('capability grant denied by policy', {
      pluginId,
      denied: verdict.denied.map((entry) => entry.capability),
      reasons: verdict.denied.map((entry) => entry.reason),
    });
  }
  steps.push(Object.freeze({ step: 'capabilities', status: 'pass', at: now() }));

  // 6: resource policy — a bounded declared budget must be instantiable.
  createResourceBudget({ pluginId, limits: validated.resourceLimits, now });
  steps.push(Object.freeze({ step: 'resourcePolicy', status: 'pass', at: now() }));

  // 7: health — runtime evidence, injected; never invented here.
  if (!('health' in evidence)) {
    throw denied('supply-chain step \'health\' is unverified — no health evidence supplied', { pluginId, step: 'health' });
  }
  const healthRaw = evidence.health;
  const health = typeof healthRaw === 'function' ? healthRaw(candidate) : healthRaw;
  if (!health) {
    throw new PluginRuntimeError('lego.dependency_disabled', 'staged candidate is not HEALTHY — admission stops before activate', {
      details: { pluginId, toVersion },
    });
  }
  steps.push(Object.freeze({ step: 'health', status: 'pass', at: now() }));

  return Object.freeze({
    pluginId,
    fromVersion,
    toVersion,
    steps: Object.freeze(steps),
    plan,
    nextStep: 'activate',
    activated: false,
  });
}

/**
 * Stateful side-by-side upgrade attempt: stage (runs admission) → advance
 * through the machine → activate flips the serving pointer → drain → stop
 * old. Rollback is legal from every state where `fromVersion` is still
 * resident and restores it as the serving version.
 *
 * Events (`.1` vocabulary only): `plugin.activated` when the new version
 * starts serving, `plugin.deactivated` + `plugin.upgraded` when the old
 * version is stopped (upgrade complete), `plugin.rolled-back` on rollback.
 *
 * @param {{pluginId: string, fromVersion: string, toVersion: string, now?: () => number, onEvent?: ((type: string, detail: object) => void) | null}} options
 */
export function createUpgradeCoordinator({ pluginId, fromVersion, toVersion, now = Date.now, onEvent = null } = {}) {
  if (typeof pluginId !== 'string' || pluginId.length === 0) {
    throw violation('createUpgradeCoordinator requires a pluginId', { pluginId });
  }
  if (typeof fromVersion !== 'string' || typeof toVersion !== 'string' || fromVersion.length === 0 || toVersion.length === 0) {
    throw violation('createUpgradeCoordinator requires fromVersion and toVersion strings', { fromVersion, toVersion });
  }
  if (fromVersion === toVersion) {
    throw violation('fromVersion and toVersion must differ', { fromVersion, toVersion });
  }
  if (onEvent !== null && typeof onEvent !== 'function') {
    throw new TypeError('onEvent must be a function or null');
  }

  const emit = (type, detail) => {
    if (onEvent) onEvent(type, detail);
  };

  /** @type {null | string} */
  let state = null;
  /** @type {'none' | 'from' | 'to'} */
  let serving = 'none';
  /** @type {null | object} */
  let admission = null;
  /** 'pending' | 'pass' | 'rolled-back' */
  let activateStatus = 'pending';
  /** @type {number | null} */
  let activatedAt = null;
  const history = [];

  const record = (from, to, reason) => {
    const entry = { at: now(), from, to };
    if (reason !== undefined) entry.reason = reason;
    history.push(Object.freeze(entry));
  };

  const api = Object.freeze({
    stage(request = {}) {
      if (state !== null) {
        throw violation('an upgrade attempt is already staged on this coordinator', { state });
      }
      const { manifest, evidence, grants, migrations, consumers, signedOff, migrationApplied } = request;
      admission = runSupplyChainAdmission({
        pluginId,
        fromVersion,
        toVersion,
        manifest,
        evidence,
        grants,
        migrations,
        consumers,
        signedOff,
        migrationApplied,
        now,
      });
      state = 'STAGED';
      serving = 'from';
      activateStatus = 'pending';
      record(null, 'STAGED');
      return state;
    },

    advance(to, options = {}) {
      if (state === null) {
        throw violation('no upgrade attempt is staged — stage() runs admission first', { pluginId });
      }
      if (!canUpgradeTransition(state, to)) {
        throw violation(`illegal upgrade transition '${state}' → '${to}'`, { from: state, to });
      }
      if (to === 'CONTRACT_TESTED') {
        const report = options.replay;
        if (report === undefined || report === null || typeof report !== 'object') {
          throw violation('CONTRACT_TESTED requires a replayFixture report — the contract test is not optional', {
            pluginId,
          });
        }
        if (report.interchangeable !== true) {
          throw violation('contract test failed — the replay report is not interchangeable', {
            pluginId,
            mismatches: Array.isArray(report.mismatches) ? report.mismatches.length : null,
          });
        }
      }
      const from = state;
      if (to === 'ACTIVATED') {
        activateStatus = 'pass';
        activatedAt = now();
        serving = 'to';
        record(from, to);
        state = to;
        emit('plugin.activated', { id: pluginId, version: toVersion, reason: 'upgrade' });
        return state;
      }
      if (to === 'STOPPED') {
        record(from, to);
        state = to;
        emit('plugin.deactivated', { id: pluginId, version: fromVersion, reason: 'upgraded' });
        emit('plugin.upgraded', { id: pluginId, from: fromVersion, to: toVersion });
        return state;
      }
      record(from, to);
      state = to;
      return state;
    },

    rollback(request = {}) {
      if (state === null) {
        throw violation('no upgrade attempt is staged — nothing to roll back', { pluginId });
      }
      if (!canUpgradeTransition(state, 'ROLLED_BACK')) {
        throw violation(
          'old version is stopped and no longer resident — stage a new upgrade attempt; callers bind the plugin id, so workflows need no rewrite',
          { state }
        );
      }
      const reason = typeof request.reason === 'string' && request.reason.length > 0 ? request.reason : 'operator_rollback';
      const wasActivated = activateStatus === 'pass';
      const from = state;
      record(from, 'ROLLED_BACK', reason);
      state = 'ROLLED_BACK';
      serving = 'from';
      activateStatus = 'rolled-back';
      emit('plugin.rolled-back', { id: pluginId, from: fromVersion, to: toVersion, reason, wasActivated });
      return state;
    },

    state: () => state,
    serving: () => serving,
    history: () => Object.freeze([...history]),
    admission: () => {
      if (admission === null) return null;
      return Object.freeze({
        ...admission,
        steps: Object.freeze([
          ...admission.steps,
          Object.freeze({ step: 'activate', status: activateStatus, at: activatedAt }),
        ]),
        nextStep: activateStatus === 'pass' ? null : 'activate',
        activated: activateStatus === 'pass',
      });
    },
  });

  return api;
}
