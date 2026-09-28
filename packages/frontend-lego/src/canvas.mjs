/**
 * Canvas surface pilot (P2-S14, issue #240) - the strangler slice for the
 * workflow node-graph rendering surface (nodes, edges, viewport, selection),
 * split out of P2-S03 as the composite region of the workflow editor. One
 * surface, one delivery scope.
 *
 * Boundary (invariants 4-5): the graph model is HANDED OVER (inputBoundary
 * source hand-over) through declared capabilities only. The surface holds no
 * private data path and no second source of truth: it never fetches a graph,
 * PERFORMS NO ENGINE CALL (node execution, run data and workflow state stay
 * with the workflow engine; selection and zoom are DECLARED interactions
 * returning explicit results) and never re-derives the graph locally.
 *
 * Security boundary (the load-bearing rule): ENGINE AUTHORITY NEVER REACHES
 * THIS SURFACE. The surface renders what the hand-over carried; it never
 * executes a node, never posts a workflow and never mutates the graph - a
 * payload or node carrying a secret-bearing field is refused with an explicit
 * security error, never silently dropped.
 *
 * Closed contracts (invariants 4 and 7): the four region states are exactly
 * the shared REGION_STATES; an empty graph is empty with reason none, never a
 * fifth state; zoom is bounded [0.25, 4] with an explicit out-of-bounds
 * result, never silently clamped; selection is single and closed.
 *
 * Pilot (invariants 1 and 9): the original n8n editor stays the default path;
 * rollback is switching the pilot off with no residual state and no
 * workflow-data migration (rollbackStrategy: pilot-not-primary in the
 * surface-migrations manifest).
 */
import { observation } from './parity.mjs';
import { REGION_STATES } from './surface-contract.mjs';

export const CANVAS_STATES = REGION_STATES;

export const CANVAS_SURFACE_ID = 'canvas';
export const CANVAS_SURFACE_VERSION = 'p1';
export const CANVAS_MESSAGE_SLOT = 'canvas';

/** Closed empty reason: an empty graph is none, never a fifth state. */
export const CANVAS_EMPTY_REASONS = Object.freeze(['none']);

/** Closed action vocabulary: what the user may ask for in a state (declared). */
export const CANVAS_ACTIONS = Object.freeze([
  'refresh', 'select-node', 'clear-selection', 'set-zoom',
]);

/**
 * Closed request-result vocabularies: every declared outcome is explicit.
 * selected means the selection VIEW changed - the graph data never changes
 * here (the engine and the editor own the workflow document).
 */
export const CANVAS_SELECT_RESULTS = Object.freeze([
  'selected', 'unknown-node', 'same-node', 'not-ready',
]);
export const CANVAS_CLEAR_RESULTS = Object.freeze(['cleared', 'no-selection', 'not-ready']);
export const CANVAS_ZOOM_RESULTS = Object.freeze(['zoomed', 'out-of-bounds', 'not-ready']);

/** Zoom bounds: the reference editor's usable zoom range, pinned here. */
export const CANVAS_ZOOM_MIN = 0.25;
export const CANVAS_ZOOM_MAX = 4;
export const CANVAS_DEFAULT_VIEWPORT = Object.freeze({ x: 0, y: 0, zoom: 1 });

/** Default visible cap and the hard maximum a caller can request. */
export const CANVAS_MAX_VISIBLE_DEFAULT = 30;
export const CANVAS_MAX_VISIBLE_HARD_MAX = 100;

/** The a11y labels for the interactive controls, declared once. */
export const CANVAS_LABELS = Object.freeze({
  node: 'Select node',
  clearSelection: 'Clear selection',
  zoom: 'Set zoom level',
  refresh: 'Refresh graph',
});

/** Closed node shape: identity, catalog type, display name and position. */
const NODE_KEYS = Object.freeze(['id', 'type', 'name', 'position']);

/** Closed edge shape: identity and the two node ids it connects. */
const EDGE_KEYS = Object.freeze(['id', 'source', 'target']);

/** Closed hand-over payload: one load, the graph model. */
const PAYLOAD_KEYS = Object.freeze(['nodes', 'edges']);

/**
 * Fields that would carry secret or engine material. A payload or node
 * bearing any of them is refused with an explicit security error - fail-
 * closed, never dropped (the engine and the credentials runtime own them).
 */
const SECRET_BEARING_KEYS = Object.freeze([
  'password', 'secret', 'token', 'apiKey', 'apikey', 'credentials', 'privateKey',
  'encrypted', 'oauthToken', 'sessionId', 'sessionToken', 'cookie', 'key', 'hash',
  'workflowId', 'runData', 'executionData', 'staticData', 'pinData',
]);

function assertNoSecretFields(keys, where) {
  for (const key of keys) {
    if (SECRET_BEARING_KEYS.includes(key)) {
      throw new Error(
        `${where} carries the secret-bearing or engine field ${key}: engine authority never reaches this surface (the workflow engine owns it)`,
      );
    }
  }
}

function assertNode(node, index, ids) {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) {
    throw new Error(`node ${index} must be an object`);
  }
  const keys = Object.keys(node);
  assertNoSecretFields(keys, `node ${index}`);
  const sorted = keys.sort();
  if (sorted.join(',') !== [...NODE_KEYS].sort().join(',')) {
    throw new Error(`node ${index} must have exactly ${[...NODE_KEYS].sort().join(',')} (got ${sorted.join(',')})`);
  }
  for (const key of ['id', 'type', 'name']) {
    if (typeof node[key] !== 'string' || node[key].trim() === '') {
      throw new Error(`node ${index} field ${key} must be a non-empty string`);
    }
  }
  if (node.id === 'prototype' || node.id === '__proto__' || node.id === 'constructor') {
    throw new Error(`node ${index} id "${node.id}" is reserved`);
  }
  if (!Array.isArray(node.position) || node.position.length !== 2
    || !node.position.every((value) => Number.isFinite(value))) {
    throw new Error(`node ${index} field position must be [finite, finite]`);
  }
  if (ids.has(node.id)) {
    throw new Error(`node ${index} repeats the id "${node.id}": node ids are unique`);
  }
}

function assertEdge(edge, index, edgeIds, ids) {
  if (edge === null || typeof edge !== 'object' || Array.isArray(edge)) {
    throw new Error(`edge ${index} must be an object`);
  }
  const keys = Object.keys(edge);
  assertNoSecretFields(keys, `edge ${index}`);
  const sorted = keys.sort();
  if (sorted.join(',') !== [...EDGE_KEYS].sort().join(',')) {
    throw new Error(`edge ${index} must have exactly ${[...EDGE_KEYS].sort().join(',')} (got ${sorted.join(',')})`);
  }
  for (const key of ['id', 'source', 'target']) {
    if (typeof edge[key] !== 'string' || edge[key].trim() === '') {
      throw new Error(`edge ${index} field ${key} must be a non-empty string`);
    }
  }
  if (edgeIds.has(edge.id)) {
    throw new Error(`edge ${index} repeats the id "${edge.id}": edge ids are unique`);
  }
  for (const end of ['source', 'target']) {
    if (!ids.has(edge[end])) {
      throw new Error(`edge ${index} field ${end} references the unknown node "${edge[end]}"`);
    }
  }
  edgeIds.add(edge.id);
}

/** The declared surface contract: states keyed on REGION_STATES exactly. */
export function canvasSurfaceContract() {
  return Object.freeze({
    id: CANVAS_SURFACE_ID,
    version: CANVAS_SURFACE_VERSION,
    inputBoundary: Object.freeze({
      source: 'hand-over',
      entryPoint: 'loadSuccess',
      issuesEngineCall: false,
      ownsEngineAuthority: false,
      carriesSecrets: false,
    }),
    states: Object.freeze(
      Object.fromEntries(REGION_STATES.map((state) => [state, Object.freeze({ state })])),
    ),
    vocabularies: Object.freeze({
      actions: CANVAS_ACTIONS,
      selectResults: CANVAS_SELECT_RESULTS,
      clearResults: CANVAS_CLEAR_RESULTS,
      zoomResults: CANVAS_ZOOM_RESULTS,
      emptyReasons: CANVAS_EMPTY_REASONS,
      zoom: Object.freeze({ min: CANVAS_ZOOM_MIN, max: CANVAS_ZOOM_MAX }),
    }),
    bounds: Object.freeze({
      maxVisibleDefault: CANVAS_MAX_VISIBLE_DEFAULT,
      maxVisibleHardMax: CANVAS_MAX_VISIBLE_HARD_MAX,
    }),
  });
}

/**
 * The a11y intent is derived ONCE here, so the contract's declared observables
 * and the view-model's rendered attributes cannot drift. The ready state is an
 * application-like landmark (the graph handles its own keyboard interaction);
 * every other state is a status. Only error is aria-live assertive; only
 * loading is aria-busy.
 */
export const CANVAS_A11Y = Object.freeze(
  Object.fromEntries(
    CANVAS_STATES.map((state) => [
      state,
      Object.freeze({
        role: state === 'ready' ? 'application' : 'status',
        ariaLive: state === 'error' ? 'assertive' : 'polite',
        ariaBusy: state === 'loading',
      }),
    ]),
  ),
);

/**
 * The closed per-state action rule, used by BOTH the view-model and the
 * reference fixtures so the two sides cannot drift (parity is fail-closed on
 * exactly these fields). Selection and zoom availability are answered by the
 * request vocabularies, never by the rule.
 */
export function canvasActionsFor(region) {
  if (region === 'error') return Object.freeze(['refresh']);
  if (region === 'loading') return Object.freeze([]);
  if (region === 'empty') return Object.freeze(['refresh']);
  return Object.freeze(['refresh', 'select-node', 'clear-selection', 'set-zoom']);
}

function interactionsFor(region) {
  const actions = canvasActionsFor(region);
  return Object.freeze({
    refresh: actions.includes('refresh'),
    selectNode: actions.includes('select-node'),
    clearSelection: actions.includes('clear-selection'),
    setZoom: actions.includes('set-zoom'),
  });
}

/**
 * Create the canvas view-model. The graph model enters ONLY through
 * loadSuccess() (one hand-over from the canvas capability); the surface
 * performs no fetch, issues no engine call and never mutates the graph -
 * selection and zoom are view state declared here, executed nowhere.
 */
export function createCanvasSurface(options = {}) {
  const locale = options.locale ?? 'en';
  const requestedMax = options.maxVisible ?? CANVAS_MAX_VISIBLE_DEFAULT;
  if (!Number.isInteger(requestedMax) || requestedMax <= 0) {
    throw new Error('maxVisible must be a positive integer');
  }
  const maxVisible = Math.min(requestedMax, CANVAS_MAX_VISIBLE_HARD_MAX);
  const renderAvailable = options.renderAvailable ?? true;

  let nodes = Object.freeze([]);
  let edges = Object.freeze([]);
  let loaded = false;
  let region = 'loading';
  let selection = null;
  let viewport = CANVAS_DEFAULT_VIEWPORT;
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

  function visibleNodes() {
    return nodes;
  }

  function displayModel() {
    const visible = visibleNodes();
    const shown = visible.slice(0, maxVisible);
    const shownIds = new Set(shown.map((node) => node.id));
    const shownEdges = edges.filter(
      (edge) => shownIds.has(edge.source) && shownIds.has(edge.target),
    );
    const selectedNode = selection === null
      ? null
      : nodes.find((node) => node.id === selection) ?? null;
    return Object.freeze({
      visible: true,
      selection,
      selectedNode: selectedNode === null ? null : Object.freeze({ ...selectedNode }),
      viewport: Object.freeze({ ...viewport }),
      visibleCount: visible.length,
      shown: Object.freeze(shown.map((node) => Object.freeze({ ...node }))),
      shownEdges: Object.freeze(shownEdges.map((edge) => Object.freeze({ ...edge }))),
      truncated: visible.length > shown.length,
      total: nodes.length,
      totalEdges: edges.length,
      reason: region === 'empty' ? 'none' : null,
      focusOrder: Object.freeze([
        ...shown.map((node) => `node:${node.id}`),
        ...(selection !== null ? ['clear-selection'] : []),
      ]),
      labels: CANVAS_LABELS,
      announcement: pendingAnnouncement,
      actions: canvasActionsFor(region),
      error: region === 'error' ? { kind: error?.kind ?? 'network' } : null,
    });
  }

  function a11y() {
    return CANVAS_A11Y[regionState()];
  }

  return Object.freeze({
    id: CANVAS_SURFACE_ID,
    contract: canvasSurfaceContract(),
    maxVisible,
    /**
     * The only data entry point (one hand-over: nodes + edges). The surface
     * PERFORMS NO ENGINE CALL and never mutates the graph - what the payload
     * carried is exactly what renders. Secret-bearing payloads and nodes are
     * refused; edges must connect known nodes.
     */
    loadSuccess(payload) {
      if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new Error('loadSuccess expects a hand-over payload object {nodes, edges}');
      }
      const keys = Object.keys(payload);
      assertNoSecretFields(keys, 'loadSuccess payload');
      const sorted = keys.sort();
      if (sorted.join(',') !== [...PAYLOAD_KEYS].sort().join(',')) {
        throw new Error(`loadSuccess payload must have exactly ${PAYLOAD_KEYS.join(',')} (got ${sorted.join(',')})`);
      }
      if (!Array.isArray(payload.nodes) || !Array.isArray(payload.edges)) {
        throw new Error('loadSuccess payload fields nodes and edges must be arrays');
      }
      const ids = new Set();
      payload.nodes.forEach((node, index) => {
        assertNode(node, index, ids);
        ids.add(node.id);
      });
      const edgeIds = new Set();
      payload.edges.forEach((edge, index) => assertEdge(edge, index, edgeIds, ids));
      nodes = Object.freeze(payload.nodes.map((node) => Object.freeze({
        ...node, position: Object.freeze([...node.position]),
      })));
      edges = Object.freeze(payload.edges.map((edge) => Object.freeze({ ...edge })));
      selection = null;
      viewport = CANVAS_DEFAULT_VIEWPORT;
      error = null;
      loaded = true;
      pendingAnnouncement = null;
      region = nodes.length > 0 ? 'ready' : 'empty';
      pushEvent('loaded');
      return nodes.length;
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
    /** Back to loading. The graph is retained but the region is loading. */
    setLoading() {
      region = 'loading';
      pushEvent('loading');
      return 'loading';
    },
    /**
     * DECLARED, never executed against the graph: the selection VIEW changes.
     * The workflow document never changes here - selectNode is the closed
     * single-selection interaction of this slice (multi-select stays with the
     * reference editor, recorded as scope).
     */
    selectNode(id) {
      if (typeof id !== 'string' || id.trim() === '') {
        throw new Error('selectNode expects a non-empty node id');
      }
      if (region === 'loading' || region === 'error') return 'not-ready';
      const node = nodes.find((entry) => entry.id === id);
      if (node === undefined) return 'unknown-node';
      if (id === selection) return 'same-node';
      selection = id;
      pushEvent('node-selected');
      pendingAnnouncement = node.name;
      return 'selected';
    },
    /** DECLARED: clear the selection view. The graph never changes. */
    clearSelection() {
      if (region === 'loading' || region === 'error') return 'not-ready';
      if (selection === null) return 'no-selection';
      selection = null;
      pushEvent('selection-cleared');
      pendingAnnouncement = null;
      return 'cleared';
    },
    /**
     * DECLARED: set the zoom level inside the pinned bounds. Out of bounds is
     * an explicit result - the viewport is never silently clamped.
     */
    setZoom(next) {
      if (region === 'loading' || region === 'error') return 'not-ready';
      if (typeof next !== 'number' || !Number.isFinite(next)) {
        throw new Error('setZoom expects a finite number');
      }
      if (next < CANVAS_ZOOM_MIN || next > CANVAS_ZOOM_MAX) return 'out-of-bounds';
      if (next === viewport.zoom) return 'zoomed';
      viewport = Object.freeze({ ...viewport, zoom: next });
      pushEvent('zoom-changed');
      return 'zoomed';
    },
    displayModel,
    a11y,
    /** Observable snapshot for the parity harness (candidate side). */
    observe() {
      const state = regionState();
      const model = displayModel();
      const events = state === 'ready' ? ['canvas:rendered'] : [];
      if (state === 'ready' && model.announcement !== null) {
        events.push('canvas:selection');
      }
      return observation({
        surfaceId: CANVAS_SURFACE_ID,
        side: 'candidate',
        visible: model.visible === true,
        regionState: state,
        loading: state === 'loading',
        empty: state === 'empty',
        error: state === 'error' ? { kind: error?.kind ?? 'network' } : null,
        interactions: interactionsFor(state),
        events: Object.freeze(events),
        accessibility: a11y(),
        localization: Object.freeze({ slot: CANVAS_MESSAGE_SLOT, locale }),
        contract: Object.freeze({ id: CANVAS_SURFACE_ID, version: CANVAS_SURFACE_VERSION }),
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
 * their interactions come from the SAME canvasActionsFor rule the view-model
 * uses, so the two sides cannot drift by construction.
 */
function referenceObservation({ regionState: state, error = null, events = [], locale }) {
  return observation({
    surfaceId: CANVAS_SURFACE_ID,
    side: 'reference',
    visible: true,
    regionState: state,
    loading: state === 'loading',
    empty: state === 'empty',
    error,
    interactions: interactionsFor(state),
    events: Object.freeze(events),
    accessibility: CANVAS_A11Y[state],
    localization: Object.freeze({ slot: CANVAS_MESSAGE_SLOT, locale }),
    contract: Object.freeze({ id: CANVAS_SURFACE_ID, version: CANVAS_SURFACE_VERSION }),
  });
}

export function referenceLoadingObservation(locale = 'en') {
  return referenceObservation({ regionState: 'loading', locale });
}

export function referenceEmptyObservation({ reason = 'none', locale = 'en' } = {}) {
  if (!CANVAS_EMPTY_REASONS.includes(reason)) {
    throw new Error(`reason must be one of ${CANVAS_EMPTY_REASONS.join(', ')} (got "${reason}")`);
  }
  return referenceObservation({ regionState: 'empty', locale });
}

export function referenceReadyObservation(locale = 'en') {
  return referenceObservation({ regionState: 'ready', events: ['canvas:rendered'], locale });
}

export function referenceErrorObservation({ errorKind = 'network', locale = 'en' } = {}) {
  return referenceObservation({ regionState: 'error', error: { kind: errorKind }, locale });
}
