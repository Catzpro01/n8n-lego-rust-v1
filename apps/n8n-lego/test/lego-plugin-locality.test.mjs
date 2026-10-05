/**
 * P2.27.4 — runtime locality policy (design §6).
 *
 * Proves: the matrix is exact and frozen; defaults sit inside their rows;
 * each class' row matches the design rule (CORE in-process only; SANDBOXED
 * never in-process/remote); canonical-but-forbidden pairs raise the published
 * access_denied code while non-canonical input raises contract_violation;
 * recommender overrides never escape the class matrix; and the lock row (the
 * newest slice suite) pins the exact five-module surface.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LOCALITY_MATRIX,
  DEFAULT_LOCALITY,
  isLocalityAllowed,
  assertLocality,
  recommendLocality,
} from '../src/lego/plugin-locality.mjs';
import { PLUGIN_TRUST_CLASSES, PLUGIN_RUNTIME_LOCALITIES, PluginRuntimeError } from '../src/lego/plugin-runtime.mjs';

const APP_ROOT = fileURLToPath(new URL('../', import.meta.url));

test('the matrix covers exactly the four classes with only canonical localities, frozen', () => {
  assert.deepEqual(Object.keys(LOCALITY_MATRIX).sort(), [...PLUGIN_TRUST_CLASSES].sort());
  assert.ok(Object.isFrozen(LOCALITY_MATRIX));
  for (const row of Object.values(LOCALITY_MATRIX)) {
    assert.ok(Object.isFrozen(row));
    for (const locality of row) assert.ok(PLUGIN_RUNTIME_LOCALITIES.includes(locality), locality);
    assert.equal(new Set(row).size, row.length, 'no duplicate lanes');
  }
  assert.deepEqual(LOCALITY_MATRIX.CORE, ['IN_PROCESS']);
  assert.deepEqual(LOCALITY_MATRIX.TRUSTED, ['IN_PROCESS', 'ISOLATED_PROCESS', 'REMOTE']);
  assert.deepEqual(LOCALITY_MATRIX.ISOLATED, ['ISOLATED_PROCESS', 'REMOTE']);
  assert.deepEqual(LOCALITY_MATRIX.SANDBOXED, ['WASM', 'ISOLATED_PROCESS']);
});

test('every default locality sits inside its class row', () => {
  assert.deepEqual(Object.keys(DEFAULT_LOCALITY).sort(), [...PLUGIN_TRUST_CLASSES].sort());
  assert.deepEqual(DEFAULT_LOCALITY, {
    CORE: 'IN_PROCESS',
    TRUSTED: 'IN_PROCESS',
    ISOLATED: 'ISOLATED_PROCESS',
    SANDBOXED: 'WASM',
  });
  for (const trustClass of PLUGIN_TRUST_CLASSES) {
    assert.ok(
      LOCALITY_MATRIX[trustClass].includes(DEFAULT_LOCALITY[trustClass]),
      `${trustClass} default must be allowed`,
    );
  }
});

test('CORE never leaves the process; SANDBOXED never reaches in-process or remote', () => {
  assert.equal(isLocalityAllowed('CORE', 'WASM').allowed, false);
  assert.equal(isLocalityAllowed('CORE', 'ISOLATED_PROCESS').allowed, false);
  assert.equal(isLocalityAllowed('CORE', 'REMOTE').allowed, false);
  assert.equal(isLocalityAllowed('CORE', 'IN_PROCESS').allowed, true);

  assert.equal(isLocalityAllowed('SANDBOXED', 'IN_PROCESS').allowed, false, 'untrusted code never in-process');
  assert.equal(isLocalityAllowed('SANDBOXED', 'REMOTE').allowed, false, 'sandboxed plugins are not external services');
  assert.equal(isLocalityAllowed('SANDBOXED', 'WASM').allowed, true);
  assert.equal(isLocalityAllowed('SANDBOXED', 'ISOLATED_PROCESS').allowed, true);

  assert.equal(isLocalityAllowed('TRUSTED', 'WASM').allowed, false, 'audited code does not get the untrusted lane by design');
  assert.equal(isLocalityAllowed('ISOLATED', 'IN_PROCESS').allowed, false, 'the class name is the contract');
});

test('verdicts are frozen and explain themselves (operator model §20)', () => {
  const ok = isLocalityAllowed('TRUSTED', 'REMOTE');
  assert.ok(Object.isFrozen(ok));
  assert.equal(ok.allowed, true);
  assert.match(ok.reason, /TRUSTED may execute as REMOTE/);
  const no = isLocalityAllowed('ISOLATED', 'IN_PROCESS');
  assert.equal(no.allowed, false);
  assert.match(no.reason, /allowed: ISOLATED_PROCESS, REMOTE/);
});

test('assertLocality: allowed passes, forbidden raises the published access_denied code', () => {
  assert.equal(assertLocality('CORE', 'IN_PROCESS'), true);
  assert.throws(
    () => assertLocality('SANDBOXED', 'IN_PROCESS'),
    (error) =>
      error instanceof PluginRuntimeError &&
      error.code === 'lego.access_denied' &&
      error.details.trustClass === 'SANDBOXED' &&
      error.details.locality === 'IN_PROCESS' &&
      Array.isArray(error.details.allowedRow),
  );
});

test('non-canonical vocabulary input is a contract violation, not a policy denial', () => {
  assert.throws(
    () => isLocalityAllowed('trusted', 'IN_PROCESS'),
    (error) => error.code === 'lego.contract_violation',
  );
  assert.throws(
    () => isLocalityAllowed('CORE', 'in-process'),
    (error) => error.code === 'lego.contract_violation',
  );
  assert.throws(
    () => assertLocality('CORE', 'LOCAL_NETWORK'),
    (error) => error.code === 'lego.contract_violation',
  );
  assert.throws(
    () => recommendLocality('HIGH', {}),
    (error) => error.code === 'lego.contract_violation',
  );
  assert.throws(() => recommendLocality('CORE', { external: 'yes' }), (error) => error.code === 'lego.contract_violation');
});

test('recommendLocality follows the §6 rule — and overrides can never escape the class matrix', () => {
  assert.equal(recommendLocality('CORE'), 'IN_PROCESS');
  assert.equal(recommendLocality('TRUSTED'), 'IN_PROCESS');
  assert.equal(recommendLocality('ISOLATED'), 'ISOLATED_PROCESS');
  assert.equal(recommendLocality('SANDBOXED'), 'WASM');

  assert.equal(recommendLocality('TRUSTED', { external: true }), 'REMOTE', 'external work goes remote for classes that allow it');
  assert.equal(recommendLocality('ISOLATED', { external: true }), 'REMOTE');
  assert.equal(recommendLocality('TRUSTED', { crashRisk: true }), 'ISOLATED_PROCESS');
  assert.equal(recommendLocality('ISOLATED', { crashRisk: true }), 'ISOLATED_PROCESS');

  // overrides lose to the matrix, every time
  assert.equal(recommendLocality('CORE', { external: true }), 'IN_PROCESS', 'CORE has no remote lane to move to');
  assert.equal(recommendLocality('CORE', { crashRisk: true }), 'IN_PROCESS');
  assert.equal(recommendLocality('SANDBOXED', { external: true }), 'WASM', 'sandboxed plugins never become remote');
  assert.equal(recommendLocality('SANDBOXED', { crashRisk: true }), 'ISOLATED_PROCESS', 'crash risk may move within the row');
});

test('the matrix rows and the registry localities stay in lockstep (no orphan class, no orphan lane)', () => {
  const covered = new Set(Object.values(LOCALITY_MATRIX).flat());
  for (const locality of PLUGIN_RUNTIME_LOCALITIES) {
    assert.ok(covered.has(locality), `locality ${locality} appears in no class row`);
  }
  for (const trustClass of PLUGIN_TRUST_CLASSES) {
    assert.ok(LOCALITY_MATRIX[trustClass].length >= 1, `${trustClass} has at least one lane`);
  }
});

test('the lego.plugin-runtime row keeps the P2.27.4 modules locked (exact surface pins live in the newest slice suite)', () => {
  const lock = JSON.parse(readFileSync(join(APP_ROOT, 'src/lego/contracts/contract-lock.json'), 'utf8'));
  const row = lock.contracts.find((entry) => entry.id === 'lego.plugin-runtime');
  assert.match(row.version, /^\d+\.\d+\.\d+$/);
  assert.ok(row.surface.includes('src/lego/plugin-locality.mjs'), 'plugin-locality.mjs stays on the surface');
  assert.ok(row.tests.includes('apps/n8n-lego/test/lego-plugin-locality.test.mjs'));
  for (const file of row.surface) {
    const source = readFileSync(join(APP_ROOT, file), 'utf8');
    const exported = [...source.matchAll(/^export (?:const|class|function) (\w+)/gm)].map((m) => m[1]).sort();
    const locked = [...(row.exports[file] ?? [])].sort();
    assert.deepEqual(locked, exported, `lock ⇄ module exports for ${file}`);
  }
});
