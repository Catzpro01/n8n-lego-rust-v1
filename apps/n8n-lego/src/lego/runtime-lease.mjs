/**
 * Runtime lease + side-by-side upgrade — P6.6.
 *
 * PUBLIC CONTRACT (`runtime.lease@0.1.0`, domain `node-registry`).
 *
 * P6.2 publishes an epoch by moving a pointer between frozen objects. That is
 * only safe if nothing is still executing inside the old one — and something
 * always is. A workflow that started an hour ago must finish the run it started,
 * under the exact implementations it started with, while the next request is
 * served by the new epoch. "Deploy" and "what is running" are different
 * questions, and the gap between them is where the classic upgrade outage lives:
 * the new version is published, an in-flight execution silently switches
 * versions half-way through, and the result is a state that neither version
 * would have produced.
 *
 * This contract closes that gap with three mechanisms, all pure:
 *
 *   1. LEASES. A lease is what an execution holds while it runs: it names the
 *      EPOCH DIGEST it will run under (never a version number, never "current"),
 *      so a lease cannot be re-pointed by a later publication. Acquiring a lease
 *      on a draining or retired epoch is refused: a retiring epoch stops taking
 *      new work immediately, while everything already inside keeps running.
 *
 *   2. DRAIN. Draining is explicit and observable. It flips an epoch's serving
 *      state, returns the executions still outstanding, and makes the epoch
 *      invisible to new work — the two conditions an operator needs to know
 *      whether a deploy is finished.
 *
 *   3. RETIRE, GATED ON THE LEASES. An epoch cannot be retired while a single
 *      lease is outstanding, and the refusal names the executions that are still
 *      holding it. Retirement is therefore a fact derived from the lease table,
 *      not a promise made by a deployment script.
 *
 * SIDE-BY-SIDE is the consequence rather than a feature: because leases name
 * digests, several epochs can be SERVING at the same time — the old one for
 * in-flight work, the new one for new work — and the table reports exactly which
 * ones and for how long that has been true. That is what makes a zero-downtime
 * upgrade a bookkeeping problem instead of a race.
 *
 * WHAT THIS IS NOT (P6.6 scope walls, enforced by tests):
 *   - no execution, no scheduling and no queue: the caller supplies execution
 *     ids and reports releases, exactly as P6.3's caller supplies step results;
 *   - no publication, no compile, no pinning (P6.2/P6.5 own those) — this module
 *     never mints an epoch and never edits a manifest;
 *   - no residency tier (P6.7), no health, no quarantine (P6.11), no canary or
 *     rollback policy (P6.19): it counts leases, it does not decide upgrades;
 *   - no clock: leases carry a TABLE SEQUENCE, not a timestamp, so the same
 *     sequence of operations produces the same table on any host;
 *   - no mutation: every operation returns a new frozen table.
 *
 * Authority: holding a lease grants nothing but the right to keep serving the
 * epoch named in it. It is not a trust decision, not a capability and not a
 * permission.
 */
import { createHash } from 'node:crypto';

import { NODE_REGISTRY_SCHEMA_VERSION } from './node-registry.mjs';
import { isFrozenRegistryEpoch } from './registry-compiler.mjs';

export const RUNTIME_LEASE_CONTRACT = 'runtime.lease@0.1.0';
export const RUNTIME_LEASE_CONTRACT_VERSION = '0.1.0';
export const RUNTIME_LEASE_SCHEMA_VERSION = 1;

export const RUNTIME_LEASE_OPERATIONS = Object.freeze(['lease', 'release', 'drain', 'retire', 'describe']);
export const RUNTIME_LEASE_PERMISSIONS = Object.freeze(['node:read']);

/** What an epoch is allowed to receive. `serving` takes new work; the others do not. */
export const EPOCH_SERVING_STATES = Object.freeze(['serving', 'draining', 'retired']);

/** Lease states. `released` is terminal, and releasing twice is a no-op. */
export const LEASE_STATES = Object.freeze(['active', 'released']);

export const RUNTIME_LEASE_REASONS = Object.freeze([
  'lease.epoch',
  'lease.execution',
  'lease.fence',
  'lease.state',
  'lease.outstanding',
  'lease.unknown',
  'lease.table',
  'lease.digest',
]);

export const RUNTIME_LEASE_RULES = Object.freeze({
  digest: 'a lease names the epoch DIGEST it runs under, so a later publication cannot re-point work that is already running',
  admission: 'a draining or retired epoch takes no new leases; everything already inside keeps running to completion',
  gate: 'an epoch cannot be retired while a single lease is outstanding, and the refusal names who is still holding it',
  order: 'draining comes before retiring: an epoch that is still admitting work is not retired out from under the request that is asking for a lease',
  sideBySide: 'several epochs may serve at once — the old one for in-flight work, the new one for new work — and the table says which',
  release: 'releasing is idempotent, and a lease id is derived from its execution and epoch so a retried acquire is the same lease',
  sequence: 'the table carries a monotonic sequence instead of a clock, so the same operations produce the same table everywhere',
  authority: 'a lease grants nothing but the right to keep serving the epoch it names: no trust, no capability, no permission',
});

/* ------------------------------------------------------------------ *\n * Errors\n * ------------------------------------------------------------------ */

export class RuntimeLeaseError extends Error {
  constructor(message, meta = {}) {
    super(message);
    this.name = 'RuntimeLeaseError';
    this.code = 'lego.contract_violation';
    this.meta = Object.freeze({ ...meta });
  }
}

const fail = (message, meta) => { throw new RuntimeLeaseError(message, meta); };
const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const isNonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0;

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

const digestOf = (text) => createHash('sha256').update(text).digest('hex');

function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value;
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return Object.freeze(value);
}

const requireEpoch = (epoch, fn) => {
  if (!isFrozenRegistryEpoch(epoch)) fail(`${fn} expects a frozen epoch compiled by registry.compiler`, { got: typeof epoch });
};

/** The lease id is derived, not assigned: the same execution under the same epoch is the same lease. */
const leaseIdOf = (executionId, epochDigest) => `lease:${digestOf(stableJson({ executionId, epochDigest })).slice(0, 32)}`;

/* ------------------------------------------------------------------ *\n * Table\n * ------------------------------------------------------------------ */

/** A frozen, empty lease table: no epochs registered, no leases, sequence 0. */
export function createLeaseTable() {
  return deepFreeze({
    ok: true,
    contract: RUNTIME_LEASE_CONTRACT,
    schemaVersion: RUNTIME_LEASE_SCHEMA_VERSION,
    sequence: 0,
    serving: {},
    leases: {},
    retired: {},
    drains: 0,
    retirements: 0,
    admitted: 0,
    refused: 0,
  });
}

/** @returns {boolean} whether `value` is a lease table this contract produced. */
export function isLeaseTable(value) {
  return (
    isPlainObject(value) &&
    value.ok === true &&
    value.contract === RUNTIME_LEASE_CONTRACT &&
    value.schemaVersion === RUNTIME_LEASE_SCHEMA_VERSION &&
    Number.isInteger(value.sequence) &&
    isPlainObject(value.serving) &&
    isPlainObject(value.leases) &&
    Object.isFrozen(value)
  );
}

const requireTable = (table, fn) => {
  if (!isLeaseTable(table)) fail(`${fn} expects a table produced by createLeaseTable`, { got: typeof table });
};

const servingStateOf = (table, epochDigest) => table.serving[epochDigest]?.state ?? null;

function withServing(table, epoch, state) {
  return {
    ...table,
    serving: {
      ...table.serving,
      [epoch.epochDigest]: {
        epochNumber: epoch.epochNumber,
        source: epoch.source,
        digest: epoch.epochDigest,
        state,
        since: table.sequence + 1,
      },
    },
  };
}

/* ------------------------------------------------------------------ *\n * Lease\n * ------------------------------------------------------------------ */

/**
 * Register an epoch for serving. Refused for an epoch whose number was already
 * retired under a DIFFERENT digest: a number is not a place to hide a rewrite.
 */
export function registerEpoch(table, epoch) {
  requireTable(table, 'registerEpoch');
  requireEpoch(epoch, 'registerEpoch');

  const sameNumber = Object.values(table.retired).filter((entry) => entry.epochNumber === epoch.epochNumber);
  if (sameNumber.length > 0 && !sameNumber.some((entry) => entry.digest === epoch.epochDigest)) {
    fail(
      `epoch ${epoch.epochNumber} was retired under a different digest; a retired epoch number cannot be reused by different content`,
      { code: 'lease.digest', epochNumber: epoch.epochNumber },
    );
  }
  if (servingStateOf(table, epoch.epochDigest) !== null) return table;

  return deepFreeze({ ...withServing(table, epoch, 'serving'), sequence: table.sequence + 1 });
}

/**
 * Acquire a lease for one execution.
 *
 * @returns {{ ok: true, table: object, lease: object } | { ok: false, table: object, lease: null, reason: string, error: object }}
 */
export function acquireLease(table, { executionId, epoch } = {}) {
  requireTable(table, 'acquireLease');
  if (!isNonEmptyString(executionId)) {
    fail('a lease must name the execution it belongs to; an anonymous holder can never be drained', { code: 'lease.execution', field: 'executionId' });
  }
  requireEpoch(epoch, 'acquireLease');

  const state = servingStateOf(table, epoch.epochDigest);
  if (state === null) {
    fail(
      `epoch ${epoch.epochNumber} (${epoch.epochDigest.slice(0, 12)}…) was never registered for serving; a lease on an unregistered epoch is work nobody is counting`,
      { code: 'lease.epoch', epochNumber: epoch.epochNumber },
    );
  }
  if (state !== 'serving') {
    const error = {
      code: 'lease.state',
      state,
      epochNumber: epoch.epochNumber,
      message: state === 'retired'
        ? `epoch ${epoch.epochNumber} is retired and takes no new work`
        : `epoch ${epoch.epochNumber} is draining: it takes no new work, but everything already inside keeps running`,
    };
    return Object.freeze({ ok: false, table: deepFreeze({ ...table, refused: table.refused + 1 }), lease: null, reason: error.code, error: Object.freeze(error) });
  }

  const leaseId = leaseIdOf(executionId, epoch.epochDigest);
  const existing = table.leases[leaseId];
  if (existing && existing.state === 'active') {
    return Object.freeze({ ok: true, table, lease: existing, reason: 'already-held' });
  }

  const lease = deepFreeze({
    ok: true,
    kind: 'runtime-lease',
    leaseId,
    executionId,
    epochNumber: epoch.epochNumber,
    epochDigest: epoch.epochDigest,
    epochSource: epoch.source,
    state: 'active',
    sequence: table.sequence + 1,
  });
  return Object.freeze({
    ok: true,
    table: deepFreeze({ ...table, leases: { ...table.leases, [leaseId]: lease }, sequence: table.sequence + 1, admitted: table.admitted + 1 }),
    lease,
    reason: 'admitted',
  });
}

/** Release a lease. Idempotent: releasing an already-released lease changes nothing. */
export function releaseLease(table, leaseOrId) {
  requireTable(table, 'releaseLease');
  const leaseId = typeof leaseOrId === 'string' ? leaseOrId : leaseOrId?.leaseId;
  if (!isNonEmptyString(leaseId)) fail('releaseLease expects a lease or a lease id', { code: 'lease.unknown' });
  const existing = table.leases[leaseId];
  if (!existing) return Object.freeze({ ok: false, table, reason: 'lease.unknown', error: Object.freeze({ code: 'lease.unknown', message: `no lease '${leaseId}' in this table` }) });
  if (existing.state === 'released') return Object.freeze({ ok: true, table, lease: existing, reason: 'already-released' });

  const released = deepFreeze({ ...existing, state: 'released', releasedAt: table.sequence + 1 });
  return Object.freeze({
    ok: true,
    table: deepFreeze({ ...table, leases: { ...table.leases, [leaseId]: released }, sequence: table.sequence + 1 }),
    lease: released,
    reason: 'released',
  });
}

/* ------------------------------------------------------------------ *\n * Drain + retire\n * ------------------------------------------------------------------ */

/** Which executions are still holding the epoch named by `digest`. */
export function outstandingLeases(table, digestOrEpoch) {
  requireTable(table, 'outstandingLeases');
  const digest = typeof digestOrEpoch === 'string' ? digestOrEpoch : digestOrEpoch?.epochDigest;
  if (!isNonEmptyString(digest)) fail('outstandingLeases expects an epoch or an epoch digest', { code: 'lease.unknown' });
  return deepFreeze(
    Object.values(table.leases)
      .filter((lease) => lease.epochDigest === digest && lease.state === 'active')
      .sort((a, b) => (a.executionId < b.executionId ? -1 : 1)),
  );
}

/**
 * Start draining an epoch: it immediately stops taking NEW leases, and the
 * outstanding executions are returned so a deploy can wait on them honestly.
 */
export function drainEpoch(table, epoch) {
  requireTable(table, 'drainEpoch');
  requireEpoch(epoch, 'drainEpoch');
  const state = servingStateOf(table, epoch.epochDigest);
  if (state === null) fail(`epoch ${epoch.epochNumber} is not registered for serving`, { code: 'lease.epoch', epochNumber: epoch.epochNumber });
  if (state === 'retired') {
    return Object.freeze({ ok: true, table, drained: false, reason: 'already-retired', outstanding: Object.freeze([]) });
  }
  if (state === 'draining') {
    return Object.freeze({ ok: true, table, drained: false, reason: 'already-draining', outstanding: outstandingLeases(table, epoch.epochDigest) });
  }
  const outstanding = outstandingLeases(table, epoch.epochDigest);
  return Object.freeze({
    ok: true,
    table: deepFreeze({ ...withServing(table, epoch, 'draining'), sequence: table.sequence + 1, drains: table.drains + 1 }),
    drained: true,
    reason: outstanding.length === 0 ? 'drained-empty' : 'draining',
    outstanding,
  });
}

/**
 * Retire an epoch. Refused while a single lease is outstanding — and the refusal
 * names the executions still holding it.
 */
export function retireEpoch(table, epoch) {
  requireTable(table, 'retireEpoch');
  requireEpoch(epoch, 'retireEpoch');
  const state = servingStateOf(table, epoch.epochDigest);
  if (state === null) fail(`epoch ${epoch.epochNumber} is not registered for serving`, { code: 'lease.epoch', epochNumber: epoch.epochNumber });
  if (state === 'retired') return Object.freeze({ ok: true, table, retired: false, reason: 'already-retired' });
  if (state === 'serving') {
    // Retiring an epoch that is still ADMITTING work is a race with whoever is
    // asking for a lease right now. Drain first: it is one extra call and it is
    // the difference between a deploy and a race.
    const error = {
      code: 'lease.state',
      state,
      epochNumber: epoch.epochNumber,
      message: `epoch ${epoch.epochNumber} is still serving; drain it before retiring, or new work will be admitted into an epoch that is on its way out`,
    };
    return Object.freeze({ ok: false, table: deepFreeze({ ...table, refused: table.refused + 1 }), reason: error.code, error: Object.freeze(error) });
  }

  const outstanding = outstandingLeases(table, epoch.epochDigest);
  if (outstanding.length > 0) {
    const error = {
      code: 'lease.outstanding',
      epochNumber: epoch.epochNumber,
      outstanding: Object.freeze(outstanding.map((lease) => lease.executionId)),
      message: `epoch ${epoch.epochNumber} cannot be retired: ${outstanding.length} execution${outstanding.length === 1 ? '' : 's'} still running (${outstanding.map((lease) => lease.executionId).join(', ')}); drain it first`,
    };
    return Object.freeze({ ok: false, table: deepFreeze({ ...table, refused: table.refused + 1 }), reason: error.code, error: Object.freeze(error) });
  }

  const retiredEntry = deepFreeze({
    epochNumber: epoch.epochNumber,
    digest: epoch.epochDigest,
    source: epoch.source,
    retiredAt: table.sequence + 1,
  });
  const serving = { ...table.serving, [epoch.epochDigest]: { ...table.serving[epoch.epochDigest], state: 'retired' } };
  return Object.freeze({
    ok: true,
    table: deepFreeze({
      ...table,
      serving,
      retired: { ...table.retired, [epoch.epochDigest]: retiredEntry },
      sequence: table.sequence + 1,
      retirements: table.retirements + 1,
    }),
    retired: true,
    reason: 'retired',
  });
}

/* ------------------------------------------------------------------ *\n * Reads\n * ------------------------------------------------------------------ */

/** Every epoch currently taking new work — the side-by-side set. */
export function servingEpochs(table) {
  requireTable(table, 'servingEpochs');
  return deepFreeze(
    Object.values(table.serving)
      .filter((entry) => entry.state === 'serving')
      .sort((a, b) => a.epochNumber - b.epochNumber)
      .map((entry) => ({ epochNumber: entry.epochNumber, digest: entry.digest, source: entry.source })),
  );
}

/** Every epoch still draining — published but not finished. */
export function drainingEpochs(table) {
  requireTable(table, 'drainingEpochs');
  return deepFreeze(
    Object.values(table.serving)
      .filter((entry) => entry.state === 'draining')
      .sort((a, b) => a.epochNumber - b.epochNumber)
      .map((entry) => ({ epochNumber: entry.epochNumber, digest: entry.digest, outstanding: outstandingLeases(table, entry.digest).length })),
  );
}

/** Can a rollout finish right now? The one predicate an upgrade gate should ask. */
export function isFullyDrained(table) {
  requireTable(table, 'isFullyDrained');
  const draining = drainingEpochs(table);
  return draining.length === 0 || draining.every((entry) => entry.outstanding === 0);
}

/** Serializable summary: who serves, who drains, who is gone, and how much is in flight. */
export function describeLeaseTable(table) {
  requireTable(table, 'describeLeaseTable');
  const active = Object.values(table.leases).filter((lease) => lease.state === 'active');
  return deepFreeze({
    contract: table.contract,
    schemaVersion: table.schemaVersion,
    sequence: table.sequence,
    serving: servingEpochs(table),
    draining: drainingEpochs(table),
    retired: Object.values(table.retired).sort((a, b) => a.epochNumber - b.epochNumber).map((entry) => ({ epochNumber: entry.epochNumber, digest: entry.digest })),
    leases: Object.keys(table.leases).length,
    activeLeases: active.length,
    activeByEpoch: Object.freeze(Object.fromEntries(
      [...new Set(active.map((lease) => lease.epochDigest))].sort().map((digest) => [digest, active.filter((lease) => lease.epochDigest === digest).length]),
    )),
    drained: isFullyDrained(table),
    drains: table.drains,
    retirements: table.retirements,
    admitted: table.admitted,
    refused: table.refused,
  });
}

/** `leases: 2 active / 1 draining / 1 retired — 3 epochs known`. */
export function formatLeaseTable(table) {
  requireTable(table, 'formatLeaseTable');
  const described = describeLeaseTable(table);
  return `leases: ${described.activeLeases} active / ${described.draining.length} draining / ${described.retired.length} retired — ${Object.keys(table.serving).length} epoch${Object.keys(table.serving).length === 1 ? '' : 's'} known`;
}

/** Lease ids of one execution — a retried execution's leases, whether released or not. */
export function leasesOfExecution(table, executionId) {
  requireTable(table, 'leasesOfExecution');
  return deepFreeze(Object.values(table.leases).filter((lease) => lease.executionId === executionId).sort((a, b) => a.sequence - b.sequence));
}

/** Every execution still holding ANY epoch, oldest lease first. */
export function activeExecutions(table) {
  requireTable(table, 'activeExecutions');
  return deepFreeze(Object.values(table.leases).filter((lease) => lease.state === 'active').sort((a, b) => a.sequence - b.sequence).map((lease) => lease.executionId));
}

/** The epochs a set of executions is keeping alive — what a rollback must respect. */
export function epochsHeldBy(table, executionIds) {
  requireTable(table, 'epochsHeldBy');
  if (!Array.isArray(executionIds) && !(executionIds instanceof Set)) {
    fail('epochsHeldBy expects an array or Set of execution ids', { code: 'lease.execution' });
  }
  const wanted = new Set(executionIds);
  return deepFreeze([...new Set(
    Object.values(table.leases)
      .filter((lease) => lease.state === 'active' && wanted.has(lease.executionId))
      .map((lease) => lease.epochDigest),
  )].sort());
}

export const RUNTIME_LEASE_INPUT_SCHEMA_VERSION = NODE_REGISTRY_SCHEMA_VERSION;
