/**
 * P6.29 — name claims, handovers and the confusion between them.
 * Contract `node.namespace@0.1.0`.
 *
 * Matrix: the surface, the name and its key, claims, the neighbours (typosquat and relatives),
 * reuse, handovers and their direction, visibility shadowing, the comparison, determinism and the
 * reads, the walls, and the lock row.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  CLAIM_VISIBILITIES,
  MAX_NAME_LENGTH,
  NAMESPACE_CONTRACT,
  NAMESPACE_CONTRACT_VERSION,
  NAMESPACE_FORMAT,
  NAMESPACE_OPERATIONS,
  NAMESPACE_PERMISSIONS,
  NAMESPACE_REASONS,
  NAMESPACE_RULES,
  NAMESPACE_SCHEMA_VERSION,
  NAMESPACE_VERDICTS,
  NamespaceError,
  claimName,
  createHandover,
  createNamespaceState,
  describeNamespace,
  effectivePublisher,
  explainNamespace,
  isHandover,
  isNameClaim,
  isNearConfusable,
  isNamespaceState,
  nameDistance,
  nameKey,
  namespaceDigest,
  normalizeName,
  resolveName,
  stableJson,
} from '../src/lego/namespace-confusion.mjs';

/* ------------------------------------------------------------------ fixtures */

const ALPHA = 'registry.example/alpha';
const BETA = 'registry.example/beta';

const CLAIMED = (name, { publisher = ALPHA, visibility = 'public', tick = 10 } = {}) => {
  const state = createNamespaceState();
  const claim = claimName(state, { name, publisher, visibility, tick });
  return { state, claim: claim.claim };
};

const throwsWith = (fn, code) => {
  let caught = null;
  try { fn(); } catch (error) { caught = error; }
  assert.ok(caught instanceof NamespaceError, `expected a NamespaceError carrying ${code}`);
  assert.equal(caught.code, 'lego.contract_violation');
  assert.equal(caught.meta.code, code);
  return caught;
};

/* ------------------------------------------------------------------ contract */

test('the contract surface is the published one: id, version, ops, closed vocabularies', () => {
  assert.equal(NAMESPACE_CONTRACT, 'node.namespace@0.1.0');
  assert.equal(NAMESPACE_CONTRACT_VERSION, '0.1.0');
  assert.equal(NAMESPACE_SCHEMA_VERSION, 1);
  assert.equal(NAMESPACE_FORMAT, 'lego-namespace@1');
  assert.equal(MAX_NAME_LENGTH, 214);
  assert.deepEqual([...NAMESPACE_OPERATIONS], ['claim', 'resolve', 'handover', 'compare', 'describe']);
  assert.deepEqual([...NAMESPACE_PERMISSIONS], ['node:read']);
  assert.deepEqual([...CLAIM_VISIBILITIES], ['public', 'private']);
  assert.deepEqual([...NAMESPACE_VERDICTS], ['same-publisher', 'handover', 'new-name', 'unknown', 'name-reused', 'typosquat', 'shadowed']);
  assert.equal(NAMESPACE_REASONS.length, 8);
  assert.match(NAMESPACE_RULES.key, /two spellings of one name are one name/);
  assert.match(NAMESPACE_RULES.ascii, /a name that needs a second look is a name that lies/);
  assert.match(NAMESPACE_RULES.authority, /never decides whether the node behind it may run/);
});

test('a name is folded to one spelling, and anything that needs a second look is refused by character', () => {
  assert.equal(normalizeName('Some-Node'), 'some-node');
  assert.equal(normalizeName('@Scope/Name'), '@scope/name');
  assert.equal(normalizeName('n8n-nodes-base.set_1'), 'n8n-nodes-base.set_1');
  assert.equal(nameKey('Some-Node'), nameKey('some-node'));
  assert.equal(nameKey('@Scope/Name'), '@scope/name');
  assert.equal(nameDistance('abc', 'abc'), 0);

  assert.match(throwsWith(() => normalizeName('n8n\u2011nodes'), 'namespace.name').message, /carries U\+2011 at position 3/);
  assert.match(throwsWith(() => normalizeName('Ünicode'), 'namespace.name').message, /carries U\+00DC at position 0/);
  assert.match(throwsWith(() => normalizeName('a b'), 'namespace.name').message, /carries whitespace: an invisible character is how two names are made to look like one/);
  assert.match(throwsWith(() => normalizeName(' spaced'), 'namespace.name').message, /has whitespace around it: a name with whitespace around it is not the name anybody means/);
  assert.match(throwsWith(() => normalizeName('@scope'), 'namespace.name').message, /is scoped and has no name after the scope: a scope is not a package/);
  assert.match(throwsWith(() => normalizeName('@scope/'), 'namespace.name').message, /the name after the scope in '@scope\/' is not a name/);
  assert.match(throwsWith(() => normalizeName('@-scope/x'), 'namespace.name').message, /the scope in '@-scope\/x' is not a scope/);
  assert.match(throwsWith(() => normalizeName('-scope/x'), 'namespace.name').message, /carries a slash and no scope/);
  assert.match(throwsWith(() => normalizeName('a/b'), 'namespace.name').message, /carries a slash and no scope/);
  assert.match(throwsWith(() => normalizeName('-leading'), 'namespace.name').message, /is not a name: names in this registry are ASCII letters/);
  throwsWith(() => normalizeName('a'.repeat(MAX_NAME_LENGTH + 1)), 'namespace.input');
  assert.equal(normalizeName('a'.repeat(MAX_NAME_LENGTH)), 'a'.repeat(MAX_NAME_LENGTH));
  throwsWith(() => normalizeName(''), 'namespace.input');
  throwsWith(() => normalizeName(42), 'namespace.input');
});

test('a name is claimed once, by key, and a second claim is a handover or a confusion', () => {
  const state = createNamespaceState();
  assert.equal(isNamespaceState(state), true);
  assert.equal(isNamespaceState({ claims: [] }), false);
  const claimed = claimName(state, { name: 'n8n-nodes-base.set', publisher: ALPHA, tick: 10 });
  assert.equal(claimed.ok, true);
  assert.equal(isNameClaim(claimed.claim), true);
  assert.equal(Object.isFrozen(claimed.claim), true);
  assert.equal(claimed.claim.name, 'n8n-nodes-base.set');
  assert.equal(claimed.claim.visibility, 'public');
  const { claimDigest, ...body } = claimed.claim;
  assert.equal(claimDigest, namespaceDigest(body));
  assert.match(claimed.message, /'n8n-nodes-base\.set' is claimed by registry\.example\/alpha \(public\) since tick 10/);

  assert.match(
    throwsWith(() => claimName(state, { name: 'n8n-nodes-base.set', publisher: BETA, tick: 20 }), 'namespace.claim').message,
    /is already claimed by registry\.example\/alpha since tick 10: a second claim is a handover or a confusion, never a quiet overwrite/,
  );
  assert.match(
    throwsWith(() => claimName(state, { name: 'N8N-Nodes-Base.Set', publisher: BETA, tick: 20 }), 'namespace.claim').message,
    /'N8N-Nodes-Base\.Set' is not a spelling that exists: it folds to 'n8n-nodes-base\.set', which is already claimed by registry\.example\/alpha — two spellings of one name are one name/,
  );
  assert.equal(state.claims.length, 1, 'a refused claim leaves nothing behind');
  throwsWith(() => claimName(state, { name: 'other', publisher: '', tick: 1 }), 'namespace.claim');
  throwsWith(() => claimName(state, { name: 'other', publisher: ALPHA, visibility: 'semi', tick: 1 }), 'namespace.input');
  throwsWith(() => claimName(state, { name: 'other', publisher: ALPHA }), 'namespace.input');
  throwsWith(() => claimName({}, { name: 'other', publisher: ALPHA, tick: 1 }), 'namespace.input');
});

/* --------------------------------------------------------------- resolution */

test('the publisher that holds a name keeps it, and a name nobody claimed is not a claim', () => {
  const { state, claim } = CLAIMED('n8n-nodes-base.set');
  const held = resolveName(state, { name: 'n8n-nodes-base.set', publisher: ALPHA, tick: 12 });
  assert.equal(held.ok, true);
  assert.equal(held.verdict, 'same-publisher');
  assert.equal(held.reason, null);
  assert.equal(held.claim.claimDigest, claim.claimDigest);
  assert.match(held.message, /'n8n-nodes-base\.set' has belonged to registry\.example\/alpha since tick 10/);
  assert.match(explainNamespace(held), /^n8n-nodes-base\.set: SAME-PUBLISHER — /);

  const unknown = resolveName(state, { name: 'never-heard-of-it', publisher: BETA, tick: 12 });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.verdict, 'unknown');
  assert.equal(unknown.reason, 'namespace.name');
  assert.match(unknown.message, /nothing in this registry has ever been called 'never-heard-of-it': an unknown name is not a claim on it/);
});

test('a name one edit from a name somebody holds is a confusion, unless the neighbour is the claimant', () => {
  const { state } = CLAIMED('n8n-nodes-base-set');
  const typo = resolveName(state, { name: 'n8n-nodes-base-sef', publisher: BETA, tick: 12 });
  assert.equal(typo.verdict, 'typosquat');
  assert.equal(typo.reason, 'namespace.typosquat');
  assert.equal(typo.ok, false);
  assert.deepEqual(typo.similar.map((entry) => ({ ...entry })), [{ name: 'n8n-nodes-base-set', publisher: ALPHA, distance: 1 }]);
  assert.match(typo.message, /nothing here has ever been called 'n8n-nodes-base-sef', and it is 1 edit\(s\) from 'n8n-nodes-base-set' \(registry\.example\/alpha\): a name that arrives one keystroke from another is how a package is swapped/);

  const relative = resolveName(state, { name: 'n8n-nodes-base-sef', publisher: ALPHA, tick: 12 });
  assert.equal(relative.verdict, 'new-name');
  assert.equal(relative.ok, true);
  assert.match(relative.message, /which registry\.example\/alpha already holds, so this is a relative rather than a swap/);

  const twoEdits = resolveName(state, { name: 'n8n-nodes-base-seff', publisher: BETA, tick: 12 });
  assert.equal(twoEdits.verdict, 'unknown', 'one edit is the bar, and it is stated rather than assumed');
  const widened = resolveName(state, { name: 'n8n-nodes-base-seff', publisher: BETA, tick: 12, policy: { maxDistance: 2 } });
  assert.equal(widened.verdict, 'typosquat');
  assert.equal(widened.similar[0].distance, 2);
  throwsWith(() => resolveName(state, { name: 'x', publisher: BETA, tick: 1, policy: { maxDistance: 0 } }), 'namespace.input');
  throwsWith(() => resolveName(state, { name: 'x', publisher: BETA, tick: 1, policy: [] }), 'namespace.input');
});

test('a name that changes hands quietly is refused: the name was somebody else\u2019s', () => {
  const { state } = CLAIMED('legacy-node');
  const taken = resolveName(state, { name: 'legacy-node', publisher: BETA, tick: 12 });
  assert.equal(taken.ok, false);
  assert.equal(taken.verdict, 'name-reused');
  assert.equal(taken.reason, 'namespace.reuse');
  assert.match(taken.message, /'legacy-node' has belonged to registry\.example\/alpha since tick 10 and registry\.example\/beta is asking for it: a name that changes hands quietly is how a dependency is swapped/);
});

test('a handover is declared, evidenced, and does not travel backwards', () => {
  const { state } = CLAIMED('legacy-node', { tick: 10 });
  const handed = createHandover(state, { name: 'legacy-node', from: ALPHA, to: BETA, tick: 100, evidence: 'RFC-0007 transfer notice' });
  assert.equal(handed.ok, true);
  assert.equal(isHandover(handed.handover), true);
  assert.equal(handed.handover.evidence, 'RFC-0007 transfer notice');
  assert.match(handed.message, /'legacy-node' is handed from registry\.example\/alpha to registry\.example\/beta at tick 100/);

  const accepted = resolveName(state, { name: 'legacy-node', publisher: BETA, tick: 100 });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.verdict, 'handover');
  assert.match(accepted.message, /changed hands from registry\.example\/alpha to registry\.example\/beta at tick 100 and this claim is at tick 100/);

  const early = resolveName(state, { name: 'legacy-node', publisher: BETA, tick: 99 });
  assert.equal(early.verdict, 'name-reused');
  assert.equal(early.reason, 'namespace.tick');
  assert.match(early.message, /a handover does not travel backwards: 'legacy-node' becomes registry\.example\/beta's at tick 100 and this claim is at tick 99/);

  const back = resolveName(state, { name: 'legacy-node', publisher: ALPHA, tick: 150 });
  assert.equal(back.verdict, 'name-reused');
  assert.match(back.message, /changed hands at tick 100 from registry\.example\/alpha to registry\.example\/beta: a name that has been handed over does not come back to registry\.example\/alpha/);

  const third = resolveName(state, { name: 'legacy-node', publisher: 'registry.example/gamma', tick: 150 });
  assert.equal(third.verdict, 'name-reused');
  assert.match(third.message, /changed hands at tick 100 \(registry\.example\/alpha → registry\.example\/beta\) and registry\.example\/gamma was never part of it: a third publisher arriving is not a handover/);

  assert.equal(effectivePublisher(state, 'legacy-node', 99).publisher, ALPHA);
  assert.equal(effectivePublisher(state, 'legacy-node', 99).via, 'claim');
  const after = effectivePublisher(state, 'legacy-node', 100);
  assert.equal(after.publisher, BETA);
  assert.equal(after.via, 'handover');
  assert.equal(after.since, 100);
  assert.match(after.message, /has belonged to registry\.example\/beta since the handover at tick 100/);
  const nothing = effectivePublisher(state, 'nothing-here', 100);
  assert.equal(nothing.ok, false);
  assert.match(nothing.message, /has never been claimed, so it has no publisher/);

  assert.match(throwsWith(() => createHandover(state, { name: 'unknown-name', from: ALPHA, to: BETA, tick: 5, evidence: 'x' }), 'namespace.handover').message, /has never been claimed/);
  assert.match(throwsWith(() => createHandover(state, { name: 'legacy-node', from: 'someone-else', to: 'registry.example/gamma', tick: 120, evidence: 'x' }), 'namespace.handover').message, /is held by 'registry\.example\/beta' and not by 'someone-else': a handover from somebody who does not hold the name is a wish/);
  assert.match(throwsWith(() => createHandover(state, { name: 'legacy-node', from: BETA, to: BETA, tick: 120, evidence: 'x' }), 'namespace.handover').message, /cannot be handed from 'registry\.example\/beta' to itself/);
  assert.match(throwsWith(() => createHandover(state, { name: 'legacy-node', from: BETA, to: 'registry.example/gamma', tick: 120, evidence: '' }), 'namespace.handover').message, /without evidence is a rumour with a timestamp/);
  throwsWith(() => createHandover(state, { name: 'legacy-node', from: BETA, to: 'registry.example/gamma', tick: 50, evidence: 'x' }), 'namespace.tick');
  throwsWith(() => createHandover(state, { name: 'legacy-node', from: BETA }), 'namespace.handover');
  assert.match(throwsWith(() => createHandover(state, { name: 'legacy-node', from: BETA, to: 'registry.example/gamma' }), 'namespace.handover').message, /without evidence is a rumour with a timestamp/);
  throwsWith(() => createHandover(state, { name: 'legacy-node', from: BETA, to: 'registry.example/gamma', evidence: 'x' }), 'namespace.input');
  throwsWith(() => createHandover({}, { name: 'legacy-node', from: BETA, to: 'registry.example/gamma', tick: 1, evidence: 'x' }), 'namespace.input');
});

test('visibility is part of the name: a public claim does not answer a private one, or the reverse', () => {
  const { state } = CLAIMED('internal-tool', { visibility: 'private' });
  const shadowed = resolveName(state, { name: 'internal-tool', publisher: ALPHA, tick: 12 });
  assert.equal(shadowed.ok, false);
  assert.equal(shadowed.verdict, 'shadowed');
  assert.equal(shadowed.reason, 'namespace.shadow');
  assert.match(shadowed.message, /a public claim does not answer the private name 'internal-tool': the public registry answering a private name is the oldest confusion there is/);
  const same = resolveName(state, { name: 'internal-tool', publisher: ALPHA, tick: 12, visibility: 'private' });
  assert.equal(same.verdict, 'same-publisher');
  assert.equal(same.ok, true);

  const { state: publicState } = CLAIMED('public-tool');
  const reversed = resolveName(publicState, { name: 'public-tool', publisher: ALPHA, tick: 12, visibility: 'private' });
  assert.equal(reversed.verdict, 'shadowed');
  assert.match(reversed.message, /a private claim does not answer the public name 'public-tool': 'public-tool' is claimed publicly by registry\.example\/alpha/);
});

/* ------------------------------------------------------ comparison and reads */

test('the comparison is symmetric and stated in edits, and one edit is what a confusion costs', () => {
  assert.equal(nameDistance('abcd', 'abdc'), 1, 'a transposition is one edit, and it is the cheapest confusion there is');
  assert.equal(nameDistance('abc', 'abcd'), 1);
  assert.equal(nameDistance('abc', 'xyz'), 3);
  assert.equal(nameDistance('abcd', 'abdc'), nameDistance('abdc', 'abcd'));
  assert.equal(isNearConfusable('abc', 'abc'), false, 'identical is not confusable: it is the same name');
  assert.equal(isNearConfusable('abc', 'abd'), true);
  assert.equal(isNearConfusable('abc', 'xyz'), false);
  assert.equal(isNearConfusable('abc', 'abd', { maxDistance: 0 }), false);
  assert.equal(isNearConfusable('abc', 'abd', { maxDistance: 1 }), true);
  throwsWith(() => nameDistance(1, 'a'), 'namespace.input');
  throwsWith(() => isNearConfusable('a', 'b', { maxDistance: -1 }), 'namespace.input');
  throwsWith(() => isNearConfusable('a', 'b', { maxDistance: 1.5 }), 'namespace.input');
});

test('the same question gives the same answer, and the census says what the names are', () => {
  const { state } = CLAIMED('n8n-nodes-base.set');
  claimName(state, { name: '@acme/internal', publisher: BETA, visibility: 'private', tick: 11 });
  createHandover(state, { name: 'n8n-nodes-base.set', from: ALPHA, to: BETA, tick: 100, evidence: 'transfer 0007' });

  const first = resolveName(state, { name: 'n8n-nodes-base.set', publisher: BETA, tick: 100 });
  const second = resolveName(state, { name: 'n8n-nodes-base.set', publisher: BETA, tick: 100 });
  const other = resolveName(state, { name: 'n8n-nodes-base.set', publisher: BETA, tick: 101 });
  assert.equal(first.decisionDigest, second.decisionDigest);
  assert.notEqual(first.decisionDigest, other.decisionDigest, 'a decision names the tick it was made at');
  assert.match(first.decisionDigest, /^[0-9a-f]{64}$/);

  assert.equal(stableJson({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } }), stableJson({ a: { c: [3, { e: 5, f: 4 }], d: 2 }, b: 1 }));
  const described = describeNamespace(state);
  assert.equal(described.format, NAMESPACE_FORMAT);
  assert.deepEqual([...described.publishers], [ALPHA, BETA]);
  assert.deepEqual({ ...described.counts }, { claims: 2, handovers: 1, private: 1 });
  assert.equal(described.handovers[0].from, ALPHA);
  assert.equal(described.handovers[0].to, BETA);
  assert.match(described.message, /2 name\(s\) claimed by 2 publisher\(s\), 1 handover\(s\)/);
  const { namespaceDigest: digest, ...census } = described;
  assert.equal(digest, namespaceDigest(census));
  assert.match(describeNamespace(createNamespaceState()).message, /no name has been claimed, so every name is a first contact/);

  throwsWith(() => resolveName(state, { name: 'x', publisher: '', tick: 1 }), 'namespace.input');
  throwsWith(() => resolveName(state, { name: 'x', publisher: ALPHA }), 'namespace.input');
  throwsWith(() => resolveName(state, { name: 'x', publisher: ALPHA, tick: 1, visibility: 'semi' }), 'namespace.input');
  throwsWith(() => resolveName({}, { name: 'x', publisher: ALPHA, tick: 1 }), 'namespace.input');
  throwsWith(() => describeNamespace({}), 'namespace.input');
  throwsWith(() => effectivePublisher(state, 'x'), 'namespace.input');
  throwsWith(() => explainNamespace({ verdict: 'probably' }), 'namespace.input');
});

/* --------------------------------------------------------------------- walls */

test('the namespace contract decides what a name means: it resolves nothing and runs nothing', () => {
  const source = readFileSync(new URL('../src/lego/namespace-confusion.mjs', import.meta.url), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const forbidden of ['node:fs', 'node:net', 'node:http', 'node:os', 'node:child_process', 'process.', 'Math.random', 'setTimeout', 'performance.', 'fetch(', 'node:vm', 'eval(', 'createSign', 'createVerify', 'subtle', 'privateKey']) {
    assert.equal(code.includes(forbidden), false, `the namespace contract must not reference ${forbidden}`);
  }
  assert.deepEqual([...code.matchAll(/from '(node:[a-z_/]+)'/g)].map((match) => match[1]), ['node:crypto']);
  assert.equal(/\bnew Date\b|\bDate\.now\b/.test(code), false);
  for (const forbidden of ['./resolution-manifest.mjs', './node-registry.mjs', './freshness.mjs', './provenance-log.mjs', './admission-explain.mjs', './registry-compiler.mjs', './sbom-policy.mjs', './supply-chain.mjs', './canary-rollout.mjs']) {
    assert.equal(code.includes(forbidden), false, `P6.29 must not reach into ${forbidden}: names are not epochs, admission or freshness`);
  }
  for (const name of ['resolveWorkflowNodes', 'compileRegistryEpoch', 'NODE_TRUST_CLASSES', 'signAttestation', 'evaluateFreshness', 'verifyInclusion', 'verifyAcceptanceReport']) {
    assert.equal(code.includes(name), false, `${name} belongs to another milestone: a name is not a workflow, an epoch or a trust class`);
  }
});

/* ------------------------------------------------------------------- lock row */

test('the contract-lock row is canonical: one row, version, ops, tests, exports, domain path', () => {
  const lock = JSON.parse(readFileSync(new URL('../src/lego/contracts/contract-lock.json', import.meta.url)));
  const rows = lock.contracts.filter((contract) => contract.id === 'node.namespace');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].version, NAMESPACE_CONTRACT_VERSION);
  assert.equal(rows[0].domain, 'node-registry');
  assert.equal(rows[0].status, 'implemented');
  assert.deepEqual(rows[0].surface, ['src/lego/namespace-confusion.mjs']);
  assert.deepEqual(rows[0].tests, ['apps/n8n-lego/test/lego-namespace-confusion.test.mjs']);
  for (const name of ['normalizeName', 'nameKey', 'claimName', 'createHandover', 'resolveName', 'effectivePublisher', 'describeNamespace']) {
    assert.equal(rows[0].exports['src/lego/namespace-confusion.mjs'].includes(name), true, `${name} must be locked`);
  }
  for (const id of ['node.registry', 'registry.freshness', 'node.provenance', 'node.abi', 'runtime.wasm-cache', 'node.supply-chain', 'registry.integrity', 'node.admission']) {
    assert.equal(lock.contracts.find((contract) => contract.id === id).version, '0.1.0', `P6.29 must not re-version ${id}`);
  }
  const domain = JSON.parse(readFileSync(new URL('../src/lego/manifest/domains.json', import.meta.url)))
    .domains.find((entry) => entry.id === 'node-registry');
  assert.equal(domain.contract.id, 'node.portability');
  assert.ok(domain.paths.includes('src/lego/namespace-confusion.mjs'));
});
