# LEGO / Sub-LEGO Physical Isolation Standard

## Purpose

The repository is organized by **LEGO → Sub-LEGO → Work Item**. The Sub-LEGO is the smallest architectural ownership boundary and must be isolated both functionally and physically.

A Sub-LEGO is not only a planning label. It owns a bounded capability and a canonical filesystem root.

## Canonical layout

```text
lego/
├── _contracts/
└── Lxx-<lego-slug>/
    ├── S01-<sublego-slug>/
    │   ├── README.md
    │   ├── CONTRACT.md
    │   ├── src/
    │   ├── tests/
    │   └── evidence/
    └── S02-<sublego-slug>/
```

The stable identity is `Lxx.Syy`.

Example:

```text
lego/L01-execution/S04-checkpoint-recovery/
```

## Ownership rules

### 1. One file, one Sub-LEGO

Every implementation source file has exactly one owning Sub-LEGO.

A file must not contain behavior from two Sub-LEGOs merely because the behavior is convenient to share.

### 2. One Sub-LEGO, one capability

A Sub-LEGO must represent one coherent capability with a bounded public contract.

Do not use a Sub-LEGO as a catch-all for unrelated features.

### 3. Public contract only

Cross-Sub-LEGO communication is allowed only through explicit public contracts.

Allowed:

```text
L01.S04 -> L05.S02 contract
```

Forbidden:

```text
L01.S04 -> L05.S02/src/internal/*.rs
L01.S04 -> L05.S02/src/private/*.ts
```

### 4. No cross-boundary mutation

One Sub-LEGO must not directly mutate another Sub-LEGO's private state, storage objects, caches, worker handles, or internal data structures.

Requests cross the boundary through a contract, command, event, or typed adapter.

### 5. Tests stay with the owner

Unit and boundary tests for a Sub-LEGO live under its canonical root.

Cross-Sub-LEGO integration tests may exist at a repository test boundary, but they must declare the participating Sub-LEGO IDs and must not become a reason to move implementation into a shared module.

### 6. Contracts contain no hidden implementation

`CONTRACT.md` and exported contract modules describe types, commands, events, errors, versioning, and invariants. They must not become a second implementation layer.

### 7. Shared code is exceptional

`lego/_contracts/` may contain contract-only primitives used by multiple Sub-LEGOs.

Shared behavioral code is not allowed there. When behavior is shared, choose an owning Sub-LEGO and expose it through a contract.

### 8. No god modules

Files such as a global `runtime.rs`, `engine.ts`, `manager.ts`, or `utils.ts` must not become an unrestricted dumping ground for behavior owned by many Sub-LEGOs.

Split capability-specific behavior into the owning Sub-LEGO.

## Dependency rules

The dependency graph is directed.

A Sub-LEGO may depend on:

- an earlier LEGO/Sub-LEGO contract;
- repository-wide language/runtime primitives;
- explicitly approved platform crates.

A Sub-LEGO may not depend on another Sub-LEGO's private implementation.

No dependency cycle is allowed between Sub-LEGOs.

When two Sub-LEGOs repeatedly need each other's internals, the boundary is wrong. Refactor the contract instead of introducing a direct internal dependency.

## Work-item rules

Every migration issue or PR has:

- one primary `sublego:Lxx.Syy` identity;
- optional secondary references to other Sub-LEGOs;
- one canonical implementation root;
- tests and evidence owned by the same Sub-LEGO.

Recommended title:

```text
[LEGO L01.S04] Add checkpoint recovery journal
```

## Completion rules

A Sub-LEGO is complete only when:

1. its implementation is physically under its canonical root;
2. its public contract is explicit;
3. private internals are not imported by other Sub-LEGOs;
4. its unit and boundary tests pass;
5. applicable security/negative tests pass;
6. applicable n8n differential tests pass;
7. evidence identifies the exact verified commit;
8. temporary legacy files have been removed or explicitly tracked as migration debt.

A LEGO is complete only after all required Sub-LEGOs satisfy these conditions.

## Legacy migration policy

Existing mixed files in the current repository are not treated as compliant merely because they implement the correct behavior.

They are migration debt.

Refactoring order:

```text
identify owner
  -> create Sub-LEGO root
  -> define contract
  -> move implementation
  -> move tests
  -> replace internal imports
  -> run boundary checks
  -> remove legacy mixed file
```

Do not create a new shared abstraction solely to avoid moving legacy code.

## CI enforcement target

The repository should eventually validate this automatically.

Minimum checks:

- every new implementation file is under a declared Sub-LEGO root;
- Sub-LEGO dependency graph is acyclic;
- no import crosses into another Sub-LEGO private/internal path;
- each Sub-LEGO has contract + test + evidence metadata;
- each migration issue/PR has exactly one primary Sub-LEGO identity;
- ownership paths are deterministic from `Lxx.Syy`.

## Source-of-truth documents

- `docs/migration/LEGO-MILESTONE-PLAN.md` — milestone hierarchy and capability scope.
- `docs/migration/LEGO-PHYSICAL-ISOLATION.md` — physical/function boundary rules.
- `docs/migration/N8N-RUST-V4-FEATURE-MIGRATION.md` — historical issue mapping and migration status.

The source repository `Catzpro01/n8n-rust-v.4` remains read-only.
