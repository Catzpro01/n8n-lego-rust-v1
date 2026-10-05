/** P9.16 operator inspection API. Product owner agent-6; implementation
 * delegate Agent 4 (Issue #101). Authorized health/readiness/logs/metrics/
 * traces/diagnostics interfaces with pagination, timeouts, cancellation,
 * bounded results, access policy, indexed (bounded) query strategies, and
 * stable machine-readable errors. Queries are pure over caller-provided
 * datasets — they never touch workflow runtime, never perform I/O, and never
 * block a business path (hard row/time ceilings; workflow does not import
 * this module).
 */
import { containsSecretShape } from './telemetry-redaction.mjs';

export const OPERATOR_CONTRACT = Object.freeze({
  id: 'observability.operator-inspection', version: '1.0.0', owner: 'agent-6',
});
export const OPERATOR_SCHEMA_VERSION = '1.0.0';

/** Interfaces exposed as authorized (DoD). */
export const OPERATOR_INTERFACES = Object.freeze([
  'health', 'readiness', 'logs', 'metrics', 'traces', 'diagnostics',
]);

/** Roles → allowed interfaces. Access policy is explicit, not implicit. */
export const OPERATOR_ROLES = Object.freeze(['viewer', 'operator', 'admin']);
export const OPERATOR_ROLE_GRANTS = Object.freeze({
  viewer: Object.freeze(['health', 'readiness', 'logs', 'metrics', 'traces', 'diagnostics']),
  operator: Object.freeze(['health', 'readiness', 'logs', 'metrics', 'traces', 'diagnostics']),
  admin: Object.freeze(['health', 'readiness', 'logs', 'metrics', 'traces', 'diagnostics']),
});
/** Explicit denial list for unauthorized evidence: role guest has nothing. */
export const OPERATOR_DENIED_ROLES = Object.freeze(['guest', '']);

/** Stable machine-readable error codes (never free-text only). */
export const OPERATOR_ERRORS = Object.freeze({
  unauthorized: 'operator.unauthorized',
  forbidden: 'operator.forbidden',
  notFound: 'operator.not_found',
  invalidQuery: 'operator.invalid_query',
  timeout: 'operator.timeout',
  cancelled: 'operator.cancelled',
  tooLarge: 'operator.result_too_large',
  rateLimited: 'operator.rate_limited',
  busy: 'operator.busy',
});

export const OPERATOR_LIMITS = Object.freeze({
  identifierBytes: 128,
  minLimit: 1,
  maxLimit: 500,
  defaultLimit: 50,
  minTimeoutMs: 1,
  maxTimeoutMs: 30_000,
  defaultTimeoutMs: 2_000,
  maxDatasetRows: 100_000,
  maxIndexes: 32,
  maxInFlight: 64,
  maxStormQueries: 1000,
});

export const OPERATOR_NOTES = Object.freeze([
  'authorized-interfaces-only',
  'paginated-bounded-results',
  'timeout-and-cancellation',
  'indexed-bounded-scan',
  'stable-error-codes',
  'query-off-workflow-path',
]);

const QUERY_KEYS = Object.freeze([
  'iface', 'role', 'limit', 'cursor', 'timeoutMs', 'where',
]);
const WHERE_KEYS = Object.freeze(['field', 'equals', 'prefix']);
const IFACE_SOURCE = Object.freeze({
  health: 'health', readiness: 'health',
  logs: 'logs', metrics: 'metrics', traces: 'traces', diagnostics: 'diagnostics',
});

function isPlain(value) {
  return value !== null && typeof value === 'object' &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function err(code, message, extra = undefined) {
  return Object.freeze({
    ok: false,
    error: Object.freeze({ code, message, ...(extra ? { ...extra } : {}) }),
  });
}

/**
 * Create an inspection API over a caller-provided dataset.
 * dataset: { health?, logs?, metrics?, traces?, diagnostics? } arrays of rows.
 * Optional config: { indexes: string[], maxInFlight }. Fail closed → null.
 */
export function createOperatorApi(dataset, config = {}) {
  if (!isPlain(dataset)) return null;
  if (!isPlain(config)) return null;
  if (Reflect.ownKeys(config).some(k => !['indexes', 'maxInFlight'].includes(k))) return null;

  const sources = {};
  for (const key of ['health', 'logs', 'metrics', 'traces', 'diagnostics']) {
    const rows = dataset[key] === undefined ? [] : dataset[key];
    if (!Array.isArray(rows)) return null;
    if (rows.length > OPERATOR_LIMITS.maxDatasetRows) return null;
    for (const row of rows) {
      if (!isPlain(row)) return null;
      if (containsSecretShape(row)) return null;
    }
    sources[key] = rows;
  }

  const indexFields = config.indexes === undefined
    ? ['id', 'level', 'traceId', 'kind'] : config.indexes;
  if (!Array.isArray(indexFields) || indexFields.length > OPERATOR_LIMITS.maxIndexes) return null;
  const indexes = {};
  for (const field of indexFields) {
    if (typeof field !== 'string' || field.length === 0 || field.length > 64) return null;
    indexes[field] = new Map();
  }
  for (const [src, rows] of Object.entries(sources)) {
    rows.forEach((row, i) => {
      for (const field of Object.keys(indexes)) {
        const v = row[field];
        if (v === undefined || v === null) continue;
        const key = src + '\u0000' + String(v);
        if (!indexes[field].has(key)) indexes[field].set(key, []);
        indexes[field].get(key).push(i);
      }
    });
  }

  const maxInFlight = config.maxInFlight === undefined
    ? OPERATOR_LIMITS.maxInFlight : config.maxInFlight;
  if (!Number.isSafeInteger(maxInFlight) || maxInFlight < 1 ||
      maxInFlight > OPERATOR_LIMITS.maxInFlight) return null;

  let inFlight = 0;
  const stats = {
    queries: 0, unauthorized: 0, timedOut: 0, cancelled: 0,
    rateLimited: 0, rowsScanned: 0, rowsReturned: 0, pages: 0,
  };

  function allowed(role, iface) {
    if (typeof role !== 'string') return false;
    if (OPERATOR_DENIED_ROLES.includes(role)) return false;
    const grants = OPERATOR_ROLE_GRANTS[role];
    if (!grants) return false;
    return grants.includes(iface);
  }

  /**
   * Bounded query. ctl optional { now(), cancelled() } for deterministic
   * timeout/cancellation. Never throws; always {ok, result|error}.
   */
  function query(spec, ctl = undefined) {
    try {
      if (!isPlain(spec)) return err(OPERATOR_ERRORS.invalidQuery, 'query must be an object');
      if (Reflect.ownKeys(spec).some(k => !QUERY_KEYS.includes(k))) {
        return err(OPERATOR_ERRORS.invalidQuery, 'unknown query field');
      }
      stats.queries++;
      const iface = spec.iface;
      if (typeof iface !== 'string' || !OPERATOR_INTERFACES.includes(iface)) {
        return err(OPERATOR_ERRORS.invalidQuery, 'unknown interface', {
          iface: typeof iface === 'string' ? iface : null,
        });
      }
      const role = spec.role;
      if (!allowed(role, iface)) {
        stats.unauthorized++;
        return err(OPERATOR_ERRORS.unauthorized, 'operator access policy denied this interface', {
          iface, role: typeof role === 'string' ? role : null,
        });
      }

      if (inFlight >= maxInFlight) {
        stats.rateLimited++;
        return err(OPERATOR_ERRORS.busy, 'too many concurrent queries', { maxInFlight });
      }

      const limit = spec.limit === undefined ? OPERATOR_LIMITS.defaultLimit : spec.limit;
      if (!Number.isSafeInteger(limit) || limit < OPERATOR_LIMITS.minLimit ||
          limit > OPERATOR_LIMITS.maxLimit) {
        return err(OPERATOR_ERRORS.invalidQuery, 'limit out of bounds', {
          min: OPERATOR_LIMITS.minLimit, max: OPERATOR_LIMITS.maxLimit,
        });
      }
      const timeoutMs = spec.timeoutMs === undefined
        ? OPERATOR_LIMITS.defaultTimeoutMs : spec.timeoutMs;
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < OPERATOR_LIMITS.minTimeoutMs ||
          timeoutMs > OPERATOR_LIMITS.maxTimeoutMs) {
        return err(OPERATOR_ERRORS.invalidQuery, 'timeoutMs out of bounds');
      }
      let cursor = 0;
      if (spec.cursor !== undefined) {
        if (!Number.isSafeInteger(spec.cursor) || spec.cursor < 0) {
          return err(OPERATOR_ERRORS.invalidQuery, 'cursor must be a non-negative integer');
        }
        cursor = spec.cursor;
      }
      let where = null;
      if (spec.where !== undefined) {
        if (!isPlain(spec.where)) return err(OPERATOR_ERRORS.invalidQuery, 'where must be an object');
        if (Reflect.ownKeys(spec.where).some(k => !WHERE_KEYS.includes(k))) {
          return err(OPERATOR_ERRORS.invalidQuery, 'unknown where field');
        }
        if (typeof spec.where.field !== 'string' || spec.where.field.length === 0 ||
            spec.where.field.length > 64) {
          return err(OPERATOR_ERRORS.invalidQuery, 'where.field invalid');
        }
        if (spec.where.equals !== undefined && spec.where.prefix !== undefined) {
          return err(OPERATOR_ERRORS.invalidQuery, 'where equals and prefix are mutually exclusive');
        }
        if (spec.where.equals === undefined && spec.where.prefix === undefined) {
          return err(OPERATOR_ERRORS.invalidQuery, 'where needs equals or prefix');
        }
        if (spec.where.equals !== undefined &&
            !['string', 'number', 'boolean'].includes(typeof spec.where.equals)) {
          return err(OPERATOR_ERRORS.invalidQuery, 'where.equals must be scalar');
        }
        if (spec.where.prefix !== undefined && typeof spec.where.prefix !== 'string') {
          return err(OPERATOR_ERRORS.invalidQuery, 'where.prefix must be a string');
        }
        where = spec.where;
      }

      const sourceKey = IFACE_SOURCE[iface];
      const rows = sources[sourceKey];
      const nowStart = ctl && typeof ctl.now === 'function' ? ctl.now() : null;
      const isCancelled = () => ctl && typeof ctl.cancelled === 'function' && ctl.cancelled();
      const timedOut = () => {
        if (nowStart === null || !ctl || typeof ctl.now !== 'function') return false;
        return ctl.now() - nowStart >= timeoutMs;
      };

      inFlight++;
      try {
        let candidates = null;
        let usedIndex = false;
        if (where && indexes[where.field]) {
          usedIndex = true;
          if (where.equals !== undefined) {
            const key = sourceKey + '\u0000' + String(where.equals);
            candidates = indexes[where.field].get(key) || [];
          } else {
            candidates = [];
            const prefixKey = sourceKey + '\u0000';
            for (const [k, list] of indexes[where.field]) {
              if (timedOut()) {
                stats.timedOut++;
                return err(OPERATOR_ERRORS.timeout, 'query exceeded timeoutMs', { timeoutMs });
              }
              if (isCancelled()) {
                stats.cancelled++;
                return err(OPERATOR_ERRORS.cancelled, 'query cancelled');
              }
              if (!k.startsWith(prefixKey)) continue;
              const v = k.slice(prefixKey.length);
              if (v.startsWith(where.prefix)) candidates.push(...list);
              if (candidates.length > OPERATOR_LIMITS.maxDatasetRows) break;
            }
          }
        }

        const page = [];
        let scanned = 0;
        let nextCursor = null;
        const match = (row) => {
          if (!where) return true;
          const v = row[where.field];
          if (where.equals !== undefined) return v === where.equals;
          return typeof v === 'string' && v.startsWith(where.prefix);
        };

        if (candidates) {
          for (let i = cursor; i < candidates.length; i++) {
            if (timedOut()) {
              stats.timedOut++;
              return err(OPERATOR_ERRORS.timeout, 'query exceeded timeoutMs', { timeoutMs });
            }
            if (isCancelled()) {
              stats.cancelled++;
              return err(OPERATOR_ERRORS.cancelled, 'query cancelled');
            }
            scanned++;
            stats.rowsScanned++;
            const row = rows[candidates[i]];
            if (!row || !match(row)) continue;
            page.push(row);
            if (page.length >= limit) {
              nextCursor = i + 1;
              break;
            }
          }
        } else {
          for (let i = cursor; i < rows.length; i++) {
            if (timedOut()) {
              stats.timedOut++;
              return err(OPERATOR_ERRORS.timeout, 'query exceeded timeoutMs', { timeoutMs });
            }
            if (isCancelled()) {
              stats.cancelled++;
              return err(OPERATOR_ERRORS.cancelled, 'query cancelled');
            }
            scanned++;
            stats.rowsScanned++;
            if (!match(rows[i])) continue;
            page.push(rows[i]);
            if (page.length >= limit) {
              nextCursor = i + 1;
              break;
            }
          }
        }

        stats.rowsReturned += page.length;
        stats.pages++;
        return Object.freeze({
          ok: true,
          result: Object.freeze({
            iface,
            rows: Object.freeze(page.map(r => Object.freeze({ ...r }))),
            count: page.length,
            cursor,
            nextCursor,
            hasMore: nextCursor !== null,
            scanned,
            usedIndex,
            bounded: true,
          }),
        });
      } finally {
        inFlight--;
      }
    } catch {
      return err(OPERATOR_ERRORS.invalidQuery, 'query failed closed');
    }
  }

  function healthSnapshot() {
    return Object.freeze({
      ok: true,
      result: Object.freeze({
        interfaces: Object.freeze([...OPERATOR_INTERFACES]),
        stats: Object.freeze({ ...stats }),
        inFlight,
        maxInFlight,
        schemaVersion: OPERATOR_SCHEMA_VERSION,
      }),
    });
  }

  return Object.freeze({
    query,
    healthSnapshot,
    stats,
    indexes: Object.freeze(Object.keys(indexes)),
  });
}
