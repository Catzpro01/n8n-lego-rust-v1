/**
 * Settings panels pilot (P2-S10, issue #240) - the strangler slice for the
 * settings surface: the instance and personal settings panels. One surface,
 * one delivery scope.
 *
 * Boundary (invariants 4-5): settings values are HANDED OVER (inputBoundary
 * source hand-over) through declared settings capabilities only. The surface
 * holds no private data path and no second source of truth: it never fetches
 * settings and never mutates settings data - save/reset are DECLARED
 * interactions returning explicit results. loadSuccess() is the only data
 * entry point.
 *
 * Security boundary (settings can carry secret material; P2.27/P5 own secret
 * handling, finding-only here): SECRET MATERIAL NEVER REACHES THIS SURFACE.
 * An entry carrying a secret-bearing field (password, token, apiKey, ...) is
 * refused with an explicit security error, never silently dropped; a value
 * that is not a scalar is refused for the same reason. Secret-valued settings
 * stay with the reference UI and the secret runtime.
 *
 * Closed contracts (invariants 4 and 7): the four region states are exactly
 * the shared REGION_STATES; the panel vocabulary (instance / personal) is
 * closed; an empty panel filtered away from the default panel is empty with
 * reason filtered, never a fifth state.
 *
 * Pilot (invariants 1 and 9): the original n8n editor stays the default path;
 * rollback is switching the pilot off with no residual state
 * (rollbackStrategy: pilot-not-primary in the surface-migrations manifest).
 */
import { observation } from './parity.mjs';
import { REGION_STATES } from './surface-contract.mjs';

export const SETTINGS_STATES = REGION_STATES;

export const SETTINGS_SURFACE_ID = 'settings';
export const SETTINGS_SURFACE_VERSION = 'p1';
export const SETTINGS_MESSAGE_SLOT = 'settings';

/** Closed panel vocabulary: the two settings panels this surface carries. */
export const SETTINGS_PANELS = Object.freeze(['instance', 'personal']);
export const SETTINGS_DEFAULT_PANEL = 'instance';

/** Closed action vocabulary: what the user may ask for in a state (declared). */
export const SETTINGS_ACTIONS = Object.freeze(['refresh', 'save', 'reset', 'switch-panel']);

/** Closed request-result vocabulary: every request outcome is explicit. */
export const SETTINGS_REQUEST_RESULTS = Object.freeze(['requested', 'unknown-id', 'not-ready']);

/** Closed empty reasons. */
export const SETTINGS_EMPTY_REASONS = Object.freeze(['none', 'filtered']);

/** Default visible cap and the hard maximum a caller can request. */
export const SETTINGS_MAX_VISIBLE_DEFAULT = 20;
export const SETTINGS_MAX_VISIBLE_HARD_MAX = 50;

/** Closed entry shape: identity + panel + section + one scalar value. */
const ENTRY_KEYS = Object.freeze(['id', 'panel', 'section', 'value']);

/**
 * Fields that would carry secret material. An entry bearing any of them is
 * refused with an explicit security error - fail-closed, never dropped.
 */
const SECRET_BEARING_KEYS = Object.freeze([
  'secret', 'password', 'token', 'apiKey', 'apikey', 'credentials',
  'privateKey', 'encrypted', 'oauthToken', 'smtpPass', 'key', 'hash',
]);

/** A settings value is a scalar. A structured value could smuggle secrets. */
function isScalar(value) {
  return typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number';
}

function assertEntry(entry, index) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error(`settings entry ${index} must be an object`);
  }
  const keys = Object.keys(entry);
  for (const key of keys) {
    if (SECRET_BEARING_KEYS.includes(key)) {
      throw new Error(
        `settings entry ${index} carries the secret-bearing field ${key}: secret material never reaches this surface (P2.27/P5 secret boundary)`,
      );
    }
  }
  const sorted = keys.sort();
  if (sorted.join(',') !== [...ENTRY_KEYS].sort().join(',')) {
    throw new Error(`settings entry ${index} must have exactly ${ENTRY_KEYS.join(',')} (got ${sorted.join(',')})`);
  }
  for (const key of ['id', 'section']) {
    if (typeof entry[key] !== 'string' || entry[key].trim() === '') {
      throw new Error(`settings entry ${index} field ${key} must be a non-empty string`);
    }
  }
  if (typeof entry.panel !== 'string' || !SETTINGS_PANELS.includes(entry.panel)) {
    throw new Error(`settings entry ${index} field panel must be one of ${SETTINGS_PANELS.join(', ')} (got "${entry.panel}")`);
  }
  if (!isScalar(entry.value)) {
    throw new Error(
      `settings entry ${index} field value must be a scalar (string, boolean or number): a structured value is refused (it could carry secret material)`,
    );
  }
}

/** The declared surface contract: states keyed on REGION_STATES exactly. */
export function settingsSurfaceContract() {
  return Object.freeze({
    id: SETTINGS_SURFACE_ID,
    version: SETTINGS_SURFACE_VERSION,
    inputBoundary: Object.freeze({
      source: 'hand-over',
      entryPoint: 'loadSuccess',
      mutatesSettingsData: false,
      carriesSecrets: false,
    }),
    states: Object.freeze(
      Object.fromEntries(REGION_STATES.map((state) => [state, Object.freeze({ state })])),
    ),
    vocabularies: Object.freeze({
      panels: SETTINGS_PANELS,
      actions: SETTINGS_ACTIONS,
      requestResults: SETTINGS_REQUEST_RESULTS,
      emptyReasons: SETTINGS_EMPTY_REASONS,
    }),
    bounds: Object.freeze({
      maxVisibleDefault: SETTINGS_MAX_VISIBLE_DEFAULT,
      maxVisibleHardMax: SETTINGS_MAX_VISIBLE_HARD_MAX,
    }),
  });
}

/**
 * The a11y intent is derived ONCE here, so the contract's declared observables
 * and the view-model's rendered attributes cannot drift. Only error is
 * aria-live assertive; only loading is aria-busy; the ready form is announced
 * politely so a background refresh does not interrupt.
 */
export const SETTINGS_A11Y = Object.freeze(
  Object.fromEntries(
    REGION_STATES.map((state) => [
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
export function settingsActionsFor(region) {
  if (region === 'error') return Object.freeze(['refresh']);
  if (region === 'loading') return Object.freeze([]);
  if (region === 'empty') return Object.freeze(['switch-panel']);
  return Object.freeze(['refresh', 'save', 'reset', 'switch-panel']);
}

function interactionsFor(region) {
  const actions = settingsActionsFor(region);
  return Object.freeze({
    refresh: actions.includes('refresh'),
    save: actions.includes('save'),
    reset: actions.includes('reset'),
    switchPanel: actions.includes('switch-panel'),
  });
}

/**
 * Create the settings-panels view-model. Entries enter ONLY through
 * loadSuccess() (hand-over); the surface performs no fetch and no
 * settings-data mutation.
 */
export function createSettingsSurface(options = {}) {
  const locale = options.locale ?? 'en';
  const requestedMax = options.maxVisible ?? SETTINGS_MAX_VISIBLE_DEFAULT;
  if (!Number.isInteger(requestedMax) || requestedMax <= 0) {
    throw new Error('maxVisible must be a positive integer');
  }
  const maxVisible = Math.min(requestedMax, SETTINGS_MAX_VISIBLE_HARD_MAX);
  const renderAvailable = options.renderAvailable ?? true;

  let entries = Object.freeze([]);
  let region = 'loading';
  let panel = SETTINGS_DEFAULT_PANEL;
  let error = null;
  let degradedEvents = 0;
  const history = [];

  function pushEvent(name) {
    history.push({ at: history.length, name });
    if (!renderAvailable) degradedEvents += 1;
  }

  function panelEntries() {
    return entries.filter((entry) => entry.panel === panel);
  }

  function regionState() {
    return region;
  }

  function displayModel() {
    const visible = panelEntries();
    const shown = visible.slice(0, maxVisible);
    return Object.freeze({
      visible: true,
      visibleCount: visible.length,
      shown: Object.freeze(shown.map((entry) => Object.freeze({ ...entry }))),
      truncated: visible.length > shown.length,
      total: entries.length,
      panel,
      reason: region === 'empty' ? (panel !== SETTINGS_DEFAULT_PANEL ? 'filtered' : 'none') : null,
      actions: settingsActionsFor(region),
    });
  }

  function a11y() {
    return SETTINGS_A11Y[regionState()];
  }

  return Object.freeze({
    id: SETTINGS_SURFACE_ID,
    contract: settingsSurfaceContract(),
    maxVisible,
    /** The only data entry point (hand-over). Secret-bearing entries are refused. */
    loadSuccess(nextEntries) {
      if (!Array.isArray(nextEntries)) {
        throw new Error('loadSuccess expects an array of settings entries');
      }
      nextEntries.forEach(assertEntry);
      entries = Object.freeze(nextEntries.map((entry) => Object.freeze({ ...entry })));
      panel = SETTINGS_DEFAULT_PANEL;
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
     * The one observable mutation: the panel switch (instance / personal).
     * Changes what is VISIBLE. A panel with no entries is empty with reason
     * filtered when it is not the default panel. An unknown value is refused.
     */
    setPanel(next = SETTINGS_DEFAULT_PANEL) {
      if (typeof next !== 'string' || !SETTINGS_PANELS.includes(next)) {
        throw new Error(`panel must be one of ${SETTINGS_PANELS.join(', ')} (got "${next}")`);
      }
      if (next !== panel) {
        panel = next;
        pushEvent('switched-panel');
      }
      if (region === 'ready' || region === 'empty') {
        region = panelEntries().length > 0 ? 'ready' : 'empty';
      }
      return region;
    },
    /**
     * DECLARED, never executed: ask the app layer to save a setting. The
     * surface never mutates settings data - the value write stays with the
     * settings runtime and the reference UI.
     */
    requestSave(id) {
      if (typeof id !== 'string' || id.trim() === '') {
        throw new Error('requestSave expects a non-empty settings id');
      }
      if (region !== 'ready') return 'not-ready';
      if (!entries.some((entry) => entry.id === id)) return 'unknown-id';
      pushEvent('save-requested');
      return 'requested';
    },
    /** DECLARED, never executed: ask the app layer to reset a setting to default. */
    requestReset(id) {
      if (typeof id !== 'string' || id.trim() === '') {
        throw new Error('requestReset expects a non-empty settings id');
      }
      if (region !== 'ready') return 'not-ready';
      if (!entries.some((entry) => entry.id === id)) return 'unknown-id';
      pushEvent('reset-requested');
      return 'requested';
    },
    displayModel,
    a11y,
    /** Observable snapshot for the parity harness (candidate side). */
    observe() {
      const state = regionState();
      const model = displayModel();
      return observation({
        surfaceId: SETTINGS_SURFACE_ID,
        side: 'candidate',
        visible: model.visible === true,
        regionState: state,
        loading: state === 'loading',
        empty: state === 'empty',
        error: state === 'error' ? { kind: error?.kind ?? 'network' } : null,
        interactions: interactionsFor(state),
        events: Object.freeze(state === 'ready' ? ['settings:rendered'] : []),
        accessibility: a11y(),
        localization: Object.freeze({ slot: SETTINGS_MESSAGE_SLOT, locale }),
        contract: Object.freeze({ id: SETTINGS_SURFACE_ID, version: SETTINGS_SURFACE_VERSION }),
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
 * interactions come from the SAME settingsActionsFor rule the view-model uses,
 * so the two sides cannot drift by construction.
 */
function referenceObservation({ regionState: state, error = null, events = [], locale }) {
  return observation({
    surfaceId: SETTINGS_SURFACE_ID,
    side: 'reference',
    visible: true,
    regionState: state,
    loading: state === 'loading',
    empty: state === 'empty',
    error,
    interactions: interactionsFor(state),
    events: Object.freeze(events),
    accessibility: SETTINGS_A11Y[state],
    localization: Object.freeze({ slot: SETTINGS_MESSAGE_SLOT, locale }),
    contract: Object.freeze({ id: SETTINGS_SURFACE_ID, version: SETTINGS_SURFACE_VERSION }),
  });
}

export function referenceLoadingObservation(locale = 'en') {
  return referenceObservation({ regionState: 'loading', locale });
}

export function referenceEmptyObservation({ reason = 'none', locale = 'en' } = {}) {
  if (!SETTINGS_EMPTY_REASONS.includes(reason)) {
    throw new Error(`reason must be one of ${SETTINGS_EMPTY_REASONS.join(', ')} (got "${reason}")`);
  }
  return referenceObservation({ regionState: 'empty', locale });
}

export function referenceReadyObservation(locale = 'en') {
  return referenceObservation({ regionState: 'ready', events: ['settings:rendered'], locale });
}

export function referenceErrorObservation({ errorKind = 'network', locale = 'en' } = {}) {
  return referenceObservation({ regionState: 'error', error: { kind: errorKind }, locale });
}
