/**
 * Skills/Capabilities views surfaces pilot (P2-S27, issue #240) - the
 * strangler slice for the skills and capability catalog surfaces, split out
 * of P2-S03 (Layer 5). One surface, one delivery scope: render the
 * handed-over catalog read-only and ask the app layer to open a skill
 * through a DECLARED request. THE SURFACE GRANTS NOTHING: it never enables,
 * installs, loads or elevates a capability - capability records arrive from
 * the capability registry via hand-over and the registry owns every grant.
 *
 * Boundary (invariants 4-5): the catalog is HANDED OVER (inputBoundary
 * source hand-over) through declared capabilities only. The surface holds no
 * private data path and no second source of truth: no fetch, no mutation of
 * a record, no direct registry access. request-open-skill is DECLARED with
 * explicit results; the capability that owns navigation performs it.
 *
 * Security boundary (the load-bearing rule): a payload envelope carrying
 * secret or session material is refused with an explicit security error,
 * never dropped. Records are opaque closed shapes - this surface evaluates
 * nothing (no eval, no new Function), fetches nothing and never persists.
 * The vocabularies are QUOTED, never redefined: skill status comes from
 * SKILL_STATUSES (skills.mjs, the AI set's own vocabulary) and capability
 * state from CAPABILITY_STATES (lifecycle.mjs) - no second architecture.
 *
 * Closed contracts (invariants 4 and 7): the four region states are exactly
 * the shared REGION_STATES; a catalog with no skills is empty with reason
 * none, never a fifth state.
 *
 * Pilot (invariants 1 and 9): the original n8n editor stays the default
 * path; rollback is switching the pilot off with no residual state and no
 * workflow-data migration (rollbackStrategy: pilot-not-primary in the
 * surface-migrations manifest).
 */
import { observation } from './parity.mjs';
import { REGION_STATES } from './surface-contract.mjs';
import { SKILL_STATUSES } from './skills.mjs';
import { CAPABILITY_STATES } from './lifecycle.mjs';

/**
 * The quoted vocabularies are re-exported verbatim (not redefined): the
 * surface owns neither of them - skills.mjs and lifecycle.mjs do.
 */
export { SKILL_STATUSES, CAPABILITY_STATES };

export const SKILLS_CAPABILITIES_STATES = REGION_STATES;

export const SKILLS_CAPABILITIES_SURFACE_ID = 'skills-capabilities';
export const SKILLS_CAPABILITIES_SURFACE_VERSION = 'p1';
export const SKILLS_CAPABILITIES_MESSAGE_SLOT = 'skills-capabilities';

/** Closed empty reason: no skills handed over is none, never a fifth state. */
export const SKILLS_CAPABILITIES_EMPTY_REASONS = Object.freeze(['none']);

/** Closed action vocabulary: what the user may ask for in a state (declared). */
export const SKILLS_CAPABILITIES_ACTIONS = Object.freeze(['refresh', 'request-open-skill']);

/**
 * Closed request-result vocabularies: every declared outcome is explicit.
 * All of them answer for the DECLARED request - the capability that owns the
 * skill navigation performs the action, never this surface, and no result
 * claims a grant moved (the surface grants nothing; the registry owns it).
 */
export const SKILLS_CAPABILITIES_OPEN_RESULTS = Object.freeze(['accepted', 'unknown-skill', 'not-ready']);

/** Bounds: visible skill entries (default/hard) and the name ceiling. */
export const SKILLS_CAPABILITIES_MAX_VISIBLE_DEFAULT = 30;
export const SKILLS_CAPABILITIES_MAX_VISIBLE_HARD_MAX = 100;
export const SKILL_NAME_MAX_LENGTH = 120;

/** The a11y labels for the views and controls, declared once. */
export const SKILLS_CAPABILITIES_LABELS = Object.freeze({
  open: 'Open skill',
  refresh: 'Refresh catalog',
  skills: 'Skills view',
  capabilities: 'Capabilities view',
});

/** Closed skill record shape: one handed-over catalog entry. */
const SKILL_ITEM_KEYS = Object.freeze(['id', 'name', 'status']);

/** Closed capability record shape: one handed-over registry snapshot row. */
const CAPABILITY_ITEM_KEYS = Object.freeze(['id', 'state']);

/** Closed hand-over payload: one load, both catalog lists. */
const PAYLOAD_KEYS = Object.freeze(['capabilities', 'skills']);

/**
 * Fields that would carry secret or session material in the hand-over
 * envelope. Refused with an explicit security error - fail-closed, never
 * dropped (the credentials runtime owns them; registry tokens never reach
 * an inspection surface).
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

function assertSkill(item, index, seenIds) {
  if (item === null || typeof item !== 'object' || Array.isArray(item)) {
    throw new Error(`skill ${index} must be an object`);
  }
  const keys = Object.keys(item);
  assertNoSecretFields(keys, `skill ${index}`);
  assertExactKeys(keys, SKILL_ITEM_KEYS, `skill ${index}`);
  if (typeof item.id !== 'string' || item.id.trim() === '') {
    throw new Error(`skill ${index} field id must be a non-empty string`);
  }
  if (typeof item.name !== 'string' || item.name.trim() === '') {
    throw new Error(`skill ${index} field name must be a non-empty string`);
  }
  if (item.name.length > SKILL_NAME_MAX_LENGTH) {
    throw new Error(`skill ${index} field name must be at most ${SKILL_NAME_MAX_LENGTH} characters`);
  }
  if (!SKILL_STATUSES.includes(item.status)) {
    throw new Error(`skill ${index} field status must be one of ${SKILL_STATUSES.join(', ')} (got "${item.status}")`);
  }
  if (seenIds.has(item.id)) {
    throw new Error(`skill ${index} repeats the id "${item.id}": skill ids are unique`);
  }
}

function assertCapability(item, index, seenIds) {
  if (item === null || typeof item !== 'object' || Array.isArray(item)) {
    throw new Error(`capability ${index} must be an object`);
  }
  const keys = Object.keys(item);
  assertNoSecretFields(keys, `capability ${index}`);
  assertExactKeys(keys, CAPABILITY_ITEM_KEYS, `capability ${index}`);
  if (typeof item.id !== 'string' || item.id.trim() === '') {
    throw new Error(`capability ${index} field id must be a non-empty string`);
  }
  if (!CAPABILITY_STATES.includes(item.state)) {
    throw new Error(`capability ${index} field state must be one of ${CAPABILITY_STATES.join(', ')} (got "${item.state}")`);
  }
  if (seenIds.has(item.id)) {
    throw new Error(`capability ${index} repeats the id "${item.id}": capability ids are unique`);
  }
}

/** The declared surface contract: states keyed on REGION_STATES exactly. */
export function skillsCapabilitiesSurfaceContract() {
  return Object.freeze({
    id: SKILLS_CAPABILITIES_SURFACE_ID,
    version: SKILLS_CAPABILITIES_SURFACE_VERSION,
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
      skillStatuses: SKILL_STATUSES,
      capabilityStates: CAPABILITY_STATES,
      actions: SKILLS_CAPABILITIES_ACTIONS,
      openResults: SKILLS_CAPABILITIES_OPEN_RESULTS,
      emptyReasons: SKILLS_CAPABILITIES_EMPTY_REASONS,
    }),
    bounds: Object.freeze({
      maxVisibleDefault: SKILLS_CAPABILITIES_MAX_VISIBLE_DEFAULT,
      maxVisibleHardMax: SKILLS_CAPABILITIES_MAX_VISIBLE_HARD_MAX,
      nameMaxLength: SKILL_NAME_MAX_LENGTH,
    }),
  });
}

/**
 * The a11y intent is derived ONCE here, so the contract's declared observables
 * and the view-model's rendered attributes cannot drift. The ready state is
 * the form landmark; every other state is a status. Only error is aria-live
 * assertive; only loading is aria-busy.
 */
export const SKILLS_CAPABILITIES_A11Y = Object.freeze(
  Object.fromEntries(
    SKILLS_CAPABILITIES_STATES.map((state) => [
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
export function skillsCapabilitiesActionsFor(region) {
  if (region === 'error') return Object.freeze(['refresh']);
  if (region === 'loading') return Object.freeze([]);
  if (region === 'empty') return Object.freeze(['refresh']);
  return Object.freeze(['refresh', 'request-open-skill']);
}

function interactionsFor(region) {
  const actions = skillsCapabilitiesActionsFor(region);
  return Object.freeze({
    refresh: actions.includes('refresh'),
    requestOpenSkill: actions.includes('request-open-skill'),
  });
}

/**
 * Create the Skills/Capabilities view-model. The catalog enters ONLY through
 * loadSuccess() (one hand-over); the surface performs no fetch, touches no
 * registry, mutates no record and never navigates - request-open-skill is
 * DECLARED with explicit results, and the owning capability performs it.
 */
export function createSkillsCapabilitiesSurface(options = {}) {
  const locale = options.locale ?? 'en';
  const requestedMax = options.maxVisible ?? SKILLS_CAPABILITIES_MAX_VISIBLE_DEFAULT;
  if (!Number.isInteger(requestedMax) || requestedMax <= 0) {
    throw new Error('maxVisible must be a positive integer');
  }
  const maxVisible = Math.min(requestedMax, SKILLS_CAPABILITIES_MAX_VISIBLE_HARD_MAX);
  const renderAvailable = options.renderAvailable ?? true;

  let skills = Object.freeze([]);
  let skillIds = new Set();
  let capabilities = Object.freeze([]);
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
    // The window keeps the NEWEST skills (the slice tail); truncation is
    // reported, never silent.
    const shown = skills.slice(-maxVisible);
    return Object.freeze({
      visible: true,
      visibleCount: skills.length,
      shown: Object.freeze(shown.map((item) => Object.freeze({
        id: item.id,
        name: item.name,
        status: item.status,
      }))),
      truncated: skills.length > shown.length,
      total: skills.length,
      capabilities: Object.freeze(capabilities.map((item) => Object.freeze({
        id: item.id,
        state: item.state,
      }))),
      capabilityCount: capabilities.length,
      reason: region === 'empty' ? 'none' : null,
      focusOrder: Object.freeze(region === 'ready'
        ? Object.freeze([
          'view:skills',
          'view:capabilities',
          ...skills.map((item) => `skill:${item.id}`),
        ])
        : []),
      labels: SKILLS_CAPABILITIES_LABELS,
      announcement: pendingAnnouncement,
      actions: skillsCapabilitiesActionsFor(region),
      error: region === 'error' ? { kind: error?.kind ?? 'network' } : null,
    });
  }

  function a11y() {
    return SKILLS_CAPABILITIES_A11Y[regionState()];
  }

  return Object.freeze({
    id: SKILLS_CAPABILITIES_SURFACE_ID,
    contract: skillsCapabilitiesSurfaceContract(),
    maxVisible,
    /**
     * The only data entry point (one hand-over: skills + capabilities).
     * Secret-bearing envelopes, duplicate ids, unknown statuses/states and
     * malformed records are refused.
     */
    loadSuccess(payload) {
      if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new Error('loadSuccess expects a hand-over payload object {skills, capabilities}');
      }
      const keys = Object.keys(payload);
      assertNoSecretFields(keys, 'loadSuccess payload');
      assertExactKeys(keys, PAYLOAD_KEYS, 'loadSuccess payload');
      if (!Array.isArray(payload.skills)) {
        throw new Error('loadSuccess payload field skills (array) is required');
      }
      if (!Array.isArray(payload.capabilities)) {
        throw new Error('loadSuccess payload field capabilities (array) is required');
      }
      const skillSeen = new Set();
      payload.skills.forEach((item, index) => {
        assertSkill(item, index, skillSeen);
        skillSeen.add(item.id);
      });
      const capSeen = new Set();
      payload.capabilities.forEach((item, index) => {
        assertCapability(item, index, capSeen);
        capSeen.add(item.id);
      });
      skills = Object.freeze(payload.skills.map((item) => Object.freeze({ ...item })));
      skillIds = skillSeen;
      capabilities = Object.freeze(payload.capabilities.map((item) => Object.freeze({ ...item })));
      error = null;
      loaded = true;
      pendingAnnouncement = null;
      region = skills.length > 0 ? 'ready' : 'empty';
      pushEvent('loaded');
      return skills.length;
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
     * DECLARED, never executed here: ask the app layer (the capability that
     * owns navigation) to open a skill. The route never moves locally, and
     * this request grants nothing - the registry owns every grant.
     */
    requestOpenSkill(skillId) {
      if (typeof skillId !== 'string' || skillId.trim() === '') {
        throw new Error('requestOpenSkill expects a non-empty skill id');
      }
      if (region !== 'ready') return 'not-ready';
      if (!skillIds.has(skillId)) return 'unknown-skill';
      pushEvent('open-requested');
      pendingAnnouncement = skillId;
      return 'accepted';
    },
    displayModel,
    a11y,
    /** Observable snapshot for the parity harness (candidate side). */
    observe() {
      const state = regionState();
      const model = displayModel();
      const events = state === 'ready' ? ['skills-capabilities:rendered'] : [];
      if (state === 'ready' && model.announcement !== null) {
        events.push('skills-capabilities:changed');
      }
      return observation({
        surfaceId: SKILLS_CAPABILITIES_SURFACE_ID,
        side: 'candidate',
        visible: model.visible === true,
        regionState: state,
        loading: state === 'loading',
        empty: state === 'empty',
        error: state === 'error' ? { kind: error?.kind ?? 'network' } : null,
        interactions: interactionsFor(state),
        events: Object.freeze(events),
        accessibility: a11y(),
        localization: Object.freeze({ slot: SKILLS_CAPABILITIES_MESSAGE_SLOT, locale }),
        contract: Object.freeze({
          id: SKILLS_CAPABILITIES_SURFACE_ID,
          version: SKILLS_CAPABILITIES_SURFACE_VERSION,
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
    get skills() {
      return skills;
    },
    get capabilities() {
      return capabilities;
    },
  });
}

/* -------------------------------------------------------- the reference model */

/**
 * The reference (pinned n8n editor) observations as deterministic fixtures.
 * The reference UI is not run here - these are the declared behaviours the
 * candidate is compared against. They mirror observe() field for field, and
 * their interactions come from the SAME skillsCapabilitiesActionsFor rule the
 * view-model uses, so the two sides cannot drift by construction.
 */
function referenceObservation({ regionState: state, error = null, events = [], locale }) {
  return observation({
    surfaceId: SKILLS_CAPABILITIES_SURFACE_ID,
    side: 'reference',
    visible: true,
    regionState: state,
    loading: state === 'loading',
    empty: state === 'empty',
    error,
    interactions: interactionsFor(state),
    events: Object.freeze(events),
    accessibility: SKILLS_CAPABILITIES_A11Y[state],
    localization: Object.freeze({ slot: SKILLS_CAPABILITIES_MESSAGE_SLOT, locale }),
    contract: Object.freeze({
      id: SKILLS_CAPABILITIES_SURFACE_ID,
      version: SKILLS_CAPABILITIES_SURFACE_VERSION,
    }),
  });
}

export function referenceLoadingObservation(locale = 'en') {
  return referenceObservation({ regionState: 'loading', locale });
}

export function referenceEmptyObservation({ reason = 'none', locale = 'en' } = {}) {
  if (!SKILLS_CAPABILITIES_EMPTY_REASONS.includes(reason)) {
    throw new Error(`reason must be one of ${SKILLS_CAPABILITIES_EMPTY_REASONS.join(', ')} (got "${reason}")`);
  }
  return referenceObservation({ regionState: 'empty', locale });
}

export function referenceReadyObservation(locale = 'en') {
  return referenceObservation({ regionState: 'ready', events: ['skills-capabilities:rendered'], locale });
}

export function referenceErrorObservation({ errorKind = 'network', locale = 'en' } = {}) {
  return referenceObservation({ regionState: 'error', error: { kind: errorKind }, locale });
}
