/**
 * P3 Slice E+F — bounded streaming execution state + checkpoint/resume
 * (Issues #75/#97, required architecture 4 & 5).
 *
 * Proves: bounded buffer (backpressure, no silent loss) · streaming reads
 * (bounded window, finite batch generator, destructive selective consume) ·
 * JSON-domain payloads frozen on admission · purity (only node:crypto) ·
 * JSON payloads frozen on admission · fail-closed sha256 snapshot/resume
 * (Slice F) · metamorphic checkpoint→resume ≡ uninterrupted (#91 mode 4).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  STATE_STREAM_CONTRACT,
  STATE_STREAM_CONTRACT_VERSION,
  STATE_STREAM_MAX_EVENTS,
  STATE_STREAM_SNAPSHOT_VERSION,
  StateStreamError,
  createStateStream,
  stateStreamFromSnapshot,
} from '../src/lego/state-stream.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const read = (relative) => readFileSync(join(REPO_ROOT, relative), 'utf8');
const LOCK = JSON.parse(read('apps/n8n-lego/src/lego/contracts/contract-lock.json'));
const ROWS = LOCK.contracts ?? LOCK;
const DOMAINS = JSON.parse(read('apps/n8n-lego/src/lego/manifest/domains.json'));
const EXECUTION = (DOMAINS.domains ?? DOMAINS).find((d) => d.id === 'execution');
const ERRORS = JSON.parse(read('apps/n8n-lego/src/lego/contracts/errors.contract.json'));
const SOURCE = read('apps/n8n-lego/src/lego/state-stream.mjs');

const caught = (fn) => {
  try { fn(); return null; } catch (error) { return error; }
};

/* ============================================ A. CONTRACT / LOCK ROW (35th) */

test('the lock row is the thirty-fifth: execution.state-stream@0.1.0, owner agent-1, exports byte-parity', () => {
  const row = ROWS.find((r) => r.id === 'execution.state-stream');
  assert.ok(row, 'execution.state-stream is locked');
  // P9.1 envelope + P3 optimizer are merged; P9.2 structured-log adds row 42.
  assert.equal(ROWS.length, 100, 'P3 Slice E adds the thirty-fifth (execution.state-stream); P3 Slice H adds the thirty-sixth (workflow.dna); P3 Slice J the thirty-seventh (execution.ir); P3 Slice L the thirty-eighth (compatibility.oracle); P3 Slice M the thirty-ninth (execution.guard) — P6.1 adds node.registry@0.1.0; P6.2 adds registry.compiler@0.1.0; P6.3 adds package.transaction@0.1.0; P6.4 adds registry.closure@0.1.0; P6.5 adds node.resolution@0.1.0; P6.6 adds runtime.lease@0.1.0; P6.7 adds node.residency@0.1.0; P6.8 adds node.capability@0.1.0; P6.9 adds node.semantics@0.1.0; P6.10 adds node.lifecycle@0.1.0; P6.11 adds node.health@0.1.0; P6.12 adds node.supply-chain@0.1.0; P6.13 adds registry.incremental@0.1.0; P6.14 adds node.worker-convergence@0.1.0; P6.15 adds node.acceptance@0.1.0; P6.16 adds registry.integrity@0.1.0; P6.17 adds node.admission@0.1.0; P6.18 adds node.sbom@0.1.0; P6.19 adds node.canary@0.1.0; P6.20 adds node.revocation@0.1.0; P6.21 adds node.io@0.1.0; P6.22 adds runtime.jit@0.1.0; P6.23 adds runtime.cancel@0.1.0; P6.24 adds runtime.pool@0.1.0; P6.25 adds node.abi@0.1.0; P6.26 adds runtime.wasm-cache@0.1.0; P6.27 adds node.provenance@0.1.0; P6.28 adds registry.freshness@0.1.0; P6.29 adds node.namespace@0.1.0; P6.30 adds registry.repair@0.1.0; P6.31 adds registry.acceptance@0.1.0; count-pins say 76; P2.27.1 adds lego.plugin-runtime@0.1.0 (seventy-sixth); P5.1 adds the ninety-fifth (auth.principal)'); // P9 integration (Agent 1): P9.5-P9.22 add 18 observability.* rows on top of protected main 76 -> 94 (union, zero id collisions); P9 was developed on 24032a0c (57 rows). P5.2 adds the ninety-sixth (auth.session). P5.3 adds the ninety-seventh (auth.authorization). P5.5 adds the ninety-eighth (auth.credential-crypto). P5.6 adds the ninety-ninth (auth.account-security). P5.7 adds the hundredth (auth.machine-identity).
  assert.equal(row.owner, 'agent-1');
  assert.equal(row.domain, 'execution');
  assert.equal(row.version, '0.1.0', 'R9: execution domain contract 0.1.0');
  assert.equal(row.status, 'implemented');
  assert.deepEqual(row.surface, ['src/lego/state-stream.mjs']);
  const module_ = {
    STATE_STREAM_CONTRACT, STATE_STREAM_CONTRACT_VERSION, STATE_STREAM_MAX_EVENTS,
    STATE_STREAM_SNAPSHOT_VERSION, StateStreamError, createStateStream, stateStreamFromSnapshot,
  };
  const locked = row.exports['src/lego/state-stream.mjs'];
  assert.deepEqual([...locked].sort(), Object.keys(module_).sort(), 'lock ⇄ module exports');
  assert.deepEqual([...locked], [...locked].slice().sort(), 'sorted ASCII');
  assert.equal(locked.length, 7);
  assert.deepEqual(row.tests, ['apps/n8n-lego/test/lego-state-stream.test.mjs']);
  assert.equal('operations' in row, false, 'no capability/REST surface (by design)');
  assert.equal('permissions' in row, false);
  assert.equal(STATE_STREAM_CONTRACT.id, row.id);
  assert.equal(STATE_STREAM_CONTRACT_VERSION, row.version);
  assert.equal(STATE_STREAM_CONTRACT.owner, row.owner);
});

test('the execution domain owns the module; purity scan; one published error family', () => {
  assert.ok(EXECUTION.paths.includes('src/lego/state-stream.mjs'));
  assert.equal(EXECUTION.status, 'partial', 'domain status unchanged by a slice');
  assert.equal(ERRORS.version, '1.2.0', 'errors contract untouched');
  assert.ok([...ERRORS.codes].some((c) => (c.code ?? c) === 'lego.backpressure'));
  // purity: ONLY node:crypto (digest) — no clock/fs/network/timers/randomness/process
  const imports = [...SOURCE.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(imports, ['node:crypto'], 'exactly one import: the digest');
  for (const forbidden of [/node:fs/, /node:http/, /node:net/, /setTimeout/, /setInterval/, /Date\.now/, /Math\.random/, /process\./]) {
    assert.equal(forbidden.test(SOURCE), false, `${forbidden} must not appear`);
  }
  const published = new Set((ERRORS.codes ?? []).map((e) => e.code ?? e.id));
  for (const match of SOURCE.matchAll(/'(lego\.[a-z0-9_]+)'/g)) {
    assert.ok(published.has(match[1]), `${match[1]} is published`);
  }
});

/* ================================================= B. BOUNDED BUFFER / APPEND */

test('capacity is required and validated fail-closed in the one error family', () => {
  assert.equal(caught(() => createStateStream()).details.field, 'maxResidentEvents', 'no default bound — ever');
  assert.equal(caught(() => createStateStream({})).details.field, 'maxResidentEvents');
  for (const bad of [0, -1, 1.5, '8', Number.NaN, STATE_STREAM_MAX_EVENTS + 1]) {
    const error = caught(() => createStateStream({ maxResidentEvents: bad }));
    assert.ok(error instanceof StateStreamError, `capacity ${bad} refuses`);
    assert.equal(error.code, 'lego.contract_violation');
    assert.equal(error.details.field, 'maxResidentEvents');
  }
  assert.equal(caught(() => createStateStream(null)).details.field, 'options');
  assert.equal(caught(() => createStateStream([])).details.field, 'options');
});

test('the buffer is bounded: append admits up to capacity, then explicit backpressure (nothing retained)', () => {
  const capacity = 8;
  const stream = createStateStream({ maxResidentEvents: capacity });
  for (let i = 0; i < capacity; i += 1) {
    const outcome = stream.append({ n: i });
    assert.equal(outcome.status, 'admitted');
    assert.equal(outcome.seq, i + 1, 'seq is monotonic and backpressure never burns a seq');
    assert.ok(stream.size() <= capacity, `size ${stream.size()} ≤ capacity after append ${i}`);
  }
  assert.equal(stream.size(), capacity);
  const refused = stream.append({ n: 'lost?' });
  assert.equal(refused.status, 'backpressure');
  assert.equal(refused.code, 'lego.backpressure', 'published explicit outcome code');
  assert.equal(stream.size(), capacity, 'the refused event was never retained');
  assert.equal(stream.lastSeq(), capacity, 'backpressure did not advance lastSeq');
  const stats = stream.stats();
  assert.equal(stats.appended, capacity);
  assert.equal(stats.backpressured, 1);
  assert.equal(stats.peakSize, capacity, 'peak = the bound');
  assert.equal(stats.consumed, 0);
  // non-JSON-domain payloads refused (JSON stream = n8n data domain)
  assert.equal(caught(() => stream.append(undefined)).details.field, 'event');
  assert.equal(caught(() => stream.append(() => 'fn')).details.field, 'event');
  assert.equal(caught(() => stream.append({ x: Number.NaN })).details.field, 'event');
  assert.equal(caught(() => stream.append({ d: new Date() })).details.field, 'event');
});

test('payloads are frozen shared state on admission (documented producer contract)', () => {
  const stream = createStateStream({ maxResidentEvents: 4 });
  const payload = { run: 1, items: [{ ok: true }] };
  const outcome = stream.append(payload);
  assert.equal(outcome.status, 'admitted');
  assert.equal(Object.isFrozen(payload), true, 'admission freezes the event tree');
  assert.equal(Object.isFrozen(payload.items[0]), true);
  assert.throws(() => { 'use strict'; payload.run = 2; }, TypeError, 'post-append mutation refused');
  const readBack = stream.read(1, 4);
  assert.equal(readBack[0].event, payload, 'read serves the same immutable record');
});

/* ==================================================== C. STREAMING READS / CONSUME */

test('read is a bounded non-destructive window; consumed regions read empty', () => {
  const stream = createStateStream({ maxResidentEvents: 16 });
  for (let i = 0; i < 10; i += 1) stream.append({ n: i });
  const window = stream.read(4, 3);
  assert.deepEqual(window.map((r) => r.seq), [4, 5, 6], 'window starts at fromSeq, stops at limit');
  assert.equal(stream.read(4, 3).length, 3, 're-read is non-destructive');
  assert.equal(stream.size(), 10);
  assert.equal(stream.read(11, 5).length, 0, 'cursor past lastSeq reads empty');
  assert.equal(stream.read(1, 0).length, 0, 'limit 0 is legal');
  assert.equal(caught(() => stream.read(0, 1)).details.field, 'fromSeq');
  assert.equal(caught(() => stream.read(1, 999)).details.field, 'limit');
  assert.equal(caught(() => stream.read(1.5, 1)).details.field, 'fromSeq');
  const before = stream.stats().readCalls;
  stream.read(1, 1);
  assert.equal(stream.stats().readCalls, before + 1, 'reads are observable');
});

test('consume is selective retention: destructive FIFO drain frees the bounded buffer', () => {
  const stream = createStateStream({ maxResidentEvents: 4 });
  for (let i = 0; i < 4; i += 1) stream.append({ n: i });
  assert.equal(stream.append({ n: 4 }).status, 'backpressure', 'full');
  const taken = stream.consume(2);
  assert.deepEqual(taken.map((r) => r.seq), [1, 2], 'FIFO drain');
  assert.equal(stream.size(), 2);
  assert.equal(stream.firstResidentSeq(), 3, 'cursor advances');
  assert.equal(stream.append({ n: 4 }).status, 'admitted', 'consume freed capacity — resume flow');
  assert.equal(stream.lastSeq(), 5, 'the new event takes the next seq (3 consumed were 1,2 … lastSeq=5)');
  assert.equal(caught(() => stream.consume(999)).details.field, 'limit');
  assert.equal(stream.consume(0).length, 0, 'drain 0 is legal');
  const stats = stream.stats();
  assert.equal(stats.consumed, 2);
  assert.equal(stats.backpressured, 1, 'the single full-buffer refusal counted');
  assert.equal(stream.read(1, 4).map((r) => r.seq).join(','), '3,4,5', 'consumed region invisible to read');
});

test('stream() yields finite bounded batches up to lastSeq-at-call (no unbounded iteration)', () => {
  const stream = createStateStream({ maxResidentEvents: 64 });
  for (let i = 0; i < 25; i += 1) stream.append({ n: i });
  const batches = [];
  for (const batch of stream.stream(1, { batchSize: 10 })) {
    batches.push(batch);
    assert.ok(batch.events.length <= 10, 'every batch respects the bound');
  }
  assert.equal(batches.length, 3, '25 events at batchSize 10 → 10+10+5');
  assert.equal(batches[0].from, 1);
  assert.equal(batches[2].to, 25);
  // appends after capture do not extend a running iteration (finite)
  stream.append({ n: 25 });
  const again = [...stream.stream(20, { batchSize: 6 })];
  assert.deepEqual(again.map((b) => b.to), [25, 26], 'cursor 20 → batches of 6: …25, then 26');
  assert.throws(() => [...stream.stream(0)], /cursor/, 'cursor validated on first iteration');
  assert.throws(() => [...stream.stream(1, { batchSize: 0 })], /batchSize/, 'batchSize validated on first iteration');
  const empty = createStateStream({ maxResidentEvents: 4 });
  assert.equal([...empty.stream(1)].length, 0, 'empty stream yields nothing');
  assert.equal(caught(() => { empty.stream(-1).next(); }).details.field, 'cursor', 'eager validation for illegal cursor');
});

/* ================================= D. CHECKPOINT / RESUME (SLICE F) */

test('snapshot seals cursor + backlog + context with sha256; resume is fail-closed', () => {
  const stream = createStateStream({ maxResidentEvents: 16 });
  for (let i = 0; i < 5; i += 1) stream.append({ n: i });
  stream.consume(2);
  const snap = stream.snapshot({ workflowChecksum: 'abc', cursor: 3 });
  assert.equal(snap.snapshotVersion, STATE_STREAM_SNAPSHOT_VERSION);
  assert.equal(typeof snap.digest, 'string');
  assert.equal(snap.digest.length, 64, 'sha256');
  const restored = stateStreamFromSnapshot(snap);
  assert.equal(restored.context.workflowChecksum, 'abc', 'caller context roundtrips');
  assert.equal(restored.lastSeq, 5, 'cursor recovered');
  assert.equal(restored.firstResidentSeq, 3, 'resident window recovered');
  assert.equal(restored.stream.size(), 3);
  assert.deepEqual([...restored.stream.read(3, 10).map((r) => r.event.n)], [2, 3, 4]);
  // resume flow: continued appends keep the durable seq window
  const after = restored.stream.append({ n: 5 });
  assert.equal(after.status, 'admitted');
  assert.equal(after.seq, 6, 'resume continues from lastSeq, not from 1');
  // tamper detection (digest class)
  const tamper = (mutate) => {
    const s = stream.snapshot();
    const body = JSON.parse(s.bodyJson);
    mutate(body);
    return { snapshotVersion: s.snapshotVersion, bodyJson: JSON.stringify(body), digest: s.digest };
  };
  const refused = caught(() => stateStreamFromSnapshot(tamper((b) => { b.lastSeq = 99; })));
  assert.equal(refused.details.reason, 'integrity-mismatch');
  assert.equal(refused.code, 'lego.contract_violation');
  assert.equal(caught(() => stateStreamFromSnapshot(null)).details.field, 'snapshot');
  assert.equal(
    caught(() => stateStreamFromSnapshot({ snapshotVersion: 99, bodyJson: '{}', digest: 'x' })).details.reason,
    'unsupported-version');
  // structural violations after RESEALING (attacker recomputes digest — still refused)
  const sha = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
  const reseal = (mutate) => {
    const s = stream.snapshot();
    const body = JSON.parse(s.bodyJson);
    mutate(body);
    const bodyJson = JSON.stringify(body);
    return { snapshotVersion: s.snapshotVersion, bodyJson, digest: sha(bodyJson) };
  };
  const gap = reseal((b) => { b.events = [b.events[0], b.events[2]]; b.size = 2; b.firstResidentSeq = 3; });
  assert.equal(caught(() => stateStreamFromSnapshot(gap)).details.reason, 'count-mismatch',
    'non-contiguous events refused even with a valid digest');
  const wrongContract = reseal((b) => { b.contract = 'execution.state-stream@9.9.9'; });
  assert.equal(caught(() => stateStreamFromSnapshot(wrongContract)).details.reason, 'integrity-mismatch');
  const badSize = reseal((b) => { b.size = 99; });
  assert.equal(caught(() => stateStreamFromSnapshot(badSize)).details.reason, 'count-mismatch');
});

test('metamorphic: checkpoint → resume ≡ uninterrupted execution (#91 mode 4)', () => {
  const drive = (stream, ops) => {
    const log = [];
    for (const op of ops) {
      if (op.type === 'append') log.push(stream.append(op.event));
      else if (op.type === 'consume') log.push(...stream.consume(op.limit));
      else if (op.type === 'read') log.push(...stream.read(op.from, op.limit));
      else log.push(...[...stream.stream(op.from, { batchSize: op.batch })].flatMap((b) => [...b.events]));
    }
    return log.map((r) => (typeof r === 'object' && r !== null && 'seq' in r ? r.seq : r.status ?? r));
  };
  const ops = [
    { type: 'append', event: { a: 1 } }, { type: 'append', event: { a: 2 } },
    { type: 'append', event: { a: 3 } }, { type: 'read', from: 1, limit: 8 },
    { type: 'consume', limit: 1 }, { type: 'append', event: { a: 4 } },
    { type: 'stream', from: 1, batch: 2 }, { type: 'append', event: { a: 5 } },
  ];
  const straight = createStateStream({ maxResidentEvents: 8 });
  const straightLog = drive(straight, ops);
  // independent prefix reference (a fresh stream — never reuse the full-run one)
  const straightFirst = drive(createStateStream({ maxResidentEvents: 8 }), ops.slice(0, 4));
  // interrupt at the midpoint: snapshot → resume → continue
  const a = createStateStream({ maxResidentEvents: 8 });
  drive(a, ops.slice(0, 4));
  const snap = a.snapshot({ note: 'mid' });
  const b = stateStreamFromSnapshot(snap).stream;
  const resumedLog = drive(b, ops.slice(4));
  assert.deepEqual([...straightFirst, ...resumedLog], straightLog,
    'checkpoint → resume produces the exact uninterrupted sequence');
  // structural equivalence of the two end states
  const endOf = (s) => ({ lastSeq: s.lastSeq(), size: s.size(), first: s.firstResidentSeq(), stats: s.stats() });
  const sE = endOf(straight);
  const rE = endOf(b);
  assert.deepEqual(
    { ...rE, stats: { ...rE.stats, readCalls: sE.stats.readCalls } },
    { ...sE, stats: { ...sE.stats, readCalls: sE.stats.readCalls } },
    'end states match modulo readCalls (reads before interrupt are observation, not state)',
  );
  // frontier-style pending work rides the context: pending items re-admit after resume
  const pending = ['w1', 'w2'];
  const snap2 = straight.snapshot({ pendingWork: pending });
  const resumed2 = stateStreamFromSnapshot(snap2);
  assert.deepEqual(resumed2.context.pendingWork, pending, 'pending work survives the checkpoint');
});
