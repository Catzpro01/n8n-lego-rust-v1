# P5-M11 Delivery Evidence — Project / sharing backing model (P5-M10-A)

Date: 2026-09-27. Owner authorization: marathon prompt (models P5-M11..M18 after P5-M05, one by one).
Scope source: the register's scope definition (project, membership, share-role semantics; persistence =
shared store boundary P8; API surface gated; tests: model unit + API contract; rollback: drop the
resource mount; deps: P8-S01).

## 1. What changed

| Artifact | Path |
|----------|------|
| Model | `apps/n8n-lego/src/lego/project-sharing-model.mjs` — projects + membership/share records + share-role semantics over the storage facade (namespace `project-share`) |
| Tests | `apps/n8n-lego/test/lego-project-sharing-model.test.mjs` (9) |

## 2. Scope mapping

| Scope item | Delivered |
|------------|-----------|
| project records | `createProject/getProject/renameProject/setArchived` — closed record `{tag:1, projectId, name, ownerId, createdAt, archived}` |
| membership / share records | `addMember/getMember/changeMemberRole/removeMember/listMembers` — `m:{project}:{principal}` records with role + timestamps |
| share-role semantics | closed vocabulary `owner > editor > viewer` (PROJECT_ROLES + roleAtLeast), role validation typed; one-owner invariant enforced (owner edits/roles/removals refused with explicit CONFLICT pointing at transferOwnership) |
| persistence = P8 shared store boundary | model imports ONLY `storage/contract.mjs`; state lives in the facade (namespace `project-share`); surface pinned by test |
| atomicity / races | rename/archive/role-change via CAS (`putIfVersion`); **ownership transfer = one `applyBatch`** (demote old owner + promote new + rewrite project.ownerId all-or-nothing; mid-batch conflict applies nothing — tested) |
| API surface gated | model layer only; routes mount in P5-M10; rollback = drop the resource mount (no schema/data migration) |
| tests: model unit + API contract | 9 tests: lifecycle, roles/hierarchy, membership invariant, archived refusal, multi-host CAS races (two hosts, one storage), transfer atomicity incl. aborted-batch-no-landing, bounded listing, invalid inputs, storage-outage propagation, determinism, surface pin |

## 3. Deviations / known limits (explicit)

- After `transferOwnership` the previous owner keeps membership as `editor` (documented choice;
  demotion-to-member would be a vocabulary extension).
- `listMembers` filters namespace pages by the member prefix (bounded list semantics of the storage
  contract; pages may hold fewer members than `limit`, `nextCursor` continues).
- Project `create` and `addMember` create paths use the storage contract's last-writer-wins create
  (ids/principals are unique by construction); every race-sensitive update uses CAS.

## 4. Verification

Battery counts recorded in the delivery PR and the post-merge reconcile (lego incl. the 9 new tests,
engine 49/49, runtime 79/79, lego:gate, isolation, decisions, ai:check).

## 5. Rollback

Remove `project-sharing-model.mjs` + its test file; unmount the future resource route; abandoned
namespace keys are inert.
