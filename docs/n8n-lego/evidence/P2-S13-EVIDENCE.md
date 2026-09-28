# P2-S13 Navigation Surface Pilot - Delivery Evidence

**Slice:** P2-S13 (Layer 3 surface split out of P2-S03; master prompt REQ-0003
section 6: frontend surface migration only)
**Scope:** packages/frontend-lego/src/navigation.mjs + test/50-navigation.test.mjs + manifests
**Mode:** pilot; rollback pilot-not-primary; the original n8n editor stays the default path

## Out of scope (stated, not touched)

The router itself (the app layer owns history, URL resolution and route
guards), window.location reads, server-side route/table loading, permissions
gating per route, the reference `n8n-editor-ui` shell/header/sidebar markup,
deep-link semantics, and any workflow-data migration. No backend dependency
was built; rollback needs none.

## Security boundary (the load-bearing rule)

**Routing authority never reaches the surface.** The route table and the
active route arrive in ONE hand-over payload (`loadSuccess({routes, active})`);
the surface performs no fetch, never reads `window.location`, **issues no
route change** (opening a route and going back are DECLARED interactions with
closed result vocabularies - the router executes and re-hands over the new
active route) and never re-derives the active route locally. A route path
carrying secret query material (`token=`, `password=`, `secret=`, `apikey=`,
`session=`, `cookie=`, ...) is refused with an explicit security error, never
sanitized or silently dropped; a payload or route key carrying secret-bearing
field names is refused at the same boundary. Pinned by the refusal tests in
test/50-navigation.test.mjs (group A), including the static no-private-path
check (exactly one table install site, one active install site, no
`fetch(`/`window.`/`location`/`pushState`/`XMLHttpRequest` in code).

## What shipped (one surface = one delivery scope)

- **Hand-over boundary (CP-01).** Sidebar, top bar and breadcrumbs render the
  handed-over route table only; `inputBoundary` is
  `{source: hand-over, entryPoint: loadSuccess, issuesRouteChange: false,
  ownsRoutingAuthority: false, carriesSecrets: false}`. Closed vocabularies:
  regions `sidebar | topbar | breadcrumbs`, route kinds `root | section |
  page`, actions `refresh | open-route | toggle-sidebar | go-back`, route
  results `accepted | unknown-route | same-route | not-ready`, back results
  `accepted | not-ready`, empty reasons `none | filtered`. Route entries are a
  closed shape (`id, path, label, kind, parent`) with exact keys, unique ids,
  reference-style `/` paths, known parents and a cycle-proof breadcrumb walk.
- **Pilot mode + rollback (CP-02).** `ui.shell.navigation` moved from
  `reference-only` to `pilot-available` / `consuming` /
  `rollback pilot-not-primary` with `sourceIssue 240`, `slice P2-S13` and the
  test path as evidence; capability `navigation`
  (`./src/navigation.mjs`, messages slot `navigation`, degradation fallback
  `native-behavior` - without the capability the reference n8n navigation
  shell remains primary). Both manifests pinned by group B.
- **Parity against the reference (CP-03).** All four region states are
  parity-equivalent to the deterministic reference fixtures through the
  existing parity harness (loading, empty/none, empty/filtered, ready,
  error/network); the per-state action rule (`navActionsFor`) is SHARED by
  the view-model and the reference fixtures so the sides cannot drift. A
  divergence fails closed to a recorded diff, never a soft pass
  (`compareObservations` on a tampered interaction returns a non-equivalent
  status with diffs; invalid observations throw `ParityError`).
- **Accessibility (CP-04).** `NAV_A11Y` derived once: `navigation` landmark
  + polite on ready, `status` + assertive only on error, busy only on
  loading; focus order is stable and complete (sidebar toggle first, visible
  routes in table order, breadcrumbs, back last, absent on the root route);
  aria labels for every control declared once in `NAV_LABELS`; loading/empty/
  error reuse the shared interaction primitives (error offers exactly the
  retry affordance).
- **Budgets + failure behaviour (CP-05).** Bounded visible list
  (default 10, hard max 50, truncation reported); measured render cost for a
  typical payload (300 routes x20 renders + filter < 250 ms, recorded in
  test/50); failure is an explicit error region with a retry affordance and
  a recovery path, never a silent blank (`visible` stays true, error kind
  carried); degraded mode counts every undeliverable interaction instead of
  failing silently; a filter to zero is empty with reason `filtered`, the
  empty table is `none` - no fifth state.

## Divergences from the reference (recorded, never hidden)

1. **Route-table source.** The reference sidebar builds its items inside the
   editor bundle; the pilot receives the same items through the declared
   hand-over (the app layer serves them). Parity compares the declared
   behaviours and region states, not the bundle's build step - recorded as a
   strangler-model divergence (invariant 8).
2. **Secret-path refusal is stricter than the reference.** The reference UI
   will navigate to an arbitrary query string; the pilot refuses
   `token=`-style paths with an explicit security error. Divergence in the
   safe direction (fail-closed), pinned by the group A refusal test.
3. **Breadcrumb topology is fail-closed, not partial.** The reference derives
   breadcrumbs from its internal route registry; the pilot derives them from
   handed-over `parent` links with a visited-set guard. An unknown parent or
   a duplicate id refuses the whole hand-over instead of rendering a partial
   trail - no partial states, no silently dropped rows.

## Verification

- test/50-navigation.test.mjs: 18/18 (groups A-E map to CP-01..05).
- Frontend suite after the change: 754 tests, 753 pass, 0 fail, 1 skip
  (includes the pinned pilot-set updates in test/37 and test/39, the curated
  capability index in test/12 and the measured pack budget 84 KB -> 86 KB
  (measured total 86,438 B)).
