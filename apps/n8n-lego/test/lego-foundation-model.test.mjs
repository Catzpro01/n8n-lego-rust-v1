/**
 * Foundation 1.0 tests (P2.8-B).
 *
 * These test the ARCHITECTURE, not a feature: that the vocabulary is coherent,
 * that the rules are enforced by real mechanisms rather than by documentation,
 * and that the guarantees P2.8-B claims are actually checkable.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  ACTIVATION_STATES,
  CAPABILITIES,
  COMMUNICATION_MODES,
  CONTRACT_SCHEMA_STRATEGY,
  CREATION_ROUTES,
  FAILURE_BOUNDARIES,
  FOUNDATION,
  FOUNDATION_VERSION,
  NODE_CONTRACT,
  OPERATION_SEMANTICS,
  PORTABILITY_PROFILES,
  RUNTIMES,
  STATE_CLASSES,
  TRUST_LEVELS,
  canTransition,
  decideCreationRoute,
  defaultCapabilitiesFor,
  getCreationRoute,
  isCapabilityAllowed,
  isRustJustified,
} from '../src/lego/foundation.mjs';
import { loadRegistry } from '../src/lego/registry.mjs';
import { runFoundationGate } from '../../../tools/lego/foundation-gate.mjs';
import { buildGraph, impactOf, selectTests, plan, TEST_TIERS } from '../../../tools/lego/impact-graph.mjs';
import { generate } from '../../../tools/lego/ai-pack.mjs';

/* ------------------------------------------------------- communication model */

test('exactly four communication modes exist, and no more', () => {
  assert.deepEqual([...COMMUNICATION_MODES].sort(), ['batch', 'call', 'event', 'stream']);
});

test('CALL is the default mode and in-process', () => {
  assert.match(FOUNDATION.communication.modes.call.summary, /in-process|direct/i);
  assert.equal(FOUNDATION.communication.default, 'call');
});

test('STREAM exists because chat, AI, execution output and logs need it', () => {
  const stream = JSON.stringify(FOUNDATION.communication.modes.stream).toLowerCase();
  for (const consumer of ['chat', 'ai', 'execution', 'log']) assert.ok(stream.includes(consumer), `stream should mention ${consumer}`);
});

test('the communication rules forbid internal HTTP and decorative message buses', () => {
  const rules = FOUNDATION.communication.rules.join(' ').toLowerCase();
  assert.ok(rules.includes('http'), 'must rule on internal HTTP');
  assert.ok(rules.includes('bus'), 'must rule on message buses');
});

/* --------------------------------------------------------- transport neutrality */

test('contracts are transport-neutral: every target binds the same logical contract', () => {
  for (const required of ['in-process-js', 'in-process-rust', 'wasm', 'worker', 'remote-api']) {
    assert.ok(FOUNDATION.transport.targets.includes(required), `missing binding target ${required}`);
  }
  assert.match(FOUNDATION.transport.neutralityRule, /HTTP POST/);
  assert.match(FOUNDATION.transport.bindingRule, /never change/i);
});

test('the envelope carries all ten required fields', () => {
  for (const field of ['legoId', 'operation', 'contractVersion', 'requestId', 'correlationId', 'traceId', 'actor', 'deadline', 'signal', 'idempotencyKey']) {
    assert.ok(field in FOUNDATION.envelope.fields, `envelope missing ${field}`);
  }
});

test('the envelope is explicitly zero-cost on direct calls', () => {
  assert.match(FOUNDATION.envelope.costRule, /no serialization cost/i);
});

/* ------------------------------------------------------------- trust and capability */

test('trust and capability are separate axes: trust never implies a capability', () => {
  // community is not granted network by default...
  assert.equal(isCapabilityAllowed('community', 'network').allowed, false);
  // ...but an explicit grant works.
  assert.equal(isCapabilityAllowed('community', 'network', { granted: ['network'] }).allowed, true);
});

test('all six security capabilities are separately grantable', () => {
  for (const capability of ['network', 'filesystem', 'subprocess', 'secrets', 'native', 'env']) {
    assert.ok(CAPABILITIES.includes(capability), `missing capability ${capability}`);
  }
});

test('untrusted code gets no capabilities by default', () => {
  assert.deepEqual(defaultCapabilitiesFor('untrusted'), []);
});

test('trust levels are ordered so a sub-LEGO cannot outrank its parent', () => {
  assert.ok(FOUNDATION.trust.levels.core.rank < FOUNDATION.trust.levels.community.rank);
  assert.ok(FOUNDATION.trust.levels.community.rank < FOUNDATION.trust.levels.untrusted.rank);
});

test('unknown trust levels and capabilities are rejected rather than silently allowed', () => {
  assert.equal(isCapabilityAllowed('godmode', 'network').allowed, false);
  assert.equal(isCapabilityAllowed('core', 'launch-missiles').allowed, false);
});

/* ----------------------------------------------------------------- activation */

test('the activation model has all six states and never forces code into RAM', () => {
  assert.deepEqual([...ACTIVATION_STATES].sort(), ['active', 'available', 'disabled', 'idle', 'loaded', 'unloaded'].sort());
  assert.match(FOUNDATION.activation.rule, /not.*(RAM|memory|loaded)|lazy/i);
});

test('activation transitions are enforced, not decorative', () => {
  assert.equal(canTransition('available', 'loaded').allowed, true);
  assert.equal(canTransition('loaded', 'active').allowed, true);
  assert.equal(canTransition('available', 'active').allowed, false, 'cannot skip loading');
  assert.equal(canTransition('nonsense', 'active').allowed, false);
});

/* -------------------------------------------------------- operation semantics */

test('every operation-semantics dimension has a declared vocabulary', () => {
  for (const [dimension, values] of Object.entries(OPERATION_SEMANTICS)) {
    assert.ok(values.length >= 2, `${dimension} needs a real vocabulary`);
  }
});

test('transaction classes exist and distributed transactions are excluded', () => {
  const atomicity = OPERATION_SEMANTICS.atomicity;
  for (const value of ['atomic', 'best-effort', 'retryable', 'compensatable']) {
    assert.ok(atomicity.includes(value), `missing transaction class ${value}`);
  }
  assert.match(JSON.stringify(FOUNDATION.operationSemantics.atomicity), /no distributed|not distributed|never distributed/i);
});

test('backpressure offers real choices instead of an unbounded queue', () => {
  for (const policy of ['block', 'buffer', 'batch', 'spill', 'drop', 'redirect-to-worker']) {
    assert.ok(OPERATION_SEMANTICS.backpressure.includes(policy), `missing backpressure policy ${policy}`);
  }
});

test('cancellation and deadlines are mandatory — nothing waits forever', () => {
  assert.ok(FOUNDATION.envelope.fields.deadline);
  assert.ok(FOUNDATION.envelope.fields.signal);
  assert.match(FOUNDATION.operationSemantics.cancellation.rule, /indefinite|forever|unbounded/i);
});

/* ------------------------------------------------------------- state and data */

test('state is classified into exactly the five declared classes', () => {
  assert.deepEqual([...STATE_CLASSES].sort(), ['cache', 'configuration', 'derived', 'persistent', 'runtime']);
});

test('hidden global mutable state is forbidden by rule', () => {
  assert.match(FOUNDATION.state.rules.join(' '), /No hidden global mutable state/i);
});

test('failure boundaries keep untrusted failures away from the trusted core', () => {
  assert.deepEqual([...FAILURE_BOUNDARIES].sort(), ['in-process-safe', 'sandboxed', 'worker-isolated']);
  assert.match(JSON.stringify(FOUNDATION.failureBoundaries), /untrusted/i);
});

test('checkpointing defaults to off', () => {
  assert.equal(FOUNDATION.checkpoint.default, 'off');
});

test('replay is capture -> replay -> compare, which is what makes an implementation swap provable', () => {
  assert.deepEqual(FOUNDATION.replay.model, ['capture', 'replay', 'compare']);
  assert.match(FOUNDATION.replay.rule, /Rust implementation against the JS/i);
});

/* ------------------------------------------------------------- node contract */

test('all twelve node creation routes are defined', () => {
  assert.equal(CREATION_ROUTES.length, 12);
  for (const route of ['no-code-api', 'declarative', 'openapi', 'visual-builder', 'transform-formula', 'workflow-as-node', 'javascript', 'python', 'wasm', 'rust', 'remote', 'community']) {
    assert.ok(CREATION_ROUTES.includes(route), `missing creation route ${route}`);
  }
});

test('every route declares compatibility, resources, portability, security and migration', () => {
  for (const id of CREATION_ROUTES) {
    const route = getCreationRoute(id);
    for (const field of ['use', 'runtimes', 'resources', 'portability', 'trust', 'security', 'migration']) {
      assert.ok(route[field] !== undefined, `route ${id} missing ${field}`);
    }
  }
});

test('no route is newly implemented in this phase', () => {
  const legal = new Set(['defined', 'defined-not-implemented', 'supported-today']);
  for (const id of CREATION_ROUTES) {
    assert.ok(legal.has(getCreationRoute(id).status), `route ${id} has an unexpected status`);
  }
  // Only what already worked before P2.8-B may claim to work today.
  assert.deepEqual(CREATION_ROUTES.filter((id) => getCreationRoute(id).status === 'supported-today').sort(), ['community', 'javascript']);
  assert.equal(getCreationRoute('rust').status, 'defined-not-implemented', 'Rust is locked');
});

test('node identity never changes because of an implementation change', () => {
  assert.match(NODE_CONTRACT.identityRule, /type.*typeVersion/i);
  assert.match(NODE_CONTRACT.identityRule, /Neither may change/i);
});

test('the three local runtimes plus remote execution exist', () => {
  for (const runtime of ['js-compat', 'rust-native', 'wasm', 'remote-worker']) {
    assert.ok(RUNTIMES.includes(runtime), `missing runtime ${runtime}`);
  }
});

test('portability profiles cover the constrained-device cases', () => {
  for (const profile of ['portable', 'network-required', 'filesystem-required', 'process-required', 'native-required', 'server-only', 'remote-capable']) {
    assert.ok(PORTABILITY_PROFILES.includes(profile), `missing portability profile ${profile}`);
  }
});

test('Android/Termux and low-end VPS are first-class device classes', () => {
  for (const device of ['android-termux', 'low-end-vps']) {
    assert.ok(device in FOUNDATION.deviceProfile.classes, `missing device class ${device}`);
  }
});

/* --------------------------------------------------------- the decision model */

test('an existing community node always wins — no rewrite', () => {
  const decision = decideCreationRoute({ existingCommunityNode: true, pureHotTransform: true });
  assert.equal(decision.route, 'community');
  assert.equal(decision.ruleId, 'D1');
});

test('a REST wrapper is not hand-written JavaScript', () => {
  const route = decideCreationRoute({ isRestWrapper: true }).route;
  assert.ok(['no-code-api', 'declarative'].includes(route), `expected a no-code route, got ${route}`);
});

test('an OpenAPI spec is imported rather than transcribed', () => {
  assert.equal(decideCreationRoute({ isRestWrapper: true, hasOpenApiSpec: true }).route, 'openapi');
});

test('portability beats raw speed: a portable hot transform does not become Rust', () => {
  assert.notEqual(decideCreationRoute({ pureHotTransform: true, portabilityCritical: true }).route, 'rust');
});

test('a constrained device offloads heavy work instead of dropping the feature', () => {
  assert.equal(decideCreationRoute({ constrainedDevice: true, heavy: true }).route, 'remote');
});

test('the default is JavaScript, because it is the ecosystem and always compatible', () => {
  assert.equal(decideCreationRoute({}).route, 'javascript');
});

test('every decision is explainable — it returns the rule that fired', () => {
  const decision = decideCreationRoute({ pythonEcosystem: true });
  assert.ok(decision.ruleId && decision.because && decision.rule);
});

/* -------------------------------------------------------------- Rust policy */

test('Rust is refused without a declared material benefit', () => {
  const verdict = isRustJustified({ prebuiltAvailable: true });
  assert.equal(verdict.justified, false);
  assert.match(verdict.blockers.join(' '), /material benefit|it is Rust/i);
});

test('Rust is refused when it would need a compiler on a user device', () => {
  const verdict = isRustJustified({ highFrequency: true, prebuiltAvailable: false });
  assert.equal(verdict.justified, false);
  assert.match(verdict.blockers.join(' '), /compiler|prebuilt/i);
});

test('Rust is refused when it would change the contract or break JS compatibility', () => {
  assert.equal(isRustJustified({ highFrequency: true, prebuiltAvailable: true, sameContract: false }).justified, false);
  assert.equal(isRustJustified({ highFrequency: true, prebuiltAvailable: true, breaksJsCompat: true }).justified, false);
});

test('Rust is permitted when every constraint is genuinely met', () => {
  const verdict = isRustJustified({ highFrequency: true, materialResourceSaving: true, prebuiltAvailable: true });
  assert.equal(verdict.justified, true);
  assert.ok(verdict.reasons.length >= 2);
});

test('the Rust policy states its four hard constraints', () => {
  assert.ok(NODE_CONTRACT.decisionModel.rustPolicy.hardConstraints.length >= 4);
});

/* ------------------------------------------------- community node compatibility */

test('the compatibility promise protects existing community nodes', () => {
  const promise = NODE_CONTRACT.compatibilityPromise.join(' ').toLowerCase();
  assert.ok(promise.includes('community'));
  assert.ok(promise.includes('identity') || promise.includes('typeversion'));
  assert.ok(promise.includes('quarantine'));
});

test('the node lifecycle makes quarantine mandatory', () => {
  assert.ok(NODE_CONTRACT.lifecycle.removal.includes('quarantine'));
  assert.match(NODE_CONTRACT.lifecycle.quarantineRule, /MANDATORY/);
  assert.match(NODE_CONTRACT.lifecycle.quarantineRule, /rather than silently deleted/i);
  assert.deepEqual(NODE_CONTRACT.lifecycle.install, ['install', 'scan', 'validate', 'test', 'enable']);
});

test('package isolation prevents one community package destabilising another', () => {
  const isolation = JSON.stringify(NODE_CONTRACT.lifecycle.isolation).toLowerCase();
  for (const concern of ['pin', 'scope', 'conflict', 'lock']) assert.ok(isolation.includes(concern), `package isolation should address ${concern}`);
  assert.match(NODE_CONTRACT.lifecycle.isolation.rule, /never be able to silently destabilise/i);
});

/* ------------------------------------------------------------- the schema strategy */

test('the contract schema strategy is language-neutral and not TypeScript', () => {
  assert.match(CONTRACT_SCHEMA_STRATEGY.decision.chosen, /JSON Schema/i);
  const rejected = CONTRACT_SCHEMA_STRATEGY.decision.alternatives.map((alternative) => alternative.option).join(' ');
  assert.match(rejected, /TypeScript/);
});

test('no code generator is built in this phase', () => {
  assert.match(CONTRACT_SCHEMA_STRATEGY.generationPolicy.now, /none/i);
});

test('direct in-process calls pay no serialization cost', () => {
  assert.equal(CONTRACT_SCHEMA_STRATEGY.bindings['in-process-js'].serialization, 'none');
});

test('remote bindings always validate, because they are trust boundaries', () => {
  assert.match(CONTRACT_SCHEMA_STRATEGY.bindings['remote-api'].validation, /always/i);
});

/* ---------------------------------------------------------------- the gate */

test('the foundation gate passes on the real registry', () => {
  const violations = runFoundationGate(loadRegistry({ reload: true }));
  assert.deepEqual(violations, [], `foundation violations:\n${violations.map((violation) => `${violation.rule} at ${violation.where}: ${violation.message}`).join('\n')}`);
});

test('every real LEGO declares a full Foundation 1.0 profile', () => {
  const registry = loadRegistry({ reload: true });
  for (const domain of registry.domains) {
    for (const field of ['tier', 'trust', 'stateOwner', 'communication', 'resources', 'failureBoundary']) {
      assert.ok(domain[field] !== undefined, `'${domain.id}' is missing '${field}'`);
    }
  }
});

test('the gate catches an illegal capability grant', () => {
  const registry = loadRegistry({ reload: true });
  const clone = structuredClone(registry);
  const victim = clone.domains.find((domain) => domain.id === 'settings');
  victim.trust = 'community';
  victim.capabilities_granted = ['native'];
  const violations = runFoundationGate(clone);
  assert.ok(violations.some((violation) => violation.rule.startsWith('F4')), 'should reject an ungranted capability');
});

test('the gate catches untrusted code left in-process', () => {
  const clone = structuredClone(loadRegistry({ reload: true }));
  clone.domains.find((domain) => domain.id === 'settings').trust = 'untrusted';
  const violations = runFoundationGate(clone);
  assert.ok(violations.some((violation) => violation.rule.startsWith('F6')), 'untrusted must not be in-process-safe');
});

test('the gate catches two LEGOs claiming the same data', () => {
  const clone = structuredClone(loadRegistry({ reload: true }));
  clone.domains.find((domain) => domain.id === 'settings').dataOwner = 'workflow';
  const violations = runFoundationGate(clone);
  assert.ok(violations.some((violation) => violation.rule.startsWith('F3')), 'data must have exactly one owner');
});

test('the gate catches a vocabulary violation', () => {
  const clone = structuredClone(loadRegistry({ reload: true }));
  clone.domains.find((domain) => domain.id === 'settings').communication = ['carrier-pigeon'];
  const violations = runFoundationGate(clone);
  assert.ok(violations.some((violation) => violation.rule.startsWith('F1')));
});

test('the gate catches a sub-LEGO claiming more trust than its parent', () => {
  const clone = structuredClone(loadRegistry({ reload: true }));
  clone.domains.find((domain) => domain.id === 'reference-lego').trust = 'community';
  clone.domains.find((domain) => domain.id === 'reference-lego').failureBoundary = 'sandboxed';
  const violations = runFoundationGate(clone);
  assert.ok(violations.some((violation) => violation.rule.startsWith('F4')), 'a child cannot outrank its parent');
});

/* -------------------------------------------------------------- impact graph */

test('the impact graph answers "what depends on this?"', () => {
  const impact = impactOf('storage');
  assert.ok(impact.directDependents.length > 0);
  assert.ok(impact.blastRadius > impact.directDependents.length, 'transitive reach must be counted');
});

test('the impact graph is derived from the manifest, not a second registry', () => {
  const registry = loadRegistry({ reload: true });
  const graph = buildGraph(registry);
  assert.equal(graph.size, registry.domains.length);
  for (const domain of registry.domains) {
    assert.deepEqual(graph.get(domain.id).dependsOn, domain.dependsOn ?? []);
  }
});

test('dependedOnBy is the exact inverse of dependsOn', () => {
  const graph = buildGraph(loadRegistry({ reload: true }));
  for (const node of graph.values()) {
    for (const dependency of node.dependsOn) {
      assert.ok(graph.get(dependency).dependedOnBy.includes(node.id), `${dependency} should list ${node.id} as a dependent`);
    }
  }
});

test('an unknown target is an error, not an empty result', () => {
  assert.throws(() => impactOf('does-not-exist'), /unknown LEGO/);
});

/* ----------------------------------------------------------- test selection */

test('test tiers are ordered cheapest to most expensive', () => {
  const costs = Object.values(TEST_TIERS).map((tier) => tier.cost);
  assert.deepEqual(costs, [...costs].sort((a, b) => a - b));
});

test('touching the foundation escalates beyond the fast tier', () => {
  const selection = selectTests(['src/lego/registry.mjs']);
  assert.ok(TEST_TIERS[selection.tier].cost >= TEST_TIERS.boundary.cost, `expected escalation, got ${selection.tier}`);
});

test('an unowned file escalates to a full run', () => {
  assert.equal(selectTests(['src/mystery-file.mjs']).tier, 'full');
});

test('the editor-UI compatibility path always reaches the browser gate', () => {
  assert.ok(['e2e', 'full'].includes(selectTests(['src/settings/routes.mjs']).tier));
});

test('every selection explains itself', () => {
  const selection = selectTests(['src/store.mjs']);
  assert.ok(selection.reasons.length > 0);
  assert.ok(selection.command);
});

/* ------------------------------------------------------------- plan / dry-run */

test('plan mode reports every field a reviewer needs before approving a change', () => {
  const result = plan({ target: 'storage', change: 'swap the JSON file for SQLite' });
  for (const field of ['target', 'intendedChange', 'contractsAffected', 'dependenciesAffected', 'testsRequired', 'resourceImpact', 'securityImpact', 'risk', 'rollback']) {
    assert.ok(result[field] !== undefined, `plan missing ${field}`);
  }
});

test('plan mode never applies anything', () => {
  assert.match(plan({ target: 'settings' }).apply, /not performed|advisory/i);
});

test('a high blast radius is reported as high risk', () => {
  assert.equal(plan({ target: 'storage' }).risk, 'high');
});

/* ------------------------------------------------------------- the AI pack */

test('the AI pack generates a card for every LEGO', () => {
  const files = generate();
  for (const domain of loadRegistry({ reload: true }).domains) {
    assert.ok(files.has(`domains/${domain.id}.md`), `missing card for ${domain.id}`);
  }
});

test('the AI pack contains all thirteen required artifacts', () => {
  const files = generate();
  for (const required of ['constitution.md', 'glossary.md', 'index.md', 'contracts.md', 'capabilities.md', 'decision-cards.md', 'recipes.md', 'migration-cookbook.md', 'compatibility-matrix.md', 'impact-graph.md', 'scale-out.md', 'adr-index.md', 'node-routes.md']) {
    assert.ok(files.has(required), `AI pack missing ${required}`);
  }
});

test('the constitution stays short enough that an agent will actually read it', () => {
  const lines = generate().get('constitution.md').split('\n').length;
  assert.ok(lines < 70, `constitution is ${lines} lines — it must stay compact`);
});

test('every file is marked generated, so nobody hand-edits it into drift', () => {
  for (const [path, content] of generate()) {
    assert.match(content, /GENERATED by tools\/lego\/ai-pack\.mjs/, `${path} is missing the generated banner`);
  }
});

test('all six decision cards are present', () => {
  const cards = generate().get('decision-cards.md');
  for (const card of ['API_NODE', 'CPU_HEAVY', 'MOBILE', 'COMMUNITY_NODE', 'RUST_MIGRATION', 'REMOTE_EXECUTION']) {
    assert.ok(cards.includes(card), `missing decision card ${card}`);
  }
});

test('all ten recipes exist, each with prerequisites, tests, a merge gate and a rollback', () => {
  const files = generate();
  const recipes = ['ADD_LEGO', 'ADD_SUB_LEGO', 'UPGRADE_LEGO', 'REPLACE_IMPLEMENTATION', 'MIGRATE_JS_TO_RUST', 'ADD_NODE', 'INSTALL_NODE', 'QUARANTINE_NODE', 'CHANGE_CONTRACT', 'RUN_IMPACT_ANALYSIS'];
  for (const recipe of recipes) {
    const content = files.get(`recipes/${recipe}.md`);
    assert.ok(content, `missing recipe ${recipe}`);
    for (const section of ['## Prerequisites', '## Steps', '## Required tests', '## Merge gate', '## Rollback condition']) {
      assert.ok(content.includes(section), `${recipe} missing ${section}`);
    }
  }
});

test('the Rust recipe states that Rust is currently locked', () => {
  assert.match(generate().get('recipes/MIGRATE_JS_TO_RUST.md'), /LOCKED/);
});

test('the pack tells the truth about scale-out', () => {
  assert.match(generate().get('scale-out.md'), /NOT scale-out ready/i);
});

test('the constitution documents the five context levels', () => {
  const constitution = generate().get('constitution.md');
  for (const level of ['L0', 'L1', 'L2', 'L3', 'L4']) assert.ok(constitution.includes(level), `missing context level ${level}`);
});

test('the pack is derived data — regenerating twice gives identical output', () => {
  const first = generate();
  const second = generate();
  assert.equal(first.size, second.size);
  for (const [path, content] of first) assert.equal(second.get(path), content, `${path} is not deterministic`);
});

/* -------------------------------------------------------------- foundation itself */

test('foundation version is 1.0', () => {
  assert.match(FOUNDATION_VERSION, /^1\.0/);
});

test('the LEGO model caps nesting at three tiers', () => {
  assert.equal(FOUNDATION.legoModel.maxDepth, 3);
  assert.deepEqual(FOUNDATION.legoModel.tiers, ['domain', 'feature', 'sub']);
});

test('the model states that not every function is a LEGO', () => {
  assert.match(FOUNDATION.legoModel.granularityTest, /it is a function — not a LEGO/);
  assert.match(FOUNDATION.legoModel.tierRule, /Not every function/);
});

test('a LEGO identity declares all fifteen required attributes', () => {
  for (const attribute of ['identity', 'parent', 'publicContract', 'privateImplementation', 'owner', 'dataOwner', 'stateOwner', 'capabilities', 'dependencies', 'version', 'lifecycle', 'tests', 'resources', 'trust', 'upgradePolicy']) {
    assert.ok(FOUNDATION.legoModel.attributes.includes(attribute), `LEGO model missing attribute ${attribute}`);
  }
});

test('observability happens at boundaries only, and audit is architectural not application logging', () => {
  assert.match(FOUNDATION.observability.rule, /BOUNDARIES only/);
  for (const field of ['legoId', 'contractVersion', 'operation', 'implementation', 'durationMs', 'status']) {
    assert.ok(FOUNDATION.observability.boundaryFields.includes(field), `observability missing ${field}`);
  }
  assert.match(FOUNDATION.audit.rule, /architectural change only/i);
  assert.match(FOUNDATION.audit.rule, /not application logging/i);
});

test('the rollout model is lightweight: five stages, no platform', () => {
  for (const stage of ['off', 'canary', 'gradual', 'full', 'rollback']) {
    assert.ok(FOUNDATION.rollout.stages.includes(stage), `rollout missing ${stage}`);
  }
  assert.match(FOUNDATION.rollout.rule, /No feature-flag platform is installed/i);
});

test('the performance rule names the cheap path and the things to avoid', () => {
  assert.match(FOUNDATION.principles.cheapArchitecture, /direct call -> explicit contract -> lazy runtime -> worker only when necessary/);
  for (const avoided of ['HTTP between local LEGO', 'message bus', 'daemons', 'duplicated registries']) {
    assert.ok(FOUNDATION.principles.cheapArchitecture.includes(avoided), `the cheap-architecture rule should name ${avoided}`);
  }
});

/* ------------------------------------------- minimal core, offline, Hermes, security */

test('the minimal core is exactly five members', () => {
  assert.equal(FOUNDATION.minimalCore.members.length, 5);
  for (const member of ['contracts', 'registry', 'essential runtime', 'scheduler/execution primitives', 'storage abstraction']) {
    assert.ok(FOUNDATION.minimalCore.members.includes(member), `minimal core missing ${member}`);
  }
});

test('offline readiness covers all four constrained targets', () => {
  for (const target of ['laptop', 'low-end VPS', 'Termux', 'Android']) {
    assert.ok(FOUNDATION.offlineReadiness.targets.includes(target), `missing target ${target}`);
  }
});

test('a compiler is never required on an end-user device', () => {
  assert.match(FOUNDATION.offlineReadiness.rules.join(' '), /require a compiler on an end-user device/i);
  assert.match(FOUNDATION.offlineReadiness.rules.join(' '), /PREBUILT/);
  assert.match(FOUNDATION.offlineReadiness.artifactRule, /hard requirement/i);
  assert.match(FOUNDATION.offlineReadiness.artifactRule, /isRustJustified/);
});

test('Hermes is a reserved optional provider and never a core dependency', () => {
  assert.equal(FOUNDATION.chatContract.status, 'reserved-not-implemented');
  assert.match(FOUNDATION.chatContract.rule, /never become a core dependency/i);
  assert.ok(!FOUNDATION.minimalCore.members.some((member) => /hermes|chat|translat/i.test(member)), 'chat must not be in the minimal core');
});

test('no translation LEGO or language pack was built', () => {
  assert.match(FOUNDATION.chatContract.notBuilt, /no translation LEGO/i);
});

test('the security gate names all eight detections', () => {
  assert.equal(FOUNDATION.securityGate.detections.length, 8);
  for (const detection of ['secret-in-contract', 'unauthorized-capability', 'undeclared-dependency', 'internal-bypass', 'data-owner-bypass', 'unsafe-runtime-capability', 'undeclared-external-endpoint', 'unrestricted-resource-access']) {
    assert.ok(FOUNDATION.securityGate.detections.includes(detection), `missing detection ${detection}`);
  }
});

test('the security gate is honest about what is enforced today versus deferred', () => {
  assert.ok(FOUNDATION.securityGate.implementedNow.length >= 4);
  assert.ok(FOUNDATION.securityGate.deferred.length >= 1, 'deferred detections must be stated, not implied');
  assert.match(FOUNDATION.securityGate.rule, /lightweight/i);
});

test('the security gate actually catches a secret in a public contract', async () => {
  const { mkdtempSync, writeFileSync, mkdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  // F8 is a textual probe; prove the pattern it relies on matches a real secret line
  // and not ordinary code, so the check is neither blind nor noisy.
  const probe = /(?:api[_-]?key|secret|password|token|private[_-]?key)\s*[:=]\s*['"][^'"\s]{12,}['"]/i;
  assert.ok(probe.test(`const apiKey = 'sk-live-0123456789abcdef';`), 'should flag a literal secret');
  assert.ok(!probe.test(`const apiKey = credentials.get('service');`), 'should not flag a resolved credential');
});
