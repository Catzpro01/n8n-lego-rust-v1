/**
 * State stream — bounded streaming execution state (P3 Slices E+F, Issues #75/#97).
 *
 * PUBLIC CONTRACT (`execution.state-stream`, v0.1.0, owner: agent-1).
 *
 * #75 required architecture 4 — streaming execution state: no unbounded
 * in-memory results or logs. This module is the bounded seam:
 *
 *   - APPEND-ONLY log with monotonic `seq` (1..lastSeq; backpressure never
 *     consumes a seq);
 *   - BOUNDED BUFFER: `maxResidentEvents` is REQUIRED (no default) — when the
 *     resident backlog is full, `append` answers an EXPLICIT `backpressure`
 *     outcome (published code `lego.backpressure`) and retains NOTHING (the
 *     same no-silent-loss rule as `execution.frontier`);
 *   - STREAMING READS: `read(from, limit)` (bounded window, non-destructive),
 *     `stream(cursor, {batchSize})` (finite bounded-batch generator),
 *     `consume(limit)` (destructive sink drain — selective retention: the
 *     backlog only shrinks when a sink takes events);
 *   - payloads are JSON-domain plain data, deep-frozen on admission (shared
 *     immutable resident state — producers must not mutate after append);
 *   - PERSISTENCE (Slice F): `snapshot(context?)` → durable envelope sealed
 *     with sha256 over the canonical body; `stateStreamFromSnapshot` restores
 *     fail-closed (checkpoint/resume: cursor + resident backlog + context).
 *
 * Purity: ONLY `node:crypto` (digest) — no clock, fs, network, timers,
 * randomness, or process access. One error family `lego.contract_violation`.
 *
 * Owner: agent-1 per Issue #98.
 */

import { createHash } from 'node:crypto';

/** The contract this module publishes. */
export const STATE_STREAM_CONTRACT = Object.freeze({
  id: `execution.state-stream`,
  version: '0.1.0',
  owner: 'agent-1',
});

/** Pinned contract version for pin-style assertions. */
export const STATE_STREAM_CONTRACT_VERSION = STATE_STREAM_CONTRACT.version;

/** Upper validation bound for maxResidentEvents (policy sanity, not a node ceiling). */
export const STATE_STREAM_MAX_EVENTS = 1048576;

/** Checkpoint envelope version produced by snapshot() (Slice F). */
export const STATE_STREAM_SNAPSHOT_VERSION = 1;

/** One error family — same published code as the rest of the lego surface. */
export class StateStreamError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'StateStreamError';
    this.code = 'lego.contract_violation';
    this.details = Object.freeze({ ...details });
  }
}

function fail(message, details) {
  throw new StateStreamError(message, details);
}

/** Internal-only restore channel (unexported symbol — not forgeable). */
const RESTORE = Symbol('state-stream.restore');

/** Deep JSON-domain validation: plain objects, arrays, finite numbers, primitives. */
function assertJsonValue(value, field) {
  if (value === null) return;
  const type = typeof value;
  if (type === 'string' || type === 'boolean') return;
  if (type === 'number') {
    if (!Number.isFinite(value)) fail(`${field} must contain only finite numbers`, { field });
    return;
  }
  if (type !== 'object') {
    fail(`${field} must be JSON-domain plain data (no functions, symbols, undefined, bigints)`, { field });
  }
  if (Array.isArray(value)) {
    for (const entry of value) assertJsonValue(entry, field);
    return;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    fail(`${field} must contain only plain objects`, { field });
  }
  for (const inner of Object.values(value)) assertJsonValue(inner, field);
}

/** Deep-freeze JSON payloads — shared immutable resident state. */
function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const inner of Object.values(value)) deepFreeze(inner);
  return value;
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Create a bounded streaming execution-state log.
 *
 * @param {{maxResidentEvents: number}} options REQUIRED explicit buffer bound.
 */
export function createStateStream(options = {}) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    fail('stream options must be a plain object', { field: 'options' });
  }
  if (!('maxResidentEvents' in options)) {
    fail('maxResidentEvents is required — the state buffer must be bounded explicitly', {
      field: 'maxResidentEvents',
    });
  }
  const capacity = options.maxResidentEvents;
  if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > STATE_STREAM_MAX_EVENTS) {
    fail(`maxResidentEvents must be a safe integer in 1..${STATE_STREAM_MAX_EVENTS}`, {
      field: 'maxResidentEvents',
    });
  }

  /** @type {{seq: number, event: object}[]} resident FIFO backlog */
  let resident = [];
  let lastSeq = 0;
  const counters = { peakSize: 0, appended: 0, backpressured: 0, consumed: 0, readCalls: 0 };

  const restore = options[RESTORE];
  if (restore !== undefined) {
    // fully validated by stateStreamFromSnapshot before this channel is used
    resident = restore.events;
    lastSeq = restore.lastSeq;
    counters.peakSize = restore.events.length;
    counters.appended = restore.events.length;
  }

  const firstResidentSeq = () => (resident.length === 0 ? lastSeq + 1 : resident[0].seq);

  const api = {
    contract: STATE_STREAM_CONTRACT,

    capacity() {
      return capacity;
    },

    size() {
      return resident.length;
    },

    lastSeq() {
      return lastSeq;
    },

    isEmpty() {
      return resident.length === 0;
    },

    firstResidentSeq() {
      return firstResidentSeq();
    },

    /** Admit exactly one event or answer explicit backpressure (nothing retained). */
    append(event) {
      assertJsonValue(event, 'event');
      if (resident.length === capacity) {
        counters.backpressured += 1;
        return Object.freeze({
          status: 'backpressure',
          code: 'lego.backpressure',
          size: resident.length,
          capacity,
        });
      }
      lastSeq += 1;
      const record = Object.freeze({ seq: lastSeq, event: deepFreeze(event) });
      resident.push(record);
      counters.appended += 1;
      if (resident.length > counters.peakSize) counters.peakSize = resident.length;
      return Object.freeze({
        status: 'admitted',
        seq: lastSeq,
        size: resident.length,
        capacity,
      });
    },

    /**
     * Bounded non-destructive window read: resident events with
     * seq ≥ fromSeq, at most `limit`. Consumed regions read as [].
     */
    read(fromSeq, limit) {
      if (!Number.isSafeInteger(fromSeq) || fromSeq < 1 || fromSeq > lastSeq + 1) {
        fail(`fromSeq must be a safe integer in 1..${lastSeq + 1}`, { field: 'fromSeq' });
      }
      if (!Number.isSafeInteger(limit) || limit < 0 || limit > capacity) {
        fail(`limit must be a safe integer in 0..${capacity}`, { field: 'limit' });
      }
      counters.readCalls += 1;
      const out = [];
      for (const record of resident) {
        if (record.seq < fromSeq) continue;
        if (out.length === limit) break;
        out.push(record);
      }
      return Object.freeze(out);
    },

    /**
     * Destructive sink drain (selective retention): removes and returns the
     * first `limit` resident events, FIFO. The backlog only shrinks here.
     */
    consume(limit) {
      if (!Number.isSafeInteger(limit) || limit < 0 || limit > capacity) {
        fail(`limit must be a safe integer in 0..${capacity}`, { field: 'limit' });
      }
      const taken = resident.splice(0, Math.min(limit, resident.length));
      counters.consumed += taken.length;
      return Object.freeze(taken);
    },

    /**
     * Finite bounded-batch generator: yields frozen `{events, from, to}`
     * batches from `cursor` up to lastSeq captured at call time.
     */
    *stream(cursor = 1, opts = {}) {
      if (!Number.isSafeInteger(cursor) || cursor < 1 || cursor > lastSeq + 1) {
        fail(`cursor must be a safe integer in 1..${lastSeq + 1}`, { field: 'cursor' });
      }
      const batchSize = opts === undefined || opts === null ? capacity : opts.batchSize ?? capacity;
      if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > capacity) {
        fail(`batchSize must be a safe integer in 1..${capacity}`, { field: 'batchSize' });
      }
      const endSeq = lastSeq; // finite snapshot: does not follow appends mid-iteration
      let next = cursor;
      while (next <= endSeq) {
        const batch = api.read(next, batchSize);
        if (batch.length === 0) break; // nothing resident at/after cursor
        yield Object.freeze({ events: batch, from: batch[0].seq, to: batch[batch.length - 1].seq });
        next = batch[batch.length - 1].seq + 1;
      }
    },

    /** Observability minimum: bounded-buffer counters (Issue #75/#79). */
    stats() {
      return Object.freeze({
        capacity,
        size: resident.length,
        lastSeq,
        peakSize: counters.peakSize,
        appended: counters.appended,
        backpressured: counters.backpressured,
        consumed: counters.consumed,
        readCalls: counters.readCalls,
      });
    },

    /**
     * Durable checkpoint envelope (Slice F): resident backlog + cursor +
     * optional caller context, sealed with sha256 over the canonical body
     * JSON. Pure data — safe to persist through any storage adapter.
     */
    snapshot(context = undefined) {
      let contextValue = null;
      if (context !== undefined) {
        assertJsonValue(context, 'context');
        contextValue = context;
      }
      const bodyJson = JSON.stringify({
        snapshotVersion: STATE_STREAM_SNAPSHOT_VERSION,
        contract: `${STATE_STREAM_CONTRACT.id}@${STATE_STREAM_CONTRACT.version}`,
        lastSeq,
        firstResidentSeq: firstResidentSeq(),
        size: resident.length,
        capacity,
        context: contextValue,
        events: resident.map((record) => ({ seq: record.seq, event: record.event })),
      });
      return Object.freeze({
        snapshotVersion: STATE_STREAM_SNAPSHOT_VERSION,
        bodyJson,
        digest: sha256(bodyJson),
      });
    },
  };

  return Object.freeze(api);
}

/**
 * Resume from a checkpoint envelope (Slice F). Fail-closed: shape, version,
 * internal consistency and sha256 digest must all verify — otherwise refused
 * with the one error family (no partial resumes).
 *
 * @param {object} snapshot output of snapshot()
 * @returns {{stream: object, context: object|null, lastSeq: number, firstResidentSeq: number}}
 */
export function stateStreamFromSnapshot(snapshot) {
  if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    fail('a snapshot envelope (plain object) is required', { field: 'snapshot' });
  }
  const { snapshotVersion, bodyJson, digest } = snapshot;
  if (snapshotVersion !== STATE_STREAM_SNAPSHOT_VERSION) {
    fail('unsupported snapshot version', { field: 'snapshotVersion', reason: 'unsupported-version' });
  }
  if (typeof bodyJson !== 'string' || typeof digest !== 'string') {
    fail('snapshot must carry bodyJson and digest strings', { field: 'digest' });
  }
  if (sha256(bodyJson) !== digest) {
    fail('snapshot integrity check failed — digest does not match the body', {
      field: 'digest',
      reason: 'integrity-mismatch',
    });
  }
  let b;
  try {
    b = JSON.parse(bodyJson);
  } catch {
    fail('snapshot.bodyJson must be valid JSON', { field: 'bodyJson', reason: 'invalid-json' });
  }
  if (b === null || typeof b !== 'object' || Array.isArray(b)) {
    fail('snapshot body must be a plain object', { field: 'bodyJson' });
  }
  if (b.snapshotVersion !== STATE_STREAM_SNAPSHOT_VERSION) {
    fail('unsupported body snapshot version', { field: 'snapshotVersion', reason: 'unsupported-version' });
  }
  if (b.contract !== `${STATE_STREAM_CONTRACT.id}@${STATE_STREAM_CONTRACT.version}`) {
    fail('snapshot contract mismatch', { field: 'contract', reason: 'integrity-mismatch' });
  }
  if (!Number.isSafeInteger(b.capacity) || b.capacity < 1 || b.capacity > STATE_STREAM_MAX_EVENTS) {
    fail('snapshot capacity is invalid', { field: 'capacity' });
  }
  if (!Number.isSafeInteger(b.lastSeq) || b.lastSeq < 0) {
    fail('snapshot lastSeq is invalid', { field: 'lastSeq' });
  }
  if (!Number.isSafeInteger(b.firstResidentSeq) || b.firstResidentSeq < 1 || b.firstResidentSeq > b.lastSeq + 1) {
    fail('snapshot firstResidentSeq is invalid', { field: 'firstResidentSeq' });
  }
  if (!Array.isArray(b.events)) {
    fail('snapshot.events must be an array', { field: 'events' });
  }
  if (b.events.length !== b.size || b.size > b.capacity) {
    fail('snapshot size does not match its resident events', { field: 'size', reason: 'count-mismatch' });
  }
  if (b.context !== null && b.context !== undefined) assertJsonValue(b.context, 'context');
  let expectedSeq = b.firstResidentSeq;
  for (const record of b.events) {
    if (record === null || typeof record !== 'object' || !Number.isSafeInteger(record.seq)) {
      fail('every snapshot event must carry an integer seq', { field: 'events' });
    }
    if (record.seq !== expectedSeq) {
      fail('snapshot events must be contiguous from firstResidentSeq', {
        field: 'events',
        reason: 'count-mismatch',
      });
    }
    if (record.seq > b.lastSeq) {
      fail('snapshot event seq exceeds lastSeq', { field: 'events', reason: 'count-mismatch' });
    }
    assertJsonValue(record.event, 'events');
    expectedSeq += 1;
  }

  const records = b.events.map((record) =>
    Object.freeze({ seq: record.seq, event: deepFreeze(record.event) }),
  );
  const stream = createStateStream({
    maxResidentEvents: b.capacity,
    [RESTORE]: { events: records, lastSeq: b.lastSeq },
  });
  return Object.freeze({
    stream,
    context: b.context ?? null,
    lastSeq: b.lastSeq,
    firstResidentSeq: b.firstResidentSeq,
  });
}
