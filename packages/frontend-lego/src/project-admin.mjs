/**
 * Project/workspace administration surface pilot (P2-S21, issue #240) - the
 * strangler slice for the project and workspace administration panels,
 * split out of P2-S03 (Layer 4). One surface, one delivery scope: render the
 * handed-over project and membership data and ask the app layer to invite,
 * remove or rename through DECLARED interactions that go through the
 * capability that owns project state.
 *
 * Boundary (invariants 4-5): membership and project data are HANDED OVER
 * (inputBoundary source hand-over) through declared capabilities only. The
 * surface holds no project model of its own until P5-M11 exists - no fetch,
 * no mutation of a record (a rename or membership change arrives only via a
 * fresh hand-over), no second source of truth. The selected project is VIEW
 * state only: it never leaves the surface and is cleared by every fresh
 * hand-over. Project management ownership stays with the project/role
 * capability (P5-M11..M18); this surface never calls it directly.
 *
 * Security boundary (the load-bearing rule): a payload envelope carrying
 * secret or session material is refused with an explicit security error,
 * never dropped. Records are opaque closed shapes - this surface evaluates
 * nothing (no eval, no new Function), fetches nothing and never persists.
 *
 * Closed contracts (invariants 4 and 7): the four region states are exactly
 * the shared REGION_STATES; project membership roles are the declared
 * subset owner | admin | member; a workspace with no projects is empty with
 * reason none, never a fifth state.
 *
 * Pilot (invariants 1 and 9): the original n8n editor stays the default
 * path; rollback is switching the pilot off with no residual state and no
 * workflow-data migration (rollbackStrategy: pilot-not-primary in the
 * surface-migrations manifest).
 */
import { observation } from './parity.mjs';
import { REGION_STATES } from './surface-contract.mjs';

export const PROJECT_ADMIN_STATES = REGION_STATES;

export const PROJECT_ADMIN_SURFACE_ID = 'project-admin';
export const PROJECT_ADMIN_SURFACE_VERSION = 'p1';
export const PROJECT_ADMIN_MESSAGE_SLOT = 'project-admin';

/** Closed role vocabulary: who a member is inside a workspace project. */
export const PROJECT_ROLES = Object.freeze(['owner', 'admin', 'member']);

/** Closed empty reason: no projects handed over is none, never a fifth state. */
export const PROJECT_ADMIN_EMPTY_REASONS = Object.freeze(['none']);

/** Closed action vocabulary: what the user may ask for in a state (declared). */
export const PROJECT_ADMIN_ACTIONS = Object.freeze([
  'refresh', 'select-project', 'request-invite', 'request-remove-member', 'request-rename',
]);

/**
 * Closed request-result vocabularies: every declared outcome is explicit.
 * All of them answer for the DECLARED request - the capability that owns
 * project state performs the action, never this surface, and no result
 * claims a record changed.
 */
export const PROJECT_ADMIN_SELECT_RESULTS = Object.freeze(['accepted', 'unknown-project', 'not-ready']);
export const PROJECT_ADMIN_INVITE_RESULTS = Object.freeze(['accepted', 'unknown-project', 'not-ready']);
export const PROJECT_ADMIN_REMOVE_RESULTS = Object.freeze([
  'accepted', 'unknown-project', 'unknown-member', 'invalid-role', 'not-ready',
]);
export const PROJECT_ADMIN_RENAME_RESULTS = Object.freeze([
  'accepted', 'unknown-project', 'invalid-name', 'not-ready',
]);

/** Bounds: visible project list (default/hard) and the declared name length. */
export const PROJECT_ADMIN_MAX_VISIBLE_DEFAULT = 30;
export const PROJECT_ADMIN_MAX_VISIBLE_HARD_MAX = 100;
export const PROJECT_NAME_MAX_LENGTH = 64;

/** The a11y labels for the interactive controls, declared once. */
export const PROJECT_ADMIN_LABELS = Object.freeze({
  select: 'Select project',
  invite: 'Invite member',
  remove: 'Remove member',
  rename: 'Rename project',
  refresh: 'Refresh projects',
});

/** Closed project record shape: one handed-over project. */
const PROJECT_KEYS = Object.freeze(['id', 'name', 'memberCount']);

/** Closed member record shape: one handed-over workspace member. */
const MEMBER_KEYS = Object.freeze(['userId', 'displayName', 'role']);

/** Closed hand-over payload: one load, projects + members. */
const PAYLOAD_KEYS = Object.freeze(['projects', 'members']);

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

function assertExactShape(record, keys, where) {
  const recordKeys = Object.keys(record);
  assertNoSecretFields(recordKeys, where);
  const sorted = recordKeys.sort();
  if (sorted.join(',') !== [...keys].sort().join(',')) {
    throw new Error(`${where} must have exactly ${keys.join(',')} (got ${sorted.join(',')})`);
  }
}

function assertProject(project, index, seenIds) {
  if (project === null || typeof project !== 'object' || Array.isArray(project)) {
    throw new Error(`project ${index} must be an object`);
  }
  assertExactShape(project, PROJECT_KEYS, `project ${index}`);
  for (const key of ['id', 'name']) {
    if (typeof project[key] !== 'string' || project[key].trim() === '') {
      throw new Error(`project ${index} field ${key} must be a non-empty string`);
    }
  }
  if (!Number.isInteger(project.memberCount) || project.memberCount < 0) {
    throw new Error(`project ${index} field memberCount must be a non-negative integer`);
  }
  if (seenIds.has(project.id)) {
    throw new Error(`project ${index} repeats the id "${project.id}": project ids are unique`);
  }
}

function assertMember(member, index, seenIds) {
  if (member === null || typeof member !== 'object' || Array.isArray(member)) {
    throw new Error(`member ${index} must be an object`);
  }
  assertExactShape(member, MEMBER_KEYS, `member ${index}`);
  for (const key of ['userId', 'displayName']) {
    if (typeof member[key] !== 'string' || member[key].trim() === '') {
      throw new Error(`member ${index} field ${key} must be a non-empty string`);
    }
  }
  if (!PROJECT_ROLES.includes(member.role)) {
    throw new Error(`member ${index} field role must be one of ${PROJECT_ROLES.join(', ')} (got "${member.role}")`);
  }
  if (seenIds.has(member.userId)) {
    throw new Error(`member ${index} repeats the userId "${member.userId}": member ids are unique`);
  }
}

/** The declared surface contract: states keyed on REGION_STATES exactly. */
export function projectAdminSurfaceContract() {
  return Object.freeze({
    id: PROJECT_ADMIN_SURFACE_ID,
    version: PROJECT_ADMIN_SURFACE_VERSION,
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
      roles: PROJECT_ROLES,
      actions: PROJECT_ADMIN_ACTIONS,
      selectResults: PROJECT_ADMIN_SELECT_RESULTS,
      inviteResults: PROJECT_ADMIN_INVITE_RESULTS,
      removeResults: PROJECT_ADMIN_REMOVE_RESULTS,
      renameResults: PROJECT_ADMIN_RENAME_RESULTS,
      emptyReasons: PROJECT_ADMIN_EMPTY_REASONS,
    }),
    bounds: Object.freeze({
      maxVisibleDefault: PROJECT_ADMIN_MAX_VISIBLE_DEFAULT,
      maxVisibleHardMax: PROJECT_ADMIN_MAX_VISIBLE_HARD_MAX,
      nameMaxLength: PROJECT_NAME_MAX_LENGTH,
    }),
  });
}

/**
 * The a11y intent is derived ONCE here, so the contract's declared observables
 * and the view-model's rendered attributes cannot drift. The ready state is
 * the form landmark; every other state is a status. Only error is aria-live
 * assertive; only loading is aria-busy.
 */
export const PROJECT_ADMIN_A11Y = Object.freeze(
  Object.fromEntries(
    PROJECT_ADMIN_STATES.map((state) => [
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
export function projectAdminActionsFor(region) {
  if (region === 'error') return Object.freeze(['refresh']);
  if (region === 'loading') return Object.freeze([]);
  if (region === 'empty') return Object.freeze(['refresh']);
  return Object.freeze([
    'refresh', 'select-project', 'request-invite', 'request-remove-member', 'request-rename',
  ]);
}

function interactionsFor(region) {
  const actions = projectAdminActionsFor(region);
  return Object.freeze({
    refresh: actions.includes('refresh'),
    selectProject: actions.includes('select-project'),
    requestInvite: actions.includes('request-invite'),
    requestRemoveMember: actions.includes('request-remove-member'),
    requestRename: actions.includes('request-rename'),
  });
}

/**
 * Create the project administration view-model. Project and membership
 * records enter ONLY through loadSuccess() (one hand-over); the surface
 * performs no fetch, mutates no record and never calls the project/role
 * capability itself - select-project is VIEW state (cleared by every fresh
 * hand-over), the request-* interactions are DECLARED with explicit results.
 */
export function createProjectAdminSurface(options = {}) {
  const locale = options.locale ?? 'en';
  const requestedMax = options.maxVisible ?? PROJECT_ADMIN_MAX_VISIBLE_DEFAULT;
  if (!Number.isInteger(requestedMax) || requestedMax <= 0) {
    throw new Error('maxVisible must be a positive integer');
  }
  const maxVisible = Math.min(requestedMax, PROJECT_ADMIN_MAX_VISIBLE_HARD_MAX);
  const renderAvailable = options.renderAvailable ?? true;

  let projects = Object.freeze([]);
  let members = Object.freeze([]);
  let projectIds = new Set();
  let memberIds = new Set();
  let selection = null;
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

  function findProject(id) {
    return projects.find((project) => project.id === id);
  }

  function displayModel() {
    const shown = projects.slice(0, maxVisible);
    const hasSelection = selection !== null && projectIds.has(selection);
    return Object.freeze({
      visible: true,
      visibleCount: projects.length,
      shown: Object.freeze(shown.map((project) => Object.freeze({
        id: project.id,
        name: project.name,
        memberCount: project.memberCount,
        selected: project.id === selection,
      }))),
      members: hasSelection ? members : Object.freeze([]),
      truncated: projects.length > shown.length,
      total: projects.length,
      reason: region === 'empty' ? 'none' : null,
      selection: selection,
      focusOrder: Object.freeze(region === 'ready'
        ? [
          ...projects.map((project) => `project:${project.id}`),
          ...(hasSelection
            ? [
              ...members.map((member) => `member:${member.userId}`),
              'invite', 'rename',
            ]
            : []),
        ]
        : []),
      labels: PROJECT_ADMIN_LABELS,
      announcement: pendingAnnouncement,
      actions: projectAdminActionsFor(region),
      error: region === 'error' ? { kind: error?.kind ?? 'network' } : null,
    });
  }

  function a11y() {
    return PROJECT_ADMIN_A11Y[regionState()];
  }

  return Object.freeze({
    id: PROJECT_ADMIN_SURFACE_ID,
    contract: projectAdminSurfaceContract(),
    maxVisible,
    /**
     * The only data entry point (one hand-over: projects + members).
     * Secret-bearing envelopes, duplicate ids, unknown roles and malformed
     * records are refused; the selection resets to null on every fresh
     * hand-over.
     */
    loadSuccess(payload) {
      if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new Error('loadSuccess expects a hand-over payload object {projects, members}');
      }
      const keys = Object.keys(payload);
      assertNoSecretFields(keys, 'loadSuccess payload');
      const sorted = keys.sort();
      if (sorted.join(',') !== [...PAYLOAD_KEYS].sort().join(',')) {
        throw new Error(`loadSuccess payload must have exactly ${PAYLOAD_KEYS.join(',')} (got ${sorted.join(',')})`);
      }
      if (!Array.isArray(payload.projects)) {
        throw new Error('loadSuccess payload field projects (array) is required');
      }
      if (!Array.isArray(payload.members)) {
        throw new Error('loadSuccess payload field members (array) is required');
      }
      const seenProjects = new Set();
      payload.projects.forEach((project, index) => {
        assertProject(project, index, seenProjects);
        seenProjects.add(project.id);
      });
      const seenMembers = new Set();
      payload.members.forEach((member, index) => {
        assertMember(member, index, seenMembers);
        seenMembers.add(member.userId);
      });
      projects = Object.freeze(payload.projects.map((project) => Object.freeze({ ...project })));
      members = Object.freeze(payload.members.map((member) => Object.freeze({ ...member })));
      projectIds = seenProjects;
      memberIds = seenMembers;
      selection = null;
      error = null;
      loaded = true;
      pendingAnnouncement = null;
      region = projects.length > 0 ? 'ready' : 'empty';
      pushEvent('loaded');
      return projects.length;
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
     * VIEW state only: select (or re-select to clear) one project. The
     * records never change and the selection never leaves the surface.
     */
    selectProject(projectId) {
      if (typeof projectId !== 'string' || projectId.trim() === '') {
        throw new Error('selectProject expects a non-empty project id');
      }
      if (region !== 'ready') return 'not-ready';
      if (!projectIds.has(projectId)) return 'unknown-project';
      selection = selection === projectId ? null : projectId;
      pushEvent('project-selected');
      pendingAnnouncement = projectId;
      return 'accepted';
    },
    /**
     * DECLARED, never executed here: ask the app layer (the capability that
     * owns project state) to invite a workspace member into the selected
     * project. Records never change locally.
     */
    requestInvite(userId, role) {
      if (typeof userId !== 'string' || userId.trim() === '') {
        throw new Error('requestInvite expects a non-empty userId');
      }
      if (!PROJECT_ROLES.includes(role)) {
        throw new Error(`requestInvite expects a role one of ${PROJECT_ROLES.join(', ')}`);
      }
      if (region !== 'ready') return 'not-ready';
      if (selection === null || !projectIds.has(selection)) return 'unknown-project';
      pushEvent('invite-requested');
      pendingAnnouncement = selection;
      return 'accepted';
    },
    /**
     * DECLARED, never executed here: ask the app layer to remove one member.
     * The owner can never be removed (closed result invalid-role); unknown
     * members are refused explicitly.
     */
    requestRemoveMember(userId) {
      if (typeof userId !== 'string' || userId.trim() === '') {
        throw new Error('requestRemoveMember expects a non-empty userId');
      }
      if (region !== 'ready') return 'not-ready';
      if (selection === null || !projectIds.has(selection)) return 'unknown-project';
      if (!memberIds.has(userId)) return 'unknown-member';
      const member = members.find((entry) => entry.userId === userId);
      if (member.role === 'owner') return 'invalid-role';
      pushEvent('remove-requested');
      pendingAnnouncement = userId;
      return 'accepted';
    },
    /**
     * DECLARED, never executed here: ask the app layer to rename the
     * selected project. The name rule is closed: non-empty, <= 64 chars.
     */
    requestRename(name) {
      if (typeof name !== 'string') {
        throw new Error('requestRename expects a name string');
      }
      if (region !== 'ready') return 'not-ready';
      if (selection === null || !projectIds.has(selection)) return 'unknown-project';
      if (name.trim() === '' || name.length > PROJECT_NAME_MAX_LENGTH) return 'invalid-name';
      pushEvent('rename-requested');
      pendingAnnouncement = selection;
      return 'accepted';
    },
    displayModel,
    a11y,
    /** Observable snapshot for the parity harness (candidate side). */
    observe() {
      const state = regionState();
      const model = displayModel();
      const events = state === 'ready' ? ['project-admin:rendered'] : [];
      if (state === 'ready' && model.announcement !== null) {
        events.push('project-admin:changed');
      }
      return observation({
        surfaceId: PROJECT_ADMIN_SURFACE_ID,
        side: 'candidate',
        visible: model.visible === true,
        regionState: state,
        loading: state === 'loading',
        empty: state === 'empty',
        error: state === 'error' ? { kind: error?.kind ?? 'network' } : null,
        interactions: interactionsFor(state),
        events: Object.freeze(events),
        accessibility: a11y(),
        localization: Object.freeze({ slot: PROJECT_ADMIN_MESSAGE_SLOT, locale }),
        contract: Object.freeze({ id: PROJECT_ADMIN_SURFACE_ID, version: PROJECT_ADMIN_SURFACE_VERSION }),
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
    get members() {
      return members;
    },
    get projects() {
      return projects;
    },
  });
}

/* -------------------------------------------------------- the reference model */

/**
 * The reference (pinned n8n editor) observations as deterministic fixtures.
 * The reference UI is not run here - these are the declared behaviours the
 * candidate is compared against. They mirror observe() field for field, and
 * their interactions come from the SAME projectAdminActionsFor rule the
 * view-model uses, so the two sides cannot drift by construction.
 */
function referenceObservation({ regionState: state, error = null, events = [], locale }) {
  return observation({
    surfaceId: PROJECT_ADMIN_SURFACE_ID,
    side: 'reference',
    visible: true,
    regionState: state,
    loading: state === 'loading',
    empty: state === 'empty',
    error,
    interactions: interactionsFor(state),
    events: Object.freeze(events),
    accessibility: PROJECT_ADMIN_A11Y[state],
    localization: Object.freeze({ slot: PROJECT_ADMIN_MESSAGE_SLOT, locale }),
    contract: Object.freeze({ id: PROJECT_ADMIN_SURFACE_ID, version: PROJECT_ADMIN_SURFACE_VERSION }),
  });
}

export function referenceLoadingObservation(locale = 'en') {
  return referenceObservation({ regionState: 'loading', locale });
}

export function referenceEmptyObservation({ reason = 'none', locale = 'en' } = {}) {
  if (!PROJECT_ADMIN_EMPTY_REASONS.includes(reason)) {
    throw new Error(`reason must be one of ${PROJECT_ADMIN_EMPTY_REASONS.join(', ')} (got "${reason}")`);
  }
  return referenceObservation({ regionState: 'empty', locale });
}

export function referenceReadyObservation(locale = 'en') {
  return referenceObservation({ regionState: 'ready', events: ['project-admin:rendered'], locale });
}

export function referenceErrorObservation({ errorKind = 'network', locale = 'en' } = {}) {
  return referenceObservation({ regionState: 'error', error: { kind: errorKind }, locale });
}
