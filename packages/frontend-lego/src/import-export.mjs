/**
 * Import/export surface pilot (P2-S17, issue #240) - the strangler slice for
 * the workflow JSON import/export flow, split out of P2-S03. One surface,
 * one delivery scope: export a handed-over workflow document byte-for-byte
 * and hand a validated imported document to the app layer.
 *
 * Boundary (invariants 4-5): the workflow document is HANDED OVER (input-
 * Boundary source hand-over) through declared capabilities only. The surface
 * holds no private data path and no second source of truth: it never fetches,
 * never reads window/location, NEVER POSTS A WORKFLOW - request-export and
 * import-document are DECLARED interactions with closed results; the
 * handed-over document is byte-identical after every interaction. Workflow
 * JSON semantics are compatibility-critical (#240 invariant): an import is
 * parsed and validated, then passed through WITHOUT alteration - no key is
 * stripped, no value is rewritten, and the exported JSON parses back to
 * exactly the handed-over document.
 *
 * Security boundary (the load-bearing rule): a document envelope carrying
 * secret or session material is refused with an explicit security error on
 * BOTH the hand-over and the import candidate, never dropped. There is no
 * evaluator here (no eval, no new Function), no fetch and no history touch -
 * parsing uses JSON.parse only.
 *
 * Closed contracts (invariants 4 and 7): the four region states are exactly
 * the shared REGION_STATES; actions are refresh | request-export |
 * import-document; export results are accepted | not-ready; import results
 * are accepted | invalid-json | invalid-document | not-ready; an empty
 * workflow is empty with reason none, never a fifth state.
 *
 * Pilot (invariants 1 and 9): the original n8n editor stays the default path;
 * rollback is switching the pilot off with no residual state and no
 * workflow-data migration (rollbackStrategy: pilot-not-primary in the
 * surface-migrations manifest).
 */
import { observation } from './parity.mjs';
import { REGION_STATES } from './surface-contract.mjs';

export const IO_STATES = REGION_STATES;

export const IO_SURFACE_ID = 'import-export';
export const IO_SURFACE_VERSION = 'p1';
export const IO_MESSAGE_SLOT = 'import-export';

/** Closed empty reason: a workflow with no nodes is none, never a fifth state. */
export const IO_EMPTY_REASONS = Object.freeze(['none']);

/** Closed action vocabulary: what the user may ask for in a state (declared). */
export const IO_ACTIONS = Object.freeze(['refresh', 'request-export', 'import-document']);

/**
 * Closed request-result vocabularies: every declared outcome is explicit.
 * accepted means the REQUEST was accepted for the app layer - the workflow
 * document is written by the app layer, never here.
 */
export const IO_EXPORT_RESULTS = Object.freeze(['accepted', 'not-ready']);
export const IO_IMPORT_RESULTS = Object.freeze([
  'accepted', 'invalid-json', 'invalid-document', 'not-ready',
]);

/** Default visible node-preview cap and the hard maximum a caller can request. */
export const IO_MAX_VISIBLE_DEFAULT = 30;
export const IO_MAX_VISIBLE_HARD_MAX = 100;

/** The a11y labels for the interactive controls, declared once. */
export const IO_LABELS = Object.freeze({
  export: 'Export workflow',
  import: 'Import workflow file',
  refresh: 'Refresh',
});

/** Closed hand-over payload: one load, the workflow document. */
const PAYLOAD_KEYS = Object.freeze(['workflow']);

/**
 * Fields that would carry secret or session material in a document
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

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The workflow-JSON contract: a document must be a plain object carrying
 * nodes (array) + connections (object). Everything else passes through
 * untouched - semantics compatibility-critical, no key is stripped.
 */
function documentProblem(document) {
  if (!isPlainObject(document)) return 'not a plain object';
  if (!Array.isArray(document.nodes)) return 'missing nodes array';
  if (!isPlainObject(document.connections)) return 'missing connections object';
  return null;
}

function assertHandOverDocument(document) {
  const problem = documentProblem(document);
  if (problem !== null) {
    throw new Error(`loadSuccess workflow document is invalid: ${problem}`);
  }
  assertNoSecretFields(Object.keys(document), 'loadSuccess workflow document');
}

/** The declared surface contract: states keyed on REGION_STATES exactly. */
export function importExportSurfaceContract() {
  return Object.freeze({
    id: IO_SURFACE_ID,
    version: IO_SURFACE_VERSION,
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
      actions: IO_ACTIONS,
      exportResults: IO_EXPORT_RESULTS,
      importResults: IO_IMPORT_RESULTS,
      emptyReasons: IO_EMPTY_REASONS,
    }),
    bounds: Object.freeze({
      maxVisibleDefault: IO_MAX_VISIBLE_DEFAULT,
      maxVisibleHardMax: IO_MAX_VISIBLE_HARD_MAX,
    }),
  });
}

/**
 * The a11y intent is derived ONCE here, so the contract's declared observables
 * and the view-model's rendered attributes cannot drift. The ready state is
 * the form landmark; every other state is a status. Only error is aria-live
 * assertive; only loading is aria-busy.
 */
export const IO_A11Y = Object.freeze(
  Object.fromEntries(
    IO_STATES.map((state) => [
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
 * exactly these fields). The empty region offers refresh only - exporting or
 * importing an empty document stays with the reference path (recorded as
 * evidence, never hidden).
 */
export function ioActionsFor(region) {
  if (region === 'error') return Object.freeze(['refresh']);
  if (region === 'loading') return Object.freeze([]);
  if (region === 'empty') return Object.freeze(['refresh']);
  return Object.freeze(['refresh', 'request-export', 'import-document']);
}

function interactionsFor(region) {
  const actions = ioActionsFor(region);
  return Object.freeze({
    refresh: actions.includes('refresh'),
    requestExport: actions.includes('request-export'),
    importDocument: actions.includes('import-document'),
  });
}

/**
 * Create the import/export view-model. The workflow document enters ONLY
 * through loadSuccess() (one hand-over); the surface performs no fetch and
 * never posts the workflow - request-export serializes exactly the handed-
 * over document (round-trip semantic identity), while import-document parses
 * a candidate string with JSON.parse, validates it and holds it as a PENDING
 * hand-off for the app layer. The workflow document never changes here.
 */
export function createImportExportSurface(options = {}) {
  const locale = options.locale ?? 'en';
  const requestedMax = options.maxVisible ?? IO_MAX_VISIBLE_DEFAULT;
  if (!Number.isInteger(requestedMax) || requestedMax <= 0) {
    throw new Error('maxVisible must be a positive integer');
  }
  const maxVisible = Math.min(requestedMax, IO_MAX_VISIBLE_HARD_MAX);
  const renderAvailable = options.renderAvailable ?? true;

  let workflow = null;
  let loaded = false;
  let region = 'loading';
  let error = null;
  let degradedEvents = 0;
  let pendingAnnouncement = null;
  let pendingImport = null;
  const history = [];

  function pushEvent(name) {
    history.push({ at: history.length, name });
    if (!renderAvailable) degradedEvents += 1;
  }

  function regionState() {
    return region;
  }

  function nodeNames() {
    if (workflow === null) return [];
    return workflow.nodes.map((node) => (
      isPlainObject(node) && typeof node.name === 'string' && node.name.trim() !== ''
        ? node.name
        : '(unnamed)'
    ));
  }

  function displayModel() {
    const names = nodeNames();
    const shown = names.slice(0, maxVisible);
    return Object.freeze({
      visible: true,
      visibleCount: names.length,
      shown: Object.freeze(shown.map((name) => Object.freeze({ name }))),
      truncated: names.length > shown.length,
      total: names.length,
      reason: region === 'empty' ? 'none' : null,
      pendingImport: pendingImport !== null,
      focusOrder: Object.freeze(region === 'ready' ? ['export', 'import'] : []),
      labels: IO_LABELS,
      announcement: pendingAnnouncement,
      actions: ioActionsFor(region),
      error: region === 'error' ? { kind: error?.kind ?? 'network' } : null,
    });
  }

  function a11y() {
    return IO_A11Y[regionState()];
  }

  return Object.freeze({
    id: IO_SURFACE_ID,
    contract: importExportSurfaceContract(),
    maxVisible,
    /**
     * The only data entry point (one hand-over: the workflow document). The
     * surface never fetches and never posts the workflow - what the payload
     * carried is exactly what exports. Secret-bearing envelopes, non-documents
     * and missing nodes/connections are refused.
     */
    loadSuccess(payload) {
      if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new Error('loadSuccess expects a hand-over payload object {workflow}');
      }
      const keys = Object.keys(payload);
      assertNoSecretFields(keys, 'loadSuccess payload');
      const sorted = keys.sort();
      if (sorted.join(',') !== [...PAYLOAD_KEYS].sort().join(',')) {
        throw new Error(`loadSuccess payload must have exactly ${PAYLOAD_KEYS.join(',')} (got ${sorted.join(',')})`);
      }
      assertHandOverDocument(payload.workflow);
      workflow = payload.workflow;
      error = null;
      loaded = true;
      pendingAnnouncement = null;
      region = workflow.nodes.length > 0 ? 'ready' : 'empty';
      pushEvent('loaded');
      return workflow.nodes.length;
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
    /** Back to loading. The document is retained but the region is loading. */
    setLoading() {
      region = 'loading';
      pushEvent('loading');
      return 'loading';
    },
    /**
     * DECLARED, never executed: ask the app layer to export the handed-over
     * document. The export content is EXACTLY the handed-over document -
     * exportJson() round-trips to a deep-equal document (semantics
     * compatibility-critical, #240 invariant).
     */
    requestExport() {
      if (region !== 'ready') return 'not-ready';
      pushEvent('export-requested');
      return 'accepted';
    },
    /**
     * The handed-over document serialized exactly - parsing this string
     * yields a document deep-equal to the hand-over (no key stripped, no
     * value rewritten).
     */
    exportJson() {
      if (workflow === null) {
        throw new Error('exportJson before loadSuccess: the document is handed over first');
      }
      return JSON.stringify(workflow);
    },
    /**
     * DECLARED, never installed: parse + validate a candidate file string
     * (JSON.parse only - no evaluator). A valid candidate is held as the
     * PENDING hand-off for the app layer; the workflow document on screen is
     * byte-identical - the app layer writes the workflow.
     */
    importDocument(text) {
      if (typeof text !== 'string') {
        throw new Error('importDocument expects the file content as a string');
      }
      if (region !== 'ready') return 'not-ready';
      let candidate;
      try {
        candidate = JSON.parse(text);
      } catch {
        return 'invalid-json';
      }
      if (!isPlainObject(candidate)) return 'invalid-document';
      assertNoSecretFields(Object.keys(candidate), 'import candidate');
      const problem = documentProblem(candidate);
      if (problem !== null) return 'invalid-document';
      pendingImport = candidate;
      pushEvent('import-accepted');
      pendingAnnouncement = typeof candidate.name === 'string' && candidate.name.trim() !== ''
        ? candidate.name
        : 'Import';
      return 'accepted';
    },
    displayModel,
    a11y,
    /** Observable snapshot for the parity harness (candidate side). */
    observe() {
      const state = regionState();
      const model = displayModel();
      const events = state === 'ready' ? ['import-export:rendered'] : [];
      if (state === 'ready' && model.announcement !== null) {
        events.push('import-export:changed');
      }
      return observation({
        surfaceId: IO_SURFACE_ID,
        side: 'candidate',
        visible: model.visible === true,
        regionState: state,
        loading: state === 'loading',
        empty: state === 'empty',
        error: state === 'error' ? { kind: error?.kind ?? 'network' } : null,
        interactions: interactionsFor(state),
        events: Object.freeze(events),
        accessibility: a11y(),
        localization: Object.freeze({ slot: IO_MESSAGE_SLOT, locale }),
        contract: Object.freeze({ id: IO_SURFACE_ID, version: IO_SURFACE_VERSION }),
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
    /** The PENDING imported document for the app layer (never installed here). */
    get pendingImport() {
      return pendingImport;
    },
  });
}

/* -------------------------------------------------------- the reference model */

/**
 * The reference (pinned n8n editor) observations as deterministic fixtures.
 * The reference UI is not run here - these are the declared behaviours the
 * candidate is compared against. They mirror observe() field for field, and
 * their interactions come from the SAME ioActionsFor rule the view-model
 * uses, so the two sides cannot drift by construction.
 */
function referenceObservation({ regionState: state, error = null, events = [], locale }) {
  return observation({
    surfaceId: IO_SURFACE_ID,
    side: 'reference',
    visible: true,
    regionState: state,
    loading: state === 'loading',
    empty: state === 'empty',
    error,
    interactions: interactionsFor(state),
    events: Object.freeze(events),
    accessibility: IO_A11Y[state],
    localization: Object.freeze({ slot: IO_MESSAGE_SLOT, locale }),
    contract: Object.freeze({ id: IO_SURFACE_ID, version: IO_SURFACE_VERSION }),
  });
}

export function referenceLoadingObservation(locale = 'en') {
  return referenceObservation({ regionState: 'loading', locale });
}

export function referenceEmptyObservation({ reason = 'none', locale = 'en' } = {}) {
  if (!IO_EMPTY_REASONS.includes(reason)) {
    throw new Error(`reason must be one of ${IO_EMPTY_REASONS.join(', ')} (got "${reason}")`);
  }
  return referenceObservation({ regionState: 'empty', locale });
}

export function referenceReadyObservation(locale = 'en') {
  return referenceObservation({ regionState: 'ready', events: ['import-export:rendered'], locale });
}

export function referenceErrorObservation({ errorKind = 'network', locale = 'en' } = {}) {
  return referenceObservation({ regionState: 'error', error: { kind: errorKind }, locale });
}
