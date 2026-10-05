/**
 * Backend LEGO foundation — CALL / EVENT / STREAM / BATCH.
 *
 * PUBLIC CONTRACT (`lego.interaction`, v1.1.0, owner: agent-2).
 *
 * The central design rule (P2.8-B §20): **the contract stays the same across
 * transports**. A consumer writes `call(target, 'resolve', payload, envelope)`
 * and never learns whether that was a direct function call, a worker message or
 * a remote request. Only the *binding* changes.
 *
 * So this module deliberately contains NO transport. It is dispatch semantics
 * plus declaration: what the four classes mean, what backpressure policies
 * exist, and how a local call is routed. A transport adapter (worker, IPC,
 * HTTP) is a later, separate thing that plugs in behind `registerProvider` —
 * and because it plugs in behind the same registry, adding one does not touch a
 * single consumer.
 *
 * WHY A LOCAL DISPATCHER AT ALL, rather than importing the target directly?
 * Because direct imports make the *consumer* choose the implementation, which
 * kills the replacement story: you cannot swap JS for Rust, or in-process for
 * worker, without editing every caller. The dispatcher is the one indirection
 * that buys implementation replacement — and it is a Map lookup plus a function
 * call, so it costs essentially nothing. That is the trade: one Map.get() to
 * make ADR-0001 and ADR-0005 mechanically possible.
 *
 * What this is NOT: a message bus, a queue, an event-sourcing system or a
 * scheduler. There is no broker, no persistence and no background loop.
 */
import { CancellationError, createEnvelope, deriveEnvelope, isCancelled, throwIfCancelled } from './envelope.mjs';

/** The four logical interaction classes. There are exactly four, and no fifth. */
export const INTERACTION_CLASSES = Object.freeze(['call', 'event', 'stream', 'batch']);

/**
 * What happens when a STREAM or EVENT consumer cannot keep up.
 * Declaring this is mandatory for streams: an undeclared policy in practice
 * means "buffer without limit", which is how a process dies slowly.
 */
export const BACKPRESSURE_POLICIES = Object.freeze({
  buffer: 'queue up to `highWaterMark` items, then apply `onOverflow`',
  drop: 'discard the newest item when full — for telemetry where loss is acceptable',
  'drop-oldest': 'discard the oldest item when full — for live state where only the latest matters',
  coalesce: 'merge pending items via `coalesce(previous, next)` — for progress updates',
  block: 'await the consumer — only legal when the producer can actually be paused',
  reject: 'raise `lego.backpressure` to the producer',
  terminate: 'end the stream with an error — for unrecoverable overload',
});

/** Error raised when a stream sheds load under a `reject` policy. */
export class BackpressureError extends Error {
  constructor(message, { legoId, operation, policy, pending }) {
    super(message);
    this.name = 'BackpressureError';
    this.code = 'lego.backpressure';
    this.retryable = true;
    this.legoId = legoId;
    this.operation = operation;
    this.policy = policy;
    this.pending = pending;
  }
}

/** Raised when a capability, operation or contract version cannot be satisfied. */
export class UnavailableError extends Error {
  constructor(message, { code = 'lego.unavailable', legoId = null, operation = null, degradation = null } = {}) {
    super(message);
    this.name = 'UnavailableError';
    this.code = code;
    this.retryable = false;
    this.legoId = legoId;
    this.operation = operation;
    this.degradation = degradation;
  }
}

/* ------------------------------------------------------------------ registry */

/**
 * The provider registry. A provider is `{ legoId, contractVersion, operations, implementation, transport }`.
 * `transport: 'in-process'` today; a worker adapter would register the same
 * shape with `transport: 'worker'` and consumers would not notice.
 */
const providers = new Map();

export function registerProvider({ legoId, contractVersion, operations, implementation = 'default', transport = 'in-process' }) {
  if (!legoId) throw new TypeError('registerProvider requires legoId');
  if (!operations || typeof operations !== 'object') throw new TypeError('registerProvider requires an operations object');

  for (const [name, definition] of Object.entries(operations)) {
    const handler = typeof definition === 'function' ? definition : definition.handler;
    const interaction = typeof definition === 'function' ? 'call' : (definition.interaction ?? 'call');
    if (typeof handler !== 'function') throw new TypeError(`operation '${legoId}.${name}' has no handler`);
    if (!INTERACTION_CLASSES.includes(interaction)) {
      throw new TypeError(`operation '${legoId}.${name}' declares unknown interaction '${interaction}'`);
    }
    if (interaction === 'stream' && !(typeof definition === 'object' && definition.backpressure)) {
      throw new TypeError(`stream operation '${legoId}.${name}' must declare a backpressure policy`);
    }
    if (typeof definition === 'object' && definition.backpressure && !(definition.backpressure.policy in BACKPRESSURE_POLICIES)) {
      throw new TypeError(`operation '${legoId}.${name}' declares unknown backpressure policy '${definition.backpressure.policy}'`);
    }
  }

  providers.set(legoId, { legoId, contractVersion, operations, implementation, transport });
  return () => providers.delete(legoId);
}

export function getProvider(legoId) {
  return providers.get(legoId) ?? null;
}

export function listProviders() {
  return [...providers.values()].map(({ legoId, contractVersion, implementation, transport, operations }) => ({
    legoId,
    contractVersion,
    implementation,
    transport,
    operations: Object.keys(operations),
  }));
}

/** Test/bootstrap helper: forget every provider. */
export function resetProviders() {
  providers.clear();
}

function resolve(legoId, operation) {
  const provider = providers.get(legoId);
  if (!provider) {
    throw new UnavailableError(`no provider registered for '${legoId}'`, { code: 'lego.capability_unavailable', legoId, operation });
  }
  const definition = provider.operations[operation];
  if (!definition) {
    throw new UnavailableError(`'${legoId}' does not implement operation '${operation}'`, { code: 'lego.operation_unsupported', legoId, operation });
  }
  const handler = typeof definition === 'function' ? definition : definition.handler;
  const interaction = typeof definition === 'function' ? 'call' : (definition.interaction ?? 'call');
  const meta = typeof definition === 'function' ? {} : definition;
  return { provider, handler, interaction, meta };
}

function expect(actual, expected, legoId, operation) {
  if (actual !== expected) {
    throw new UnavailableError(
      `'${legoId}.${operation}' is a ${actual.toUpperCase()} operation but was invoked as ${expected.toUpperCase()}`,
      { code: 'lego.interaction_mismatch', legoId, operation },
    );
  }
}

/* -------------------------------------------------------------------- CALL */

/**
 * Synchronous request/response — the default.
 * Cancellation is checked before dispatch and after completion: before, so a
 * cancelled caller never starts new work; after, so a result produced past the
 * deadline is not quietly accepted.
 */
export async function call(legoId, operation, payload, envelope) {
  const { provider, handler, interaction } = resolve(legoId, operation);
  expect(interaction, 'call', legoId, operation);

  const active = envelope ?? createEnvelope({ legoId, operation, contractVersion: provider.contractVersion });
  throwIfCancelled(active);
  const result = await handler(payload, active);
  throwIfCancelled(active);
  return result;
}

/* ------------------------------------------------------------------- EVENT */

/**
 * Fire-and-forget notification.
 *
 * Deliberately does not await handlers and never throws into the emitter: an
 * emitter that can be broken by a subscriber is not fire-and-forget, and one
 * slow audit listener must not be able to stall an execution. Failures are
 * reported to `onError` instead of propagating.
 */
const subscribers = new Map();

export function subscribe(topic, handler) {
  if (!subscribers.has(topic)) subscribers.set(topic, new Set());
  subscribers.get(topic).add(handler);
  return () => subscribers.get(topic)?.delete(handler);
}

export function emit(topic, payload, envelope, { onError = null } = {}) {
  const handlers = subscribers.get(topic);
  if (!handlers || handlers.size === 0) return { delivered: 0 };
  if (envelope && isCancelled(envelope)) return { delivered: 0, cancelled: true };

  let delivered = 0;
  for (const handler of handlers) {
    delivered += 1;
    try {
      const outcome = handler(payload, envelope);
      if (outcome && typeof outcome.catch === 'function') {
        outcome.catch((error) => onError?.(error, { topic, envelope }));
      }
    } catch (error) {
      onError?.(error, { topic, envelope });
    }
  }
  return { delivered };
}

export function resetSubscribers() {
  subscribers.clear();
}

/* ------------------------------------------------------------------ STREAM */

/**
 * Long-lived incremental output, as an async iterable.
 *
 * Cancellation is checked on every yielded item, so a cancelled consumer stops
 * the producer at the next item rather than after the whole stream drains. The
 * `finally` block runs the provider's `onCancel` — that is what stops a stopped
 * execution from continuing to compute output nobody will read.
 */
export async function* stream(legoId, operation, payload, envelope) {
  const { provider, handler, interaction, meta } = resolve(legoId, operation);
  expect(interaction, 'stream', legoId, operation);

  const active = envelope ?? createEnvelope({ legoId, operation, contractVersion: provider.contractVersion });
  throwIfCancelled(active);

  const source = await handler(payload, active);
  try {
    for await (const item of source) {
      throwIfCancelled(active);
      yield item;
    }
  } finally {
    if (isCancelled(active)) await meta.onCancel?.(payload, active);
  }
}

/**
 * Apply a declared backpressure policy to a producer/consumer pair.
 *
 * This is the semantic implementation the contracts talk about — a bounded
 * buffer with an explicit overflow rule, not a queueing system. It is small on
 * purpose: the goal is that "what happens when the consumer is slow" has one
 * testable answer per contract, not that we ship a broker.
 */
export function applyBackpressure({
  policy,
  highWaterMark = 64,
  coalesce = null,
  onOverflow = null,
  legoId = null,
  operation = null,
}) {
  if (!(policy in BACKPRESSURE_POLICIES)) throw new TypeError(`unknown backpressure policy '${policy}'`);
  if (!Number.isInteger(highWaterMark) || highWaterMark < 1 || highWaterMark > 65536) {
    throw new TypeError('highWaterMark must be an integer in [1, 65536]');
  }

  const pending = [];
  const stats = { accepted: 0, dropped: 0, coalesced: 0, rejected: 0, terminated: false };
  // P2.18 bound: blocked producers are themselves a queue — cap them so the
  // buffer cannot be replaced by an unbounded waiter list.
  const MAX_BLOCK_WAITERS = 1024;
  let waiters = [];

  /** @returns {{ accepted: boolean, action: string }} */
  const pushImpl = (item) => {
    if (stats.terminated) return { accepted: false, action: 'terminated' };

    if (pending.length < highWaterMark) {
      pending.push(item);
      stats.accepted += 1;
      return { accepted: true, action: 'buffered' };
    }

    switch (policy) {
      case 'drop':
        stats.dropped += 1;
        return { accepted: false, action: 'dropped-newest' };
      case 'drop-oldest':
        pending.shift();
        pending.push(item);
        stats.dropped += 1;
        stats.accepted += 1;
        return { accepted: true, action: 'dropped-oldest' };
      case 'coalesce': {
        if (typeof coalesce !== 'function') throw new TypeError('coalesce policy requires a coalesce(previous, next) function');
        pending[pending.length - 1] = coalesce(pending[pending.length - 1], item);
        stats.coalesced += 1;
        return { accepted: true, action: 'coalesced' };
      }
      case 'reject':
        stats.rejected += 1;
        throw new BackpressureError(`'${legoId}.${operation}' cannot keep up (${pending.length} pending)`, { legoId, operation, policy, pending: pending.length });
      case 'terminate':
        stats.terminated = true;
        throw new BackpressureError(`stream '${legoId}.${operation}' terminated under overload`, { legoId, operation, policy, pending: pending.length });
      case 'buffer': {
        // Declared semantics (P2.18): queue up to highWaterMark, then apply
        // onOverflow. With no declared handler the bounded, loud answer is a
        // retryable lego.backpressure — never a silent unbounded queue.
        if (typeof onOverflow === 'function') {
          const handled = onOverflow(item);
          if (handled === false) {
            stats.dropped += 1;
            return { accepted: false, action: 'overflow-dropped' };
          }
          stats.accepted += 1;
          return { accepted: true, action: 'overflow-handled' };
        }
        stats.rejected += 1;
        throw new BackpressureError(
          `'${legoId}.${operation}' buffer is full (${pending.length} pending) and no onOverflow handler is declared`,
          { legoId, operation, policy, pending: pending.length },
        );
      }
      case 'block':
        // A synchronous push cannot await the consumer: bounded refusal that
        // tells the producer to pause. Use pushAsync() to actually block.
        stats.rejected += 1;
        return { accepted: false, action: 'blocked' };
      default:
        // Unreachable — policy was validated — but never buffer without a bound.
        stats.rejected += 1;
        return { accepted: false, action: 'refused' };
    }
  };

  return {
    policy,
    highWaterMark,
    stats,
    get size() {
      return pending.length;
    },
    push: pushImpl,
    /**
     * P2.18: the real `block` semantics for async producers — await the
     * consumer below the watermark, with the waiter list itself bounded.
     * Non-block policies fall through to the synchronous push.
     */
    async pushAsync(item) {
      if (stats.terminated) return { accepted: false, action: 'terminated' };
      if (policy === 'block') {
        while (pending.length >= highWaterMark) {
          if (waiters.length >= MAX_BLOCK_WAITERS) {
            stats.rejected += 1;
            throw new BackpressureError(
              `'${legoId}.${operation}' has ${waiters.length} blocked producers — the waiter bound is ${MAX_BLOCK_WAITERS}`,
              { legoId, operation, policy, pending: pending.length },
            );
          }
          await new Promise((resolve) => { waiters.push(resolve); });
          if (stats.terminated) return { accepted: false, action: 'terminated' };
        }
        pending.push(item);
        stats.accepted += 1;
        return { accepted: true, action: 'buffered' };
      }
      return pushImpl(item);
    },
    drain() {
      const items = [...pending];
      pending.length = 0;
      const wake = waiters;
      waiters = [];
      for (const resolve of wake) resolve();
      return items;
    },
  };
}

/* ------------------------------------------------------------------- BATCH */

/**
 * The batch ceiling (P2.18): a batch is a bounded contract call, never an
 * unbounded queue. Declared here so both producer and tests share one number.
 */
export const BATCH_LIMITS = Object.freeze({ maxItems: 256 });

/**
 * Many operations in one contract call.
 *
 * Returns a per-item result rather than failing the whole batch on one bad
 * item: a batch that fails wholesale forces the caller to re-derive which item
 * broke, which is exactly the information the callee already had. Deadlines are
 * honoured between items, so a batch that runs out of time reports what it
 * completed instead of silently overrunning.
 */
export async function batch(legoId, operation, items, envelope, { atomic = false } = {}) {
  const { provider, handler, interaction } = resolve(legoId, operation);
  expect(interaction, 'batch', legoId, operation);

  if (!Array.isArray(items)) {
    throw new TypeError(`batch '${legoId}.${operation}' items must be an array`);
  }
  if (items.length > BATCH_LIMITS.maxItems) {
    throw new TypeError(
      `batch '${legoId}.${operation}' declares ${items.length} items, beyond BATCH_LIMITS.maxItems=${BATCH_LIMITS.maxItems}`,
    );
  }

  const active = envelope ?? createEnvelope({ legoId, operation, contractVersion: provider.contractVersion });
  throwIfCancelled(active);

  if (typeof handler === 'function' && handler.length >= 3) {
    return handler(items, active, { atomic });
  }

  const results = [];
  for (const [index, item] of items.entries()) {
    if (isCancelled(active)) {
      results.push({ index, status: 'cancelled', error: new CancellationError('batch cancelled', { envelope: active }) });
      continue;
    }
    try {
      results.push({ index, status: 'fulfilled', value: await handler(item, deriveEnvelope(active, { operation })) });
    } catch (error) {
      if (atomic) throw error;
      results.push({ index, status: 'rejected', error });
    }
  }
  return results;
}

/* -------------------------------------------------------------- degradation */

/**
 * Graceful degradation (§11), as an explicit decision rather than a hidden
 * fallback. Every state names what a consumer should do — there is no silent
 * "try something else", because a fallback nobody declared is a bug nobody can
 * find.
 */
export const DEGRADATION_STATES = Object.freeze({
  available: { usable: true, action: 'proceed' },
  degraded: { usable: true, action: 'proceed with reduced guarantees; the provider declares what is reduced' },
  'capability-unavailable': { usable: false, action: 'fail with lego.capability_unavailable' },
  'optional-absent': { usable: false, action: 'skip the optional path; this is not an error' },
  'version-incompatible': { usable: false, action: 'fail with lego.version_incompatible — never silently adapt' },
  'dependency-disabled': { usable: false, action: 'fail with lego.dependency_disabled' },
  'migration-required': { usable: false, action: 'fail with lego.migration_required and name the migration' },
  'feature-unsupported': { usable: false, action: 'answer 501 through the compatibility layer' },
});

export function degradationFor(state) {
  const entry = DEGRADATION_STATES[state];
  if (!entry) throw new TypeError(`unknown degradation state '${state}'`);
  return { state, ...entry };
}
