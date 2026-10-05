/**
 * Admission explain plan + dependency blast radius — P6.17.
 *
 * PUBLIC CONTRACT (`node.admission@0.1.0`, domain `node-registry`).
 *
 * By now the pieces exist: capability (P6.8), semantics (P6.9), lifecycle (P6.10),
 * health (P6.11), supply chain (P6.12), closure (P6.4), residency (P6.7). Each one
 * can say no. None of them can say, in one place, **why THIS node is being admitted
 * right now** — or why it is not.
 *
 * A PLAN IS AN ORDERED ARGUMENT, NOT A SUMMARY. The checks run in a fixed order
 * (identity → lifecycle → supply → capability → semantics → health → closure →
 * residency), each step carries its OUTCOME and a CITATION naming the contract that
 * produced the evidence, and the verdict is one of three words:
 *
 *   ADMIT       every check passed, with evidence
 *   REFUSE      at least one check failed, and the plan says which and why
 *   INCOMPLETE  no check failed and at least one had no evidence — which FAILS CLOSED
 *
 * INCOMPLETE IS THE DESIGN. A plan that admits a node because nobody checked it is
 * worse than no plan at all, so missing evidence is never a pass: it is a named
 * hole, and the plan refuses to call it an admission. A first-time node has no
 * semantics baseline (P6.9 returns MISSING), which is exactly the honest outcome:
 * somebody must supply the baseline before this node is admitted on semantics.
 *
 * THE PLAN DOES NOT RE-DECIDE. It composes: the capability verdict comes from the
 * capability contract, the health verdict from the health contract. Nothing here
 * re-derives a decision another contract already made, because a second opinion
 * that disagrees with the first is how two systems end up disagreeing about one
 * node's safety.
 *
 * THE BLAST RADIUS IS THE OTHER HALF. Before a revocation, a downgrade or a
 * rollout, someone has to answer "who breaks?" — so a radius is computed from a
 * REVERSE dependency index: who depends on this, transitively, how deep, and by
 * which path. It is DESCRIPTIVE: a radius is a count and a list, never a permission,
 * and a cycle is walked once rather than forever.
 *
 * WHAT THIS IS NOT (P6.17 scope walls, enforced by tests):
 *   - no decisions of its own: every verdict is cited, and an uncited pass is not
 *     possible in the shape;
 *   - no install (P6.3), no publish (P6.2/P6.13), no lease (P6.6), no quarantine
 *     action (P6.11 reports, this explains), no rollback (P6.19);
 *   - no filesystem, network, clock, randomness or mutation: evidence is data.
 *
 * Authority: an ADMIT verdict explains why nothing refused. It is not a grant —
 * capability, health and lease still decide whether anything runs.
 */
import { createHash } from 'node:crypto';

import { isFrozenRegistryEpoch } from './registry-compiler.mjs';

export const ADMISSION_CONTRACT = 'node.admission@0.1.0';
export const ADMISSION_CONTRACT_VERSION = '0.1.0';
export const ADMISSION_SCHEMA_VERSION = 1;

export const ADMISSION_OPERATIONS = Object.freeze(['ask', 'explain', 'blast', 'describe']);
export const ADMISSION_PERMISSIONS = Object.freeze(['node:read']);

/** The three words a plan may end with. `incomplete` fails closed. */
export const ADMISSION_VERDICTS = Object.freeze(['admit', 'refuse', 'incomplete']);

/** The checks, in the order they are argued. Order is data, not an accident. */
export const ADMISSION_CHECKS = Object.freeze([
  'identity', 'lifecycle', 'supply', 'capability', 'semantics', 'health', 'closure', 'residency',
]);

/** Which contract owns each check: a citation is a contract identity, never a guess. */
export const ADMISSION_CITATIONS = Object.freeze({
  identity: 'node.registry@0.1.0',
  lifecycle: 'node.lifecycle@0.1.0',
  supply: 'node.supply-chain@0.1.0',
  capability: 'node.capability@0.1.0',
  semantics: 'node.semantics@0.1.0',
  health: 'node.health@0.1.0',
  closure: 'registry.closure@0.1.0',
  residency: 'node.residency@0.1.0',
});

export const ADMISSION_REASONS = Object.freeze([
  'admission.input',
  'admission.identity',
  'admission.evidence',
  'admission.plan',
  'admission.target',
  'admission.radius',
]);

export const ADMISSION_RULES = Object.freeze({
  order: 'the checks are argued in a fixed order, so two people explaining one node tell the same story in the same sequence',
  citation: 'every step names the contract that produced its evidence: an uncited pass is not a pass, it is an opinion',
  incomplete: 'no check failed and at least one had no evidence is INCOMPLETE, which fails closed — a plan that admits a node because nobody checked it is worse than no plan',
  compose: 'the plan does not re-decide: a second opinion that disagrees with the first is how two systems end up disagreeing about one node\'s safety',
  radius: 'a blast radius is a count and a list of paths: the blast radius is descriptive, never a permission, and a cycle is walked once rather than forever',
  authority: 'an admit verdict explains why nothing refused; capability, health and lease still decide whether anything runs',
});

/* ------------------------------------------------------------------ *
 * Errors, helpers
 * ------------------------------------------------------------------ */

/** Raised for API misuse. A refusal is data inside a plan. */
export class AdmissionError extends Error {
  constructor(message, meta = {}) {
    super(message);
    this.name = 'AdmissionError';
    this.code = 'lego.contract_violation';
    this.meta = Object.freeze({ ...meta });
  }
}

const fail = (message, meta) => { throw new AdmissionError(message, meta); };
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
 * The question
 * ------------------------------------------------------------------ */

/**
 * The question a plan answers. Making it a value means it can be filed, replayed
 * and compared — an admission argument that cannot be re-read is a conversation.
 */
export function admissionQuestion({ identity, epoch, context = null } = {}) {
  if (!isNonEmptyString(identity)) {
    fail('an admission question must name the node identity it is about', { code: 'admission.identity', field: 'identity' });
  }
  if (!isFrozenRegistryEpoch(epoch)) {
    fail('an admission question is asked against a compiled epoch: without one there is nothing to admit into', { code: 'admission.input', field: 'epoch' });
  }
  if (context !== null && !isPlainObject(context)) fail('context must be an object or null', { code: 'admission.input', field: 'context' });
  return deepFreeze({
    ok: true,
    schemaVersion: ADMISSION_SCHEMA_VERSION,
    contract: ADMISSION_CONTRACT,
    identity,
    epochNumber: epoch.epochNumber,
    epochDigest: epoch.epochDigest,
    context: context ? Object.freeze({ ...context }) : null,
    questionDigest: digestOf(stableJson({ identity, epochNumber: epoch.epochNumber, epochDigest: epoch.epochDigest, context })),
  });
}

/** @returns {boolean} whether `value` is a question this contract produced. */
export function isAdmissionQuestion(value) {
  return (
    isPlainObject(value) &&
    value.ok === true &&
    value.contract === ADMISSION_CONTRACT &&
    typeof value.questionDigest === 'string' &&
    Object.isFrozen(value)
  );
}

const requireQuestion = (question) => {
  if (!isAdmissionQuestion(question)) fail('this expects a question from admissionQuestion', { got: typeof question });
};

/* ------------------------------------------------------------------ *
 * The checks
 * ------------------------------------------------------------------ */

const step = (check, outcome, message, digest = null) => Object.freeze({
  check,
  outcome,
  citation: Object.freeze({ contract: ADMISSION_CITATIONS[check], digest }),
  message,
});

/**
 * Every check reads ONE piece of evidence and returns pass/fail/unknown. The rules
 * are deliberately conservative: anything the evidence does not establish is
 * `unknown`, and unknown is never a pass.
 */
const CHECKS = Object.freeze({
  identity: ({ identity, epoch }) => {
    const entry = epoch.byIdentity[identity];
    if (!entry) {
      return step('identity', 'fail', `'${identity}' is not in epoch ${epoch.epochNumber}: an identity the registry does not have cannot be explained as admitted`, null);
    }
    return step('identity', 'pass', `'${identity}' is declared in epoch ${epoch.epochNumber}`, entry.digest);
  },
  lifecycle: ({ evidence }) => {
    if (!evidence.lifecycle) return step('lifecycle', 'unknown', 'no lifecycle evidence was supplied');
    const { state, tombstone } = evidence.lifecycle;
    if (tombstone) {
      return step('lifecycle', 'fail', `tombstoned (${tombstone.reason ?? 'retired'}): a retired name does not come back to life`, null);
    }
    if (state === 'disabled') return step('lifecycle', 'fail', 'the node is disabled: an admission plan that ignores the ledger is not explaining anything', null);
    return step('lifecycle', 'pass', `lifecycle state is '${state}'`, null);
  },
  supply: ({ evidence }) => {
    if (!evidence.supply) return step('supply', 'unknown', 'no attestation verdict was supplied');
    const { ok, primaryReason, message } = evidence.supply;
    if (ok === false) return step('supply', 'fail', primaryReason ? `${primaryReason}: ${message ?? 'the attestations do not support admission'}` : message ?? 'the attestations do not support admission', null);
    return step('supply', 'pass', 'attestations verified against the policy, or the policy explicitly exempts them', null);
  },
  capability: ({ evidence }) => {
    if (!evidence.capability) return step('capability', 'unknown', 'no capability plan was supplied');
    const plan = evidence.capability;
    if (plan.ok === false) return step('capability', 'fail', plan.reason ? `${plan.reason}: the host cannot grant what this node asks for` : 'the capability plan refused', plan.planDigest ?? null);
    if (Array.isArray(plan.denied) && plan.denied.length > 0) {
      return step('capability', 'fail', `the grant is not all-or-nothing: denied ${plan.denied.join(', ')}`, plan.planDigest ?? null);
    }
    return step('capability', 'pass', `every requested capability is granted${plan.locality ? ` (locality ${plan.locality})` : ''}`, plan.planDigest ?? null);
  },
  semantics: ({ evidence }) => {
    if (!evidence.semantics) return step('semantics', 'unknown', 'no compatibility replay was supplied');
    const replay = evidence.semantics;
    const { verdict, impact } = replay;
    if (verdict === 'MISSING' || verdict === 'NON_DETERMINISTIC') {
      return step('semantics', 'unknown', `the replay is ${verdict}: a node whose semantics cannot be established is not admitted on semantics`, replay.replayDigest ?? null);
    }
    if (verdict === 'DIFF' && (impact === 'breaking' || impact === 'behavioral')) {
      return step('semantics', 'fail', `the replay is DIFF with impact '${impact}'${Array.isArray(replay.changedAxes) && replay.changedAxes.length > 0 ? ` (axes: ${replay.changedAxes.join(', ')})` : ''}: a workflow pinned to the previous semantics would change behaviour`, replay.replayDigest ?? null);
    }
    return step('semantics', 'pass', verdict === 'MATCH' ? 'the replay matches the baseline' : `the replay is DIFF with impact '${impact}'`, replay.replayDigest ?? null);
  },
  health: ({ evidence }) => {
    if (!evidence.health) return step('health', 'unknown', 'no health decision was supplied');
    if (evidence.health.ok === false) {
      return step('health', 'fail', `${evidence.health.reason ?? 'health.circuit_open'}: ${evidence.health.message ?? 'the node is not serving'}`.trim(), null);
    }
    return step('health', 'pass', evidence.health.probe ? 'the circuit allows a probe' : 'the node is serving', null);
  },
  closure: ({ evidence }) => {
    if (!evidence.closure) return step('closure', 'unknown', 'no dependency closure was supplied');
    if (evidence.closure.ok === false) return step('closure', 'fail', `${evidence.closure.reason ?? 'closure.missing'}: the dependencies are not closed`, null);
    return step('closure', 'pass', `the closure resolves ${Array.isArray(evidence.closure.order) ? evidence.closure.order.length : 'the'} package(s)`, evidence.closure.digest ?? null);
  },
  residency: ({ evidence }) => {
    if (evidence.residency === null || evidence.residency === undefined) return step('residency', 'unknown', 'no residency evidence was supplied');
    return step('residency', 'pass', `the implementation tier is '${evidence.residency}'`, null);
  },
});

/**
 * Explain why this node is, or is not, admissible — as an ordered argument.
 *
 * @param {object} question from `admissionQuestion`
 * @param {{ lifecycle?: object, supply?: object, capability?: object, semantics?: object, health?: object, closure?: object, residency?: string }} [evidence]
 */
export function explainAdmission(question, { evidence = {} } = {}) {
  requireQuestion(question);
  if (!isPlainObject(evidence)) fail('evidence must be an object of verdicts from the contracts that produced them', { code: 'admission.evidence', field: 'evidence' });
  const context = { identity: question.identity, epoch: { byIdentity: {} }, evidence };
  // The identity check needs the epoch; the caller's question carries its identity
  // and digest, and the plan is re-checked against the epoch by `planAgainstEpoch`.
  const steps = ADMISSION_CHECKS.map((check) => {
    if (check === 'identity') return null;
    return CHECKS[check](context);
  }).filter(Boolean);
  const ordered = Object.freeze(steps.map((entry, order) => Object.freeze({ order, ...entry })));
  const failures = Object.freeze(ordered.filter((entry) => entry.outcome === 'fail').map((entry) => Object.freeze({ check: entry.check, citation: entry.citation.contract, message: entry.message })));
  const unknowns = Object.freeze(ordered.filter((entry) => entry.outcome === 'unknown').map((entry) => entry.check));
  const verdict = failures.length > 0 ? 'refuse' : (unknowns.length > 0 ? 'incomplete' : 'admit');
  return deepFreeze({
    ok: verdict === 'admit',
    schemaVersion: ADMISSION_SCHEMA_VERSION,
    contract: ADMISSION_CONTRACT,
    identity: question.identity,
    epochNumber: question.epochNumber,
    epochDigest: question.epochDigest,
    verdict,
    steps: ordered,
    failures,
    unknowns,
    planDigest: digestOf(stableJson({ identity: question.identity, epochDigest: question.epochDigest, steps: ordered.map((entry) => [entry.check, entry.outcome, entry.citation.contract, entry.message]) })),
    message: verdict === 'admit'
      ? null
      : (failures.length > 0
        ? `refused: ${failures.map((entry) => `${entry.check} (${entry.citation})`).join(', ')}`
        : `incomplete: no check failed and ${unknowns.length} had no evidence (${unknowns.join(', ')}) — a plan that admits a node because nobody checked it is worse than no plan at all`),
  });
}

/**
 * The full plan: the same argument, with the identity check run against a real
 * epoch. This is the entry point; `explainAdmission` is the argument without the
 * registry in hand.
 */
export function planAdmission(question, epoch, { evidence = {} } = {}) {
  requireQuestion(question);
  if (!isFrozenRegistryEpoch(epoch)) fail('planAdmission expects the epoch the question names', { code: 'admission.input', field: 'epoch' });
  if (epoch.epochDigest !== question.epochDigest) {
    fail(`the question names epoch ${question.epochDigest} and this epoch is ${epoch.epochDigest}: an argument about another registry is not about this one`, { code: 'admission.input', field: 'epoch' });
  }
  const identityStep = CHECKS.identity({ identity: question.identity, epoch });
  const identityFailures = [];
  const identityUnknowns = [];
  if (identityStep.outcome === 'fail') identityFailures.push({ check: 'identity', citation: identityStep.citation.contract, message: identityStep.message });
  const base = explainAdmission(question, { evidence });
  const steps = Object.freeze([Object.freeze({ order: 0, ...identityStep }), ...base.steps.map((entry, order) => Object.freeze({ ...entry, order: order + 1 }))]);
  const failures = Object.freeze([...identityFailures.map((entry) => Object.freeze(entry)), ...base.failures]);
  const verdict = failures.length > 0 ? 'refuse' : base.verdict;
  return deepFreeze({
    ok: verdict === 'admit',
    schemaVersion: ADMISSION_SCHEMA_VERSION,
    contract: ADMISSION_CONTRACT,
    identity: question.identity,
    epochNumber: epoch.epochNumber,
    epochDigest: epoch.epochDigest,
    verdict,
    steps,
    failures,
    unknowns: base.unknowns,
    planDigest: digestOf(stableJson({ identity: question.identity, epochDigest: epoch.epochDigest, steps: steps.map((entry) => [entry.check, entry.outcome, entry.citation.contract, entry.message]) })),
    message: failures.length > 0
      ? `refused: ${failures.map((entry) => `${entry.check} (${entry.citation})`).join(', ')}`
      : base.message,
  });
}

/** @returns {boolean} whether `value` is a plan this contract produced. */
export function isAdmissionPlan(value) {
  return (
    isPlainObject(value) &&
    value.contract === ADMISSION_CONTRACT &&
    ADMISSION_VERDICTS.includes(value.verdict) &&
    Array.isArray(value.steps) &&
    typeof value.planDigest === 'string' &&
    Object.isFrozen(value)
  );
}

/** A sentence an operator can read, and a rollout can be stopped by. */
export function explainPlan(plan) {
  if (!isAdmissionPlan(plan)) fail('explainPlan expects a plan from explainAdmission or planAdmission', { got: typeof plan });
  if (plan.verdict === 'admit') {
    return `'${plan.identity}' is admitted into epoch ${plan.epochNumber}: ${plan.steps.length} check(s) passed with evidence — an explanation, not a grant`;
  }
  if (plan.verdict === 'refuse') {
    return `'${plan.identity}' is refused: ${plan.failures.map((entry) => `${entry.check} by ${entry.citation}`).join('; ')}`;
  }
  return `'${plan.identity}' is INCOMPLETE: no check failed and ${plan.unknowns.length} had no evidence (${plan.unknowns.join(', ')}) — this fails closed`;
}

/* ------------------------------------------------------------------ *
 * Blast radius
 * ------------------------------------------------------------------ */

/**
 * Turn dependency edges (`from` depends on `to`) into a reverse index.
 *
 * `packages` is the universe the index knows about. Without it, a key only exists
 * if it has at least one dependent — which makes "this package has no dependents"
 * indistinguishable from "this package does not exist", and those are opposite
 * answers. So the caller may declare the universe, and then an absent key really
 * does mean "not in the registry".
 */
export function dependentsFrom(edges, { packages = [] } = {}) {
  if (!Array.isArray(edges)) fail('dependentsFrom expects an array of edges', { code: 'admission.input', field: 'edges' });
  if (!Array.isArray(packages)) fail('packages must be an array of package names when supplied', { code: 'admission.input', field: 'packages' });
  const index = {};
  for (const name of packages) {
    if (!isNonEmptyString(name)) fail('every declared package needs a name', { code: 'admission.input', field: 'packages' });
    index[name] = [];
  }
  for (const edge of edges) {
    if (!isPlainObject(edge) || !isNonEmptyString(edge.from) || !isNonEmptyString(edge.to)) {
      fail('every edge needs a from and a to: a dependency is a direction', { code: 'admission.input', field: 'edges' });
    }
    if (edge.from === edge.to) {
      fail(`'${edge.from}' depends on itself: a self-dependency is a typo or a trap, and either way it is not resolved here`, { code: 'admission.input', field: 'edges' });
    }
    index[edge.to] = [...(index[edge.to] ?? []), edge.from];
  }
  const sorted = {};
  for (const key of Object.keys(index).sort()) sorted[key] = Object.freeze([...new Set(index[key])].sort());
  return deepFreeze({ ok: true, schemaVersion: ADMISSION_SCHEMA_VERSION, contract: ADMISSION_CONTRACT, dependents: Object.freeze(sorted), edgeCount: edges.length });
}

/** @returns {boolean} whether `value` is a reverse index this contract produced. */
export function isDependentIndex(value) {
  return isPlainObject(value) && value.ok === true && value.contract === ADMISSION_CONTRACT && isPlainObject(value.dependents) && Object.isFrozen(value);
}

/**
 * Who breaks if this changes?
 *
 * @param {{ target: string, dependents: object, maxDepth?: number, limit?: number }} input
 */
export function computeBlastRadius({ target, dependents, maxDepth = 8, limit = 256 } = {}) {
  if (!isNonEmptyString(target)) fail('computeBlastRadius expects the package a change is proposed for', { code: 'admission.target', field: 'target' });
  const index = isDependentIndex(dependents) ? dependents.dependents : dependents;
  if (!isPlainObject(index)) fail('computeBlastRadius expects a reverse index from dependentsFrom', { code: 'admission.input', field: 'dependents' });
  if (!Number.isInteger(maxDepth) || maxDepth < 1 || maxDepth > 32) fail('maxDepth must be an integer between 1 and 32', { code: 'admission.input', field: 'maxDepth' });
  if (!Number.isInteger(limit) || limit < 1) fail('limit must be a positive integer: an unbounded report is not a report', { code: 'admission.input', field: 'limit' });
  if (!(target in index)) {
    return deepFreeze({
      ok: false,
      schemaVersion: ADMISSION_SCHEMA_VERSION,
      contract: ADMISSION_CONTRACT,
      reason: 'admission.target',
      target,
      affected: Object.freeze([]),
      count: 0,
      byDepth: Object.freeze({}),
      truncated: false,
      message: `'${target}' is not in the dependency index: the blast radius of something the registry does not have is not zero, it is unknown — and unknown fails closed`,
    });
  }

  const affected = [];
  const seen = new Set([target]);
  let frontier = [target];
  let truncated = false;
  for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth += 1) {
    const next = [];
    for (const current of [...frontier].sort()) {
      for (const name of index[current] ?? []) {
        if (seen.has(name)) continue;
        seen.add(name);
        next.push(name);
        affected.push({ name, depth, via: current });
        if (affected.length >= limit) { truncated = true; break; }
      }
      if (truncated) break;
    }
    if (truncated) break;
    if (next.length === 0) break;
    // A report that stops at the depth ceiling says so rather than looking complete.
    if (depth === maxDepth) truncated = true;
    frontier = next;
  }
  const byDepth = {};
  for (const entry of affected) byDepth[entry.depth] = (byDepth[entry.depth] ?? 0) + 1;
  const sorted = [...affected].sort((left, right) => (left.depth === right.depth ? (left.name < right.name ? -1 : 1) : left.depth - right.depth));
  return deepFreeze({
    ok: true,
    schemaVersion: ADMISSION_SCHEMA_VERSION,
    contract: ADMISSION_CONTRACT,
    reason: null,
    target,
    affected: Object.freeze(sorted.map((entry) => Object.freeze(entry))),
    count: sorted.length,
    byDepth: Object.freeze(byDepth),
    deepest: sorted.length === 0 ? 0 : sorted[sorted.length - 1].depth,
    truncated,
    radiusDigest: digestOf(stableJson({ target, affected: sorted.map((entry) => [entry.name, entry.depth, entry.via]) })),
    message: null,
  });
}

/** A sentence a human can act on, and a rollout can be stopped by. */
export function explainBlastRadius(radius) {
  if (!isPlainObject(radius) || radius.contract !== ADMISSION_CONTRACT || !Array.isArray(radius.affected)) {
    fail('explainBlastRadius expects a radius from computeBlastRadius', { got: typeof radius });
  }
  if (radius.ok === false) return `blast radius of '${radius.target}' is UNKNOWN: ${radius.message}`;
  if (radius.count === 0) return `'${radius.target}' has no dependents in this index: nothing else breaks when it changes`;
  return `'${radius.target}' affects ${radius.count} package(s) to depth ${radius.deepest}${radius.truncated ? ' (TRUNCATED: the report stopped early and says so)' : ''}: ${radius.affected.slice(0, 5).map((entry) => `${entry.name} (depth ${entry.depth})`).join(', ')}${radius.count > 5 ? ', …' : ''}`;
}

/** The plan and the radius, as one document an operator reads before acting. */
export function describeAdmission({ plan = null, radius = null } = {}) {
  const described = {};
  if (plan !== null) {
    if (!isAdmissionPlan(plan)) fail('describeAdmission expects a plan from explainAdmission or planAdmission', { code: 'admission.plan', field: 'plan' });
    described.plan = Object.freeze({
      identity: plan.identity,
      verdict: plan.verdict,
      passed: plan.steps.filter((entry) => entry.outcome === 'pass').map((entry) => entry.check),
      failed: plan.failures.map((entry) => entry.check),
      unknown: plan.unknowns,
      planDigest: plan.planDigest,
    });
  }
  if (radius !== null) {
    if (!isPlainObject(radius) || !Array.isArray(radius.affected)) fail('describeAdmission expects a radius from computeBlastRadius', { code: 'admission.radius', field: 'radius' });
    described.radius = Object.freeze({ target: radius.target, count: radius.count, deepest: radius.deepest, truncated: radius.truncated });
  }
  return deepFreeze(described);
}

export const ADMISSION_INPUT_SCHEMA_VERSION = ADMISSION_SCHEMA_VERSION;
