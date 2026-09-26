/**
 * P7-S02 — Visibility & Dependency Graph (Issue #223 §7-9, §37-38; DEC-0024).
 *
 * Unit rules pin the n8n `displayParameter` semantics on small hand-written
 * definitions. The catalog suite builds the dependency graph of every node type of the
 * pinned n8n-nodes-base catalog and proves, over deterministic random edits, that the
 * incremental session always equals a full resolution.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ParameterPlanError, compileParameterPlan } from '../src/lego/parameter-plan.mjs';
import {
  GRAPH_LIMITS, ResolutionSession, buildDependencyGraph, dependentsOf, evaluateVisibility,
  getPath, getPropertyValues, resolveVisibility, splitPath, templateOf,
} from '../src/lego/parameter-graph.mjs';

const node = (properties, extra = {}) => ({ name: 'test.node', version: [1, 2], properties, ...extra });
const meta = { typeVersion: 2, nodeType: 'test.node', features: [] };
const visible = (displayOptions, scope, root = scope, m = meta) => evaluateVisibility(displayOptions, scope, root, m).visible;
const entry = (resolution, path) => resolution.entries.filter((item) => item.path === path);

const RESOURCE_OPERATION = [
  { displayName: 'Resource', name: 'resource', type: 'options', default: 'user',
    options: [{ name: 'User', value: 'user' }, { name: 'Team', value: 'team' }] },
  { displayName: 'Operation', name: 'operation', type: 'options', default: 'get',
    displayOptions: { show: { resource: ['user'] } }, options: [{ name: 'Get', value: 'get' }] },
  { displayName: 'Operation', name: 'operation', type: 'options', default: 'list',
    displayOptions: { show: { resource: ['team'] } }, options: [{ name: 'List', value: 'list' }] },
  { displayName: 'Team', name: 'teamId', type: 'options', default: '',
    typeOptions: { loadOptionsMethod: 'getTeams', loadOptionsDependsOn: ['resource'] },
    displayOptions: { show: { resource: ['team'], operation: ['list'] } } },
  { displayName: 'Members', name: 'members', type: 'options', default: '',
    typeOptions: { loadOptionsMethod: 'getMembers', loadOptionsDependsOn: ['teamId'] },
    displayOptions: { show: { resource: ['team'] } } },
  { displayName: 'Note', name: 'note', type: 'string', default: '' },
  { displayName: 'Options', name: 'options', type: 'collection', default: {},
    options: [
      { displayName: 'Timeout', name: 'timeout', type: 'number', default: 1000 },
      { displayName: 'Retry', name: 'retry', type: 'boolean', default: false,
        displayOptions: { hide: { timeout: [0] } } },
    ] },
  { displayName: 'Headers', name: 'headers', type: 'fixedCollection', default: {}, typeOptions: { multipleValues: true },
    displayOptions: { show: { resource: ['user'] } },
    options: [{ name: 'parameter', displayName: 'Header', values: [
      { displayName: 'Name', name: 'name', type: 'string', default: '' },
      { displayName: 'Value', name: 'value', type: 'string', default: '',
        displayOptions: { show: { name: [{ _cnd: { exists: true } }] } } },
    ] }] },
];

/* ------------------------------------------------------------------ paths */

test('lodash-style paths: dotted, indexed, verbatim keys and templates', () => {
  assert.deepEqual(splitPath('headers.parameter[2].name'), ['headers', 'parameter', 2, 'name']);
  assert.equal(getPath({ a: { b: [{ c: 1 }] } }, 'a.b[0].c'), 1);
  assert.equal(getPath({ 'a.b': 'verbatim', a: { b: 'nested' } }, 'a.b'), 'verbatim', 'lodash get prefers an existing verbatim key');
  assert.equal(getPath(undefined, 'a'), undefined);
  assert.equal(templateOf('headers.parameter[12].value'), 'headers.parameter[].value');
});

/* ------------------------------------------------------------------ displayParameter port */

test('getPropertyValues: root keys, meta keys, resource-locator unwrap and arrays', () => {
  const root = { resource: 'team', base: { __rl: true, mode: 'id', value: 'app1' } };
  assert.deepEqual(getPropertyValues({}, '/resource', root, meta), ['team']);
  assert.deepEqual(getPropertyValues(root, 'base', root, meta), ['app1']);
  assert.deepEqual(getPropertyValues({ tags: ['a', 'b'] }, 'tags', root, meta), ['a', 'b']);
  assert.deepEqual(getPropertyValues({}, 'missing', root, meta), [undefined]);
  assert.deepEqual(getPropertyValues({}, '@version', root, { ...meta, typeVersion: 0 }), [0]);
  assert.deepEqual(getPropertyValues({}, '@tool', root, { ...meta, nodeType: 'x.slackTool' }), [true]);
  assert.deepEqual(getPropertyValues({}, '@feature', root, meta), [], 'no declared features: empty, as upstream');
  assert.deepEqual(getPropertyValues({}, '@feature', root, { ...meta, features: ['f1'] }), ['f1']);
});

test('show: every key must pass; an expression short-circuits to VISIBLE in key order', () => {
  const rule = { show: { resource: ['team'], operation: ['list'] } };
  assert.equal(visible(rule, { resource: 'team', operation: 'list' }), true);
  assert.equal(visible(rule, { resource: 'team', operation: 'get' }), false);
  assert.equal(visible(rule, { resource: '={{ $json.r }}', operation: 'get' }), true, 'expression on the first key wins before operation is checked');
  const late = evaluateVisibility(rule, { resource: 'user', operation: '={{ 1 }}' }, {}, meta);
  assert.deepEqual([late.visible, late.reason, late.key], [false, 'show', 'resource'], 'a failing key before the expression still hides');
  assert.equal(evaluateVisibility(rule, { resource: '=x' }, {}, meta).reason, 'expression');
});

test('hide: walked only after show completes; the first matching key hides', () => {
  const rule = { show: { resource: ['team'] }, hide: { operation: ['delete'] } };
  assert.equal(visible(rule, { resource: 'team', operation: 'get' }), true);
  assert.deepEqual(evaluateVisibility(rule, { resource: 'team', operation: 'delete' }, {}, meta).reason, 'hide');
  assert.equal(visible({ hide: { tags: ['x'] } }, { tags: [] }), true, 'an empty value list never matches hide');
  assert.equal(visible({ hide: { tags: [{ _cnd: { not: 'x' } }] } }, { tags: [] }), true, 'hide requires a non-empty value list');
  assert.equal(visible({ show: { tags: [{ _cnd: { not: 'x' } }] } }, { tags: [] }), true, 'show with no values: only `not` holds');
  assert.equal(visible({ show: { '@version': [{ _cnd: { gte: 2 } }] } }, {}), true);
  assert.equal(visible({ show: { '@version': [1] } }, {}), false);
  assert.equal(visible(null, {}), true);
  assert.equal(visible({}, {}), true, 'displayOptions without show/hide is visible');
});

test('malformed rules fail safe: HIDDEN with a diagnostic, never an accidental VISIBLE', () => {
  assert.deepEqual(evaluateVisibility({ show: { resource: 'team' } }, { resource: 'team' }, {}, meta), { visible: false, reason: 'malformed', key: 'resource' });
  assert.equal(evaluateVisibility({ show: { a: [{ _cnd: { nope: 1 } }] } }, { a: 1 }, {}, meta).reason, 'malformed');
  assert.equal(evaluateVisibility({ show: { a: [{ _cnd: { regex: '(' } }] } }, { a: 'x' }, {}, meta).reason, 'malformed');
  assert.equal(evaluateVisibility({ hide: { a: 'x' } }, { a: 'x' }, {}, meta).reason, 'malformed');
  assert.equal(evaluateVisibility(['not', 'an', 'object'], {}, {}, meta).reason, 'malformed');
  const plan = compileParameterPlan(node([{ displayName: 'A', name: 'a', type: 'string', default: '', displayOptions: { show: { b: 'x' } } }]));
  const resolution = resolveVisibility(plan, { b: 'x' });
  assert.equal(resolution.entries[0].visible, false);
  assert.deepEqual(resolution.diagnostics.map((diagnostic) => diagnostic.code), ['MALFORMED_RULE']);
});

/* ------------------------------------------------------------------ resolution walk */

test('resolution: variants, collection scope, fixedCollection elements and parent-hidden', () => {
  const plan = compileParameterPlan(node(RESOURCE_OPERATION));
  const values = { resource: 'user', operation: 'get', options: { timeout: 0 }, headers: { parameter: [{ name: 'X-A', value: '1' }, { name: '' }] } };
  const resolution = resolveVisibility(plan, values);
  assert.deepEqual(entry(resolution, 'operation').map((item) => item.visible), [true, false], 'exactly the user variant of operation');
  assert.equal(entry(resolution, 'teamId')[0].visible, false);
  assert.equal(entry(resolution, 'options.retry')[0].visible, false, 'collection children read the collection value as their level');
  assert.equal(entry(resolution, 'options.retry')[0].reason, 'hide');
  assert.equal(entry(resolution, 'options.timeout')[0].present, true);
  assert.equal(entry(resolution, 'options.retry')[0].present, false);
  assert.equal(entry(resolution, 'headers.parameter[0].value')[0].visible, true, 'each element is its own level');
  assert.equal(entry(resolution, 'headers.parameter[1].value')[0].visible, false, 'exists is false for an empty string');
  const team = resolveVisibility(plan, { ...values, resource: 'team', operation: 'list' });
  assert.equal(entry(team, 'headers')[0].visible, false);
  assert.deepEqual(entry(team, 'headers.parameter[0].name').map((item) => item.reason), ['parent-hidden'], 'children of a hidden parent are hidden, never evaluated');
  assert.equal(entry(team, 'teamId')[0].visible, true);
  assert.equal(resolveVisibility(plan, null).entries.length > 0, true, 'no values resolves against defaults-free empty values');
  assert.ok(Object.isFrozen(plan), 'resolution never mutates the plan');
});

test('root keys read the root from any depth', () => {
  const plan = compileParameterPlan(node([
    { displayName: 'Mode', name: 'mode', type: 'options', default: 'a', options: [{ name: 'A', value: 'a' }, { name: 'B', value: 'b' }] },
    { displayName: 'Options', name: 'options', type: 'collection', default: {}, options: [
      { displayName: 'Only B', name: 'onlyB', type: 'string', default: '', displayOptions: { show: { '/mode': ['b'] } } },
    ] },
  ]));
  assert.equal(entry(resolveVisibility(plan, { mode: 'a', options: {} }), 'options.onlyB')[0].visible, false);
  assert.equal(entry(resolveVisibility(plan, { mode: 'b', options: {} }), 'options.onlyB')[0].visible, true);
  assert.deepEqual(buildDependencyGraph(plan).edges, [['mode', 'options.onlyB']]);
});

/* ------------------------------------------------------------------ dependency graph */

test('dependency graph: edges, slot-prefix resolution and a topological order', () => {
  const plan = compileParameterPlan(node([
    ...RESOURCE_OPERATION,
    { displayName: 'Base', name: 'base', type: 'resourceLocator', default: { mode: 'list', value: '' },
      modes: [{ displayName: 'ID', name: 'id', type: 'string' }] },
    { displayName: 'Table', name: 'table', type: 'options', default: '',
      typeOptions: { loadOptionsMethod: 'getTables', loadOptionsDependsOn: ['base.value'] } },
  ]));
  const graph = buildDependencyGraph(plan);
  assert.ok(graph.edges.some(([from, to]) => from === 'base' && to === 'table'), '`base.value` reads inside slot `base`');
  assert.ok(graph.edges.some(([from, to]) => from === 'resource' && to === 'teamId'));
  assert.ok(graph.edges.some(([from, to]) => from === 'teamId' && to === 'members'));
  assert.deepEqual([graph.cycles, graph.selfLoops, graph.missing], [[], [], []]);
  const position = new Map(graph.order.map((path, index) => [path, index]));
  for (const [from, to] of graph.edges) assert.ok(position.get(from) < position.get(to), `${from} before ${to}`);
  assert.deepEqual(buildDependencyGraph(plan), graph, 'deterministic');
  assert.deepEqual(dependentsOf(graph, 'resource'), ['headers', 'members', 'operation', 'teamId']);
  assert.deepEqual(dependentsOf(graph, 'teamId'), ['members'], 'transitive dependents only, never the path itself');
});

test('cycles, self-loops and missing paths are diagnosed by default and refused in strict mode', () => {
  const plan = compileParameterPlan(node([
    { displayName: 'A', name: 'a', type: 'boolean', default: false, displayOptions: { hide: { b: [true] } } },
    { displayName: 'B', name: 'b', type: 'boolean', default: false, displayOptions: { hide: { a: [true] } } },
    { displayName: 'C', name: 'c', type: 'string', default: '', displayOptions: { show: { c: ['x'] } } },
    { displayName: 'D', name: 'd', type: 'string', default: '', displayOptions: { show: { ghost: ['x'] } } },
  ]));
  const graph = buildDependencyGraph(plan);
  assert.deepEqual(graph.cycles, [['a', 'b']]);
  assert.deepEqual(graph.selfLoops, ['c']);
  assert.deepEqual(graph.missing.map((item) => [item.dependent, item.dependency]), [['d', 'ghost']]);
  // A cycle never recurses: visibility reads values, so both resolve in one pass.
  const resolution = resolveVisibility(plan, { a: true, b: true });
  assert.deepEqual([entry(resolution, 'a')[0].visible, entry(resolution, 'b')[0].visible], [false, false]);
  assert.throws(() => buildDependencyGraph(plan, { strict: true }), (error) => error instanceof ParameterPlanError && error.code === 'DEPENDENCY_CYCLE');
  const missingOnly = compileParameterPlan(node([{ displayName: 'D', name: 'd', type: 'string', default: '', displayOptions: { show: { ghost: ['x'] } } }]));
  assert.throws(() => buildDependencyGraph(missingOnly, { strict: true }), (error) => error.code === 'MISSING_DEPENDENCY');
});

test('a long dependency chain is handled iteratively (no recursion depth limit)', () => {
  const properties = [{ displayName: 'P0', name: 'p0', type: 'string', default: '' }];
  for (let i = 1; i < 4000; i += 1) properties.push({ displayName: `P${i}`, name: `p${i}`, type: 'string', default: '', displayOptions: { show: { [`p${i - 1}`]: ['x'] } } });
  const plan = compileParameterPlan(node(properties));
  const graph = buildDependencyGraph(plan);
  assert.equal(graph.edges.length, 3999);
  assert.equal(graph.order[0], 'p0');
  assert.equal(dependentsOf(graph, 'p0').length, 3999);
});

/* ------------------------------------------------------------------ incremental session */

test('session: a leaf edit re-evaluates nothing; a resource edit flips exactly its dependents', () => {
  const plan = compileParameterPlan(node(RESOURCE_OPERATION));
  const session = new ResolutionSession(plan, { resource: 'user', operation: 'get' });
  const leaf = session.set('note', 'hello');
  assert.deepEqual([leaf.mode, leaf.evaluated, leaf.changed, leaf.invalidated], ['in-place', 0, [], []]);
  const flip = session.set('resource', 'team');
  const changedSlots = new Set(flip.changed.map((key) => key.split('@')[1]));
  assert.ok(changedSlots.has('operation') && changedSlots.has('headers') && changedSlots.has('members'));
  assert.ok(!changedSlots.has('note') && !changedSlots.has('options'));
  assert.deepEqual(flip.invalidated, ['headers', 'members', 'operation', 'teamId']);
  assert.deepEqual(session.resolution.entries, resolveVisibility(plan, session.values).entries);
  const cache = session.set('teamId', 't1');
  assert.deepEqual(cache.invalidated, ['members'], 'the DISCOVER cache key set: dependents of teamId');
});

test('session: nested edits, element add/remove, parent visibility and removal stay exact', () => {
  const plan = compileParameterPlan(node(RESOURCE_OPERATION));
  const session = new ResolutionSession(plan, { resource: 'user', headers: { parameter: [{ name: '' }] } });
  const same = () => assert.deepEqual(session.resolution.entries, resolveVisibility(plan, session.values).entries);
  const edit = session.set('headers.parameter[0].name', 'X-A');
  assert.equal(edit.mode, 'in-place');
  assert.deepEqual(edit.changed.map((key) => key.split('@')[1]), ['headers.parameter[0].value']);
  same();
  const add = session.set('headers.parameter[1]', { name: 'X-B', value: '2' });
  assert.equal(add.mode, 'structural');
  assert.ok(add.changed.some((key) => key.endsWith('@headers.parameter[1].value')));
  same();
  assert.equal(session.set('options.timeout', 0).mode, 'in-place');
  assert.equal(entry(session.resolution, 'options.retry')[0].visible, false);
  same();
  session.set('resource', 'team');
  assert.ok(entry(session.resolution, 'headers.parameter[1].name').every((item) => item.reason === 'parent-hidden'));
  same();
  session.set('resource', 'user');
  same();
  session.set('headers', undefined);
  assert.equal(entry(session.resolution, 'headers.parameter[0].name').length, 0, 'removed elements leave no instances');
  same();
  assert.deepEqual(session.values.headers, undefined, 'hidden never deletes; explicit removal does');
});

test('session refuses invalid paths and over-budget resolutions', () => {
  const plan = compileParameterPlan(node(RESOURCE_OPERATION));
  const session = new ResolutionSession(plan, {});
  for (const bad of ['', '/resource', '@version', 42]) {
    assert.throws(() => session.set(bad, 1), (error) => error instanceof ParameterPlanError && error.code === 'INVALID_PATH');
  }
  assert.throws(() => session.set(Array.from({ length: GRAPH_LIMITS.maxPathSegments + 1 }, () => 'a').join('.'), 1), /segments/);
  const many = { resource: 'user', headers: { parameter: Array.from({ length: 40 }, () => ({ name: 'x' })) } };
  assert.throws(() => resolveVisibility(plan, many, { limits: { maxInstances: 50 } }), (error) => error.code === 'LIMIT_EXCEEDED');
  const input = { resource: 'user' };
  new ResolutionSession(plan, input).set('resource', 'team');
  assert.deepEqual(input, { resource: 'user' }, 'the session owns a private copy of the values');
});

/* ------------------------------------------------------------------ the pinned catalog */

const CATALOG_DIR = process.env.N8N_LEGO_CATALOG_DIR;

test('catalog: every plan yields a graph, and incremental resolution equals full resolution', () => {
  assert.ok(CATALOG_DIR && existsSync(join(CATALOG_DIR, 'nodes.json')), 'N8N_LEGO_CATALOG_DIR must point at the fetched catalog (npm run lego:catalog); CI provides it');
  const nodes = JSON.parse(readFileSync(join(CATALOG_DIR, 'nodes.json'), 'utf8'));
  let seed = 7;
  const random = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const totals = { edges: 0, cycles: 0, selfLoops: 0, missing: 0, steps: 0, evaluated: 0, reused: 0 };
  for (const description of nodes) {
    const plan = compileParameterPlan(description);
    const graph = buildDependencyGraph(plan);
    totals.edges += graph.edges.length;
    totals.cycles += graph.cycles.length;
    totals.selfLoops += graph.selfLoops.length;
    totals.missing += graph.missing.length;
    for (const cycle of graph.cycles) for (const path of cycle) assert.ok(graph.nodes.includes(path));
    const session = new ResolutionSession(plan, {});
    assert.deepEqual(session.resolution.diagnostics, [], `${description.name}: no malformed rule in the pinned catalog`);
    const choices = plan.parameters.filter((parameter) => !parameter.parentId && parameter.choices?.length);
    for (let step = 0; step < 6 && choices.length; step += 1) {
      const parameter = choices[Math.floor(random() * choices.length)];
      const value = random() < 0.1 ? '={{ $json.x }}' : parameter.choices[Math.floor(random() * parameter.choices.length)];
      const result = session.set(parameter.path, value);
      totals.steps += 1;
      totals.evaluated += result.evaluated;
      totals.reused += result.reused;
      assert.deepEqual(session.resolution.entries, resolveVisibility(plan, session.values).entries, `${description.name}: incremental = full after ${parameter.path}`);
    }
  }
  assert.ok(totals.edges > 10_000, `edges ${totals.edges}`);
  assert.ok(totals.steps > 2_000, `steps ${totals.steps}`);
  assert.ok(totals.reused > 0, 'the incremental path reuses results');
});
