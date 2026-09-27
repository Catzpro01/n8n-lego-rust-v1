/**
 * Workflow editor host pilot (P2-S08, issue #240) - the strangler slice for the
 * editor chrome AROUND the canvas: the name/tags/active-state header and the
 * workflow-level actions panel. One surface, one delivery scope.
 *
 * Scope note (issue #241 vs #240): the canvas/editor rewrite itself is OUT of
 * scope (ui.editor.canvas stays reference-only). This surface is the host header
 * and actions panel only - a reduction of the P2-S03 Layer 3 surface list, not
 * the excluded rewrite.
 *
 * Boundary (invariant 5): the workflow record is HANDED OVER read-only
 * (inputBoundary source hand-over). The surface never fetches
 * /rest/workflows/:id and never mutates workflow data - rename and activate are
 * DECLARED interactions that return explicit results and emit history events,
 * the write path stays with the app layer. loadSuccess() is the only data entry
 * point.
 *
 * Closed contracts (invariants 4 and 7): the four region states are exactly the
 * shared REGION_STATES; the action and result vocabularies are closed; the tag
 * chips list is bounded (maxVisible, truncation observable).
 *
 * Pilot (invariants 1 and 9): the original n8n editor stays the default path;
 * rollback is switching the pilot off with no residual state
 * (rollbackStrategy: pilot-not-primary in the surface-migrations manifest).
 */
import { observation } from './parity.mjs';
import { REGION_STATES } from './surface-contract.mjs';

export const WORKFLOW_EDITOR_STATES = REGION_STATES;

export const WORKFLOW_EDITOR_SURFACE_ID = 'workflow-editor';
export const WORKFLOW_EDITOR_SURFACE_VERSION = 'p1';
export const WORKFLOW_EDITOR_MESSAGE_SLOT = 'forms';

/** Closed action vocabulary: what the user may ask for in a state (declared). */
export const WORKFLOW_EDITOR_ACTIONS = Object.freeze([
  'refresh',
  'rename',
  'set-active',
  'set-inactive',
  'open-canvas',
  'clear-draft',
]);

/** Closed active-state display vocabulary. */
export const WORKFLOW_EDITOR_ACTIVE_STATES = Object.freeze(['active', 'inactive']);

/** Closed request-result vocabulary: every request outcome is explicit. */
export const WORKFLOW_EDITOR_REQUEST_RESULTS = Object.freeze(['requested', 'no-draft', 'not-ready', 'unchanged']);

/** Closed empty reasons. */
export const WORKFLOW_EDITOR_EMPTY_REASONS = Object.freeze(['none']);

/** Default visible tag-chip cap and the hard maximum a caller can request. */
export const WORKFLOW_EDITOR_MAX_VISIBLE_DEFAULT = 20;
export const WORKFLOW_EDITOR_MAX_VISIBLE_HARD_MAX = 50;

/** The rename draft bound: a longer name cannot be typed into the draft. */
export const WORKFLOW_EDITOR_NAME_MAX = 128;

/** Closed shapes: rows outside these shapes are refused, never silently dropped. */
const WORKFLOW_KEYS = Object.freeze(['id', 'name', 'active', 'tags', 'versionId']);
const TAG_KEYS = Object.freeze(['id', 'name']);

function assertTag(tag, index) {
  if (tag === null || typeof tag !== 'object' || Array.isArray(tag)) {
    throw new Error(`workflow tag ${index} must be an object`);
  }
  const keys = Object.keys(tag).sort();
  if (keys.join(',') !== [...TAG_KEYS].sort().join(',')) {
    throw new Error(`workflow tag ${index} must have exactly id,name (got ${keys.join(',')})`);
  }
  for (const key of TAG_KEYS) {
    if (typeof tag[key] !== 'string' || tag[key].trim() === '') {
      throw new Error(`workflow tag ${index} field ${key} must be a non-empty string`);
    }
  }
}

function assertWorkflow(workflow) {
  if (workflow === null || typeof workflow !== 'object' || Array.isArray(workflow)) {
    throw new Error('workflow must be an object');
  }
  const keys = Object.keys(workflow).sort();
  if (keys.join(',') !== [...WORKFLOW_KEYS].sort().join(',')) {
    throw new Error(`workflow must have exactly ${WORKFLOW_KEYS.join(',')} (got ${keys.join(',')})`);
  }
  for (const key of ['id', 'name', 'versionId']) {
    if (typeof workflow[key] !== 'string' || workflow[key].trim() === '') {
      throw new Error(`workflow field ${key} must be a non-empty string`);
    }
  }
  if (typeof workflow.active !== 'boolean') {
    throw new Error('workflow field active must be a boolean');
  }
  if (!Array.isArray(workflow.tags)) {
    throw new Error('workflow field tags must be an array');
  }
  workflow.tags.forEach(assertTag);
}

/** The declared surface contract: states keyed on REGION_STATES exactly. */
export function workflowEditorSurfaceContract() {
  return Object.freeze({
    id: WORKFLOW_EDITOR_SURFACE_ID,
    version: WORKFLOW_EDITOR_SURFACE_VERSION,
    inputBoundary: Object.freeze({ source: 'hand-over', entryPoint: 'loadSuccess', mutatesWorkflowData: false }),
    states: Object.freeze(
      Object.fromEntries(REGION_STATES.map((state) => [state, Object.freeze({ state })])),
    ),
    vocabularies: Object.freeze({
      actions: WORKFLOW_EDITOR_ACTIONS,
      activeStates: WORKFLOW_EDITOR_ACTIVE_STATES,
      requestResults: WORKFLOW_EDITOR_REQUEST_RESULTS,
      emptyReasons: WORKFLOW_EDITOR_EMPTY_REASONS,
    }),
    bounds: Object.freeze({
      maxVisibleDefault: WORKFLOW_EDITOR_MAX_VISIBLE_DEFAULT,
      maxVisibleHardMax: WORKFLOW_EDITOR_MAX_VISIBLE_HARD_MAX,
      nameMax: WORKFLOW_EDITOR_NAME_MAX,
    }),
  });
}

/**
 * The a11y intent is derived ONCE here, so the contract's declared observables
 * and the view-model's rendered attributes cannot drift. Only error is
 * aria-live assertive; only loading is aria-busy; the ready header is a group
 * announced politely so a background refresh does not interrupt.
 */
export const WORKFLOW_EDITOR_A11Y = Object.freeze(
  Object.fromEntries(
    REGION_STATES.map((state) => [
      state,
      Object.freeze({
        role: state === 'ready' ? 'group' : 'status',
        ariaLive: state === 'error' ? 'assertive' : 'polite',
        ariaBusy: state === 'loading',
      }),
    ]),
  ),
);

/**
 * Create the workflow-editor host view-model. The workflow record enters ONLY
 * through loadSuccess() (read-only hand-over); the surface performs no fetch and
 * no workflow-data mutation.
 */
export function createWorkflowEditorSurface(options = {}) {
  const locale = options.locale ?? 'en';
  const requestedMax = options.maxVisible ?? WORKFLOW_EDITOR_MAX_VISIBLE_DEFAULT;
  if (!Number.isInteger(requestedMax) || requestedMax <= 0) {
    throw new Error('maxVisible must be a positive integer');
  }
  const maxVisible = Math.min(requestedMax, WORKFLOW_EDITOR_MAX_VISIBLE_HARD_MAX);
  const renderAvailable = options.renderAvailable ?? true;

  let workflow = null;
  let region = 'loading';
  let error = null;
  let draftName = null;
  let degradedEvents = 0;
  const history = [];

  function pushEvent(name) {
    history.push({ at: history.length, name });
    if (!renderAvailable) degradedEvents += 1;
  }

  function regionState() {
    return region;
  }

  function shownTags() {
    return (workflow?.tags ?? []).slice(0, maxVisible);
  }

  function displayModel() {
    const tags = workflow?.tags ?? [];
    return Object.freeze({
      visible: true,
      workflowId: workflow?.id ?? null,
      name: workflow?.name ?? null,
      active: workflow === null ? null : (workflow.active ? 'active' : 'inactive'),
      versionId: workflow?.versionId ?? null,
      tags: Object.freeze(shownTags().map((tag) => Object.freeze({ ...tag }))),
      tagsTotal: tags.length,
      truncated: tags.length > shownTags().length,
      draftName,
      dirty: draftName !== null,
      reason: region === 'empty' ? 'none' : null,
      actions: Object.freeze(
        region === 'error'
          ? ['refresh']
          : region === 'loading' || region === 'empty'
            ? []
            : [
                'refresh',
                'rename',
                workflow?.active ? 'set-inactive' : 'set-active',
                'open-canvas',
                ...(draftName !== null ? ['clear-draft'] : []),
              ],
      ),
    });
  }

  function a11y() {
    return WORKFLOW_EDITOR_A11Y[regionState()];
  }

  return Object.freeze({
    id: WORKFLOW_EDITOR_SURFACE_ID,
    contract: workflowEditorSurfaceContract(),
    maxVisible,
    /**
     * The only data entry point (read-only hand-over). `next` is the workflow
     * record or null for "no workflow in context" (empty). Unknown shapes are
     * refused. A stale rename draft is cleared: a new hand-over would make it a
     * draft of the wrong record.
     */
    loadSuccess(next) {
      if (next !== null) assertWorkflow(next);
      workflow = next === null
        ? null
        : Object.freeze({
            id: next.id,
            name: next.name,
            active: next.active,
            tags: Object.freeze(next.tags.map((tag) => Object.freeze({ ...tag }))),
            versionId: next.versionId,
          });
      draftName = null;
      error = null;
      region = workflow === null ? 'empty' : 'ready';
      pushEvent('loaded');
      if (!renderAvailable) degradedEvents += 1;
      return workflow === null ? 0 : 1;
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
    /** Back to loading. The record is retained but the region is loading. */
    setLoading() {
      region = 'loading';
      pushEvent('loading');
      return 'loading';
    },
    /**
     * The one local mutation: the rename DRAFT. It is UI state only - the
     * handed-over workflow data is never touched. The draft is bounded by
     * WORKFLOW_EDITOR_NAME_MAX; a longer name is refused, not truncated.
     */
    setDraftName(name) {
      if (typeof name !== 'string') {
        throw new Error('draft name must be a string');
      }
      if (name.trim() === '') {
        throw new Error('draft name must be a non-empty string');
      }
      if (name.length > WORKFLOW_EDITOR_NAME_MAX) {
        throw new Error(`draft name must be at most ${WORKFLOW_EDITOR_NAME_MAX} characters`);
      }
      if (region !== 'ready') {
        return 'not-ready';
      }
      draftName = name;
      pushEvent('draft');
      return 'draft';
    },
    /** Clear the draft without applying it. */
    clearDraft() {
      if (region !== 'ready') return 'not-ready';
      draftName = null;
      pushEvent('draft-cleared');
      return 'cleared';
    },
    /**
     * DECLARED, never executed: ask the app layer to rename. Returns one of the
     * closed WORKFLOW_EDITOR_REQUEST_RESULTS; the workflow record keeps its
     * handed-over name (the surface never mutates workflow data).
     */
    requestRename() {
      if (region !== 'ready') return 'not-ready';
      if (draftName === null) return 'no-draft';
      pushEvent('rename-requested');
      return 'requested';
    },
    /**
     * DECLARED, never executed: ask the app layer to toggle activation.
     * 'unchanged' when already in the requested target state.
     */
    requestActiveToggle() {
      if (region !== 'ready') return 'not-ready';
      pushEvent('active-toggle-requested');
      return 'requested';
    },
    displayModel,
    a11y,
    /** Observable snapshot for the parity harness (candidate side). */
    observe() {
      const state = regionState();
      const model = displayModel();
      return observation({
        surfaceId: WORKFLOW_EDITOR_SURFACE_ID,
        side: 'candidate',
        visible: model.visible === true,
        regionState: state,
        loading: state === 'loading',
        empty: state === 'empty',
        error: state === 'error' ? { kind: error?.kind ?? 'network' } : null,
        interactions: Object.freeze({
          refresh: model.actions.includes('refresh'),
          rename: model.actions.includes('rename'),
          setActive: model.actions.includes('set-active'),
          setInactive: model.actions.includes('set-inactive'),
          openCanvas: model.actions.includes('open-canvas'),
          clearDraft: model.actions.includes('clear-draft'),
        }),
        events: Object.freeze(state === 'ready' ? ['workflow-editor:rendered'] : []),
        accessibility: a11y(),
        localization: Object.freeze({ slot: WORKFLOW_EDITOR_MESSAGE_SLOT, locale }),
        contract: Object.freeze({ id: WORKFLOW_EDITOR_SURFACE_ID, version: WORKFLOW_EDITOR_SURFACE_VERSION }),
      });
    },
    /** The handed-over record as an immutable snapshot (never mutated). */
    get workflowSnapshot() {
      return workflow;
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
 * The reference (pinned n8n editor) observations as deterministic fixtures. The
 * reference UI is not run here - these are the declared behaviours the candidate
 * is compared against. They mirror observe() field for field, which is what
 * makes the parity harness fail-closed: a fixture that drifts from the
 * candidate is a bug.
 */
export function referenceLoadingObservation(locale = 'en') {
  return observation({
    surfaceId: WORKFLOW_EDITOR_SURFACE_ID,
    side: 'reference',
    visible: true,
    regionState: 'loading',
    loading: true,
    empty: false,
    error: null,
    interactions: Object.freeze({
      refresh: false, rename: false, setActive: false, setInactive: false, openCanvas: false, clearDraft: false,
    }),
    events: Object.freeze([]),
    accessibility: WORKFLOW_EDITOR_A11Y.loading,
    localization: Object.freeze({ slot: WORKFLOW_EDITOR_MESSAGE_SLOT, locale }),
    contract: Object.freeze({ id: WORKFLOW_EDITOR_SURFACE_ID, version: WORKFLOW_EDITOR_SURFACE_VERSION }),
  });
}

export function referenceEmptyObservation({ reason = 'none', locale = 'en' } = {}) {
  return observation({
    surfaceId: WORKFLOW_EDITOR_SURFACE_ID,
    side: 'reference',
    visible: true,
    regionState: 'empty',
    loading: false,
    empty: true,
    error: null,
    interactions: Object.freeze({
      refresh: false, rename: false, setActive: false, setInactive: false, openCanvas: false, clearDraft: false,
    }),
    events: Object.freeze([]),
    accessibility: WORKFLOW_EDITOR_A11Y.empty,
    localization: Object.freeze({ slot: WORKFLOW_EDITOR_MESSAGE_SLOT, locale }),
    contract: Object.freeze({ id: WORKFLOW_EDITOR_SURFACE_ID, version: WORKFLOW_EDITOR_SURFACE_VERSION }),
  });
}

export function referenceReadyObservation({ active = true, locale = 'en' } = {}) {
  return observation({
    surfaceId: WORKFLOW_EDITOR_SURFACE_ID,
    side: 'reference',
    visible: true,
    regionState: 'ready',
    loading: false,
    empty: false,
    error: null,
    interactions: Object.freeze({
      refresh: true,
      rename: true,
      setActive: active === false,
      setInactive: active === true,
      openCanvas: true,
      clearDraft: false,
    }),
    events: Object.freeze(['workflow-editor:rendered']),
    accessibility: WORKFLOW_EDITOR_A11Y.ready,
    localization: Object.freeze({ slot: WORKFLOW_EDITOR_MESSAGE_SLOT, locale }),
    contract: Object.freeze({ id: WORKFLOW_EDITOR_SURFACE_ID, version: WORKFLOW_EDITOR_SURFACE_VERSION }),
  });
}

export function referenceErrorObservation({ errorKind = 'network', locale = 'en' } = {}) {
  return observation({
    surfaceId: WORKFLOW_EDITOR_SURFACE_ID,
    side: 'reference',
    visible: true,
    regionState: 'error',
    loading: false,
    empty: false,
    error: { kind: errorKind },
    interactions: Object.freeze({
      refresh: true, rename: false, setActive: false, setInactive: false, openCanvas: false, clearDraft: false,
    }),
    events: Object.freeze([]),
    accessibility: WORKFLOW_EDITOR_A11Y.error,
    localization: Object.freeze({ slot: WORKFLOW_EDITOR_MESSAGE_SLOT, locale }),
    contract: Object.freeze({ id: WORKFLOW_EDITOR_SURFACE_ID, version: WORKFLOW_EDITOR_SURFACE_VERSION }),
  });
}
