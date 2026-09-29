/**
 * AI Copilot surface pilot (P2-S23, issue #240) - the strangler slice for
 * the inline copilot suggestion surface, split out of P2-S03 (Layer 5). One
 * surface, one delivery scope: render the handed-over suggestion events and
 * ask the app layer to accept or reject them through DECLARED interactions.
 *
 * Boundary (invariants 4-5): suggestions ARRIVE as declared AI capability
 * events (inputBoundary source hand-over) through declared capabilities
 * only. **A suggestion is never applied silently** - the surface writes no
 * suggestion status, mutates no record and holds no second source of truth:
 * accept / reject are DECLARED requests with explicit results, the owning
 * capability performs them, and the outcome arrives only via a fresh
 * hand-over. No fetch, no inference client, no persistence.
 *
 * Security boundary (the load-bearing rule): a payload envelope carrying
 * secret or session material is refused with an explicit security error,
 * never dropped. Suggestions are opaque closed shapes - this surface
 * evaluates nothing (no eval, no new Function), fetches nothing and never
 * persists.
 *
 * Closed contracts (invariants 4 and 7): the four region states are exactly
 * the shared REGION_STATES; suggestion status is the declared subset
 * pending | accepted | rejected; a workspace with no suggestions is empty
 * with reason none, never a fifth state.
 *
 * Pilot (invariants 1 and 9): the original n8n editor stays the default
 * path; rollback is switching the pilot off with no residual state and no
 * workflow-data migration (rollbackStrategy: pilot-not-primary in the
 * surface-migrations manifest).
 */
import { observation } from './parity.mjs';
import { REGION_STATES } from './surface-contract.mjs';

export const COPILOT_STATES = REGION_STATES;

export const COPILOT_SURFACE_ID = 'copilot';
export const COPILOT_SURFACE_VERSION = 'p1';
export const COPILOT_MESSAGE_SLOT = 'copilot';

/** Closed suggestion-status vocabulary: the declared lifecycle subset. */
export const SUGGESTION_STATUSES = Object.freeze(['pending', 'accepted', 'rejected']);

/** Closed empty reason: no suggestions handed over is none, never a fifth state. */
export const COPILOT_EMPTY_REASONS = Object.freeze(['none']);

/** Closed action vocabulary: what the user may ask for in a state (declared). */
export const COPILOT_ACTIONS = Object.freeze([
  'refresh', 'request-accept', 'request-reject',
]);

/**
 * Closed request-result vocabularies: every declared outcome is explicit.
 * All of them answer for the DECLARED request - the owning capability
 * performs the action, never this surface, and no result claims a status
 * changed locally (the outcome arrives only via a fresh hand-over).
 */
export const COPILOT_ACCEPT_RESULTS = Object.freeze(['accepted', 'unknown-suggestion', 'invalid-state', 'not-ready']);
export const COPILOT_REJECT_RESULTS = Object.freeze(['accepted', 'unknown-suggestion', 'invalid-state', 'not-ready']);

/** Bounds: visible suggestion list (default/hard) and the declared text length. */
export const COPILOT_MAX_VISIBLE_DEFAULT = 30;
export const COPILOT_MAX_VISIBLE_HARD_MAX = 100;
export const SUGGESTION_TEXT_MAX_LENGTH = 4000;

/** The a11y labels for the interactive controls, declared once. */
export const COPILOT_LABELS = Object.freeze({
  accept: 'Accept suggestion',
  reject: 'Reject suggestion',
  refresh: 'Refresh suggestions',
});

/** Closed suggestion record shape: one handed-over suggestion event. */
const SUGGESTION_KEYS = Object.freeze(['id', 'target', 'text', 'status']);

/** Closed hand-over payload: one load, suggestions. */
const PAYLOAD_KEYS = Object.freeze(['suggestions']);

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

function assertSuggestion(suggestion, index, seenIds) {
  if (suggestion === null || typeof suggestion !== 'object' || Array.isArray(suggestion)) {
    throw new Error(`suggestion ${index} must be an object`);
  }
  const keys = Object.keys(suggestion);
  assertNoSecretFields(keys, `suggestion ${index}`);
  const sorted = keys.sort();
  if (sorted.join(',') !== [...SUGGESTION_KEYS].sort().join(',')) {
    throw new Error(`suggestion ${index} must have exactly id,target,text,status (got ${sorted.join(',')})`);
  }
  for (const key of ['id', 'target', 'text']) {
    if (typeof suggestion[key] !== 'string' || suggestion[key].trim() === '') {
      throw new Error(`suggestion ${index} field ${key} must be a non-empty string`);
    }
  }
  if (suggestion.text.length > SUGGESTION_TEXT_MAX_LENGTH) {
    throw new Error(`suggestion ${index} field text must be at most ${SUGGESTION_TEXT_MAX_LENGTH} characters`);
  }
  if (!SUGGESTION_STATUSES.includes(suggestion.status)) {
    throw new Error(`suggestion ${index} field status must be one of ${SUGGESTION_STATUSES.join(', ')} (got "${suggestion.status}")`);
  }
  if (seenIds.has(suggestion.id)) {
    throw new Error(`suggestion ${index} repeats the id "${suggestion.id}": suggestion ids are unique`);
  }
}

/** The declared surface contract: states keyed on REGION_STATES exactly. */
export function copilotSurfaceContract() {
  return Object.freeze({
    id: COPILOT_SURFACE_ID,
    version: COPILOT_SURFACE_VERSION,
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
      suggestionStatuses: SUGGESTION_STATUSES,
      actions: COPILOT_ACTIONS,
      acceptResults: COPILOT_ACCEPT_RESULTS,
      rejectResults: COPILOT_REJECT_RESULTS,
      emptyReasons: COPILOT_EMPTY_REASONS,
    }),
    bounds: Object.freeze({
      maxVisibleDefault: COPILOT_MAX_VISIBLE_DEFAULT,
      maxVisibleHardMax: COPILOT_MAX_VISIBLE_HARD_MAX,
      textMaxLength: SUGGESTION_TEXT_MAX_LENGTH,
    }),
  });
}

/**
 * The a11y intent is derived ONCE here, so the contract's declared observables
 * and the view-model's rendered attributes cannot drift. The ready state is
 * the form landmark; every other state is a status. Only error is aria-live
 * assertive; only loading is aria-busy.
 */
export const COPILOT_A11Y = Object.freeze(
  Object.fromEntries(
    COPILOT_STATES.map((state) => [
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
export function copilotActionsFor(region) {
  if (region === 'error') return Object.freeze(['refresh']);
  if (region === 'loading') return Object.freeze([]);
  if (region === 'empty') return Object.freeze(['refresh']);
  return Object.freeze(['refresh', 'request-accept', 'request-reject']);
}

function interactionsFor(region) {
  const actions = copilotActionsFor(region);
  return Object.freeze({
    refresh: actions.includes('refresh'),
    requestAccept: actions.includes('request-accept'),
    requestReject: actions.includes('request-reject'),
  });
}

/**
 * Create the AI Copilot view-model. Suggestions enter ONLY through
 * loadSuccess() (one hand-over of declared events); the surface performs no
 * fetch, **never applies a suggestion silently**, never mutates a record and
 * never calls an inference capability - request-accept / request-reject are
 * DECLARED with explicit results, and the outcome arrives as a fresh
 * hand-over.
 */
export function createCopilotSurface(options = {}) {
  const locale = options.locale ?? 'en';
  const requestedMax = options.maxVisible ?? COPILOT_MAX_VISIBLE_DEFAULT;
  if (!Number.isInteger(requestedMax) || requestedMax <= 0) {
    throw new Error('maxVisible must be a positive integer');
  }
  const maxVisible = Math.min(requestedMax, COPILOT_MAX_VISIBLE_HARD_MAX);
  const renderAvailable = options.renderAvailable ?? true;

  let suggestions = Object.freeze([]);
  let suggestionIds = new Set();
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

  function findSuggestion(id) {
    return suggestions.find((suggestion) => suggestion.id === id);
  }

  function displayModel() {
    const shown = suggestions.slice(0, maxVisible);
    return Object.freeze({
      visible: true,
      visibleCount: suggestions.length,
      shown: Object.freeze(shown.map((suggestion) => Object.freeze({
        id: suggestion.id,
        target: suggestion.target,
        text: suggestion.text,
        status: suggestion.status,
      }))),
      pendingCount: suggestions.filter((suggestion) => suggestion.status === 'pending').length,
      truncated: suggestions.length > shown.length,
      total: suggestions.length,
      reason: region === 'empty' ? 'none' : null,
      focusOrder: Object.freeze(region === 'ready'
        ? shown
          .filter((suggestion) => suggestion.status === 'pending')
          .map((suggestion) => `suggestion:${suggestion.id}`)
        : []),
      labels: COPILOT_LABELS,
      announcement: pendingAnnouncement,
      actions: copilotActionsFor(region),
      error: region === 'error' ? { kind: error?.kind ?? 'network' } : null,
    });
  }

  function a11y() {
    return COPILOT_A11Y[regionState()];
  }

  return Object.freeze({
    id: COPILOT_SURFACE_ID,
    contract: copilotSurfaceContract(),
    maxVisible,
    /**
     * The only data entry point (one hand-over: suggestion events).
     * Secret-bearing envelopes, duplicate ids, unknown statuses and
     * malformed records are refused; nothing here can change a status.
     */
    loadSuccess(payload) {
      if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new Error('loadSuccess expects a hand-over payload object {suggestions}');
      }
      const keys = Object.keys(payload);
      assertNoSecretFields(keys, 'loadSuccess payload');
      const sorted = keys.sort();
      if (sorted.join(',') !== [...PAYLOAD_KEYS].sort().join(',')) {
        throw new Error(`loadSuccess payload must have exactly ${PAYLOAD_KEYS.join(',')} (got ${sorted.join(',')})`);
      }
      if (!Array.isArray(payload.suggestions)) {
        throw new Error('loadSuccess payload field suggestions (array) is required');
      }
      const seen = new Set();
      payload.suggestions.forEach((suggestion, index) => {
        assertSuggestion(suggestion, index, seen);
        seen.add(suggestion.id);
      });
      suggestions = Object.freeze(payload.suggestions.map((suggestion) => Object.freeze({ ...suggestion })));
      suggestionIds = seen;
      error = null;
      loaded = true;
      pendingAnnouncement = null;
      region = suggestions.length > 0 ? 'ready' : 'empty';
      pushEvent('loaded');
      return suggestions.length;
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
    /** Back to loading. Suggestions are retained but the region is loading. */
    setLoading() {
      region = 'loading';
      pushEvent('loading');
      return 'loading';
    },
    /**
     * DECLARED, never executed here: ask the app layer (the owning
     * capability) to accept the suggestion. Only a pending suggestion may be
     * accepted - a decided one is a closed invalid-state, and the status
     * never changes here.
     */
    requestAccept(suggestionId) {
      if (typeof suggestionId !== 'string' || suggestionId.trim() === '') {
        throw new Error('requestAccept expects a non-empty suggestion id');
      }
      if (region !== 'ready') return 'not-ready';
      const suggestion = findSuggestion(suggestionId);
      if (suggestion === undefined) return 'unknown-suggestion';
      if (suggestion.status !== 'pending') return 'invalid-state';
      pushEvent('accept-requested');
      pendingAnnouncement = suggestionId;
      return 'accepted';
    },
    /**
     * DECLARED, never executed here: ask the app layer to reject the
     * suggestion. Same closed rule: only pending is actionable.
     */
    requestReject(suggestionId) {
      if (typeof suggestionId !== 'string' || suggestionId.trim() === '') {
        throw new Error('requestReject expects a non-empty suggestion id');
      }
      if (region !== 'ready') return 'not-ready';
      const suggestion = findSuggestion(suggestionId);
      if (suggestion === undefined) return 'unknown-suggestion';
      if (suggestion.status !== 'pending') return 'invalid-state';
      pushEvent('reject-requested');
      pendingAnnouncement = suggestionId;
      return 'accepted';
    },
    displayModel,
    a11y,
    /** Observable snapshot for the parity harness (candidate side). */
    observe() {
      const state = regionState();
      const model = displayModel();
      const events = state === 'ready' ? ['copilot:rendered'] : [];
      if (state === 'ready' && model.announcement !== null) {
        events.push('copilot:changed');
      }
      return observation({
        surfaceId: COPILOT_SURFACE_ID,
        side: 'candidate',
        visible: model.visible === true,
        regionState: state,
        loading: state === 'loading',
        empty: state === 'empty',
        error: state === 'error' ? { kind: error?.kind ?? 'network' } : null,
        interactions: interactionsFor(state),
        events: Object.freeze(events),
        accessibility: a11y(),
        localization: Object.freeze({ slot: COPILOT_MESSAGE_SLOT, locale }),
        contract: Object.freeze({ id: COPILOT_SURFACE_ID, version: COPILOT_SURFACE_VERSION }),
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
    get suggestions() {
      return suggestions;
    },
  });
}

/* -------------------------------------------------------- the reference model */

/**
 * The reference (pinned n8n editor) observations as deterministic fixtures.
 * The reference UI is not run here - these are the declared behaviours the
 * candidate is compared against. They mirror observe() field for field, and
 * their interactions come from the SAME copilotActionsFor rule the
 * view-model uses, so the two sides cannot drift by construction.
 */
function referenceObservation({ regionState: state, error = null, events = [], locale }) {
  return observation({
    surfaceId: COPILOT_SURFACE_ID,
    side: 'reference',
    visible: true,
    regionState: state,
    loading: state === 'loading',
    empty: state === 'empty',
    error,
    interactions: interactionsFor(state),
    events: Object.freeze(events),
    accessibility: COPILOT_A11Y[state],
    localization: Object.freeze({ slot: COPILOT_MESSAGE_SLOT, locale }),
    contract: Object.freeze({ id: COPILOT_SURFACE_ID, version: COPILOT_SURFACE_VERSION }),
  });
}

export function referenceLoadingObservation(locale = 'en') {
  return referenceObservation({ regionState: 'loading', locale });
}

export function referenceEmptyObservation({ reason = 'none', locale = 'en' } = {}) {
  if (!COPILOT_EMPTY_REASONS.includes(reason)) {
    throw new Error(`reason must be one of ${COPILOT_EMPTY_REASONS.join(', ')} (got "${reason}")`);
  }
  return referenceObservation({ regionState: 'empty', locale });
}

export function referenceReadyObservation(locale = 'en') {
  return referenceObservation({ regionState: 'ready', events: ['copilot:rendered'], locale });
}

export function referenceErrorObservation({ errorKind = 'network', locale = 'en' } = {}) {
  return referenceObservation({ regionState: 'error', error: { kind: errorKind }, locale });
}
