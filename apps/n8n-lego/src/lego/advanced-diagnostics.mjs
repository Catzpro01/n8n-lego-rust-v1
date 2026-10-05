/** P9.21 advanced diagnostics / incident intelligence. Product owner agent-6;
 * implementation delegate Agent 4 (Issue #101). Selected features each carry
 * an explicit resource budget, kill-switch, fallback path, negative tests and
 * pressure behavior — and never alter workflow business semantics.
 * Security/audit logs are never deduplicated by default. Profiling/eBPF stay
 * optional (not selected). Tail sampling has bounded in-flight state with a
 * keep-on-overflow fallback. No I/O, no clock (now is an argument), no
 * workflow/execution import.
 */
import { containsSecretShape } from './telemetry-redaction.mjs';

export const ADVDIAG_CONTRACT = Object.freeze({
  id: 'observability.advanced-diagnostics', version: '1.0.0', owner: 'agent-6',
});
export const ADVDIAG_SCHEMA_VERSION = '1.0.0';

/** Features selected for implementation (approved subset of the P9.21 pool). */
export const ADVDIAG_FEATURES = Object.freeze([
  'fast_path', 'delta_telemetry', 'bounded_interning', 'burst_dedup',
  'tail_sampling', 'incident_burst_mode',
]);

/** Per-feature containment: budget key + fallback strategy. */
export const ADVDIAG_CONTAINMENT = Object.freeze({
  fast_path: Object.freeze({ budget: 'fastPathByteBudget', fallback: 'slow_path_admit' }),
  delta_telemetry: Object.freeze({ budget: 'deltaBaselineMax', fallback: 'absolute_snapshot' }),
  bounded_interning: Object.freeze({ budget: 'internMaxEntries', fallback: 'passthrough_string' }),
  burst_dedup: Object.freeze({ budget: 'dedupMaxEntries', fallback: 'admit_undeduped' }),
  tail_sampling: Object.freeze({ budget: 'maxInFlight', fallback: 'keep_on_overflow' }),
  incident_burst_mode: Object.freeze({ budget: 'burstThreshold', fallback: 'steady_mode' }),
});

/** Categories that must NEVER be burst-deduplicated by default. */
export const ADVDIAG_DEDUP_EXEMPT = Object.freeze(['audit', 'security', 'audit_security']);

export const ADVDIAG_LIMITS = Object.freeze({
  identifierBytes: 128,
  minFastPathByteBudget: 1024,
  maxFastPathByteBudget: 64 * 1024 * 1024,
  defaultFastPathByteBudget: 256 * 1024,
  minInternMax: 1,
  maxInternMax: 65536,
  defaultInternMax: 256,
  minDedupWindow: 1,
  maxDedupWindow: 600_000,
  defaultDedupWindow: 1000,
  minDedupMaxEntries: 1,
  maxDedupMaxEntries: 65536,
  defaultDedupMaxEntries: 1024,
  minInFlight: 1,
  maxInFlight: 65536,
  defaultInFlight: 64,
  minBurstThreshold: 1,
  maxBurstThreshold: 100000,
  defaultBurstThreshold: 50,
  minBurstCooldownMs: 0,
  maxBurstCooldownMs: 3_600_000,
  defaultBurstCooldownMs: 5000,
  minDeltaBaselines: 1,
  maxDeltaBaselines: 4096,
  defaultDeltaBaselines: 64,
  categoryBytes: 64,
  maxInternKeyBytes: 256,
});

export const ADVDIAG_NOTES = Object.freeze([
  'budget-per-feature',
  'kill-switch-per-feature',
  'fallback-per-feature',
  'negative-tests',
  'pressure-behavior',
  'workflow-ab-stable',
  'security-audit-never-deduped',
  'profiling-ebpf-optional-not-selected',
  'tail-sampling-bounded',
]);

const CONFIG_KEYS = Object.freeze([
  'fastPathByteBudget', 'internMaxEntries', 'dedupWindowMs', 'dedupMaxEntries',
  'maxInFlight', 'burstThreshold', 'burstCooldownMs', 'deltaBaselineMax',
  'disabled',
]);
const ADMIT_KEYS = Object.freeze(['id', 'category', 'bytes']);
const DELTA_KEYS = Object.freeze(['name', 'value']);
const DEDUP_KEYS = Object.freeze(['id', 'category', 'now']);
const IDENT = /^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/;

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

function validId(value, max = ADVDIAG_LIMITS.identifierBytes) {
  return typeof value === 'string' && value.length > 0 &&
    value.length <= max && IDENT.test(value) && !value.includes('://');
}

function inRange(v, min, max) {
  return Number.isSafeInteger(v) && v >= min && v <= max;
}

/**
 * Create the advanced-diagnostics controller. Config budgets + optional
 * `disabled: [feature, ...]` kill-switches at construction. Fail closed → null.
 */
export function createAdvancedDiagnostics(config = {}) {
  if (!isPlain(config)) return null;
  if (Reflect.ownKeys(config).some(k => !CONFIG_KEYS.includes(k))) return null;

  const fastPathByteBudget = config.fastPathByteBudget === undefined
    ? ADVDIAG_LIMITS.defaultFastPathByteBudget : config.fastPathByteBudget;
  if (!inRange(fastPathByteBudget, ADVDIAG_LIMITS.minFastPathByteBudget,
               ADVDIAG_LIMITS.maxFastPathByteBudget)) return null;

  const internMaxEntries = config.internMaxEntries === undefined
    ? ADVDIAG_LIMITS.defaultInternMax : config.internMaxEntries;
  if (!inRange(internMaxEntries, ADVDIAG_LIMITS.minInternMax,
               ADVDIAG_LIMITS.maxInternMax)) return null;

  const dedupWindowMs = config.dedupWindowMs === undefined
    ? ADVDIAG_LIMITS.defaultDedupWindow : config.dedupWindowMs;
  if (!inRange(dedupWindowMs, ADVDIAG_LIMITS.minDedupWindow,
               ADVDIAG_LIMITS.maxDedupWindow)) return null;

  const dedupMaxEntries = config.dedupMaxEntries === undefined
    ? ADVDIAG_LIMITS.defaultDedupMaxEntries : config.dedupMaxEntries;
  if (!inRange(dedupMaxEntries, ADVDIAG_LIMITS.minDedupMaxEntries,
               ADVDIAG_LIMITS.maxDedupMaxEntries)) return null;

  const maxInFlight = config.maxInFlight === undefined
    ? ADVDIAG_LIMITS.defaultInFlight : config.maxInFlight;
  if (!inRange(maxInFlight, ADVDIAG_LIMITS.minInFlight, ADVDIAG_LIMITS.maxInFlight)) return null;

  const burstThreshold = config.burstThreshold === undefined
    ? ADVDIAG_LIMITS.defaultBurstThreshold : config.burstThreshold;
  if (!inRange(burstThreshold, ADVDIAG_LIMITS.minBurstThreshold,
               ADVDIAG_LIMITS.maxBurstThreshold)) return null;

  const burstCooldownMs = config.burstCooldownMs === undefined
    ? ADVDIAG_LIMITS.defaultBurstCooldownMs : config.burstCooldownMs;
  if (!inRange(burstCooldownMs, ADVDIAG_LIMITS.minBurstCooldownMs,
               ADVDIAG_LIMITS.maxBurstCooldownMs)) return null;

  const deltaBaselineMax = config.deltaBaselineMax === undefined
    ? ADVDIAG_LIMITS.defaultDeltaBaselines : config.deltaBaselineMax;
  if (!inRange(deltaBaselineMax, ADVDIAG_LIMITS.minDeltaBaselines,
               ADVDIAG_LIMITS.maxDeltaBaselines)) return null;

  let disabled;
  if (config.disabled === undefined) {
    disabled = new Set();
  } else {
    if (!Array.isArray(config.disabled)) return null;
    disabled = new Set();
    for (const f of config.disabled) {
      if (!ADVDIAG_FEATURES.includes(f)) return null;
      disabled.add(f);
    }
  }

  const state = {
    disabled,
    fastPathBytes: 0,
    fastPathAdmits: 0,
    fastPathFallbacks: 0,
    fastPathDisabledAdmits: 0,
    interner: new Map(),
    internHits: 0,
    internMisses: 0,
    internEvictions: 0,
    internPassthrough: 0,
    baselines: new Map(),
    deltaOverflows: 0,
    dedupSeen: new Map(),
    dedupSuppressed: 0,
    dedupAdmitted: 0,
    dedupExempt: 0,
    dedupDisabled: 0,
    dedupPressureEvictions: 0,
    inFlight: new Map(),
    tailOverflowKeep: 0,
    tailDecidedKeep: 0,
    tailDecidedDrop: 0,
    tailDisabled: 0,
    burstMode: 'steady',
    burstEntered: 0,
    burstRecovered: 0,
    burstLastTransitionAt: null,
    windowEvents: [],
  };

  function on(feature) {
    return !state.disabled.has(feature);
  }

  function admitFast(record) {
    if (!isPlain(record) || Reflect.ownKeys(record).some(k => !ADMIT_KEYS.includes(k))) {
      return err('advdiag.invalid_record', 'record must be { id, category, bytes }');
    }
    if (!validId(record.id)) return err('advdiag.invalid_record', 'id invalid');
    if (record.category !== undefined &&
        (typeof record.category !== 'string' || record.category.length === 0 ||
         record.category.length > ADVDIAG_LIMITS.categoryBytes)) {
      return err('advdiag.invalid_record', 'category invalid');
    }
    if (!inRange(record.bytes, 1, 1_048_576)) {
      return err('advdiag.invalid_record', 'bytes invalid');
    }
    if (containsSecretShape(record)) {
      return err('advdiag.secret', 'secret-shaped record');
    }
    if (!on('fast_path')) {
      state.fastPathDisabledAdmits++;
      return Object.freeze({ ok: true, outcome: 'fallback', path: 'disabled', accepted: true });
    }
    if (state.fastPathBytes + record.bytes > fastPathByteBudget) {
      state.fastPathFallbacks++;
      return Object.freeze({
        ok: true, outcome: 'fallback', path: 'slow_path_admit', accepted: false, reason: 'budget',
      });
    }
    state.fastPathBytes += record.bytes;
    state.fastPathAdmits++;
    return Object.freeze({
      ok: true, outcome: 'admitted', path: 'fast', accepted: true, usage: state.fastPathBytes,
    });
  }

  function observeDelta(sample) {
    if (!isPlain(sample) || Reflect.ownKeys(sample).some(k => !DELTA_KEYS.includes(k))) {
      return err('advdiag.invalid_delta', 'sample must be { name, value }');
    }
    if (!validId(sample.name, 64)) return err('advdiag.invalid_delta', 'name invalid');
    if (typeof sample.value !== 'number' || !Number.isFinite(sample.value)) {
      return err('advdiag.invalid_delta', 'value invalid');
    }
    if (!on('delta_telemetry')) {
      return Object.freeze({
        ok: true, mode: 'absolute_fallback', delta: 0, value: sample.value, name: sample.name,
      });
    }
    const prev = state.baselines.get(sample.name);
    if (prev === undefined && state.baselines.size >= deltaBaselineMax) {
      state.deltaOverflows++;
      return err('advdiag.delta_overflow', 'baseline cap reached', { max: deltaBaselineMax });
    }
    const delta = prev === undefined ? sample.value : sample.value - prev;
    state.baselines.set(sample.name, sample.value);
    return Object.freeze({
      ok: true, mode: 'delta', name: sample.name,
      delta, value: sample.value, previous: prev === undefined ? null : prev,
    });
  }

  function absoluteSnapshot() {
    return Object.freeze({
      ok: true,
      mode: 'absolute_fallback',
      values: Object.freeze(Object.fromEntries(state.baselines)),
    });
  }

  function intern(key) {
    if (typeof key !== 'string' || key.length === 0 ||
        key.length > ADVDIAG_LIMITS.maxInternKeyBytes) {
      return err('advdiag.invalid_key', 'key invalid');
    }
    if (containsSecretShape(key)) return err('advdiag.secret', 'secret-shaped key');
    if (!on('bounded_interning')) {
      state.internPassthrough++;
      return Object.freeze({ ok: true, value: key, interned: false, path: 'passthrough' });
    }
    const hit = state.interner.get(key);
    if (hit !== undefined) {
      state.internHits++;
      state.interner.delete(key);
      state.interner.set(key, hit);
      return Object.freeze({ ok: true, value: hit, interned: true, path: 'hit' });
    }
    if (state.interner.size >= internMaxEntries) {
      const oldest = state.interner.keys().next().value;
      state.interner.delete(oldest);
      state.internEvictions++;
    }
    state.interner.set(key, key);
    state.internMisses++;
    return Object.freeze({ ok: true, value: key, interned: true, path: 'miss' });
  }

  function offerDedup(event) {
    if (!isPlain(event) || Reflect.ownKeys(event).some(k => !DEDUP_KEYS.includes(k))) {
      return err('advdiag.invalid_event', 'event must be { id, category, now }');
    }
    if (!validId(event.id)) return err('advdiag.invalid_event', 'id invalid');
    if (!Number.isSafeInteger(event.now) || event.now < 0) {
      return err('advdiag.invalid_event', 'now must be a non-negative integer');
    }
    const category = event.category === undefined ? 'log' : event.category;
    if (typeof category !== 'string' || category.length === 0 ||
        category.length > ADVDIAG_LIMITS.categoryBytes) {
      return err('advdiag.invalid_event', 'category invalid');
    }
    const exempt = ADVDIAG_DEDUP_EXEMPT.includes(category);
    if (!on('burst_dedup')) {
      state.dedupDisabled++;
      return Object.freeze({
        ok: true, outcome: 'admitted', deduped: false, path: 'disabled_fallback', exempt,
      });
    }
    if (exempt) {
      state.dedupExempt++;
      state.dedupAdmitted++;
      return Object.freeze({
        ok: true, outcome: 'admitted', deduped: false, path: 'exempt', exempt: true,
      });
    }
    const mapKey = category + ' ' + event.id;
    const last = state.dedupSeen.get(mapKey);
    if (last !== undefined && event.now - last < dedupWindowMs) {
      state.dedupSuppressed++;
      return Object.freeze({
        ok: true, outcome: 'suppressed', deduped: true, path: 'burst_dedup', exempt: false,
      });
    }
    if (state.dedupSeen.size >= dedupMaxEntries && last === undefined) {
      const oldest = state.dedupSeen.keys().next().value;
      state.dedupSeen.delete(oldest);
      state.dedupPressureEvictions++;
    }
    state.dedupSeen.set(mapKey, event.now);
    state.dedupAdmitted++;
    return Object.freeze({
      ok: true, outcome: 'admitted', deduped: false, path: 'burst_dedup', exempt: false,
    });
  }

  function tailBegin(id) {
    if (!validId(id)) return err('advdiag.invalid_id', 'id invalid');
    if (!on('tail_sampling')) {
      state.tailDisabled++;
      return Object.freeze({
        ok: true, decision: 'keep', path: 'disabled_fallback', inFlight: state.inFlight.size,
      });
    }
    if (state.inFlight.has(id)) {
      return err('advdiag.duplicate', 'sample already in flight');
    }
    if (state.inFlight.size >= maxInFlight) {
      state.tailOverflowKeep++;
      return Object.freeze({
        ok: true, decision: 'keep', path: 'keep_on_overflow',
        inFlight: state.inFlight.size, overflow: true,
      });
    }
    state.inFlight.set(id, { id });
    return Object.freeze({
      ok: true, decision: 'track', path: 'tail_sampling',
      inFlight: state.inFlight.size, overflow: false,
    });
  }

  function tailEnd(id, decision) {
    if (!validId(id)) return err('advdiag.invalid_id', 'id invalid');
    if (!['keep', 'drop'].includes(decision)) {
      return err('advdiag.invalid_decision', 'decision must be keep|drop');
    }
    if (!state.inFlight.has(id)) {
      return Object.freeze({
        ok: true, decision: 'keep', path: 'already_resolved', tracked: false,
      });
    }
    state.inFlight.delete(id);
    if (decision === 'keep') state.tailDecidedKeep++;
    else state.tailDecidedDrop++;
    return Object.freeze({ ok: true, decision, path: 'tail_sampling', tracked: true });
  }

  function observeBurst(now) {
    if (!Number.isSafeInteger(now) || now < 0) {
      return err('advdiag.invalid_now', 'now must be a non-negative integer');
    }
    if (!on('incident_burst_mode')) {
      return Object.freeze({
        ok: true, mode: 'steady', changed: false, path: 'disabled_fallback',
      });
    }
    state.windowEvents.push(now);
    while (state.windowEvents.length > 0 && now - state.windowEvents[0] > dedupWindowMs) {
      state.windowEvents.shift();
    }
    const hardCap = burstThreshold * 4;
    while (state.windowEvents.length > hardCap) {
      state.windowEvents.shift();
    }
    const before = state.burstMode;
    const inCooldown = state.burstLastTransitionAt !== null &&
      now - state.burstLastTransitionAt < burstCooldownMs;
    if (before === 'steady' && state.windowEvents.length >= burstThreshold) {
      if (inCooldown) {
        return Object.freeze({
          ok: true, mode: before, changed: false, count: state.windowEvents.length,
          path: 'cooldown',
        });
      }
      state.burstMode = 'burst';
      state.burstEntered++;
      state.burstLastTransitionAt = now;
      return Object.freeze({
        ok: true, mode: 'burst', changed: true, count: state.windowEvents.length,
        path: 'incident_burst_mode',
      });
    }
    if (before === 'burst' && !inCooldown &&
        state.windowEvents.length < Math.ceil(burstThreshold / 4)) {
      state.burstMode = 'steady';
      state.burstRecovered++;
      state.burstLastTransitionAt = now;
      return Object.freeze({
        ok: true, mode: 'steady', changed: true, count: state.windowEvents.length,
        path: 'incident_burst_mode',
      });
    }
    return Object.freeze({
      ok: true, mode: before, changed: false, count: state.windowEvents.length,
      path: 'incident_burst_mode',
    });
  }

  function setKillSwitch(feature, enabled) {
    if (!ADVDIAG_FEATURES.includes(feature)) {
      return err('advdiag.invalid_feature', 'unknown feature');
    }
    if (typeof enabled !== 'boolean') {
      return err('advdiag.invalid_switch', 'enabled must be boolean');
    }
    if (enabled) state.disabled.delete(feature);
    else state.disabled.add(feature);
    return Object.freeze({
      ok: true, feature, enabled, disabled: Object.freeze([...state.disabled].sort()),
    });
  }

  function workflowAb(workflowInput, transform) {
    if (typeof transform !== 'function') {
      return err('advdiag.invalid_transform', 'transform must be a function');
    }
    if (containsSecretShape(workflowInput)) {
      return err('advdiag.invalid_input', 'secret-shaped workflow input');
    }
    let result;
    try {
      result = transform(workflowInput);
    } catch {
      return err('advdiag.transform_failed', 'transform threw');
    }
    return Object.freeze({
      ok: true,
      result,
      telemetryFeatures: Object.freeze({
        disabled: Object.freeze([...state.disabled].sort()),
        burstMode: state.burstMode,
        note: 'result derived solely from workflowInput+transform',
      }),
    });
  }

  function snapshot() {
    return Object.freeze({
      schemaVersion: ADVDIAG_SCHEMA_VERSION,
      contract: Object.freeze({ ...ADVDIAG_CONTRACT }),
      features: Object.freeze([...ADVDIAG_FEATURES]),
      disabled: Object.freeze([...state.disabled].sort()),
      budgets: Object.freeze({
        fastPathByteBudget, internMaxEntries, dedupWindowMs, dedupMaxEntries,
        maxInFlight, burstThreshold, burstCooldownMs, deltaBaselineMax,
      }),
      usage: Object.freeze({
        fastPathBytes: state.fastPathBytes,
        internSize: state.interner.size,
        dedupSize: state.dedupSeen.size,
        inFlight: state.inFlight.size,
        baselines: state.baselines.size,
        windowEvents: state.windowEvents.length,
      }),
      counters: Object.freeze({
        fastPathAdmits: state.fastPathAdmits,
        fastPathFallbacks: state.fastPathFallbacks,
        fastPathDisabledAdmits: state.fastPathDisabledAdmits,
        internHits: state.internHits,
        internMisses: state.internMisses,
        internEvictions: state.internEvictions,
        internPassthrough: state.internPassthrough,
        deltaOverflows: state.deltaOverflows,
        dedupSuppressed: state.dedupSuppressed,
        dedupAdmitted: state.dedupAdmitted,
        dedupExempt: state.dedupExempt,
        dedupDisabled: state.dedupDisabled,
        dedupPressureEvictions: state.dedupPressureEvictions,
        tailOverflowKeep: state.tailOverflowKeep,
        tailDecidedKeep: state.tailDecidedKeep,
        tailDecidedDrop: state.tailDecidedDrop,
        tailDisabled: state.tailDisabled,
        burstEntered: state.burstEntered,
        burstRecovered: state.burstRecovered,
      }),
      burstMode: state.burstMode,
    });
  }

  return Object.freeze({
    admitFast, observeDelta, absoluteSnapshot, intern, offerDedup,
    tailBegin, tailEnd, observeBurst, setKillSwitch, workflowAb, snapshot,
  });
}
