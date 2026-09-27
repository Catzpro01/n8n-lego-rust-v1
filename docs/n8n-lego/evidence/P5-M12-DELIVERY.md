# P5-M12 — Audit backing model (P5-M10-B): security-audit event generation and store

Scope mapping (register P5-M12):

| Scope | Delivered | Evidence |
| --- | --- | --- |
| append-only audit-event model with actor/action/target/attestation fields | `apps/n8n-lego/src/lego/audit-event-model.mjs` — `createAuditEventModel` (clock + idFactory injected); events carry actor/action/target/targetType/occurredAt/attestation{kind,by,at,digest}/metadata/source; stored under `e:<eventId>` with tag `audit-event-v1` | tests 1, 9 |
| persistence = shared store (P8) | storage facade only (`createStorage(createLocalStorage)`); multi-host shared history over one provider | test 6 |
| API gated until the model exists | no HTTP surface added; model layer only (`/api/v1/audit` mounts later on this model) | surface pin: no route files touched |
| tests: immutability + query contract | immutability: append-only, duplicate id refused (CONFLICT), no mutation/delete API exposed; query: actor/action/target/targetType/time-window filters, stable (occurredAt, eventId) ordering, stateless cursor paging | tests 2–5 |
| rollback: unmount | model exposes no destructive op; namespace isolation (`audit_t8_v2`) starts empty while original history stays intact | test 8 |
| deps: P8-S01 | delivered (PR #356, merge 3e0f621d) | register |

Model surface (closure of the model errors): `append`, `record`, `get`, `query`, `summarize`.

## Deviations (explicit)

1. **No atomic create-if-absent in P8-S01** (documented P8 limitation): `putIfVersion` cannot express "must be absent". Append-only is enforced with pre-check `get` + unconditional `put` + read-back value verify; a concurrent create race throws `AUDIT_CONFLICT` instead of silently overwriting (test 2). A future atomic create primitive can replace the sequence without changing the model surface.
2. **Cursor paging is stateless**: the cursor is the opaque `(occurredAt, eventId)` of the last returned item (resumes strictly after); no cursor markers are persisted (keeps the read path write-free and the history keyspace pure). Malformed cursors are `AUDIT_INVALID`.
3. **Error set is `{AUDIT_INVALID, AUDIT_CONFLICT}`** (closed); `AUDIT_NOT_FOUND` from the earlier design sketch is dropped because `get` reads misses as `null` (house read semantics: absence is a result, not an error).

## Determinism

Identical inputs produce byte-identical stored events across independent namespaces (test 9); `summarize` output is key-sorted.

## Battery

See PR CI + post-merge battery (lego suite + engine + runtime + lego:gate + isolation + decisions).
