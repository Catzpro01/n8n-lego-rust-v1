/**
 * P6.16 — Registry integrity chain + freshness / anti-rollback.
 * Contract `registry.integrity@0.1.0`.
 *
 * Matrix: the chain (links, digests, idempotent re-append), the three refusals
 * (monotonic, continuity, fork) told apart from each other, the recovery epoch that
 * is NOT a rollback, verification of a tampered/truncated/resealed/head-lying chain,
 * witnesses and the three freshness states, the rollback exception that must be
 * written down, the broken chain no exception may pass, and the scope walls.
 *
 * Epochs are real: P6.2 compiles them, parents included.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { compileRegistryEpoch } from '../src/lego/registry-compiler.mjs';
import {
  FRESHNESS_STATES,
  REGISTRY_INTEGRITY_CONTRACT,
  REGISTRY_INTEGRITY_CONTRACT_VERSION,
  REGISTRY_INTEGRITY_INPUT_SCHEMA_VERSION,
  REGISTRY_INTEGRITY_OPERATIONS,
  REGISTRY_INTEGRITY_PERMISSIONS,
  REGISTRY_INTEGRITY_REASONS,
  REGISTRY_INTEGRITY_RULES,
  REGISTRY_INTEGRITY_SCHEMA_VERSION,
  RegistryIntegrityError,
  appendEpoch,
  chainHead,
  checkFreshness,
  createIntegrityChain,
  describeChain,
  explainIntegrity,
  findLink,
  headEpochNumber,
  isIntegrityChain,
  isIntegrityLink,
  isWitnessReceipt,
  linkCount,
  verifyChain,
  verifyLink,
  witnessChain,
} from '../src/lego/registry-integrity.mjs';

/* ------------------------------------------------------------------ fixtures */

const declaration = (type, typeVersion, overrides = {}) => ({
  type,
  typeVersion,
  package: type.split('.')[0],
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
const IF = declaration('n8n-nodes-base.if', 2.2);
const EPOCH_1 = compileRegistryEpoch({ declarations: [SET], source: 'p6.16-genesis' });
const EPOCH_2 = compileRegistryEpoch({ declarations: [SET, IF], epochNumber: 2, source: 'p6.16-add-if', parent: EPOCH_1 });
const EPOCH_2_OTHER = compileRegistryEpoch({
  declarations: [SET, declaration('n8n-nodes-base.if', 2.2, { trustClass: 'community' })],
  epochNumber: 2, source: 'p6.16-fork', parent: EPOCH_1,
});
const EPOCH_3_RECOVERY = compileRegistryEpoch({ declarations: [SET], epochNumber: 3, source: 'p6.16-recovery', parent: EPOCH_2 });
const EPOCH_4_ORPHAN = compileRegistryEpoch({ declarations: [SET], epochNumber: 4, source: 'p6.16-orphan' });
const EPOCH_5_STANDALONE = compileRegistryEpoch({ declarations: [SET], epochNumber: 5, source: 'p6.16-start-at-5' });
const EPOCH_4_STANDALONE = compileRegistryEpoch({ declarations: [IF], epochNumber: 4, source: 'p6.16-go-back' });

const CHAIN = (() => {
  const first = appendEpoch(createIntegrityChain(), EPOCH_1);
  const second = appendEpoch(first.chain, EPOCH_2);
  return appendEpoch(second.chain, EPOCH_3_RECOVERY).chain;
})();

const stableJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
};
const digestOf = (value) => `sha256:${createHash('sha256').update(typeof value === 'string' ? value : stableJson(value), 'utf8').digest('hex')}`;

/** Rebuild the whole chain with link 1 replaced — the forgery the witness must catch. */
const resealedForgery = (chain) => {
  const links = [];
  let parent = null;
  for (const raw of chain.links) {
    const payload = {
      index: raw.index,
      epochNumber: raw.epochNumber,
      epochDigest: raw.index === 1 ? `sha256:${'7'.repeat(64)}` : raw.epochDigest,
      origin: raw.origin,
      source: raw.source,
      parentLinkDigest: parent,
    };
    const link = Object.freeze({ ...payload, linkDigest: digestOf(payload) });
    links.push(link);
    parent = link.linkDigest;
  }
  return Object.freeze({
    ok: true,
    schemaVersion: REGISTRY_INTEGRITY_SCHEMA_VERSION,
    contract: REGISTRY_INTEGRITY_CONTRACT,
    links: Object.freeze(links),
    head: links[links.length - 1],
    chainDigest: digestOf(links.map((link) => link.linkDigest)),
  });
};

const codeOf = (error) => [error.code, error.meta?.code, error.meta?.field].filter(Boolean);
const throwsWith = (fn, codes) => {
  const want = [].concat(codes);
  assert.throws(fn, (error) => {
    assert.ok(
      codeOf(error).some((code) => want.includes(code)),
      `expected ${want.join('|')}, got ${codeOf(error).join('|')}: ${error.message}`,
    );
    return true;
  });
};

/* ---------------------------------------------------------- contract surface */

test('the contract identifies itself, is versioned and declares its states', () => {
  assert.equal(REGISTRY_INTEGRITY_CONTRACT, 'registry.integrity@0.1.0');
  assert.equal(REGISTRY_INTEGRITY_CONTRACT_VERSION, '0.1.0');
  assert.equal(REGISTRY_INTEGRITY_SCHEMA_VERSION, 1);
  assert.equal(REGISTRY_INTEGRITY_INPUT_SCHEMA_VERSION, 1);
  assert.deepEqual([...REGISTRY_INTEGRITY_OPERATIONS], ['append', 'verify', 'freshness', 'witness', 'describe']);
  assert.deepEqual([...REGISTRY_INTEGRITY_PERMISSIONS], ['node:read']);
  assert.deepEqual([...FRESHNESS_STATES], ['current', 'rollback', 'unknown']);
  for (const reason of REGISTRY_INTEGRITY_REASONS) assert.match(reason, /^integrity\.[a-z_]+$/);
  assert.equal(Object.isFrozen(REGISTRY_INTEGRITY_RULES), true);
  assert.match(REGISTRY_INTEGRITY_RULES.monotonic, /FORK rather than a lag/);
  assert.match(REGISTRY_INTEGRITY_RULES.recovery, /NEW epoch carrying older content/);
  assert.match(REGISTRY_INTEGRITY_RULES.exception, /drift nobody noticed/);
  assert.match(REGISTRY_INTEGRITY_RULES.broken, /never a corrupt one/);
});

/* -------------------------------------------------------------------- chain */

test('an epoch is appended as a link whose digest covers its ancestor', () => {
  const empty = createIntegrityChain();
  assert.equal(isIntegrityChain(empty), true);
  assert.equal(linkCount(empty), 0);
  assert.equal(headEpochNumber(empty), null);
  assert.equal(explainIntegrity(empty), 'the integrity chain is empty');

  const first = appendEpoch(empty, EPOCH_1);
  assert.equal(first.ok, true);
  assert.equal(first.changed, true);
  assert.equal(first.link.index, 1);
  assert.equal(first.link.epochNumber, 1);
  assert.equal(first.link.parentLinkDigest, null, 'the first link points at nothing, not at a placeholder');
  assert.match(first.link.linkDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(isIntegrityLink(first.link), true);
  assert.equal(isIntegrityChain(first.chain), true);

  const second = appendEpoch(first.chain, EPOCH_2);
  assert.equal(second.link.parentLinkDigest, first.link.linkDigest, 'a link covers its ancestor by digest');
  const third = appendEpoch(second.chain, EPOCH_3_RECOVERY);
  assert.equal(third.link.parentLinkDigest, second.link.linkDigest);
  assert.equal(headEpochNumber(third.chain), 3);
  assert.equal(chainHead(third.chain).linkDigest, third.link.linkDigest);
  assert.equal(linkCount(third.chain), 3);
  assert.equal(findLink(third.chain, 2).epochNumber, 2);
  assert.equal(findLink(third.chain, 9), null);
  assert.equal(explainIntegrity(second).includes('appended as link 2'), true);
});

test('re-appending the identical epoch changes nothing', () => {
  const first = appendEpoch(createIntegrityChain(), EPOCH_1);
  const again = appendEpoch(first.chain, EPOCH_1);
  assert.equal(again.ok, true);
  assert.equal(again.changed, false);
  assert.equal(again.chain, first.chain, 'the chain object itself is reused, so nothing downstream can drift');
  assert.equal(again.link.linkDigest, first.link.linkDigest);
  assert.match(explainIntegrity(again), /already chained: nothing changed/);
});

test('the three refusals are told apart: monotonic, continuity, fork', () => {
  const chain = CHAIN;
  const fork = appendEpoch(chain, EPOCH_2_OTHER);
  assert.equal(fork.ok, false);
  assert.equal(fork.reason, 'integrity.fork', 'the same number with different bytes is a fork, not a lag');
  assert.equal(fork.forkOf, EPOCH_2.epochDigest);
  assert.equal(fork.chain, null);
  assert.match(fork.message, /fork rather than a lag/);

  const freshChain = appendEpoch(createIntegrityChain(), EPOCH_5_STANDALONE).chain;
  const backwards = appendEpoch(freshChain, EPOCH_4_STANDALONE);
  assert.equal(backwards.ok, false);
  assert.equal(backwards.reason, 'integrity.monotonic');
  assert.match(backwards.message, /is a set, not a chain/);

  const orphan = appendEpoch(chain, EPOCH_4_ORPHAN);
  assert.equal(orphan.ok, false);
  assert.equal(orphan.reason, 'integrity.continuity');
  assert.equal(orphan.expectedParent, chainHead(chain).epochDigest);
  assert.match(orphan.message, /is not part of it/);

  const firstWithParent = appendEpoch(createIntegrityChain(), EPOCH_2);
  assert.equal(firstWithParent.ok, false);
  assert.equal(firstWithParent.reason, 'integrity.continuity');
  assert.equal(firstWithParent.expectedParent, null);

  throwsWith(() => appendEpoch({}, EPOCH_1), 'lego.contract_violation');
  throwsWith(() => appendEpoch(chain, { epochNumber: 2 }), 'integrity.epoch');
});

test('a recovery epoch is not a rollback: higher number, older content', () => {
  const recovery = CHAIN.links[2];
  assert.equal(recovery.epochNumber, 3);
  assert.equal(EPOCH_3_RECOVERY.count, 1);
  assert.equal(EPOCH_2.count, 2);
  assert.notEqual(EPOCH_3_RECOVERY.contentDigest, EPOCH_2.contentDigest);
  assert.equal(EPOCH_3_RECOVERY.parentEpochDigest, EPOCH_2.epochDigest, 'the recovery epoch says which history it continues');
  const origins = describeChain(CHAIN).origins;
  assert.ok(origins.length >= 1);
  assert.equal(origins.every((origin) => typeof origin === 'string'), true);
  assert.equal(verifyChain(CHAIN).ok, true);
});

/* ----------------------------------------------------------------- verify */

test('a chain verifies itself: digests, continuity, numbering, head', () => {
  const verified = verifyChain(CHAIN);
  assert.equal(verified.ok, true);
  assert.equal(verified.verified, true);
  assert.equal(verified.linkCount, 3);
  assert.equal(verified.headEpochNumber, 3);
  assert.equal(verified.chainDigest, CHAIN.chainDigest);
  assert.equal(verified.message, null);
  assert.equal(verifyChain(createIntegrityChain()).ok, true, 'an empty chain is trivially intact');
});

test('every way a chain can be edited is caught', () => {
  const editedLink = Object.freeze({
    ...CHAIN,
    links: Object.freeze([{ ...CHAIN.links[0], epochDigest: `sha256:${'5'.repeat(64)}` }, CHAIN.links[1], CHAIN.links[2]]),
  });
  const edited = verifyChain(editedLink);
  assert.equal(edited.ok, false);
  assert.equal(edited.failures.some((failure) => failure.field === 'linkDigest'), true);
  assert.match(edited.message, /edited after it was appended/);

  const truncated = Object.freeze({ ...CHAIN, links: Object.freeze([CHAIN.links[0]]), head: CHAIN.links[0] });
  const cut = verifyChain(truncated);
  assert.equal(cut.ok, false);
  assert.equal(cut.failures.some((failure) => failure.field === 'chainDigest'), true);

  const fakeDigest = Object.freeze({ ...CHAIN, chainDigest: `sha256:${'6'.repeat(64)}` });
  assert.equal(verifyChain(fakeDigest).ok, false);

  const lyingHead = Object.freeze({ ...CHAIN, head: CHAIN.links[0] });
  const headFailure = verifyChain(lyingHead);
  assert.equal(headFailure.ok, false);
  assert.equal(headFailure.failures.some((failure) => failure.field === 'head'), true);
  assert.match(headFailure.message, /a head that is not the end is how a truncation hides/);

  const reordered = Object.freeze({ ...CHAIN, links: Object.freeze([CHAIN.links[1], CHAIN.links[0], CHAIN.links[2]]) });
  const outOfOrder = verifyChain(reordered);
  assert.equal(outOfOrder.ok, false);
  assert.equal(outOfOrder.failures.some((failure) => failure.code === 'integrity.monotonic' || failure.field === 'parentLinkDigest'), true);
});

test('a link proves one epoch and refuses a substitute', () => {
  const link = findLink(CHAIN, 1);
  assert.equal(verifyLink(link, EPOCH_1).ok, true);
  const substituted = verifyLink(link, EPOCH_2);
  assert.equal(substituted.ok, false);
  assert.match(substituted.message, /is not part of this history/);
  assert.equal(substituted.linkEpochDigest, link.epochDigest);
  assert.equal(substituted.epochDigest, EPOCH_2.epochDigest);
  throwsWith(() => verifyLink({ nope: true }, EPOCH_1), 'integrity.link');
});

/* ------------------------------------------------- witnesses and freshness */

test('a witness is what a client remembers: the head, its link and its digest', () => {
  const witness = witnessChain(CHAIN, { witnessId: 'client-1', tick: 10, installationId: 'install-9' });
  assert.equal(isWitnessReceipt(witness), true);
  assert.equal(witness.epochNumber, 3);
  assert.equal(witness.linkDigest, chainHead(CHAIN).linkDigest);
  assert.equal(witness.chainDigest, CHAIN.chainDigest);
  assert.equal(witness.linkCount, 3);
  assert.equal(witness.installationId, 'install-9');
  assert.match(witness.witnessDigest, /^sha256:[0-9a-f]{64}$/);
  throwsWith(() => witnessChain(CHAIN, { tick: 1 }), 'integrity.witness');
  throwsWith(() => witnessChain(CHAIN, { witnessId: 'w' }), 'integrity.input');
  throwsWith(() => witnessChain(createIntegrityChain(), { witnessId: 'w', tick: 1 }), 'integrity.witness');
});

test('freshness has three states and says how far behind the client is', () => {
  const head = witnessChain(CHAIN, { witnessId: 'client-head', tick: 10 });
  const current = checkFreshness(CHAIN, { witness: head });
  assert.equal(current.ok, true);
  assert.equal(current.state, 'current');
  assert.equal(current.fresh, true);
  assert.equal(current.detail.behindBy, 0);
  assert.equal(current.message, null);

  const behind = witnessChain(appendEpoch(createIntegrityChain(), EPOCH_1).chain, { witnessId: 'client-old', tick: 5 });
  const catchingUp = checkFreshness(CHAIN, { witness: behind });
  assert.equal(catchingUp.ok, true);
  assert.equal(catchingUp.state, 'current');
  assert.equal(catchingUp.fresh, false);
  assert.equal(catchingUp.detail.behindBy, 2);
  assert.match(catchingUp.message, /2 epoch\(s\) to catch up/);
  assert.match(explainIntegrity(current), /freshness: current/);
});

test('no recall fails closed, and first contact must be stated', () => {
  const refused = checkFreshness(CHAIN, {});
  assert.equal(refused.ok, false);
  assert.equal(refused.state, 'unknown');
  assert.equal(refused.detail.reason, 'integrity.witness');
  assert.match(refused.message, /cannot detect a rollback/);

  const first = checkFreshness(CHAIN, { firstContact: true });
  assert.equal(first.ok, true);
  assert.equal(first.state, 'unknown');
  assert.equal(first.fresh, false);
  assert.equal(first.detail.firstContact, true);
  assert.match(first.message, /NEXT rollback detectable/);
  assert.match(explainIntegrity(first), /freshness: unknown/);
  throwsWith(() => checkFreshness({}, { firstContact: true }), 'lego.contract_violation');
  throwsWith(() => checkFreshness(createIntegrityChain(), { firstContact: true }), 'integrity.input');
  throwsWith(() => checkFreshness(CHAIN, { witness: { ok: true, epochNumber: 1 } }), 'integrity.witness');
});

test('a rollback is refused: older chain, lost link, and a rewritten history', () => {
  const witness = witnessChain(CHAIN, { witnessId: 'client-3', tick: 10 });

  const shorter = appendEpoch(createIntegrityChain(), EPOCH_1).chain;
  const older = checkFreshness(shorter, { witness });
  assert.equal(older.ok, false);
  assert.equal(older.state, 'rollback');
  assert.equal(older.accepted, false);
  assert.equal(older.detail.witnessedEpochNumber, 3);
  assert.equal(older.detail.headEpochNumber, 1);
  assert.match(older.message, /older than what the client remembers/);
  assert.match(explainIntegrity(older), /ROLLBACK — refused/);

  const startsLater = appendEpoch(createIntegrityChain(), EPOCH_5_STANDALONE).chain;
  const witnessTwo = witnessChain(appendEpoch(appendEpoch(createIntegrityChain(), EPOCH_1).chain, EPOCH_2).chain, { witnessId: 'client-2', tick: 5 });
  const missing = checkFreshness(startsLater, { witness: witnessTwo });
  assert.equal(missing.ok, false);
  assert.equal(missing.detail.missing, true);
  assert.match(missing.message, /lost a link it used to have/);
});

test('a chain that does not verify cannot be excepted, and a resealed forgery is caught by the witness', () => {
  const witness = witnessChain(CHAIN, { witnessId: 'client-x', tick: 3 });
  const editedBehindHead = Object.freeze({
    ...CHAIN,
    links: Object.freeze([{ ...CHAIN.links[0], linkDigest: `sha256:${'4'.repeat(64)}` }, CHAIN.links[1], CHAIN.links[2]]),
  });
  const broken = checkFreshness(editedBehindHead, { witness });
  assert.equal(broken.ok, false);
  assert.equal(broken.detail.broken, true);
  assert.match(broken.message, /never a corrupt one/);
  const exceptedBroken = checkFreshness(editedBehindHead, {
    witness, rollbackException: { reason: 'restored', actor: 'operator', tick: 99 },
  });
  assert.equal(exceptedBroken.ok, false, 'an exception accepts an older registry, never a corrupt one');
  assert.equal(exceptedBroken.exception, null);

  const forgery = resealedForgery(CHAIN);
  assert.equal(verifyChain(forgery).ok, true, 'the forgery is internally consistent — that is what makes it dangerous');
  const caught = checkFreshness(forgery, { witness });
  assert.equal(caught.ok, false);
  assert.equal(caught.state, 'rollback');
  assert.equal(caught.detail.rewritten, true);
  assert.match(caught.message, /history was rewritten/);
});

test('a rollback can be accepted, on the record', () => {
  const witness = witnessChain(CHAIN, { witnessId: 'client-rec', tick: 10 });
  const shorter = appendEpoch(createIntegrityChain(), EPOCH_1).chain;
  const accepted = checkFreshness(shorter, {
    witness,
    rollbackException: { reason: 'restored from the airgap mirror', actor: 'operator-7', tick: 99 },
  });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.state, 'rollback');
  assert.equal(accepted.fresh, false);
  assert.deepEqual({ ...accepted.exception }, { reason: 'restored from the airgap mirror', actor: 'operator-7', tick: 99 });
  assert.match(accepted.message, /decision somebody made rather than a drift nobody noticed/);
  assert.match(explainIntegrity(accepted), /accepted under an explicit exception/);

  const nameless = checkFreshness(shorter, { witness, rollbackException: { reason: 'restored', tick: 99 } });
  assert.equal(nameless.exception.actor, null, 'an unnamed actor is recorded as unnamed, not invented');
  throwsWith(() => checkFreshness(shorter, { witness, rollbackException: { reason: 'restored' } }), 'integrity.input');
  throwsWith(() => checkFreshness(shorter, { witness, rollbackException: {} }), 'integrity.input');
});

/* ------------------------------------------------------------ reads, walls */

test('describing and explaining a chain is what an operations page reads', () => {
  const described = describeChain(CHAIN);
  assert.equal(described.linkCount, 3);
  assert.equal(described.firstEpochNumber, 1);
  assert.equal(described.headEpochNumber, 3);
  assert.equal(described.headEpochDigest, EPOCH_3_RECOVERY.epochDigest);
  assert.equal(described.headLinkDigest, chainHead(CHAIN).linkDigest);
  assert.equal(Object.isFrozen(described), true);
  assert.match(explainIntegrity(CHAIN), /integrity chain: 3 link\(s\), epochs 1…3/);
  const refused = appendEpoch(CHAIN, EPOCH_4_ORPHAN);
  assert.match(explainIntegrity(refused), /append refused: integrity\.continuity/);
  throwsWith(() => explainIntegrity(42), 'lego.contract_violation');
  throwsWith(() => describeChain({}), 'lego.contract_violation');
  throwsWith(() => chainHead({}), 'lego.contract_violation');
  throwsWith(() => findLink(CHAIN, 'x'), 'integrity.input');
  const error = new RegistryIntegrityError('x');
  assert.equal(error instanceof Error, true);
  assert.equal(error.code, 'lego.contract_violation');
  assert.equal(Object.isFrozen(error.meta), true);
});

test('P6.16 is pure: the only node import is the hash, and no clock decides freshness', () => {
  const source = readFileSync(new URL('../src/lego/registry-integrity.mjs', import.meta.url), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const forbidden of ['node:fs', 'node:net', 'node:http', 'node:os', 'node:child_process', 'process.', 'Math.random', 'setTimeout', 'performance.', 'fetch(', 'node:vm', 'eval(']) {
    assert.equal(code.includes(forbidden), false, `the integrity chain must not reference ${forbidden}`);
  }
  assert.deepEqual([...code.matchAll(/from '(node:[a-z_/]+)'/g)].map((match) => match[1]), ['node:crypto']);
  assert.equal(/\bnew Date\b|\bDate\.now\b/.test(code), false);
  assert.ok(code.includes("from './registry-compiler.mjs'"), 'the epoch guard is P6.2\'s, reused');
});

test('P6.16 stays inside its walls: it records history, it does not publish, sign or repair', () => {
  const source = readFileSync(new URL('../src/lego/registry-integrity.mjs', import.meta.url), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const forbidden of ['./supply-chain.mjs', './node-health.mjs', './worker-convergence.mjs', './node-lifecycle.mjs', 'publishRegistryEpoch(', 'rollbackRegistryEpoch(', 'compileRegistryEpoch(', 'createHmac', 'createVerify', 'spawn', 'node:vm']) {
    assert.equal(code.includes(forbidden), false, `P6.16 must not reach into ${forbidden}: signatures, trust delegation and repair belong to other contracts`);
  }
  assert.match(REGISTRY_INTEGRITY_RULES.authority, /never says the nodes are safe to run/);
});

/* ------------------------------------------------------------------- lock row */

test('the contract-lock row is canonical: one row, version, ops, tests, exports, domain path', () => {
  const lock = JSON.parse(readFileSync(new URL('../src/lego/contracts/contract-lock.json', import.meta.url)));
  const rows = lock.contracts.filter((contract) => contract.id === 'registry.integrity');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].version, REGISTRY_INTEGRITY_CONTRACT_VERSION);
  assert.equal(rows[0].domain, 'node-registry');
  assert.equal(rows[0].status, 'implemented');
  assert.deepEqual(rows[0].surface, ['src/lego/registry-integrity.mjs']);
  assert.deepEqual(rows[0].tests, ['apps/n8n-lego/test/lego-registry-integrity.test.mjs']);
  for (const name of ['createIntegrityChain', 'appendEpoch', 'verifyChain', 'witnessChain', 'checkFreshness']) {
    assert.equal(rows[0].exports['src/lego/registry-integrity.mjs'].includes(name), true, `${name} must be locked`);
  }
  for (const id of ['node.registry', 'registry.compiler', 'package.transaction', 'registry.closure', 'node.resolution', 'runtime.lease', 'node.residency', 'node.capability', 'node.semantics', 'node.lifecycle', 'node.health', 'node.supply-chain', 'registry.incremental', 'node.worker-convergence', 'node.acceptance']) {
    assert.equal(lock.contracts.find((contract) => contract.id === id).version, '0.1.0', `P6.16 must not re-version ${id}`);
  }
  const domain = JSON.parse(readFileSync(new URL('../src/lego/manifest/domains.json', import.meta.url)))
    .domains.find((entry) => entry.id === 'node-registry');
  assert.equal(domain.contract.id, 'node.portability');
  assert.ok(domain.paths.includes('src/lego/registry-integrity.mjs'));
});
