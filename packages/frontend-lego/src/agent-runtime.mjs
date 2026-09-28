/**
 * Agent/Runtime views surfaces pilot (P2-S28, issue #240) - the strangler
 * slice for the agent and runtime supervision surfaces, split out of
 * P2-S03 (Layer 5). One surface, one delivery scope: render the handed-over
 * supervision snapshot read-only and ask the app layer to open an agent
 * through a DECLARED request. THE SURFACE CANNOT START OR STOP RUNTIMES (or
 * pause, resume or cancel anything): control verbs are contract operations
 * with their own permissions and never appear as actions here. Runtime
 * events arrive via hand-over - the surface holds no private data path and
 * no second source of truth: no fetch, no mutation of a record, no runtime
 * or agent operation.
 *
 * Boundary (invariants 4-5): supervision state is HANDED OVER
 * (inputBoundary source hand-over) through declared capabilities only.
 * request-open-agent is DECLARED with explicit results; the capability
 * that owns navigation performs it.
 *
 * Security boundary (the load-bearing rule): a payload envelope carrying
 * secret or session material is refused with an explicit security error,
 * never dropped. Records are opaque closed shapes - this surface evaluates
 * nothing (no eval, no new Function), fetches nothing and never persists.
 * The vocabularies are QUOTED, never redefined: agent status comes from
 * `agentSessionState` and event type from `agentEventType` in the
 * vocabulary lock (vocabulary.mjs) - no second architecture.
 *
 * Closed contracts (invariants 4 and 7): the four region states are exactly
 * the shared REGION_STATES; a supervision view with no records is empty
 * with reason none, never a fifth state.
 *
 * Pilot (invariants 1 and 9): the original n8n editor stays the default
 * path; rollback is switching the pilot off with no residual state and no
 * workflow-data migration (rollbackStrategy: pilot-not-primary in the
 * surface-migrations manifest).
 */
import { observation } from './parity.mjs';
import { REGION_STATES } from './surface-contract.mjs';
import { vocabularyOf } from './vocabulary.mjs';

export const AGENT_RUNTIME_STATES = REGION_STATES;

export const AGENT_RUNTIME_SURFACE_ID = 'agent-runtime';
export const AGENT_RUNTIME_SURFACE_VERSION = 'p1';
export const AGENT_RUNTIME_MESSAGE_SLOT = 'agent-runtime';

/** The quoted agent status vocabulary: the session state lock, verbatim. */
export const AGENT_SESSION_STATES = vocabularyOf('agentSessionState').values;
/** The quoted event type vocabulary: the agent event lock (26 types), verbatim. */
export const AGENT_EVENT_TYPES = vocabularyOf('agentEventType').values;

/** Closed empty reason: no handed-over records is none, never a fifth state. */
export const AGENT_RUNTIME_EMPTY_REASONS = Object.freeze(['none']);

/**
 * Closed action vocabulary: refresh, and the DECLARED open request.
 * There is NO start, stop, pause, resume or cancel - the surface cannot
 * start or stop runtimes; those are contract operations, not UI controls.
 */
export const AGENT_RUNTIME_ACTIONS = Object.freeze(['refresh', 'request-open-agent']);

/** Closed request-result vocabularies: every declared outcome is explicit. */
export const AGENT_RUNTIME_OPEN_RESULTS = Object.freeze(['accepted', 'unknown-agent', 'not-ready']);

/** Bounds: visible event rows (default/hard) and the summary ceiling. */
export const AGENT_RUNTIME_MAX_VISIBLE_DEFAULT = 30;
export const AGENT_RUNTIME_MAX_VISIBLE_HARD_MAX = 100;
export const AGENT_SUMMARY_MAX_LENGTH = 400;

/** The a11y labels for the views and controls, declared once. */
export const AGENT_RUNTIME_LABELS = Object.freeze({
  open: 'Open agent',
  refresh: 'Refresh supervision view',
  agents: 'Agents view',
  events: 'Runtime events view',
});

/** Closed agent record shape: one handed-over supervision row. */
const AGENT_ITEM_KEYS = Object.freeze(['agentId', 'runtimeId', 'status']);

/** Closed event record shape: one handed-over runtime event (envelope subset). */
const EVENT_ITEM_KEYS = Object.freeze(['agentId', 'eventId', 'summary', 'timestamp', 'type']);

/** Closed hand-over payload: one load, both supervision lists. */
const PAYLOAD_KEYS = Object.freeze(['agents', 'events']);

/**
 * Fields that would carry secret or session material in the hand-over
 * envelope. Refused with an explicit security error - fail-closed, never
 * dropped (the credentials runtime owns them; cookies and tokens never
 * reach a supervision surface).
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

function assertExactKeys(keys, expected, where) {
  const sorted = keys.sort();
  if (sorted.join(',') !== [...expected].sort().join(',')) {
    throw new Error(`${where} must have exactly ${expected.join(',')} (got ${sorted.join(',')})`);
  }
}

function assertIsoTimestamp(value, where) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value) || Number.isNaN(Date.parse(value))) {
    throw new Error(`${where} must be an ISO 8601 timestamp (got ${JSON.stringify(value)})`);
  }
}

function assertAgent(item, index, seenIds) {
  if (item === null || typeof item !== 'object' || Array.isArray(item)) {
    throw new Error(`agent ${index} must be an object`);
  }
  const keys = Object.keys(item);
  assertNoSecretFields(keys, `agent ${index}`);
  assertExactKeys(keys, AGENT_ITEM_KEYS, `agent ${index}`);
  if (typeof item.agentId !== 'string' || item.agentId.trim() === '') {
    throw new Error(`agent ${index} field agentId must be a non-empty string`);
  }
  if (typeof item.runtimeId !== 'string' || item.runtimeId.trim() === '') {
    throw new Error(`agent ${index} field runtimeId must be a non-empty string`);
  }
  if (!AGENT_SESSION_STATES.includes(item.status)) {
    throw new Error(`agent ${index} field status must be one of ${AGENT_SESSION_STATES.join(', ')} (got "${item.status}")`);
  }
  if (seenIds.has(item.agentId)) {
    throw new Error(`agent ${index} repeats the agentId "${item.agentId}": agent ids are unique`);
  }
}

function assertEvent(item, index, seenIds) {
  if (item === null || typeof item !== 'object' || Array.isArray(item)) {
    throw new Error(`event ${index} must be an object`);
  }
  const keys = Object.keys(item);
  assertNoSecretFields(keys, `event ${index}`);
  assertExactKeys(keys, EVENT_ITEM_KEYS, `event ${index}`);
  if (typeof item.eventId !== 'string' || item.eventId.trim() === '') {
    throw new Error(`event ${index} field eventId must be a non-empty string`);
  }
  if (typeof item.agentId !== 'string' || item.agentId.trim() === '') {
    throw new Error(`event ${index} field agentId must be a non-empty string`);
  }
  assertIsoTimestamp(item.timestamp, `event ${index} field timestamp`);
  if (!AGENT_EVENT_TYPES.includes(item.type)) {
    throw new Error(`event ${index} field type must be one of the locked agentEventType values (got "${item.type}")`);
  }
  if (typeof item.summary !== 'string' || item.summary.trim() === '') {
    throw new Error(`event ${index} field summary must be a non-empty string`);
  }
  if (item.summary.length > AGENT_SUMMARY_MAX_LENGTH) {
    throw new Error(`event ${index} field summary must be at most ${AGENT_SUMMARY_MAX_LENGTH} characters`);
  }
  if (seenIds.has(item.eventId)) {
    throw new Error(`event ${index} repeats the eventId "${item.eventId}": event ids are unique`);
  }
}

/** The declared surface contract: states keyed on REGION_STATES exactly. */
export function agentRuntimeSurfaceContract() {
  return Object.freeze({
    id: AGENT_RUNTIME_SURFACE_ID,
    version: AGENT_RUNTIME_SURFACE_VERSION,
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
      agentStatuses: AGENT_SESSION_STATES,
      eventTypes: AGENT_EVENT_TYPES,
      actions: AGENT_RUNTIME_ACTIONS,
      openResults: AGENT_RUNTIME_OPEN_RESULTS,
      emptyReasons: AGENT_RUNTIME_EMPTY_REASONS,
    }),
    bounds: Object.freeze({
      maxVisibleDefault: AGENT_RUNTIME_MAX_VISIBLE_DEFAULT,
      maxVisibleHardMax: AGENT_RUNTIME_MAX_VISIBLE_HARD_MAX,
      summaryMaxLength: AGENT_SUMMARY_MAX_LENGTH,
    }),
  });
}

/**
 * The a11y intent is derived ONCE here, so the contract's declared observables
 * and the view-model's rendered attributes cannot drift. The ready state is
 * the form landmark; every other state is a status. Only error is aria-live
 * assertive; only loading is aria-busy.
 */
export const AGENT_RUNTIME_A11Y = Object.freeze(
  Object.fromEntries(
    AGENT_RUNTIME_STATES.map((state) => [
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
export function agentRuntimeActionsFor(region) {
  if (region === 'error') return Object.freeze(['refresh']);
  if (region === 'loading') return Object.freeze([]);
  if (region === 'empty') return Object.freeze(['refresh']);
  return Object.freeze(['refresh', 'request-open-agent']);
}

function interactionsFor(region) {
  const actions = agentRuntimeActionsFor(region);
  return Object.freeze({
    refresh: actions.includes('refresh'),
    requestOpenAgent: actions.includes('request-open-agent'),
  });
}

/**
 * Create the Agent/Runtime view-model. Supervision state enters ONLY
 * through loadSuccess() (one hand-over); the surface performs no fetch,
 * touches no runtime or agent operation, mutates no record and never
 * navigates - request-open-agent is DECLARED with explicit results, and
 * the owning capability performs it.
 */
export function createAgentRuntimeSurface(options = {}) {
  const locale = options.locale ?? 'en';
  const requestedMax = options.maxVisible ?? AGENT_RUNTIME_MAX_VISIBLE_DEFAULT;
  if (!Number.isInteger(requestedMax) || requestedMax <= 0) {
    throw new Error('maxVisible must be a positive integer');
  }
  const maxVisible = Math.min(requestedMax, AGENT_RUNTIME_MAX_VISIBLE_HARD_MAX);
  const renderAvailable = options.renderAvailable ?? true;

  let agents = Object.freeze([]);
  let agentIds = new Set();
  let events = Object.freeze([]);
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
    // The window keeps the NEWEST event rows (the stream tail); truncation
    // is reported, never silent. The agent list is a bounded supervision
    // snapshot shown in full.
    const shown = events.slice(-maxVisible);
    return Object.freeze({
      visible: true,
      visibleCount: events.length,
      shown: Object.freeze(shown.map((item) => Object.freeze({
        eventId: item.eventId,
        timestamp: item.timestamp,
        type: item.type,
        agentId: item.agentId,
        summary: item.summary,
      }))),
      truncated: events.length > shown.length,
      total: events.length,
      agents: Object.freeze(agents.map((item) => Object.freeze({
        agentId: item.agentId,
        runtimeId: item.runtimeId,
        status: item.status,
      }))),
      agentCount: agents.length,
      reason: region === 'empty' ? 'none' : null,
      focusOrder: Object.freeze(region === 'ready'
        ? Object.freeze([
          'view:agents',
          'view:events',
          ...agents.map((item) => `agent:${item.agentId}`),
          ...events.map((item) => `event:${item.eventId}`),
        ])
        : []),
      labels: AGENT_RUNTIME_LABELS,
      announcement: pendingAnnouncement,
      actions: agentRuntimeActionsFor(region),
      error: region === 'error' ? { kind: error?.kind ?? 'network' } : null,
    });
  }

  function a11y() {
    return AGENT_RUNTIME_A11Y[regionState()];
  }

  return Object.freeze({
    id: AGENT_RUNTIME_SURFACE_ID,
    contract: agentRuntimeSurfaceContract(),
    maxVisible,
    /**
     * The only data entry point (one hand-over: agents + events).
     * Secret-bearing envelopes, duplicate ids, unknown statuses/types and
     * malformed records are refused.
     */
    loadSuccess(payload) {
      if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new Error('loadSuccess expects a hand-over payload object {agents, events}');
      }
      const keys = Object.keys(payload);
      assertNoSecretFields(keys, 'loadSuccess payload');
      assertExactKeys(keys, PAYLOAD_KEYS, 'loadSuccess payload');
      if (!Array.isArray(payload.agents)) {
        throw new Error('loadSuccess payload field agents (array) is required');
      }
      if (!Array.isArray(payload.events)) {
        throw new Error('loadSuccess payload field events (array) is required');
      }
      const agentSeen = new Set();
      payload.agents.forEach((item, index) => {
        assertAgent(item, index, agentSeen);
        agentSeen.add(item.agentId);
      });
      const eventSeen = new Set();
      payload.events.forEach((item, index) => {
        assertEvent(item, index, eventSeen);
        eventSeen.add(item.eventId);
      });
      agents = Object.freeze(payload.agents.map((item) => Object.freeze({ ...item })));
      agentIds = agentSeen;
      events = Object.freeze(payload.events.map((item) => Object.freeze({ ...item })));
      error = null;
      loaded = true;
      pendingAnnouncement = null;
      region = (agents.length > 0 || events.length > 0) ? 'ready' : 'empty';
      pushEvent('loaded');
      return agents.length + events.length;
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
     * DECLARED, never executed here: ask the app layer (the capability that
     * owns navigation) to open an agent's detail. The route never moves
     * locally, and this request cannot start, stop, pause or cancel
     * anything - control is a contract operation, never a surface action.
     */
    requestOpenAgent(agentId) {
      if (typeof agentId !== 'string' || agentId.trim() === '') {
        throw new Error('requestOpenAgent expects a non-empty agent id');
      }
      if (region !== 'ready') return 'not-ready';
      if (!agentIds.has(agentId)) return 'unknown-agent';
      pushEvent('open-requested');
      pendingAnnouncement = agentId;
      return 'accepted';
    },
    displayModel,
    a11y,
    /** Observable snapshot for the parity harness (candidate side). */
    observe() {
      const state = regionState();
      const model = displayModel();
      const events = state === 'ready' ? ['agent-runtime:rendered'] : [];
      if (state === 'ready' && model.announcement !== null) {
        events.push('agent-runtime:changed');
      }
      return observation({
        surfaceId: AGENT_RUNTIME_SURFACE_ID,
        side: 'candidate',
        visible: model.visible === true,
        regionState: state,
        loading: state === 'loading',
        empty: state === 'empty',
        error: state === 'error' ? { kind: error?.kind ?? 'network' } : null,
        interactions: interactionsFor(state),
        events: Object.freeze(events),
        accessibility: a11y(),
        localization: Object.freeze({ slot: AGENT_RUNTIME_MESSAGE_SLOT, locale }),
        contract: Object.freeze({
          id: AGENT_RUNTIME_SURFACE_ID,
          version: AGENT_RUNTIME_SURFACE_VERSION,
        }),
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
    get agents() {
      return agents;
    },
    get events() {
      return events;
    },
  });
}

/* -------------------------------------------------------- the reference model */

/**
 * The reference (pinned n8n editor) observations as deterministic fixtures.
 * The reference UI is not run here - these are the declared behaviours the
 * candidate is compared against. They mirror observe() field for field, and
 * their interactions come from the SAME agentRuntimeActionsFor rule the
 * view-model uses, so the two sides cannot drift by construction.
 */
function referenceObservation({ regionState: state, error = null, events = [], locale }) {
  return observation({
    surfaceId: AGENT_RUNTIME_SURFACE_ID,
    side: 'reference',
    visible: true,
    regionState: state,
    loading: state === 'loading',
    empty: state === 'empty',
    error,
    interactions: interactionsFor(state),
    events: Object.freeze(events),
    accessibility: AGENT_RUNTIME_A11Y[state],
    localization: Object.freeze({ slot: AGENT_RUNTIME_MESSAGE_SLOT, locale }),
    contract: Object.freeze({
      id: AGENT_RUNTIME_SURFACE_ID,
      version: AGENT_RUNTIME_SURFACE_VERSION,
    }),
  });
}

export function referenceLoadingObservation(locale = 'en') {
  return referenceObservation({ regionState: 'loading', locale });
}

export function referenceEmptyObservation({ reason = 'none', locale = 'en' } = {}) {
  if (!AGENT_RUNTIME_EMPTY_REASONS.includes(reason)) {
    throw new Error(`reason must be one of ${AGENT_RUNTIME_EMPTY_REASONS.join(', ')} (got "${reason}")`);
  }
  return referenceObservation({ regionState: 'empty', locale });
}

export function referenceReadyObservation(locale = 'en') {
  return referenceObservation({ regionState: 'ready', events: ['agent-runtime:rendered'], locale });
}

export function referenceErrorObservation({ errorKind = 'network', locale = 'en' } = {}) {
  return referenceObservation({ regionState: 'error', error: { kind: errorKind }, locale });
}
