/**
 * runtime.pool@0.1.0 — runtime pools.
 *
 * P6 milestone 24 of 31 (Issue #100). A pool is several workers that may host the same work,
 * plus the policy that decides which one does. The interesting part is not "pick a free
 * worker": it is that a pool is the place where a runtime over-subscribes itself, by counting
 * only the work it can see and forgetting the work it cannot.
 *
 * What this contract adds:
 *
 *  - A PLACEMENT IS DECIDED, NOT SAMPLED. Scoring is declared data — prefer a worker that
 *    already holds this identity and wire contract, then the most free capacity, then the
 *    declared priority, then the id — so the same pool and the same request always answer the
 *    same way. A placement that moves when nothing changed is a placement nobody can reproduce.
 *  - ANTI-AFFINITY IS ENFORCED, NOT ADVISED. A pool declares how many instances of one identity
 *    may share a worker; the next placement goes elsewhere, and when everywhere is full the
 *    answer is a refusal that names the limit.
 *  - CAPACITY COUNTS WHAT IT CANNOT SEE. Outstanding work — slots that a lease still holds,
 *    including the ones an abandoned execution kept (P6.22, P6.23, passed in as data) — counts
 *    against a worker. A pool that counts only its own bookkeeping over-subscribes the worker.
 *  - DRAINING IS NOT DELETION. A draining worker takes no new placements and keeps the work it
 *    has; a worker with outstanding work cannot be removed, because work does not vanish
 *    because a record says it did.
 *  - REBALANCING MOVES THE FUTURE. Running work is never moved by this contract: a rebalance
 *    changes where the next placement goes. Moving a running execution is a cancellation, and
 *    that is a different contract with a different record (P6.23).
 *
 * Scope walls (enforced by tests): no lease granting (P6.22) and no accounting (P6.23) — counts
 * arrive as data; no scheduler, queue or retry policy (P4); no health judgement (P6.11); no
 * rollout decision (P6.19); no admission decision (P6.17). No filesystem, network, clock,
 * randomness or shared-state mutation beyond the pool handed in — the only `node:` import is
 * the hash, and every answer takes the tick it answers for.
 *
 * Authority: this contract decides where new work is placed inside a pool. It never decides
 * that work should run, never stops anything, and never loads a node.
 */
import { createHash } from 'node:crypto';
import { NODE_RUNTIME_LOCALITIES } from './node-registry.mjs';

export const POOL_CONTRACT = 'runtime.pool@0.1.0';
export const POOL_CONTRACT_VERSION = '0.1.0';
export const POOL_SCHEMA_VERSION = 1;

export const POOL_OPERATIONS = Object.freeze(['place', 'release', 'drain', 'rebalance', 'describe']);
export const POOL_PERMISSIONS = Object.freeze(['node:read']);

/** What a worker in a pool is doing. `removed` is only reachable with nothing outstanding. */
export const WORKER_STATES = Object.freeze(['accepting', 'draining', 'removed']);

/** Why a placement was refused. A closed list, because "no capacity" is not an explanation. */
export const PLACEMENT_REFUSALS = Object.freeze(['pool.locality', 'pool.no-worker', 'pool.no-slot', 'pool.over-subscribed', 'pool.anti-affinity', 'pool.unknown']);

export const DEFAULT_MAX_PER_IDENTITY = 1;
export const MAX_PER_IDENTITY = 32;
export const MAX_POOL_WORKERS = 64;

export const POOL_REASONS = Object.freeze([
  'pool.input', 'pool.worker', 'pool.policy', 'pool.placement', 'pool.state', 'pool.capacity',
]);

export const POOL_RULES = Object.freeze({
  decided: 'a placement is decided by declared scoring, so the same request always gets the same answer',
  antiAffinity: 'anti-affinity is enforced: a pool declares how many instances of one identity may share a worker',
  counts: 'capacity counts what the pool cannot see: outstanding work counts against the worker that still owes it',
  drain: 'draining takes no new placements and keeps the work it has',
  remove: 'a worker with outstanding work cannot be removed: work does not vanish because a record says it did',
  rebalance: 'rebalancing is advice about the next placement; running work is never moved, because moving it is a cancellation (P6.23)',
  authority: 'this contract decides where new work is placed; it never decides that work should run',
});

export class PoolError extends Error {
  constructor(message, { code = 'pool.input', meta = {} } = {}) {
    super(message);
    this.name = 'PoolError';
    this.code = 'lego.contract_violation';
    this.meta = { code, ...meta };
  }
}

const fail = (message, detail = {}) => { throw new PoolError(message, detail); };

const isNonEmptyString = (value) => typeof value === 'string' && value.length > 0;
const isTick = (value) => Number.isInteger(value) && value >= 0;
const isIdentity = (value) => isNonEmptyString(value) && value.includes('@') && value.split('@').every((part) => part.length > 0);

/** Canonical JSON: key order must not change a digest. */
export function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

/** A digest over a set of fields, so a pool state can be cited by content. */
export function poolDigest(fields) {
  return sha256(stableJson(fields ?? {}));
}

/**
 * A pool is its workers and its policy. Both are frozen: a policy that can be edited while
 * placements are being decided is a policy nobody agreed to.
 */
export function createPool({ id, workers = [], policy = {} } = {}) {
  if (!isNonEmptyString(id)) fail('a pool needs an id: an unnamed pool cannot be cited when it over-subscribes', { code: 'pool.input', field: 'id' });
  if (!Array.isArray(workers) || workers.length === 0) fail('a pool has workers: an empty pool is a refusal with extra steps', { code: 'pool.input', field: 'workers' });
  if (workers.length > MAX_POOL_WORKERS) fail(`a pool of ${workers.length} workers exceeds ${MAX_POOL_WORKERS}`, { code: 'pool.input', field: 'workers' });
  const normalized = normalizePolicy(policy);
  const records = new Map();
  for (const [index, worker] of workers.entries()) {
    const record = normalizeWorker(worker, index, records);
    records.set(record.id, record);
  }
  return {
    contract: POOL_CONTRACT,
    schemaVersion: POOL_SCHEMA_VERSION,
    id,
    policy: normalized,
    workers: records,
    placements: new Map(),
    sequence: 0,
  };
}

function normalizeWorker(worker, index, records) {
  const id = worker?.id;
  if (!isNonEmptyString(id)) fail(`worker ${index} has no id`, { code: 'pool.worker', field: `workers[${index}].id` });
  if (records.has(id)) fail(`worker '${id}' is declared twice in this pool`, { code: 'pool.worker', field: `workers[${index}].id` });
  if (!NODE_RUNTIME_LOCALITIES.includes(worker?.locality)) {
    fail(`worker '${id}' declares locality '${String(worker?.locality)}', which is not one the foundation publishes (${NODE_RUNTIME_LOCALITIES.join(', ')})`, { code: 'pool.worker', field: `workers[${index}].locality` });
  }
  if (!Number.isInteger(worker?.slots) || worker.slots < 1) {
    fail(`worker '${id}' declares ${String(worker?.slots)} slots: capacity is a positive whole number`, { code: 'pool.worker', field: `workers[${index}].slots` });
  }
  const priority = worker?.priority ?? index;
  if (!Number.isInteger(priority) || priority < 0) {
    fail(`worker '${id}' declares priority ${String(priority)}: priority is a whole number, lower first`, { code: 'pool.worker', field: `workers[${index}].priority` });
  }
  return { id, locality: worker.locality, slots: worker.slots, priority, state: 'accepting', placed: 0 };
}

function normalizePolicy(policy) {
  if (policy === null || typeof policy !== 'object' || Array.isArray(policy)) {
    fail('a pool policy is an object: affinity, the per-identity limit and nothing else it invents', { code: 'pool.policy', field: 'policy' });
  }
  const affinity = policy.affinity ?? 'prefer-warm';
  if (!['prefer-warm', 'prefer-idle'].includes(affinity)) {
    fail(`affinity '${String(affinity)}' is not a placement preference this contract understands`, { code: 'pool.policy', field: 'affinity' });
  }
  const maxPerIdentity = policy.maxPerIdentityPerWorker ?? DEFAULT_MAX_PER_IDENTITY;
  if (!Number.isInteger(maxPerIdentity) || maxPerIdentity < 1 || maxPerIdentity > MAX_PER_IDENTITY) {
    fail(`maxPerIdentityPerWorker must be between 1 and ${MAX_PER_IDENTITY}; got ${String(maxPerIdentity)}`, { code: 'pool.policy', field: 'maxPerIdentityPerWorker' });
  }
  return Object.freeze({ affinity, maxPerIdentityPerWorker: maxPerIdentity });
}

export function isPool(value) {
  return Boolean(value) && typeof value === 'object' && value.contract === POOL_CONTRACT && value.workers instanceof Map && value.placements instanceof Map;
}

/** How much of a worker is spoken for: what the pool placed, plus what it is told is outstanding. */
function loadOf(pool, worker, outstanding = {}) {
  const placed = [...pool.placements.values()].filter((placement) => placement.worker === worker.id && placement.state === 'placed').length;
  const issued = outstanding[worker.id] ?? 0;
  if (!Number.isInteger(issued) || issued < 0) {
    fail(`outstanding work for '${worker.id}' must be a whole number; got ${String(issued)}`, { code: 'pool.capacity', field: 'outstanding' });
  }
  return { placed, issued, load: placed + issued };
}

const identityCountOn = (pool, worker, identity) => [...pool.placements.values()]
  .filter((placement) => placement.worker === worker.id && placement.identity === identity)
  .length;

/**
 * Placing work is a decision with a reason, and the reason is made of declared data: locality,
 * affinity, free capacity, anti-affinity, priority, id. Nothing here samples a random worker.
 */
export function placeOnPool(pool, { identity, ioDigest: wireDigest, locality, tick, outstanding = {} } = {}) {
  if (!isPool(pool)) fail('placeOnPool reads a pool made by createPool', { code: 'pool.input', field: 'pool' });
  if (!isIdentity(identity)) fail("a placement names an identity 'type@typeVersion'", { code: 'pool.placement', field: 'identity' });
  if (!isNonEmptyString(wireDigest)) fail('a placement names the wire contract digest it is for, so affinity is about the thing being placed', { code: 'pool.placement', field: 'ioDigest' });
  if (!isTick(tick)) fail('a placement happens at a tick', { code: 'pool.input', field: 'tick' });
  if (!NODE_RUNTIME_LOCALITIES.includes(locality)) {
    return refusal('pool.locality', `locality '${String(locality)}' is not one the foundation publishes (${NODE_RUNTIME_LOCALITIES.join(', ')})`, { locality });
  }
  const candidates = [...pool.workers.values()].filter((worker) => worker.locality === locality);
  if (candidates.length === 0) {
    return refusal('pool.no-worker', `no worker in pool '${pool.id}' runs '${locality}': a pool cannot place work on a locality it does not have`, { locality });
  }
  const accepting = candidates.filter((worker) => worker.state === 'accepting');
  if (accepting.length === 0) {
    const draining = candidates.map((worker) => `${worker.id} (${worker.state})`).join(', ');
    return refusal('pool.no-slot', `every '${locality}' worker in pool '${pool.id}' is draining or removed: ${draining}`, { locality });
  }

  const capacity = accepting.map((worker) => ({ worker, ...loadOf(pool, worker, outstanding) }));
  const overSubscribed = capacity.filter((entry) => entry.issued >= entry.worker.slots);
  const withSlot = capacity.filter((entry) => entry.load < entry.worker.slots);
  if (withSlot.length === 0) {
    if (overSubscribed.length > 0) {
      return refusal(
        'pool.over-subscribed',
        `every '${locality}' worker in pool '${pool.id}' is already over-subscribed by outstanding work (${overSubscribed.map((entry) => `${entry.worker.id}: ${entry.issued} outstanding of ${entry.worker.slots}`).join(', ')}): counting only what the pool placed would place work it cannot run`,
        { locality, outstanding: Object.freeze(overSubscribed.map((entry) => `${entry.worker.id}`)) },
      );
    }
    return refusal('pool.no-slot', `every '${locality}' worker in pool '${pool.id}' is at capacity (${capacity.map((entry) => `${entry.worker.id}: ${entry.load}/${entry.worker.slots}`).join(', ')})`, { locality });
  }

  const affinityOk = withSlot.filter((entry) => identityCountOn(pool, entry.worker, identity) < pool.policy.maxPerIdentityPerWorker);
  if (affinityOk.length === 0) {
    return refusal(
      'pool.anti-affinity',
      `pool '${pool.id}' allows ${pool.policy.maxPerIdentityPerWorker} instance(s) of '${identity}' per worker and every free worker already holds that many`,
      { identity, maxPerIdentityPerWorker: pool.policy.maxPerIdentityPerWorker },
    );
  }

  const scored = affinityOk.map((entry) => {
    const warm = identityCountOn(pool, entry.worker, identity) > 0;
    return {
      entry,
      warm,
      free: entry.worker.slots - entry.load,
      score: Object.freeze({ warm, free: entry.worker.slots - entry.load, priority: entry.worker.priority }),
    };
  });
  scored.sort((left, right) => {
    if (pool.policy.affinity === 'prefer-warm' && left.warm !== right.warm) return left.warm ? -1 : 1;
    if (pool.policy.affinity === 'prefer-idle' && left.free !== right.free) return right.free - left.free;
    if (left.warm !== right.warm) return left.warm ? -1 : 1;
    if (left.free !== right.free) return right.free - left.free;
    if (left.entry.worker.priority !== right.entry.worker.priority) return left.entry.worker.priority - right.entry.worker.priority;
    return left.entry.worker.id < right.entry.worker.id ? -1 : 1;
  });

  const chosen = scored[0];
  pool.sequence += 1;
  const placement = Object.freeze({
    contract: POOL_CONTRACT,
    id: `${pool.id}#${pool.sequence}`,
    identity,
    ioDigest: wireDigest,
    worker: chosen.entry.worker.id,
    locality,
    placedAt: tick,
    score: chosen.score,
    state: 'placed',
  });
  pool.placements.set(placement.id, placement);
  chosen.entry.worker.placed = loadOf(pool, chosen.entry.worker, outstanding).placed;
  return Object.freeze({
    ok: true,
    placement,
    load: chosen.entry.load + 1,
    slots: chosen.entry.worker.slots,
    message: `placed '${identity}' on '${chosen.entry.worker.id}' (${chosen.warm ? 'warm' : 'cold'} for this identity, ${chosen.free} free of ${chosen.entry.worker.slots} before this placement, priority ${chosen.entry.worker.priority})`,
  });
}

function refusal(reason, message, detail) {
  return Object.freeze({ ok: false, reason, message, detail: Object.freeze(detail ?? {}) });
}

/**
 * Releasing a placement is how the pool learns an execution ended — or that it did not (the
 * caller passes outstanding counts in, and an abandoned execution keeps counting).
 */
export function releasePlacement(pool, placement, { tick } = {}) {
  if (!isPool(pool)) fail('releasePlacement reads a pool made by createPool', { code: 'pool.input', field: 'pool' });
  if (!isTick(tick)) fail('a release happens at a tick', { code: 'pool.input', field: 'tick' });
  const id = typeof placement === 'string' ? placement : placement?.id;
  const held = pool.placements.get(id) ?? null;
  if (!held) fail(`placement '${String(id)}' is not in this pool: releasing what was never placed would invent capacity`, { code: 'pool.placement', field: 'placement' });
  if (held.state === 'released') {
    fail(`placement '${held.id}' was released at tick ${held.releasedAt}: releasing it twice would invent a second slot`, { code: 'pool.placement', field: 'state' });
  }
  pool.placements.set(held.id, Object.freeze({ ...held, state: 'released', releasedAt: tick }));
  return Object.freeze({ ok: true, released: true, placement: pool.placements.get(held.id), tick, message: `'${held.identity}' came off '${held.worker}' at tick ${tick}` });
}

/**
 * Draining a worker stops new placements on it and changes nothing about the work it has. A
 * worker with outstanding work cannot be removed: work does not vanish because a record says it
 * did.
 */
export function setWorkerState(pool, { worker, state, tick, outstanding = {} } = {}) {
  if (!isPool(pool)) fail('setWorkerState reads a pool made by createPool', { code: 'pool.input', field: 'pool' });
  const target = pool.workers.get(worker) ?? null;
  if (!target) fail(`worker '${String(worker)}' is not in pool '${pool.id}'`, { code: 'pool.worker', field: 'worker' });
  if (!WORKER_STATES.includes(state)) {
    fail(`'${String(state)}' is not a worker state (${WORKER_STATES.join(', ')})`, { code: 'pool.state', field: 'state' });
  }
  if (!isTick(tick)) fail('a worker state change records the tick it happened at', { code: 'pool.input', field: 'tick' });
  const load = loadOf(pool, target, outstanding);
  if (state === 'removed' && load.load > 0) {
    return Object.freeze({
      ok: false,
      reason: 'pool.capacity',
      message: `worker '${target.id}' still owes ${load.load} placement(s) (${load.placed} placed, ${load.issued} outstanding): work does not vanish because a record says it did`,
      detail: Object.freeze({ placed: load.placed, outstanding: load.issued }),
    });
  }
  target.state = state;
  return Object.freeze({ ok: true, worker: target.id, state, tick, message: `'${target.id}' is now '${state}' at tick ${tick}` });
}

/**
 * A rebalance is advice about the future: which worker the next placement should avoid. Running
 * work is never moved here — moving it would be a cancellation, and that is P6.23's record.
 */
/**
 * A rebalance is advice about the future. Concentration within the policy is legal and still
 * worth spreading: when every instance of an identity sits on one worker while another worker
 * has room, the next placement should go elsewhere. Running work is NEVER moved here — moving a
 * running execution is a cancellation, and that is a different contract with a different record.
 */
export function rebalancePool(pool, { outstanding = {} } = {}) {
  if (!isPool(pool)) fail('rebalancePool reads a pool made by createPool', { code: 'pool.input', field: 'pool' });
  const perIdentity = new Map();
  for (const placement of pool.placements.values()) {
    if (placement.state !== 'placed') continue;
    const list = perIdentity.get(placement.identity) ?? [];
    list.push(placement);
    perIdentity.set(placement.identity, list);
  }
  const moves = [];
  for (const [identity, list] of [...perIdentity.entries()].sort()) {
    const perWorker = new Map();
    for (const placement of list) perWorker.set(placement.worker, (perWorker.get(placement.worker) ?? 0) + 1);
    const spread = [...perWorker.entries()].sort((left, right) => (right[1] - left[1]) || (left[0] < right[0] ? -1 : 1));
    const [busiest, count] = spread[0];
    if (count <= 1) continue;
    // Advice stays inside the locality: a placement names the locality it needs, so sending the
    // next one to a worker of another locality would be advice about a request nobody made.
    const busiestLocality = pool.workers.get(busiest)?.locality ?? null;
    const alternatives = [...pool.workers.values()]
      .filter((worker) => worker.state === 'accepting' && worker.id !== busiest && worker.locality === busiestLocality)
      .map((worker) => ({ worker, ...loadOf(pool, worker, outstanding), instances: perWorker.get(worker.id) ?? 0 }))
      .filter((entry) => entry.load < entry.worker.slots)
      .sort((left, right) => (left.instances - right.instances) || (left.load - right.load) || (left.worker.priority - right.worker.priority) || (left.worker.id < right.worker.id ? -1 : 1));
    moves.push(Object.freeze({
      identity,
      busiest,
      instances: count,
      spread: Object.freeze(Object.fromEntries(spread)),
      prefer: alternatives.length === 0 ? null : alternatives[0].worker.id,
      note: alternatives.length === 0
        ? 'nowhere to move the next placement: every other worker is at capacity, draining or removed, so this stays until something is released'
        : 'the next placement for this identity goes here; running work is not moved',
    }));
  }
  const policyLimit = pool.policy.maxPerIdentityPerWorker;
  return Object.freeze({
    ok: true,
    moves: Object.freeze(moves),
    message: moves.length === 0
      ? `pool '${pool.id}' has nothing to rebalance: every identity is spread across workers`
      : `${moves.length} identity(ies) sit on one worker (the policy allows ${policyLimit} per worker, and this is advice about the next placement)`,
  });
}

/** The state a pool is judged by: per worker, what it may take and what it still owes. */
export function describePool(pool, { outstanding = {} } = {}) {
  if (!isPool(pool)) fail('describePool reads a pool made by createPool', { code: 'pool.input', field: 'pool' });
  const workers = [...pool.workers.values()].map((worker) => {
    const load = loadOf(pool, worker, outstanding);
    return Object.freeze({
      id: worker.id,
      locality: worker.locality,
      state: worker.state,
      slots: worker.slots,
      placed: load.placed,
      outstanding: load.issued,
      load: load.load,
      free: worker.slots - load.load,
      overSubscribed: load.load > worker.slots,
    });
  }).sort((left, right) => (left.id < right.id ? -1 : 1));
  const body = {
    contract: POOL_CONTRACT,
    id: pool.id,
    policy: pool.policy,
    workers: Object.freeze(workers),
    placements: [...pool.placements.values()].filter((placement) => placement.state === 'placed').length,
    released: [...pool.placements.values()].filter((placement) => placement.state === 'released').length,
    overSubscribed: Object.freeze(workers.filter((worker) => worker.overSubscribed).map((worker) => worker.id)),
  };
  return Object.freeze({ ...body, poolDigest: poolDigest(body) });
}

export function explainPool(pool, { outstanding = {} } = {}) {
  const described = describePool(pool, { outstanding });
  const parts = described.workers.map((worker) => `${worker.id} ${worker.state} ${worker.load}/${worker.slots}${worker.outstanding > 0 ? ` (${worker.outstanding} outstanding)` : ''}`);
  const over = described.overSubscribed.length === 0 ? '' : ` — over-subscribed: ${described.overSubscribed.join(', ')}`;
  return `pool ${described.id} (${described.policy.affinity}, max ${described.policy.maxPerIdentityPerWorker} per identity per worker): ${parts.join('; ')}${over}`;
}

export function explainPlacement(placement) {
  if (!placement || typeof placement !== 'object' || placement.contract !== POOL_CONTRACT || !isNonEmptyString(placement.id)) {
    fail('explainPlacement reads a placement made by placeOnPool', { code: 'pool.input', field: 'placement' });
  }
  return `placement ${placement.id}: '${placement.identity}' on '${placement.worker}' (${placement.locality}) ${placement.state} at tick ${placement.placedAt} — ${placement.score.warm ? 'warm' : 'cold'} for this identity, ${placement.score.free} free`;
}
