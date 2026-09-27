# P5-M16 — Workflow-version backing model (P5-M10-F)

Scope mapping (register P5-M16):

| Scope | Delivered | Evidence |
| --- | --- | --- |
| immutable version records with parent links and diff metadata | `apps/n8n-lego/src/lego/workflow-version-model.mjs` — `createWorkflowVersionModel(storage,{clock,idFactory,namespace})`; record `{tag, versionId, workflowId, parentIds[], sequence, diff{summary,added,removed,changed}, author, createdAt, metadata}`; per-workflow monotonic `sequence` | test 1 |
| persistence = shared store (P8) | storage facade only; multi-host shared history over one provider | tests 2, 6 |
| API gated until the model exists | no HTTP surface added; model layer only (mounts later) | surface pin test 9 |
| tests: immutability | create-only (pre-check + `put` + read-back verify); duplicate id refused (`VERSION_CONFLICT`) across hosts; model exposes no mutation/deletion API | test 2 |
| tests: ancestry | parent links form a DAG by construction (only existing parents; self-parent refused); `ancestors`/`descendants` walks deterministic (sequence/createdAt/versionId order); unknown parent → `VERSION_NOT_FOUND`; a corrupted cycle written behind the model's back is refused explicitly (`VERSION_CONFLICT`) instead of looping | tests 3–4 |
| rollback: unmount | no destructive API; namespace isolation leaves history intact but hidden | test 8 |
| deps: P8-S01 | delivered (PR #356) | register |

Model surface (closed, pinned in test 9): `createVersion/getVersion`, `ancestors/descendants`, `listVersions`, `capabilities/namespace`.

## Impl bugs caught pre-commit (impl fixed, tests unchanged)

1. **Walk direction bug**: the ancestry walker expanded via `record.parentIds` unconditionally, so `descendants()` walked back up through parents and flagged ordinary diamonds as "cycle". Fixed: the walk expands along `edgeOf` (parents for `ancestors`, children for `descendants`).
2. **Cursor shape gap**: `listVersions` accepted any non-empty string as cursor while its own error text promises "an opaque token issued by a previous list call" (issued cursors are versionIds). Fixed: cursors are validated as id-shaped tokens.

## Semantics recorded (explicit)

- Create-if-absent pattern (documented P8-S01 deviation, same as P5-M12..M15).
- Read misses throw `VERSION_NOT_FOUND` (backing-model family convention).
- `sequence` derives from existing versions of the same workflow at create time (deterministic in a single-writer order; concurrent cross-host creates may tie and are resolved by (createdAt, versionId) in reads).

## Battery

See PR CI + post-merge battery (lego suite + engine + runtime + lego:gate + isolation + decisions).
