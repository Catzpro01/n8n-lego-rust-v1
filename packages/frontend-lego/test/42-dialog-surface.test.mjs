/**
 * P2-S03 Layer 3 — the dialogs / overlays pilot (surface `dialogs`).
 *
 * Second strangler slice of P2-S03's Layers 3-5, in the #241/#245/#240 shape:
 * one additional low-risk surface, `mode: pilot`, `rollback: pilot-not-primary`,
 * original editor stays the default. The tests defend the design decisions the
 * way the #241/#245/#240 suites do:
 *
 *   A  the contract validates against the closed vocabularies, and a mutated
 *      one is refused (unknown field, unknown state, wrong authority)
 *   B  all four region states are parity-`equivalent` against the reference
 *      fixtures; a drifted field is `migration-required`
 *   C  open / close is a real mutation: open (hand-over) is `ready`, close is
 *      `empty` (not a fifth "closed" state); the payload is cleared on close
 *   D  bounded: the title and body lengths are capped and the bounds are
 *      enforced, not just declared
 *   E  the payload shape is closed (unknown field refused) and the kind is a
 *      closed set that decides the declared ready actions
 *   F  accessibility derived once per state; only `error` is assertive, only
 *      `loading` is busy, a closed dialog is hidden
 *   G  degradation is observable, never silent; observe() is a snapshot, not a
 *      replay; history is deterministic
 *   H  the surface reaches consumers only through the existing registry seam,
 *      opt-in, and the pilot gate's closed set includes it
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  DIALOG_A11Y,
  DIALOG_CAPABILITY_ID,
  DIALOG_INTERACTIONS,
  DIALOG_KINDS,
  DIALOG_LIMITS,
  DIALOG_MESSAGE_SLOT,
  DIALOG_PAYLOAD_FIELDS,
  DIALOG_SURFACE_ID,
  DIALOG_SURFACE_VERSION,
  createDialogSurface,
  referenceClosedObservation,
  referenceErrorObservation,
  referencePreparingObservation,
  referenceReadyObservation,
  validateDialogSurfaceContract,
  dialogSurfaceContract,
} from '../src/dialog-surface.mjs';
import { compareObservations, PARITY_STATUSES } from '../src/parity.mjs';
import { REGION_STATES, SURFACE_MODES } from '../src/surface-contract.mjs';
import { MESSAGE_SLOTS, isValidMessageKey } from '../src/i18n.mjs';
import { PACKAGE_ROOT, loadManifests } from '../src/manifests.mjs';
import { createFrontendRegistry } from '../src/registry.mjs';

const CONFIRM = { title: 'Delete workflow?', body: 'This cannot be undone.', kind: 'confirmation' };

/* --------------------------------------------------------------- the contract */

test('the pilot contract validates against the closed vocabularies', () => {
  const { ok, errors } = validateDialogSurfaceContract();
  assert.equal(ok, true, errors.join('; '));
});

test('the contract reuses REGION_STATES, not a forked list', () => {
  const contract = dialogSurfaceContract();
  for (const state of REGION_STATES) {
    assert.ok(contract.states[state], `contract must declare "${state}"`);
    assert.ok(typeof contract.states[state].messageKey === 'string');
  }
});

test('a contract with an unknown top-level field is refused', () => {
  const { ok } = validateDialogSurfaceContract({ ...dialogSurfaceContract(), bogus: true });
  assert.equal(ok, false);
});

test('a contract claiming execute authority is refused (UI never authorizes)', () => {
  const { ok } = validateDialogSurfaceContract({
    ...dialogSurfaceContract(),
    outputBoundary: { ...dialogSurfaceContract().outputBoundary, authority: 'execute' },
  });
  assert.equal(ok, false);
});

test('the contract is a pilot that rolls back to the reference, never primary', () => {
  const contract = dialogSurfaceContract();
  assert.equal(contract.mode, 'pilot');
  assert.ok(SURFACE_MODES.includes(contract.mode));
  assert.equal(contract.rollback.strategy, 'pilot-not-primary');
  assert.equal(contract.rollback.reference, 'n8n-editor-ui@2.9.4');
});

test('every state messageKey lives in the declared slot and is a valid key', () => {
  const contract = dialogSurfaceContract();
  for (const state of REGION_STATES) {
    const key = contract.states[state].messageKey;
    assert.ok(isValidMessageKey(key), `${state}: ${key} is a valid message key`);
    assert.ok(key.startsWith(`${contract.localization.slot}.`), `${state}: key is in the declared slot`);
  }
});

test('the declared message slot is a real, known slot', () => {
  const contract = dialogSurfaceContract();
  assert.ok(MESSAGE_SLOTS.some((s) => s.id === contract.localization.slot), 'slot is declared');
});

/* ------------------------------------------------------------------- parity (B) */

test('a closed dialog is parity-equivalent to the reference', () => {
  const surface = createDialogSurface();
  const { status } = compareObservations(referenceClosedObservation(), surface.observe());
  assert.equal(status, 'equivalent');
});

test('a preparing dialog is parity-equivalent to the reference', () => {
  const surface = createDialogSurface();
  surface.setPreparing();
  const { status } = compareObservations(referencePreparingObservation(), surface.observe());
  assert.equal(status, 'equivalent');
});

test('a shown confirmation dialog is parity-equivalent for its kind', () => {
  const surface = createDialogSurface();
  surface.openDialog(CONFIRM);
  const { status } = compareObservations(referenceReadyObservation({ kind: 'confirmation' }), surface.observe());
  assert.equal(status, 'equivalent');
});

test('a shown form dialog declares submit/cancel and is parity-equivalent', () => {
  const surface = createDialogSurface();
  surface.openDialog({ title: 'Save credential', body: 'Enter the new secret.', kind: 'form' });
  assert.deepEqual(surface.displayModel().actions, ['submit', 'cancel']);
  const { status } = compareObservations(referenceReadyObservation({ kind: 'form' }), surface.observe());
  assert.equal(status, 'equivalent');
});

test('a render failure is parity-equivalent for its declared error kind', () => {
  const surface = createDialogSurface();
  surface.openDialog(CONFIRM);
  surface.contentFailure({ kind: 'server', message: 'boom' });
  const { status } = compareObservations(referenceErrorObservation(), surface.observe());
  assert.equal(status, 'equivalent');
});

test('a mismatched error kind is migration-required, not a silent pass', () => {
  const surface = createDialogSurface();
  surface.openDialog(CONFIRM);
  surface.contentFailure({ kind: 'network', message: 'boom' });
  const { status, diffs } = compareObservations(referenceErrorObservation(), surface.observe());
  assert.equal(status, 'migration-required');
  assert.ok(diffs.some((d) => d.field === 'error'), 'the error kind is the drifted field');
});

test('the parity harness is fail-closed: a drifted field is not equivalent', () => {
  const surface = createDialogSurface();
  surface.openDialog(CONFIRM);
  // A drifted fixture (wrong regionState) must not be equivalent.
  const drifted = { ...referenceReadyObservation({ kind: 'confirmation' }) };
  const { status } = compareObservations(drifted, { ...surface.observe(), regionState: 'empty' });
  assert.notEqual(status, 'equivalent');
});

test('all four parity statuses are a closed vocabulary', () => {
  assert.equal(PARITY_STATUSES.length, 4);
});

/* ------------------------------------------------------------- open / close (C) */

test('opening hands over the content and the region becomes ready', () => {
  const surface = createDialogSurface();
  assert.equal(surface.regionState, 'empty');
  assert.equal(surface.open, false);
  assert.equal(surface.openDialog(CONFIRM), 'ready');
  assert.equal(surface.regionState, 'ready');
  assert.equal(surface.open, true);
  assert.equal(surface.displayModel().title, 'Delete workflow?');
});

test('closing is empty (not a fifth state) and clears the payload', () => {
  const surface = createDialogSurface();
  surface.openDialog(CONFIRM);
  assert.equal(surface.closeDialog(), 'empty');
  assert.equal(surface.regionState, 'empty');
  assert.equal(surface.open, false);
  assert.equal(surface.displayModel().title, null, 'the dismissed payload is gone');
});

test('a closed dialog is hidden: a dismissed dialog is not an announced region', () => {
  const surface = createDialogSurface();
  surface.openDialog(CONFIRM);
  assert.equal(surface.a11y().hidden, false, 'an open dialog is not hidden');
  surface.closeDialog();
  assert.equal(surface.a11y().hidden, true, 'a closed dialog is hidden');
});

test('preparing retains the payload; the region is loading', () => {
  const surface = createDialogSurface();
  surface.openDialog(CONFIRM);
  surface.setPreparing();
  assert.equal(surface.regionState, 'loading');
  assert.equal(surface.displayModel().title, 'Delete workflow?', 'the payload is retained');
});

/* ------------------------------------------------------------------- bounds (D) */

test('an over-long title is refused, not silently truncated', () => {
  const surface = createDialogSurface();
  assert.throws(
    () => surface.openDialog({ title: 'x'.repeat(DIALOG_LIMITS.maxTitleLength + 1), kind: 'notice' }),
    /title exceeds/,
  );
});

test('an over-long body is refused, not silently truncated', () => {
  const surface = createDialogSurface();
  assert.throws(
    () => surface.openDialog({ title: 'ok', body: 'x'.repeat(DIALOG_LIMITS.maxBodyLength + 1), kind: 'notice' }),
    /body exceeds/,
  );
});

test('a title at the bound is accepted', () => {
  const surface = createDialogSurface();
  assert.equal(surface.openDialog({ title: 'x'.repeat(DIALOG_LIMITS.maxTitleLength), kind: 'notice' }), 'ready');
});

/* --------------------------------------------------------------- closed shape (E) */

test('a payload with an unknown field is refused (closed shape)', () => {
  const surface = createDialogSurface();
  assert.throws(() => surface.openDialog({ title: 'ok', bogus: 1 }), /unknown field/);
});

test('a payload missing the title is refused', () => {
  const surface = createDialogSurface();
  assert.throws(() => surface.openDialog({ body: 'no title' }), /title must be a non-empty string/);
});

test('a non-object payload is refused', () => {
  const surface = createDialogSurface();
  assert.throws(() => surface.openDialog('just a string'), /must be a plain object/);
});

test('the payload field set is the closed, documented one', () => {
  assert.deepEqual([...DIALOG_PAYLOAD_FIELDS], ['title', 'body', 'kind']);
});

test('the kind is a closed set and an unknown kind is refused', () => {
  const surface = createDialogSurface();
  assert.deepEqual([...DIALOG_KINDS], ['confirmation', 'form', 'notice']);
  assert.throws(() => surface.openDialog({ title: 'ok', kind: 'nope' }), /kind must be one of/);
});

test('the kind defaults to notice when omitted', () => {
  const surface = createDialogSurface();
  surface.openDialog({ title: 'Heads up' });
  assert.equal(surface.displayModel().kind, 'notice');
  assert.deepEqual(surface.displayModel().actions, ['acknowledge']);
});

/* ------------------------------------------------------------------- a11y (F) */

test('accessibility is derived once per state and cannot drift', () => {
  for (const state of REGION_STATES) {
    assert.ok(DIALOG_A11Y[state], `a11y intent for "${state}"`);
    const { role, 'aria-live': live, 'aria-busy': busy, hidden } = DIALOG_A11Y[state];
    assert.equal(typeof role, 'string');
    assert.ok(['polite', 'assertive'].includes(live));
    assert.equal(typeof busy, 'boolean');
    assert.equal(typeof hidden, 'boolean');
  }
});

test('only `error` is assertive and only `loading` is busy', () => {
  assert.equal(DIALOG_A11Y.error['aria-live'], 'assertive');
  for (const state of ['loading', 'empty', 'ready']) {
    assert.equal(DIALOG_A11Y[state]['aria-live'], 'polite', `${state} is polite`);
  }
  assert.equal(DIALOG_A11Y.loading['aria-busy'], true);
  for (const state of ['empty', 'error', 'ready']) {
    assert.equal(DIALOG_A11Y[state]['aria-busy'], false, `${state} is not busy`);
  }
});

test('the a11y observable carries the state message key', () => {
  const surface = createDialogSurface();
  surface.openDialog(CONFIRM);
  const a11y = surface.a11y();
  assert.ok(a11y['aria-label-key'].startsWith(`${DIALOG_MESSAGE_SLOT}.`));
  assert.equal(a11y.role, 'dialog', 'a ready dialog has role dialog');
});

/* --------------------------------------------------------------- degradation (G) */

test('degradation is observable, never silent', () => {
  const surface = createDialogSurface();
  assert.equal(surface.degradedEvents, 0);
  surface.setRenderAvailable(false);
  assert.equal(surface.renderAvailable, false);
  assert.ok(surface.displayModel().degraded);
  assert.ok(surface.degradedEvents >= 1, 'a degradation event was recorded');
});

test('re-enabling rendering clears the degraded flag', () => {
  const surface = createDialogSurface({ renderAvailable: false });
  assert.ok(surface.displayModel().degraded);
  surface.setRenderAvailable(true);
  assert.equal(surface.renderAvailable, true);
  assert.equal(surface.displayModel().degraded, false);
});

test('observe() is a snapshot, not a replay of the cumulative history', () => {
  const surface = createDialogSurface();
  surface.openDialog(CONFIRM);
  surface.closeDialog();
  surface.openDialog(CONFIRM);
  const obs = surface.observe();
  // The events describe what is true now (ready), not a replay of the two opens.
  assert.deepEqual(obs.events, ['dialog:rendered']);
});

test('history is deterministic across identical scripts', () => {
  const run = () => {
    const s = createDialogSurface();
    s.setPreparing();
    s.openDialog(CONFIRM);
    s.contentFailure({ kind: 'server', message: 'boom' });
    s.closeDialog();
    return s.history.map((h) => h.event);
  };
  assert.deepEqual(run(), run());
});

test('the actions are declared, never executed: they change with the state', () => {
  const surface = createDialogSurface();
  assert.deepEqual(surface.displayModel().actions, [], 'a closed dialog offers no actions');
  surface.setPreparing();
  assert.deepEqual(surface.displayModel().actions, ['close'], 'preparing offers close');
  surface.openDialog(CONFIRM);
  assert.deepEqual(surface.displayModel().actions, ['confirm', 'cancel'], 'a ready confirmation offers confirm/cancel');
  surface.contentFailure({ kind: 'server', message: 'boom' });
  assert.deepEqual(surface.displayModel().actions, ['retry', 'close'], 'an error offers retry/close');
});

test('observe() reports a closed set of interaction booleans', () => {
  const surface = createDialogSurface();
  surface.openDialog(CONFIRM);
  const { interactions } = surface.observe();
  assert.deepEqual(Object.keys(interactions).sort(), [...DIALOG_INTERACTIONS].sort());
  assert.equal(interactions.confirm, true);
  assert.equal(interactions.cancel, true);
  assert.equal(interactions.submit, false);
  assert.equal(interactions.acknowledge, false);
});

/* ------------------------------------------------------- registry seam + gate (H) */

test('the capability is declared in the catalog and the module exists', async () => {
  const { capabilities } = loadManifests();
  const declaration = capabilities.find((c) => c.id === DIALOG_CAPABILITY_ID);
  assert.ok(declaration, `${DIALOG_CAPABILITY_ID} is declared in manifest/capabilities.json`);
  assert.equal(declaration.lifecycle, 'available');
  assert.equal(declaration.activation, 'lazy');
  assert.ok(existsSync(join(PACKAGE_ROOT, declaration.entry.slice(2))), `${declaration.entry} does not exist`);
});

test('the surface registers through the existing registry seam, opt-in', () => {
  // Reach consumers through the existing package/registry/adapter boundary. The
  // registry is created against the declared catalog exactly as the other
  // frontend suites do: an empty catalog is refused, because a registry with no
  // vocabulary cannot validate anything.
  const manifests = loadManifests();
  const registry = createFrontendRegistry({
    surfaces: manifests.surfaces,
    extensionPoints: manifests.extensionPoints,
  });
  const declaration = manifests.capabilities.find((c) => c.id === DIALOG_CAPABILITY_ID);
  // `register` THROWS on an invalid declaration; reaching the next line is the
  // assertion that the declaration is registrable.
  registry.register(declaration);
  const available = registry.availability().find((c) => c.id === DIALOG_CAPABILITY_ID);
  assert.ok(available, 'the capability is not in the registry vocabulary');
  assert.equal(available.activation, 'lazy');
  assert.equal(available.lifecycle, 'available');
});

test('the migration inventory entry is pilot-available and non-primary', async () => {
  const { readFileSync } = await import('node:fs');
  const inv = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'manifest', 'surface-migrations.json'), 'utf8'));
  const entry = inv.entries.find((e) => e.inventoryId === DIALOG_SURFACE_ID);
  assert.ok(entry, `${DIALOG_SURFACE_ID} is in the migration inventory`);
  assert.equal(entry.migrationStatus, 'pilot-available');
  assert.equal(entry.rollbackStrategy, 'pilot-not-primary');
  assert.ok(existsSync(join(PACKAGE_ROOT, '..', '..', entry.evidencePath)), `${entry.evidencePath} does not exist`);
});

test('the surface id follows the inventory grammar and the version is semver', () => {
  assert.match(DIALOG_SURFACE_ID, /^ui\.[a-z0-9]+(?:[.-][a-z0-9]+)+$/);
  assert.match(DIALOG_SURFACE_VERSION, /^\d+\.\d+\.\d+$/);
});

test('the dialogs surface has no backend capability of its own in the catalog', async () => {
  const { readFileSync } = await import('node:fs');
  const surfaces = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'manifest', 'surfaces.json'), 'utf8'));
  const dialog = surfaces.surfaces.find((s) => s.id === DIALOG_CAPABILITY_ID);
  assert.ok(dialog, 'the dialogs surface is declared');
  assert.equal(dialog.kind, 'overlay');
  assert.equal(dialog.backend.capability, 'none', 'dialogs carry no backend capability');
  assert.equal(dialog.backend.contract, null, 'dialogs carry no backend contract');
});

test('the dialogs surface is frontend-owned: it declares no backend endpoints', async () => {
  const { readFileSync } = await import('node:fs');
  const surfaces = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'manifest', 'surfaces.json'), 'utf8'));
  const dialog = surfaces.surfaces.find((s) => s.id === DIALOG_CAPABILITY_ID);
  assert.deepEqual(dialog.backend.endpoints, [], 'no endpoints of its own');
  assert.ok(dialog.extensionPoints.includes('ui:dialog:render'), 'it renders through the dialog seam');
});
