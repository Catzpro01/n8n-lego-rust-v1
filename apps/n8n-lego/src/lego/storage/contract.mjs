/**
 * P8-S01..S07 — provider-neutral storage contract (REQ-0003 section 8).
 *
 * The contract is the boundary: consumers import ONLY this module (facade,
 * errors, validation) and receive a provider instance through injection. A
 * consumer that imports provider internals is outside the contract and loses
 * portability (local -> shared provider, JS -> Rust).
 *
 * Semantics are specified in docs/n8n-lego/evidence/P8-S01-FOUNDATION.md and
 * pinned by the conformance harness in test/lego-storage-conformance.test.mjs.
 * Every provider must pass the harness before it may be wired into a consumer.
 *
 * Rust-readiness: explicit interface, no hidden global state (clock and
 * persistence are injected), deterministic given the same injected clock and
 * inputs, stable typed error codes, values are opaque bytes.
 */

/** Typed storage errors. Codes are closed; a consumer branches on a published code. */
export const STORAGE_ERROR_CODES = Object.freeze({
  TIMEOUT: 'STORAGE_TIMEOUT',
  UNAVAILABLE: 'STORAGE_UNAVAILABLE',
  CONFLICT: 'STORAGE_CONFLICT',
  NOT_FOUND: 'STORAGE_NOT_FOUND',
  INVALID: 'STORAGE_INVALID',
});

export class StorageError extends Error {
  /**
   * @param {string} code one of STORAGE_ERROR_CODES values
   * @param {string} message short, non-sensitive explanation
   * @param {{ cause?: unknown, details?: object }} [options]
   */
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'StorageError';
    this.code = code;
    this.details = options.details ?? {};
    if (options.cause !== undefined) this.cause = options.cause;
    if (!Object.values(STORAGE_ERROR_CODES).includes(code)) {
      throw new TypeError(`StorageError: unknown code ${String(code)}`);
    }
  }
}

export const invalid = (message, details) => new StorageError(STORAGE_ERROR_CODES.INVALID, message, { details });
export const notFound = (message, details) => new StorageError(STORAGE_ERROR_CODES.NOT_FOUND, message, { details });
export const conflict = (message, details) => new StorageError(STORAGE_ERROR_CODES.CONFLICT, message, { details });
export const unavailable = (message, details) => new StorageError(STORAGE_ERROR_CODES.UNAVAILABLE, message, { details });
export const timeout = (message, details) => new StorageError(STORAGE_ERROR_CODES.TIMEOUT, message, { details });

/* ------------------------------------------------------------------ names and keys */

/**
 * Namespace names are caller-declared and provider-validated (charset + length).
 * Closed rule: lowercase letters, digits, dot, underscore, dash; must start with a
 * letter or digit; 1..64 characters. Cross-namespace reads do not exist.
 */
export const NAMESPACE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** Keys are opaque non-empty strings of at most 256 UTF-8 bytes. */
export const MAX_KEY_BYTES = 256;
/** Bounded list is part of the contract; unbounded enumeration is not. */
export const MAX_LIST_LIMIT = 1000;
export const DEFAULT_LIST_LIMIT = 100;

export function assertNamespace(namespace) {
  if (typeof namespace !== 'string' || !NAMESPACE_PATTERN.test(namespace)) {
    throw invalid(`namespace must match ${NAMESPACE_PATTERN.source}`, { namespace: String(namespace).slice(0, 80) });
  }
  return namespace;
}

export function assertKey(key) {
  if (typeof key !== 'string' || key.length === 0) throw invalid('key must be a non-empty string');
  const bytes = Buffer.byteLength(key, 'utf8');
  if (bytes > MAX_KEY_BYTES) throw invalid(`key must be at most ${MAX_KEY_BYTES} UTF-8 bytes`, { bytes });
  return key;
}

export function assertValueBytes(value) {
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
    throw invalid('value must be bytes (Buffer or Uint8Array); the contract never interprets value bytes');
  }
  return value instanceof Uint8Array && !Buffer.isBuffer(value) ? Buffer.from(value) : value;
}

export function assertTtlSeconds(ttlSeconds) {
  if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) {
    throw invalid('ttlSeconds must be a positive integer');
  }
  return ttlSeconds;
}

/**
 * Version tokens are OPAQUE monotonic tokens per key. Callers must never parse or
 * synthesize them; they compare tokens only with the CAS operations. (The local
 * provider emits stringified monotonic integers, but that is provider detail.)
 */
export function assertVersionToken(version) {
  if (typeof version !== 'string' || version.length === 0 || version.length > 64) {
    throw invalid('version must be an opaque token string issued by the provider');
  }
  return version;
}

/* ------------------------------------------------------------------ batch operations */

/** Batch op kinds: `put` and `delete`. CAS inside a batch is expressed with expectedVersion. */
export function assertBatchOps(ops) {
  if (!Array.isArray(ops) || ops.length === 0) throw invalid('applyBatch requires a non-empty ops array');
  if (ops.length > MAX_LIST_LIMIT) throw invalid(`applyBatch supports at most ${MAX_LIST_LIMIT} ops`, { ops: ops.length });
  return ops.map((op, index) => {
    if (!op || typeof op !== 'object') throw invalid(`op ${index} must be an object`);
    const kind = op.type === 'put' ? 'put' : op.type === 'delete' ? 'delete' : null;
    if (!kind) throw invalid(`op ${index} type must be 'put' or 'delete'`);
    const entry = { type: kind, namespace: assertNamespace(op.namespace), key: assertKey(op.key) };
    if (kind === 'put') {
      entry.value = assertValueBytes(op.value);
      if (op.ttlSeconds !== undefined) entry.ttlSeconds = assertTtlSeconds(op.ttlSeconds);
    }
    if (op.expectedVersion !== undefined) entry.expectedVersion = assertVersionToken(op.expectedVersion);
    return entry;
  });
}

/* ------------------------------------------------------------------ results */

/**
 * A read miss is a RESULT (`{ found: false }`), never an error: errors never
 * masquerade as empty reads, and empty reads never masquerade as errors.
 */
export const absent = () => Object.freeze({ found: false });

/**
 * CAS outcome is a first-class result (not an error to swallow):
 *   { applied: true,  version }                    - write landed, new version
 *   { applied: false, reason: 'version_conflict' } - key exists with another version
 *   { applied: false, reason: 'absent' }           - key does not exist (or expired)
 */
export const casApplied = (version) => Object.freeze({ applied: true, version: assertVersionToken(version) });
export const casSkipped = (reason) => {
  if (reason !== 'version_conflict' && reason !== 'absent') {
    throw invalid(`cas skip reason must be 'version_conflict' or 'absent', got ${String(reason)}`);
  }
  return Object.freeze({ applied: false, reason });
};

/**
 * deleteIfVersion outcome: { applied: true, deleted } when the expected version
 * matched (deleted is false only if the provider raced a delete; local provider
 * always deletes), or the same first-class skip result as putIfVersion.
 */
export const deleteCasApplied = (deleted) => Object.freeze({ applied: true, deleted: Boolean(deleted) });

/**
 * applyBatch outcome (all-or-nothing):
 *   { applied: true,  count }                                - every op landed
 *   { applied: false, failedOpIndex, reason }                - NOTHING landed; reason is
 *                                                              'version_conflict' or 'absent'
 * INVALID input throws before any apply; provider faults (UNAVAILABLE) roll back
 * and throw. A semantic batch conflict is a result, never a silent partial apply.
 */
export const batchApplied = (count) => Object.freeze({ applied: true, count });
export const batchAborted = (failedOpIndex, reason) => {
  if (reason !== 'version_conflict' && reason !== 'absent') {
    throw invalid(`batch abort reason must be 'version_conflict' or 'absent', got ${String(reason)}`);
  }
  if (!Number.isInteger(failedOpIndex) || failedOpIndex < 0) throw invalid('batch failedOpIndex must be a non-negative integer');
  return Object.freeze({ applied: false, failedOpIndex, reason });
};

/* ------------------------------------------------------------------ capability profile */

/**
 * A provider MUST declare what it can honestly promise.
 * - multiHost: true only for providers whose concurrency semantics hold across
 *   processes/hosts. Local-only storage MUST NOT claim multi-host semantics
 *   (owner condition, P8-S01-FOUNDATION.md item 10).
 * - durable: true only if acknowledged writes remain visible after provider
 *   restart. Callers relying on durability must check this profile.
 */
export function assertCapabilityProfile(profile) {
  if (!profile || typeof profile !== 'object') throw invalid('provider must expose a capability profile');
  const { name, multiHost, durable, maxListLimit, maxValueBytes } = profile;
  if (typeof name !== 'string' || !name) throw invalid('capability profile.name must be a non-empty string');
  if (typeof multiHost !== 'boolean' || typeof durable !== 'boolean') {
    throw invalid('capability profile.multiHost and .durable must be booleans');
  }
  if (!Number.isInteger(maxListLimit) || maxListLimit <= 0 || maxListLimit > MAX_LIST_LIMIT) {
    throw invalid(`capability profile.maxListLimit must be an integer in 1..${MAX_LIST_LIMIT}`);
  }
  if (!Number.isInteger(maxValueBytes) || maxValueBytes <= 0) throw invalid('capability profile.maxValueBytes must be a positive integer');
  return Object.freeze({ name, multiHost, durable, maxListLimit, maxValueBytes });
}

/* ------------------------------------------------------------------ provider interface */

const PROVIDER_METHODS = Object.freeze([
  'get', 'put', 'delete', 'list', 'putIfVersion', 'deleteIfVersion', 'applyBatch', 'touch',
]);

/**
 * Structural check that an object implements the provider interface. The facade
 * calls this once at wiring time so a broken provider fails at the boundary, not
 * at the first write.
 */
export function assertProvider(provider) {
  if (!provider || typeof provider !== 'object') throw invalid('provider must be an object');
  for (const method of PROVIDER_METHODS) {
    if (typeof provider[method] !== 'function') throw invalid(`provider is missing method ${method}`);
  }
  assertCapabilityProfile(provider.capabilities);
  return provider;
}

/* ------------------------------------------------------------------ facade */

function mapProviderFailure(error, operation) {
  if (error instanceof StorageError) return error;
  // A provider that throws raw errors is an UNAVAILABLE provider at the boundary;
  // the facade never lets an unmapped error masquerade as a contract result.
  return new StorageError(STORAGE_ERROR_CODES.UNAVAILABLE, `storage ${operation} failed: ${String(error?.message ?? error).slice(0, 120)}`, { cause: error });
}

/**
 * Wrap a provider in the contract boundary. Consumers hold ONLY this handle.
 * All arguments are validated here (contract rules, not provider rules), so two
 * providers reject the same invalid input identically.
 *
 * @param {{} } provider object implementing the provider interface + capabilities
 */
export function createStorage(provider) {
  assertProvider(provider);
  const caps = provider.capabilities;

  const call = (operation, fn) => {
    try {
      return fn();
    } catch (error) {
      throw mapProviderFailure(error, operation);
    }
  };

  return Object.freeze({
    /** Capability profile of the wired provider (check before relying on durability/multi-host). */
    capabilities: caps,

    get(namespace, key) {
      return call('get', () => provider.get(assertNamespace(namespace), assertKey(key)));
    },

    put(namespace, key, value, options = {}) {
      return call('put', () => {
        const opts = {};
        if (options.ttlSeconds !== undefined) opts.ttlSeconds = assertTtlSeconds(options.ttlSeconds);
        return provider.put(assertNamespace(namespace), assertKey(key), assertValueBytes(value), opts);
      });
    },

    delete(namespace, key) {
      return call('delete', () => provider.delete(assertNamespace(namespace), assertKey(key)));
    },

    list(namespace, options = {}) {
      return call('list', () => {
        const limit = options.limit ?? DEFAULT_LIST_LIMIT;
        if (!Number.isInteger(limit) || limit <= 0 || limit > caps.maxListLimit) {
          throw invalid(`list limit must be an integer in 1..${caps.maxListLimit}`);
        }
        const cursor = options.cursor;
        if (cursor !== undefined && (typeof cursor !== 'string' || cursor.length > 256)) {
          throw invalid('list cursor must be an opaque token issued by a previous list call');
        }
        return provider.list(assertNamespace(namespace), { cursor, limit });
      });
    },

    putIfVersion(namespace, key, value, expectedVersion, options = {}) {
      return call('putIfVersion', () => {
        const opts = {};
        if (options.ttlSeconds !== undefined) opts.ttlSeconds = assertTtlSeconds(options.ttlSeconds);
        return provider.putIfVersion(
          assertNamespace(namespace), assertKey(key), assertValueBytes(value),
          assertVersionToken(expectedVersion), opts,
        );
      });
    },

    deleteIfVersion(namespace, key, expectedVersion) {
      return call('deleteIfVersion', () =>
        provider.deleteIfVersion(assertNamespace(namespace), assertKey(key), assertVersionToken(expectedVersion)));
    },

    applyBatch(ops) {
      return call('applyBatch', () => provider.applyBatch(assertBatchOps(ops)));
    },

    touch(namespace, key, ttlSeconds) {
      return call('touch', () =>
        provider.touch(assertNamespace(namespace), assertKey(key), assertTtlSeconds(ttlSeconds)));
    },
  });
}
