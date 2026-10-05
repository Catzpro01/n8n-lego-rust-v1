/**
 * P6.22 — just-in-time leases for runtime slots.
 * Contract `runtime.jit@0.1.0`.
 *
 * Matrix: worker registration and capacity, a lease that names what it is for (identity, wire
 * contract digest, locality), capacity where a dead lease does not hold a slot, the idle
 * renewal rule, the bounded life, expiry that is a record and not a deletion, double release,
 * the census, the reads, and the walls.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { NODE_RUNTIME_LOCALITIES } from '../src/lego/node-registry.mjs';
import {
  DEFAULT_MAX_RENEWALS,
  DEFAULT_TTL_TICKS,
  JIT_CONTRACT,
  JIT_CONTRACT_VERSION,
  JIT_LEASE_STATES,
  JIT_OPERATIONS,
  JIT_PERMISSIONS,
  JIT_REASONS,
  JIT_RULES,
  JIT_SCHEMA_VERSION,
  JitError,
  MAX_RENEWALS,
  MAX_SLOTS_PER_WORKER,
  MAX_TTL_TICKS,
  createJitTable,
  describeJit,
  explainLease,
  isJitTable,
  isLease,
  leaseDigest,
  leasesOf,
  reapExpired,
  registerWorker,
  releaseLease,
  renewLease,
  requestLease,
  stableJson,
  useLease,
} from '../src/lego/jit-lease.mjs';

/* ------------------------------------------------------------------ fixtures */

const WIRE = 'a'.repeat(64);
const WIRE_V2 = 'b'.repeat(64);

const TABLE = ({ slots = 2, ttl = DEFAULT_TTL_TICKS, maxRenewals = DEFAULT_MAX_RENEWALS, locality = 'js-compat' } = {}) => {
  const table = createJitTable();
  const worker = registerWorker(table, { id: 'worker-a', locality, slots, ttl, maxRenewals });
  return { table, worker };
};

const HELD = (options, at = 0) => {
  const { table, worker } = TABLE(options);
  const granted = requestLease(table, { worker: worker.id, identity: 'n8n-nodes-base.set@3.4', ioDigest: WIRE, tick: at });
  assert.equal(granted.granted, true, granted.message ?? '');
  return { table, worker, lease: granted.lease };
};

const throwsWith = (fn, code) => {
  let caught = null;
  try { fn(); } catch (error) { caught = error; }
  assert.ok(caught instanceof JitError, `expected a JitError carrying ${code}`);
  assert.equal(caught.code, 'lego.contract_violation');
  assert.equal(caught.meta.code, code);
  return caught;
};

/* ------------------------------------------------------------------ contract */

test('the contract surface is the published one: id, version, ops, states, bounds', () => {
  assert.equal(JIT_CONTRACT, 'runtime.jit@0.1.0');
  assert.equal(JIT_CONTRACT_VERSION, '0.1.0');
  assert.equal(JIT_SCHEMA_VERSION, 1);
  assert.deepEqual([...JIT_OPERATIONS], ['request', 'use', 'renew', 'release', 'reap', 'describe']);
  assert.deepEqual([...JIT_PERMISSIONS], ['node:read']);
  assert.deepEqual([...JIT_LEASE_STATES], ['active', 'expired', 'released']);
  assert.equal(JIT_REASONS.length, 8);
  assert.equal(DEFAULT_TTL_TICKS, 30);
  assert.equal(MAX_TTL_TICKS, 120);
  assert.equal(MAX_RENEWALS, 8);
  assert.equal(MAX_SLOTS_PER_WORKER, 64);
  assert.match(JIT_RULES.short, /short by construction/);
  assert.match(JIT_RULES.authority, /never decides whether a node should run/);
  assert.deepEqual([...NODE_RUNTIME_LOCALITIES], ['js-compat', 'remote-worker', 'rust-native', 'wasm']);
});

test('a worker is registered with terms that cannot move under a live lease', () => {
  const { table, worker } = TABLE();
  assert.equal(isJitTable(table), true);
  assert.equal(worker.slots, 2);
  assert.equal(worker.ttl, DEFAULT_TTL_TICKS);
  assert.equal(Object.isFrozen(worker), true);
  assert.equal(registerWorker(table, { id: 'worker-a', locality: 'js-compat', slots: 2 }).id, 'worker-a', 'the same terms are not a second registration');
  assert.match(
    throwsWith(() => registerWorker(table, { id: 'worker-a', locality: 'js-compat', slots: 4 }), 'jit.worker').message,
    /capacity that moves under a live lease/,
  );
  throwsWith(() => registerWorker(table, { id: '', locality: 'wasm', slots: 1 }), 'jit.worker');
  throwsWith(() => registerWorker(table, { id: 'b', locality: 'gpu-tent', slots: 1 }), 'jit.worker');
  throwsWith(() => registerWorker(table, { id: 'b', locality: 'wasm', slots: 0 }), 'jit.worker');
  throwsWith(() => registerWorker(table, { id: 'b', locality: 'wasm', slots: MAX_SLOTS_PER_WORKER + 1 }), 'jit.worker');
  throwsWith(() => registerWorker(table, { id: 'b', locality: 'wasm', slots: 1, ttl: 0 }), 'jit.ttl');
  throwsWith(() => registerWorker(table, { id: 'b', locality: 'wasm', slots: 1, ttl: MAX_TTL_TICKS + 1 }), 'jit.ttl');
  throwsWith(() => registerWorker(table, { id: 'b', locality: 'wasm', slots: 1, maxRenewals: -1 }), 'jit.ttl');
  assert.equal(isJitTable({ contract: JIT_CONTRACT }), false);
  throwsWith(() => registerWorker({}, { id: 'a', locality: 'wasm', slots: 1 }), 'jit.input');
});

test('a lease names the identity, the wire contract and the locality it was granted for', () => {
  const { lease } = HELD();
  assert.equal(isLease(lease), true);
  assert.equal(lease.identity, 'n8n-nodes-base.set@3.4');
  assert.equal(lease.ioDigest, WIRE);
  assert.equal(lease.locality, 'js-compat');
  assert.equal(lease.grantedAt, 0);
  assert.equal(lease.expiresAt, DEFAULT_TTL_TICKS);
  assert.equal(lease.uses, 0);
  assert.equal(lease.renewals, 0);
  assert.equal(lease.state, 'active');
  assert.match(lease.leaseDigest, /^[0-9a-f]{64}$/);
  const { leaseDigest: digest, ...body } = lease;
  assert.equal(digest, leaseDigest(body), 'the digest covers the lease as it was granted');
  assert.match(explainLease(lease), /lease worker-a#1: 'n8n-nodes-base\.set@3\.4' on worker-a \(js-compat\) — active; granted 0, never used, 0 renewal\(s\), runs to 30/);
  throwsWith(() => explainLease({ id: 'x' }), 'jit.input');

  const { table, worker } = TABLE();
  throwsWith(() => requestLease(table, { worker: worker.id, identity: 'n8n-nodes-base.set', ioDigest: WIRE, tick: 0 }), 'jit.lease');
  throwsWith(() => requestLease(table, { worker: worker.id, identity: 'n8n-nodes-base.set@3.4', tick: 0 }), 'jit.lease');
  throwsWith(() => requestLease(table, { worker: 'nobody', identity: 'a@1', ioDigest: WIRE, tick: 0 }), 'jit.worker');
  throwsWith(() => requestLease(table, { worker: worker.id, identity: 'a@1', ioDigest: WIRE }), 'jit.input');
  throwsWith(() => requestLease(table, { worker: worker.id, identity: 'a@1', ioDigest: WIRE, tick: 0, ttl: MAX_TTL_TICKS + 1 }), 'jit.ttl');
});

test('asking twice for the same slot hands back the lease that exists rather than a second slot', () => {
  const { table, worker, lease } = HELD();
  const again = requestLease(table, { worker: worker.id, identity: 'n8n-nodes-base.set@3.4', ioDigest: WIRE, tick: 5 });
  assert.equal(again.ok, true);
  assert.equal(again.granted, false);
  assert.equal(again.existing.id, lease.id);
  assert.match(again.message, /already holds a lease/);
  assert.equal(describeJit(table, { tick: 5 }).active, 1);
  // A different wire contract is a different slot: the lease is not a licence for the next version.
  const moved = requestLease(table, { worker: worker.id, identity: 'n8n-nodes-base.set@3.4', ioDigest: WIRE_V2, tick: 5 });
  assert.equal(moved.granted, true);
  assert.notEqual(moved.lease.id, lease.id);
  assert.equal(describeJit(table, { tick: 5 }).active, 2);
});

test('capacity is per worker, and a lease that has already lapsed does not hold a slot', () => {
  const { table, worker } = TABLE({ slots: 2, ttl: 10 });
  assert.equal(requestLease(table, { worker: worker.id, identity: 'a@1', ioDigest: WIRE, tick: 0 }).granted, true);
  assert.equal(requestLease(table, { worker: worker.id, identity: 'b@1', ioDigest: WIRE, tick: 0 }).granted, true);
  const full = requestLease(table, { worker: worker.id, identity: 'c@1', ioDigest: WIRE, tick: 1 });
  assert.equal(full.ok, false);
  assert.equal(full.reason, 'jit.capacity');
  assert.equal(full.live, 2);
  assert.match(full.message, /all are in use at tick 1/);
  // Nobody swept anything: the slots come back because the leases are dead, not because someone remembered.
  const after = requestLease(table, { worker: worker.id, identity: 'c@1', ioDigest: WIRE, tick: 11 });
  assert.equal(after.granted, true);
  assert.equal(after.reclaimed ?? 0, 0);
  const census = describeJit(table, { tick: 11 });
  assert.equal(census.workers[0].live, 1);
  assert.equal(census.workers[0].free, 1);
  assert.equal(census.expired, 2, 'the lapsed leases are still in the record');
  assert.equal(leasesOf(table, worker.id).length, 3);
  assert.equal(leasesOf(table, worker.id, { tick: 11 }).filter((lease) => lease.state === 'expired-view').length, 0, 'the census tick already passed, so nothing is left showing as active-but-dead');
  throwsWith(() => leasesOf(table, 'nobody'), 'jit.worker');
});

test('using a lease is what keeps it alive, and a use after expiry is refused', () => {
  const { table, lease } = HELD({ ttl: 10 });
  const used = useLease(table, lease, { tick: 3 });
  assert.equal(used.used, true);
  assert.equal(lease.uses, 1);
  assert.equal(lease.lastUsedAt, 3);
  assert.match(used.message, /runs to 10/);
  assert.equal(useLease(table, lease, { tick: 9 }).used, true);
  assert.equal(lease.uses, 2);
  const late = useLease(table, lease, { tick: 10 });
  assert.equal(late.ok, false);
  assert.equal(late.reason, 'jit.expired');
  assert.match(late.message, /a use after expiry is a use the host has no record of/);
  assert.equal(lease.state, 'expired');
  assert.equal(lease.endedAt, 10);
  const again = useLease(table, lease, { tick: 11 });
  assert.equal(again.ok, false, 'an expired lease stays expired: the refusal is the same answer, not a new event');
  assert.equal(again.reason, 'jit.expired');
  throwsWith(() => useLease(table, 'worker-a#9', { tick: 3 }), 'jit.lease');
  throwsWith(() => useLease(table, lease, {}), 'jit.input');
});

test('an idle lease cannot be renewed: a slot held with paperwork is a leak', () => {
  const { table, lease } = HELD({ ttl: 10 });
  const idle = renewLease(table, lease, { tick: 5 });
  assert.equal(idle.ok, false);
  assert.equal(idle.reason, 'jit.idle');
  assert.match(idle.message, /has not been used since it was granted/);
  assert.equal(lease.expiresAt, 10, 'a refused renewal does not move the deadline');
  useLease(table, lease, { tick: 6 });
  const renewed = renewLease(table, lease, { tick: 7 });
  assert.equal(renewed.renewed, true);
  assert.equal(lease.expiresAt, 17);
  assert.equal(lease.renewals, 1);
  assert.equal(lease.usedSinceRenewal, false);
  const idleAgain = renewLease(table, lease, { tick: 8 });
  assert.equal(idleAgain.reason, 'jit.idle');
  assert.match(idleAgain.message, /has not been used since renewal 1/);
  assert.match(explainLease(lease), /last used at 6 \(1 use\(s\)\), 1 renewal\(s\)/);
});

test('a JIT lease is short by construction: renewals and total life are both bounded', () => {
  const { table, lease } = HELD({ ttl: 10, maxRenewals: 1 });
  useLease(table, lease, { tick: 1 });
  assert.equal(renewLease(table, lease, { tick: 2 }).renewed, true);
  useLease(table, lease, { tick: 3 });
  const exhausted = renewLease(table, lease, { tick: 4 });
  assert.equal(exhausted.ok, false);
  assert.equal(exhausted.reason, 'jit.ttl');
  assert.match(exhausted.message, /has used all 1 renewal\(s\)/);

  const long = HELD({ ttl: 100, maxRenewals: 5 });
  useLease(long.table, long.lease, { tick: 1 });
  const beyond = renewLease(long.table, long.lease, { tick: 100 });
  assert.equal(beyond.ok, false);
  assert.equal(beyond.reason, 'jit.ttl');
  assert.match(beyond.message, /would outlive the 120-tick ceiling from grant \(tick 120\)/);
  const within = renewLease(long.table, long.lease, { tick: 19 });
  assert.equal(within.renewed, true);
  assert.equal(long.lease.expiresAt, 119);
  throwsWith(() => renewLease(long.table, long.lease, { tick: 20, ttl: 0 }), 'jit.ttl');
});

test('expiry is a record, not a deletion, and releasing a lapsed lease is bookkeeping', () => {
  const { table, worker, lease } = HELD({ ttl: 10 });
  useLease(table, lease, { tick: 2 });
  const sweep = reapExpired(table, { tick: 12 });
  assert.deepEqual([...sweep.reclaimed], ['worker-a#1']);
  assert.equal(sweep.slots, 1);
  assert.match(sweep.message, /1 slot\(s\) returned to their pools/);
  assert.equal(lease.state, 'expired');
  assert.equal(lease.uses, 1, 'the record keeps what the lease did');
  assert.equal(lease.lastUsedAt, 2);
  assert.equal(reapExpired(table, { tick: 13 }).slots, 0, 'sweeping twice reclaims nothing twice');
  const release = releaseLease(table, lease, { tick: 13 });
  assert.equal(release.ok, true);
  assert.equal(release.released, false);
  assert.equal(release.alreadyExpired, true);
  assert.match(release.message, /the slot came back on its own/);
  assert.equal(lease.state, 'expired', 'a lapsed lease does not become a released one');
  const second = releaseLease(table, leasesOf(table, worker.id)[0], { tick: 14 });
  assert.equal(second.ok, true);
  throwsWith(() => reapExpired(table, {}), 'jit.input');
});

test('releasing a live lease returns the slot, and releasing it twice is refused', () => {
  const { table, worker, lease } = HELD();
  const released = releaseLease(table, lease, { tick: 4 });
  assert.equal(released.released, true);
  assert.equal(lease.state, 'released');
  assert.equal(lease.endedAt, 4);
  assert.match(released.message, /slot returned on 'worker-a' at tick 4/);
  assert.equal(describeJit(table, { tick: 4 }).workers[0].free, 2);
  throwsWith(() => releaseLease(table, lease, { tick: 5 }), 'jit.lease');
  assert.match(throwsWith(() => releaseLease(table, lease, { tick: 5 }), 'jit.lease').message, /count one slot twice/);
  assert.match(throwsWith(() => useLease(table, lease, { tick: 5 }), 'jit.lease').message, /a released lease is not a licence/);
  assert.equal(requestLease(table, { worker: worker.id, identity: 'n8n-nodes-base.set@3.4', ioDigest: WIRE, tick: 5 }).granted, true, 'the slot can be asked for again');
});

test('the census answers for a tick and digests the whole picture', () => {
  const { table, worker } = TABLE({ slots: 4, ttl: 20 });
  requestLease(table, { worker: worker.id, identity: 'a@1', ioDigest: WIRE, tick: 0 });
  requestLease(table, { worker: worker.id, identity: 'b@1', ioDigest: WIRE, tick: 1 });
  const third = requestLease(table, { worker: worker.id, identity: 'c@1', ioDigest: WIRE, tick: 1 });
  useLease(table, third.lease, { tick: 2 });
  renewLease(table, third.lease, { tick: 3 });
  releaseLease(table, requestLease(table, { worker: worker.id, identity: 'd@1', ioDigest: WIRE, tick: 4 }).lease, { tick: 5 });
  const census = describeJit(table, { tick: 6 });
  assert.equal(census.contract, JIT_CONTRACT);
  assert.equal(census.tick, 6);
  assert.equal(census.records, 4);
  assert.equal(census.active, 3);
  assert.equal(census.released, 1);
  assert.equal(census.renewalsUsed, 1);
  assert.equal(census.uses, 1);
  assert.equal(census.workers.length, 1);
  assert.deepEqual(census.workers[0].expiringAt, [20, 21, 23]);
  assert.match(census.censusDigest, /^[0-9a-f]{64}$/);
  const { censusDigest, ...body } = census;
  assert.equal(censusDigest, leaseDigest(body));
  assert.equal(stableJson({ b: 1, a: 2 }), stableJson({ a: 2, b: 1 }));
  assert.notEqual(describeJit(table, { tick: 21 }).censusDigest, census.censusDigest, 'the census is a reading of a tick, and ticks differ');
  assert.equal(describeJit(table, { tick: 21 }).workers[0].live, 1, 'the two leases granted at tick 1 lapsed at 21, the renewed one did not');
  throwsWith(() => describeJit(table, {}), 'jit.input');
  throwsWith(() => describeJit({}, { tick: 1 }), 'jit.input');
});

/* --------------------------------------------------------------------- walls */

test('the contract is bookkeeping about slots: no scheduler, no cache, no loader, no clock', () => {
  const source = readFileSync(new URL('../src/lego/jit-lease.mjs', import.meta.url), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const forbidden of ['node:fs', 'node:net', 'node:http', 'node:os', 'node:child_process', 'process.', 'Math.random', 'setTimeout', 'performance.', 'fetch(', 'node:vm', 'eval(']) {
    assert.equal(code.includes(forbidden), false, `the JIT lease contract must not reference ${forbidden}`);
  }
  assert.deepEqual([...code.matchAll(/from '(node:[a-z_/]+)'/g)].map((match) => match[1]), ['node:crypto']);
  assert.equal(/\bnew Date\b|\bDate\.now\b/.test(code), false, 'every answer takes the tick it answers for');
  for (const forbidden of ['./runtime-lease.mjs', './node-health.mjs', './registry-compiler.mjs', './io-compiler.mjs', './admission-explain.mjs', './canary-rollout.mjs', './revocation-bulletin.mjs', './resolution-manifest.mjs']) {
    assert.equal(code.includes(forbidden), false, `P6.22 must not reach into ${forbidden}: slots are its business and nothing else's`);
  }
  assert.ok(code.includes("from './node-registry.mjs'"), 'the locality vocabulary is P6.1\'s, quoted');
  for (const name of ['createLeaseTable', 'acquireLease', 'drainEpoch', 'mayServe', 'createHealthTable', 'compileRegistryEpoch']) {
    assert.equal(code.includes(name), false, `${name} belongs to another milestone: an epoch lease and a slot lease are different promises`);
  }
});

/* ------------------------------------------------------------------- lock row */

test('the contract-lock row is canonical: one row, version, ops, tests, exports, domain path', () => {
  const lock = JSON.parse(readFileSync(new URL('../src/lego/contracts/contract-lock.json', import.meta.url)));
  const rows = lock.contracts.filter((contract) => contract.id === 'runtime.jit');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].version, JIT_CONTRACT_VERSION);
  assert.equal(rows[0].domain, 'node-registry');
  assert.equal(rows[0].status, 'implemented');
  assert.deepEqual(rows[0].surface, ['src/lego/jit-lease.mjs']);
  assert.deepEqual(rows[0].tests, ['apps/n8n-lego/test/lego-jit-lease.test.mjs']);
  for (const name of ['createJitTable', 'registerWorker', 'requestLease', 'useLease', 'renewLease', 'releaseLease', 'reapExpired', 'describeJit']) {
    assert.equal(rows[0].exports['src/lego/jit-lease.mjs'].includes(name), true, `${name} must be locked`);
  }
  for (const id of ['node.registry', 'runtime.lease', 'registry.compiler', 'node.io', 'node.admission', 'node.sbom', 'node.canary', 'node.revocation']) {
    assert.equal(lock.contracts.find((contract) => contract.id === id).version, '0.1.0', `P6.22 must not re-version ${id}`);
  }
  const domain = JSON.parse(readFileSync(new URL('../src/lego/manifest/domains.json', import.meta.url)))
    .domains.find((entry) => entry.id === 'node-registry');
  assert.equal(domain.contract.id, 'node.portability');
  assert.ok(domain.paths.includes('src/lego/jit-lease.mjs'));
});
