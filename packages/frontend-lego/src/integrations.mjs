/**
 * Integrations surface pilot (P2-S19, issue #240) - the strangler slice for
 * the external integration management panel (community / private / custom
 * sources view), split out of P2-S03 (Layer 4). One surface, one delivery
 * scope: browse the handed-over integration records and ask the app layer to
 * activate one or to install one through DECLARED interactions.
 *
 * Boundary (invariants 4-5): the integration list and the active integration
 * are HANDED OVER (inputBoundary source hand-over) through declared
 * capabilities only. The surface holds no private data path and no second
 * source of truth: it never fetches integrations, never derives the active
 * integration locally (the hand-over owns it - request-activate is DECLARED,
 * the active id changes only via a fresh hand-over) and NEVER installs -
 * request-install is DECLARED and always lands behind the P6 admission path
 * (results are closed and never include a local "installed" flip).
 *
 * Security boundary (the load-bearing rule): a payload envelope carrying
 * secret or session material is refused with an explicit security error,
 * never dropped. The `installed` flags are handed over data: this surface
 * never mutates them, never downloads packages and never executes anything
 * (no eval, no new Function, no dynamic import).
 *
 * Closed contracts (invariants 4 and 7): the four region states are exactly
 * the shared REGION_STATES; integration sources are the declared subset
 * community | private | custom (the full source zoo stays with the
 * reference - recorded as evidence); a workflow with no integrations is
 * empty with reason none, never a fifth state.
 *
 * Pilot (invariants 1 and 9): the original n8n editor stays the default
 * path; rollback is switching the pilot off with no residual state and no
 * workflow-data migration (rollbackStrategy: pilot-not-primary in the
 * surface-migrations manifest).
 */
import { observation } from './parity.mjs';
import { REGION_STATES } from './surface-contract.mjs';

export const INTEGRATION_STATES = REGION_STATES;

export const INTEGRATION_SURFACE_ID = 'integrations';
export const INTEGRATION_SURFACE_VERSION = 'p1';
export const INTEGRATION_MESSAGE_SLOT = 'integrations';

/** Closed source vocabulary: the declared subset this slice renders. */
export const INTEGRATION_SOURCES = Object.freeze(['community', 'private', 'custom']);

/** Closed empty reason: no integrations handed over is none, never a fifth state. */
export const INTEGRATION_EMPTY_REASONS = Object.freeze(['none']);

/** Closed action vocabulary: what the user may ask for in a state (declared). */
export const INTEGRATION_ACTIONS = Object.freeze([
  'refresh', 'request-activate', 'request-install',
]);

/**
 * Closed request-result vocabularies: every declared outcome is explicit.
 * activate: accepted means the REQUEST was accepted for the app layer.
 * install: there is NO accepted result - every install goes through the P6
 * admission path (admission-required), so the surface can never claim an
 * installation happened.
 */
export const INTEGRATION_ACTIVATE_RESULTS = Object.freeze([
  'accepted', 'unknown-integration', 'not-ready',
]);
export const INTEGRATION_INSTALL_RESULTS = Object.freeze([
  'admission-required', 'unknown-integration', 'already-installed', 'not-ready',
]);

/** Default visible integration cap and the hard maximum a caller can request. */
export const INTEGRATION_MAX_VISIBLE_DEFAULT = 30;
export const INTEGRATION_MAX_VISIBLE_HARD_MAX = 100;

/** The a11y labels for the interactive controls, declared once. */
export const INTEGRATION_LABELS = Object.freeze({
  activate: 'Select integration',
  install: 'Request installation',
  refresh: 'Refresh integrations',
});

/** Closed integration record shape: one handed-over integration. */
const INTEGRATION_KEYS = Object.freeze(['id', 'name', 'source', 'installed']);

/** Closed hand-over payload: one load, integrations + active. */
const PAYLOAD_KEYS = Object.freeze(['integrations', 'active']);

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

function assertIntegration(integration, index, seenIds) {
  if (integration === null || typeof integration !== 'object' || Array.isArray(integration)) {
    throw new Error(`integration ${index} must be an object`);
  }
  const keys = Object.keys(integration);
  assertNoSecretFields(keys, `integration ${index}`);
  const sorted = keys.sort();
  if (sorted.join(',') !== [...INTEGRATION_KEYS].sort().join(',')) {
    throw new Error(`integration ${index} must have exactly id,name,source,installed (got ${sorted.join(',')})`);
  }
  for (const key of ['id', 'name']) {
    if (typeof integration[key] !== 'string' || integration[key].trim() === '') {
      throw new Error(`integration ${index} field ${key} must be a non-empty string`);
    }
  }
  if (!INTEGRATION_SOURCES.includes(integration.source)) {
    throw new Error(`integration ${index} field source must be one of ${INTEGRATION_SOURCES.join(', ')} (got "${integration.source}")`);
  }
  if (typeof integration.installed !== 'boolean') {
    throw new Error(`integration ${index} field installed must be a boolean`);
  }
  if (seenIds.has(integration.id)) {
    throw new Error(`integration ${index} repeats the id "${integration.id}": integration ids are unique`);
  }
}

/** The declared surface contract: states keyed on REGION_STATES exactly. */
export function integrationsSurfaceContract() {
  return Object.freeze({
    id: INTEGRATION_SURFACE_ID,
    version: INTEGRATION_SURFACE_VERSION,
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
      sources: INTEGRATION_SOURCES,
      actions: INTEGRATION_ACTIONS,
      activateResults: INTEGRATION_ACTIVATE_RESULTS,
      installResults: INTEGRATION_INSTALL_RESULTS,
      emptyReasons: INTEGRATION_EMPTY_REASONS,
    }),
    bounds: Object.freeze({
      maxVisibleDefault: INTEGRATION_MAX_VISIBLE_DEFAULT,
      maxVisibleHardMax: INTEGRATION_MAX_VISIBLE_HARD_MAX,
    }),
  });
}

/**
 * The a11y intent is derived ONCE here, so the contract's declared observables
 * and the view-model's rendered attributes cannot drift. The ready state is
 * the form landmark; every other state is a status. Only error is aria-live
 * assertive; only loading is aria-busy.
 */
export const INTEGRATION_A11Y = Object.freeze(
  Object.fromEntries(
    INTEGRATION_STATES.map((state) => [
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
export function integrationsActionsFor(region) {
  if (region === 'error') return Object.freeze(['refresh']);
  if (region === 'loading') return Object.freeze([]);
  if (region === 'empty') return Object.freeze(['refresh']);
  return Object.freeze(['refresh', 'request-activate', 'request-install']);
}

function interactionsFor(region) {
  const actions = integrationsActionsFor(region);
  return Object.freeze({
    refresh: actions.includes('refresh'),
    requestActivate: actions.includes('request-activate'),
    requestInstall: actions.includes('request-install'),
  });
}

/**
 * Create the integrations view-model. Integrations and the active id enter
 * ONLY through loadSuccess() (one hand-over); the surface performs no fetch,
 * derives no active integration locally and never installs -
 * request-activate/request-install are DECLARED interactions with explicit
 * results. The visible list is the handed-over records in hand-over order.
 */
export function createIntegrationsSurface(options = {}) {
  const locale = options.locale ?? 'en';
  const requestedMax = options.maxVisible ?? INTEGRATION_MAX_VISIBLE_DEFAULT;
  if (!Number.isInteger(requestedMax) || requestedMax <= 0) {
    throw new Error('maxVisible must be a positive integer');
  }
  const maxVisible = Math.min(requestedMax, INTEGRATION_MAX_VISIBLE_HARD_MAX);
  const renderAvailable = options.renderAvailable ?? true;

  let integrations = Object.freeze([]);
  let activeId = null;
  let integrationIds = new Set();
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
    const shown = integrations.slice(0, maxVisible);
    const active = activeId === null
      ? null
      : integrations.find((integration) => integration.id === activeId) ?? null;
    return Object.freeze({
      visible: true,
      visibleCount: integrations.length,
      shown: Object.freeze(shown.map((integration) => Object.freeze({
        id: integration.id,
        name: integration.name,
        source: integration.source,
        installed: integration.installed,
        active: integration.id === activeId,
      }))),
      truncated: integrations.length > shown.length,
      total: integrations.length,
      reason: region === 'empty' ? 'none' : null,
      sources: INTEGRATION_SOURCES,
      active: activeId,
      focusOrder: Object.freeze(region === 'ready'
        ? [
          ...integrations.map((integration) => `integration:${integration.id}`),
          ...(active !== null && !active.installed ? ['install'] : []),
        ]
        : []),
      labels: INTEGRATION_LABELS,
      announcement: pendingAnnouncement,
      actions: integrationsActionsFor(region),
      error: region === 'error' ? { kind: error?.kind ?? 'network' } : null,
    });
  }

  function a11y() {
    return INTEGRATION_A11Y[regionState()];
  }

  return Object.freeze({
    id: INTEGRATION_SURFACE_ID,
    contract: integrationsSurfaceContract(),
    maxVisible,
    /**
     * The only data entry point (one hand-over: integrations + active).
     * Secret-bearing envelopes, duplicate ids, unknown sources, non-boolean
     * installed flags and an inconsistent active id are refused.
     */
    loadSuccess(payload) {
      if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new Error('loadSuccess expects a hand-over payload object {integrations, active}');
      }
      const keys = Object.keys(payload);
      assertNoSecretFields(keys, 'loadSuccess payload');
      const sorted = keys.sort();
      if (sorted.join(',') !== [...PAYLOAD_KEYS].sort().join(',')) {
        throw new Error(`loadSuccess payload must have exactly ${PAYLOAD_KEYS.join(',')} (got ${sorted.join(',')})`);
      }
      if (!Array.isArray(payload.integrations)) {
        throw new Error('loadSuccess payload field integrations (array) is required');
      }
      const ids = new Set();
      payload.integrations.forEach((integration, index) => {
        assertIntegration(integration, index, ids);
        ids.add(integration.id);
      });
      if (payload.active !== null) {
        if (typeof payload.active !== 'string' || payload.active.trim() === '') {
          throw new Error('loadSuccess active must be null or a non-empty integration id');
        }
        if (ids.size === 0) {
          throw new Error('loadSuccess active must be null when no integrations are handed over');
        }
        if (!ids.has(payload.active)) {
          throw new Error(`loadSuccess active resolves the unknown integration "${payload.active}": the hand-over must be consistent`);
        }
      } else if (ids.size > 0) {
        throw new Error('loadSuccess active must name one of the handed-over integrations when the list is non-empty');
      }
      integrations = Object.freeze(payload.integrations.map((integration) => Object.freeze({ ...integration })));
      activeId = payload.active;
      integrationIds = ids;
      error = null;
      loaded = true;
      pendingAnnouncement = null;
      region = integrations.length > 0 ? 'ready' : 'empty';
      pushEvent('loaded');
      return integrations.length;
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
     * DECLARED, never executed: ask the app layer to activate an
     * integration. The handed-over active id NEVER changes here - only a
     * fresh hand-over moves it (no second source of truth).
     */
    requestActivate(integrationId) {
      if (typeof integrationId !== 'string' || integrationId.trim() === '') {
        throw new Error('requestActivate expects a non-empty integration id');
      }
      if (region !== 'ready') return 'not-ready';
      if (!integrationIds.has(integrationId)) return 'unknown-integration';
      pushEvent('activate-requested');
      pendingAnnouncement = integrationId;
      return 'accepted';
    },
    /**
     * DECLARED, never executed: ask the P6 admission path to install the
     * ACTIVE integration. The surface NEVER installs: there is no accepted
     * result, the handed-over `installed` flags never change here, and an
     * unknown or already-installed target is an explicit closed result.
     */
    requestInstall() {
      if (region !== 'ready') return 'not-ready';
      if (activeId === null) return 'unknown-integration';
      const active = integrations.find((integration) => integration.id === activeId);
      if (active === undefined) return 'unknown-integration';
      if (active.installed) return 'already-installed';
      pushEvent('install-requested');
      pendingAnnouncement = active.name;
      return 'admission-required';
    },
    displayModel,
    a11y,
    /** Observable snapshot for the parity harness (candidate side). */
    observe() {
      const state = regionState();
      const model = displayModel();
      const events = state === 'ready' ? ['integrations:rendered'] : [];
      if (state === 'ready' && model.announcement !== null) {
        events.push('integrations:changed');
      }
      return observation({
        surfaceId: INTEGRATION_SURFACE_ID,
        side: 'candidate',
        visible: model.visible === true,
        regionState: state,
        loading: state === 'loading',
        empty: state === 'empty',
        error: state === 'error' ? { kind: error?.kind ?? 'network' } : null,
        interactions: interactionsFor(state),
        events: Object.freeze(events),
        accessibility: a11y(),
        localization: Object.freeze({ slot: INTEGRATION_MESSAGE_SLOT, locale }),
        contract: Object.freeze({ id: INTEGRATION_SURFACE_ID, version: INTEGRATION_SURFACE_VERSION }),
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
    get activeId() {
      return activeId;
    },
  });
}

/* -------------------------------------------------------- the reference model */

/**
 * The reference (pinned n8n editor) observations as deterministic fixtures.
 * The reference UI is not run here - these are the declared behaviours the
 * candidate is compared against. They mirror observe() field for field, and
 * their interactions come from the SAME integrationsActionsFor rule the
 * view-model uses, so the two sides cannot drift by construction.
 */
function referenceObservation({ regionState: state, error = null, events = [], locale }) {
  return observation({
    surfaceId: INTEGRATION_SURFACE_ID,
    side: 'reference',
    visible: true,
    regionState: state,
    loading: state === 'loading',
    empty: state === 'empty',
    error,
    interactions: interactionsFor(state),
    events: Object.freeze(events),
    accessibility: INTEGRATION_A11Y[state],
    localization: Object.freeze({ slot: INTEGRATION_MESSAGE_SLOT, locale }),
    contract: Object.freeze({ id: INTEGRATION_SURFACE_ID, version: INTEGRATION_SURFACE_VERSION }),
  });
}

export function referenceLoadingObservation(locale = 'en') {
  return referenceObservation({ regionState: 'loading', locale });
}

export function referenceEmptyObservation({ reason = 'none', locale = 'en' } = {}) {
  if (!INTEGRATION_EMPTY_REASONS.includes(reason)) {
    throw new Error(`reason must be one of ${INTEGRATION_EMPTY_REASONS.join(', ')} (got "${reason}")`);
  }
  return referenceObservation({ regionState: 'empty', locale });
}

export function referenceReadyObservation(locale = 'en') {
  return referenceObservation({ regionState: 'ready', events: ['integrations:rendered'], locale });
}

export function referenceErrorObservation({ errorKind = 'network', locale = 'en' } = {}) {
  return referenceObservation({ regionState: 'error', error: { kind: errorKind }, locale });
}
