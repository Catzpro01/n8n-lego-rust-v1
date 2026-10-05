/**
 * P2.27.1 — tiny plugin runtime core.
 *
 * Proves the kernel contract: canonical vocabularies are exact (no forked
 * synonyms), the event primitive is bounded (drop-oldest ring, never a queue),
 * the error type cannot carry an unpublished code (foundation F16 by
 * construction), identity/clock/health are honest, and the published lock row
 * matches the module export surface exactly.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PLUGIN_RUNTIME_CONTRACT,
  PLUGIN_RUNTIME_CONTRACT_VERSION,
  PLUGIN_TRUST_CLASSES,
  PLUGIN_RUNTIME_LOCALITIES,
  PLUGIN_LIFECYCLE_STATES,
  PLUGIN_EVENT_TYPES,
  PLUGIN_CORE,
  PLUGIN_EVENT_LIMIT_DEFAULT,
  PLUGIN_EVENT_LIMIT_MAX,
  PUBLISHED_ERROR_CODES,
  PluginRuntimeError,
  createPluginRuntime,
  bootstrapPluginCore,
} from '../src/lego/plugin-runtime.mjs';

const APP_ROOT = fileURLToPath(new URL('../', import.meta.url));

test('the contract identity is published as lego.plugin-runtime@0.1.0', () => {
  assert.equal(PLUGIN_RUNTIME_CONTRACT, 'lego.plugin-runtime');
  assert.equal(PLUGIN_RUNTIME_CONTRACT_VERSION, '0.1.0');
  assert.equal(PLUGIN_CORE.contract, 'lego.plugin-runtime@0.1.0');
});

test('trust classes are exactly the four posture classes of design §8', () => {
  assert.deepEqual([...PLUGIN_TRUST_CLASSES], ['CORE', 'TRUSTED', 'ISOLATED', 'SANDBOXED']);
  assert.ok(Object.isFrozen(PLUGIN_TRUST_CLASSES));
});

test('runtime localities are exactly the four classes of design §6', () => {
  assert.deepEqual([...PLUGIN_RUNTIME_LOCALITIES], ['IN_PROCESS', 'WASM', 'ISOLATED_PROCESS', 'REMOTE']);
  assert.ok(Object.isFrozen(PLUGIN_RUNTIME_LOCALITIES));
});

test('the lifecycle is exactly the eight states of design §15, in order', () => {
  assert.deepEqual(
    [...PLUGIN_LIFECYCLE_STATES],
    ['DISCOVERED', 'VALIDATING', 'STARTING', 'HEALTHY', 'DEGRADED', 'DRAINING', 'STOPPED', 'QUARANTINED'],
  );
  assert.equal(new Set(PLUGIN_LIFECYCLE_STATES).size, 8, 'no duplicate state words');
});

test('the core identity is CORE-only and frozen', () => {
  assert.equal(PLUGIN_CORE.trust, 'CORE');
  assert.equal(PLUGIN_CORE.kind, 'core');
  assert.ok(Object.isFrozen(PLUGIN_CORE));
  assert.throws(() => {
    'use strict';
    PLUGIN_CORE.trust = 'SANDBOXED';
  }, TypeError);
});

test('the clock is injectable and the instance freezes its surface', () => {
  let t = 1000;
  const runtime = createPluginRuntime({ now: () => (t += 25) });
  assert.equal(runtime.bootedAt, 1025, 'creation consumes exactly one tick');
  assert.equal(runtime.now(), 1050);
  assert.equal(runtime.now(), 1075);
  assert.ok(Object.isFrozen(runtime));
  assert.throws(() => {
    'use strict';
    runtime.evil = true;
  }, TypeError);
  assert.throws(() => createPluginRuntime({ now: () => 'not-a-number' }), TypeError);
  assert.throws(() => createPluginRuntime({ now: 42 }), TypeError);
});

test('bootstrap emits exactly one core.booted event and returns a runtime', () => {
  const runtime = bootstrapPluginCore({ now: () => 7 });
  const events = runtime.events();
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'core.booted');
  assert.equal(events[0].at, 7);
  assert.equal(runtime.bootedAt, 7);
});

test('unknown event types fail closed with the published contract_violation code', () => {
  const runtime = createPluginRuntime();
  assert.throws(
    () => runtime.recordEvent('plugin.exploded', {}),
    (error) => error instanceof PluginRuntimeError && error.code === 'lego.contract_violation',
  );
});

test('event detail must be a JSON-serializable object — cycles and functions are rejected', () => {
  const runtime = createPluginRuntime();
  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(
    () => runtime.recordEvent('plugin.registered', cyclic),
    (error) => error.code === 'lego.contract_violation',
  );
  assert.throws(
    () => runtime.recordEvent('plugin.registered', () => {}),
    (error) => error.code === 'lego.contract_violation',
  );
});

test('the event ring is bounded: beyond the limit the oldest drops and dropped is counted', () => {
  const runtime = createPluginRuntime({ eventLimit: 4 });
  let clock = 0;
  for (let i = 0; i < 100; i += 1) {
    runtime.recordEvent('plugin.registered', { seq: i });
    clock += 1;
  }
  const events = runtime.events();
  assert.equal(events.length, 4, 'stored never exceeds the bound');
  assert.deepEqual(
    events.map((event) => event.detail.seq),
    [96, 97, 98, 99],
    'drop-oldest keeps the freshest tail',
  );
  const health = runtime.health();
  assert.equal(health.events.stored, 4);
  assert.equal(health.events.limit, 4);
  assert.equal(health.events.dropped, 96, 'loss is counted, not hidden');
  assert.equal(health.status, 'ok', 'bounded loss is telemetry, not failure');
});

test('eventLimit is validated against honest bounds', () => {
  for (const bad of [0, -1, 1.5, '8', null, PLUGIN_EVENT_LIMIT_MAX + 1]) {
    assert.throws(() => createPluginRuntime({ eventLimit: bad }), TypeError, `rejects ${String(bad)}`);
  }
  const tight = createPluginRuntime({ eventLimit: 1 });
  tight.recordEvent('core.booted', {});
  tight.recordEvent('core.booted', {});
  assert.equal(tight.events().length, 1);
  assert.equal(tight.health().events.dropped, 1);
  assert.equal(PLUGIN_EVENT_LIMIT_DEFAULT, 64);
});

test('PluginRuntimeError refuses unpublished codes and publishes its published set', () => {
  assert.throws(() => new PluginRuntimeError('lego.not_a_real_code', 'nope'), TypeError);
  const error = new PluginRuntimeError('lego.access_denied', 'denied', { details: { capability: 'secrets' } });
  assert.equal(error.code, 'lego.access_denied');
  assert.equal(error.retryable, false);
  assert.deepEqual(error.details, { capability: 'secrets' });
  assert.ok(Object.isFrozen(error.details), 'details are a frozen snapshot — no post-hoc mutation');
  // The published set itself is exactly the errors contract — no forked list.
  const contract = JSON.parse(readFileSync(join(APP_ROOT, 'src/lego/contracts/errors.contract.json'), 'utf8'));
  assert.deepEqual([...PUBLISHED_ERROR_CODES], contract.codes.map((entry) => entry.code));
  assert.equal(new Set(PUBLISHED_ERROR_CODES).size, PUBLISHED_ERROR_CODES.length, 'no duplicate codes');
});

test('health reports a core-ok snapshot with plugin count reserved for the registry slice', () => {
  const runtime = bootstrapPluginCore();
  const health = runtime.health();
  assert.equal(health.status, 'ok');
  assert.equal(health.core, 'ok');
  assert.equal(health.plugins, 0);
  assert.ok(typeof health.bootedAt === 'number');
  assert.deepEqual(Object.keys(health.events).sort(), ['dropped', 'limit', 'stored']);
});

test('the lock row promises exactly this module export surface', () => {
  const lock = JSON.parse(readFileSync(join(APP_ROOT, 'src/lego/contracts/contract-lock.json'), 'utf8'));
  const row = lock.contracts.find((entry) => entry.id === 'lego.plugin-runtime');
  assert.ok(row, 'lego.plugin-runtime is locked');
  assert.match(row.version, /^\d+\.\d+\.\d+$/, 'the row carries a semver version (exact pins live in the newest slice suite)');
  assert.equal(row.owner, 'agent-1');
  assert.equal(row.domain, 'lego-foundation');
  assert.equal(row.status, 'implemented');
  assert.ok(row.surface.includes('src/lego/plugin-runtime.mjs'), 'runtime core stays on the surface');
  assert.ok(row.tests.includes('apps/n8n-lego/test/lego-plugin-runtime.test.mjs'));
  const source = readFileSync(join(APP_ROOT, 'src/lego/plugin-runtime.mjs'), 'utf8');
  const exported = [...source.matchAll(/^export (?:const|class|function) (\w+)/gm)].map((match) => match[1]).sort();
  const locked = [...row.exports['src/lego/plugin-runtime.mjs']].sort();
  assert.deepEqual(locked, exported, 'lock ⇄ module exports');
});
