/**
 * P5-M17 execution retry model (P5-M10-G): retry-request records bound to an
 * original execution, over the execution-store extension of the P8 storage
 * facade. The /api/v1 retry surface stays gated upstream; it mounts on this
 * model later.
 *
 * Record (closed shape) - ONE authoritative record per original execution:
 *   retry {tag:1, retryId, originalExecutionId, requestedBy, reason, state,
 *          createdAt, updatedAt, metadata}
 *   stored at key `x:<originalExecutionId>` (linkage + uniqueness in ONE key);
 *   a pointer `r:<retryId>` resolves retryId -> originalExecutionId.
 *
 * IDEMPOTENCY / DOUBLE-RETRY RULE (no silent second run):
 *   - at most ONE retry request exists per original execution, ever: a second
 *     createRetry is RETRY_CONFLICT (double-retry refusal) - on any host;
 *   - the model never runs anything itself; the executed terminal state is
 *     recorded exactly once via a pure CAS transition.
 *
 * TERMINAL-STATE RULES:
 *   - the original execution must be retry-eligible (closed set:
 *     RETRY_ELIGIBLE_EXECUTION_STATES = failed | cancelled). An unknown
 *     execution is RETRY_NOT_FOUND; a running or succeeded execution is
 *     RETRY_CONFLICT (running would be a parallel hidden run; succeeded would
 *     be a hidden second run);
 *   - retry lifecycle (closed): created -> approved -> executed
 *     (created -> rejected | aborted; approved -> rejected | aborted).
 *     `executed` and all end states are terminal. Every transition is pure CAS
 *     (version token REQUIRED; stale -> RETRY_CONFLICT).
 *
 * The original execution is resolved through a dependency-injected
 * `executionLookup(id)` -> { state } | null (provider-neutral; the engine's
 * execution records exist outside this model).
 *
 * Error set (closed): RETRY_INVALID | RETRY_NOT_FOUND | RETRY_CONFLICT.
 * Storage errors propagate unchanged.
 */

export const RETRY_ERROR_CODES = Object.freeze({
  INVALID: 'RETRY_INVALID',
  NOT_FOUND: 'RETRY_NOT_FOUND',
  CONFLICT: 'RETRY_CONFLICT',
});

export class ExecutionRetryModelError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'ExecutionRetryModelError';
    this.code = code;
    this.details = options.details ?? {};
    if (!Object.values(RETRY_ERROR_CODES).includes(code)) {
      throw new TypeError(`ExecutionRetryModelError: unknown code ${String(code)}`);
    }
  }
}

const invalid = (message, details) => new ExecutionRetryModelError(RETRY_ERROR_CODES.INVALID, message, { details });
const notFound = (message, details) => new ExecutionRetryModelError(RETRY_ERROR_CODES.NOT_FOUND, message, { details });
const conflict = (message, details) => new ExecutionRetryModelError(RETRY_ERROR_CODES.CONFLICT, message, { details });

/** Closed retry-request state vocabulary. */
export const RETRY_STATES = Object.freeze(['created', 'approved', 'executed', 'rejected', 'aborted']);
/** Legal transitions; end states have empty lists (terminal). */
export const RETRY_TRANSITIONS = Object.freeze({
  created: ['approved', 'rejected', 'aborted'],
  approved: ['executed', 'rejected', 'aborted'],
  executed: [],
  rejected: [],
  aborted: [],
});
/** Closed execution-state vocabulary understood from executionLookup. */
export const EXECUTION_STATES = Object.freeze(['running', 'succeeded', 'failed', 'cancelled']);
/** Retry-eligible original execution states (failed | cancelled only). */
export const RETRY_ELIGIBLE_EXECUTION_STATES = Object.freeze(['failed', 'cancelled']);

const RECORD_TAG = 1;
const retryKey = (originalExecutionId) => `x:${originalExecutionId}`;
const pointerKey = (retryId) => `r:${retryId}`;

const assertId = (value, field) => {
  if (typeof value !== 'string' || value.length < 6 || value.length > 128) {
    throw invalid(`${field} must be an opaque string of 6..128 characters`);
  }
  return value;
};
const assertPrincipal = (value, field) => {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) {
    throw invalid(`${field} must be a non-empty principal of at most 128 characters`);
  }
  return value;
};

/**
 * @param {object} storage storage facade handle - the ONLY persistence boundary
 * @param {object} options
 * @param {{ now: () => number }} options.clock REQUIRED deterministic clock (ms)
 * @param {() => string} options.idFactory REQUIRED opaque id factory
 * @param {(id: string) => ({ state: string } | null)} options.executionLookup
 *   REQUIRED dependency-injected resolver of the original execution record
 * @param {string} [options.namespace='exec-retry']
 */
export function createExecutionRetryModel(storage, { clock, idFactory, executionLookup, namespace = 'exec-retry' } = {}) {
  if (!storage || typeof storage.get !== 'function' || typeof storage.putIfVersion !== 'function') {
    throw invalid('createExecutionRetryModel requires a storage facade handle');
  }
  if (!clock || typeof clock.now !== 'function') throw invalid('an injected clock is required');
  if (typeof idFactory !== 'function') throw invalid('an injected idFactory is required');
  if (typeof executionLookup !== 'function') throw invalid('an injected executionLookup is required');

  const readJson = (key) => {
    const got = storage.get(namespace, key);
    if (!got.found) return null;
    let record;
    try {
      record = JSON.parse(got.value.toString('utf8'));
    } catch (error) {
      throw conflict('retry record is unreadable', { cause: error });
    }
    if (record.tag !== RECORD_TAG) throw conflict('retry record has an unsupported shape');
    return { record, version: got.version };
  };

  const readRetryByExecution = (originalExecutionId) => {
    const found = readJson(retryKey(originalExecutionId));
    if (!found) throw notFound('retry request not found', { originalExecutionId: originalExecutionId.slice(0, 8) });
    return found;
  };

  const resolve = (retryId) => {
    assertId(retryId, 'retryId');
    const pointer = storage.get(namespace, pointerKey(retryId));
    if (!pointer.found) throw notFound('retry request not found', { retryId: retryId.slice(0, 8) });
    const { originalExecutionId } = JSON.parse(pointer.value.toString('utf8'));
    return readRetryByExecution(originalExecutionId);
  };

  const requireVersion = (version) => {
    if (typeof version !== 'string' || version.length === 0) {
      throw invalid('a CAS version token is required for this update');
    }
    return version;
  };

  const createRecord = (key, record) => {
    if (storage.get(namespace, key).found) throw conflict('record already exists');
    const bytes = Buffer.from(JSON.stringify(record), 'utf8');
    storage.put(namespace, key, bytes);
    const verify = storage.get(namespace, key);
    if (!verify.found || !verify.value.equals(bytes)) {
      throw conflict('create lost a concurrent write');
    }
    return Object.freeze({ ...record, version: verify.version });
  };

  return Object.freeze({
    capabilities: storage.capabilities,
    namespace,

    /**
     * Create the (single) retry request for an original execution.
     * Double-retry refusal: a second call - on any host - is RETRY_CONFLICT.
     */
    createRetry({ originalExecutionId, requestedBy, reason = '', metadata = null } = {}) {
      assertId(originalExecutionId, 'originalExecutionId');
      assertPrincipal(requestedBy, 'requestedBy');
      const execution = executionLookup(originalExecutionId);
      if (execution === null || execution === undefined) {
        throw notFound('original execution not found', { originalExecutionId: originalExecutionId.slice(0, 8) });
      }
      if (!EXECUTION_STATES.includes(execution.state)) {
        throw invalid(`execution state must be one of ${EXECUTION_STATES.join('|')}`);
      }
      if (!RETRY_ELIGIBLE_EXECUTION_STATES.includes(execution.state)) {
        // no silent second run: running = parallel hidden run; succeeded = hidden duplicate
        throw conflict(`execution in state ${execution.state} is not retry-eligible`, {
          eligible: [...RETRY_ELIGIBLE_EXECUTION_STATES],
        });
      }
      const retryId = assertId(idFactory(), 'idFactory output');
      const now = clock.now();
      const record = {
        tag: RECORD_TAG,
        retryId,
        originalExecutionId,
        requestedBy,
        reason: typeof reason === 'string' ? reason.slice(0, 500) : '',
        state: 'created',
        createdAt: now,
        updatedAt: now,
        metadata: metadata === undefined ? null : structuredClone(metadata),
      };
      // linkage + uniqueness live in ONE authoritative key (append-only)
      const created = createRecord(retryKey(originalExecutionId), record);
      // secondary pointer (retryId -> originalExecutionId)
      createRecord(pointerKey(retryId), { tag: RECORD_TAG, retryId, originalExecutionId });
      return Object.freeze({ ...record, version: created.version });
    },

    /** Read by retryId (pointer) or by originalExecutionId. */
    getRetry(retryIdOrExecutionId) {
      assertId(retryIdOrExecutionId, 'retryIdOrExecutionId');
      try {
        const { record, version } = resolve(retryIdOrExecutionId);
        return Object.freeze({ ...record, version });
      } catch (error) {
        if (error.code !== RETRY_ERROR_CODES.NOT_FOUND) throw error;
        const { record, version } = readRetryByExecution(retryIdOrExecutionId);
        return Object.freeze({ ...record, version });
      }
    },

    /** Approve a created request (CAS). */
    approveRetry(retryId, { version } = {}) {
      return transition(retryId, 'approved', version);
    },

    /** Record the executed terminal state exactly once (CAS). */
    executeRetry(retryId, { version } = {}) {
      return transition(retryId, 'executed', version);
    },

    rejectRetry(retryId, { version } = {}) {
      return transition(retryId, 'rejected', version);
    },

    abortRetry(retryId, { version } = {}) {
      return transition(retryId, 'aborted', version);
    },

    /** Bounded listing (stable order, filter-aware cursor over retryId). */
    listRetries({ cursor = null, limit = 100 } = {}) {
      if (cursor !== null && (typeof cursor !== 'string' || cursor.length === 0 || cursor.length > 256)) {
        throw invalid('cursor must be an opaque token issued by a previous list call');
      }
      if (!Number.isInteger(limit) || limit <= 0) throw invalid('limit must be a positive integer');
      const collected = [];
      let scan;
      for (;;) {
        const page = storage.list(namespace, { cursor: scan, limit: 1000 });
        for (const entry of page.keys) {
          if (!entry.key.startsWith('x:')) continue;
          const found = readJson(entry.key);
          if (found) collected.push({ ...found.record, version: entry.version });
        }
        if (!page.nextCursor) break;
        scan = page.nextCursor;
      }
      collected.sort((a, b) => (a.retryId < b.retryId ? -1 : a.retryId > b.retryId ? 1 : 0));
      const after = cursor === null ? collected : collected.filter((r) => r.retryId > cursor);
      const items = after.slice(0, limit);
      const last = items[items.length - 1];
      return Object.freeze({
        retries: Object.freeze(items),
        nextCursor: after.length > items.length && last ? last.retryId : null,
      });
    },
  });

  function transition(retryId, target, version) {
    requireVersion(version);
    const { record } = resolve(retryId);
    const allowed = RETRY_TRANSITIONS[record.state];
    if (!allowed.includes(target)) {
      throw invalid(`cannot move a retry from ${record.state} to ${target}`);
    }
    const next = { ...record, state: target, updatedAt: clock.now() };
    const applied = storage.putIfVersion(
      namespace, retryKey(record.originalExecutionId),
      Buffer.from(JSON.stringify(next), 'utf8'), version,
    );
    if (!applied.applied) {
      throw conflict('retry update lost a concurrent update', { reason: applied.reason });
    }
    return Object.freeze({ ...next, version: applied.version });
  }
}

export const EXECUTION_RETRY_MODEL_VERSION = 1;
