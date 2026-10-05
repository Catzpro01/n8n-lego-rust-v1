/**
 * node.canary@0.1.0 — canary rollout, side-by-side upgrade, and rollback.
 *
 * P6 milestone 19 of 31 (Issue #100). A node upgrade is a change to what runs, and
 * the only honest way to make it is side by side: both epochs resolvable at once, a
 * declared share of work going to the candidate, and a stop condition that is
 * checked rather than assumed.
 *
 * What this contract adds beyond "route some traffic":
 *
 *  - BOTH EPOCHS STAY RESOLVABLE. A rollout never replaces anything; it holds two
 *    frozen epochs and moves a share of work between them. A cutover with a single
 *    stage is refused, because that is not a canary.
 *  - ASSIGNMENT IS MONOTONE. A cohort is a bucket of a key, and the bucket is fixed
 *    for the life of the rollout; stage shares are cumulative, so a key that reached
 *    the candidate never comes back. An execution that flapped between epochs would
 *    be a bug reported as a flake.
 *  - HEALTH IS COMPOSED AS DATA. Observations arrive from P6.11 (health states) and
 *    P6.10 (leases held); this contract never imports a verdict, it reads one.
 *  - MISSING EVIDENCE HALTS. A rollout that cannot see its own health is stopped,
 *    not continued — `unknown` is not a synonym for `fine`.
 *  - ROLLBACK IS A STATE, NOT AN UNDO. Halting and rolling back retain the candidate
 *    epoch, record the reason and the tick, and move new work back to the previous
 *    epoch; what was already leased drains normally. Nothing is deleted, and a
 *    rolled-back rollout cannot be resumed — resuming is a new rollout with a new id.
 *
 * Scope walls (enforced by tests): no scheduler or workflow graph (P4), no leases or
 * runtimes (P6.10), no health judgement (P6.11), no admission decision (P6.8/P6.17),
 * no registry mutation (P6.16/P6.13), no SBOM (P6.18). No filesystem, network, clock,
 * randomness or mutation of shared state — the only `node:` import is the hash.
 *
 * Authority: this contract decides where new work goes during a rollout. It never
 * decides that a candidate is good; a completed rollout is a record of what happened,
 * not a claim that the change was safe.
 */
import { createHash } from 'node:crypto';
import { isFrozenRegistryEpoch } from './registry-compiler.mjs';
import { HEALTH_STATES } from './node-health.mjs';

export const CANARY_CONTRACT = 'node.canary@0.1.0';
export const CANARY_CONTRACT_VERSION = '0.1.0';
export const CANARY_SCHEMA_VERSION = 1;

export const CANARY_OPERATIONS = Object.freeze(['plan', 'assign', 'evaluate', 'halt', 'complete', 'describe']);
export const CANARY_PERMISSIONS = Object.freeze(['node:read']);

/** Where a rollout is in its life. `rolled_back` is terminal: a new rollout is a new id. */
export const ROLLOUT_STATES = Object.freeze(['planned', 'live', 'halted', 'rolled_back', 'completed']);

/** What an evaluation of a stage says to do. There is no fourth answer. */
export const STAGE_ACTIONS = Object.freeze(['hold', 'advance', 'halt']);

/**
 * The closed list of things a rollout may be halted for. A free-text reason would make
 * "why did we stop" unanswerable six months later.
 */
export const HALT_RULES = Object.freeze([
  'health-state', 'circuit-open', 'failure-rate', 'insufficient-evidence', 'manual', 'lease-held',
]);

/** Cohorts a key can be assigned to. There are two, because a canary has two sides. */
export const COHORTS = Object.freeze(['current', 'candidate']);

export const DEFAULT_BUCKETS = 10000;
export const DEFAULT_MAX_FAILURE_RATE = 0.05;
export const DEFAULT_MIN_ATTEMPTS = 20;
export const MAX_STAGES = 10;

export const CANARY_REASONS = Object.freeze([
  'canary.input', 'canary.epoch', 'canary.stage', 'canary.cohort', 'canary.evidence', 'canary.state', 'canary.halt',
]);

export const CANARY_RULES = Object.freeze({
  sides: 'a rollout holds two epochs: the one serving and the one being tried. Neither is deleted by this contract',
  monotone: 'a key belongs to one bucket for the life of the rollout, and stage shares only grow, so an execution never moves back',
  evidence: 'a stage advances only on evidence that says advance; a stage that cannot be evaluated halts, it does not proceed',
  halt: 'a halt is recorded with a rule, a reason and a tick; a halt that nobody can read is an outage without a cause',
  rollback: 'rollback returns new work to the previous epoch and keeps the candidate; it is not an undo and not a delete',
  resume: 'a halted or rolled-back rollout is never reopened; continuing is a new rollout with a new id and fresh evidence',
  authority: 'this contract routes work during a rollout; it never decides that a candidate is safe',
});

export class CanaryError extends Error {
  constructor(message, { code = 'canary.input', meta = {} } = {}) {
    super(message);
    this.name = 'CanaryError';
    this.code = 'lego.contract_violation';
    this.meta = { code, ...meta };
  }
}

const fail = (message, detail = {}) => { throw new CanaryError(message, detail); };

/** Canonical JSON: key order must not change a digest. */
export function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

/** A digest over a set of fields, so a rollout is identifiable by content. */
export function rolloutDigest(fields) {
  return sha256(stableJson(fields ?? {}));
}

const isNonEmptyString = (value) => typeof value === 'string' && value.length > 0;
const isTick = (value) => Number.isInteger(value) && value >= 0;

/**
 * A plan is the declared shape of a rollout: which identity, from which epoch to which,
 * and how the share grows. It is data, and it is frozen — a plan that could be edited
 * mid-rollout would be a rollout nobody agreed to.
 */
export function createRolloutPlan({ id, subject, from, to, stages, salt } = {}) {
  if (!isNonEmptyString(id)) fail('a rollout needs an id: an unnamed rollout cannot be cited', { code: 'canary.input', field: 'id' });
  if (!isNonEmptyString(subject) || subject.split('@').some((part) => part.length === 0) || !subject.includes('@')) {
    fail("subject must be an identity 'type@typeVersion'; a rollout of something unnamed is not a rollout", { code: 'canary.input', field: 'subject' });
  }
  for (const [field, epoch] of [['from', from], ['to', to]]) {
    if (!isFrozenRegistryEpoch(epoch)) {
      fail(`createRolloutPlan reads compiled epochs: '${field}' must be a frozen registry epoch`, { code: 'canary.epoch', field });
    }
  }
  const fromDigest = epochDigestOf(from);
  const toDigest = epochDigestOf(to);
  if (fromDigest === toDigest) {
    fail('the two sides of a rollout are the same epoch: there is nothing being tried', { code: 'canary.epoch', field: 'to' });
  }
  const declared = normalizeStages(stages);
  const plan = {
    contract: CANARY_CONTRACT,
    schemaVersion: CANARY_SCHEMA_VERSION,
    id,
    subject,
    fromDigest,
    toDigest,
    fromNumber: Number.isInteger(from.epochNumber) ? from.epochNumber : null,
    toNumber: Number.isInteger(to.epochNumber) ? to.epochNumber : null,
    stages: declared,
    salt: isNonEmptyString(salt) ? salt : `canary:${id}`,
    buckets: DEFAULT_BUCKETS,
    state: 'planned',
  };
  return Object.freeze({ ...plan, planDigest: rolloutDigest(plan) });
}

function epochDigestOf(epoch) {
  const digest = epoch?.epochDigest ?? epoch?.digest ?? null;
  if (!isNonEmptyString(digest)) fail('a compiled epoch without a digest cannot be a side of a rollout', { code: 'canary.epoch', field: 'digest' });
  return digest;
}

function normalizeStages(stages) {
  if (!Array.isArray(stages) || stages.length === 0) {
    fail('a rollout declares its stages: without stages there is no share to grow', { code: 'canary.stage', field: 'stages' });
  }
  if (stages.length === 1) {
    fail('a rollout with a single stage is a cutover, not a canary: move a share, watch it, then move more', { code: 'canary.stage', field: 'stages' });
  }
  if (stages.length > MAX_STAGES) {
    fail(`a rollout with more than ${MAX_STAGES} stages is a rollout nobody will finish`, { code: 'canary.stage', field: 'stages' });
  }
  let previous = 0;
  const declared = stages.map((stage, index) => {
    const share = typeof stage === 'number' ? stage : stage?.share;
    if (typeof share !== 'number' || !(share > 0) || share > 1) {
      fail(`stage ${index} declares a share in (0, 1]; got ${String(share)}`, { code: 'canary.stage', field: `stages[${index}].share` });
    }
    if (share <= previous) {
      fail(`stage ${index} declares a share that does not grow (${previous} → ${share}): a share that falls is an unannounced rollback`, { code: 'canary.stage', field: `stages[${index}].share` });
    }
    previous = share;
    return Object.freeze({
      index,
      share,
      cumulative: share,
      minTicks: Number.isInteger(stage?.minTicks) && stage.minTicks >= 0 ? stage.minTicks : null,
      note: isNonEmptyString(stage?.note) ? stage.note : null,
    });
  });
  const last = declared[declared.length - 1];
  if (last.share !== 1) {
    fail('the last stage must reach the whole share: a rollout that stops short leaves two epochs serving forever', { code: 'canary.stage', field: 'stages' });
  }
  return Object.freeze(declared);
}

export function isRolloutPlan(value) {
  return Boolean(value) && typeof value === 'object'
    && value.contract === CANARY_CONTRACT
    && isNonEmptyString(value.id)
    && Array.isArray(value.stages)
    && isNonEmptyString(value.planDigest);
}

const assertLive = (rollout) => {
  if (!rollout || typeof rollout !== 'object' || rollout.contract !== CANARY_CONTRACT || !isNonEmptyString(rollout.id)) {
    fail('this is not a rollout', { code: 'canary.input', field: 'rollout' });
  }
  if (rollout.state !== 'live') {
    fail(`a rollout in state '${rollout.state}' does not accept this: only a live rollout routes work`, { code: 'canary.state', field: 'state' });
  }
};

/**
 * Starting a rollout makes it live at its first stage. Nothing is served by the candidate
 * until a share is declared and a key is assigned, so this is a bookkeeping step, not a switch.
 */
export function startRollout(plan, { tick } = {}) {
  if (!isRolloutPlan(plan)) fail('startRollout reads a plan made by createRolloutPlan', { code: 'canary.input', field: 'plan' });
  if (!isTick(tick)) fail('starting a rollout requires the tick it started at', { code: 'canary.input', field: 'tick' });
  return {
    contract: CANARY_CONTRACT,
    schemaVersion: CANARY_SCHEMA_VERSION,
    id: plan.id,
    subject: plan.subject,
    plan,
    planDigest: plan.planDigest,
    fromDigest: plan.fromDigest,
    toDigest: plan.toDigest,
    tick,
    state: 'live',
    stageIndex: 0,
    history: Object.freeze([Object.freeze({ kind: 'started', tick, stageIndex: 0 })]),
    halts: Object.freeze([]),
  };
}

export function isRollout(value) {
  return Boolean(value) && typeof value === 'object' && value.contract === CANARY_CONTRACT && Array.isArray(value.history);
}

/** The bucket a key falls in. Fixed for the life of the rollout: the salt is the rollout id. */
export function bucketOf(rollout, key) {
  if (!isNonEmptyString(key)) fail('a cohort key identifies a caller, a workspace or a workflow: it cannot be empty', { code: 'canary.cohort', field: 'key' });
  const plan = rollout?.plan ?? rollout;
  if (!isRolloutPlan(plan)) fail('assigning a cohort reads a rollout plan', { code: 'canary.input', field: 'plan' });
  return Number.parseInt(sha256(`${plan.id}|${plan.salt}|${key}`).slice(0, 12), 16) % plan.buckets;
}

/** The share the candidate serves at a stage. Cumulative by construction: shares only grow. */
export function cumulativeShare(plan, stageIndex) {
  if (!isRolloutPlan(plan)) fail('cumulativeShare reads a rollout plan', { code: 'canary.input', field: 'plan' });
  if (!Number.isInteger(stageIndex) || stageIndex < 0 || stageIndex >= plan.stages.length) {
    fail(`stage ${String(stageIndex)} is not a stage of this plan`, { code: 'canary.stage', field: 'stageIndex' });
  }
  return plan.stages[stageIndex].share;
}

/**
 * Which side a key is on right now, and which bucket decided it. Because the bucket is
 * fixed and the share only grows, a key that reached the candidate never returns.
 */
export function assignCohort(rollout, key) {
  if (!isRollout(rollout)) fail('assignCohort reads a rollout made by startRollout', { code: 'canary.input', field: 'rollout' });
  const bucket = bucketOf(rollout, key);
  const share = rollout.plan.stages[rollout.stageIndex].share;
  const cutoff = Math.round(share * rollout.plan.buckets);
  return Object.freeze({
    ok: true,
    cohort: bucket < cutoff ? 'candidate' : 'current',
    bucket,
    stageIndex: rollout.stageIndex,
    candidateShare: share,
  });
}

/**
 * Evaluating a stage reads observations and answers hold, advance or halt. Observations
 * are data from other contracts: P6.10 counts the leases still held on the previous
 * epoch, P6.11 names the health state. Silence is not good news.
 */
export function evaluateStage(rollout, { observations } = {}) {
  if (!isRollout(rollout)) fail('evaluateStage reads a rollout made by startRollout', { code: 'canary.input', field: 'rollout' });
  if (!observations || typeof observations !== 'object') {
    return verdict('halt', 'insufficient-evidence', 'no observations were supplied: a stage that cannot be looked at is not advanced', {});
  }
  const { attempts, failures, healthState, circuit, maxFailureRate, minAttempts } = observations;
  if (healthState !== undefined && !HEALTH_STATES.includes(healthState)) {
    fail(`healthState '${String(healthState)}' is not a health state the runtime publishes`, { code: 'canary.evidence', field: 'healthState' });
  }
  if (circuit !== undefined && !['closed', 'open', 'half-open'].includes(circuit)) {
    fail(`circuit '${String(circuit)}' is not a circuit state the runtime publishes`, { code: 'canary.evidence', field: 'circuit' });
  }
  if (healthState === 'failing' || healthState === 'quarantined') {
    return verdict('halt', 'health-state', `the candidate is '${healthState}': a side that is not serving is not promoted`, { healthState });
  }
  if (circuit === 'open') {
    return verdict('halt', 'circuit-open', 'the candidate breaker is open: the runtime already voted', { circuit });
  }
  if (healthState === undefined || healthState === 'unknown') {
    return verdict('halt', 'insufficient-evidence', 'the candidate health is unknown: unknown is not a synonym for fine', { healthState: healthState ?? null });
  }
  if (!Number.isInteger(attempts) || attempts < 0) {
    return verdict('halt', 'insufficient-evidence', 'no attempt count was supplied: a failure rate without a denominator is an opinion', { attempts: attempts ?? null });
  }
  const floor = Number.isInteger(minAttempts) ? minAttempts : DEFAULT_MIN_ATTEMPTS;
  if (attempts < floor) {
    return verdict('hold', 'insufficient-evidence', `${attempts} attempts is below the ${floor} this stage needs before it is judged`, { attempts, minAttempts: floor });
  }
  if (!Number.isInteger(failures) || failures < 0 || failures > attempts) {
    return verdict('halt', 'insufficient-evidence', `failures must be a count within attempts; got ${String(failures)} of ${attempts}`, { failures: failures ?? null, attempts });
  }
  const ceiling = typeof maxFailureRate === 'number' && maxFailureRate >= 0 && maxFailureRate <= 1 ? maxFailureRate : DEFAULT_MAX_FAILURE_RATE;
  const rate = failures / attempts;
  if (rate > ceiling) {
    return verdict('halt', 'failure-rate', `the candidate failed ${(rate * 100).toFixed(2)}% of ${attempts} attempts, above the ${(ceiling * 100).toFixed(2)}% ceiling`, { rate, ceiling, attempts, failures });
  }
  if (healthState === 'degraded' || circuit === 'half-open') {
    return verdict('hold', 'health-state', `the candidate is '${healthState}'${circuit ? ` with a ${circuit} breaker` : ''}: it is not failing, and it is not yet something to grow on`, { healthState, circuit: circuit ?? null });
  }
  return verdict('advance', null, `${attempts} attempts with ${failures} failures (${(rate * 100).toFixed(2)}%) and health '${healthState}'`, { rate, ceiling, attempts, failures, healthState });
}

function verdict(action, rule, message, evidence) {
  return Object.freeze({ ok: true, action, rule, message, evidence: Object.freeze(evidence ?? {}) });
}

/**
 * Advancing is a decision, so it needs a decision's evidence: an evaluation that says
 * advance, at this tick, for this stage. A `hold` here is not an error — it is an answer.
 */
export function advanceStage(rollout, { tick, evidence } = {}) {
  assertLive(rollout);
  if (!isTick(tick)) fail('advancing a stage requires the tick it happened at', { code: 'canary.input', field: 'tick' });
  if (!evidence || typeof evidence !== 'object' || typeof evidence.action !== 'string') {
    fail('advancing requires the evaluation that justified it', { code: 'canary.evidence', field: 'evidence' });
  }
  if (evidence.action !== 'advance') {
    return Object.freeze({ ok: false, advanced: false, action: evidence.action, reason: 'canary.evidence', message: `the evidence says '${evidence.action}': only 'advance' moves a stage` });
  }
  const next = rollout.stageIndex + 1;
  if (next >= rollout.plan.stages.length) {
    return Object.freeze({ ok: false, advanced: false, action: 'advance', reason: 'canary.stage', message: 'the last stage is already serving the whole share: there is no further stage; completing the rollout is a separate act' });
  }
  const minTicks = rollout.plan.stages[rollout.stageIndex].minTicks;
  if (minTicks !== null && tick - rollout.tick < minTicks) {
    return Object.freeze({ ok: false, advanced: false, action: 'advance', reason: 'canary.stage', message: `stage ${rollout.stageIndex} declares ${minTicks} ticks of soak time; ${tick - rollout.tick} have passed` });
  }
  rollout.stageIndex = next;
  rollout.history = Object.freeze([...rollout.history, Object.freeze({ kind: 'advanced', tick, stageIndex: next, share: rollout.plan.stages[next].share })]);
  return Object.freeze({ ok: true, advanced: true, stageIndex: next, share: rollout.plan.stages[next].share, message: `stage ${next} serves ${(rollout.plan.stages[next].share * 100).toFixed(2)}%` });
}

/**
 * Halting stops the rollout where it is: the share it reached stays serving, and no new
 * work beyond it goes to the candidate. Rolling back is the separate act that returns
 * new work to the previous epoch.
 */
export function haltRollout(rollout, { rule, reason, tick, detail } = {}) {
  if (!isRollout(rollout)) fail('haltRollout reads a rollout made by startRollout', { code: 'canary.input', field: 'rollout' });
  if (rollout.state === 'completed' || rollout.state === 'rolled_back') {
    fail(`a '${rollout.state}' rollout is finished: halting it would rewrite what happened`, { code: 'canary.state', field: 'state' });
  }
  if (rollout.state === 'halted') {
    fail(`this rollout is already halted at tick ${rollout.halts[rollout.halts.length - 1].tick} for ${rollout.halts[rollout.halts.length - 1].rule}: a second halt would rewrite the record`, { code: 'canary.state', field: 'state' });
  }
  if (!HALT_RULES.includes(rule)) {
    fail(`'${String(rule)}' is not a halt rule: halt reasons are a closed list, or 'why did we stop' has no answer`, { code: 'canary.halt', field: 'rule' });
  }
  if (!isNonEmptyString(reason)) fail('a halt records a reason a human can read', { code: 'canary.halt', field: 'reason' });
  if (!isTick(tick)) fail('a halt records the tick it happened at', { code: 'canary.halt', field: 'tick' });
  rollout.state = 'halted';
  rollout.halts = Object.freeze([...rollout.halts, Object.freeze({ rule, reason, tick, stageIndex: rollout.stageIndex, detail: isNonEmptyString(detail) ? detail : null })]);
  rollout.history = Object.freeze([...rollout.history, Object.freeze({ kind: 'halted', tick, rule, stageIndex: rollout.stageIndex })]);
  return Object.freeze({ ok: true, state: 'halted', rule, tick, stageIndex: rollout.stageIndex, message: `halted at stage ${rollout.stageIndex} for ${rule}: ${reason}` });
}

/**
 * Rolling back returns new work to the epoch that was serving and KEEPS the candidate.
 * The candidate is not deleted, not failed, and not judged — it is retained for the
 * report and for whoever investigates. `holders` is the count of leases still held on the
 * previous epoch (P6.10's `epochsHeldBy`), which the caller supplies as data.
 */
export function rollbackRollout(rollout, { rule, reason, tick, holders = 0 } = {}) {
  if (!isRollout(rollout)) fail('rollbackRollout reads a rollout made by startRollout', { code: 'canary.input', field: 'rollout' });
  if (rollout.state === 'completed') {
    fail('a completed rollout has nothing to roll back to: the candidate is what serves; undoing that is a new rollout', { code: 'canary.state', field: 'state' });
  }
  if (rollout.state === 'rolled_back') {
    fail('this rollout is already rolled back: rolling back twice would rewrite the record', { code: 'canary.state', field: 'state' });
  }
  if (!HALT_RULES.includes(rule)) {
    fail(`'${String(rule)}' is not a halt rule: rollback is a halt that also moves the work`, { code: 'canary.halt', field: 'rule' });
  }
  if (!isNonEmptyString(reason)) fail('a rollback records a reason a human can read', { code: 'canary.halt', field: 'reason' });
  if (!isTick(tick)) fail('a rollback records the tick it happened at', { code: 'canary.halt', field: 'tick' });
  if (!Number.isInteger(holders) || holders < 0) fail('holders is a count of leases still held', { code: 'canary.evidence', field: 'holders' });
  const retained = Object.freeze({
    digest: rollout.toDigest,
    epochNumber: rollout.plan.toNumber,
    stageIndex: rollout.stageIndex,
    shareAtHalt: rollout.plan.stages[rollout.stageIndex].share,
  });
  if (rollout.state === 'live') {
    rollout.halts = Object.freeze([...rollout.halts, Object.freeze({ rule, reason, tick, stageIndex: rollout.stageIndex, detail: 'rolled back' })]);
  }
  rollout.state = 'rolled_back';
  rollout.retainedCandidate = retained;
  rollout.history = Object.freeze([...rollout.history, Object.freeze({ kind: 'rolled_back', tick, rule, stageIndex: rollout.stageIndex, holders })]);
  return Object.freeze({
    ok: true,
    state: 'rolled_back',
    rule,
    retained,
    draining: holders,
    message: `new work returns to epoch ${rollout.plan.fromNumber ?? 'previous'}; the candidate is retained for the record, and ${holders} execution(s) on the previous epoch drain normally`,
  });
}

/**
 * Completing is the only moment a rollout claims anything: the last stage served the
 * whole share, the evidence said advance, and nothing is left held on the old epoch.
 */
export function completeRollout(rollout, { tick, evidence, holders = 0 } = {}) {
  assertLive(rollout);
  if (!isTick(tick)) fail('completing a rollout requires the tick it happened at', { code: 'canary.input', field: 'tick' });
  const lastIndex = rollout.plan.stages.length - 1;
  if (rollout.stageIndex !== lastIndex) {
    return Object.freeze({ ok: false, completed: false, reason: 'canary.stage', message: `stage ${rollout.stageIndex} of ${lastIndex} is serving: a rollout completes at the last stage` });
  }
  if (!evidence || evidence.action !== 'advance') {
    return Object.freeze({ ok: false, completed: false, reason: 'canary.evidence', message: 'completing needs an evaluation of the last stage that says advance' });
  }
  if (!Number.isInteger(holders) || holders < 0) fail('holders is a count of leases still held', { code: 'canary.evidence', field: 'holders' });
  if (holders > 0) {
    return Object.freeze({ ok: false, completed: false, reason: 'canary.evidence', message: `${holders} execution(s) still hold the previous epoch: draining is not abandoning, so this is not complete` });
  }
  rollout.state = 'completed';
  rollout.history = Object.freeze([...rollout.history, Object.freeze({ kind: 'completed', tick, stageIndex: lastIndex, toDigest: rollout.toDigest })]);
  return Object.freeze({ ok: true, completed: true, state: 'completed', toDigest: rollout.toDigest, message: 'the candidate serves the whole share and the previous epoch is released' });
}

/** The counts a person opens with: which stage, how much, how many halts, what is retained. */
export function describeRollout(rollout) {
  if (!isRollout(rollout)) fail('describeRollout reads a rollout made by startRollout', { code: 'canary.input', field: 'rollout' });
  const stage = rollout.plan.stages[rollout.stageIndex];
  return Object.freeze({
    contract: CANARY_CONTRACT,
    id: rollout.id,
    subject: rollout.subject,
    state: rollout.state,
    stage: rollout.stageIndex,
    stages: rollout.plan.stages.length,
    candidateShare: stage.share,
    cohorts: Object.freeze({
      candidate: stage.share,
      current: 1 - stage.share,
    }),
    halts: Object.freeze(rollout.halts.map((halt) => `${halt.rule}@${halt.tick}: ${halt.reason}`)),
    retainedCandidate: rollout.retainedCandidate ?? null,
    events: rollout.history.length,
    planDigest: rollout.planDigest,
  });
}

/** One readable line, so a rollback is not something a reader has to reconstruct. */
export function explainRollout(rollout) {
  const described = describeRollout(rollout);
  const share = `${(described.candidateShare * 100).toFixed(2)}%`;
  if (described.state === 'rolled_back') {
    return `${described.id}: ${described.subject} rolled back at stage ${described.stage} while the candidate served ${share}; the candidate is retained, not deleted`;
  }
  if (described.state === 'halted') {
    return `${described.id}: ${described.subject} halted at stage ${described.stage} (${share}) — ${described.halts[described.halts.length - 1] ?? 'no reason recorded'}`;
  }
  if (described.state === 'completed') {
    return `${described.id}: ${described.subject} completed; the candidate serves everything and the previous epoch is released`;
  }
  return `${described.id}: ${described.subject} ${described.state} at stage ${described.stage} of ${described.stages}, candidate serving ${share}`;
}

export { HEALTH_STATES };
