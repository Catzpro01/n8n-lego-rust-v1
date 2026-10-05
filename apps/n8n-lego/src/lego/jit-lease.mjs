/**
 * runtime.jit@0.1.0 — just-in-time leases for runtime slots.
 *
 * P6 milestone 22 of 31 (Issue #100). A worker does not hold every node implementation it
 * might be asked to run: it holds slots, and it fills a slot when work for a node actually
 * arrives. That is what keeps memory bounded and what makes a cold start a decision rather
 * than an accident. This contract is the bookkeeping that makes the decision enforceable.
 *
 * What it adds beyond a counter:
 *
 *  - A LEASE NAMES WHAT IT IS FOR. Identity (`type@typeVersion`), the wire contract digest it
 *    was granted against (P6.21) and the worker's locality. A lease granted for one wire
 *    contract is not a licence for the next version of it: when the digest moves, the lease
 *    is `stale` and is refused rather than silently reused.
 *  - SLOTS ARE THE RESOURCE, AND THEY COME BACK BY THEMSELVES. Capacity is per worker. A
 *    slot is NOT held by a lease that has already expired — even if nobody has swept it yet —
 *    so a request lazily expires what is dead before counting what is live. A host that
 *    refuses work because of its own bookkeeping is a host that lies.
 *  - AN IDLE LEASE CANNOT BE RENEWED. Renewal requires that the lease was used since the last
 *    renewal: a slot held with paperwork is a leak, and this contract makes it expire instead
 *    of extending it.
 *  - A JIT LEASE IS SHORT BY CONSTRUCTION. Time to live is bounded, the total life from grant
 *    is bounded, and the renewals are bounded. A lease that can be extended forever is not
 *    just-in-time; it is a role.
 *  - EXPIRY IS NOT DELETION. An expired lease keeps its record (who held a slot, for what,
 *    and when it lapsed) and `release` on an expired lease is bookkeeping, not a second event.
 *
 * Scope walls (enforced by tests): no scheduling or queueing (P4) — a request that does not
 * fit is refused, and queueing is somebody else's decision; no execution leases for epochs
 * (P6.10 owns those); no health judgement (P6.11); no admission decision (P6.17); no cache
 * implementation (P6.26); no pool management (P6.24). No filesystem, network, clock,
 * randomness or shared-state mutation of anything but the table handed in — the only `node:`
 * import is the hash, and every answer takes the tick it answers for.
 *
 * Authority: this contract decides whether a slot may be used, for how long, and for what. It
 * never decides that a node should run somewhere, and it never loads anything.
 */
import { createHash } from 'node:crypto';
import { NODE_RUNTIME_LOCALITIES } from './node-registry.mjs';

export const JIT_CONTRACT = 'runtime.jit@0.1.0';
export const JIT_CONTRACT_VERSION = '0.1.0';
export const JIT_SCHEMA_VERSION = 1;

export const JIT_OPERATIONS = Object.freeze(['request', 'use', 'renew', 'release', 'reap', 'describe']);
export const JIT_PERMISSIONS = Object.freeze(['node:read']);

/** Where a lease stands. `expired` keeps its record; `released` is the holder letting go. */
export const JIT_LEASE_STATES = Object.freeze(['active', 'expired', 'released']);

export const DEFAULT_TTL_TICKS = 30;
export const MAX_TTL_TICKS = 120;
export const DEFAULT_MAX_RENEWALS = 2;
export const MAX_RENEWALS = 8;
export const MAX_SLOTS_PER_WORKER = 64;

export const JIT_REASONS = Object.freeze([
  'jit.input', 'jit.worker', 'jit.capacity', 'jit.lease', 'jit.expired', 'jit.stale', 'jit.idle', 'jit.ttl',
]);

export const JIT_RULES = Object.freeze({
  slots: 'capacity is per worker: a shared counter would let one node push another out of a slot nobody granted',
  lazyExpiry: 'a slot is not held by a lease that has already expired, even if nobody has swept it yet',
  bound: 'a lease names the identity, the wire contract digest and the locality it was granted for',
  stale: 'a lease granted for one wire contract is not reused after the wire contract moves',
  idle: 'an idle lease cannot be renewed: a slot held with paperwork is a leak, so it expires instead',
  short: 'time to live, total life from grant and renewals are all bounded: a JIT lease is short by construction',
  record: 'expiry is not deletion: who held a slot, for what and when it lapsed stays readable',
  authority: 'this contract decides whether a slot may be used and for how long; it never decides whether a node should run',
});

export class JitError extends Error {
  constructor(message, { code = 'jit.input', meta = {} } = {}) {
    super(message);
    this.name = 'JitError';
    this.code = 'lego.contract_violation';
    this.meta = { code, ...meta };
  }
}

const fail = (message, detail = {}) => { throw new JitError(message, detail); };

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

/** A digest over a set of fields, so a census can be cited by content. */
export function leaseDigest(fields) {
  return sha256(stableJson(fields ?? {}));
}

export function createJitTable() {
  return { contract: JIT_CONTRACT, schemaVersion: JIT_SCHEMA_VERSION, workers: new Map(), leases: new Map(), sequence: 0 };
}

export function isJitTable(value) {
  return Boolean(value) && typeof value === 'object' && value.contract === JIT_CONTRACT && value.workers instanceof Map && value.leases instanceof Map;
}

/**
 * A worker is registered with its locality, its slot count and how many times a lease may be
 * renewed. Re-registering the same worker with different terms is refused: capacity that moved
 * under a live lease is capacity nobody can reason about.
 */
export function registerWorker(table, { id, locality, slots, maxRenewals = DEFAULT_MAX_RENEWALS, ttl = DEFAULT_TTL_TICKS } = {}) {
  if (!isJitTable(table)) fail('registerWorker reads a table made by createJitTable', { code: 'jit.input', field: 'table' });
  if (!isNonEmptyString(id)) fail('a worker has an id: an anonymous slot pool is not a resource', { code: 'jit.worker', field: 'id' });
  if (!NODE_RUNTIME_LOCALITIES.includes(locality)) {
    fail(`locality '${String(locality)}' is not one the foundation publishes (${NODE_RUNTIME_LOCALITIES.join(', ')})`, { code: 'jit.worker', field: 'locality' });
  }
  if (!Number.isInteger(slots) || slots < 1 || slots > MAX_SLOTS_PER_WORKER) {
    fail(`slots must be a whole number between 1 and ${MAX_SLOTS_PER_WORKER}; got ${String(slots)}`, { code: 'jit.worker', field: 'slots' });
  }
  const renewals = normalizeRenewals(maxRenewals);
  const window = normalizeTtl(ttl);
  const existing = table.workers.get(id) ?? null;
  if (existing) {
    if (existing.slots !== slots || existing.locality !== locality || existing.maxRenewals !== renewals || existing.ttl !== window) {
      fail(`worker '${id}' is already registered with different terms: capacity that moves under a live lease is capacity nobody can reason about`, { code: 'jit.worker', field: 'id' });
    }
    return Object.freeze({ id, locality, slots, maxRenewals: renewals, ttl: window });
  }
  // The stored record is live bookkeeping (its slot set and lease counter move); the terms
  // handed back are frozen, because the terms must not move under a live lease.
  const record = { id, locality, slots, maxRenewals: renewals, ttl: window, active: new Set(), sequence: 0 };
  table.workers.set(id, record);
  return Object.freeze({ id, locality, slots, maxRenewals: renewals, ttl: window });
}

function normalizeRenewals(maxRenewals) {
  if (!Number.isInteger(maxRenewals) || maxRenewals < 0 || maxRenewals > MAX_RENEWALS) {
    fail(`maxRenewals must be a whole number between 0 and ${MAX_RENEWALS}; got ${String(maxRenewals)}`, { code: 'jit.ttl', field: 'maxRenewals' });
  }
  return maxRenewals;
}

function normalizeTtl(ttl) {
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > MAX_TTL_TICKS) {
    fail(`a time to live must be a whole number of ticks between 1 and ${MAX_TTL_TICKS}; got ${String(ttl)}`, { code: 'jit.ttl', field: 'ttl' });
  }
  return ttl;
}

export function isLease(value) {
  return Boolean(value) && typeof value === 'object' && value.contract === JIT_CONTRACT && isNonEmptyString(value.id) && JIT_LEASE_STATES.includes(value.state);
}

/** Live leases are only those that are active AND not past their deadline at this tick. */
function liveLeases(table, worker, tick) {
  return [...worker.active]
    .map((leaseId) => table.leases.get(leaseId))
    .filter((lease) => lease && lease.state === 'active' && lease.expiresAt > tick);
}

/** Expiring what is dead is a side effect of asking, never something a caller has to remember. */
function expireDead(table, worker, tick) {
  const expired = [];
  for (const leaseId of [...worker.active]) {
    const lease = table.leases.get(leaseId);
    if (lease && lease.state === 'active' && lease.expiresAt <= tick) {
      lease.state = 'expired';
      lease.endedAt = lease.expiresAt;
      worker.active.delete(leaseId);
      expired.push(lease);
    }
  }
  return expired;
}

/**
 * A request is answered immediately: granted, or refused because the worker has no slot to
 * give at this tick. A queue belongs to the scheduler, not here — a contract that quietly
 * held requests would be a scheduler with no policy.
 */
export function requestLease(table, { worker: workerId, identity, ioDigest: wireDigest, tick, ttl } = {}) {
  if (!isJitTable(table)) fail('requestLease reads a table made by createJitTable', { code: 'jit.input', field: 'table' });
  const worker = table.workers.get(workerId) ?? null;
  if (!worker) fail(`worker '${String(workerId)}' is not registered: a slot on a worker nobody declared is a slot nobody owns`, { code: 'jit.worker', field: 'worker' });
  if (!isIdentity(identity)) {
    fail("a lease names an identity 'type@typeVersion': a slot held for something unnamed cannot be cited", { code: 'jit.lease', field: 'identity' });
  }
  if (!isNonEmptyString(wireDigest)) {
    fail('a lease names the wire contract digest it was granted against: without it a lease outlives the contract it was for', { code: 'jit.lease', field: 'ioDigest' });
  }
  if (!isTick(tick)) fail('a lease is requested at a tick', { code: 'jit.input', field: 'tick' });
  const window = ttl === undefined ? worker.ttl : normalizeTtl(ttl);

  const reclaimed = expireDead(table, worker, tick);
  const live = liveLeases(table, worker, tick);
  if (live.length >= worker.slots) {
    return Object.freeze({
      ok: false,
      reason: 'jit.capacity',
      worker: worker.id,
      slots: worker.slots,
      live: live.length,
      reclaimed: reclaimed.length,
      message: `worker '${worker.id}' has ${worker.slots} slot(s) and all are in use at tick ${tick}: a request that does not fit is refused, and queueing is the scheduler's decision`,
    });
  }
  const held = live.find((lease) => lease.identity === identity && lease.ioDigest === wireDigest) ?? null;
  if (held) {
    // Asking twice for the same slot is not an error; it is the same lease, and saying so
    // keeps the slot count honest.
    return Object.freeze({ ok: true, granted: false, existing: held, worker: worker.id, tick, message: `'${identity}' already holds a lease on '${worker.id}' for this wire contract` });
  }
  worker.sequence += 1;
  table.sequence += 1;
  const id = `${worker.id}#${worker.sequence}`;
  const body = {
    contract: JIT_CONTRACT,
    schemaVersion: JIT_SCHEMA_VERSION,
    id,
    worker: worker.id,
    locality: worker.locality,
    identity,
    ioDigest: wireDigest,
    grantedAt: tick,
    expiresAt: tick + window,
    ttl: window,
    maxRenewals: worker.maxRenewals,
    renewals: 0,
    uses: 0,
    lastUsedAt: null,
    usedSinceRenewal: false,
    state: 'active',
    endedAt: null,
  };
  const lease = { ...body, leaseDigest: leaseDigest(body) };
  table.leases.set(id, lease);
  worker.active.add(id);
  return Object.freeze({ ok: true, granted: true, lease, worker: worker.id, tick, message: `'${identity}' holds a slot on '${worker.id}' until tick ${lease.expiresAt}` });
}

/**
 * Using a lease is what keeps it alive — and what makes it renewable. A use after expiry is a
 * use the host has no record of, so it is refused and the lease is marked expired.
 */
export function useLease(table, lease, { tick } = {}) {
  if (!isJitTable(table)) fail('useLease reads a table made by createJitTable', { code: 'jit.input', field: 'table' });
  const held = requireLease(table, lease);
  if (!isTick(tick)) fail('a use happens at a tick', { code: 'jit.input', field: 'tick' });
  if (held.state === 'released') {
    fail(`lease '${held.id}' was released: a released lease is not a licence`, { code: 'jit.lease', field: 'state' });
  }
  if (held.state === 'expired' || tick >= held.expiresAt) {
    if (held.state === 'active') {
      held.state = 'expired';
      held.endedAt = held.expiresAt;
      table.workers.get(held.worker)?.active.delete(held.id);
    }
    return Object.freeze({ ok: false, reason: 'jit.expired', lease: held, tick, message: `lease '${held.id}' lapsed at ${held.expiresAt}: a use after expiry is a use the host has no record of` });
  }
  held.uses += 1;
  held.lastUsedAt = tick;
  held.usedSinceRenewal = true;
  return Object.freeze({ ok: true, used: true, lease: held, uses: held.uses, tick, message: `used at tick ${tick}; the lease runs to ${held.expiresAt}` });
}

function requireLease(table, lease) {
  const id = typeof lease === 'string' ? lease : lease?.id;
  const held = table.leases.get(id) ?? null;
  if (!held) fail(`lease '${String(id)}' is not in this table: a lease that cannot be looked up is a slot nobody can audit`, { code: 'jit.lease', field: 'lease' });
  return held;
}

/**
 * Renewal extends the window. It is refused for an idle lease, for a lease past its renewal
 * budget, and for one that would live beyond the longest life this contract allows.
 */
export function renewLease(table, lease, { tick, ttl } = {}) {
  if (!isJitTable(table)) fail('renewLease reads a table made by createJitTable', { code: 'jit.input', field: 'table' });
  const held = requireLease(table, lease);
  if (!isTick(tick)) fail('a renewal happens at a tick', { code: 'jit.input', field: 'tick' });
  // Argument checking comes before state checking: a bad ttl is a caller's mistake and must be
  // reported as one, however the lease happens to be standing.
  const window = ttl === undefined ? held.ttl : normalizeTtl(ttl);
  if (held.state !== 'active') {
    return Object.freeze({ ok: false, reason: 'jit.expired', lease: held, tick, message: `lease '${held.id}' is '${held.state}': a lapsed or released lease is not renewed` });
  }
  if (!held.usedSinceRenewal) {
    return Object.freeze({
      ok: false,
      reason: 'jit.idle',
      lease: held,
      tick,
      message: `lease '${held.id}' has not been used since ${held.renewals === 0 ? 'it was granted' : `renewal ${held.renewals}`}: a slot held with paperwork is a leak, so let it expire`,
    });
  }
  if (held.renewals >= held.maxRenewals) {
    return Object.freeze({ ok: false, reason: 'jit.ttl', lease: held, tick, message: `lease '${held.id}' has used all ${held.maxRenewals} renewal(s): a JIT lease is short by construction` });
  }
  const nextExpiry = tick + window;
  const deadline = held.grantedAt + MAX_TTL_TICKS;
  if (nextExpiry > deadline) {
    return Object.freeze({
      ok: false,
      reason: 'jit.ttl',
      lease: held,
      tick,
      message: `renewing to tick ${nextExpiry} would outlive the ${MAX_TTL_TICKS}-tick ceiling from grant (tick ${deadline}): the slot must be asked for again`,
    });
  }
  held.renewals += 1;
  held.expiresAt = nextExpiry;
  held.usedSinceRenewal = false;
  return Object.freeze({ ok: true, renewed: true, lease: held, expiresAt: nextExpiry, renewals: held.renewals, tick, message: `renewed at tick ${tick} to ${nextExpiry} (renewal ${held.renewals} of ${held.maxRenewals})` });
}

/**
 * Releasing gives the slot back. Releasing a lease that already expired is bookkeeping — the
 * slot came back by itself — and releasing twice is refused, because a second release would
 * count one slot twice.
 */
export function releaseLease(table, lease, { tick } = {}) {
  if (!isJitTable(table)) fail('releaseLease reads a table made by createJitTable', { code: 'jit.input', field: 'table' });
  const held = requireLease(table, lease);
  if (!isTick(tick)) fail('a release happens at a tick', { code: 'jit.input', field: 'tick' });
  if (held.state === 'released') {
    fail(`lease '${held.id}' was released at tick ${held.endedAt}: releasing it twice would count one slot twice`, { code: 'jit.lease', field: 'state' });
  }
  if (held.state === 'expired') {
    return Object.freeze({ ok: true, released: false, alreadyExpired: true, lease: held, tick, message: `lease '${held.id}' had already lapsed at ${held.endedAt}: the slot came back on its own` });
  }
  held.state = 'released';
  held.endedAt = tick;
  table.workers.get(held.worker)?.active.delete(held.id);
  return Object.freeze({ ok: true, released: true, lease: held, tick, message: `slot returned on '${held.worker}' at tick ${tick}` });
}

/** Sweeping is a read of the clock, and the answer is what came back to the pool. */
export function reapExpired(table, { tick } = {}) {
  if (!isJitTable(table)) fail('reapExpired reads a table made by createJitTable', { code: 'jit.input', field: 'table' });
  if (!isTick(tick)) fail('a sweep happens at a tick', { code: 'jit.input', field: 'tick' });
  const reclaimed = [];
  for (const worker of table.workers.values()) reclaimed.push(...expireDead(table, worker, tick));
  return Object.freeze({
    ok: true,
    tick,
    reclaimed: Object.freeze(reclaimed.map((lease) => lease.id)),
    slots: reclaimed.length,
    message: reclaimed.length === 0 ? 'nothing had lapsed' : `${reclaimed.length} slot(s) returned to their pools`,
  });
}

/** Every lease this worker has, in the state it is in — expired ones included, because they are the record. */
export function leasesOf(table, workerId, { tick } = {}) {
  if (!isJitTable(table)) fail('leasesOf reads a table made by createJitTable', { code: 'jit.input', field: 'table' });
  if (!table.workers.has(workerId)) fail(`worker '${String(workerId)}' is not registered`, { code: 'jit.worker', field: 'worker' });
  const leases = [...table.leases.values()].filter((lease) => lease.worker === workerId);
  if (!isTick(tick)) return Object.freeze(leases);
  return Object.freeze(leases.map((lease) => (lease.state === 'active' && lease.expiresAt <= tick ? { ...lease, state: 'expired-view', endedAt: lease.expiresAt } : lease)));
}

/** The census a pool reads: slots, live leases, records kept, and the digest of the whole picture. */
export function describeJit(table, { tick } = {}) {
  if (!isJitTable(table)) fail('describeJit reads a table made by createJitTable', { code: 'jit.input', field: 'table' });
  if (!isTick(tick)) fail('a census answers for a tick: a census without one is a snapshot of nothing', { code: 'jit.input', field: 'tick' });
  const workers = [...table.workers.keys()].sort().map((id) => {
    const worker = table.workers.get(id);
    const live = liveLeases(table, worker, tick);
    return Object.freeze({
      id,
      locality: worker.locality,
      slots: worker.slots,
      live: live.length,
      free: worker.slots - live.length,
      expiringAt: Object.freeze(live.map((lease) => lease.expiresAt).sort((left, right) => left - right)),
    });
  });
  const all = [...table.leases.values()];
  const body = {
    contract: JIT_CONTRACT,
    tick,
    workers: Object.freeze(workers),
    records: all.length,
    active: all.filter((lease) => lease.state === 'active' && lease.expiresAt > tick).length,
    expired: all.filter((lease) => lease.state === 'expired' || (lease.state === 'active' && lease.expiresAt <= tick)).length,
    released: all.filter((lease) => lease.state === 'released').length,
    renewalsUsed: all.reduce((total, lease) => total + lease.renewals, 0),
    uses: all.reduce((total, lease) => total + lease.uses, 0),
  };
  return Object.freeze({ ...body, censusDigest: leaseDigest(body) });
}

/** One readable line, because a slot held by nobody anyone can name is an outage waiting. */
export function explainLease(lease) {
  if (!isLease(lease)) fail('explainLease reads a lease made by requestLease', { code: 'jit.input', field: 'lease' });
  const used = lease.lastUsedAt === null ? 'never used' : `last used at ${lease.lastUsedAt} (${lease.uses} use(s))`;
  return `lease ${lease.id}: '${lease.identity}' on ${lease.worker} (${lease.locality}) — ${lease.state}; granted ${lease.grantedAt}, ${used}, ${lease.renewals} renewal(s), ${lease.state === 'active' ? `runs to ${lease.expiresAt}` : `ended ${lease.endedAt}`}`;
}
