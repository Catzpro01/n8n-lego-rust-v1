/**
 * Memory/Context/Session views surfaces pilot (P2-S26, issue #240) - the
 * strangler slice for the memory, context and session inspection surfaces,
 * split out of P2-S03 (Layer 5). One surface, one delivery scope: render the
 * handed-over inspection state read-only and ask the app layer to open an
 * entry through a DECLARED request.
 *
 * Boundary (invariants 4-5): the session state is HANDED OVER from the
 * session capability (inputBoundary source hand-over) through declared
 * capabilities only. The surface holds no private data path: no direct
 * session store access, no fetch, no mutation of a record - request-open-entry
 * is DECLARED with explicit results; the capability that owns navigation
 * performs it.
 *
 * Security boundary (the load-bearing rule): a payload envelope carrying
 * secret or session material is refused with an explicit security error,
 * never dropped. Records are opaque closed shapes - this surface evaluates
 * nothing (no eval, no new Function), fetches nothing and never persists.
 *
 * Closed contracts (invariants 4 and 7): the four region states are exactly
 * the shared REGION_STATES; memory kinds are the declared vocabulary
 * short-term | long-term | retrieved; session status is active | idle |
 * closed; an inspection with no memory entries is empty with reason none,
 * never a fifth state.
 *
 * Pilot (invariants 1 and 9): the original n8n editor stays the default
 * path; rollback is switching the pilot off with no residual state and no
 * workflow-data migration (rollbackStrategy: pilot-not-primary in the
 * surface-migrations manifest).
 */
import { observation } from './parity.mjs';
import { REGION_STATES } from './surface-contract.mjs';

export const MEMORY_VIEWS_STATES = REGION_STATES;

export const MEMORY_VIEWS_SURFACE_ID = 'memory-views';
export const MEMORY_VIEWS_SURFACE_VERSION = 'p1';
export const MEMORY_VIEWS_MESSAGE_SLOT = 'memory-views';

/** Closed memory-kind vocabulary: where a handed-over memory entry lives. */
export const MEMORY_KINDS = Object.freeze(['short-term', 'long-term', 'retrieved']);

/** Closed session-status vocabulary: the handed-over session lifecycle. */
export const SESSION_STATUSES = Object.freeze(['active', 'idle', 'closed']);

/** Closed empty reason: no memory entries handed over is none, never a fifth state. */
export const MEMORY_VIEWS_EMPTY_REASONS = Object.freeze(['none']);

/** Closed action vocabulary: what the user may ask for in a state (declared). */
export const MEMORY_VIEWS_ACTIONS = Object.freeze(['refresh', 'request-open-entry']);

/**
 * Closed request-result vocabularies: every declared outcome is explicit.
 * All of them answer for the DECLARED request - the capability that owns the
 * entry navigation performs the action, never this surface, and no result
 * claims a route moved (it is performed by the owning capability).
 */
export const MEMORY_VIEWS_OPEN_RESULTS = Object.freeze(['accepted', 'unknown-entry', 'not-ready']);

/** Bounds: visible memory entries (default/hard) and the entry text ceiling. */
export const MEMORY_VIEWS_MAX_VISIBLE_DEFAULT = 30;
export const MEMORY_VIEWS_MAX_VISIBLE_HARD_MAX = 100;
export const MEMORY_TEXT_MAX_LENGTH = 500;

/** The a11y labels for the views and controls, declared once. */
export const MEMORY_VIEWS_LABELS = Object.freeze({
  open: 'Open entry',
  refresh: 'Refresh views',
  session: 'Session view',
  context: 'Context view',
  memory: 'Memory view',
});

/** Closed memory item shape: one handed-over entry. */
const MEMORY_ITEM_KEYS = Object.freeze(['id', 'kind', 'text']);

/** Closed context shape: the handed-over token budget. */
const CONTEXT_KEYS = Object.freeze(['limit', 'used']);

/** Closed session shape: the handed-over session summary. */
const SESSION_KEYS = Object.freeze(['id', 'status', 'turns']);

/** Closed hand-over payload: one load, the three inspection records. */
const PAYLOAD_KEYS = Object.freeze(['memory', 'context', 'session']);

/**
 * Fields that would carry secret or session material in the hand-over
 * envelope. Refused with an explicit security error - fail-closed, never
 * dropped (the credentials runtime owns them; raw session tokens never
 * reach an inspection surface).
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

function assertMemoryItem(item, index, seenIds) {
  if (item === null || typeof item !== 'object' || Array.isArray(item)) {
    throw new Error(`memory item ${index} must be an object`);
  }
  const keys = Object.keys(item);
  assertNoSecretFields(keys, `memory item ${index}`);
  assertExactKeys(keys, MEMORY_ITEM_KEYS, `memory item ${index}`);
  if (typeof item.id !== 'string' || item.id.trim() === '') {
    throw new Error(`memory item ${index} field id must be a non-empty string`);
  }
  if (!MEMORY_KINDS.includes(item.kind)) {
    throw new Error(`memory item ${index} field kind must be one of ${MEMORY_KINDS.join(', ')} (got "${item.kind}")`);
  }
  if (typeof item.text !== 'string') {
    throw new Error(`memory item ${index} field text must be a string`);
  }
  if (item.text.length > MEMORY_TEXT_MAX_LENGTH) {
    throw new Error(`memory item ${index} field text must be at most ${MEMORY_TEXT_MAX_LENGTH} characters`);
  }
  if (seenIds.has(item.id)) {
    throw new Error(`memory item ${index} repeats the id "${item.id}": memory ids are unique`);
  }
}

function assertContext(context) {
  if (context === null || typeof context !== 'object' || Array.isArray(context)) {
    throw new Error('context must be an object {limit, used}');
  }
  assertExactKeys(Object.keys(context), CONTEXT_KEYS, 'context');
  if (!Number.isInteger(context.limit) || context.limit < 1) {
    throw new Error(`context field limit must be an integer >= 1 (got ${JSON.stringify(context.limit)})`);
  }
  if (!Number.isInteger(context.used) || context.used < 0) {
    throw new Error(`context field used must be an integer >= 0 (got ${JSON.stringify(context.used)})`);
  }
  if (context.used > context.limit) {
    throw new Error(`context field used must not exceed limit (${context.used} > ${context.limit})`);
  }
}

function assertSession(session) {
  if (session === null || typeof session !== 'object' || Array.isArray(session)) {
    throw new Error('session must be an object {id, status, turns}');
  }
  assertExactKeys(Object.keys(session), SESSION_KEYS, 'session');
  if (typeof session.id !== 'string' || session.id.trim() === '') {
    throw new Error('session field id must be a non-empty string');
  }
  if (!SESSION_STATUSES.includes(session.status)) {
    throw new Error(`session field status must be one of ${SESSION_STATUSES.join(', ')} (got "${session.status}")`);
  }
  if (!Number.isInteger(session.turns) || session.turns < 0) {
    throw new Error(`session field turns must be an integer >= 0 (got ${JSON.stringify(session.turns)})`);
  }
}

/** The declared surface contract: states keyed on REGION_STATES exactly. */
export function memoryViewsSurfaceContract() {
  return Object.freeze({
    id: MEMORY_VIEWS_SURFACE_ID,
    version: MEMORY_VIEWS_SURFACE_VERSION,
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
      memoryKinds: MEMORY_KINDS,
      sessionStatuses: SESSION_STATUSES,
      actions: MEMORY_VIEWS_ACTIONS,
      openResults: MEMORY_VIEWS_OPEN_RESULTS,
      emptyReasons: MEMORY_VIEWS_EMPTY_REASONS,
    }),
    bounds: Object.freeze({
      maxVisibleDefault: MEMORY_VIEWS_MAX_VISIBLE_DEFAULT,
      maxVisibleHardMax: MEMORY_VIEWS_MAX_VISIBLE_HARD_MAX,
      textMaxLength: MEMORY_TEXT_MAX_LENGTH,
    }),
  });
}

/**
 * The a11y intent is derived ONCE here, so the contract's declared observables
 * and the view-model's rendered attributes cannot drift. The ready state is
 * the form landmark; every other state is a status. Only error is aria-live
 * assertive; only loading is aria-busy.
 */
export const MEMORY_VIEWS_A11Y = Object.freeze(
  Object.fromEntries(
    MEMORY_VIEWS_STATES.map((state) => [
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
export function memoryViewsActionsFor(region) {
  if (region === 'error') return Object.freeze(['refresh']);
  if (region === 'loading') return Object.freeze([]);
  if (region === 'empty') return Object.freeze(['refresh']);
  return Object.freeze(['refresh', 'request-open-entry']);
}

function interactionsFor(region) {
  const actions = memoryViewsActionsFor(region);
  return Object.freeze({
    refresh: actions.includes('refresh'),
    requestOpenEntry: actions.includes('request-open-entry'),
  });
}

/**
 * Create the Memory/Context/Session views view-model. The inspection state
 * enters ONLY through loadSuccess() (one hand-over); the surface performs no
 * fetch, touches no session store, mutates no record and never navigates -
 * request-open-entry is DECLARED with explicit results, and the owning
 * capability performs it.
 */
export function createMemoryViewsSurface(options = {}) {
  const locale = options.locale ?? 'en';
  const requestedMax = options.maxVisible ?? MEMORY_VIEWS_MAX_VISIBLE_DEFAULT;
  if (!Number.isInteger(requestedMax) || requestedMax <= 0) {
    throw new Error('maxVisible must be a positive integer');
  }
  const maxVisible = Math.min(requestedMax, MEMORY_VIEWS_MAX_VISIBLE_HARD_MAX);
  const renderAvailable = options.renderAvailable ?? true;

  let memory = Object.freeze([]);
  let entryIds = new Set();
  let context = Object.freeze({ limit: 1, used: 0 });
  let session = Object.freeze({ id: '', turns: 0, status: 'closed' });
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
    // The window keeps the NEWEST memory entries (the slice tail);
    // truncation is reported, never silent.
    const shown = memory.slice(-maxVisible);
    return Object.freeze({
      visible: true,
      visibleCount: memory.length,
      shown: Object.freeze(shown.map((item) => Object.freeze({
        id: item.id,
        kind: item.kind,
        text: item.text,
      }))),
      truncated: memory.length > shown.length,
      total: memory.length,
      session: Object.freeze({
        id: session.id,
        turns: session.turns,
        status: session.status,
      }),
      context: Object.freeze({
        used: context.used,
        limit: context.limit,
        percent: Math.floor((context.used * 100) / context.limit),
      }),
      reason: region === 'empty' ? 'none' : null,
      focusOrder: Object.freeze(region === 'ready'
        ? Object.freeze([
          'view:session',
          'view:context',
          ...memory.map((item) => `entry:${item.id}`),
        ])
        : []),
      labels: MEMORY_VIEWS_LABELS,
      announcement: pendingAnnouncement,
      actions: memoryViewsActionsFor(region),
      error: region === 'error' ? { kind: error?.kind ?? 'network' } : null,
    });
  }

  function a11y() {
    return MEMORY_VIEWS_A11Y[regionState()];
  }

  return Object.freeze({
    id: MEMORY_VIEWS_SURFACE_ID,
    contract: memoryViewsSurfaceContract(),
    maxVisible,
    /**
     * The only data entry point (one hand-over: memory, context, session).
     * Secret-bearing envelopes, duplicate ids, unknown kinds and malformed
     * records are refused.
     */
    loadSuccess(payload) {
      if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new Error('loadSuccess expects a hand-over payload object {memory, context, session}');
      }
      const keys = Object.keys(payload);
      assertNoSecretFields(keys, 'loadSuccess payload');
      assertExactKeys(keys, PAYLOAD_KEYS, 'loadSuccess payload');
      if (!Array.isArray(payload.memory)) {
        throw new Error('loadSuccess payload field memory (array) is required');
      }
      assertContext(payload.context);
      assertSession(payload.session);
      const seen = new Set();
      payload.memory.forEach((item, index) => {
        assertMemoryItem(item, index, seen);
        seen.add(item.id);
      });
      memory = Object.freeze(payload.memory.map((item) => Object.freeze({ ...item })));
      entryIds = seen;
      context = Object.freeze({ limit: payload.context.limit, used: payload.context.used });
      session = Object.freeze({
        id: payload.session.id,
        turns: payload.session.turns,
        status: payload.session.status,
      });
      error = null;
      loaded = true;
      pendingAnnouncement = null;
      region = memory.length > 0 ? 'ready' : 'empty';
      pushEvent('loaded');
      return memory.length;
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
     * owns navigation) to open a memory entry. The route never moves locally -
     * the owning capability performs the navigation.
     */
    requestOpenEntry(entryId) {
      if (typeof entryId !== 'string' || entryId.trim() === '') {
        throw new Error('requestOpenEntry expects a non-empty entry id');
      }
      if (region !== 'ready') return 'not-ready';
      if (!entryIds.has(entryId)) return 'unknown-entry';
      pushEvent('open-requested');
      pendingAnnouncement = entryId;
      return 'accepted';
    },
    displayModel,
    a11y,
    /** Observable snapshot for the parity harness (candidate side). */
    observe() {
      const state = regionState();
      const model = displayModel();
      const events = state === 'ready' ? ['memory-views:rendered'] : [];
      if (state === 'ready' && model.announcement !== null) {
        events.push('memory-views:changed');
      }
      return observation({
        surfaceId: MEMORY_VIEWS_SURFACE_ID,
        side: 'candidate',
        visible: model.visible === true,
        regionState: state,
        loading: state === 'loading',
        empty: state === 'empty',
        error: state === 'error' ? { kind: error?.kind ?? 'network' } : null,
        interactions: interactionsFor(state),
        events: Object.freeze(events),
        accessibility: a11y(),
        localization: Object.freeze({ slot: MEMORY_VIEWS_MESSAGE_SLOT, locale }),
        contract: Object.freeze({ id: MEMORY_VIEWS_SURFACE_ID, version: MEMORY_VIEWS_SURFACE_VERSION }),
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
    get memory() {
      return memory;
    },
    get context() {
      return context;
    },
    get session() {
      return session;
    },
  });
}

/* -------------------------------------------------------- the reference model */

/**
 * The reference (pinned n8n editor) observations as deterministic fixtures.
 * The reference UI is not run here - these are the declared behaviours the
 * candidate is compared against. They mirror observe() field for field, and
 * their interactions come from the SAME memoryViewsActionsFor rule the
 * view-model uses, so the two sides cannot drift by construction.
 */
function referenceObservation({ regionState: state, error = null, events = [], locale }) {
  return observation({
    surfaceId: MEMORY_VIEWS_SURFACE_ID,
    side: 'reference',
    visible: true,
    regionState: state,
    loading: state === 'loading',
    empty: state === 'empty',
    error,
    interactions: interactionsFor(state),
    events: Object.freeze(events),
    accessibility: MEMORY_VIEWS_A11Y[state],
    localization: Object.freeze({ slot: MEMORY_VIEWS_MESSAGE_SLOT, locale }),
    contract: Object.freeze({ id: MEMORY_VIEWS_SURFACE_ID, version: MEMORY_VIEWS_SURFACE_VERSION }),
  });
}

export function referenceLoadingObservation(locale = 'en') {
  return referenceObservation({ regionState: 'loading', locale });
}

export function referenceEmptyObservation({ reason = 'none', locale = 'en' } = {}) {
  if (!MEMORY_VIEWS_EMPTY_REASONS.includes(reason)) {
    throw new Error(`reason must be one of ${MEMORY_VIEWS_EMPTY_REASONS.join(', ')} (got "${reason}")`);
  }
  return referenceObservation({ regionState: 'empty', locale });
}

export function referenceReadyObservation(locale = 'en') {
  return referenceObservation({ regionState: 'ready', events: ['memory-views:rendered'], locale });
}

export function referenceErrorObservation({ errorKind = 'network', locale = 'en' } = {}) {
  return referenceObservation({ regionState: 'error', error: { kind: errorKind }, locale });
}
