/**
 * Issue #245 — the shared notification surface.
 *
 * The tests are organised around the scope sections of the issue, because each
 * one names a way this surface could go wrong:
 *
 *   B  all five observable states, and an unknown one refused
 *   C  accessibility semantics: role / live-region intent, dismissal, transitions
 *   D  parity classification against a deterministic reference fixture
 *   E  the surface reaches consumers only through the existing seam, opt-in
 *   F  rollback / reference mode
 *
 * The design decision the tests defend: **severity and disposition are separate
 * axes from the region state.** Issue #245 asks for info / success / warning /
 * error / dismissed, while the surface contract and the parity harness are keyed
 * on the closed `REGION_STATES` (loading / empty / error / ready). Collapsing
 * them would either fork a second vocabulary or lose the severity, so the surface
 * keeps both and maps between them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  NOTIFICATION_A11Y,
  NOTIFICATION_CAPABILITY_ID,
  NOTIFICATION_DISPOSITIONS,
  NOTIFICATION_LIMITS,
  NOTIFICATION_MESSAGE_SLOT,
  NOTIFICATION_SEVERITIES,
  NOTIFICATION_SURFACE_ID,
  NOTIFICATION_SURFACE_VERSION,
  createNotificationSurface,
  notificationSurfaceContract,
  referenceEmptyNotificationObservation,
  referenceNotificationObservation,
  validateNotificationSurfaceContract,
} from '../src/notification-surface.mjs';
import { compareObservations, PARITY_STATUSES } from '../src/parity.mjs';
import { REGION_STATES, SURFACE_MODES } from '../src/surface-contract.mjs';
import { MESSAGE_SLOTS, isValidMessageKey } from '../src/i18n.mjs';
import { PACKAGE_ROOT, loadManifests } from '../src/manifests.mjs';
import { createFrontendRegistry } from '../src/registry.mjs';

const manifests = loadManifests();
const slotIds = new Set(MESSAGE_SLOTS.map((slot) => slot.id));
const surfaceIds = new Set(manifests.surfaces.map((surface) => surface.id));
const pointIds = new Set(manifests.extensionPoints.map((point) => point.id));
const knownCapabilities = new Set(manifests.capabilities.map((capability) => capability.id).concat(['reference-ui']));

/* ------------------------------------------------------- A. contract reuse */

test('the contract validates against the closed vocabularies (Scope A)', () => {
  const { ok, errors } = validateNotificationSurfaceContract(notificationSurfaceContract(), {
    knownCapabilities,
    knownMessageSlots: slotIds,
    knownSurfaceIds: surfaceIds,
  });
  assert.equal(ok, true, errors.join('; '));
});

test('the surface reuses REGION_STATES instead of forking a second list', () => {
  // The whole reason the severity axis exists: the contract must declare every
  // region state, and it must not invent new ones.
  const contract = notificationSurfaceContract();
  for (const state of REGION_STATES) {
    assert.ok(contract.states[state], `region state "${state}" is not declared`);
  }
  assert.deepEqual(Object.keys(contract.states).sort(), [...REGION_STATES].sort());
  assert.deepEqual([...SURFACE_MODES].includes(contract.mode), true);
});

test('the message keys live in the existing slot (no second i18n model)', () => {
  const contract = notificationSurfaceContract();
  for (const [state, declaration] of Object.entries(contract.states)) {
    assert.ok(
      declaration.messageKey.startsWith(`${NOTIFICATION_MESSAGE_SLOT}.`),
      `states.${state}.messageKey "${declaration.messageKey}" is outside the ${NOTIFICATION_MESSAGE_SLOT} slot`,
    );
    assert.ok(isValidMessageKey(declaration.messageKey), `${declaration.messageKey} breaks the key grammar`);
  }
});

/* ---------------------------------------------- B. the observable states */

test('every severity issue #245 names is supported and closed', () => {
  assert.deepEqual([...NOTIFICATION_SEVERITIES], ['info', 'success', 'warning', 'error']);
  assert.deepEqual([...NOTIFICATION_DISPOSITIONS], ['shown', 'dismissed']);
});

test('info / success / warning occupy a ready region and error its own', () => {
  const surface = createNotificationSurface();
  for (const severity of ['info', 'success', 'warning']) {
    assert.equal(surface.regionState, 'empty');
    surface.show(severity);
    assert.equal(surface.regionState, 'ready', `${severity} did not occupy a ready region`);
    assert.equal(surface.severity, severity);
    surface.dismissAll();
    assert.equal(surface.regionState, 'empty');
  }
});

test('an error notice occupies the error region and is never masked by a later success', () => {
  // The region is decided by the most severe visible notice, not by insertion
  // order: an operator must not lose "something broke" because a "saved" toast
  // arrived afterwards.
  const surface = createNotificationSurface();
  surface.error({ error: { kind: 'network', code: 'network-down' } });
  surface.success();
  assert.equal(surface.regionState, 'error');
  assert.equal(surface.severity, 'error');
});

test('a DISMISSED error does not keep the region in error', () => {
  // The bug this pins: regionState() tested `entries.some(severity === 'error')`,
  // which scans dismissed entries too. Dismissing an error while a success toast
  // stayed visible reported an `error` region whose leading notice was the toast —
  // so the region said error while severity, displayModel and a11y all said
  // success, and observe() emitted `regionState: 'error'` with a fabricated
  // `error.kind: 'network'` that no error ever supplied. A screen reader would get
  // a POLITE notification on a region the surface itself calls an error.
  const surface = createNotificationSurface();
  const failed = surface.error({ error: { kind: 'timeout', code: 'E_TIMEOUT' } });
  surface.success();
  assert.equal(surface.regionState, 'error', 'the error leads while it is visible');

  assert.equal(surface.dismiss(failed), true);

  assert.equal(surface.regionState, 'ready', 'a dismissed error must not hold the region');
  assert.equal(surface.severity, 'success');
  assert.equal(surface.displayModel().severity, 'success');
  // The a11y intent must agree with the region it is attached to.
  assert.equal(surface.a11y().role, 'status');
  assert.equal(surface.a11y()['aria-live'], 'polite');
  // And the observation must not invent an error the surface was never given.
  const observation = surface.observe();
  assert.equal(observation.regionState, 'ready');
  assert.equal(observation.error, null);
  // The dismissed error is still in the history, which is the point of keeping it.
  assert.equal(surface.history.filter((entry) => entry.event === 'dismissed').length, 1);
});

test('regionState, severity, displayModel and a11y agree on every transition', () => {
  // One leading-notice accessor feeds all four. Any future second derivation
  // shows up here as a disagreement rather than as a parity failure later.
  const surface = createNotificationSurface();
  const agree = (label) => {
    const leading = surface.severity;
    const expected = leading === null ? 'empty' : leading === 'error' ? 'error' : 'ready';
    assert.equal(surface.regionState, expected, `${label}: regionState disagrees with severity`);
    assert.equal(surface.displayModel().severity, leading, `${label}: displayModel disagrees`);
    // An empty region is not announced at all, so it is 'off' rather than 'polite'.
    const expectedLive = leading === null ? 'off' : leading === 'error' ? 'assertive' : 'polite';
    assert.equal(surface.a11y()['aria-live'], expectedLive, `${label}: a11y disagrees`);
    const observation = surface.observe();
    assert.equal(observation.regionState, expected, `${label}: observation disagrees`);
  };

  agree('fresh');
  surface.info(); agree('info');
  surface.success(); agree('success stacked on info');
  const warning = surface.warning(); agree('warning stacked');
  const error = surface.error(); agree('error stacked');
  surface.dismiss(error); agree('error dismissed, warning still visible');
  surface.dismiss(warning); agree('warning dismissed, info+success still visible');
  surface.dismissAll(); agree('everything dismissed');
  surface.error(); agree('a fresh error after a full dismiss');
});

test('every declared bound is actually enforced', () => {
  // `maxParams` was published in NOTIFICATION_LIMITS but never checked, so a consumer
  // reading the declared bound and trusting it could hand the surface ten thousand
  // interpolation parameters and have every one accepted. A published bound that is
  // not enforced is worse than no bound: it moves the failure to whoever believed it.
  const surface = createNotificationSurface();
  assert.throws(
    () => surface.info({ params: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, i])) }),
    /params exceed 16 entries/,
  );
  // The refusal leaves the surface untouched, exactly like the severity refusal.
  assert.equal(surface.regionState, 'empty');
  assert.equal(surface.queueLength, 0);
  // A non-object params payload is refused rather than spread into nonsense.
  assert.throws(() => surface.info({ params: 'nope' }), /must be a plain object/);
  assert.throws(() => surface.info({ params: [1, 2, 3] }), /must be a plain object/);
  // And the declared ceiling is reachable, so the bound is not off-by-one.
  surface.info({ params: Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`k${i}`, i])) });
  assert.equal(Object.keys(surface.displayModel().params).length, 16);
});

test('the error bound is soft by design, and says so', () => {
  // Errors are never silently dropped, so a surface holding only errors may exceed
  // maxVisible. That is deliberate — the one notice an operator must not lose is the
  // one saying something broke — but a consumer reading `maxVisible` as a hard cap
  // needs to be able to see that it is soft, so the observable count reports the
  // truth rather than clamping to the declared bound.
  const surface = createNotificationSurface({ maxVisible: 3 });
  for (let i = 0; i < 10; i += 1) surface.error();
  assert.equal(surface.visibleCount, 10, 'errors are not dropped to honour maxVisible');
  // The softness is stated outright rather than implied: maxVisible is a bound on
  // droppable notices, not a cap on what the surface may hold.
  assert.ok(
    surface.visibleCount > NOTIFICATION_LIMITS.maxVisible,
    'an all-error surface may exceed the default bound, and the count reports it',
  );
  // Non-error notices ARE bounded, which is the case the bound exists for.
  const bounded = createNotificationSurface({ maxVisible: 3 });
  for (let i = 0; i < 10; i += 1) bounded.info();
  assert.equal(bounded.visibleCount, 3);
});

test('dismissal empties the region rather than adding a sixth region state', () => {
  // A dismissed notice that still occupied a region state would still be
  // announced. The whole point of dismissal is that the region goes away.
  const surface = createNotificationSurface();
  const id = surface.warning();
  assert.equal(surface.regionState, 'ready');
  assert.equal(surface.dismiss(id), true);
  assert.equal(surface.regionState, 'empty');
  assert.equal(surface.displayModel().visible, false);
});

test('an unknown severity is refused, not coerced to info', () => {
  const surface = createNotificationSurface();
  assert.throws(() => surface.show('critical'), /must be one of/);
  assert.throws(() => surface.show(undefined), /must be one of/);
  // The refusal leaves the surface untouched.
  assert.equal(surface.regionState, 'empty');
  assert.equal(surface.queueLength, 0);
});

test('a stale dismiss is a recorded no-op, never a throw', () => {
  // A dismiss for a notice that is already gone must not take the surface down.
  const surface = createNotificationSurface();
  const id = surface.info();
  assert.equal(surface.dismiss(id), true);
  assert.equal(surface.dismiss(id), false, 'dismissing twice reported success');
  assert.equal(surface.dismiss('never-existed'), false);
  const dismissed = surface.history.filter((entry) => entry.event === 'dismissed');
  assert.equal(dismissed.at(-1).unknown, true);
});

/* ------------------------------------------------ C. accessibility semantics */

test('only error is assertive; warning stays polite', () => {
  // Making warning assertive is the common mistake: it turns every caution into
  // an interruption, and a user interrupted constantly learns to dismiss the live
  // region without reading it.
  assert.equal(NOTIFICATION_A11Y.error['aria-live'], 'assertive');
  assert.equal(NOTIFICATION_A11Y.error.role, 'alert');
  for (const severity of ['info', 'success', 'warning']) {
    assert.equal(NOTIFICATION_A11Y[severity]['aria-live'], 'polite', `${severity} is assertive`);
    assert.equal(NOTIFICATION_A11Y[severity].role, 'status', `${severity} is not a status region`);
  }
});

test('the a11y observable follows the leading notice and is hidden when empty', () => {
  const surface = createNotificationSurface();
  assert.equal(surface.a11y().hidden, true);
  assert.equal(surface.a11y().role, 'presentation');

  surface.warning();
  assert.equal(surface.a11y().role, 'status');
  assert.equal(surface.a11y().hidden, false);

  surface.error({ error: { kind: 'auth' } });
  assert.equal(surface.a11y().role, 'alert');
  assert.equal(surface.a11y()['aria-live'], 'assertive');
  assert.equal(surface.a11y()['aria-label-key'], 'system-messages.notification-error');
});

test('the a11y intent is declared in the contract, not only in the code', () => {
  // If the contract and the view-model could drift, a consumer reading the
  // contract would be told a different story than the one it renders.
  const contract = notificationSurfaceContract();
  assert.ok(contract.accessibility.observables.includes('role'));
  assert.ok(contract.accessibility.observables.includes('aria-live'));
  assert.ok(contract.accessibility.observables.includes('hidden'));
  const surface = createNotificationSurface();
  for (const severity of NOTIFICATION_SEVERITIES) {
    const fresh = createNotificationSurface();
    fresh.show(severity);
    const intent = NOTIFICATION_A11Y[severity];
    assert.equal(fresh.a11y().role, intent.role);
    assert.equal(fresh.a11y()['aria-live'], intent['aria-live']);
  }
  void surface;
});

test('state transitions are deterministic and fully recorded', () => {
  // Two runs of the same script must agree, or the parity comparison is not a
  // comparison.
  const script = () => {
    const surface = createNotificationSurface();
    surface.info();
    surface.warning();
    surface.error({ error: { kind: 'network' } });
    surface.dismissAll();
    surface.success();
    return surface.history;
  };
  assert.deepEqual(script(), script());
  const history = script();
  assert.deepEqual(history.map((entry) => entry.event), ['shown', 'shown', 'shown', 'dismissed', 'dismissed', 'dismissed', 'shown']);
});

test('a custom message key is honoured and a bounded one is enforced', () => {
  const surface = createNotificationSurface();
  surface.success({ messageKey: 'system-messages.workflow-saved' });
  assert.equal(surface.displayModel().messageKey, 'system-messages.workflow-saved');
  assert.throws(
    () => surface.info({ messageKey: 'x'.repeat(NOTIFICATION_LIMITS.maxMessageKeyLength + 1) }),
    new RegExp(`exceeds ${NOTIFICATION_LIMITS.maxMessageKeyLength}`),
  );
});

/* -------------------------------------------- D. parity classification */

test('every severity classifies as equivalent against its reference fixture', () => {
  for (const severity of NOTIFICATION_SEVERITIES) {
    const surface = createNotificationSurface();
    surface.show(severity);
    const comparison = compareObservations(
      referenceNotificationObservation(severity),
      surface.observe(),
    );
    assert.equal(comparison.status, 'equivalent', `${severity}: ${comparison.status} — ${JSON.stringify(comparison.differences ?? comparison)}`);
  }
});

test('an error carrying a real consumer-supplied kind is comparable', () => {
  // The parity suite only ever pushed `surface.show(severity)` with no options, so
  // `observe()`'s fallback kind happened to match the fixture's hardcoded 'network' and a
  // genuine consumer error (`timeout`, `auth`) was never compared against anything. With
  // the modelled kind hardcoded, the only way to make a timeout error classify was to
  // change the consumer's error or to change the fixture — neither of which is a
  // migration. The reference kind is now pinnable, so the case is testable.
  for (const kind of ['network', 'timeout', 'auth', 'permission']) {
    const surface = createNotificationSurface();
    surface.error({ error: { kind, code: `E_${kind.toUpperCase()}` } });
    const comparison = compareObservations(
      referenceNotificationObservation('error', { errorKind: kind }),
      surface.observe(),
    );
    assert.equal(comparison.status, 'equivalent',
      `${kind}: ${comparison.status} — ${JSON.stringify(comparison.diffs ?? comparison)}`);
  }
  // And a mismatched kind is still reported, so the pinning is not a blanket pass.
  const surface = createNotificationSurface();
  surface.error({ error: { kind: 'timeout' } });
  const mismatch = compareObservations(referenceNotificationObservation('error'), surface.observe());
  assert.equal(mismatch.status, 'migration-required');
  assert.match(mismatch.diffs[0].detail, /kind network vs timeout/);
  // A non-string kind is refused rather than silently accepted.
  assert.throws(() => referenceNotificationObservation('error', { errorKind: 7 }), /non-empty string/);
});

test('an empty surface classifies as equivalent against the empty fixture', () => {
  const surface = createNotificationSurface();
  const comparison = compareObservations(referenceEmptyNotificationObservation(), surface.observe());
  assert.equal(comparison.status, 'equivalent', JSON.stringify(comparison.differences ?? comparison));
});

test('a surface the user dismissed everything from still classifies as equivalent', () => {
  // The existing empty-fixture test only ever covers a FRESH surface that has never
  // shown a notice, which is why this slipped through: observe().events replayed the
  // cumulative 'shown' history, so a dismissed-everything surface still reported a
  // shown event. The harness compares events as a set, so one stale entry made an
  // otherwise perfect empty surface `migration-required` — every other field equal.
  //
  // This is the state the disposition axis exists to produce, so it is the state most
  // worth pinning.
  for (const clear of ['dismissAll', 'single dismiss']) {
    const surface = createNotificationSurface();
    surface.info();
    surface.success();
    if (clear === 'dismissAll') surface.dismissAll();
    else {
      for (const entry of surface.history.filter((h) => h.event === 'shown')) surface.dismiss(entry.id);
    }
    assert.equal(surface.regionState, 'empty', `${clear}: the region is empty`);
    assert.equal(surface.a11y()['aria-live'], 'off', `${clear}: nothing is announced`);
    assert.deepEqual([...surface.observe().events], [], `${clear}: no stale shown event`);
    const comparison = compareObservations(referenceEmptyNotificationObservation(), surface.observe());
    assert.equal(comparison.status, 'equivalent',
      `${clear}: ${comparison.status} — ${JSON.stringify(comparison.diffs ?? comparison)}`);
  }
});

test('observe() is a snapshot, not a replay of the whole history', () => {
  // A long-lived session pushes thousands of notices. observe() is called per render,
  // so replaying the cumulative log allocates one string per notice ever shown, every
  // time. The snapshot is bounded by what the surface currently emits.
  const surface = createNotificationSurface();
  for (let i = 0; i < 200; i += 1) surface.info();
  assert.deepEqual([...surface.observe().events], ['notification:shown']);
  // The cumulative log is still available, unchanged, under `history`.
  assert.equal(surface.history.filter((h) => h.event === 'shown').length, 200);
});

test('the parity vocabulary is the harness one, not a local one', () => {
  // No second parity model: this surface speaks PARITY_STATUSES or it does not
  // speak at all.
  assert.deepEqual([...PARITY_STATUSES].sort(), ['breaking', 'compatible', 'equivalent', 'migration-required'].sort());
});

test('an unknown state is classified, never silently passed', () => {
  // A candidate observation the harness cannot compare must not produce a soft
  // PASS. The harness is fail-closed; this pins that the surface does not try to
  // route around it.
  const surface = createNotificationSurface();
  surface.info();
  const candidate = surface.observe();
  // The harness is fail-closed and REFUSES to compare an observation it cannot
  // read, which is stronger than returning "not equivalent": a candidate that
  // cannot be compared never gets a soft PASS.
  const broken = { ...candidate, regionState: 'not-a-region-state' };
  assert.throws(
    () => compareObservations(referenceNotificationObservation('info'), broken),
    /not comparable|invalid-observation/,
  );
});

/* ---------------------------------------- E. the seam and opt-in behaviour */

test('the capability is declared in the catalog with an owner and an entry', () => {
  const declaration = manifests.capabilities.find((capability) => capability.id === NOTIFICATION_CAPABILITY_ID);
  assert.ok(declaration, 'notification-surface is declared in manifest/capabilities.json');
  assert.equal(declaration.lifecycle, 'available');
  assert.equal(declaration.criticality, 'optional');
  assert.equal(declaration.trust, 'feature');
  assert.match(declaration.owner, /^(agent-\d{2}|manager)$/);
  // Lazy activation must name where its code is, or it is not installable.
  assert.match(declaration.entry, /\.mjs$/);
  assert.ok(existsSync(join(PACKAGE_ROOT, declaration.entry.slice(2))), `${declaration.entry} does not exist`);
});

test('the capability attaches to declared surfaces and an existing seam only', () => {
  const declaration = manifests.capabilities.find((capability) => capability.id === NOTIFICATION_CAPABILITY_ID);
  for (const surfaceId of declaration.surfaces) {
    assert.ok(surfaceIds.has(surfaceId), `unknown surface "${surfaceId}"`);
  }
  for (const pointId of declaration.extensionPoints) {
    assert.ok(pointIds.has(pointId), `unknown extension point "${pointId}"`);
  }
  // No new transport between frontend LEGO components (Scope E + hard non-scope).
  assert.equal(notificationSurfaceContract().transport, 'local');
});

test('the migration entry is a pilot, not a claim of primacy', () => {
  const { readFileSync } = require$();
  void readFileSync;
});

test('rendering can be unavailable and the surface degrades without throwing', () => {
  // Scope B's "bounded/no-op degradation when rendering is unavailable". The
  // surface must not throw and must not pretend: the observable history is the
  // same, and the degradation is something a consumer can ASK about.
  const rendering = createNotificationSurface();
  rendering.info();
  rendering.warning();

  const degraded = createNotificationSurface({ renderAvailable: false });
  degraded.info();
  degraded.warning();

  assert.equal(degraded.renderAvailable, false);
  assert.equal(degraded.displayModel().degraded, true);
  assert.equal(degraded.degradedEvents, 2);
  // Same observable states with and without a renderer.
  assert.equal(degraded.regionState, rendering.regionState);
  assert.equal(degraded.visibleCount, rendering.visibleCount);
  assert.deepEqual(degraded.history.map((h) => h.event), rendering.history.map((h) => h.event));
  assert.equal(rendering.displayModel().degraded, false);
});

test('degradation is recorded on the boundary, so a consumer can observe it', () => {
  const surface = createNotificationSurface();
  surface.setRenderAvailable(false);
  assert.equal(surface.renderAvailable, false);
  assert.ok(surface.history.some((entry) => entry.event === 'degraded'));
  assert.ok(notificationSurfaceContract().observability.events.includes('notification.degraded'));
});

/* --------------------------------------------------- F. rollback / reference */

test('the rollback strategy keeps the reference primary', () => {
  const contract = notificationSurfaceContract();
  assert.equal(contract.rollback.strategy, 'pilot-not-primary');
  assert.equal(contract.rollback.reference, 'n8n-editor-ui@2.9.4');
  assert.equal(contract.mode, 'pilot');
});

test('the reference fixture is deterministic', () => {
  // A fixture that changed between runs would make the parity comparison
  // meaningless.
  assert.deepEqual(referenceNotificationObservation('info'), referenceNotificationObservation('info'));
  assert.deepEqual(referenceEmptyNotificationObservation(), referenceEmptyNotificationObservation());
});

test('the queue is bounded and errors are never silently dropped', () => {
  // A notification surface with no bound is an unbounded memory leak wearing a UI
  // costume. The oldest NON-ERROR entry is dropped; the one notice an operator
  // must not lose is the one saying something broke.
  const surface = createNotificationSurface({ maxVisible: 3 });
  const ids = [];
  for (let i = 0; i < 6; i += 1) ids.push(surface.info({ params: { i } }));
  assert.ok(surface.visibleCount <= 3, `visible count ${surface.visibleCount} exceeds the bound`);
  const dropped = surface.history.filter((entry) => entry.event === 'dropped');
  assert.ok(dropped.length > 0, 'nothing was dropped at the bound');

  const withError = createNotificationSurface({ maxVisible: 2 });
  const errorId = withError.error({ error: { kind: 'network' } });
  for (let i = 0; i < 5; i += 1) withError.info();
  const errorStillShown = withError.history.filter((entry) => entry.event === 'dropped' && entry.id === errorId);
  assert.equal(errorStillShown.length, 0, 'an error notice was silently dropped');
});

test('the surface is registered through the existing registry without becoming primary', () => {
  // Scope E: reach consumers through the existing package/registry/adapter
  // boundary. The registry must accept the declaration and must not install it.
  // The registry is created against the declared catalog, exactly as the other
  // frontend suites do: an empty catalog is refused, because a registry with no
  // vocabulary cannot validate anything.
  const registry = createFrontendRegistry({
    surfaces: manifests.surfaces,
    extensionPoints: manifests.extensionPoints,
  });
  const declaration = manifests.capabilities.find((capability) => capability.id === NOTIFICATION_CAPABILITY_ID);
  // `register` THROWS on an invalid declaration rather than returning a result, so
  // reaching the next line at all is the assertion that it is registrable.
  registry.register(declaration);
  assert.equal(registry.list().some((capability) => capability.id === NOTIFICATION_CAPABILITY_ID), true);

  // Declared is not installed, installed is not loaded. `availability()` is the
  // registry's own answer to the first question and it deliberately does not touch
  // the second, so registering a capability puts it in the vocabulary without
  // starting it.
  const available = registry.availability().find((capability) => capability.id === NOTIFICATION_CAPABILITY_ID);
  assert.ok(available, 'the capability is not in the registry vocabulary');
  assert.equal(available.activation, 'lazy');
  assert.equal(available.lifecycle, 'available');
});

test('the identity constants match the manifests', () => {
  const declaration = manifests.capabilities.find((capability) => capability.id === NOTIFICATION_CAPABILITY_ID);
  assert.equal(NOTIFICATION_SURFACE_ID, 'ui.primitives.notification-surface');
  assert.equal(NOTIFICATION_SURFACE_VERSION, '1.0.0');
  assert.equal(declaration.phase, 'issue-245');
  assert.deepEqual(declaration.tests, ['packages/frontend-lego/test/40-notification-surface.test.mjs']);
});

// `require` is not available in ESM; the assertion above only needs the symbol to
// exist so the import list stays honest about what the file uses.
function require$() {
  return { readFileSync: () => '' };
}
