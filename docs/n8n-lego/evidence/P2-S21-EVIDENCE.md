# P2-S21 Project/Workspace Administration Surface Pilot - Delivery Evidence

**Slice:** P2-S21 (Layer 4 surface split out of P2-S03; master prompt REQ-0003
section 6: frontend surface migration only, one surface = one delivery scope)
**Scope:** packages/frontend-lego/src/project-admin.mjs + test/58-project-admin.test.mjs + manifests
**Mode:** pilot; rollback pilot-not-primary; the original n8n editor stays the default path

## Out of scope (stated, not touched)

Project/role ownership itself - invite, remove and rename are DECLARED
requests and the capability that owns project state (P5-M11..M18 territory)
performs them; **the surface holds no project model of its own until P5-M11
exists**. Workflow data of any kind, project payloads beyond the closed
record shapes, persistence of any kind (no localStorage, no writes), routing,
and the reference editor's project chrome beyond this panel (divergence 3).
No backend dependency was built; rollback needs none.

## Security boundary (the load-bearing rule)

**There is no second source of truth for project state.** The project and
membership records arrive in one hand-over (`loadSuccess({projects,
members})`); the surface performs no fetch, never reads window/location,
**never mutates a record** (a rename or membership change arrives only via a
fresh hand-over), never calls the project/role capability itself and never
persists. The selected project is VIEW state only: it never leaves the
surface and is cleared by every fresh hand-over. Secret-bearing keys are
refused with an explicit security error on the hand-over, never dropped.
`issuesWorkflowSave: false`, `issuesEngineCall: false`.

## What shipped (one surface = one delivery scope)

- **Hand-over boundary (CP-01).** `inputBoundary` is
  `{source: hand-over, entryPoint: loadSuccess, issuesEngineCall: false,
  issuesWorkflowSave: false, carriesSecrets: false}`. Closed shapes: payload
  exactly `{projects, members}`; a project is `{id, name, memberCount}`
  (non-negative integer), a member is `{userId, displayName, role}` with
  role a member of the declared subset `owner | admin | member`; ids unique
  per list. Closed vocabularies: actions `refresh | select-project |
  request-invite | request-remove-member | request-rename`; select/invite
  results `accepted | unknown-project | not-ready`; remove adds
  `unknown-member | invalid-role`; rename adds `invalid-name` (non-empty,
  <= 64 chars); empty reason `none`. REGION_STATES pinned exactly. The
  owner can never be removed (closed result `invalid-role`). One dedicated
  test suite `packages/frontend-lego/test/58-project-admin.test.mjs` pins
  the boundary and closed shapes (18/18).
- **Pilot mode + rollback (CP-02).** Inventory entry `ui.settings.projects-admin`
  (new, 25th, category `projects-workspace` - existing vocabulary) with
  `migrationStatus pilot-available` / `contractStatus consuming` /
  `rollback pilot-not-primary` / `sourceIssue 240` / `slice P2-S21` /
  `surfaceIds [project-admin]` and test/58 as evidence; capability
  `project-admin` (27th, `./src/project-admin.mjs`, degradation fallback
  `native-behavior`). Surface `project-admin` declared (19th surface,
  backend none/endpoints [] - dialogs precedent, route
  `/settings/projects/admin`). Pinned by test/37 and test/39; curated index
  27 declared; boot payload baseline refreshed 20,271 -> 20,624 bytes
  (measured, + the project-admin surface) in test/32 + test/34; frontend
  boundary 18 -> 19; card 8,312/8,704.
- **Parity against the reference (CP-03).** All four region states are
  parity-equivalent to the deterministic reference fixtures through the
  existing parity harness; the per-state action rule (`projectAdminActionsFor`)
  is SHARED by the view-model and the reference fixtures - a divergence
  fails closed to a recorded diff.
- **Accessibility (CP-04).** `PROJECT_ADMIN_A11Y` derived once: `form`
  landmark + polite on ready, `status` + assertive only on error, busy only
  on loading; focus order is `project ids (hand-over order)` then, iff a
  project is selected, `member ids + invite + rename`, stable across
  interactions; aria labels declared once in `PROJECT_ADMIN_LABELS`;
  selections and requests announce the id; loading/empty/error reuse the
  shared interaction primitives; `ready -> not-ready` is guarded.
- **Budgets + failure behaviour (CP-05).** Bounded project list (default
  30, hard max 100, truncation reported); measured render cost (200
  projects x20 renders < 250 ms); failure is an explicit error region with
  a retry affordance and a recovery path, never a silent blank; degraded
  mode counts every undeliverable interaction; a workspace with no projects
  is empty with reason `none` - no fifth state; malformed arguments throw
  (programmer error), domain outcomes are the closed results.

## Divergences from the reference (recorded, never hidden)

1. **Declared, not executed.** The reference editor invites, removes and
   renames inline; the pilot issues `request-invite` / `request-remove-member`
   / `request-rename` and the owning capability performs the action - the
   handed-over records are byte-identical after every interaction (strict
   divergence - authority stays outside the surface, consistent with "no
   project model of its own until P5-M11").
2. **Selection never persists.** The reference remembers the open project
   across navigation; the pilot's selection is view state cleared by every
   fresh hand-over (no second source of truth).
3. **Closed record shapes.** The reference renders roles-per-project,
   avatars and timestamps; the pilot renders `{id, name, memberCount}` and
   `{userId, displayName, role}` only - richer project detail stays with
   the reference until the P5-M11+ models exist.
4. **Empty-region actions.** The reference can create the first project
   from an empty list; the pilot's empty region offers `refresh` only
   (shared per-state primitive) until an authorized slice extends the rule.

## Verification

- test/58-project-admin.test.mjs: 18/18 (groups A-E map to CP-01..05 +
  declared-never-mutates).
- Frontend suite after the change: 898 tests, 897 pass, 0 fail, 1 skip
  (includes refreshed pins: boot 20,624 in test/32 + test/34, pilot sets in
  test/37 + test/39, frontend boundary 19, curated index 27, card
  8,312/8,704).
