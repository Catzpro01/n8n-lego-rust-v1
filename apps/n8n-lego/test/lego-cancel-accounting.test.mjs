/**
 * P6.23 — cancellation and accounting.
 * Contract `runtime.cancel@0.1.0`.
 *
 * Matrix: the token's state machine with its deadline, the idempotent request that does not
 * buy time, checkpoints that notice a missed grace, settling where the race is named rather
 * than erased, addressed charges with duplicates refused, releases that happen exactly once,
 * an abandoned execution that keeps holding its slot, the totals, the reads, and the walls.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  CANCEL_CAUSES,
  CANCEL_CONTRACT,
  CANCEL_CONTRACT_VERSION,
  CANCEL_OPERATIONS,
  CANCEL_PERMISSIONS,
  CANCEL_REASONS,
  CANCEL_RULES,
  CANCEL_SCHEMA_VERSION,
  CANCEL_STATES,
  CHARGE_KINDS,
  CancelError,
  DEFAULT_GRACE_TICKS,
  MAX_GRACE_TICKS,
  SETTLE_OUTCOMES,
  cancelDigest,
  charge,
  checkpoint,
  createAccountingLedger,
  createCancelToken,
  describeLedger,
  explainLedger,
  explainToken,
  isAccountingLedger,
  isCancelToken,
  releaseCharge,
  requestCancel,
  settleExecution,
  settleToken,
  stableJson,
} from '../src/lego/cancel-accounting.mjs';

/* ------------------------------------------------------------------ fixtures */

const TOKEN = (overrides = {}) => createCancelToken({ executionId: 'exec-1', tick: 0, ...overrides });

const CANCELLING = ({ grace } = {}) => {
  const token = TOKEN();
  const requested = requestCancel(token, { tick: 10, cause: 'operator', reason: 'user stopped the run', ...(grace === undefined ? {} : { grace }) });
  assert.equal(requested.requested, true);
  return token;
};

const CHARGED = () => {
  const ledger = createAccountingLedger();
  const charged = charge(ledger, { executionId: 'exec-1', kind: 'slot', amount: 1, tick: 0, reference: 'slot' });
  assert.equal(charged.charged, true);
  return { ledger, entry: charged.entry };
};

const throwsWith = (fn, code) => {
  let caught = null;
  try { fn(); } catch (error) { caught = error; }
  assert.ok(caught instanceof CancelError, `expected a CancelError carrying ${code}`);
  assert.equal(caught.code, 'lego.contract_violation');
  assert.equal(caught.meta.code, code);
  return caught;
};

/* ------------------------------------------------------------------ contract */

test('the contract surface is the published one: id, version, ops, closed vocabularies', () => {
  assert.equal(CANCEL_CONTRACT, 'runtime.cancel@0.1.0');
  assert.equal(CANCEL_CONTRACT_VERSION, '0.1.0');
  assert.equal(CANCEL_SCHEMA_VERSION, 1);
  assert.deepEqual([...CANCEL_OPERATIONS], ['request', 'checkpoint', 'settle', 'charge', 'release', 'describe']);
  assert.deepEqual([...CANCEL_PERMISSIONS], ['node:read']);
  assert.deepEqual([...CANCEL_STATES], ['running', 'cancelling', 'cancelled', 'completed', 'abandoned']);
  assert.deepEqual([...SETTLE_OUTCOMES], ['cancelled', 'completed', 'completed-after-cancel', 'abandoned']);
  assert.deepEqual([...CHARGE_KINDS], ['slot', 'ticks', 'bytes', 'side-effects']);
  assert.equal(CANCEL_CAUSES.length, 7);
  assert.equal(CANCEL_REASONS.length, 8);
  assert.equal(DEFAULT_GRACE_TICKS, 30);
  assert.equal(MAX_GRACE_TICKS, 600);
  assert.match(CANCEL_RULES.race, /something happened and it has to be billed/);
  assert.match(CANCEL_RULES.authority, /never decides whether something should run/);
});

test('cancellation is a state machine with a deadline, and a request that does not buy time', () => {
  const token = TOKEN();
  assert.equal(isCancelToken(token), true);
  assert.equal(token.state, 'running');
  assert.equal(token.deadline, null);
  assert.match(token.tokenDigest, /^[0-9a-f]{64}$/);
  const { tokenDigest, ...body } = token;
  assert.equal(tokenDigest, cancelDigest(body));

  assert.equal(requestCancel(token, { tick: 10, cause: 'operator', reason: 'stopped' }).requested, true);
  assert.equal(token.state, 'cancelling');
  assert.equal(token.deadline, 40);
  const again = requestCancel(token, { tick: 20, cause: 'quota', reason: 'a different reason', grace: 1 });
  assert.equal(again.already, true);
  assert.equal(again.requested, false);
  assert.equal(token.deadline, 40, 'asking again does not extend the grace');
  assert.equal(token.cause, 'operator', 'and it does not rewrite why');
  assert.match(again.message, /does not extend the grace/);
  assert.match(explainToken(token), /execution exec-1: cancelling — cancelled for operator at tick 10 \(grace to 40\); 0 checkpoint\(s\); not settled/);

  throwsWith(() => requestCancel(TOKEN(), { tick: 10, cause: 'because', reason: 'x' }), 'cancel.request');
  throwsWith(() => requestCancel(TOKEN(), { tick: 10, cause: 'operator', reason: '' }), 'cancel.request');
  throwsWith(() => requestCancel(TOKEN(), { tick: 10, cause: 'operator', reason: 'x', grace: 0 }), 'cancel.deadline');
  throwsWith(() => requestCancel(TOKEN(), { tick: 10, cause: 'operator', reason: 'x', grace: MAX_GRACE_TICKS + 1 }), 'cancel.deadline');
  throwsWith(() => requestCancel(TOKEN(), { cause: 'operator', reason: 'x' }), 'cancel.input');
  throwsWith(() => createCancelToken({ executionId: '', tick: 0 }), 'cancel.input');
  throwsWith(() => createCancelToken({ executionId: 'exec-1' }), 'cancel.input');
  throwsWith(() => cancelDigest === undefined ? requestCancel({}, { tick: 1, cause: 'operator', reason: 'x' }) : requestCancel({}, { tick: 1, cause: 'operator', reason: 'x' }), 'cancel.input');
  assert.equal(isCancelToken({ contract: CANCEL_CONTRACT, executionId: 'x' }), false);
});

test('a checkpoint is where a runner asks, and where a missed grace is noticed', () => {
  const token = TOKEN();
  const running = checkpoint(token, { tick: 5 });
  assert.equal(running.proceed, true);
  assert.equal(token.checkpoints, 1);
  assert.match(running.message, /no cancellation has been asked for/);

  requestCancel(token, { tick: 10, cause: 'health', reason: 'the node is failing', grace: 10 });
  const stopped = checkpoint(token, { tick: 12 });
  assert.equal(stopped.ok, true);
  assert.equal(stopped.proceed, false);
  assert.equal(stopped.reason, 'cancel.request');
  assert.match(stopped.message, /starting new work is refused, and so is pretending it was not asked/);

  const missed = checkpoint(token, { tick: 20 });
  assert.equal(missed.ok, false);
  assert.equal(missed.abandoned, true);
  assert.equal(missed.reason, 'cancel.deadline');
  assert.equal(token.state, 'abandoned');
  assert.equal(token.abandonedAt, 20);
  assert.match(missed.message, /its slot stays in the ledger/);
  const after = checkpoint(token, { tick: 21 });
  assert.equal(after.proceed, false);
  assert.equal(after.reason, 'cancel.state');
  throwsWith(() => checkpoint(token, {}), 'cancel.input');
  throwsWith(() => checkpoint({}, { tick: 1 }), 'cancel.input');
});

test('the race is recorded, not erased: a completed run after a cancellation is completed-after-cancel', () => {
  const raced = CANCELLING();
  assert.match(
    throwsWith(() => settleToken(raced, { tick: 20, outcome: 'completed' }), 'cancel.settle').message,
    /claiming 'completed' erases the cancellation/,
  );
  assert.equal(raced.settledAt, null, 'a refused settlement changes nothing');
  const settled = settleToken(raced, { tick: 20, outcome: 'completed-after-cancel', producedOutput: true });
  assert.equal(settled.outcome, 'completed-after-cancel');
  assert.equal(raced.state, 'completed', 'the work did finish; the outcome names how');
  assert.equal(raced.producedOutput, true);
  assert.match(explainToken(raced), /settled at tick 20 as 'completed-after-cancel', output produced: true/);
  assert.match(throwsWith(() => settleToken(raced, { tick: 21, outcome: 'cancelled' }), 'cancel.settle').message, /a second settlement would rewrite what happened/);
  throwsWith(() => settleToken(CANCELLING(), { tick: 20, outcome: 'completed-after-cancel' }), 'cancel.settle');
  assert.match(throwsWith(() => settleToken(CANCELLING(), { tick: 20, outcome: 'completed-after-cancel' }), 'cancel.settle').message, /says whether output was produced/);
});

test('an outcome has to be consistent with what actually happened', () => {
  assert.match(
    throwsWith(() => settleToken(TOKEN(), { tick: 20, outcome: 'cancelled' }), 'cancel.settle').message,
    /nothing was cancelled/,
  );
  assert.equal(settleToken(TOKEN(), { tick: 20, outcome: 'completed' }).outcome, 'completed');
  const abandoned = TOKEN({ grace: 5 });
  requestCancel(abandoned, { tick: 10, cause: 'timeout', reason: 'took too long' });
  assert.match(
    throwsWith(() => settleToken(abandoned, { tick: 20, outcome: 'abandoned' }), 'cancel.settle').message,
    /abandoned when its grace has passed, not when somebody says so/,
  );
  // The checkpoint IS the abandonment: the token settles itself when the grace passes, so a
  // later settlement would be a second record of one event.
  assert.equal(checkpoint(abandoned, { tick: 15 }).abandoned, true);
  assert.equal(abandoned.abandonedAt, 15, 'the checkpoint notices the abandonment');
  assert.equal(abandoned.settledAt, null, 'and it does not settle the accounting: that is a separate act');
  assert.match(explainToken(abandoned), /abandoned at tick 15, not yet settled/);
  assert.equal(settleToken(abandoned, { tick: 15, outcome: 'abandoned' }).outcome, 'abandoned');
  assert.match(throwsWith(() => settleToken(abandoned, { tick: 16, outcome: 'abandoned' }), 'cancel.settle').message, /a second settlement would rewrite what happened/);
  throwsWith(() => settleToken(CANCELLING(), { tick: 20, outcome: 'maybe' }), 'cancel.settle');
  throwsWith(() => settleToken(CANCELLING(), { outcome: 'cancelled' }), 'cancel.input');
  const done = TOKEN();
  settleToken(done, { tick: 5, outcome: 'completed' });
  throwsWith(() => requestCancel(done, { tick: 6, cause: 'operator', reason: 'too late' }), 'cancel.state');
  assert.match(throwsWith(() => requestCancel(done, { tick: 6, cause: 'operator', reason: 'too late' }), 'cancel.state').message, /rewrite what happened/);
});

/* ------------------------------------------------------------------- ledger */

test('charges are addressed: the same reference with the same amount is a duplicate, not a second charge', () => {
  const { ledger, entry } = CHARGED();
  assert.equal(isAccountingLedger(ledger), true);
  assert.match(entry.entryDigest, /^[0-9a-f]{64}$/);
  const duplicate = charge(ledger, { executionId: 'exec-1', kind: 'slot', amount: 1, tick: 1, reference: 'slot' });
  assert.equal(duplicate.charged, false);
  assert.equal(duplicate.duplicate, true);
  assert.match(duplicate.message, /the duplicate is ignored, not added/);
  assert.equal(describeLedger(ledger).byKind.slot.charged, 1);
  assert.match(
    throwsWith(() => charge(ledger, { executionId: 'exec-1', kind: 'slot', amount: 2, tick: 2, reference: 'slot' }), 'accounting.duplicate').message,
    /two amounts for one reference is two rumours for one fact/,
  );
  assert.equal(charge(ledger, { executionId: 'exec-1', kind: 'ticks', amount: 30, tick: 3, reference: 'run' }).charged, true);
  throwsWith(() => charge(ledger, { executionId: 'exec-1', kind: 'memories', amount: 1, tick: 3, reference: 'x' }), 'accounting.charge');
  throwsWith(() => charge(ledger, { executionId: 'exec-1', kind: 'slot', amount: 0, tick: 3, reference: 'x' }), 'accounting.charge');
  throwsWith(() => charge(ledger, { executionId: 'exec-1', kind: 'slot', amount: 1.5, tick: 3, reference: 'x' }), 'accounting.charge');
  throwsWith(() => charge(ledger, { executionId: 'exec-1', kind: 'slot', amount: 1, tick: 3 }), 'accounting.charge');
  throwsWith(() => charge(ledger, { executionId: '', kind: 'slot', amount: 1, tick: 3, reference: 'x' }), 'accounting.charge');
  throwsWith(() => charge(ledger, { executionId: 'exec-1', kind: 'slot', amount: 1, reference: 'x' }), 'cancel.input');
  throwsWith(() => charge({}, { executionId: 'exec-1', kind: 'slot', amount: 1, tick: 3, reference: 'x' }), 'cancel.input');
});

test('a release happens exactly once, and what was never charged does not come back', () => {
  const { ledger, entry } = CHARGED();
  const first = releaseCharge(ledger, { executionId: 'exec-1', kind: 'slot', reference: 'slot', amount: 1, tick: 9 });
  assert.equal(first.released, 1);
  assert.equal(first.outstanding, 0);
  assert.deepEqual([...entry.releaseTicks], [9]);
  assert.match(
    throwsWith(() => releaseCharge(ledger, { executionId: 'exec-1', kind: 'slot', reference: 'slot', amount: 1, tick: 10 }), 'accounting.release').message,
    /the same charge does not come back twice/,
  );
  assert.match(
    throwsWith(() => releaseCharge(ledger, { executionId: 'exec-9', kind: 'slot', reference: 'slot', amount: 1, tick: 10 }), 'accounting.release').message,
    /a slot that never existed/,
  );
  const partial = charge(ledger, { executionId: 'exec-2', kind: 'bytes', amount: 100, tick: 3, reference: 'payload' }).entry;
  assert.equal(releaseCharge(ledger, { executionId: 'exec-2', kind: 'bytes', reference: 'payload', amount: 40, tick: 4 }).outstanding, 60);
  throwsWith(() => releaseCharge(ledger, { executionId: 'exec-2', kind: 'bytes', reference: 'payload', amount: 61, tick: 5 }), 'accounting.release');
  assert.equal(partial.released, 40);
  throwsWith(() => releaseCharge(ledger, { executionId: 'exec-2', kind: 'bytes', reference: 'payload' }), 'cancel.input');
});

test('settling an execution hands the slot back once, and an abandoned one keeps holding it', () => {
  const { ledger } = CHARGED();
  charge(ledger, { executionId: 'exec-1', kind: 'ticks', amount: 12, tick: 4, reference: 'run' });
  const token = CANCELLING({ grace: 5 });
  const cancelled = settleExecution(ledger, token, { tick: 15, outcome: 'cancelled' });
  assert.equal(cancelled.settled, true);
  assert.equal(cancelled.slot.held, false);
  assert.match(cancelled.slot.note, /returned 1/);
  assert.match(cancelled.message, /the slot came back once/);
  assert.equal(describeLedger(ledger).byKind.slot.outstanding, 0);
  assert.equal(describeLedger(ledger).byKind.ticks.outstanding, 12, 'a cancelled execution is not free: what it consumed stays consumed');

  const abandonedLedger = createAccountingLedger();
  charge(abandonedLedger, { executionId: 'exec-2', kind: 'slot', amount: 1, tick: 0, reference: 'slot' });
  const stuck = createCancelToken({ executionId: 'exec-2', tick: 0, grace: 5 });
  requestCancel(stuck, { tick: 10, cause: 'shutdown', reason: 'the host is going down' });
  checkpoint(stuck, { tick: 16 });
  const abandoned = settleExecution(abandonedLedger, stuck, { tick: 16, outcome: 'abandoned' });
  assert.equal(abandoned.slot.held, true);
  assert.match(abandoned.slot.note, /stays in the ledger/);
  assert.deepEqual([...describeLedger(abandonedLedger).outstandingSlots], ['exec-2:slot']);
  assert.match(explainLedger(abandonedLedger), /1 slot\(s\) outstanding \(exec-2:slot\)/);
});

test('settling an execution with nothing charged says so rather than inventing a release', () => {
  const ledger = createAccountingLedger();
  const token = CANCELLING();
  const settled = settleExecution(ledger, token, { tick: 15, outcome: 'cancelled' });
  assert.equal(settled.slot.held, false);
  assert.match(settled.slot.note, /no slot was charged for this execution/);
  assert.equal(describeLedger(ledger).entries, 0);
  const { ledger: ledger2 } = CHARGED();
  const raced = CANCELLING();
  const first = settleExecution(ledger2, raced, { tick: 20, outcome: 'completed-after-cancel', producedOutput: false });
  assert.equal(first.slot.held, false);
  assert.equal(raced.producedOutput, false);
  assert.match(explainLedger(ledger2), /slot 1\/1; no slot is outstanding/);
});

test('the totals answer per kind and per execution, and digest the whole picture', () => {
  const { ledger } = CHARGED();
  charge(ledger, { executionId: 'exec-1', kind: 'ticks', amount: 12, tick: 4, reference: 'run' });
  charge(ledger, { executionId: 'exec-2', kind: 'slot', amount: 2, tick: 5, reference: 'pool' });
  charge(ledger, { executionId: 'exec-2', kind: 'side-effects', amount: 1, tick: 5, reference: 'webhook-sent' });
  releaseCharge(ledger, { executionId: 'exec-2', kind: 'slot', reference: 'pool', amount: 1, tick: 6 });
  const described = describeLedger(ledger, { tick: 7 });
  assert.equal(described.entries, 4);
  assert.equal(described.tick, 7);
  assert.deepEqual(described.byKind.slot, { charged: 3, released: 1, outstanding: 2 });
  assert.deepEqual(described.byKind['side-effects'], { charged: 1, released: 0, outstanding: 1 });
  assert.deepEqual(described.byExecution['exec-2'], { charged: 3, released: 1, outstanding: 2, entries: 2 });
  assert.deepEqual([...described.outstandingSlots], ['exec-1:slot', 'exec-2:pool']);
  assert.match(described.ledgerDigest, /^[0-9a-f]{64}$/);
  const { ledgerDigest, ...body } = described;
  assert.equal(ledgerDigest, cancelDigest(body));
  assert.equal(stableJson({ b: 1, a: 2 }), stableJson({ a: 2, b: 1 }));
  throwWith: {
    throwsWith(() => describeLedger(ledger, { tick: -1 }), 'cancel.input');
    throwsWith(() => describeLedger({}, { tick: 1 }), 'cancel.input');
  }
  assert.equal(explainLedger(createAccountingLedger()), '0 charge(s) — nothing charged; no slot is outstanding');
});

/* --------------------------------------------------------------------- walls */

test('the contract records what happened: no scheduler, no slot table, no telemetry, no clock', () => {
  const source = readFileSync(new URL('../src/lego/cancel-accounting.mjs', import.meta.url), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const forbidden of ['node:fs', 'node:net', 'node:http', 'node:os', 'node:child_process', 'process.', 'Math.random', 'setTimeout', 'performance.', 'fetch(', 'node:vm', 'eval(']) {
    assert.equal(code.includes(forbidden), false, `the cancellation contract must not reference ${forbidden}`);
  }
  assert.deepEqual([...code.matchAll(/from '(node:[a-z_/]+)'/g)].map((match) => match[1]), ['node:crypto']);
  assert.equal(/\bnew Date\b|\bDate\.now\b/.test(code), false, 'every answer takes the tick it answers for');
  for (const forbidden of ['./jit-lease.mjs', './runtime-lease.mjs', './node-health.mjs', './io-compiler.mjs', './canary-rollout.mjs', './revocation-bulletin.mjs', './registry-compiler.mjs']) {
    assert.equal(code.includes(forbidden), false, `P6.23 must not reach into ${forbidden}: a cancelled execution hands its slot back through the record, not through the table`);
  }
  for (const name of ['requestLease', 'releaseLease', 'mayServe', 'drainEpoch', 'POST', 'emit(']) {
    assert.equal(code.includes(name), false, `${name} belongs to another milestone`);
  }
});

/* ------------------------------------------------------------------- lock row */

test('the contract-lock row is canonical: one row, version, ops, tests, exports, domain path', () => {
  const lock = JSON.parse(readFileSync(new URL('../src/lego/contracts/contract-lock.json', import.meta.url)));
  const rows = lock.contracts.filter((contract) => contract.id === 'runtime.cancel');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].version, CANCEL_CONTRACT_VERSION);
  assert.equal(rows[0].domain, 'node-registry');
  assert.equal(rows[0].status, 'implemented');
  assert.deepEqual(rows[0].surface, ['src/lego/cancel-accounting.mjs']);
  assert.deepEqual(rows[0].tests, ['apps/n8n-lego/test/lego-cancel-accounting.test.mjs']);
  for (const name of ['createCancelToken', 'requestCancel', 'checkpoint', 'settleToken', 'charge', 'releaseCharge', 'settleExecution', 'describeLedger']) {
    assert.equal(rows[0].exports['src/lego/cancel-accounting.mjs'].includes(name), true, `${name} must be locked`);
  }
  for (const id of ['node.registry', 'runtime.lease', 'runtime.jit', 'node.io', 'registry.compiler', 'node.admission', 'node.sbom', 'node.canary', 'node.revocation']) {
    assert.equal(lock.contracts.find((contract) => contract.id === id).version, '0.1.0', `P6.23 must not re-version ${id}`);
  }
  const domain = JSON.parse(readFileSync(new URL('../src/lego/manifest/domains.json', import.meta.url)))
    .domains.find((entry) => entry.id === 'node-registry');
  assert.equal(domain.contract.id, 'node.portability');
  assert.ok(domain.paths.includes('src/lego/cancel-accounting.mjs'));
});
