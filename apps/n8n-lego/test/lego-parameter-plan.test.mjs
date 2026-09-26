/**
 * P7-S01 — Parameter Contract & Compiler (Issue #223 §4-6, §31, §37-38; DEC-0024).
 *
 * Unit rules run on small hand-written definitions; the catalog suite compiles every
 * node type of the pinned n8n-nodes-base catalog at every declared typeVersion and
 * proves the accounting invariant (declared = compiled + pruned-by-version) holds, so
 * no declaration is silently dropped.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  PLAN_FORMAT, PLAN_FORMAT_VERSION, PARAMETER_SCHEMA_VERSION, PLAN_LIMITS, KIND_BY_TYPE,
  ParameterPlanError, ParameterPlanCompiler, canonicalJson, compileParameterPlan,
  evaluateCondition, nodeVersions, parameterById, slotVariants, versionAllows, checkConditions, isDeepEqual,
} from '../src/lego/parameter-plan.mjs';

const node = (properties, extra = {}) => ({ name: 'test.node', version: [1, 2, 3], properties, ...extra });

const RESOURCE_OPERATION = [
  { displayName: 'Resource', name: 'resource', type: 'options', default: 'user', noDataExpression: true,
    options: [{ name: 'User', value: 'user' }, { name: 'Team', value: 'team' }] },
  { displayName: 'Operation', name: 'operation', type: 'options', default: 'get',
    displayOptions: { show: { resource: ['user'] } },
    options: [{ name: 'Get', value: 'get' }, { name: 'Delete', value: 'delete' }] },
  { displayName: 'Operation', name: 'operation', type: 'options', default: 'list',
    displayOptions: { show: { resource: ['team'] } },
    options: [{ name: 'List', value: 'list' }] },
  { displayName: 'Team', name: 'teamId', type: 'options', default: '',
    typeOptions: { loadOptionsMethod: 'getTeams', loadOptionsDependsOn: ['resource'] },
    displayOptions: { show: { resource: ['team'], operation: ['list'] } } },
  { displayName: 'Options', name: 'options', type: 'collection', default: {},
    options: [
      { displayName: 'Timeout', name: 'timeout', type: 'number', default: 1000, typeOptions: { minValue: 1 } },
      { displayName: 'Token', name: 'token', type: 'string', default: '', typeOptions: { password: true } },
    ] },
  { displayName: 'Headers', name: 'headers', type: 'fixedCollection', default: {}, typeOptions: { multipleValues: true },
    options: [{ name: 'parameter', displayName: 'Header', values: [
      { displayName: 'Name', name: 'name', type: 'string', default: '' },
      { displayName: 'Value', name: 'value', type: 'string', default: '', displayOptions: { show: { '/resource': ['user'] } } },
    ] }] },
  { displayName: 'Account', name: 'account', type: 'resourceLocator', default: { mode: 'list', value: '' },
    modes: [
      { displayName: 'From List', name: 'list', type: 'list', typeOptions: { searchListMethod: 'searchAccounts', searchable: true } },
      { displayName: 'ID', name: 'id', type: 'string', validation: [{ type: 'regex', properties: { regex: '^[0-9]+$' } }] },
    ] },
  { displayName: 'Legacy flag', name: 'legacy', type: 'boolean', default: false,
    displayOptions: { show: { '@version': [1] } } },
  { displayName: 'Modern flag', name: 'modern', type: 'boolean', default: true,
    displayOptions: { show: { '@version': [{ _cnd: { gte: 2 } }] } } },
  { displayName: 'Not in v3', name: 'notV3', type: 'string', default: '',
    displayOptions: { hide: { '@version': [3] } } },
];

/* ------------------------------------------------------------------ contract */

test('a plan carries its format, versions and fingerprints (#223 §5, §31)', () => {
  const plan = compileParameterPlan(node(RESOURCE_OPERATION));
  assert.equal(plan.format, PLAN_FORMAT);
  assert.equal(plan.planFormatVersion, PLAN_FORMAT_VERSION);
  assert.equal(plan.schemaVersion, PARAMETER_SCHEMA_VERSION);
  assert.equal(plan.nodeType, 'test.node');
  assert.equal(plan.typeVersion, 3, 'defaults to the latest declared version');
  assert.deepEqual(plan.versions, [1, 2, 3]);
  assert.match(plan.definitionFingerprint, /^[0-9a-f]{64}$/);
  assert.match(plan.planFingerprint, /^[0-9a-f]{64}$/);
});

test('a plan is deep-frozen: compiled state cannot be mutated by a consumer', () => {
  const plan = compileParameterPlan(node(RESOURCE_OPERATION));
  assert.ok(Object.isFrozen(plan));
  assert.ok(Object.isFrozen(plan.parameters));
  assert.ok(Object.isFrozen(plan.parameters[0]));
  assert.ok(Object.isFrozen(plan.slots));
  assert.throws(() => { 'use strict'; plan.parameters[0].default = 'x'; }, TypeError);
});

test('the source definition is never mutated and never shared with the plan', () => {
  const definition = node(structuredClone(RESOURCE_OPERATION));
  const before = canonicalJson(definition);
  const plan = compileParameterPlan(definition);
  assert.equal(canonicalJson(definition), before);
  const options = plan.parameters.find((parameter) => parameter.path === 'options');
  assert.notEqual(options.default, definition.properties[4].default, 'defaults are copies');
});

test('compilation is deterministic and reconstructible (derived plans are disposable, #223 §5)', () => {
  const a = compileParameterPlan(node(structuredClone(RESOURCE_OPERATION)));
  const b = compileParameterPlan(node(structuredClone(RESOURCE_OPERATION)));
  assert.equal(a.planFingerprint, b.planFingerprint);
  assert.equal(canonicalJson(a), canonicalJson(b));
});

/* ------------------------------------------------------------------ identity */

test('logical paths follow n8n value slots: root, collection and fixedCollection group[] (#223 §6)', () => {
  const plan = compileParameterPlan(node(RESOURCE_OPERATION));
  const paths = new Set(plan.parameters.map((parameter) => parameter.path));
  for (const path of ['resource', 'operation', 'teamId', 'options', 'options.timeout', 'options.token', 'headers', 'headers.parameter[].name', 'headers.parameter[].value', 'account']) {
    assert.ok(paths.has(path), path);
  }
});

test('one slot declared twice keeps both variants under one value slot', () => {
  const plan = compileParameterPlan(node(RESOURCE_OPERATION));
  const variants = slotVariants(plan, 'operation');
  assert.equal(variants.length, 2);
  assert.notEqual(variants[0].id, variants[1].id);
  for (const variant of variants) assert.match(variant.id, /^operation#[0-9a-f]{12}$/);
});

test('array position never becomes identity: reordering declarations keeps every id', () => {
  const plan = compileParameterPlan(node(RESOURCE_OPERATION));
  const reversed = compileParameterPlan(node([...RESOURCE_OPERATION].reverse()));
  const ids = (p) => p.parameters.map((parameter) => parameter.id).sort();
  assert.deepEqual(ids(reversed), ids(plan));
  assert.equal(reversed.definitionFingerprint === plan.definitionFingerprint, false, 'the definition itself did change');
});

test('the same child under two variants of one collection is two declarations of one slot', () => {
  const child = { displayName: 'Flag', name: 'flag', type: 'boolean', default: false };
  const plan = compileParameterPlan(node([
    { displayName: 'Options', name: 'options', type: 'collection', default: {}, displayOptions: { show: { resource: ['a'] } }, options: [child] },
    { displayName: 'Options', name: 'options', type: 'collection', default: {}, displayOptions: { show: { resource: ['b'] } }, options: [child] },
  ]));
  const flags = slotVariants(plan, 'options.flag');
  assert.equal(flags.length, 2);
  assert.notEqual(flags[0].parentId, flags[1].parentId);
  assert.deepEqual(plan.diagnostics, []);
});

test('a byte-identical repeat is kept, never dropped, and reported', () => {
  const twin = { displayName: 'X', name: 'x', type: 'string', default: '' };
  const plan = compileParameterPlan(node([twin, structuredClone(twin)]));
  assert.equal(slotVariants(plan, 'x').length, 2);
  assert.equal(plan.stats.compiled, 2);
  assert.deepEqual(plan.diagnostics.map((diagnostic) => diagnostic.code), ['IDENTICAL_DECLARATION']);
});

/* ------------------------------------------------------------------ versions */

test('@version is decided at compile time: show needs a match, hide removes a match (#223 §31)', () => {
  const at = (typeVersion) => new Set(compileParameterPlan(node(RESOURCE_OPERATION), { typeVersion }).parameters.map((parameter) => parameter.path));
  assert.ok(at(1).has('legacy') && !at(1).has('modern') && at(1).has('notV3'));
  assert.ok(!at(2).has('legacy') && at(2).has('modern') && at(2).has('notV3'));
  assert.ok(!at(3).has('legacy') && at(3).has('modern') && !at(3).has('notV3'));
  const plan = compileParameterPlan(node(RESOURCE_OPERATION), { typeVersion: 3 });
  assert.equal(plan.stats.prunedByVersion, 2);
  assert.equal(plan.stats.declarations, plan.stats.compiled + plan.stats.prunedByVersion);
});

test('versionAllows and evaluateCondition implement the n8n _cnd operators', () => {
  assert.equal(versionAllows(undefined, 1), true);
  assert.equal(versionAllows({ show: { '@version': [{ _cnd: { between: { from: 2, to: 3 } } }] } }, 2.5), true);
  assert.equal(versionAllows({ show: { '@version': [{ _cnd: { lt: 2 } }] } }, 2), false);
  assert.equal(versionAllows({ show: { resource: ['x'] } }, 9), true, 'non-version keys are left to RESOLVE');
  for (const [condition, actual, expected] of [
    [{ eq: 1 }, 1, true], [{ not: 1 }, 1, false], [{ gte: 2 }, 2, true], [{ lte: 2 }, 3, false],
    [{ gt: 1 }, 1.1, true], [{ lt: 1 }, 1, false], [{ includes: 'b' }, 'abc', true], [{ exists: true }, '', false],
  ]) assert.equal(evaluateCondition(condition, actual), expected, JSON.stringify(condition));
  assert.throws(() => evaluateCondition({ bogus: 1 }, 1), (error) => error instanceof ParameterPlanError && error.code === 'UNSUPPORTED_CONDITION');
  assert.throws(() => evaluateCondition({ eq: 1, not: 2 }, 1), (error) => error.code === 'INVALID_CONDITION');
});

test('pruning is sound against n8n key order: a dynamic key before @version keeps the variant', () => {
  // n8n returns VISIBLE as soon as a show key holds an expression, before @version is read.
  assert.equal(versionAllows({ show: { resource: ['x'], '@version': [1] } }, 2), true);
  assert.equal(versionAllows({ show: { '@version': [1], resource: ['x'] } }, 2), false, '@version first: the walk stops at it');
  // hide is only walked when show completes, so it prunes only behind a fully static show.
  assert.equal(versionAllows({ show: { resource: ['x'] }, hide: { '@version': [2] } }, 2), true);
  assert.equal(versionAllows({ show: { '@version': [2] }, hide: { '@version': [2] } }, 2), false);
  assert.equal(versionAllows({ hide: { resource: ['x'], '@version': [2] } }, 2), false, 'any static hide match hides');
  // @tool is static: the node name ends with Tool.
  assert.equal(versionAllows({ show: { '@tool': [true] } }, 1, 'n8n-nodes-base.fooTool'), true);
  assert.equal(versionAllows({ show: { '@tool': [true] } }, 1, 'n8n-nodes-base.foo'), false);
});

test('checkConditions is the n8n port: every value must match a _cnd, empty values only satisfy not', () => {
  assert.equal(checkConditions([{ _cnd: { gte: 2 } }], [2, 3]), true);
  assert.equal(checkConditions([{ _cnd: { gte: 2 } }], [2, 1]), false);
  assert.equal(checkConditions([{ _cnd: { not: 'a' } }], []), true);
  assert.equal(checkConditions([{ _cnd: { eq: 'a' } }], []), false);
  assert.equal(checkConditions(['a', 'b'], ['b']), true);
  assert.equal(checkConditions([1], ['1']), false, 'literals match strictly');
  assert.equal(checkConditions([{ _cnd: { eq: { a: [1] } } }], [{ a: [1] }]), true, 'eq is structural');
  assert.equal(isDeepEqual({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 }), true);
  assert.equal(isDeepEqual([1], { 0: 1 }), false);
});

test('an undeclared typeVersion is refused, not approximated', () => {
  assert.throws(() => compileParameterPlan(node(RESOURCE_OPERATION), { typeVersion: 4 }), (error) => error.code === 'UNKNOWN_VERSION');
  assert.deepEqual(nodeVersions({ name: 'n', version: 2 }), [2]);
  assert.deepEqual(nodeVersions({ name: 'n', version: [3, 1, 1] }), [1, 3]);
  assert.throws(() => nodeVersions({ name: 'n', version: ['x'] }), (error) => error.code === 'INVALID_VERSION');
});

/* ------------------------------------------------------------------ recorded rules */

test('dependencies are recorded as absolute paths; @meta keys are kept apart (#223 §7 input)', () => {
  const plan = compileParameterPlan(node(RESOURCE_OPERATION), { typeVersion: 2 });
  const team = slotVariants(plan, 'teamId')[0];
  assert.deepEqual(team.dependsOn, ['operation', 'resource']);
  const value = slotVariants(plan, 'headers.parameter[].value')[0];
  assert.deepEqual(value.dependsOn, ['resource'], 'a leading slash is root-relative');
  const modern = slotVariants(plan, 'modern')[0];
  assert.deepEqual(modern.dependsOn, []);
  assert.deepEqual(modern.metaDependsOn, ['@version']);
  assert.ok(plan.dependencyEdges.some(([from, to]) => from === 'resource' && to === 'teamId'));
});

test('loadOptionsDependsOn is root-relative; a leading & names a sibling in the same scope', () => {
  const plan = compileParameterPlan(node([
    { displayName: 'Base', name: 'base', type: 'string', default: '' },
    { displayName: 'Options', name: 'options', type: 'collection', default: {}, options: [
      { displayName: 'Table', name: 'table', type: 'string', default: '' },
      { displayName: 'Fields', name: 'fields', type: 'multiOptions', default: [],
        typeOptions: { loadOptionsMethod: 'getFields', loadOptionsDependsOn: ['base.value', '&table'] } },
    ] },
  ]));
  assert.deepEqual(slotVariants(plan, 'options.fields')[0].dependsOn, ['base.value', 'options.table']);
});

test('dynamic sources, resourceLocator modes, validation and sensitivity are compiled, not evaluated', () => {
  const plan = compileParameterPlan(node(RESOURCE_OPERATION));
  const team = slotVariants(plan, 'teamId')[0];
  assert.deepEqual(team.dynamic, { loadOptionsMethod: 'getTeams', loadOptionsDependsOn: ['resource'] });
  assert.equal(team.cachePolicy, 'dynamic');
  assert.deepEqual(team.capability, { discover: true, network: true });
  const account = slotVariants(plan, 'account')[0];
  assert.deepEqual(account.dynamic, { searchListMethods: ['searchAccounts'] });
  assert.equal(account.resourceLocatorModes[0].searchListMethod, 'searchAccounts');
  assert.equal(account.resourceLocatorModes[1].validation[0].type, 'regex');
  assert.deepEqual(slotVariants(plan, 'options.timeout')[0].validation, { minValue: 1 });
  assert.equal(slotVariants(plan, 'options.token')[0].sensitive, true);
  assert.deepEqual(plan.sensitiveParameters, [slotVariants(plan, 'options.token')[0].id]);
  assert.deepEqual(slotVariants(plan, 'resource')[0].validation, { noDataExpression: true });
  assert.deepEqual(slotVariants(plan, 'resource')[0].choices, ['user', 'team']);
  const staticField = slotVariants(plan, 'resource')[0];
  assert.deepEqual(staticField.capability, { discover: false, network: false }, 'no network on static fields (#223 §37)');
  assert.equal(parameterById(plan, team.id), team);
});

test('an unknown type is kept as opaque with a diagnostic, never dropped (#223 §32)', () => {
  const plan = compileParameterPlan(node([{ displayName: 'Custom', name: 'custom', type: 'myCommunityWidget', default: 1 }]));
  assert.equal(plan.parameters.length, 1);
  assert.equal(plan.parameters[0].kind, 'opaque');
  assert.deepEqual(plan.diagnostics, [{ code: 'UNKNOWN_TYPE', path: 'custom', type: 'myCommunityWidget' }]);
  assert.equal(KIND_BY_TYPE.resourceLocator, 'resourceLocator');
});

test('display-only declarations hold no value slot', () => {
  const plan = compileParameterPlan(node([{ displayName: 'Note', name: 'note', type: 'notice', default: '' }]));
  assert.equal(plan.parameters[0].valueSlot, false);
  assert.deepEqual(plan.slots, {});
});

test('node credentials are recorded with their visibility', () => {
  const plan = compileParameterPlan(node([], { credentials: [{ name: 'fooApi', required: true, displayOptions: { show: { authentication: ['foo'] } } }] }));
  assert.deepEqual(plan.credentials, [{ name: 'fooApi', required: true, visibility: { show: { authentication: ['foo'] } } }]);
});

/* ------------------------------------------------------------------ bounds */

test('limits refuse, never truncate (#223 §38)', () => {
  const many = Array.from({ length: 5 }, (_, index) => ({ displayName: `P${index}`, name: `p${index}`, type: 'string', default: '' }));
  assert.throws(() => compileParameterPlan(node(many), { limits: { maxParameters: 4 } }), (error) => error.code === 'LIMIT_EXCEEDED' && error.details.limit === 'maxParameters');
  let deep = [{ displayName: 'Leaf', name: 'leaf', type: 'string', default: '' }];
  for (let level = 0; level < 4; level += 1) deep = [{ displayName: `C${level}`, name: `c${level}`, type: 'collection', default: {}, options: deep }];
  assert.throws(() => compileParameterPlan(node(deep), { limits: { maxDepth: 2 } }), (error) => error.details.limit === 'maxDepth');
  assert.throws(() => compileParameterPlan(node([{ displayName: 'Big', name: 'big', type: 'string', default: 'x'.repeat(100) }]), { limits: { maxDefaultBytes: 10 } }), (error) => error.details.limit === 'maxDefaultBytes');
  assert.throws(() => compileParameterPlan(node([{ displayName: 'O', name: 'o', type: 'options', default: 'a', options: [{ name: 'a', value: 'a' }, { name: 'b', value: 'b' }] }]), { limits: { maxOptionsPerParameter: 1 } }), (error) => error.details.limit === 'maxOptionsPerParameter');
});

test('invalid definitions are refused with a typed error', () => {
  for (const bad of [null, {}, { name: 'x', version: 1, properties: 'no' }, { name: 'x', version: 1, properties: [{ type: 'string' }] }]) {
    assert.throws(() => compileParameterPlan(bad), (error) => error instanceof ParameterPlanError && error.namespace === 'dynamic-parameters');
  }
});

/* ------------------------------------------------------------------ compile-once cache */

test('the compiler compiles once per (type, version, definition) and serves the frozen plan', () => {
  const compiler = new ParameterPlanCompiler({ maxEntries: 2 });
  const definition = node(RESOURCE_OPERATION);
  const first = compiler.plan(definition, 2);
  assert.equal(compiler.plan(definition, 2), first);
  assert.deepEqual(compiler.stats(), { entries: 1, maxEntries: 2, hits: 1, misses: 1, evictions: 0 });
  const changed = node([...RESOURCE_OPERATION, { displayName: 'New', name: 'new', type: 'string', default: '' }]);
  assert.notEqual(compiler.plan(changed, 2), first, 'a changed definition is a different key; a stale plan is never served');
  compiler.plan(definition, 1);
  assert.equal(compiler.stats().evictions, 1, 'bounded LRU');
  assert.equal(compiler.stats().entries, 2);
  assert.throws(() => new ParameterPlanCompiler({ maxEntries: PLAN_LIMITS.maxCacheEntries + 1 }), (error) => error.code === 'INVALID_BUDGET');
});

/* ------------------------------------------------------------------ the pinned catalog */

const CATALOG_DIR = process.env.N8N_LEGO_CATALOG_DIR;

test('every node type of the catalog compiles at every declared version, with full accounting', () => {
  assert.ok(CATALOG_DIR && existsSync(join(CATALOG_DIR, 'nodes.json')), 'N8N_LEGO_CATALOG_DIR must point at the fetched catalog (npm run lego:catalog); CI provides it');
  const nodes = JSON.parse(readFileSync(join(CATALOG_DIR, 'nodes.json'), 'utf8'));
  assert.ok(nodes.length >= 400, `catalog has ${nodes.length} node types`);
  const compiler = new ParameterPlanCompiler({ maxEntries: PLAN_LIMITS.maxCacheEntries });
  let plans = 0;
  let dynamic = 0;
  let locators = 0;
  const unknown = new Set();
  for (const description of nodes) {
    for (const version of nodeVersions(description)) {
      const plan = compiler.plan(description, version);
      plans += 1;
      assert.equal(plan.stats.declarations, plan.stats.compiled + plan.stats.prunedByVersion, `${description.name}@${version}: every declaration is compiled or pruned by version`);
      assert.equal(new Set(plan.parameters.map((parameter) => parameter.id)).size, plan.parameters.length, `${description.name}@${version}: ids are unique`);
      for (const diagnostic of plan.diagnostics) if (diagnostic.code === 'UNKNOWN_TYPE') unknown.add(diagnostic.type);
      dynamic += plan.stats.dynamic;
      locators += plan.parameters.filter((parameter) => parameter.kind === 'resourceLocator').length;
    }
  }
  assert.ok(plans > nodes.length, 'multi-version nodes compile once per version');
  assert.deepEqual([...unknown], [], 'every catalog property type is known to the compiler');
  assert.ok(dynamic > 1000, `dynamic sources recorded (${dynamic})`);
  assert.ok(locators > 100, `resourceLocator parameters recorded (${locators})`);
});
