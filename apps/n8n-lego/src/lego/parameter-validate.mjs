/**
 * P7-S03 — Local Validation & Normalization (#223 stage 5 VALIDATE, §20-21, §27, §29-30).
 *
 * The last *local* stage of the five-stage pipeline. It consumes a compiled
 * ParameterPlan plus raw parameter values and performs a cheap, deterministic,
 * pure local operation: it normalizes each value to its canonical form, validates
 * it against the compact canonical vocabulary, and produces a compact immutable
 * execution-ready snapshot. It never crosses a provider/network boundary and never
 * treats a cached UI value as authority.
 *
 * Hard rules honoured here:
 *  - §20  compact validation vocabulary; structured errors carry path + code +
 *         expected/actual class and never secret material;
 *  - §21  normalization is explicit and testable and never changes observable n8n
 *         behavior (only the two safe canonicalizations: numeric-string -> number,
 *         'true'/'false' -> boolean);
 *  - §27  a closed failure vocabulary; a validation failure is never converted into
 *         a fake empty success;
 *  - §29  a compact immutable snapshot (schema version, normalized values,
 *         unresolved expression refs, validation status, dependency digest);
 *  - §30  the snapshot is DERIVED (execution input), never the canonical workflow
 *         definition, and is always reconstructible from the plan + values.
 */
import { createHash } from 'node:crypto';
import { canonicalJson, PARAMETER_SCHEMA_VERSION } from './parameter-plan.mjs';

export const VALIDATION_FORMAT = 'n8n-lego.parameter-validation';
export const VALIDATION_FORMAT_VERSION = 1;
export const SNAPSHOT_FORMAT = 'n8n-lego.execution-snapshot';
export const SNAPSHOT_FORMAT_VERSION = 1;

/**
 * §27 — the closed failure vocabulary. Only the two local-stage codes can be
 * produced by this module; the provider/network codes are defined for the
 * downstream stages (P7-S04+) so the set is complete and stable.
 */
export const FAILURE_CODES = Object.freeze({
  UNAVAILABLE: 'UNAVAILABLE',
  TIMEOUT: 'TIMEOUT',
  RATE_LIMITED: 'RATE_LIMITED',
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  AUTH_REJECTED: 'AUTH_REJECTED',
  INVALID_PROVIDER_DATA: 'INVALID_PROVIDER_DATA',
  SCHEMA_INVALID: 'SCHEMA_INVALID',
  DEPENDENCY_INVALID: 'DEPENDENCY_INVALID',
  STALE_REQUEST: 'STALE_REQUEST',
  CANCELLED: 'CANCELLED',
  VERSION_INCOMPATIBLE: 'VERSION_INCOMPATIBLE',
});

/** The codes this local stage can actually emit. */
export const LOCAL_FAILURE_CODES = Object.freeze(['SCHEMA_INVALID', 'DEPENDENCY_INVALID']);

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value;
  Object.freeze(value);
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return value;
}

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Human class name of a value, used in structured errors. Never carries the value itself. */
function actualClass(value) {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/** An n8n expression reference: a string whose first character is `=`. */
export const isExpression = (value) => typeof value === 'string' && value.length > 0 && value.charCodeAt(0) === 61;

/* ------------------------------------------------------------------ §21 normalization */

const NUMBER_LITERAL = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

function isNumericString(text) {
  const trimmed = text.trim();
  return trimmed !== '' && NUMBER_LITERAL.test(trimmed) && Number.isFinite(Number(trimmed));
}

/**
 * §21 — normalize one raw value to its canonical form for a given n8n type.
 * Returns `{ canonical, changed }`. This is a pure function: it never throws on a
 * type mismatch (that is the validator's job) and it only performs the two safe,
 * compatible canonicalizations — a finite numeric string becomes a number and the
 * exact strings 'true'/'false' become booleans. Every other value passes through
 * unchanged, so observable n8n behavior is preserved.
 */
export function normalizeValue(type, value, options = {}) {
  if (value === undefined || value === null) return { canonical: value, changed: false };
  switch (type) {
    case 'number': {
      if (typeof value === 'number') return { canonical: value, changed: false };
      if (typeof value === 'string' && isNumericString(value)) {
        return { canonical: Number(value.trim()), changed: true };
      }
      return { canonical: value, changed: false };
    }
    case 'boolean': {
      if (typeof value === 'boolean') return { canonical: value, changed: false };
      if (value === 'true') return { canonical: true, changed: true };
      if (value === 'false') return { canonical: false, changed: true };
      return { canonical: value, changed: false };
    }
    default:
      return { canonical: value, changed: false };
  }
}

/* ------------------------------------------------------------------ §20 validation */

/**
 * The compact canonical vocabulary (§20): a predicate per n8n type deciding whether
 * a (already normalized) value is of the right shape. `hidden` accepts anything by
 * design; `json` accepts a JSON string or a value.
 */
const TYPE_OK = {
  string: (v) => typeof v === 'string',
  color: (v) => typeof v === 'string',
  number: (v) => typeof v === 'number',
  boolean: (v) => typeof v === 'boolean',
  dateTime: (v) => typeof v === 'string' || typeof v === 'number',
  json: (v) => typeof v === 'string' || isPlainObject(v) || Array.isArray(v),
  hidden: () => true,
  options: (v) => typeof v === 'string',
  multiOptions: (v) => Array.isArray(v) && v.every((x) => typeof x === 'string'),
  collection: (v) => isPlainObject(v),
  fixedCollection: (v) => isPlainObject(v),
  resourceLocator: (v) => isPlainObject(v),
  resourceMapper: (v) => isPlainObject(v),
  assignmentCollection: (v) => Array.isArray(v),
  filter: (v) => isPlainObject(v),
  workflowSelector: (v) => typeof v === 'string' || isPlainObject(v),
  credentials: (v) => typeof v === 'string',
  credentialsSelect: (v) => typeof v === 'string',
};

const EMPTY_VALUES = new Set(['']);

function isEmpty(value) {
  return value === undefined || value === null || EMPTY_VALUES.has(value);
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function makeIssue(path, code, rule, expected, actual, message) {
  return deepFreeze({ path, code, rule, expected, actual, message });
}

/**
 * §20 — validate one (already normalized) value against a plan parameter's rules.
 * Returns `{ canonical, issues }` where `issues` is an array of structured errors,
 * each carrying `path`, `code` (a §27 failure code), `rule`, the `expected` class
 * and the `actual` class, and a `message`. Secret material never appears in an issue.
 */
export function validateValue(parameter, value, options = {}) {
  const type = parameter.type;
  const rules = parameter.validation ?? {};
  const path = parameter.path;
  const { canonical } = normalizeValue(type, value);
  const issues = [];

  // An absent value (undefined/null) is not itself a type error: the only thing that
  // can apply to it is `required`. A present value is checked against its type, and a
  // type error is terminal for the slot (further rule checks would be misleading).
  if (canonical !== undefined && canonical !== null) {
    const expectedOk = TYPE_OK[type] ?? (() => true);
    if (!expectedOk(canonical)) {
      issues.push(makeIssue(path, FAILURE_CODES.SCHEMA_INVALID, 'type', type, actualClass(canonical), `${path}: expected ${type}, got ${actualClass(canonical)}`));
      return { canonical, issues };
    }
  }

  // `ignoreValidationDuringExecution` (§20 via extractValidation): the value is kept
  // and normalized but the rule checks are skipped for execution.
  if (rules.ignoreValidationDuringExecution !== true) {
    if (rules.required === true && isEmpty(canonical)) {
      issues.push(makeIssue(path, FAILURE_CODES.SCHEMA_INVALID, 'required', `non-empty ${type}`, actualClass(canonical), `${path} is required`));
    } else if (!isEmpty(canonical)) {
      applyRules(issues, parameter, type, canonical, rules, path);
    }
  }

  return { canonical, issues };
}

function applyRules(issues, parameter, type, value, rules, path) {
  if (type === 'number' && typeof value === 'number') {
    if (rules.minValue !== undefined && value < rules.minValue) {
      issues.push(makeIssue(path, FAILURE_CODES.SCHEMA_INVALID, 'minValue', `>= ${rules.minValue}`, String(value), `${path}: ${value} < minValue ${rules.minValue}`));
    }
    if (rules.maxValue !== undefined && value > rules.maxValue) {
      issues.push(makeIssue(path, FAILURE_CODES.SCHEMA_INVALID, 'maxValue', `<= ${rules.maxValue}`, String(value), `${path}: ${value} > maxValue ${rules.maxValue}`));
    }
  }
  if (typeof value === 'string') {
    if (rules.maxLength !== undefined && value.length > rules.maxLength) {
      issues.push(makeIssue(path, FAILURE_CODES.SCHEMA_INVALID, 'maxLength', `<= ${rules.maxLength} chars`, `${value.length} chars`, `${path}: length ${value.length} > maxLength ${rules.maxLength}`));
    }
    if (rules.minLength !== undefined && value.length < rules.minLength) {
      issues.push(makeIssue(path, FAILURE_CODES.SCHEMA_INVALID, 'minLength', `>= ${rules.minLength} chars`, `${value.length} chars`, `${path}: length ${value.length} < minLength ${rules.minLength}`));
    }
    if (rules.regex !== undefined && rules.regex !== '') {
      let re;
      try {
        re = new RegExp(rules.regex);
      } catch {
        issues.push(makeIssue(path, FAILURE_CODES.DEPENDENCY_INVALID, 'regex', 'valid regex', 'malformed regex', `${path}: declared regex is malformed`));
      }
      if (re && !re.test(value)) {
        issues.push(makeIssue(path, FAILURE_CODES.SCHEMA_INVALID, 'regex', rules.regex, 'string', `${path}: value does not match ${rules.regex}`));
      }
    }
    if (rules.email === true && !EMAIL.test(value)) {
      issues.push(makeIssue(path, FAILURE_CODES.SCHEMA_INVALID, 'email', 'email address', 'string', `${path}: value is not a valid email`));
    }
  }
  // enum / choices (§20): a choice slot's value (or each member of a multiOptions)
  // must be one of the declared option values.
  if (Array.isArray(parameter.choices) && parameter.choices.length > 0) {
    const members = Array.isArray(value) ? value : [value];
    for (const member of members) {
      if (!parameter.choices.includes(member)) {
        issues.push(makeIssue(path, FAILURE_CODES.SCHEMA_INVALID, 'enum', `one of [${parameter.choices.join(', ')}]`, actualClass(member), `${path}: ${String(member)} is not a declared option`));
      }
    }
  }
  // object property rule: at least `minRequiredFields` of a collection must be set.
  if (rules.minRequiredFields !== undefined && isPlainObject(value)) {
    const present = Object.values(value).filter((v) => !isEmpty(v)).length;
    if (present < rules.minRequiredFields) {
      issues.push(makeIssue(path, FAILURE_CODES.SCHEMA_INVALID, 'minRequiredFields', `>= ${rules.minRequiredFields} set`, `${present} set`, `${path}: only ${present} of ${rules.minRequiredFields} required fields set`));
    }
  }
}

/* ------------------------------------------------------------------ §20/§27 full walk */

/**
 * Expand a value-slot template path into concrete instances. A `[]` segment means
 * "iterate the array at this key", producing one instance per element. A missing or
 * non-object intermediate yields a single `undefined` instance (the slot is absent).
 */
function instancesAt(values, templatePath) {
  const segments = templatePath === '' ? [] : templatePath.split('.');
  let current = [{ path: '', value: values }];
  for (const segment of segments) {
    const isArray = segment.endsWith('[]');
    const key = isArray ? segment.slice(0, -2) : segment;
    const next = [];
    for (const instance of current) {
      const object = instance.value;
      const childPath = instance.path === '' ? key : `${instance.path}.${key}`;
      if (!isPlainObject(object)) {
        next.push({ path: childPath, value: undefined });
        continue;
      }
      if (isArray) {
        if (Array.isArray(object[key])) {
          object[key].forEach((element, index) => next.push({ path: `${instance.path === '' ? key : instance.path + '.' + key}[${index}]`, value: element }));
        } else if (key in object) {
          next.push({ path: childPath, value: object[key] });
        } else {
          next.push({ path: childPath, value: undefined });
        }
      } else {
        next.push({ path: childPath, value: key in object ? object[key] : undefined });
      }
    }
    current = next;
  }
  return current;
}

/** Parse a concrete path (`opts.timeout`, `collection[0].field`) into segments. */
function parsePath(path) {
  const segments = [];
  for (const part of path.split('.')) {
    const match = part.match(/^(.*)\[(\d+)\]$/);
    if (match) {
      if (match[1] !== '') segments.push(match[1]);
      segments.push(Number(match[2]));
    } else if (part !== '') {
      segments.push(part);
    }
  }
  return segments;
}

/** Deep-copy a plain JSON value (objects/arrays); scalars pass through. */
function deepCopy(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((element) => deepCopy(element));
  const copy = {};
  for (const key of Object.keys(value)) copy[key] = deepCopy(value[key]);
  return copy;
}

function setAtPath(target, path, value) {
  if (path === '') return;
  const segments = parsePath(path);
  let current = target;
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i];
    const last = i === segments.length - 1;
    if (last) {
      if (value === undefined) delete current[segment];
      // Deep-copy object/array leaves so the snapshot never aliases (and thereby
      // freezes, via deepFreeze) the caller's input.
      else current[segment] = value !== null && typeof value === 'object' ? deepCopy(value) : value;
      return;
    }
    const next = current[segment];
    if (!isPlainObject(next) && !Array.isArray(next)) {
      current[segment] = typeof segments[i + 1] === 'number' ? [] : {};
    }
    current = current[segment];
  }
}

/**
 * §20/§21/§27 — validate a full set of parameter values against a compiled plan.
 * Pure and idempotent. Returns:
 *   - `valid`          true when no issue was produced;
 *   - `normalized`     the canonical values (a plain object, mirrors the input shape);
 *   - `issues`         the structured error list (each a §27-coded, path-scoped issue);
 *   - `unresolvedExpressions`  concrete paths whose value is still an expression ref;
 *   - `dependencyDigest`       a sha256 over the canonical normalized values.
 */
export function validateParameters(plan, values, options = {}) {
  const root = values && typeof values === 'object' ? values : {};
  const issues = [];
  const normalized = {};
  const unresolvedExpressions = [];
  const changed = [];

  for (const parameter of plan.parameters) {
    if (!parameter.valueSlot) continue;
    const instances = instancesAt(root, parameter.path);
    for (const instance of instances) {
      const { canonical, issues: slotIssues } = validateValue(parameter, instance.value, options);
      issues.push(...slotIssues);
      if (canonical !== undefined) {
        setAtPath(normalized, instance.path, canonical);
      }
      if (isExpression(instance.value)) unresolvedExpressions.push(instance.path);
      if (slotIssues.length === 0 && canonical !== instance.value && changed.length < (options.maxChanges ?? 4096)) changed.push(parameter.path);
    }
  }

  const dependencyDigest = sha256(canonicalJson(normalized));
  return deepFreeze({
    valid: issues.length === 0,
    normalized,
    issues,
    unresolvedExpressions,
    changed,
    dependencyDigest,
  });
}

/* ------------------------------------------------------------------ §29/§30 snapshot */

/**
 * §29/§30 — produce the compact immutable execution-ready snapshot. This is DERIVED
 * execution input (never the canonical workflow definition) and is reconstructible
 * from `plan` + `values` (see `reconstructSnapshot`).
 */
export function buildExecutionSnapshot(plan, values, options = {}) {
  const result = validateParameters(plan, values, options);
  const snapshot = {
    format: SNAPSHOT_FORMAT,
    formatVersion: SNAPSHOT_FORMAT_VERSION,
    schemaVersion: plan.schemaVersion,
    nodeType: plan.nodeType,
    typeVersion: plan.typeVersion,
    planFingerprint: plan.planFingerprint,
    definitionFingerprint: plan.definitionFingerprint,
    validationStatus: result.valid ? 'valid' : 'invalid',
    issueCount: result.issues.length,
    dependencyDigest: result.dependencyDigest,
    unresolvedExpressions: result.unresolvedExpressions,
    values: result.normalized,
    createdAt: typeof options.createdAt === 'string' ? options.createdAt : new Date().toISOString(),
  };
  return deepFreeze(snapshot);
}

/**
 * §30 — prove the snapshot is derived and reconstructible: re-deriving the snapshot
 * from the same plan + values (with a fixed `createdAt`) yields a byte-identical
 * snapshot. Returns the freshly derived snapshot for comparison.
 */
export function reconstructSnapshot(plan, values, options = {}) {
  return buildExecutionSnapshot(plan, values, options);
}

export { PARAMETER_SCHEMA_VERSION };
