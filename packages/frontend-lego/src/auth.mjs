/**
 * Auth surface pilot (P2-S12, issue #240) - the strangler slice for the
 * sign-in, user-management and membership surfaces. One surface, one delivery
 * scope.
 *
 * Boundary (invariants 4-5): identity state and the user/membership directory
 * are HANDED OVER (inputBoundary source hand-over) by the auth capability in
 * one loadSuccess() payload. The surface holds no private data path and no
 * second source of truth: it never fetches users, never posts credentials,
 * ISSUES NO LOGIN CALL (sign-in/sign-out/role changes are DECLARED
 * interactions returning explicit results) and never re-derives identity -
 * who is signed in is exactly what the payload carried, nothing is computed
 * locally from the directory rows.
 *
 * Security boundary (the load-bearing rule): CREDENTIALS AND SESSION
 * MATERIAL NEVER REACH THIS SURFACE. A payload, identity or row carrying a
 * secret-bearing field (password, token, sessionToken, mfaCode, ...) is
 * refused with an explicit security error, never silently dropped. Credential
 * verification stays with the auth runtime against the Credentials/identity
 * backend (finding-only here).
 *
 * Closed contracts (invariants 4 and 7): the four region states are exactly
 * the shared REGION_STATES; the facet vocabulary is signin / users /
 * membership (the three screens this slice carries); roles are pinned to the
 * reference n8n 2.9.4 system roles (global:owner|admin|member|chatUser for
 * the user directory, project:admin|editor|viewer|chatUser for membership) -
 * custom roles are refused, fail-closed; an empty directory facet is empty
 * with reason none (users) or filtered (membership), never a fifth state.
 *
 * Reference rule carried over: an owner's global role cannot be changed
 * (n8n assignableGlobalRoleSchema excludes global:owner - "Owner cannot be
 * changed"), so requestRoleChange answers owner-unchangeable, never a silent
 * no-op.
 *
 * Pilot (invariants 1 and 9): the original n8n editor stays the default path;
 * rollback is switching the pilot off with no residual state
 * (rollbackStrategy: pilot-not-primary in the surface-migrations manifest).
 */
import { observation } from './parity.mjs';
import { REGION_STATES } from './surface-contract.mjs';

export const AUTH_STATES = REGION_STATES;

export const AUTH_SURFACE_ID = 'auth';
export const AUTH_SURFACE_VERSION = 'p1';
export const AUTH_MESSAGE_SLOT = 'auth';

/**
 * Closed facet vocabulary: the three screens this surface carries - the
 * sign-in form, the user directory (user management) and project membership.
 */
export const AUTH_FACETS = Object.freeze(['signin', 'users', 'membership']);
export const AUTH_DEFAULT_FACET = 'signin';

/**
 * Closed role vocabularies, pinned to the reference n8n 2.9.4 system roles
 * (the pinned n8n 2.9.4 reference: @n8n/api-types user.schema ROLE and
 * @n8n/permissions teamRoleSchema). Custom roles exist upstream and are deliberately refused
 * here: the surface vocabulary is closed, fail-closed (recorded as evidence).
 */
export const AUTH_GLOBAL_ROLES = Object.freeze([
  'global:owner', 'global:admin', 'global:member', 'global:chatUser',
]);

/** Membership rows carry assignable project (team) roles; personalOwner is personal-only. */
export const AUTH_PROJECT_ROLES = Object.freeze([
  'project:admin', 'project:editor', 'project:viewer', 'project:chatUser',
]);

/** Reference rule: the owner's global role cannot be changed. */
export const AUTH_ASSIGNABLE_GLOBAL_ROLES = Object.freeze([
  'global:admin', 'global:member', 'global:chatUser',
]);

/** Closed action vocabulary: what the user may ask for in a state (declared). */
export const AUTH_ACTIONS = Object.freeze([
  'refresh', 'sign-in', 'sign-out', 'switch-facet', 'change-role',
]);

/** Closed request-result vocabularies: every declared request outcome is explicit. */
export const AUTH_ROLE_CHANGE_RESULTS = Object.freeze([
  'accepted', 'not-ready', 'unknown-id', 'invalid-role', 'same-role', 'owner-unchangeable',
]);
export const AUTH_SIGN_IN_RESULTS = Object.freeze(['accepted', 'already-signed-in', 'not-ready']);
export const AUTH_SIGN_OUT_RESULTS = Object.freeze(['accepted', 'not-signed-in', 'not-ready']);

/** Closed empty reasons. */
export const AUTH_EMPTY_REASONS = Object.freeze(['none', 'filtered']);

/** Default visible cap and the hard maximum a caller can request. */
export const AUTH_MAX_VISIBLE_DEFAULT = 20;
export const AUTH_MAX_VISIBLE_HARD_MAX = 50;

/** Closed entry shape: identity metadata for one directory row. */
const ENTRY_KEYS = Object.freeze(['id', 'facet', 'label', 'role']);

/** Closed identity shape: exactly who the auth capability says is signed in. */
const IDENTITY_KEYS = Object.freeze(['userId', 'role']);

/** Closed hand-over payload: one load, the identity plus the directory. */
const PAYLOAD_KEYS = Object.freeze(['identity', 'entries']);

/**
 * Fields that would carry credential or session material. A payload, identity
 * or row bearing any of them is refused with an explicit security error -
 * fail-closed, never dropped. Credential verification stays with the auth
 * runtime (P5 boundary, finding-only here).
 */
const SECRET_BEARING_KEYS = Object.freeze([
  'password', 'passwordHash', 'pass', 'secret', 'token', 'refreshToken', 'accessToken',
  'apiKey', 'apikey', 'credentials', 'privateKey', 'encrypted', 'oauthToken',
  'sessionToken', 'sessionId', 'mfaCode', 'mfa', 'ssoAssertion', 'cookie', 'key', 'hash',
]);

function assertNoSecretFields(keys, where) {
  for (const key of keys) {
    if (SECRET_BEARING_KEYS.includes(key)) {
      throw new Error(
        `${where} carries the secret-bearing field ${key}: credentials and session material never reach this surface (the auth runtime owns them)`,
      );
    }
  }
}

function assertRow(row, index) {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) {
    throw new Error(`auth entry ${index} must be an object`);
  }
  const keys = Object.keys(row);
  assertNoSecretFields(keys, `auth entry ${index}`);
  const sorted = keys.sort();
  if (sorted.join(',') !== [...ENTRY_KEYS].sort().join(',')) {
    throw new Error(`auth entry ${index} must have exactly ${ENTRY_KEYS.join(',')} (got ${sorted.join(',')})`);
  }
  for (const key of ['id', 'label']) {
    if (typeof row[key] !== 'string' || row[key].trim() === '') {
      throw new Error(`auth entry ${index} field ${key} must be a non-empty string`);
    }
  }
  if (typeof row.facet !== 'string' || !AUTH_FACETS.includes(row.facet)) {
    throw new Error(`auth entry ${index} field facet must be one of ${AUTH_FACETS.join(', ')} (got "${row.facet}")`);
  }
  if (row.facet === 'signin') {
    throw new Error('auth entry field facet must not be "signin": the sign-in screen carries no directory rows');
  }
  const roles = rolesForFacet(row.facet);
  if (typeof row.role !== 'string' || !roles.includes(row.role)) {
    throw new Error(`auth entry ${index} field role must be one of ${roles.join(', ')} (got "${row.role}")`);
  }
}

function assertIdentity(identity) {
  if (identity === null) return;
  if (typeof identity !== 'object' || Array.isArray(identity)) {
    throw new Error('identity must be null or an object');
  }
  const keys = Object.keys(identity);
  assertNoSecretFields(keys, 'identity');
  const sorted = keys.sort();
  if (sorted.join(',') !== [...IDENTITY_KEYS].sort().join(',')) {
    throw new Error(`identity must have exactly ${IDENTITY_KEYS.join(',')} (got ${sorted.join(',')})`);
  }
  if (typeof identity.userId !== 'string' || identity.userId.trim() === '') {
    throw new Error('identity field userId must be a non-empty string');
  }
  if (typeof identity.role !== 'string' || !AUTH_GLOBAL_ROLES.includes(identity.role)) {
    throw new Error(`identity field role must be one of ${AUTH_GLOBAL_ROLES.join(', ')} (got "${identity.role}")`);
  }
}

function rolesForFacet(facet) {
  return facet === 'membership' ? AUTH_PROJECT_ROLES : AUTH_GLOBAL_ROLES;
}

/** The declared surface contract: states keyed on REGION_STATES exactly. */
export function authSurfaceContract() {
  return Object.freeze({
    id: AUTH_SURFACE_ID,
    version: AUTH_SURFACE_VERSION,
    inputBoundary: Object.freeze({
      source: 'hand-over',
      entryPoint: 'loadSuccess',
      issuesLoginCall: false,
      reDerivesIdentity: false,
      carriesSecrets: false,
    }),
    states: Object.freeze(
      Object.fromEntries(REGION_STATES.map((state) => [state, Object.freeze({ state })])),
    ),
    vocabularies: Object.freeze({
      facets: AUTH_FACETS,
      globalRoles: AUTH_GLOBAL_ROLES,
      projectRoles: AUTH_PROJECT_ROLES,
      assignableGlobalRoles: AUTH_ASSIGNABLE_GLOBAL_ROLES,
      actions: AUTH_ACTIONS,
      roleChangeResults: AUTH_ROLE_CHANGE_RESULTS,
      signInResults: AUTH_SIGN_IN_RESULTS,
      signOutResults: AUTH_SIGN_OUT_RESULTS,
      emptyReasons: AUTH_EMPTY_REASONS,
    }),
    bounds: Object.freeze({
      maxVisibleDefault: AUTH_MAX_VISIBLE_DEFAULT,
      maxVisibleHardMax: AUTH_MAX_VISIBLE_HARD_MAX,
    }),
  });
}

/**
 * The a11y intent is derived ONCE here, so the contract's declared observables
 * and the view-model's rendered attributes cannot drift. The ready state is a
 * landmark region: the sign-in form or the directory inside it carries its own
 * widget roles, the region announces state changes politely. Only error is
 * aria-live assertive; only loading is aria-busy.
 */
export const AUTH_A11Y = Object.freeze(
  Object.fromEntries(
    REGION_STATES.map((state) => [
      state,
      Object.freeze({
        role: state === 'ready' ? 'region' : 'status',
        ariaLive: state === 'error' ? 'assertive' : 'polite',
        ariaBusy: state === 'loading',
      }),
    ]),
  ),
);

/**
 * The closed per-state action rule, used by BOTH the view-model and the
 * reference fixtures so the two sides cannot drift (parity is fail-closed on
 * exactly these fields). Identity-specific availability (already signed in,
 * owner rows) is answered by the request vocabularies, never by the rule.
 */
export function authActionsFor(region) {
  if (region === 'error') return Object.freeze(['refresh']);
  if (region === 'loading') return Object.freeze([]);
  if (region === 'empty') return Object.freeze(['sign-in', 'switch-facet']);
  return Object.freeze(['refresh', 'sign-in', 'sign-out', 'switch-facet', 'change-role']);
}

function interactionsFor(region) {
  const actions = authActionsFor(region);
  return Object.freeze({
    refresh: actions.includes('refresh'),
    signIn: actions.includes('sign-in'),
    signOut: actions.includes('sign-out'),
    switchFacet: actions.includes('switch-facet'),
    changeRole: actions.includes('change-role'),
  });
}

/**
 * Create the auth view-model. Identity and directory rows enter ONLY through
 * loadSuccess() (one hand-over from the auth capability); the surface performs
 * no fetch, issues no login call and never re-derives identity locally.
 */
export function createAuthSurface(options = {}) {
  const locale = options.locale ?? 'en';
  const requestedMax = options.maxVisible ?? AUTH_MAX_VISIBLE_DEFAULT;
  if (!Number.isInteger(requestedMax) || requestedMax <= 0) {
    throw new Error('maxVisible must be a positive integer');
  }
  const maxVisible = Math.min(requestedMax, AUTH_MAX_VISIBLE_HARD_MAX);
  const renderAvailable = options.renderAvailable ?? true;

  let entries = Object.freeze([]);
  let identity = null;
  let loaded = false;
  let region = 'loading';
  let facet = AUTH_DEFAULT_FACET;
  let error = null;
  let degradedEvents = 0;
  const history = [];

  function pushEvent(name) {
    history.push({ at: history.length, name });
    if (!renderAvailable) degradedEvents += 1;
  }

  function facetEntries() {
    return entries.filter((entry) => entry.facet === facet);
  }

  function regionState() {
    return region;
  }

  function displayModel() {
    const visible = facet === 'signin' ? [] : facetEntries();
    const shown = visible.slice(0, maxVisible);
    return Object.freeze({
      visible: true,
      identity,
      facet,
      visibleCount: visible.length,
      shown: Object.freeze(shown.map((entry) => Object.freeze({ ...entry }))),
      truncated: visible.length > shown.length,
      total: entries.length,
      reason: region === 'empty' ? (facet === 'users' ? 'none' : 'filtered') : null,
      actions: authActionsFor(region),
    });
  }

  function a11y() {
    return AUTH_A11Y[regionState()];
  }

  return Object.freeze({
    id: AUTH_SURFACE_ID,
    contract: authSurfaceContract(),
    maxVisible,
    /**
     * The only data entry point (one hand-over: identity + directory). The
     * surface ISSUES NO LOGIN CALL and never re-derives identity - rows never
     * imply a session. Secret-bearing payloads, identities and rows are refused.
     */
    loadSuccess(payload) {
      if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new Error('loadSuccess expects a hand-over payload object {identity, entries}');
      }
      const keys = Object.keys(payload);
      assertNoSecretFields(keys, 'loadSuccess payload');
      const sorted = keys.sort();
      if (sorted.join(',') !== [...PAYLOAD_KEYS].sort().join(',')) {
        throw new Error(`loadSuccess payload must have exactly ${PAYLOAD_KEYS.join(',')} (got ${sorted.join(',')})`);
      }
      if (!Array.isArray(payload.entries)) {
        throw new Error('loadSuccess payload field entries must be an array of auth entries');
      }
      payload.entries.forEach(assertRow);
      assertIdentity(payload.identity);
      entries = Object.freeze(payload.entries.map((entry) => Object.freeze({ ...entry })));
      identity = payload.identity === null ? null : Object.freeze({ ...payload.identity });
      facet = AUTH_DEFAULT_FACET;
      error = null;
      loaded = true;
      region = 'ready';
      pushEvent('loaded');
      if (!renderAvailable) degradedEvents += 1;
      return entries.length;
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
    /** Back to loading. Entries are retained but the region is loading. */
    setLoading() {
      region = 'loading';
      pushEvent('loading');
      return 'loading';
    },
    /**
     * The observable facet switch (signin / users / membership). Changes what
     * is VISIBLE. The sign-in facet is always ready once the hand-over landed;
     * a directory facet with no rows is empty (none on users, filtered on
     * membership). An unknown value is refused.
     */
    setFacet(next = AUTH_DEFAULT_FACET) {
      if (typeof next !== 'string' || !AUTH_FACETS.includes(next)) {
        throw new Error(`facet must be one of ${AUTH_FACETS.join(', ')} (got "${next}")`);
      }
      if (next !== facet) {
        facet = next;
        pushEvent('switched-facet');
      }
      if (region === 'ready' || region === 'empty') {
        region = facet === 'signin' ? 'ready' : (facetEntries().length > 0 ? 'ready' : 'empty');
      }
      return region;
    },
    /**
     * DECLARED, never executed: ask the app layer to sign in. Credentials are
     * never accepted here - the app layer collects and posts them to the auth
     * runtime; this surface only declares that the sign-in was requested.
     */
    requestSignIn() {
      if (region === 'loading' || region === 'error') return 'not-ready';
      if (identity !== null) return 'already-signed-in';
      pushEvent('sign-in-requested');
      return 'accepted';
    },
    /**
     * DECLARED, never executed: ask the app layer to sign out. The session end
     * stays with the auth runtime - identity here still shows what was handed
     * over until the next load.
     */
    requestSignOut() {
      if (region === 'loading' || region === 'error') return 'not-ready';
      if (identity === null) return 'not-signed-in';
      pushEvent('sign-out-requested');
      return 'accepted';
    },
    /**
     * DECLARED, never executed: ask the app layer to change a directory row's
     * role. The reference rule holds - an owner row answers owner-unchangeable,
     * never a silent no-op. The directory data never changes here.
     */
    requestRoleChange(id, nextRole) {
      if (typeof id !== 'string' || id.trim() === '') {
        throw new Error('requestRoleChange expects a non-empty auth entry id');
      }
      if (region !== 'ready') return 'not-ready';
      const row = entries.find((entry) => entry.id === id);
      if (row === undefined) return 'unknown-id';
      if (row.role === 'global:owner') return 'owner-unchangeable';
      const assignable = row.facet === 'membership' ? AUTH_PROJECT_ROLES : AUTH_ASSIGNABLE_GLOBAL_ROLES;
      if (typeof nextRole !== 'string' || !assignable.includes(nextRole)) {
        return 'invalid-role';
      }
      if (nextRole === row.role) return 'same-role';
      pushEvent('role-change-requested');
      return 'accepted';
    },
    displayModel,
    a11y,
    /** Observable snapshot for the parity harness (candidate side). */
    observe() {
      const state = regionState();
      const model = displayModel();
      return observation({
        surfaceId: AUTH_SURFACE_ID,
        side: 'candidate',
        visible: model.visible === true,
        regionState: state,
        loading: state === 'loading',
        empty: state === 'empty',
        error: state === 'error' ? { kind: error?.kind ?? 'network' } : null,
        interactions: interactionsFor(state),
        events: Object.freeze(state === 'ready' ? ['auth:rendered'] : []),
        accessibility: a11y(),
        localization: Object.freeze({ slot: AUTH_MESSAGE_SLOT, locale }),
        contract: Object.freeze({ id: AUTH_SURFACE_ID, version: AUTH_SURFACE_VERSION }),
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
 * The reference (pinned n8n editor) observations as deterministic fixtures. The
 * reference UI is not run here - these are the declared behaviours the candidate
 * is compared against. They mirror observe() field for field, and their
 * interactions come from the SAME authActionsFor rule the view-model uses,
 * so the two sides cannot drift by construction.
 */
function referenceObservation({ regionState: state, error = null, events = [], locale }) {
  return observation({
    surfaceId: AUTH_SURFACE_ID,
    side: 'reference',
    visible: true,
    regionState: state,
    loading: state === 'loading',
    empty: state === 'empty',
    error,
    interactions: interactionsFor(state),
    events: Object.freeze(events),
    accessibility: AUTH_A11Y[state],
    localization: Object.freeze({ slot: AUTH_MESSAGE_SLOT, locale }),
    contract: Object.freeze({ id: AUTH_SURFACE_ID, version: AUTH_SURFACE_VERSION }),
  });
}

export function referenceLoadingObservation(locale = 'en') {
  return referenceObservation({ regionState: 'loading', locale });
}

export function referenceEmptyObservation({ reason = 'none', locale = 'en' } = {}) {
  if (!AUTH_EMPTY_REASONS.includes(reason)) {
    throw new Error(`reason must be one of ${AUTH_EMPTY_REASONS.join(', ')} (got "${reason}")`);
  }
  return referenceObservation({ regionState: 'empty', locale });
}

export function referenceReadyObservation(locale = 'en') {
  return referenceObservation({ regionState: 'ready', events: ['auth:rendered'], locale });
}

export function referenceErrorObservation({ errorKind = 'network', locale = 'en' } = {}) {
  return referenceObservation({ regionState: 'error', error: { kind: errorKind }, locale });
}
