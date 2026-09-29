/**
 * Node configuration surface pilot (P2-S15, issue #240) - the strangler slice
 * for the node parameter / NDV panel, split out of P2-S03. One surface, one
 * delivery scope: the parameter panel that edits ONE node type's parameters
 * through the parameter contract.
 *
 * Boundary (invariants 4-5): the parameter definitions and the current values
 * are HANDED OVER (inputBoundary source hand-over) through declared
 * capabilities only. The surface holds no private data path and no second
 * source of truth: it never fetches a node type's parameter schema (the node
 * registry owns the catalog), NEVER EVALUATES AN EXPRESSION (expression
 * strings pass through exactly as carried - evaluation stays behind the
 * declared boundary with the engine) and never posts a workflow.
 *
 * Security boundary (the load-bearing rule): THE EVALUATOR NEVER REACHES
 * THIS SURFACE. There is no eval, no new Function and no expression engine
 * here - an expression value is rendered as the string the hand-over carried
 * and marked, never executed. A payload carrying secret or session material
 * is refused with an explicit security error, never dropped; values are
 * primitives only (no objects, no functions, no code).
 *
 * Closed contracts (invariants 4 and 7): the four region states are exactly
 * the shared REGION_STATES; the parameter type vocabulary is the declared
 * subset string | number | boolean | options (the full n8n type zoo stays
 * with the reference - recorded as evidence); value kinds are literal |
 * expression | unset; an empty parameter list is empty with reason none,
 * never a fifth state.
 *
 * Pilot (invariants 1 and 9): the original n8n editor stays the default path;
 * rollback is switching the pilot off with no residual state and no
 * workflow-data migration (rollbackStrategy: pilot-not-primary in the
 * surface-migrations manifest).
 */
import { observation } from './parity.mjs';
import { REGION_STATES } from './surface-contract.mjs';

export const PARAM_STATES = REGION_STATES;

export const PARAM_SURFACE_ID = 'node-config';
export const PARAM_SURFACE_VERSION = 'p1';
export const PARAM_MESSAGE_SLOT = 'node-config';

/** Closed parameter-type vocabulary: the declared subset this slice edits. */
export const PARAM_TYPES = Object.freeze(['string', 'number', 'boolean', 'options']);

/** Closed value kinds: how a value reaches the panel. Never evaluated here. */
export const PARAM_VALUE_KINDS = Object.freeze(['literal', 'expression', 'unset']);

/** Closed empty reason: a node with no parameters is none, never a fifth state. */
export const PARAM_EMPTY_REASONS = Object.freeze(['none']);

/** Closed action vocabulary: what the user may ask for in a state (declared). */
export const PARAM_ACTIONS = Object.freeze(['refresh', 'set-parameter', 'request-submit']);

/**
 * Closed request-result vocabularies: every declared outcome is explicit.
 * accepted means the VIEW changed - the workflow document is written by the
 * app layer, never here.
 */
export const PARAM_SET_RESULTS = Object.freeze([
  'accepted', 'unknown-parameter', 'invalid-value', 'not-ready',
]);
export const PARAM_SUBMIT_RESULTS = Object.freeze(['accepted', 'no-changes', 'not-ready']);

/** Default visible cap and the hard maximum a caller can request. */
export const PARAM_MAX_VISIBLE_DEFAULT = 30;
export const PARAM_MAX_VISIBLE_HARD_MAX = 100;

/** The a11y labels for the interactive controls, declared once. */
export const PARAM_LABELS = Object.freeze({
  parameter: 'Parameter value',
  submit: 'Apply changes',
  refresh: 'Refresh parameters',
});

/** Closed definition shape: one parameter of the handed-over node type. */
const DEFINITION_KEYS = Object.freeze(['displayName', 'name', 'options', 'required', 'type']);

/** Closed option shape for a select parameter. */
const OPTION_KEYS = Object.freeze(['name', 'value']);

/** Closed hand-over payload: one load, the definitions plus the values. */
const PAYLOAD_KEYS = Object.freeze(['parameters', 'values']);

/**
 * Fields that would carry secret or session material in the hand-over
 * envelope. Refused with an explicit security error - fail-closed, never
 * dropped (the credentials runtime owns them).
 */
const SECRET_BEARING_KEYS = Object.freeze([
  'password', 'passwordHash', 'secret', 'token', 'refreshToken', 'accessToken',
  'apiKey', 'apikey', 'credentials', 'privateKey', 'encrypted', 'oauthToken',
  'sessionToken', 'sessionId', 'cookie', 'key', 'hash', 'authorization',
]);

function assertNoSecretFields(keys, where) {
  for (const key of keys) {
    if (SECRET_BEARING_KEYS.includes(key)) {
      throw new Error(
        `${where} carries the secret-bearing field ${key}: session material never reaches this surface (the credentials runtime owns it)`,
      );
    }
  }
}

function isExpression(value) {
  return typeof value === 'string' && value.startsWith('={{') && value.endsWith('}}');
}

function assertPrimitive(value, where) {
  if (value === null) return;
  const type = typeof value;
  if (type === 'string') return;
  if (type === 'boolean') return;
  if (type === 'number' && Number.isFinite(value)) return;
  throw new Error(
    `${where} must be a primitive (null, string, finite number, boolean) - objects and code never reach this surface`,
  );
}

function assertDefinition(definition, index, names) {
  if (definition === null || typeof definition !== 'object' || Array.isArray(definition)) {
    throw new Error(`parameter ${index} must be an object`);
  }
  const keys = Object.keys(definition);
  assertNoSecretFields(keys, `parameter ${index}`);
  const sorted = keys.sort();
  if (sorted.join(',') !== [...DEFINITION_KEYS].sort().join(',')) {
    throw new Error(`parameter ${index} must have exactly ${[...DEFINITION_KEYS].sort().join(',')} (got ${sorted.join(',')})`);
  }
  for (const key of ['name', 'displayName']) {
    if (typeof definition[key] !== 'string' || definition[key].trim() === '') {
      throw new Error(`parameter ${index} field ${key} must be a non-empty string`);
    }
  }
  if (typeof definition.required !== 'boolean') {
    throw new Error(`parameter ${index} field required must be a boolean`);
  }
  if (typeof definition.type !== 'string' || !PARAM_TYPES.includes(definition.type)) {
    throw new Error(`parameter ${index} field type must be one of ${PARAM_TYPES.join(', ')} (got "${definition.type}")`);
  }
  if (definition.type === 'options') {
    if (!Array.isArray(definition.options) || definition.options.length === 0) {
      throw new Error(`parameter ${index} of type options carries a non-empty options list`);
    }
    definition.options.forEach((option, optionIndex) => {
      if (option === null || typeof option !== 'object' || Array.isArray(option)) {
        throw new Error(`parameter ${index} option ${optionIndex} must be an object`);
      }
      const optionKeys = Object.keys(option).sort();
      if (optionKeys.join(',') !== [...OPTION_KEYS].sort().join(',')) {
        throw new Error(`parameter ${index} option ${optionIndex} must have exactly name,value`);
      }
      for (const key of ['name', 'value']) {
        if (typeof option[key] !== 'string' || option[key].trim() === '') {
          throw new Error(`parameter ${index} option ${optionIndex} field ${key} must be a non-empty string`);
        }
      }
    });
  } else if (definition.options !== null) {
    throw new Error(`parameter ${index} carries options only for type options (got ${definition.type})`);
  }
  if (names.has(definition.name)) {
    throw new Error(`parameter ${index} repeats the name "${definition.name}": parameter names are unique`);
  }
}

function matchesType(definition, value) {
  if (isExpression(value)) return true; // evaluation happens behind the boundary
  if (value === null) return true; // unset is always representable
  if (definition.type === 'string') return typeof value === 'string';
  if (definition.type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (definition.type === 'boolean') return typeof value === 'boolean';
  return definition.options.some((option) => option.value === value); // options
}

/** The declared surface contract: states keyed on REGION_STATES exactly. */
export function nodeConfigSurfaceContract() {
  return Object.freeze({
    id: PARAM_SURFACE_ID,
    version: PARAM_SURFACE_VERSION,
    inputBoundary: Object.freeze({
      source: 'hand-over',
      entryPoint: 'loadSuccess',
      issuesExpressionEvaluation: false,
      issuesWorkflowSave: false,
      carriesSecrets: false,
    }),
    states: Object.freeze(
      Object.fromEntries(REGION_STATES.map((state) => [state, Object.freeze({ state })])),
    ),
    vocabularies: Object.freeze({
      parameterTypes: PARAM_TYPES,
      valueKinds: PARAM_VALUE_KINDS,
      actions: PARAM_ACTIONS,
      setResults: PARAM_SET_RESULTS,
      submitResults: PARAM_SUBMIT_RESULTS,
      emptyReasons: PARAM_EMPTY_REASONS,
    }),
    bounds: Object.freeze({
      maxVisibleDefault: PARAM_MAX_VISIBLE_DEFAULT,
      maxVisibleHardMax: PARAM_MAX_VISIBLE_HARD_MAX,
    }),
  });
}

/**
 * The a11y intent is derived ONCE here, so the contract's declared observables
 * and the view-model's rendered attributes cannot drift. The ready state is
 * the form landmark; every other state is a status. Only error is aria-live
 * assertive; only loading is aria-busy.
 */
export const PARAM_A11Y = Object.freeze(
  Object.fromEntries(
    PARAM_STATES.map((state) => [
      state,
      Object.freeze({
        role: state === 'ready' ? 'form' : 'status',
        ariaLive: state === 'error' ? 'assertive' : 'polite',
        ariaBusy: state === 'loading',
      }),
    ]),
  ),
);

/**
 * The closed per-state action rule, used by BOTH the view-model and the
 * reference fixtures so the two sides cannot drift (parity is fail-closed on
 * exactly these fields). Dirty-state availability is answered by the request
 * vocabularies, never by the rule.
 */
export function paramActionsFor(region) {
  if (region === 'error') return Object.freeze(['refresh']);
  if (region === 'loading') return Object.freeze([]);
  if (region === 'empty') return Object.freeze(['refresh']);
  return Object.freeze(['refresh', 'set-parameter', 'request-submit']);
}

function interactionsFor(region) {
  const actions = paramActionsFor(region);
  return Object.freeze({
    refresh: actions.includes('refresh'),
    setParameter: actions.includes('set-parameter'),
    requestSubmit: actions.includes('request-submit'),
  });
}

/**
 * Create the node-configuration view-model. Definitions and values enter
 * ONLY through loadSuccess() (one hand-over from the parameter contract); the
 * surface performs no fetch, evaluates no expression and never posts the
 * workflow - setParameter and requestSubmit are DECLARED interactions with
 * explicit results.
 */
export function createNodeConfigSurface(options = {}) {
  const locale = options.locale ?? 'en';
  const requestedMax = options.maxVisible ?? PARAM_MAX_VISIBLE_DEFAULT;
  if (!Number.isInteger(requestedMax) || requestedMax <= 0) {
    throw new Error('maxVisible must be a positive integer');
  }
  const maxVisible = Math.min(requestedMax, PARAM_MAX_VISIBLE_HARD_MAX);
  const renderAvailable = options.renderAvailable ?? true;

  let parameters = Object.freeze([]);
  let values = Object.freeze({});
  let originalValues = Object.freeze({});
  let loaded = false;
  let region = 'loading';
  let error = null;
  let degradedEvents = 0;
  let pendingAnnouncement = null;
  const history = [];

  function pushEvent(name) {
    history.push({ at: history.length, name });
    if (!renderAvailable) degradedEvents += 1;
  }

  function regionState() {
    return region;
  }

  function valueKindOf(value) {
    if (value === null || value === undefined) return 'unset';
    if (isExpression(value)) return 'expression';
    return 'literal';
  }

  function dirtyNames() {
    return parameters
      .map((definition) => definition.name)
      .filter((name) => !Object.is(values[name] ?? null, originalValues[name] ?? null));
  }

  function displayModel() {
    const visible = parameters;
    const shown = visible.slice(0, maxVisible);
    return Object.freeze({
      visible: true,
      visibleCount: visible.length,
      shown: Object.freeze(shown.map((definition) => Object.freeze({
        ...definition,
        options: definition.options === null ? null : Object.freeze(definition.options.map((option) => Object.freeze({ ...option }))),
        value: values[definition.name] ?? null,
        valueKind: valueKindOf(values[definition.name] ?? null),
      }))),
      truncated: visible.length > shown.length,
      total: visible.length,
      reason: region === 'empty' ? 'none' : null,
      dirty: Object.freeze(dirtyNames()),
      focusOrder: Object.freeze([
        ...shown.map((definition) => `param:${definition.name}`),
        ...(dirtyNames().length > 0 ? ['submit'] : []),
      ]),
      labels: PARAM_LABELS,
      announcement: pendingAnnouncement,
      actions: paramActionsFor(region),
      error: region === 'error' ? { kind: error?.kind ?? 'network' } : null,
    });
  }

  function a11y() {
    return PARAM_A11Y[regionState()];
  }

  return Object.freeze({
    id: PARAM_SURFACE_ID,
    contract: nodeConfigSurfaceContract(),
    maxVisible,
    /**
     * The only data entry point (one hand-over: definitions + values). The
     * surface evaluates NO expression and never posts the workflow - what the
     * payload carried is exactly what renders. Secret-bearing envelopes,
     * unknown value keys, duplicate names and non-primitive values are
     * refused.
     */
    loadSuccess(payload) {
      if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new Error('loadSuccess expects a hand-over payload object {parameters, values}');
      }
      const keys = Object.keys(payload);
      assertNoSecretFields(keys, 'loadSuccess payload');
      const sorted = keys.sort();
      if (sorted.join(',') !== [...PAYLOAD_KEYS].sort().join(',')) {
        throw new Error(`loadSuccess payload must have exactly ${PAYLOAD_KEYS.join(',')} (got ${sorted.join(',')})`);
      }
      if (!Array.isArray(payload.parameters) || payload.values === null
        || typeof payload.values !== 'object' || Array.isArray(payload.values)) {
        throw new Error('loadSuccess payload fields parameters (array) and values (object) are required');
      }
      const names = new Set();
      payload.parameters.forEach((definition, index) => {
        assertDefinition(definition, index, names);
        names.add(definition.name);
      });
      for (const [name, value] of Object.entries(payload.values)) {
        if (!names.has(name)) {
          throw new Error(`values carries the unknown parameter "${name}": the hand-over must be consistent`);
        }
        assertPrimitive(value, `value for "${name}"`);
      }
      parameters = Object.freeze(payload.parameters.map((definition) => Object.freeze({
        ...definition,
        options: definition.options === null ? null : Object.freeze(definition.options.map((option) => Object.freeze({ ...option }))),
      })));
      const mutable = {};
      for (const name of names) mutable[name] = payload.values[name] ?? null;
      values = Object.freeze(mutable);
      originalValues = values;
      error = null;
      loaded = true;
      pendingAnnouncement = null;
      region = parameters.length > 0 ? 'ready' : 'empty';
      pushEvent('loaded');
      return parameters.length;
    },
    /** The load failed. The only assertive region state. */
    loadFailure(nextError) {
      if (nextError === null || nextError === undefined || typeof nextError !== 'object') {
        throw new Error('loadFailure expects an error object');
      }
      error = nextError;
      region = 'error';
      pushEvent('failed');
      if (!renderAvailable) degradedEvents += 1;
      return 'error';
    },
    /** Back to loading. Definitions are retained but the region is loading. */
    setLoading() {
      region = 'loading';
      pushEvent('loading');
      return 'loading';
    },
    /**
     * DECLARED, never posted: change one parameter's value in the VIEW. The
     * value is type-checked against the handed-over definition; an expression
     * string is accepted verbatim (evaluation happens behind the boundary).
     * The workflow document never changes here.
     */
    setParameter(name, value) {
      if (typeof name !== 'string' || name.trim() === '') {
        throw new Error('setParameter expects a non-empty parameter name');
      }
      if (region === 'loading' || region === 'error') return 'not-ready';
      const definition = parameters.find((entry) => entry.name === name);
      if (definition === undefined) return 'unknown-parameter';
      assertPrimitive(value, `value for "${name}"`);
      if (!matchesType(definition, value)) return 'invalid-value';
      const previous = values[name] ?? null;
      const next = value === undefined ? null : value;
      if (Object.is(previous, next)) return 'accepted';
      values = Object.freeze({ ...values, [name]: next });
      pushEvent('parameter-set');
      pendingAnnouncement = definition.displayName;
      return 'accepted';
    },
    /**
     * DECLARED, never executed: ask the app layer to persist the edited
     * values. The surface never posts a workflow - identity of the changes is
     * the dirty list, cleared only by a fresh hand-over.
     */
    requestSubmit() {
      if (region === 'loading' || region === 'error') return 'not-ready';
      if (dirtyNames().length === 0) return 'no-changes';
      pushEvent('submit-requested');
      return 'accepted';
    },
    displayModel,
    a11y,
    /** Observable snapshot for the parity harness (candidate side). */
    observe() {
      const state = regionState();
      const model = displayModel();
      const events = state === 'ready' ? ['node-config:rendered'] : [];
      if (state === 'ready' && model.announcement !== null) {
        events.push('node-config:changed');
      }
      return observation({
        surfaceId: PARAM_SURFACE_ID,
        side: 'candidate',
        visible: model.visible === true,
        regionState: state,
        loading: state === 'loading',
        empty: state === 'empty',
        error: state === 'error' ? { kind: error?.kind ?? 'network' } : null,
        interactions: interactionsFor(state),
        events: Object.freeze(events),
        accessibility: a11y(),
        localization: Object.freeze({ slot: PARAM_MESSAGE_SLOT, locale }),
        contract: Object.freeze({ id: PARAM_SURFACE_ID, version: PARAM_SURFACE_VERSION }),
      });
    },
    /** Deterministic history, so two runs of the same script agree. */
    get history() {
      return Object.freeze(history.map((item) => Object.freeze({ ...item })));
    },
    get degradedEvents() {
      return degradedEvents;
    },
    get loaded() {
      return loaded;
    },
  });
}

/* -------------------------------------------------------- the reference model */

/**
 * The reference (pinned n8n editor) observations as deterministic fixtures.
 * The reference UI is not run here - these are the declared behaviours the
 * candidate is compared against. They mirror observe() field for field, and
 * their interactions come from the SAME paramActionsFor rule the view-model
 * uses, so the two sides cannot drift by construction.
 */
function referenceObservation({ regionState: state, error = null, events = [], locale }) {
  return observation({
    surfaceId: PARAM_SURFACE_ID,
    side: 'reference',
    visible: true,
    regionState: state,
    loading: state === 'loading',
    empty: state === 'empty',
    error,
    interactions: interactionsFor(state),
    events: Object.freeze(events),
    accessibility: PARAM_A11Y[state],
    localization: Object.freeze({ slot: PARAM_MESSAGE_SLOT, locale }),
    contract: Object.freeze({ id: PARAM_SURFACE_ID, version: PARAM_SURFACE_VERSION }),
  });
}

export function referenceLoadingObservation(locale = 'en') {
  return referenceObservation({ regionState: 'loading', locale });
}

export function referenceEmptyObservation({ reason = 'none', locale = 'en' } = {}) {
  if (!PARAM_EMPTY_REASONS.includes(reason)) {
    throw new Error(`reason must be one of ${PARAM_EMPTY_REASONS.join(', ')} (got "${reason}")`);
  }
  return referenceObservation({ regionState: 'empty', locale });
}

export function referenceReadyObservation(locale = 'en') {
  return referenceObservation({ regionState: 'ready', events: ['node-config:rendered'], locale });
}

export function referenceErrorObservation({ errorKind = 'network', locale = 'en' } = {}) {
  return referenceObservation({ regionState: 'error', error: { kind: errorKind }, locale });
}
