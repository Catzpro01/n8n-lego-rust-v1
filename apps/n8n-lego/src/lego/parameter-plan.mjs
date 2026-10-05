/**
 * Parameter Contract & Compiler (P7-S01, Issue #223 §4-6, §31, §37-38; DEC-0024).
 *
 * Stage 2 (COMPILE) of the five-stage P7 pipeline:
 *
 *   DECLARE  canonical n8n node definition (`properties`, unchanged n8n vocabulary)
 *   COMPILE  -> immutable ParameterPlan                           <- this module
 *   RESOLVE  visibility / dependency graph / incremental recompute  (P7-S02)
 *   DISCOVER provider-backed options / resource lookup              (P7-S04/S05)
 *   VALIDATE normalization, validation, execution snapshot          (P7-S03)
 *
 * A ParameterPlan is a compact, deep-frozen, JSON-serialisable description of one
 * (nodeType, typeVersion) parameter surface. It is DERIVED and DISPOSABLE: it is
 * reconstructible byte-for-byte from the canonical definition, so it is never an
 * authority and never persisted as one (#223 §5).
 *
 * STABLE IDENTITY (#223 §6). Every parameter has
 *   - `path`: its canonical logical value slot, exactly where n8n stores the value
 *     (`resource`, `options.timeout`, `headers.parameter[].name`). The catalog
 *     declares one slot several times (5,450 duplicate top-level names in
 *     n8n-nodes-base 2.9.1), each variant selected by displayOptions; all
 *     variants of a slot share its value, as in n8n.
 *   - `id`: `path#<variant>`, where the variant is a SHA-256 prefix of the
 *     variant's own declaration (type + displayOptions). Array position never
 *     becomes identity: reordering properties keeps every id.
 *
 * VERSIONING (#223 §31). The plan records the node type version, a definition
 * fingerprint (SHA-256 of the canonical declaration), the parameter schema
 * version and the plan format version. `@version` and `@tool` are fixed for one
 * plan, so a variant that can never be visible is pruned at compile time, but only
 * on the provably static prefix of n8n's key-ordered walk: `show` returns visible as
 * soon as a key holds an expression, so a failing static key prunes only when no
 * dynamic key precedes it, and `hide` prunes only when every `show` key is static
 * (see `versionAllows`). Every other condition is left to the RESOLVE stage and is
 * recorded, not evaluated.
 *
 * COMPATIBILITY (#223 §3, §32). The n8n vocabulary is preserved as declared:
 * string, number, boolean, options, multiOptions, collection, fixedCollection,
 * resourceLocator, resourceMapper, displayOptions, typeOptions, required,
 * default, placeholder, loadOptionsMethod, searchListMethod. A type this module
 * does not know is kept as kind `opaque` with a diagnostic; it is never dropped.
 *
 * HOUSE RULES:
 *   - NO I/O, NO NETWORK, NO CLOCK. Pure functions over plain data. Only DISCOVER
 *     may cross a provider boundary, and this module never does.
 *   - BOUNDED (#223 §38). Declared limits for parameters, depth, options and
 *     default size; over-limit REFUSES with a typed error, never truncates.
 *   - NO MODULE STATE. The compile cache is an instance (ParameterPlanCompiler)
 *     owned by its caller, bounded (LRU) and observable.
 *
 * One error family: `ParameterPlanError` (namespace `dynamic-parameters`).
 */
import { createHash } from 'node:crypto';

export const PLAN_FORMAT = 'n8n-lego.parameter-plan';
export const PLAN_FORMAT_VERSION = 1;
/** Version of the parameter-schema interpretation implemented here (#223 §31). */
export const PARAMETER_SCHEMA_VERSION = '1.0.0';

export const PLAN_LIMITS = Object.freeze({
  maxParameters: 4096, // largest catalog node (notion) compiles to 932 declarations
  maxDepth: 16, // catalog maximum nesting is 8
  maxOptionsPerParameter: 4096,
  maxDefaultBytes: 65536,
  maxDefinitionBytes: 8 * 1024 * 1024,
  maxCacheEntries: 512,
});

/** n8n property types known to this compiler, mapped to a plan kind. */
export const KIND_BY_TYPE = Object.freeze({
  string: 'scalar',
  number: 'scalar',
  boolean: 'scalar',
  dateTime: 'scalar',
  color: 'scalar',
  json: 'scalar',
  hidden: 'scalar',
  options: 'choice',
  multiOptions: 'choice',
  collection: 'collection',
  fixedCollection: 'fixedCollection',
  resourceLocator: 'resourceLocator',
  resourceMapper: 'resourceMapper',
  assignmentCollection: 'structured',
  filter: 'structured',
  workflowSelector: 'structured',
  credentials: 'credential',
  credentialsSelect: 'credential',
  notice: 'display',
  button: 'display',
  callout: 'display',
  curlImport: 'display',
});

/** Kinds that hold no value slot of their own (UI-only declarations). */
const DISPLAY_KINDS = new Set(['display']);
/** displayOptions keys that are node metadata, not parameter paths. */
const META_KEYS = new Set(['@version', '@tool', '@feature']);
const CND_OPERATORS = new Set(['eq', 'not', 'gte', 'lte', 'gt', 'lt', 'between', 'includes', 'startsWith', 'endsWith', 'regex', 'exists']);

export class ParameterPlanError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ParameterPlanError';
    this.namespace = 'dynamic-parameters';
    this.code = code;
    this.details = details;
  }
}

/* ------------------------------------------------------------------ canonical JSON + hashing */

/** Deterministic JSON: object keys sorted, undefined dropped (as JSON.stringify). */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((item) => (item === undefined ? 'null' : canonicalJson(item))).join(',')}]`;
  const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

const clonePlain = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

/* ------------------------------------------------------------------ display conditions */

/** Structural equality with lodash `isEqual` semantics for JSON values (n8n `eq` / `not`). */
export function isDeepEqual(a, b) {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') return Number.isNaN(a) && Number.isNaN(b);
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((item, index) => isDeepEqual(item, b[index]));
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => Object.prototype.hasOwnProperty.call(b, key) && isDeepEqual(a[key], b[key]));
}

/**
 * Port of n8n `checkConditions` (workflow/src/node-helpers.ts, pinned 2.9.1): does any
 * declared condition match the actual values? A `{ _cnd: { op: target } }` condition
 * must hold for EVERY actual value; with no actual values only `not` holds. A literal
 * condition matches by strict inclusion.
 */
export function checkConditions(conditions, actualValues) {
  return conditions.some((condition) => {
    if (condition && typeof condition === 'object' && condition._cnd && Object.keys(condition).length === 1) {
      const entries = Object.entries(condition._cnd);
      if (entries.length !== 1) throw new ParameterPlanError('INVALID_CONDITION', `a _cnd condition has exactly one operator (got ${entries.length})`);
      const [operator, target] = entries[0];
      if (!CND_OPERATORS.has(operator)) throw new ParameterPlanError('UNSUPPORTED_CONDITION', `unsupported _cnd operator "${operator}"`, { operator });
      if (actualValues.length === 0) return operator === 'not';
      return actualValues.every((value) => evaluateCondition({ [operator]: target }, value));
    }
    return actualValues.includes(condition);
  });
}

/**
 * One `_cnd` operator against one value, as n8n evaluates it. String operators on a
 * non-string value are false here; upstream would throw a TypeError on such
 * malformed data (recorded divergence, never reachable from a valid catalog value).
 */
export function evaluateCondition(condition, actual) {
  const entries = Object.entries(condition ?? {});
  if (entries.length !== 1) throw new ParameterPlanError('INVALID_CONDITION', `a _cnd condition has exactly one operator (got ${entries.length})`);
  const [operator, expected] = entries[0];
  if (!CND_OPERATORS.has(operator)) throw new ParameterPlanError('UNSUPPORTED_CONDITION', `unsupported _cnd operator "${operator}"`, { operator });
  switch (operator) {
    case 'eq': return isDeepEqual(actual, expected);
    case 'not': return !isDeepEqual(actual, expected);
    case 'gte': return actual >= expected;
    case 'lte': return actual <= expected;
    case 'gt': return actual > expected;
    case 'lt': return actual < expected;
    case 'between': return actual >= expected?.from && actual <= expected?.to;
    case 'includes': return typeof actual === 'string' && actual.includes(expected);
    case 'startsWith': return typeof actual === 'string' && actual.startsWith(expected);
    case 'endsWith': return typeof actual === 'string' && actual.endsWith(expected);
    case 'regex': return typeof actual === 'string' && new RegExp(expected).test(actual);
    case 'exists': return actual !== null && actual !== undefined && actual !== '';
    default: return false;
  }
}

/** Keys whose value is fixed for one (nodeType, typeVersion) plan and never an expression. */
const STATIC_META_KEYS = new Set(['@version', '@tool']);

function staticMetaValues(key, typeVersion, nodeName) {
  if (key === '@version') return [typeVersion || 0];
  return [String(nodeName ?? '').endsWith('Tool')];
}

/**
 * Compile-time visibility decision. Returns false only when the variant can NEVER be
 * visible for this plan; true means "not ruled out" (decided at RESOLVE, P7-S02).
 *
 * n8n walks `show` in key order and returns VISIBLE as soon as a key's value is an
 * expression, before later keys are checked; `hide` is only walked when `show`
 * completes. So pruning is sound only on the static prefix:
 *   - show: a failing `@version` / `@tool` key prunes only when every key before it is
 *     also static (no earlier key can short-circuit to visible);
 *   - hide: a matching static key prunes only when every `show` key is static and
 *     passed (so the `hide` walk is certainly reached).
 */
export function versionAllows(displayOptions, typeVersion, nodeName = '') {
  const show = displayOptions?.show ?? {};
  let showFullyStatic = true;
  for (const key of Object.keys(show)) {
    if (!STATIC_META_KEYS.has(key)) {
      showFullyStatic = false;
      break;
    }
    const declared = Array.isArray(show[key]) ? show[key] : [show[key]];
    if (!checkConditions(declared, staticMetaValues(key, typeVersion, nodeName))) return false;
  }
  if (!showFullyStatic) return true;
  const hide = displayOptions?.hide ?? {};
  for (const key of Object.keys(hide)) {
    if (!STATIC_META_KEYS.has(key)) continue;
    const declared = Array.isArray(hide[key]) ? hide[key] : [hide[key]];
    if (checkConditions(declared, staticMetaValues(key, typeVersion, nodeName))) return false;
  }
  return true;
}

/* ------------------------------------------------------------------ versions */

/** Declared type versions of a node description, ascending. */
export function nodeVersions(description) {
  const declared = Array.isArray(description?.version) ? description.version : [description?.version ?? 1];
  const versions = declared.filter((version) => typeof version === 'number' && Number.isFinite(version));
  if (versions.length === 0) throw new ParameterPlanError('INVALID_VERSION', `node ${description?.name ?? '?'} declares no numeric version`);
  return [...new Set(versions)].sort((a, b) => a - b);
}

/* ------------------------------------------------------------------ compiler */

function dependencyOf(key, valueScope) {
  if (META_KEYS.has(key)) return { meta: key };
  if (key.startsWith('/')) return { path: key.slice(1) };
  return { path: valueScope ? `${valueScope}.${key}` : key };
}

function extractValidation(property) {
  const options = property.typeOptions ?? {};
  const rules = {};
  for (const key of ['minValue', 'maxValue', 'numberPrecision', 'maxLength', 'regex', 'minRequiredFields', 'multipleValues', 'password', 'dateOnly', 'email']) {
    if (options[key] !== undefined) rules[key] = options[key];
  }
  if (property.validateType !== undefined) rules.validateType = property.validateType;
  if (property.required === true) rules.required = true;
  if (property.noDataExpression === true || options.noDataExpression === true) rules.noDataExpression = true;
  if (property.ignoreValidationDuringExecution === true) rules.ignoreValidationDuringExecution = true;
  return rules;
}

function extractDynamic(property) {
  const options = property.typeOptions ?? {};
  const dynamic = {};
  if (typeof options.loadOptionsMethod === 'string') dynamic.loadOptionsMethod = options.loadOptionsMethod;
  if (options.loadOptions !== undefined) dynamic.declarativeLoadOptions = true;
  if (Array.isArray(options.loadOptionsDependsOn)) dynamic.loadOptionsDependsOn = [...options.loadOptionsDependsOn];
  if (options.resourceMapper?.resourceMapperMethod) dynamic.resourceMapperMethod = options.resourceMapper.resourceMapperMethod;
  if (options.resourceMapper?.localResourceMapperMethod) dynamic.localResourceMapperMethod = options.resourceMapper.localResourceMapperMethod;
  const searchListMethods = [];
  for (const mode of property.modes ?? []) {
    const method = mode?.typeOptions?.searchListMethod;
    if (typeof method === 'string') searchListMethods.push(method);
  }
  if (searchListMethods.length) dynamic.searchListMethods = searchListMethods;
  return Object.keys(dynamic).length ? dynamic : null;
}

function extractModes(property) {
  if (!Array.isArray(property.modes)) return null;
  return property.modes.map((mode) => {
    const entry = { name: mode.name, type: mode.type ?? null };
    if (mode.typeOptions?.searchListMethod) entry.searchListMethod = mode.typeOptions.searchListMethod;
    if (mode.typeOptions?.searchable) entry.searchable = true;
    if (Array.isArray(mode.validation)) entry.validation = clonePlain(mode.validation);
    if (mode.extractValue) entry.extractValue = clonePlain(mode.extractValue);
    return entry;
  });
}

/**
 * Compile one node description at one typeVersion into an immutable ParameterPlan.
 * @param {object} description n8n INodeTypeDescription (as in the catalog nodes.json)
 * @param {{ typeVersion?: number, limits?: object }} [options]
 */
export function compileParameterPlan(description, options = {}) {
  if (!description || typeof description !== 'object') throw new ParameterPlanError('INVALID_DEFINITION', 'a node description object is required');
  if (typeof description.name !== 'string' || description.name === '') throw new ParameterPlanError('INVALID_DEFINITION', 'the node description has no name');
  if (description.properties !== undefined && !Array.isArray(description.properties)) throw new ParameterPlanError('INVALID_DEFINITION', `${description.name}: properties must be an array`);
  const limits = { ...PLAN_LIMITS, ...(options.limits ?? {}) };
  const versions = nodeVersions(description);
  const typeVersion = options.typeVersion ?? versions.at(-1);
  if (!versions.includes(typeVersion)) throw new ParameterPlanError('UNKNOWN_VERSION', `${description.name} has no typeVersion ${typeVersion} (declared ${versions.join(', ')})`, { versions });

  const properties = description.properties ?? [];
  const definitionJson = canonicalJson(properties);
  if (definitionJson.length > limits.maxDefinitionBytes) throw new ParameterPlanError('LIMIT_EXCEEDED', `${description.name}: definition exceeds ${limits.maxDefinitionBytes} bytes`, { limit: 'maxDefinitionBytes' });
  const definitionFingerprint = sha256(definitionJson);

  const parameters = [];
  const diagnostics = [];
  const slots = new Map();
  const variantIds = new Map(); // id -> canonical declaration that owns it
  let declarations = 0;
  let pruned = 0;
  let maxDepth = 0;

  const visit = (list, context) => {
    if (context.depth > limits.maxDepth) throw new ParameterPlanError('LIMIT_EXCEEDED', `${description.name}: nesting deeper than ${limits.maxDepth} at ${context.valueScope || '(root)'}`, { limit: 'maxDepth' });
    maxDepth = Math.max(maxDepth, context.depth);
    for (const property of list) {
      declarations += 1;
      if (declarations > limits.maxParameters) throw new ParameterPlanError('LIMIT_EXCEEDED', `${description.name}: more than ${limits.maxParameters} parameter declarations`, { limit: 'maxParameters' });
      if (!property || typeof property !== 'object' || typeof property.name !== 'string' || property.name === '') {
        throw new ParameterPlanError('INVALID_DEFINITION', `${description.name}: a parameter at ${context.valueScope || '(root)'} has no name`);
      }
      if (!versionAllows(property.displayOptions, typeVersion, description.name)) {
        pruned += 1;
        continue;
      }
      const path = context.valueScope ? `${context.valueScope}.${property.name}` : property.name;
      const known = Object.prototype.hasOwnProperty.call(KIND_BY_TYPE, property.type);
      const kind = known ? KIND_BY_TYPE[property.type] : 'opaque';
      if (!known) diagnostics.push({ code: 'UNKNOWN_TYPE', path, type: String(property.type) });

      // The variant is its own declaration inside its parent variant: the same child declared
      // under two variants of one collection is two declarations of one value slot.
      const variantHash = sha256(canonicalJson({ type: property.type, displayOptions: property.displayOptions ?? null, parent: context.parentId })).slice(0, 12);
      const declarationJson = canonicalJson(property);
      const assign = (candidate) => {
        if (!variantIds.has(candidate)) return candidate;
        if (variantIds.get(candidate) !== declarationJson) return null;
        // Byte-identical repeat: kept (never dropped); only among indistinguishable twins
        // does occurrence order name the copy.
        let occurrence = 2;
        while (variantIds.has(`${candidate}~${occurrence}`)) occurrence += 1;
        diagnostics.push({ code: 'IDENTICAL_DECLARATION', path, id: `${candidate}~${occurrence}` });
        return `${candidate}~${occurrence}`;
      };
      // Same type, displayOptions and parent but a different declaration: name it by the full
      // declaration, which is still independent of array position.
      const id = assign(`${path}#${variantHash}`)
        ?? assign(`${path}#${sha256(canonicalJson({ property, parent: context.parentId })).slice(0, 12)}`);
      if (id === null) throw new ParameterPlanError('IDENTITY_COLLISION', `${description.name}: cannot derive a unique id for ${path}`);
      variantIds.set(id, declarationJson);

      if (property.default !== undefined) {
        const bytes = canonicalJson(property.default).length;
        if (bytes > limits.maxDefaultBytes) throw new ParameterPlanError('LIMIT_EXCEEDED', `${description.name}: default of ${path} exceeds ${limits.maxDefaultBytes} bytes`, { limit: 'maxDefaultBytes' });
      }
      if (Array.isArray(property.options) && property.options.length > limits.maxOptionsPerParameter) {
        throw new ParameterPlanError('LIMIT_EXCEEDED', `${description.name}: ${path} declares more than ${limits.maxOptionsPerParameter} options`, { limit: 'maxOptionsPerParameter' });
      }

      const dependsOn = [];
      const metaDependsOn = [];
      for (const branch of ['show', 'hide']) {
        for (const key of Object.keys(property.displayOptions?.[branch] ?? {})) {
          const dependency = dependencyOf(key, context.valueScope);
          if (dependency.meta) metaDependsOn.push(dependency.meta);
          else dependsOn.push(dependency.path);
        }
      }
      const dynamic = extractDynamic(property);
      // loadOptionsDependsOn paths are ROOT-relative in n8n; only a leading `&` names a
      // sibling in the same scope (workflow/src/node-parameters/path-utils.ts resolveRelativePath).
      for (const key of dynamic?.loadOptionsDependsOn ?? []) {
        if (typeof key !== 'string' || key === '') continue;
        dependsOn.push(key.startsWith('&') ? (context.valueScope ? `${context.valueScope}.${key.slice(1)}` : key.slice(1)) : key);
      }

      const entry = {
        id,
        path,
        name: property.name,
        displayName: property.displayName ?? property.name,
        type: property.type,
        kind,
        container: context.container,
        parentPath: context.parentPath,
        parentId: context.parentId,
        valueSlot: !DISPLAY_KINDS.has(kind),
        multipleValues: property.typeOptions?.multipleValues === true,
        default: clonePlain(property.default),
        visibility: property.displayOptions ? clonePlain(property.displayOptions) : null,
        dependsOn: [...new Set(dependsOn)].sort(),
        metaDependsOn: [...new Set(metaDependsOn)].sort(),
        validation: extractValidation(property),
        dynamic,
        resourceLocatorModes: extractModes(property),
        choices: kind === 'choice' && Array.isArray(property.options)
          ? property.options.filter((option) => option && typeof option === 'object' && 'value' in option).map((option) => option.value)
          : null,
        sensitive: property.typeOptions?.password === true,
        capability: dynamic ? { discover: true, network: true } : { discover: false, network: false },
        cachePolicy: dynamic ? 'dynamic' : 'static',
        declarationOrder: declarations - 1,
      };
      parameters.push(entry);
      if (entry.valueSlot) {
        if (!slots.has(path)) slots.set(path, []);
        slots.get(path).push(id);
      }

      // Children: collection options are property declarations under this slot;
      // fixedCollection options are groups whose `values` are declarations under slot.group.
      if (kind === 'collection' && Array.isArray(property.options)) {
        const children = property.options.filter((option) => option && typeof option === 'object' && typeof option.type === 'string');
        const scope = entry.multipleValues ? `${path}[]` : path;
        visit(children, { depth: context.depth + 1, valueScope: scope, parentPath: path, parentId: id, container: 'collection' });
      } else if (kind === 'fixedCollection' && Array.isArray(property.options)) {
        for (const group of property.options) {
          if (!group || typeof group !== 'object' || typeof group.name !== 'string' || !Array.isArray(group.values)) continue;
          const groupPath = `${path}.${group.name}`;
          const scope = entry.multipleValues ? `${groupPath}[]` : groupPath;
          visit(group.values, { depth: context.depth + 1, valueScope: scope, parentPath: path, parentId: id, container: 'fixedCollection' });
        }
      }
    }
  };
  visit(properties, { depth: 0, valueScope: '', parentPath: null, parentId: null, container: 'root' });

  const dependencyEdges = [];
  for (const parameter of parameters) for (const from of parameter.dependsOn) dependencyEdges.push([from, parameter.path]);
  dependencyEdges.sort((a, b) => (a[0] + '\0' + a[1]).localeCompare(b[0] + '\0' + b[1]));
  const uniqueEdges = dependencyEdges.filter((edge, index) => index === 0 || edge[0] !== dependencyEdges[index - 1][0] || edge[1] !== dependencyEdges[index - 1][1]);

  const body = {
    format: PLAN_FORMAT,
    planFormatVersion: PLAN_FORMAT_VERSION,
    schemaVersion: PARAMETER_SCHEMA_VERSION,
    nodeType: description.name,
    typeVersion,
    versions,
    definitionFingerprint,
    parameters,
    slots: Object.fromEntries([...slots.entries()].sort(([a], [b]) => a.localeCompare(b))),
    dependencyEdges: uniqueEdges,
    dynamicParameters: parameters.filter((parameter) => parameter.dynamic).map((parameter) => parameter.id),
    sensitiveParameters: parameters.filter((parameter) => parameter.sensitive).map((parameter) => parameter.id),
    credentials: (description.credentials ?? []).map((credential) => ({
      name: credential.name,
      required: credential.required === true,
      visibility: credential.displayOptions ? clonePlain(credential.displayOptions) : null,
    })),
    diagnostics,
    stats: {
      declarations,
      compiled: parameters.length,
      prunedByVersion: pruned,
      slots: slots.size,
      dynamic: parameters.filter((parameter) => parameter.dynamic).length,
      maxDepth,
    },
  };
  body.planFingerprint = sha256(canonicalJson(body));
  return deepFreeze(body);
}

/* ------------------------------------------------------------------ plan queries */

/** All variants (declarations) of one value slot, in declaration order. */
export function slotVariants(plan, path) {
  const ids = new Set(plan.slots[path] ?? []);
  return plan.parameters.filter((parameter) => ids.has(parameter.id));
}

export function parameterById(plan, id) {
  return plan.parameters.find((parameter) => parameter.id === id) ?? null;
}

/* ------------------------------------------------------------------ compile-once cache */

/**
 * Compile-once cache (#223 §37): plans are keyed by node type, type version and
 * definition fingerprint, so a changed definition is a different key and a stale
 * plan is never served. Bounded LRU; the instance is owned by its caller.
 */
export class ParameterPlanCompiler {
  constructor({ maxEntries = PLAN_LIMITS.maxCacheEntries, limits } = {}) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > PLAN_LIMITS.maxCacheEntries) {
      throw new ParameterPlanError('INVALID_BUDGET', `maxEntries must be an integer in 1..${PLAN_LIMITS.maxCacheEntries}`);
    }
    this.maxEntries = maxEntries;
    this.limits = limits;
    this.entries = new Map();
    this.counters = { hits: 0, misses: 0, evictions: 0 };
    this.fingerprints = new WeakMap();
  }

  #definitionFingerprint(description) {
    let fingerprint = this.fingerprints.get(description);
    if (!fingerprint) {
      fingerprint = sha256(canonicalJson(description.properties ?? []));
      this.fingerprints.set(description, fingerprint);
    }
    return fingerprint;
  }

  plan(description, typeVersion) {
    const version = typeVersion ?? nodeVersions(description).at(-1);
    const key = `${description?.name}@${version}#${this.#definitionFingerprint(description)}`;
    const cached = this.entries.get(key);
    if (cached) {
      this.counters.hits += 1;
      this.entries.delete(key);
      this.entries.set(key, cached);
      return cached;
    }
    this.counters.misses += 1;
    const plan = compileParameterPlan(description, { typeVersion: version, limits: this.limits });
    this.entries.set(key, plan);
    while (this.entries.size > this.maxEntries) {
      this.entries.delete(this.entries.keys().next().value);
      this.counters.evictions += 1;
    }
    return plan;
  }

  stats() {
    return { entries: this.entries.size, maxEntries: this.maxEntries, ...this.counters };
  }

  clear() {
    this.entries.clear();
  }
}
