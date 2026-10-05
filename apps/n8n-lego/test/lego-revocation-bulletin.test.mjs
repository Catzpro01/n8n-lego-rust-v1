/**
 * P6.20 — emergency revocation bulletins.
 * Contract `node.revocation@0.1.0`.
 *
 * Matrix: the bulletin as data (baseline epoch, bounded window, named subjects), the
 * sequence that makes a replay visible, the client witness that refuses one without the
 * registry's help, the ticked standing (pending/active/lapsed), dispositions (uphold needs
 * somewhere durable; lift needs an actor), the one decision this contract makes, the
 * baseline rule (a change cannot be un-seen), the reads, and the walls.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { compileRegistryEpoch } from '../src/lego/registry-compiler.mjs';
import {
  BULLETIN_CONTRACT,
  BULLETIN_CONTRACT_VERSION,
  BULLETIN_OPERATIONS,
  BULLETIN_PERMISSIONS,
  BULLETIN_REASONS,
  BULLETIN_RULES,
  BULLETIN_SCHEMA_VERSION,
  BULLETIN_STATES,
  BulletinError,
  DISPOSITIONS,
  MAX_BULLETIN_TICKS,
  MAX_SUBJECTS,
  SUBJECT_DECISIONS,
  SUBJECT_KINDS,
  appliesToEpoch,
  bulletinDigest,
  createBulletinView,
  createBulletinWitness,
  decideSubject,
  describeBulletin,
  disposeBulletin,
  evaluateBulletin,
  explainBulletin,
  isBulletin,
  isBulletinView,
  isBulletinWitness,
  isDisposition,
  issueBulletin,
  normalizeDigest,
  stableJson,
  verifyBulletinSequence,
  witnessBulletin,
} from '../src/lego/revocation-bulletin.mjs';

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
const EPOCH = compileRegistryEpoch({ declarations: [SET], source: 'p6.20-one' });
const EPOCH_TWO = compileRegistryEpoch({ declarations: [SET, declaration('n8n-nodes-base.if', 2.2)], epochNumber: 2, source: 'p6.20-two' });
const EPOCH_THREE = compileRegistryEpoch({ declarations: [SET], epochNumber: 3, source: 'p6.20-three' });

const ARTIFACT = `sha256:${'c'.repeat(64)}`;

const BULLETIN = (overrides = {}) => issueBulletin({
  id: 'emergency-1',
  sequence: 1,
  issuedBy: 'security@example',
  issuedAt: 50,
  effectiveFrom: 100,
  expiresAt: 160,
  baseline: EPOCH,
  subjects: [{ kind: 'identity', key: 'n8n-nodes-base.set@3.4' }],
  reason: 'credential exfiltration reported in n8n-nodes-base.set@3.4',
  ...overrides,
});

const SECOND = (previous, overrides = {}) => issueBulletin({
  id: 'emergency-1',
  sequence: previous.sequence + 1,
  issuedBy: 'security@example',
  issuedAt: 200,
  effectiveFrom: 200,
  expiresAt: 260,
  baseline: EPOCH_TWO,
  subjects: [{ kind: 'package', key: 'n8n-nodes-base@1.0.0' }],
  reason: 'the advisory was widened to the whole package',
  previousDigest: previous.bulletinDigest,
  ...overrides,
});

const throwsWith = (fn, code) => {
  let caught = null;
  try { fn(); } catch (error) { caught = error; }
  assert.ok(caught instanceof BulletinError, `expected a BulletinError carrying ${code}`);
  assert.equal(caught.code, 'lego.contract_violation');
  assert.equal(caught.meta.code, code);
  return caught;
};

/* ------------------------------------------------------------------ contract */

test('the contract surface is the published one: id, version, ops, closed vocabularies', () => {
  assert.equal(BULLETIN_CONTRACT, 'node.revocation@0.1.0');
  assert.equal(BULLETIN_CONTRACT_VERSION, '0.1.0');
  assert.equal(BULLETIN_SCHEMA_VERSION, 1);
  assert.deepEqual([...BULLETIN_OPERATIONS], ['issue', 'evaluate', 'dispose', 'witness', 'describe']);
  assert.deepEqual([...BULLETIN_PERMISSIONS], ['node:read']);
  assert.deepEqual([...SUBJECT_KINDS], ['identity', 'package', 'artifact']);
  assert.deepEqual([...BULLETIN_STATES], ['pending', 'active', 'lapsed']);
  assert.deepEqual([...DISPOSITIONS], ['uphold', 'lift']);
  assert.deepEqual([...SUBJECT_DECISIONS], ['deny', 'allow']);
  assert.equal(BULLETIN_REASONS.length, 7);
  assert.equal(BULLETIN_RULES.authority, 'a bulletin denies work; it never grants it, and it never repairs a registry');
  assert.match(BULLETIN_RULES.lapse, /keeps denying until somebody disposes of it/);
  assert.equal(MAX_BULLETIN_TICKS, 720);
  assert.equal(MAX_SUBJECTS, 100);
});

test('a bulletin is data about a specific registry state, and it refuses to be vague', () => {
  const bulletin = BULLETIN();
  assert.equal(isBulletin(bulletin), true);
  assert.equal(Object.isFrozen(bulletin), true);
  assert.equal(bulletin.baselineDigest, normalizeDigest(EPOCH.epochDigest));
  assert.equal(bulletin.baselineNumber, EPOCH.epochNumber ?? null);
  assert.equal(bulletin.previousDigest, null);
  assert.match(bulletin.bulletinDigest, /^[0-9a-f]{64}$/);
  assert.equal(bulletin.subjects[0].kind, 'identity');
  assert.equal(bulletin.subjects[0].digest, null);

  throwsWith(() => BULLETIN({ id: '' }), 'revocation.input');
  throwsWith(() => BULLETIN({ issuedBy: '' }), 'revocation.input');
  throwsWith(() => BULLETIN({ issuedAt: -1 }), 'revocation.input');
  throwsWith(() => BULLETIN({ reason: '' }), 'revocation.input');
  throwsWith(() => BULLETIN({ sequence: 0 }), 'revocation.sequence');
  throwsWith(() => BULLETIN({ sequence: 1, previousDigest: `sha256:${'d'.repeat(64)}` }), 'revocation.sequence');
  assert.match(
    throwsWith(() => BULLETIN({ sequence: 2 }), 'revocation.sequence').message,
    /cannot be ordered against a replay/,
  );
  assert.equal(isBulletin(BULLETIN({ sequence: 2, previousDigest: `sha256:${'d'.repeat(64)}` })), true, 'a linked bulletin is a bulletin; whether the link holds is the sequence check\'s question, not the issue check\'s');
  throwsWith(() => BULLETIN({ baseline: { epochDigest: EPOCH.epochDigest } }), 'revocation.epoch');
  throwsWith(() => BULLETIN({ subjects: [] }), 'revocation.subject');
  assert.equal(isBulletin({ contract: BULLETIN_CONTRACT, id: 'x' }), false);
  assert.equal(isBulletin(null), false);
});

test('the emergency window is bounded, and a standing policy is refused rather than accepted quietly', () => {
  throwsWith(() => BULLETIN({ effectiveFrom: 100, expiresAt: 100 }), 'revocation.window');
  throwsWith(() => BULLETIN({ effectiveFrom: 100, expiresAt: 90 }), 'revocation.window');
  assert.match(
    throwsWith(() => BULLETIN({ effectiveFrom: 0, expiresAt: MAX_BULLETIN_TICKS + 1 }), 'revocation.window').message,
    /a standing policy belongs on the durable path/,
  );
  assert.equal(BULLETIN({ effectiveFrom: 10, expiresAt: 10 + MAX_BULLETIN_TICKS }).expiresAt - BULLETIN({ effectiveFrom: 10, expiresAt: 10 + MAX_BULLETIN_TICKS }).effectiveFrom, MAX_BULLETIN_TICKS);
});

test('subjects are identities, packages or artifacts, and a doubled subject is refused', () => {
  const artifact = BULLETIN({ subjects: [{ kind: 'artifact', key: ARTIFACT }] });
  assert.equal(artifact.subjects[0].digest, ARTIFACT);
  const bareDigest = BULLETIN({ subjects: [{ kind: 'artifact', key: 'c'.repeat(64) }] });
  assert.equal(bareDigest.subjects[0].digest, ARTIFACT, 'the two ways P6.2 publishes a digest mean one digest');
  throwsWith(() => BULLETIN({ subjects: [{ kind: 'artifact', key: 'not-a-digest' }] }), 'revocation.input');
  assert.match(throwsWith(() => BULLETIN({ subjects: [{ kind: 'identity', key: 'n8n-nodes-base.set' }] }), 'revocation.subject').message, /is not an identity 'type@typeVersion'/);
  assert.match(throwsWith(() => BULLETIN({ subjects: [{ kind: '@3.4' }] }), 'revocation.subject').message, /a bulletin denies identities, packages or artifacts/);
  throwsWith(() => BULLETIN({ subjects: [{ kind: 'workflow', key: 'x' }] }), 'revocation.subject');
  assert.match(
    throwsWith(() => BULLETIN({ subjects: [{ kind: 'package', key: 'p@1' }, { kind: 'package', key: 'p@1' }] }), 'revocation.subject').message,
    /nobody proofread/,
  );
  const many = Array.from({ length: MAX_SUBJECTS + 1 }, (_, index) => ({ kind: 'package', key: `p-${index}@1` }));
  throwsWith(() => BULLETIN({ subjects: many }), 'revocation.subject');
  // An identity and a package with the same text are different subjects: the kind is part of the name.
  const both = BULLETIN({ subjects: [{ kind: 'identity', key: 'p@1' }, { kind: 'package', key: 'p@1' }] });
  assert.equal(both.subjects.length, 2);
});

test('a digest is a digest of content, not of key order', () => {
  const bulletin = BULLETIN();
  const { bulletinDigest: digest, ...fields } = bulletin;
  assert.equal(digest, bulletinDigest(fields));
  assert.equal(stableJson({ b: 1, a: [{ d: 2, c: 3 }] }), stableJson({ a: [{ c: 3, d: 2 }], b: 1 }));
  assert.equal(normalizeDigest(`sha256:${'a'.repeat(64)}`), `sha256:${'a'.repeat(64)}`, 'a prefixed digest stays prefixed');
  assert.equal(normalizeDigest('a'.repeat(64)), `sha256:${'a'.repeat(64)}`, 'and a bare one becomes the same digest');
  assert.equal(normalizeDigest('c'.repeat(64)), `sha256:${'c'.repeat(64)}`);
  throwsWith(() => normalizeDigest(''), 'revocation.input');
  throwsWith(() => normalizeDigest('sha256:xyz'), 'revocation.input');
});

/* -------------------------------------------------------------------- chain */

test('the sequence makes a dropped or replaced emergency visible', () => {
  const first = BULLETIN();
  const second = SECOND(first);
  const third = SECOND(second, { issuedAt: 300, effectiveFrom: 300, expiresAt: 360, previousDigest: second.bulletinDigest });
  const verified = verifyBulletinSequence([third, first, second]);
  assert.equal(verified.ok, true);
  assert.equal(verified.length, 3);
  assert.equal(verified.head, third.bulletinDigest);

  const gap = verifyBulletinSequence([first, third]);
  assert.equal(gap.ok, false);
  assert.equal(gap.reason, 'revocation.sequence');
  assert.equal(gap.detail[0].kind, 'gap');
  assert.equal(gap.detail[0].expected, 2);

  const forked = SECOND(first, { issuedAt: 201, effectiveFrom: 201, expiresAt: 261, reason: 'a different second bulletin' });
  const fork = verifyBulletinSequence([first, second, forked]);
  assert.equal(fork.ok, false);
  const forkDetail = fork.detail.find((entry) => entry.kind === 'fork');
  assert.equal(forkDetail.sequence, 2);
  assert.equal(forkDetail.digests.length, 2);
  assert.match(fork.message, /something was dropped, replayed or replaced/);

  const unlinked = SECOND(first, { previousDigest: `sha256:${'e'.repeat(64)}` });
  const broken = verifyBulletinSequence([first, unlinked]);
  assert.equal(broken.ok, false);
  assert.equal(broken.detail[0].kind, 'unlinked');
  assert.equal(verifyBulletinSequence([]).ok, true);
  throwsWith(() => verifyBulletinSequence('nope'), 'revocation.input');
  throwsWith(() => verifyBulletinSequence([{ id: 'x' }]), 'revocation.input');
});

test('a witness refuses a replay without asking the registry, and fails closed without a first contact', () => {
  const first = BULLETIN();
  const second = SECOND(first);
  const witness = createBulletinWitness();
  assert.equal(isBulletinWitness(witness), true);
  throwsWith(() => witnessBulletin(witness, first), 'revocation.state');
  const held = witnessBulletin(witness, second, { firstContact: 1 });
  assert.equal(held.witnessed, true);
  assert.equal(witness.firstContact, 1);
  assert.equal(witnessBulletin(witness, second).witnessed, true, 'the same bulletin twice is not an event');
  throwsWith(() => witnessBulletin(witness, first, { firstContact: 7 }), 'revocation.state');

  const replay = witnessBulletin(witness, first);
  assert.equal(replay.ok, false);
  assert.match(replay.message, /this is a replay/);
  assert.equal(replay.detail.seen, 2);
  const forged = witnessBulletin(witness, SECOND(first, { reason: 'a different second bulletin', issuedAt: 201, effectiveFrom: 201, expiresAt: 261 }));
  assert.equal(forged.ok, false);
  assert.match(forged.message, /two bulletins claim one place in the sequence/);
  assert.equal(witness.sequences.get('emergency-1').digest, second.bulletinDigest, 'a refused bulletin does not overwrite what was witnessed');
  throwsWith(() => witnessBulletin(witness, { id: 'x' }), 'revocation.input');
  throwsWith(() => witnessBulletin({}, first), 'revocation.input');
});

/* --------------------------------------------------------------- evaluation */

test('a bulletin is pending, then active, then lapsed — and it never acts in the past', () => {
  const bulletin = BULLETIN();
  assert.equal(evaluateBulletin(bulletin, { tick: 99 }).state, 'pending');
  assert.equal(evaluateBulletin(bulletin, { tick: 100 }).state, 'active');
  assert.equal(evaluateBulletin(bulletin, { tick: 159 }).state, 'active');
  assert.equal(evaluateBulletin(bulletin, { tick: 160 }).state, 'lapsed');
  assert.match(evaluateBulletin(bulletin, { tick: 160 }).message, /lapsed at 160 and not yet disposed of/);
  throwsWith(() => evaluateBulletin(bulletin, { tick: 49 }), 'revocation.window');
  throwsWith(() => evaluateBulletin(bulletin, {}), 'revocation.input');
  throwsWith(() => evaluateBulletin({ id: 'x' }, { tick: 1 }), 'revocation.input');
});

test('disposing is how an emergency ends: upholding must land somewhere durable, lifting is on the record', () => {
  const bulletin = BULLETIN();
  throwsWith(() => disposeBulletin(bulletin, { disposition: 'forget', tick: 200, actor: 'a@b', reason: 'tired' }), 'revocation.disposition');
  throwsWith(() => disposeBulletin(bulletin, { disposition: 'uplift', tick: 200, actor: 'a@b', reason: 'x' }), 'revocation.disposition');
  throwsWith(() => disposeBulletin(bulletin, { disposition: 'lift', tick: 200, actor: '', reason: 'x' }), 'revocation.disposition');
  throwsWith(() => disposeBulletin(bulletin, { disposition: 'lift', tick: 200, actor: 'a@b', reason: '' }), 'revocation.disposition');
  throwsWith(() => disposeBulletin(bulletin, { disposition: 'lift', tick: 20, actor: 'a@b', reason: 'x' }), 'revocation.disposition');
  assert.match(
    throwsWith(() => disposeBulletin(bulletin, { disposition: 'uphold', tick: 200, actor: 'a@b', reason: 'x' }), 'revocation.disposition').message,
    /this contract denies work, it does not make a revocation permanent/,
  );
  const upheld = disposeBulletin(bulletin, { disposition: 'uphold', tick: 200, actor: 'a@b', reason: 'advisory confirmed', durableRef: 'revocation-list:entry-9' });
  assert.equal(isDisposition(upheld), true);
  assert.equal(upheld.durableRef, 'revocation-list:entry-9');
  assert.match(upheld.dispositionDigest, /^[0-9a-f]{64}$/);
  const lifted = disposeBulletin(bulletin, { disposition: 'lift', tick: 210, actor: 'a@b', reason: 'advisory retracted' });
  assert.equal(lifted.durableRef, null, 'a lift has nothing to make permanent');
  assert.equal(isDisposition({ disposition: 'lift' }), false);
  assert.equal(isDisposition(lifted), true);
});

/* ------------------------------------------------------------------ decision */

test('the decision denies while a bulletin acts, and a lapsed bulletin keeps denying until it is disposed of', () => {
  const bulletin = BULLETIN();
  const naming = { kind: 'identity', key: 'n8n-nodes-base.set@3.4' };
  const active = createBulletinView({ bulletins: [bulletin], tick: 120 });
  assert.equal(isBulletinView(active), true);
  const denied = decideSubject(active, naming);
  assert.equal(denied.decision, 'deny');
  assert.match(denied.basis, /active bulletin 'emergency-1' \(sequence 1\)/);
  assert.deepEqual([...denied.cites], [bulletin.bulletinDigest]);
  assert.equal(decideSubject(active, { kind: 'identity', key: 'n8n-nodes-base.if@2.2' }).decision, 'allow');

  const pending = createBulletinView({ bulletins: [bulletin], tick: 99 });
  assert.equal(decideSubject(pending, naming).decision, 'allow', 'a bulletin that has not taken effect has not taken effect');

  const lapsed = createBulletinView({ bulletins: [bulletin], tick: 200 });
  const stillDenied = decideSubject(lapsed, naming);
  assert.equal(stillDenied.decision, 'deny');
  assert.match(stillDenied.basis, /nobody disposed of it: an emergency that expires without a disposition is a decision nobody made/);

  const upheld = createBulletinView({ bulletins: [bulletin], dispositions: [disposeBulletin(bulletin, { disposition: 'uphold', tick: 200, actor: 'a@b', reason: 'confirmed', durableRef: 'revocation-list:entry-9' })], tick: 210 });
  assert.match(decideSubject(upheld, naming).basis, /upheld at tick 200 by a@b into revocation-list:entry-9/);

  const lifted = createBulletinView({ bulletins: [bulletin], dispositions: [disposeBulletin(bulletin, { disposition: 'lift', tick: 200, actor: 'a@b', reason: 'retracted' })], tick: 210 });
  const reopened = decideSubject(lifted, naming);
  assert.equal(reopened.decision, 'allow');
  assert.match(reopened.basis, /was lifted on the record/);
  assert.deepEqual([...reopened.cites], [bulletin.bulletinDigest], 'the record of the emergency survives the reopening');
});

test('a view reads the latest disposition and refuses a disposition that is older than one it already read', () => {
  const bulletin = BULLETIN();
  const uphold = disposeBulletin(bulletin, { disposition: 'uphold', tick: 200, actor: 'a@b', reason: 'confirmed', durableRef: 'revocation-list:entry-9' });
  const laterLift = disposeBulletin(bulletin, { disposition: 'lift', tick: 220, actor: 'c@d', reason: 'advisory retracted after review' });
  const ordered = createBulletinView({ bulletins: [bulletin], dispositions: [uphold, laterLift], tick: 230 });
  assert.equal(decideSubject(ordered, { kind: 'identity', key: 'n8n-nodes-base.set@3.4' }).decision, 'allow');
  assert.match(throwsWith(() => createBulletinView({ bulletins: [bulletin], dispositions: [laterLift, uphold], tick: 230 }), 'revocation.disposition').message, /resurrect a decision/);
  throwsWith(() => createBulletinView({ bulletins: [bulletin], dispositions: [{ disposition: 'lift' }], tick: 230 }), 'revocation.disposition');
  throwsWith(() => createBulletinView({ bulletins: [], tick: 1 }), 'revocation.input');
  throwsWith(() => createBulletinView({ bulletins: [bulletin] }), 'revocation.input');
  assert.equal(isBulletinView({ contract: BULLETIN_CONTRACT }), false);
});

test('a bulletin the channel cannot order is believed about nothing, and an unknown kind denies by refusal to answer', () => {
  const first = BULLETIN();
  const second = SECOND(first);
  const broken = verifyBulletinSequence([first, second]);
  assert.equal(broken.ok, true);
  const unlinked = createBulletinView({ bulletins: [second], tick: 220 });
  assert.equal(unlinked.sequenceOk, false, 'a sequence starting at 2 with nothing before it does not hold together');
  assert.equal(unlinked.sequenceDetail.detail[0].kind, 'orphan', 'a channel whose sequence starts in the middle is reported, not crashed into');
  const decision = decideSubject(unlinked, { kind: 'package', key: 'n8n-nodes-base@1.0.0' });
  assert.equal(decision.decision, 'deny');
  assert.equal(decision.reason, 'revocation.sequence');
  assert.match(decision.basis, /no bulletin here can be given the benefit of the doubt/);
  // A subject the broken channel does not name is still allowed: the denial is narrow on purpose.
  assert.equal(decideSubject(unlinked, { kind: 'package', key: 'n8n-nodes-slack@1.0.0' }).decision, 'allow');
  throwsWith(() => decideSubject(unlinked, { kind: 'namespace', key: 'x' }), 'revocation.subject');
  throwsWith(() => decideSubject(unlinked, { kind: 'identity', key: '' }), 'revocation.subject');
  throwsWith(() => decideSubject({}, { kind: 'identity', key: 'a@1' }), 'revocation.input');
});

test('an artifact subject is addressed by digest, and the two published spellings mean one subject', () => {
  const bulletin = BULLETIN({ subjects: [{ kind: 'artifact', key: ARTIFACT }] });
  const view = createBulletinView({ bulletins: [bulletin], tick: 120 });
  assert.equal(decideSubject(view, { kind: 'artifact', key: ARTIFACT }).decision, 'deny');
  assert.equal(decideSubject(view, { kind: 'artifact', key: 'c'.repeat(64) }).decision, 'deny');
  assert.equal(decideSubject(view, { kind: 'artifact', key: 'd'.repeat(64) }).decision, 'allow');
  assert.match(decideSubject(view, { kind: 'artifact', key: ARTIFACT }).cites[0], /^[0-9a-f]{64}$/);
  throwsWith(() => decideSubject(view, { kind: 'artifact', key: 'nope' }), 'revocation.input');
});

test('a bulletin issued against an epoch must not be applied to an older one', () => {
  const bulletin = BULLETIN({ baseline: EPOCH_TWO });
  assert.equal(appliesToEpoch(bulletin, EPOCH_TWO).applies, true);
  assert.equal(appliesToEpoch(bulletin, EPOCH_THREE).applies, true, 'a newer epoch is not older than the baseline');
  const older = appliesToEpoch(bulletin, EPOCH);
  assert.equal(older.ok, false);
  assert.equal(older.reason, 'revocation.epoch');
  assert.match(older.message, /a change cannot be un-seen by going back/);
  assert.deepEqual(older.detail, { baseline: 2, epoch: 1 });
  throwsWith(() => appliesToEpoch(bulletin, { epochDigest: EPOCH.epochDigest }), 'revocation.epoch');
  throwsWith(() => appliesToEpoch({ id: 'x' }, EPOCH), 'revocation.input');
});

test('describing a bulletin gives the counts an incident review opens with', () => {
  const bulletin = BULLETIN({ subjects: [{ kind: 'identity', key: 'n8n-nodes-base.set@3.4' }, { kind: 'package', key: 'n8n-nodes-base@1.0.0' }] });
  const described = describeBulletin(bulletin, { tick: 120 });
  assert.equal(described.id, 'emergency-1');
  assert.equal(described.sequence, 1);
  assert.equal(described.standing, 'active');
  assert.deepEqual(described.window, { from: 100, to: 160, ticks: 60 });
  assert.deepEqual([...described.subjects], ['identity:n8n-nodes-base.set@3.4', 'package:n8n-nodes-base@1.0.0']);
  assert.equal(described.disposed, null);
  assert.equal(Object.isFrozen(described), true);
  assert.match(explainBulletin(bulletin, { tick: 120 }), /bulletin emergency-1#1 \[active\] names 2 subjects until tick 160/);
  assert.equal(describeBulletin(bulletin, { tick: 99 }).standing, 'pending');

  const lifted = disposeBulletin(bulletin, { disposition: 'lift', tick: 190, actor: 'a@b', reason: 'retracted' });
  assert.match(explainBulletin(bulletin, { dispositions: [lifted], tick: 200 }), /was lifted at tick 190 by a@b/);
  assert.equal(describeBulletin(bulletin, { dispositions: [lifted], tick: 200 }).disposed.disposition, 'lift');
  throwsWith(() => describeBulletin({ id: 'x' }), 'revocation.input');
});

/* --------------------------------------------------------------------- walls */

test('the contract denies work and reads nothing else: no epoch chain, no attestation list, no clock', () => {
  const source = readFileSync(new URL('../src/lego/revocation-bulletin.mjs', import.meta.url), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const forbidden of ['node:fs', 'node:net', 'node:http', 'node:os', 'node:child_process', 'process.', 'Math.random', 'setTimeout', 'performance.', 'fetch(', 'node:vm', 'eval(']) {
    assert.equal(code.includes(forbidden), false, `the revocation contract must not reference ${forbidden}`);
  }
  assert.deepEqual([...code.matchAll(/from '(node:[a-z_/]+)'/g)].map((match) => match[1]), ['node:crypto']);
  assert.equal(/\bnew Date\b|\bDate\.now\b/.test(code), false, 'every answer takes the tick it answers for');
  for (const forbidden of ['./supply-chain.mjs', './registry-integrity.mjs', './node-health.mjs', './runtime-lease.mjs', './admission-explain.mjs', './canary-rollout.mjs', './sbom-policy.mjs']) {
    assert.equal(code.includes(forbidden), false, `P6.20 must not reach into ${forbidden}: a bulletin is a denial, not a second registry`);
  }
  assert.ok(code.includes("from './registry-compiler.mjs'"), 'the baseline guard is P6.2\'s, reused');
  for (const name of ['createRevocationList', 'revokeArtifact', 'verifyChain', 'appendEpoch']) {
    assert.equal(code.includes(name), false, `${name} belongs to another milestone: the emergency channel is not the durable path`);
  }
});

/* ------------------------------------------------------------------- lock row */

test('the contract-lock row is canonical: one row, version, ops, tests, exports, domain path', () => {
  const lock = JSON.parse(readFileSync(new URL('../src/lego/contracts/contract-lock.json', import.meta.url)));
  const rows = lock.contracts.filter((contract) => contract.id === 'node.revocation');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].version, BULLETIN_CONTRACT_VERSION);
  assert.equal(rows[0].domain, 'node-registry');
  assert.equal(rows[0].status, 'implemented');
  assert.deepEqual(rows[0].surface, ['src/lego/revocation-bulletin.mjs']);
  assert.deepEqual(rows[0].tests, ['apps/n8n-lego/test/lego-revocation-bulletin.test.mjs']);
  for (const name of ['issueBulletin', 'verifyBulletinSequence', 'witnessBulletin', 'evaluateBulletin', 'disposeBulletin', 'createBulletinView', 'decideSubject']) {
    assert.equal(rows[0].exports['src/lego/revocation-bulletin.mjs'].includes(name), true, `${name} must be locked`);
  }
  for (const id of ['node.registry', 'registry.compiler', 'node.supply-chain', 'registry.integrity', 'node.acceptance', 'node.admission', 'node.sbom', 'node.canary']) {
    assert.equal(lock.contracts.find((contract) => contract.id === id).version, '0.1.0', `P6.20 must not re-version ${id}`);
  }
  const domain = JSON.parse(readFileSync(new URL('../src/lego/manifest/domains.json', import.meta.url)))
    .domains.find((entry) => entry.id === 'node-registry');
  assert.equal(domain.contract.id, 'node.portability');
  assert.ok(domain.paths.includes('src/lego/revocation-bulletin.mjs'));
});
