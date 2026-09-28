/**
 * Execution management surface pilot (P2-S20, issue #240) - the strangler
 * slice for the retry / stop / bulk actions around executions, split out of
 * P2-S03 (Layer 4, beyond the P2-S06 history list). One surface, one
 * delivery scope: render the handed-over execution records and ask the app
 * layer to retry or stop them through DECLARED interactions that go through
 * the execution capability.
 *
 * Boundary (invariants 4-5): the execution records are HANDED OVER
 * (inputBoundary source hand-over) through declared capabilities only. The
 * surface holds no private data path and no second source truth: it never
 * fetches executions, never mutates a record (status changes arrive only via
 * a fresh hand-over), never calls the engine or the execution capability
 * itself - request-retry / request-stop / request-bulk-* are DECLARED
 * interactions with explicit results. The selection is VIEW state only: it
 * never leaves the surface and is cleared by every fresh hand-over.
 *
 * Security boundary (the load-bearing rule): a payload envelope carrying
 * secret or session material is refused with an explicit security error,
 * never dropped. Records are opaque closed shapes - this surface evaluates
 * nothing (no eval, no new Function), fetches nothing and never persists.
 *
 * Closed contracts (invariants 4 and 7): the four region states are exactly
 * the shared REGION_STATES; execution status is the declared subset
 * success | error | running | waiting (the full n8n status zoo stays with
 * the reference - recorded as evidence); a workflow with no executions is
 * empty with reason none, never a fifth state.
 *
 * Pilot (invariants 1 and 9): the original n8n editor stays the default
 * path; rollback is switching the pilot off with no residual state and no
 * workflow-data migration (rollbackStrategy: pilot-not-primary in the
 * surface-migrations manifest).
 */
import { observation } from './parity.mjs';
import { REGION_STATES } from './surface-contract.mjs';

export const EXEC_MGMT_STATES = REGION_STATES;

export const EXEC_MGMT_SURFACE_ID = 'execution-mgmt';
export const EXEC_MGMT_SURFACE_VERSION = 'p1';
export const EXEC_MGMT_MESSAGE_SLOT = 'execution-mgmt';

/** Closed execution-status vocabulary: the declared subset this slice renders. */
export const EXECUTION_STATUSES = Object.freeze(['success', 'error', 'running', 'waiting']);

/** Statuses a stop request may target; only a failed run may be retried. */
export const EXECUTION_STOPPABLE = Object.freeze(['running', 'waiting']);
export const EXECUTION_RETRYABLE = Object.freeze(['error']);

/** Closed empty reason: no executions handed over is none, never a fifth state. */
export const EXEC_MGMT_EMPTY_REASONS = Object.freeze(['none']);

/** Closed action vocabulary: what the user may ask for in a state (declared). */
export const EXEC_MGMT_ACTIONS = Object.freeze([
  'refresh', 'select', 'request-retry', 'request-stop', 'request-bulk-retry', 'request-bulk-stop',
]);

/**
 * Closed request-result vocabularies: every declared outcome is explicit.
 * All of them answer for the DECLARED request - the execution capability
 * (app layer) performs the action, never this surface, and no result claims
 * a record changed.
 */
export const EXEC_MGMT_SELECT_RESULTS = Object.freeze(['accepted', 'unknown-execution', 'not-ready']);
export const EXEC_MGMT_RETRY_RESULTS = Object.freeze(['accepted', 'unknown-execution', 'invalid-state', 'not-ready']);
export const EXEC_MGMT_STOP_RESULTS = Object.freeze(['accepted', 'unknown-execution', 'invalid-state', 'not-ready']);
export const EXEC_MGMT_BULK_RETRY_RESULTS = Object.freeze(['accepted', 'no-selection', 'no-retryable', 'not-ready']);
export const EXEC_MGMT_BULK_STOP_RESULTS = Object.freeze(['accepted', 'no-selection', 'no-stoppable', 'not-ready']);

/** Default visible execution cap and the hard maximum a caller can request. */
export const EXEC_MGMT_MAX_VISIBLE_DEFAULT = 30;
export const EXEC_MGMT_MAX_VISIBLE_HARD_MAX = 100;

/** The a11y labels for the interactive controls, declared once. */
export const EXEC_MGMT_LABELS = Object.freeze({
  select: 'Toggle execution selection',
  retry: 'Retry execution',
  stop: 'Stop execution',
  bulkRetry: 'Retry selected executions',
  bulkStop: 'Stop selected executions',
  refresh: 'Refresh executions',
});

/** Closed execution record shape: one handed-over execution. */
const EXECUTION_KEYS = Object.freeze(['id', 'workflowName', 'status']);

/** Closed hand-over payload: one load, executions. */
const PAYLOAD_KEYS = Object.freeze(['executions']);

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

function assertExecution(execution, index, seenIds) {
  if (execution === null || typeof execution !== 'object' || Array.isArray(execution)) {
    throw new Error(`execution ${index} must be an object`);
  }
  const keys = Object.keys(execution);
  assertNoSecretFields(keys, `execution ${index}`);
  const sorted = keys.sort();
  if (sorted.join(',') !== [...EXECUTION_KEYS].sort().join(',')) {
    throw new Error(`execution ${index} must have exactly id,workflowName,status (got ${sorted.join(',')})`);
  }
  for (const key of ['id', 'workflowName']) {
    if (typeof execution[key] !== 'string' || execution[key].trim() === '') {
      throw new Error(`execution ${index} field ${key} must be a non-empty string`);
    }
  }
  if (!EXECUTION_STATUSES.includes(execution.status)) {
    throw new Error(`execution ${index} field status must be one of ${EXECUTION_STATUSES.join(', ')} (got "${execution.status}")`);
  }
  if (seenIds.has(execution.id)) {
    throw new Error(`execution ${index} repeats the id "${execution.id}": execution ids are unique`);
  }
}

/** The declared surface contract: states keyed on REGION_STATES exactly. */
export function executionMgmtSurfaceContract() {
  return Object.freeze({
    id: EXEC_MGMT_SURFACE_ID,
    version: EXEC_MGMT_SURFACE_VERSION,
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
      executionStatuses: EXECUTION_STATUSES,
      stoppable: EXECUTION_STOPPABLE,
      retryable: EXECUTION_RETRYABLE,
      actions: EXEC_MGMT_ACTIONS,
      selectResults: EXEC_MGMT_SELECT_RESULTS,
      retryResults: EXEC_MGMT_RETRY_RESULTS,
      stopResults: EXEC_MGMT_STOP_RESULTS,
      bulkRetryResults: EXEC_MGMT_BULK_RETRY_RESULTS,
      bulkStopResults: EXEC_MGMT_BULK_STOP_RESULTS,
      emptyReasons: EXEC_MGMT_EMPTY_REASONS,
    }),
    bounds: Object.freeze({
      maxVisibleDefault: EXEC_MGMT_MAX_VISIBLE_DEFAULT,
      maxVisibleHardMax: EXEC_MGMT_MAX_VISIBLE_HARD_MAX,
    }),
  });
}

/**
 * The a11y intent is derived ONCE here, so the contract's declared observables
 * and the view-model's rendered attributes cannot drift. The ready state is
 * the form landmark; every other state is a status. Only error is aria-live
 * assertive; only loading is aria-busy.
 */
export const EXEC_MGMT_A11Y = Object.freeze(
  Object.fromEntries(
    EXEC_MGMT_STATES.map((state) => [
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
export function execMgmtActionsFor(region) {
  if (region === 'error') return Object.freeze(['refresh']);
  if (region === 'loading') return Object.freeze([]);
  if (region === 'empty') return Object.freeze(['refresh']);
  return Object.freeze([
    'refresh', 'select', 'request-retry', 'request-stop', 'request-bulk-retry', 'request-bulk-stop',
  ]);
}

function interactionsFor(region) {
  const actions = execMgmtActionsFor(region);
  return Object.freeze({
    refresh: actions.includes('refresh'),
    select: actions.includes('select'),
    requestRetry: actions.includes('request-retry'),
    requestStop: actions.includes('request-stop'),
    requestBulkRetry: actions.includes('request-bulk-retry'),
    requestBulkStop: actions.includes('request-bulk-stop'),
  });
}

/**
 * Create the execution-management view-model. Execution records enter ONLY
 * through loadSuccess() (one hand-over); the surface performs no fetch,
 * mutates no record and never calls the execution capability itself -
 * select is VIEW state (cleared by every fresh hand-over), the request-*
 * interactions are DECLARED with explicit results.
 */
export function createExecutionMgmtSurface(options = {}) {
  const locale = options.locale ?? 'en';
  const requestedMax = options.maxVisible ?? EXEC_MGMT_MAX_VISIBLE_DEFAULT;
  if (!Number.isInteger(requestedMax) || requestedMax <= 0) {
    throw new Error('maxVisible must be a positive integer');
  }
  const maxVisible = Math.min(requestedMax, EXEC_MGMT_MAX_VISIBLE_HARD_MAX);
  const renderAvailable = options.renderAvailable ?? true;

  let executions = Object.freeze([]);
  let executionIds = new Set();
  let selection = Object.freeze([]);
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

  function findExecution(id) {
    return executions.find((execution) => execution.id === id);
  }

  function displayModel() {
    const shown = executions.slice(0, maxVisible);
    return Object.freeze({
      visible: true,
      visibleCount: executions.length,
      shown: Object.freeze(shown.map((execution) => Object.freeze({
        id: execution.id,
        workflowName: execution.workflowName,
        status: execution.status,
        selected: selection.includes(execution.id),
      }))),
      truncated: executions.length > shown.length,
      total: executions.length,
      reason: region === 'empty' ? 'none' : null,
      selection: selection,
      focusOrder: Object.freeze(region === 'ready'
        ? [
          ...executions.map((execution) => `exec:${execution.id}`),
          ...(selection.length > 0 ? ['bulk-retry', 'bulk-stop'] : []),
        ]
        : []),
      labels: EXEC_MGMT_LABELS,
      announcement: pendingAnnouncement,
      actions: execMgmtActionsFor(region),
      error: region === 'error' ? { kind: error?.kind ?? 'network' } : null,
    });
  }

  function a11y() {
    return EXEC_MGMT_A11Y[regionState()];
  }

  return Object.freeze({
    id: EXEC_MGMT_SURFACE_ID,
    contract: executionMgmtSurfaceContract(),
    maxVisible,
    /**
     * The only data entry point (one hand-over: executions). Secret-bearing
     * envelopes, duplicate ids, unknown statuses and non-array payloads are
     * refused; the selection resets to empty on every fresh hand-over.
     */
    loadSuccess(payload) {
      if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new Error('loadSuccess expects a hand-over payload object {executions}');
      }
      const keys = Object.keys(payload);
      assertNoSecretFields(keys, 'loadSuccess payload');
      const sorted = keys.sort();
      if (sorted.join(',') !== [...PAYLOAD_KEYS].sort().join(',')) {
        throw new Error(`loadSuccess payload must have exactly ${PAYLOAD_KEYS.join(',')} (got ${sorted.join(',')})`);
      }
      if (!Array.isArray(payload.executions)) {
        throw new Error('loadSuccess payload field executions (array) is required');
      }
      const ids = new Set();
      payload.executions.forEach((execution, index) => {
        assertExecution(execution, index, ids);
        ids.add(execution.id);
      });
      executions = Object.freeze(payload.executions.map((execution) => Object.freeze({ ...execution })));
      executionIds = ids;
      selection = Object.freeze([]);
      error = null;
      loaded = true;
      pendingAnnouncement = null;
      region = executions.length > 0 ? 'ready' : 'empty';
      pushEvent('loaded');
      return executions.length;
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
     * VIEW state only: toggle one execution in the selection. The records
     * never change and the selection never leaves the surface.
     */
    select(executionId) {
      if (typeof executionId !== 'string' || executionId.trim() === '') {
        throw new Error('select expects a non-empty execution id');
      }
      if (region !== 'ready') return 'not-ready';
      if (!executionIds.has(executionId)) return 'unknown-execution';
      selection = selection.includes(executionId)
        ? Object.freeze(selection.filter((id) => id !== executionId))
        : Object.freeze([...selection, executionId]);
      pushEvent('selection-toggled');
      pendingAnnouncement = executionId;
      return 'accepted';
    },
    /**
     * DECLARED, never executed here: ask the app layer (execution capability)
     * to retry one failed execution. Records never change locally.
     */
    requestRetry(executionId) {
      if (typeof executionId !== 'string' || executionId.trim() === '') {
        throw new Error('requestRetry expects a non-empty execution id');
      }
      if (region !== 'ready') return 'not-ready';
      const execution = findExecution(executionId);
      if (execution === undefined) return 'unknown-execution';
      if (!EXECUTION_RETRYABLE.includes(execution.status)) return 'invalid-state';
      pushEvent('retry-requested');
      pendingAnnouncement = executionId;
      return 'accepted';
    },
    /**
     * DECLARED, never executed here: ask the app layer (execution capability)
     * to stop one running or waiting execution. Records never change locally.
     */
    requestStop(executionId) {
      if (typeof executionId !== 'string' || executionId.trim() === '') {
        throw new Error('requestStop expects a non-empty execution id');
      }
      if (region !== 'ready') return 'not-ready';
      const execution = findExecution(executionId);
      if (execution === undefined) return 'unknown-execution';
      if (!EXECUTION_STOPPABLE.includes(execution.status)) return 'invalid-state';
      pushEvent('stop-requested');
      pendingAnnouncement = executionId;
      return 'accepted';
    },
    /**
     * DECLARED, never executed here: bulk retry over the selection. The
     * results name exactly what was wrong (empty selection, nothing
     * retryable); no record changes here.
     */
    requestBulkRetry() {
      if (region !== 'ready') return 'not-ready';
      if (selection.length === 0) return 'no-selection';
      const retryable = selection.some((id) => {
        const execution = findExecution(id);
        return execution !== undefined && EXECUTION_RETRYABLE.includes(execution.status);
      });
      if (!retryable) return 'no-retryable';
      pushEvent('bulk-retry-requested');
      return 'accepted';
    },
    /** DECLARED, never executed here: bulk stop over the selection. */
    requestBulkStop() {
      if (region !== 'ready') return 'not-ready';
      if (selection.length === 0) return 'no-selection';
      const stoppable = selection.some((id) => {
        const execution = findExecution(id);
        return execution !== undefined && EXECUTION_STOPPABLE.includes(execution.status);
      });
      if (!stoppable) return 'no-stoppable';
      pushEvent('bulk-stop-requested');
      return 'accepted';
    },
    displayModel,
    a11y,
    /** Observable snapshot for the parity harness (candidate side). */
    observe() {
      const state = regionState();
      const model = displayModel();
      const events = state === 'ready' ? ['execution-mgmt:rendered'] : [];
      if (state === 'ready' && model.announcement !== null) {
        events.push('execution-mgmt:changed');
      }
      return observation({
        surfaceId: EXEC_MGMT_SURFACE_ID,
        side: 'candidate',
        visible: model.visible === true,
        regionState: state,
        loading: state === 'loading',
        empty: state === 'empty',
        error: state === 'error' ? { kind: error?.kind ?? 'network' } : null,
        interactions: interactionsFor(state),
        events: Object.freeze(events),
        accessibility: a11y(),
        localization: Object.freeze({ slot: EXEC_MGMT_MESSAGE_SLOT, locale }),
        contract: Object.freeze({ id: EXEC_MGMT_SURFACE_ID, version: EXEC_MGMT_SURFACE_VERSION }),
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
    get selection() {
      return selection;
    },
  });
}

/* -------------------------------------------------------- the reference model */

/**
 * The reference (pinned n8n editor) observations as deterministic fixtures.
 * The reference UI is not run here - these are the declared behaviours the
 * candidate is compared against. They mirror observe() field for field, and
 * their interactions come from the SAME execMgmtActionsFor rule the
 * view-model uses, so the two sides cannot drift by construction.
 */
function referenceObservation({ regionState: state, error = null, events = [], locale }) {
  return observation({
    surfaceId: EXEC_MGMT_SURFACE_ID,
    side: 'reference',
    visible: true,
    regionState: state,
    loading: state === 'loading',
    empty: state === 'empty',
    error,
    interactions: interactionsFor(state),
    events: Object.freeze(events),
    accessibility: EXEC_MGMT_A11Y[state],
    localization: Object.freeze({ slot: EXEC_MGMT_MESSAGE_SLOT, locale }),
    contract: Object.freeze({ id: EXEC_MGMT_SURFACE_ID, version: EXEC_MGMT_SURFACE_VERSION }),
  });
}

export function referenceLoadingObservation(locale = 'en') {
  return referenceObservation({ regionState: 'loading', locale });
}

export function referenceEmptyObservation({ reason = 'none', locale = 'en' } = {}) {
  if (!EXEC_MGMT_EMPTY_REASONS.includes(reason)) {
    throw new Error(`reason must be one of ${EXEC_MGMT_EMPTY_REASONS.join(', ')} (got "${reason}")`);
  }
  return referenceObservation({ regionState: 'empty', locale });
}

export function referenceReadyObservation(locale = 'en') {
  return referenceObservation({ regionState: 'ready', events: ['execution-mgmt:rendered'], locale });
}

export function referenceErrorObservation({ errorKind = 'network', locale = 'en' } = {}) {
  return referenceObservation({ regionState: 'error', error: { kind: errorKind }, locale });
}
