/**
 * P2.27.3 — capability + permission policy (deny-by-default).
 *
 * Proves: the ceiling map is exact and monotonic; foundation OS-capabilities
 * are decided by foundation.mjs against the ceiling (defaults never widen by
 * isolation); domain tokens pass only on exact explicit grants; wildcards
 * cannot even be stated; manifest evaluation splits granted/denied with
 * reasons; assertCapability throws the published access_denied code; and
 * delegation is attenuated — a child never holds more than its parent.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TRUST_CLASS_CAPABILITY_CEILING,
  PLUGIN_GRANTS_MAX,
  normalizeGrants,
  isFoundationCapability,
  evaluateCapability,
  evaluateManifestPolicy,
  assertCapability,
  attenuateDelegation,
} from '../src/lego/plugin-policy.mjs';
import { CAPABILITIES } from '../src/lego/foundation.mjs';
import { PLUGIN_TRUST_CLASSES, PluginRuntimeError } from '../src/lego/plugin-runtime.mjs';

const APP_ROOT = fileURLToPath(new URL('../', import.meta.url));

test('the ceiling map covers exactly the four trust classes with foundation levels — monotonic: more isolation, less default authority', () => {
  assert.deepEqual(Object.keys(TRUST_CLASS_CAPABILITY_CEILING).sort(), [...PLUGIN_TRUST_CLASSES].sort());
  assert.deepEqual(TRUST_CLASS_CAPABILITY_CEILING, {
    CORE: 'core',
    TRUSTED: 'verified',
    ISOLATED: 'community',
    SANDBOXED: 'untrusted',
  });
  assert.ok(Object.isFrozen(TRUST_CLASS_CAPABILITY_CEILING));
  // core defaults ⊇ verified ⊇ community = untrusted (empty)
  assert.equal(isFoundationCapability('network'), CAPABILITIES.includes('network'));
});

test('foundation capabilities decide via foundation.mjs at the ceiling level — CORE keeps defaults, SANDBOXED gets none', () => {
  const coreNet = evaluateCapability({ trustClass: 'CORE', capability: 'network' });
  assert.equal(coreNet.granted, true);
  assert.equal(coreNet.via, 'foundation-default');

  const trustedNet = evaluateCapability({ trustClass: 'TRUSTED', capability: 'network' });
  assert.equal(trustedNet.granted, true, 'verified default grant includes network');

  const trustedSubprocess = evaluateCapability({ trustClass: 'TRUSTED', capability: 'subprocess' });
  assert.equal(trustedSubprocess.granted, false, 'verified does not default-grant subprocess');

  const sandboxedNet = evaluateCapability({ trustClass: 'SANDBOXED', capability: 'network' });
  assert.equal(sandboxedNet.granted, false, 'untrusted ceiling: no defaults');
  assert.equal(sandboxedNet.via, 'denied');

  const isolatedNet = evaluateCapability({ trustClass: 'ISOLATED', capability: 'network' });
  assert.equal(isolatedNet.granted, false, 'community ceiling: empty defaults');
});

test('an explicit grant lifts a foundation capability at any trust class — grants are deliberate, not implied', () => {
  const verdict = evaluateCapability({
    trustClass: 'SANDBOXED',
    capability: 'network',
    grants: ['network'],
  });
  assert.equal(verdict.granted, true);
  assert.equal(verdict.via, 'explicit-grant');
  assert.match(verdict.reason, /explicitly granted/);
});

test('domain capabilities are deny-by-default: exact grant only, no foundation fallback', () => {
  assert.equal(isFoundationCapability('memory.read'), false);
  const denied = evaluateCapability({ trustClass: 'CORE', capability: 'memory.read' });
  assert.equal(denied.granted, false, 'CORE status does not imply domain tokens');
  assert.equal(denied.via, 'denied');
  assert.match(denied.reason, /deny-by-default/);

  const granted = evaluateCapability({ trustClass: 'CORE', capability: 'memory.read', grants: ['memory.read'] });
  assert.equal(granted.granted, true);
  assert.equal(granted.via, 'explicit-grant');

  // near-miss tokens never match (no suffix/prefix authority)
  const nearMiss = evaluateCapability({ trustClass: 'CORE', capability: 'memory.write', grants: ['memory.read'] });
  assert.equal(nearMiss.granted, false);
});

test('wildcards cannot be stated — * , all, and .* are contract violations, not denials', () => {
  for (const bad of [['*'], ['all'], ['memory.*'], ['network', '*'], ['EVERYTHING.THING']]) {
    assert.throws(
      () => normalizeGrants(bad),
      (error) => error instanceof PluginRuntimeError && error.code === 'lego.contract_violation',
      `rejects ${JSON.stringify(bad)}`,
    );
  }
  // and a wildcard inside an evaluation request fails closed the same way
  assert.throws(
    () => evaluateCapability({ trustClass: 'CORE', capability: 'network', grants: ['*'] }),
    (error) => error.code === 'lego.contract_violation',
  );
});

test('grant lists are bounded, patterned and duplicate-free', () => {
  assert.throws(() => normalizeGrants('network'), (e) => e.code === 'lego.contract_violation');
  assert.throws(() => normalizeGrants(['network', 'network']), (e) => e.code === 'lego.contract_violation');
  assert.throws(() => normalizeGrants(['Bad Token']), (e) => e.code === 'lego.contract_violation');
  const tooMany = Array.from({ length: PLUGIN_GRANTS_MAX.grants + 1 }, (_, i) => `cap${i}`);
  assert.throws(() => normalizeGrants(tooMany), (e) => e.code === 'lego.contract_violation');
  assert.ok(Object.isFrozen(normalizeGrants(['network'])));
});

test('unknown trust classes and malformed capabilities fail closed as contract violations', () => {
  assert.throws(
    () => evaluateCapability({ trustClass: 'trusted', capability: 'network' }),
    (e) => e.code === 'lego.contract_violation',
  );
  assert.throws(
    () => evaluateCapability({ trustClass: 'ROOT', capability: 'network' }),
    (e) => e.code === 'lego.contract_violation',
  );
  assert.throws(
    () => evaluateCapability({ trustClass: 'CORE', capability: '' }),
    (e) => e.code === 'lego.contract_violation',
  );
});

test('manifest policy splits requested capabilities into granted/denied with reasons (§10 pipeline)', () => {
  const policy = evaluateManifestPolicy(
    {
      trustClass: 'TRUSTED',
      requestedCapabilities: ['network', 'subprocess', 'memory.read', 'secrets'],
    },
    { grants: ['memory.read', 'secrets'] },
  );
  // network = verified default; memory.read + secrets explicit; subprocess has
  // no grant at TRUSTED — it stays denied, which is the point of the split.
  assert.deepEqual([...policy.granted], ['network', 'memory.read', 'secrets']);
  assert.equal(policy.denied.length, 1);
  assert.equal(policy.denied[0].capability, 'subprocess');
  assert.match(policy.denied[0].reason, /subprocess/);

  const sandboxed = evaluateManifestPolicy({
    trustClass: 'SANDBOXED',
    requestedCapabilities: ['network', 'filesystem', 'pdf.render'],
  });
  assert.deepEqual([...sandboxed.granted], [], 'sandboxed plugin receives nothing by default');
  assert.equal(sandboxed.denied.length, 3);
  for (const entry of sandboxed.denied) assert.match(entry.reason, /./, 'every denial explains itself');
  assert.ok(Object.isFrozen(policy) && Object.isFrozen(policy.granted) && Object.isFrozen(policy.denied));
});

test('evaluateManifestPolicy validates its inputs fail-closed', () => {
  assert.throws(() => evaluateManifestPolicy(null), (e) => e.code === 'lego.contract_violation');
  assert.throws(
    () => evaluateManifestPolicy({ trustClass: 'NOPE', requestedCapabilities: [] }),
    (e) => e.code === 'lego.contract_violation',
  );
  assert.throws(
    () => evaluateManifestPolicy({ trustClass: 'CORE', requestedCapabilities: 'network' }),
    (e) => e.code === 'lego.contract_violation',
  );
  assert.throws(
    () => evaluateManifestPolicy({ trustClass: 'CORE', requestedCapabilities: [] }, { grants: ['*'] }),
    (e) => e.code === 'lego.contract_violation',
  );
});

test('assertCapability throws the published access_denied code with the reason attached', () => {
  assert.equal(assertCapability({ trustClass: 'CORE', capability: 'network' }), true);
  assert.throws(
    () => assertCapability({ trustClass: 'SANDBOXED', capability: 'filesystem' }),
    (error) =>
      error instanceof PluginRuntimeError &&
      error.code === 'lego.access_denied' &&
      typeof error.message === 'string' &&
      error.message.length > 10 &&
      error.details.capability === 'filesystem' &&
      error.details.trustClass === 'SANDBOXED',
  );
});

test('§11 delegation: grant(B) <= grant(A) — children keep the intersection, stripped extras are reported', () => {
  const parent = ['network', 'memory.read', 'secrets'];
  const childAsk = ['network', 'memory.read', 'memory.write', 'subprocess'];
  const verdict = attenuateDelegation(parent, childAsk);
  assert.deepEqual([...verdict.granted], ['network', 'memory.read']);
  assert.deepEqual([...verdict.stripped], ['memory.write', 'subprocess']);
  // nesting an empty parent grants the child nothing even for CORE-looking asks
  const hollow = attenuateDelegation([], ['network']);
  assert.deepEqual([...hollow.granted], []);
  assert.deepEqual([...hollow.stripped], ['network']);
  // wildcard parent or child fails closed before any intersection happens
  assert.throws(() => attenuateDelegation(['*'], ['network']), (e) => e.code === 'lego.contract_violation');
  assert.throws(() => attenuateDelegation(['network'], ['*']), (e) => e.code === 'lego.contract_violation');
  assert.ok(Object.isFrozen(verdict) && Object.isFrozen(verdict.granted) && Object.isFrozen(verdict.stripped));
});

test('the lego.plugin-runtime row keeps the P2.27.3 modules locked (exact surface pins live in the newest slice suite)', () => {
  const lock = JSON.parse(readFileSync(join(APP_ROOT, 'src/lego/contracts/contract-lock.json'), 'utf8'));
  const row = lock.contracts.find((entry) => entry.id === 'lego.plugin-runtime');
  assert.match(row.version, /^\d+\.\d+\.\d+$/);
  assert.ok(row.surface.includes('src/lego/plugin-policy.mjs'), 'plugin-policy.mjs stays on the surface');
  assert.ok(row.tests.includes('apps/n8n-lego/test/lego-plugin-policy.test.mjs'));
  for (const file of row.surface) {
    const source = readFileSync(join(APP_ROOT, file), 'utf8');
    const exported = [...source.matchAll(/^export (?:const|class|function) (\w+)/gm)].map((m) => m[1]).sort();
    const locked = [...(row.exports[file] ?? [])].sort();
    assert.deepEqual(locked, exported, `lock ⇄ module exports for ${file}`);
  }
});
