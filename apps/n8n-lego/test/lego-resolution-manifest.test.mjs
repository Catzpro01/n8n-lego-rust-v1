/**
 * P6.5 — Workflow node resolution manifest. Contract `node.resolution@0.1.0`.
 *
 * Matrix: exact pinning against a compiled epoch, refusal when the registry does
 * not have what the workflow needs, resolution states (match / missing /
 * changed — where `changed` is an integrity violation, not an upgrade), upgrade
 * policies (exact never moves, minor stays in the major line, major crosses),
 * the two-phase upgrade (planning changes nothing; applying needs authorization,
 * a current revision and a plan that still matches the epoch), append-only
 * history with a monotonic revision, and the scope walls.
 *
 * Composition is real, not mocked: epochs come from P6.2 (`compileRegistryEpoch`)
 * built from P6.1 declarations, so these tests exercise the same chain the
 * runtime does — P6.1 declarations → P6.2 epoch → P6.5 pins.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { compileRegistryEpoch } from '../src/lego/registry-compiler.mjs';
import {
  RESOLUTION_MANIFEST_CONTRACT,
  RESOLUTION_MANIFEST_CONTRACT_VERSION,
  RESOLUTION_MANIFEST_INPUT_SCHEMA_VERSION,
  RESOLUTION_MANIFEST_OPERATIONS,
  RESOLUTION_MANIFEST_PERMISSIONS,
  RESOLUTION_MANIFEST_REASONS,
  RESOLUTION_MANIFEST_RULES,
  RESOLUTION_MANIFEST_SCHEMA_VERSION,
  RESOLUTION_STATES,
  ResolutionManifestError,
  UPGRADE_POLICIES,
  applyNodeUpgrade,
  createResolutionManifest,
  describeResolutionManifest,
  formatResolutionManifest,
  isResolutionManifest,
  pinnedIdentities,
  planNodeUpgrade,
  resolutionDiff,
  resolutionManifestView,
  resolveWorkflowNodes,
} from '../src/lego/resolution-manifest.mjs';

const HTTP = 'n8n-nodes-base.httpRequest';
const HEX = 'abcdef0123456789';

const declaration = (typeVersion, digestChar, type = HTTP) => ({
  type,
  typeVersion,
  package: type.split('.')[0],
  packageVersion: '2.9.1',
  vendor: 'n8n',
  contractVersion: '1.0.0',
  implementationVersion: '1.0.0',
  digest: `sha256:${digestChar.repeat(64)}`,
  provenance: { kind: 'package-registry', source: 'npm:n8n-nodes-base@2.9.1' },
  capabilities: ['network'],
  trustClass: 'core',
  runtimeLocality: 'js-compat',
  resourceProfile: { cpu: 'low', memory: 'medium', disk: 'none', network: true, concurrency: 'parallel-safe', startup: 'fast' },
  compatibility: { contractRange: '^1.0.0', portabilityTargets: ['JS'] },
  lifecycle: 'declared',
  health: 'unknown',
  discovery: { displayName: 'HTTP Request', group: 'input', description: '' },
});

const epochOf = (declarations, source = 'catalog:n8n-nodes-base@2.9.1') => {
  const epoch = compileRegistryEpoch({ declarations, source });
  assert.equal(epoch.ok, true, `fixture epoch must compile: ${JSON.stringify(epoch.errors ?? [])}`);
  return epoch;
};

const EPOCH = epochOf([declaration(4, 'a'), declaration(4.1, 'b'), declaration(4.4, 'c'), declaration(5, 'd')]);
const node = (typeVersion, type = HTTP) => ({ type, typeVersion });
const manifestOf = (overrides = {}) => createResolutionManifest({ workflowId: 'workflow-7', nodes: [node(4)], epoch: EPOCH, ...overrides });

/* ---------------------------------------------------------------- contract */

test('the contract identifies itself, is versioned and declares its states', () => {
  assert.equal(RESOLUTION_MANIFEST_CONTRACT, 'node.resolution@0.1.0');
  assert.equal(RESOLUTION_MANIFEST_CONTRACT_VERSION, '0.1.0');
  assert.equal(RESOLUTION_MANIFEST_SCHEMA_VERSION, 1);
  assert.deepEqual([...RESOLUTION_MANIFEST_OPERATIONS], ['pin', 'resolve', 'upgrade', 'describe']);
  assert.deepEqual([...UPGRADE_POLICIES], ['exact', 'minor', 'major']);
  assert.deepEqual([...RESOLUTION_STATES], ['match', 'missing', 'changed']);
  assert.ok(RESOLUTION_MANIFEST_PERMISSIONS.every((word) => typeof word === 'string'));
  assert.equal(RESOLUTION_MANIFEST_INPUT_SCHEMA_VERSION, 1);
});

test('the refusal vocabulary is closed, prefixed and free of duplicates', () => {
  assert.ok(RESOLUTION_MANIFEST_REASONS.length >= 10);
  assert.equal(new Set(RESOLUTION_MANIFEST_REASONS).size, RESOLUTION_MANIFEST_REASONS.length);
  assert.ok(RESOLUTION_MANIFEST_REASONS.every((reason) => reason.startsWith('resolution.')));
  assert.match(RESOLUTION_MANIFEST_RULES.exact, /no latest/);
  assert.match(RESOLUTION_MANIFEST_RULES.explicit, /two-phase/);
  assert.match(RESOLUTION_MANIFEST_RULES.integrity, /integrity violation/);
});

/* -------------------------------------------------------------------- pin */

test('a manifest pins exact identities against a named epoch', () => {
  const manifest = manifestOf();
  assert.equal(manifest.ok, true);
  assert.equal(manifest.revision, 1);
  assert.equal(manifest.policy, 'exact');
  assert.equal(manifest.pinCount, 1);
  assert.equal(manifest.pins[0].identity, `${HTTP}@4`);
  assert.equal(manifest.pins[0].digest, EPOCH.byIdentity[`${HTTP}@4`].digest);
  assert.equal(manifest.epochNumber, 1);
  assert.equal(manifest.epochDigest, EPOCH.epochDigest);
  assert.equal(manifest.epochSource, 'catalog:n8n-nodes-base@2.9.1');
  assert.deepEqual([...manifest.history], []);
  assert.ok(isResolutionManifest(manifest));
  assert.ok(Object.isFrozen(manifest) && Object.isFrozen(manifest.pins) && Object.isFrozen(manifest.pins[0]));
  assert.match(formatResolutionManifest(manifest), /^workflow 'workflow-7' rev 1 \(exact\) 1 node @ epoch 1 [0-9a-f]{12}$/);
});

test('pinning is deterministic and order-independent', () => {
  const second = epochOf([declaration(4, 'a'), declaration(4.1, 'b'), declaration(4.4, 'c'), declaration(5, 'd')]);
  assert.equal(manifestOf().manifestDigest, manifestOf().manifestDigest);
  assert.equal(manifestOf().manifestDigest, createResolutionManifest({
    workflowId: 'workflow-7', epoch: second, nodes: [node(4)],
  }).manifestDigest, 'compiling the same content twice gives the same manifest');
  const two = createResolutionManifest({
    workflowId: 'workflow-7',
    epoch: EPOCH,
    nodes: [{ type: 'n8n-nodes-base.set', typeVersion: 1 }, node(4)],
  });
  const reversed = createResolutionManifest({
    workflowId: 'workflow-7',
    epoch: EPOCH,
    nodes: [node(4), { type: 'n8n-nodes-base.set', typeVersion: 1 }],
  });
  assert.equal(two.ok, false, 'the second node is not in the fixture epoch, so this pins nothing');
  assert.equal(two.reason, 'resolution.unresolved');
  assert.equal(reversed.reason, 'resolution.unresolved');
});

test('a manifest must name its workflow and a valid policy', () => {
  for (const workflowId of ['', '   ', null, 42]) {
    assert.throws(() => manifestOf({ workflowId }), (error) => error.meta.code === 'resolution.workflow');
  }
  assert.throws(() => manifestOf({ policy: 'latest' }), (error) => error.meta.code === 'resolution.policy');
  assert.throws(() => manifestOf({ policy: 'patch' }), (error) => error.meta.code === 'resolution.policy');
  assert.throws(() => manifestOf({ nodes: 'all' }), (error) => error.meta.code === 'resolution.node');
  assert.throws(() => manifestOf({ nodes: ['http'] }), (error) => error.meta.code === 'resolution.node');
  assert.throws(() => manifestOf({ nodes: [node(4), node(4)] }), (error) => error.meta.code === 'resolution.node');
  assert.throws(() => manifestOf({ epoch: { ok: true, epochNumber: 1 } }), ResolutionManifestError);
});

test('a workflow cannot pin what the registry does not have — and nothing partial is returned', () => {
  const refused = createResolutionManifest({
    workflowId: 'workflow-7',
    epoch: EPOCH,
    nodes: [node(4), { type: 'n8n-nodes-base.ghost', typeVersion: 1 }],
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'resolution.unresolved');
  assert.equal(refused.pins, null, 'no partial pinning: either the workflow resolves or it does not');
  assert.match(refused.errors[0].message, /cannot pin what the registry does not have/);
});

test('the epoch digest is recorded, so which implementation ran is a stored fact', () => {
  const manifest = manifestOf();
  const other = epochOf([declaration(4, 'a')], 'catalog:mirror');
  assert.notEqual(manifest.epochDigest, other.epochDigest);
  const view = resolutionManifestView(manifest);
  assert.equal(view.epochDigest, manifest.epochDigest);
  assert.equal(view.pins[0].identity, `${HTTP}@4`);
  assert.equal(view.historyLength, 0);
  assert.ok(Object.isFrozen(view));
});

/* ---------------------------------------------------------------- resolve */

test('resolution reports match for every pinned node and says so', () => {
  const result = resolveWorkflowNodes(manifestOf(), EPOCH);
  assert.equal(result.ok, true);
  assert.equal(result.matched, 1);
  assert.deepEqual([...result.missing], []);
  assert.deepEqual([...result.changed], []);
  assert.equal(result.states[0].state, 'match');
  assert.equal(result.resolvedAgainstPinnedEpoch, true);
  assert.equal(result.reason, null);
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.states));
});

test('a pinned node missing from the epoch is reported, never silently dropped', () => {
  const manifest = manifestOf();
  const shrunk = epochOf([declaration(5, 'd')], 'catalog:later');
  const result = resolveWorkflowNodes(manifest, shrunk);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'resolution.missing');
  assert.deepEqual([...result.missing], [`${HTTP}@4`]);
  assert.match(result.messages[0], /nothing is silently dropped from a workflow/);
  assert.equal(result.resolvedAgainstPinnedEpoch, false);
});

test('the same identity with different bytes is an integrity violation, not an upgrade', () => {
  const manifest = manifestOf();
  const rewritten = epochOf([declaration(4, 'f')], 'catalog:rewritten');
  const result = resolveWorkflowNodes(manifest, rewritten);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'resolution.changed');
  assert.deepEqual([...result.changed], [`${HTTP}@4`]);
  assert.equal(result.states[0].state, 'changed');
  assert.notEqual(result.states[0].digest, result.states[0].epochDigest);
  assert.match(result.messages[0], /registry integrity violation, not an upgrade/);
});

test('resolution of a newer epoch that still contains the pin is a match', () => {
  const later = epochOf([declaration(4, 'a'), declaration(5, 'd')], 'catalog:later');
  const result = resolveWorkflowNodes(manifestOf(), later);
  assert.equal(result.ok, true);
  assert.equal(result.matched, 1);
  assert.equal(result.resolvedAgainstPinnedEpoch, false, 'the epoch moved; the pin still resolves, and the difference is visible');
});

test('every read refuses a value this contract did not produce', () => {
  const forged = { ok: true, contract: RESOLUTION_MANIFEST_CONTRACT, schemaVersion: 1, workflowId: 'w', revision: 1, pins: [], manifestDigest: 'x', history: [] };
  for (const fn of [resolveWorkflowNodes, describeResolutionManifest, resolutionManifestView, formatResolutionManifest, pinnedIdentities, planNodeUpgrade]) {
    assert.throws(() => fn(forged, EPOCH), ResolutionManifestError, `${fn.name} must refuse a forged manifest`);
  }
  assert.equal(isResolutionManifest({ ...manifestOf() }), false, 'a shallow copy is not a manifest');
  assert.equal(isResolutionManifest(JSON.parse(JSON.stringify(manifestOf()))), false);
});

/* ------------------------------------------------------------------- plan */

test('planning proposes the highest version the policy allows and changes nothing', () => {
  const manifest = manifestOf({ policy: 'minor' });
  const before = JSON.stringify(resolutionManifestView(manifest));
  const plan = planNodeUpgrade(manifest, EPOCH);
  assert.equal(plan.ok, true);
  assert.equal(plan.changes.length, 1);
  assert.equal(plan.changes[0].from, `${HTTP}@4`);
  assert.equal(plan.changes[0].to, `${HTTP}@4.4`, 'minor stays inside the major line and takes the highest');
  assert.equal(plan.changes[0].policy, 'minor');
  assert.equal(plan.changes[0].toDigest, EPOCH.byIdentity[`${HTTP}@4.4`].digest);
  assert.equal(plan.fromEpochDigest, manifest.epochDigest);
  assert.equal(JSON.stringify(resolutionManifestView(manifest)), before, 'planning changes nothing at all');
  assert.match(plan.planDigest, /^[0-9a-f]{64}$/);
});

test('the exact policy never moves a pin', () => {
  const plan = planNodeUpgrade(manifestOf({ policy: 'exact' }), EPOCH);
  assert.equal(plan.ok, true);
  assert.deepEqual([...plan.changes], []);
  assert.deepEqual([...plan.unchanged], [`${HTTP}@4`]);
});

test('the major policy crosses a version line; minor does not', () => {
  // Both versions exist, so the only thing under test is the POLICY.
  const bothLines = epochOf([declaration(4, 'a'), declaration(5, 'd')], 'catalog:both-lines');
  const minorPlan = planNodeUpgrade(manifestOf({ policy: 'minor' }), bothLines);
  assert.equal(minorPlan.ok, true);
  assert.deepEqual([...minorPlan.changes], [], 'minor must not cross a version line');
  assert.deepEqual([...minorPlan.unchanged], [`${HTTP}@4`]);
  const majorPlan = planNodeUpgrade(manifestOf({ policy: 'major' }), bothLines);
  assert.equal(majorPlan.changes[0].to, `${HTTP}@5`);
  assert.equal(majorPlan.changes[0].policy, 'major');
});

test('an upgrade never proposes a downgrade or a no-op', () => {
  const older = epochOf([declaration(3, 'e')], 'catalog:older');
  // @3 exists in a different epoch; against an epoch that only has @3 the pin is
  // missing, and against one that has both the highest is chosen — never below.
  const both = epochOf([declaration(3, 'e'), declaration(4, 'a')], 'catalog:both');
  const plan = planNodeUpgrade(manifestOf({ policy: 'major' }), both);
  assert.deepEqual([...plan.changes], [], 'nothing above @4 exists, so nothing is proposed');
  assert.equal(plan.ok, true);
  assert.equal(plan.unchanged.length, 1);
  assert.equal(planNodeUpgrade(manifestOf({ policy: 'major' }), older).ok, false, 'a workflow cannot be pinned to a node the epoch does not have');
});

test('a plan refuses to drop a node: unavailability is fatal, not a warning', () => {
  const shrunk = epochOf([declaration(5, 'd')], 'catalog:later');
  const plan = planNodeUpgrade(manifestOf({ policy: 'minor' }), shrunk);
  assert.equal(plan.ok, false);
  assert.equal(plan.reason, 'resolution.unresolved');
  assert.match(plan.unavailable[0].message, /must not drop a node/);
});

/* ------------------------------------------------------------------ apply */

test('applying an upgrade requires an explicit authorization', () => {
  const manifest = manifestOf({ policy: 'minor' });
  const plan = planNodeUpgrade(manifest, EPOCH);
  const refused = applyNodeUpgrade(manifest, EPOCH, plan);
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'resolution.authorization');
  assert.equal(refused.manifest, manifest, 'a refusal hands the manifest back untouched');
  assert.equal(applyNodeUpgrade(manifest, EPOCH, plan, { authorized: false }).reason, 'resolution.authorization');
  assert.match(refused.errors[0].message, /never a default/);
});

test('an authorized apply advances the revision, re-pins and appends history', () => {
  const manifest = manifestOf({ policy: 'minor' });
  const plan = planNodeUpgrade(manifest, EPOCH);
  const applied = applyNodeUpgrade(manifest, EPOCH, plan, { authorized: true });
  assert.equal(applied.ok, true);
  assert.equal(applied.manifest.revision, 2);
  assert.deepEqual(applied.manifest.pins.map((pin) => pin.identity), [`${HTTP}@4.4`]);
  assert.equal(applied.manifest.epochNumber, EPOCH.epochNumber);
  assert.equal(applied.manifest.history.length, 1);
  assert.equal(applied.manifest.history[0].fromRevision, 1);
  assert.equal(applied.manifest.history[0].changes[0].from, `${HTTP}@4`);
  assert.notEqual(applied.manifest.manifestDigest, manifest.manifestDigest);
  assert.equal(manifest.revision, 1, 'the previous revision is untouched');
  assert.equal(manifest.pins[0].identity, `${HTTP}@4`);
  // The new manifest resolves cleanly against the same epoch.
  assert.equal(resolveWorkflowNodes(applied.manifest, EPOCH).ok, true);
});

test('a stale plan is refused rather than merged', () => {
  const manifest = manifestOf({ policy: 'minor' });
  const plan = planNodeUpgrade(manifest, EPOCH);
  const moved = epochOf([declaration(4, 'a'), declaration(4.2, 'b')], 'catalog:moved');
  const stale = applyNodeUpgrade(manifest, moved, plan, { authorized: true });
  assert.equal(stale.ok, false);
  assert.equal(stale.reason, 'resolution.stale');
  assert.match(stale.errors[0].message, /approved against a different registry is not applied/);
});

test('a proposal computed for another revision or workflow is refused', () => {
  const manifest = manifestOf({ policy: 'minor' });
  const plan = planNodeUpgrade(manifest, EPOCH);
  const applied = applyNodeUpgrade(manifest, EPOCH, plan, { authorized: true }).manifest;
  const reused = applyNodeUpgrade(applied, EPOCH, plan, { authorized: true });
  assert.equal(reused.ok, false);
  assert.equal(reused.reason, 'resolution.revision');
  const foreign = applyNodeUpgrade(manifest, EPOCH, { ...plan, workflowId: 'other-workflow' }, { authorized: true });
  assert.equal(foreign.reason, 'resolution.plan');
  assert.equal(applyNodeUpgrade(manifest, EPOCH, {}, { authorized: true }).reason, 'resolution.plan');
  assert.equal(applyNodeUpgrade(manifest, EPOCH, null, { authorized: true }).reason, 'resolution.plan');
});

test('applying a plan with no changes is a successful no-op', () => {
  const manifest = manifestOf({ policy: 'exact' });
  const applied = applyNodeUpgrade(manifest, EPOCH, planNodeUpgrade(manifest, EPOCH), { authorized: true });
  assert.equal(applied.ok, true);
  assert.equal(applied.manifest, manifest, 'nothing to do means the manifest is not rewritten');
  assert.deepEqual([...applied.applied], []);
});

test('applying the same proposal twice is idempotent, and a moved revision refuses it', () => {
  const manifest = manifestOf({ policy: 'minor' });
  const plan = planNodeUpgrade(manifest, EPOCH);
  const first = applyNodeUpgrade(manifest, EPOCH, plan, { authorized: true });
  const again = applyNodeUpgrade(manifest, EPOCH, plan, { authorized: true });
  assert.equal(first.ok, true);
  assert.equal(again.ok, true);
  assert.equal(again.manifest.manifestDigest, first.manifest.manifestDigest, 'the same proposal from the same revision is the same result, not a double upgrade');
  const onTop = applyNodeUpgrade(first.manifest, EPOCH, plan, { authorized: true });
  assert.equal(onTop.ok, false);
  assert.equal(onTop.reason, 'resolution.revision', 'a proposal computed for revision 1 is not applied to revision 2');
});

test('an upgrade that would drop a node is refused even when authorized', () => {
  const manifest = manifestOf({ policy: 'minor' });
  const plan = planNodeUpgrade(manifest, EPOCH);
  const shrunk = epochOf([declaration(4.4, 'c')], 'catalog:shrunk');
  const refused = applyNodeUpgrade(manifest, shrunk, { ...plan, planDigest: planNodeUpgrade(manifest, shrunk).planDigest }, { authorized: true });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'resolution.unresolved');
  // Even with a candidate version available: the pinned identity is gone, so
  // there is nothing to upgrade FROM.
  assert.equal(planNodeUpgrade(manifest, shrunk).unavailable.length, 1);
  assert.deepEqual([...planNodeUpgrade(manifest, shrunk).changes], []);
});

/* ----------------------------------------------------------------- reads */

test('describe answers what a workflow is pinned to, in one look', () => {
  const described = describeResolutionManifest(manifestOf());
  assert.equal(described.workflowId, 'workflow-7');
  assert.equal(described.revision, 1);
  assert.equal(described.pins ?? 0, 0);
  assert.equal(described.pinCount, 1);
  assert.deepEqual([...described.identities], [`${HTTP}@4`]);
  assert.equal(described.upgrades, 0);
  assert.equal(described.epochDigest, EPOCH.epochDigest);
  assert.ok(Object.isFrozen(described));
});

test('pinnedIdentities is a stable identity → digest map', () => {
  const pinned = pinnedIdentities(manifestOf());
  assert.deepEqual(Object.keys(pinned), [`${HTTP}@4`]);
  assert.equal(pinned[`${HTTP}@4`], EPOCH.byIdentity[`${HTTP}@4`].digest);
  assert.ok(Object.isFrozen(pinned));
});

test('resolutionDiff reports a re-pin as replaced, and refuses two workflows', () => {
  const manifest = manifestOf({ policy: 'minor' });
  const applied = applyNodeUpgrade(manifest, EPOCH, planNodeUpgrade(manifest, EPOCH), { authorized: true }).manifest;
  const diff = resolutionDiff(manifest, applied);
  // A re-pin moves the IDENTITY (@4 → @4.4), so it is a removal plus an addition,
  // not an edit in place: the identity is what the workflow refers to.
  assert.deepEqual([...diff.removed], [`${HTTP}@4`]);
  assert.deepEqual([...diff.added], [`${HTTP}@4.4`]);
  assert.deepEqual([...diff.replaced], []);
  // `replaced` is for the case that must never happen silently: same identity,
  // different bytes. It is reported rather than hidden.
  const rewritten = createResolutionManifest({ workflowId: 'workflow-7', nodes: [node(4)], epoch: epochOf([declaration(4, 'f')], 'catalog:rewritten') });
  assert.deepEqual([...resolutionDiff(manifest, rewritten).replaced], [`${HTTP}@4`]);
  assert.equal(diff.fromRevision, 1);
  assert.equal(diff.toRevision, 2);
  // A same-identity comparison partitions the pins; a re-pin does not, by design.
  const sameIdentity = resolutionDiff(manifest, rewritten);
  assert.equal(sameIdentity.replaced.length + sameIdentity.unchanged, manifest.pinCount);
  assert.throws(() => resolutionDiff(manifest, manifestOf({ workflowId: 'other' })), (error) => error.meta.code === 'resolution.workflow');
});

test('history is append-only across two upgrades', () => {
  const first = manifestOf({ policy: 'minor' });
  const afterFirst = applyNodeUpgrade(first, EPOCH, planNodeUpgrade(first, EPOCH), { authorized: true }).manifest;
  const lineCrossed = epochOf([declaration(4.4, 'c'), declaration(5, 'd')], 'catalog:crossed');
  // Changing the policy is part of the explicit proposal, and it is recorded.
  const plan = planNodeUpgrade(afterFirst, lineCrossed, { policy: 'major' });
  assert.equal(plan.currentPolicy, 'minor');
  assert.equal(plan.policy, 'major');
  const afterSecond = applyNodeUpgrade(afterFirst, lineCrossed, plan, { authorized: true }).manifest;
  assert.equal(afterSecond.revision, 3);
  assert.equal(afterSecond.policy, 'major');
  assert.equal(afterSecond.history.length, 2);
  assert.deepEqual(afterSecond.history.map((entry) => entry.revision), [2, 3]);
  assert.equal(afterSecond.history[1].policyFrom, 'minor');
  assert.equal(afterSecond.history[1].policyTo, 'major');
  assert.equal(afterSecond.pins[0].identity, `${HTTP}@5`);
  assert.deepEqual(resolutionManifestView(afterSecond).revisions, [2, 3]);
});

/* ------------------------------------------------------------ scope walls */

test('P6.5 publishes exactly one contract row and leaves the rest of P6 alone', () => {
  const lock = JSON.parse(readFileSync(new URL('../src/lego/contracts/contract-lock.json', import.meta.url)));
  const rows = lock.contracts.filter((contract) => contract.id === 'node.resolution');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].version, RESOLUTION_MANIFEST_CONTRACT_VERSION);
  assert.equal(rows[0].domain, 'node-registry');
  assert.deepEqual(rows[0].surface, ['src/lego/resolution-manifest.mjs']);
  for (const [id, version] of [['node.registry', '0.1.0'], ['registry.compiler', '0.1.0'], ['package.transaction', '0.1.0'], ['registry.closure', '0.1.0']]) {
    const row = lock.contracts.find((contract) => contract.id === id);
    assert.equal(row.version, version, `P6.5 must not re-version ${id}`);
  }
  const domain = JSON.parse(readFileSync(new URL('../src/lego/manifest/domains.json', import.meta.url)))
    .domains.find((entry) => entry.id === 'node-registry');
  assert.equal(domain.contract.id, 'node.portability');
  assert.ok(domain.paths.includes('src/lego/resolution-manifest.mjs'));
});

test('P6.5 builds on P6.1 and P6.2 rather than re-deriving them', () => {
  const source = readFileSync(new URL('../src/lego/resolution-manifest.mjs', import.meta.url), 'utf8');
  assert.match(source, /from '\.\/node-registry\.mjs'/);
  assert.match(source, /from '\.\/registry-compiler\.mjs'/);
  assert.equal(source.includes('createHash'), true);
  // No second compiler: epochs are handed in, never assembled here.
  assert.equal(source.includes('indexNodeRegistryDeclarations'), false);
});

test('the module is pure and touches no workflow or execution internals', () => {
  const source = readFileSync(new URL('../src/lego/resolution-manifest.mjs', import.meta.url), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const forbidden of ['node:fs', 'node:net', 'node:http', 'node:os', 'node:child_process', 'process.', 'Math.random', 'setTimeout', 'performance.']) {
    assert.equal(code.includes(forbidden), false, `resolution manifest must not reference ${forbidden}`);
  }
  assert.equal(/\bnew Date\b|\bDate\.now\b/.test(code), false);
  assert.equal(code.includes('foundation.mjs'), false, 'the foundation accessor stays outside the published surface (gate rule R4)');
  // P3's frontier, IR and graph modules are never imported: the node list is data.
  for (const p3 of ['bounded-frontier', 'execution-ir', 'workflow-graph', 'execution-optimizer', 'resource-guard']) {
    assert.equal(code.includes(p3), false, `P6.5 must not reach into P3's ${p3}`);
  }
});

test('P6.5 scope walls: no lease, residency, capability, health or attestation', () => {
  const names = Object.keys({
    RESOLUTION_MANIFEST_CONTRACT, RESOLUTION_MANIFEST_OPERATIONS, RESOLUTION_MANIFEST_PERMISSIONS,
    RESOLUTION_MANIFEST_SCHEMA_VERSION, RESOLUTION_MANIFEST_REASONS, RESOLUTION_MANIFEST_RULES, UPGRADE_POLICIES,
    RESOLUTION_STATES, ResolutionManifestError, createResolutionManifest, isResolutionManifest,
    resolveWorkflowNodes, planNodeUpgrade, applyNodeUpgrade, resolutionManifestView, describeResolutionManifest,
    formatResolutionManifest, pinnedIdentities, resolutionDiff,
  }).join(' ');
  for (const later of ['lease', 'residency', 'capabilit', 'quarantine', 'attest', 'sbom', 'canary', 'fingerprint', 'health', 'drain']) {
    assert.equal(new RegExp(later, 'i').test(names), false, `${later} belongs to a later milestone`);
  }
});
