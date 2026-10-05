/**
 * P2.27.7 — supervisor: lifecycle machine + crash loop → quarantine.
 *
 * Proves: the transition table is exactly design §15's; every transition is
 * machine-checked (illegal edge = contract_violation); QUARANTINED has no
 * automatic exits — only the operator release; crash loop quarantines at the
 * limit and emits plugin.quarantined; HEALTHY resets the consecutive-crash
 * window; events stay inside the .1 vocabulary; unknown ids fail with
 * unavailable; and the lock row (newest suite) pins the exact eight-module
 * surface.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PLUGIN_LIFECYCLE_TRANSITIONS,
  PLUGIN_RUNNING_STATES,
  canPluginTransition,
  createPluginSupervisor,
} from '../src/lego/plugin-supervisor.mjs';
import { PLUGIN_LIFECYCLE_STATES, PLUGIN_EVENT_TYPES, PluginRuntimeError } from '../src/lego/plugin-runtime.mjs';

const APP_ROOT = fileURLToPath(new URL('../', import.meta.url));

const setup = (overrides = {}) => {
  let t = 0;
  const events = [];
  const supervisor = createPluginSupervisor({
    now: () => (t += 5),
    onEvent: (type, detail) => events.push({ type, detail }),
    ...overrides,
  });
  return { supervisor, events };
};

test('the machine covers exactly the eight design §15 states; QUARANTINED has no automatic exits', () => {
  assert.deepEqual(Object.keys(PLUGIN_LIFECYCLE_TRANSITIONS).sort(), [...PLUGIN_LIFECYCLE_STATES].sort());
  assert.ok(Object.isFrozen(PLUGIN_LIFECYCLE_TRANSITIONS));
  assert.deepEqual(PLUGIN_LIFECYCLE_TRANSITIONS.DISCOVERED, ['VALIDATING']);
  assert.deepEqual(PLUGIN_LIFECYCLE_TRANSITIONS.VALIDATING, ['STARTING', 'QUARANTINED']);
  assert.deepEqual(PLUGIN_LIFECYCLE_TRANSITIONS.STARTING, ['HEALTHY', 'QUARANTINED', 'STARTING']);
  assert.deepEqual(PLUGIN_LIFECYCLE_TRANSITIONS.HEALTHY, ['STARTING', 'DEGRADED', 'DRAINING', 'QUARANTINED']);
  assert.deepEqual(PLUGIN_LIFECYCLE_TRANSITIONS.DRAINING, ['STOPPED', 'QUARANTINED']);
  assert.deepEqual(PLUGIN_LIFECYCLE_TRANSITIONS.STOPPED, ['STARTING']);
  assert.deepEqual(PLUGIN_LIFECYCLE_TRANSITIONS.QUARANTINED, [], 'quarantine is a one-way door on the machine');
  for (const row of Object.values(PLUGIN_LIFECYCLE_TRANSITIONS)) assert.ok(Object.isFrozen(row));
  assert.deepEqual([...PLUGIN_RUNNING_STATES], ['STARTING', 'HEALTHY', 'DEGRADED']);
});

test('canPluginTransition is explainable and honest about illegal/unknown states', () => {
  assert.equal(canPluginTransition('DISCOVERED', 'VALIDATING').allowed, true);
  assert.equal(canPluginTransition('DISCOVERED', 'HEALTHY').allowed, false, 'no skipping validation');
  assert.equal(canPluginTransition('DRAINING', 'HEALTHY').allowed, false, 'drain finishes or quarantines');
  assert.equal(canPluginTransition('QUARANTINED', 'HEALTHY').allowed, false);
  assert.match(canPluginTransition('STOPPED', 'HEALTHY').reason, /not a legal transition/);
  assert.match(canPluginTransition('NOPE', 'HEALTHY').reason, /unknown lifecycle state/);
  assert.match(canPluginTransition('STOPPED', 'NOPE').reason, /unknown lifecycle state/);
  assert.ok(Object.isFrozen(canPluginTransition('STOPPED', 'STARTING')));
});

test('track initializes DISCOVERED, rejects duplicates and bad ids', () => {
  const { supervisor } = setup();
  const record = supervisor.track('pdf-exporter');
  assert.equal(record.state, 'DISCOVERED');
  assert.equal(supervisor.state('pdf-exporter'), 'DISCOVERED');
  assert.throws(() => supervisor.track('pdf-exporter'), (e) => e.code === 'lego.contract_violation');
  assert.throws(() => supervisor.track(''), (e) => e.code === 'lego.contract_violation');
  assert.throws(() => supervisor.track('x'.repeat(65)), (e) => e.code === 'lego.contract_violation');
  assert.throws(() => supervisor.track(null), (e) => e.code === 'lego.contract_violation');
});

test('the happy path walks DISCOVERED → VALIDATING → STARTING → HEALTHY → DRAINING → STOPPED → STARTING', () => {
  const { supervisor, events } = setup();
  supervisor.track('p');
  const path = ['VALIDATING', 'STARTING', 'HEALTHY', 'DRAINING', 'STOPPED', 'STARTING'];
  let from = 'DISCOVERED';
  for (const to of path) {
    const result = supervisor.transition('p', to);
    assert.equal(result.from, from);
    assert.equal(result.to, to);
    from = to;
  }
  assert.deepEqual(
    events.map((event) => event.type),
    ['plugin.activated', 'plugin.deactivated'],
    'only activated/deactivated fire — vocabulary stays the .1 set',
  );
});

test('illegal transitions fail closed with contract_violation and change nothing', () => {
  const { supervisor } = setup();
  supervisor.track('p');
  assert.throws(
    () => supervisor.transition('p', 'HEALTHY'),
    (error) => error instanceof PluginRuntimeError && error.code === 'lego.contract_violation',
  );
  assert.equal(supervisor.state('p'), 'DISCOVERED');
  assert.throws(() => supervisor.transition('p', 'TELEPORTED'), (e) => e.code === 'lego.contract_violation');
  assert.throws(() => supervisor.transition('ghost', 'VALIDATING'), (e) => e.code === 'lego.unavailable');
  assert.throws(() => supervisor.state('ghost'), (e) => e.code === 'lego.unavailable');
  assert.throws(() => supervisor.crashCount('ghost'), (e) => e.code === 'lego.unavailable');
});

test('crash loop: restarts below the limit, QUARANTINED at it, with plugin.quarantined emitted', () => {
  const { supervisor, events } = setup({ crashLimit: 3 });
  supervisor.track('p');
  supervisor.transition('p', 'VALIDATING');
  supervisor.transition('p', 'STARTING');

  // A loop is CONSECUTIVE failures that never reach HEALTHY (restart attempts
  // that keep dying in STARTING) — reaching HEALTHY resets the window instead.
  const first = supervisor.reportCrash('p', { reason: 'segfault during startup' });
  assert.equal(first.outcome, 'STARTING');
  assert.equal(supervisor.crashCount('p'), 1);

  const second = supervisor.reportCrash('p', { reason: 'oom during startup' });
  assert.equal(second.outcome, 'STARTING');
  assert.equal(supervisor.crashCount('p'), 2);

  const third = supervisor.reportCrash('p', { reason: 'boom during startup' });
  assert.equal(third.outcome, 'QUARANTINED');
  assert.equal(supervisor.state('p'), 'QUARANTINED');
  assert.match(third.reason, /crash loop 3\/3/);
  const quarantinedEvents = events.filter((event) => event.type === 'plugin.quarantined');
  assert.equal(quarantinedEvents.length, 1);
  assert.equal(quarantinedEvents[0].detail.crashes, 3);
});

test('HEALTHY resets the consecutive-crash window — lifetime crashes do not accumulate into false loops', () => {
  const { supervisor } = setup({ crashLimit: 2 });
  supervisor.track('p');
  supervisor.transition('p', 'VALIDATING');
  supervisor.transition('p', 'STARTING');
  supervisor.transition('p', 'HEALTHY');
  supervisor.reportCrash('p');
  supervisor.transition('p', 'HEALTHY');
  assert.equal(supervisor.crashCount('p'), 0, 'healthy resets the window');
  supervisor.reportCrash('p');
  assert.equal(supervisor.state('p'), 'STARTING', 'one consecutive crash restarts, does not quarantine');
  const result = supervisor.reportCrash('p');
  assert.equal(result.outcome, 'QUARANTINED', 'second consecutive crash hits the limit');
});

test('crash reports only make sense for running states', () => {
  const { supervisor } = setup();
  supervisor.track('p');
  assert.throws(() => supervisor.reportCrash('p'), (e) => e.code === 'lego.contract_violation');
  supervisor.transition('p', 'VALIDATING');
  assert.throws(() => supervisor.reportCrash('p'), (e) => e.code === 'lego.contract_violation');
  supervisor.transition('p', 'STARTING');
  const result = supervisor.reportCrash('p'); // STARTING is a running state — the report is accepted
  assert.equal(result.outcome, 'STARTING');
  assert.equal(result.crashes, 1);
});

test('quarantine is a one-way door: transitions cannot leave, only the operator release can', () => {
  const { supervisor, events } = setup({ crashLimit: 1 });
  supervisor.track('p');
  supervisor.transition('p', 'VALIDATING');
  supervisor.transition('p', 'STARTING');
  supervisor.reportCrash('p'); // limit 1 → quarantined
  assert.equal(supervisor.state('p'), 'QUARANTINED');
  for (const to of PLUGIN_LIFECYCLE_STATES) {
    if (to === 'QUARANTINED') continue;
    assert.throws(
      () => supervisor.transition('p', to),
      (error) => error.code === 'lego.contract_violation',
      `no machine edge leaves QUARANTINED toward ${to}`,
    );
  }
  assert.throws(() => supervisor.releaseFromQuarantine('other'), (e) => e.code === 'lego.unavailable');
  const released = supervisor.releaseFromQuarantine('p', { reason: 'operator fixed the build' });
  assert.equal(released.to, 'DISCOVERED');
  assert.equal(supervisor.state('p'), 'DISCOVERED');
  assert.equal(supervisor.crashCount('p'), 0, 'release resets the crash window for a fresh cycle');
  assert.throws(() => supervisor.releaseFromQuarantine('p'), (e) => e.code === 'lego.contract_violation');
  assert.equal(events.filter((event) => event.type === 'plugin.quarantined').length, 1);
});

test('events stay inside the P2.27.1 vocabulary — no new event words sneak in', () => {
  const { supervisor, events } = setup({ crashLimit: 1 });
  supervisor.track('p');
  supervisor.transition('p', 'VALIDATING');
  supervisor.transition('p', 'STARTING');
  supervisor.transition('p', 'HEALTHY');
  supervisor.transition('p', 'DRAINING');
  supervisor.transition('p', 'STOPPED');
  supervisor.transition('p', 'STARTING');
  supervisor.reportCrash('p'); // quarantines at limit
  supervisor.releaseFromQuarantine('p');
  for (const event of events) {
    assert.ok(PLUGIN_EVENT_TYPES.includes(event.type), `${event.type} is declared in the .1 vocabulary`);
  }
});

test('supervisor options fail closed; list() is a frozen honest snapshot', () => {
  assert.throws(() => createPluginSupervisor({ now: 1 }), TypeError);
  assert.throws(() => createPluginSupervisor({ now: () => 0, onEvent: 'x' }), TypeError);
  assert.throws(() => createPluginSupervisor({ now: () => 0, crashLimit: 0 }), TypeError);
  assert.throws(() => createPluginSupervisor({ now: () => 0, crashLimit: 101 }), TypeError);
  assert.throws(() => createPluginSupervisor({ now: () => 0, crashLimit: 2.5 }), TypeError);
  const { supervisor } = setup({ crashLimit: 7 });
  supervisor.track('a');
  supervisor.track('b');
  const snapshot = supervisor.list();
  assert.ok(Object.isFrozen(snapshot));
  assert.equal(snapshot.length, 2);
  assert.deepEqual(snapshot.map((entry) => entry.id).sort(), ['a', 'b']);
  assert.equal(supervisor.crashLimit.value, 7);
});

test('the lego.plugin-runtime row keeps the P2.27.7 modules locked (exact surface pins live in the newest slice suite)', () => {
  const lock = JSON.parse(readFileSync(join(APP_ROOT, 'src/lego/contracts/contract-lock.json'), 'utf8'));
  const row = lock.contracts.find((entry) => entry.id === 'lego.plugin-runtime');
  assert.match(row.version, /^\d+\.\d+\.\d+$/);
  assert.ok(row.surface.includes('src/lego/plugin-supervisor.mjs'), 'plugin-supervisor.mjs stays on the surface');
  assert.ok(row.tests.includes('apps/n8n-lego/test/lego-plugin-supervisor.test.mjs'));
  for (const file of row.surface) {
    const source = readFileSync(join(APP_ROOT, file), 'utf8');
    const exported = [...source.matchAll(/^export (?:const|class|function) (\w+)/gm)].map((m) => m[1]).sort();
    const locked = [...(row.exports[file] ?? [])].sort();
    assert.deepEqual(locked, exported, `lock ⇄ module exports for ${file}`);
  }
});
