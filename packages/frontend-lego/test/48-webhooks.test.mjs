/**
 * P2-S11 - Webhooks surface pilot (issue #240).
 *
 * The strangler slice for the webhook URL/method/registration surface shown
 * with a node or a workflow. Trigger routing, registration writes and the
 * Webhook node auth evaluation stay OUT of this slice.
 *
 * Evidence map:
 *   CP-01 boundary + closed contract: hand-over only, no register call, auth
 *         material refused at the boundary, closed REGION_STATES (A)
 *   CP-02 pilot mode + rollback: manifest pins (B)
 *   CP-03 parity against the reference, fail-closed (C)
 *   CP-04 accessibility derived once, assertive/busy exclusivity (D)
 *   CP-05 bounds + resource mutation + explicit requests and failure (E)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createWebhooksSurface,
  webhooksSurfaceContract,
  webhookActionsFor,
  referenceLoadingObservation,
  referenceEmptyObservation,
  referenceReadyObservation,
  referenceErrorObservation,
  WEBHOOK_STATES,
  WEBHOOK_METHODS,
  WEBHOOK_RESOURCES,
  WEBHOOK_DEFAULT_RESOURCE,
  WEBHOOK_URL_KINDS,
  WEBHOOK_ACTIONS,
  WEBHOOK_REQUEST_RESULTS,
  WEBHOOK_EMPTY_REASONS,
  WEBHOOK_A11Y,
  WEBHOOK_MAX_VISIBLE_HARD_MAX,
  WEBHOOK_SURFACE_ID,
} from '../src/webhooks.mjs';
import { REGION_STATES } from '../src/surface-contract.mjs';
import { compareObservations, PARITY_STATUSES, ParityError } from '../src/parity.mjs';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const ENTRY_A = { id: 'wh-node.test', method: 'GET', url: 'https://n8n.example/webhook-test/a', resource: 'node', urlKind: 'test' };
const ENTRY_B = { id: 'wh-node.prod', method: 'GET', url: 'https://n8n.example/webhook/a', resource: 'node', urlKind: 'production' };
const ENTRY_W = { id: 'wh-workflow.prod', method: 'POST', url: 'https://n8n.example/webhook/w', resource: 'workflow', urlKind: 'production' };

function readySurface() {
  const surface = createWebhooksSurface();
  surface.loadSuccess([ENTRY_A, ENTRY_B, ENTRY_W]);
  return surface;
}

/* ------------------------------------------------------------- A (CP-01) */

test('A entries enter only through loadSuccess: the surface issues no register call', () => {
  const surface = createWebhooksSurface();
  assert.equal(surface.contract.inputBoundary.source, 'hand-over');
  assert.equal(surface.contract.inputBoundary.entryPoint, 'loadSuccess');
  assert.equal(surface.contract.inputBoundary.issuesRegisterCall, false);
  assert.equal(surface.contract.inputBoundary.carriesSecrets, false);
  surface.loadSuccess([ENTRY_A]);
  assert.equal(surface.displayModel().total, 1);
});

test('A a registration carrying a secret-bearing field is refused with an explicit security error', () => {
  const surface = createWebhooksSurface();
  for (const key of ['auth', 'headers', 'token', 'password', 'apiKey', 'basicAuth', 'headerAuth', 'jwtAuth', 'webhookId']) {
    assert.throws(
      () => surface.loadSuccess([{ ...ENTRY_A, [key]: 'hunter2' }]),
      (error) => {
        assert.match(error.message, /secret-bearing field/);
        assert.match(error.message, /never reaches this surface/);
        return true;
      },
      key,
    );
  }
  assert.equal(surface.displayModel().visible, true, 'a refused load leaves the region untouched');
  assert.equal(surface.displayModel().total, 0);
});

test('A a registration outside the closed shape is refused, not dropped', () => {
  const surface = createWebhooksSurface();
  assert.throws(() => surface.loadSuccess([{ id: 'x', method: 'GET', url: 'u', resource: 'node' }]), /must have exactly/);
  assert.throws(() => surface.loadSuccess([{ ...ENTRY_A, extra: 1 }]), /must have exactly/);
  assert.throws(() => surface.loadSuccess([{ ...ENTRY_A, method: 'OPTIONS' }]), /method must be one of/);
  assert.throws(() => surface.loadSuccess([{ ...ENTRY_A, method: 'get' }]), /method must be one of/);
  assert.throws(() => surface.loadSuccess([{ ...ENTRY_A, resource: 'cron' }]), /resource must be one of/);
  assert.throws(() => surface.loadSuccess([{ ...ENTRY_A, urlKind: 'staging' }]), /urlKind must be one of/);
  assert.throws(() => surface.loadSuccess([{ ...ENTRY_A, id: ' ' }]), /non-empty string/);
  assert.throws(() => surface.loadSuccess([{ ...ENTRY_A, url: '' }]), /non-empty string/);
  assert.throws(() => surface.loadSuccess(['not-an-object']), /must be an object/);
});

test('A the contract states are pinned to REGION_STATES exactly - no fifth state', () => {
  const contract = webhooksSurfaceContract();
  assert.deepEqual(WEBHOOK_STATES, REGION_STATES);
  assert.deepEqual(Object.keys(contract.states).sort(), [...REGION_STATES].sort());
});

test('A the method, resource, url-kind, action and request-result vocabularies are closed', () => {
  const contract = webhooksSurfaceContract();
  // The method guard of contracts/webhook.contract.md; OPTIONS is CORS handling,
  // answered without executing, so it is not a registration method.
  assert.deepEqual([...WEBHOOK_METHODS], ['DELETE', 'GET', 'HEAD', 'PATCH', 'POST', 'PUT']);
  assert.deepEqual([...WEBHOOK_RESOURCES], ['node', 'workflow']);
  assert.equal(WEBHOOK_DEFAULT_RESOURCE, 'node');
  assert.deepEqual([...WEBHOOK_URL_KINDS], ['test', 'production']);
  assert.deepEqual([...WEBHOOK_ACTIONS], ['refresh', 'copy-url', 'switch-resource']);
  assert.deepEqual([...WEBHOOK_REQUEST_RESULTS], ['requested', 'unknown-id', 'not-ready']);
  assert.deepEqual([...WEBHOOK_EMPTY_REASONS], ['none', 'filtered']);
  assert.deepEqual(contract.vocabularies.methods, WEBHOOK_METHODS);
  assert.deepEqual(contract.vocabularies.urlKinds, WEBHOOK_URL_KINDS);
  for (const region of REGION_STATES) {
    for (const action of webhookActionsFor(region)) {
      assert.ok(WEBHOOK_ACTIONS.includes(action), `${action} in ${region} is declared`);
    }
  }
});

/* ------------------------------------------------------------- B (CP-02) */

test('B the surface migrates as a pilot with rollback pilot-not-primary', () => {
  const inv = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'manifest', 'surface-migrations.json'), 'utf8'));
  const entry = inv.entries.find((e) => e.inventoryId === 'ui.webhooks.registrations');
  assert.ok(entry, 'ui.webhooks.registrations entry exists');
  assert.equal(entry.migrationStatus, 'pilot-available');
  assert.equal(entry.contractStatus, 'consuming');
  assert.equal(entry.rollbackStrategy, 'pilot-not-primary');
  assert.match(entry.evidencePath, /48-webhooks\.test\.mjs/);
  assert.deepEqual(entry.surfaceIds, [WEBHOOK_SURFACE_ID]);
  assert.equal(entry.slice, 'P2-S11');
  assert.equal(entry.sourceIssue, '240');
});

test('B the capability declares the pilot and degrades to native behavior', () => {
  const caps = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'manifest', 'capabilities.json'), 'utf8'));
  const list = caps.capabilities ?? caps;
  const cap = list.find((c) => c.id === WEBHOOK_SURFACE_ID);
  assert.ok(cap, 'webhooks capability declared');
  assert.equal(cap.entry, './src/webhooks.mjs');
  assert.equal(cap.degradation.fallback, 'native-behavior');
  assert.ok(cap.tests.some((t) => /48-webhooks\.test\.mjs/.test(t)));
  assert.deepEqual(cap.surfaces, [WEBHOOK_SURFACE_ID]);
});

/* ------------------------------------------------------------- C (CP-03) */

test('C loading is parity-equivalent to the reference', () => {
  const surface = createWebhooksSurface();
  const { status } = compareObservations(referenceLoadingObservation(), surface.observe());
  assert.equal(status, PARITY_STATUSES[0]);
});

test('C an empty filter is parity-equivalent for both empty reasons', () => {
  const none = createWebhooksSurface();
  none.loadSuccess([]);
  assert.equal(none.displayModel().reason, 'none');
  assert.equal(compareObservations(referenceEmptyObservation({ reason: 'none' }), none.observe()).status, PARITY_STATUSES[0]);

  const filtered = createWebhooksSurface();
  filtered.loadSuccess([ENTRY_A, ENTRY_B]);
  filtered.setResource('workflow');
  assert.equal(filtered.displayModel().reason, 'filtered');
  assert.equal(compareObservations(referenceEmptyObservation({ reason: 'filtered' }), filtered.observe()).status, PARITY_STATUSES[0]);
});

test('C loaded registrations are parity-equivalent', () => {
  const surface = readySurface();
  assert.equal(compareObservations(referenceReadyObservation(), surface.observe()).status, PARITY_STATUSES[0]);
  surface.setResource('workflow');
  assert.equal(compareObservations(referenceReadyObservation(), surface.observe()).status, PARITY_STATUSES[0]);
});

test('C a failed load is parity-equivalent for its declared error kind', () => {
  const surface = createWebhooksSurface();
  surface.loadFailure({ kind: 'timeout' });
  assert.equal(compareObservations(referenceErrorObservation({ errorKind: 'timeout' }), surface.observe()).status, PARITY_STATUSES[0]);
});

test('C the harness is fail-closed: a drifted field is migration-required', () => {
  const surface = createWebhooksSurface();
  surface.loadSuccess([]);
  const { status } = compareObservations(referenceReadyObservation(), surface.observe());
  assert.equal(status, PARITY_STATUSES[2]);
});

test('C an incomparable observation throws, never silently passes', () => {
  const surface = readySurface();
  assert.throws(
    () => compareObservations(referenceReadyObservation(), { ...surface.observe(), regionState: 'ghost' }),
    ParityError,
  );
});

/* ------------------------------------------------------------- D (CP-04) */

test('D the a11y intent is derived once from WEBHOOK_A11Y', () => {
  const surface = readySurface();
  assert.equal(surface.a11y(), WEBHOOK_A11Y.ready);
  assert.deepEqual(surface.observe().accessibility, WEBHOOK_A11Y.ready);
});

test('D only error is assertive and only loading is busy', () => {
  for (const state of REGION_STATES) {
    const attrs = WEBHOOK_A11Y[state];
    if (state === 'error') assert.equal(attrs.ariaLive, 'assertive');
    else assert.equal(attrs.ariaLive, 'polite');
    if (state === 'loading') assert.equal(attrs.ariaBusy, true);
    else assert.equal(attrs.ariaBusy, false);
    if (state === 'ready') assert.equal(attrs.role, 'list');
    else assert.equal(attrs.role, 'status');
  }
});

/* ------------------------------------------------------------- E (CP-05) */

test('E visible registrations are bounded and truncation is observable', () => {
  const surface = createWebhooksSurface({ maxVisible: 2 });
  const rows = Array.from({ length: 5 }, (unused, i) => ({
    id: `wh-${i}`, method: 'GET', url: `https://n8n.example/webhook-test/${i}`, resource: 'node', urlKind: 'test',
  }));
  surface.loadSuccess(rows);
  const model = surface.displayModel();
  assert.equal(model.shown.length, 2);
  assert.equal(model.truncated, true);
  assert.equal(model.total, 5);
  const capped = createWebhooksSurface({ maxVisible: WEBHOOK_MAX_VISIBLE_HARD_MAX + 10 });
  assert.equal(capped.maxVisible, WEBHOOK_MAX_VISIBLE_HARD_MAX);
  assert.throws(() => createWebhooksSurface({ maxVisible: 0 }), /positive integer/);
});

test('E the resource switch is an observable mutation: narrow, back', () => {
  const surface = readySurface();
  assert.equal(surface.setResource('workflow'), 'ready');
  assert.equal(surface.displayModel().visibleCount, 1);
  assert.equal(surface.displayModel().resource, 'workflow');
  surface.loadSuccess([ENTRY_A, ENTRY_B]);
  assert.equal(surface.setResource('workflow'), 'empty');
  assert.equal(surface.displayModel().reason, 'filtered');
  assert.equal(surface.setResource('node'), 'ready');
  assert.throws(() => surface.setResource('everything'), /resource must be one of/);
});

test('E requests are declared and explicit, and registration data never changes', () => {
  const surface = readySurface();
  assert.equal(surface.requestCopy(ENTRY_A.id), 'requested');
  assert.equal(surface.requestCopy(ENTRY_W.id), 'requested');
  assert.equal(surface.requestCopy('ghost'), 'unknown-id');
  surface.setLoading();
  assert.equal(surface.requestCopy(ENTRY_A.id), 'not-ready');
  assert.throws(() => surface.requestCopy(''), /non-empty/);
  // The declared request changed no registration data.
  surface.setResource('node');
  assert.equal(surface.displayModel().total, 3);
});

test('E failure is explicit: the error region carries a retry affordance', () => {
  const surface = createWebhooksSurface();
  assert.equal(surface.loadFailure({ kind: 'network' }), 'error');
  const model = surface.displayModel();
  assert.deepEqual([...model.actions], ['refresh']);
  assert.throws(() => surface.loadFailure(null), /error object/);
  const degraded = createWebhooksSurface({ renderAvailable: false });
  degraded.loadSuccess([ENTRY_A]);
  assert.ok(degraded.degradedEvents > 0);
});

test('E loadSuccess resets the resource and history is deterministic', () => {
  const surface = readySurface();
  surface.setResource('workflow');
  surface.loadSuccess([ENTRY_A, ENTRY_B, ENTRY_W]);
  assert.equal(surface.displayModel().resource, WEBHOOK_DEFAULT_RESOURCE);
  const again = createWebhooksSurface();
  // Both resources have entries so the switch lands in ready and the declared
  // copy is actually issued (a copy on an empty filter would be not-ready).
  again.loadSuccess([ENTRY_A, ENTRY_W]);
  again.setResource('workflow');
  again.requestCopy(ENTRY_W.id);
  assert.deepEqual(again.history.map((h) => h.name), ['loaded', 'switched-resource', 'copy-requested']);
});
