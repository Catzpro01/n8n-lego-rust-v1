/**
 * Environments surface pilot (P2-S18, issue #240) - the strangler slice for
 * the environment selection and variable-scoping panel, split out of P2-S03
 * (Layer 4). One surface, one delivery scope: pick the active environment and
 * scope/edit the handed-over environment variables through declared
 * interactions.
 *
 * Boundary (invariants 4-5): the environment list, the active environment and
 * the variable records are HANDED OVER (inputBoundary source hand-over)
 * through declared capabilities only. The surface holds no private data path
 * and no second source of truth: it never fetches variables, never derives
 * the active environment locally (the hand-over owns it - request-switch is
 * DECLARED, the active id changes only via a fresh hand-over) and NEVER
 * POSTS THE WORKFLOW or the variables - set-variable/set-scope/
 * request-submit are DECLARED interactions with closed results.
 *
 * Security boundary (the load-bearing rule): a payload envelope carrying
 * secret or session material is refused with an explicit security error,
 * never dropped. Variable VALUES are opaque primitives handed over from the
 * variable store - this surface evaluates nothing (no eval, no new
 * Function), fetches nothing and never persists: what the hand-over carried
 * is exactly what renders.
 *
 * Closed contracts (invariants 4 and 7): the four region states are exactly
 * the shared REGION_STATES; environment kinds are the declared subset dev |
 * preview | staging (the full zoo stays with the reference - recorded as
 * evidence); variable scope is 'all' | <environment id>; a workflow with no
 * environments is empty with reason none, never a fifth state.
 *
 * Pilot (invariants 1 and 9): the original n8n settings stay the default
 * path; rollback is switching the pilot off with no residual state and no
 * variables-data migration (rollbackStrategy: pilot-not-primary in the
 * surface-migrations manifest).
 */
import { observation } from './parity.mjs';
import { REGION_STATES } from './surface-contract.mjs';

export const ENV_STATES = REGION_STATES;

export const ENV_SURFACE_ID = 'environments';
export const ENV_SURFACE_VERSION = 'p1';
export const ENV_MESSAGE_SLOT = 'environments';

/** Closed environment-kind vocabulary: the declared subset this slice renders. */
export const ENV_KINDS = Object.freeze(['dev', 'preview', 'staging']);

/** Closed scope vocabulary prefix: a variable is scoped to every environment or one id. */
export const ENV_GLOBAL_SCOPE = 'all';

/** Closed empty reason: no environments handed over is none, never a fifth state. */
export const ENV_EMPTY_REASONS = Object.freeze(['none']);

/** Closed action vocabulary: what the user may ask for in a state (declared). */
export const ENV_ACTIONS = Object.freeze([
  'refresh', 'set-variable', 'set-scope', 'request-submit', 'request-switch',
]);

/**
 * Closed request-result vocabularies: every declared outcome is explicit.
 * accepted means the REQUEST was accepted for the app layer - the variables
 * store and the active environment are written by the app layer, never here.
 */
export const ENV_SET_RESULTS = Object.freeze(['accepted', 'unknown-variable', 'not-ready']);
export const ENV_SCOPE_RESULTS = Object.freeze([
  'accepted', 'unknown-variable', 'invalid-scope', 'not-ready',
]);
export const ENV_SUBMIT_RESULTS = Object.freeze(['accepted', 'no-changes', 'not-ready']);
export const ENV_SWITCH_RESULTS = Object.freeze(['accepted', 'unknown-environment', 'not-ready']);

/** Default visible variable cap and the hard maximum a caller can request. */
export const ENV_MAX_VISIBLE_DEFAULT = 30;
export const ENV_MAX_VISIBLE_HARD_MAX = 100;

/** The a11y labels for the interactive controls, declared once. */
export const ENV_LABELS = Object.freeze({
  variable: 'Variable value',
  scope: 'Variable scope',
  submit: 'Save variables',
  switch: 'Switch environment',
  refresh: 'Refresh environments',
});

/** Closed environment record shape: one handed-over environment. */
const ENVIRONMENT_KEYS = Object.freeze(['id', 'name', 'kind']);

/** Closed variable record shape: name + primitive value + declared scope. */
const VARIABLE_KEYS = Object.freeze(['name', 'value', 'scope']);

/** Closed hand-over payload: one load, environments + active + variables. */
const PAYLOAD_KEYS = Object.freeze(['environments', 'active', 'variables']);

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

function assertEnvironment(environment, index, seenIds) {
  if (environment === null || typeof environment !== 'object' || Array.isArray(environment)) {
    throw new Error(`environment ${index} must be an object`);
  }
  const keys = Object.keys(environment);
  assertNoSecretFields(keys, `environment ${index}`);
  const sorted = keys.sort();
  if (sorted.join(',') !== [...ENVIRONMENT_KEYS].sort().join(',')) {
    throw new Error(`environment ${index} must have exactly id,name,kind (got ${sorted.join(',')})`);
  }
  for (const key of ['id', 'name']) {
    if (typeof environment[key] !== 'string' || environment[key].trim() === '') {
      throw new Error(`environment ${index} field ${key} must be a non-empty string`);
    }
  }
  if (!ENV_KINDS.includes(environment.kind)) {
    throw new Error(`environment ${index} field kind must be one of ${ENV_KINDS.join(', ')} (got "${environment.kind}")`);
  }
  if (seenIds.has(environment.id)) {
    throw new Error(`environment ${index} repeats the id "${environment.id}": environment ids are unique`);
  }
}

function assertVariable(variable, index, seenNames, environmentIds) {
  if (variable === null || typeof variable !== 'object' || Array.isArray(variable)) {
    throw new Error(`variable ${index} must be an object`);
  }
  const keys = Object.keys(variable);
  assertNoSecretFields(keys, `variable ${index}`);
  const sorted = keys.sort();
  if (sorted.join(',') !== [...VARIABLE_KEYS].sort().join(',')) {
    throw new Error(`variable ${index} must have exactly name,value,scope (got ${sorted.join(',')})`);
  }
  if (typeof variable.name !== 'string' || variable.name.trim() === '') {
    throw new Error(`variable ${index} field name must be a non-empty string`);
  }
  if (seenNames.has(variable.name)) {
    throw new Error(`variable ${index} repeats the name "${variable.name}": variable names are unique`);
  }
  assertPrimitive(variable.value, `variable "${variable.name}" value`);
  const scopeOk = variable.scope === ENV_GLOBAL_SCOPE || (
    typeof variable.scope === 'string' && environmentIds.has(variable.scope)
  );
  if (!scopeOk) {
    throw new Error(`variable ${index} scope must be "${ENV_GLOBAL_SCOPE}" or a handed-over environment id (got "${variable.scope}")`);
  }
}

/** The declared surface contract: states keyed on REGION_STATES exactly. */
export function environmentsSurfaceContract() {
  return Object.freeze({
    id: ENV_SURFACE_ID,
    version: ENV_SURFACE_VERSION,
    inputBoundary: Object.freeze({
      source: 'hand-over',
      entryPoint: 'loadSuccess',
      issuesEngineCall: false,
      issuesWorkflowSave: false,
      carriesSecrets: false,
    }),
    states: Object.freeze(
      Object.fromEntries(REGION_STATES.map((state) => [state, Object.freeze({ state })])),
    ),
    vocabularies: Object.freeze({
      environmentKinds: ENV_KINDS,
      globalScope: ENV_GLOBAL_SCOPE,
      actions: ENV_ACTIONS,
      setResults: ENV_SET_RESULTS,
      scopeResults: ENV_SCOPE_RESULTS,
      submitResults: ENV_SUBMIT_RESULTS,
      switchResults: ENV_SWITCH_RESULTS,
      emptyReasons: ENV_EMPTY_REASONS,
    }),
    bounds: Object.freeze({
      maxVisibleDefault: ENV_MAX_VISIBLE_DEFAULT,
      maxVisibleHardMax: ENV_MAX_VISIBLE_HARD_MAX,
    }),
  });
}

/**
 * The a11y intent is derived ONCE here, so the contract's declared observables
 * and the view-model's rendered attributes cannot drift. The ready state is
 * the form landmark; every other state is a status. Only error is aria-live
 * assertive; only loading is aria-busy.
 */
export const ENV_A11Y = Object.freeze(
  Object.fromEntries(
    ENV_STATES.map((state) => [
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
 * exactly these fields).
 */
export function envActionsFor(region) {
  if (region === 'error') return Object.freeze(['refresh']);
  if (region === 'loading') return Object.freeze([]);
  if (region === 'empty') return Object.freeze(['refresh']);
  return Object.freeze(['refresh', 'set-variable', 'set-scope', 'request-submit', 'request-switch']);
}

function interactionsFor(region) {
  const actions = envActionsFor(region);
  return Object.freeze({
    refresh: actions.includes('refresh'),
    setVariable: actions.includes('set-variable'),
    setScope: actions.includes('set-scope'),
    requestSubmit: actions.includes('request-submit'),
    requestSwitch: actions.includes('request-switch'),
  });
}

/**
 * Create the environments view-model. Environments, the active id and the
 * variable records enter ONLY through loadSuccess() (one hand-over); the
 * surface performs no fetch, derives no active environment locally and never
 * persists - set/set-scope/request-submit/request-switch are DECLARED
 * interactions with explicit results. Visible variables are the handed-over
 * records scoped to the HANDED-OVER active environment (or 'all').
 */
export function createEnvironmentsSurface(options = {}) {
  const locale = options.locale ?? 'en';
  const requestedMax = options.maxVisible ?? ENV_MAX_VISIBLE_DEFAULT;
  if (!Number.isInteger(requestedMax) || requestedMax <= 0) {
    throw new Error('maxVisible must be a positive integer');
  }
  const maxVisible = Math.min(requestedMax, ENV_MAX_VISIBLE_HARD_MAX);
  const renderAvailable = options.renderAvailable ?? true;

  let environments = Object.freeze([]);
  let activeId = null;
  let variables = Object.freeze([]);
  let originalVariables = Object.freeze([]);
  let environmentIds = new Set();
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

  function scopedVariables() {
    return variables.filter(
      (variable) => variable.scope === ENV_GLOBAL_SCOPE || variable.scope === activeId,
    );
  }

  function dirtyNames() {
    return variables
      .map((variable, index) => (Object.is(variable.value, originalVariables[index]?.value)
        && Object.is(variable.scope, originalVariables[index]?.scope)
        ? null : variable.name))
      .filter((name) => name !== null);
  }

  function displayModel() {
    const visible = scopedVariables();
    const shown = visible.slice(0, maxVisible);
    return Object.freeze({
      visible: true,
      visibleCount: visible.length,
      shown: Object.freeze(shown.map((variable) => Object.freeze({
        name: variable.name,
        value: variable.value,
        scope: variable.scope,
      }))),
      truncated: visible.length > shown.length,
      total: visible.length,
      reason: region === 'empty' ? 'none' : null,
      environments: Object.freeze(environments.map((environment) => Object.freeze({
        id: environment.id,
        name: environment.name,
        kind: environment.kind,
        active: environment.id === activeId,
      }))),
      active: activeId,
      focusOrder: Object.freeze(region === 'ready'
        ? [
          ...environments.map((environment) => `env:${environment.id}`),
          ...shown.map((variable) => `var:${variable.name}`),
          ...(dirtyNames().length > 0 ? ['submit'] : []),
        ]
        : []),
      labels: ENV_LABELS,
      announcement: pendingAnnouncement,
      actions: envActionsFor(region),
      error: region === 'error' ? { kind: error?.kind ?? 'network' } : null,
    });
  }

  function a11y() {
    return ENV_A11Y[regionState()];
  }

  return Object.freeze({
    id: ENV_SURFACE_ID,
    contract: environmentsSurfaceContract(),
    maxVisible,
    /**
     * The only data entry point (one hand-over: environments + active +
     * variables). Secret-bearing envelopes, duplicate ids/names, unknown
     * kinds, unknown scopes and non-primitive values are refused.
     */
    loadSuccess(payload) {
      if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new Error('loadSuccess expects a hand-over payload object {environments, active, variables}');
      }
      const keys = Object.keys(payload);
      assertNoSecretFields(keys, 'loadSuccess payload');
      const sorted = keys.sort();
      if (sorted.join(',') !== [...PAYLOAD_KEYS].sort().join(',')) {
        throw new Error(`loadSuccess payload must have exactly ${PAYLOAD_KEYS.join(',')} (got ${sorted.join(',')})`);
      }
      if (!Array.isArray(payload.environments) || !Array.isArray(payload.variables)) {
        throw new Error('loadSuccess payload fields environments (array) and variables (array) are required');
      }
      const ids = new Set();
      payload.environments.forEach((environment, index) => {
        assertEnvironment(environment, index, ids);
        ids.add(environment.id);
      });
      if (payload.active !== null) {
        if (typeof payload.active !== 'string' || payload.active.trim() === '') {
          throw new Error('loadSuccess active must be null or a non-empty environment id');
        }
        if (ids.size === 0) {
          throw new Error('loadSuccess active must be null when no environments are handed over');
        }
        if (!ids.has(payload.active)) {
          throw new Error(`loadSuccess active resolves the unknown environment "${payload.active}": the hand-over must be consistent`);
        }
      } else if (ids.size > 0) {
        throw new Error('loadSuccess active must name one of the handed-over environments when the list is non-empty');
      }
      const names = new Set();
      payload.variables.forEach((variable, index) => {
        assertVariable(variable, index, names, ids);
        names.add(variable.name);
      });
      environments = Object.freeze(payload.environments.map((environment) => Object.freeze({ ...environment })));
      activeId = payload.active;
      environmentIds = ids;
      const held = payload.variables.map((variable) => Object.freeze({ ...variable }));
      variables = Object.freeze(held);
      originalVariables = variables;
      error = null;
      loaded = true;
      pendingAnnouncement = null;
      region = environments.length > 0 ? 'ready' : 'empty';
      pushEvent('loaded');
      return environments.length;
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
    /** Back to loading. Records are retained but the region is loading. */
    setLoading() {
      region = 'loading';
      pushEvent('loading');
      return 'loading';
    },
    /**
     * DECLARED, view-only: change one variable's value in the VIEW. The value
     * must be primitive; the variables store is written by the app layer via
     * requestSubmit, never here.
     */
    setVariable(name, value) {
      if (typeof name !== 'string' || name.trim() === '') {
        throw new Error('setVariable expects a non-empty variable name');
      }
      if (region !== 'ready') return 'not-ready';
      const index = variables.findIndex((variable) => variable.name === name);
      if (index === -1) return 'unknown-variable';
      assertPrimitive(value, `variable "${name}" value`);
      const previous = variables[index].value;
      if (Object.is(previous, value)) return 'accepted';
      const next = [...variables];
      next[index] = Object.freeze({ ...next[index], value });
      variables = Object.freeze(next);
      pushEvent('variable-set');
      pendingAnnouncement = name;
      return 'accepted';
    },
    /**
     * DECLARED, view-only: re-scope one variable in the VIEW. The scope must
     * be 'all' or a handed-over environment id; the store is written by the
     * app layer via requestSubmit, never here.
     */
    setScope(name, scope) {
      if (typeof name !== 'string' || name.trim() === '') {
        throw new Error('setScope expects a non-empty variable name');
      }
      if (region !== 'ready') return 'not-ready';
      const index = variables.findIndex((variable) => variable.name === name);
      if (index === -1) return 'unknown-variable';
      const scopeOk = scope === ENV_GLOBAL_SCOPE || (
        typeof scope === 'string' && environmentIds.has(scope)
      );
      if (!scopeOk) return 'invalid-scope';
      const previous = variables[index].scope;
      if (Object.is(previous, scope)) return 'accepted';
      const next = [...variables];
      next[index] = Object.freeze({ ...next[index], scope });
      variables = Object.freeze(next);
      pushEvent('scope-set');
      pendingAnnouncement = name;
      return 'accepted';
    },
    /**
     * DECLARED, never executed: ask the app layer to persist the edited
     * variables. The surface never posts - identity of the changes is the
     * dirty list, cleared only by a fresh hand-over.
     */
    requestSubmit() {
      if (region !== 'ready') return 'not-ready';
      if (dirtyNames().length === 0) return 'no-changes';
      pushEvent('submit-requested');
      return 'accepted';
    },
    /**
     * DECLARED, never executed: ask the app layer to switch the active
     * environment. The handed-over active id NEVER changes here - only a
     * fresh hand-over moves it (no second source of truth).
     */
    requestSwitch(environmentId) {
      if (typeof environmentId !== 'string' || environmentId.trim() === '') {
        throw new Error('requestSwitch expects a non-empty environment id');
      }
      if (region !== 'ready') return 'not-ready';
      if (!environmentIds.has(environmentId)) return 'unknown-environment';
      pushEvent('switch-requested');
      return 'accepted';
    },
    displayModel,
    a11y,
    /** Observable snapshot for the parity harness (candidate side). */
    observe() {
      const state = regionState();
      const model = displayModel();
      const events = state === 'ready' ? ['environments:rendered'] : [];
      if (state === 'ready' && model.announcement !== null) {
        events.push('environments:changed');
      }
      return observation({
        surfaceId: ENV_SURFACE_ID,
        side: 'candidate',
        visible: model.visible === true,
        regionState: state,
        loading: state === 'loading',
        empty: state === 'empty',
        error: state === 'error' ? { kind: error?.kind ?? 'network' } : null,
        interactions: interactionsFor(state),
        events: Object.freeze(events),
        accessibility: a11y(),
        localization: Object.freeze({ slot: ENV_MESSAGE_SLOT, locale }),
        contract: Object.freeze({ id: ENV_SURFACE_ID, version: ENV_SURFACE_VERSION }),
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
    get activeId() {
      return activeId;
    },
  });
}

/* -------------------------------------------------------- the reference model */

/**
 * The reference (pinned n8n settings) observations as deterministic fixtures.
 * The reference UI is not run here - these are the declared behaviours the
 * candidate is compared against. They mirror observe() field for field, and
 * their interactions come from the SAME envActionsFor rule the view-model
 * uses, so the two sides cannot drift by construction.
 */
function referenceObservation({ regionState: state, error = null, events = [], locale }) {
  return observation({
    surfaceId: ENV_SURFACE_ID,
    side: 'reference',
    visible: true,
    regionState: state,
    loading: state === 'loading',
    empty: state === 'empty',
    error,
    interactions: interactionsFor(state),
    events: Object.freeze(events),
    accessibility: ENV_A11Y[state],
    localization: Object.freeze({ slot: ENV_MESSAGE_SLOT, locale }),
    contract: Object.freeze({ id: ENV_SURFACE_ID, version: ENV_SURFACE_VERSION }),
  });
}

export function referenceLoadingObservation(locale = 'en') {
  return referenceObservation({ regionState: 'loading', locale });
}

export function referenceEmptyObservation({ reason = 'none', locale = 'en' } = {}) {
  if (!ENV_EMPTY_REASONS.includes(reason)) {
    throw new Error(`reason must be one of ${ENV_EMPTY_REASONS.join(', ')} (got "${reason}")`);
  }
  return referenceObservation({ regionState: 'empty', locale });
}

export function referenceReadyObservation(locale = 'en') {
  return referenceObservation({ regionState: 'ready', events: ['environments:rendered'], locale });
}

export function referenceErrorObservation({ errorKind = 'network', locale = 'en' } = {}) {
  return referenceObservation({ regionState: 'error', error: { kind: errorKind }, locale });
}
