/**
 * Webhooks surface pilot (P2-S11, issue #240) - the strangler slice for the
 * webhook URL/method/registration surface shown with a node or a workflow. One
 * surface, one delivery scope.
 *
 * Boundary (invariants 4-5): webhook registrations are HANDED OVER
 * (inputBoundary source hand-over) through declared capabilities only. The
 * surface holds no private data path and no second source of truth: it never
 * fetches registrations, ISSUES NO REGISTER CALL (registration is handed over,
 * never requested or created here) and never mutates registration data -
 * copy-url is a DECLARED interaction returning explicit results. loadSuccess()
 * is the only data entry point.
 *
 * Security boundary (a webhook registration can carry auth material; node-level
 * auth is evaluated inside the Webhook node against the Credentials runtime,
 * finding-only here): AUTH MATERIAL NEVER REACHES THIS SURFACE. A registration
 * carrying a secret-bearing field (auth, headers, token, ...) is refused with an
 * explicit security error, never silently dropped. The URL shown is exactly the
 * endpoint the reference UI publishes - the surface adds nothing to it.
 *
 * Closed contracts (invariants 4 and 7): the four region states are exactly the
 * shared REGION_STATES; the method vocabulary is the webhook contract's method
 * guard (DELETE GET HEAD PATCH POST PUT); the resource vocabulary is node /
 * workflow (what a registration is shown with); the URL kind vocabulary is test
 * / production; an empty filter is empty with reason filtered, never a fifth
 * state.
 *
 * Pilot (invariants 1 and 9): the original n8n editor stays the default path;
 * rollback is switching the pilot off with no residual state
 * (rollbackStrategy: pilot-not-primary in the surface-migrations manifest).
 */
import { observation } from './parity.mjs';
import { REGION_STATES } from './surface-contract.mjs';

export const WEBHOOK_STATES = REGION_STATES;

export const WEBHOOK_SURFACE_ID = 'webhooks';
export const WEBHOOK_SURFACE_VERSION = 'p1';
export const WEBHOOK_MESSAGE_SLOT = 'webhooks';

/**
 * Closed method vocabulary - the webhook contract's method guard. OPTIONS is
 * CORS handling answered without executing, so it is not a registration method.
 */
export const WEBHOOK_METHODS = Object.freeze(['DELETE', 'GET', 'HEAD', 'PATCH', 'POST', 'PUT']);

/** Closed resource vocabulary: what a registration is shown with. */
export const WEBHOOK_RESOURCES = Object.freeze(['node', 'workflow']);
export const WEBHOOK_DEFAULT_RESOURCE = 'node';

/** Closed URL kind vocabulary: the two endpoint URLs the reference UI publishes. */
export const WEBHOOK_URL_KINDS = Object.freeze(['test', 'production']);

/** Closed action vocabulary: what the user may ask for in a state (declared). */
export const WEBHOOK_ACTIONS = Object.freeze(['refresh', 'copy-url', 'switch-resource']);

/** Closed request-result vocabulary: every request outcome is explicit. */
export const WEBHOOK_REQUEST_RESULTS = Object.freeze(['requested', 'unknown-id', 'not-ready']);

/** Closed empty reasons. */
export const WEBHOOK_EMPTY_REASONS = Object.freeze(['none', 'filtered']);

/** Default visible cap and the hard maximum a caller can request. */
export const WEBHOOK_MAX_VISIBLE_DEFAULT = 20;
export const WEBHOOK_MAX_VISIBLE_HARD_MAX = 50;

/** Closed entry shape: identity + method + url + what it is shown with. */
const ENTRY_KEYS = Object.freeze(['id', 'method', 'url', 'resource', 'urlKind']);

/**
 * Fields that would carry auth/secret material (node-level auth lives in the
 * Webhook node against the Credentials runtime). A registration bearing any of
 * them is refused with an explicit security error - fail-closed, never dropped.
 */
const SECRET_BEARING_KEYS = Object.freeze([
  'auth', 'authorization', 'basicAuth', 'headerAuth', 'jwtAuth', 'secret', 'password',
  'token', 'apiKey', 'apikey', 'credentials', 'privateKey', 'encrypted', 'oauthToken',
  'headers', 'key', 'hash', 'webhookId',
]);

function assertEntry(entry, index) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error(`webhook entry ${index} must be an object`);
  }
  const keys = Object.keys(entry);
  for (const key of keys) {
    if (SECRET_BEARING_KEYS.includes(key)) {
      throw new Error(
        `webhook entry ${index} carries the secret-bearing field ${key}: auth material never reaches this surface (Webhook node + Credentials runtime own it)`,
      );
    }
  }
  const sorted = keys.sort();
  if (sorted.join(',') !== [...ENTRY_KEYS].sort().join(',')) {
    throw new Error(`webhook entry ${index} must have exactly ${ENTRY_KEYS.join(',')} (got ${sorted.join(',')})`);
  }
  if (typeof entry.id !== 'string' || entry.id.trim() === '') {
    throw new Error(`webhook entry ${index} field id must be a non-empty string`);
  }
  if (typeof entry.method !== 'string' || !WEBHOOK_METHODS.includes(entry.method)) {
    throw new Error(`webhook entry ${index} field method must be one of ${WEBHOOK_METHODS.join(', ')} (got "${entry.method}")`);
  }
  if (typeof entry.url !== 'string' || entry.url.trim() === '') {
    throw new Error(`webhook entry ${index} field url must be a non-empty string`);
  }
  if (typeof entry.resource !== 'string' || !WEBHOOK_RESOURCES.includes(entry.resource)) {
    throw new Error(`webhook entry ${index} field resource must be one of ${WEBHOOK_RESOURCES.join(', ')} (got "${entry.resource}")`);
  }
  if (typeof entry.urlKind !== 'string' || !WEBHOOK_URL_KINDS.includes(entry.urlKind)) {
    throw new Error(`webhook entry ${index} field urlKind must be one of ${WEBHOOK_URL_KINDS.join(', ')} (got "${entry.urlKind}")`);
  }
}

/** The declared surface contract: states keyed on REGION_STATES exactly. */
export function webhooksSurfaceContract() {
  return Object.freeze({
    id: WEBHOOK_SURFACE_ID,
    version: WEBHOOK_SURFACE_VERSION,
    inputBoundary: Object.freeze({
      source: 'hand-over',
      entryPoint: 'loadSuccess',
      issuesRegisterCall: false,
      carriesSecrets: false,
    }),
    states: Object.freeze(
      Object.fromEntries(REGION_STATES.map((state) => [state, Object.freeze({ state })])),
    ),
    vocabularies: Object.freeze({
      methods: WEBHOOK_METHODS,
      resources: WEBHOOK_RESOURCES,
      urlKinds: WEBHOOK_URL_KINDS,
      actions: WEBHOOK_ACTIONS,
      requestResults: WEBHOOK_REQUEST_RESULTS,
      emptyReasons: WEBHOOK_EMPTY_REASONS,
    }),
    bounds: Object.freeze({
      maxVisibleDefault: WEBHOOK_MAX_VISIBLE_DEFAULT,
      maxVisibleHardMax: WEBHOOK_MAX_VISIBLE_HARD_MAX,
    }),
  });
}

/**
 * The a11y intent is derived ONCE here, so the contract's declared observables
 * and the view-model's rendered attributes cannot drift. Only error is
 * aria-live assertive; only loading is aria-busy; the ready list is announced
 * politely so a background refresh does not interrupt.
 */
export const WEBHOOK_A11Y = Object.freeze(
  Object.fromEntries(
    REGION_STATES.map((state) => [
      state,
      Object.freeze({
        role: state === 'ready' ? 'list' : 'status',
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
export function webhookActionsFor(region) {
  if (region === 'error') return Object.freeze(['refresh']);
  if (region === 'loading') return Object.freeze([]);
  if (region === 'empty') return Object.freeze(['switch-resource']);
  return Object.freeze(['refresh', 'copy-url', 'switch-resource']);
}

function interactionsFor(region) {
  const actions = webhookActionsFor(region);
  return Object.freeze({
    refresh: actions.includes('refresh'),
    copyUrl: actions.includes('copy-url'),
    switchResource: actions.includes('switch-resource'),
  });
}

/**
 * Create the webhooks view-model. Registrations enter ONLY through
 * loadSuccess() (hand-over); the surface performs no fetch and issues no
 * register call - registration stays with the trigger/activation runtime.
 */
export function createWebhooksSurface(options = {}) {
  const locale = options.locale ?? 'en';
  const requestedMax = options.maxVisible ?? WEBHOOK_MAX_VISIBLE_DEFAULT;
  if (!Number.isInteger(requestedMax) || requestedMax <= 0) {
    throw new Error('maxVisible must be a positive integer');
  }
  const maxVisible = Math.min(requestedMax, WEBHOOK_MAX_VISIBLE_HARD_MAX);
  const renderAvailable = options.renderAvailable ?? true;

  let entries = Object.freeze([]);
  let region = 'loading';
  let resource = WEBHOOK_DEFAULT_RESOURCE;
  let error = null;
  let degradedEvents = 0;
  const history = [];

  function pushEvent(name) {
    history.push({ at: history.length, name });
    if (!renderAvailable) degradedEvents += 1;
  }

  function resourceEntries() {
    return entries.filter((entry) => entry.resource === resource);
  }

  function regionState() {
    return region;
  }

  function displayModel() {
    const visible = resourceEntries();
    const shown = visible.slice(0, maxVisible);
    return Object.freeze({
      visible: true,
      visibleCount: visible.length,
      shown: Object.freeze(shown.map((entry) => Object.freeze({ ...entry }))),
      truncated: visible.length > shown.length,
      total: entries.length,
      resource,
      reason: region === 'empty' ? (resource !== WEBHOOK_DEFAULT_RESOURCE ? 'filtered' : 'none') : null,
      actions: webhookActionsFor(region),
    });
  }

  function a11y() {
    return WEBHOOK_A11Y[regionState()];
  }

  return Object.freeze({
    id: WEBHOOK_SURFACE_ID,
    contract: webhooksSurfaceContract(),
    maxVisible,
    /**
     * The only data entry point (hand-over). The surface ISSUES NO REGISTER
     * CALL - registration is handed over, never requested here. Secret-bearing
     * registrations are refused.
     */
    loadSuccess(nextEntries) {
      if (!Array.isArray(nextEntries)) {
        throw new Error('loadSuccess expects an array of webhook entries');
      }
      nextEntries.forEach(assertEntry);
      entries = Object.freeze(nextEntries.map((entry) => Object.freeze({ ...entry })));
      resource = WEBHOOK_DEFAULT_RESOURCE;
      error = null;
      region = entries.length > 0 ? 'ready' : 'empty';
      pushEvent('loaded');
      if (!renderAvailable) degradedEvents += 1;
      return entries.length;
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
    /** Back to loading. Entries are retained but the region is loading. */
    setLoading() {
      region = 'loading';
      pushEvent('loading');
      return 'loading';
    },
    /**
     * The one observable mutation: the resource switch (node / workflow).
     * Changes what is VISIBLE. A filter with no registrations is empty with
     * reason filtered when it is not the default resource. An unknown value is
     * refused.
     */
    setResource(next = WEBHOOK_DEFAULT_RESOURCE) {
      if (typeof next !== 'string' || !WEBHOOK_RESOURCES.includes(next)) {
        throw new Error(`resource must be one of ${WEBHOOK_RESOURCES.join(', ')} (got "${next}")`);
      }
      if (next !== resource) {
        resource = next;
        pushEvent('switched-resource');
      }
      if (region === 'ready' || region === 'empty') {
        region = resourceEntries().length > 0 ? 'ready' : 'empty';
      }
      return region;
    },
    /**
     * DECLARED, never executed: ask the app layer to copy a webhook URL. The
     * surface never writes to the clipboard itself - the copy stays with the
     * app layer and the reference UI.
     */
    requestCopy(id) {
      if (typeof id !== 'string' || id.trim() === '') {
        throw new Error('requestCopy expects a non-empty webhook entry id');
      }
      if (region !== 'ready') return 'not-ready';
      if (!entries.some((entry) => entry.id === id)) return 'unknown-id';
      pushEvent('copy-requested');
      return 'requested';
    },
    displayModel,
    a11y,
    /** Observable snapshot for the parity harness (candidate side). */
    observe() {
      const state = regionState();
      const model = displayModel();
      return observation({
        surfaceId: WEBHOOK_SURFACE_ID,
        side: 'candidate',
        visible: model.visible === true,
        regionState: state,
        loading: state === 'loading',
        empty: state === 'empty',
        error: state === 'error' ? { kind: error?.kind ?? 'network' } : null,
        interactions: interactionsFor(state),
        events: Object.freeze(state === 'ready' ? ['webhooks:rendered'] : []),
        accessibility: a11y(),
        localization: Object.freeze({ slot: WEBHOOK_MESSAGE_SLOT, locale }),
        contract: Object.freeze({ id: WEBHOOK_SURFACE_ID, version: WEBHOOK_SURFACE_VERSION }),
      });
    },
    /** Deterministic history, so two runs of the same script agree. */
    get history() {
      return Object.freeze(history.map((item) => Object.freeze({ ...item })));
    },
    get degradedEvents() {
      return degradedEvents;
    },
  });
}

/* -------------------------------------------------------- the reference model */

/**
 * The reference (pinned n8n editor) observations as deterministic fixtures. The
 * reference UI is not run here - these are the declared behaviours the candidate
 * is compared against. They mirror observe() field for field, and their
 * interactions come from the SAME webhookActionsFor rule the view-model uses,
 * so the two sides cannot drift by construction.
 */
function referenceObservation({ regionState: state, error = null, events = [], locale }) {
  return observation({
    surfaceId: WEBHOOK_SURFACE_ID,
    side: 'reference',
    visible: true,
    regionState: state,
    loading: state === 'loading',
    empty: state === 'empty',
    error,
    interactions: interactionsFor(state),
    events: Object.freeze(events),
    accessibility: WEBHOOK_A11Y[state],
    localization: Object.freeze({ slot: WEBHOOK_MESSAGE_SLOT, locale }),
    contract: Object.freeze({ id: WEBHOOK_SURFACE_ID, version: WEBHOOK_SURFACE_VERSION }),
  });
}

export function referenceLoadingObservation(locale = 'en') {
  return referenceObservation({ regionState: 'loading', locale });
}

export function referenceEmptyObservation({ reason = 'none', locale = 'en' } = {}) {
  if (!WEBHOOK_EMPTY_REASONS.includes(reason)) {
    throw new Error(`reason must be one of ${WEBHOOK_EMPTY_REASONS.join(', ')} (got "${reason}")`);
  }
  return referenceObservation({ regionState: 'empty', locale });
}

export function referenceReadyObservation(locale = 'en') {
  return referenceObservation({ regionState: 'ready', events: ['webhooks:rendered'], locale });
}

export function referenceErrorObservation({ errorKind = 'network', locale = 'en' } = {}) {
  return referenceObservation({ regionState: 'error', error: { kind: errorKind }, locale });
}
