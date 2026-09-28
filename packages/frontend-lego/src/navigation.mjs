/**
 * Navigation surface pilot (P2-S13, issue #240) - the strangler slice for the
 * primary navigation, breadcrumbs and route-switching shell (split out of
 * P2-S03). One surface, one delivery scope.
 *
 * Boundary (invariants 4-5): the route table and the active route are HANDED
 * OVER (inputBoundary source hand-over) through declared capabilities only.
 * The surface holds no private data path and no second source of truth: it
 * never fetches a route table, never reads window.location, ISSUES NO ROUTE
 * CHANGE (opening a route is a DECLARED interaction returning explicit
 * results - the router belongs to the app layer) and never re-derives the
 * active route locally from its own state.
 *
 * Security boundary: ROUTING AUTHORITY NEVER REACHES THIS SURFACE. The
 * surface declares and renders; the app layer's router owns history. A route
 * path carrying secret query material (token=, password=, ...) is refused
 * with an explicit security error, never silently dropped or sanitized.
 *
 * Closed contracts (invariants 4 and 7): the four region states are exactly
 * the shared REGION_STATES; the region vocabulary is sidebar / topbar /
 * breadcrumbs (the three regions this slice renders); the route kind
 * vocabulary is root / section / page (the structural shapes a reference
 * sidebar carries); an empty or filtered-to-zero table is empty with reason
 * none or filtered, never a fifth state.
 *
 * Pilot (invariants 1 and 9): the original n8n editor stays the default path;
 * rollback is switching the pilot off with no residual state
 * (rollbackStrategy: pilot-not-primary in the surface-migrations manifest).
 */
import { observation } from './parity.mjs';
import { REGION_STATES } from './surface-contract.mjs';

export const NAV_STATES = REGION_STATES;

export const NAV_SURFACE_ID = 'navigation';
export const NAV_SURFACE_VERSION = 'p1';
export const NAV_MESSAGE_SLOT = 'navigation';

/** Closed region vocabulary: the three regions this surface renders. */
export const NAV_REGIONS = Object.freeze(['sidebar', 'topbar', 'breadcrumbs']);

/**
 * Closed route-kind vocabulary: the structural shapes a reference sidebar
 * carries - the root entry, a section container and a page leaf.
 */
export const NAV_ROUTE_KINDS = Object.freeze(['root', 'section', 'page']);

/** Closed empty reasons: an empty table is none; a filter to zero is filtered. */
export const NAV_EMPTY_REASONS = Object.freeze(['none', 'filtered']);

/** Closed action vocabulary: what the user may ask for in a state (declared). */
export const NAV_ACTIONS = Object.freeze([
  'refresh', 'open-route', 'toggle-sidebar', 'go-back',
]);

/**
 * Closed request-result vocabularies: every declared route request outcome is
 * explicit. accepted means the REQUEST was accepted - the surface never
 * routes; the app layer's router executes and re-hands over the new active
 * route (loadSuccess), which is also what clears the pending announcement.
 */
export const NAV_ROUTE_RESULTS = Object.freeze([
  'accepted', 'unknown-route', 'same-route', 'not-ready',
]);
export const NAV_BACK_RESULTS = Object.freeze(['accepted', 'not-ready']);

/** Default visible cap and the hard maximum a caller can request. */
export const NAV_MAX_VISIBLE_DEFAULT = 10;
export const NAV_MAX_VISIBLE_HARD_MAX = 50;

/** The a11y labels for the interactive controls, declared once. */
export const NAV_LABELS = Object.freeze({
  sidebarToggle: 'Toggle navigation sidebar',
  route: 'Open route',
  breadcrumb: 'Open breadcrumb route',
  back: 'Go back',
  filter: 'Filter routes',
});

/** Closed entry shape: one handed-over route-table row. */
const ENTRY_KEYS = Object.freeze(['id', 'path', 'label', 'kind', 'parent']);

/** Closed hand-over payload: one load, the route table plus the active route. */
const PAYLOAD_KEYS = Object.freeze(['routes', 'active']);

/**
 * Fields that would carry secret material in a key name. A payload or route
 * bearing any of them is refused with an explicit security error - fail-
 * closed, never dropped (the router and the session runtime own them).
 */
const SECRET_BEARING_KEYS = Object.freeze([
  'password', 'passwordHash', 'secret', 'token', 'refreshToken', 'accessToken',
  'apiKey', 'apikey', 'credentials', 'privateKey', 'encrypted', 'oauthToken',
  'sessionToken', 'sessionId', 'cookie', 'key', 'hash', 'authorization',
]);

/** Secret query markers inside a path value - refused, never sanitized. */
const SECRET_PATH_MARKERS = Object.freeze([
  'token=', 'secret=', 'password=', 'apikey=', 'api_key=', 'session=', 'cookie=',
]);

function assertNoSecretFields(keys, where) {
  for (const key of keys) {
    if (SECRET_BEARING_KEYS.includes(key)) {
      throw new Error(
        `${where} carries the secret-bearing field ${key}: routing and session material never reach this surface (the app-layer router owns them)`,
      );
    }
  }
}

function assertRoute(route, index, ids) {
  if (route === null || typeof route !== 'object' || Array.isArray(route)) {
    throw new Error(`route ${index} must be an object`);
  }
  const keys = Object.keys(route);
  assertNoSecretFields(keys, `route ${index}`);
  const sorted = keys.sort();
  if (sorted.join(',') !== [...ENTRY_KEYS].sort().join(',')) {
    throw new Error(`route ${index} must have exactly ${ENTRY_KEYS.join(',')} (got ${sorted.join(',')})`);
  }
  for (const key of ['id', 'path', 'label']) {
    if (typeof route[key] !== 'string' || route[key].trim() === '') {
      throw new Error(`route ${index} field ${key} must be a non-empty string`);
    }
  }
  if (!route.path.startsWith('/')) {
    throw new Error(`route ${index} field path must start with "/" (got "${route.path}")`);
  }
  for (const marker of SECRET_PATH_MARKERS) {
    if (route.path.includes(marker)) {
      throw new Error(
        `route ${index} path carries secret query material (${marker}): routing paths are refused, never sanitized (the app-layer router owns them)`,
      );
    }
  }
  if (typeof route.kind !== 'string' || !NAV_ROUTE_KINDS.includes(route.kind)) {
    throw new Error(`route ${index} field kind must be one of ${NAV_ROUTE_KINDS.join(', ')} (got "${route.kind}")`);
  }
  if (route.parent !== null && typeof route.parent !== 'string') {
    throw new Error(`route ${index} field parent must be null or a route id`);
  }
  if (route.parent !== null && !ids.has(route.parent)) {
    throw new Error(`route ${index} field parent references the unknown route "${route.parent}"`);
  }
}

/** The declared surface contract: states keyed on REGION_STATES exactly. */
export function navigationSurfaceContract() {
  return Object.freeze({
    id: NAV_SURFACE_ID,
    version: NAV_SURFACE_VERSION,
    inputBoundary: Object.freeze({
      source: 'hand-over',
      entryPoint: 'loadSuccess',
      issuesRouteChange: false,
      ownsRoutingAuthority: false,
      carriesSecrets: false,
    }),
    states: Object.freeze(
      Object.fromEntries(REGION_STATES.map((state) => [state, Object.freeze({ state })])),
    ),
    vocabularies: Object.freeze({
      regions: NAV_REGIONS,
      routeKinds: NAV_ROUTE_KINDS,
      actions: NAV_ACTIONS,
      routeResults: NAV_ROUTE_RESULTS,
      backResults: NAV_BACK_RESULTS,
      emptyReasons: NAV_EMPTY_REASONS,
    }),
    bounds: Object.freeze({
      maxVisibleDefault: NAV_MAX_VISIBLE_DEFAULT,
      maxVisibleHardMax: NAV_MAX_VISIBLE_HARD_MAX,
    }),
  });
}

/**
 * The a11y intent is derived ONCE here, so the contract's declared observables
 * and the view-model's rendered attributes cannot drift. The ready state is
 * the navigation landmark; every other state is a status. Only error is
 * aria-live assertive; only loading is aria-busy.
 */
export const NAV_A11Y = Object.freeze(
  Object.fromEntries(
    NAV_STATES.map((state) => [
      state,
      Object.freeze({
        role: state === 'ready' ? 'navigation' : 'status',
        ariaLive: state === 'error' ? 'assertive' : 'polite',
        ariaBusy: state === 'loading',
      }),
    ]),
  ),
);

/**
 * The closed per-state action rule, used by BOTH the view-model and the
 * reference fixtures so the two sides cannot drift (parity is fail-closed on
 * exactly these fields). Sidebar state and announcements are answered by the
 * request vocabularies, never by the rule.
 */
export function navActionsFor(region) {
  if (region === 'error') return Object.freeze(['refresh']);
  if (region === 'loading') return Object.freeze([]);
  if (region === 'empty') return Object.freeze(['refresh', 'toggle-sidebar']);
  return Object.freeze(['refresh', 'open-route', 'toggle-sidebar', 'go-back']);
}

function interactionsFor(region) {
  const actions = navActionsFor(region);
  return Object.freeze({
    refresh: actions.includes('refresh'),
    openRoute: actions.includes('open-route'),
    toggleSidebar: actions.includes('toggle-sidebar'),
    goBack: actions.includes('go-back'),
  });
}

/**
 * Create the navigation view-model. The route table and the active route
 * enter ONLY through loadSuccess() (one hand-over from the navigation
 * capability); the surface performs no fetch, reads no location, issues no
 * route change and never re-derives the active route locally.
 */
export function createNavigationSurface(options = {}) {
  const locale = options.locale ?? 'en';
  const requestedMax = options.maxVisible ?? NAV_MAX_VISIBLE_DEFAULT;
  if (!Number.isInteger(requestedMax) || requestedMax <= 0) {
    throw new Error('maxVisible must be a positive integer');
  }
  const maxVisible = Math.min(requestedMax, NAV_MAX_VISIBLE_HARD_MAX);
  const renderAvailable = options.renderAvailable ?? true;

  let routes = Object.freeze([]);
  let active = null;
  let loaded = false;
  let region = 'loading';
  let filter = '';
  let sidebarOpen = true;
  let error = null;
  let degradedEvents = 0;
  let pendingAnnouncement = null;
  const history = [];

  function pushEvent(name) {
    history.push({ at: history.length, name });
    if (!renderAvailable) degradedEvents += 1;
  }

  function visibleRoutes() {
    if (routes.length === 0) return [];
    const query = filter.trim().toLowerCase();
    const base = query === ''
      ? routes
      : routes.filter((route) => route.label.toLowerCase().includes(query)
        || route.path.toLowerCase().includes(query));
    return base;
  }

  function regionState() {
    return region;
  }

  function recomputeRegion() {
    if (region === 'loading' || region === 'error') return region;
    region = visibleRoutes().length > 0 ? 'ready' : 'empty';
    return region;
  }

  function activeRoute() {
    return active === null ? null : routes.find((route) => route.id === active) ?? null;
  }

  function breadcrumbs() {
    const current = activeRoute();
    if (current === null) return Object.freeze([]);
    const trail = [];
    const visited = new Set();
    let cursor = current;
    while (cursor !== null && !visited.has(cursor.id)) {
      visited.add(cursor.id);
      trail.unshift(cursor);
      cursor = cursor.parent === null
        ? null
        : routes.find((route) => route.id === cursor.parent) ?? null;
    }
    return Object.freeze(trail.map((route) => Object.freeze({ id: route.id, label: route.label })));
  }

  function focusOrder(shown) {
    const crumbs = breadcrumbs();
    const isRoot = current => current !== null && (current.kind === 'root' || current.path === '/');
    return Object.freeze([
      'sidebar-toggle',
      ...shown.map((route) => `route:${route.id}`),
      ...crumbs.map((crumb) => `crumb:${crumb.id}`),
      ...(activeRoute() !== null && !isRoot(activeRoute()) ? ['back'] : []),
    ]);
  }

  function displayModel() {
    const visible = visibleRoutes();
    const shown = visible.slice(0, maxVisible);
    return Object.freeze({
      visible: true,
      active,
      regions: NAV_REGIONS,
      visibleCount: visible.length,
      shown: Object.freeze(shown.map((route) => Object.freeze({ ...route }))),
      truncated: visible.length > shown.length,
      total: routes.length,
      reason: region === 'empty' ? (filter.trim() === '' ? 'none' : 'filtered') : null,
      filter,
      sidebarOpen,
      breadcrumbs: breadcrumbs(),
      focusOrder: focusOrder(shown),
      labels: NAV_LABELS,
      announcement: pendingAnnouncement,
      actions: navActionsFor(region),
      error: region === 'error' ? { kind: error?.kind ?? 'network' } : null,
    });
  }

  function a11y() {
    return NAV_A11Y[regionState()];
  }

  return Object.freeze({
    id: NAV_SURFACE_ID,
    contract: navigationSurfaceContract(),
    maxVisible,
    /**
     * The only data entry point (one hand-over: route table + active route).
     * The surface ISSUES NO ROUTE CHANGE and never re-derives the active
     * route - the handed-over active is exactly what the router knows.
     * Secret-bearing payloads and paths are refused.
     */
    loadSuccess(payload) {
      if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new Error('loadSuccess expects a hand-over payload object {routes, active}');
      }
      const keys = Object.keys(payload);
      assertNoSecretFields(keys, 'loadSuccess payload');
      const sorted = keys.sort();
      if (sorted.join(',') !== [...PAYLOAD_KEYS].sort().join(',')) {
        throw new Error(`loadSuccess payload must have exactly ${PAYLOAD_KEYS.join(',')} (got ${sorted.join(',')})`);
      }
      if (!Array.isArray(payload.routes)) {
        throw new Error('loadSuccess payload field routes must be an array of route entries');
      }
      const ids = new Set();
      payload.routes.forEach((route, index) => {
        assertRoute(route, index, ids);
        if (ids.has(route.id)) {
          throw new Error(`route ${index} repeats the id "${route.id}": route ids are unique`);
        }
        ids.add(route.id);
      });
      if (payload.routes.length === 0) {
        if (payload.active !== null) {
          throw new Error(
            `an empty handed-over route table carries active null (got "${payload.active}")`,
          );
        }
      } else if (typeof payload.active !== 'string' || !ids.has(payload.active)) {
        throw new Error(
          `loadSuccess payload field active must name a handed-over route (got "${payload.active}")`,
        );
      }
      routes = Object.freeze(payload.routes.map((route) => Object.freeze({ ...route })));
      active = payload.active;
      filter = '';
      error = null;
      loaded = true;
      pendingAnnouncement = null;
      region = routes.length > 0 ? 'ready' : 'empty';
      pushEvent('loaded');
      return routes.length;
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
    /** Back to loading. Routes are retained but the region is loading. */
    setLoading() {
      region = 'loading';
      pushEvent('loading');
      return 'loading';
    },
    /**
     * The observable filter over the handed-over route table. Filtering to
     * zero is empty with reason filtered - never a fifth state. An unknown
     * value is refused.
     */
    setFilter(next = '') {
      if (typeof next !== 'string') {
        throw new Error('filter must be a string');
      }
      if (next !== filter) {
        filter = next;
        pushEvent('filtered');
      }
      return recomputeRegion();
    },
    /**
     * Sidebar open/closed is chrome state, not routing state: toggling never
     * changes the active route. The per-state action rule decides whether the
     * control is offered.
     */
    toggleSidebar() {
      sidebarOpen = !sidebarOpen;
      pushEvent('sidebar-toggled');
      return sidebarOpen;
    },
    /**
     * DECLARED, never executed: ask the app-layer router to open a route.
     * The surface holds no routing authority - active here does NOT change;
     * the router executes and re-hands over the new active route.
     */
    requestOpenRoute(id) {
      if (typeof id !== 'string' || id.trim() === '') {
        throw new Error('requestOpenRoute expects a non-empty route id');
      }
      if (region === 'loading' || region === 'error') return 'not-ready';
      const route = routes.find((entry) => entry.id === id);
      if (route === undefined) return 'unknown-route';
      if (id === active) return 'same-route';
      pushEvent('route-change-requested');
      pendingAnnouncement = route.label;
      return 'accepted';
    },
    /**
     * DECLARED, never executed: ask the app-layer router to go back. The
     * history entry belongs to the router - this surface never touches it.
     */
    requestGoBack() {
      if (region === 'loading' || region === 'error') return 'not-ready';
      pushEvent('back-requested');
      return 'accepted';
    },
    displayModel,
    a11y,
    /** Observable snapshot for the parity harness (candidate side). */
    observe() {
      const state = regionState();
      const model = displayModel();
      const events = state === 'ready' ? ['navigation:rendered'] : [];
      if (state === 'ready' && model.announcement !== null) {
        events.push('navigation:route-change');
      }
      return observation({
        surfaceId: NAV_SURFACE_ID,
        side: 'candidate',
        visible: model.visible === true,
        regionState: state,
        loading: state === 'loading',
        empty: state === 'empty',
        error: state === 'error' ? { kind: error?.kind ?? 'network' } : null,
        interactions: interactionsFor(state),
        events: Object.freeze(events),
        accessibility: a11y(),
        localization: Object.freeze({ slot: NAV_MESSAGE_SLOT, locale }),
        contract: Object.freeze({ id: NAV_SURFACE_ID, version: NAV_SURFACE_VERSION }),
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
  });
}

/* -------------------------------------------------------- the reference model */

/**
 * The reference (pinned n8n editor) observations as deterministic fixtures.
 * The reference UI is not run here - these are the declared behaviours the
 * candidate is compared against. They mirror observe() field for field, and
 * their interactions come from the SAME navActionsFor rule the view-model
 * uses, so the two sides cannot drift by construction.
 */
function referenceObservation({ regionState: state, error = null, events = [], locale }) {
  return observation({
    surfaceId: NAV_SURFACE_ID,
    side: 'reference',
    visible: true,
    regionState: state,
    loading: state === 'loading',
    empty: state === 'empty',
    error,
    interactions: interactionsFor(state),
    events: Object.freeze(events),
    accessibility: NAV_A11Y[state],
    localization: Object.freeze({ slot: NAV_MESSAGE_SLOT, locale }),
    contract: Object.freeze({ id: NAV_SURFACE_ID, version: NAV_SURFACE_VERSION }),
  });
}

export function referenceLoadingObservation(locale = 'en') {
  return referenceObservation({ regionState: 'loading', locale });
}

export function referenceEmptyObservation({ reason = 'none', locale = 'en' } = {}) {
  if (!NAV_EMPTY_REASONS.includes(reason)) {
    throw new Error(`reason must be one of ${NAV_EMPTY_REASONS.join(', ')} (got "${reason}")`);
  }
  return referenceObservation({ regionState: 'empty', locale });
}

export function referenceReadyObservation(locale = 'en') {
  return referenceObservation({ regionState: 'ready', events: ['navigation:rendered'], locale });
}

export function referenceErrorObservation({ errorKind = 'network', locale = 'en' } = {}) {
  return referenceObservation({ regionState: 'error', error: { kind: errorKind }, locale });
}
