/**
 * P6.10 — Orphan / tombstone / alias / deprecation. Contract `node.lifecycle@0.1.0`.
 *
 * Matrix: the ledger of one epoch, the eleven foundation states (quoted, not
 * re-invented), the one irreversible thing (a tombstone) against the reversible
 * everything-else, one-hop aliases only, deprecations that must name a
 * replacement the epoch actually contains, the two halves of the orphan question
 * (a node nobody references, a reference nobody provides), and the scope walls.
 *
 * Epochs are real: they come from P6.2, built from P6.1 declarations.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { compileRegistryEpoch } from '../src/lego/registry-compiler.mjs';
import {
  LIFECYCLE_EVENTS,
  LIFECYCLE_INITIAL_STATE,
  LIFECYCLE_STATES,
  NODE_LIFECYCLE_CONTRACT,
  NODE_LIFECYCLE_CONTRACT_VERSION,
  NODE_LIFECYCLE_INPUT_SCHEMA_VERSION,
  NODE_LIFECYCLE_OPERATIONS,
  NODE_LIFECYCLE_PERMISSIONS,
  NODE_LIFECYCLE_REASONS,
  NODE_LIFECYCLE_RULES,
  NODE_LIFECYCLE_SCHEMA_VERSION,
  NodeLifecycleError,
  TOMBSTONE_GROUNDS,
  aliasNode,
  createLifecycleLedger,
  deprecateNode,
  describeLifecycle,
  isLifecycleLedger,
  isTombstoned,
  lifecycleOf,
  mayReuseName,
  orphanNodes,
  orphanReport,
  resolveAlias,
  tombstoneNode,
  transitionNode,
  verifyLifecycleLedger,
} from '../src/lego/node-lifecycle.mjs';

/* ------------------------------------------------------------------ fixtures */

const HTTP = 'n8n-nodes-base.httpRequest@4.4';
const SET = 'n8n-nodes-base.set@3.4';
const IF = 'n8n-nodes-base.if@2.2';

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
  discovery: { displayName: type, group: 'transform', description: 'x' },
  ...overrides,
});

const EPOCH = compileRegistryEpoch({
  declarations: [
    declaration('n8n-nodes-base.httpRequest', 4.4),
    declaration('n8n-nodes-base.set', 3.4),
    declaration('n8n-nodes-base.if', 2.2),
  ],
  source: 'p6.10-test',
});

const ledger = () => createLifecycleLedger(EPOCH);
const deprecated = () => deprecateNode(ledger(), HTTP, { replacedBy: SET, reason: 'superseded by set' }).ledger;
const aliased = () => aliasNode(deprecated(), HTTP, { to: SET, reason: 'renamed' }).ledger;
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
const refuses = (result, reason) => {
  assert.equal(result.ok, false, `expected a refusal, got ok:true`);
  assert.equal(result.reason, reason);
  return result;
};

/* ---------------------------------------------------------- contract surface */

test('the contract identifies itself, is versioned and declares its operations', () => {
  assert.equal(NODE_LIFECYCLE_CONTRACT, 'node.lifecycle@0.1.0');
  assert.equal(NODE_LIFECYCLE_CONTRACT_VERSION, '0.1.0');
  assert.equal(NODE_LIFECYCLE_SCHEMA_VERSION, 1);
  assert.equal(NODE_LIFECYCLE_INPUT_SCHEMA_VERSION, 1);
  assert.deepEqual([...NODE_LIFECYCLE_OPERATIONS], ['transition', 'deprecate', 'alias', 'tombstone', 'describe']);
  assert.deepEqual([...NODE_LIFECYCLE_PERMISSIONS], ['node:read']);
  assert.deepEqual([...LIFECYCLE_EVENTS], ['declare', 'transition', 'deprecate', 'alias', 'tombstone']);
  assert.deepEqual([...TOMBSTONE_GROUNDS], ['removed', 'renamed', 'compromised', 'superseded', 'policy']);
  for (const reason of NODE_LIFECYCLE_REASONS) assert.match(reason, /^lifecycle\.[a-z_]+$/);
  assert.equal(Object.isFrozen(NODE_LIFECYCLE_RULES), true);
  assert.match(NODE_LIFECYCLE_RULES.tombstone, /irreversible/);
  assert.match(NODE_LIFECYCLE_RULES.alias, /one hop/);
});

test('the states are P6.1\'s vocabulary, quoted rather than re-invented', async () => {
  const registry = await import('../src/lego/node-registry.mjs');
  assert.deepEqual([...LIFECYCLE_STATES], [...registry.NODE_LIFECYCLE_STATES]);
  assert.equal(LIFECYCLE_STATES.length, 11);
  for (const state of ['declared', 'deprecated', 'disabled', 'unloaded']) assert.ok(LIFECYCLE_STATES.includes(state));
  assert.equal(LIFECYCLE_INITIAL_STATE, 'declared');
  assert.equal(LIFECYCLE_STATES.includes(LIFECYCLE_INITIAL_STATE), true);
});

/* -------------------------------------------------------------------- ledger */

test('a ledger is built for one epoch, frozen, and every identity starts declared', () => {
  const subject = ledger();
  assert.equal(isLifecycleLedger(subject), true);
  assert.equal(subject.epochNumber, EPOCH.epochNumber);
  assert.equal(subject.epochDigest, EPOCH.epochDigest);
  assert.deepEqual(Object.keys(subject.entries), [HTTP, IF, SET]);
  for (const identity of Object.keys(subject.entries)) {
    assert.equal(subject.entries[identity].state, 'declared');
    assert.equal(subject.entries[identity].aliasOf, null);
    assert.equal(subject.entries[identity].deprecated, null);
    assert.equal(subject.entries[identity].tombstone, null);
  }
  assert.equal(Object.isFrozen(subject), true);
  assert.equal(Object.isFrozen(subject.entries[HTTP]), true);
  assert.deepEqual([...subject.events], []);
  assert.match(subject.ledgerDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(verifyLifecycleLedger(subject).ok, true);
  assert.equal(verifyLifecycleLedger(subject, EPOCH).ok, true);
});

test('a ledger needs a compiled epoch, and API misuse throws', () => {
  throwsWith(() => createLifecycleLedger({ epochNumber: 1, epochDigest: 'sha256:x' }), 'lifecycle.epoch');
  throwsWith(() => createLifecycleLedger({ epochNumber: 'one', epochDigest: 'sha256:x', identities: [] }), 'lifecycle.epoch');
  throwsWith(() => createLifecycleLedger(null), 'lifecycle.epoch');
  throwsWith(() => lifecycleOf({ ok: true }, HTTP), 'lego.contract_violation');
  throwsWith(() => lifecycleOf(ledger(), undefined), 'lifecycle.identity');
});

test('an identity outside the epoch cannot be governed', () => {
  throwsWith(() => lifecycleOf(ledger(), 'n8n-nodes-base.ghost@1'), 'lifecycle.identity');
  throwsWith(() => transitionNode(ledger(), 'n8n-nodes-base.ghost@1', { state: 'active', reason: 'x' }), 'lifecycle.identity');
  assert.equal(lifecycleOf(ledger(), IF).state, 'declared');
  assert.equal(lifecycleOf(ledger(), IF).identity, IF);
});

/* --------------------------------------------------------------- transitions */

test('a transition returns a new ledger and never touches the old one', () => {
  const before = ledger();
  const result = transitionNode(before, SET, { state: 'disabled', reason: 'maintenance window' });
  assert.equal(result.ok, true);
  assert.equal(result.changed, true);
  assert.equal(result.state, 'disabled');
  assert.notEqual(result.ledger, before);
  assert.equal(before.entries[SET].state, 'declared', 'the ledger handed in is untouched');
  assert.equal(result.ledger.entries[SET].state, 'disabled');
  assert.equal(verifyLifecycleLedger(result.ledger).ok, true);
  assert.equal(result.ledger.events.length, 1);
  assert.deepEqual(
    { event: result.ledger.events[0].event, state: result.ledger.events[0].state, reason: result.ledger.events[0].reason },
    { event: 'transition', state: 'disabled', reason: 'maintenance window' },
  );
});

test('states move backwards too: only the tombstone is irreversible', () => {
  const disabled = transitionNode(ledger(), SET, { state: 'disabled', reason: 'x' }).ledger;
  const active = transitionNode(disabled, SET, { state: 'active', reason: 'maintenance over' });
  assert.equal(active.ok, true);
  assert.equal(active.ledger.entries[SET].state, 'active');
  const noop = transitionNode(active.ledger, SET, { state: 'active', reason: 'again' });
  assert.equal(noop.ok, true);
  assert.equal(noop.changed, false);
  assert.equal(noop.ledger, active.ledger, 'a no-op returns the same ledger, not a new revision');
  assert.equal(active.ledger.events.length, 2);
});

test('transitions are validated: an unknown state, a missing reason, an epoch that goes backwards', () => {
  throwsWith(() => transitionNode(ledger(), SET, { state: 'vibing', reason: 'x' }), 'lifecycle.state');
  throwsWith(() => transitionNode(ledger(), SET, { state: 'active' }), 'lifecycle.input');
  throwsWith(() => transitionNode(ledger(), SET, { state: 'active', reason: '   ' }), 'lifecycle.input');
  throwsWith(() => transitionNode(ledger(), SET, { state: 'active', reason: 'x', atEpoch: 0 }), 'lifecycle.epoch');
  throwsWith(() => transitionNode(ledger(), SET, { state: 'active', reason: 'x', atEpoch: 1.5 }), 'lifecycle.epoch');
  const later = transitionNode(ledger(), SET, { state: 'idle', reason: 'x', atEpoch: EPOCH.epochNumber + 7 });
  assert.equal(later.ledger.events.at(-1).atEpoch, EPOCH.epochNumber + 7);
});

/* --------------------------------------------------------------- deprecation */

test('a deprecation names its replacement and the epoch it happened at', () => {
  const result = deprecateNode(ledger(), HTTP, { replacedBy: SET, reason: 'superseded by set' });
  assert.equal(result.ok, true);
  const entry = result.ledger.entries[HTTP];
  assert.equal(entry.state, 'deprecated');
  assert.deepEqual(entry.deprecated, { atEpoch: EPOCH.epochNumber, replacedBy: SET, reason: 'superseded by set' });
  assert.equal(result.ledger.events.at(-1).event, 'deprecate');
  assert.equal(result.ledger.events.at(-1).replacedBy, SET);
});

test('a deprecation that points nowhere is refused, and the node stays in service', () => {
  refuses(deprecateNode(ledger(), HTTP, { replacedBy: 'n8n-nodes-base.ghost@1', reason: 'x' }), 'lifecycle.replacement');
  throwsWith(() => deprecateNode(ledger(), HTTP, { reason: 'x' }), 'lifecycle.replacement');
  throwsWith(() => deprecateNode(ledger(), HTTP, { replacedBy: HTTP, reason: 'x' }), 'lifecycle.replacement');
  throwsWith(() => deprecateNode(ledger(), HTTP, { replacedBy: SET }), 'lifecycle.input');
  assert.equal(ledger().entries[HTTP].state, 'declared');
});

/* --------------------------------------------------------------------- alias */

test('an alias is one hop, and it resolves', () => {
  const result = aliasNode(deprecated(), HTTP, { to: SET, reason: 'renamed in 5.0' });
  assert.equal(result.ok, true);
  assert.equal(result.to, SET);
  assert.equal(result.ledger.entries[HTTP].aliasOf, SET);
  const resolved = resolveAlias(result.ledger, HTTP);
  assert.deepEqual({ ...resolved }, { identity: HTTP, aliased: true, target: SET, state: 'deprecated' });
  assert.deepEqual({ ...resolveAlias(result.ledger, SET) }, { identity: SET, aliased: false, target: null, state: 'declared' });
});

test('an alias exists for a retired name, and only for a retired name', () => {
  const inService = aliasNode(ledger(), SET, { to: IF, reason: 'x' });
  refuses(inService, 'lifecycle.alias');
  assert.match(inService.message, /still in service/);
  const disabled = transitionNode(ledger(), SET, { state: 'disabled', reason: 'x' }).ledger;
  assert.equal(aliasNode(disabled, SET, { to: IF, reason: 'x' }).ok, true, 'a disabled name may be aliased');
});

test('aliases do not chain, and their target must exist and be alive', () => {
  const chained = aliasNode(aliased(), IF, { to: HTTP, reason: 'x' });
  refuses(chained, 'lifecycle.alias_chain');
  assert.match(chained.message, /do not chain/);
  refuses(aliasNode(deprecated(), HTTP, { to: 'n8n-nodes-base.ghost@1', reason: 'x' }), 'lifecycle.alias');
  throwsWith(() => aliasNode(deprecated(), HTTP, { to: HTTP, reason: 'x' }), 'lifecycle.alias');
  throwsWith(() => aliasNode(deprecated(), HTTP, { reason: 'x' }), 'lifecycle.alias');
  throwsWith(() => aliasNode(deprecated(), HTTP, { to: SET }), 'lifecycle.input');
  const tombstonedTarget = tombstoneNode(ledger(), SET, { reason: 'compromised', grounds: 'compromised' }).ledger;
  const away = deprecateNode(tombstonedTarget, IF, { replacedBy: HTTP, reason: 'x' }).ledger;
  refuses(aliasNode(away, IF, { to: SET, reason: 'x' }), 'lifecycle.tombstoned');
});

/* ----------------------------------------------------------------- tombstone */

test('a tombstone is the only irreversible thing here', () => {
  const result = tombstoneNode(ledger(), SET, { reason: 'compromised package', grounds: 'compromised' });
  assert.equal(result.ok, true);
  assert.equal(result.atEpoch, EPOCH.epochNumber);
  const entry = result.ledger.entries[SET];
  assert.equal(entry.state, 'disabled');
  assert.deepEqual(entry.tombstone, { atEpoch: EPOCH.epochNumber, reason: 'compromised package', grounds: 'compromised' });
  assert.equal(isTombstoned(result.ledger, SET), true);
  assert.equal(isTombstoned(result.ledger, IF), false);
  assert.equal(mayReuseName(result.ledger, SET), false);
  assert.equal(mayReuseName(result.ledger, IF), true);
});

test('a tombstoned name never comes back to life, and the tombstone is not edited', () => {
  const tomb = tombstoneNode(ledger(), SET, { reason: 'compromised package', grounds: 'compromised' }).ledger;
  const moved = transitionNode(tomb, SET, { state: 'active', reason: 'please' });
  refuses(moved, 'lifecycle.tombstoned');
  assert.match(moved.message, /tombstoned/);
  refuses(deprecateNode(tomb, SET, { replacedBy: HTTP, reason: 'x' }), 'lifecycle.tombstoned');
  const identical = tombstoneNode(tomb, SET, { reason: 'compromised package', grounds: 'compromised' });
  assert.equal(identical.ok, true);
  assert.equal(identical.changed, false);
  assert.equal(identical.ledger, tomb);
  refuses(tombstoneNode(tomb, SET, { reason: 'other reason', grounds: 'policy' }), 'lifecycle.tombstoned');
});

test('tombstone grounds and reasons are validated', () => {
  throwsWith(() => tombstoneNode(ledger(), SET, { reason: 'x', grounds: 'vibes' }), 'lifecycle.input');
  throwsWith(() => tombstoneNode(ledger(), SET, {}), 'lifecycle.input');
  for (const grounds of TOMBSTONE_GROUNDS) {
    assert.equal(tombstoneNode(ledger(), SET, { reason: `because ${grounds}`, grounds }).ok, true);
  }
});

/* --------------------------------------------------- orphans and dangling refs */

test('an orphan is a node nobody references, and an uninstall never happens here', () => {
  const report = orphanReport(ledger(), { referenced: [SET, 'n8n-nodes-base.ghost@1'] });
  assert.deepEqual([...report.orphans], [HTTP, IF]);
  assert.deepEqual([...report.dangling], ['n8n-nodes-base.ghost@1']);
  assert.equal(report.referencedCount, 2);
  assert.equal(report.nodeCount, 3);
  assert.equal(Object.isFrozen(report.orphans), true);
  assert.deepEqual([...report.orphans], [...orphanNodes(ledger(), { referenced: [SET, 'n8n-nodes-base.ghost@1'] })]);
  assert.deepEqual([...report.orphans], [...report.orphans].sort());
});

test('retired names are not orphans: they are already accounted for', () => {
  const retired = tombstoneNode(aliased(), IF, { reason: 'removed', grounds: 'removed' }).ledger;
  assert.deepEqual([...orphanNodes(retired, { referenced: [] })], [SET]);
  const everything = orphanNodes(retired, { referenced: [SET] });
  assert.deepEqual([...everything], []);
  throwsWith(() => orphanNodes(ledger(), { referenced: SET }), 'lifecycle.input');
});

/* ----------------------------------------------------------- reads and verify */

test('describeLifecycle counts states and names the retirements', () => {
  const described = describeLifecycle(aliased());
  assert.equal(described.nodeCount, 3);
  assert.equal(described.byState.deprecated, 1);
  assert.equal(described.byState.declared, 2);
  assert.deepEqual([...described.deprecated], [HTTP]);
  assert.deepEqual({ ...described.aliases }, { [HTTP]: SET });
  assert.deepEqual([...described.tombstones], []);
  assert.equal(described.eventCount, 2);
  assert.equal(described.ledgerDigest, aliased().ledgerDigest, 'the ledger is a document: same decisions, same digest');
  assert.equal(Object.isFrozen(described), true);
});

test('verification catches an edited ledger and a foreign epoch', () => {
  const forged = Object.freeze({
    ...ledger(),
    entries: Object.freeze({ ...ledger().entries, [SET]: Object.freeze({ ...ledger().entries[SET], state: 'active' }) }),
  });
  const verdict = verifyLifecycleLedger(forged);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'lifecycle.ledger');
  assert.match(verdict.message, /digest/);
  const other = compileRegistryEpoch({ declarations: [declaration('n8n-nodes-base.noOp', 1)], source: 'p6.10-test' });
  const foreign = verifyLifecycleLedger(ledger(), other);
  assert.equal(foreign.ok, false);
  assert.equal(foreign.reason, 'lifecycle.epoch');
});

test('the error type is exported, and a governance refusal is data rather than an exception', () => {
  const error = new NodeLifecycleError('x');
  assert.equal(error instanceof Error, true);
  assert.equal(error.code, 'lego.contract_violation');
  assert.equal(Object.isFrozen(error.meta), true);
  assert.doesNotThrow(() => transitionNode(tombstoneNode(ledger(), SET, { reason: 'x', grounds: 'policy' }).ledger, SET, { state: 'active', reason: 'y' }));
});

/* ------------------------------------------------------------------ scope walls */

test('P6.10 is pure: the only node import is the hash, and there is no I/O', () => {
  const source = readFileSync(new URL('../src/lego/node-lifecycle.mjs', import.meta.url), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const forbidden of ['node:fs', 'node:net', 'node:http', 'node:os', 'node:child_process', 'process.', 'Math.random', 'setTimeout', 'performance.', 'fetch(']) {
    assert.equal(code.includes(forbidden), false, `the lifecycle ledger must not reference ${forbidden}`);
  }
  assert.deepEqual(
    [...code.matchAll(/from '(node:[a-z_/]+)'/g)].map((match) => match[1]),
    ['node:crypto'],
    'the only node import is the hash',
  );
  assert.equal(/\bnew Date\b|\bDate\.now\b/.test(code), false, 'atEpoch is data, not a clock reading');
  assert.ok(code.includes("from './node-registry.mjs'"), 'the state vocabulary is quoted from P6.1');
});

test('P6.10 stays inside its walls: no health, no admission, no resolution, no install', () => {
  const source = readFileSync(new URL('../src/lego/node-lifecycle.mjs', import.meta.url), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const forbidden of ['node-health', 'package-transaction', 'resolution-manifest', 'registry-closure', 'capability-compiler', 'node-residency', 'runtime-lease', 'quarantine', 'uninstall(']) {
    assert.equal(code.includes(forbidden), false, `P6.10 must not reach into ${forbidden}: that belongs to a later or different contract`);
  }
});

/* ------------------------------------------------------------------- lock row */

test('the contract-lock row is canonical: one row, version, ops, tests, exports, domain path', () => {
  const lock = JSON.parse(readFileSync(new URL('../src/lego/contracts/contract-lock.json', import.meta.url)));
  const rows = lock.contracts.filter((contract) => contract.id === 'node.lifecycle');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].version, NODE_LIFECYCLE_CONTRACT_VERSION);
  assert.equal(rows[0].domain, 'node-registry');
  assert.equal(rows[0].status, 'implemented');
  assert.deepEqual(rows[0].surface, ['src/lego/node-lifecycle.mjs']);
  assert.deepEqual(rows[0].tests, ['apps/n8n-lego/test/lego-node-lifecycle.test.mjs']);
  for (const name of ['createLifecycleLedger', 'deprecateNode', 'aliasNode', 'tombstoneNode', 'orphanReport', 'verifyLifecycleLedger']) {
    assert.equal(rows[0].exports['src/lego/node-lifecycle.mjs'].includes(name), true, `${name} must be locked`);
  }
  for (const id of ['node.registry', 'registry.compiler', 'package.transaction', 'registry.closure', 'node.resolution', 'runtime.lease', 'node.residency', 'node.capability', 'node.semantics']) {
    assert.equal(lock.contracts.find((contract) => contract.id === id).version, '0.1.0', `P6.10 must not re-version ${id}`);
  }
  const domain = JSON.parse(readFileSync(new URL('../src/lego/manifest/domains.json', import.meta.url)))
    .domains.find((entry) => entry.id === 'node-registry');
  assert.equal(domain.contract.id, 'node.portability');
  assert.ok(domain.paths.includes('src/lego/node-lifecycle.mjs'));
});
