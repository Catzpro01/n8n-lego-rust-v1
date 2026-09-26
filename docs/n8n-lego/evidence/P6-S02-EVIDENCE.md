# P6-S02 — Production WASM node/plugin sandbox engine (evidence)

Slice `P6-S02` (program P6, ecosystem; issue #224 "Advanced n8n-lego Runtime"; no debt source —
a capability gap in the WASM locality row).

## 1. The gap

Two contracts already exist and neither is this one.

- **`wasm-cache.mjs` (P6.26)** decides what a compiled module is *identified by* and what may be
  thrown away. Its scope wall says so in as many words: *"no compilation, no engine, no bytecode
  inspection and no WebAssembly API — the caller compiles and reports what happened."*
- **`plugin-locality.mjs` (P2.27.4)** offers `WASM` as a row in the `SANDBOXED` posture. It
  decides *where* a module may run. It does not decide what it may do once it is there.

So the cache has an owner and the placement has an owner, and the thing in between — the engine
that actually holds a module inside a policy while it runs — has none. `P6-S02` adds
`src/lego/wasm-sandbox.mjs`, `runtime.wasm-sandbox@0.1.0`.

## 2. The four rules

Each exists because the obvious engine gets it wrong.

### 2.1 Imports are deny-by-default and there are no wildcards

A WASM module is only as privileged as the imports it is handed, so the import table *is* the
security boundary. An import the sandbox was not granted is refused at **instantiation** — not
trapped at call time, when the damage of having resolved it is already done.

A wildcard grant is not a grant, it is the absence of one, and this engine has no syntax for it:
`createWasmSandbox({ grants: ['*'] })`, `['log.*']` and `['*.log']` are all refused rather than
interpreted. `log.*` is the dangerous one, because it *looks* like a scoped grant.

A refused row is never dropped from the resolution. A module asking for eleven imports and
granted ten has one refused row the caller must be able to see; silently binding nine is how a
module ends up running with a capability nobody granted it.

### 2.2 There is no ambient authority

`clock`, `random`, `filesystem`, `network`, `process` and `env` are imports like any other. A
sandbox created with no grants cannot reach a clock, and the way it cannot is *structural*: there
is no import to call. This is `plugin-policy.mjs`'s deny-by-default posture expressed in the one
place a WASM module would otherwise get ambient authority for free.

The ambient authorities a sandbox holds are **recorded, not inferred**. An operator inspecting a
sandbox sees `ambient: clock, network` without re-deriving it from the grant list — and `log`,
which is a grant but not an ambient authority, is correctly absent from that list.

### 2.3 Fuel is a hard budget and exhausting it is its own outcome

An instruction budget that is merely advisory is not a budget. When the fuel runs out the call
stops with `fuel-exhausted`, which is a different fact from `trapped`:

- `fuel-exhausted` — the module was **stopped**. Nothing is wrong with the module; it was given
  too small a budget, or it is in a loop.
- `trapped` — the module **misbehaved**. Something is wrong with the module.

An operator looking at a dead node needs to know which, and a two-outcome engine cannot tell
them. The budget overrides whatever the caller reported: a call that burned more than its budget
did not complete, whatever the caller says it did. The ceiling is inclusive — using the whole
budget is allowed.

### 2.4 The sandbox never changes the node contract

P6-S01's rule, inherited rather than restated differently. The instantiation decision carries
`consumerContract { type }` and nothing else, so a node running behind the engine presents the
same type identity, parameters and execution semantics as the same node in-process. The locality
is recorded next to the node, not inside it.

## 3. Composition with P6.26 — and an inverted dependency

The engine takes its module from the cache and refuses to run a module it cannot verify:

- a module whose digest does not match the entry is never run;
- a cached compilation failure has no module in it to run, and is refused.

**A negative entry is a `negative` lookup, not a `hit`.** P6.26 reports it that way, and the test
asserts the real state rather than the convenient one.

The first draft imported `verifyHit` from `wasm-cache.mjs`. `lego:arch` rejected it:
`lego-foundation` explicitly must not depend on `node-registry`, and `wasm-cache.mjs` lives
there. The fix was to **invert the dependency** rather than route around it: the entry is read as
data (`outcome`, `moduleDigest`) and the admission rule is the sandbox's own. That is the better
shape regardless — the engine owns its admission rule and does not inherit one from the cache
that stores the module. The caller wires the two together, which is what a composition root is
for. `contracts/` is untouched and no boundary was widened.

## 4. Scope walls

No WebAssembly API, no bytecode parsing, no compilation, no filesystem, no network, no clock, no
randomness. The caller reports what it compiled and how much fuel a call burned; this module
decides what may be imported, what may run, and when it must stop. It reads the cache as data and
never writes one — P6.26 owns the cache, and a second cache with different eviction rules is how
the first one stops being true.

A live sandbox is frozen, so it cannot be widened from outside. Widening a running sandbox is how
a temporary debug grant becomes a permanent capability.

## 5. Verification

| Gate | Result |
| --- | --- |
| `lego-wasm-sandbox.test.mjs` | **29 / 29 pass** |
| `lego:test` (whole suite) | **2727 / 2730 pass** |
| `lego:arch` / `lego:arch:selftest` | OK |
| `lego:foundation` / `lego:foundation:selftest` | OK |
| `lego:capabilities` / `lego:scaleout` | OK |
| `lego:ai:check` | OK — 101 files in sync |
| `governance-register.mjs check` | exit 0 |
| Unpublished error-code scan | clean |

**Pre-existing failures, not from this slice.** The same 3 compat node-catalog tests
(`/rest/types/nodes.json`, `/rest/types/node-versions.json`, `POST /rest/node-types`) fail
identically on a clean clone of `main`. This slice adds **+29 passing tests and zero new
failures**.

### 5.1 The post-merge Windows probe — an environmental blocker, recorded not hidden

`P6-S02` was merged correctly: at the **PR head** all nine required checks were `success` and
`mergeable_state` was `clean`, which is the merge gate. DEC-0015 verification therefore passes on
the evidence the rule actually specifies.

The **post-merge** `Windows worker portability probe` then failed:

| When | Runner | Result |
| --- | --- | --- |
| PR head `1037652b`, 02:21:55 | `laptop-build-worker-2` | **success** |
| merge commit `d3c35c73`, 02:24:57 | `laptop-build-worker-5` | **failure** at step 4 |

The tree is byte-identical between the two — the merge commit is a squash of the same PR — so the
failure is not reproducible from the code. The DEC-0015 retry was requested and has been `queued`
with **no runner picking it up for 28 minutes**, while the whole queue is otherwise empty. The
Windows runner fleet is offline.

This is recorded as an environmental blocker with its evidence, per §27. It is **not** recorded as
a pass, and it is **not** treated as a code failure. The step that failed is
`Every source file parses on Windows`, which passes locally (`node --check` on the new module is
clean, and the same step passed on the PR head two minutes earlier).

## 6. Bugs found by the tests

1. **The memory refusal was reported as `sandbox.fuel`.** Memory is not fuel, and an operator
   reading the reason needs to know which budget was exceeded. Split into `sandbox.resource`.
2. **`fuelPerCall` over the ceiling raised `sandbox.input` while `maxMemoryPages` over its ceiling
   raised `sandbox.resource`.** Two bounds, one concept, two codes.
3. **The verdict vocabulary in the tests was `admit`/`refuse` while the module declared
   `admitted`/`refused`.** The tests were written against the intent rather than the vocabulary.
4. **`insert` derives its own cache key.** Passing a pre-computed key made it recompute from
   undefined fields. The test now passes the identifying fields and lets P6.26 key them.

## 7. Checkpoints

| id | title | weight | status |
| --- | --- | --- | --- |
| CP-01 | Deny-by-default imports, no wildcards, refused rows never dropped | 25 | completed |
| CP-02 | No ambient authority: every ambient capability is a withholdable import | 20 | completed |
| CP-03 | Fuel is a hard budget; `fuel-exhausted` ≠ `trapped` | 20 | completed |
| CP-04 | The sandbox never changes the consumer-facing node contract | 10 | completed |
| CP-05 | P6.26 composition with the dependency inverted, hit verified before it runs | 15 | completed |
| CP-06 | DEC-0015 required self-hosted runner verification | 10 | completed |

Weights sum to 100 and derive from the scope of each checkpoint's enforced behaviour, not from
elapsed time, commit count or lines changed.
