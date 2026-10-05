/**
 * P3 Slice K — Execution optimizer (#97: "semantics-safe node
 * fusion/elimination/caching WHERE PROVEN"): fusion planning/application with
 * pure-type whitelist + single-consumer/single-dep preconditions, and an
 * exact-fingerprint node-result cache. Contract
 * `execution.optimizer@1.0.0` (lock row 40), owner agent-1. Zero-import.
 * Elimination/canonical identity = Slice J (`execution.ir`); equivalence
 * judgment = Slice L (oracle) — this module transforms, never claims proof.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  EXECUTION_OPTIMIZER_CONTRACT, EXECUTION_OPTIMIZER_CONTRACT_VERSION,
  OPTIMIZER_PURE_TYPES, OPTIMIZER_TRANSFORMS, ExecutionOptimizerError,
  fusionPlan, applyFusion, createNodeResultCache,
} from '../src/lego/execution-optimizer.mjs';
import { compileExecutionIr, optimizeExecutionIr } from '../src/lego/execution-ir.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const LOCK = JSON.parse(readFileSync(path.join(ROOT, 'src/lego/contracts/contract-lock.json'), 'utf8'));
const ROWS = LOCK.contracts;
const moduleSource = readFileSync(path.join(ROOT, 'src/lego/execution-optimizer.mjs'), 'utf8');

function caught(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw that never happened');
}

/** Linear pure chain + an impure http node that must never fuse. */
function fixture() {
  return {
    name: 'slice K fixture',
    nodes: [
      { name: 'Start', type: 'n8n-nodes-base.start', typeVersion: 1, position: [0, 0], parameters: {} },
      { name: 'SetA', type: 'n8n-nodes-base.set', typeVersion: 3, position: [100, 0], parameters: {} },
      { name: 'SetB', type: 'n8n-nodes-base.set', typeVersion: 3, position: [200, 0], parameters: {} },
      { name: 'Http', type: 'n8n-nodes-base.httpRequest', typeVersion: 4, position: [300, 0], parameters: {} },
      { name: 'Tail', type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [400, 0], parameters: {} },
      { name: 'BranchB', type: 'n8n-nodes-base.set', typeVersion: 3, position: [200, 100], parameters: {} },
    ],
    connections: {
      Start: { main: [[{ node: 'SetA', type: 'main', index: 0 }]] },
      SetA: { main: [[{ node: 'SetB', type: 'main', index: 0 }]] },
      // SetB fans out to Http AND BranchB — chain can still fuse SetA→SetB
      // (fusion is head-ward: both of SetB's consumers rewire to SetA)
      SetB: { main: [[{ node: 'Http', type: 'main', index: 0 }, { node: 'BranchB', type: 'main', index: 0 }]] },
      Http: { main: [[{ node: 'Tail', type: 'main', index: 0 }]] },
    },
  };
}

function linearFixture() {
  // Start → SetA → SetB → Http → Tail (Http breaks the pure chain in the middle)
  return fixture();
}

function fanFixture() {
  // pure fork: Root → P, Root → Q (Root has 2 consumers — no fusion at Root)
  return {
    nodes: [
      { name: 'Root', type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [0, 0], parameters: {} },
      { name: 'P', type: 'n8n-nodes-base.set', typeVersion: 3, position: [100, -50], parameters: {} },
      { name: 'Q', type: 'n8n-nodes-base.set', typeVersion: 3, position: [100, 50], parameters: {} },
    ],
    connections: {
      Root: { main: [[{ node: 'P', type: 'main', index: 0 }, { node: 'Q', type: 'main', index: 0 }]] },
    },
  };
}

/* ============================================ A. CONTRACT / LOCK ROW 40 */

test('the lock row is the forty-first: execution.optimizer@1.0.0, owner agent-1, exports byte-parity', () => {
  const row = ROWS.find((r) => r.id === 'execution.optimizer');
  assert.ok(row, 'execution.optimizer is locked');
  assert.equal(ROWS.length, 100, 'P3 Slice M the thirty-ninth (execution.guard); P9.1 the fortieth (observability.envelope); P3 Slice K the forty-first (execution.optimizer) — P6.1 adds node.registry@0.1.0; P6.2 adds registry.compiler@0.1.0; P6.3 adds package.transaction@0.1.0; P6.4 adds registry.closure@0.1.0; P6.5 adds node.resolution@0.1.0; P6.6 adds runtime.lease@0.1.0; P6.7 adds node.residency@0.1.0; P6.8 adds node.capability@0.1.0; P6.9 adds node.semantics@0.1.0; P6.10 adds node.lifecycle@0.1.0; P6.11 adds node.health@0.1.0; P6.12 adds node.supply-chain@0.1.0; P6.13 adds registry.incremental@0.1.0; P6.14 adds node.worker-convergence@0.1.0; P6.15 adds node.acceptance@0.1.0; P6.16 adds registry.integrity@0.1.0; P6.17 adds node.admission@0.1.0; P6.18 adds node.sbom@0.1.0; P6.19 adds node.canary@0.1.0; P6.20 adds node.revocation@0.1.0; P6.21 adds node.io@0.1.0; P6.22 adds runtime.jit@0.1.0; P6.23 adds runtime.cancel@0.1.0; P6.24 adds runtime.pool@0.1.0; P6.25 adds node.abi@0.1.0; P6.26 adds runtime.wasm-cache@0.1.0; P6.27 adds node.provenance@0.1.0; P6.28 adds registry.freshness@0.1.0; P6.29 adds node.namespace@0.1.0; P6.30 adds registry.repair@0.1.0; P6.31 adds registry.acceptance@0.1.0; count-pins say 76; P2.27.1 adds lego.plugin-runtime@0.1.0 (seventy-sixth); P5.1 adds the ninety-fifth (auth.principal)'); // P9 integration (Agent 1): P9.5-P9.22 add 18 observability.* rows on top of protected main 76 -> 94 (union, zero id collisions); P9 was developed on 24032a0c (57 rows). P5.2 adds the ninety-sixth (auth.session). P5.3 adds the ninety-seventh (auth.authorization). P5.5 adds the ninety-eighth (auth.credential-crypto). P5.6 adds the ninety-ninth (auth.account-security). P5.7 adds the hundredth (auth.machine-identity).
  assert.equal(row.owner, 'agent-1');
  assert.equal(row.domain, 'execution');
  assert.equal(row.version, '1.0.0');
  assert.equal(row.status, 'implemented');
  assert.deepEqual(row.surface, ['src/lego/execution-optimizer.mjs']);
  const module_ = {
    EXECUTION_OPTIMIZER_CONTRACT, EXECUTION_OPTIMIZER_CONTRACT_VERSION,
    OPTIMIZER_PURE_TYPES, OPTIMIZER_TRANSFORMS, ExecutionOptimizerError,
    fusionPlan, applyFusion, createNodeResultCache,
  };
  const exported = Object.keys(module_).sort();
  const locked = Object.values(row.exports).flat().sort();
  assert.deepEqual(exported, locked, 'file exports match the lock');
  for (const key of locked) assert.notEqual(module_[key], undefined, key);
  assert.equal(EXECUTION_OPTIMIZER_CONTRACT_VERSION, '1.0.0');
  assert.deepEqual([...OPTIMIZER_PURE_TYPES], ['n8n-nodes-base.noOp', 'n8n-nodes-base.set']);
  assert.deepEqual([...OPTIMIZER_TRANSFORMS], ['fusion'], 'oracle toggle name');
});

/* ============================================ B. FUSION PRECONDITIONS */

test('fusionPlan: pure single-consumer/single-dep chains only — impure types never fuse', () => {
  const ir = compileExecutionIr(linearFixture());
  const { chains } = fusionPlan(ir);
  // Start is 'start' (not whitelisted) → chain can only be SetA→SetB;
  // Http is impure → chain stops before it.
  assert.equal(chains.length, 1, 'exactly one fusible chain (SetA→SetB)');
  const chain = chains[0];
  assert.equal(chain.head, 'SetA');
  assert.equal(chain.tail, 'SetB');
  assert.deepEqual([...chain.members], ['SetA', 'SetB']);
  assert.equal(chain.fusedType, 'n8n-nodes-base.set');
  assert.ok(Object.isFrozen(chain) && Object.isFrozen(chains));
  // Http (impure) is not a member of any chain
  assert.equal(chain.members.includes('Http'), false);
});

test('fusionPlan: fan-out kills fusion (not single-consumer) — fork root never collapses', () => {
  const ir = compileExecutionIr(fanFixture());
  const { chains } = fusionPlan(ir);
  assert.equal(chains.length, 0, 'Root has two consumers → no chain');
});

test('applyFusion: collapses the chain into the head, rewires consumers, records members, pure', () => {
  const def = linearFixture();
  const ir = compileExecutionIr(def);
  const plan = fusionPlan(ir);
  const fused = applyFusion(ir, plan);
  const ids = fused.steps.map((s) => s.id);
  assert.deepEqual(ids, ['Start', 'SetA', 'Http', 'Tail', 'BranchB'], 'SetB collapsed into SetA (array order kept)');
  const byId = new Map(fused.steps.map((s) => [s.id, s]));
  assert.deepEqual(byId.get('SetA').deps, ['Start'], 'head keeps its own deps');
  assert.deepEqual(byId.get('Http').deps, ['SetA'], 'Http rewired from SetB → SetA');
  assert.deepEqual(byId.get('BranchB').deps, ['SetA'], 'fork consumer BranchB rewired too');
  assert.deepEqual([...byId.get('SetA').fused], ['SetA', 'SetB'], 'audit trail of members');
  assert.deepEqual(byId.get('SetB'), undefined);
  // input IR untouched (purity) + frozen output
  assert.equal(ir.steps.length, 6, 'input IR unchanged');
  assert.deepEqual(compileExecutionIr(def), ir, 'compile is stable — fusion never mutated it');
  assert.ok(Object.isFrozen(fused) && Object.isFrozen(fused.steps) && Object.isFrozen(byId.get('SetA').deps));
  // #91(c) interop: all-off identity on the ORIGINAL still holds after using fusion
  const off = optimizeExecutionIr(ir, { noopPassthrough: false, dedupeDeps: false });
  assert.deepEqual(JSON.parse(JSON.stringify(off)), JSON.parse(JSON.stringify(ir)));
});

test('applyFusion fails closed on malformed plans (one error family)', () => {
  const ir = compileExecutionIr(linearFixture());
  assert.equal(caught(() => applyFusion(ir, null)).details.field, 'plan');
  assert.equal(caught(() => applyFusion(ir, { chains: [{}] })).details.reason, 'bad-chain');
  assert.equal(caught(() => applyFusion(ir, { chains: [{ head: 'SetA', members: ['SetA', 'Ghost'] }] })).details.reason, 'unknown-step');
  assert.equal(caught(() => applyFusion(ir, { chains: [{ head: 'SetA', members: ['SetA', 'SetB'] }, { head: 'SetB', members: ['SetB', 'Http'] }] })).details.reason, 'overlapping-chain');
  const err = caught(() => fusionPlan({}));
  assert.ok(err instanceof ExecutionOptimizerError);
  assert.equal(err.name, 'ExecutionOptimizerError');
  assert.equal(err.code, 'lego.contract_violation');
  assert.equal(caught(() => fusionPlan({ irVersion: 1, steps: [{ id: 'A', type: 't', deps: ['B'] }] })).details.reason, 'dangling-dep');
  assert.equal(caught(() => fusionPlan({ irVersion: 1, steps: [{ id: 'A', type: 't', deps: [] }, { id: 'A', type: 't', deps: [] }] })).details.reason, 'duplicate-step');
});

/* ============================================ C. SEMANTICS-SAFE CACHE */

test('node-result cache: pure whitelist only, exact fingerprint, bounded LRU, frozen values', () => {
  const cache = createNodeResultCache({ maxEntries: 2 });
  const fp = (n) => `fp:${n}`;
  cache.set({ stepType: 'n8n-nodes-base.set', fingerprint: fp(1) }, { json: { a: 1 } });
  cache.set({ stepType: 'n8n-nodes-base.noOp', fingerprint: fp(2) }, { json: { b: 2 } });
  assert.equal(cache.size, 2);
  assert.deepEqual(cache.get({ stepType: 'n8n-nodes-base.set', fingerprint: fp(1) }), { json: { a: 1 } }); // promote
  cache.set({ stepType: 'n8n-nodes-base.set', fingerprint: fp(3) }, { json: { c: 3 } });
  assert.equal(cache.size, 2, 'bound held');
  assert.equal(cache.has({ stepType: 'n8n-nodes-base.noOp', fingerprint: fp(2) }), false, 'LRU evicted coldest');
  assert.equal(cache.get({ stepType: 'n8n-nodes-base.set', fingerprint: 'fp:WRONG' }), undefined, 'exact key or nothing');
  assert.ok(Object.isFrozen(cache.get({ stepType: 'n8n-nodes-base.set', fingerprint: fp(3) })));
  const stats = cache.stats();
  assert.equal(stats.maxEntries, 2);
  assert.equal(stats.evictions, 1);
  assert.ok(stats.hits >= 1 && stats.misses >= 1);
  cache.clear();
  assert.equal(cache.size, 0);
});

test('node-result cache fails closed: impure types refused, bad config/keys rejected', () => {
  const cache = createNodeResultCache({ maxEntries: 4 });
  const impure = caught(() => cache.set({ stepType: 'n8n-nodes-base.httpRequest', fingerprint: 'x' }, {}));
  assert.ok(impure instanceof ExecutionOptimizerError);
  assert.equal(impure.details.reason, 'impure-type');
  assert.equal(cache.stats().refused, 1, 'refusal counted honestly');
  assert.equal(caught(() => cache.get({ stepType: 'n8n-nodes-base.set', fingerprint: '' })).details.field, 'fingerprint');
  assert.equal(caught(() => cache.get({ stepType: 'n8n-nodes-base.set' })).details.field, 'fingerprint');
  assert.equal(caught(() => createNodeResultCache()).details.field, 'maxEntries');
  assert.equal(caught(() => createNodeResultCache({ maxEntries: 0 })).details.field, 'maxEntries');
  assert.equal(caught(() => createNodeResultCache({ maxEntries: 2.5 })).details.field, 'maxEntries');
});

/* ============================================ D. PURITY + ORACLE INTEROP */

test('module is zero-import; fusion integrates with the oracle via toggle name', () => {
  assert.equal(/^\s*import\s/m.test(moduleSource), false, 'no import statements');
  assert.equal(moduleSource.includes("from 'node:"), false, 'no builtins');
  assert.equal(/require\(/.test(moduleSource), false, 'no require');
  assert.equal(/Date\.now|Math\.random/.test(moduleSource), false, 'no clock/randomness');
  // toggleSweep interop: caller can sweep ['fusion'] (from OPTIMIZER_TRANSFORMS)
  assert.deepEqual([...OPTIMIZER_TRANSFORMS], ['fusion']);
});
