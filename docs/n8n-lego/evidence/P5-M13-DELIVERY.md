# P5-M13 — Source-control backing model (P5-M10-C): repository/branch/changeset records

Scope mapping (register P5-M13):

| Scope | Delivered | Evidence |
| --- | --- | --- |
| repository, branch, changeset records with provider-neutral fields | `apps/n8n-lego/src/lego/source-control-model.mjs` — `createSourceControlModel(storage,{clock,idFactory,namespace})`; closed record shapes `{tag, ...}` with provider as free neutral string; closed changeset vocabulary `open\|merged\|closed` | tests 1–3 |
| persistence = shared store (P8) | storage facade only; multi-host shared state over one provider | test 6 |
| API gated until the model exists | no HTTP surface added; model layer only (`/api/v1/source-control` mounts later) | surface pin test 9 |
| tests: round-trip + conflict semantics | round-trip byte-stable (get body === create body); stale CAS → `SOURCE_CONFLICT` (never silent LWW); missing → `SOURCE_NOT_FOUND`; malformed / missing version token → `SOURCE_INVALID` | tests 4–5 |
| rollback: unmount | no destructive API; namespace isolation leaves history intact but hidden | test 8 |
| deps: P8-S01 | delivered (PR #356, merge 3e0f621d) | register |

Model surface (closed, pinned in test 9): `createRepository/getRepository/renameRepository/archiveRepository`, `createBranch/getBranch/moveBranchHead`, `createChangeset/getChangeset/setChangesetState`, `listBranches/listChangesets`, `capabilities/namespace`.

## Deviations (explicit)

1. **No atomic create-if-absent in P8-S01** (same as P5-M12): creates use pre-check `get` + unconditional `put` + read-back verify; a concurrent create race throws `SOURCE_CONFLICT`.
2. **CAS updates REQUIRE the explicit version token** (no silent fallback to the just-read version): `renameRepository`/`archiveRepository`/`moveBranchHead`/`setChangesetState` throw `SOURCE_INVALID` without `{version}`. This matches the P5-M11 project-model contract; the implementation initially carried a `version ?? current` convenience fallback and it was removed as a contract violation (impl bug caught by test 4).
3. **List cursors are filter-aware result-set cursors** (stateless opaque = record key of the last returned item), not raw namespace scan positions: `listBranches`/`listChangesets` paginate the filtered set so a caller never receives an empty page while `nextCursor` is non-null. (The first implementation paged the raw namespace scan and inverted the first-page slice — two impl bugs fixed before commit, caught by test 7.)

## Determinism

Identical inputs produce identical records across namespaces (test 9); list ordering is stable key order.

## Battery

See PR CI + post-merge battery (lego suite + engine + runtime + lego:gate + isolation + decisions).
