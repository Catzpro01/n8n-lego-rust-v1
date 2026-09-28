/**
 * Capability negotiation: discovery, access, availability and degradation.
 *
 * The rule this file exists to protect: **placement grants nothing**. A unit nested
 * under a capable parent reaches only what its own surface binds or what a
 * capability explicitly declares for that surface.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  AVAILABILITY_STATES,
  CapabilityNotGrantedError,
  NegotiationError,
  createCapabilityNegotiator,
} from '../src/negotiation.mjs';
import { backendAvailabilityFrom, describeBackendView } from '../src/backend-view.mjs';
import { createFrontendRegistry } from '../src/registry.mjs';
import { vocabularyOf } from '../src/vocabulary.mjs';
import { createSubLegoRegistry } from '../src/sublegos.mjs';
import { capabilityOf, backendCapabilitiesOf, surfacesOfCapability } from '../src/surface-capability.mjs';
import { loadManifests } from '../src/manifests.mjs';

const manifests = loadManifests();

function assembly({ capabilities = [], backendOverrides = {}, unsupportedFeatures = [] } = {}) {
  const registry = createFrontendRegistry({
    surfaces: manifests.surfaces,
    extensionPoints: manifests.extensionPoints,
    capabilities,
  });
  const subLegos = createSubLegoRegistry({
    subLegos: manifests.subLegos,
    owners: manifests.owners,
    surfaces: manifests.surfaces,
    extensionPoints: manifests.extensionPoints,
  });
  const backend = backendAvailabilityFrom({ surfaces: manifests.surfaces, unsupportedFeatures, overrides: backendOverrides });
  const negotiator = createCapabilityNegotiator({
    registry,
    subLegos,
    surfaces: manifests.surfaces,
    declared: manifests.capabilities,
    backend,
    contractVersion: '1.0.0',
    locales: ['id', 'en', 'ar'],
  });
  return { registry, subLegos, backend, negotiator };
}

const translation = assembly();

test('the surface join is one function, and it normalises the `none` sentinel', () => {
  assert.equal(capabilityOf({ backend: { capability: 'settings' } }), 'settings');
  assert.equal(capabilityOf({ backend: { capability: 'none' } }), null);
  assert.equal(capabilityOf({ backend: {} }), null);
  assert.equal(capabilityOf({}), null);
  const bound = backendCapabilitiesOf(manifests.surfaces);
  assert.ok(bound.includes('settings'));
  assert.ok(bound.includes('workflow'));
  assert.equal(bound.includes('none'), false, 'the sentinel never becomes a capability');
  assert.deepEqual(surfacesOfCapability(manifests.surfaces, 'settings'), ['navigation', 'settings']);
});

test('a consumer can discover identity, version, operations and origin', () => {
  const described = translation.negotiator.describe('translation');
  assert.equal(described.id, 'translation');
  assert.equal(described.origin, 'frontend-declared', 'frontend capability: this LEGO adds it');
  assert.equal(described.criticality, 'optional');
  assert.equal(described.trust, 'feature');
  assert.equal(described.activation, 'lazy');
  assert.equal(described.installed, false, 'declared is not installed');
  assert.deepEqual(described.operations, [], 'no operation contract is published yet');
  assert.equal(described.contracts.length, 2);

  const backendCapability = translation.negotiator.describe('workflow');
  assert.equal(backendCapability.origin, 'backend-advertised');
  assert.equal(backendCapability.owner, 'workflow');
  // Refresh 2026-09-28 (P2-S14): the canvas surface (ui.editor.canvas pilot) consumes the
  // backend workflow capability - the derived set grows by one, no capability change.
  assert.deepEqual(backendCapability.surfaces, ['dashboard', 'workflow-editor', 'canvas']);
  assert.throws(() => translation.negotiator.describe('nothing-here'), (error) => {
    assert.ok(error instanceof NegotiationError);
    assert.equal(error.code, 'frontend.capability.unknown');
    return true;
  });
});

test('placement grants nothing: access comes from the surface or an explicit declaration', () => {
  const { negotiator } = translation;
  // Own-surface binding: the settings surface carries the settings capability.
  assert.deepEqual(negotiator.mayUse('settings.general', 'settings'), { allowed: true, unitId: 'settings.general', capabilityId: 'settings', basis: 'surface-binding', reason: null });
  // Explicit declaration: the translation capability names the settings surface.
  assert.equal(negotiator.mayUse('settings.localization.rtl', 'translation').basis, 'declared-surface');
  // Nested under settings, the unit is *not* magically granted the workflow capability.
  const escalated = negotiator.mayUse('settings.localization.rtl', 'workflow');
  assert.equal(escalated.allowed, false);
  assert.match(escalated.reason, /placement never grants/);
  // requireUse refuses instead of returning a decision.
  assert.throws(() => negotiator.requireUse('settings.localization.rtl', 'workflow'), (error) => {
    assert.ok(error instanceof CapabilityNotGrantedError);
    assert.equal(error.code, 'frontend.capability.not-granted');
    assert.equal(error.unitId, 'settings.localization.rtl');
    return true;
  });
  // A unit on a frontend-only surface (dialogs) has no surface binding at all.
  const dialogs = negotiator.mayUse('dialogs', 'workflow');
  assert.equal(dialogs.allowed, false);
  assert.match(dialogs.reason, /carries no backend capability/);
});

test('negotiation returns a verdict, never a bare boolean', () => {
  const { negotiator } = translation;
  const verdict = negotiator.negotiate({ capabilityId: 'translation' });
  assert.equal(verdict.state, 'optional-absent', 'declared but not installed skips the optional path');
  assert.equal(verdict.ok, false, 'the optional path is skipped, and the verdict never pretends otherwise');
  assert.equal(verdict.degraded, false);
  assert.equal(verdict.identity, 'translation@1.0.0');
  assert.equal(verdict.origin, 'frontend-declared');
  assert.match(verdict.reasons.join(' '), /declared but not installed/);
  assert.equal(verdict.degradation.state, 'optional-absent');
  assert.equal(verdict.degradation.usable, false);
  assert.equal(verdict.degradation.action, 'skip the optional path; this is not an error');
  assert.deepEqual(verdict.degradation.behavior, 'fallback');
  // The states are the canonical degradation vocabulary, quoted from the backend foundation.
  assert.deepEqual(AVAILABILITY_STATES, vocabularyOf('degradation').values);
  assert.deepEqual(AVAILABILITY_STATES, ['available', 'degraded', 'capability-unavailable', 'optional-absent', 'version-incompatible', 'dependency-disabled', 'migration-required', 'feature-unsupported']);
  assert.deepEqual(verdict.requiredPermissions, [], 'nothing is required by default, and the verdict says so');
  assert.equal(verdict.migrationRequired, false);
});

test('an ungranted consumer is not told whether the capability would have worked', () => {
  const { negotiator } = translation;
  const verdict = negotiator.negotiate({ capabilityId: 'workflow', unitId: 'settings.localization.rtl' });
  assert.equal(verdict.state, 'capability-unavailable');
  assert.equal(verdict.ok, false);
  assert.equal(verdict.capability, null, 'no metadata leaks to a consumer that may not use it');
  assert.equal(verdict.identity, null);
  assert.match(verdict.reasons[0], /placement never grants/);
});

test('operations are negotiated by name, and a missing operation degrades', () => {
  const withOperations = assembly({
    capabilities: [{
      id: 'search',
      lego: 'search',
      title: 'Search',
      status: 'available',
      surfaces: ['node-picker'],
      contracts: ['contracts/frontend.contract.md'],
      tests: ['packages/search-lego/test/*.test.mjs'],
      operations: ['search.nodes', 'search.workflows'],
      activation: 'lazy',
      entry: './features/search/index.mjs',
    }],
  });
  const granted = withOperations.negotiator.negotiate({ capabilityId: 'search', requireOperations: ['search.nodes'] });
  assert.deepEqual(granted.missingOperations, []);
  assert.equal(granted.state, 'available');

  const partial = withOperations.negotiator.negotiate({ capabilityId: 'search', requireOperations: ['search.nodes', 'search.credentials'] });
  assert.deepEqual(partial.grantedOperations, ['search.nodes']);
  assert.deepEqual(partial.missingOperations, ['search.credentials']);
  assert.equal(partial.state, 'degraded');
  assert.match(partial.reasons.join(' '), /operations not offered: search.credentials/);

  // The operation grammar is the envelope's — no second spelling.
  const registry = createFrontendRegistry({ surfaces: manifests.surfaces, extensionPoints: manifests.extensionPoints });
  assert.throws(
    () => registry.register({
      id: 'bad', lego: 'bad', title: 'Bad', status: 'declared',
      surfaces: ['settings'], contracts: ['contracts/frontend.contract.md'], tests: ['x'], operations: ['searchNodes'],
    }),
    /must look like "<domain>\.<name>"/,
  );
});

test('a version mismatch is named, not swallowed', () => {
  // `workflow` is still backend-advertised only (the settings pilot declared
  // `settings` in the frontend catalog with P2-S10, the same way the credentials
  // pilot declared `credentials` in P2-S09 - a declaration shadows the backend
  // advertisement in the resolve order, so these fixtures need an unshadowed id).
  const mismatched = assembly({ backendOverrides: { workflow: { status: 'implemented', contractVersion: '2.0.0', owner: 'workflow' } } });
  const verdict = mismatched.negotiator.negotiate({ capabilityId: 'workflow', requireVersion: '1.0.0' });
  assert.equal(verdict.state, 'version-incompatible');
  assert.equal(verdict.ok, false);
  assert.equal(verdict.compatibility.kind, 'breaking', 'a 2.0.0 provider breaks a 1.0.0 consumer');
  assert.equal(verdict.compatibility.satisfied, false);
  assert.match(verdict.reasons.join(' '), /major 1 → 2/);

  const additive = assembly({ backendOverrides: { workflow: { status: 'implemented', contractVersion: '1.4.0', owner: 'workflow' } } });
  const fine = additive.negotiator.negotiate({ capabilityId: 'workflow', requireVersion: '1.0.0' });
  assert.equal(fine.state, 'available');
  assert.equal(fine.compatibility.kind, 'compatible');
  assert.equal(fine.compatibility.move, 'minor');
});

test('feature availability shows the frontend declaration beside the backend reality', () => {
  const { negotiator } = assembly({ unsupportedFeatures: [{ prefix: '/rest/sso', feature: 'sso', label: 'SSO', owner: 'auth', phase: 'deferred' }] });
  const availability = negotiator.featureAvailability();
  assert.equal(availability.length, manifests.surfaces.length);
  const auth = availability.find((entry) => entry.surface === 'auth');
  assert.equal(auth.state, 'degraded', 'one endpoint answered 501 makes the capability partial, not available');
  assert.match(auth.reasons.join(' '), /partially/);
  assert.equal(auth.contract, 'contracts/api.contract.md');
  const dialogs = availability.find((entry) => entry.surface === 'dialogs');
  assert.equal(dialogs.capability, null, 'a frontend-only surface has nothing to negotiate');
  assert.equal(dialogs.state, 'available');
  const workflow = availability.find((entry) => entry.surface === 'workflow-editor');
  assert.equal(workflow.state, 'available');
  assert.equal(workflow.capability, 'workflow');

  // Overrides are keyed by capability id (the surface's backend binding), not by surface id.
  const disabled = assembly({ backendOverrides: { execution: { status: 'unsupported', owner: 'execution' } } });
  const executions = disabled.negotiator.featureAvailability().find((entry) => entry.surface === 'executions');
  assert.equal(executions.state, 'feature-unsupported');
  assert.match(executions.reasons.join(' '), /does not implement/);
});

test('the backend view states where each fact came from, and never probes', () => {
  const view = backendAvailabilityFrom({
    surfaces: manifests.surfaces,
    unsupportedFeatures: [{ prefix: '/rest/community-packages', feature: 'community-packages', label: 'Community nodes', owner: 'node-registry', phase: 'P6' }],
  });
  const nodeRegistry = view.capabilities['node-registry'];
  assert.equal(nodeRegistry.status, 'partial');
  assert.equal(nodeRegistry.source, 'compat-unsupported-map');
  assert.deepEqual(nodeRegistry.endpoints, ['/rest/community-packages']);
  const workflow = view.capabilities.workflow;
  assert.equal(workflow.source, 'surface-catalog');
  assert.deepEqual(workflow.endpoints, [], 'nothing is probed: an empty list is the honest answer');
  const model = describeBackendView();
  assert.match(model.rules.join(' '), /never probed|Nothing is probed/);
  assert.deepEqual(model.states, ['implemented', 'partial', 'unsupported', 'unknown']);
  for (const state of ['implemented', 'partial', 'unsupported']) {
    assert.ok(vocabularyOf('capabilityStatus').values.includes(state), `"${state}" is a canonical status word`);
  }
  assert.equal(vocabularyOf('capabilityStatus').values.includes('unknown'), false, 'unknown is the frontend honest answer, declared as an extension');
});

test('locale readiness is declared readiness, not a translation implementation', () => {
  const { negotiator } = translation;
  const readiness = negotiator.localeReadiness({ supported: ['id', 'en', 'ar', 'zh', 'ru', 'jv'], fallback: 'en' });
  assert.deepEqual(readiness.supported, ['id', 'en', 'ar']);
  assert.equal(readiness.complete, false);
  assert.deepEqual(readiness.missing, ['zh', 'ru', 'jv']);
  assert.equal(readiness.capability, 'declared-not-installed');
  const model = negotiator.describeModel();
  assert.match(model.rules.join(' '), /Placement grants nothing/);
});
