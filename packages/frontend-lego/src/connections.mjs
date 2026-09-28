/**
 * Connections surface pilot (P2-S16, issue #240) - the strangler slice for the
 * connection inspector / connection list, split out of P2-S03. One surface,
 * one delivery scope: the panel that lists and manages a workflow's
 * connections (edges) over the handed-over connection records.
 *
 * Boundary (invariants 4-5): the connection records and the node-id vocabulary
 * they resolve against are HANDED OVER (inputBoundary source hand-over)
 * through declared capabilities only. The surface holds no private data path
 * and no second source of truth: it never fetches a workflow's graph (the
 * workflow record owns it), performs no engine call and NEVER POSTS A
 * WORKFLOW - select-connection is a view interaction, reconnect and
 * remove-connection are DECLARED REQUESTS answered with closed results; the
 * handed-over connection list is byte-identical after every interaction.
 *
 * Security boundary (the load-bearing rule): a payload carrying secret or
 * session material is refused with an explicit security error, never dropped;
 * there is no evaluator here (no eval, no new Function), no fetch and no
 * history touch - the module is a pure view-model over the hand-over.
 *
 * Closed contracts (invariants 4 and 7): the four region states are exactly
 * the shared REGION_STATES; the connection type vocabulary is the declared
 * subset main | ai_tool | ai_memory | ai_embedding | ai_vector (the full n8n
 * connection type zoo stays with the reference - recorded as evidence); an
 * empty connection list is empty with reason none, never a fifth state.
 *
 * Pilot (invariants 1 and 9): the original n8n editor stays the default path;
 * rollback is switching the pilot off with no residual state and no
 * workflow-data migration (rollbackStrategy: pilot-not-primary in the
 * surface-migrations manifest).
 */
import { observation } from './parity.mjs';
import { REGION_STATES } from './surface-contract.mjs';

export const CONNECTION_STATES = REGION_STATES;

export const CONNECTION_SURFACE_ID = 'connections';
export const CONNECTION_SURFACE_VERSION = 'p1';
export const CONNECTION_MESSAGE_SLOT = 'connections';

/** Closed connection-type vocabulary: the declared subset this slice renders. */
export const CONNECTION_TYPES = Object.freeze([
  'main', 'ai_tool', 'ai_memory', 'ai_embedding', 'ai_vector',
]);

/** Closed empty reason: a workflow with no connections is none, never a fifth state. */
export const CONNECTION_EMPTY_REASONS = Object.freeze(['none']);

/** Closed action vocabulary: what the user may ask for in a state (declared). */
export const CONNECTION_ACTIONS = Object.freeze([
  'refresh', 'select-connection', 'reconnect', 'remove-connection',
]);

/**
 * Closed request-result vocabularies: every declared outcome is explicit.
 * accepted means the REQUEST was accepted for the app layer - the workflow
 * document is written by the app layer, never here.
 */
export const CONNECTION_SELECT_RESULTS = Object.freeze([
  'accepted', 'unknown-connection', 'not-ready',
]);
export const CONNECTION_RECONNECT_RESULTS = Object.freeze([
  'accepted', 'unknown-connection', 'unknown-node', 'duplicate-connection', 'not-ready',
]);
export const CONNECTION_REMOVE_RESULTS = Object.freeze([
  'accepted', 'unknown-connection', 'not-ready',
]);

/** Default visible cap and the hard maximum a caller can request. */
export const CONNECTION_MAX_VISIBLE_DEFAULT = 30;
export const CONNECTION_MAX_VISIBLE_HARD_MAX = 100;

/** The a11y labels for the interactive controls, declared once. */
export const CONNECTION_LABELS = Object.freeze({
  connection: 'Connection',
  select: 'Select connection',
  reconnect: 'Reconnect connection',
  remove: 'Remove connection',
  refresh: 'Refresh connections',
});

/** Closed connection record shape: one edge of the handed-over workflow. */
const CONNECTION_KEYS = Object.freeze(['id', 'source', 'target', 'type']);

/** Closed endpoint shape: a node id plus a non-negative port index. */
const ENDPOINT_KEYS = Object.freeze(['node', 'port']);

/** Closed hand-over payload: one load, the connections plus the node vocabulary. */
const PAYLOAD_KEYS = Object.freeze(['connections', 'nodeIds']);

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

function assertEndpointShape(endpoint, where) {
  if (endpoint === null || typeof endpoint !== 'object' || Array.isArray(endpoint)) {
    throw new Error(`${where} must be an object {node, port}`);
  }
  const keys = Object.keys(endpoint).sort();
  if (keys.join(',') !== [...ENDPOINT_KEYS].sort().join(',')) {
    throw new Error(`${where} must have exactly node,port (got ${keys.join(',')})`);
  }
  if (typeof endpoint.node !== 'string' || endpoint.node.trim() === '') {
    throw new Error(`${where} field node must be a non-empty string`);
  }
  if (!Number.isInteger(endpoint.port) || endpoint.port < 0) {
    throw new Error(`${where} field port must be a non-negative integer`);
  }
}

function assertEndpoint(endpoint, where, nodeIds) {
  assertEndpointShape(endpoint, where);
  if (!nodeIds.has(endpoint.node)) {
    throw new Error(`${where} resolves the unknown node "${endpoint.node}": the hand-over must be consistent`);
  }
}

function assertConnection(connection, index, seenIds, nodeIds) {
  if (connection === null || typeof connection !== 'object' || Array.isArray(connection)) {
    throw new Error(`connection ${index} must be an object`);
  }
  const keys = Object.keys(connection);
  assertNoSecretFields(keys, `connection ${index}`);
  const sorted = keys.sort();
  if (sorted.join(',') !== [...CONNECTION_KEYS].sort().join(',')) {
    throw new Error(`connection ${index} must have exactly id,source,target,type (got ${sorted.join(',')})`);
  }
  if (typeof connection.id !== 'string' || connection.id.trim() === '') {
    throw new Error(`connection ${index} field id must be a non-empty string`);
  }
  if (seenIds.has(connection.id)) {
    throw new Error(`connection ${index} repeats the id "${connection.id}": connection ids are unique`);
  }
  if (typeof connection.type !== 'string' || !CONNECTION_TYPES.includes(connection.type)) {
    throw new Error(`connection ${index} field type must be one of ${CONNECTION_TYPES.join(', ')} (got "${connection.type}")`);
  }
  assertEndpoint(connection.source, `connection ${index} source`, nodeIds);
  assertEndpoint(connection.target, `connection ${index} target`, nodeIds);
}

function endpointSignature(endpoint) {
  return `${endpoint.node}:${endpoint.port}`;
}

function connectionSignature(connection) {
  return `${connection.type}|${endpointSignature(connection.source)}|${endpointSignature(connection.target)}`;
}

/** The declared surface contract: states keyed on REGION_STATES exactly. */
export function connectionsSurfaceContract() {
  return Object.freeze({
    id: CONNECTION_SURFACE_ID,
    version: CONNECTION_SURFACE_VERSION,
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
      connectionTypes: CONNECTION_TYPES,
      actions: CONNECTION_ACTIONS,
      selectResults: CONNECTION_SELECT_RESULTS,
      reconnectResults: CONNECTION_RECONNECT_RESULTS,
      removeResults: CONNECTION_REMOVE_RESULTS,
      emptyReasons: CONNECTION_EMPTY_REASONS,
    }),
    bounds: Object.freeze({
      maxVisibleDefault: CONNECTION_MAX_VISIBLE_DEFAULT,
      maxVisibleHardMax: CONNECTION_MAX_VISIBLE_HARD_MAX,
    }),
  });
}

/**
 * The a11y intent is derived ONCE here, so the contract's declared observables
 * and the view-model's rendered attributes cannot drift. The ready state is
 * the list landmark; every other state is a status. Only error is aria-live
 * assertive; only loading is aria-busy.
 */
export const CONNECTION_A11Y = Object.freeze(
  Object.fromEntries(
    CONNECTION_STATES.map((state) => [
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
export function connectionActionsFor(region) {
  if (region === 'error') return Object.freeze(['refresh']);
  if (region === 'loading') return Object.freeze([]);
  if (region === 'empty') return Object.freeze(['refresh']);
  return Object.freeze(['refresh', 'select-connection', 'reconnect', 'remove-connection']);
}

function interactionsFor(region) {
  const actions = connectionActionsFor(region);
  return Object.freeze({
    refresh: actions.includes('refresh'),
    selectConnection: actions.includes('select-connection'),
    reconnect: actions.includes('reconnect'),
    removeConnection: actions.includes('remove-connection'),
  });
}

/**
 * Create the connections view-model. Connection records and the node-id
 * vocabulary enter ONLY through loadSuccess() (one hand-over from the
 * workflow record); the surface performs no fetch, issues no engine call and
 * never posts the workflow - select changes the VIEW only, while
 * reconnect/remove are DECLARED requests with explicit results.
 */
export function createConnectionsSurface(options = {}) {
  const locale = options.locale ?? 'en';
  const requestedMax = options.maxVisible ?? CONNECTION_MAX_VISIBLE_DEFAULT;
  if (!Number.isInteger(requestedMax) || requestedMax <= 0) {
    throw new Error('maxVisible must be a positive integer');
  }
  const maxVisible = Math.min(requestedMax, CONNECTION_MAX_VISIBLE_HARD_MAX);
  const renderAvailable = options.renderAvailable ?? true;

  let connections = Object.freeze([]);
  let nodeIds = Object.freeze([]);
  let knownNodes = new Set();
  let selectedId = null;
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

  function displayModel() {
    const visible = connections;
    const shown = visible.slice(0, maxVisible);
    return Object.freeze({
      visible: true,
      visibleCount: visible.length,
      shown: Object.freeze(shown.map((connection) => Object.freeze({
        id: connection.id,
        source: Object.freeze({ ...connection.source }),
        target: Object.freeze({ ...connection.target }),
        type: connection.type,
        label: `${connection.source.node} -> ${connection.target.node}`,
        selected: connection.id === selectedId,
      }))),
      truncated: visible.length > shown.length,
      total: visible.length,
      reason: region === 'empty' ? 'none' : null,
      selected: selectedId,
      focusOrder: Object.freeze(shown.map((connection) => `conn:${connection.id}`)),
      labels: CONNECTION_LABELS,
      announcement: pendingAnnouncement,
      actions: connectionActionsFor(region),
      error: region === 'error' ? { kind: error?.kind ?? 'network' } : null,
    });
  }

  function a11y() {
    return CONNECTION_A11Y[regionState()];
  }

  return Object.freeze({
    id: CONNECTION_SURFACE_ID,
    contract: connectionsSurfaceContract(),
    maxVisible,
    /**
     * The only data entry point (one hand-over: connections + nodeIds). The
     * surface never fetches a graph and never posts the workflow - what the
     * payload carried is exactly what renders. Secret-bearing envelopes,
     * duplicate ids, unknown endpoints and out-of-vocabulary types are
     * refused.
     */
    loadSuccess(payload) {
      if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new Error('loadSuccess expects a hand-over payload object {connections, nodeIds}');
      }
      const keys = Object.keys(payload);
      assertNoSecretFields(keys, 'loadSuccess payload');
      const sorted = keys.sort();
      if (sorted.join(',') !== [...PAYLOAD_KEYS].sort().join(',')) {
        throw new Error(`loadSuccess payload must have exactly ${PAYLOAD_KEYS.join(',')} (got ${sorted.join(',')})`);
      }
      if (!Array.isArray(payload.connections) || !Array.isArray(payload.nodeIds)) {
        throw new Error('loadSuccess payload fields connections (array) and nodeIds (array) are required');
      }
      const nodes = new Set();
      payload.nodeIds.forEach((nodeId, index) => {
        if (typeof nodeId !== 'string' || nodeId.trim() === '') {
          throw new Error(`nodeIds[${index}] must be a non-empty string`);
        }
        if (nodes.has(nodeId)) {
          throw new Error(`nodeIds repeats "${nodeId}": node ids are unique`);
        }
        nodes.add(nodeId);
      });
      const seenIds = new Set();
      payload.connections.forEach((connection, index) => {
        assertConnection(connection, index, seenIds, nodes);
        seenIds.add(connection.id);
      });
      connections = Object.freeze(payload.connections.map((connection) => Object.freeze({
        id: connection.id,
        source: Object.freeze({ ...connection.source }),
        target: Object.freeze({ ...connection.target }),
        type: connection.type,
      })));
      nodeIds = Object.freeze([...payload.nodeIds]);
      knownNodes = nodes;
      selectedId = null;
      error = null;
      loaded = true;
      pendingAnnouncement = null;
      region = connections.length > 0 ? 'ready' : 'empty';
      pushEvent('loaded');
      return connections.length;
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
    /** Back to loading. Connections are retained but the region is loading. */
    setLoading() {
      region = 'loading';
      pushEvent('loading');
      return 'loading';
    },
    /**
     * DECLARED, view-only: highlight one connection in the list. The
     * handed-over connection records never change - selection is not graph
     * data.
     */
    selectConnection(id) {
      if (typeof id !== 'string' || id.trim() === '') {
        throw new Error('selectConnection expects a non-empty connection id');
      }
      if (region === 'loading' || region === 'error') return 'not-ready';
      const connection = connections.find((entry) => entry.id === id);
      if (connection === undefined) return 'unknown-connection';
      if (selectedId === id) return 'accepted';
      selectedId = id;
      pushEvent('selected');
      pendingAnnouncement = connection.id;
      return 'accepted';
    },
    /**
     * DECLARED, never executed here: ask the app layer to rebind a
     * connection's endpoint(s). Endpoints are validated against the
     * handed-over node vocabulary and duplicates are refused; the connection
     * list on screen stays byte-identical - the app layer writes the workflow.
     */
    reconnect(connectionId, nextEndpoints = {}) {
      if (typeof connectionId !== 'string' || connectionId.trim() === '') {
        throw new Error('reconnect expects a non-empty connection id');
      }
      if (region === 'loading' || region === 'error') return 'not-ready';
      const connection = connections.find((entry) => entry.id === connectionId);
      if (connection === undefined) return 'unknown-connection';
      if (nextEndpoints === null || typeof nextEndpoints !== 'object' || Array.isArray(nextEndpoints)) {
        throw new Error('reconnect expects an object with source and/or target');
      }
      const endpointKeys = Object.keys(nextEndpoints).sort();
      if (endpointKeys.some((key) => key !== 'source' && key !== 'target')) {
        throw new Error('reconnect expects only source and/or target');
      }
      if (endpointKeys.length === 0) {
        throw new Error('reconnect expects source and/or target');
      }
      const source = nextEndpoints.source ?? connection.source;
      const target = nextEndpoints.target ?? connection.target;
      assertEndpointShape(source, 'reconnect source');
      assertEndpointShape(target, 'reconnect target');
      if (!knownNodes.has(source.node)) return 'unknown-node';
      if (!knownNodes.has(target.node)) return 'unknown-node';
      const signature = `${connection.type}|${endpointSignature(source)}|${endpointSignature(target)}`;
      const duplicate = connections.some(
        (entry) => entry.id !== connectionId && connectionSignature(entry) === signature,
      );
      if (duplicate) return 'duplicate-connection';
      pushEvent('reconnect-requested');
      return 'accepted';
    },
    /**
     * DECLARED, never executed here: ask the app layer to remove a connection
     * from the workflow. The surface only reports the request - the list on
     * screen is untouched (the app layer writes the workflow).
     */
    removeConnection(connectionId) {
      if (typeof connectionId !== 'string' || connectionId.trim() === '') {
        throw new Error('removeConnection expects a non-empty connection id');
      }
      if (region === 'loading' || region === 'error') return 'not-ready';
      const connection = connections.find((entry) => entry.id === connectionId);
      if (connection === undefined) return 'unknown-connection';
      pushEvent('remove-requested');
      return 'accepted';
    },
    displayModel,
    a11y,
    /** Observable snapshot for the parity harness (candidate side). */
    observe() {
      const state = regionState();
      const model = displayModel();
      const events = state === 'ready' ? ['connections:rendered'] : [];
      if (state === 'ready' && model.announcement !== null) {
        events.push('connections:changed');
      }
      return observation({
        surfaceId: CONNECTION_SURFACE_ID,
        side: 'candidate',
        visible: model.visible === true,
        regionState: state,
        loading: state === 'loading',
        empty: state === 'empty',
        error: state === 'error' ? { kind: error?.kind ?? 'network' } : null,
        interactions: interactionsFor(state),
        events: Object.freeze(events),
        accessibility: a11y(),
        localization: Object.freeze({ slot: CONNECTION_MESSAGE_SLOT, locale }),
        contract: Object.freeze({ id: CONNECTION_SURFACE_ID, version: CONNECTION_SURFACE_VERSION }),
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
    get selectedId() {
      return selectedId;
    },
    /** The handed-over node vocabulary (read-only, for assertions). */
    get nodeIds() {
      return nodeIds;
    },
  });
}

/* -------------------------------------------------------- the reference model */

/**
 * The reference (pinned n8n editor) observations as deterministic fixtures.
 * The reference UI is not run here - these are the declared behaviours the
 * candidate is compared against. They mirror observe() field for field, and
 * their interactions come from the SAME connectionActionsFor rule the
 * view-model uses, so the two sides cannot drift by construction.
 */
function referenceObservation({ regionState: state, error = null, events = [], locale }) {
  return observation({
    surfaceId: CONNECTION_SURFACE_ID,
    side: 'reference',
    visible: true,
    regionState: state,
    loading: state === 'loading',
    empty: state === 'empty',
    error,
    interactions: interactionsFor(state),
    events: Object.freeze(events),
    accessibility: CONNECTION_A11Y[state],
    localization: Object.freeze({ slot: CONNECTION_MESSAGE_SLOT, locale }),
    contract: Object.freeze({ id: CONNECTION_SURFACE_ID, version: CONNECTION_SURFACE_VERSION }),
  });
}

export function referenceLoadingObservation(locale = 'en') {
  return referenceObservation({ regionState: 'loading', locale });
}

export function referenceEmptyObservation({ reason = 'none', locale = 'en' } = {}) {
  if (!CONNECTION_EMPTY_REASONS.includes(reason)) {
    throw new Error(`reason must be one of ${CONNECTION_EMPTY_REASONS.join(', ')} (got "${reason}")`);
  }
  return referenceObservation({ regionState: 'empty', locale });
}

export function referenceReadyObservation(locale = 'en') {
  return referenceObservation({ regionState: 'ready', events: ['connections:rendered'], locale });
}

export function referenceErrorObservation({ errorKind = 'network', locale = 'en' } = {}) {
  return referenceObservation({ regionState: 'error', error: { kind: errorKind }, locale });
}
