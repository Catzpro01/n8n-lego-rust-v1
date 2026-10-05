/**
 * P6.24 — runtime pools.
 * Contract `runtime.pool@0.1.0`.
 *
 * Matrix: the pool as declared data (workers, locality, slots, priority, policy), placements
 * that are decided rather than sampled, anti-affinity that is enforced, capacity that counts
 * outstanding work the pool cannot see, draining that keeps what it has, removal that is
 * refused while work is owed, rebalancing that moves only the future, the reads, and the walls.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { NODE_RUNTIME_LOCALITIES } from '../src/lego/node-registry.mjs';
import {
  DEFAULT_MAX_PER_IDENTITY,
  MAX_PER_IDENTITY,
  MAX_POOL_WORKERS,
  PLACEMENT_REFUSALS,
  POOL_CONTRACT,
  POOL_CONTRACT_VERSION,
  POOL_OPERATIONS,
  POOL_PERMISSIONS,
  POOL_REASONS,
  POOL_RULES,
  POOL_SCHEMA_VERSION,
  PoolError,
  WORKER_STATES,
  createPool,
  describePool,
  explainPlacement,
  explainPool,
  isPool,
  placeOnPool,
  poolDigest,
  rebalancePool,
  releasePlacement,
  setWorkerState,
  stableJson,
} from '../src/lego/runtime-pool.mjs';

/* ------------------------------------------------------------------ fixtures */

const WIRE = 'a'.repeat(64);
const WIRE_V2 = 'b'.repeat(64);

const POOL = (overrides = {}) => createPool({
  id: 'pool-1',
  workers: [
    { id: 'w-a', locality: 'js-compat', slots: 2, priority: 1 },
    { id: 'w-b', locality: 'js-compat', slots: 2, priority: 2 },
    { id: 'w-wasm', locality: 'wasm', slots: 4, priority: 0 },
  ],
  policy: { affinity: 'prefer-warm', maxPerIdentityPerWorker: 1 },
  ...overrides,
});

const PLACE = (pool, overrides = {}) => {
  const result = placeOnPool(pool, { identity: 'n8n-nodes-base.set@3.4', ioDigest: WIRE, locality: 'js-compat', tick: 0, ...overrides });
  assert.equal(result.ok, true, result.message);
  return result;
};

const throwsWith = (fn, code) => {
  let caught = null;
  try { fn(); } catch (error) { caught = error; }
  assert.ok(caught instanceof PoolError, `expected a PoolError carrying ${code}`);
  assert.equal(caught.code, 'lego.contract_violation');
  assert.equal(caught.meta.code, code);
  return caught;
};

/* ------------------------------------------------------------------ contract */

test('the contract surface is the published one: id, version, ops, closed vocabularies', () => {
  assert.equal(POOL_CONTRACT, 'runtime.pool@0.1.0');
  assert.equal(POOL_CONTRACT_VERSION, '0.1.0');
  assert.equal(POOL_SCHEMA_VERSION, 1);
  assert.deepEqual([...POOL_OPERATIONS], ['place', 'release', 'drain', 'rebalance', 'describe']);
  assert.deepEqual([...POOL_PERMISSIONS], ['node:read']);
  assert.deepEqual([...WORKER_STATES], ['accepting', 'draining', 'removed']);
  assert.equal(PLACEMENT_REFUSALS.length, 6);
  assert.equal(DEFAULT_MAX_PER_IDENTITY, 1);
  assert.equal(MAX_PER_IDENTITY, 32);
  assert.equal(MAX_POOL_WORKERS, 64);
  assert.equal(POOL_REASONS.length, 6);
  assert.match(POOL_RULES.counts, /outstanding work counts against the worker that still owes it/);
  assert.match(POOL_RULES.rebalance, /advice about the next placement; running work is never moved/);
  assert.deepEqual([...NODE_RUNTIME_LOCALITIES], ['js-compat', 'remote-worker', 'rust-native', 'wasm']);
});

test('a pool is workers and a policy, and it refuses to be declared carelessly', () => {
  const pool = POOL();
  assert.equal(isPool(pool), true);
  assert.equal(pool.workers.size, 3);
  assert.equal(pool.workers.get('w-a').state, 'accepting');
  assert.deepEqual({ ...pool.policy }, { affinity: 'prefer-warm', maxPerIdentityPerWorker: 1 });
  throwsWith(() => createPool({ id: '', workers: [] }), 'pool.input');
  throwsWith(() => createPool({ id: 'p' }), 'pool.input');
  throwsWith(() => createPool({ id: 'p', workers: [] }), 'pool.input');
  throwsWith(() => createPool({ id: 'p', workers: Array.from({ length: MAX_POOL_WORKERS + 1 }, (_, index) => ({ id: `w${index}`, locality: 'wasm', slots: 1 })) }), 'pool.input');
  throwsWith(() => createPool({ id: 'p', workers: [{ locality: 'wasm', slots: 1 }] }), 'pool.worker');
  throwsWith(() => createPool({ id: 'p', workers: [{ id: 'w', locality: 'wasm', slots: 1 }, { id: 'w', locality: 'wasm', slots: 1 }] }), 'pool.worker');
  throwsWith(() => createPool({ id: 'p', workers: [{ id: 'w', locality: 'gpu-tent', slots: 1 }] }), 'pool.worker');
  throwsWith(() => createPool({ id: 'p', workers: [{ id: 'w', locality: 'wasm', slots: 0 }] }), 'pool.worker');
  throwsWith(() => createPool({ id: 'p', workers: [{ id: 'w', locality: 'wasm', slots: 1, priority: -1 }] }), 'pool.worker');
  throwsWith(() => POOL({ policy: { affinity: 'round-robin' } }), 'pool.policy');
  throwsWith(() => POOL({ policy: { maxPerIdentityPerWorker: 0 } }), 'pool.policy');
  throwsWith(() => POOL({ policy: { maxPerIdentityPerWorker: MAX_PER_IDENTITY + 1 } }), 'pool.policy');
  throwsWith(() => POOL({ policy: [] }), 'pool.policy');
  assert.equal(isPool({ contract: POOL_CONTRACT }), false);
});

/* --------------------------------------------------------------- placement */

test('a placement is decided by declared scoring, so the same request always answers the same', () => {
  const pool = POOL();
  const first = PLACE(pool);
  assert.equal(first.placement.worker, 'w-a', 'priority 1 beats priority 2');
  assert.equal(first.placement.score.warm, false);
  assert.equal(first.placement.score.free, 2);
  assert.match(first.message, /placed 'n8n-nodes-base\.set@3\.4' on 'w-a' \(cold for this identity, 2 free of 2 before this placement, priority 1\)/);
  assert.equal(describePool(pool).placements, 1);
  assert.equal(explainPlacement(first.placement).includes('placement pool-1#1'), true);

  // A second, different identity goes to the worker with the most free capacity...
  const second = PLACE(pool, { identity: 'n8n-nodes-base.if@2.2' });
  assert.equal(second.placement.worker, 'w-b', 'w-b has two free slots and w-a has one');
  // ...and with free capacity tied, the declared priority decides: w-a (1) before w-b (2).
  const third = PLACE(pool, { identity: 'n8n-nodes-slack.slack@2.1' });
  assert.equal(third.placement.worker, 'w-a');
  assert.deepEqual({ ...third.placement.score }, { warm: false, free: 1, priority: 1 });
  // A second pool with the same declarations answers identically.
  assert.equal(PLACE(POOL()).placement.worker, first.placement.worker);
  throwsWith(() => placeOnPool(pool, { identity: 'not-an-identity', ioDigest: WIRE, locality: 'js-compat', tick: 0 }), 'pool.placement');
  throwsWith(() => placeOnPool(pool, { identity: 'a@1', locality: 'js-compat', tick: 0 }), 'pool.placement');
  throwsWith(() => placeOnPool(pool, { identity: 'a@1', ioDigest: WIRE, locality: 'js-compat' }), 'pool.input');
  throwsWith(() => placeOnPool({}, { identity: 'a@1', ioDigest: WIRE, locality: 'js-compat', tick: 0 }), 'pool.input');
});

test('affinity prefers a warm worker, and prefer-idle prefers the emptiest one', () => {
  // With the default policy (one instance per identity per worker) the second instance CANNOT
  // be warm: anti-affinity sends it elsewhere, cold.
  const spread = POOL();
  PLACE(spread);
  const elsewhere = PLACE(spread, { identity: 'n8n-nodes-base.set@3.4' });
  assert.equal(elsewhere.placement.worker, 'w-b');
  assert.equal(elsewhere.placement.score.warm, false);

  // Where two instances of an identity may share a worker, warm placement wins.
  const warm = POOL({ policy: { affinity: 'prefer-warm', maxPerIdentityPerWorker: 2 } });
  PLACE(warm);
  const again = PLACE(warm, { identity: 'n8n-nodes-base.set@3.4' });
  assert.equal(again.placement.score.warm, true);
  assert.equal(again.placement.worker, 'w-a', 'warm placement beats a worker with more free capacity, because the affinity says so');

  const idle = POOL({ policy: { affinity: 'prefer-idle', maxPerIdentityPerWorker: 2 } });
  PLACE(idle);
  const idleSecond = PLACE(idle, { identity: 'n8n-nodes-base.set@3.4' });
  assert.equal(idleSecond.placement.worker, 'w-b', 'prefer-idle sends it to the emptier worker');
  const third = PLACE(idle, { identity: 'n8n-nodes-base.set@3.4' });
  assert.equal(third.placement.worker, 'w-a', 'free capacity is now tied, so the declared priority decides');
});

test('anti-affinity is enforced, and the refusal names the limit', () => {
  const pool = POOL({ workers: [{ id: 'only', locality: 'js-compat', slots: 4, priority: 0 }] });
  PLACE(pool);
  const refused = placeOnPool(pool, { identity: 'n8n-nodes-base.set@3.4', ioDigest: WIRE, locality: 'js-compat', tick: 1 });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'pool.anti-affinity');
  assert.match(refused.message, /allows 1 instance\(s\) of 'n8n-nodes-base\.set@3\.4' per worker/);
  assert.equal(PLACEMENT_REFUSALS.includes(refused.reason), true);
  const permissive = POOL({ workers: [{ id: 'only', locality: 'js-compat', slots: 4 }], policy: { maxPerIdentityPerWorker: 2 } });
  PLACE(permissive);
  assert.equal(placeOnPool(permissive, { identity: 'n8n-nodes-base.set@3.4', ioDigest: WIRE, locality: 'js-compat', tick: 1 }).ok, true);
});

test('a locality the pool does not have is refused, and so is a locality nobody publishes', () => {
  const pool = POOL();
  const missing = placeOnPool(pool, { identity: 'a@1', ioDigest: WIRE, locality: 'rust-native', tick: 0 });
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'pool.no-worker');
  assert.match(missing.message, /a pool cannot place work on a locality it does not have/);
  const unknown = placeOnPool(pool, { identity: 'a@1', ioDigest: WIRE, locality: 'gpu-tent', tick: 0 });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.reason, 'pool.locality');
  assert.equal(placeOnPool(pool, { identity: 'a@1', ioDigest: WIRE, locality: 'wasm', tick: 0 }).placement.worker, 'w-wasm');
});

test('capacity counts the work the pool cannot see: outstanding work occupies the worker', () => {
  const pool = POOL({ workers: [{ id: 'solo', locality: 'js-compat', slots: 2 }] });
  PLACE(pool);
  assert.equal(placeOnPool(pool, { identity: 'b@1', ioDigest: WIRE, locality: 'js-compat', tick: 1 }).ok, true, 'one placement leaves one slot of two');
  const busy = placeOnPool(pool, { identity: 'c@1', ioDigest: WIRE, locality: 'js-compat', tick: 1 });
  assert.equal(busy.ok, false);
  assert.equal(busy.reason, 'pool.no-slot');
  assert.match(busy.message, /is at capacity \(solo: 2\/2\)/);
  const over = placeOnPool(pool, { identity: 'c@1', ioDigest: WIRE, locality: 'js-compat', tick: 1, outstanding: { solo: 3 } });
  assert.equal(over.ok, false);
  assert.equal(over.reason, 'pool.over-subscribed');
  assert.match(over.message, /counting only what the pool placed would place work it cannot run/);
  const census = describePool(pool, { outstanding: { solo: 3 } });
  assert.equal(census.workers[0].placed, 2);
  assert.equal(census.workers[0].outstanding, 3);
  assert.equal(census.workers[0].load, 5);
  assert.equal(census.workers[0].overSubscribed, true);
  assert.deepEqual([...census.overSubscribed], ['solo']);
  assert.match(explainPool(pool, { outstanding: { solo: 3 } }), /over-subscribed: solo/);
});

/* ------------------------------------------------------- release and drain */

test('releasing a placement is once, and it cannot be released from the wrong pool', () => {
  const pool = POOL();
  const placement = PLACE(pool).placement;
  const released = releasePlacement(pool, placement, { tick: 5 });
  assert.equal(released.released, true);
  assert.equal(released.placement.state, 'released');
  assert.match(released.message, /came off 'w-a' at tick 5/);
  assert.equal(describePool(pool).placements, 0, 'a released placement does not occupy the worker');
  assert.equal(describePool(pool).released, 1, 'and it stays in the record');
  assert.equal(placeOnPool(pool, { identity: 'n8n-nodes-base.set@3.4', ioDigest: WIRE, locality: 'js-compat', tick: 6 }).ok, true);
  assert.match(throwsWith(() => releasePlacement(pool, placement, { tick: 7 }), 'pool.placement').message, /invent a second slot/);
  assert.match(throwsWith(() => releasePlacement(pool, 'pool-1#99', { tick: 7 }), 'pool.placement').message, /would invent capacity/);
  assert.match(throwsWith(() => releasePlacement(POOL(), placement, { tick: 7 }), 'pool.placement').message, /not in this pool/);
  throwsWith(() => releasePlacement(pool, placement, {}), 'pool.input');
  throwsWith(() => releasePlacement({}, placement, { tick: 1 }), 'pool.input');
});

test('draining takes no new placements and keeps what it has; removal waits for the work', () => {
  const pool = POOL({ workers: [{ id: 'solo', locality: 'js-compat', slots: 4 }] });
  const placement = PLACE(pool).placement;
  const drained = setWorkerState(pool, { worker: 'solo', state: 'draining', tick: 2 });
  assert.equal(drained.state, 'draining');
  assert.match(drained.message, /is now 'draining' at tick 2/);
  const refused = placeOnPool(pool, { identity: 'n8n-nodes-base.set@3.4', ioDigest: WIRE, locality: 'js-compat', tick: 3 });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'pool.no-slot');
  assert.match(refused.message, /is draining or removed: solo \(draining\)/);
  assert.match(
    throwsWith(() => setWorkerState(pool, { worker: 'solo', state: 'gone', tick: 3 }), 'pool.state').message,
    /is not a worker state/,
  );
  const removal = setWorkerState(pool, { worker: 'solo', state: 'removed', tick: 3 });
  assert.equal(removal.ok, false);
  assert.equal(removal.reason, 'pool.capacity');
  assert.match(removal.message, /work does not vanish because a record says it did/);
  const removalWithOutstanding = setWorkerState(pool, { worker: 'solo', state: 'removed', tick: 3, outstanding: { solo: 1 } });
  assert.equal(removalWithOutstanding.ok, false, 'outstanding work also blocks removal');
  releasePlacement(pool, placement, { tick: 4 });
  assert.equal(setWorkerState(pool, { worker: 'solo', state: 'removed', tick: 5 }).state, 'removed');
  throwsWith(() => setWorkerState(pool, { worker: 'nobody', state: 'draining', tick: 5 }), 'pool.worker');
  throwsWith(() => setWorkerState(pool, { worker: 'solo', state: 'draining' }), 'pool.input');
});

/* ------------------------------------------------------------- rebalancing */

test('rebalancing moves the future: it names where the next placement goes and moves nothing', () => {
  // Two instances of one identity on one worker is within the policy, and still worth spreading.
  const pool = POOL({ policy: { maxPerIdentityPerWorker: 2 } });
  const first = PLACE(pool).placement;
  const second = PLACE(pool).placement;
  assert.equal(first.worker, second.worker, 'two instances may share one worker under this policy');
  const plan = rebalancePool(pool);
  assert.equal(plan.moves.length, 1);
  assert.equal(plan.moves[0].identity, 'n8n-nodes-base.set@3.4');
  assert.equal(plan.moves[0].busiest, 'w-a');
  assert.equal(plan.moves[0].instances, 2);
  assert.deepEqual({ ...plan.moves[0].spread }, { 'w-a': 2 });
  assert.equal(plan.moves[0].prefer, 'w-b', 'the next placement goes to a worker of the same locality with no instance of this identity and room');
  assert.match(plan.moves[0].note, /running work is not moved/);
  assert.match(plan.message, /1 identity\(ies\) sit on one worker/);

  // Anti-affinity already spread them, so there is nothing to say.
  const spread = POOL({ policy: { maxPerIdentityPerWorker: 1 } });
  PLACE(spread);
  PLACE(spread);
  const advice = rebalancePool(spread);
  assert.equal(advice.ok, true);
  assert.equal(advice.moves.length, 0);
  assert.match(advice.message, /every identity is spread across workers/);

  // Nowhere to move the future to: every other worker is at capacity.
  const stuck = POOL({
    workers: [{ id: 'w-a', locality: 'js-compat', slots: 4 }, { id: 'w-b', locality: 'js-compat', slots: 1 }],
    policy: { maxPerIdentityPerWorker: 2 },
  });
  PLACE(stuck);
  PLACE(stuck);
  PLACE(stuck, { identity: 'n8n-nodes-base.if@2.2' });
  const nothing = rebalancePool(stuck, { outstanding: { 'w-b': 1 } });
  assert.equal(nothing.moves[0].prefer, null, 'w-b is the only other js-compat worker and its one slot is spoken for');
  assert.match(nothing.moves[0].note, /nowhere to move the next placement/);
  // The placements themselves are untouched: a rebalance is advice, not a migration.
  assert.equal(describePool(stuck).placements, 3);
  throwsWith(() => rebalancePool({}), 'pool.input');
});

test('the census digests the pool state, and the policy travels with it', () => {
  const pool = POOL();
  PLACE(pool);
  PLACE(pool, { identity: 'n8n-nodes-base.if@2.2' });
  const described = describePool(pool, { outstanding: { 'w-b': 1 } });
  assert.equal(described.id, 'pool-1');
  assert.deepEqual({ ...described.policy }, { affinity: 'prefer-warm', maxPerIdentityPerWorker: 1 });
  assert.equal(described.placements, 2);
  assert.equal(described.workers.find((worker) => worker.id === 'w-b').outstanding, 1);
  assert.equal(described.workers.find((worker) => worker.id === 'w-b').load, 2, 'one placed plus one the pool cannot see');
  assert.equal(described.workers.find((worker) => worker.id === 'w-b').free, 0);
  assert.match(described.poolDigest, /^[0-9a-f]{64}$/);
  const { poolDigest: digest, ...body } = described;
  assert.equal(digest, poolDigest(body));
  assert.equal(stableJson({ b: 1, a: 2 }), stableJson({ a: 2, b: 1 }));
  assert.notEqual(describePool(pool).poolDigest, described.poolDigest, 'the census is a reading, and readings differ when the state does');
  throwsWith(() => describePool({}), 'pool.input');
  throwsWith(() => explainPlacement({ id: 'x' }), 'pool.input');
  assert.match(explainPlacement(PLACE(POOL()).placement), /cold for this identity/);
});

/* --------------------------------------------------------------------- walls */

test('the pool places work: no lease granting, no accounting, no scheduler, no loader', () => {
  const source = readFileSync(new URL('../src/lego/runtime-pool.mjs', import.meta.url), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const forbidden of ['node:fs', 'node:net', 'node:http', 'node:os', 'node:child_process', 'process.', 'Math.random', 'setTimeout', 'performance.', 'fetch(', 'node:vm', 'eval(']) {
    assert.equal(code.includes(forbidden), false, `the pool contract must not reference ${forbidden}`);
  }
  assert.deepEqual([...code.matchAll(/from '(node:[a-z_/]+)'/g)].map((match) => match[1]), ['node:crypto']);
  assert.equal(/\bnew Date\b|\bDate\.now\b/.test(code), false);
  for (const forbidden of ['./jit-lease.mjs', './cancel-accounting.mjs', './runtime-lease.mjs', './node-health.mjs', './canary-rollout.mjs', './io-compiler.mjs', './admission-explain.mjs']) {
    assert.equal(code.includes(forbidden), false, `P6.24 must not reach into ${forbidden}: counts arrive as data, and placement is not granting`);
  }
  assert.ok(code.includes("from './node-registry.mjs'"), 'the locality vocabulary is P6.1\'s, quoted');
  for (const name of ['requestLease', 'charge(', 'createHealthTable', 'mayServe', 'settleExecution']) {
    assert.equal(code.includes(name), false, `${name} belongs to another milestone`);
  }
});

/* ------------------------------------------------------------------- lock row */

test('the contract-lock row is canonical: one row, version, ops, tests, exports, domain path', () => {
  const lock = JSON.parse(readFileSync(new URL('../src/lego/contracts/contract-lock.json', import.meta.url)));
  const rows = lock.contracts.filter((contract) => contract.id === 'runtime.pool');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].version, POOL_CONTRACT_VERSION);
  assert.equal(rows[0].domain, 'node-registry');
  assert.equal(rows[0].status, 'implemented');
  assert.deepEqual(rows[0].surface, ['src/lego/runtime-pool.mjs']);
  assert.deepEqual(rows[0].tests, ['apps/n8n-lego/test/lego-runtime-pool.test.mjs']);
  for (const name of ['createPool', 'placeOnPool', 'releasePlacement', 'setWorkerState', 'rebalancePool', 'describePool']) {
    assert.equal(rows[0].exports['src/lego/runtime-pool.mjs'].includes(name), true, `${name} must be locked`);
  }
  for (const id of ['node.registry', 'runtime.lease', 'runtime.jit', 'runtime.cancel', 'node.io', 'registry.compiler', 'node.admission', 'node.sbom', 'node.canary', 'node.revocation']) {
    assert.equal(lock.contracts.find((contract) => contract.id === id).version, '0.1.0', `P6.24 must not re-version ${id}`);
  }
  const domain = JSON.parse(readFileSync(new URL('../src/lego/manifest/domains.json', import.meta.url)))
    .domains.find((entry) => entry.id === 'node-registry');
  assert.equal(domain.contract.id, 'node.portability');
  assert.ok(domain.paths.includes('src/lego/runtime-pool.mjs'));
});
