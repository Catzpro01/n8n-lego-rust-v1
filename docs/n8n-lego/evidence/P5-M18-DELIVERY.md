# P5-M18 — Execution annotation/tag model (P5-M10-H)

Scope mapping (register P5-M18) — owner minimal targets checklist:

| Target | Delivered | Evidence |
| --- | --- | --- |
| entity AnnotationTag-equivalent | `apps/n8n-lego/src/lego/execution-tag-model.mjs` — tag `{tagId, name, createdAt, updatedAt}` + case-insensitive name index + attachment records | test 1 |
| attach tag ke execution | `attachTag` (idempotent: `{attached:false, reason:'already_attached'}` on re-attach; exactly one record ever) | test 2 |
| detach tag dari execution | `detachTag` (idempotent: `{detached:false}` when absent) | test 3 |
| parity dengan perilaku upstream yang relevan | names unique case-insensitively; attach/detach idempotent; deleteTag frees the name and detaches everywhere (no dangling attachments) | tests 1–3, 5, 7 |
| deterministic behavior | stable key-order lists + cursor paging; `cleanupGarbage` deterministic order + counted; identical inputs → identical records | tests 4, 6, 9 |
| persistence melalui storage foundation | storage facade only (namespace `exec-tags`); multi-host shared state | test 7 |
| concurrency/CAS bila state mutable | `deleteTag` pure CAS (token REQUIRED, stale → CONFLICT); delete = one all-or-nothing `applyBatch` with per-op `expectedVersion` (concurrent attach aborts the delete) | test 5 |
| tidak ada side effect tersembunyi | writes happen ONLY inside named APIs; orphan cleanup is EXPLICIT (`cleanupGarbage`), never automatic | tests 6, 9 |
| error contract eksplisit | closed `TAG_INVALID\|NOT_FOUND\|CONFLICT`; idempotent outcomes are RESULTS, not errors | tests 1–3, 5 |
| focused tests tanpa mengubah ekspektasi demi hijau | 9 focused tests; 2 test-expectation fixes were DIAGNOSED fixture/logic errors (see below), impl unchanged | — |

Model surface (closed, pinned in test 9): `createTag/getTag/getTagByName/listTags/deleteTag`, `attachTag/detachTag/listAttachments/listByTag`, `cleanupGarbage`, `capabilities/namespace`.

## Test-expectation fixes (diagnosed; impl unchanged)

1. Test 4 fixture lacked `exec-000003-id` which the case itself attaches (fixture bug).
2. Test 7 asserted `createTag('bug')` conflicts AFTER `deleteTag('bug')` — but deleteTag correctly frees the name (upstream parity). The name-index conflict assertion now runs WHILE the tag is alive; post-delete re-create is asserted to succeed.

## Semantics recorded (explicit)

- Create-if-absent pattern (documented P8-S01 deviation family).
- `attachTag` checks execution existence via dependency-injected `executionLookup` (execution records live outside this model).
- Deleting a tag is the only destructive tag op and requires the explicit CAS token.

## Battery

See PR CI + post-merge battery (lego suite + engine + runtime + lego:gate + isolation + decisions).
