/**
 * P6.3 — Transactional package + single-flight install. Contract `package.transaction@0.1.0`.
 *
 * Matrix: plan determinism and identity validation, step ORDER (a journal is a
 * proof, not a log), attempt ceiling (retry allowed, loop impossible), replay
 * semantics (an old report is a no-op, a new result for a done step is a lie),
 * the visibility boundary (before it a failure costs nothing, after it the
 * registry is inconsistent and must be resumed or rolled back), the fence rule
 * (a stale lease cannot publish), commit/abort purity, journal determinism, and
 * the scope walls that keep this milestone out of P6.4+ territory.
 *
 * Pure: no filesystem, no network, no timers, no clock, no randomness, and no
 * mutation — the host does the IO, this contract judges the history it is told.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  PACKAGE_RECOVERY_ACTIONS,
  PACKAGE_TRANSACTION_CONTRACT,
  PACKAGE_TRANSACTION_CONTRACT_VERSION,
  PACKAGE_TRANSACTION_INPUT_SCHEMA_VERSION,
  PACKAGE_TRANSACTION_MAX_ATTEMPTS,
  PACKAGE_TRANSACTION_OPERATIONS,
  PACKAGE_TRANSACTION_PERMISSIONS,
  PACKAGE_TRANSACTION_REASONS,
  PACKAGE_TRANSACTION_RULES,
  PACKAGE_TRANSACTION_SCHEMA_VERSION,
  PACKAGE_TRANSACTION_STATUSES,
  PACKAGE_TRANSACTION_STEPS,
  PACKAGE_TRANSACTION_STEP_STATUSES,
  PACKAGE_TRANSACTION_VISIBILITY_BOUNDARY,
  PackageTransactionError,
  abortPackageTransaction,
  acquireInstallLease,
  commitPackageTransaction,
  createInstallGate,
  decidePackageRecovery,
  formatPackageTransaction,
  holdsInstallLease,
  isPackageTransaction,
  journalDigest,
  pendingPackageSteps,
  planPackageTransaction,
  recordPackageStep,
  releaseInstallLease,
  transactionJournal,
} from '../src/lego/package-transaction.mjs';

const EPOCH = 'b'.repeat(64);
const plan = (overrides = {}) => planPackageTransaction({
  package: 'n8n-nodes-base', version: '2.9.1', digest: `sha256:${'a'.repeat(64)}`, source: 'npm:n8n-nodes-base@2.9.1', ...overrides,
});
const run = (transaction, steps) => steps.reduce((current, step) => recordPackageStep(current, step), transaction);
const upTo = (stop) => PACKAGE_TRANSACTION_STEPS.slice(0, PACKAGE_TRANSACTION_STEPS.indexOf(stop) + 1).map((step) => ({ step }));
const publishInput = (lease, gate) => ({ step: 'publish', epochDigest: EPOCH, lease, gate });
const leased = () => {
  const admitted = acquireInstallLease(createInstallGate(), { owner: 'agent-3', package: 'n8n-nodes-base' });
  return { gate: admitted.gate, lease: admitted.lease };
};

/* ---------------------------------------------------------------- contract */

test('the contract identifies itself, is versioned and fixes the step order', () => {
  assert.equal(PACKAGE_TRANSACTION_CONTRACT, 'package.transaction@0.1.0');
  assert.equal(PACKAGE_TRANSACTION_CONTRACT_VERSION, '0.1.0');
  assert.equal(PACKAGE_TRANSACTION_SCHEMA_VERSION, 1);
  assert.deepEqual([...PACKAGE_TRANSACTION_STEPS], ['resolve', 'prepare', 'verify', 'stage', 'publish', 'activate']);
  assert.deepEqual([...PACKAGE_TRANSACTION_OPERATIONS], ['plan', 'record', 'commit', 'recover', 'lease']);
  assert.ok(PACKAGE_TRANSACTION_PERMISSIONS.every((word) => typeof word === 'string'));
  assert.equal(PACKAGE_TRANSACTION_VISIBILITY_BOUNDARY, 'publish');
  assert.equal(PACKAGE_TRANSACTION_MAX_ATTEMPTS, 2);
  assert.deepEqual([...PACKAGE_TRANSACTION_STEP_STATUSES], ['pending', 'done', 'failed']);
  assert.deepEqual([...PACKAGE_TRANSACTION_STATUSES], ['open', 'committed', 'failed', 'aborted']);
  assert.deepEqual([...PACKAGE_RECOVERY_ACTIONS], ['abort', 'resume', 'rollback', 'none']);
  assert.equal(PACKAGE_TRANSACTION_INPUT_SCHEMA_VERSION, 1);
});

test('the refusal vocabulary is closed, prefixed and free of duplicates', () => {
  assert.ok(PACKAGE_TRANSACTION_REASONS.length >= 8);
  assert.equal(new Set(PACKAGE_TRANSACTION_REASONS).size, PACKAGE_TRANSACTION_REASONS.length);
  assert.ok(PACKAGE_TRANSACTION_REASONS.every((reason) => reason.startsWith('package.transaction.')));
  assert.match(PACKAGE_TRANSACTION_RULES.visibility, /visibility boundary/);
  assert.match(PACKAGE_TRANSACTION_RULES.singleflight, /fence/);
  assert.match(PACKAGE_TRANSACTION_RULES.authority, /host does the IO/);
});

/* -------------------------------------------------------------------- plan */

test('a plan is deterministic, frozen and starts with every step pending', () => {
  const first = plan();
  const second = plan();
  assert.equal(first.transactionId, second.transactionId, 'the same intent plans the same transaction');
  assert.equal(first.status, 'open');
  assert.equal(first.seq, 0);
  assert.equal(first.attempts ?? 0, 0);
  assert.deepEqual(first.steps.map((entry) => entry.step), [...PACKAGE_TRANSACTION_STEPS]);
  assert.ok(first.steps.every((entry) => entry.status === 'pending' && entry.attempts === 0 && entry.seq === null));
  assert.ok(isPackageTransaction(first));
  assert.ok(Object.isFrozen(first) && Object.isFrozen(first.steps) && Object.isFrozen(first.steps[0]));
  assert.deepEqual([...pendingPackageSteps(first)], [...PACKAGE_TRANSACTION_STEPS]);
});

test('a different digest, source or version is a different transaction', () => {
  const ids = new Set([
    plan().transactionId,
    plan({ digest: `sha256:${'c'.repeat(64)}` }).transactionId,
    plan({ source: 'npm:mirror' }).transactionId,
    plan({ version: '2.9.2' }).transactionId,
  ]);
  assert.equal(ids.size, 4, 'an install identity that ignores the digest is not an identity');
});

test('package identity, version, digest and source all fail closed', () => {
  for (const bad of ['', 'N8N-Nodes-Base', 'n8n nodes', '@Scope/name', '.hidden']) {
    assert.throws(() => plan({ package: bad }), (error) => error.meta.code === 'package.transaction.identity');
  }
  for (const bad of ['', '2.9', 'v2.9.1', 'latest', '2.9.1.0']) {
    assert.throws(() => plan({ version: bad }), (error) => error.meta.code === 'package.transaction.identity');
  }
  for (const bad of ['', 'sha256:xyz', 'a'.repeat(64), `md5:${'a'.repeat(64)}`, `sha256:${'A'.repeat(64)}`]) {
    assert.throws(() => plan({ digest: bad }), (error) => error.meta.code === 'package.transaction.digest');
  }
  assert.throws(() => plan({ source: '' }), (error) => error.meta.code === 'package.transaction.source');
  assert.throws(() => planPackageTransaction(null), PackageTransactionError);
  // Scoped packages and pre-release versions are legitimate, not exotic.
  assert.ok(plan({ package: '@n8n/n8n-nodes-langchain', version: '1.0.0-beta.2' }));
});

/* ------------------------------------------------------------------ record */

test('a full run records every step in order and commits', () => {
  const { gate, lease } = leased();
  let transaction = run(plan(), upTo('stage'));
  transaction = recordPackageStep(transaction, publishInput(lease, gate));
  transaction = recordPackageStep(transaction, { step: 'activate' });
  assert.equal(transaction.epochDigest, EPOCH);
  assert.equal(transaction.leaseFence, lease.fence);
  const committed = commitPackageTransaction(transaction);
  assert.equal(committed.ok, true);
  assert.equal(committed.committed.status, 'committed');
  assert.equal(committed.journal.status, 'committed');
  assert.deepEqual([...pendingPackageSteps(committed.committed)], []);
});

test('recording is immutable: every step returns a new frozen transaction', () => {
  const start = plan();
  const after = recordPackageStep(start, { step: 'resolve' });
  assert.notEqual(after, start);
  assert.equal(start.steps[0].status, 'pending', 'the transaction in front of an operator cannot change under them');
  assert.equal(after.steps[0].status, 'done');
  assert.ok(Object.isFrozen(after));
  assert.equal(after.steps[0].seq, 1);
});

test('steps happen in order — the journal is a proof, not a log', () => {
  assert.throws(() => recordPackageStep(plan(), { step: 'verify' }), (error) => error.meta.code === 'package.transaction.order');
  assert.throws(() => recordPackageStep(plan(), { step: 'publish', epochDigest: EPOCH }), (error) => error.meta.code === 'package.transaction.order');
  const staged = run(plan(), upTo('stage'));
  assert.throws(() => recordPackageStep(staged, { step: 'activate' }), (error) => {
    assert.equal(error.meta.blockedBy, 'publish');
    return true;
  });
});

test('an unknown step and a nonsense status are refused, not coerced', () => {
  assert.throws(() => recordPackageStep(plan(), { step: 'download' }), (error) => error.meta.code === 'package.transaction.unknown_step');
  assert.throws(() => recordPackageStep(plan(), { step: 'resolve', status: 'maybe' }), (error) => error.meta.code === 'package.transaction.replay');
  assert.throws(() => recordPackageStep(plan(), { step: 'resolve', status: 'pending' }), (error) => error.meta.code === 'package.transaction.replay');
  assert.throws(() => recordPackageStep({ ok: true }, { step: 'resolve' }), PackageTransactionError);
});

/* ----------------------------------------------------------- retries/replay */

test('a failed attempt keeps the transaction open so recovery can resume it', () => {
  const failed = recordPackageStep(plan(), { step: 'resolve', status: 'failed', detail: 'dns' });
  assert.equal(failed.steps[0].status, 'failed');
  assert.equal(failed.steps[0].attempts, 1);
  assert.equal(failed.status, 'open', 'one failure is a retry, not a dead transaction');
  assert.equal(failed.reason, 'step-failed:resolve');
  const decision = decidePackageRecovery(failed);
  assert.equal(decision.action, 'resume');
  assert.equal(decision.resumeFrom, 'resolve');
  assert.equal(decision.publishedAt, null);
});

test('a retry can succeed and the history shows both attempts', () => {
  let transaction = recordPackageStep(plan(), { step: 'resolve', status: 'failed', detail: 'dns' });
  transaction = recordPackageStep(transaction, { step: 'resolve', status: 'done', attempt: 2 });
  assert.equal(transaction.steps[0].status, 'done');
  assert.equal(transaction.steps[0].attempts, 2);
  assert.equal(transaction.seq, 2, 'both attempts are real events in the sequence');
});

test('the attempt ceiling ends the transaction instead of looping', () => {
  let transaction = recordPackageStep(plan(), { step: 'resolve', status: 'failed', detail: 'dns-1' });
  transaction = recordPackageStep(transaction, { step: 'resolve', status: 'failed', detail: 'dns-2' });
  assert.equal(transaction.steps[0].attempts, PACKAGE_TRANSACTION_MAX_ATTEMPTS);
  assert.equal(transaction.status, 'failed');
  assert.throws(() => recordPackageStep(transaction, { step: 'resolve', status: 'failed', detail: 'dns-3' }), (error) => error.meta.code === 'package.transaction.attempts');
  assert.equal(decidePackageRecovery(transaction).action, 'abort', 'nothing was published, so there is nothing to undo');
  assert.equal(decidePackageRecovery(transaction).exhausted, true);
});

test('replaying a recorded attempt is a no-op — even after the transaction closed', () => {
  let transaction = recordPackageStep(plan(), { step: 'resolve', status: 'failed', detail: 'dns' });
  assert.equal(recordPackageStep(transaction, { step: 'resolve', status: 'failed', detail: 'dns', attempt: 1 }), transaction);
  transaction = recordPackageStep(transaction, { step: 'resolve', status: 'failed', detail: 'dns-2' });
  assert.equal(transaction.status, 'failed');
  assert.equal(recordPackageStep(transaction, { step: 'resolve', status: 'failed', detail: 'dns-2', attempt: 2 }), transaction, 'a crashed driver must be able to reconcile its own journal');
  assert.throws(() => recordPackageStep(transaction, { step: 'prepare', status: 'done' }), (error) => error.meta.code === 'package.transaction.closed');
});

test('attempt numbers are sequential: a gap is a lost report, not a new attempt', () => {
  const transaction = recordPackageStep(plan(), { step: 'resolve', status: 'failed', detail: 'dns' });
  assert.throws(() => recordPackageStep(transaction, { step: 'resolve', status: 'done', attempt: 7 }), (error) => {
    assert.equal(error.meta.code, 'package.transaction.replay');
    assert.equal(error.meta.expected, 2);
    return true;
  });
  assert.throws(() => recordPackageStep(plan(), { step: 'resolve', attempt: 0 }), (error) => error.meta.code === 'package.transaction.replay');
});

test('a step that already succeeded can never be re-recorded', () => {
  const done = run(plan(), [{ step: 'resolve' }]);
  assert.throws(() => recordPackageStep(done, { step: 'resolve', status: 'failed', detail: 'x' }), (error) => error.meta.code === 'package.transaction.replay');
  assert.throws(() => recordPackageStep(done, { step: 'resolve', status: 'done', detail: 'again' }), (error) => error.meta.code === 'package.transaction.replay');
  assert.equal(recordPackageStep(done, { step: 'resolve', status: 'done', attempt: 1 }), done);
});

/* ------------------------------------------------------- visibility boundary */

test('a publication must name the epoch digest it made visible', () => {
  const staged = run(plan(), upTo('stage'));
  const { gate, lease } = leased();
  // The digest is checked first: a publication that cannot name what it publishes
  // is not a publication, whether or not it is fenced.
  assert.throws(() => recordPackageStep(staged, { step: 'publish' }), (error) => error.meta.code === 'package.transaction.order');
  assert.throws(() => recordPackageStep(staged, { step: 'publish', epochDigest: 'not-a-digest', lease, gate }), (error) => error.meta.code === 'package.transaction.order');
  assert.throws(() => recordPackageStep(staged, { step: 'publish', epochDigest: null, lease, gate }), (error) => error.meta.code === 'package.transaction.order');
  assert.throws(() => recordPackageStep(staged, { step: 'publish', epochDigest: EPOCH.toUpperCase(), lease, gate }), (error) => error.meta.code === 'package.transaction.order');
  assert.ok(recordPackageStep(staged, { step: 'publish', epochDigest: EPOCH, lease, gate }), 'and the well-formed publication is accepted');
});

test('an unfenced publication is refused: a race with no referee', () => {
  const staged = run(plan(), upTo('stage'));
  assert.throws(() => recordPackageStep(staged, { step: 'publish', epochDigest: EPOCH }), (error) => {
    assert.equal(error.meta.code, 'package.transaction.fence');
    assert.match(error.message, /unfenced publish/);
    return true;
  });
});

test('a publication under a lease the gate no longer holds is refused', () => {
  const { gate, lease } = leased();
  const released = releaseInstallLease(gate, lease);
  const nextAdmitted = acquireInstallLease(released.gate, { owner: 'agent-4' });
  const staged = run(plan(), upTo('stage'));
  assert.equal(holdsInstallLease(nextAdmitted.gate, lease), false);
  assert.throws(
    () => recordPackageStep(staged, publishInput(lease, nextAdmitted.gate)),
    (error) => {
      assert.equal(error.meta.code, 'package.transaction.fence');
      assert.equal(error.meta.offeredFence, lease.fence);
      assert.equal(error.meta.heldFence, nextAdmitted.gate.holder.fence);
      return true;
    },
  );
  assert.ok(recordPackageStep(staged, publishInput(nextAdmitted.lease, nextAdmitted.gate)));
});

test('failure before the boundary aborts; failure after it rolls back', () => {
  const before = recordPackageStep(run(plan(), upTo('stage')), { step: 'publish', status: 'failed', detail: 'io', ...leased() });
  assert.equal(decidePackageRecovery(before).action, 'resume');
  const beforeDead = recordPackageStep(before, { step: 'publish', status: 'failed', detail: 'io-2' });
  assert.equal(decidePackageRecovery(beforeDead).action, 'abort');

  const { gate, lease } = leased();
  let published = recordPackageStep(run(plan(), upTo('stage')), publishInput(lease, gate));
  published = recordPackageStep(published, { step: 'activate', status: 'failed', detail: 'crash' });
  const decision = decidePackageRecovery(published);
  assert.equal(decision.action, 'resume', 'the bytes are already visible: finish, or roll back');
  assert.equal(decision.publishedAt, published.steps[4].seq);
  const dead = recordPackageStep(published, { step: 'activate', status: 'failed', detail: 'crash-2' });
  assert.equal(decidePackageRecovery(dead).action, 'rollback');
  assert.equal(decidePackageRecovery(dead).reason, 'rollback-after:activate');
});

test('a committed transaction needs no recovery, and an aborted one is finished', () => {
  const { gate, lease } = leased();
  const committed = commitPackageTransaction(recordPackageStep(recordPackageStep(run(plan(), upTo('stage')), publishInput(lease, gate)), { step: 'activate' })).committed;
  assert.equal(decidePackageRecovery(committed).action, 'none');
  assert.equal(decidePackageRecovery(committed).reason, 'committed');
  const aborted = abortPackageTransaction(recordPackageStep(plan(), { step: 'resolve', status: 'failed', detail: 'dns' }), 'aborted-by-operator');
  assert.equal(decidePackageRecovery(aborted).action, 'none');
  assert.equal(aborted.status, 'aborted');
});

test('recovery of an incomplete history resumes at the first pending step', () => {
  const staged = run(plan(), upTo('verify'));
  const decision = decidePackageRecovery(staged);
  assert.equal(decision.action, 'resume');
  assert.equal(decision.resumeFrom, 'stage');
  assert.equal(decision.reason, 'resume-at:stage');
});

/* ------------------------------------------------------------- commit/abort */

test('a transaction can only be committed when every step is done', () => {
  const staged = run(plan(), upTo('stage'));
  assert.throws(() => commitPackageTransaction(staged), (error) => {
    assert.equal(error.meta.code, 'package.transaction.order');
    assert.equal(error.meta.step, 'publish');
    assert.equal(error.meta.status, 'pending');
    return true;
  });
  const { gate, lease } = leased();
  const published = recordPackageStep(staged, publishInput(lease, gate));
  assert.throws(() => commitPackageTransaction(published), (error) => error.meta.step === 'activate');
});

test('commit refuses a closed transaction and is idempotent-free by design', () => {
  const aborted = abortPackageTransaction(plan(), 'nope');
  assert.throws(() => commitPackageTransaction(aborted), (error) => error.meta.code === 'package.transaction.closed');
  assert.throws(() => abortPackageTransaction(aborted), (error) => error.meta.code === 'package.transaction.closed');
  assert.throws(() => commitPackageTransaction({}), PackageTransactionError);
});

test('abort is refused once the package is visible — it must be rolled back', () => {
  const { gate, lease } = leased();
  const published = recordPackageStep(run(plan(), upTo('stage')), publishInput(lease, gate));
  assert.throws(() => abortPackageTransaction(published), (error) => {
    assert.equal(error.meta.code, 'package.transaction.order');
    assert.equal(error.meta.boundary, 'publish');
    return true;
  });
});

/* ------------------------------------------------------------- single-flight */

test('one install per package identity at a time, and the refusal names the holder', () => {
  const first = acquireInstallLease(createInstallGate(), { owner: 'agent-3', package: 'n8n-nodes-base' });
  assert.equal(first.ok, true);
  assert.equal(first.lease.fence, 1);
  const second = acquireInstallLease(first.gate, { owner: 'agent-4', package: 'n8n-nodes-base' });
  assert.equal(second.ok, false);
  assert.equal(second.lease, null);
  assert.equal(second.reason, 'package.transaction.inflight');
  assert.equal(second.error.heldBy, 'agent-3');
  assert.match(second.error.message, /mixture of two/);
  assert.equal(second.gate.refused, 1);
  assert.equal(second.gate.admitted, 1, 'a refusal is not an admission');
});

test('the same owner asking twice gets the same lease, without burning a fence', () => {
  const first = acquireInstallLease(createInstallGate(), { owner: 'agent-3' });
  const again = acquireInstallLease(first.gate, { owner: 'agent-3' });
  assert.equal(again.ok, true);
  assert.equal(again.lease.fence, first.lease.fence, 're-entrancy must not fence the owner out of their own install');
  assert.equal(again.reason, 'already-held-by-owner');
  assert.equal(again.gate.fence, first.gate.fence);
});

test('an anonymous holder is refused: it could never be asked to release', () => {
  assert.throws(() => acquireInstallLease(createInstallGate(), { package: 'x' }), (error) => error.meta.code === 'package.transaction.identity');
  assert.throws(() => acquireInstallLease({ ok: true }, { owner: 'a' }), PackageTransactionError);
});

test('release frees the gate and the next holder fences past the previous one', () => {
  const first = acquireInstallLease(createInstallGate(), { owner: 'agent-3' });
  const released = releaseInstallLease(first.gate, first.lease);
  assert.equal(released.ok, true);
  assert.equal(released.gate.holder, null);
  assert.equal(released.gate.fence, 1, 'the fence is monotonic, not reset by a release');
  const second = acquireInstallLease(released.gate, { owner: 'agent-4' });
  assert.equal(second.ok, true);
  assert.equal(second.lease.fence, 2);
});

test('a stale lease cannot release a gate a newer holder owns', () => {
  const first = acquireInstallLease(createInstallGate(), { owner: 'agent-3' });
  const released = releaseInstallLease(first.gate, first.lease).gate;
  const second = acquireInstallLease(released, { owner: 'agent-4' });
  const stale = releaseInstallLease(second.gate, first.lease);
  assert.equal(stale.ok, false);
  assert.equal(stale.reason, 'package.transaction.fence');
  assert.equal(stale.error.heldFence, 2);
  assert.equal(stale.error.offeredFence, 1);
  assert.equal(stale.gate.holder.owner, 'agent-4', 'the refusal must not damage the current holder');
  assert.equal(releaseInstallLease(second.gate, second.lease).ok, true);
});

test('the gate itself is immutable: admitting returns a new gate', () => {
  const gate = createInstallGate();
  const admitted = acquireInstallLease(gate, { owner: 'agent-3' });
  assert.equal(gate.holder, null);
  assert.equal(gate.fence, 0);
  assert.ok(Object.isFrozen(gate) && Object.isFrozen(admitted.gate) && Object.isFrozen(admitted.lease));
  assert.throws(() => { 'use strict'; admitted.lease.fence = 99; }, TypeError);
});

/* ----------------------------------------------------------------- journal */

test('the journal is serializable, ordered and deterministic', () => {
  const { gate, lease } = leased();
  const transaction = recordPackageStep(recordPackageStep(run(plan(), upTo('stage')), publishInput(lease, gate)), { step: 'activate' });
  const journal = transactionJournal(transaction);
  assert.deepEqual(journal.steps.map((entry) => entry.step), [...PACKAGE_TRANSACTION_STEPS]);
  assert.ok(journal.steps.every((entry) => entry.seq !== null));
  assert.deepEqual(JSON.parse(JSON.stringify(journal)), journal);
  assert.equal(journalDigest(transaction), journalDigest(transaction));
  assert.match(journalDigest(transaction), /^[0-9a-f]{64}$/);
  assert.equal(journal.epochDigest, EPOCH);
  assert.ok(Object.isFrozen(journal));
});

test('two different histories never share a journal digest', () => {
  const { gate, lease } = leased();
  const staged = run(plan(), upTo('stage'));
  const published = recordPackageStep(staged, publishInput(lease, gate));
  const failed = recordPackageStep(staged, { step: 'publish', status: 'failed', detail: 'io', lease, gate });
  assert.notEqual(journalDigest(published), journalDigest(failed));
  assert.notEqual(journalDigest(plan()), journalDigest(recordPackageStep(plan(), { step: 'resolve' })));
});

test('formatPackageTransaction states progress, status and digest', () => {
  const { gate, lease } = leased();
  const transaction = recordPackageStep(run(plan(), upTo('stage')), publishInput(lease, gate));
  assert.match(formatPackageTransaction(transaction), /^install:[0-9a-f]{32} n8n-nodes-base@2\.9\.1 via npm:n8n-nodes-base@2\.9\.1 5\/6 steps open [0-9a-f]{12}$/);
  assert.throws(() => formatPackageTransaction('nope'), PackageTransactionError);
});

/* --------------------------------------------------------------- read walls */

test('every read refuses a value this contract did not produce', () => {
  const forged = { ok: true, contract: PACKAGE_TRANSACTION_CONTRACT, schemaVersion: 1, transactionId: 'x', steps: [], status: 'open' };
  for (const fn of [transactionJournal, journalDigest, formatPackageTransaction, pendingPackageSteps, decidePackageRecovery, commitPackageTransaction]) {
    assert.throws(() => fn(forged), PackageTransactionError, `${fn.name} must refuse a forged transaction`);
  }
  const copy = JSON.parse(JSON.stringify(plan()));
  assert.equal(isPackageTransaction(copy), false, 'a plain copy is not a transaction; freezing is not decoration');
  assert.equal(isPackageTransaction({ ...plan() }), false);
});

/* -------------------------------------------------------------- scope walls */

test('P6.3 publishes exactly one contract row and keeps P6.2 untouched', () => {
  const lock = JSON.parse(readFileSync(new URL('../src/lego/contracts/contract-lock.json', import.meta.url)));
  const rows = lock.contracts.filter((contract) => contract.id === 'package.transaction');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].version, PACKAGE_TRANSACTION_CONTRACT_VERSION);
  assert.equal(rows[0].domain, 'node-registry');
  assert.deepEqual(rows[0].surface, ['src/lego/package-transaction.mjs']);
  const compiler = lock.contracts.filter((contract) => contract.id === 'registry.compiler');
  assert.equal(compiler.length, 1);
  assert.equal(compiler[0].version, '0.1.0', 'P6.3 composes with P6.2, it does not re-version it');
  const registry = lock.contracts.filter((contract) => contract.id === 'node.registry');
  assert.equal(registry.length, 1);
  assert.equal(registry[0].version, '0.1.0');
  const domain = JSON.parse(readFileSync(new URL('../src/lego/manifest/domains.json', import.meta.url)))
    .domains.find((entry) => entry.id === 'node-registry');
  assert.equal(domain.contract.id, 'node.portability', 'the domain keeps its own primary contract');
  assert.ok(domain.paths.includes('src/lego/package-transaction.mjs'));
});

test('the module is pure, and it never mutates an input it was handed', () => {
  const source = readFileSync(new URL('../src/lego/package-transaction.mjs', import.meta.url), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const forbidden of ['node:fs', 'node:net', 'node:http', 'node:os', 'node:child_process', 'process.', 'Math.random', 'setTimeout', 'performance.']) {
    assert.equal(code.includes(forbidden), false, `package transaction must not reference ${forbidden}`);
  }
  assert.equal(code.includes('foundation.mjs'), false, 'the foundation accessor stays outside the published surface (gate rule R4)');
  // No wall clock anywhere: an install journal that reads a clock is not replayable.
  assert.equal(/\bnew Date\b|\bDate\.now\b/.test(code), false);
});

test('P6.3 builds on P6.1 vocabulary and does not re-invent it', () => {
  const source = readFileSync(new URL('../src/lego/package-transaction.mjs', import.meta.url), 'utf8');
  assert.match(source, /from '\.\/node-registry\.mjs'/);
  assert.equal(source.includes('NODE_REGISTRY_SCHEMA_VERSION'), true);
  // It composes with P6.2 without depending on its internals.
  assert.equal(source.includes('registry-compiler.mjs'), false, 'publication names an epoch digest; it does not mint one');
});

test('P6.3 scope walls: no closure, store, lease, residency, health or attestation', () => {
  const names = Object.keys({
    PACKAGE_TRANSACTION_CONTRACT, PACKAGE_TRANSACTION_OPERATIONS, PACKAGE_TRANSACTION_PERMISSIONS,
    PACKAGE_TRANSACTION_SCHEMA_VERSION, PACKAGE_TRANSACTION_STEPS, PACKAGE_TRANSACTION_STEP_STATUSES,
    PACKAGE_TRANSACTION_STATUSES, PACKAGE_TRANSACTION_MAX_ATTEMPTS, PACKAGE_TRANSACTION_VISIBILITY_BOUNDARY,
    PACKAGE_TRANSACTION_REASONS, PACKAGE_TRANSACTION_RULES, PACKAGE_RECOVERY_ACTIONS, PackageTransactionError,
    planPackageTransaction, recordPackageStep, commitPackageTransaction, abortPackageTransaction,
    decidePackageRecovery, createInstallGate, acquireInstallLease, releaseInstallLease, holdsInstallLease,
    transactionJournal, journalDigest, formatPackageTransaction, pendingPackageSteps, isPackageTransaction,
  }).join(' ');
  for (const later of ['closure', 'artifacts', 'residency', 'quarantine', 'attest', 'sbom', 'canary', 'provenance', 'health']) {
    assert.equal(new RegExp(later, 'i').test(names), false, `${later} belongs to a later milestone`);
  }
});
