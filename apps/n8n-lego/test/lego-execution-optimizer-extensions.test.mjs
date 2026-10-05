import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  OPTIMIZER_EXT_CONTRACT, OPTIMIZER_EXT_TRANSFORMS, ELIMINABLE_PURE_TYPES,
  NON_ELIMINABLE_FLAGS, PROFILE_PROVENANCE, PLAN_SHAPES, OPTIMIZER_EXT_LIMITS,
  OPTIMIZER_EXT_DEFAULTS, OPTIMIZER_EXT_BUDGETS,
  ExecutionOptimizerExtensionError,
  sha256Hex, canonicalIr, contentAddress, stepFingerprint,
  eliminationPlan, applyElimination,
  createSubgraphCache, compilePlan, replanIncremental,
  createOptimizerProfiler, splitHotCold, resolveExtensions,
} from '../src/lego/execution-optimizer-extensions.mjs';
import { GUARD_BUDGETS } from '../src/lego/resource-guard.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/p3/execution-optimizer-extensions.json', import.meta.url), 'utf8'));

const ir = (steps) => ({ irVersion: 1, steps });

const SET = 'n8n-nodes-base.set';
const NOOP = 'n8n-nodes-base.noOp';
const HTTP = 'n8n-nodes-base.httpRequest';

/** a dead pure noOp whose parent is `start`: eliminable. */
const eliminableIr = () => ir([
  { id: 'start', type: SET, deps: [], params: { keep: 'a' } },
  { id: 'dead', type: NOOP, deps: ['start'], params: {} },
  { id: 'end', type: SET, deps: ['start'], params: { keep: 'b' } },
]);

test('P3-S01 contract: id, version, owner, extends, transforms, defaults all OFF', () => {
  assert.equal(OPTIMIZER_EXT_CONTRACT.id, 'execution.optimizer-extensions');
  assert.equal(OPTIMIZER_EXT_CONTRACT.version, '1.0.0');
  assert.equal(OPTIMIZER_EXT_CONTRACT.owner, 'agent-1');
  assert.equal(OPTIMIZER_EXT_CONTRACT.extends, 'execution.optimizer@1.0.0');
  assert.deepEqual([...OPTIMIZER_EXT_TRANSFORMS], fixture.transforms);
  // Defaults OFF: an optimizer that changes behaviour by default is a bug.
  for (const name of OPTIMIZER_EXT_TRANSFORMS) {
    assert.equal(OPTIMIZER_EXT_DEFAULTS[name], false, `${name} must default OFF`);
  }
  assert.equal(Object.keys(OPTIMIZER_EXT_DEFAULTS).length, OPTIMIZER_EXT_TRANSFORMS.length);
});

test('P3-S01 vocabularies: pure whitelist, non-eliminable flags, plan shapes, budgets', () => {
  assert.deepEqual([...ELIMINABLE_PURE_TYPES], fixture.eliminablePureTypes);
  assert.deepEqual([...NON_ELIMINABLE_FLAGS], fixture.nonEliminableFlags);
  assert.deepEqual([...PLAN_SHAPES], fixture.planShapes);
  assert.deepEqual([...PROFILE_PROVENANCE], fixture.provenance);
  assert.deepEqual([...OPTIMIZER_EXT_BUDGETS], [...GUARD_BUDGETS]);
  assert.ok(GUARD_BUDGETS.includes('maxConcurrency'));
});

test('P3-S01 sha256 is real SHA-256, not a short hash', () => {
  // Known vectors (FIPS 180-4).
  assert.equal(sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(sha256Hex('The quick brown fox jumps over the lazy dog'),
    'd7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592');
  assert.equal(sha256Hex('a'.repeat(1000)).length, 64);
  assert.throws(() => sha256Hex(null), ExecutionOptimizerExtensionError);
});

test('P3-S01 canonicalIr is key-order and dep-order independent', () => {
  const a = ir([{ id: 'a', type: SET, deps: ['x', 'b'], params: { p: 1, q: 2 } }]);
  const b = ir([{ id: 'a', type: SET, deps: ['b', 'x'], params: { q: 2, p: 1 } }]);
  assert.equal(canonicalIr(a), canonicalIr(b));
  assert.equal(contentAddress(a), contentAddress(b));
});

test('P3-S01 contentAddress changes when the content changes', () => {
  const a = contentAddress(eliminableIr());
  const b = contentAddress(ir([
    { id: 'start', type: SET, deps: [], params: { keep: 'DIFFERENT' } },
    { id: 'dead', type: NOOP, deps: ['start'], params: {} },
    { id: 'end', type: SET, deps: ['start'], params: { keep: 'b' } },
  ]));
  assert.match(a, /^sha256:[0-9a-f]{64}$/);
  assert.notEqual(a, b);
});

test('P3-S01 canonicalIr and contentAddress refuse unusable IRs', () => {
  assert.equal(canonicalIr(null), null);
  assert.equal(canonicalIr({ steps: 'nope' }), null);
  assert.equal(canonicalIr({ steps: [{ id: 1, deps: [] }] }), null);
  assert.equal(canonicalIr({ steps: [{ id: 'a', deps: [1] }] }), null);
  assert.equal(contentAddress({ steps: [{ id: 'a', deps: [] }] }), null, 'a non-string type is not canonicalisable');
  assert.equal(stepFingerprint({ id: 'a', deps: [] }), null);
  assert.equal(stepFingerprint(null), null);
});

test('P3-S01 stepFingerprint is stable and content-sensitive', () => {
  const step = { id: 'a', type: SET, deps: ['b', 'c'], params: { x: 1, y: [1, 2] } };
  const reordered = { id: 'a', type: SET, deps: ['c', 'b'], params: { y: [1, 2], x: 1 } };
  assert.equal(stepFingerprint(step), stepFingerprint(reordered));
  assert.notEqual(stepFingerprint(step), stepFingerprint({ ...step, params: { x: 2, y: [1, 2] } }));
});

test('P3-S01 elimination: a dead pure node is planned for removal', () => {
  const plan = eliminationPlan(eliminableIr());
  assert.deepEqual([...plan.eliminated], ['dead']);
  assert.equal(plan.reduced, true);
  assert.deepEqual([...plan.remaining], ['start', 'end'], 'remaining keeps ordinal order');
});

test('P3-S01 elimination: a step WITH a consumer is never eliminated', () => {
  const plan = eliminationPlan(ir([
    { id: 'start', type: SET, deps: [] },
    { id: 'mid', type: NOOP, deps: ['start'] },
    { id: 'end', type: SET, deps: ['mid'] },
  ]));
  assert.deepEqual([...plan.eliminated], []);
  assert.equal(plan.reduced, false);
});

test('P3-S01 elimination: a non-pure type is never eliminated, even when dead', () => {
  const plan = eliminationPlan(ir([
    { id: 'start', type: SET, deps: [] },
    { id: 'deadHttp', type: HTTP, deps: ['start'] },
  ]));
  assert.deepEqual([...plan.eliminated], [], 'http has side effects');
});

test('P3-S01 elimination: a flagged step is never eliminated', () => {
  for (const flag of NON_ELIMINABLE_FLAGS) {
    const plan = eliminationPlan(ir([
      { id: 'start', type: SET, deps: [] },
      { id: 'dead', type: NOOP, deps: ['start'], [flag]: true },
    ]));
    assert.deepEqual([...plan.eliminated], [], `${flag} must block elimination`);
  }
});

test('P3-S01 elimination: the terminal step is never eliminated', () => {
  const plan = eliminationPlan(ir([{ id: 'only', type: NOOP, deps: [] }]));
  assert.deepEqual([...plan.eliminated], [], 'the declared output must survive');
});

test('P3-S01 elimination: rewiring keeps consumers satisfiable', () => {
  const plan = eliminationPlan(ir([
    { id: 'start', type: SET, deps: [] },
    { id: 'mid', type: NOOP, deps: ['start'] },
    { id: 'dead', type: NOOP, deps: ['mid'] },
    { id: 'end', type: SET, deps: ['start'] },
  ]));
  assert.deepEqual([...plan.eliminated], ['dead']);
  assert.deepEqual([...plan.rewired.dead], ['mid']);
});

test('P3-S01 applyElimination returns a valid IR and never mutates the input', () => {
  const source = eliminableIr();
  const snapshot = JSON.stringify(source);
  const plan = eliminationPlan(source);
  const next = applyElimination(source, plan);
  assert.equal(JSON.stringify(source), snapshot, 'the input IR is untouched');
  const ids = next.steps.map((s) => s.id);
  assert.deepEqual(ids.sort(), ['end', 'start']);
  // Every surviving dependency is satisfiable in the new IR.
  const present = new Set(ids);
  for (const step of next.steps) for (const dep of step.deps) assert.ok(present.has(dep), `${step.id} -> ${dep}`);
  assert.equal(Object.isFrozen(next), true);
});

test('P3-S01 applyElimination hoists an eliminated step parents onto consumers', () => {
  // `end` consumes `dead`; eliminating `dead` must rewire `end` to `start`.
  const source = ir([
    { id: 'start', type: SET, deps: [] },
    { id: 'dead', type: NOOP, deps: ['start'] },
    { id: 'end', type: SET, deps: ['dead'] },
  ]);
  // `dead` HAS a consumer, so the plan alone will not eliminate it; force it
  // through the plan's own elimination set to prove the rewire is correct.
  const plan = { eliminated: ['dead'] };
  const next = applyElimination(source, plan);
  const end = next.steps.find((s) => s.id === 'end');
  assert.deepEqual([...end.deps], ['start'], 'the consumer must not be orphaned');
  assert.equal(next.steps.length, 2);
});

test('P3-S01 applyElimination refuses an unknown step in the plan', () => {
  assert.throws(() => applyElimination(eliminableIr(), { eliminated: ['ghost'] }), ExecutionOptimizerExtensionError);
  assert.throws(() => applyElimination(eliminableIr(), {}), ExecutionOptimizerExtensionError);
});

test('P3-S01 every IR entry point refuses a malformed IR', () => {
  const bad = [null, 'nope', 42, {}, { irVersion: 1 }, { irVersion: 1, steps: 'x' },
    { irVersion: 1, steps: [{ id: 'a' }] },
    { irVersion: 1, steps: [{ id: 'a', deps: ['ghost'] }] },
    { irVersion: 1, steps: [{ id: 'a', deps: [] }, { id: 'a', deps: [] }] }];
  for (const value of bad) {
    assert.throws(() => eliminationPlan(value), ExecutionOptimizerExtensionError, JSON.stringify(value));
    assert.throws(() => replanIncremental(value, {}), ExecutionOptimizerExtensionError);
    assert.throws(() => compilePlan(value, {}), ExecutionOptimizerExtensionError);
    assert.throws(() => splitHotCold(value, {}), ExecutionOptimizerExtensionError);
  }
});

test('P3-S01 subgraph cache: a hit means byte-identical content', () => {
  const cache = createSubgraphCache({ maxEntries: 4 });
  const graph = ir([{ id: 'a', type: SET, deps: [], params: { k: 'v' } }]);
  assert.equal(cache.get(graph), undefined);
  cache.set(graph, { result: 42 });
  assert.deepEqual(cache.get(graph), { result: 42 });
  const same = ir([{ id: 'a', type: SET, deps: [], params: { k: 'v' } }]);
  assert.deepEqual(cache.get(same), { result: 42 }, 'a structurally identical subgraph must hit');
  assert.equal(cache.stats().hits, 2);
  assert.equal(cache.stats().misses, 1);
});

test('P3-S01 subgraph cache: a changed parameter is a miss, never a stale hit', () => {
  const cache = createSubgraphCache({ maxEntries: 4 });
  cache.set(ir([{ id: 'a', type: SET, deps: [], params: { k: 'v1' } }]), { result: 1 });
  assert.equal(cache.get(ir([{ id: 'a', type: SET, deps: [], params: { k: 'v2' } }])), undefined);
  assert.equal(cache.stats().misses, 1);
});

test('P3-S01 subgraph cache: a non-pure type is refused and counted, not silently missed', () => {
  const cache = createSubgraphCache({ maxEntries: 4 });
  const impure = ir([{ id: 'a', type: HTTP, deps: [], params: {} }]);
  cache.set(impure, { result: 1 });
  assert.equal(cache.get(impure), undefined);
  assert.equal(cache.stats().refused, 2, 'a refusal must be visible, not absorbed');
  assert.equal(cache.stats().size, 0);
});

test('P3-S01 subgraph cache: an uncanonicalisable subgraph is refused', () => {
  const cache = createSubgraphCache({ maxEntries: 4 });
  assert.equal(cache.address({ steps: 'nope' }), null);
  cache.set({ steps: 'nope' }, { result: 1 });
  assert.equal(cache.stats().refused, 1);
  assert.equal(cache.has({ steps: 'nope' }), false);
});

test('P3-S01 subgraph cache: bounded LRU with eviction accounting', () => {
  const cache = createSubgraphCache({ maxEntries: 2 });
  const g = (k) => ir([{ id: 'a', type: SET, deps: [], params: { k } }]);
  cache.set(g(1), { r: 1 });
  cache.set(g(2), { r: 2 });
  cache.get(g(1));            // promote 1
  cache.set(g(3), { r: 3 });  // evicts 2
  assert.deepEqual(cache.get(g(1)), { r: 1 });
  assert.equal(cache.get(g(2)), undefined);
  assert.equal(cache.stats().evictions, 1);
});

test('P3-S01 subgraph cache: fail-closed configuration', () => {
  for (const opts of [{ maxEntries: 0 }, { maxEntries: 1.5 }, { maxEntries: -1 }, { maxSubgraphSteps: 0 }]) {
    assert.throws(() => createSubgraphCache(opts), ExecutionOptimizerExtensionError, JSON.stringify(opts));
  }
});

test('P3-S01 subgraph cache: an oversized subgraph is refused', () => {
  const cache = createSubgraphCache({ maxSubgraphSteps: 1 });
  const big = ir([
    { id: 'a', type: SET, deps: [] },
    { id: 'b', type: SET, deps: ['a'] },
  ]);
  assert.equal(cache.address(big), null);
  cache.set(big, { r: 1 });
  assert.equal(cache.stats().refused, 1);
});

test('P3-S01 subgraph cache: an unserialisable payload is refused', () => {
  const cache = createSubgraphCache({ maxEntries: 2 });
  const cyclic = {};
  cyclic.self = cyclic;
  cache.set(ir([{ id: 'a', type: SET, deps: [] }]), cyclic);
  assert.equal(cache.stats().refused, 1);
  assert.equal(cache.stats().size, 0);
});

test('P3-S01 compilePlan: a linear graph compiles to sequential', () => {
  const chain = ir([
    { id: 'a', type: SET, deps: [] },
    { id: 'b', type: SET, deps: ['a'] },
    { id: 'c', type: SET, deps: ['b'] },
  ]);
  const plan = compilePlan(chain, { maxConcurrency: 8 });
  assert.equal(plan.shape, 'sequential', 'a chain has nothing to run concurrently');
  assert.equal(plan.width, 1);
  assert.equal(plan.steps, 3);
  assert.equal(plan.satisfiable, true);
  // A graph whose widest level is 2 must NOT be called sequential.
  const forked = compilePlan(eliminableIr(), { maxConcurrency: 8 });
  assert.equal(forked.shape, 'bounded-parallel');
  assert.equal(forked.width, 2);
});

test('P3-S01 compilePlan: fan-out compiles to bounded-parallel capped by the budget', () => {
  const wide = ir([
    { id: 'root', type: SET, deps: [] },
    ...Array.from({ length: 10 }, (_, i) => ({ id: `w${i}`, type: SET, deps: ['root'] })),
  ]);
  const capped = compilePlan(wide, { maxConcurrency: 4 });
  assert.equal(capped.shape, 'bounded-parallel');
  assert.equal(capped.width, 4, 'the budget caps the width');
  const open = compilePlan(wide, {});
  assert.equal(open.shape, 'bounded-parallel');
  assert.equal(open.width, 10, 'no declared budget uses the plan-width bound');
  assert.deepEqual([...open.budgetDeclared], []);
});

test('P3-S01 compilePlan: width never exceeds the plan bound', () => {
  const wide = ir([
    { id: 'root', type: SET, deps: [] },
    ...Array.from({ length: 400 }, (_, i) => ({ id: `w${i}`, type: SET, deps: ['root'] })),
  ]);
  const plan = compilePlan(wide, { maxConcurrency: 1000 });
  assert.equal(plan.width, OPTIMIZER_EXT_LIMITS.maxPlanWidth);
});

test('P3-S01 compilePlan: the budget is read, never invented', () => {
  assert.throws(() => compilePlan(eliminableIr(), { cpuPercent: 50 }), ExecutionOptimizerExtensionError);
  assert.throws(() => compilePlan(eliminableIr(), { maxConcurrency: 0 }), ExecutionOptimizerExtensionError);
  assert.throws(() => compilePlan(eliminableIr(), { maxConcurrency: 1.5 }), ExecutionOptimizerExtensionError);
  assert.throws(() => compilePlan(eliminableIr(), { maxConcurrency: -1 }), ExecutionOptimizerExtensionError);
  assert.throws(() => compilePlan(eliminableIr(), { timeoutMs: -5 }), ExecutionOptimizerExtensionError);
  assert.throws(() => compilePlan(eliminableIr(), 'nope'), ExecutionOptimizerExtensionError);
});

test('P3-S01 compilePlan: a zero-concurrency budget is refused, not degraded', () => {
  assert.throws(() => compilePlan(eliminableIr(), { maxConcurrency: 0 }), /cannot execute anything/);
});

test('P3-S01 incremental: an unchanged graph is fully reusable', () => {
  const source = eliminableIr();
  const previous = new Map(source.steps.map((s) => [s.id, stepFingerprint(s)]));
  const plan = replanIncremental(source, previous);
  assert.deepEqual([...plan.rerun], []);
  assert.equal(plan.reusable.length, 3);
  assert.equal(plan.savings, 1);
});

test('P3-S01 incremental: a changed step invalidates its whole downstream cone', () => {
  const source = ir([
    { id: 'a', type: SET, deps: [], params: { v: 1 } },
    { id: 'b', type: SET, deps: ['a'], params: { v: 2 } },
    { id: 'c', type: SET, deps: ['b'], params: { v: 3 } },
    { id: 'sibling', type: SET, deps: ['a'], params: { v: 9 } },
  ]);
  const previous = new Map(source.steps.map((s) => [s.id, stepFingerprint(s)]));
  const changed = { ...source, steps: source.steps.map((s) => (s.id === 'b' ? { ...s, params: { v: 99 } } : s)) };
  const plan = replanIncremental(changed, previous);
  assert.deepEqual([...plan.rerun], ['b', 'c']);
  assert.deepEqual([...plan.reusable], ['a', 'sibling']);
  assert.equal(plan.invalidatedBy.c, 'b', 'the cause of the rerun is recorded');
  assert.equal(plan.savings, 0.5);
});

test('P3-S01 incremental: an absent fingerprint forces a recompute', () => {
  const source = eliminableIr();
  // Only `start` has a MATCHING fingerprint; `dead` and `end` have none.
  const previous = new Map([['start', stepFingerprint(source.steps[0])]]);
  const plan = replanIncremental(source, previous);
  assert.deepEqual([...plan.reusable], ['start']);
  assert.deepEqual([...plan.rerun], ['dead', 'end']);
  // A fingerprint that does not match is also "no evidence it is the same".
  const wrong = new Map([['start', 'sha256:not-the-same']]);
  assert.deepEqual([...replanIncremental(source, wrong).reusable], []);
});

test('P3-S01 incremental: no evidence at all means nothing is reusable', () => {
  const plan = replanIncremental(eliminableIr(), {});
  assert.deepEqual([...plan.reusable], []);
  assert.equal(plan.rerun.length, 3);
  assert.equal(plan.savings, 0);
});

test('P3-S01 incremental: a fingerprint naming an unknown step is refused', () => {
  assert.throws(() => replanIncremental(eliminableIr(), { ghost: 'sha256:x' }), ExecutionOptimizerExtensionError);
  assert.throws(() => replanIncremental(eliminableIr(), { start: 42 }), ExecutionOptimizerExtensionError);
});

test('P3-S01 incremental: savings is derived from the reusable set', () => {
  const source = eliminableIr();
  const previous = new Map(source.steps.map((s) => [s.id, stepFingerprint(s)]));
  const plan = replanIncremental(source, previous);
  assert.equal(plan.savings, plan.reusable.length / source.steps.length);
});

test('P3-S01 profiler: samples accumulate with a mandatory provenance', () => {
  const profiler = createOptimizerProfiler();
  assert.equal(profiler.record('a', 10), true);
  assert.equal(profiler.record('a', 20), true);
  const summary = profiler.summary('a');
  assert.equal(summary.samples, 2);
  assert.equal(summary.totalMs, 30);
  assert.equal(summary.meanMs, 15);
  assert.equal(summary.maxMs, 20);
  assert.deepEqual([...summary.provenance], ['OBSERVED']);
  assert.equal(summary.mixedProvenance, false);
});

test('P3-S01 profiler: a mixed profile reports mixedProvenance', () => {
  const profiler = createOptimizerProfiler();
  profiler.record('a', 10, 'OBSERVED');
  profiler.record('a', 50, 'ESTIMATED');
  const summary = profiler.summary('a');
  assert.equal(summary.mixedProvenance, true);
  assert.deepEqual([...summary.provenance], ['ESTIMATED', 'OBSERVED']);
  assert.equal(profiler.measuredFraction(), 0, 'not every sample was measured');
});

test('P3-S01 profiler: an unmeasured step is null, and an empty profiler is not 100%', () => {
  const profiler = createOptimizerProfiler();
  assert.equal(profiler.summary('never'), null);
  assert.equal(profiler.measuredFraction(), null, 'nothing measured is not 100%');
  assert.equal(profiler.totalMs(), 0);
});

test('P3-S01 profiler: invalid samples are refused and never recorded', () => {
  const profiler = createOptimizerProfiler();
  assert.equal(profiler.record('a', -1), false);
  assert.equal(profiler.record('a', NaN), false);
  assert.equal(profiler.record('a', Infinity), false);
  assert.equal(profiler.record('a', '10'), false);
  assert.equal(profiler.record('a', 10, 'GUESSED'), false);
  assert.equal(profiler.record('', 10), false);
  assert.equal(profiler.size, 0, 'nothing was recorded');
});

test('P3-S01 profiler: bounded, fail-closed configuration', () => {
  const profiler = createOptimizerProfiler({ maxSteps: 2 });
  assert.equal(profiler.record('a', 1), true);
  assert.equal(profiler.record('b', 1), true);
  assert.equal(profiler.record('c', 1), false, 'the bound refuses, it does not evict');
  assert.equal(profiler.size, 2);
  assert.throws(() => createOptimizerProfiler({ maxSteps: 0 }), ExecutionOptimizerExtensionError);
});

test('P3-S01 hot/cold: observed frequency classifies against the threshold', () => {
  const source = ir([
    { id: 'a', type: SET, deps: [] },
    { id: 'b', type: SET, deps: ['a'] },
    { id: 'c', type: SET, deps: ['a'] },
  ]);
  const split = splitHotCold(source, { a: 100, b: 90, c: 2 });
  assert.deepEqual([...split.hot], ['a', 'b']);
  assert.deepEqual([...split.cold], ['c']);
  assert.deepEqual([...split.unmeasured], []);
  assert.equal(split.measuredFraction, 1);
  assert.equal(split.maxCount, 100);
});

test('P3-S01 hot/cold: cold-by-default is reported separately from cold-by-evidence', () => {
  const source = eliminableIr();
  const split = splitHotCold(source, { start: 100 });
  assert.deepEqual([...split.hot], ['start']);
  assert.deepEqual([...split.cold], ['dead', 'end']);
  assert.deepEqual([...split.unmeasured], ['dead', 'end']);
  assert.equal(split.measuredFraction, 1 / 3);
});

test('P3-S01 hot/cold: an all-zero observation set classifies nothing as hot', () => {
  const source = eliminableIr();
  const split = splitHotCold(source, { start: 0, dead: 0, end: 0 });
  assert.deepEqual([...split.hot], [], 'zero invocations is not hot');
  assert.equal(split.cold.length, 3);
  assert.equal(split.unmeasured.length, 0, 'these WERE observed, as zero');
  assert.equal(split.measuredFraction, 1);
});

test('P3-S01 hot/cold: an out-of-range threshold and bad observations are refused', () => {
  const source = eliminableIr();
  for (const threshold of [0, -0.5, 1.5, NaN, Infinity, '0.5']) {
    assert.throws(() => splitHotCold(source, {}, { threshold }), ExecutionOptimizerExtensionError, String(threshold));
  }
  assert.throws(() => splitHotCold(source, { ghost: 1 }), ExecutionOptimizerExtensionError);
  assert.throws(() => splitHotCold(source, { start: -1 }), ExecutionOptimizerExtensionError);
  assert.throws(() => splitHotCold(source, { start: 1.5 }), ExecutionOptimizerExtensionError);
});

test('P3-S01 toggles: unknown extensions and non-boolean values are refused', () => {
  assert.deepEqual({ ...resolveExtensions() }, { ...OPTIMIZER_EXT_DEFAULTS });
  assert.equal(resolveExtensions({ elimination: true }).elimination, true);
  assert.equal(resolveExtensions({ hotColdSplit: false }).elimination, false);
  assert.throws(() => resolveExtensions({ nope: true }), ExecutionOptimizerExtensionError);
  assert.throws(() => resolveExtensions({ elimination: 'yes' }), ExecutionOptimizerExtensionError);
  assert.throws(() => resolveExtensions('nope'), ExecutionOptimizerExtensionError);
});

test('P3-S01 the module is zero-import except the in-domain guard vocabulary', () => {
  const source = readFileSync(new URL('../src/lego/execution-optimizer-extensions.mjs', import.meta.url), 'utf8');
  const imports = [...source.matchAll(/^import .*?;$/gm)].map((m) => m[0]);
  assert.equal(imports.length, 1, 'only the P3.11 guard vocabulary may be imported');
  assert.match(imports[0], /from '\.\/resource-guard\.mjs'/);
});
