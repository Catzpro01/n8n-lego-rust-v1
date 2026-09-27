/**
 * Node picker / catalog pilot (P2-S07, issue #240) - the strangler slice for the
 * palette surface of the workflow editor. One surface, one delivery scope: a
 * bounded, query-filterable view-model of the node picker.
 *
 * Boundary (invariant 5): node types are HANDED OVER (inputBoundary source
 * hand-over). The surface never fetches /rest/types/nodes.json or
 * /types/nodes.json, so it holds no private data path and no second source of
 * truth for the node catalog - the node-registry capability stays with the app
 * layer. loadSuccess() is the only row entry point.
 *
 * Closed contracts (issue #240 invariants 4 and 7): the four region states are
 * exactly the shared REGION_STATES the parity harness compares; the category
 * vocabulary is the closed NODE_PICKER_CATEGORIES; a picker filtered down to
 * nothing and a picker with no nodes are BOTH empty at the region level, the
 * difference is carried in the display model's reason (none vs filtered), never
 * invented as a fifth state.
 *
 * Pilot (invariants 1 and 9): the original n8n editor stays the default path;
 * rollback is switching the pilot off with no residual state
 * (rollbackStrategy: pilot-not-primary in the surface-migrations manifest).
 */
import { observation } from './parity.mjs';
import { REGION_STATES } from './surface-contract.mjs';

/** Closed region states, pinned to the shared vocabulary (no fifth state). */
export const NODE_PICKER_STATES = REGION_STATES;

export const NODE_PICKER_SURFACE_ID = 'node-picker';
export const NODE_PICKER_SURFACE_VERSION = 'p1';
export const NODE_PICKER_MESSAGE_SLOT = 'empty-states';

/** Closed category vocabulary. An unknown category is refused, not coerced. */
export const NODE_PICKER_CATEGORIES = Object.freeze(['trigger', 'action', 'transform', 'utility']);

/** Closed selection-result vocabulary: every select() outcome is explicit. */
export const NODE_PICKER_SELECT_RESULTS = Object.freeze(['selected', 'unknown-id', 'not-ready']);

/** Default visible cap and the hard maximum a caller can request. */
export const NODE_PICKER_MAX_VISIBLE_DEFAULT = 20;
export const NODE_PICKER_MAX_VISIBLE_HARD_MAX = 50;

/** Closed row shape: a row outside this shape is refused, never silently dropped. */
const ROW_KEYS = Object.freeze(['id', 'name', 'description', 'category']);

function assertRow(row, index) {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) {
    throw new Error(`node picker row ${index} must be an object`);
  }
  const keys = Object.keys(row).sort();
  if (keys.join(',') !== [...ROW_KEYS].sort().join(',')) {
    throw new Error(`node picker row ${index} must have exactly ${ROW_KEYS.join(',')} (got ${keys.join(',')})`);
  }
  for (const key of ['id', 'name', 'description', 'category']) {
    if (typeof row[key] !== 'string' || row[key].trim() === '') {
      throw new Error(`node picker row ${index} field ${key} must be a non-empty string`);
    }
  }
  if (!NODE_PICKER_CATEGORIES.includes(row.category)) {
    throw new Error(`node picker row ${index} category must be one of ${NODE_PICKER_CATEGORIES.join(', ')} (got "${row.category}")`);
  }
}

/** The declared surface contract: states keyed on REGION_STATES exactly. */
export function nodePickerSurfaceContract() {
  return Object.freeze({
    id: NODE_PICKER_SURFACE_ID,
    version: NODE_PICKER_SURFACE_VERSION,
    inputBoundary: Object.freeze({ source: 'hand-over', entryPoint: 'loadSuccess' }),
    states: Object.freeze(
      Object.fromEntries(REGION_STATES.map((state) => [state, Object.freeze({ state })])),
    ),
    vocabularies: Object.freeze({
      categories: NODE_PICKER_CATEGORIES,
      selectResults: NODE_PICKER_SELECT_RESULTS,
      emptyReasons: Object.freeze(['none', 'filtered']),
    }),
    bounds: Object.freeze({
      maxVisibleDefault: NODE_PICKER_MAX_VISIBLE_DEFAULT,
      maxVisibleHardMax: NODE_PICKER_MAX_VISIBLE_HARD_MAX,
    }),
  });
}

/**
 * The a11y intent is derived ONCE here, so the contract's declared observables
 * and the view-model's rendered attributes cannot drift. Only error is
 * aria-live assertive; only loading is aria-busy; the ready list is announced
 * politely so a background refresh does not interrupt.
 */
export const NODE_PICKER_A11Y = Object.freeze(
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
 * Create the node-picker view-model. Rows enter ONLY through loadSuccess()
 * (hand-over); the surface performs no fetch of any node-catalog endpoint.
 */
export function createNodePickerSurface(options = {}) {
  const locale = options.locale ?? 'en';
  const requestedMax = options.maxVisible ?? NODE_PICKER_MAX_VISIBLE_DEFAULT;
  if (!Number.isInteger(requestedMax) || requestedMax <= 0) {
    throw new Error('maxVisible must be a positive integer');
  }
  const maxVisible = Math.min(requestedMax, NODE_PICKER_MAX_VISIBLE_HARD_MAX);
  const renderAvailable = options.renderAvailable ?? true;

  let rows = Object.freeze([]);
  let region = 'loading';
  let query = '';
  let error = null;
  let selectedId = null;
  let degradedEvents = 0;
  const history = [];

  function pushEvent(name) {
    history.push({ at: history.length, name });
    if (!renderAvailable) degradedEvents += 1;
  }

  function matchesQuery(row) {
    if (query === '') return true;
    const q = query.trim().toLowerCase();
    return row.name.toLowerCase().includes(q) || row.description.toLowerCase().includes(q);
  }

  function visibleRows() {
    return rows.filter(matchesQuery);
  }

  function regionState() {
    return region;
  }

  function displayModel() {
    const visible = visibleRows();
    const shown = visible.slice(0, maxVisible);
    const isFiltered = query !== '';
    return Object.freeze({
      visible: true,
      visibleCount: visible.length,
      shown: Object.freeze(shown.map((row) => Object.freeze({ ...row }))),
      truncated: visible.length > shown.length,
      total: rows.length,
      query,
      selectedId,
      reason: visible.length === 0 ? (isFiltered ? 'filtered' : 'none') : 'none',
      actions: Object.freeze(
        region === 'error'
          ? ['refresh']
          : region === 'loading'
            ? []
            : [
                'refresh',
                'add',
                ...(visible.length > 0 ? ['select'] : []),
                ...(isFiltered ? ['clear-query'] : []),
              ],
      ),
    });
  }

  function a11y() {
    return NODE_PICKER_A11Y[regionState()];
  }

  return Object.freeze({
    id: NODE_PICKER_SURFACE_ID,
    contract: nodePickerSurfaceContract(),
    maxVisible,
    /** The only row entry point (hand-over). Unknown shapes are refused. */
    loadSuccess(nextRows) {
      if (!Array.isArray(nextRows)) {
        throw new Error('loadSuccess expects an array of node-type rows');
      }
      nextRows.forEach(assertRow);
      rows = Object.freeze(nextRows.map((row) => Object.freeze({ ...row })));
      query = '';
      selectedId = null;
      error = null;
      region = rows.length > 0 ? 'ready' : 'empty';
      pushEvent('loaded');
      if (!renderAvailable) degradedEvents += 1;
      return rows.length;
    },
    /** The fetch failed. The only assertive region state. */
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
    /** Back to fetching. Rows are retained but the region is loading. */
    setLoading() {
      region = 'loading';
      pushEvent('loading');
      return 'loading';
    },
    /**
     * The one observable mutation: the client-side query filter. Changes what
     * is VISIBLE. Filtering to zero is empty with reason filtered. The query is
     * a plain string; an unknown category filter is refused through the closed
     * vocabulary rule.
     */
    setQuery(nextQuery = '') {
      if (typeof nextQuery !== 'string') {
        throw new Error('query must be a string');
      }
      query = nextQuery;
      if (region === 'ready' || region === 'empty') {
        region = visibleRows().length > 0 ? 'ready' : 'empty';
        if (query !== '') pushEvent('filtered');
      }
      return region;
    },
    /**
     * A declared interaction, never executed silently: selecting a node type
     * returns one of the closed NODE_PICKER_SELECT_RESULTS. Selecting while not
     * ready is refused with 'not-ready' - never a quiet no-op.
     */
    select(id) {
      if (typeof id !== 'string' || id.trim() === '') {
        throw new Error('select expects a non-empty node-type id');
      }
      if (region !== 'ready' && region !== 'empty') {
        return 'not-ready';
      }
      if (!rows.some((row) => row.id === id)) {
        return 'unknown-id';
      }
      selectedId = id;
      pushEvent('selected');
      return 'selected';
    },
    displayModel,
    a11y,
    /** Observable snapshot for the parity harness (candidate side). */
    observe() {
      const state = regionState();
      const model = displayModel();
      return observation({
        surfaceId: NODE_PICKER_SURFACE_ID,
        side: 'candidate',
        visible: model.visible === true,
        regionState: state,
        loading: state === 'loading',
        empty: state === 'empty',
        error: state === 'error' ? { kind: error?.kind ?? 'network' } : null,
        interactions: Object.freeze({
          refresh: model.actions.includes('refresh'),
          add: model.actions.includes('add'),
          select: model.actions.includes('select'),
          clearQuery: model.actions.includes('clear-query'),
        }),
        events: Object.freeze(state === 'ready' ? ['node-picker:rendered'] : []),
        accessibility: a11y(),
        localization: Object.freeze({ slot: NODE_PICKER_MESSAGE_SLOT, locale }),
        contract: Object.freeze({ id: NODE_PICKER_SURFACE_ID, version: NODE_PICKER_SURFACE_VERSION }),
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
    surfaceId: NODE_PICKER_SURFACE_ID,
    side: 'reference',
    visible: true,
    regionState: 'loading',
    loading: true,
    empty: false,
    error: null,
    interactions: Object.freeze({ refresh: false, add: false, select: false, clearQuery: false }),
    events: Object.freeze([]),
    accessibility: NODE_PICKER_A11Y.loading,
    localization: Object.freeze({ slot: NODE_PICKER_MESSAGE_SLOT, locale }),
    contract: Object.freeze({ id: NODE_PICKER_SURFACE_ID, version: NODE_PICKER_SURFACE_VERSION }),
  });
}

export function referenceEmptyObservation({ reason = 'none', locale = 'en' } = {}) {
  return observation({
    surfaceId: NODE_PICKER_SURFACE_ID,
    side: 'reference',
    visible: true,
    regionState: 'empty',
    loading: false,
    empty: true,
    error: null,
    interactions: Object.freeze({
      refresh: true,
      add: true,
      select: false,
      clearQuery: reason === 'filtered',
    }),
    events: Object.freeze([]),
    accessibility: NODE_PICKER_A11Y.empty,
    localization: Object.freeze({ slot: NODE_PICKER_MESSAGE_SLOT, locale }),
    contract: Object.freeze({ id: NODE_PICKER_SURFACE_ID, version: NODE_PICKER_SURFACE_VERSION }),
  });
}

export function referenceReadyObservation(locale = 'en') {
  return observation({
    surfaceId: NODE_PICKER_SURFACE_ID,
    side: 'reference',
    visible: true,
    regionState: 'ready',
    loading: false,
    empty: false,
    error: null,
    interactions: Object.freeze({ refresh: true, add: true, select: true, clearQuery: false }),
    events: Object.freeze(['node-picker:rendered']),
    accessibility: NODE_PICKER_A11Y.ready,
    localization: Object.freeze({ slot: NODE_PICKER_MESSAGE_SLOT, locale }),
    contract: Object.freeze({ id: NODE_PICKER_SURFACE_ID, version: NODE_PICKER_SURFACE_VERSION }),
  });
}

export function referenceErrorObservation({ errorKind = 'network', locale = 'en' } = {}) {
  return observation({
    surfaceId: NODE_PICKER_SURFACE_ID,
    side: 'reference',
    visible: true,
    regionState: 'error',
    loading: false,
    empty: false,
    error: { kind: errorKind },
    interactions: Object.freeze({ refresh: true, add: false, select: false, clearQuery: false }),
    events: Object.freeze([]),
    accessibility: NODE_PICKER_A11Y.error,
    localization: Object.freeze({ slot: NODE_PICKER_MESSAGE_SLOT, locale }),
    contract: Object.freeze({ id: NODE_PICKER_SURFACE_ID, version: NODE_PICKER_SURFACE_VERSION }),
  });
}
