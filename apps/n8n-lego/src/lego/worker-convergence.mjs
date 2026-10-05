/**
 * Worker registry convergence + handshake — P6.14.
 *
 * PUBLIC CONTRACT (`node.worker-convergence@0.1.0`, domain `node-registry`).
 *
 * A worker that is behind is a fact. A worker that is WRONG is a different fact,
 * and a registry that cannot tell them apart has two options, both bad: bring
 * everything forward blindly (a divergent worker gets "fixed" into silence) or
 * refuse everything (a worker that only needs an epoch gets treated as a threat).
 *
 * So the handshake has four answers and no fifth:
 *
 *   MATCH               the worker holds exactly this epoch: nothing to do
 *   UPGRADE_REQUIRED    the worker is BEHIND and CONSISTENT: it holds a subset of
 *                       this epoch's identities, with matching digests, under a
 *                       lower epoch number. It can be brought forward.
 *   MISMATCH            the worker holds something this registry does not: a node
 *                       the epoch does not contain, a digest that disagrees for a
 *                       node the epoch does contain, or a HIGHER epoch number than
 *                       the coordinator. It must not be brought forward
 *                       automatically, because the difference may be evidence.
 *   UNAVAILABLE         the coordinator has nothing to converge TO (an epoch that
 *                       is not serving). The worker must not serve, and the reason
 *                       is that the target is missing — not that the worker is bad.
 *
 * THE MISMATCH RULE IS THE POINT. "Behind" is a position; "divergent" is a claim
 * about the same node that disagrees. The first is a scheduling problem and the
 * second is a supply-chain or correctness problem, and collapsing them means the
 * dangerous one gets the treatment of the harmless one.
 *
 * A HIGHER EPOCH NUMBER IS NOT AN UPGRADE. If a worker reports epoch 9 and the
 * coordinator serves epoch 7, the honest answer is MISMATCH: something ahead of the
 * source of truth exists, and quietly moving backwards to "converge" it would
 * rewrite a worker's history without asking why it was ahead.
 *
 * CONVERGENCE IS A PLAN, NOT A TRANSPORT. The decision carries ordered steps
 * (`request-runtime-view`, `apply-registry-changes`, `reverify-views`, …) and the
 * contract stops there: who ships the bytes, over which link, is a runtime
 * concern. That is what keeps this testable and what keeps "the message is data"
 * true.
 *
 * WHAT THIS IS NOT (P6.14 scope walls, enforced by tests):
 *   - it does not compile or publish an epoch (P6.2/P6.13) and does not send
 *     anything: no network, no queue, no socket;
 *   - it does not lease runtimes (P6.6), load implementations (P6.7), decide
 *     capabilities (P6.8) or health (P6.11): a converged worker is a worker
 *     holding the right bytes, not a worker that is allowed to run them;
 *   - it does not pool workers (P6.24) and does not repair a diverged one (P6.30):
 *     a MISMATCH is escalated, never silently resolved;
 *   - no clock, no randomness, no mutation: a handshake is a function of two
 *     bindings.
 *
 * Authority: a MATCH is permission to skip work, never permission to serve. The
 * decision about whether work may run belongs to capability, health and lease.
 */
import { createHash } from 'node:crypto';

import { isFrozenRegistryEpoch } from './registry-compiler.mjs';
import { projectEpochView } from './incremental-registry.mjs';

export const WORKER_CONVERGENCE_CONTRACT = 'node.worker-convergence@0.1.0';
export const WORKER_CONVERGENCE_CONTRACT_VERSION = '0.1.0';
export const WORKER_CONVERGENCE_SCHEMA_VERSION = 1;

export const WORKER_CONVERGENCE_OPERATIONS = Object.freeze(['bind', 'handshake', 'converge', 'describe']);
export const WORKER_CONVERGENCE_PERMISSIONS = Object.freeze(['node:read']);

/** The four answers. `UPGRADE_REQUIRED` is the only one that moves a worker forward. */
export const CONVERGENCE_DECISIONS = Object.freeze(['MATCH', 'UPGRADE_REQUIRED', 'MISMATCH', 'UNAVAILABLE']);

/** Ordered steps a worker or coordinator performs. Data, never transport. */
export const CONVERGENCE_STEPS = Object.freeze([
  'request-runtime-view',
  'request-full-epoch',
  'apply-registry-changes',
  'reverify-views',
  'refuse-service',
  'escalate-to-operator',
  'retry-when-serving',
]);

export const WORKER_CONVERGENCE_REASONS = Object.freeze([
  'convergence.input',
  'convergence.binding',
  'convergence.epoch',
  'convergence.behind',
  'convergence.divergence',
  'convergence.ahead',
  'convergence.unavailable',
  'convergence.unknown_identity',
]);

export const WORKER_CONVERGENCE_RULES = Object.freeze({
  behind: '"behind" is a position and "divergent" is a claim that disagrees: the first is a scheduling problem, the second is a correctness or supply-chain problem, and collapsing them gives the dangerous one the treatment of the harmless one',
  ahead: 'a worker reporting a HIGHER epoch than the coordinator is MISMATCH, not an upgrade: something ahead of the source of truth exists, and moving backwards to "converge" it would rewrite a history without asking why',
  subset: 'an upgrade requires the worker to hold a SUBSET with matching digests: a worker with a single disagreement is divergent, however far behind it also happens to be',
  view: 'a MATCH requires the epoch AND the reported runtime view to agree: a worker that cannot state its view digest cannot be keyed by a pool or a compiled cache, and "no view reported" is a question rather than an agreement',
  plan: 'convergence is a plan, not a transport: the decision carries ordered steps and the contract stops there, which is what keeps the message data and the handshake testable',
  unavailable: 'UNAVAILABLE means the coordinator has nothing to converge TO: the worker is refused because the target is missing, not because the worker is suspect',
  authority: 'a MATCH is permission to skip work, never permission to serve: capability, health and lease decide whether anything runs',
});

/* ------------------------------------------------------------------ *
 * Errors
 * ------------------------------------------------------------------ */

/** Raised for API misuse. A refusal to converge is returned as data. */
export class WorkerConvergenceError extends Error {
  constructor(message, meta = {}) {
    super(message);
    this.name = 'WorkerConvergenceError';
    this.code = 'lego.contract_violation';
    this.meta = Object.freeze({ ...meta });
  }
}

const fail = (message, meta) => { throw new WorkerConvergenceError(message, meta); };
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

/**
 * `registry.compiler` publishes `epochDigest` as bare 64-hex (its per-entry
 * digests carry the `sha256:` prefix, the epoch digest does not), while
 * `registry.incremental` publishes view digests with the prefix. This contract
 * accepts either spelling from a caller and stores the EPOCH's own form, so a
 * comparison against `epoch.epochDigest` needs no translation at the call site.
 */
const normalizeEpochDigest = (value, field) => {
  if (typeof value === 'string' && DIGEST_RE.test(value)) return value.slice('sha256:'.length);
  if (typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)) return value;
  fail(`${field} must be a 64-hex epoch digest (bare, as registry.compiler publishes it, or 'sha256:'-prefixed): a worker that cannot say which epoch it holds cannot be compared`, { code: 'convergence.binding', field });
  return null;
};

/* ------------------------------------------------------------------ *
 * Bindings: what a worker holds, as data
 * ------------------------------------------------------------------ */

/**
 * What a worker reports it holds. `identityDigests` is the part that matters: an
 * epoch number is a claim, and a set of identity digests is the claim's content.
 */
export function workerBinding({ workerId, epochNumber, epochDigest, runtimeViewDigest = null, identityDigests = {}, runtimes = [] } = {}) {
  if (!isNonEmptyString(workerId)) {
    fail('a binding must name the worker: an anonymous worker cannot be converged, only restarted', { code: 'convergence.binding', field: 'workerId' });
  }
  if (!Number.isInteger(epochNumber) || epochNumber < 1) {
    fail('a binding must report the epoch number it holds', { code: 'convergence.binding', field: 'epochNumber' });
  }
  const normalizedEpochDigest = normalizeEpochDigest(epochDigest, 'binding.epochDigest');
  if (runtimeViewDigest !== null && (typeof runtimeViewDigest !== 'string' || !DIGEST_RE.test(runtimeViewDigest))) {
    fail("binding.runtimeViewDigest must be null or a 'sha256:<64 hex>' digest", { code: 'convergence.binding', field: 'runtimeViewDigest' });
  }
  if (!isPlainObject(identityDigests)) {
    fail('binding.identityDigests must be an object of identity → digest', { code: 'convergence.binding', field: 'identityDigests' });
  }
  const entries = {};
  for (const identity of Object.keys(identityDigests).sort()) {
    const digest = identityDigests[identity];
    if (typeof digest !== 'string' || !DIGEST_RE.test(digest)) {
      fail(`binding.identityDigests['${identity}'] must be a 'sha256:<64 hex>' digest`, { code: 'convergence.binding', field: 'identityDigests' });
    }
    entries[identity] = digest;
  }
  if (!Array.isArray(runtimes)) fail('binding.runtimes must be an array', { code: 'convergence.binding', field: 'runtimes' });
  const binding = {
    ok: true,
    schemaVersion: WORKER_CONVERGENCE_SCHEMA_VERSION,
    contract: WORKER_CONVERGENCE_CONTRACT,
    workerId,
    epochNumber,
    epochDigest: normalizedEpochDigest,
    runtimeViewDigest,
    identityDigests: Object.freeze(entries),
    runtimes: Object.freeze([...new Set(runtimes)].sort()),
  };
  return deepFreeze({ ...binding, bindingDigest: digestOf(stableJson(binding)) });
}

/** @returns {boolean} whether `value` is a binding this contract produced. */
export function isWorkerBinding(value) {
  return (
    isPlainObject(value) &&
    value.ok === true &&
    value.contract === WORKER_CONVERGENCE_CONTRACT &&
    typeof value.bindingDigest === 'string' &&
    Object.isFrozen(value)
  );
}

const requireBinding = (binding, fn) => {
  if (!isWorkerBinding(binding)) fail(`${fn} expects a binding from workerBinding`, { got: typeof binding });
};

/** Bind a worker to a compiled epoch: the target side of the handshake. */
export function coordinatorBinding(epoch, { coordinatorId = 'registry' } = {}) {
  if (!isFrozenRegistryEpoch(epoch)) {
    fail('coordinatorBinding expects an epoch compiled by registry.compiler', { code: 'convergence.epoch', field: 'epoch' });
  }
  if (!isNonEmptyString(coordinatorId)) fail('a coordinator must be named', { code: 'convergence.input', field: 'coordinatorId' });
  const identityDigests = {};
  for (const identity of epoch.identities) identityDigests[identity] = epoch.byIdentity[identity].digest;
  return deepFreeze({
    ok: true,
    schemaVersion: WORKER_CONVERGENCE_SCHEMA_VERSION,
    contract: WORKER_CONVERGENCE_CONTRACT,
    coordinatorId,
    epochNumber: epoch.epochNumber,
    epochDigest: epoch.epochDigest,
    runtimeViewDigest: projectEpochView(epoch, 'runtime').viewDigest,
    identityDigests: Object.freeze(identityDigests),
    identities: Object.freeze([...epoch.identities]),
  });
}

/* ------------------------------------------------------------------ *
 * The handshake
 * ------------------------------------------------------------------ */

/**
 * A refusal is still a DECISION: `UNAVAILABLE` is one of the four answers, so it
 * travels in `decision` like the others and `reason` explains it. A caller that
 * had to branch on a null decision and a reason string would eventually forget to.
 */
const unavailable = (reason, message, { steps = ['refuse-service', 'retry-when-serving'], detail = null } = {}) => deepFreeze({
  ok: false,
  schemaVersion: WORKER_CONVERGENCE_SCHEMA_VERSION,
  contract: WORKER_CONVERGENCE_CONTRACT,
  decision: 'UNAVAILABLE',
  reason,
  steps: Object.freeze(steps.map((step, order) => Object.freeze({ order, step }))),
  detail,
  message,
});

const decisionOf = (decision, { workerId, epochNumber, steps, detail = null, message = null }) => deepFreeze({
  ok: true,
  schemaVersion: WORKER_CONVERGENCE_SCHEMA_VERSION,
  contract: WORKER_CONVERGENCE_CONTRACT,
  decision,
  reason: null,
  workerId,
  epochNumber,
  steps: Object.freeze(steps.map((step, order) => Object.freeze({ order, step }))),
  detail,
  message,
});

const stepsFor = (decision, { cold = false, hasView = true, viewOnly = false } = {}) => {
  if (decision === 'MATCH') return [];
  if (decision === 'UPGRADE_REQUIRED') {
    // A view-only upgrade must not tell the worker to apply registry changes it
    // already holds: a plan that overstates the work is a plan nobody trusts.
    if (viewOnly) return ['request-runtime-view', 'reverify-views'];
    return cold
      ? ['request-full-epoch', 'reverify-views']
      : (hasView ? ['apply-registry-changes', 'reverify-views'] : ['request-runtime-view', 'apply-registry-changes', 'reverify-views']);
  }
  if (decision === 'MISMATCH') return ['refuse-service', 'escalate-to-operator'];
  return ['refuse-service', 'retry-when-serving'];
};

/**
 * The handshake: what should happen to this worker, given this epoch?
 *
 * @param {object} worker a binding from `workerBinding`
 * @param {object} coordinator a binding from `coordinatorBinding` (or `null` when
 *   the coordinator has no epoch to offer — an honest answer, not an error)
 * @param {{ serving?: boolean }} [options] whether the target epoch is serving
 */
export function handshake(worker, coordinator, { serving = true } = {}) {
  requireBinding(worker, 'handshake');
  if (coordinator === null || coordinator === undefined) {
    return unavailable('convergence.unavailable', 'the coordinator has no epoch to offer: a worker is refused because the target is missing, not because the worker is suspect');
  }
  if (!isPlainObject(coordinator) || coordinator.contract !== WORKER_CONVERGENCE_CONTRACT || !isNonEmptyString(coordinator.coordinatorId) || typeof coordinator.epochDigest !== 'string') {
    fail('handshake expects a coordinator binding from coordinatorBinding (or null)', { code: 'convergence.binding', field: 'coordinator' });
  }
  if (serving !== true) {
    return unavailable('convergence.unavailable', `epoch ${coordinator.epochNumber} is not serving: an epoch that is not serving is not a target, and converging a worker onto one would be a downgrade nobody asked for`);
  }

  const known = new Set(coordinator.identities);
  const unknownIdentities = Object.keys(worker.identityDigests).filter((identity) => !known.has(identity)).sort();
  const divergent = Object.keys(worker.identityDigests)
    .filter((identity) => known.has(identity) && worker.identityDigests[identity] !== coordinator.identityDigests[identity])
    .sort();
  const behind = worker.epochNumber < coordinator.epochNumber;
  const ahead = worker.epochNumber > coordinator.epochNumber;
  const missing = coordinator.identities.filter((identity) => !(identity in worker.identityDigests));
  const epochDigestAgrees = worker.epochDigest === coordinator.epochDigest;

  // 1. Anything the worker holds that the registry does not is divergence, whatever
  //    its epoch number says: a fabricated or withdrawn node is not "behind".
  if (unknownIdentities.length > 0) {
    return decisionOf('MISMATCH', {
      workerId: worker.workerId,
      epochNumber: coordinator.epochNumber,
      steps: stepsFor('MISMATCH'),
      detail: Object.freeze({ reason: 'convergence.unknown_identity', identities: Object.freeze(unknownIdentities) }),
      message: `the worker holds ${unknownIdentities.length} identity(ies) epoch ${coordinator.epochNumber} does not contain (${unknownIdentities.join(', ')}): something ahead of the source of truth exists, and it is escalated rather than converged`,
    });
  }

  // 2. A disagreement about a node both sides have is divergence, even if the
  //    worker is also behind: "behind" is a position, this is a contradiction.
  if (divergent.length > 0) {
    return decisionOf('MISMATCH', {
      workerId: worker.workerId,
      epochNumber: coordinator.epochNumber,
      steps: stepsFor('MISMATCH'),
      detail: Object.freeze({ reason: 'convergence.divergence', identities: Object.freeze(divergent) }),
      message: `the worker disagrees about ${divergent.length} identity(ies) it shares with epoch ${coordinator.epochNumber} (${divergent.join(', ')}): a worker with one disagreement is divergent, however far behind it also happens to be`,
    });
  }

  // 3. Ahead is not an upgrade.
  if (ahead) {
    return decisionOf('MISMATCH', {
      workerId: worker.workerId,
      epochNumber: coordinator.epochNumber,
      steps: stepsFor('MISMATCH'),
      detail: Object.freeze({ reason: 'convergence.ahead', workerEpochNumber: worker.epochNumber, coordinatorEpochNumber: coordinator.epochNumber }),
      message: `the worker reports epoch ${worker.epochNumber} and the coordinator serves epoch ${coordinator.epochNumber}: moving it backwards to "converge" would rewrite a history without asking why it was ahead`,
    });
  }

  // 4. Same epoch number: the whole epoch must agree, digests included.
  if (!behind) {
    if (epochDigestAgrees && missing.length === 0) {
      // MATCH needs the epoch AND the REPORTED runtime view to agree. "No view
      // reported" is a question, not an agreement: a worker that cannot state its
      // view digest cannot be keyed by a pool or a compiled cache, and calling
      // that a match would hand the pool a worker it cannot address.
      if (worker.runtimeViewDigest === coordinator.runtimeViewDigest) {
        return decisionOf('MATCH', { workerId: worker.workerId, epochNumber: coordinator.epochNumber, steps: stepsFor('MATCH') });
      }
      const reported = worker.runtimeViewDigest !== null;
      return decisionOf('UPGRADE_REQUIRED', {
        workerId: worker.workerId,
        epochNumber: coordinator.epochNumber,
        steps: stepsFor('UPGRADE_REQUIRED', { viewOnly: true }),
        detail: Object.freeze({ reason: 'convergence.behind', viewOnly: true, epochDigestAgrees: true, viewReported: reported, missing: Object.freeze([]) }),
        message: reported
          ? 'the epoch agrees and the reported runtime view does not: the worker can be brought forward by re-requesting the view'
          : 'the epoch agrees and no runtime view was reported: a worker that cannot state its view digest cannot be pooled, so the view is requested before calling this a match',
      });
    }
    return decisionOf('MISMATCH', {
      workerId: worker.workerId,
      epochNumber: coordinator.epochNumber,
      steps: stepsFor('MISMATCH'),
      detail: Object.freeze({ reason: 'convergence.divergence', epochDigestAgrees, missing: Object.freeze(missing) }),
      message: `the worker claims epoch ${worker.epochNumber} (${worker.epochDigest}) and the coordinator's epoch ${coordinator.epochNumber} is ${coordinator.epochDigest}: the same epoch number with a different digest is a contradiction, not a lag`,
    });
  }

  // 5. Behind and consistent: this is the only case that moves a worker forward.
  return decisionOf('UPGRADE_REQUIRED', {
    workerId: worker.workerId,
    epochNumber: coordinator.epochNumber,
    steps: stepsFor('UPGRADE_REQUIRED', { cold: Object.keys(worker.identityDigests).length === 0, hasView: worker.runtimeViewDigest !== null }),
    detail: Object.freeze({
      reason: 'convergence.behind',
      fromEpochNumber: worker.epochNumber,
      toEpochNumber: coordinator.epochNumber,
      missing: Object.freeze(missing),
      shared: Object.freeze(coordinator.identities.filter((identity) => identity in worker.identityDigests)),
    }),
    message: `the worker is behind at epoch ${worker.epochNumber} and consistent: ${missing.length} identity(ies) to bring forward, no disagreements`,
  });
}

/** The decision plus the epoch to converge onto, as one plan a coordinator can act on. */
export function convergeWorker(worker, epoch, { serving = true, coordinatorId = 'registry' } = {}) {
  requireBinding(worker, 'convergeWorker');
  if (epoch === null || epoch === undefined) {
    const outcome = handshake(worker, null);
    return deepFreeze({ ok: false, decision: outcome.decision, outcome, epoch: null, coordinator: null, reason: outcome.reason, message: outcome.message });
  }
  const coordinator = coordinatorBinding(epoch, { coordinatorId });
  const outcome = handshake(worker, coordinator, { serving });
  return deepFreeze({
    ok: outcome.decision !== 'MISMATCH' && outcome.decision !== 'UNAVAILABLE',
    decision: outcome.decision,
    reason: outcome.reason,
    outcome,
    epoch: outcome.decision === 'UPGRADE_REQUIRED' ? epoch : null,
    coordinator,
    message: outcome.message ?? null,
  });
}

/* ------------------------------------------------------------------ *
 * Reads
 * ------------------------------------------------------------------ */

/** A sentence a human can check, and a rollout can be stopped by. */
export function explainHandshake(outcome) {
  if (!isPlainObject(outcome) || !CONVERGENCE_DECISIONS.includes(outcome.decision)) {
    fail('explainHandshake expects an outcome from handshake or convergeWorker', { got: typeof outcome });
  }
  if (outcome.decision === 'MATCH') return `worker '${outcome.workerId}' holds epoch ${outcome.epochNumber}: nothing to do`;
  if (outcome.decision === 'UPGRADE_REQUIRED') {
    return `worker '${outcome.workerId}' is behind and consistent: ${outcome.detail.missing.length} identity(ies) to bring forward to epoch ${outcome.epochNumber} via ${outcome.steps.map((entry) => entry.step).join(' → ')}`;
  }
  if (outcome.decision === 'MISMATCH') return `worker '${outcome.workerId}' diverges: ${outcome.message}`;
  return `worker '${outcome.workerId}' refused: ${outcome.message}`;
}

/** The fleet, as counts and as the list of workers that need attention. */
export function describeFleet(outcomes) {
  if (!Array.isArray(outcomes)) fail('describeFleet expects an array of handshake outcomes', { code: 'convergence.input', field: 'outcomes' });
  const byDecision = {};
  const attention = [];
  for (const outcome of outcomes) {
    if (!isPlainObject(outcome) || !CONVERGENCE_DECISIONS.includes(outcome.decision)) {
      fail('every entry of describeFleet must be a handshake outcome', { code: 'convergence.input', field: 'outcomes' });
    }
    byDecision[outcome.decision] = (byDecision[outcome.decision] ?? 0) + 1;
    if (outcome.decision === 'MISMATCH') attention.push({ workerId: outcome.workerId, reason: outcome.detail?.reason ?? 'convergence.divergence' });
    if (outcome.decision === 'UNAVAILABLE') attention.push({ workerId: outcome.workerId, reason: 'convergence.unavailable' });
  }
  return deepFreeze({
    workerCount: outcomes.length,
    byDecision: Object.freeze(byDecision),
    converged: byDecision.MATCH ?? 0,
    upgradable: byDecision.UPGRADE_REQUIRED ?? 0,
    diverged: byDecision.MISMATCH ?? 0,
    unavailable: byDecision.UNAVAILABLE ?? 0,
    attention: Object.freeze(attention.map((entry) => Object.freeze(entry))),
  });
}

export const WORKER_CONVERGENCE_INPUT_SCHEMA_VERSION = WORKER_CONVERGENCE_SCHEMA_VERSION;
