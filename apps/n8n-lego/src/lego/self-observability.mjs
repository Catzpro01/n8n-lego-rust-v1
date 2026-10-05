/** P9.18 telemetry self-observability. Product owner agent-6;
 * implementation delegate Agent 4 (Issue #101). P9 must report at minimum:
 * generated, dropped, sampled, buffered, export_failed, redacted,
 * cardinality_rejected, query_slow, diagnostic_bundle_failed, degraded.
 * Self-metrics are a fixed bounded key set with saturating integer values;
 * zero errors is distinguishable from zero telemetry; self-observation never
 * recurses indefinitely (re-entrancy guard); self-telemetry has its own
 * suppression/priority rule (counters always update; detail delivery may be
 * suppressed under outage, P0/P1 always delivered). No I/O, no clock, no
 * workflow/execution import.
 */
import { containsSecretShape } from './telemetry-redaction.mjs';

export const SELFVIEW_CONTRACT = Object.freeze({
  id: 'observability.self-observability', version: '1.0.0', owner: 'agent-6',
});
export const SELFVIEW_SCHEMA_VERSION = '1.0.0';

/** Minimum DoD counter set — fixed keys; never grows at runtime. */
export const SELFVIEW_COUNTERS = Object.freeze([
  'generated', 'dropped', 'sampled', 'buffered', 'export_failed',
  'redacted', 'cardinality_rejected', 'query_slow',
  'diagnostic_bundle_failed', 'degraded',
]);

/** Counters that constitute errors for zero-errors vs zero-telemetry. */
export const SELFVIEW_ERROR_COUNTERS = Object.freeze([
  'export_failed', 'cardinality_rejected', 'query_slow',
  'diagnostic_bundle_failed',
]);

/** note(kind) accepts exactly the counter names (identity mapping). */
export const SELFVIEW_EVENT_KINDS = SELFVIEW_COUNTERS;

export const SELFVIEW_PRIORITIES = Object.freeze(['P0', 'P1', 'P2', 'P3', 'P4']);

/** Self-telemetry's own suppression/priority rule. */
export const SELFVIEW_SUPPRESSION = Object.freeze({
  rule: 'counters-always-detail-may-suppress',
  protectedPriorities: Object.freeze(['P0', 'P1']),
  detailPriorities: Object.freeze(['P2', 'P3', 'P4']),
  suppressedWhen: 'outage',
});

export const SELFVIEW_LIMITS = Object.freeze({
  maxCounterValue: Number.MAX_SAFE_INTEGER, // saturating — bounded values
  maxDepth: 1, // re-entrancy: a note() inside note() is suppressed
  minCapacity: 1,
  maxCapacity: 65536,
  defaultCapacity: 256,
  minDegradeAfterFailures: 1,
  maxDegradeAfterFailures: 1000,
  defaultDegradeAfterFailures: 3,
});

export const SELFVIEW_NOTES = Object.freeze([
  'required-counters',
  'zero-errors-vs-zero-telemetry',
  'bounded-self-metrics',
  'recursion-guard',
  'self-suppression-priority',
]);

const CONFIG_KEYS = Object.freeze(['capacity', 'degradeAfterFailures', 'onNote']);
const NOTE_KEYS = Object.freeze(['priority']);

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

function zeroCounters() {
  const c = {};
  for (const k of SELFVIEW_COUNTERS) c[k] = 0;
  return c;
}

/**
 * Create a self-observability recorder. Config:
 *  capacity (bounded buffered occupancy), degradeAfterFailures (outage → degraded),
 *  onNote (optional hook invoked per processed note; re-entrant note() is suppressed).
 * Fail closed → null.
 */
export function createSelfObservability(config = {}) {
  if (!isPlain(config)) return null;
  if (Reflect.ownKeys(config).some(k => !CONFIG_KEYS.includes(k))) return null;

  const capacity = config.capacity === undefined
    ? SELFVIEW_LIMITS.defaultCapacity : config.capacity;
  if (!Number.isSafeInteger(capacity) || capacity < SELFVIEW_LIMITS.minCapacity ||
      capacity > SELFVIEW_LIMITS.maxCapacity) return null;

  const degradeAfterFailures = config.degradeAfterFailures === undefined
    ? SELFVIEW_LIMITS.defaultDegradeAfterFailures : config.degradeAfterFailures;
  if (!Number.isSafeInteger(degradeAfterFailures) ||
      degradeAfterFailures < SELFVIEW_LIMITS.minDegradeAfterFailures ||
      degradeAfterFailures > SELFVIEW_LIMITS.maxDegradeAfterFailures) return null;

  const onNote = config.onNote === undefined ? null : config.onNote;
  if (onNote !== null && typeof onNote !== 'function') return null;

  const state = {
    counters: zeroCounters(),
    internal: {
      recursion_suppressed: 0,
      detail_suppressed: 0,
      detail_delivered: 0,
      export_attempts: 0,
      export_ok: 0,
      consecutive_export_failures: 0,
    },
    capacity,
    occupancy: 0,
    depth: 0,
    outage: false,
    degraded: false,
  };

  /** Saturating bump — bounded at MAX_SAFE_INTEGER. */
  function bump(key) {
    const v = state.counters[key];
    if (v >= SELFVIEW_LIMITS.maxCounterValue) return v;
    state.counters[key] = v + 1;
    return state.counters[key];
  }

  function errorTotal() {
    let n = 0;
    for (const k of SELFVIEW_ERROR_COUNTERS) n += state.counters[k];
    return n;
  }

  /**
   * Record a self-telemetry event. kind must be one of SELFVIEW_COUNTERS.
   * options: { priority } (default P2). Under outage, P2–P4 detail delivery
   * is suppressed (counter still bumps); P0/P1 always delivered. Re-entrant
   * calls (from inside onNote) are suppressed by the recursion guard.
   * Returns frozen report or error.
   */
  function note(kind, options = undefined) {
    if (state.depth >= SELFVIEW_LIMITS.maxDepth) {
      state.internal.recursion_suppressed++;
      return err('selfview.recursion', 'self-observation does not recurse');
    }
    if (typeof kind !== 'string' || !SELFVIEW_EVENT_KINDS.includes(kind)) {
      return err('selfview.invalid_kind', 'unknown event kind');
    }
    if (options !== undefined) {
      if (!isPlain(options) || Reflect.ownKeys(options).some(k => !NOTE_KEYS.includes(k))) {
        return err('selfview.invalid_options', 'options must be { priority }');
      }
      if (options.priority !== undefined && !SELFVIEW_PRIORITIES.includes(options.priority)) {
        return err('selfview.invalid_options', 'priority invalid');
      }
      if (containsSecretShape(options)) {
        return err('selfview.secret', 'secret-shaped options');
      }
    }
    const priority = options === undefined || options.priority === undefined
      ? 'P2' : options.priority;

    state.depth += 1;
    try {
      const value = bump(kind);
      const suppressed = state.outage &&
        SELFVIEW_SUPPRESSION.detailPriorities.includes(priority);
      let delivered = false;
      if (!suppressed) {
        if (onNote !== null) {
          // Hook runs inside the depth guard: a note() from within onNote
          // hits the recursion guard above and never re-enters this body.
          onNote(Object.freeze({
            kind, priority, value,
            outage: state.outage,
          }));
        }
        delivered = true;
        state.internal.detail_delivered += 1;
      } else {
        state.internal.detail_suppressed += 1;
      }
      return Object.freeze({
        ok: true,
        report: Object.freeze({
          kind, value, priority, delivered,
          suppressed, outage: state.outage,
        }),
      });
    } finally {
      state.depth -= 1;
    }
  }

  /**
   * Buffer one unit of telemetry. Succeeds while occupancy < capacity
   * (bumps buffered); otherwise bumps dropped (drop-counter path).
   */
  function offer() {
    if (state.occupancy >= capacity) {
      const value = bump('dropped');
      return Object.freeze({ ok: true, outcome: 'dropped', value, occupancy: state.occupancy });
    }
    state.occupancy += 1;
    const value = bump('buffered');
    return Object.freeze({ ok: true, outcome: 'buffered', value, occupancy: state.occupancy });
  }

  /** Release up to n buffered units (occupancy never negative). */
  function take(n = 1) {
    if (!Number.isSafeInteger(n) || n < 1) {
      return err('selfview.invalid_options', 'take n must be a positive integer');
    }
    const released = Math.min(n, state.occupancy);
    state.occupancy -= released;
    return Object.freeze({ ok: true, released, occupancy: state.occupancy });
  }

  /**
   * Record an export attempt. Failure marks outage, bumps export_failed,
   * and after degradeAfterFailures consecutive failures bumps degraded once.
   * Success clears outage/degraded/consecutive counter (cumulative counters
   * stay honest). This is the simulated telemetry outage entry point.
   */
  function attemptExport(ok) {
    if (typeof ok !== 'boolean') {
      return err('selfview.invalid_export', 'ok must be a boolean');
    }
    state.internal.export_attempts += 1;
    if (ok) {
      state.internal.export_ok += 1;
      state.internal.consecutive_export_failures = 0;
      state.outage = false;
      state.degraded = false;
      return Object.freeze({
        ok: true, outcome: 'exported',
        outage: false, degraded: false,
        exportFailed: state.counters.export_failed,
      });
    }
    state.outage = true;
    state.internal.consecutive_export_failures += 1;
    const value = bump('export_failed');
    let degradedNow = false;
    if (!state.degraded &&
        state.internal.consecutive_export_failures >= degradeAfterFailures) {
      state.degraded = true;
      bump('degraded');
      degradedNow = true;
    }
    return Object.freeze({
      ok: true, outcome: 'export_failed',
      outage: true, degraded: state.degraded, degradedNow,
      exportFailed: value,
    });
  }

  /**
   * Deterministic snapshot: the 10 DoD counters, explicit zero-errors vs
   * zero-telemetry booleans (independent), occupancy/capacity, outage state.
   */
  function snapshot() {
    const errorTotal = errorTotal_();
    const zeroTelemetry = state.counters.generated === 0;
    const zeroErrors = errorTotal === 0;
    const classification = zeroTelemetry
      ? (zeroErrors ? 'no_telemetry_no_errors' : 'no_telemetry_errors_present')
      : (zeroErrors ? 'telemetry_zero_errors' : 'telemetry_errors_present');
    return Object.freeze({
      schemaVersion: SELFVIEW_SCHEMA_VERSION,
      contract: Object.freeze({ ...SELFVIEW_CONTRACT }),
      counters: Object.freeze({ ...state.counters }),
      errorTotal,
      // Independent dimensions: all-idle (both true) is not the same as
      // healthy traffic (zeroTelemetry false, zeroErrors true).
      zeroTelemetry,
      zeroErrors,
      classification,
      occupancy: state.occupancy,
      capacity,
      outage: state.outage,
      degraded: state.degraded,
      consecutiveExportFailures: state.internal.consecutive_export_failures,
      internal: Object.freeze({ ...state.internal }),
    });

    function errorTotal_() {
      let n = 0;
      for (const k of SELFVIEW_ERROR_COUNTERS) n += state.counters[k];
      return n;
    }
  }

  return Object.freeze({
    note, offer, take, attemptExport, snapshot,
    stats: state.counters,
  });
}
