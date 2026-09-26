# P7-S01 — Parameter Contract & Compiler

**Issue:** #223 §4–6, §31, §37–38, §42 rung P7.1 (authorized by DEC-0024)
**Status:** in-progress until delivery merge + post-merge verification (DEC-0014, DEC-0015)
**Branch:** `manager/p7-s01-parameter-compiler`
**Contract:** domain `dynamic-parameters` 0.1.0 (owner `agent-4`), module `src/lego/parameter-plan.mjs`
**Executed by:** MANAGER-01 (DEC-0019: the Manager executes every task itself)

## 1. What was delivered

`apps/n8n-lego/src/lego/parameter-plan.mjs`: stage 2 (**COMPILE**) of the five-stage
P7 pipeline (#223 §4). It compiles one canonical n8n node description at one
`typeVersion` into an immutable **ParameterPlan**.

| #223 § | Requirement | Where it is met |
|---|---|---|
| §5 | nodeType, nodeVersion, schemaVersion, parameter ids and paths, dependency graph input, visibility predicates, default rules, validation rules, dynamic option sources, resourceLocator modes, capability requirements, cache policy | `compileParameterPlan`: `nodeType`, `typeVersion`, `versions`, `schemaVersion`, `parameters[].{id,path,visibility,default,validation,dynamic,resourceLocatorModes,capability,cachePolicy}`, `dependencyEdges`, `slots` |
| §5 | derived plans are disposable and reconstructible | deterministic compile. The same definition gives the same `planFingerprint`, and the plan is deep-frozen and never persisted as an authority |
| §6 | canonical logical path per parameter (`options.someField`, `fixedCollection.group[].field`) | `path` is the n8n value slot. Collection children are `parent.child`, fixedCollection children are `parent.group.child`, and `parent.group[].child` when `multipleValues` |
| §6 | array positions must not become identity | `id = path#sha256(type, displayOptions, parentVariant)[:12]`. Reordering the declarations keeps every id (tested) |
| §31 | node type version, definition version, schema version | `typeVersion`, `definitionFingerprint` (SHA-256 of the canonical declaration), `schemaVersion` `1.0.0`, `planFormatVersion` `1` |
| §37 | compile once, no network on static fields | `ParameterPlanCompiler` caches by (type, version, definition fingerprint). Static fields carry `capability: { discover: false, network: false }` |
| §38 | bounded, degrade before memory pressure | `PLAN_LIMITS`. An over-limit input throws `LIMIT_EXCEEDED`; nothing is truncated. The cache is a bounded LRU instance, not module state |
| §3, §32 | preserve the n8n vocabulary; community compatibility | the property shape is carried as declared. An unknown type is kept as kind `opaque` with an `UNKNOWN_TYPE` diagnostic and is never dropped |

## 2. Design decisions worth recording

- **One slot, many variants.** In n8n-nodes-base 2.9.1, 5,450 top-level property names
  are declared more than once, each copy selected by `displayOptions`. n8n stores
  all copies in one value slot. The plan mirrors this: `slots[path]` lists the
  variant ids, and every variant keeps its own visibility, default and validation.
- **The parent variant is part of identity.** The same child can be declared under
  two variants of one collection. An `options` collection repeated per resource
  with an identical `options.flag` child is the common case. A first draft hashed
  only (type, displayOptions), and it reported 2,477 catalog declarations as
  duplicates; 2,466 of those were this shape and 11 were true twins. Hashing the
  parent variant id into the child's id keeps them distinct, so they cannot
  collide or be dropped.
- **Byte-identical twins are kept.** Eleven catalog declarations repeat an identical
  sibling inside one parent. They are compiled as `id~2` (and so on) and reported as
  `IDENTICAL_DECLARATION`. Only among indistinguishable twins does occurrence order
  name the copy.
- **`@version` / `@tool` are decided at compile time, and only where provably sound.**
  For one plan the type version and the node name are constants. But n8n walks
  `show` in key order and returns *visible* as soon as a key holds an expression
  (`=…`), before later keys are read. `hide` is only walked when `show` completes.
  So a failing static key prunes only when no dynamic key precedes it, and a
  matching static `hide` key prunes only when every `show` key is static.
  `checkConditions` is a port of the pinned n8n function: `eq` is structural, a
  `_cnd` must hold for every value, an empty value list satisfies only `not`, and
  literals match strictly. **Correction made during this slice:** the first draft
  pruned on `show['@version']` regardless of key order and pruned 717
  declarations. Reading the upstream `displayParameter` showed that 296 of those
  can be visible through the expression short-circuit, so the rule was narrowed
  to the static prefix; 421 are now pruned. A test pins the key-order cases. Every
  other displayOptions condition is recorded as `visibility` for the RESOLVE stage
  (P7-S02) and is not evaluated here. Unknown `_cnd` operators throw
  `UNSUPPORTED_CONDITION`.
- **Dependencies are absolute paths.** A displayOptions key is relative to the
  containing value scope, a leading `/` makes it root-relative, and `@version`,
  `@tool` and `@feature` are kept apart as `metaDependsOn`.
  `typeOptions.loadOptionsDependsOn` contributes edges too. Its paths are root-relative in n8n,
  and only a leading `&` names a sibling in the same scope (upstream `resolveRelativePath`;
  corrected during this slice after an audit against the editor source). Cycle, missing-path
  and unsupported-type rejection belong to the dependency graph of P7-S02; the
  plan only records the edges.
- **Accounting invariant.** For every plan, `declarations = compiled + prunedByVersion`.
  The catalog test asserts it for every node type at every declared version.

## 3. Measurements (sandbox: 2 vCPU, 2 GB RAM, Node v20.20.2, catalog n8n-nodes-base 2.9.1)

| Measurement | Result |
|---|---|
| Plans compiled (483 node types, every declared version) | 638, 0 errors |
| Declarations (all versions) | 37,189 = 36,768 compiled + 421 pruned by `@version` / `@tool` |
| Unknown property types | 0 (all 21 catalog types are known) |
| Dynamic sources recorded (loadOptions / searchList / resourceMapper) | 3,823 across all plans |
| Cold compile, 483 latest-version plans | ≈ 2.3–2.7 s (2,303 ms and 2,659 ms in two runs) |
| Warm (cache hit), the same 483 plans | 1.5–1.9 ms, 483 hits / 0 evictions |
| Largest node (`notion`, latest version) | 787 compiled, 68–80 ms, 614 KB serialised |
| Process heap after compiling everything | ≈ 53–58 MB (RSS ≈ 172 MB for the whole test process) |

The largest serialised plan (614 KB for notion) is a compactness target for the
P7-S08 low-resource work. It is recorded here and has not been optimised yet.

## 4. Registration

- `manifest/domains.json` → `dynamic-parameters`: `status` planned → partial,
  `paths` = [`src/lego/parameter-plan.mjs`], contract `0.1.0`, contract test
  `test/lego-parameter-plan.test.mjs`. The capability `dynamic-parameters.resolve`
  stays `unsupported`: `/rest/dynamic-node-parameters` still answers 501 until
  P7-S04 mounts it. This slice claims no REST surface.
- `.ai` regenerated by `npm run lego:ai` (domain page, index, core architecture).

## 5. Tests

`apps/n8n-lego/test/lego-parameter-plan.test.mjs` has 24 tests:
- contract fields;
- deep freeze;
- the source definition is not mutated;
- determinism and reconstructibility;
- slot paths (root, collection, fixedCollection `group[]`);
- two variants under one slot;
- identity that survives reordering;
- the same child under two parent variants;
- byte-identical twins kept;
- `@version` pruning at v1, v2 and v3 with the accounting invariant;
- pruning soundness against n8n key order, and `@tool`;
- the `checkConditions` port (every value, empty values, strict literals, structural `eq`);
- the `_cnd` operators;
- an undeclared version refused;
- dependency paths (relative, root-relative, meta);
- `loadOptionsDependsOn` root-relative with `&` siblings;
- dynamic sources, modes, validation and sensitivity;
- unknown type kept as opaque;
- display-only declarations;
- credentials;
- four limits that refuse rather than truncate;
- invalid definitions;
- the compile-once LRU cache (hit, stale-definition miss, eviction, budget);
- the whole catalog at every version.

The catalog test needs `N8N_LEGO_CATALOG_DIR`, which CI's hosted job already
provides. When it is missing, the test fails; it is never skipped.

## 6. Verification

- **Delivery PR:** #334, head `71510167bffd57ac38fc75f5289fe20b7bd2f457`, squash-merged
  to `main` as `8aedbfa2cf67d4afd7cedb2e30b179e152107413` (2026-09-26).
- **GitHub-hosted checks on the head (3/3 success):** Unit + integration tests and release
  package; Backend LEGO architecture gate (P2.6); Clean clone → start → health → browser
  smoke → restart.
- **Self-hosted checks on the head: WAITING_RUNNER** (queued, not run): Level 0 (Check &
  Format), Level 1 (Affected Tests), Level 2 Workspace Tests (linux), Level 2 Workspace
  Tests (windows), Level 2 Conformance LEGO & Node Catalog, Windows worker portability
  probe. Merged under DEC-0015 model B. WAITING_RUNNER is not PASS, so the slice stays
  **in-progress (VERIFYING)** until these checks pass on main.
- **Fresh `main` at `8aedbfa2` (local re-verification):** backend 2755/2755
  (`lego-parameter-plan` 24/24), frontend 451/451, `lego:ai:check`, `lego:arch`,
  `lego:foundation`, `lego:capabilities` and `lego:scaleout` all exit 0.
- **Correction recorded before merge (head `71510167`):** `loadOptionsDependsOn` paths
  were first read as relative to the scope. Upstream reads them relative to the root, and a
  leading `&` names a sibling (`resolveRelativePath`). After the fix, 38 dependency
  paths in 12 catalog nodes still name no declared slot. That is a property of those node
  definitions, not of the compiler. P7-S02 reports them.

## 7. Not delivered here (later P7 slices)

- Visibility evaluation, dependency-graph validation (cycles, missing paths) and
  incremental recomputation: P7-S02.
- Validation, normalization and the execution snapshot: P7-S03.
- `/rest/dynamic-node-parameters`, the dynamic cache and coalescing: P7-S04.
- Resource locator search and pagination: P7-S05.
- Credential-aware resolution: P7-S06.
- Provider and plugin boundary: P7-S07.
- Differential certification against `n8n-workflow@2.9.1` and the low-resource
  target: P7-S08.
