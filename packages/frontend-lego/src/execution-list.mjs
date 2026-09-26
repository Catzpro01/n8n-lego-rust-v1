/**
 * Executions list pilot (P2-S03 Layer 3, surface `executions`).
 *
 * The third strangler slice of P2-S03's Layers 3-5, delivered in the #241/#245
 * shape as its two predecessors (P2-S04 dashboard workflow-list, P2-S05 dialogs):
 * **one additional low-risk surface, `mode: pilot`, `rollback: pilot-not-primary`,
 * the original editor stays the default path.**
 *
 * WHAT THIS SURFACE IS. A framework-neutral view-model for the Executions page
 * list - the one place the list of executions is *described*, so a later
 * migration can render it without forking a second vocabulary. It is a
 * view-model plus an observation, never a framework component. It declares,
 * requests and renders metadata; it never authorizes and never executes.
 * Opening an execution or retrying a failed one are *declared* interactions -
 * the surface names them, the reference (or a future primary) performs them.
 *
 * WHY a view-model and not a fetcher. The executions surface's backend is the
 * `execution` capability (`contracts/execution.contract.md`, `/rest/executions`).
 * The pilot does not fetch: rows are **handed over** (`inputBoundary.source:
 * "hand-over"`), exactly as the #241 pilot and P2-S04/P2-S05 hand over theirs.
 * Fetching would give the UI a private data path and a second source of truth
 * for the execution catalog, which the compatibility boundary exists to prevent.
 * `loadSuccess()` is the only row entry point.
 *
 * THE FOUR REGION STATES, REUSED NOT FORKED. The contract keys its `states` on
 * the closed `REGION_STATES` vocabulary (loading / empty / error / ready), the
 * same vocabulary the parity harness compares against the pinned reference.
 * "The user's status filter matched nothing" and "there are no executions yet"
 * are BOTH `empty` at the region level - the difference is carried in the
 * display model's `reason` (`none` vs `filtered`), not invented as a fifth
 * region state. The test pins `Object.keys(contract.states)` to `REGION_STATES`
 * exactly so a fifth state cannot be added quietly.
 *
 * BOUNDED. The list has a ceiling on visible rows. An executions list with no
 * bound is an unbounded memory/CPU leak on a page, so rows past the bound are
 * retained (the data is not dropped) but not presented; "show more" is a
 * declared interaction, not a silent overflow.
 *
 * THE STATUS FILTER IS A REAL MUTATION. Unlike the purely declarative
 * interactions, the status filter changes what is VISIBLE, and it is the one
 * behaviour a test can observe end to end: select a status, narrow, clear. The
 * filter vocabulary is closed (`all` plus the engine's execution statuses); an
 * unknown status is refused, not silently coerced. Filtering to zero is `empty`
 * with `reason: 'filtered'`, which is how the reference tells a first-time
 * "no executions yet" from "your status filter matched nothing".
 */
import {
  REGION_STATES,
  SURFACE_MODES,
  defineSurfaceContract,
  validateSurfaceContract,
} from './surface-contract.mjs';
import { observation } from './parity.mjs';
import { FrontendError, toDisplayModel, normalizeError } from './errors.mjs';
import { buildMessageKey } from './i18n.mjs';

/** Surface identity (must stay in sync with manifest/capabilities.json + surface-migrations.json). */
export const EXECUTION_LIST_SURFACE_ID = 'ui.executions.history';
export const EXECUTION_LIST_SURFACE_VERSION = '1.0.0';
export const EXECUTION_LIST_CAPABILITY_ID = 'executions';

/**
 * Reuse an existing i18n grammar slot. The `executions` surface declares no slot
 * of its own (see manifest/surfaces.json messageSlots); `empty-states` is the
 * slot that covers the `executions` surface and owns list/page copy, so the
 * four region-state message keys live there rather than forking a fourteenth
 * slot.
 */
export const EXECUTION_LIST_MESSAGE_SLOT = 'empty-states';

/**
 * Closed field set of a handed-over execution row. Unknown fields are refused.
 * `status` must be one of EXECUTION_STATUSES (the engine vocabulary).
 */
export const EXECUTION_LIST_ROW_FIELDS = Object.freeze(['id', 'workflowName', 'status', 'lastExecutedAt']);

/**
 * The engine's execution status vocabulary (contracts/execution.contract.md):
 * the terminal states (success / error / canceled / crashed) plus the in-progress
 * states (running / waiting). `new` is transient (an execution reserved but not
 * yet started) and is not a list-presented status, so it is excluded from the
 * closed set the list can display or filter by.
 */
export const EXECUTION_STATUSES = Object.freeze(['success', 'error', 'canceled', 'crashed', 'running', 'waiting']);

/** The closed status-filter vocabulary: `all` plus every execution status. */
export const EXECUTION_LIST_FILTER_VALUES = Object.freeze(['all', ...EXECUTION_STATUSES]);

/** Bounds: visible rows are bounded and enforced. (The filter is a closed pick, not a length-bounded string.) */
export const EXECUTION_LIST_LIMITS = Object.freeze({
  maxVisible: 20,
  hardMaxVisible: 50,
});

/**
 * Accessibility intent per region state, derived once so the a11y observable and
 * the contract cannot drift apart (same rule as WORKFLOW_LIST_A11Y / DIALOG_A11Y).
 *
 * `error` is the only assertive state. `loading` is the only busy one. A `ready`
 * list is announced politely so a background refresh does not interrupt.
 */
export const EXECUTION_LIST_A11Y = Object.freeze({
  loading: Object.freeze({ role: 'status', 'aria-live': 'polite', 'aria-busy': true, hidden: false }),
  empty: Object.freeze({ role: 'region', 'aria-live': 'polite', 'aria-busy': false, hidden: false }),
  error: Object.freeze({ role: 'alert', 'aria-live': 'assertive', 'aria-busy': false, hidden: false }),
  ready: Object.freeze({ role: 'list', 'aria-live': 'polite', 'aria-busy': false, hidden: false }),
});

/** The state message key each region state carries, in the `empty-states` slot. */
const STATE_MESSAGE_NAME = Object.freeze({
  loading: 'loading',
  empty: 'empty',
  error: 'load-error',
  ready: 'executions',
});

function stateMessageKey(state) {
  return buildMessageKey(EXECUTION_LIST_MESSAGE_SLOT, STATE_MESSAGE_NAME[state]);
}

/* --------------------------------------------------------------- the contract */

/**
 * The migration contract. States reuse `REGION_STATES`; keys live in the existing
 * `empty-states` slot; rollback keeps the reference primary.
 */
export function executionListSurfaceContract() {
  return defineSurfaceContract({
    id: EXECUTION_LIST_SURFACE_ID,
    version: EXECUTION_LIST_SURFACE_VERSION,
    title: 'Executions list (loading / empty / error / ready, bounded + status-filterable)',
    mode: 'pilot',
    lifecycleState: 'available',
    capabilityRequirements: [
      {
        id: 'reference-ui',
        criticality: 'optional',
        degradation: {
          fallback: 'native-behavior',
          detail: 'without this surface the stock n8n executions page list remains the path',
        },
      },
      {
        id: EXECUTION_LIST_CAPABILITY_ID,
        criticality: 'optional',
        degradation: {
          fallback: 'native-behavior',
          detail: 'if the capability is absent, the reference executions list stays primary',
        },
      },
    ],
    inputBoundary: {
      fields: ['id', 'workflowName', 'status', 'lastExecutedAt', 'error', 'renderAvailable'],
      source: 'hand-over',
    },
    outputBoundary: {
      events: ['execution-list:rendered', 'execution-list:filtered'],
      authority: 'declare-request-render',
    },
    interaction: 'event',
    transport: 'local',
    localization: {
      slot: EXECUTION_LIST_MESSAGE_SLOT,
      fallbackLocale: 'en',
    },
    accessibility: {
      observables: ['role', 'aria-live', 'aria-busy', 'aria-label-key', 'hidden'],
    },
    states: {
      // The list is being fetched. Transient by nature; the only busy region.
      loading: { messageKey: stateMessageKey('loading') },
      // No executions visible: none exist, or the status filter matched nothing.
      empty: { messageKey: stateMessageKey('empty') },
      // The fetch failed. The only assertive region state.
      error: { messageKey: stateMessageKey('error'), errorKind: 'network' },
      // At least one execution is visible.
      ready: { messageKey: stateMessageKey('ready') },
    },
    observability: {
      events: [
        'execution-list.loaded',
        'execution-list.filtered',
        'execution-list.degraded',
      ],
    },
    rollback: {
      strategy: 'pilot-not-primary',
      reference: 'n8n-editor-ui@2.9.4',
    },
  });
}

/** Validate against the closed vocabularies, exactly like the #241/#245 pilots and P2-S04/S05 do. */
export function validateExecutionListSurfaceContract(contract = executionListSurfaceContract(), catalog = {}) {
  return validateSurfaceContract(contract, catalog);
}

/* ------------------------------------------------------------- the view-model */

function assertRowShape(row) {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) {
    throw new Error('an execution row must be a plain object');
  }
  const keys = Object.keys(row);
  for (const key of keys) {
    if (!EXECUTION_LIST_ROW_FIELDS.includes(key)) {
      throw new Error(
        `execution row has unknown field "${key}" (allowed: ${EXECUTION_LIST_ROW_FIELDS.join(', ')})`,
      );
    }
  }
  if (typeof row.id !== 'string' || row.id.length === 0) {
    throw new Error('execution row.id must be a non-empty string');
  }
  if (typeof row.workflowName !== 'string' || row.workflowName.length === 0) {
    throw new Error('execution row.workflowName must be a non-empty string');
  }
  if (typeof row.status !== 'string' || !EXECUTION_STATUSES.includes(row.status)) {
    throw new Error(
      `execution row.status must be one of ${EXECUTION_STATUSES.join(', ')} (got "${row.status}")`,
    );
  }
  if (row.lastExecutedAt !== undefined && row.lastExecutedAt !== null && typeof row.lastExecutedAt !== 'string') {
    throw new Error('execution row.lastExecutedAt must be an ISO string or null when present');
  }
}

function normalizeRow(row) {
  assertRowShape(row);
  return Object.freeze({
    id: row.id,
    workflowName: row.workflowName,
    status: row.status,
    lastExecutedAt: row.lastExecutedAt ?? null,
  });
}

/**
 * Create an executions-list view-model.
 *
 * @param {object} [init]
 * @param {number}  [init.maxVisible]      visible-row bound (clamped to the hard max)
 * @param {boolean} [init.renderAvailable] false = degradation (reference stays primary)
 * @param {string}  [init.locale]
 */
export function createExecutionListSurface(init = {}) {
  const contract = executionListSurfaceContract();
  const maxVisible = Number.isInteger(init.maxVisible) && init.maxVisible > 0
    ? Math.min(init.maxVisible, EXECUTION_LIST_LIMITS.hardMaxVisible)
    : EXECUTION_LIST_LIMITS.maxVisible;
  let renderAvailable = init.renderAvailable !== false;
  const locale = init.locale ?? 'en';

  /** @type {Array<readonly {id:string,workflowName:string,status:string,lastExecutedAt:string|null}>} */
  let rows = [];
  let statusFilter = 'all';
  let region = 'loading';
  let error = null;
  const history = [];
  let degradedEvents = 0;

  /** The rows after the current status filter, before the visible bound. ONE place. */
  function matchedRows() {
    if (statusFilter === 'all') return rows;
    return rows.filter((row) => row.status === statusFilter);
  }

  function visibleRows() {
    return matchedRows().slice(0, maxVisible);
  }

  function regionState() {
    return region;
  }

  /**
   * The one rule for the empty reason, derived from the loaded set and the filter.
   * "None exist" vs "the filter matched nothing" is carried here, not as a fifth
   * region state: at the region level both are `empty`, and the parity harness
   * compares the region, not the reason.
   */
  function emptyReason() {
    if (rows.length === 0) return 'none';
    return matchedRows().length === 0 ? 'filtered' : 'none';
  }

  function a11y() {
    const state = regionState();
    const intent = EXECUTION_LIST_A11Y[state] ?? EXECUTION_LIST_A11Y.loading;
    return Object.freeze({
      role: intent.role,
      'aria-live': intent['aria-live'],
      'aria-busy': intent['aria-busy'],
      hidden: intent.hidden,
      'aria-label-key': stateMessageKey(state),
    });
  }

  function displayModel() {
    const state = regionState();
    const matched = matchedRows();
    const visible = matched.slice(0, maxVisible);
    const errorDisplay = state === 'error' && error
      ? toDisplayModel(
          typeof error.kind === 'string'
            ? new FrontendError({
                kind: error.kind,
                code: error.code ?? null,
                messageKey: error.messageKey ?? undefined,
                message: error.message ?? undefined,
                status: typeof error.status === 'number' ? error.status : undefined,
              })
            : normalizeError(error),
        )
      : null;
    return Object.freeze({
      visible: true,
      regionState: state,
      loading: state === 'loading',
      empty: state === 'empty',
      error: state === 'error',
      count: rows.length,
      visibleCount: visible.length,
      truncated: state === 'ready' ? matched.length > maxVisible : false,
      reason: state === 'empty' ? emptyReason() : null,
      statusFilter,
      messageKey: stateMessageKey(state),
      fallbackText: errorDisplay?.message ?? null,
      rows: Object.freeze(visible.map((row) => ({ ...row }))),
      // Declared, never executed: the surface names what the user may ask for.
      actions: Object.freeze(
        state === 'ready' ? ['open', 'refresh']
          : state === 'empty' ? ['refresh', ...(emptyReason() === 'filtered' ? ['clear-filter'] : [])]
            : ['refresh'],
      ),
      degraded: !renderAvailable,
    });
  }

  function pushEvent(name) {
    history.push({ event: name, at: history.length });
  }

  return Object.freeze({
    id: EXECUTION_LIST_SURFACE_ID,
    version: EXECUTION_LIST_SURFACE_VERSION,
    get mode() {
      return 'pilot';
    },
    contract: Object.freeze(contract),
    get regionState() {
      return regionState();
    },
    get renderAvailable() {
      return renderAvailable;
    },
    get count() {
      return rows.length;
    },
    get statusFilter() {
      return statusFilter;
    },
    /** Set rendering availability. Degradation is observable, never silent. */
    setRenderAvailable(next) {
      renderAvailable = next === true;
      if (!renderAvailable) {
        degradedEvents += 1;
        history.push({ event: 'degraded', at: history.length });
      }
      return renderAvailable;
    },
    /**
     * Hand over the loaded list. Replaces the rows, resets the status filter to
     * `all`, and the region becomes `ready` (or `empty` when the list is empty).
     * This is the `hand-over` input: the surface never fetches.
     */
    loadSuccess(list = []) {
      if (!Array.isArray(list)) throw new Error('loadSuccess expects an array of execution rows');
      rows = list.map(normalizeRow);
      // A load with a filter active would be a stale result: reset it.
      statusFilter = 'all';
      error = null;
      region = rows.length > 0 ? 'ready' : 'empty';
      pushEvent('loaded');
      if (!renderAvailable) degradedEvents += 1;
      return rows.length;
    },
    /** The fetch failed. The only assertive region state. */
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
    /** Back to fetching. Rows are retained but the region is `loading`. */
    setLoading() {
      region = 'loading';
      pushEvent('loading');
      return 'loading';
    },
    /**
     * The one real mutation: the client-side status filter. Changes what is
     * VISIBLE. The vocabulary is closed (`all` plus the engine statuses); an
     * unknown status is refused. Filtering to zero is `empty` with
     * `reason: 'filtered'`.
     */
    setStatusFilter(status = 'all') {
      if (typeof status !== 'string' || !EXECUTION_LIST_FILTER_VALUES.includes(status)) {
        throw new Error(`status filter must be one of ${EXECUTION_LIST_FILTER_VALUES.join(', ')} (got "${status}")`);
      }
      statusFilter = status;
      if (region === 'ready' || region === 'empty') {
        region = visibleRows().length > 0 ? 'ready' : 'empty';
        if (statusFilter !== 'all') pushEvent('filtered');
      }
      return region;
    },
    displayModel,
    a11y,
    /** Observable snapshot for the parity harness (candidate side). */
    observe() {
      const state = regionState();
      const model = displayModel();
      return observation({
        surfaceId: EXECUTION_LIST_SURFACE_ID,
        side: 'candidate',
        visible: model.visible,
        regionState: state,
        loading: state === 'loading',
        empty: state === 'empty',
        error: state === 'error' ? { kind: error?.kind ?? 'network' } : null,
        interactions: Object.freeze({
          // Declared, not executed: what the user may ask for in this state.
          refresh: model.actions.includes('refresh'),
          open: model.actions.includes('open'),
          clearFilter: model.actions.includes('clear-filter'),
        }),
        // A SNAPSHOT of the current state, not a replay of history: the events
        // describe what is true now, exactly as the #245 snapshot rule requires.
        events: Object.freeze(state === 'ready' ? ['execution-list:rendered'] : []),
        accessibility: a11y(),
        localization: Object.freeze({ slot: EXECUTION_LIST_MESSAGE_SLOT, locale }),
        contract: Object.freeze({ id: EXECUTION_LIST_SURFACE_ID, version: EXECUTION_LIST_SURFACE_VERSION }),
      });
    },
    /** Deterministic history, so two runs of the same script agree. */
    get history() {
      return Object.freeze(history.map((item) => Object.freeze({ ...item })));
    },
    get degradedEvents() {
      return degradedEvents;
    },
  });
}

/* -------------------------------------------------------- the reference model */

/**
 * The reference (pinned n8n editor) observations, as deterministic fixtures. The
 * reference UI is not run here - these are the declared behaviours the candidate
 * is compared against, fixtures precisely so the comparison is reproducible.
 * They mirror `observe()` field for field, which is what makes the parity
 * harness fail-closed: a fixture that drifts from the candidate is a bug.
 */

/** The reference while the list is being fetched. */
export function referenceLoadingObservation(locale = 'en') {
  return observation({
    surfaceId: EXECUTION_LIST_SURFACE_ID,
    side: 'reference',
    visible: true,
    regionState: 'loading',
    loading: true,
    empty: false,
    error: null,
    interactions: Object.freeze({ refresh: true, open: false, clearFilter: false }),
    events: Object.freeze([]),
    accessibility: Object.freeze({
      role: 'status',
      'aria-live': 'polite',
      'aria-busy': true,
      hidden: false,
      'aria-label-key': stateMessageKey('loading'),
    }),
    localization: Object.freeze({ slot: EXECUTION_LIST_MESSAGE_SLOT, locale }),
    contract: Object.freeze({ id: EXECUTION_LIST_SURFACE_ID, version: EXECUTION_LIST_SURFACE_VERSION }),
  });
}

/**
 * The reference empty list. `reason` is 'none' (no executions) or 'filtered'
 * (the status filter matched nothing); at the region level both are `empty`.
 */
export function referenceEmptyObservation({ reason = 'none', locale = 'en' } = {}) {
  return observation({
    surfaceId: EXECUTION_LIST_SURFACE_ID,
    side: 'reference',
    visible: true,
    regionState: 'empty',
    loading: false,
    empty: true,
    error: null,
    interactions: Object.freeze({
      refresh: true,
      open: false,
      clearFilter: reason === 'filtered',
    }),
    events: Object.freeze([]),
    accessibility: Object.freeze({
      role: 'region',
      'aria-live': 'polite',
      'aria-busy': false,
      hidden: false,
      'aria-label-key': stateMessageKey('empty'),
    }),
    localization: Object.freeze({ slot: EXECUTION_LIST_MESSAGE_SLOT, locale }),
    contract: Object.freeze({ id: EXECUTION_LIST_SURFACE_ID, version: EXECUTION_LIST_SURFACE_VERSION }),
  });
}

/** The reference list that failed to load. The only assertive state. */
export function referenceErrorObservation({ errorKind = 'network', locale = 'en' } = {}) {
  if (typeof errorKind !== 'string' || errorKind === '') {
    throw new Error('reference errorKind must be a non-empty string when given');
  }
  return observation({
    surfaceId: EXECUTION_LIST_SURFACE_ID,
    side: 'reference',
    visible: true,
    regionState: 'error',
    loading: false,
    empty: false,
    error: { kind: errorKind },
    interactions: Object.freeze({ refresh: true, open: false, clearFilter: false }),
    events: Object.freeze([]),
    accessibility: Object.freeze({
      role: 'alert',
      'aria-live': 'assertive',
      'aria-busy': false,
      hidden: false,
      'aria-label-key': stateMessageKey('error'),
    }),
    localization: Object.freeze({ slot: EXECUTION_LIST_MESSAGE_SLOT, locale }),
    contract: Object.freeze({ id: EXECUTION_LIST_SURFACE_ID, version: EXECUTION_LIST_SURFACE_VERSION }),
  });
}

/** The reference loaded list: at least one execution visible. */
export function referenceReadyObservation({ count = 1, locale = 'en' } = {}) {
  return observation({
    surfaceId: EXECUTION_LIST_SURFACE_ID,
    side: 'reference',
    visible: true,
    regionState: 'ready',
    loading: false,
    empty: false,
    error: null,
    interactions: Object.freeze({ refresh: true, open: true, clearFilter: false }),
    events: Object.freeze(['execution-list:rendered']),
    accessibility: Object.freeze({
      role: 'list',
      'aria-live': 'polite',
      'aria-busy': false,
      hidden: false,
      'aria-label-key': stateMessageKey('ready'),
    }),
    localization: Object.freeze({ slot: EXECUTION_LIST_MESSAGE_SLOT, locale }),
    contract: Object.freeze({ id: EXECUTION_LIST_SURFACE_ID, version: EXECUTION_LIST_SURFACE_VERSION }),
  });
}

export { REGION_STATES, SURFACE_MODES };
