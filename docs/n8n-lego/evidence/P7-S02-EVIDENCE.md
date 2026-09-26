# P7-S02 — Visibility & Dependency Graph

**Issue:** #223 §7–10, §37–38, §42 rung P7.2 (authorized by DEC-0024)
**Status:** in-progress until delivery merge + post-merge verification (DEC-0014, DEC-0015)
**Branch:** `manager/p7-s02-visibility-graph`
**Contract:** domain `dynamic-parameters` 0.2.0 (owner `agent-4`), module `src/lego/parameter-graph.mjs`
**Executed by:** MANAGER-01 (DEC-0019: the Manager executes every task itself)
**Features:** P7-F-PARAM-003..006

## 1. What was delivered

`apps/n8n-lego/src/lego/parameter-graph.mjs`: stage 3 (**RESOLVE**) of the P7 pipeline,
over the immutable ParameterPlan of P7-S01. The module is pure: no I/O, no network, no
clock and no module state.

| #223 § | Requirement | Where it is met |
|---|---|---|
| §7 | dependency graph; detect and reject cycles, missing dependencies, invalid paths | `buildDependencyGraph`: edges after slot resolution, iterative Tarjan SCC `cycles`, `selfLoops`, `missing`, topological `order`. `strict: true` refuses with `DEPENDENCY_CYCLE` / `MISSING_DEPENDENCY`. `ResolutionSession.set` refuses invalid paths with `INVALID_PATH` |
| §7 | never recurse until stack exhaustion | Tarjan and the transitive closure are iterative. A 4,000-deep chain is tested |
| §8 | when `resource` changes, invalidate `operation` and descendants; recompute only the affected subgraph | `ResolutionSession.set` re-evaluates only variants whose dependencies touch the changed path, or whose parent visibility changed. `invalidated` is the transitive dependent set that a DISCOVER cache (P7-S04) drops |
| §9 | resolved local values + predicate → VISIBLE or HIDDEN | `evaluateVisibility` is a port of n8n `displayParameter` / `getPropertyValues`. `resolveVisibility` walks the plan the way the editor passes `nodeValues` at each path |
| §9 | hidden does not delete stored values | resolution never writes values. Only an explicit `set(path, undefined)` removes one (tested) |
| §9 | malformed rules fail safely | a non-array condition list, an unknown `_cnd` operator or an invalid regex resolves **HIDDEN** with reason `malformed` and a `MALFORMED_RULE` diagnostic |
| §10 | no second expression language | expressions are never evaluated. As in n8n, a `show` key whose value is an expression makes the parameter visible (reason `expression`) |
| §38 | bounded | `GRAPH_LIMITS.maxInstances` (50,000 resolved instances) and `maxPathSegments` (64). Over-limit input throws `LIMIT_EXCEEDED`; nothing is truncated |

## 2. Upstream semantics ported (oracle: `reference/n8n/packages/workflow/src/node-helpers.ts`)

- **`getPropertyValues`:**
  - a `/key` reads from the root parameters; any other key reads lodash-`get` style from the current level. Lodash prefers a verbatim own key over path splitting, and so does `getPath`.
  - `@version` → `typeVersion || 0`.
  - `@tool` → the node name ends with `Tool`.
  - `@feature` → the enabled features, or `[]` when none are declared. No node in the pinned catalog declares features, so callers pass them explicitly.
  - a `{ __rl: true }` value is unwrapped to `.value`.
  - an array value is many values.
- **`displayParameter`:**
  - `show` is walked in key order. The first key whose values contain an expression returns VISIBLE before later keys are checked. Otherwise every key must pass `checkConditions`, which is shared with P7-S01.
  - `hide` is walked only when `show` completes, and hides on the first key with a non-empty value list whose `checkConditions` holds.
  - A missing or empty `displayOptions` is visible.
- **`displayParameterPath`:**
  - Children of a collection read the collection value as their level. For `multipleValues`, each element is its own level.
  - Children of a fixedCollection read the group value, or each element of the group.
  - Children of a hidden parent are recorded as `parent-hidden` and are never evaluated.
- **`loadOptionsDependsOn`** is root-relative, and `&x` names a sibling (`resolveRelativePath`, corrected in P7-S01 head `71510167`). A path such as `/rules` is kept literally. Upstream `get(parameters, '/rules')` finds nothing too, so the graph reports it as missing.
- **Recorded divergence (one):** upstream throws a `TypeError` on a malformed rule, for example a condition that is not an array. The editor then fails for that node. Here the rule resolves HIDDEN with a diagnostic, because hiding is the safe direction (#223 §9). The pinned catalog has no malformed rule; the catalog test asserts zero diagnostics.

## 3. Catalog facts (n8n-nodes-base 2.9.1, 483 descriptions / 436 node types, latest version of each)

| Fact | Value |
|---|---|
| Graph nodes (parameter paths) | 15,782 |
| Edges after slot resolution | 11,538 |
| Cycles (SCC size > 1) | 7, in 6 descriptions |
| Self-loops | 2 (theHive `operation`, wise `profileId`) |
| Missing dependency references | 47 variant-level (36 distinct dependency → dependent pairs), in 13 descriptions / 12 node types |
| Instances resolved with empty values | 21,889 total, 720 maximum for one node |
| Malformed rules | 0 |

- **The cycles are all mutually exclusive option pairs**, for example gmail `replyToSenderOnly` ↔ `replyToRecipientsOnly`, webhook/wait `rawBody` ↔ `noResponseBody`, moveBinaryData `jsonParse` ↔ `keepAsBase64`, and todoist `parent` ↔ `section`. Each option hides when the other is true. They are harmless in n8n because visibility reads values, never another parameter's visibility, so resolution is one pass.
- **Missing references** are dead paths in the node definitions, for example `/rules` in switch, `/pipelineId` in highLevel, and `optimizeResponse` read relative to a collection level in httpRequest.
- **Why the default is compatible:** rejecting these definitions would reject 21 pinned catalog descriptions (20 node types) that work in n8n. Compatible mode reports them. `strict: true` is the mode for definitions that must be clean, such as later third-party admission (P7-S07).

## 4. Measurements (sandbox: 2 vCPU, Node v20.20.2; `/tmp/w/s02measure.mjs`, 2 runs)

| Measurement | Result |
|---|---|
| Build every graph (483 plans) | 65 ms |
| Full resolution, mean per node, empty values | 0.065–0.069 ms |
| Incremental leaf edit (a path nothing depends on), 9,580 edits | 0.047 ms mean, **0 predicate evaluations** |
| Incremental controlling edit (a path others depend on, e.g. `resource`), 7,040 edits | 0.125–0.127 ms mean |
| Full resolution of the same states | 0.046 ms mean |
| Heap after the run | 47 MB |

**Honest reading:** at catalog sizes a full resolution already costs about 0.05–0.07 ms.
- **What incremental buys:**
  - a leaf edit does no predicate evaluation at all;
  - the change list (`changed`) and the cache invalidation set (`invalidated`) come out of the same pass.
- **What it does not buy:** it is not faster wall-clock for a controlling edit. The dependency matching and the change list cost more than a fresh walk of a few hundred instances. A controlling edit costs about 2.7× a fresh walk (0.125 ms against 0.046 ms), even though a wide edit, where more than half of the variants are affected, re-walks directly.
- **Correctness:** exactness is proven, not sampled by eye. The catalog test runs deterministic random edits over every node, including expression values, and asserts that the incremental state equals a fresh full resolution after every step.

## 5. Tests

`apps/n8n-lego/test/lego-parameter-graph.test.mjs` has 14 tests:
- lodash paths (verbatim key, indices, templates);
- `getPropertyValues` (root, meta, `__rl`, arrays, `@feature`);
- `show` key order with the expression short-circuit;
- the `hide` rules, including empty value lists and `not`;
- malformed rules resolve HIDDEN with a diagnostic;
- walk scope for collections and fixedCollection elements, and parent-hidden;
- root keys at depth;
- graph edges, slot-prefix resolution (`base.value` → `base`) and topological order;
- cycles, self-loops and missing references in compatible and strict mode;
- a 4,000-deep iterative chain;
- session leaf and controlling edits and `invalidated`;
- nested edits, element add/remove, parent flips and removal, all equal to a full resolution;
- invalid paths and instance budget;
- catalog-wide incremental = full.

## 6. Verification

- **Delivery PR:** #336, head `3d1dcd0260e5accc127c42404549535a0d9c38ce`, squash-merged
  to `main` as `d58dfaebf6d181d115ff9bd9cb455377061590b1` (2026-09-26).
- **GitHub-hosted checks on the head (3/3 success):** Unit + integration tests and release
  package; Backend LEGO architecture gate (P2.6); Clean clone → start → health → browser
  smoke → restart.
- **Self-hosted checks on the head: WAITING_RUNNER** (6 queued, not run): Level 0, Level 1,
  Level 2 Workspace Tests (linux / windows), Level 2 Conformance LEGO & Node Catalog,
  Windows worker portability probe. Merged under DEC-0015 model B. WAITING_RUNNER is not
  PASS, so the slice stays **in-progress (VERIFYING)** until these checks pass on main.
- **Fresh `main` at `d58dfaeb` (local re-verification):** backend 2769/2769
  (`lego-parameter-graph` 14/14), frontend 451/451, `lego:ai:check`, `lego:arch`,
  `lego:foundation`, `lego:capabilities` and `lego:scaleout` all exit 0.

## 7. Not delivered here (later P7 slices)

- Validation, normalization (n8n `getNodeParameters` including removal of hidden values
  where n8n removes them) and the execution snapshot: P7-S03.
- `/rest/dynamic-node-parameters`, the dynamic cache keyed by `invalidated`, and
  coalescing: P7-S04. The route stays 501 until then.
- Resource locator search: P7-S05. Credential-aware resolution: P7-S06. Provider
  boundary and third-party strict admission: P7-S07. Differential certification against
  the upstream implementation: P7-S08.
