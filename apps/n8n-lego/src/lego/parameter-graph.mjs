/**
 * Visibility & Dependency Graph (P7-S02, Issue #223 §7-9, §37-38; DEC-0024).
 *
 * Stage 3 (RESOLVE) of the P7 pipeline, over an immutable ParameterPlan (P7-S01):
 *
 *   DECLARE -> COMPILE (parameter-plan.mjs) -> RESOLVE (this module) -> DISCOVER -> VALIDATE
 *
 * VISIBILITY (#223 §9) is a faithful port of n8n `displayParameter` /
 * `displayParameterPath` / `getPropertyValues` (workflow/src/node-helpers.ts, pinned
 * n8n-nodes-base 2.9.1):
 *   - a key starting with `/` reads from the root parameters, any other key reads
 *     lodash-`get` style from the current level (the containing collection value or
 *     fixedCollection element);
 *   - `@version` is `typeVersion || 0`, `@tool` is "node name ends with Tool",
 *     `@feature` is the caller-supplied enabled feature list (none by default: no
 *     node in the pinned catalog declares features);
 *   - a resource-locator value (`{ __rl: true, value }`) is unwrapped to `.value`;
 *     an array value is many values;
 *   - `show` is walked in key order and returns VISIBLE as soon as a key's values
 *     contain an expression (a string starting with `=`), otherwise every key must
 *     pass `checkConditions`; `hide` is walked only when `show` completes and hides on
 *     the first matching key.
 *   Hidden never deletes a stored value (#223 §9). Expressions are never evaluated:
 *   P7 does not have an expression language (#223 §10).
 *
 * FAIL SAFE (#223 §9). A malformed rule (condition list that is not an array, an
 * unknown `_cnd` operator, an invalid regex) resolves HIDDEN with reason `malformed`
 * and a diagnostic. Upstream throws on such data; hiding is the safe direction and is
 * the recorded divergence.
 *
 * DEPENDENCY GRAPH (#223 §7). Nodes are parameter paths; an edge `a -> b` means b's
 * visibility or option source reads a. A dependency path resolves to its declared slot
 * or to the longest declared slot prefix (`base.value` reads inside slot `base`).
 * Cycles (iterative Tarjan SCC, never recursion), self-loops and dependencies on
 * undeclared paths are reported. The pinned catalog contains all three (mutually
 * dependent `show` rules are harmless in n8n because visibility reads values, not
 * visibility), so the default is COMPATIBLE: diagnose, do not reject. `strict: true`
 * rejects them for definitions that must be clean (later third-party admission).
 *
 * INCREMENTAL (#223 §8, §37). A ResolutionSession keeps the last resolution. After
 * `set(path, value)` it re-evaluates only variants whose dependencies touch the
 * changed path (or whose parent visibility changed); every other instance reuses its
 * previous result. The walk stays linear in instances; predicate evaluation is limited
 * to the affected set, and the incremental result always equals a full resolution
 * (tested over the whole catalog). `invalidated` lists the transitive dependents of
 * the change, the key set a DISCOVER cache (P7-S04) must drop.
 *
 * HOUSE RULES: no I/O, no network, no clock, no module state. Bounded: instance
 * count and value path depth are limited and over-limit REFUSES with a typed error.
 */
import { ParameterPlanError, checkConditions } from './parameter-plan.mjs';

export const GRAPH_LIMITS = Object.freeze({
  maxInstances: 50_000, // resolved (variant, concrete path) pairs per resolution
  maxPathSegments: 64, // segments in one value path accepted by set()
});

/* ------------------------------------------------------------------ lodash-style paths */

const INDEX = /\[(\d+)\]/g;

/** Split `a.b[0].c` into ['a', 'b', 0, 'c'] (lodash `stringToPath` for the shapes n8n uses). */
export function splitPath(path) {
  if (typeof path !== 'string' || path === '') return [];
  const segments = [];
  for (const part of path.split('.')) {
    const head = part.replace(INDEX, '');
    if (head !== '') segments.push(head);
    for (const match of part.matchAll(INDEX)) segments.push(Number(match[1]));
  }
  return segments;
}

/** lodash `get`: a key that exists verbatim on the object wins over path splitting. */
export function getPath(object, path) {
  if (object === null || object === undefined) return undefined;
  if (typeof path === 'string' && typeof object === 'object' && path in object) return object[path];
  let current = object;
  for (const segment of splitPath(path)) {
    if (current === null || current === undefined) return undefined;
    current = current[segment];
  }
  return current;
}

/** Concrete path -> template path (`headers.parameter[3].name` -> `headers.parameter[].name`). */
export const templateOf = (path) => path.replace(INDEX, '[]');

/* ------------------------------------------------------------------ visibility (port) */

/** Port of n8n `getPropertyValues`. */
export function getPropertyValues(scopeValues, key, rootValues, meta) {
  let value;
  if (key.charAt(0) === '/') value = getPath(rootValues, key.slice(1));
  else if (key === '@version') value = meta.typeVersion || 0;
  else if (key === '@tool') value = String(meta.nodeType ?? '').endsWith('Tool');
  else if (key === '@feature') return [...(meta.features ?? [])];
  else value = getPath(scopeValues, key);
  if (value && typeof value === 'object' && '__rl' in value && value.__rl) value = value.value;
  return Array.isArray(value) ? value : [value];
}

const isExpression = (value) => typeof value === 'string' && value.charAt(0) === '=';

/**
 * Port of n8n `displayParameter`. Returns { visible, reason, key? } where reason is
 * `no-rules` | `rules` | `expression` (show short-circuit on key) | `show` (key failed)
 * | `hide` (key matched) | `malformed`.
 */
export function evaluateVisibility(displayOptions, scopeValues, rootValues, meta) {
  if (!displayOptions) return { visible: true, reason: 'no-rules' };
  if (typeof displayOptions !== 'object' || Array.isArray(displayOptions)) return { visible: false, reason: 'malformed', key: null };
  const { show, hide } = displayOptions;
  try {
    if (show) {
      for (const key of Object.keys(show)) {
        const values = getPropertyValues(scopeValues, key, rootValues, meta);
        if (values.some(isExpression)) return { visible: true, reason: 'expression', key };
        if (!Array.isArray(show[key])) return { visible: false, reason: 'malformed', key };
        if (!checkConditions(show[key], values)) return { visible: false, reason: 'show', key };
      }
    }
    if (hide) {
      for (const key of Object.keys(hide)) {
        const values = getPropertyValues(scopeValues, key, rootValues, meta);
        if (!Array.isArray(hide[key])) return { visible: false, reason: 'malformed', key };
        if (values.length !== 0 && checkConditions(hide[key], values)) return { visible: false, reason: 'hide', key };
      }
    }
  } catch (error) {
    if (error instanceof ParameterPlanError || error instanceof SyntaxError) return { visible: false, reason: 'malformed', key: null };
    throw error;
  }
  return { visible: true, reason: 'rules' };
}

/* ------------------------------------------------------------------ dependency graph */

function childrenIndex(plan) {
  const children = new Map();
  for (const parameter of plan.parameters) {
    const parent = parameter.parentId ?? '';
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(parameter);
  }
  return children;
}

function resolveSlot(slots, path) {
  if (slots.has(path)) return path;
  const segments = path.split('.');
  for (let length = segments.length - 1; length > 0; length -= 1) {
    const prefix = segments.slice(0, length).join('.');
    if (slots.has(prefix)) return prefix;
  }
  return null;
}

/**
 * Dependency graph of one plan. Nodes are parameter paths; `edges` are
 * [dependencyPath, dependentPath] after slot resolution. Reports `cycles`
 * (strongly connected components of size > 1, sorted), `selfLoops` and `missing`
 * (dependency paths that name no declared slot). `order` is a deterministic
 * topological order of the condensation (dependencies first).
 */
export function buildDependencyGraph(plan, { strict = false } = {}) {
  const nodes = [...new Set(plan.parameters.map((parameter) => parameter.path))].sort();
  const slots = new Set(nodes);
  const adjacency = new Map(nodes.map((node) => [node, new Set()]));
  const missing = [];
  const selfLoops = new Set();
  const edges = [];
  for (const parameter of plan.parameters) {
    for (const dependency of parameter.dependsOn) {
      const from = resolveSlot(slots, dependency);
      if (from === null) {
        missing.push({ dependency, dependent: parameter.path, id: parameter.id });
        continue;
      }
      if (from === parameter.path) {
        selfLoops.add(from);
        continue;
      }
      if (!adjacency.get(from).has(parameter.path)) {
        adjacency.get(from).add(parameter.path);
        edges.push([from, parameter.path]);
      }
    }
  }
  edges.sort((a, b) => (a[0] + '\0' + a[1]).localeCompare(b[0] + '\0' + b[1]));

  // Iterative Tarjan: deterministic (sorted nodes and successors), no recursion.
  const index = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  const components = [];
  let counter = 0;
  const successors = new Map(nodes.map((node) => [node, [...adjacency.get(node)].sort()]));
  for (const start of nodes) {
    if (index.has(start)) continue;
    const work = [[start, 0]];
    index.set(start, counter); low.set(start, counter); counter += 1;
    stack.push(start); onStack.add(start);
    while (work.length) {
      const frame = work[work.length - 1];
      const [node] = frame;
      const next = successors.get(node);
      if (frame[1] < next.length) {
        const target = next[frame[1]];
        frame[1] += 1;
        if (!index.has(target)) {
          index.set(target, counter); low.set(target, counter); counter += 1;
          stack.push(target); onStack.add(target);
          work.push([target, 0]);
        } else if (onStack.has(target)) {
          low.set(node, Math.min(low.get(node), index.get(target)));
        }
        continue;
      }
      work.pop();
      if (work.length) {
        const parent = work[work.length - 1][0];
        low.set(parent, Math.min(low.get(parent), low.get(node)));
      }
      if (low.get(node) === index.get(node)) {
        const component = [];
        let member;
        do {
          member = stack.pop();
          onStack.delete(member);
          component.push(member);
        } while (member !== node);
        components.push(component.sort());
      }
    }
  }
  const order = components.slice().reverse().flat(); // Tarjan emits sinks first
  const cycles = components.filter((component) => component.length > 1).sort((a, b) => a[0].localeCompare(b[0]));
  const graph = {
    nodeType: plan.nodeType,
    typeVersion: plan.typeVersion,
    planFingerprint: plan.planFingerprint,
    nodes,
    edges,
    order,
    cycles,
    selfLoops: [...selfLoops].sort(),
    missing: missing.sort((a, b) => (a.dependent + a.dependency).localeCompare(b.dependent + b.dependency)),
  };
  if (strict) {
    if (graph.cycles.length || graph.selfLoops.length) {
      throw new ParameterPlanError('DEPENDENCY_CYCLE', `${plan.nodeType}: parameter dependency cycle (${[...graph.cycles.map((cycle) => cycle.join(' -> ')), ...graph.selfLoops].join('; ')})`, { cycles: graph.cycles, selfLoops: graph.selfLoops });
    }
    if (graph.missing.length) {
      throw new ParameterPlanError('MISSING_DEPENDENCY', `${plan.nodeType}: ${graph.missing.length} dependency path(s) name no declared parameter (first: ${graph.missing[0].dependent} -> ${graph.missing[0].dependency})`, { missing: graph.missing });
    }
  }
  return graph;
}

/** Transitive dependents of `path` (template form), dependencies excluded, sorted. */
function adjacencyOf(graph) {
  const adjacency = new Map();
  for (const [from, to] of graph.edges) {
    if (!adjacency.has(from)) adjacency.set(from, []);
    adjacency.get(from).push(to);
  }
  return adjacency;
}

export function dependentsOf(graph, path, adjacency = adjacencyOf(graph)) {
  const template = templateOf(path);
  const seeds = graph.nodes.filter((node) => related(node, template));
  const seen = new Set();
  const queue = [...seeds];
  for (let head = 0; head < queue.length; head += 1) {
    const node = queue[head];
    for (const next of adjacency.get(node) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return [...seen].sort();
}

/** True when two template paths are equal or one lies inside the other. */
function related(a, b) {
  if (a === b) return true;
  const inside = (inner, outer) => inner.startsWith(`${outer}.`) || inner.startsWith(`${outer}[`);
  return inside(a, b) || inside(b, a);
}

/* ------------------------------------------------------------------ resolution walk */

function metaOf(plan, options) {
  return { typeVersion: plan.typeVersion, nodeType: plan.nodeType, features: options.features ?? [] };
}

/**
 * Walk the plan against values. `decide(parameter, path, scope)` returns the
 * visibility record; the walk instantiates collection children against the collection
 * value and fixedCollection children against each group value / element, exactly as
 * the editor passes `nodeValues` at that path.
 */
function walk(plan, values, decide, limits) {
  const children = childrenIndex(plan);
  const entries = [];
  const root = values && typeof values === 'object' ? values : {};
  const scopes = [];
  const parents = [];
  const visitList = (list, scope, concreteScope, parentHidden, parentIndex) => {
    for (const parameter of list) {
      const path = concreteScope ? `${concreteScope}.${parameter.name}` : parameter.name;
      if (entries.length >= limits.maxInstances) {
        throw new ParameterPlanError('LIMIT_EXCEEDED', `${plan.nodeType}: more than ${limits.maxInstances} resolved parameter instances`, { limit: 'maxInstances' });
      }
      const record = parentHidden
        ? { visible: false, reason: 'parent-hidden' }
        : decide(parameter, path, scope, root);
      const scoped = scope && typeof scope === 'object' ? scope : {};
      const self = entries.length;
      entries.push({ id: parameter.id, path, slot: parameter.path, visible: record.visible, reason: record.reason, key: record.key ?? null, present: Object.prototype.hasOwnProperty.call(scoped, parameter.name) });
      scopes.push(concreteScope);
      parents.push(parentIndex);
      const kids = children.get(parameter.id);
      if (!kids) continue;
      const hidden = !record.visible;
      const value = scoped[parameter.name];
      if (parameter.kind === 'collection') {
        if (parameter.multipleValues) {
          (Array.isArray(value) ? value : []).forEach((element, i) => visitList(kids, element, `${path}[${i}]`, hidden, self));
        } else {
          visitList(kids, value && typeof value === 'object' && !Array.isArray(value) ? value : {}, path, hidden, self);
        }
      } else if (parameter.kind === 'fixedCollection') {
        const groups = new Map();
        for (const kid of kids) {
          const group = kid.path.slice(parameter.path.length + 1).split(/[.[]/)[0];
          if (!groups.has(group)) groups.set(group, []);
          groups.get(group).push(kid);
        }
        const container = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
        for (const [group, members] of groups) {
          const groupValue = container[group];
          if (parameter.multipleValues) {
            (Array.isArray(groupValue) ? groupValue : []).forEach((element, i) => visitList(members, element, `${path}.${group}[${i}]`, hidden, self));
          } else {
            visitList(members, groupValue && typeof groupValue === 'object' && !Array.isArray(groupValue) ? groupValue : {}, `${path}.${group}`, hidden, self);
          }
        }
      }
    }
  };
  visitList(children.get('') ?? [], root, '', false, -1);
  return { entries, scopes, parents };
}

function summarise(plan, entries, diagnostics, counters) {
  return {
    nodeType: plan.nodeType,
    typeVersion: plan.typeVersion,
    planFingerprint: plan.planFingerprint,
    entries,
    visible: entries.filter((entry) => entry.visible).map((entry) => `${entry.id}@${entry.path}`),
    diagnostics,
    counters,
  };
}

/** Full resolution: visibility of every parameter instance for these values. */
export function resolveVisibility(plan, values, options = {}) {
  const limits = { ...GRAPH_LIMITS, ...(options.limits ?? {}) };
  const meta = metaOf(plan, options);
  const diagnostics = [];
  let evaluated = 0;
  const { entries } = walk(plan, values, (parameter, path, scope, root) => {
    evaluated += 1;
    const record = evaluateVisibility(parameter.visibility, scope, root, meta);
    if (record.reason === 'malformed') diagnostics.push({ code: 'MALFORMED_RULE', id: parameter.id, path, key: record.key ?? null });
    return record;
  }, limits);
  return summarise(plan, entries, diagnostics, { evaluated, reused: 0 });
}

/* ------------------------------------------------------------------ incremental session */

function setPath(object, path, value) {
  const segments = splitPath(path);
  let current = object;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const segment = segments[i];
    if (current[segment] === null || typeof current[segment] !== 'object') current[segment] = typeof segments[i + 1] === 'number' ? [] : {};
    current = current[segment];
  }
  if (value === undefined) delete current[segments.at(-1)];
  else current[segments.at(-1)] = value;
}

const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

/**
 * Incremental resolution over one plan. Owns a private copy of the values. `set`
 * accepts a concrete lodash path (`options.timeout`, `headers.parameter[0].name`);
 * `undefined` removes the value. Returns { changed, evaluated, reused, mode,
 * invalidated } with mode `in-place` | `structural` | `wide`.
 *
 * Two paths, both exact:
 *   - IN PLACE (the common case): the set of instances cannot change, so one pass over
 *     the existing instances re-evaluates only variants whose dependencies touch the
 *     changed path, or whose parent visibility changed; everything else is reused.
 *   - STRUCTURAL: the change is at or above a multiple-valued collection array (an
 *     element added, removed or replaced wholesale), so instances are re-walked; still
 *     only affected variants are re-evaluated.
 *   - WIDE: more than half of the variants are affected (typically `resource`), so the
 *     same re-walk is used because it is cheaper than the in-place pass.
 */
export class ResolutionSession {
  constructor(plan, values = {}, options = {}) {
    this.plan = plan;
    this.limits = { ...GRAPH_LIMITS, ...(options.limits ?? {}) };
    this.meta = metaOf(plan, options);
    this.graph = buildDependencyGraph(plan);
    this.adjacency = adjacencyOf(this.graph);
    this.values = clone(values && typeof values === 'object' ? values : {});
    this.byId = new Map(plan.parameters.map((parameter) => [parameter.id, parameter]));
    // dependency path -> ids reading it; array paths whose element count shapes instances
    this.readers = new Map();
    for (const parameter of plan.parameters) {
      for (const dependency of parameter.dependsOn) {
        if (!this.readers.has(dependency)) this.readers.set(dependency, []);
        this.readers.get(dependency).push(parameter.id);
      }
    }
    const withChildren = new Set(plan.parameters.map((parameter) => parameter.parentId).filter(Boolean));
    this.arrayPaths = [];
    for (const parameter of plan.parameters) {
      if (!parameter.multipleValues || !withChildren.has(parameter.id)) continue;
      if (parameter.kind === 'collection') this.arrayPaths.push(parameter.path);
      if (parameter.kind === 'fixedCollection') {
        for (const kid of plan.parameters) {
          if (kid.parentId === parameter.id) this.arrayPaths.push(kid.path.slice(0, kid.path.length - kid.name.length - 3));
        }
      }
    }
    this.arrayPaths = [...new Set(this.arrayPaths)];
    this.#full(null);
  }

  get resolution() {
    return summarise(this.plan, this.entries, this.diagnostics, this.counters);
  }

  #evaluate(parameter, scope, root, path, diagnostics) {
    const record = evaluateVisibility(parameter.visibility, scope, root, this.meta);
    if (record.reason === 'malformed') diagnostics.push({ code: 'MALFORMED_RULE', id: parameter.id, path, key: record.key ?? null });
    return record;
  }

  #full(affected) {
    const previous = affected && new Map(this.entries.map((entry) => [`${entry.id}@${entry.path}`, entry]));
    const diagnostics = [];
    let evaluated = 0;
    let reused = 0;
    const walked = walk(this.plan, this.values, (parameter, path, scope, root) => {
      const before = previous?.get(`${parameter.id}@${path}`);
      if (before && !affected.has(parameter.id) && before.reason !== 'parent-hidden' && before.reason !== 'malformed') {
        reused += 1;
        return { visible: before.visible, reason: before.reason, key: before.key };
      }
      evaluated += 1;
      return this.#evaluate(parameter, scope, root, path, diagnostics);
    }, this.limits);
    this.entries = walked.entries;
    this.scopes = walked.scopes;
    this.parents = walked.parents;
    this.diagnostics = diagnostics;
    this.counters = { evaluated, reused };
    return previous;
  }

  set(path, value) {
    if (typeof path !== 'string' || path === '' || path.startsWith('/') || path.startsWith('@')) {
      throw new ParameterPlanError('INVALID_PATH', `set() needs a concrete parameter path (got ${JSON.stringify(path)})`);
    }
    const segments = splitPath(path);
    if (segments.length === 0 || segments.length > this.limits.maxPathSegments) {
      throw new ParameterPlanError('INVALID_PATH', `set() path has ${segments.length} segments (1..${this.limits.maxPathSegments})`);
    }
    setPath(this.values, path, clone(value));
    const template = templateOf(path);
    const affected = new Set();
    for (const [dependency, ids] of this.readers) if (related(dependency, template)) for (const id of ids) affected.add(id);
    const structural = this.arrayPaths.some((array) => related(array, template) && !template.startsWith(`${array}[].`));
    // Adaptive: when most variants are affected (a `resource` edit), one fresh walk is
    // cheaper than the in-place pass; both produce the identical resolution.
    const wide = affected.size * 2 > this.byId.size;
    const changed = [];

    if (structural || wide) {
      const previous = this.#full(affected);
      const now = new Set();
      for (const entry of this.entries) {
        const key = `${entry.id}@${entry.path}`;
        now.add(key);
        const before = previous.get(key);
        if (!before || before.visible !== entry.visible) changed.push(key);
      }
      for (const key of previous.keys()) if (!now.has(key)) changed.push(key);
    } else {
      const diagnostics = [];
      let evaluated = 0;
      let reused = 0;
      const root = this.values;
      for (let i = 0; i < this.entries.length; i += 1) {
        const entry = this.entries[i];
        const parameter = this.byId.get(entry.id);
        const parentIndex = this.parents[i];
        const parentHidden = parentIndex >= 0 && !this.entries[parentIndex].visible;
        const scopePath = this.scopes[i];
        const touchesPresence = related(entry.slot, template);
        let scope;
        const scopeOf = () => {
          if (scope === undefined) {
            const raw = scopePath === '' ? root : getPath(root, scopePath);
            scope = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
          }
          return scope;
        };
        let record;
        if (parentHidden) {
          record = { visible: false, reason: 'parent-hidden' };
        } else if (affected.has(entry.id) || entry.reason === 'parent-hidden' || entry.reason === 'malformed') {
          evaluated += 1;
          record = this.#evaluate(parameter, scopeOf(), root, entry.path, diagnostics);
        } else {
          reused += 1;
          record = null;
        }
        const present = touchesPresence ? Object.prototype.hasOwnProperty.call(scopeOf(), parameter.name) : entry.present;
        if (record === null && present === entry.present) continue;
        const next = record === null
          ? { ...entry, present }
          : { ...entry, visible: record.visible, reason: record.reason, key: record.key ?? null, present };
        if (next.visible !== entry.visible) changed.push(`${entry.id}@${entry.path}`);
        this.entries[i] = next;
      }
      // Every instance that can be malformed now was re-evaluated in this pass (previously
      // malformed, affected, or newly un-hidden), so the fresh list is complete.
      this.diagnostics = diagnostics;
      this.counters = { evaluated, reused };
    }
    return { changed: changed.sort(), evaluated: this.counters.evaluated, reused: this.counters.reused, mode: structural ? 'structural' : wide ? 'wide' : 'in-place', invalidated: dependentsOf(this.graph, path, this.adjacency) };
  }
}
