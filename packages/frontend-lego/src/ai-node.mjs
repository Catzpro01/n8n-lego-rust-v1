/**
 * AI Node surfaces pilot (P2-S24, issue #240) - the strangler slice for the
 * AI-node parameter and model-picker surfaces, split out of P2-S03 (Layer 5).
 * One surface, one delivery scope: render the handed-over model catalog and
 * ask the app layer to write the node parameter through a DECLARED request.
 *
 * Boundary (invariants 4-5): the model catalog is HANDED OVER from the
 * node/parameter contracts (inputBoundary source hand-over) through declared
 * capabilities only. The surface holds no second source of truth: no fetch,
 * no mutation of the catalog, no local write of the selected model - a
 * parameter change arrives only via a fresh hand-over. request-select-model
 * is DECLARED with explicit results; the capability that owns the parameter
 * performs it.
 *
 * Security boundary (the load-bearing rule): a payload envelope carrying
 * secret or session material is refused with an explicit security error,
 * never dropped. Models are opaque closed shapes - this surface evaluates
 * nothing (no eval, no new Function), fetches nothing and never persists.
 *
 * Closed contracts (invariants 4 and 7): the four region states are exactly
 * the shared REGION_STATES; providers are the declared subset
 * hosted | local | custom; a node with no models is empty with reason none,
 * never a fifth state.
 *
 * Pilot (invariants 1 and 9): the original n8n editor stays the default
 * path; rollback is switching the pilot off with no residual state and no
 * workflow-data migration (rollbackStrategy: pilot-not-primary in the
 * surface-migrations manifest).
 */
import { observation } from './parity.mjs';
import { REGION_STATES } from './surface-contract.mjs';

export const AI_NODE_STATES = REGION_STATES;

export const AI_NODE_SURFACE_ID = 'ai-node';
export const AI_NODE_SURFACE_VERSION = 'p1';
export const AI_NODE_MESSAGE_SLOT = 'ai-node';

/** Closed provider vocabulary: where a handed-over model comes from. */
export const MODEL_PROVIDERS = Object.freeze(['hosted', 'local', 'custom']);

/** Closed empty reason: no models handed over is none, never a fifth state. */
export const AI_NODE_EMPTY_REASONS = Object.freeze(['none']);

/** Closed action vocabulary: what the user may ask for in a state (declared). */
export const AI_NODE_ACTIONS = Object.freeze(['refresh', 'request-select-model']);

/**
 * Closed request-result vocabularies: every declared outcome is explicit.
 * All of them answer for the DECLARED request - the capability that owns the
 * node parameter performs the action, never this surface, and no result
 * claims the selection moved (it arrives only via a fresh hand-over).
 */
export const AI_NODE_SELECT_RESULTS = Object.freeze(['accepted', 'unknown-model', 'not-ready']);

/** Bounds: visible model list (default/hard). */
export const AI_NODE_MAX_VISIBLE_DEFAULT = 30;
export const AI_NODE_MAX_VISIBLE_HARD_MAX = 100;

/** The a11y labels for the interactive controls, declared once. */
export const AI_NODE_LABELS = Object.freeze({
  select: 'Select model',
  refresh: 'Refresh models',
});

/** Closed model record shape: one handed-over catalog entry. */
const MODEL_KEYS = Object.freeze(['id', 'name', 'provider']);

/** Closed hand-over payload: one load, models + selectedModelId. */
const PAYLOAD_KEYS = Object.freeze(['models', 'selectedModelId']);

/**
 * Fields that would carry secret or session material in the hand-over
 * envelope. Refused with an explicit security error - fail-closed, never
 * dropped (the credentials runtime owns them; a model provider API key
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

function assertModel(model, index, seenIds) {
  if (model === null || typeof model !== 'object' || Array.isArray(model)) {
    throw new Error(`model ${index} must be an object`);
  }
  const keys = Object.keys(model);
  assertNoSecretFields(keys, `model ${index}`);
  const sorted = keys.sort();
  if (sorted.join(',') !== [...MODEL_KEYS].sort().join(',')) {
    throw new Error(`model ${index} must have exactly id,name,provider (got ${sorted.join(',')})`);
  }
  for (const key of ['id', 'name']) {
    if (typeof model[key] !== 'string' || model[key].trim() === '') {
      throw new Error(`model ${index} field ${key} must be a non-empty string`);
    }
  }
  if (!MODEL_PROVIDERS.includes(model.provider)) {
    throw new Error(`model ${index} field provider must be one of ${MODEL_PROVIDERS.join(', ')} (got "${model.provider}")`);
  }
  if (seenIds.has(model.id)) {
    throw new Error(`model ${index} repeats the id "${model.id}": model ids are unique`);
  }
}

/** The declared surface contract: states keyed on REGION_STATES exactly. */
export function aiNodeSurfaceContract() {
  return Object.freeze({
    id: AI_NODE_SURFACE_ID,
    version: AI_NODE_SURFACE_VERSION,
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
      providers: MODEL_PROVIDERS,
      actions: AI_NODE_ACTIONS,
      selectResults: AI_NODE_SELECT_RESULTS,
      emptyReasons: AI_NODE_EMPTY_REASONS,
    }),
    bounds: Object.freeze({
      maxVisibleDefault: AI_NODE_MAX_VISIBLE_DEFAULT,
      maxVisibleHardMax: AI_NODE_MAX_VISIBLE_HARD_MAX,
    }),
  });
}

/**
 * The a11y intent is derived ONCE here, so the contract's declared observables
 * and the view-model's rendered attributes cannot drift. The ready state is
 * the form landmark; every other state is a status. Only error is aria-live
 * assertive; only loading is aria-busy.
 */
export const AI_NODE_A11Y = Object.freeze(
  Object.fromEntries(
    AI_NODE_STATES.map((state) => [
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
export function aiNodeActionsFor(region) {
  if (region === 'error') return Object.freeze(['refresh']);
  if (region === 'loading') return Object.freeze([]);
  if (region === 'empty') return Object.freeze(['refresh']);
  return Object.freeze(['refresh', 'request-select-model']);
}

function interactionsFor(region) {
  const actions = aiNodeActionsFor(region);
  return Object.freeze({
    refresh: actions.includes('refresh'),
    requestSelectModel: actions.includes('request-select-model'),
  });
}

/**
 * Create the AI Node view-model. The model catalog and the current parameter
 * value enter ONLY through loadSuccess() (one hand-over); the surface
 * performs no fetch, mutates no record, never writes the selection locally
 * and never calls the parameter capability - request-select-model is
 * DECLARED with explicit results, and the new value arrives as a fresh
 * hand-over.
 */
export function createAiNodeSurface(options = {}) {
  const locale = options.locale ?? 'en';
  const requestedMax = options.maxVisible ?? AI_NODE_MAX_VISIBLE_DEFAULT;
  if (!Number.isInteger(requestedMax) || requestedMax <= 0) {
    throw new Error('maxVisible must be a positive integer');
  }
  const maxVisible = Math.min(requestedMax, AI_NODE_MAX_VISIBLE_HARD_MAX);
  const renderAvailable = options.renderAvailable ?? true;

  let models = Object.freeze([]);
  let modelIds = new Set();
  let selectedModelId = null;
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
    const shown = models.slice(0, maxVisible);
    return Object.freeze({
      visible: true,
      visibleCount: models.length,
      shown: Object.freeze(shown.map((model) => Object.freeze({
        id: model.id,
        name: model.name,
        provider: model.provider,
        selected: model.id === selectedModelId,
      }))),
      selectedModelId: selectedModelId,
      truncated: models.length > shown.length,
      total: models.length,
      reason: region === 'empty' ? 'none' : null,
      focusOrder: Object.freeze(region === 'ready'
        ? models.map((model) => `model:${model.id}`)
        : []),
      labels: AI_NODE_LABELS,
      announcement: pendingAnnouncement,
      actions: aiNodeActionsFor(region),
      error: region === 'error' ? { kind: error?.kind ?? 'network' } : null,
    });
  }

  function a11y() {
    return AI_NODE_A11Y[regionState()];
  }

  return Object.freeze({
    id: AI_NODE_SURFACE_ID,
    contract: aiNodeSurfaceContract(),
    maxVisible,
    /**
     * The only data entry point (one hand-over: model catalog + the current
     * parameter value). Secret-bearing envelopes, duplicate ids, unknown
     * providers and malformed records are refused; selectedModelId must be
     * null or a handed-over model id.
     */
    loadSuccess(payload) {
      if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new Error('loadSuccess expects a hand-over payload object {models, selectedModelId}');
      }
      const keys = Object.keys(payload);
      assertNoSecretFields(keys, 'loadSuccess payload');
      const sorted = keys.sort();
      if (sorted.join(',') !== [...PAYLOAD_KEYS].sort().join(',')) {
        throw new Error(`loadSuccess payload must have exactly ${PAYLOAD_KEYS.join(',')} (got ${sorted.join(',')})`);
      }
      if (!Array.isArray(payload.models)) {
        throw new Error('loadSuccess payload field models (array) is required');
      }
      if (payload.selectedModelId !== null && typeof payload.selectedModelId !== 'string') {
        throw new Error('loadSuccess payload field selectedModelId must be null or a model id');
      }
      const seen = new Set();
      payload.models.forEach((model, index) => {
        assertModel(model, index, seen);
        seen.add(model.id);
      });
      if (payload.selectedModelId !== null && !seen.has(payload.selectedModelId)) {
        throw new Error('loadSuccess payload field selectedModelId must name a handed-over model');
      }
      models = Object.freeze(payload.models.map((model) => Object.freeze({ ...model })));
      modelIds = seen;
      selectedModelId = payload.selectedModelId;
      error = null;
      loaded = true;
      pendingAnnouncement = null;
      region = models.length > 0 ? 'ready' : 'empty';
      pushEvent('loaded');
      return models.length;
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
    /** Back to loading. Models are retained but the region is loading. */
    setLoading() {
      region = 'loading';
      pushEvent('loading');
      return 'loading';
    },
    /**
     * DECLARED, never executed here: ask the app layer (the capability that
     * owns the node parameter) to select a model. The selection never moves
     * locally - the new value arrives only via a fresh hand-over.
     */
    requestSelectModel(modelId) {
      if (typeof modelId !== 'string' || modelId.trim() === '') {
        throw new Error('requestSelectModel expects a non-empty model id');
      }
      if (region !== 'ready') return 'not-ready';
      if (!modelIds.has(modelId)) return 'unknown-model';
      pushEvent('select-requested');
      pendingAnnouncement = modelId;
      return 'accepted';
    },
    displayModel,
    a11y,
    /** Observable snapshot for the parity harness (candidate side). */
    observe() {
      const state = regionState();
      const model = displayModel();
      const events = state === 'ready' ? ['ai-node:rendered'] : [];
      if (state === 'ready' && model.announcement !== null) {
        events.push('ai-node:changed');
      }
      return observation({
        surfaceId: AI_NODE_SURFACE_ID,
        side: 'candidate',
        visible: model.visible === true,
        regionState: state,
        loading: state === 'loading',
        empty: state === 'empty',
        error: state === 'error' ? { kind: error?.kind ?? 'network' } : null,
        interactions: interactionsFor(state),
        events: Object.freeze(events),
        accessibility: a11y(),
        localization: Object.freeze({ slot: AI_NODE_MESSAGE_SLOT, locale }),
        contract: Object.freeze({ id: AI_NODE_SURFACE_ID, version: AI_NODE_SURFACE_VERSION }),
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
    get selectedModelId() {
      return selectedModelId;
    },
    get models() {
      return models;
    },
  });
}

/* -------------------------------------------------------- the reference model */

/**
 * The reference (pinned n8n editor) observations as deterministic fixtures.
 * The reference UI is not run here - these are the declared behaviours the
 * candidate is compared against. They mirror observe() field for field, and
 * their interactions come from the SAME aiNodeActionsFor rule the
 * view-model uses, so the two sides cannot drift by construction.
 */
function referenceObservation({ regionState: state, error = null, events = [], locale }) {
  return observation({
    surfaceId: AI_NODE_SURFACE_ID,
    side: 'reference',
    visible: true,
    regionState: state,
    loading: state === 'loading',
    empty: state === 'empty',
    error,
    interactions: interactionsFor(state),
    events: Object.freeze(events),
    accessibility: AI_NODE_A11Y[state],
    localization: Object.freeze({ slot: AI_NODE_MESSAGE_SLOT, locale }),
    contract: Object.freeze({ id: AI_NODE_SURFACE_ID, version: AI_NODE_SURFACE_VERSION }),
  });
}

export function referenceLoadingObservation(locale = 'en') {
  return referenceObservation({ regionState: 'loading', locale });
}

export function referenceEmptyObservation({ reason = 'none', locale = 'en' } = {}) {
  if (!AI_NODE_EMPTY_REASONS.includes(reason)) {
    throw new Error(`reason must be one of ${AI_NODE_EMPTY_REASONS.join(', ')} (got "${reason}")`);
  }
  return referenceObservation({ regionState: 'empty', locale });
}

export function referenceReadyObservation(locale = 'en') {
  return referenceObservation({ regionState: 'ready', events: ['ai-node:rendered'], locale });
}

export function referenceErrorObservation({ errorKind = 'network', locale = 'en' } = {}) {
  return referenceObservation({ regionState: 'error', error: { kind: errorKind }, locale });
}
