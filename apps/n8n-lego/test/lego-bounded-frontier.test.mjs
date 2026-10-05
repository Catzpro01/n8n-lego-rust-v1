/**
 * P3 Slice D — bounded runtime primitive (Issues #75/#97/#79, marathon §30).
 *
 * Proves: capacity IS the bound (ring, depth ≤ capacity everywhere) · explicit
 * admission outcomes (admitted | backpressure/lego.backpressure) · no silent
 * loss (batch arithmetic; refused items never retained; re-offer after drain
 * succeeds) · bounded takeBatch (consumer cannot over-pull) · FIFO order ·
 * observability stats · pure structure (no clock/fs/network/timers) ·
 * execution domain stays mustNotDependOn workflow (zero cross-domain imports).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BoundedFrontierError,
  FRONTIER_CONTRACT,
  FRONTIER_CONTRACT_VERSION,
  FRONTIER_MAX_CAPACITY,
  FRONTIER_OUTCOME,
  createBoundedFrontier,
} from '../src/lego/bounded-frontier.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const read = (relative) => readFileSync(join(REPO_ROOT, relative), 'utf8');
const LOCK = JSON.parse(read('apps/n8n-lego/src/lego/contracts/contract-lock.json'));
const ROWS = LOCK.contracts ?? LOCK;
const DOMAINS = JSON.parse(read('apps/n8n-lego/src/lego/manifest/domains.json'));
const EXECUTION = (DOMAINS.domains ?? DOMAINS).find((d) => d.id === 'execution');
const ERRORS = JSON.parse(read('apps/n8n-lego/src/lego/contracts/errors.contract.json'));
const SOURCE = read('apps/n8n-lego/src/lego/bounded-frontier.mjs');

const caught = (fn) => {
  try { fn(); return null; } catch (error) { return error; }
};

/* ======================================== A. CONTRACT / LOCK ROW (34th) */

test('the lock row is the thirty-fourth: execution.frontier@0.1.0, owner agent-1, exports byte-parity', () => {
  const row = ROWS.find((r) => r.id === 'execution.frontier');
  assert.ok(row, 'execution.frontier is locked');
  // P9.1 envelope + P3 optimizer are merged; P9.2 structured-log adds row 42.
  assert.equal(ROWS.length, 100, 'P3 Slice D adds the thirty-fourth (execution.frontier); P3 Slice E adds the thirty-fifth (execution.state-stream); P3 Slice H adds the thirty-sixth (workflow.dna); P3 Slice J the thirty-seventh (execution.ir); P3 Slice L the thirty-eighth (compatibility.oracle); P3 Slice M the thirty-ninth (execution.guard) — P6.1 adds node.registry@0.1.0; P6.2 adds registry.compiler@0.1.0; P6.3 adds package.transaction@0.1.0; P6.4 adds registry.closure@0.1.0; P6.5 adds node.resolution@0.1.0; P6.6 adds runtime.lease@0.1.0; P6.7 adds node.residency@0.1.0; P6.8 adds node.capability@0.1.0; P6.9 adds node.semantics@0.1.0; P6.10 adds node.lifecycle@0.1.0; P6.11 adds node.health@0.1.0; P6.12 adds node.supply-chain@0.1.0; P6.13 adds registry.incremental@0.1.0; P6.14 adds node.worker-convergence@0.1.0; P6.15 adds node.acceptance@0.1.0; P6.16 adds registry.integrity@0.1.0; P6.17 adds node.admission@0.1.0; P6.18 adds node.sbom@0.1.0; P6.19 adds node.canary@0.1.0; P6.20 adds node.revocation@0.1.0; P6.21 adds node.io@0.1.0; P6.22 adds runtime.jit@0.1.0; P6.23 adds runtime.cancel@0.1.0; P6.24 adds runtime.pool@0.1.0; P6.25 adds node.abi@0.1.0; P6.26 adds runtime.wasm-cache@0.1.0; P6.27 adds node.provenance@0.1.0; P6.28 adds registry.freshness@0.1.0; P6.29 adds node.namespace@0.1.0; P6.30 adds registry.repair@0.1.0; P6.31 adds registry.acceptance@0.1.0; count-pins say 76; P2.27.1 adds lego.plugin-runtime@0.1.0 (seventy-sixth); P5.1 adds the ninety-fifth (auth.principal)'); // P9 integration (Agent 1): P9.5-P9.22 add 18 observability.* rows on top of protected main 76 -> 94 (union, zero id collisions); P9 was developed on 24032a0c (57 rows). P5.2 adds the ninety-sixth (auth.session). P5.3 adds the ninety-seventh (auth.authorization). P5.5 adds the ninety-eighth (auth.credential-crypto). P5.6 adds the ninety-ninth (auth.account-security). P5.7 adds the hundredth (auth.machine-identity).
  assert.equal(row.owner, 'agent-1', 'Issue #98: Agent 1 owns the bounded frontier');
  assert.equal(row.domain, 'execution');
  assert.equal(row.version, '0.1.0', 'R9: matches the execution domain contract version (0.1.0)');
  assert.equal(row.status, 'implemented');
  assert.deepEqual(row.surface, ['src/lego/bounded-frontier.mjs']);
  const module_ = {
    BoundedFrontierError, FRONTIER_CONTRACT, FRONTIER_CONTRACT_VERSION,
    FRONTIER_MAX_CAPACITY, FRONTIER_OUTCOME, createBoundedFrontier,
  };
  const locked = row.exports['src/lego/bounded-frontier.mjs'];
  assert.deepEqual([...locked].sort(), Object.keys(module_).sort(), 'lock ⇄ module exports');
  assert.deepEqual([...locked], [...locked].slice().sort(), 'sorted ASCII');
  assert.deepEqual(row.tests, ['apps/n8n-lego/test/lego-bounded-frontier.test.mjs']);
  assert.equal('operations' in row, false, 'no capability/REST surface in Slice D (by design)');
  assert.equal('permissions' in row, false);
  assert.equal(FRONTIER_CONTRACT.id, row.id);
  assert.equal(FRONTIER_CONTRACT_VERSION, row.version);
  assert.equal(FRONTIER_CONTRACT.owner, row.owner);
});

test('the execution domain owns the module; no capability added; no workflow dependency (Issue #98 boundary)', () => {
  assert.ok(EXECUTION.paths.includes('src/lego/bounded-frontier.mjs'));
  assert.equal(EXECUTION.status, 'partial', 'domain status unchanged by a slice');
  assert.ok(EXECUTION.mustNotDependOn.includes('workflow'), 'execution must NOT depend on workflow');
  assert.equal('workflow' in Object.fromEntries(EXECUTION.dependsOn.map((d) => [d, true])), false,
    'dependsOn stays without workflow');
  // the module imports NOTHING — a pure structure cannot violate the domain boundary
  assert.equal(/^\s*import\s/m.test(SOURCE), false, 'zero imports (no cross-domain coupling possible)');
  assert.equal(ERRORS.version, '1.2.0', 'errors contract untouched');
  const published = new Set((ERRORS.codes ?? ERRORS.errors ?? []).map((e) => e.code ?? e.id));
  for (const match of SOURCE.matchAll(/'(lego\.[a-z0-9_]+)'/g)) {
    assert.ok(published.has(match[1]), `${match[1]} is published`);
  }
  assert.ok(published.has('lego.backpressure'), 'backpressure outcome code was already published');
});

/* ============================================== B. VALIDATION (FAIL-CLOSED) */

test('capacity is required and validated in the one error family', () => {
  assert.equal(caught(() => createBoundedFrontier()).details.field, 'capacity', 'no default bound — ever');
  assert.equal(caught(() => createBoundedFrontier({})).details.field, 'capacity');
  for (const bad of [0, -1, 1.5, '8', Number.NaN, FRONTIER_MAX_CAPACITY + 1, Number.MAX_SAFE_INTEGER + 2]) {
    const error = caught(() => createBoundedFrontier({ capacity: bad }));
    assert.ok(error instanceof BoundedFrontierError, `capacity ${bad} refuses`);
    assert.equal(error.code, 'lego.contract_violation');
    assert.equal(error.details.field, 'capacity');
  }
  assert.match(caught(() => createBoundedFrontier({ capacity: 0 })).message, /1\.\.1048576/);
  assert.equal(caught(() => createBoundedFrontier(null)).details.field, 'options');
  assert.equal(caught(() => createBoundedFrontier([])).details.field, 'options');
  assert.equal(caught(() => createBoundedFrontier({ capacity: 1 }).offer()).details.field, 'item');
  assert.equal(caught(() => createBoundedFrontier({ capacity: 2 }).offerBatch('nope')).details.field, 'items');
  assert.equal(caught(() => createBoundedFrontier({ capacity: 2 }).offerBatch([null, undefined])).details.field, 'items');
  const frontier = createBoundedFrontier({ capacity: 2 });
  assert.equal(caught(() => frontier.takeBatch(-1)).details.field, 'max');
  assert.equal(caught(() => frontier.takeBatch(3)).details.field, 'max', 'cannot ask past capacity');
  assert.equal(caught(() => frontier.takeBatch(1.5)).details.field, 'max');
});

/* ================================ C. THE BOUND / EXPLICIT ADMISSION OUTCOMES */

test('depth never exceeds capacity: flood admits exactly capacity, then explicit backpressure', () => {
  const capacity = 64;
  const frontier = createBoundedFrontier({ capacity });
  assert.equal(frontier.capacity(), capacity);
  assert.equal(frontier.isFull(), false);
  const firstBackpressure = [];
  for (let i = 0; i < capacity; i += 1) {
    const outcome = frontier.offer({ seq: i });
    assert.equal(outcome.status, FRONTIER_OUTCOME.ADMITTED);
    assert.equal(outcome.depth, i + 1);
    assert.ok(frontier.depth() <= capacity, `depth ${frontier.depth()} ≤ capacity after offer ${i}`);
    if (i >= capacity - 2) firstBackpressure.push(outcome);
  }
  assert.equal(frontier.isFull(), true);
  assert.equal(frontier.depth(), capacity, 'ring admits exactly capacity items');
  const refused = frontier.offer({ seq: 'lost?' });
  assert.equal(refused.status, FRONTIER_OUTCOME.BACKPRESSURE);
  assert.equal(refused.code, 'lego.backpressure', 'explicit published outcome state');
  assert.equal(refused.depth, capacity, 'refusal does not change depth');
  assert.equal(frontier.depth(), capacity, 'the refused item was never allocated into the queue');
  const stats = frontier.stats();
  assert.equal(stats.admitted, capacity);
  assert.equal(stats.backpressured, 1);
  assert.equal(stats.peakDepth, capacity, 'peak depth observed = the bound');
  assert.equal(stats.depth, capacity);
  assert.equal(stats.served, 0);
});

test('FIFO order holds across offer/take/takeBatch interleavings (deterministic)', () => {
  const frontier = createBoundedFrontier({ capacity: 8 });
  for (const v of ['a', 'b', 'c', 'd']) frontier.offer(v);
  assert.equal(frontier.take(), 'a');
  frontier.offer('e');
  assert.deepEqual(frontier.takeBatch(2), ['b', 'c']);
  for (const v of ['f', 'g', 'h', 'i', 'j']) frontier.offer(v); // fills to 8? depth: after takes = 4-2+... 
  // depth now: 4 -1 +1 -2 =2 ('e','f') + g,h,i,j = 6 → offer j: 7? recount below via stats
  const rest = frontier.takeBatch(frontier.capacity());
  assert.deepEqual(rest, ['d', 'e', 'f', 'g', 'h', 'i', 'j'], 'FIFO across wraparound of the ring');
  assert.equal(frontier.isEmpty(), true);
  assert.equal(frontier.take(), undefined, 'empty take is undefined, not an error');
  assert.equal(frontier.takeBatch(3).length, 0, 'empty batch drain');
});

test('offerBatch = bounded fan-out: exact counts, input order, arithmetic proof of no silent loss', () => {
  const frontier = createBoundedFrontier({ capacity: 5 });
  const batch = Array.from({ length: 12 }, (_, i) => ({ n: i }));
  const outcome = frontier.offerBatch(batch);
  assert.equal(outcome.admitted + outcome.backpressured, batch.length, 'every input item is accounted for');
  assert.equal(outcome.admitted, 5, 'admits exactly up to the bound');
  assert.equal(outcome.backpressured, 7, 'the excess is explicit, not dropped in silence');
  assert.equal(outcome.depth, 5);
  const drained = frontier.takeBatch(frontier.capacity());
  assert.deepEqual(drained.map((x) => x.n), [0, 1, 2, 3, 4], 'admitted items kept input order');
  // after drain the previously refused tail admits — capacity still bounds each round
  const retry = frontier.offerBatch(batch.slice(5));
  assert.equal(retry.admitted, 5, 'pressure subsided → exactly capacity admits again');
  assert.equal(retry.backpressured, 2, 'the remaining tail stays explicit — still owned by the producer');
  assert.deepEqual(frontier.takeBatch(5).map((x) => x.n), [5, 6, 7, 8, 9], 'second round keeps input order');
  const finalRetry = frontier.offerBatch(batch.slice(10));
  assert.equal(finalRetry.admitted, 2, 'the last tail admits on the next round');
  assert.equal(finalRetry.backpressured, 0);
  assert.deepEqual(frontier.takeBatch(5).map((x) => x.n), [10, 11], 'third round completes the tail');
  const finalStats = frontier.stats();
  assert.equal(finalStats.admitted, 12, 'over three rounds, all 12 admitted eventually');
  assert.equal(finalStats.backpressured, 9, '7 + 2 refusals counted exactly — none silently lost');
  assert.equal(finalStats.served, 12);
});

test('takeBatch is a bounded active set: never more than requested, never past depth', () => {
  const frontier = createBoundedFrontier({ capacity: 10 });
  frontier.offerBatch(Array.from({ length: 6 }, (_, i) => i));
  assert.equal(caught(() => frontier.takeBatch(100)).details.field, 'max',
    'max > capacity refuses BEFORE pulling anything');
  assert.equal(frontier.stats().served, 0, 'the refused pull served nothing');
  assert.equal(frontier.depth(), 6, 'the refused pull pulled nothing');
  const pulled = frontier.takeBatch(4);
  assert.equal(pulled.length, 4, 'never more than requested');
  assert.equal(frontier.depth(), 2, 'never past depth');
  const rest = frontier.takeBatch(2);
  assert.equal(rest.length, 2);
  assert.equal(frontier.depth(), 0);
  // asking exactly capacity is legal on an empty frontier (returns [])
  assert.deepEqual(frontier.takeBatch(frontier.capacity()), []);
});

/* =============================== D. PRESSURE → RECOVERY (Issue #79 direction) */

test('producer flood cannot grow the queue: recovery works after drain (primitive-level resume)', () => {
  const capacity = 64;
  const frontier = createBoundedFrontier({ capacity });
  const flood = Array.from({ length: 10000 }, (_, i) => ({ seq: i, payload: `p${i}` }));
  const outcome = frontier.offerBatch(flood);
  assert.equal(outcome.admitted, capacity, 'admission stops at the bound');
  assert.equal(outcome.backpressured, flood.length - capacity, 'every refused item is counted, none retained');
  assert.equal(frontier.depth(), capacity, 'queue depth pinned at capacity under a 10k flood');
  const stats = frontier.stats();
  assert.equal(stats.peakDepth, capacity, 'peak depth never exceeded the bound');
  // drain everything the frontier owns …
  const drained = frontier.takeBatch(capacity);
  assert.equal(drained.length, capacity);
  assert.equal(frontier.isEmpty(), true);
  assert.equal(frontier.stats().served, capacity);
  // … then admission resumes with the items the producer still owns
  const retryItem = flood[capacity]; // the first refused item
  const retry = frontier.offer(retryItem);
  assert.equal(retry.status, FRONTIER_OUTCOME.ADMITTED, 'after drain, backpressured work admits again');
  assert.equal(frontier.take(), retryItem, 'the exact refused item arrives intact');
  assert.equal(frontier.stats().backpressured, flood.length - capacity, 'counters never paper over the refusal');
});

/* ================================== E. PURITY / OBSERVABILITY / IMMUTABILITY */

test('the frontier is a pure structure: no clock, fs, network, timers, or randomness', () => {
  for (const forbidden of [/node:fs/, /node:http/, /node:net/, /node:crypto/, /setTimeout/, /setInterval/, /Date\.now/, /Math\.random/, /process\./]) {
    assert.equal(forbidden.test(SOURCE), false, `${forbidden} must not appear — pure bounded structure`);
  }
  assert.equal(/^\s*import\s/m.test(SOURCE), false, 'zero imports at all');
  // determinism: two identical sequences produce identical stats and drain orders
  const build = () => {
    const f = createBoundedFrontier({ capacity: 4 });
    f.offerBatch(['x', 'y', 'z']);
    f.take();
    f.offer('w');
    f.offer('v'); // backpressure? depth: 3+1=4 then v refused
    return { order: f.takeBatch(4), stats: f.stats() };
  };
  assert.deepEqual(build(), build(), 'same inputs → same outputs and counters (no hidden clock/randomness)');
});

test('stats and outcomes are frozen copies — callers cannot corrupt frontier bookkeeping', () => {
  const frontier = createBoundedFrontier({ capacity: 3 });
  frontier.offer('a');
  const stats = frontier.stats();
  assert.equal(Object.isFrozen(stats), true);
  assert.throws(() => { 'use strict'; stats.depth = 999; }, TypeError);
  assert.equal(frontier.stats().depth, 1, 'external mutation never lands inside');
  const outcome = frontier.offer('b');
  assert.equal(Object.isFrozen(outcome), true);
  assert.equal(Object.isFrozen(frontier), true, 'the public surface itself is frozen');
  assert.equal(frontier.contract, FRONTIER_CONTRACT);
  // falsy-but-defined items travel losslessly (0/null/false/'' are values, not absence)
  const items = [0, null, false, ''];
  const f2 = createBoundedFrontier({ capacity: 4 });
  for (const item of items) assert.equal(f2.offer(item).status, FRONTIER_OUTCOME.ADMITTED);
  assert.deepEqual(f2.takeBatch(4), items, 'falsy payloads roundtrip unchanged');
});
