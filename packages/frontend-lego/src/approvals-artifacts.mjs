/**
 * Approvals and artifacts surfaces pilot (P2-S29, issue #240) - the
 * strangler slice for the approval queue and artifact review surfaces,
 * split out of P2-S03 (Layer 5). One surface, one delivery scope: render
 * the handed-over approval queue and artifact index read-only, and route
 * approve/reject DECLARED requests through the declared action path. THE
 * SURFACE NEVER WRITES A DECISION: request-approve and request-reject
 * record the request and announce it; the status flip arrives via a fresh
 * hand-over from the approval capability. Artifact bytes are never read,
 * uploaded or deleted - the review list is a handed-over index only.
 *
 * Boundary (invariants 4-5): approval and artifact state is HANDED OVER
 * (inputBoundary source hand-over) through declared capabilities only. The
 * surface holds no private data path and no second source of truth: no
 * fetch, no mutation of a record, no store access.
 *
 * Security boundary (the load-bearing rule): a payload envelope carrying
 * secret or session material is refused with an explicit security error,
 * never dropped. Records are opaque closed shapes - this surface evaluates
 * nothing (no eval, no new Function), fetches nothing and never persists.
 * The vocabularies are QUOTED, never redefined: approval status comes
 * from `decisionApprovalState`, artifact kind from `artifactKind` and
 * retention from `artifactRetention` in the vocabulary lock
 * (vocabulary.mjs) - no second architecture.
 *
 * Closed contracts (invariants 4 and 7): the four region states are exactly
 * the shared REGION_STATES; an empty queue with no artifacts is empty with
 * reason none, never a fifth state.
 *
 * Pilot (invariants 1 and 9): the original n8n editor stays the default
 * path; rollback is switching the pilot off with no residual state and no
 * workflow-data migration (rollbackStrategy: pilot-not-primary in the
 * surface-migrations manifest).
 */
import { observation } from './parity.mjs';
import { REGION_STATES } from './surface-contract.mjs';
import { vocabularyOf } from './vocabulary.mjs';

export const APPROVALS_ARTIFACTS_STATES = REGION_STATES;

export const APPROVALS_ARTIFACTS_SURFACE_ID = 'approvals-artifacts';
export const APPROVALS_ARTIFACTS_SURFACE_VERSION = 'p1';
export const APPROVALS_ARTIFACTS_MESSAGE_SLOT = 'approvals-artifacts';

/** The quoted approval state vocabulary: the decision lock, verbatim. */
export const APPROVAL_STATES = vocabularyOf('decisionApprovalState').values;
/** The quoted artifact kind vocabulary, verbatim. */
export const ARTIFACT_KINDS = vocabularyOf('artifactKind').values;
/** The quoted artifact retention vocabulary, verbatim. */
export const ARTIFACT_RETENTIONS = vocabularyOf('artifactRetention').values;

/** Closed empty reason: no handed-over records is none, never a fifth state. */
export const APPROVALS_ARTIFACTS_EMPTY_REASONS = Object.freeze(['none']);

/**
 * Closed action vocabulary: refresh, and the DECLARED decision requests.
 * The requests are routed through the declared action path - the surface
 * itself never flips a status or writes a decision anywhere.
 */
export const APPROVALS_ARTIFACTS_ACTIONS = Object.freeze(['refresh', 'request-approve', 'request-reject']);

/** Closed request-result vocabularies: every declared outcome is explicit. */
export const APPROVALS_ARTIFACTS_DECISION_RESULTS = Object.freeze(['accepted', 'unknown-approval', 'invalid-state', 'not-ready']);

/** Bounds: visible approval rows (default/hard) and the name ceiling. */
export const APPROVALS_ARTIFACTS_MAX_VISIBLE_DEFAULT = 30;
export const APPROVALS_ARTIFACTS_MAX_VISIBLE_HARD_MAX = 100;
export const APPROVAL_NAME_MAX_LENGTH = 120;

/** The a11y labels for the views and controls, declared once. */
export const APPROVALS_ARTIFACTS_LABELS = Object.freeze({
  approve: 'Approve selection',
  reject: 'Reject selection',
  refresh: 'Refresh review view',
  approvals: 'Approval queue',
  artifacts: 'Artifact review',
});

/** Closed approval record shape: one handed-over queue row. */
const APPROVAL_ITEM_KEYS = Object.freeze(['approvalId', 'artifactId', 'status']);

/** Closed artifact record shape: one handed-over artifact index row. */
const ARTIFACT_ITEM_KEYS = Object.freeze(['artifactId', 'kind', 'name', 'retention']);

/** Closed hand-over payload: one load, both review lists. */
const PAYLOAD_KEYS = Object.freeze(['approvals', 'artifacts']);

/**
 * Fields that would carry secret or session material in the hand-over
 * envelope. Refused with an explicit security error - fail-closed, never
 * dropped (the credentials runtime owns them; tokens and cookies never
 * reach a review surface).
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

function assertApproval(item, index, seenIds) {
  if (item === null || typeof item !== 'object' || Array.isArray(item)) {
    throw new Error(`approval ${index} must be an object`);
  }
  const keys = Object.keys(item);
  assertNoSecretFields(keys, `approval ${index}`);
  assertExactKeys(keys, APPROVAL_ITEM_KEYS, `approval ${index}`);
  if (typeof item.approvalId !== 'string' || item.approvalId.trim() === '') {
    throw new Error(`approval ${index} field approvalId must be a non-empty string`);
  }
  if (typeof item.artifactId !== 'string' || item.artifactId.trim() === '') {
    throw new Error(`approval ${index} field artifactId must be a non-empty string`);
  }
  if (!APPROVAL_STATES.includes(item.status)) {
    throw new Error(`approval ${index} field status must be one of ${APPROVAL_STATES.join(', ')} (got "${item.status}")`);
  }
  if (seenIds.has(item.approvalId)) {
    throw new Error(`approval ${index} repeats the approvalId "${item.approvalId}": approval ids are unique`);
  }
}

function assertArtifact(item, index, seenIds) {
  if (item === null || typeof item !== 'object' || Array.isArray(item)) {
    throw new Error(`artifact ${index} must be an object`);
  }
  const keys = Object.keys(item);
  assertNoSecretFields(keys, `artifact ${index}`);
  assertExactKeys(keys, ARTIFACT_ITEM_KEYS, `artifact ${index}`);
  if (typeof item.artifactId !== 'string' || item.artifactId.trim() === '') {
    throw new Error(`artifact ${index} field artifactId must be a non-empty string`);
  }
  if (typeof item.name !== 'string' || item.name.trim() === '') {
    throw new Error(`artifact ${index} field name must be a non-empty string`);
  }
  if (item.name.length > APPROVAL_NAME_MAX_LENGTH) {
    throw new Error(`artifact ${index} field name must be at most ${APPROVAL_NAME_MAX_LENGTH} characters`);
  }
  if (!ARTIFACT_KINDS.includes(item.kind)) {
    throw new Error(`artifact ${index} field kind must be one of ${ARTIFACT_KINDS.join(', ')} (got "${item.kind}")`);
  }
  if (!ARTIFACT_RETENTIONS.includes(item.retention)) {
    throw new Error(`artifact ${index} field retention must be one of ${ARTIFACT_RETENTIONS.join(', ')} (got "${item.retention}")`);
  }
  if (seenIds.has(item.artifactId)) {
    throw new Error(`artifact ${index} repeats the artifactId "${item.artifactId}": artifact ids are unique`);
  }
}

/** The declared surface contract: states keyed on REGION_STATES exactly. */
export function approvalsArtifactsSurfaceContract() {
  return Object.freeze({
    id: APPROVALS_ARTIFACTS_SURFACE_ID,
    version: APPROVALS_ARTIFACTS_SURFACE_VERSION,
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
      approvalStates: APPROVAL_STATES,
      artifactKinds: ARTIFACT_KINDS,
      artifactRetentions: ARTIFACT_RETENTIONS,
      actions: APPROVALS_ARTIFACTS_ACTIONS,
      decisionResults: APPROVALS_ARTIFACTS_DECISION_RESULTS,
      emptyReasons: APPROVALS_ARTIFACTS_EMPTY_REASONS,
    }),
    bounds: Object.freeze({
      maxVisibleDefault: APPROVALS_ARTIFACTS_MAX_VISIBLE_DEFAULT,
      maxVisibleHardMax: APPROVALS_ARTIFACTS_MAX_VISIBLE_HARD_MAX,
      nameMaxLength: APPROVAL_NAME_MAX_LENGTH,
    }),
  });
}

/**
 * The a11y intent is derived ONCE here, so the contract's declared observables
 * and the view-model's rendered attributes cannot drift. The ready state is
 * the form landmark; every other state is a status. Only error is aria-live
 * assertive; only loading is aria-busy.
 */
export const APPROVALS_ARTIFACTS_A11Y = Object.freeze(
  Object.fromEntries(
    APPROVALS_ARTIFACTS_STATES.map((state) => [
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
export function approvalsArtifactsActionsFor(region) {
  if (region === 'error') return Object.freeze(['refresh']);
  if (region === 'loading') return Object.freeze([]);
  if (region === 'empty') return Object.freeze(['refresh']);
  return Object.freeze(['refresh', 'request-approve', 'request-reject']);
}

function interactionsFor(region) {
  const actions = approvalsArtifactsActionsFor(region);
  return Object.freeze({
    refresh: actions.includes('refresh'),
    requestApprove: actions.includes('request-approve'),
    requestReject: actions.includes('request-reject'),
  });
}

/**
 * Create the Approvals/Artifacts view-model. The review state enters ONLY
 * through loadSuccess() (one hand-over); the surface performs no fetch,
 * touches no store, mutates no record and never writes a decision -
 * request-approve and request-reject are DECLARED with explicit results
 * and the approval capability performs them through the declared action
 * path; the outcome arrives via a fresh hand-over.
 */
export function createApprovalsArtifactsSurface(options = {}) {
  const locale = options.locale ?? 'en';
  const requestedMax = options.maxVisible ?? APPROVALS_ARTIFACTS_MAX_VISIBLE_DEFAULT;
  if (!Number.isInteger(requestedMax) || requestedMax <= 0) {
    throw new Error('maxVisible must be a positive integer');
  }
  const maxVisible = Math.min(requestedMax, APPROVALS_ARTIFACTS_MAX_VISIBLE_HARD_MAX);
  const renderAvailable = options.renderAvailable ?? true;

  let approvals = Object.freeze([]);
  let approvalStatuses = new Map();
  let artifacts = Object.freeze([]);
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
    // The window keeps the NEWEST approval rows (the queue tail);
    // truncation is reported, never silent. The artifact index is shown
    // in full as a bounded review list.
    const shown = approvals.slice(-maxVisible);
    return Object.freeze({
      visible: true,
      visibleCount: approvals.length,
      shown: Object.freeze(shown.map((item) => Object.freeze({
        approvalId: item.approvalId,
        artifactId: item.artifactId,
        status: item.status,
      }))),
      truncated: approvals.length > shown.length,
      total: approvals.length,
      artifacts: Object.freeze(artifacts.map((item) => Object.freeze({
        artifactId: item.artifactId,
        name: item.name,
        kind: item.kind,
        retention: item.retention,
      }))),
      artifactCount: artifacts.length,
      reason: region === 'empty' ? 'none' : null,
      focusOrder: Object.freeze(region === 'ready'
        ? Object.freeze([
          'view:approvals',
          'view:artifacts',
          ...approvals.map((item) => `approval:${item.approvalId}`),
          ...artifacts.map((item) => `artifact:${item.artifactId}`),
        ])
        : []),
      labels: APPROVALS_ARTIFACTS_LABELS,
      announcement: pendingAnnouncement,
      actions: approvalsArtifactsActionsFor(region),
      error: region === 'error' ? { kind: error?.kind ?? 'network' } : null,
    });
  }

  function a11y() {
    return APPROVALS_ARTIFACTS_A11Y[regionState()];
  }

  function decide(decision, approvalId) {
    if (typeof approvalId !== 'string' || approvalId.trim() === '') {
      throw new Error(`request${decision === 'approve' ? 'Approve' : 'Reject'} expects a non-empty approval id`);
    }
    if (region !== 'ready') return 'not-ready';
    const status = approvalStatuses.get(approvalId);
    if (status === undefined) return 'unknown-approval';
    if (status !== 'pending') return 'invalid-state';
    pushEvent(`${decision}-requested`);
    pendingAnnouncement = `${decision}:${approvalId}`;
    return 'accepted';
  }

  return Object.freeze({
    id: APPROVALS_ARTIFACTS_SURFACE_ID,
    contract: approvalsArtifactsSurfaceContract(),
    maxVisible,
    /**
     * The only data entry point (one hand-over: approvals + artifacts).
     * Secret-bearing envelopes, duplicate ids, unknown statuses/kinds and
     * malformed records are refused.
     */
    loadSuccess(payload) {
      if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new Error('loadSuccess expects a hand-over payload object {approvals, artifacts}');
      }
      const keys = Object.keys(payload);
      assertNoSecretFields(keys, 'loadSuccess payload');
      assertExactKeys(keys, PAYLOAD_KEYS, 'loadSuccess payload');
      if (!Array.isArray(payload.approvals)) {
        throw new Error('loadSuccess payload field approvals (array) is required');
      }
      if (!Array.isArray(payload.artifacts)) {
        throw new Error('loadSuccess payload field artifacts (array) is required');
      }
      const approvalSeen = new Set();
      payload.approvals.forEach((item, index) => {
        assertApproval(item, index, approvalSeen);
        approvalSeen.add(item.approvalId);
      });
      const artifactSeen = new Set();
      payload.artifacts.forEach((item, index) => {
        assertArtifact(item, index, artifactSeen);
        artifactSeen.add(item.artifactId);
      });
      approvals = Object.freeze(payload.approvals.map((item) => Object.freeze({ ...item })));
      approvalStatuses = new Map(payload.approvals.map((item) => [item.approvalId, item.status]));
      artifacts = Object.freeze(payload.artifacts.map((item) => Object.freeze({ ...item })));
      error = null;
      loaded = true;
      pendingAnnouncement = null;
      region = (approvals.length > 0 || artifacts.length > 0) ? 'ready' : 'empty';
      pushEvent('loaded');
      return approvals.length + artifacts.length;
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
     * DECLARED, never executed here: ask the approval capability to approve
     * through the declared action path. Only a pending approval is
     * actionable; the status never flips locally - the outcome arrives via
     * a fresh hand-over.
     */
    requestApprove(approvalId) {
      return decide('approve', approvalId);
    },
    /**
     * DECLARED, never executed here: ask the approval capability to reject
     * through the declared action path. Same closed rules as approve.
     */
    requestReject(approvalId) {
      return decide('reject', approvalId);
    },
    displayModel,
    a11y,
    /** Observable snapshot for the parity harness (candidate side). */
    observe() {
      const state = regionState();
      const model = displayModel();
      const events = state === 'ready' ? ['approvals-artifacts:rendered'] : [];
      if (state === 'ready' && model.announcement !== null) {
        events.push('approvals-artifacts:changed');
      }
      return observation({
        surfaceId: APPROVALS_ARTIFACTS_SURFACE_ID,
        side: 'candidate',
        visible: model.visible === true,
        regionState: state,
        loading: state === 'loading',
        empty: state === 'empty',
        error: state === 'error' ? { kind: error?.kind ?? 'network' } : null,
        interactions: interactionsFor(state),
        events: Object.freeze(events),
        accessibility: a11y(),
        localization: Object.freeze({ slot: APPROVALS_ARTIFACTS_MESSAGE_SLOT, locale }),
        contract: Object.freeze({
          id: APPROVALS_ARTIFACTS_SURFACE_ID,
          version: APPROVALS_ARTIFACTS_SURFACE_VERSION,
        }),
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
    get approvals() {
      return approvals;
    },
    get artifacts() {
      return artifacts;
    },
  });
}

/* -------------------------------------------------------- the reference model */

/**
 * The reference (pinned n8n editor) observations as deterministic fixtures.
 * The reference UI is not run here - these are the declared behaviours the
 * candidate is compared against. They mirror observe() field for field, and
 * their interactions come from the SAME approvalsArtifactsActionsFor rule
 * the view-model uses, so the two sides cannot drift by construction.
 */
function referenceObservation({ regionState: state, error = null, events = [], locale }) {
  return observation({
    surfaceId: APPROVALS_ARTIFACTS_SURFACE_ID,
    side: 'reference',
    visible: true,
    regionState: state,
    loading: state === 'loading',
    empty: state === 'empty',
    error,
    interactions: interactionsFor(state),
    events: Object.freeze(events),
    accessibility: APPROVALS_ARTIFACTS_A11Y[state],
    localization: Object.freeze({ slot: APPROVALS_ARTIFACTS_MESSAGE_SLOT, locale }),
    contract: Object.freeze({
      id: APPROVALS_ARTIFACTS_SURFACE_ID,
      version: APPROVALS_ARTIFACTS_SURFACE_VERSION,
    }),
  });
}

export function referenceLoadingObservation(locale = 'en') {
  return referenceObservation({ regionState: 'loading', locale });
}

export function referenceEmptyObservation({ reason = 'none', locale = 'en' } = {}) {
  if (!APPROVALS_ARTIFACTS_EMPTY_REASONS.includes(reason)) {
    throw new Error(`reason must be one of ${APPROVALS_ARTIFACTS_EMPTY_REASONS.join(', ')} (got "${reason}")`);
  }
  return referenceObservation({ regionState: 'empty', locale });
}

export function referenceReadyObservation(locale = 'en') {
  return referenceObservation({ regionState: 'ready', events: ['approvals-artifacts:rendered'], locale });
}

export function referenceErrorObservation({ errorKind = 'network', locale = 'en' } = {}) {
  return referenceObservation({ regionState: 'error', error: { kind: errorKind }, locale });
}
