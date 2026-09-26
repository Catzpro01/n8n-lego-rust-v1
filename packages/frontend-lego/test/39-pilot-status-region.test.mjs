/**
 * Issue #241 — Scope D + E: the single pilot surface behind the Frontend LEGO boundary.
 *
 * Pilot = status region (loading / empty / error / ready).
 * - low risk, reversible, framework-neutral view-model
 * - original n8n UI remains primary/default
 * - integrates via declared capability + ui:error:render (existing seam)
 * - parity against a deterministic reference observation for each region state
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PILOT_ID,
  PILOT_CAPABILITY_ID,
  PILOT_MESSAGE_SLOT,
  pilotSurfaceContract,
  validatePilotSurfaceContract,
  createStatusRegion,
  referenceStatusObservation,
  assertValidPilotObservation,
} from '../src/pilot-status-region.mjs';
import { compareObservations } from '../src/parity.mjs';
import { REGION_STATES } from '../src/surface-contract.mjs';
import { MESSAGE_SLOTS } from '../src/i18n.mjs';
import { createFrontendRegistry, validateCapability } from '../src/registry.mjs';
import { createFrontendLego } from '../src/lego.mjs';
import { PACKAGE_ROOT, loadManifests } from '../src/manifests.mjs';
import { existsSync } from 'node:fs';
import { createTranslator, isValidMessageKey } from '../src/i18n.mjs';

const manifests = loadManifests();
const slotIds = new Set(MESSAGE_SLOTS.map((s) => s.id));
const surfaceIds = new Set(manifests.surfaces.map((s) => s.id));
const pointIds = new Set(manifests.extensionPoints.map((p) => p.id));
const knownCapabilities = new Set(manifests.capabilities.map((c) => c.id).concat(['reference-ui']));

test('the pilot surface contract validates against closed vocabularies', () => {
  const { ok, errors } = validatePilotSurfaceContract(pilotSurfaceContract(), {
    knownCapabilities,
    knownMessageSlots: slotIds,
    knownSurfaceIds: surfaceIds,
  });
  assert.equal(ok, true, errors.join('; '));
});

test('every pilot-available entry is a declared pilot with a capability and a test path', async () => {
  // Inventory pilot gate. This used to assert "exactly one pilot", which was true
  // while #241 was the only migrated surface. #245 adds a second pilot for its own
  // slice, so the gate is now a CLOSED SET: one pilot per originating slice, each
  // with a capability declaration and a test path that exists. Pinning the set is
  // stronger than counting — a pilot that appears without declaring itself fails.
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const inv = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'manifest', 'surface-migrations.json'), 'utf8'));
  const pilots = inv.entries.filter((e) => e.migrationStatus === 'pilot-available');
  assert.deepEqual(
    pilots.map((e) => e.inventoryId).sort(),
    [PILOT_ID, 'ui.primitives.notification-surface', 'ui.pages.dashboard'].sort(),
    'the pilot set is exactly the status region (#241), the notification surface (#245) and the dashboard workflow list (P2-S03)',
  );
  for (const pilot of pilots) {
    const capability = manifests.capabilities.find((c) => c.id === pilot.inventoryId.split('.').at(-1));
    assert.ok(capability, `${pilot.inventoryId} declares no capability`);
    assert.equal(capability.lifecycle, 'available', `${pilot.inventoryId} capability is not available`);
    assert.ok(pilot.evidencePath, `${pilot.inventoryId} names no evidence path`);
    assert.ok(
      existsSync(join(PACKAGE_ROOT, '..', '..', pilot.evidencePath)),
      `${pilot.evidencePath} does not exist`,
    );
    // A pilot must not claim to be primary: the reference UI stays the default.
    assert.equal(pilot.rollbackStrategy, 'pilot-not-primary', `${pilot.inventoryId} claims primacy`);
  }
});

test('the pilot capability declaration is valid for the existing registry catalog', () => {
  const declaration = manifests.capabilities.find((c) => c.id === PILOT_CAPABILITY_ID);
  assert.ok(declaration, 'status-region is declared in manifest/capabilities.json');
  const { ok, errors } = validateCapability(declaration, {
    surfaces: manifests.surfaces,
    extensionPoints: manifests.extensionPoints,
    owners: { 'agent-01': 'Frontend LEGO', 'agent-04': 'Workflow graph domain', manager: 'Manager' },
    knownNamespaces: manifests.capabilities
      .filter((c) => c.id !== PILOT_CAPABILITY_ID && typeof c.messages === 'string')
      .map((c) => c.messages),
  });
  assert.equal(ok, true, errors.join('; '));
  assert.ok(declaration.extensionPoints.includes('ui:error:render'));
  // ui:error:render belongs to error-surfaces — pilot must occupy that surface
  assert.ok(declaration.surfaces.includes('error-surfaces'));
  // must not claim notification hook without occupying notifications
  assert.equal(declaration.extensionPoints.includes('ui:notification:render'), false);
});

test('the pilot registers through the existing frontend registry boundary', () => {
  const registry = createFrontendRegistry({
    surfaces: manifests.surfaces,
    extensionPoints: manifests.extensionPoints,
    owners: manifests.owners,
    capabilities: [],
  });
  const declaration = manifests.capabilities.find((c) => c.id === PILOT_CAPABILITY_ID);
  const registered = registry.register(declaration);
  assert.ok(registered);
  const descriptor = registry.descriptor();
  assert.ok(
    descriptor.capabilities.some((c) => c.id === PILOT_CAPABILITY_ID),
    'pilot capability visible in descriptor after register',
  );
});

test('createFrontendLego boot keeps original UI default and surfaces the declared pilot metadata', () => {
  const lego = createFrontendLego({
    app: { name: 'n8n lego', version: '0.1.0', referenceVersion: '2.9.4' },
    ui: { basePath: '/', restEndpoint: 'rest' },
    capabilities: [manifests.capabilities.find((c) => c.id === PILOT_CAPABILITY_ID)],
  });
  const availability = lego.availability();
  const pilot = availability.find((c) => c.id === PILOT_CAPABILITY_ID);
  assert.ok(pilot, 'pilot appears in availability (declared metadata)');
  assert.equal(pilot.status, 'available');
  // Fail-soft boundary: describe still works
  const described = lego.describe ? lego.describe() : null;
  if (described) assert.equal(described.backendUntouched, true);
});

test('status region view-model covers all four region states with a11y + message keys', () => {
  const region = createStatusRegion({ state: 'ready' });
  assert.equal(region.state, 'ready');
  assert.equal(region.mode, 'pilot');
  assert.equal(region.contract.rollback.strategy, 'pilot-not-primary');
  assert.equal(region.contract.outputBoundary.authority, 'declare-request-render');

  for (const state of REGION_STATES) {
    if (region.state !== state) region.transition(state);
    assert.equal(region.state, state);
    const obs = region.observe();
    assertValidPilotObservation(obs);
    assert.equal(obs.regionState, state);
    assert.ok(isValidMessageKey(obs.localization.messageKeys.find((k) => k.includes(state === 'ready' ? 'ready' : state)) ?? obs.localization.messageKeys[0])
      || obs.localization.messageKeys.length === 4);
    const a11y = region.a11y();
    if (state === 'loading') assert.equal(a11y['aria-busy'], 'true');
    else assert.equal(a11y['aria-busy'], 'false');
    if (state === 'error') {
      assert.equal(a11y.role, 'alert');
      assert.equal(region.observe().interactions['shows-retry'], true);
    } else {
      assert.equal(region.observe().interactions['shows-retry'], false);
    }
  }
});

test('error state flows through the existing error display model', () => {
  const region = createStatusRegion({ state: 'loading' });
  region.transition('error', {
    error: { kind: 'network', code: 'E_NET', message: 'boom' },
  });
  const model = region.displayModel();
  assert.equal(typeof model.messageKey, 'string');
  assert.ok(model.actions.includes('retry'));
  const obs = region.observe();
  assert.equal(obs.error.kind, 'network');
  assert.equal(obs.loading, false);
});

test('parity: pilot observation is compatible with the reference fixture for every state', () => {
  for (const state of REGION_STATES) {
    const region = createStatusRegion({ state: 'ready' });
    if (region.state !== state) region.transition(state);
    const cand = region.observe();
    const ref = referenceStatusObservation({ state });
    const result = compareObservations(ref, cand);
    assert.ok(
      result.status === 'compatible' || result.status === 'equivalent',
      `${state} → ${result.status}: ${JSON.stringify(result.diffs)}`,
    );
    assert.notEqual(result.status, 'breaking');
    assert.notEqual(result.status, 'migration-required');
  }
});

test('pilot does not become primary: inventory rollback + contract mode stay pilot', async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const inv = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'manifest', 'surface-migrations.json'), 'utf8'));
  const pilot = inv.entries.find((e) => e.inventoryId === PILOT_ID);
  assert.equal(pilot.migrationStatus, 'pilot-available');
  assert.equal(pilot.rollbackStrategy, 'pilot-not-primary');
  assert.equal(pilot.currentOwner, 'n8n-editor-ui');
  const contract = pilotSurfaceContract();
  assert.equal(contract.mode, 'pilot');
  assert.equal(contract.rollback.reference, 'n8n-editor-ui@2.9.4');
  assert.equal(contract.lifecycleState, 'available', 'not active/primary at boot');
});

test('localization keys use the system-messages slot grammar only', () => {
  const contract = pilotSurfaceContract();
  assert.equal(contract.localization.slot, PILOT_MESSAGE_SLOT);
  for (const state of REGION_STATES) {
    const key = contract.states[state].messageKey;
    assert.ok(key.startsWith(`${PILOT_MESSAGE_SLOT}.`), key);
    assert.ok(isValidMessageKey(key), key);
  }
  // translator can be created for the slot structure (structure-only catalogs are allowed)
  const translator = createTranslator({ locale: 'en', catalogs: [] });
  assert.equal(typeof translator.t, 'function');
});

test('pilot isolation: no network, no authority, no credential fields in contract JSON', () => {
  const contract = pilotSurfaceContract();
  const raw = JSON.stringify(contract).toLowerCase();
  assert.equal(raw.includes('password'), false);
  assert.equal(raw.includes('secret'), false);
  assert.equal(raw.includes('http://'), false);
  assert.equal(raw.includes('authorize'), false);
  assert.equal(contract.outputBoundary.authority, 'declare-request-render');
  assert.equal(contract.transport, 'local');
  assert.equal(contract.interaction, 'event');
});
