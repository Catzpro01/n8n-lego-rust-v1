/**
 * Bounded frontier — capacity-bounded execution work queue (P3 Slice D,
 * Issues #75/#97/#79).
 *
 * PUBLIC CONTRACT (`execution.frontier`, v0.1.0, owner: agent-1).
 *
 * Slice D boundary = the BOUNDED RUNTIME PRIMITIVE, nothing more:
 *
 *   - a FIFO frontier whose capacity IS the policy bound: the queue is a ring
 *     buffer of exactly `capacity` slots — depth can never exceed capacity by
 *     construction (enforceable, observable queue depth per Issue #79);
 *   - ADMISSION with EXPLICIT STATE: `offer` answers `admitted` or
 *     `backpressure` (published code `lego.backpressure`). On backpressure the
 *     item is NOT retained — the producer still owns it (refused work is
 *     never silently lost by the frontier, never allocated into the queue);
 *   - `offerBatch` = bounded fan-out: admits in input order until full and
 *     returns exact `admitted`/`backpressured` counts whose sum always equals
 *     the batch length (arithmetic proof of no-silent-loss);
 *   - `take` / `takeBatch` = BOUNDED ACTIVE SET: a scheduler can never pull
 *     more than requested, never past depth, FIFO order preserved;
 *   - `stats` exposes queue depth, peakDepth, admitted, backpressured, served
 *     (the observability minimum from Issue #79 at primitive level);
 *   - PURE STRUCTURE: no clock, no fs, no network, no timers, no executor —
 *     later executor/resource-protection slices compose this seam; load
 *     shedding, priority lanes and memory-emergency policy are NOT here
 *     (Issue #79 policy layers arrive with the resource-protection slice).
 *
 * WHAT THIS IS NOT
 * ----------------
 * Not a scheduler, not an executor, not a workflow-aware structure: items are
 * opaque values (the execution domain is `mustNotDependOn: workflow`, and this
 * module imports NOTHING cross-domain). Not unbounded anywhere: `capacity` is
 * required (no default that could be forgotten), validated, and pre-allocates
 * the ring — memory is bounded by policy up front.
 *
 * One error family: `lego.contract_violation` (published, errors contract
 * 1.2.0 untouched); backpressure is a PUBLISHED OUTCOME CODE, not a new error
 * family.
 *
 * Owner: agent-1 per Issue #98 (bounded frontier is Agent 1 territory).
 */

/** The contract this module publishes. */
export const FRONTIER_CONTRACT = Object.freeze({
  id: `execution.frontier`,
  version: '0.1.0',
  owner: 'agent-1',
});

/** Pinned contract version for pin-style assertions. */
export const FRONTIER_CONTRACT_VERSION = FRONTIER_CONTRACT.version;

/** Upper validation bound for an explicit capacity (policy sanity, not a node ceiling). */
export const FRONTIER_MAX_CAPACITY = 1048576;

/** Explicit admission outcomes (Issue #79: work is never silently lost). */
export const FRONTIER_OUTCOME = Object.freeze({
  ADMITTED: 'admitted',
  BACKPRESSURE: 'backpressure',
});

/** One error family — same published code as the rest of the lego surface. */
export class BoundedFrontierError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'BoundedFrontierError';
    this.code = 'lego.contract_violation';
    this.details = Object.freeze({ ...details });
  }
}

function fail(message, details) {
  throw new BoundedFrontierError(message, details);
}

function assertCapacity(capacity) {
  if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > FRONTIER_MAX_CAPACITY) {
    fail(`capacity must be a safe integer in 1..${FRONTIER_MAX_CAPACITY}`, { field: 'capacity' });
  }
  return capacity;
}

/**
 * Create a capacity-bounded FIFO frontier.
 *
 * @param {{capacity: number}} options REQUIRED explicit bound — no default.
 * @returns frozen public surface of the frontier.
 */
export function createBoundedFrontier(options = {}) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    fail('frontier options must be a plain object', { field: 'options' });
  }
  if (!('capacity' in options)) {
    fail('capacity is required — the frontier must be bounded explicitly', { field: 'capacity' });
  }
  const capacity = assertCapacity(options.capacity);

  // Ring buffer: exactly `capacity` slots allocated up front (bounded by policy).
  const slots = new Array(capacity);
  let head = 0;
  let count = 0;
  const counters = { peakDepth: 0, admitted: 0, backpressured: 0, served: 0 };

  const enqueue = (item) => {
    slots[(head + count) % capacity] = item;
    count += 1;
    if (count > counters.peakDepth) counters.peakDepth = count;
  };

  const dequeue = () => {
    const item = slots[head];
    slots[head] = undefined;
    head = (head + 1) % capacity;
    count -= 1;
    return item;
  };

  const api = {
    contract: FRONTIER_CONTRACT,

    capacity() {
      return capacity;
    },

    depth() {
      return count;
    },

    isFull() {
      return count === capacity;
    },

    isEmpty() {
      return count === 0;
    },

    /**
     * Admission control: exactly one explicit outcome.
     * `admitted` → enqueued; `backpressure` (code lego.backpressure) → NOT
     * retained (the caller still owns the item and may retry after drain).
     */
    offer(item) {
      if (item === undefined) {
        fail('an item is required — offer(undefined) is refused', { field: 'item' });
      }
      if (count === capacity) {
        counters.backpressured += 1;
        return Object.freeze({
          status: FRONTIER_OUTCOME.BACKPRESSURE,
          code: 'lego.backpressure',
          depth: count,
          capacity,
        });
      }
      enqueue(item);
      counters.admitted += 1;
      return Object.freeze({
        status: FRONTIER_OUTCOME.ADMITTED,
        depth: count,
        capacity,
      });
    },

    /**
     * Bounded fan-out admission: input order, admits until full, exact counts.
     * `admitted + backpressured === items.length` always (no silent loss).
     */
    offerBatch(items) {
      if (!Array.isArray(items)) fail('offerBatch requires an array of items', { field: 'items' });
      for (const item of items) {
        if (item === undefined) {
          fail('batch items must not be undefined', { field: 'items' });
        }
      }
      let admitted = 0;
      let backpressured = 0;
      for (const item of items) {
        if (count === capacity) {
          backpressured += 1;
          counters.backpressured += 1;
        } else {
          enqueue(item);
          counters.admitted += 1;
          admitted += 1;
        }
      }
      return Object.freeze({ admitted, backpressured, depth: count, capacity });
    },

    /** Next item in FIFO order; undefined only when the frontier is empty. */
    take() {
      if (count === 0) return undefined;
      counters.served += 1;
      return dequeue();
    },

    /**
     * Bounded drain: at most `max` items (0 ≤ max ≤ capacity), FIFO order —
     * the consumer can never over-pull the active set.
     */
    takeBatch(max) {
      if (!Number.isSafeInteger(max) || max < 0 || max > capacity) {
        fail(`max must be a safe integer in 0..${capacity}`, { field: 'max' });
      }
      const wanted = Math.min(max, count);
      const pulled = new Array(wanted);
      for (let i = 0; i < wanted; i += 1) {
        pulled[i] = dequeue();
        counters.served += 1;
      }
      return pulled;
    },

    /** Observability minimum (Issue #79): depth + peak + admission counters. */
    stats() {
      return Object.freeze({
        capacity,
        depth: count,
        peakDepth: counters.peakDepth,
        admitted: counters.admitted,
        backpressured: counters.backpressured,
        served: counters.served,
      });
    },
  };

  return Object.freeze(api);
}
