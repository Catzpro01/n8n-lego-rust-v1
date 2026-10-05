/** P9.9 resource / pressure telemetry. Product owner agent-6;
 * implementation delegate Agent 4 (Issue #101). Observes CPU/memory/disk/
 * network and applicable runtime resources; distinguishes OBSERVED vs
 * ESTIMATED vs REPORTED (never fabricates provider-reported values); exposes
 * canonical pressure states NORMAL/PRESSURED/CONSTRAINED/CRITICAL/UNKNOWN with
 * policy-driven thresholds. Readings land in a fixed-size history ring (no
 * unbounded telemetry from resource sampling). Pressure transitions emit a
 * degradation hint so P9 can degrade before the workflow runtime destabilizes.
 * An optional collector runs fail-safe: exceptions → UNKNOWN + failure counter.
 * P9 reports the condition; P3/P4/P6 decide what to do. No I/O, no clock,
 * no workflow import.
 */
export const RESOURCE_PRESSURE_CONTRACT = Object.freeze({
  id: 'observability.resource-pressure', version: '1.0.0', owner: 'agent-6',
});
/** #101 deep design §11 canonical operational pressure states. */
export const PRESSURE_STATES = Object.freeze([
  'NORMAL', 'PRESSURED', 'CONSTRAINED', 'CRITICAL', 'UNKNOWN',
]);
/** #101 deep design §10 — value provenance ladder. REPORTED only when a
 * provider actually reported it; OBSERVED = measured here; ESTIMATED = derived. */
export const VALUE_PROVENANCE = Object.freeze(['OBSERVED', 'ESTIMATED', 'REPORTED']);
export const RESOURCE_DIMENSIONS = Object.freeze([
  'cpu', 'memory', 'disk', 'network',
  'activeExecutions', 'queueDepth', 'openConnections', 'fileDescriptors',
]);
/** Degradation levels tied to pressure (0 = none) — P9.17 low-resource mode
 * and boundary policy consume this; P9 never applies it to workflow itself. */
export const DEGRADATION_LEVELS = Object.freeze({
  NORMAL: 0, UNKNOWN: 0, PRESSURED: 1, CONSTRAINED: 2, CRITICAL: 3,
});
export const PRESSURE_LIMITS = Object.freeze({
  maxHistory: 1024,
  maxThresholds: RESOURCE_DIMENSIONS.length,
  valueMin: 0,
  valueMax: Number.MAX_SAFE_INTEGER,
  maxCollectorReadings: RESOURCE_DIMENSIONS.length,
  // Unit-less ratios: thresholds may be absolute counts OR fractions in [0,1]
  // when dimension is normalized by the collector.
});
const CONFIG_KEYS = Object.freeze(['historySize', 'thresholds', 'collector', 'degradationHook']);
const THRESHOLD_KEYS = Object.freeze(['warn', 'high', 'critical']);
/** Default policy thresholds — absolute units (collector supplies consistent
 * units). Operators override via config.thresholds (policy-driven DoD). */
export const DEFAULT_PRESSURE_THRESHOLDS = Object.freeze({
  cpu: { warn: 0.7, high: 0.85, critical: 0.95 },          // utilization fraction
  memory: { warn: 0.7, high: 0.85, critical: 0.95 },       // used fraction
  disk: { warn: 0.8, high: 0.9, critical: 0.97 },          // used fraction
  network: { warn: 0.7, high: 0.9, critical: 0.98 },       // saturation fraction
  activeExecutions: { warn: 32, high: 64, critical: 128 },
  queueDepth: { warn: 100, high: 500, critical: 2000 },
  openConnections: { warn: 200, high: 500, critical: 1000 },
  fileDescriptors: { warn: 0.7, high: 0.85, critical: 0.95 },
});

function isPlain(value) {
  return value !== null && typeof value === 'object' &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function clampStateRank(state) {
  switch (state) {
    case 'NORMAL': return 0;
    case 'PRESSURED': return 1;
    case 'CONSTRAINED': return 2;
    case 'CRITICAL': return 3;
    default: return -1; // UNKNOWN handled separately
  }
}
function validateThresholds(raw) {
  if (raw === undefined) return { ok: true, thresholds: DEFAULT_PRESSURE_THRESHOLDS };
  if (!isPlain(raw)) return { ok: false, thresholds: null };
  const keys = Reflect.ownKeys(raw);
  if (keys.some(k => typeof k !== 'string' || !RESOURCE_DIMENSIONS.includes(k))) {
    return { ok: false, thresholds: null };
  }
  const out = {};
  for (const dim of RESOURCE_DIMENSIONS) {
    if (raw[dim] === undefined) {
      out[dim] = DEFAULT_PRESSURE_THRESHOLDS[dim];
      continue;
    }
    const t = raw[dim];
    if (!isPlain(t)) return { ok: false, thresholds: null };
    const tKeys = Reflect.ownKeys(t);
    if (tKeys.some(k => !THRESHOLD_KEYS.includes(k))) return { ok: false, thresholds: null };
    const warn = t.warn, high = t.high, critical = t.critical;
    for (const v of [warn, high, critical]) {
      if (typeof v !== 'number' || !Number.isFinite(v) || v < PRESSURE_LIMITS.valueMin) {
        return { ok: false, thresholds: null };
      }
    }
    if (!(warn <= high && high <= critical)) return { ok: false, thresholds: null };
    out[dim] = Object.freeze({ warn, high, critical });
  }
  return { ok: true, thresholds: Object.freeze(out) };
}
function classifyValue(dim, value, thresholds) {
  const t = thresholds[dim];
  if (!t) return 'UNKNOWN';
  if (value >= t.critical) return 'CRITICAL';
  if (value >= t.high) return 'CONSTRAINED';
  if (value >= t.warn) return 'PRESSURED';
  return 'NORMAL';
}

/**
 * Create a resource/pressure monitor. Fail-closed: invalid config → null.
 * historySize bounds the reading ring (resource samples never grow unbounded).
 */
export function createResourcePressureMonitor(config) {
  try {
    if (config !== undefined && config !== null && !isPlain(config)) return null;
    const cfg = config ?? {};
    const keys = Reflect.ownKeys(cfg);
    if (keys.some(k => !CONFIG_KEYS.includes(k))) return null;

    const historySize = cfg.historySize === undefined ? 256 : cfg.historySize;
    if (!Number.isSafeInteger(historySize) || historySize < 1 ||
        historySize > PRESSURE_LIMITS.maxHistory) return null;

    const vThresholds = validateThresholds(cfg.thresholds);
    if (!vThresholds.ok) return null;
    let thresholds = vThresholds.thresholds;

    let collector = null;
    if (cfg.collector !== undefined) {
      if (typeof cfg.collector !== 'function') return null;
      collector = cfg.collector;
    }
    let degradationHook = null;
    if (cfg.degradationHook !== undefined) {
      if (typeof cfg.degradationHook !== 'function') return null;
      degradationHook = cfg.degradationHook;
    }

    // Fixed-size history ring — memory ceiling is policy.
    const history = new Array(historySize).fill(null);
    let historyHead = 0;
    let historyCount = 0;

    /** Latest value per dimension (bounded by RESOURCE_DIMENSIONS.length). */
    const latest = Object.create(null);
    const latestProvenance = Object.create(null);

    let currentState = 'NORMAL'; // optimistic until first bad reading
    let lastTransition = null; // { from, to, dimension, degradation }
    let collectorFailures = 0;
    let readingsAccepted = 0;
    let readingsRejected = 0;
    let historyOverflowDrops = 0;
    let transitions = 0;
    let peakDegradation = 0;
    let unknownSinceCollectorFail = false;

    function pushHistory(entry) {
      if (historyCount === historySize) {
        historyOverflowDrops++;
        // overwrite oldest
        history[historyHead] = entry;
        historyHead = (historyHead + 1) % historySize;
      } else {
        const idx = (historyHead + historyCount) % historySize;
        history[idx] = entry;
        historyCount++;
      }
    }

    function recomputeState() {
      // Worst state across dimensions that have a latest reading; UNKNOWN only
      // when collector failed and we have no usable readings path.
      if (unknownSinceCollectorFail && historyCount === 0) return 'UNKNOWN';
      let worst = 'NORMAL';
      let worstRank = 0;
      let worstDim = null;
      let sawAny = false;
      for (const dim of RESOURCE_DIMENSIONS) {
        if (latest[dim] === undefined) continue;
        sawAny = true;
        const st = classifyValue(dim, latest[dim], thresholds);
        const rank = clampStateRank(st);
        if (rank > worstRank) {
          worstRank = rank;
          worst = st;
          worstDim = dim;
        }
      }
      if (!sawAny) return unknownSinceCollectorFail ? 'UNKNOWN' : 'NORMAL';
      return worst;
    }

    function applyState(next, dimension) {
      if (next === currentState) return null;
      const from = currentState;
      currentState = next;
      transitions++;
      const degradation = DEGRADATION_LEVELS[next] ?? 0;
      if (degradation > peakDegradation) peakDegradation = degradation;
      lastTransition = Object.freeze({
        from, to: next, dimension: dimension ?? null, degradation,
      });
      if (degradationHook) {
        try { degradationHook(lastTransition); } catch { /* hook must not break monitor */ }
      }
      return lastTransition;
    }

    /**
     * Record one resource reading. provenance must be OBSERVED/ESTIMATED/
     * REPORTED — reject anything else (never fabricate REPORTED).
     */
    function recordReading(reading) {
      try {
        if (!isPlain(reading)) { readingsRejected++; return null; }
        const rk = Reflect.ownKeys(reading);
        if (rk.some(k => !['dimension', 'value', 'provenance', 'at'].includes(k))) {
          readingsRejected++;
          return null;
        }
        const { dimension, value, provenance } = reading;
        if (typeof dimension !== 'string' || !RESOURCE_DIMENSIONS.includes(dimension)) {
          readingsRejected++;
          return null;
        }
        if (typeof value !== 'number' || !Number.isFinite(value) ||
            value < PRESSURE_LIMITS.valueMin || value > PRESSURE_LIMITS.valueMax) {
          readingsRejected++;
          return null;
        }
        if (!VALUE_PROVENANCE.includes(provenance)) {
          readingsRejected++;
          return null;
        }
        // Optional correlation token (bounded string) — not a clock.
        let at = null;
        if (reading.at !== undefined) {
          if (typeof reading.at !== 'string' || reading.at.length > 128) {
            readingsRejected++;
            return null;
          }
          at = reading.at;
        }
        latest[dimension] = value;
        latestProvenance[dimension] = provenance;
        unknownSinceCollectorFail = false;
        readingsAccepted++;
        const level = classifyValue(dimension, value, thresholds);
        const entry = Object.freeze({
          dimension, value, provenance, level, at,
        });
        pushHistory(entry);
        const next = recomputeState();
        const transition = applyState(next, dimension);
        return Object.freeze({
          reading: entry,
          state: currentState,
          transition,
        });
      } catch {
        readingsRejected++;
        return null;
      }
    }

    /**
     * Optional fail-safe collector pass: runs cfg.collector to obtain an
     * array of readings (or a single reading). Collector exceptions → UNKNOWN
     * state path + collectorFailures++ (never throws out).
     */
    function collect() {
      if (!collector) return null;
      try {
        const out = collector();
        const list = Array.isArray(out) ? out : [out];
        if (list.length > PRESSURE_LIMITS.maxCollectorReadings) {
          // Bound the batch — first N only; extras counted as rejected.
          const excess = list.length - PRESSURE_LIMITS.maxCollectorReadings;
          for (let i = 0; i < excess; i++) readingsRejected++;
          return list.slice(0, PRESSURE_LIMITS.maxCollectorReadings)
            .map(recordReading)
            .filter(Boolean);
        }
        return list.map(recordReading).filter(Boolean);
      } catch {
        collectorFailures++;
        unknownSinceCollectorFail = true;
        const transition = applyState('UNKNOWN', null);
        return { error: true, state: currentState, transition };
      }
    }

    /**
     * Evaluate current pressure from latest readings. If a collector is
     * configured, runs it first (fail-safe). Returns frozen snapshot.
     */
    function evaluate() {
      try {
        let collected = null;
        if (collector) collected = collect();
        const state = recomputeState();
        if (state !== currentState) applyState(state, null);
        const worstDim = Object.keys(latest)
          .filter(d => RESOURCE_DIMENSIONS.includes(d))
          .map(d => ({ dimension: d, level: classifyValue(d, latest[d], thresholds) }))
          .sort((a, b) => clampStateRank(b.level) - clampStateRank(a.level))[0] ?? null;
        return Object.freeze({
          contractVersion: RESOURCE_PRESSURE_CONTRACT.version,
          state,
          degradation: DEGRADATION_LEVELS[state] ?? 0,
          worst: worstDim,
          transition: lastTransition,
          collectorFailure: collected !== null && collected.error === true,
          historyCount,
        });
      } catch {
        return Object.freeze({
          contractVersion: RESOURCE_PRESSURE_CONTRACT.version,
          state: 'UNKNOWN',
          degradation: 0,
          worst: null,
          transition: lastTransition,
          collectorFailure: true,
          historyCount,
        });
      }
    }

    /** Bounded snapshot of the reading ring (oldest → newest). */
    function historySnapshot() {
      const out = [];
      for (let i = 0; i < historyCount; i++) {
        out.push(history[(historyHead + i) % historySize]);
      }
      return Object.freeze(out);
    }

    /** Latest provenance-aware value per dimension (null if never seen). */
    function latestSnapshot() {
      const out = {};
      for (const dim of RESOURCE_DIMENSIONS) {
        out[dim] = latest[dim] === undefined ? null : Object.freeze({
          value: latest[dim],
          provenance: latestProvenance[dim] ?? 'OBSERVED',
          level: classifyValue(dim, latest[dim], thresholds),
        });
      }
      return Object.freeze(out);
    }

    function setThresholds(policy) {
      const v = validateThresholds(policy);
      if (!v.ok) return false;
      thresholds = v.thresholds;
      // Re-evaluate state under new policy (still bounded, no new readings).
      const next = recomputeState();
      applyState(next, null);
      return true;
    }

    function stats() {
      return Object.freeze({
        contractVersion: RESOURCE_PRESSURE_CONTRACT.version,
        state: currentState,
        degradation: DEGRADATION_LEVELS[currentState] ?? 0,
        peakDegradation,
        transitions,
        lastTransition,
        readingsAccepted,
        readingsRejected,
        collectorFailures,
        historyCount,
        historySize,
        historyOverflowDrops,
        dimensionsTracked: Object.keys(latest).length,
      });
    }

    function reset() {
      history.fill(null);
      historyHead = 0;
      historyCount = 0;
      for (const k of Object.keys(latest)) delete latest[k];
      for (const k of Object.keys(latestProvenance)) delete latestProvenance[k];
      currentState = 'NORMAL';
      lastTransition = null;
      collectorFailures = 0;
      readingsAccepted = 0;
      readingsRejected = 0;
      historyOverflowDrops = 0;
      transitions = 0;
      peakDegradation = 0;
      unknownSinceCollectorFail = false;
    }

    return Object.freeze({
      contract: RESOURCE_PRESSURE_CONTRACT,
      limits: PRESSURE_LIMITS,
      thresholds,
      recordReading,
      collect,
      evaluate,
      historySnapshot,
      latestSnapshot,
      setThresholds,
      stats,
      reset,
    });
  } catch {
    return null;
  }
}
