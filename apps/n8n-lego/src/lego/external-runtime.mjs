/**
 * External Runtime — the first real external runtime behind the P2.21 seam (P2.25).
 *
 * WHAT THIS MODULE IS
 * -------------------
 * The first real EXTERNAL executor binding for `ai.runtime-adapter@1.0.0`
 * (the P2.21 contract-preserving seam). Unlike the scripted simulated runtime,
 * this runtime performs a real exchange with an external executor through the
 * injected `exchange` binding, normalizes the response into the seam's
 * response dialect, propagates cancellation idempotently, and translates the
 * official runtime lifecycle vocabulary onto the canonical Agent Machine
 * operations via the seam's own published table — never a second lifecycle.
 *
 *   consumer → runtime-adapter seam (register/lookup/eligibility/manager)
 *                └─ EXTERNAL executorKind → this runtime → injected exchange
 *
 * WHAT THIS MODULE DOES NOT DO
 * ----------------------------
 * It does NOT redefine `ai.agent-machine@1.1.0`, does NOT create a parallel
 * lifecycle, does NOT own the agent loop, and does NOT become a lock row:
 * `ai.agent-runtime@1.0.0` stays VOCABULARY (the seam registers runtimes
 * against that contract id; the lock deliberately publishes no such row).
 * The seam module's exports are consumed through their published surface —
 * this file only adds the first external binding beside them.
 *
 * THE SEAM'S SYNCHRONOUS CONTRACT (P2.21, unchanged)
 * --------------------------------------------------
 * `createRuntimeAdapter(...).pullStep()` calls `runtime.nextResponse(...)` —
 * synchronously. The seam is P2.21's published contract and is NOT redefined
 * here: `exchange` is therefore a SYNCHRONOUS binding (it returns the response
 * directly). A production binding that needs asynchronous I/O completes its
 * exchange before returning (platform boundary / worker); this module owns
 * validation, bounds, cancellation and failure translation — the wire stays at
 * the injected edge. No `node:*` import, no ambient clock, no ambient id.
 *
 * FAILURE MODES (§29) — fail closed
 * ---------------------------------
 * missing/invalid exchange → contract_violation at creation;
 * unknown lifecycle operation → contract_violation (seam table refuses);
 * declared-but-unsupported (stream) → contract_violation (seam table);
 * timeout / provider unavailable / rate-limited / forbidden → canonical
 * `lego.*` codes with NO echo of the external error's own message (§13);
 * response budget exhaustion → contract_violation (bounded, never unbounded);
 * cancellation is idempotent and reports `already` — never a fake success.
 */

import { AI_TRANSPORTS } from './ai-foundation.mjs';
import {
  ADAPTER_AVAILABILITIES,
  ADAPTER_CAPABILITIES,
  ADAPTER_LIMITS,
  ADAPTER_LOCALITIES,
  ADAPTER_RUNTIME_CONTRACT,
  RUNTIME_LIFECYCLE_TRANSLATION,
} from './runtime-adapter.mjs';
import { SENSITIVE_USAGE_RE } from './token-usage.mjs';

/* ---------------------------------------------------------------- contract */

/**
 * The registration contract every runtime declares — quoted from the P2.21
 * seam (`ADAPTER_RUNTIME_CONTRACT`), single-sourced, never forked.
 */
export const EXTERNAL_RUNTIME_CONTRACT = ADAPTER_RUNTIME_CONTRACT;

/** Canonical codes this runtime may emit — quoted from errors.contract.json 1.2.0. */
export const EXTERNAL_RUNTIME_ERROR_CODES = Object.freeze([
  'lego.contract_violation',
  'lego.access_denied',
  'lego.unavailable',
  'lego.deadline_exceeded',
  'lego.operation_unsupported',
  'lego.dependency_disabled',
  'lego.backpressure',
  'lego.cancelled',
]);

/** Exchange error kinds → canonical codes (stable across runtimes, §13). */
export const EXTERNAL_RUNTIME_ERROR_TRANSLATION = Object.freeze({
  timeout: 'lego.deadline_exceeded',
  unavailable: 'lego.unavailable',
  'rate-limited': 'lego.backpressure',
  forbidden: 'lego.access_denied',
  cancelled: 'lego.cancelled',
});

/** Bounds — every external exchange dimension is finite (§27). */
export const EXTERNAL_RUNTIME_LIMITS = Object.freeze({
  maxExchangeCalls: 1024,
  maxAttemptsPerCall: ADAPTER_LIMITS.maxRetryAttempts,
  maxTimeoutMs: 600_000,
  maxSupportKeys: 8,
  maxDetailLength: ADAPTER_LIMITS.maxResponseDetailLength,
});

/** The runtimeMetadata.supports keys the declaration must state explicitly. */
const REQUIRED_SUPPORT_KEYS = Object.freeze(['session', 'background', 'stream', 'cancellation', 'delegation']);

/** Declared availability for an external runtime binding — quoted from the seam. */
const DECLARED_AVAILABILITIES = ADAPTER_AVAILABILITIES;

/* ------------------------------------------------------------------ errors */

export class ExternalRuntimeError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ExternalRuntimeError';
    if (!EXTERNAL_RUNTIME_ERROR_CODES.includes(code)) {
      throw new Error(`unknown external-runtime error code '${code}' — declare it in src/lego/contracts/errors.contract.json first`);
    }
    this.code = code;
    this.details = freezeDeep(sanitizeDetails(details));
  }
}

function fail(code, message, details = {}) {
  throw new ExternalRuntimeError(code, message, details);
}

/* -------------------------------------------------------------- primitives */

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const REFERENCE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const TRAVERSAL_RE = /(^|\/)\.\.(\/|$)/;
const ABSOLUTE_PATH_RE = /^(?:\/|~\/|[A-Za-z]:[\\/])/;

function freezeDeep(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) freezeDeep(value[key]);
    Object.freeze(value);
  }
  return value;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sanitizeDetails(details) {
  if (!isPlainObject(details)) return {};
  const out = {};
  for (const [key, value] of Object.entries(details)) {
    if (typeof value === 'string') {
      const sliced = value.length > EXTERNAL_RUNTIME_LIMITS.maxDetailLength
        ? value.slice(0, EXTERNAL_RUNTIME_LIMITS.maxDetailLength)
        : value;
      out[key] = SENSITIVE_USAGE_RE.test(sliced) ? '[redacted]' : sliced;
    } else if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
      out[key] = value;
    }
  }
  return out;
}

function assertId(value, field) {
  if (typeof value !== 'string' || value.length === 0 || !ID_RE.test(value)) {
    fail('lego.contract_violation', `${field} must match ${ID_RE} (1..${EXTERNAL_RUNTIME_LIMITS.maxDetailLength} characters)`, { field });
  }
  if (SENSITIVE_USAGE_RE.test(value)) {
    fail('lego.contract_violation', `${field} carries a credential-shaped value — external runtimes never record credentials or tokens`, {
      field,
      reason: 'credential-shaped-value',
    });
  }
  return value;
}

function assertOpaqueReference(value, field) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length === 0 || value.length > ADAPTER_LIMITS.maxReferenceIdLength
    || !REFERENCE_ID_RE.test(value) || TRAVERSAL_RE.test(value) || ABSOLUTE_PATH_RE.test(value)) {
    fail('lego.contract_violation', `${field} must be an opaque reference — path-shaped values are refused at the external seam (no filesystem authority)`, {
      field,
      reason: 'not-an-opaque-reference',
    });
  }
  if (SENSITIVE_USAGE_RE.test(value)) {
    fail('lego.contract_violation', `${field} carries a credential-shaped value`, { field, reason: 'credential-shaped-value' });
  }
  return value;
}

function mapTransportError(error) {
  if (error && typeof error.code === 'string' && EXTERNAL_RUNTIME_ERROR_CODES.includes(error.code)) {
    return error.code;
  }
  if (error && typeof error.kind === 'string' && EXTERNAL_RUNTIME_ERROR_TRANSLATION[error.kind]) {
    return EXTERNAL_RUNTIME_ERROR_TRANSLATION[error.kind];
  }
  if (error && (error.name === 'TimeoutError' || error.code === 'ETIMEDOUT' || error.code === 'ESOCKETTIMEDOUT')) {
    return 'lego.deadline_exceeded';
  }
  return 'lego.unavailable';
}

/* ---------------------------------------------------------------- runtime */

/**
 * @param {{ runtimeId: string, kind: 'agent-runtime', exchange: Function,
 *           availability?: string, transport: string, locality: string,
 *           supports: object, now: Function, newId: Function,
 *           timeoutMs?: number }} options
 */
export function createExternalRuntime(options = {}) {
  const {
    runtimeId, kind, exchange, transport, locality, supports,
    now, newId, timeoutMs = 10_000,
  } = options;
  const availability = options.availability ?? 'available';

  if (typeof now !== 'function' || typeof newId !== 'function') {
    throw new ExternalRuntimeError('lego.contract_violation', 'now and newId must be injected (no ambient clock, no ambient id)', {});
  }
  if (typeof exchange !== 'function') {
    fail('lego.contract_violation', 'exchange must be a synchronous function — the P2.21 seam contract is unchanged', { field: 'exchange' });
  }
  assertId(runtimeId, 'runtimeId');
  if (kind !== 'agent-runtime' && kind !== 'simulation-runtime') {
    fail('lego.contract_violation', `kind must be one of agent-runtime, simulation-runtime — received '${String(kind)}' (fail-closed)`, {
      field: 'kind',
    });
  }
  if (!AI_TRANSPORTS.includes(transport)) {
    fail('lego.contract_violation', `transport must be one of ${AI_TRANSPORTS.join(', ')}`, { field: 'transport' });
  }
  if (!ADAPTER_LOCALITIES.includes(locality)) {
    fail('lego.contract_violation', `locality must be one of ${ADAPTER_LOCALITIES.join(', ')} — quoted from runtimeMetadata`, { field: 'locality' });
  }
  if (!DECLARED_AVAILABILITIES.includes(availability)) {
    fail('lego.contract_violation', `availability must be one of ${DECLARED_AVAILABILITIES.join(', ')}`, { field: 'availability' });
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > EXTERNAL_RUNTIME_LIMITS.maxTimeoutMs) {
    fail('lego.contract_violation', `timeoutMs must be an integer in [1, ${EXTERNAL_RUNTIME_LIMITS.maxTimeoutMs}]`, { field: 'timeoutMs' });
  }
  if (!isPlainObject(supports)) {
    fail('lego.contract_violation', 'supports must state every runtimeMetadata.supports key explicitly — no defaults, no guesses', { field: 'supports' });
  }
  const supportKeys = Object.keys(supports);
  if (supportKeys.length === 0 || supportKeys.length > EXTERNAL_RUNTIME_LIMITS.maxSupportKeys) {
    fail('lego.contract_violation', `supports must declare 1..${EXTERNAL_RUNTIME_LIMITS.maxSupportKeys} keys`, { field: 'supports' });
  }
  for (const key of supportKeys) {
    if (!REQUIRED_SUPPORT_KEYS.includes(key) && key !== 'artifacts') {
      fail('lego.contract_violation', `unknown support key '${key}' — vocabulary is runtimeMetadata.supports (+ artifacts)`, { field: 'supports' });
    }
    if (typeof supports[key] !== 'boolean') {
      fail('lego.contract_violation', `supports.${key} must be a boolean`, { field: `supports.${key}` });
    }
  }
  for (const key of REQUIRED_SUPPORT_KEYS) {
    if (supports[key] === undefined) {
      fail('lego.contract_violation', `supports.${key} must be stated explicitly — cancellation: false is a legitimate answer, silence is not`, {
        field: `supports.${key}`,
      });
    }
  }

  const configuredAtRaw = String(now());
  if (Number.isNaN(Date.parse(configuredAtRaw))) {
    fail('lego.contract_violation', 'now() must return an ISO timestamp', { field: 'now' });
  }
  const configuredAt = new Date(configuredAtRaw).toISOString();
  const adapterId = String(newId()).slice(0, 64);
  if (adapterId.length === 0) {
    fail('lego.contract_violation', 'newId() must return a non-empty identifier', { field: 'newId' });
  }

  const frozenSupports = Object.freeze({ ...supports });
  const declaredCapabilities = Object.freeze(
    Object.entries(frozenSupports)
      .filter(([, value]) => value === true)
      .map(([key]) => key)
      .filter((key) => ADAPTER_CAPABILITIES.includes(key)),
  );

  const cancellations = new Set();
  const cancelledResults = new Set();
  let exchangeCalls = 0;

  function callExchange(operation, request) {
    if (exchangeCalls >= EXTERNAL_RUNTIME_LIMITS.maxExchangeCalls) {
      fail('lego.backpressure', `the external exchange budget is bounded at ${EXTERNAL_RUNTIME_LIMITS.maxExchangeCalls} calls`, {
        operation,
        limit: 'maxExchangeCalls',
      });
    }
    exchangeCalls += 1;
    try {
      return exchange(freezeDeep(request));
    } catch (error) {
      const code = mapTransportError(error);
      // The external runtime's own error text is NEVER echoed (§13) — canonical
      // category and bounded adapter-side metadata only.
      fail(code, `external runtime exchange failed for '${operation}' (${code})`, {
        operation,
        runtimeId,
        reason: typeof error?.kind === 'string' ? error.kind.slice(0, 32) : 'transport-failure',
      });
      /* c8 ignore next */
      return undefined;
    }
  }

  const runtime = Object.freeze({
    runtimeId,
    adapterId,
    configuredAt,
    contract: EXTERNAL_RUNTIME_CONTRACT,
    kind,
    transport,
    locality,
    availability,
    timeoutMs,
    supports: frozenSupports,
    declaredCapabilities,

    /**
     * Registration payload for `createRuntimeRegistry().register(...)` —
     * executorKind EXTERNAL exactly, canonical vocabulary, fail-closed at the
     * registry gate. `providerId` is an opaque reference, never a credential.
     */
    declaration(providerId = null) {
      const safeProviderId = providerId === null || providerId === undefined
        ? null
        : assertId(providerId, 'providerId');
      return Object.freeze({
        runtimeId,
        contract: EXTERNAL_RUNTIME_CONTRACT,
        executorKinds: Object.freeze(['EXTERNAL']),
        capabilities: declaredCapabilities,
        locality,
        availability,
        providerId: safeProviderId,
      });
    },

    /**
     * The P2.21 seam entry: pull ONE normalized response for a machine step.
     * Synchronous by the seam's contract; bounded; validated into the exact
     * response dialect `pullStep` accepts (outcome/final/references).
     */
    nextResponse(context = {}) {
      const machineId = context.machineId === undefined || context.machineId === null
        ? null
        : assertId(context.machineId, 'machineId');
      const response = callExchange('exchange', {
        op: 'exchange',
        runtimeId,
        machineId,
        timeoutMs,
        cancellationRequested: false,
      });
      if (!isPlainObject(response)) {
        fail('lego.contract_violation', 'malformed external response — nextResponse must answer with an object', { operation: 'exchange' });
      }
      if (response.outcome !== 'succeeded' && response.outcome !== 'failed') {
        fail('lego.contract_violation', 'malformed external response — outcome must be succeeded or failed', {
          operation: 'exchange',
          field: 'outcome',
        });
      }
      if (typeof response.final !== 'boolean') {
        fail('lego.contract_violation', 'malformed external response — final must be a boolean', {
          operation: 'exchange',
          field: 'final',
        });
      }
      const resultReference = assertOpaqueReference(response.resultReference, 'resultReference');
      const errorReference = assertOpaqueReference(response.errorReference, 'errorReference');
      const approvalReference = assertOpaqueReference(response.approvalReference, 'approvalReference');
      const inputReference = assertOpaqueReference(response.inputReference, 'inputReference');
      if (response.outcome === 'failed' && errorReference === null && response.final !== true) {
        fail('lego.contract_violation', 'malformed external response — a failed non-final step needs an errorReference', {
          operation: 'exchange',
          field: 'errorReference',
        });
      }
      return Object.freeze({
        outcome: response.outcome,
        final: response.final,
        resultReference,
        errorReference,
        approvalReference,
        inputReference,
        machineId,
      });
    },

    /** Seam interface: declared cancellation support comes from `supports`. */
    supportsCancellation: frozenSupports.cancellation === true,

    /**
     * Idempotent cancellation bookkeeping for `signalCancellation` at the
     * seam: first signal propagates (and pings the external executor once),
     * repeated signals answer `{ propagated, already }` — never a fake second
     * cancel, never a silent no-op on a runtime that declared support.
     */
    noteCancellation(machineId) {
      assertId(machineId, 'machineId');
      if (frozenSupports.cancellation !== true) {
        return { propagated: false, reason: 'missing-capability' };
      }
      if (cancellations.has(machineId)) {
        return { propagated: true, already: true };
      }
      cancellations.add(machineId);
      callExchange('cancel', {
        op: 'cancel',
        runtimeId,
        machineId,
        timeoutMs,
      });
      return { propagated: true, already: false };
    },

    wasCancelled(machineId) {
      return cancellations.has(machineId);
    },

    cancelledMachines() {
      return [...cancellations].sort();
    },

    /**
     * Consumer-facing cancel result marking: the external executor reported a
     * cancelled machine (failure translation for cancelled work). Idempotent.
     */
    noteCancelledResult(machineId) {
      assertId(machineId, 'machineId');
      const first = !cancelledResults.has(machineId);
      cancelledResults.add(machineId);
      return Object.freeze({ machineId, cancelled: true, first });
    },

    /** Observability counters — references and counts only, never payloads (§23). */
    stats() {
      return Object.freeze({
        runtimeId,
        adapterId,
        configuration: 'configured',
        exchangeCalls,
        cancellations: cancellations.size,
        availability,
        registeredContract: EXTERNAL_RUNTIME_CONTRACT,
      });
    },

    /**
     * Lifecycle translation is the seam's published table — re-exposed here
     * for convenience, single-sourced, so no second vocabulary can drift.
     */
    translate(runtimeOperation) {
      if (typeof runtimeOperation !== 'string' || runtimeOperation.length === 0) {
        fail('lego.contract_violation', 'runtimeOperation must be a non-empty string', { field: 'runtimeOperation' });
      }
      if (!Object.hasOwn(RUNTIME_LIFECYCLE_TRANSLATION, runtimeOperation)) {
        fail('lego.contract_violation', `unknown runtime operation '${runtimeOperation}' — the official runtime-adapter vocabulary only`, {
          runtimeOperation,
        });
      }
      const mapped = RUNTIME_LIFECYCLE_TRANSLATION[runtimeOperation];
      if (mapped === null) {
        // Byte-identical refusal to the seam's own translate(): declared-but-unsupported
        // (stream) and unknown operations both fail closed as contract violations —
        // no second behaviour, no second vocabulary (§12).
        fail('lego.contract_violation', `runtime operation '${runtimeOperation}' has no canonical target against ${EXTERNAL_RUNTIME_CONTRACT} — unsupported operations fail closed`, {
          runtimeOperation,
          contract: EXTERNAL_RUNTIME_CONTRACT,
        });
      }
      return Object.freeze([...mapped]);
    },
  });

  return runtime;
}
