# P5-M10 — Public /api/v1 resources over the backing models (M11..M18)

**Slice**: P5-M10 (`Public /api/v1 resources that need a backing model this product does not have yet: projects, audit, source-control, data-tables, workflow and credential transfer, workflow versions, execution retry, execution tags (upstream AnnotationTag)`)
**Delivered**: 2026-09-27 · **Status**: implemented (this document is the delivery evidence)

## What shipped

26 `/api/v1` routes over the eight backing models, mounted into the P5-M03..M09
public API pipeline (`src/auth/public-api-routes.mjs`) by a new mounting
framework (`src/auth/public-api-backing.mjs`):

| Resource (CP) | Routes | Backing model |
| --- | --- | --- |
| audit (CP-02) | `POST /audit` | M12 `audit-event-model` (`summarize`) |
| projects (CP-02) | `GET/POST /projects`, `PUT/DELETE /projects/{projectId}`, `GET/POST /projects/{projectId}/users`, `PATCH/DELETE /projects/{projectId}/users/{userId}` | M11 `project-sharing-model` |
| source-control (CP-02) | `POST /source-control/pull` | M13 `source-control-model` |
| data-tables (CP-02) | `GET/POST /data-tables`, `GET/PATCH/DELETE /data-tables/{dataTableId}`, `GET/POST .../rows`, `PATCH .../rows/update`, `POST .../rows/upsert`, `DELETE .../rows/delete` | M14 `data-table-model` |
| transfer (CP-03) | `PUT /workflows/{id}/transfer`, `PUT /credentials/{id}/transfer` | M15 `transfer-model` |
| workflow versions (CP-03) | `GET /workflows/{id}/{versionId}` | M16 `workflow-version-model` |
| execution retry (CP-03) | `POST /executions/{id}/retry` | M17 `execution-retry-model` |
| execution tags (CP-03) | `GET/PUT /executions/{id}/tags` | M18 `execution-tag-model` (AnnotationTag) |

Paths, methods, scopes and status codes mirror the pinned n8n 2.9.4 public API
(`reference/n8n/packages/cli/src/public-api/v1`); the served OpenAPI document
is regenerated from the pinned spec for exactly the mounted operations
(`scripts/extract-public-api-spec.py`, 57 operations / 34 paths).

## Guardrail verification (the acceptance checklist)

### CP-01 API mounting framework — contract & HTTP semantics
- One route→model wiring layer: `BACKING_RESOURCE_ROUTES` (static descriptors)
  is the single source of truth shared by the runtime mount, the OpenAPI
  extractor and the spec test — they cannot drift (framework test: "mount binds
  exactly the static BACKING_RESOURCE_ROUTES table").
- Uniform closed error mapping (tested exhaustively):
  `*_INVALID→400`, `*_NOT_FOUND→404`, `*_CONFLICT→409`,
  storage `UNAVAILABLE|TIMEOUT→503`, anything else `500 "Internal Server Error"`
  (never leaks internals). `withBackingErrors` routes every handler through it.
- Upstream HTTP semantics preserved: 201 create-project (empty body), 204
  rename/delete/member verbs (empty body), 200 `{data,nextCursor}` lists with
  the pinned cursor codec, `405 <METHOD> method not allowed`, error bodies
  `{ message }` (and the one upstream-verbatim `{ status, message }` on
  unconnected source control).

### Request → model → response mapping
- Every handler is a thin mapping over model verbs (create/get/list/update/
  lifecycle transitions with the model's own CAS version tokens — the API layer
  re-reads before mutating, never caches versions).
- Model-first response DTOs (documented): retry responses are M17 retry records
  (this product records retries; upstream re-executes), `POST /audit` answers
  M12's event summary `{summary:{total,byAction,byActor}, additionalOptions}`
  (upstream returns security risk reports — no such backing model exists here),
  workflow versions carry M16 fields (`versionId,workflowId,parentIds,diff,
  authors,...`), data-table rows use the model's string row ids (upstream:
  integers). Response schemas advertised from the pinned spec; deviations are
  exactly these model record shapes.
- Source-control pull (model-first): merges the connected repository's open
  changesets onto the branch head (CAS `setChangesetState('merged')` +
  `moveBranchHead`), reporting `statusResult.changed` + applied variables;
  unconnected → upstream-verbatim 400 `{status:'Error', message:'Source Control
  is not connected to a repository'}`. The upstream licence gate (401) collapses
  in this build: shipping the M13 module IS the Source Control feature.
- Data-table filter engine is deterministic and fail-closed:
  `{type:and|or, filters:[{columnName, condition: eq|neq|like|ilike|gt|gte|lt|lte, value}]}`,
  `sortBy field:asc|desc` with rowId tiebreak, `search` over string cells.
  Unknown columns NEVER match — a filter typo cannot widen a delete.
  `dryRun`/`returnData`/`returnType: count|id|all` honored per upstream.

### Error propagation
- Model failures surface with their closed codes mapped as above; entity
  lookups normalize to upstream bodies: `404 {message:'Not Found'}`,
  `404 {message:'Some tags not found'}` (execution tags), `404 {message:'Version
  not found'}` (catch-all like upstream's handler).
- Validation failures are 400 with explicit `request/body[/field]` messages
  (the P5-M08 `invalid()` idiom). Double retry → 409; ineligible execution →
  409 (M17's "no silent second run" refusal); missing `filter` on bulk row
  delete → 400 (upstream requires it).

### Auth/authorization boundary (the pinned vocabulary)
- Every operation carries a scope from `data/api-key-scopes.json` (53 pinned
  upstream scopes): `securityAudit:generate`, `project:create|update|delete|list`,
  `user:list`, `sourceControl:pull`, `dataTable:*`, `dataTableRow:*`,
  `execution:retry`, `executionTags:list|update`, `workflow:read|move`,
  `credential:move`. No invented scopes — unknown permissions fail closed in
  the P5.3 `authorize()` kernel (framework test + E2E 403 test with a
  narrowed key).
- `/api/v1` accepts API keys only (no cookies/CSRF surface) — pipeline
  unchanged from P5-M03..M09.

### Storage through the P8 facade — no hidden in-memory fallback
- `createBackingModels` builds all eight models over ONE `createLocalStorage`
  facade handle with an injected write-through persistence adapter
  (`<userFolder>/public-api-backing.json`, tmp+rename); the API layer holds no
  shadow state — reads and writes always cross the models.
- E2E proof: every API write is read back through the model in the same test
  (`backing.projects.getProject`, `backing.executionTags.listAttachments`,
  `backing.transfers.listTransfers`, `backing.sourceControl.getChangeset`, ...).
- DI hard requirements (framework test): storage, clock, idFactory and
  executionLookup are all mandatory — no ambient fallbacks.

### Deterministic behavior
- Clock/ids injected; list orders are stable key order with opaque cursors;
  filter/sort/search are pure functions with rowId tiebreaks; `GET /projects`
  twice is byte-identical (E2E pin).

### Rollback = unmount routes (CP-04)
- `mountPublicApiOperations(...)` returns the unmount handle; unmount removes
  the routes (404 'not found') while backing models and their history stay
  intact and readable, and re-mount serves the same history (framework test
  "unmount removes the routes; backing models and history stay intact").
  The base P5-M03..M09 routes survive a backing unmount.

### Focused API tests
- `test/public-api-backing-framework.test.mjs` — 18 tests (mapping, DI,
  mount/unmount lifecycle, filter engine, table integrity, scope vocabulary).
- `test/public-api-v1-backing.test.mjs` — 21 tests end-to-end through
  `startServer` (contract per resource, error propagation, auth boundary,
  model read-backs, determinism).
- Stale fixtures in the P5-M08/09 suites were repointed with diagnosis (they
  pinned "transfer/projects/retry not mounted"): POST-on-transfer and
  GET-on-retry now assert 405 (mounted, wrong method), the spec equality test
  covers the full build (57 operations) and the unmounted examples moved to
  genuinely absent paths (`/docs`, `/securityAudit`, `/metrics`).
- Backing-model surface pins in the M11/M13/M14 suites were extended for the
  three declared list verbs + `deleteTable` (still closed enumerations).

### Full battery
- lego **3053/3053** (3014 pre-existing + 39 new), engine **49/49**,
  runtime **79/79**; `governance-register --validate` 0 errors/0 drift;
  arch + foundation + capabilities + scale-out + ai:check gates green;
  `ai-pack --check` in sync.

## Backing-model extensions (declared, tested)

Three read verbs + one delete were added to merged models — each was required
to mount the resource, follows the sibling models' existing list idiom
(stable key order, opaque cursor), and keeps the closed surface pins:

- M11 `listProjects({cursor,limit})` → `{projects, nextCursor}`
- M13 `listRepositories({cursor,limit})` → `{repositories, nextCursor}`
- M14 `listTables({cursor,limit})` → `{tables, nextCursor}`;
  `deleteTable(tableId,{version})` — table + rows in ONE all-or-nothing
  `applyBatch` (pure CAS, like M18 `deleteTag`)

## Governance

- `src/lego/manifest/domains.json` (raw-text surgery): the eight model factory
  modules are now published in `lego-foundation.public` (named files, the
  boundary rule's designed mechanism); two scale-out findings declared
  (`S1 src/auth/public-api-routes.mjs` — per-process mount table = the rollback
  handle, benign; `S3 src/server.mjs` — the injected P8 persistence adapter,
  accepted with the same shared-backend resolution as `src/store.mjs` S3).
- Issue #85. Rollback story: unmount the routes; models + history untouched.
