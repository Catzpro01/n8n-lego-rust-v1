/**
 * P2-S27 - Skills/Capabilities surface pilot (issue #240, Layer 5).
 *
 * The strangler slice for the skills and capability catalog surfaces split
 * out of P2-S03. The catalog is handed over through the capability registry
 * - the surface is READ-ONLY AND GRANTS NOTHING: no fetch, no direct
 * registry access, no mutation of a record, no enable/install/load of any
 * capability. request-open-skill is declared with explicit results and the
 * capability that owns navigation performs it. Vocabularies are quoted:
 * SKILL_STATUSES from skills.mjs, CAPABILITY_STATES from lifecycle.mjs.
 *
 * Evidence map:
 *   CP-01 boundary + closed contract: handed-over {skills, capabilities},
 *         read-only, grants nothing, no fetch, no workflow save, secret
 *         envelope refused, closed REGION_STATES + status/state/action/
 *         result vocabularies (A)
 *   CP-02 pilot mode + rollback: manifest pins (B)
 *   CP-03 parity against the reference, fail-closed (C)
 *   CP-04 accessibility derived once, keyboard reachability + focus order,
 *         shared loading/empty/error interaction primitives (D)
 *   CP-05 bounds, measured render cost, explicit failure/degradation,
 *         declared request vocabularies, records never mutate (E)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createSkillsCapabilitiesSurface,
  skillsCapabilitiesSurfaceContract,
  skillsCapabilitiesActionsFor,
  referenceLoadingObservation,
  referenceEmptyObservation,
  referenceReadyObservation,
  referenceErrorObservation,
  SKILLS_CAPABILITIES_STATES,
  SKILL_STATUSES,
  CAPABILITY_STATES,
  SKILLS_CAPABILITIES_EMPTY_REASONS,
  SKILLS_CAPABILITIES_ACTIONS,
  SKILLS_CAPABILITIES_OPEN_RESULTS,
  SKILLS_CAPABILITIES_LABELS,
  SKILLS_CAPABILITIES_A11Y,
  SKILLS_CAPABILITIES_MAX_VISIBLE_DEFAULT,
  SKILLS_CAPABILITIES_MAX_VISIBLE_HARD_MAX,
  SKILL_NAME_MAX_LENGTH,
  SKILLS_CAPABILITIES_SURFACE_ID,
} from '../src/skills-capabilities.mjs';
import { REGION_STATES } from '../src/surface-contract.mjs';
import { compareObservations, PARITY_STATUSES, ParityError } from '../src/parity.mjs';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(path, 'utf8');

const SKILLS = [
  { id: 'sk-1', name: 'invoice-reconcile', status: 'implemented' },
  { id: 'sk-2', name: 'crm-enrich', status: 'contract-only' },
  { id: 'sk-3', name: 'incident-triage', status: 'planned' },
  { id: 'sk-4', name: 'weekly-digest', status: 'in-progress' },
];
const CAPABILITIES = [
  { id: 'work-trace', state: 'available' },
  { id: 'memory-views', state: 'loaded' },
  { id: 'status-region', state: 'active' },
];

function loadedSurface(skills = SKILLS, options = {}) {
  const surface = createSkillsCapabilitiesSurface(options);
  surface.loadSuccess({ skills, capabilities: CAPABILITIES });
  return surface;
}

const skillSnapshot = (surface) => JSON.stringify(
  surface.displayModel().shown.map(({ id, name, status }) => ({ id, name, status })),
);

/* ------------------------------------------------ A (CP-01) boundary + contract */

test('A the contract declares the hand-over boundary with no fetch and no save', () => {
  const contract = skillsCapabilitiesSurfaceContract();
  assert.deepEqual(contract.inputBoundary, {
    source: 'hand-over',
    entryPoint: 'loadSuccess',
    issuesEngineCall: false,
    issuesWorkflowSave: false,
    carriesSecrets: false,
  });
  assert.equal(contract.id, SKILLS_CAPABILITIES_SURFACE_ID);
  assert.equal(contract.version, 'p1');
  assert.deepEqual(Object.keys(contract.states).sort(), [...REGION_STATES].sort());
  for (const state of REGION_STATES) {
    assert.deepEqual(contract.states[state], { state });
  }
  assert.deepEqual(contract.vocabularies.skillStatuses, SKILL_STATUSES);
  assert.deepEqual(contract.vocabularies.capabilityStates, CAPABILITY_STATES);
  assert.deepEqual(contract.vocabularies.actions, SKILLS_CAPABILITIES_ACTIONS);
  assert.deepEqual(contract.vocabularies.openResults, SKILLS_CAPABILITIES_OPEN_RESULTS);
  assert.deepEqual(contract.vocabularies.emptyReasons, SKILLS_CAPABILITIES_EMPTY_REASONS);
  assert.equal(contract.bounds.maxVisibleDefault, SKILLS_CAPABILITIES_MAX_VISIBLE_DEFAULT);
  assert.equal(contract.bounds.maxVisibleHardMax, SKILLS_CAPABILITIES_MAX_VISIBLE_HARD_MAX);
  assert.equal(contract.bounds.nameMaxLength, SKILL_NAME_MAX_LENGTH);
});

test('A the four region states are exactly the shared REGION_STATES', () => {
  assert.deepEqual(SKILLS_CAPABILITIES_STATES, REGION_STATES);
  assert.deepEqual(SKILLS_CAPABILITIES_STATES, ['loading', 'empty', 'error', 'ready']);
  // The vocabularies are QUOTED, never redefined: the surface has none of its own.
  assert.deepEqual(SKILL_STATUSES, ['implemented', 'contract-only', 'planned', 'blocked', 'deferred', 'in-progress']);
  assert.deepEqual(CAPABILITY_STATES, ['available', 'installed', 'loaded', 'active', 'idle', 'unloaded', 'disabled']);
  for (const vocab of [SKILL_STATUSES, CAPABILITY_STATES, SKILLS_CAPABILITIES_ACTIONS, SKILLS_CAPABILITIES_OPEN_RESULTS, SKILLS_CAPABILITIES_EMPTY_REASONS]) {
    assert.ok(Object.isFrozen(vocab), 'closed vocabularies are frozen');
  }
});

test('A the payload is one closed hand-over and the envelope carries no secrets', () => {
  const surface = createSkillsCapabilitiesSurface();
  assert.throws(() => surface.loadSuccess(null), /payload object/);
  assert.throws(() => surface.loadSuccess({}), /must have exactly capabilities,skills/);
  assert.throws(() => surface.loadSuccess({ skills: [], capabilities: [], extra: 1 }), /must have exactly/);
  assert.throws(() => surface.loadSuccess({ skills: 'no', capabilities: [] }), /skills \(array\)/);
  assert.throws(
    () => surface.loadSuccess({ skills: [{ id: 'sk', name: 'x', status: 'implemented', token: 'y' }], capabilities: [] }),
    /secret-bearing field token/,
  );
  assert.throws(
    () => surface.loadSuccess({ skills: [], capabilities: [], sessionId: 'x' }),
    /secret-bearing field sessionId/,
  );
});

test('A records are a closed shape and the hand-over is consistent', () => {
  const surface = createSkillsCapabilitiesSurface();
  const base = { capabilities: CAPABILITIES };
  assert.throws(() => surface.loadSuccess({ ...base, skills: ['s'] }), /skill 0 must be an object/);
  assert.throws(
    () => surface.loadSuccess({ ...base, skills: [{ id: 'sk', name: 'x', status: 'implemented', extra: 1 }] }),
    /must have exactly id,name,status/,
  );
  assert.throws(
    () => surface.loadSuccess({ ...base, skills: [{ id: 'sk', name: 'x', status: 'ghost' }] }),
    /field status must be one of implemented, contract-only/,
  );
  assert.throws(
    () => surface.loadSuccess({ ...base, skills: [{ id: 'sk', name: 'x'.repeat(SKILL_NAME_MAX_LENGTH + 1), status: 'planned' }] }),
    /field name must be at most/,
  );
  assert.throws(
    () => surface.loadSuccess({ ...base, skills: [{ id: 'sk', name: 'a', status: 'planned' }, { id: 'sk', name: 'b', status: 'planned' }] }),
    /repeats the id/,
  );
  assert.throws(
    () => surface.loadSuccess({ skills: [], capabilities: [{ id: 'c', state: 'ghost' }] }),
    /field state must be one of available, installed, loaded/,
  );
  assert.throws(
    () => surface.loadSuccess({ skills: [], capabilities: [{ id: 'c', state: 'available' }, { id: 'c', state: 'loaded' }] }),
    /capability 1 repeats the id/,
  );
});

test('A the surface is read-only and grants nothing: loadSuccess is the only entry, no fetch, no evaluator, no writes', () => {
  const source = read(join(PACKAGE_ROOT, 'src', 'skills-capabilities.mjs'));
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.equal(code.includes('fetch('), false, 'the surface never fetches');
  assert.equal(code.includes('window.'), false, 'the surface never reads window');
  assert.equal(code.includes('location'), false, 'the surface never reads location');
  assert.equal(code.includes('pushState'), false, 'the surface never touches history entries');
  assert.equal(code.includes('eval('), false, 'there is no evaluator in this surface');
  assert.equal(code.includes('new Function'), false, 'there is no function constructor in this surface');
  assert.equal(code.includes('XMLHttpRequest'), false, 'no XHR');
  assert.equal(code.includes('child_process'), false, 'the surface never shells out');
  assert.equal(code.includes('import('), false, 'the surface never dynamically imports a driver');
  const installs = code.match(/skills = Object\.freeze\(payload\.skills/g) ?? [];
  assert.equal(installs.length, 1, 'the skills are installed in loadSuccess exactly once');
  const fieldWrites = code.match(/\.(name|status|state)\s*=(?!=)/g) ?? [];
  assert.equal(fieldWrites.length, 0, 'no record field is ever written locally - the surface is read-only');
  const grantCalls = code.match(/grant|enable\(|install\(|loadCapability/g) ?? [];
  assert.equal(grantCalls.length, 0, 'the surface grants nothing - the registry owns every grant');
});

test('A the declared open never mutates the records - read-only holds for every request', () => {
  const surface = loadedSurface();
  const before = skillSnapshot(surface);
  assert.equal(surface.requestOpenSkill('sk-3'), 'accepted');
  assert.equal(surface.requestOpenSkill('sk-ghost'), 'unknown-skill');
  assert.equal(skillSnapshot(surface), before, 'id/name/status are byte-identical after every declared request');
  assert.equal(surface.skills.length, SKILLS.length, 'nothing was appended or removed');
  surface.loadSuccess({ skills: SKILLS, capabilities: CAPABILITIES });
  assert.equal(skillSnapshot(surface), before, 'a fresh hand-over yields the same read-only records');
  assert.ok(SKILLS_CAPABILITIES_OPEN_RESULTS.includes('accepted'));
  assert.ok(SKILLS_CAPABILITIES_OPEN_RESULTS.includes('unknown-skill'));
});

/* ------------------------------------------------------ B (CP-02) pilot pins */

test('B the surface-migrations manifest pins the pilot and its rollback path', () => {
  const manifest = JSON.parse(read(join(PACKAGE_ROOT, 'manifest', 'surface-migrations.json')));
  const entry = manifest.entries.find((row) => row.inventoryId === 'ui.skills.catalog');
  assert.ok(entry, 'ui.skills.catalog is registered');
  assert.deepEqual(entry.surfaceIds, ['skills-capabilities']);
  assert.equal(entry.category, 'skills-capabilities');
  assert.equal(entry.migrationStatus, 'pilot-available');
  assert.equal(entry.contractStatus, 'consuming');
  assert.equal(entry.rollbackStrategy, 'pilot-not-primary');
  assert.equal(entry.referenceImplementation, 'n8n-editor-ui@2.9.4');
  assert.equal(entry.proposedLegoOwner, 'ui-frontend');
  assert.equal(entry.sourceIssue, '240');
  assert.equal(entry.slice, 'P2-S27');
  assert.deepEqual(entry.dependencies, []);
  assert.equal(entry.evidencePath, 'packages/frontend-lego/test/64-skills-capabilities.test.mjs');
  const repoRoot = join(PACKAGE_ROOT, '..', '..');
  assert.equal(read(join(repoRoot, entry.evidencePath)).length > 0, true, 'evidence path exists');
});

test('B the capability manifest declares the skills-capabilities capability with a native fallback', () => {
  const manifest = JSON.parse(read(join(PACKAGE_ROOT, 'manifest', 'capabilities.json')));
  const capability = manifest.capabilities.find((row) => row.id === 'skills-capabilities');
  assert.ok(capability, 'skills-capabilities capability is declared');
  assert.equal(capability.lego, 'ui-frontend');
  assert.equal(capability.entry, './src/skills-capabilities.mjs');
  assert.equal(capability.status, 'available');
  assert.equal(capability.lifecycle, 'available');
  assert.equal(capability.activation, 'lazy');
  assert.equal(capability.messages, 'skills-capabilities');
  assert.deepEqual(capability.surfaces, ['skills-capabilities']);
  assert.equal(capability.degradation.fallback, 'native-behavior');
  assert.ok(capability.degradation.detail.includes('reference n8n'), 'fallback keeps the reference editor');
  assert.deepEqual(capability.tests, ['packages/frontend-lego/test/64-skills-capabilities.test.mjs']);
  assert.equal(capability.phase, 'P2-S27');
});

/* -------------------------------------------- C (CP-03) parity vs reference */

test('C every declared region state is parity-equivalent to the reference', () => {
  const loading = createSkillsCapabilitiesSurface();
  assert.equal(compareObservations(referenceLoadingObservation(), loading.observe()).status, PARITY_STATUSES[0]);

  const empty = createSkillsCapabilitiesSurface();
  empty.loadSuccess({ skills: [], capabilities: CAPABILITIES });
  assert.equal(empty.displayModel().reason, 'none');
  assert.equal(compareObservations(referenceEmptyObservation({ reason: 'none' }), empty.observe()).status, PARITY_STATUSES[0]);

  const ready = loadedSurface();
  assert.equal(compareObservations(referenceReadyObservation(), ready.observe()).status, PARITY_STATUSES[0]);

  const failed = createSkillsCapabilitiesSurface();
  failed.loadFailure({ kind: 'network' });
  assert.equal(compareObservations(referenceErrorObservation({ errorKind: 'network' }), failed.observe()).status, PARITY_STATUSES[0]);
});

test('C a divergence from the reference is fail-closed, never hidden', () => {
  const surface = loadedSurface();
  const tampered = { ...surface.observe(), interactions: { ...surface.observe().interactions, requestOpenSkill: false } };
  const { status, diffs } = compareObservations(referenceReadyObservation(), tampered);
  assert.ok(PARITY_STATUSES.includes(status), 'status stays in the closed vocabulary');
  assert.notEqual(status, PARITY_STATUSES[0], 'a divergence never reports equivalent');
  assert.ok(diffs.length > 0, 'the divergence is recorded as evidence, not hidden');
  assert.throws(() => compareObservations({}, {}), ParityError);
  assert.throws(() => referenceEmptyObservation({ reason: 'filtered' }), /reason must be one of/);
});

/* ---------------------------------- D (CP-04) accessibility + interaction */

test('D the a11y intent is derived once: form landmark on ready, assertive only on error, busy only on loading', () => {
  assert.deepEqual(SKILLS_CAPABILITIES_A11Y.ready, { role: 'form', ariaLive: 'polite', ariaBusy: false });
  assert.deepEqual(SKILLS_CAPABILITIES_A11Y.error, { role: 'status', ariaLive: 'assertive', ariaBusy: false });
  assert.deepEqual(SKILLS_CAPABILITIES_A11Y.loading, { role: 'status', ariaLive: 'polite', ariaBusy: true });
  assert.deepEqual(SKILLS_CAPABILITIES_A11Y.empty, { role: 'status', ariaLive: 'polite', ariaBusy: false });
  const surface = loadedSurface();
  assert.deepEqual(surface.a11y(), SKILLS_CAPABILITIES_A11Y.ready, 'the view-model reports the derived intent, never a copy');
  const failed = createSkillsCapabilitiesSurface();
  failed.loadFailure({ kind: 'network' });
  assert.deepEqual(failed.a11y(), SKILLS_CAPABILITIES_A11Y.error);
});

test('D keyboard reachability: focus order is stable, complete and labelled', () => {
  const surface = loadedSurface();
  const model = surface.displayModel();
  assert.deepEqual(
    model.focusOrder,
    ['view:skills', 'view:capabilities', 'skill:sk-1', 'skill:sk-2', 'skill:sk-3', 'skill:sk-4'],
    'the two catalog views lead, then every skill in hand-over order, rows never reorder',
  );
  for (const key of ['open', 'refresh']) {
    assert.equal(typeof SKILLS_CAPABILITIES_LABELS[key], 'string');
    assert.ok(SKILLS_CAPABILITIES_LABELS[key].trim().length > 0, `aria label for ${key}`);
  }
  assert.equal(model.labels, SKILLS_CAPABILITIES_LABELS, 'labels are declared once');
  surface.requestOpenSkill('sk-3');
  assert.equal(surface.displayModel().announcement, 'sk-3', 'the request announces the skill id');
});

test('D the shared per-state interaction primitives hold for every state', () => {
  assert.deepEqual(skillsCapabilitiesActionsFor('loading'), []);
  assert.deepEqual(skillsCapabilitiesActionsFor('error'), ['refresh'], 'error offers exactly the retry affordance');
  assert.deepEqual(skillsCapabilitiesActionsFor('empty'), ['refresh']);
  assert.deepEqual(skillsCapabilitiesActionsFor('ready'), ['refresh', 'request-open-skill']);

  const loading = createSkillsCapabilitiesSurface();
  assert.deepEqual(loading.displayModel().actions, []);
  assert.equal(loading.displayModel().visible, true, 'loading is never a blank');
  const empty = createSkillsCapabilitiesSurface();
  empty.loadSuccess({ skills: [], capabilities: CAPABILITIES });
  assert.deepEqual(empty.displayModel().actions, ['refresh'], 'an empty catalog offers only refresh');
  const failed = createSkillsCapabilitiesSurface();
  failed.loadFailure({ kind: 'network' });
  assert.deepEqual(failed.displayModel().actions, ['refresh']);
  assert.equal(failed.displayModel().error.kind, 'network', 'the error region carries the kind');
});

/* ------------------ E (CP-05) bounds, render cost, failure/degradation */

test('E bounded skill window: default cap, hard clamp and truncation reported', () => {
  const skills = Array.from({ length: 45 }, (_, i) => ({ id: `sk${i}`, name: `skill-${i}`, status: SKILL_STATUSES[i % 6] }));
  const surface = loadedSurface(skills);
  assert.equal(surface.maxVisible, SKILLS_CAPABILITIES_MAX_VISIBLE_DEFAULT);
  const model = surface.displayModel();
  assert.equal(model.shown.length, SKILLS_CAPABILITIES_MAX_VISIBLE_DEFAULT);
  assert.equal(model.truncated, true, 'truncation is reported, never silent');
  assert.equal(model.visibleCount, 45);
  assert.equal(model.shown[0].id, 'sk15', 'the window keeps the newest skills');

  const wide = createSkillsCapabilitiesSurface({ maxVisible: 9999 });
  assert.equal(wide.maxVisible, SKILLS_CAPABILITIES_MAX_VISIBLE_HARD_MAX, 'the hard maximum clamps the request');
  assert.throws(() => createSkillsCapabilitiesSurface({ maxVisible: 0 }), /positive integer/);
  assert.throws(() => createSkillsCapabilitiesSurface({ maxVisible: 2.5 }), /positive integer/);
});

test('E a typical payload renders inside the measured budget', () => {
  const skills = Array.from({ length: 200 }, (_, i) => ({ id: `sk${i}`, name: `skill-${i}`, status: SKILL_STATUSES[i % 6] }));
  const surface = createSkillsCapabilitiesSurface({ maxVisible: SKILLS_CAPABILITIES_MAX_VISIBLE_HARD_MAX });
  const started = process.hrtime.bigint();
  surface.loadSuccess({ skills, capabilities: CAPABILITIES });
  for (let i = 0; i < 20; i += 1) surface.displayModel();
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(elapsedMs < 250, `200 skills x20 renders took ${elapsedMs.toFixed(1)}ms (< 250ms)`);
});

test('E failure is an explicit error region with retry, never a silent blank', () => {
  const surface = createSkillsCapabilitiesSurface();
  surface.loadFailure({ kind: 'network' });
  const model = surface.displayModel();
  assert.equal(model.visible, true, 'the region stays visible');
  assert.deepEqual(model.error, { kind: 'network' });
  assert.deepEqual(model.actions, ['refresh'], 'the retry affordance is the one offered action');
  assert.equal(surface.observe().regionState, 'error');
  surface.setLoading();
  surface.loadSuccess({ skills: SKILLS, capabilities: CAPABILITIES });
  assert.equal(surface.observe().regionState, 'ready');
  assert.equal(surface.displayModel().error, null);
});

test('E degraded mode counts every undeliverable interaction instead of failing silently', () => {
  const surface = loadedSurface(SKILLS, { renderAvailable: false });
  assert.equal(surface.degradedEvents, 1, 'the load counted');
  surface.requestOpenSkill('sk-1');
  assert.equal(surface.degradedEvents, 2, 'the open counted');
  const healthy = loadedSurface();
  assert.equal(healthy.degradedEvents, 0, 'no degradation when rendering is available');
  const failed = createSkillsCapabilitiesSurface({ renderAvailable: false });
  failed.loadFailure({ kind: 'network' });
  assert.equal(failed.degradedEvents, 2, 'failure pushes the event and counts the lost render');
});

test('E declared requests answer the closed vocabularies and never mutate the hand-over', () => {
  const surface = loadedSurface();
  const before = skillSnapshot(surface);
  // request-open-skill: closed vocabulary
  assert.equal(surface.requestOpenSkill('sk-ghost'), 'unknown-skill');
  assert.equal(surface.requestOpenSkill('sk-2'), 'accepted');
  assert.throws(() => surface.requestOpenSkill(' '), /non-empty skill id/);
  // not-ready beyond refresh
  surface.setLoading();
  assert.equal(surface.requestOpenSkill('sk-2'), 'not-ready');
  // fresh hand-over: read-only, byte-identical
  surface.loadSuccess({ skills: SKILLS, capabilities: CAPABILITIES });
  assert.equal(skillSnapshot(surface), before, 'id/name/status are byte-identical after every declared request');
  // empty region refuses everything beyond refresh
  surface.loadSuccess({ skills: [], capabilities: CAPABILITIES });
  assert.equal(surface.displayModel().reason, 'none', 'no skills is empty with reason none');
  assert.equal(surface.requestOpenSkill('sk-2'), 'not-ready');
  assert.ok(SKILLS_CAPABILITIES_OPEN_RESULTS.includes('unknown-skill'));
  assert.ok(SKILLS_CAPABILITIES_OPEN_RESULTS.includes('not-ready'));
  for (const action of SKILLS_CAPABILITIES_ACTIONS) assert.ok(SKILLS_CAPABILITIES_ACTIONS.includes(action));
});
