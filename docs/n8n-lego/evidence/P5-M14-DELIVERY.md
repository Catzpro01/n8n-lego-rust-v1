# P5-M14 — Data-table backing model (P5-M10-D): column schema + row store

Scope mapping (register P5-M14):

| Scope | Delivered | Evidence |
| --- | --- | --- |
| column schema + row records with typed cells | `apps/n8n-lego/src/lego/data-table-model.mjs` — `createDataTableModel(storage,{clock,idFactory,namespace})`; closed column types `string\|number\|boolean\|date\|json`; rows `{tag, tableId, rowId, cells}` with strict cell validation (required/default/null-as-absence) | tests 1–2 |
| persistence = shared store (P8) | storage facade only; multi-host shared tables over one provider | test 6 |
| API gated until the model exists | no HTTP surface added; model layer only (`/api/v1/data-tables` mounts later) | surface pin test 9 |
| tests: schema evolution | `addColumn` (backfill `null`; required-without-default on non-empty table = explicit `TABLE_CONFLICT`), `renameColumn`/`dropColumn` rewrite schema AND rows in ONE all-or-nothing `applyBatch` (every op carries `expectedVersion`) — no silent data reinterpretation; last remaining column cannot be dropped | tests 3–4 |
| tests: row CRUD | create/get/update(partial patch)/delete with typed-cell validation; updates/deletes pure CAS (version token REQUIRED) | tests 2, 5 |
| rollback: unmount | no destructive API; namespace isolation leaves history intact but hidden | test 8 |
| deps: P8-S01 | delivered (PR #356, merge 3e0f621d) | register |

Model surface (closed, pinned in test 9): `createTable/getTable/renameTable`, `addColumn/renameColumn/dropColumn`, `createRow/getRow/updateRow/deleteRow/listRows`, `capabilities/namespace`.

## Semantics recorded (explicit)

1. **Table version = schema version.** Row writes do NOT bump the table version; schema CAS tokens guard schema races, row CAS tokens guard row races (both explicit, both required).
2. **Create-if-absent pattern** (same documented P8-S01 deviation as P5-M12/P5-M13): pre-check `get` + `put` + read-back verify.
3. **Reads throw `TABLE_NOT_FOUND`** for missing records (backing-model family convention, consistent with P5-M11/P5-M13); absence after delete is therefore a NOT_FOUND read, not a null.

## Test-expectation fixes (diagnosed, impl unchanged)

1. `getRow` after `deleteRow`: expectation corrected to NOT_FOUND throw (family convention; the initial expectation of `null` contradicted the model's own test 8).
2. "dropColumn('id')" while other columns remain is LEGAL — the intended invariant is "a table must keep at least one column", now exercised with a single-column table.
3. Stale-schema-CAS probe must follow an actual schema mutation (row creates do not stale the schema token).

## Battery

See PR CI + post-merge battery (lego suite + engine + runtime + lego:gate + isolation + decisions).
