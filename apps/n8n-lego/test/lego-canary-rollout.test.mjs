/**
 * P6.19 — canary rollout, side-by-side upgrade, rollback.
 * Contract `node.canary@0.1.0`.
 *
 * Matrix: the plan as declared data (two sides, growing shares, a cutover refused),
 * monotone cohort assignment (a key never comes back), stage evaluation over
 * observations composed as data (unknown halts, silence halts, the ceiling is a
 * boundary), advancing as a decision that needs evidence, halting with a closed
 * rule list, rollback as a state that retains the candidate, completion as the only
 * claim, the reads, and the walls.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { compileRegistryEpoch } from '../src/lego/registry-compiler.mjs';
import { HEALTH_STATES } from '../src/lego/node-health.mjs';
import {
  CANARY_CONTRACT,
  CANARY_CONTRACT_VERSION,
  CANARY_OPERATIONS,
  CANARY_PERMISSIONS,
  CANARY_REASONS,
  CANARY_RULES,
  CANARY_SCHEMA_VERSION,
  COHORTS,
  CanaryError,
  DEFAULT_BUCKETS,
  HALT_RULES,
  MAX_STAGES,
  ROLLOUT_STATES,
  STAGE_ACTIONS,
  advanceStage,
  assignCohort,
  bucketOf,
  completeRollout,
  createRolloutPlan,
  cumulativeShare,
  describeRollout,
  evaluateStage,
  explainRollout,
  haltRollout,
  isRollout,
  isRolloutPlan,
  rollbackRollout,
  rolloutDigest,
  stableJson,
  startRollout,
} from '../src/lego/canary-rollout.mjs';

/* ------------------------------------------------------------------ fixtures */

const declaration = (type, typeVersion, overrides = {}) => ({
  type,
  typeVersion,
  package: 'n8n-nodes-base',
  packageVersion: '1.0.0',
  vendor: 'n8n',
  contractVersion: '0.1.0',
  implementationVersion: '0.1.0',
  digest: `sha256:${'a'.repeat(64)}`,
  provenance: { kind: 'package-registry', source: 'npm:n8n-nodes-base@1.0.0' },
  capabilities: ['network'],
  trustClass: 'core',
  runtimeLocality: 'js-compat',
  resourceProfile: { cpu: 'low', memory: 'medium', disk: 'none', network: true, concurrency: 'parallel-safe', startup: 'fast' },
  compatibility: { contractRange: '^0.1.0', portabilityTargets: ['JS'] },
  lifecycle: 'declared',
  health: 'unknown',
  discovery: { displayName: type, group: 'transform', description: `about ${type}` },
  ...overrides,
});

const SET = declaration('n8n-nodes-base.set', 3.4);
const SET_V2 = declaration('n8n-nodes-base.set', 3.5, {
  packageVersion: '1.1.0', implementationVersion: '0.2.0', digest: `sha256:${'b'.repeat(64)}`,
});

const EPOCH_FROM = compileRegistryEpoch({ declarations: [SET], source: 'p6.19-from' });
const EPOCH_TO = compileRegistryEpoch({ declarations: [SET, SET_V2], epochNumber: 2, source: 'p6.19-to' });
const EPOCH_OTHER = compileRegistryEpoch({ declarations: [SET_V2], epochNumber: 3, source: 'p6.19-other' });

const PLAN = () => createRolloutPlan({
  id: 'rollout-42',
  subject: 'n8n-nodes-base.set@3.5',
  from: EPOCH_FROM,
  to: EPOCH_TO,
  stages: [{ share: 0.1, minTicks: 0 }, { share: 0.5 }, { share: 1 }],
});

const LIVE = (tick = 0) => startRollout(PLAN(), { tick });

const healthy = (overrides = {}) => ({
  attempts: 200, failures: 1, healthState: 'healthy', circuit: 'closed', ...overrides,
});

/** Advance to the last stage through real evaluations, so nothing is assumed. */
function advanceToLastStage(rollout) {
  for (let index = 0; index < rollout.plan.stages.length - 1; index += 1) {
    const evidence = evaluateStage(rollout, { observations: healthy() });
    const result = advanceStage(rollout, { tick: 10 * (index + 1), evidence });
    assert.equal(result.ok, true, `stage ${index} must advance: ${result.message}`);
  }
  return rollout;
}

const throwsWith = (fn, code) => {
  let caught = null;
  try { fn(); } catch (error) { caught = error; }
  assert.ok(caught instanceof CanaryError, `expected a CanaryError carrying ${code}`);
  assert.equal(caught.code, 'lego.contract_violation');
  assert.equal(caught.meta.code, code);
  return caught;
};

/* ------------------------------------------------------------------ contract */

test('the contract surface is the published one: id, version, ops, states, a closed halt list', () => {
  assert.equal(CANARY_CONTRACT, 'node.canary@0.1.0');
  assert.equal(CANARY_CONTRACT_VERSION, '0.1.0');
  assert.equal(CANARY_SCHEMA_VERSION, 1);
  assert.deepEqual([...CANARY_OPERATIONS], ['plan', 'assign', 'evaluate', 'halt', 'complete', 'describe']);
  assert.deepEqual([...CANARY_PERMISSIONS], ['node:read']);
  assert.deepEqual([...ROLLOUT_STATES], ['planned', 'live', 'halted', 'rolled_back', 'completed']);
  assert.deepEqual([...STAGE_ACTIONS], ['hold', 'advance', 'halt']);
  assert.deepEqual([...COHORTS], ['current', 'candidate']);
  assert.equal(HALT_RULES.length, 6);
  assert.equal(HALT_RULES.includes('free-text'), false);
  assert.equal(CANARY_REASONS.length, 7);
  assert.equal(CANARY_RULES.authority, 'this contract routes work during a rollout; it never decides that a candidate is safe');
  assert.deepEqual([...HEALTH_STATES], ['unknown', 'healthy', 'degraded', 'failing', 'quarantined']);
});

test('a plan declares two distinct epochs and growing shares, and refuses a cutover', () => {
  const plan = PLAN();
  assert.equal(isRolloutPlan(plan), true);
  assert.equal(plan.state, 'planned');
  assert.equal(plan.fromDigest, EPOCH_FROM.epochDigest);
  assert.equal(plan.toDigest, EPOCH_TO.epochDigest);
  assert.deepEqual(plan.stages.map((stage) => stage.share), [0.1, 0.5, 1]);
  assert.equal(Object.isFrozen(plan), true);
  assert.equal(Object.isFrozen(plan.stages), true);
  assert.equal(plan.buckets, DEFAULT_BUCKETS);
  assert.match(plan.planDigest, /^[0-9a-f]{64}$/);

  const make = (overrides) => createRolloutPlan({
    id: 'rollout-42', subject: 'n8n-nodes-base.set@3.5', from: EPOCH_FROM, to: EPOCH_TO, stages: [0.5, 1], ...overrides,
  });
  throwsWith(() => make({ id: '' }), 'canary.input');
  throwsWith(() => make({ subject: 'n8n-nodes-base.set' }), 'canary.input');
  throwsWith(() => make({ subject: '@3.5' }), 'canary.input');
  throwsWith(() => make({ from: { epochDigest: 'sha256:x', frozen: true } }), 'canary.epoch');
  throwsWith(() => make({ to: EPOCH_FROM }), 'canary.epoch');
  assert.match(throwsWith(() => createRolloutPlan({
    id: 'r', subject: 'a@1', from: EPOCH_FROM, to: EPOCH_TO, stages: [1],
  }), 'canary.stage').message, /cutover, not a canary/);
  assert.match(throwsWith(() => make({ stages: [0.5, 0.4] }), 'canary.stage').message, /does not grow/);
  assert.match(throwsWith(() => make({ stages: [0.5, 0.9] }), 'canary.stage').message, /must reach the whole share/);
  throwsWith(() => make({ stages: [0, 1] }), 'canary.stage');
  throwsWith(() => make({ stages: [1.5, 1] }), 'canary.stage');
  throwsWith(() => make({ stages: Array.from({ length: MAX_STAGES + 1 }, (_, index) => (index + 1) / (MAX_STAGES + 1)).concat(1) }), 'canary.stage');
  // An unreadable plan is not a plan: the sides must be epochs that really compiled.
  assert.equal(isRolloutPlan({ contract: CANARY_CONTRACT, id: 'r', stages: [] }), false);
  assert.equal(isRolloutPlan(null), false);
});

test('a plan digest is a digest of content, not of key order', () => {
  const plan = PLAN();
  const { planDigest, ...fields } = plan;
  assert.equal(planDigest, rolloutDigest(fields));
  assert.equal(stableJson({ b: 1, a: [{ d: 2, c: 3 }] }), stableJson({ a: [{ c: 3, d: 2 }], b: 1 }));
  assert.equal(rolloutDigest({ id: 'a' }), rolloutDigest({ id: 'a' }));
  assert.notEqual(rolloutDigest({ id: 'a' }), rolloutDigest({ id: 'b' }));
});

/* --------------------------------------------------------------------- cohorts */

test('a key belongs to one bucket for the life of the rollout, and stage shares only grow', () => {
  const rollout = LIVE();
  assert.equal(bucketOf(rollout, 'exec-1'), bucketOf(rollout, 'exec-1'), 'the same key gets the same bucket');
  assert.notEqual(bucketOf(rollout, 'exec-1'), bucketOf(rollout, 'exec-1 '), 'whitespace is a different key, not the same one');
  throwsWith(() => bucketOf(rollout, ''), 'canary.cohort');

  const keys = Array.from({ length: 400 }, (_, index) => `workflow-${index}`);
  const seen = new Map(keys.map((key) => [key, assignCohort(rollout, key).cohort]));
  const atFirstStage = [...seen.values()].filter((cohort) => cohort === 'candidate').length / keys.length;
  assert.ok(atFirstStage > 0.05 && atFirstStage < 0.16, `~10% of keys should start on the candidate, got ${atFirstStage}`);

  advanceToLastStage(rollout);
  for (const key of keys) {
    const now = assignCohort(rollout, key);
    assert.equal(now.stageIndex, 2);
    assert.equal(now.candidateShare, 1);
    assert.equal(now.cohort, 'candidate', `${key} was assigned by a growing share and must never come back`);
    assert.ok(['current', 'candidate'].includes(now.cohort));
  }
});

test('cohort assignment is monotone stage by stage: no key ever moves back to the previous epoch', () => {
  const rollout = LIVE();
  const keys = Array.from({ length: 300 }, (_, index) => `job-${index}`);
  const assignments = keys.map((key) => []);

  for (let stage = 0; stage < rollout.plan.stages.length; stage += 1) {
    keys.forEach((key, index) => assignments[index].push(assignCohort(rollout, key).cohort));
    if (stage < rollout.plan.stages.length - 1) {
      const evidence = evaluateStage(rollout, { observations: healthy() });
      assert.equal(advanceStage(rollout, { tick: stage + 1, evidence }).ok, true);
    }
  }

  const cohortsSeen = new Set();
  for (const [index, sequence] of assignments.entries()) {
    cohortsSeen.add(sequence[0]);
    if (sequence.includes('candidate')) {
      const first = sequence.indexOf('candidate');
      assert.equal(
        sequence.slice(first).every((cohort) => cohort === 'candidate'), true,
        `key ${keys[index]} moved back to the previous epoch: ${sequence.join(' -> ')}`,
      );
      assert.equal(
        sequence.slice(0, first).every((cohort) => cohort === 'current'), true,
        `key ${keys[index]} was on the candidate and then was not: ${sequence.join(' -> ')}`,
      );
    } else {
      assert.deepEqual(sequence, ['current', 'current', 'current'], `key ${keys[index]} never moved and must not claim to: ${sequence.join(' -> ')}`);
    }
  }
  // Both sides are really exercised: a monotone sequence means nothing if every key started on the candidate.
  assert.deepEqual([...cohortsSeen].sort(), ['candidate', 'current']);
  assert.equal(assignments.filter((sequence) => sequence[0] === 'candidate').length > 0, true);
  assert.equal(assignments.every((sequence) => sequence[sequence.length - 1] === 'candidate'), true, 'at the last stage the whole share is the candidate');
  assert.equal([...CANARY_OPERATIONS].includes('resume'), false, 'resuming is a new rollout, not an operation on this one');
});

test('the candidate share at a stage is the declared share, and the boundary is the boundary', () => {
  const rollout = LIVE();
  assert.equal(cumulativeShare(rollout.plan, 0), 0.1);
  assert.equal(cumulativeShare(rollout.plan, 2), 1);
  throwsWith(() => cumulativeShare(rollout.plan, 3), 'canary.stage');
  throwsWith(() => cumulativeShare({ contract: CANARY_CONTRACT }, 0), 'canary.input');

  const cutoff = Math.round(0.1 * DEFAULT_BUCKETS);
  // Find keys that land exactly below and exactly at the cutoff, using the shipped
  // bucket function: the boundary is decided by the hash, so it is tested with it.
  let below = null;
  let at = null;
  let searched = 0;
  for (let index = 0; (below === null || at === null) && index < 400000; index += 1) {
    const key = `boundary-${index}`;
    searched += 1;
    const bucket = bucketOf(rollout, key);
    if (bucket === cutoff - 1) below = key;
    if (bucket === cutoff) at = key;
  }
  assert.ok(below && at, 'the boundary keys must exist for this plan; the hash is deterministic, so a miss is a bug');
  assert.ok(searched < 400000, 'the search is bounded, so a miss fails rather than hangs');
  assert.equal(assignCohort(rollout, below).cohort, 'candidate', 'bucket below the cutoff is on the candidate side');
  assert.equal(assignCohort(rollout, at).cohort, 'current', 'the cutoff bucket itself is not yet on the candidate side');
});

/* ----------------------------------------------------------------- evaluation */

test('a stage advances on evidence that says advance, and the failure ceiling is a boundary', () => {
  const rollout = LIVE();
  const advance = evaluateStage(rollout, { observations: healthy() });
  assert.equal(advance.action, 'advance');
  assert.equal(advance.rule, null);
  assert.equal(advance.evidence.rate, 0.005);

  const atCeiling = evaluateStage(rollout, { observations: healthy({ attempts: 100, failures: 5 }) });
  assert.equal(atCeiling.action, 'advance', 'exactly at the ceiling is not above it');
  const above = evaluateStage(rollout, { observations: healthy({ attempts: 100, failures: 6 }) });
  assert.equal(above.action, 'halt');
  assert.equal(above.rule, 'failure-rate');
  assert.match(above.message, /6\.00% of 100 attempts/);
  assert.equal(above.evidence.ceiling, 0.05);

  const declaredCeiling = evaluateStage(rollout, { observations: healthy({ attempts: 100, failures: 2, maxFailureRate: 0.01 }) });
  assert.equal(declaredCeiling.action, 'halt', 'a stage may declare a stricter ceiling than the default');

  const soaking = evaluateStage(rollout, { observations: healthy({ attempts: 19 }) });
  assert.equal(soaking.action, 'hold');
  assert.equal(soaking.rule, 'insufficient-evidence');
  assert.match(soaking.message, /19 attempts is below the 20/);
  assert.equal(evaluateStage(rollout, { observations: healthy({ attempts: 20, failures: 0, minAttempts: 50 }) }).action, 'hold');
});

test('unknown, silence, a breaking circuit and a failing side all stop the rollout', () => {
  const rollout = LIVE();
  const unknown = evaluateStage(rollout, { observations: healthy({ healthState: 'unknown' }) });
  assert.equal(unknown.action, 'halt');
  assert.match(unknown.message, /unknown is not a synonym for fine/);
  const silent = evaluateStage(rollout, {});
  assert.equal(silent.action, 'halt');
  assert.equal(silent.rule, 'insufficient-evidence');
  const open = evaluateStage(rollout, { observations: healthy({ circuit: 'open' }) });
  assert.equal(open.action, 'halt');
  assert.equal(open.rule, 'circuit-open');
  assert.equal(evaluateStage(rollout, { observations: healthy({ healthState: 'failing' }) }).rule, 'health-state');
  assert.equal(evaluateStage(rollout, { observations: healthy({ healthState: 'quarantined' }) }).action, 'halt');
  const degraded = evaluateStage(rollout, { observations: healthy({ healthState: 'degraded' }) });
  assert.equal(degraded.action, 'hold', 'degraded is not failing and not something to grow on');
  assert.equal(evaluateStage(rollout, { observations: healthy({ circuit: 'half-open' }) }).action, 'hold');
  assert.equal(evaluateStage(rollout, { observations: healthy({ attempts: 100, failures: 101 }) }).action, 'halt', 'failures above attempts is a broken observation, not a rate');
  throwsWith(() => evaluateStage(rollout, { observations: healthy({ healthState: 'mostly-fine' }) }), 'canary.evidence');
  throwsWith(() => evaluateStage(rollout, { observations: healthy({ circuit: 'ajar' }) }), 'canary.evidence');
});

test('advancing is a decision: it needs evidence, a tick, and soak time, and it stops at the last stage', () => {
  const rollout = LIVE();
  throwsWith(() => advanceStage(rollout, {}), 'canary.input');
  throwsWith(() => advanceStage(rollout, { tick: 1 }), 'canary.evidence');
  const held = advanceStage(rollout, { tick: 1, evidence: evaluateStage(rollout, { observations: healthy({ healthState: 'degraded' }) }) });
  assert.equal(held.ok, false);
  assert.equal(held.reason, 'canary.evidence');
  assert.match(held.message, /only 'advance' moves a stage/);
  assert.equal(rollout.stageIndex, 0, 'a refused advance does not move the rollout');

  const evidence = evaluateStage(rollout, { observations: healthy() });
  assert.equal(advanceStage(rollout, { tick: 5, evidence }).stageIndex, 1);
  assert.equal(rollout.stageIndex, 1);
  assert.equal(advanceStage(rollout, { tick: 6, evidence }).stageIndex, 2);
  const past = advanceStage(rollout, { tick: 7, evidence });
  assert.equal(past.ok, false);
  assert.equal(past.reason, 'canary.stage');
  assert.match(past.message, /completing the rollout is a separate act/);
  assert.equal(rollout.history.filter((event) => event.kind === 'advanced').length, 2);
});

test('a stage that declares soak time cannot be advanced early', () => {
  const rollout = startRollout(createRolloutPlan({
    id: 'soaked', subject: 'n8n-nodes-base.set@3.5', from: EPOCH_FROM, to: EPOCH_TO,
    stages: [{ share: 0.2, minTicks: 0 }, { share: 0.6, minTicks: 50 }, { share: 1 }],
  }), { tick: 0 });
  const evidence = evaluateStage(rollout, { observations: healthy() });
  advanceStage(rollout, { tick: 1, evidence });
  const early = advanceStage(rollout, { tick: 20, evidence });
  assert.equal(early.ok, false);
  assert.match(early.message, /50 ticks of soak time; 20 have passed/);
  assert.equal(advanceStage(rollout, { tick: 51, evidence }).stageIndex, 2);
});

/* -------------------------------------------------------- halt and rollback */

test('a halt records a rule from the closed list, a reason and a tick, and stops only the rollout', () => {
  const rollout = LIVE();
  throwsWith(() => haltRollout(rollout, { rule: 'bad-vibes', reason: 'x', tick: 1 }), 'canary.halt');
  throwsWith(() => haltRollout(rollout, { rule: 'failure-rate', reason: '', tick: 1 }), 'canary.halt');
  throwsWith(() => haltRollout(rollout, { rule: 'failure-rate', reason: 'rate', tick: -1 }), 'canary.halt');
  const halted = haltRollout(rollout, { rule: 'failure-rate', reason: '6% failures on the candidate', tick: 12 });
  assert.equal(halted.state, 'halted');
  assert.equal(rollout.state, 'halted');
  assert.equal(rollout.stageIndex, 0, 'halting keeps the share it reached');
  assert.match(explainRollout(rollout), /halted at stage 0 \(10\.00%\)/);
  assert.match(describeRollout(rollout).halts[0], /failure-rate@12: 6% failures/);
  assert.match(
    throwsWith(() => haltRollout(rollout, { rule: 'manual', reason: 'again', tick: 13 }), 'canary.state').message,
    /already halted at tick 12 for failure-rate/,
  );
  assert.equal(rollout.halts.length, 1, 'a second halt does not rewrite the record');
});

test('a halted rollout routes nothing new and does not accept further decisions', () => {
  const rollout = LIVE();
  haltRollout(rollout, { rule: 'manual', reason: 'operator stopped it', tick: 3 });
  const evidence = evaluateStage(rollout, { observations: healthy() });
  assert.equal(evidence.action, 'advance', 'evaluation is a read: it still says what it sees');
  throwsWith(() => advanceStage(rollout, { tick: 4, evidence }), 'canary.state');
  throwsWith(() => completeRollout(rollout, { tick: 4, evidence, holders: 0 }), 'canary.state');
  assert.equal(assignCohort(rollout, 'any-key').ok, true, 'assignment is still answerable: a reader can ask what would have happened');
});

test('rollback returns new work to the previous epoch and retains the candidate', () => {
  const rollout = LIVE();
  const evidence = evaluateStage(rollout, { observations: healthy() });
  advanceStage(rollout, { tick: 1, evidence });
  const result = rollbackRollout(rollout, { rule: 'failure-rate', reason: 'candidate failed 9% of 400', tick: 40, holders: 12 });
  assert.equal(result.state, 'rolled_back');
  assert.equal(result.draining, 12);
  assert.match(result.message, /drain normally/);
  assert.equal(result.retained.digest, EPOCH_TO.epochDigest, 'the candidate epoch is retained, not deleted');
  assert.equal(result.retained.shareAtHalt, 0.5);
  assert.equal(result.retained.epochNumber, 2);
  assert.equal(describeRollout(rollout).retainedCandidate.shareAtHalt, 0.5);
  assert.match(explainRollout(rollout), /rolled back at stage 1 while the candidate served 50\.00%; the candidate is retained, not deleted/);
  throwsWith(() => rollbackRollout(rollout, { rule: 'manual', reason: 'again', tick: 41 }), 'canary.state');
  throwsWith(() => advanceStage(rollout, { tick: 42, evidence }), 'canary.state');
});

test('a halted rollout can roll back, and a completed one cannot', () => {
  const halted = LIVE();
  haltRollout(halted, { rule: 'health-state', reason: 'candidate quarantined', tick: 8 });
  const rolled = rollbackRollout(halted, { rule: 'health-state', reason: 'candidate quarantined', tick: 9 });
  assert.equal(rolled.ok, true);
  assert.equal(halted.halts.length, 1, 'rolling back out of a halt does not add a second halt to the record');
  assert.equal(halted.history.filter((event) => event.kind === 'halted').length, 1);

  const finished = advanceToLastStage(LIVE());
  const evidence = evaluateStage(finished, { observations: healthy() });
  assert.equal(completeRollout(finished, { tick: 99, evidence, holders: 0 }).completed, true);
  throwsWith(() => rollbackRollout(finished, { rule: 'manual', reason: 'too late', tick: 100 }), 'canary.state');
  throwsWith(() => haltRollout(finished, { rule: 'manual', reason: 'no', tick: 100 }), 'canary.state');
  assert.match(throwsWith(() => rollbackRollout(finished, { rule: 'manual', reason: 'no', tick: 100 }), 'canary.state').message, /new rollout/);
});

/* ---------------------------------------------------------------- completion */

test('completion is the only claim a rollout makes, and it needs a drained previous epoch', () => {
  const rollout = advanceToLastStage(LIVE());
  const evidence = evaluateStage(rollout, { observations: healthy() });
  const tooEarly = completeRollout(LIVE(), { tick: 1, evidence, holders: 0 });
  assert.equal(tooEarly.completed, false);
  assert.equal(tooEarly.reason, 'canary.stage');
  const held = completeRollout(rollout, { tick: 100, evidence, holders: 3 });
  assert.equal(held.completed, false);
  assert.match(held.message, /draining is not abandoning/);
  const withoutEvidence = completeRollout(rollout, { tick: 100, holders: 0 });
  assert.equal(withoutEvidence.completed, false);
  assert.equal(withoutEvidence.reason, 'canary.evidence');
  const done = completeRollout(rollout, { tick: 100, evidence, holders: 0 });
  assert.equal(done.completed, true);
  assert.equal(done.toDigest, EPOCH_TO.epochDigest);
  assert.equal(rollout.state, 'completed');
  assert.match(explainRollout(rollout), /completed; the candidate serves everything and the previous epoch is released/);
  throwsWith(() => advanceStage(rollout, { tick: 101, evidence }), 'canary.state');
});

test('describing a rollout gives the counts a review opens with', () => {
  const rollout = LIVE();
  advanceToLastStage(rollout);
  const described = describeRollout(rollout);
  assert.equal(described.contract, CANARY_CONTRACT);
  assert.equal(described.id, 'rollout-42');
  assert.equal(described.subject, 'n8n-nodes-base.set@3.5');
  assert.equal(described.state, 'live');
  assert.equal(described.stage, 2);
  assert.equal(described.stages, 3);
  assert.equal(described.candidateShare, 1);
  assert.deepEqual(described.cohorts, { candidate: 1, current: 0 });
  assert.deepEqual(described.halts, []);
  assert.equal(described.retainedCandidate, null);
  assert.equal(described.planDigest, rollout.planDigest);
  assert.equal(Object.isFrozen(described), true);
  assert.match(explainRollout(rollout), /live at stage 2 of 3, candidate serving 100\.00%/);
  throwsWith(() => describeRollout({ contract: CANARY_CONTRACT }), 'canary.input');
  assert.equal(isRollout(rollout), true);
  assert.equal(isRollout({ contract: CANARY_CONTRACT }), false);
  throwsWith(() => startRollout({ id: 'x' }, { tick: 0 }), 'canary.input');
  throwsWith(() => startRollout(PLAN(), {}), 'canary.input');
  assert.equal(startRollout(PLAN(), { tick: 0 }).state, 'live');
  // Two plans over the same epochs are different rollouts: the id and salt are part of the plan.
  const other = createRolloutPlan({ id: 'rollout-43', subject: 'n8n-nodes-base.set@3.5', from: EPOCH_FROM, to: EPOCH_OTHER, stages: [0.1, 1] });
  assert.notEqual(other.planDigest, PLAN().planDigest);
  assert.equal(bucketOf(other, 'exec-1') === bucketOf(PLAN(), 'exec-1'), false);
});

/* --------------------------------------------------------------------- walls */

test('the contract is a reading of other modules, not a second copy of them', () => {
  const source = readFileSync(new URL('../src/lego/canary-rollout.mjs', import.meta.url), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const forbidden of ['node:fs', 'node:net', 'node:http', 'node:os', 'node:child_process', 'process.', 'Math.random', 'setTimeout', 'performance.', 'fetch(', 'node:vm', 'eval(']) {
    assert.equal(code.includes(forbidden), false, `the canary contract must not reference ${forbidden}`);
  }
  assert.deepEqual([...code.matchAll(/from '(node:[a-z_/]+)'/g)].map((match) => match[1]), ['node:crypto']);
  assert.equal(/\bnew Date\b|\bDate\.now\b/.test(code), false);
  for (const forbidden of ['./runtime-lease.mjs', './node-health-table.mjs', './admission-explain.mjs', './sbom-policy.mjs', './registry-integrity.mjs', './resolution-manifest.mjs']) {
    assert.equal(code.includes(forbidden), false, `P6.19 must not reach into ${forbidden}: it routes work and reads observations`);
  }
  assert.ok(code.includes("from './registry-compiler.mjs'"), 'the epoch guard is P6.2\'s, reused');
  assert.ok(code.includes("from './node-health.mjs'"), 'the health vocabulary is P6.11\'s, quoted');
  assert.equal(code.includes('createHealthTable'), false, 'this contract reads a health state; it does not judge one');
});

/* ------------------------------------------------------------------- lock row */

test('the contract-lock row is canonical: one row, version, ops, tests, exports, domain path', () => {
  const lock = JSON.parse(readFileSync(new URL('../src/lego/contracts/contract-lock.json', import.meta.url)));
  const rows = lock.contracts.filter((contract) => contract.id === 'node.canary');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].version, CANARY_CONTRACT_VERSION);
  assert.equal(rows[0].domain, 'node-registry');
  assert.equal(rows[0].status, 'implemented');
  assert.deepEqual(rows[0].surface, ['src/lego/canary-rollout.mjs']);
  assert.deepEqual(rows[0].tests, ['apps/n8n-lego/test/lego-canary-rollout.test.mjs']);
  for (const name of ['createRolloutPlan', 'startRollout', 'assignCohort', 'evaluateStage', 'haltRollout', 'rollbackRollout', 'completeRollout', 'describeRollout']) {
    assert.equal(rows[0].exports['src/lego/canary-rollout.mjs'].includes(name), true, `${name} must be locked`);
  }
  for (const id of ['node.registry', 'registry.compiler', 'runtime.lease', 'node.health', 'node.supply-chain', 'registry.integrity', 'node.acceptance', 'node.admission', 'node.sbom']) {
    assert.equal(lock.contracts.find((contract) => contract.id === id).version, '0.1.0', `P6.19 must not re-version ${id}`);
  }
  const domain = JSON.parse(readFileSync(new URL('../src/lego/manifest/domains.json', import.meta.url)))
    .domains.find((entry) => entry.id === 'node-registry');
  assert.equal(domain.contract.id, 'node.portability');
  assert.ok(domain.paths.includes('src/lego/canary-rollout.mjs'));
});
