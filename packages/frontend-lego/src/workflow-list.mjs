/**
 * Dashboard workflow-list pilot (P2-S03 Layer 3, surface `dashboard`).
 *
 * The first strangler slice of P2-S03's Layers 3–5, delivered as a focused,
 * low-risk pilot in the #241/#245 shape: **one additional low-risk surface,
 * `mode: pilot`, `rollback: pilot-not-primary`, the original editor stays the
 * default path.**
 *
 * WHAT THIS SURFACE IS. A framework-neutral view-model for the Home workflow
 * list — the one place the list of workflows is *described*, so a later
 * migration can render it without forking a second vocabulary. It is a
 * view-model plus an observation, never a framework component. It declares,
 * requests and renders metadata; it never authorizes and never executes.
 * Opening a workflow or toggling its active state are *declared* interactions —
 * the surface names them, the reference (or a future primary) performs them.
 *
 * WHY a view-model and not a fetcher. The dashboard surface's backend is the
 * `workflow` capability (`contracts/workflow.contract.md`, `/rest/workflows`).
 * The pilot does not fetch: entries are **handed over** (`inputBoundary.source:
 * "hand-over"`), exactly as the #241 pilot hands over its state. Fetching would
 * give the UI a private data path and a second source of truth for the
 * workflow catalog, which the compatibility boundary exists to prevent.
 *
 * THE FOUR REGION STATES, REUSED NOT FORKED. The contract keys its `states` on
 * the closed `REGION_STATES` vocabulary (loading / empty / error / ready), the
 * same vocabulary the parity harness compares against the pinned reference.
 * "The user filtered the list down to nothing" and "there are no workflows"
 * are BOTH `empty` at the region level — the difference is carried in the
 * display model's `reason`, not invented as a fifth region state.
 *
 * BOUNDED. The list has a ceiling on visible rows. A workflow list with no
 * bound is an unbounded memory/CPU leak on a Home screen, so rows past the
 * bound are retained (the data is not dropped) but not presented; "show more"
 * is a declared interaction, not a silent overflow.
 *
 * CLIENT FILTER IS A REAL MUTATION. Unlike the purely declarative interactions,
 * the name filter changes what is VISIBLE, and it is the one behaviour a test
 * can observe end to end: type, narrow, clear. Filtering to zero is `empty`
 * with `reason: 'filtered'`, which is how the reference tells a first-time
 * "no workflows yet" from "your search matched nothing".
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
export const WORKFLOW_LIST_SURFACE_ID = 'ui.pages.dashboard';
export const WORKFLOW_LIST_SURFACE_VERSION = '1.0.0';
export const WORKFLOW_LIST_CAPABILITY_ID = 'dashboard';

/** Reuse the existing i18n grammar. The `dashboard` slot owns Home labels/summaries. */
export const WORKFLOW_LIST_MESSAGE_SLOT = 'dashboard';

/** Closed field set of a handed-over workflow row. Unknown fields are refused. */
export const WORKFLOW_LIST_ROW_FIELDS = Object.freeze(['id', 'name', 'active', 'updatedAt']);

/** Bounds: visible rows and the filter length are both bounded and both enforced. */
export const WORKFLOW_LIST_LIMITS = Object.freeze({
  maxVisible: 20,
  hardMaxVisible: 50,
  maxFilterLength: 64,
});

/**
 * Accessibility intent per region state, derived once so the a11y observable and
 * the contract cannot drift apart.
 *
 * `error` is the only assertive state. `loading` is the only busy one. A `ready`
 * list is announced politely so a background refresh does not interrupt.
 */
export const WORKFLOW_LIST_A11Y = Object.freeze({
  loading: Object.freeze({ role: 'status', 'aria-live': 'polite', 'aria-busy': true, hidden: false }),
  empty: Object.freeze({ role: 'region', 'aria-live': 'polite', 'aria-busy': false, hidden: false }),
  error: Object.freeze({ role: 'alert', 'aria-live': 'assertive', 'aria-busy': false, hidden: false }),
  ready: Object.freeze({ role: 'list', 'aria-live': 'polite', 'aria-busy': false, hidden: false }),
});

/** The state message key each region state carries, in the `dashboard` slot. */
const STATE_MESSAGE_NAME = Object.freeze({
  loading: 'loading',
  empty: 'empty',
  error: 'load-error',
  ready: 'workflows',
});

function stateMessageKey(state) {
  return buildMessageKey(WORKFLOW_LIST_MESSAGE_SLOT, STATE_MESSAGE_NAME[state]);
}

/* --------------------------------------------------------------- the contract */

/**
 * The migration contract. States reuse `REGION_STATES`; keys live in the existing
 * `dashboard` slot; rollback keeps the reference primary.
 */
export function workflowListSurfaceContract() {
  return defineSurfaceContract({
    id: WORKFLOW_LIST_SURFACE_ID,
    version: WORKFLOW_LIST_SURFACE_VERSION,
    title: 'Dashboard workflow list (loading / empty / error / ready, bounded + filterable)',
    mode: 'pilot',
    lifecycleState: 'available',
    capabilityRequirements: [
      {
        id: 'reference-ui',
        criticality: 'optional',
        degradation: {
          fallback: 'native-behavior',
          detail: 'without this surface the stock n8n Home workflow list remains the path',
        },
      },
      {
        id: WORKFLOW_LIST_CAPABILITY_ID,
        criticality: 'optional',
        degradation: {
          fallback: 'native-behavior',
          detail: 'if the capability is absent, the reference Home workflow list stays primary',
        },
      },
    ],
    inputBoundary: {
      fields: ['id', 'name', 'active', 'updatedAt', 'error', 'renderAvailable'],
      source: 'hand-over',
    },
    outputBoundary: {
      events: ['workflow-list:rendered', 'workflow-list:filtered'],
      authority: 'declare-request-render',
    },
    interaction: 'event',
    transport: 'local',
    localization: {
      slot: WORKFLOW_LIST_MESSAGE_SLOT,
      fallbackLocale: 'en',
    },
    accessibility: {
      observables: ['role', 'aria-live', 'aria-busy', 'aria-label-key', 'hidden'],
    },
    states: {
      // The list is being fetched. Transient by nature; the only busy region.
      loading: { messageKey: stateMessageKey('loading') },
      // No workflows visible: none exist, or the filter matched nothing.
      empty: { messageKey: stateMessageKey('empty') },
      // The fetch failed. The only assertive region state.
      error: { messageKey: stateMessageKey('error'), errorKind: 'network' },
      // At least one workflow is visible.
      ready: { messageKey: stateMessageKey('ready') },
    },
    observability: {
      events: [
        'workflow-list.loaded',
        'workflow-list.filtered',
        'workflow-list.degraded',
      ],
    },
    rollback: {
      strategy: 'pilot-not-primary',
      reference: 'n8n-editor-ui@2.9.4',
    },
  });
}

/** Validate against the closed vocabularies, exactly like the #241/#245 pilots do. */
export function validateWorkflowListSurfaceContract(contract = workflowListSurfaceContract(), catalog = {}) {
  return validateSurfaceContract(contract, catalog);
}

/* ------------------------------------------------------------- the view-model */

function assertRowShape(row) {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) {
    throw new Error('a workflow row must be a plain object');
  }
  const keys = Object.keys(row);
  for (const key of keys) {
    if (!WORKFLOW_LIST_ROW_FIELDS.includes(key)) {
      throw new Error(
        `workflow row has unknown field "${key}" (allowed: ${WORKFLOW_LIST_ROW_FIELDS.join(', ')})`,
      );
    }
  }
  if (typeof row.id !== 'string' || row.id.length === 0) {
    throw new Error('workflow row.id must be a non-empty string');
  }
  if (typeof row.name !== 'string' || row.name.length === 0) {
    throw new Error('workflow row.name must be a non-empty string');
  }
  if (typeof row.active !== 'boolean') {
    throw new Error('workflow row.active must be a boolean');
  }
  if (row.updatedAt !== undefined && row.updatedAt !== null && typeof row.updatedAt !== 'string') {
    throw new Error('workflow row.updatedAt must be an ISO string or null when present');
  }
}

function normalizeRow(row) {
  assertRowShape(row);
  return Object.freeze({
    id: row.id,
    name: row.name,
    active: row.active,
    updatedAt: row.updatedAt ?? null,
  });
}

/**
 * Create a dashboard workflow-list view-model.
 *
 * @param {object} [init]
 * @param {number}  [init.maxVisible]      visible-row bound (clamped to the hard max)
 * @param {boolean} [init.renderAvailable] false = degradation (reference stays primary)
 * @param {string}  [init.locale]
 */
export function createWorkflowListSurface(init = {}) {
  const contract = workflowListSurfaceContract();
  const maxVisible = Number.isInteger(init.maxVisible) && init.maxVisible > 0
    ? Math.min(init.maxVisible, WORKFLOW_LIST_LIMITS.hardMaxVisible)
    : WORKFLOW_LIST_LIMITS.maxVisible;
  let renderAvailable = init.renderAvailable !== false;
  const locale = init.locale ?? 'en';

  /** @type {Array<readonly {id:string,name:string,active:boolean,updatedAt:string|null}>} */
  let rows = [];
  let filter = '';
  let region = 'loading';
  let error = null;
  const history = [];
  let degradedEvents = 0;

  /** The rows after the current filter, before the visible bound. ONE place. */
  function matchedRows() {
    const trimmed = filter.trim().toLowerCase();
    if (trimmed === '') return rows;
    return rows.filter((row) => row.name.toLowerCase().includes(trimmed));
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
    const intent = WORKFLOW_LIST_A11Y[state] ?? WORKFLOW_LIST_A11Y.loading;
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
      filter,
      messageKey: stateMessageKey(state),
      fallbackText: errorDisplay?.message ?? null,
      rows: Object.freeze(visible.map((row) => ({ ...row }))),
      // Declared, never executed: the surface names what the user may ask for.
      actions: Object.freeze(
        state === 'ready' ? ['open', 'toggle-active', 'create', 'refresh']
          : state === 'empty' ? ['create', 'refresh', ...(emptyReason() === 'filtered' ? ['clear-filter'] : [])]
            : ['refresh'],
      ),
      degraded: !renderAvailable,
    });
  }

  function pushEvent(name) {
    history.push({ event: name, at: history.length });
  }

  return Object.freeze({
    id: WORKFLOW_LIST_SURFACE_ID,
    version: WORKFLOW_LIST_SURFACE_VERSION,
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
    get filter() {
      return filter;
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
     * Hand over the loaded list. Replaces the rows, clears the filter, and the
     * region becomes `ready` (or `empty` when the list is empty). This is the
     * `hand-over` input: the surface never fetches.
     */
    loadSuccess(list = []) {
      if (!Array.isArray(list)) throw new Error('loadSuccess expects an array of workflow rows');
      rows = list.map(normalizeRow);
      // A load with a filter active would be a stale result: clear it.
      filter = '';
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
     * The one real mutation: the client-side name filter. Changes what is
     * VISIBLE. Filtering to zero is `empty` with `reason: 'filtered'`.
     */
    setFilter(text = '') {
      if (typeof text !== 'string') throw new Error('setFilter expects a string');
      if (text.length > WORKFLOW_LIST_LIMITS.maxFilterLength) {
        throw new Error(`filter exceeds ${WORKFLOW_LIST_LIMITS.maxFilterLength} characters`);
      }
      filter = text;
      if (region === 'ready' || region === 'empty') {
        region = visibleRows().length > 0 ? 'ready' : 'empty';
        if (filter.trim() !== '') pushEvent('filtered');
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
        surfaceId: WORKFLOW_LIST_SURFACE_ID,
        side: 'candidate',
        visible: model.visible,
        regionState: state,
        loading: state === 'loading',
        empty: state === 'empty',
        error: state === 'error' ? { kind: error?.kind ?? 'network' } : null,
        interactions: Object.freeze({
          // Declared, not executed: what the user may ask for in this state.
          create: model.actions.includes('create'),
          refresh: model.actions.includes('refresh'),
          open: model.actions.includes('open'),
          clearFilter: model.actions.includes('clear-filter'),
        }),
        // A SNAPSHOT of the current state, not a replay of history: the events
        // describe what is true now, exactly as the #245 snapshot rule requires.
        events: Object.freeze(state === 'ready' ? ['workflow-list:rendered'] : []),
        accessibility: a11y(),
        localization: Object.freeze({ slot: WORKFLOW_LIST_MESSAGE_SLOT, locale }),
        contract: Object.freeze({ id: WORKFLOW_LIST_SURFACE_ID, version: WORKFLOW_LIST_SURFACE_VERSION }),
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
 * reference UI is not run here — these are the declared behaviours the candidate
 * is compared against, fixtures precisely so the comparison is reproducible.
 * They mirror `observe()` field for field, which is what makes the parity
 * harness fail-closed: a fixture that drifts from the candidate is a bug.
 */

/** The reference while the list is being fetched. */
export function referenceLoadingObservation(locale = 'en') {
  return observation({
    surfaceId: WORKFLOW_LIST_SURFACE_ID,
    side: 'reference',
    visible: true,
    regionState: 'loading',
    loading: true,
    empty: false,
    error: null,
    interactions: Object.freeze({ create: false, refresh: true, open: false, clearFilter: false }),
    events: Object.freeze([]),
    accessibility: Object.freeze({
      role: 'status',
      'aria-live': 'polite',
      'aria-busy': true,
      hidden: false,
      'aria-label-key': stateMessageKey('loading'),
    }),
    localization: Object.freeze({ slot: WORKFLOW_LIST_MESSAGE_SLOT, locale }),
    contract: Object.freeze({ id: WORKFLOW_LIST_SURFACE_ID, version: WORKFLOW_LIST_SURFACE_VERSION }),
  });
}

/**
 * The reference empty list. `reason` is 'none' (no workflows) or 'filtered'
 * (the search matched nothing); at the region level both are `empty`.
 */
export function referenceEmptyObservation({ reason = 'none', locale = 'en' } = {}) {
  return observation({
    surfaceId: WORKFLOW_LIST_SURFACE_ID,
    side: 'reference',
    visible: true,
    regionState: 'empty',
    loading: false,
    empty: true,
    error: null,
    interactions: Object.freeze({
      create: true,
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
    localization: Object.freeze({ slot: WORKFLOW_LIST_MESSAGE_SLOT, locale }),
    contract: Object.freeze({ id: WORKFLOW_LIST_SURFACE_ID, version: WORKFLOW_LIST_SURFACE_VERSION }),
  });
}

/** The reference list that failed to load. The only assertive state. */
export function referenceErrorObservation({ errorKind = 'network', locale = 'en' } = {}) {
  if (typeof errorKind !== 'string' || errorKind === '') {
    throw new Error('reference errorKind must be a non-empty string when given');
  }
  return observation({
    surfaceId: WORKFLOW_LIST_SURFACE_ID,
    side: 'reference',
    visible: true,
    regionState: 'error',
    loading: false,
    empty: false,
    error: { kind: errorKind },
    interactions: Object.freeze({ create: false, refresh: true, open: false, clearFilter: false }),
    events: Object.freeze([]),
    accessibility: Object.freeze({
      role: 'alert',
      'aria-live': 'assertive',
      'aria-busy': false,
      hidden: false,
      'aria-label-key': stateMessageKey('error'),
    }),
    localization: Object.freeze({ slot: WORKFLOW_LIST_MESSAGE_SLOT, locale }),
    contract: Object.freeze({ id: WORKFLOW_LIST_SURFACE_ID, version: WORKFLOW_LIST_SURFACE_VERSION }),
  });
}

/** The reference loaded list: at least one workflow visible. */
export function referenceReadyObservation({ count = 1, locale = 'en' } = {}) {
  return observation({
    surfaceId: WORKFLOW_LIST_SURFACE_ID,
    side: 'reference',
    visible: true,
    regionState: 'ready',
    loading: false,
    empty: false,
    error: null,
    interactions: Object.freeze({ create: true, refresh: true, open: true, clearFilter: false }),
    events: Object.freeze(['workflow-list:rendered']),
    accessibility: Object.freeze({
      role: 'list',
      'aria-live': 'polite',
      'aria-busy': false,
      hidden: false,
      'aria-label-key': stateMessageKey('ready'),
    }),
    localization: Object.freeze({ slot: WORKFLOW_LIST_MESSAGE_SLOT, locale }),
    contract: Object.freeze({ id: WORKFLOW_LIST_SURFACE_ID, version: WORKFLOW_LIST_SURFACE_VERSION }),
  });
}

export { REGION_STATES, SURFACE_MODES };
