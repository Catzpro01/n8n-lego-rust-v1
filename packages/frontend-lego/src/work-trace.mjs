/**
 * Work Trace surfaces pilot (P2-S25, issue #240) - the strangler slice for
 * the work-trace timeline surface, split out of P2-S03 (Layer 5). One
 * surface, one delivery scope: render the handed-over trace events read-only
 * and ask the app layer to open an event through a DECLARED request.
 *
 * Boundary (invariants 4-5): the trace is HANDED OVER from the
 * observability capability (inputBoundary source hand-over) through declared
 * capabilities only. The surface holds no second source of truth: no fetch,
 * no mutation of an event, no navigation - request-open-event is DECLARED
 * with explicit results; the capability that owns navigation performs it.
 *
 * Security boundary (the load-bearing rule): a payload envelope carrying
 * secret or session material is refused with an explicit security error,
 * never dropped. Events are opaque closed shapes - this surface evaluates
 * nothing (no eval, no new Function), fetches nothing and never persists.
 *
 * Closed contracts (invariants 4 and 7): the four region states are exactly
 * the shared REGION_STATES; trace kinds are the declared vocabulary
 * run | node | error | manual; an empty trace is empty with reason none,
 * never a fifth state.
 *
 * Pilot (invariants 1 and 9): the original n8n editor stays the default
 * path; rollback is switching the pilot off with no residual state and no
 * workflow-data migration (rollbackStrategy: pilot-not-primary in the
 * surface-migrations manifest).
 */
import { observation } from './parity.mjs';
import { REGION_STATES } from './surface-contract.mjs';

export const WORK_TRACE_STATES = REGION_STATES;

export const WORK_TRACE_SURFACE_ID = 'work-trace';
export const WORK_TRACE_SURFACE_VERSION = 'p1';
export const WORK_TRACE_MESSAGE_SLOT = 'work-trace';

/** Closed event-kind vocabulary: what a handed-over trace event represents. */
export const TRACE_EVENT_KINDS = Object.freeze(['run', 'node', 'error', 'manual']);

/** Closed empty reason: no events handed over is none, never a fifth state. */
export const WORK_TRACE_EMPTY_REASONS = Object.freeze(['none']);

/** Closed action vocabulary: what the user may ask for in a state (declared). */
export const WORK_TRACE_ACTIONS = Object.freeze(['refresh', 'request-open-event']);

/**
 * Closed request-result vocabularies: every declared outcome is explicit.
 * All of them answer for the DECLARED request - the capability that owns the
 * navigation performs the action, never this surface, and no result claims a
 * route moved (the owning capability performs it).
 */
export const WORK_TRACE_OPEN_RESULTS = Object.freeze(['accepted', 'unknown-event', 'not-ready']);

/** Bounds: visible event window (default/hard) and the label ceiling. */
export const WORK_TRACE_MAX_VISIBLE_DEFAULT = 30;
export const WORK_TRACE_MAX_VISIBLE_HARD_MAX = 100;
export const TRACE_LABEL_MAX_LENGTH = 200;

/** The a11y labels for the interactive controls, declared once. */
export const WORK_TRACE_LABELS = Object.freeze({
  open: 'Open event',
  refresh: 'Refresh trace',
});

/** Closed event record shape: one handed-over trace event. */
const EVENT_KEYS = Object.freeze(['id', 'kind', 'at', 'label']);

/** Closed hand-over payload: one load, the event list. */
const PAYLOAD_KEYS = Object.freeze(['events']);

/**
 * Fields that would carry secret or session material in the hand-over
 * envelope. Refused with an explicit security error - fail-closed, never
 * dropped (the credentials runtime owns them; session material never reaches
 * the timeline).
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

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

function assertEvent(event, index, seenIds) {
  if (event === null || typeof event !== 'object' || Array.isArray(event)) {
    throw new Error(`event ${index} must be an object`);
  }
  const keys = Object.keys(event);
  assertNoSecretFields(keys, `event ${index}`);
  const sorted = keys.sort();
  if (sorted.join(',') !== [...EVENT_KEYS].sort().join(',')) {
    throw new Error(`event ${index} must have exactly id,kind,at,label (got ${sorted.join(',')})`);
  }
  if (typeof event.id !== 'string' || event.id.trim() === '') {
    throw new Error(`event ${index} field id must be a non-empty string`);
  }
  if (!TRACE_EVENT_KINDS.includes(event.kind)) {
    throw new Error(`event ${index} field kind must be one of ${TRACE_EVENT_KINDS.join(', ')} (got "${event.kind}")`);
  }
  if (typeof event.at !== 'string' || !ISO_TIMESTAMP.test(event.at)) {
    throw new Error(`event ${index} field at must be an ISO timestamp (got "${event.at}")`);
  }
  if (typeof event.label !== 'string') {
    throw new Error(`event ${index} field label must be a string`);
  }
  if (event.label.length > TRACE_LABEL_MAX_LENGTH) {
    throw new Error(`event ${index} field label must be at most ${TRACE_LABEL_MAX_LENGTH} characters`);
  }
  if (seenIds.has(event.id)) {
    throw new Error(`event ${index} repeats the id "${event.id}": event ids are unique`);
  }
}

/** The declared surface contract: states keyed on REGION_STATES exactly. */
export function workTraceSurfaceContract() {
  return Object.freeze({
    id: WORK_TRACE_SURFACE_ID,
    version: WORK_TRACE_SURFACE_VERSION,
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
      eventKinds: TRACE_EVENT_KINDS,
      actions: WORK_TRACE_ACTIONS,
      openResults: WORK_TRACE_OPEN_RESULTS,
      emptyReasons: WORK_TRACE_EMPTY_REASONS,
    }),
    bounds: Object.freeze({
      maxVisibleDefault: WORK_TRACE_MAX_VISIBLE_DEFAULT,
      maxVisibleHardMax: WORK_TRACE_MAX_VISIBLE_HARD_MAX,
      labelMaxLength: TRACE_LABEL_MAX_LENGTH,
    }),
  });
}

/**
 * The a11y intent is derived ONCE here, so the contract's declared observables
 * and the view-model's rendered attributes cannot drift. The ready state is
 * the form landmark; every other state is a status. Only error is aria-live
 * assertive; only loading is aria-busy.
 */
export const WORK_TRACE_A11Y = Object.freeze(
  Object.fromEntries(
    WORK_TRACE_STATES.map((state) => [
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
export function workTraceActionsFor(region) {
  if (region === 'error') return Object.freeze(['refresh']);
  if (region === 'loading') return Object.freeze([]);
  if (region === 'empty') return Object.freeze(['refresh']);
  return Object.freeze(['refresh', 'request-open-event']);
}

function interactionsFor(region) {
  const actions = workTraceActionsFor(region);
  return Object.freeze({
    refresh: actions.includes('refresh'),
    requestOpenEvent: actions.includes('request-open-event'),
  });
}

/**
 * Create the Work Trace view-model. The trace enters ONLY through
 * loadSuccess() (one hand-over); the surface performs no fetch, mutates no
 * record, never reads window/history and never navigates - request-open-event
 * is DECLARED with explicit results, and the owning capability performs it.
 */
export function createWorkTraceSurface(options = {}) {
  const locale = options.locale ?? 'en';
  const requestedMax = options.maxVisible ?? WORK_TRACE_MAX_VISIBLE_DEFAULT;
  if (!Number.isInteger(requestedMax) || requestedMax <= 0) {
    throw new Error('maxVisible must be a positive integer');
  }
  const maxVisible = Math.min(requestedMax, WORK_TRACE_MAX_VISIBLE_HARD_MAX);
  const renderAvailable = options.renderAvailable ?? true;

  let events = Object.freeze([]);
  let eventIds = new Set();
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
    // The window keeps the NEWEST events (the slice tail); truncation is
    // reported, never silent.
    const shown = events.slice(-maxVisible);
    return Object.freeze({
      visible: true,
      visibleCount: events.length,
      shown: Object.freeze(shown.map((event) => Object.freeze({
        id: event.id,
        kind: event.kind,
        at: event.at,
        label: event.label,
      }))),
      truncated: events.length > shown.length,
      total: events.length,
      reason: region === 'empty' ? 'none' : null,
      focusOrder: Object.freeze(region === 'ready'
        ? events.map((event) => `event:${event.id}`)
        : []),
      labels: WORK_TRACE_LABELS,
      announcement: pendingAnnouncement,
      actions: workTraceActionsFor(region),
      error: region === 'error' ? { kind: error?.kind ?? 'network' } : null,
    });
  }

  function a11y() {
    return WORK_TRACE_A11Y[regionState()];
  }

  return Object.freeze({
    id: WORK_TRACE_SURFACE_ID,
    contract: workTraceSurfaceContract(),
    maxVisible,
    /**
     * The only data entry point (one hand-over: the trace events). Secret-
     * bearing envelopes, duplicate ids, unknown kinds and malformed records
     * are refused.
     */
    loadSuccess(payload) {
      if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new Error('loadSuccess expects a hand-over payload object {events}');
      }
      const keys = Object.keys(payload);
      assertNoSecretFields(keys, 'loadSuccess payload');
      const sorted = keys.sort();
      if (sorted.join(',') !== [...PAYLOAD_KEYS].sort().join(',')) {
        throw new Error(`loadSuccess payload must have exactly ${PAYLOAD_KEYS.join(',')} (got ${sorted.join(',')})`);
      }
      if (!Array.isArray(payload.events)) {
        throw new Error('loadSuccess payload field events (array) is required');
      }
      const seen = new Set();
      payload.events.forEach((event, index) => {
        assertEvent(event, index, seen);
        seen.add(event.id);
      });
      events = Object.freeze(payload.events.map((event) => Object.freeze({ ...event })));
      eventIds = seen;
      error = null;
      loaded = true;
      pendingAnnouncement = null;
      region = events.length > 0 ? 'ready' : 'empty';
      pushEvent('loaded');
      return events.length;
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
    /** Back to loading. Events are retained but the region is loading. */
    setLoading() {
      region = 'loading';
      pushEvent('loading');
      return 'loading';
    },
    /**
     * DECLARED, never executed here: ask the app layer (the capability that
     * owns navigation) to open an event. The route never moves locally - the
     * owning capability performs the navigation.
     */
    requestOpenEvent(eventId) {
      if (typeof eventId !== 'string' || eventId.trim() === '') {
        throw new Error('requestOpenEvent expects a non-empty event id');
      }
      if (region !== 'ready') return 'not-ready';
      if (!eventIds.has(eventId)) return 'unknown-event';
      pushEvent('open-requested');
      pendingAnnouncement = eventId;
      return 'accepted';
    },
    displayModel,
    a11y,
    /** Observable snapshot for the parity harness (candidate side). */
    observe() {
      const state = regionState();
      const model = displayModel();
      const events = state === 'ready' ? ['work-trace:rendered'] : [];
      if (state === 'ready' && model.announcement !== null) {
        events.push('work-trace:changed');
      }
      return observation({
        surfaceId: WORK_TRACE_SURFACE_ID,
        side: 'candidate',
        visible: model.visible === true,
        regionState: state,
        loading: state === 'loading',
        empty: state === 'empty',
        error: state === 'error' ? { kind: error?.kind ?? 'network' } : null,
        interactions: interactionsFor(state),
        events: Object.freeze(events),
        accessibility: a11y(),
        localization: Object.freeze({ slot: WORK_TRACE_MESSAGE_SLOT, locale }),
        contract: Object.freeze({ id: WORK_TRACE_SURFACE_ID, version: WORK_TRACE_SURFACE_VERSION }),
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
 * their interactions come from the SAME workTraceActionsFor rule the
 * view-model uses, so the two sides cannot drift by construction.
 */
function referenceObservation({ regionState: state, error = null, events = [], locale }) {
  return observation({
    surfaceId: WORK_TRACE_SURFACE_ID,
    side: 'reference',
    visible: true,
    regionState: state,
    loading: state === 'loading',
    empty: state === 'empty',
    error,
    interactions: interactionsFor(state),
    events: Object.freeze(events),
    accessibility: WORK_TRACE_A11Y[state],
    localization: Object.freeze({ slot: WORK_TRACE_MESSAGE_SLOT, locale }),
    contract: Object.freeze({ id: WORK_TRACE_SURFACE_ID, version: WORK_TRACE_SURFACE_VERSION }),
  });
}

export function referenceLoadingObservation(locale = 'en') {
  return referenceObservation({ regionState: 'loading', locale });
}

export function referenceEmptyObservation({ reason = 'none', locale = 'en' } = {}) {
  if (!WORK_TRACE_EMPTY_REASONS.includes(reason)) {
    throw new Error(`reason must be one of ${WORK_TRACE_EMPTY_REASONS.join(', ')} (got "${reason}")`);
  }
  return referenceObservation({ regionState: 'empty', locale });
}

export function referenceReadyObservation(locale = 'en') {
  return referenceObservation({ regionState: 'ready', events: ['work-trace:rendered'], locale });
}

export function referenceErrorObservation({ errorKind = 'network', locale = 'en' } = {}) {
  return referenceObservation({ regionState: 'error', error: { kind: errorKind }, locale });
}
