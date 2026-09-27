/**
 * Credentials list pilot (P2-S09, issue #240) - the strangler slice for the
 * credentials list surface: the credential list, create/delete and
 * sharing-affordance interactions. One surface, one delivery scope.
 *
 * Security boundary (P5 owns the credential security domain; finding-only,
 * never modified here): CREDENTIAL VALUES NEVER REACH THIS SURFACE. The handed-
 * over row shape carries identity metadata only (id, name, type, createdAt,
 * shared); a row carrying a value-bearing field is refused with an explicit
 * error, not silently dropped. The value-entry editor and the P5/P2.27 envelope
 * stay with the reference UI and the credential runtime - out of this slice.
 *
 * Boundary (invariant 5): rows are HANDED OVER (inputBoundary source hand-over).
 * The surface never fetches /rest/credentials and never mutates credential data -
 * create/delete/share are DECLARED interactions returning explicit results.
 * loadSuccess() is the only data entry point.
 *
 * Closed contracts (invariants 4 and 7): the four region states are exactly the
 * shared REGION_STATES; the visibility filter is a closed vocabulary; a list
 * filtered to zero and a list with no credentials are BOTH empty at the region
 * level (reason none vs filtered), never a fifth state.
 *
 * Pilot (invariants 1 and 9): the original n8n editor stays the default path;
 * rollback is switching the pilot off with no residual state
 * (rollbackStrategy: pilot-not-primary in the surface-migrations manifest).
 */
import { observation } from './parity.mjs';
import { REGION_STATES } from './surface-contract.mjs';

export const CREDENTIALS_STATES = REGION_STATES;

export const CREDENTIALS_SURFACE_ID = 'credentials';
export const CREDENTIALS_SURFACE_VERSION = 'p1';
export const CREDENTIALS_MESSAGE_SLOT = 'validation-errors';

/** Closed action vocabulary: what the user may ask for in a state (declared). */
export const CREDENTIALS_ACTIONS = Object.freeze(['refresh', 'create', 'delete', 'share', 'clear-filter']);

/** Closed visibility-filter vocabulary. */
export const CREDENTIALS_VISIBILITY = Object.freeze(['all', 'shared', 'private']);

/** Closed request-result vocabulary: every request outcome is explicit. */
export const CREDENTIALS_REQUEST_RESULTS = Object.freeze(['requested', 'unknown-id', 'not-ready']);

/** Closed empty reasons. */
export const CREDENTIALS_EMPTY_REASONS = Object.freeze(['none', 'filtered']);

/** Default visible cap and the hard maximum a caller can request. */
export const CREDENTIALS_MAX_VISIBLE_DEFAULT = 20;
export const CREDENTIALS_MAX_VISIBLE_HARD_MAX = 50;

/** Closed row shape: identity metadata only - never a credential value. */
const ROW_KEYS = Object.freeze(['id', 'name', 'type', 'createdAt', 'shared']);

/**
 * Fields that would carry a credential value or secret material. A row bearing
 * any of them is refused with an explicit security error - fail-closed, never
 * dropped silently.
 */
const VALUE_BEARING_KEYS = Object.freeze([
  'value', 'values', 'data', 'password', 'token', 'secret', 'oauthToken', 'encrypted', 'key',
]);

function assertRow(row, index) {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) {
    throw new Error(`credential row ${index} must be an object`);
  }
  const keys = Object.keys(row);
  for (const key of keys) {
    if (VALUE_BEARING_KEYS.includes(key)) {
      throw new Error(
        `credential row ${index} carries the value-bearing field ${key}: credential values never reach this surface (P5/P2.27 envelope boundary)`,
      );
    }
  }
  const sorted = keys.sort();
  if (sorted.join(',') !== [...ROW_KEYS].sort().join(',')) {
    throw new Error(`credential row ${index} must have exactly ${ROW_KEYS.join(',')} (got ${sorted.join(',')})`);
  }
  for (const key of ['id', 'name', 'type', 'createdAt']) {
    if (typeof row[key] !== 'string' || row[key].trim() === '') {
      throw new Error(`credential row ${index} field ${key} must be a non-empty string`);
    }
  }
  if (typeof row.shared !== 'boolean') {
    throw new Error(`credential row ${index} field shared must be a boolean`);
  }
}

/** The declared surface contract: states keyed on REGION_STATES exactly. */
export function credentialsSurfaceContract() {
  return Object.freeze({
    id: CREDENTIALS_SURFACE_ID,
    version: CREDENTIALS_SURFACE_VERSION,
    inputBoundary: Object.freeze({
      source: 'hand-over',
      entryPoint: 'loadSuccess',
      mutatesCredentialData: false,
      carriesValues: false,
    }),
    states: Object.freeze(
      Object.fromEntries(REGION_STATES.map((state) => [state, Object.freeze({ state })])),
    ),
    vocabularies: Object.freeze({
      actions: CREDENTIALS_ACTIONS,
      visibility: CREDENTIALS_VISIBILITY,
      requestResults: CREDENTIALS_REQUEST_RESULTS,
      emptyReasons: CREDENTIALS_EMPTY_REASONS,
    }),
    bounds: Object.freeze({
      maxVisibleDefault: CREDENTIALS_MAX_VISIBLE_DEFAULT,
      maxVisibleHardMax: CREDENTIALS_MAX_VISIBLE_HARD_MAX,
    }),
  });
}

/**
 * The a11y intent is derived ONCE here, so the contract's declared observables
 * and the view-model's rendered attributes cannot drift. Only error is
 * aria-live assertive; only loading is aria-busy; the ready list is announced
 * politely so a background refresh does not interrupt.
 */
export const CREDENTIALS_A11Y = Object.freeze(
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
 * Create the credentials-list view-model. Rows enter ONLY through loadSuccess()
 * (hand-over); the surface performs no fetch and no credential-data mutation.
 */
export function createCredentialsSurface(options = {}) {
  const locale = options.locale ?? 'en';
  const requestedMax = options.maxVisible ?? CREDENTIALS_MAX_VISIBLE_DEFAULT;
  if (!Number.isInteger(requestedMax) || requestedMax <= 0) {
    throw new Error('maxVisible must be a positive integer');
  }
  const maxVisible = Math.min(requestedMax, CREDENTIALS_MAX_VISIBLE_HARD_MAX);
  const renderAvailable = options.renderAvailable ?? true;

  let rows = Object.freeze([]);
  let region = 'loading';
  let visibility = 'all';
  let error = null;
  let degradedEvents = 0;
  const history = [];

  function pushEvent(name) {
    history.push({ at: history.length, name });
    if (!renderAvailable) degradedEvents += 1;
  }

  function matchesVisibility(row) {
    if (visibility === 'all') return true;
    return visibility === 'shared' ? row.shared === true : row.shared === false;
  }

  function visibleRows() {
    return rows.filter(matchesVisibility);
  }

  function regionState() {
    return region;
  }

  function displayModel() {
    const visible = visibleRows();
    const shown = visible.slice(0, maxVisible);
    return Object.freeze({
      visible: true,
      visibleCount: visible.length,
      shown: Object.freeze(shown.map((row) => Object.freeze({ ...row }))),
      truncated: visible.length > shown.length,
      total: rows.length,
      visibility,
      reason: region === 'empty' ? (visibility !== 'all' ? 'filtered' : 'none') : null,
      actions: Object.freeze(
        region === 'error'
          ? ['refresh']
          : region === 'loading' || region === 'empty'
            ? []
            : [
                'refresh',
                'create',
                ...(visible.length > 0 ? ['delete', 'share'] : []),
                ...(visibility !== 'all' ? ['clear-filter'] : []),
              ],
      ),
    });
  }

  function a11y() {
    return CREDENTIALS_A11Y[regionState()];
  }

  return Object.freeze({
    id: CREDENTIALS_SURFACE_ID,
    contract: credentialsSurfaceContract(),
    maxVisible,
    /** The only data entry point (hand-over). Value-bearing rows are refused. */
    loadSuccess(nextRows) {
      if (!Array.isArray(nextRows)) {
        throw new Error('loadSuccess expects an array of credential rows');
      }
      nextRows.forEach(assertRow);
      rows = Object.freeze(nextRows.map((row) => Object.freeze({ ...row })));
      visibility = 'all';
      error = null;
      region = rows.length > 0 ? 'ready' : 'empty';
      pushEvent('loaded');
      if (!renderAvailable) degradedEvents += 1;
      return rows.length;
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
    /** Back to loading. Rows are retained but the region is loading. */
    setLoading() {
      region = 'loading';
      pushEvent('loading');
      return 'loading';
    },
    /**
     * The one observable mutation: the client-side visibility filter
     * (all / shared / private). Changes what is VISIBLE. Filtering to zero is
     * empty with reason filtered. An unknown value is refused.
     */
    setVisibility(next = 'all') {
      if (typeof next !== 'string' || !CREDENTIALS_VISIBILITY.includes(next)) {
        throw new Error(`visibility must be one of ${CREDENTIALS_VISIBILITY.join(', ')} (got "${next}")`);
      }
      visibility = next;
      if (region === 'ready' || region === 'empty') {
        region = visibleRows().length > 0 ? 'ready' : 'empty';
        if (visibility !== 'all') pushEvent('filtered');
      }
      return region;
    },
    /**
     * DECLARED, never executed: ask the app layer to create a credential. The
     * value-entry editor stays with the reference UI - this surface never sees
     * credential values (P5/P2.27 envelope boundary).
     */
    requestCreate() {
      if (region !== 'ready' && region !== 'empty') return 'not-ready';
      pushEvent('create-requested');
      return 'requested';
    },
    /** DECLARED, never executed: ask the app layer to delete a credential. */
    requestDelete(id) {
      if (typeof id !== 'string' || id.trim() === '') {
        throw new Error('requestDelete expects a non-empty credential id');
      }
      if (region !== 'ready') return 'not-ready';
      if (!rows.some((row) => row.id === id)) return 'unknown-id';
      pushEvent('delete-requested');
      return 'requested';
    },
    /** DECLARED, never executed: ask the app layer to open the sharing affordance. */
    requestShare(id) {
      if (typeof id !== 'string' || id.trim() === '') {
        throw new Error('requestShare expects a non-empty credential id');
      }
      if (region !== 'ready') return 'not-ready';
      if (!rows.some((row) => row.id === id)) return 'unknown-id';
      pushEvent('share-requested');
      return 'requested';
    },
    displayModel,
    a11y,
    /** Observable snapshot for the parity harness (candidate side). */
    observe() {
      const state = regionState();
      const model = displayModel();
      return observation({
        surfaceId: CREDENTIALS_SURFACE_ID,
        side: 'candidate',
        visible: model.visible === true,
        regionState: state,
        loading: state === 'loading',
        empty: state === 'empty',
        error: state === 'error' ? { kind: error?.kind ?? 'network' } : null,
        interactions: Object.freeze({
          refresh: model.actions.includes('refresh'),
          create: model.actions.includes('create'),
          delete: model.actions.includes('delete'),
          share: model.actions.includes('share'),
          clearFilter: model.actions.includes('clear-filter'),
        }),
        events: Object.freeze(state === 'ready' ? ['credentials:rendered'] : []),
        accessibility: a11y(),
        localization: Object.freeze({ slot: CREDENTIALS_MESSAGE_SLOT, locale }),
        contract: Object.freeze({ id: CREDENTIALS_SURFACE_ID, version: CREDENTIALS_SURFACE_VERSION }),
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
 * is compared against. They mirror observe() field for field, which is what
 * makes the parity harness fail-closed: a fixture that drifts from the
 * candidate is a bug.
 */
export function referenceLoadingObservation(locale = 'en') {
  return observation({
    surfaceId: CREDENTIALS_SURFACE_ID,
    side: 'reference',
    visible: true,
    regionState: 'loading',
    loading: true,
    empty: false,
    error: null,
    interactions: Object.freeze({ refresh: false, create: false, delete: false, share: false, clearFilter: false }),
    events: Object.freeze([]),
    accessibility: CREDENTIALS_A11Y.loading,
    localization: Object.freeze({ slot: CREDENTIALS_MESSAGE_SLOT, locale }),
    contract: Object.freeze({ id: CREDENTIALS_SURFACE_ID, version: CREDENTIALS_SURFACE_VERSION }),
  });
}

export function referenceEmptyObservation({ reason = 'none', locale = 'en' } = {}) {
  return observation({
    surfaceId: CREDENTIALS_SURFACE_ID,
    side: 'reference',
    visible: true,
    regionState: 'empty',
    loading: false,
    empty: true,
    error: null,
    interactions: Object.freeze({
      refresh: false,
      create: false,
      delete: false,
      share: false,
      clearFilter: reason === 'filtered',
    }),
    events: Object.freeze([]),
    accessibility: CREDENTIALS_A11Y.empty,
    localization: Object.freeze({ slot: CREDENTIALS_MESSAGE_SLOT, locale }),
    contract: Object.freeze({ id: CREDENTIALS_SURFACE_ID, version: CREDENTIALS_SURFACE_VERSION }),
  });
}

export function referenceReadyObservation(locale = 'en') {
  return observation({
    surfaceId: CREDENTIALS_SURFACE_ID,
    side: 'reference',
    visible: true,
    regionState: 'ready',
    loading: false,
    empty: false,
    error: null,
    interactions: Object.freeze({ refresh: true, create: true, delete: true, share: true, clearFilter: false }),
    events: Object.freeze(['credentials:rendered']),
    accessibility: CREDENTIALS_A11Y.ready,
    localization: Object.freeze({ slot: CREDENTIALS_MESSAGE_SLOT, locale }),
    contract: Object.freeze({ id: CREDENTIALS_SURFACE_ID, version: CREDENTIALS_SURFACE_VERSION }),
  });
}

export function referenceErrorObservation({ errorKind = 'network', locale = 'en' } = {}) {
  return observation({
    surfaceId: CREDENTIALS_SURFACE_ID,
    side: 'reference',
    visible: true,
    regionState: 'error',
    loading: false,
    empty: false,
    error: { kind: errorKind },
    interactions: Object.freeze({ refresh: true, create: false, delete: false, share: false, clearFilter: false }),
    events: Object.freeze([]),
    accessibility: CREDENTIALS_A11Y.error,
    localization: Object.freeze({ slot: CREDENTIALS_MESSAGE_SLOT, locale }),
    contract: Object.freeze({ id: CREDENTIALS_SURFACE_ID, version: CREDENTIALS_SURFACE_VERSION }),
  });
}
