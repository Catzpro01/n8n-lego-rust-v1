/**
 * P3 Slice J — Execution IR: compile, independently disableable optimization
 * toggles (#91(c)), bounded LRU cache. Contract `execution.ir@1.0.0`
 * (lock row 37), owner agent-1, domain execution. Zero-import module.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  EXECUTION_IR_CONTRACT, EXECUTION_IR_CONTRACT_VERSION,
  IR_OPTIMIZATIONS, ExecutionIrError,
  compileExecutionIr, optimizeExecutionIr, createIrCache,
} from '../src/lego/execution-ir.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const LOCK = JSON.parse(readFileSync(path.join(ROOT, 'src/lego/contracts/contract-lock.json'), 'utf8'));
const ROWS = LOCK.contracts;
const moduleSource = readFileSync(path.join(ROOT, 'src/lego/execution-ir.mjs'), 'utf8');

function caught(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw that never happened');
}

function fixture() {
  return {
    name: 'slice J fixture',
    nodes: [
      { name: 'Start', type: 'n8n-nodes-base.start', typeVersion: 1, position: [0, 0], parameters: {} },
      { name: 'Noop1', type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [100, 0], parameters: {} },
      { name: 'Noop2', type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [200, 0], parameters: {} },
      { name: 'Work', type: 'n8n-nodes-base.set', typeVersion: 3, position: [300, 0], parameters: {} },
      { name: 'Sink', type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [400, 0], parameters: {} },
      { name: 'Other', type: 'n8n-nodes-base.httpRequest', typeVersion: 4, position: [300, 100], parameters: {} },
    ],
    connections: {
      Start: { main: [[{ node: 'Noop1', type: 'main', index: 0 }]] },
      Noop1: { main: [[{ node: 'Noop2', type: 'main', index: 0 }, { node: 'Noop2', type: 'main', index: 0 }]] },
      Noop2: { main: [[{ node: 'Work', type: 'main', index: 0 }]] },
      Work: { main: [[{ node: 'Sink', type: 'main', index: 0 }]] },
      Ghost: { main: [[{ node: 'Start', type: 'main', index: 0 }]] }, // orphan key
      Other: { main: [[{ node: 'Work', type: 'main', index: 0 }, { node: 'Work', type: 'main', index: 0 }]] },
    },
  };
}

/* ============================================ A. CONTRACT / LOCK ROW 37 */

test('the lock row is the thirty-seventh: execution.ir@1.0.0, owner agent-1, exports byte-parity', () => {
  const row = ROWS.find((r) => r.id === 'execution.ir');
  assert.ok(row, 'execution.ir is locked');
  // P9.1 envelope + P3 optimizer are merged; P9.2 structured-log adds row 42.
  assert.equal(ROWS.length, 100, 'P3 Slice H added the thirty-sixth (workflow.dna); P3 Slice J adds the thirty-seventh (execution.ir); P3 Slice L the thirty-eighth (compatibility.oracle); P3 Slice M the thirty-ninth (execution.guard) — P6.1 adds node.registry@0.1.0; P6.2 adds registry.compiler@0.1.0; P6.3 adds package.transaction@0.1.0; P6.4 adds registry.closure@0.1.0; P6.5 adds node.resolution@0.1.0; P6.6 adds runtime.lease@0.1.0; P6.7 adds node.residency@0.1.0; P6.8 adds node.capability@0.1.0; P6.9 adds node.semantics@0.1.0; P6.10 adds node.lifecycle@0.1.0; P6.11 adds node.health@0.1.0; P6.12 adds node.supply-chain@0.1.0; P6.13 adds registry.incremental@0.1.0; P6.14 adds node.worker-convergence@0.1.0; P6.15 adds node.acceptance@0.1.0; P6.16 adds registry.integrity@0.1.0; P6.17 adds node.admission@0.1.0; P6.18 adds node.sbom@0.1.0; P6.19 adds node.canary@0.1.0; P6.20 adds node.revocation@0.1.0; P6.21 adds node.io@0.1.0; P6.22 adds runtime.jit@0.1.0; P6.23 adds runtime.cancel@0.1.0; P6.24 adds runtime.pool@0.1.0; P6.25 adds node.abi@0.1.0; P6.26 adds runtime.wasm-cache@0.1.0; P6.27 adds node.provenance@0.1.0; P6.28 adds registry.freshness@0.1.0; P6.29 adds node.namespace@0.1.0; P6.30 adds registry.repair@0.1.0; P6.31 adds registry.acceptance@0.1.0; count-pins say 76; P2.27.1 adds lego.plugin-runtime@0.1.0 (seventy-sixth); P5.1 adds the ninety-fifth (auth.principal)'); // P9 integration (Agent 1): P9.5-P9.22 add 18 observability.* rows on top of protected main 76 -> 94 (union, zero id collisions); P9 was developed on 24032a0c (57 rows). P5.2 adds the ninety-sixth (auth.session). P5.3 adds the ninety-seventh (auth.authorization). P5.5 adds the ninety-eighth (auth.credential-crypto). P5.6 adds the ninety-ninth (auth.account-security). P5.7 adds the hundredth (auth.machine-identity).
  assert.equal(row.owner, 'agent-1', 'Issue #98: Agent 1 owns execution artifacts');
  assert.equal(row.domain, 'execution');
  assert.equal(row.version, '1.0.0');
  assert.equal(row.status, 'implemented');
  assert.deepEqual(row.surface, ['src/lego/execution-ir.mjs']);
  const module_ = {
    EXECUTION_IR_CONTRACT, EXECUTION_IR_CONTRACT_VERSION,
    IR_OPTIMIZATIONS, ExecutionIrError,
    compileExecutionIr, optimizeExecutionIr, createIrCache,
  };
  const exported = Object.keys(module_).sort();
  const locked = Object.values(row.exports).flat().sort();
  assert.deepEqual(exported, locked, 'file exports match the lock');
  for (const key of locked) assert.notEqual(module_[key], undefined, key + ' is exported');
  assert.equal(typeof compileExecutionIr, 'function');
  assert.equal(typeof optimizeExecutionIr, 'function');
  assert.equal(typeof createIrCache, 'function');
  assert.equal(typeof ExecutionIrError, 'function');
  assert.equal(EXECUTION_IR_CONTRACT_VERSION, '1.0.0');
  assert.deepEqual([...IR_OPTIMIZATIONS], ['noopPassthrough', 'dedupeDeps'], 'two independently disableable optimizations');
});

/* ================================================ B. COMPILE (raw, truth) */

test('compileExecutionIr: raw deps in encounter order, duplicates kept, dangling excluded', () => {
  const ir = compileExecutionIr(fixture());
  assert.equal(ir.irVersion, 1);
  assert.deepEqual(ir.steps.map((s) => s.id), ['Start', 'Noop1', 'Noop2', 'Work', 'Sink', 'Other']);
  const byId = new Map(ir.steps.map((s) => [s.id, s]));
  // DIRECTION: deps = predecessor sources (what must run before), raw order
  assert.deepEqual(byId.get('Start').deps, [], 'root — Ghost orphan excluded');
  assert.deepEqual(byId.get('Noop1').deps, ['Start']);
  // RAW: duplicated inbound links stay duplicated — dedupe is an OPTIMIZATION
  assert.deepEqual(byId.get('Noop2').deps, ['Noop1', 'Noop1'], 'raw duplicate deps preserved at compile');
  assert.deepEqual(byId.get('Work').deps, ['Noop2', 'Other', 'Other']);
  assert.deepEqual(byId.get('Sink').deps, ['Work']);
  assert.deepEqual(byId.get('Other').deps, []);
  assert.ok(Object.isFrozen(ir) && Object.isFrozen(ir.steps) && Object.isFrozen(byId.get('Work').deps));
  // orphan Ghost is not a step; Ghost→Start contributes no dependency
  assert.equal(ir.steps.some((s) => s.id === 'Ghost'), false);
  assert.deepEqual(byId.get('Start').deps, [], 'orphan source adds nothing to Start');
  // purity: fixture untouched
  assert.equal(fixture().connections.Ghost.main[0][0].node, 'Start');
});

test('compileExecutionIr fails closed on malformed structure (one error family)', () => {
  assert.equal(caught(() => compileExecutionIr(null)).code, 'lego.contract_violation');
  assert.equal(caught(() => compileExecutionIr({ nodes: [] })).details.field, 'nodes');
  assert.equal(caught(() => compileExecutionIr({ nodes: [{ type: 'x' }] })).details.field, 'nodes');
  const dup = { nodes: [{ name: 'A', type: 't' }, { name: 'A', type: 't' }] };
  assert.equal(caught(() => compileExecutionIr(dup)).details.reason, 'duplicate-name');
  assert.equal(caught(() => compileExecutionIr({ nodes: [{ name: 'A', type: 't' }], connections: 7 })).details.field, 'connections');
  const err = caught(() => compileExecutionIr(null));
  assert.ok(err instanceof ExecutionIrError);
  assert.equal(err.name, 'ExecutionIrError');
});

/* ================================== C. TOGGLES (#91(c)) — all combinations */

test('optimization toggles: all-off is the canonical identity; each toggle independent', () => {
  const raw = compileExecutionIr(fixture());

  // all OFF → identity (#91(c): disabling recovers canonical behavior)
  const off = optimizeExecutionIr(raw, { noopPassthrough: false, dedupeDeps: false });
  assert.deepEqual(JSON.parse(JSON.stringify(off)), JSON.parse(JSON.stringify(raw)));

  // default (no toggles) = ALL ON: multi-level noop chain contracted + deps deduped
  const on = optimizeExecutionIr(raw);
  const idsOn = on.steps.map((s) => s.id);
  assert.deepEqual(idsOn, ['Start', 'Work', 'Other'], 'noop chain removed; Work & Other stay');
  const byId = new Map(on.steps.map((s) => [s.id, s]));
  assert.deepEqual(byId.get('Start').deps, [], 'root unchanged');
  assert.deepEqual(byId.get('Work').deps, ['Start', 'Other'], 'noop chain fully collapsed, deduped');
  assert.deepEqual(byId.get('Other').deps, []);
  assert.equal(on.steps.some((s) => s.id === 'Sink'), false, 'noop sink dropped');

  // only dedupe ON: structure unchanged (noops intact), dup deps removed
  const dedupeOnly = optimizeExecutionIr(raw, { noopPassthrough: false });
  assert.deepEqual(dedupeOnly.steps.map((s) => s.id), raw.steps.map((s) => s.id));
  const dById = new Map(dedupeOnly.steps.map((s) => [s.id, s]));
  assert.deepEqual(dById.get('Noop2').deps, ['Noop1'], 'dup collapsed, order kept');
  assert.deepEqual(dById.get('Work').deps, ['Noop2', 'Other']);
  assert.deepEqual(dById.get('Noop1').deps, ['Start']);

  // only noop ON: noops contracted, raw dups survive where dedupe off
  const noopOnly = optimizeExecutionIr(raw, { dedupeDeps: false });
  const nById = new Map(noopOnly.steps.map((s) => [s.id, s]));
  assert.equal(noopOnly.steps.some((s) => s.type === 'n8n-nodes-base.noOp'), false);
  assert.deepEqual(nById.get('Work').deps, ['Start', 'Start', 'Other', 'Other'],
    'raw dups survive when dedupe off (fixpoint rewires inherited lists verbatim)');
  assert.deepEqual(nById.get('Start').deps, []);

  // purity: raw input never mutated by any combination
  assert.deepEqual(compileExecutionIr(fixture()), raw);
  assert.ok(Object.isFrozen(on) && Object.isFrozen(on.steps) && Object.isFrozen(byId.get('Work').deps));
});

test('toggles validation: unknown key / wrong type / wrong shape fail closed', () => {
  const raw = compileExecutionIr(fixture());
  assert.equal(caught(() => optimizeExecutionIr(raw, { fusion: true })).details.reason, 'unknown-toggle');
  assert.equal(caught(() => optimizeExecutionIr(raw, { dedupeDeps: 'yes' })).details.toggle, 'dedupeDeps');
  assert.equal(caught(() => optimizeExecutionIr(raw, true)).details.field, 'toggles');
  assert.equal(caught(() => optimizeExecutionIr({})).details.field, 'ir');
  assert.equal(caught(() => optimizeExecutionIr({ irVersion: 2, steps: [] })).details.field, 'ir');
  // default-ON semantics documented by the exports themselves
  assert.deepEqual([...IR_OPTIMIZATIONS], ['noopPassthrough', 'dedupeDeps']);
});

test('noop cycle guard: self-referential noop chain is skipped, never corrupted', () => {
  const wf = {
    nodes: [
      { name: 'A', type: 'n8n-nodes-base.set', typeVersion: 3 },
      { name: 'Loop', type: 'n8n-nodes-base.noOp', typeVersion: 1 },
      { name: 'B', type: 'n8n-nodes-base.set', typeVersion: 3 },
    ],
    connections: {
      A: { main: [[{ node: 'Loop', type: 'main', index: 0 }]] },
      Loop: { main: [[{ node: 'B', type: 'main', index: 0 }]] },
      B: { main: [[{ node: 'A', type: 'main', index: 0 }]] },
    },
  };
  const raw = compileExecutionIr(wf);
  const on = optimizeExecutionIr(raw); // must not throw, must not self-loop deps
  for (const step of on.steps) {
    assert.equal(step.deps.includes(step.id), false, `no self-dep on ${step.id}`);
  }
  // Loop had a single consumer (B) and dep (A) — safe to contract even in cycle
  const byId = new Map(on.steps.map((s) => [s.id, s]));
  assert.equal(byId.has('Loop'), false);
  assert.deepEqual(byId.get('B').deps, ['A']);
  // guard case: noop whose consumer appears in its OWN deps → skip (identity for that node)
  const guarded = {
    nodes: [
      { name: 'X', type: 'n8n-nodes-base.noOp', typeVersion: 1 },
      { name: 'Y', type: 'n8n-nodes-base.set', typeVersion: 3 },
    ],
    connections: {
      X: { main: [[{ node: 'Y', type: 'main', index: 0 }]] },
      Y: { main: [[{ node: 'X', type: 'main', index: 0 }]] },
    },
  };
  const g = optimizeExecutionIr(compileExecutionIr(guarded));
  const gById = new Map(g.steps.map((s) => [s.id, s]));
  // consumer Y is in noop X's deps → guard skips elimination; X remains (honest canonical-safe)
  assert.equal(gById.has('X'), true, 'cycle-guarded noop stays (no corruption)');
  assert.deepEqual(gById.get('Y').deps, ['X']);
  assert.deepEqual(gById.get('X').deps, ['Y']);
});

/* ==================================== D. CACHE — bounded LRU, fail-closed */

test('createIrCache: LRU bound enforced, promote-on-get, stats truthful', () => {
  const cache = createIrCache({ maxEntries: 2 });
  const ir = compileExecutionIr(fixture());
  const keyOf = (label) => `ir:${label}:${JSON.stringify(label)}`;
  cache.set(keyOf('a'), ir);
  cache.set(keyOf('b'), ir);
  assert.equal(cache.size, 2);
  // get 'a' promotes it; adding 'c' evicts 'b' (oldest unpromoted)
  assert.ok(cache.get(keyOf('a')) !== undefined);
  cache.set(keyOf('c'), ir);
  assert.equal(cache.size, 2, 'bound never exceeded');
  assert.equal(cache.has(keyOf('b')), false, 'LRU evicted the coldest entry');
  assert.equal(cache.has(keyOf('a')), true);
  const stats = cache.stats();
  assert.equal(stats.maxEntries, 2);
  assert.equal(stats.evictions, 1);
  assert.equal(stats.hits, 1);
  assert.equal(stats.misses, 0);
  assert.equal(stats.size, 2);
  // frozen resident value
  assert.ok(Object.isFrozen(cache.get(keyOf('a'))));
  cache.clear();
  assert.equal(cache.size, 0);
  assert.equal(cache.stats().hits, 0);
  // miss path
  assert.equal(cache.get('nope'), undefined);
  assert.equal(cache.stats().misses, 1);
});

test('createIrCache fails closed on bad config/keys/values (one error family)', () => {
  assert.equal(caught(() => createIrCache()).details.field, 'maxEntries');
  assert.equal(caught(() => createIrCache({ maxEntries: 0 })).details.field, 'maxEntries');
  assert.equal(caught(() => createIrCache({ maxEntries: 1.5 })).details.field, 'maxEntries');
  assert.equal(caught(() => createIrCache({ maxEntries: '2' })).details.field, 'maxEntries');
  const cache = createIrCache({ maxEntries: 1 });
  assert.equal(caught(() => cache.set('', compileExecutionIr(fixture()))).details.field, 'key');
  assert.equal(caught(() => cache.get(42)).details.field, 'key');
  assert.equal(caught(() => cache.set('k', { irVersion: 1 })).details.field, 'ir');
  assert.equal(caught(() => cache.set('k', {})).details.field, 'ir');
});

/* ==================================== E. PURITY — zero-import enforcement */

test('module is zero-import (purity seam scanned from source)', () => {
  assert.equal(moduleSource.includes("from 'node:"), false, 'no node: builtins');
  assert.equal(moduleSource.includes('from \'../'), false, 'no relative imports');
  assert.equal(/^\s*import\s/m.test(moduleSource), false, 'no import statements at all');
  assert.equal(/require\(/.test(moduleSource), false, 'no require calls');
});
