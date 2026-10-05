/**
 * P2.27.9 — side-by-side upgrade + rollback + supply-chain admission.
 *
 * Proves: the admission pipeline runs in Issue #83's exact order and fails
 * closed at the first unverified or failed step (missing evidence = denial,
 * never a skip); the upgrade machine follows exactly
 * old→new→validate→health→contract test→activate→drain→stop with ROLLED_BACK
 * one-way; the contract test consumes a real `replayFixture` report; compat
 * gates (downgrade/breaking sign-off/migration points/consumer blocks) come
 * from `planUpgrade`; capabilities deny-by-default and resource policy stay
 * bounded; rollback swaps the serving pointer back to the old version with
 * no workflow rewrite; events stay inside the `.1` vocabulary; and the lock
 * row stays semver-versioned with the upgrade surface + suites pinned (the
 * exact surface pin lives in the newest suite).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SUPPLY_CHAIN_STEPS,
  UPGRADE_STATES,
  UPGRADE_TRANSITIONS,
  canUpgradeTransition,
  runSupplyChainAdmission,
  createUpgradeCoordinator,
} from '../src/lego/plugin-upgrade.mjs';
import { replayFixture } from '../src/lego/plugin-replay.mjs';
import { PLUGIN_EVENT_TYPES, PluginRuntimeError } from '../src/lego/plugin-runtime.mjs';

const APP_ROOT = fileURLToPath(new URL('../', import.meta.url));

const manifest = (overrides = {}) => ({
  id: 'pdf-exporter',
  version: '1.1.0',
  publisher: 'acme',
  contract: { id: 'acme.pdf', range: '^1.0.0' },
  trustClass: 'TRUSTED',
  runtimeClass: 'IN_PROCESS',
  requestedCapabilities: [],
  ...overrides,
});

const GOOD_EVIDENCE = {
  signature: () => true,
  digest: true,
  provenance: true,
  health: () => true,
};

const admit = (overrides = {}) =>
  runSupplyChainAdmission({
    pluginId: 'pdf-exporter',
    fromVersion: '1.0.0',
    toVersion: '1.1.0',
    manifest: manifest(),
    evidence: GOOD_EVIDENCE,
    ...overrides,
  });

const setup = (overrides = {}) => {
  let t = 0;
  const events = [];
  const coordinator = createUpgradeCoordinator({
    pluginId: 'pdf-exporter',
    fromVersion: '1.0.0',
    toVersion: '1.1.0',
    now: () => (t += 5),
    onEvent: (type, detail) => events.push({ type, detail }),
    ...overrides,
  });
  return { coordinator, events };
};

const stageGood = (coordinator) => coordinator.stage({ manifest: manifest(), evidence: GOOD_EVIDENCE });

const goodReport = () =>
  replayFixture({
    input: { doc: 'a' },
    implementations: [
      { id: 'v-old', invoke: () => ({ pages: 3, meta: { pages: 3, title: 'x' } }) },
      { id: 'v-new', invoke: () => ({ meta: { title: 'x', pages: 3 }, pages: 3 }) },
    ],
  });

test('the pipeline is Issue #83\'s exact order and stays frozen', () => {
  assert.deepEqual([...SUPPLY_CHAIN_STEPS], [
    'signature',
    'digest',
    'provenance',
    'contract',
    'capabilities',
    'resourcePolicy',
    'health',
    'activate',
  ]);
  assert.ok(Object.isFrozen(SUPPLY_CHAIN_STEPS));
  assert.deepEqual([...UPGRADE_STATES], [
    'STAGED',
    'VALIDATED',
    'HEALTHY',
    'CONTRACT_TESTED',
    'ACTIVATED',
    'DRAINED',
    'STOPPED',
    'ROLLED_BACK',
  ]);
  assert.ok(Object.isFrozen(UPGRADE_STATES) && Object.isFrozen(UPGRADE_TRANSITIONS));
  assert.deepEqual(Object.keys(UPGRADE_TRANSITIONS).sort(), [...UPGRADE_STATES].sort());
  assert.deepEqual(UPGRADE_TRANSITIONS.STOPPED, []);
  assert.deepEqual(UPGRADE_TRANSITIONS.ROLLED_BACK, []);
  for (const state of ['STAGED', 'VALIDATED', 'HEALTHY', 'CONTRACT_TESTED', 'ACTIVATED', 'DRAINED']) {
    assert.ok(UPGRADE_TRANSITIONS[state].includes('ROLLED_BACK'), `${state} can roll back`);
  }
  assert.equal(UPGRADE_TRANSITIONS.STOPPED.includes('ROLLED_BACK'), false, 'stopped old version is gone');
  assert.ok(canUpgradeTransition('STAGED', 'VALIDATED'));
  assert.ok(canUpgradeTransition('CONTRACT_TESTED', 'ACTIVATED'));
  assert.equal(canUpgradeTransition('STAGED', 'ACTIVATED'), false, 'no skipping');
  assert.equal(canUpgradeTransition('STOPPED', 'ROLLED_BACK'), false);
  assert.equal(canUpgradeTransition('nonsense', 'STAGED'), false);
});

test('admission passes only when every evidence step verifies — frozen record with the plan', () => {
  const record = admit();
  assert.ok(Object.isFrozen(record));
  assert.equal(record.nextStep, 'activate');
  assert.equal(record.activated, false);
  assert.equal(record.steps.length, 7, 'activate is pending until the machine reaches ACTIVATED');
  assert.deepEqual(record.steps.map((s) => s.step), [
    'signature',
    'digest',
    'provenance',
    'contract',
    'capabilities',
    'resourcePolicy',
    'health',
  ]);
  assert.ok(record.steps.every((s) => s.status === 'pass' && Number.isFinite(s.at)));
  assert.equal(record.plan.change, 'compatible');
  assert.equal(record.plan.safeToActivate, true);
});

test('trust steps fail closed: unverified (missing evidence) and failed verification both deny, in order', () => {
  assert.throws(
    () => runSupplyChainAdmission({ pluginId: 'p', fromVersion: '1.0.0', toVersion: '1.1.0', manifest: manifest(), evidence: {} }),
    (error) => error instanceof PluginRuntimeError && error.code === 'lego.access_denied' && /signature/.test(error.message)
  );
  for (const bad of ['signature', 'digest', 'provenance']) {
    assert.throws(
      () => admit({ evidence: { ...GOOD_EVIDENCE, [bad]: false } }),
      (error) => error.code === 'lego.access_denied' && error.message.includes(bad),
      `${bad} false denies`
    );
    assert.throws(
      () => admit({ evidence: { ...GOOD_EVIDENCE, [bad]: undefined } }),
      (error) => error.code === 'lego.access_denied',
      `${bad} undefined counts as unverified`
    );
  }
  // order: a failing signature beats everything behind it (even a broken manifest)
  assert.throws(
    () => admit({ manifest: { nonsense: true }, evidence: { ...GOOD_EVIDENCE, signature: false } }),
    (error) => error.code === 'lego.access_denied' && error.message.includes('signature'),
    'signature runs before contract'
  );
});

test('health: missing evidence is a denial, unhealthy is dependency_disabled — never reaches activate', () => {
  const noHealth = { signature: () => true, digest: true, provenance: true };
  assert.throws(
    () => admit({ evidence: noHealth }),
    (error) => error.code === 'lego.access_denied' && /health/.test(error.message)
  );
  assert.throws(
    () => admit({ evidence: { ...GOOD_EVIDENCE, health: false } }),
    (error) => error.code === 'lego.dependency_disabled'
  );
});

test('contract step: schema, version integrity and compat gates compose from existing modules', () => {
  assert.throws(
    () => admit({ manifest: { id: 'pdf-exporter' } }),
    (error) => error.code === 'lego.contract_violation',
    'validateManifest decides schema'
  );
  assert.throws(
    () => admit({ toVersion: '9.9.9' }),
    (error) => error.code === 'lego.contract_violation' && /must equal the staged manifest version/.test(error.message)
  );
  assert.throws(
    () => admit({ fromVersion: '1.1.0' }),
    (error) => error.code === 'lego.contract_violation' && /must differ/.test(error.message)
  );
  assert.throws(
    () => admit({ fromVersion: '2.0.0' }),
    (error) => error.code === 'lego.version_incompatible' && /older/.test(error.message),
    'downgrade is never automatic'
  );
  assert.throws(
    () => admit({ toVersion: '2.0.0', manifest: manifest({ version: '2.0.0' }) }),
    (error) => error.code === 'lego.version_incompatible' && /sign-off/.test(error.message)
  );
  const signed = admit({ toVersion: '2.0.0', manifest: manifest({ version: '2.0.0' }), signedOff: true });
  assert.equal(signed.plan.change, 'breaking');
  assert.throws(
    () => admit({ migrations: ['1.0.5'] }),
    (error) => error.code === 'lego.migration_required',
    'crossing a declared migration point stops until applied'
  );
  const applied = admit({ migrations: ['1.0.5'], migrationApplied: true });
  assert.equal(applied.plan.change, 'migration-required');
  assert.throws(
    () =>
      admit({
        toVersion: '2.0.0',
        manifest: manifest({ version: '2.0.0' }),
        signedOff: true,
        consumers: [{ id: 'wf-a', requires: '^1.0.0' }],
      }),
    (error) => error.code === 'lego.version_incompatible' && /blocked by consumer/.test(error.message)
  );
});

test('capabilities deny-by-default and resource policy stays bounded', () => {
  assert.throws(
    () => admit({ manifest: manifest({ requestedCapabilities: ['memory.read'] }), grants: [] }),
    (error) => error.code === 'lego.access_denied' && error.details.denied.includes('memory.read'),
    'a domain capability with no explicit grant is DENIED at every trust class'
  );
  const granted = admit({ manifest: manifest({ requestedCapabilities: ['memory.read'] }), grants: ['memory.read'] });
  assert.equal(granted.steps.find((s) => s.step === 'capabilities').status, 'pass');
  assert.equal(
    admit({ manifest: manifest({ requestedCapabilities: ['network'] }), grants: [] }).steps.find((s) => s.step === 'capabilities').status,
    'pass',
    'foundation network stays a default at the TRUSTED ceiling'
  );
  assert.throws(
    () => admit({ manifest: manifest({ resourceLimits: { concurrency: 0 } }) }),
    (error) => error.code === 'lego.contract_violation' && /concurrency/.test(error.message),
    'a zero concurrency budget cannot be instantiated'
  );
});

test('happy path: stage → validate → health → contract test → activate → drain → stop, with the .1 events', () => {
  const { coordinator, events } = setup();
  assert.equal(coordinator.state(), null);
  assert.equal(coordinator.serving(), 'none');
  assert.equal(stageGood(coordinator), 'STAGED');
  assert.equal(coordinator.serving(), 'from', 'old version keeps serving while staged');
  assert.throws(() => stageGood(coordinator), (error) => error.code === 'lego.contract_violation', 'one attempt per coordinator');
  const path = ['VALIDATED', 'HEALTHY'];
  for (const to of path) assert.equal(coordinator.advance(to), to);
  assert.equal(coordinator.advance('CONTRACT_TESTED', { replay: goodReport() }), 'CONTRACT_TESTED');
  assert.equal(coordinator.advance('ACTIVATED'), 'ACTIVATED');
  assert.equal(coordinator.serving(), 'to', 'activation flips the serving pointer');
  assert.equal(coordinator.advance('DRAINED'), 'DRAINED');
  assert.equal(coordinator.advance('STOPPED'), 'STOPPED');
  assert.equal(coordinator.serving(), 'to');
  assert.deepEqual(
    events.map((event) => event.type),
    ['plugin.activated', 'plugin.deactivated', 'plugin.upgraded'],
    'only .1 vocabulary fires'
  );
  for (const event of events) assert.ok(PLUGIN_EVENT_TYPES.includes(event.type), `${event.type} is declared`);
  assert.equal(events[1].detail.reason, 'upgraded');
  assert.deepEqual(
    { from: events[2].detail.from, to: events[2].detail.to },
    { from: '1.0.0', to: '1.1.0' }
  );
  const record = coordinator.admission();
  assert.equal(record.steps.length, 8, 'the activate step completed');
  assert.equal(record.steps[7].step, 'activate');
  assert.equal(record.steps[7].status, 'pass');
  assert.equal(record.activated, true);
  assert.equal(record.nextStep, null);
  const history = coordinator.history();
  assert.equal(history.length, 7);
  assert.ok(history.every((entry) => Object.isFrozen(entry)));
  assert.deepEqual(history.map((entry) => entry.to), [
    'STAGED',
    'VALIDATED',
    'HEALTHY',
    'CONTRACT_TESTED',
    'ACTIVATED',
    'DRAINED',
    'STOPPED',
  ]);
});

test('unverified artifacts never stage, so they can never activate', () => {
  const { coordinator } = setup();
  assert.throws(
    () => coordinator.stage({ manifest: manifest(), evidence: {} }),
    (error) => error.code === 'lego.access_denied'
  );
  assert.equal(coordinator.state(), null, 'failed admission leaves nothing staged');
  assert.throws(
    () => coordinator.advance('VALIDATED'),
    (error) => error.code === 'lego.contract_violation' && /stage\(\) runs admission/.test(error.message)
  );
  assert.equal(coordinator.admission(), null);
  assert.equal(coordinator.serving(), 'none');
});

test('the contract test is a real replay report — missing or non-interchangeable blocks activation', () => {
  const { coordinator } = setup();
  stageGood(coordinator);
  coordinator.advance('VALIDATED');
  coordinator.advance('HEALTHY');
  assert.throws(
    () => coordinator.advance('CONTRACT_TESTED'),
    (error) => error.code === 'lego.contract_violation' && /replayFixture report/.test(error.message)
  );
  const divergent = replayFixture({
    input: {},
    implementations: [
      { id: 'v-old', invoke: () => ({ total: 10 }) },
      { id: 'v-new', invoke: () => ({ total: 11 }) },
    ],
  });
  assert.equal(divergent.interchangeable, false);
  assert.throws(
    () => coordinator.advance('CONTRACT_TESTED', { replay: divergent }),
    (error) => error.code === 'lego.contract_violation' && /not interchangeable/.test(error.message)
  );
  assert.equal(coordinator.state(), 'HEALTHY', 'a failed contract test changes nothing');
  assert.equal(coordinator.advance('CONTRACT_TESTED', { replay: goodReport() }), 'CONTRACT_TESTED');
});

test('illegal transitions fail closed with contract_violation and change nothing', () => {
  const { coordinator } = setup();
  stageGood(coordinator);
  assert.throws(
    () => coordinator.advance('ACTIVATED'),
    (error) => error.code === 'lego.contract_violation' && /illegal upgrade transition/.test(error.message)
  );
  assert.equal(coordinator.state(), 'STAGED');
  coordinator.advance('VALIDATED');
  coordinator.advance('HEALTHY');
  coordinator.advance('CONTRACT_TESTED', { replay: goodReport() });
  coordinator.advance('ACTIVATED');
  coordinator.advance('DRAINED');
  coordinator.advance('STOPPED');
  assert.throws(
    () => coordinator.advance('ROLLED_BACK'),
    (error) => error.code === 'lego.contract_violation'
  );
  assert.equal(coordinator.state(), 'STOPPED');
});

test('rollback before activation aborts the attempt without touching serving or emitting activation events', () => {
  const { coordinator, events } = setup();
  stageGood(coordinator);
  coordinator.advance('VALIDATED');
  assert.equal(coordinator.rollback({ reason: 'operator_abort' }), 'ROLLED_BACK');
  assert.equal(coordinator.serving(), 'from', 'old version was serving the whole time');
  assert.deepEqual(events.map((event) => event.type), ['plugin.rolled-back']);
  assert.equal(events[0].detail.wasActivated, false);
  assert.equal(events[0].detail.reason, 'operator_abort');
  const record = coordinator.admission();
  assert.equal(record.steps[7].status, 'rolled-back');
  assert.equal(record.activated, false);
  assert.equal(coordinator.state(), 'ROLLED_BACK');
  assert.throws(
    () => coordinator.advance('VALIDATED'),
    (error) => error.code === 'lego.contract_violation',
    'ROLLED_BACK is one-way'
  );
});

test('rollback after activation flips serving back to the old version — no workflow rewrite (plugin id binding)', () => {
  const { coordinator, events } = setup();
  stageGood(coordinator);
  coordinator.advance('VALIDATED');
  coordinator.advance('HEALTHY');
  coordinator.advance('CONTRACT_TESTED', { replay: goodReport() });
  coordinator.advance('ACTIVATED');
  assert.equal(coordinator.serving(), 'to');
  assert.equal(coordinator.rollback({ reason: 'canary_regression' }), 'ROLLED_BACK');
  assert.equal(coordinator.serving(), 'from', 'the old version serves again under the same plugin id');
  const types = events.map((event) => event.type);
  assert.deepEqual(types, ['plugin.activated', 'plugin.rolled-back']);
  const rolled = events.find((event) => event.type === 'plugin.rolled-back');
  assert.equal(rolled.detail.wasActivated, true);
  assert.equal(rolled.detail.reason, 'canary_regression');
  assert.equal(coordinator.admission().steps[7].status, 'rolled-back');
});

test('rollback from STOPPED refuses: the old version is gone — stage a new attempt instead', () => {
  const { coordinator } = setup();
  stageGood(coordinator);
  for (const to of ['VALIDATED', 'HEALTHY']) coordinator.advance(to);
  coordinator.advance('CONTRACT_TESTED', { replay: goodReport() });
  coordinator.advance('ACTIVATED');
  coordinator.advance('DRAINED');
  coordinator.advance('STOPPED');
  assert.throws(
    () => coordinator.rollback(),
    (error) =>
      error.code === 'lego.contract_violation' && /stage a new upgrade/.test(error.message)
  );
  assert.equal(coordinator.state(), 'STOPPED');
});

test('the lock row keeps the upgrade surface + suites pinned (exact pin lives in the newest suite)', () => {
  const lock = JSON.parse(readFileSync(join(APP_ROOT, 'src/lego/contracts/contract-lock.json'), 'utf8'));
  const row = lock.contracts.find((entry) => entry.id === 'lego.plugin-runtime');
  assert.match(row.version, /^\d+\.\d+\.\d+$/);
  assert.ok(row.surface.includes('src/lego/plugin-upgrade.mjs'), 'plugin-upgrade.mjs stays on the surface');
  assert.ok(row.surface.includes('src/lego/plugin-replay.mjs'));
  assert.ok(row.tests.includes('apps/n8n-lego/test/lego-plugin-upgrade.test.mjs'));
  assert.ok(row.tests.includes('apps/n8n-lego/test/lego-plugin-replay.test.mjs'));
  for (const file of row.surface) {
    const source = readFileSync(join(APP_ROOT, file), 'utf8');
    const exported = [...source.matchAll(/^export (?:const|class|function) (\w+)/gm)].map((m) => m[1]).sort();
    const locked = [...(row.exports[file] ?? [])].sort();
    assert.deepEqual(locked, exported, `lock ⇄ module exports for ${file}`);
  }
});
