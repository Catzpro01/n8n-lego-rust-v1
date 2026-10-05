/**
 * P5-M17 — execution retry model over the execution-store extension of the
 * storage facade. Double-retry refusal + linkage; no silent second run; API
 * routes stay gated upstream.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStorage } from '../src/lego/storage/contract.mjs';
import { createLocalStorage } from '../src/lego/storage/local-provider.mjs';
import { createTestClock } from '../src/lego/storage/conformance.mjs';
import {
  createExecutionRetryModel, ExecutionRetryModelError, RETRY_ERROR_CODES,
  RETRY_STATES, RETRY_TRANSITIONS, RETRY_ELIGIBLE_EXECUTION_STATES, EXECUTION_STATES,
} from '../src/lego/execution-retry-model.mjs';

const setup = (name, executions = {}) => {
  const clock = createTestClock();
  const provider = createLocalStorage({ clock });
  let n = 0;
  const idFactory = () => `rty-${String(++n).padStart(6, '0')}-id`;
  const namespace = `rty-${name.replace(/\W+/g, '_')}`;
  const lookup = (id) => (Object.prototype.hasOwnProperty.call(executions, id) ? executions[id] : null);
  const hostA = createExecutionRetryModel(createStorage(provider), { clock, idFactory, executionLookup: lookup, namespace });
  const hostB = createExecutionRetryModel(createStorage(provider), { clock, idFactory, executionLookup: lookup, namespace });
  return { clock, hostA, hostB };
};

const ELIGIBLE = { 'exec-000001-id': { state: 'failed' }, 'exec-000002-id': { state: 'cancelled' } };

test('1. create/get round-trip: retry is bound to the original execution (linkage)', () => {
  const { hostA } = setup('t1', ELIGIBLE);
  const created = hostA.createRetry({
    originalExecutionId: 'exec-000001-id', requestedBy: 'alice', reason: 'transient network',
  });
  assert.equal(created.retryId, 'rty-000001-id', 'injected idFactory is deterministic');
  assert.equal(created.originalExecutionId, 'exec-000001-id', 'retry is bound to its execution');
  assert.equal(created.state, 'created');

  const byRetryId = hostA.getRetry(created.retryId);
  assert.equal(byRetryId.originalExecutionId, 'exec-000001-id');
  const byExecutionId = hostA.getRetry('exec-000001-id');
  assert.equal(byExecutionId.retryId, created.retryId);
  assert.equal(typeof byRetryId.version, 'string', 'opaque version for CAS callers');
});

test('2. double-retry refusal: at most one retry per execution, ever (no silent second run)', () => {
  const { hostA, hostB } = setup('t2', ELIGIBLE);
  hostA.createRetry({ originalExecutionId: 'exec-000001-id', requestedBy: 'alice' });
  for (const host of [hostA, hostB]) {
    assert.throws(
      () => host.createRetry({ originalExecutionId: 'exec-000001-id', requestedBy: 'bob' }),
      (e) => e instanceof ExecutionRetryModelError && e.code === RETRY_ERROR_CODES.CONFLICT,
      'a second retry request is refused (same host and cross-host)',
    );
  }
  assert.deepEqual(hostA.listRetries({ limit: 100 }).retries.map((r) => r.originalExecutionId),
    ['exec-000001-id'], 'exactly one record exists');
});

test('3. terminal-state rule on the ORIGINAL execution: only failed|cancelled are retry-eligible', () => {
  const { hostA } = setup('t3', {
    'exec-000001-id': { state: 'failed' },
    'exec-000002-id': { state: 'cancelled' },
    'exec-000003-id': { state: 'running' },
    'exec-000004-id': { state: 'succeeded' },
  });
  assert.deepEqual(RETRY_ELIGIBLE_EXECUTION_STATES, ['failed', 'cancelled']);
  assert.deepEqual(EXECUTION_STATES, ['running', 'succeeded', 'failed', 'cancelled']);
  assert.equal(hostA.createRetry({ originalExecutionId: 'exec-000001-id', requestedBy: 'a' }).state, 'created');
  assert.equal(hostA.createRetry({ originalExecutionId: 'exec-000002-id', requestedBy: 'a' }).state, 'created');
  assert.throws(() => hostA.createRetry({ originalExecutionId: 'exec-000003-id', requestedBy: 'a' }),
    (e) => e.code === RETRY_ERROR_CODES.CONFLICT, 'running = parallel hidden run, refused');
  assert.throws(() => hostA.createRetry({ originalExecutionId: 'exec-000004-id', requestedBy: 'a' }),
    (e) => e.code === RETRY_ERROR_CODES.CONFLICT, 'succeeded = hidden second run, refused');
  assert.throws(() => hostA.createRetry({ originalExecutionId: 'exec-999999-id', requestedBy: 'a' }),
    (e) => e.code === RETRY_ERROR_CODES.NOT_FOUND, 'unknown execution refused');
});

test('4. retry lifecycle: created -> approved -> executed exactly once; end states terminal', () => {
  const { hostA } = setup('t4', ELIGIBLE);
  const t = hostA.createRetry({ originalExecutionId: 'exec-000001-id', requestedBy: 'a' });
  const approved = hostA.approveRetry(t.retryId, { version: t.version });
  assert.equal(approved.state, 'approved');
  const executed = hostA.executeRetry(t.retryId, { version: approved.version });
  assert.equal(executed.state, 'executed');
  assert.deepEqual(RETRY_STATES, ['created', 'approved', 'executed', 'rejected', 'aborted']);
  assert.deepEqual(RETRY_TRANSITIONS.executed, [], 'executed is terminal');

  for (const again of ['approveRetry', 'executeRetry', 'rejectRetry', 'abortRetry']) {
    assert.throws(() => hostA[again](t.retryId, { version: executed.version }),
      (e) => e.code === RETRY_ERROR_CODES.INVALID, `executed -> ${again} is illegal`);
  }
  // created -> executed is illegal (must be approved first); created -> rejected/aborted legal
  const t2 = hostA.createRetry({ originalExecutionId: 'exec-000002-id', requestedBy: 'a' });
  assert.throws(() => hostA.executeRetry(t2.retryId, { version: t2.version }),
    (e) => e.code === RETRY_ERROR_CODES.INVALID);
  assert.equal(hostA.rejectRetry(t2.retryId, { version: t2.version }).state, 'rejected');
});

test('5. CAS semantics: stale tokens refused; version token REQUIRED', () => {
  const { hostA } = setup('t5', ELIGIBLE);
  const t = hostA.createRetry({ originalExecutionId: 'exec-000001-id', requestedBy: 'a' });
  const stale = t.version;
  hostA.approveRetry(t.retryId, { version: stale });
  assert.throws(() => hostA.rejectRetry(t.retryId, { version: stale }),
    (e) => e.code === RETRY_ERROR_CODES.CONFLICT, 'stale token refused');
  assert.throws(() => hostA.rejectRetry(t.retryId),
    (e) => e.code === RETRY_ERROR_CODES.INVALID, 'token is REQUIRED (no fallback)');
  assert.throws(() => hostA.getRetry('rty-999999-id'),
    (e) => e.code === RETRY_ERROR_CODES.NOT_FOUND);
});

test('6. multi-host: shared state, cross-host double-refusal and CAS conflicts', () => {
  const { hostA, hostB } = setup('t6', ELIGIBLE);
  const t = hostA.createRetry({ originalExecutionId: 'exec-000001-id', requestedBy: 'a' });
  assert.throws(() => hostB.createRetry({ originalExecutionId: 'exec-000001-id', requestedBy: 'b' }),
    (e) => e.code === RETRY_ERROR_CODES.CONFLICT);
  hostA.approveRetry(t.retryId, { version: t.version });
  assert.throws(() => hostB.rejectRetry(t.retryId, { version: t.version }),
    (e) => e.code === RETRY_ERROR_CODES.CONFLICT, 'cross-host lost update is explicit');
  assert.equal(hostB.getRetry(t.retryId).state, 'approved');
});

test('7. listRetries: stable order + filter-aware cursor paging', () => {
  const { hostA } = setup('t7', {
    'exec-000001-id': { state: 'failed' }, 'exec-000002-id': { state: 'failed' },
    'exec-000003-id': { state: 'failed' }, 'exec-000004-id': { state: 'failed' },
    'exec-000005-id': { state: 'failed' },
  });
  for (let i = 1; i <= 5; i += 1) {
    hostA.createRetry({ originalExecutionId: `exec-00000${i}-id`, requestedBy: 'a' });
  }
  const p1 = hostA.listRetries({ limit: 2 });
  assert.equal(p1.retries.length, 2);
  assert.ok(p1.nextCursor);
  const p2 = hostA.listRetries({ limit: 2, cursor: p1.nextCursor });
  assert.equal(p2.retries.length, 2);
  const p3 = hostA.listRetries({ limit: 2, cursor: p2.nextCursor });
  assert.equal(p3.retries.length, 1);
  assert.equal(p3.nextCursor, null);
  assert.equal(hostA.listRetries({ limit: 100 }).retries.length, 5);
});

test('8. rollback = unmount: namespace isolation leaves history untouched but hidden', () => {
  const { hostA, clock } = setup('t8', ELIGIBLE);
  const t = hostA.createRetry({ originalExecutionId: 'exec-000001-id', requestedBy: 'a' });
  const other = createExecutionRetryModel(createStorage(createLocalStorage({ clock })), {
    clock,
    idFactory: () => 'rty-999999-id',
    executionLookup: (id) => ELIGIBLE[id] ?? null,
    namespace: 'rty_t8_v2',
  });
  assert.throws(() => other.getRetry(t.retryId),
    (e) => e.code === RETRY_ERROR_CODES.NOT_FOUND);
  assert.equal(hostA.getRetry(t.retryId).originalExecutionId, 'exec-000001-id', 'original history stays intact');
});

test('9. surface pin + determinism: closed model keys and stable serialization', () => {
  const { hostA } = setup('t9', ELIGIBLE);
  assert.deepEqual(Object.keys(hostA).sort(), [
    'abortRetry', 'approveRetry', 'capabilities', 'createRetry', 'executeRetry', 'getRetry',
    'listRetries', 'namespace', 'rejectRetry',
  ].sort(), 'model surface is closed');

  const clock = createTestClock();
  const mk = (ns) => createExecutionRetryModel(createStorage(createLocalStorage({ clock })), {
    clock,
    idFactory: () => 'rty-000001-id',
    executionLookup: (id) => ELIGIBLE[id] ?? null,
    namespace: ns,
  });
  const a = mk('deta').createRetry({ originalExecutionId: 'exec-000001-id', requestedBy: 'x', reason: 'r' });
  const b = mk('detb').createRetry({ originalExecutionId: 'exec-000001-id', requestedBy: 'x', reason: 'r' });
  assert.equal(JSON.stringify({ ...a }), JSON.stringify({ ...b }), 'identical inputs, identical records');
});
