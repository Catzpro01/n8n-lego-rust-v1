/**
 * Backend LEGO foundation — the operation envelope, cancellation and deadlines.
 *
 * PUBLIC CONTRACT (`lego.envelope`, v1.1.0, owner: agent-2).
 *
 * P2.8-B declared the envelope's ten fields as vocabulary. This module makes it
 * real, and it is the piece the four interaction classes all sit on. P2.18 adds
 * the optional `causationId` field (MINOR): which immediate parent request
 * caused this one — defaulting to the parent's requestId on derived envelopes.
 *
 * THE CONSTRAINT THAT SHAPES EVERYTHING HERE: the envelope must be cheap enough
 * to create on every in-process call. A workflow executing 400 nodes creates 400
 * envelopes. So this is a plain frozen object and an AbortController — no
 * classes with prototypes to walk, no serialization, no clock syscall unless a
 * deadline was actually requested, no allocation that a direct call would not
 * otherwise make. `createEnvelope()` on a hot path costs roughly what building
 * an options object costs, which is the whole point: if the envelope were
 * expensive, callers would skip it and the architecture would lose its identity
 * and cancellation story at exactly the moment it matters.
 *
 * TRANSPORT NEUTRALITY: the envelope carries no transport concept. `signal` is
 * the one field that cannot cross a process boundary, so `serializeEnvelope()`
 * drops it and records `cancellable: false` — a worker binding re-establishes
 * cancellation with its own channel rather than pretending an AbortSignal
 * survived the trip. Everything else round-trips as plain JSON.
 */
import { randomUUID } from 'node:crypto';

/** Fields the envelope carries. Mirrors `manifest/foundation.json` → `envelope.fields`. */
export const ENVELOPE_FIELDS = Object.freeze([
  'legoId',
  'operation',
  'contractVersion',
  'requestId',
  'correlationId',
  'causationId',
  'traceId',
  'actor',
  'scope',
  'deadline',
  'signal',
  'idempotencyKey',
]);

/** Raised when a deadline passes or a caller cancels. Distinguishable from a domain failure. */
export class CancellationError extends Error {
  constructor(reason = 'cancelled', { envelope = null, deadlineExceeded = false } = {}) {
    super(typeof reason === 'string' ? reason : 'cancelled');
    this.name = 'CancellationError';
    this.code = deadlineExceeded ? 'lego.deadline_exceeded' : 'lego.cancelled';
    this.retryable = deadlineExceeded;
    this.deadlineExceeded = deadlineExceeded;
    this.requestId = envelope?.requestId ?? null;
    this.correlationId = envelope?.correlationId ?? null;
  }
}

/**
 * Create an envelope for one operation.
 *
 * `correlationId` defaults to `requestId`, so a root call starts its own
 * correlation and every descendant inherits it — that is what makes one user
 * action traceable across LEGOs without a tracing platform.
 *
 * @param {{
 *   legoId: string, operation: string, contractVersion?: string,
 *   requestId?: string, correlationId?: string, causationId?: string|null,
 *   traceId?: string, actor?: object|null, scope?: object|null,
 *   timeoutMs?: number, deadline?: number|null,
 *   signal?: AbortSignal|null, idempotencyKey?: string|null
 * }} spec
 */
export function createEnvelope(spec) {
  if (!spec?.legoId) throw new TypeError('createEnvelope requires legoId');
  if (!spec.operation) throw new TypeError('createEnvelope requires operation');

  const requestId = spec.requestId ?? randomUUID();
  const deadline = spec.deadline ?? (spec.timeoutMs === undefined ? null : Date.now() + spec.timeoutMs);

  return Object.freeze({
    legoId: spec.legoId,
    operation: spec.operation,
    contractVersion: spec.contractVersion ?? null,
    requestId,
    correlationId: spec.correlationId ?? requestId,
    causationId: spec.causationId ?? null,
    traceId: spec.traceId ?? null,
    actor: spec.actor ?? null,
    scope: spec.scope ?? null,
    deadline,
    signal: spec.signal ?? null,
    idempotencyKey: spec.idempotencyKey ?? null,
  });
}

/**
 * Derive a child envelope for a downstream call.
 *
 * This is the cancellation-propagation rule in code: the child inherits the
 * parent's correlation, trace, actor and scope, and **cannot outlive the
 * parent's deadline**. A child may ask for less time; asking for more is
 * silently clamped, because a child that outlives its caller is precisely the
 * orphaned-work failure the architecture forbids.
 */
export function deriveEnvelope(parent, spec) {
  if (!parent) throw new TypeError('deriveEnvelope requires a parent envelope');

  const requested = spec?.deadline ?? (spec?.timeoutMs === undefined ? null : Date.now() + spec.timeoutMs);
  const deadline = parent.deadline === null
    ? requested
    : requested === null
      ? parent.deadline
      : Math.min(parent.deadline, requested);

  return createEnvelope({
    ...spec,
    legoId: spec?.legoId ?? parent.legoId,
    operation: spec?.operation ?? parent.operation,
    requestId: spec?.requestId ?? randomUUID(),
    correlationId: parent.correlationId,
    causationId: spec?.causationId ?? parent.requestId,
    traceId: spec?.traceId ?? parent.traceId,
    actor: spec?.actor ?? parent.actor,
    scope: spec?.scope ?? parent.scope,
    deadline,
    signal: spec?.signal ?? parent.signal,
  });
}

/** Milliseconds left, or `null` when no deadline was set. Negative means already past. */
export function remainingMs(envelope, now = Date.now()) {
  return envelope?.deadline === null || envelope?.deadline === undefined ? null : envelope.deadline - now;
}

/** Has this operation been cancelled, either explicitly or by its deadline? */
export function isCancelled(envelope, now = Date.now()) {
  if (!envelope) return false;
  if (envelope.signal?.aborted) return true;
  return envelope.deadline !== null && envelope.deadline <= now;
}

/**
 * The check a long-running operation calls between units of work.
 *
 * Idempotent by construction: it inspects state and throws, holding no state of
 * its own, so calling it in a loop is safe and calling it after cancellation
 * always produces the same error.
 */
export function throwIfCancelled(envelope, now = Date.now()) {
  if (!envelope) return;
  const deadlineExceeded = envelope.deadline !== null && envelope.deadline <= now;
  if (deadlineExceeded) {
    throw new CancellationError(`deadline exceeded for ${envelope.legoId}.${envelope.operation}`, { envelope, deadlineExceeded: true });
  }
  if (envelope.signal?.aborted) {
    throw new CancellationError(envelope.signal.reason ?? `cancelled: ${envelope.legoId}.${envelope.operation}`, { envelope });
  }
}

/**
 * A cancellable scope: an envelope plus the handle that cancels it.
 *
 * The deadline timer is `unref`'d so a pending cancellation never keeps the
 * process alive, and `cancel()` is idempotent — cancelling twice is a no-op
 * rather than a second abort.
 */
export function createCancellableScope(spec) {
  const controller = new AbortController();
  const parentSignal = spec?.signal ?? null;

  if (parentSignal) {
    if (parentSignal.aborted) controller.abort(parentSignal.reason);
    else parentSignal.addEventListener('abort', () => controller.abort(parentSignal.reason), { once: true });
  }

  const envelope = createEnvelope({ ...spec, signal: controller.signal });

  let timer = null;
  if (envelope.deadline !== null) {
    const delay = Math.max(0, envelope.deadline - Date.now());
    timer = setTimeout(() => controller.abort(`deadline exceeded for ${envelope.legoId}.${envelope.operation}`), delay);
    timer.unref?.();
  }

  return {
    envelope,
    cancel(reason = `cancelled: ${envelope.legoId}.${envelope.operation}`) {
      if (!controller.signal.aborted) controller.abort(reason);
      if (timer) clearTimeout(timer);
    },
    dispose() {
      if (timer) clearTimeout(timer);
    },
  };
}

/**
 * Prepare an envelope to cross a process boundary.
 * `signal` is dropped because an AbortSignal cannot be serialized; the flag
 * tells the far side it must supply its own cancellation channel rather than
 * assume it inherited one.
 */
export function serializeEnvelope(envelope) {
  const { signal, ...rest } = envelope;
  return { ...rest, cancellable: false };
}

/** Rebuild an envelope on the far side of a boundary, optionally attaching a local signal. */
export function deserializeEnvelope(plain, { signal = null } = {}) {
  const { cancellable, ...rest } = plain;
  return Object.freeze({ ...rest, signal });
}

/**
 * The observability record for one completed boundary crossing.
 * Boundary-only by design (P2.8-B §12): enough to answer "who called what, with
 * which contract, how long did it take, did it work", and nothing more.
 */
export function boundaryRecord(envelope, { status, durationMs, implementation = null, source = null, error = null }) {
  return {
    legoId: envelope.legoId,
    operation: envelope.operation,
    contractVersion: envelope.contractVersion,
    requestId: envelope.requestId,
    correlationId: envelope.correlationId,
    traceId: envelope.traceId,
    sourceLegoId: source,
    implementation,
    durationMs,
    status,
    errorCode: error?.code ?? null,
  };
}
