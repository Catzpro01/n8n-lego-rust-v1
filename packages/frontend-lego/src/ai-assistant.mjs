/**
 * AI Assistant surface pilot (P2-S22, issue #240) - the strangler slice for
 * the conversational assistant surface, split out of P2-S03 (Layer 5). One
 * surface, one delivery scope: render the handed-over assistant turn events
 * and ask the app layer to send or stop through DECLARED interactions.
 *
 * Boundary (invariants 4-5): assistant turns are HANDED OVER as events
 * (inputBoundary source hand-over) through declared capabilities only. **The
 * surface never fabricates assistant output** - no method here writes a turn
 * or invents a reply; a new turn arrives only via a fresh hand-over
 * (loadSuccess). It holds no private data path and no second source of
 * truth: no fetch, no mutation of a record, no inference call, no provider
 * client. request-send / request-stop-stream are DECLARED interactions with
 * explicit results; the capability that owns inference performs them.
 *
 * Security boundary (the load-bearing rule): a payload envelope carrying
 * secret or session material is refused with an explicit security error,
 * never dropped. Turns are opaque closed shapes - this surface evaluates
 * nothing (no eval, no new Function), fetches nothing and never persists
 * (a conversation never lands on disk from here).
 *
 * Closed contracts (invariants 4 and 7): the four region states are exactly
 * the shared REGION_STATES; turn roles are the declared subset
 * user | assistant; an empty conversation is empty with reason none, never a
 * fifth state.
 *
 * Pilot (invariants 1 and 9): the original n8n editor stays the default
 * path; rollback is switching the pilot off with no residual state and no
 * workflow-data migration (rollbackStrategy: pilot-not-primary in the
 * surface-migrations manifest).
 */
import { observation } from './parity.mjs';
import { REGION_STATES } from './surface-contract.mjs';

export const AI_ASSISTANT_STATES = REGION_STATES;

export const AI_ASSISTANT_SURFACE_ID = 'assistant';
export const AI_ASSISTANT_SURFACE_VERSION = 'p1';
export const AI_ASSISTANT_MESSAGE_SLOT = 'assistant';

/** Closed role vocabulary: who spoke a handed-over turn. */
export const TURN_ROLES = Object.freeze(['user', 'assistant']);

/** Closed empty reason: no turns handed over is none, never a fifth state. */
export const AI_ASSISTANT_EMPTY_REASONS = Object.freeze(['none']);

/** Closed action vocabulary: what the user may ask for in a state (declared). */
export const AI_ASSISTANT_ACTIONS = Object.freeze([
  'refresh', 'request-send', 'request-stop-stream',
]);

/**
 * Closed request-result vocabularies: every declared outcome is explicit.
 * All of them answer for the DECLARED request - the capability that owns
 * inference performs the action, never this surface, and no result claims a
 * turn was appended (the reply arrives only as a fresh hand-over).
 */
export const AI_ASSISTANT_SEND_RESULTS = Object.freeze(['accepted', 'invalid-text', 'not-ready']);
export const AI_ASSISTANT_STOP_STREAM_RESULTS = Object.freeze(['accepted', 'not-streaming', 'not-ready']);

/** Bounds: visible turn window (default/hard) and the declared text lengths. */
export const AI_ASSISTANT_MAX_VISIBLE_DEFAULT = 30;
export const AI_ASSISTANT_MAX_VISIBLE_HARD_MAX = 100;
export const TURN_TEXT_MAX_LENGTH = 4000;
export const SEND_TEXT_MAX_LENGTH = 2000;

/** The a11y labels for the interactive controls, declared once. */
export const AI_ASSISTANT_LABELS = Object.freeze({
  composer: 'Message the assistant',
  send: 'Send message',
  stopStream: 'Stop streaming response',
  refresh: 'Refresh conversation',
});

/** Closed turn record shape: one handed-over conversation event. */
const TURN_KEYS = Object.freeze(['id', 'role', 'text']);

/** Closed hand-over payload: one load, turns + streaming. */
const PAYLOAD_KEYS = Object.freeze(['turns', 'streaming']);

/**
 * Fields that would carry secret or session material in the hand-over
 * envelope. Refused with an explicit security error - fail-closed, never
 * dropped (the credentials runtime owns them; an inference provider token
 * never reaches this surface).
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

function assertTurn(turn, index, seenIds) {
  if (turn === null || typeof turn !== 'object' || Array.isArray(turn)) {
    throw new Error(`turn ${index} must be an object`);
  }
  const keys = Object.keys(turn);
  assertNoSecretFields(keys, `turn ${index}`);
  const sorted = keys.sort();
  if (sorted.join(',') !== [...TURN_KEYS].sort().join(',')) {
    throw new Error(`turn ${index} must have exactly id,role,text (got ${sorted.join(',')})`);
  }
  for (const key of ['id', 'text']) {
    if (typeof turn[key] !== 'string' || turn[key].trim() === '') {
      throw new Error(`turn ${index} field ${key} must be a non-empty string`);
    }
  }
  if (turn.text.length > TURN_TEXT_MAX_LENGTH) {
    throw new Error(`turn ${index} field text must be at most ${TURN_TEXT_MAX_LENGTH} characters`);
  }
  if (!TURN_ROLES.includes(turn.role)) {
    throw new Error(`turn ${index} field role must be one of ${TURN_ROLES.join(', ')} (got "${turn.role}")`);
  }
  if (seenIds.has(turn.id)) {
    throw new Error(`turn ${index} repeats the id "${turn.id}": turn ids are unique`);
  }
}

/** The declared surface contract: states keyed on REGION_STATES exactly. */
export function aiAssistantSurfaceContract() {
  return Object.freeze({
    id: AI_ASSISTANT_SURFACE_ID,
    version: AI_ASSISTANT_SURFACE_VERSION,
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
      turnRoles: TURN_ROLES,
      actions: AI_ASSISTANT_ACTIONS,
      sendResults: AI_ASSISTANT_SEND_RESULTS,
      stopStreamResults: AI_ASSISTANT_STOP_STREAM_RESULTS,
      emptyReasons: AI_ASSISTANT_EMPTY_REASONS,
    }),
    bounds: Object.freeze({
      maxVisibleDefault: AI_ASSISTANT_MAX_VISIBLE_DEFAULT,
      maxVisibleHardMax: AI_ASSISTANT_MAX_VISIBLE_HARD_MAX,
      turnTextMaxLength: TURN_TEXT_MAX_LENGTH,
      sendTextMaxLength: SEND_TEXT_MAX_LENGTH,
    }),
  });
}

/**
 * The a11y intent is derived ONCE here, so the contract's declared observables
 * and the view-model's rendered attributes cannot drift. The ready state is
 * the form landmark; every other state is a status. Only error is aria-live
 * assertive; only loading is aria-busy.
 */
export const AI_ASSISTANT_A11Y = Object.freeze(
  Object.fromEntries(
    AI_ASSISTANT_STATES.map((state) => [
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
export function aiAssistantActionsFor(region) {
  if (region === 'error') return Object.freeze(['refresh']);
  if (region === 'loading') return Object.freeze([]);
  if (region === 'empty') return Object.freeze(['refresh']);
  return Object.freeze(['refresh', 'request-send', 'request-stop-stream']);
}

function interactionsFor(region) {
  const actions = aiAssistantActionsFor(region);
  return Object.freeze({
    refresh: actions.includes('refresh'),
    requestSend: actions.includes('request-send'),
    requestStopStream: actions.includes('request-stop-stream'),
  });
}

/**
 * Create the AI Assistant view-model. Assistant turns enter ONLY through
 * loadSuccess() (one hand-over of turn events); the surface performs no
 * fetch, **never fabricates assistant output**, never mutates a turn and
 * never calls an inference capability - request-send / request-stop-stream
 * are DECLARED with explicit results, and the reply arrives as a fresh
 * hand-over.
 */
export function createAiAssistantSurface(options = {}) {
  const locale = options.locale ?? 'en';
  const requestedMax = options.maxVisible ?? AI_ASSISTANT_MAX_VISIBLE_DEFAULT;
  if (!Number.isInteger(requestedMax) || requestedMax <= 0) {
    throw new Error('maxVisible must be a positive integer');
  }
  const maxVisible = Math.min(requestedMax, AI_ASSISTANT_MAX_VISIBLE_HARD_MAX);
  const renderAvailable = options.renderAvailable ?? true;

  let turns = Object.freeze([]);
  let turnIds = new Set();
  let streaming = false;
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
    // The visible window is the LAST maxVisible turns (a conversation reads
    // forward); truncation is reported, never silent.
    const shown = turns.slice(Math.max(0, turns.length - maxVisible));
    return Object.freeze({
      visible: true,
      visibleCount: turns.length,
      shown: Object.freeze(shown.map((turn) => Object.freeze({
        id: turn.id,
        role: turn.role,
        text: turn.text,
      }))),
      streaming: streaming,
      truncated: turns.length > shown.length,
      total: turns.length,
      reason: region === 'empty' ? 'none' : null,
      focusOrder: Object.freeze(region === 'ready'
        ? [
          'composer', 'send',
          ...(streaming ? ['stop-stream'] : []),
        ]
        : []),
      labels: AI_ASSISTANT_LABELS,
      announcement: pendingAnnouncement,
      actions: aiAssistantActionsFor(region),
      error: region === 'error' ? { kind: error?.kind ?? 'network' } : null,
    });
  }

  function a11y() {
    return AI_ASSISTANT_A11Y[regionState()];
  }

  return Object.freeze({
    id: AI_ASSISTANT_SURFACE_ID,
    contract: aiAssistantSurfaceContract(),
    maxVisible,
    /**
     * The only data entry point (one hand-over: turn events + streaming
     * flag). Secret-bearing envelopes, duplicate ids, unknown roles and
     * malformed records are refused; nothing here can append a turn.
     */
    loadSuccess(payload) {
      if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new Error('loadSuccess expects a hand-over payload object {turns, streaming}');
      }
      const keys = Object.keys(payload);
      assertNoSecretFields(keys, 'loadSuccess payload');
      const sorted = keys.sort();
      if (sorted.join(',') !== [...PAYLOAD_KEYS].sort().join(',')) {
        throw new Error(`loadSuccess payload must have exactly ${PAYLOAD_KEYS.join(',')} (got ${sorted.join(',')})`);
      }
      if (!Array.isArray(payload.turns)) {
        throw new Error('loadSuccess payload field turns (array) is required');
      }
      if (typeof payload.streaming !== 'boolean') {
        throw new Error('loadSuccess payload field streaming (boolean) is required');
      }
      const seen = new Set();
      payload.turns.forEach((turn, index) => {
        assertTurn(turn, index, seen);
        seen.add(turn.id);
      });
      turns = Object.freeze(payload.turns.map((turn) => Object.freeze({ ...turn })));
      turnIds = seen;
      streaming = payload.streaming;
      error = null;
      loaded = true;
      pendingAnnouncement = null;
      region = turns.length > 0 ? 'ready' : 'empty';
      pushEvent('loaded');
      return turns.length;
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
    /** Back to loading. Turns are retained but the region is loading. */
    setLoading() {
      region = 'loading';
      pushEvent('loading');
      return 'loading';
    },
    /**
     * DECLARED, never executed here: ask the app layer (the capability that
     * owns inference) to send the composer text. No turn is appended here -
     * the user turn and any assistant reply arrive only as fresh hand-overs.
     * The composer rule is closed: non-empty, <= 2000 chars.
     */
    requestSend(text) {
      if (typeof text !== 'string') {
        throw new Error('requestSend expects a text string');
      }
      if (region !== 'ready') return 'not-ready';
      if (text.trim() === '' || text.length > SEND_TEXT_MAX_LENGTH) return 'invalid-text';
      pushEvent('send-requested');
      pendingAnnouncement = 'sent';
      return 'accepted';
    },
    /**
     * DECLARED, never executed here: ask the app layer to stop an in-flight
     * streamed reply. The streaming flag is handed over - this surface never
     * toggles it.
     */
    requestStopStream() {
      if (region !== 'ready') return 'not-ready';
      if (!streaming) return 'not-streaming';
      pushEvent('stop-stream-requested');
      pendingAnnouncement = 'stopping';
      return 'accepted';
    },
    displayModel,
    a11y,
    /** Observable snapshot for the parity harness (candidate side). */
    observe() {
      const state = regionState();
      const model = displayModel();
      const events = state === 'ready' ? ['ai-assistant:rendered'] : [];
      if (state === 'ready' && model.announcement !== null) {
        events.push('ai-assistant:changed');
      }
      return observation({
        surfaceId: AI_ASSISTANT_SURFACE_ID,
        side: 'candidate',
        visible: model.visible === true,
        regionState: state,
        loading: state === 'loading',
        empty: state === 'empty',
        error: state === 'error' ? { kind: error?.kind ?? 'network' } : null,
        interactions: interactionsFor(state),
        events: Object.freeze(events),
        accessibility: a11y(),
        localization: Object.freeze({ slot: AI_ASSISTANT_MESSAGE_SLOT, locale }),
        contract: Object.freeze({ id: AI_ASSISTANT_SURFACE_ID, version: AI_ASSISTANT_SURFACE_VERSION }),
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
    get streaming() {
      return streaming;
    },
    get turns() {
      return turns;
    },
  });
}

/* -------------------------------------------------------- the reference model */

/**
 * The reference (pinned n8n editor) observations as deterministic fixtures.
 * The reference UI is not run here - these are the declared behaviours the
 * candidate is compared against. They mirror observe() field for field, and
 * their interactions come from the SAME aiAssistantActionsFor rule the
 * view-model uses, so the two sides cannot drift by construction.
 */
function referenceObservation({ regionState: state, error = null, events = [], locale }) {
  return observation({
    surfaceId: AI_ASSISTANT_SURFACE_ID,
    side: 'reference',
    visible: true,
    regionState: state,
    loading: state === 'loading',
    empty: state === 'empty',
    error,
    interactions: interactionsFor(state),
    events: Object.freeze(events),
    accessibility: AI_ASSISTANT_A11Y[state],
    localization: Object.freeze({ slot: AI_ASSISTANT_MESSAGE_SLOT, locale }),
    contract: Object.freeze({ id: AI_ASSISTANT_SURFACE_ID, version: AI_ASSISTANT_SURFACE_VERSION }),
  });
}

export function referenceLoadingObservation(locale = 'en') {
  return referenceObservation({ regionState: 'loading', locale });
}

export function referenceEmptyObservation({ reason = 'none', locale = 'en' } = {}) {
  if (!AI_ASSISTANT_EMPTY_REASONS.includes(reason)) {
    throw new Error(`reason must be one of ${AI_ASSISTANT_EMPTY_REASONS.join(', ')} (got "${reason}")`);
  }
  return referenceObservation({ regionState: 'empty', locale });
}

export function referenceReadyObservation(locale = 'en') {
  return referenceObservation({ regionState: 'ready', events: ['ai-assistant:rendered'], locale });
}

export function referenceErrorObservation({ errorKind = 'network', locale = 'en' } = {}) {
  return referenceObservation({ regionState: 'error', error: { kind: errorKind }, locale });
}
