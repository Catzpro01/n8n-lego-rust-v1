# Rust-port conformance fixtures (LEGO 01 — Workflow)

Golden values for the Phase-3 Rust port of the Workflow Model, **derived from the pinned reference
runtime** (`n8n-workflow@2.9.1` — the dependency set of n8n `2.9.4`), not hand-written.

| File | Role |
| :--- | :--- |
| `build-fixtures.mjs` | derives `fixtures.json` from the reference; `--check` re-derives and exits non-zero on drift |
| `fixtures.json` | 35 cases: `checksum` (8), `compareConnections` (6), `toJSON` (6), `rename` (6), `traversal` (9) |

## Reproduce

```bash
scripts/setup-reference-runtime.sh        # once: installs n8n-workflow/core/nodes-base 2.9.1 into .runtime/
node tests/reference/workflow-rust/build-fixtures.mjs --check
```

Expected output:

```text
fixtures match the pinned reference: 8 checksum, 6 diff, 6 shape, 6 rename, 9 traversal cases
```

`--check` is deterministic: it rebuilds every value from the reference and compares it to the committed
file, with `generatedAt` excluded. Any drift means either the reference moved (the pin `b6dc2787c45677a29a9612cd27eb911302961a83`
must be updated deliberately) or the fixtures were hand-edited (never do that).

## What each section is for

* **`checksum`** — `calculateWorkflowChecksum` (surface symbol #14). SHA-256 hex over
  `JSON.stringify(sortObjectKeys(whitelist(snapshot)))`, whitelist =
  `name, description, nodes, connections, settings, meta, pinData, isArchived, activeVersionId`.
  Cases prove: top-level and nested key-order invariance, `id/active/staticData/timestamps` exclusion,
  node-**array** order sensitivity, `pinData` inclusion.
* **`compareConnections`** — surface symbol #15 (`{ added, removed }` with `sourceIndex` and the slot
  `value.index`).
* **`toJSON`** — the aggregate's **in-memory** shape. Note the name is historical: the reference
  `Workflow` class has **no** `toJSON()`; the persisted/API shape (`nodes` as an array) belongs to the
  entity layer, and the checksum consumes that array form. These cases therefore pin what a `Workflow`
  instance exposes (name-keyed nodes, both indexes, `settings`/`staticData` defaults, resolved
  `timezone`), plus two documented invariant gaps: duplicate node names silently overwrite, and a node
  named `__proto__` never becomes an own key.
* **`rename`** — restricted JS-prototype names throw `UserError`, collisions **overwrite** (no guard),
  `D-08` (the destination index is *not* rebuilt by `renameNode`, so parent queries keep answering under
  the old name until `setConnections` re-derives it), and port-driven rewriting of parameter references
  (`$('A')` → `$('Alpha')`; plain strings untouched).
* **`traversal`** — `getConnectedNodes` connection-type filter (`main`, `ALL`, `ALL_NON_MAIN`, `ai_*`),
  depth semantics (`0` → `[]`, `n` → n levels, `-1` → unlimited) and deterministic result order.

## Consuming it from Rust

```rust
#[derive(serde::Deserialize)]
struct Fixtures { /* checksum, compareConnections, toJSON, rename, traversal */ }

let raw = include_str!("../../../../tests/reference/workflow-rust/fixtures.json");
let fixtures: Fixtures = serde_json::from_str(raw).unwrap();
// assert each case against the ported implementation
```

## Governance

* The reference tree stays **read-only**: this folder only *reads* fixtures from `tests/reference/**` and
  the pinned runtime.
* Regeneration is allowed only when the reference pin changes (a deliberate, reviewed decision);
  otherwise `fixtures.json` is frozen and is the acceptance test described in
  `docs/isolation/workflow-rust-port-review.md` §6.
