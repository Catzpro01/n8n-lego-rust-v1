/** P9.8 sampling + adaptive telemetry policy. Product owner agent-6;
 * implementation delegate Agent 4 (Issue #101). Modes: OFF, HEAD, TAIL,
 * ERROR_PRIORITY, LATENCY_PRIORITY, ADAPTIVE (RATE_LIMITED scoped out of
 * 1.0.0). Decisions are deterministic under a fixed policy/seed. The adaptive
 * controller has hard min/max bounds, decision-count hysteresis/cooldown (no
 * clock), and clamps on overload. Tail in-flight state is a preallocated ring
 * with a hard bound — overflow falls back to head sampling (never grows).
 * Sampling only ever reduces retained telemetry; it never allocates beyond the
 * configured in-flight ceiling, so workflow memory is not increased (budget
 * accounting = maxInFlight + fixed stats, observable via stats()). No I/O, no
 * clock, no workflow import.
 */
export const SAMPLING_CONTRACT = Object.freeze({
  id: 'observability.telemetry-sampling', version: '1.0.0', owner: 'agent-6',
});
/** #101 DoD required modes. RATE_LIMITED is explicitly scoped out of 1.0.0. */
export const SAMPLING_MODES = Object.freeze([
  'OFF', 'HEAD', 'TAIL', 'ERROR_PRIORITY', 'LATENCY_PRIORITY', 'ADAPTIVE',
]);
export const SAMPLING_MODE_DESCRIPTIONS = Object.freeze({
  OFF: 'sampling disabled — every signal is kept',
  HEAD: 'deterministic early reduction before any expensive work',
  TAIL: 'decide after the whole trace/span summary, bounded in-flight',
  ERROR_PRIORITY: 'keep all errors; head-sample successful signals',
  LATENCY_PRIORITY: 'keep slow signals (>= slowMs); head-sample the rest',
  ADAPTIVE: 'bounded rate controller with hysteresis around a baseline',
});
export const SAMPLING_DECISIONS = Object.freeze(['keep', 'drop']);
export const SAMPLING_REASONS = Object.freeze([
  'mode_off', 'head_hash', 'tail_summary', 'tail_error', 'tail_latency',
  'error_priority', 'latency_priority', 'adaptive_rate', 'tail_overload_fallback',
  'invalid_signal',
]);
export const SAMPLING_LIMITS = Object.freeze({
  rateMin: 0, rateMax: 1,
  maxInFlightMin: 1, maxInFlightMax: 65536,
  seedMax: 2 ** 32 - 1,
  slowMsMin: 0, slowMsMax: 86_400_000,
  stepMin: 0.001, stepMax: 1,
  cooldownMin: 1, cooldownMax: 1_000_000,
});
const CONFIG_KEYS = Object.freeze([
  'mode', 'rate', 'seed', 'slowMs', 'baselineRate', 'minRate', 'maxRate',
  'upStep', 'downStep', 'cooldownDecisions', 'maxInFlight',
]);

function isPlain(value) {
  return value !== null && typeof value === 'object' &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function rateOf(x) {
  return typeof x === 'number' && Number.isFinite(x) &&
    x >= SAMPLING_LIMITS.rateMin && x <= SAMPLING_LIMITS.rateMax;
}
/** FNV-1a 32-bit → [0,1). Pure, deterministic, no clock/Math.random. */
function hashUnit(seed, key) {
  let h = seed >>> 0;
  const text = String(key);
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  // final avalanche — force unsigned after every ^= (int32 may go negative)
  h = (h ^ (h >>> 16)) >>> 0;
  h = Math.imul(h, 0x7feb352d) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;
  h = Math.imul(h, 0x846ca68b) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4294967296;
}
function decideHead(rate, seed, key) {
  return hashUnit(seed, key) < rate;
}

/**
 * Create a sampler. Returns null on invalid config (never a half-policy).
 * mode is required among SAMPLING_MODES; rate/bounds validated per mode.
 */
export function createTelemetrySampler(config) {
  try {
    if (!isPlain(config)) return null;
    const keys = Reflect.ownKeys(config);
    if (keys.some(key => !CONFIG_KEYS.includes(key))) return null;
    const mode = config.mode;
    if (typeof mode !== 'string' || !SAMPLING_MODES.includes(mode)) return null;

    const seed = config.seed === undefined ? 1 : config.seed;
    if (!Number.isSafeInteger(seed) || seed < 0 || seed > SAMPLING_LIMITS.seedMax) return null;

    const rate = config.rate === undefined ? 1 : config.rate;
    if (!rateOf(rate)) return null;

    const slowMs = config.slowMs === undefined ? 1000 : config.slowMs;
    if (!Number.isFinite(slowMs) || slowMs < SAMPLING_LIMITS.slowMsMin ||
        slowMs > SAMPLING_LIMITS.slowMsMax) return null;

    const maxInFlight = config.maxInFlight === undefined ? 1024 : config.maxInFlight;
    if (!Number.isSafeInteger(maxInFlight) ||
        maxInFlight < SAMPLING_LIMITS.maxInFlightMin ||
        maxInFlight > SAMPLING_LIMITS.maxInFlightMax) return null;

    // Adaptive bounds only matter for ADAPTIVE; other modes ignore defaults
    // (still validated when provided so a bad adaptive config fails closed).
    const minRate = config.minRate === undefined ? 0.01 : config.minRate;
    const maxRate = config.maxRate === undefined ? 1 : config.maxRate;
    const baselineRate = config.baselineRate === undefined ? rate : config.baselineRate;
    const upStep = config.upStep === undefined ? 0.25 : config.upStep;
    const downStep = config.downStep === undefined ? 0.05 : config.downStep;
    const cooldownDecisions = config.cooldownDecisions === undefined ? 16 : config.cooldownDecisions;
    if (!rateOf(minRate) || !rateOf(maxRate) || !rateOf(baselineRate)) return null;
    if (minRate > maxRate) return null;
    if (mode === 'ADAPTIVE') {
      if (baselineRate < minRate || baselineRate > maxRate) return null;
    } else if (config.baselineRate !== undefined &&
               (baselineRate < minRate || baselineRate > maxRate)) {
      return null;
    }
    if (!rateOf(upStep) || upStep < SAMPLING_LIMITS.stepMin) return null;
    if (!rateOf(downStep) || downStep < SAMPLING_LIMITS.stepMin) return null;
    if (!Number.isSafeInteger(cooldownDecisions) ||
        cooldownDecisions < SAMPLING_LIMITS.cooldownMin ||
        cooldownDecisions > SAMPLING_LIMITS.cooldownMax) return null;

    // Tail in-flight: preallocated fixed array — memory ceiling is policy.
    const inFlightSlots = new Array(maxInFlight).fill(null);
    let inFlightCount = 0;
    let decisionIndex = 0;
    let currentRate = baselineRate;
    let decisionsSinceChange = 0;
    let overloadClamps = 0;

    const counts = {
      keep: 0, drop: 0, kept: 0,
      keepOff: 0, keepHead: 0, keepTail: 0, keepErrorPriority: 0,
      keepLatencyPriority: 0, keepAdaptive: 0, keepOverloadFallback: 0,
      dropHead: 0, dropTail: 0, dropErrorPriority: 0,
      dropLatencyPriority: 0, dropAdaptive: 0, dropInvalid: 0,
      tailBegin: 0, tailEnd: 0, tailOverloadFallback: 0,
      adaptiveRaise: 0, adaptiveDecay: 0, adaptiveClampMin: 0, adaptiveClampMax: 0,
      peakInFlight: 0,
    };

    function record(decision, reason) {
      if (decision === 'keep') counts.keep++;
      else counts.drop++;
      switch (reason) {
        case 'mode_off': counts.keepOff++; break;
        case 'head_hash':
          decision === 'keep' ? counts.keepHead++ : counts.dropHead++; break;
        case 'tail_summary': case 'tail_error': case 'tail_latency':
          decision === 'keep' ? counts.keepTail++ : counts.dropTail++; break;
        case 'error_priority':
          decision === 'keep' ? counts.keepErrorPriority++ : counts.dropErrorPriority++; break;
        case 'latency_priority':
          decision === 'keep' ? counts.keepLatencyPriority++ : counts.dropLatencyPriority++; break;
        case 'adaptive_rate':
          decision === 'keep' ? counts.keepAdaptive++ : counts.dropAdaptive++; break;
        case 'tail_overload_fallback':
          counts.keepOverloadFallback++;
          counts.tailOverloadFallback++;
          if (decision === 'drop') counts.dropHead++;
          break;
        case 'invalid_signal': counts.dropInvalid++; break;
        default: break;
      }
      return decision;
    }

    function freezeDecision(decision, reason) {
      return Object.freeze({
        contractVersion: SAMPLING_CONTRACT.version,
        mode,
        decision,
        reason,
        rate: mode === 'ADAPTIVE' ? currentRate : rate,
        decisionIndex,
      });
    }

    /** Adaptive rate step: raise on error, decay on healthy after cooldown.
     * Any error restarts cooldown so healthy decay cannot fire mid-outage. */
    function adapt(isError) {
      if (isError) {
        decisionsSinceChange = 0;
        if (currentRate < maxRate) {
          currentRate = Math.min(maxRate, currentRate + upStep);
          counts.adaptiveRaise++;
          if (currentRate >= maxRate) counts.adaptiveClampMax++;
        } else {
          counts.adaptiveClampMax++;
        }
      } else {
        decisionsSinceChange++;
        if (currentRate > baselineRate) {
          if (decisionsSinceChange >= cooldownDecisions) {
            currentRate = Math.max(baselineRate, currentRate - downStep);
            decisionsSinceChange = 0;
            counts.adaptiveDecay++;
            if (currentRate <= minRate) counts.adaptiveClampMin++;
          }
        } else if (currentRate < minRate) {
          currentRate = minRate;
          counts.adaptiveClampMin++;
        }
      }
      if (currentRate < minRate) { currentRate = minRate; counts.adaptiveClampMin++; }
      if (currentRate > maxRate) { currentRate = maxRate; counts.adaptiveClampMax++; }
    }

    function headKeep(key) {
      return decideHead(rate, seed, key);
    }

    function decide(signal) {
      decisionIndex++;
      try {
        if (signal !== undefined && signal !== null && !isPlain(signal) &&
            typeof signal !== 'string') {
          record('drop', 'invalid_signal');
          return freezeDecision('drop', 'invalid_signal');
        }
        const bag = isPlain(signal) ? signal : { key: signal };
        const isError = bag.isError === true ||
          (typeof bag.outcome === 'string' && /^(?:error|failed|failure|reject(?:ed)?)$/i.test(bag.outcome));
        const durationMs = Number.isFinite(bag.durationMs) ? bag.durationMs : 0;
        const key = typeof bag.key === 'string' && bag.key.length > 0
          ? bag.key
          : `${decisionIndex}`;

        switch (mode) {
          case 'OFF': {
            record('keep', 'mode_off');
            return freezeDecision('keep', 'mode_off');
          }
          case 'HEAD': {
            const keep = headKeep(key);
            record(keep ? 'keep' : 'drop', 'head_hash');
            return freezeDecision(keep ? 'keep' : 'drop', 'head_hash');
          }
          case 'ERROR_PRIORITY': {
            if (isError) {
              record('keep', 'error_priority');
              return freezeDecision('keep', 'error_priority');
            }
            const keep = headKeep(key);
            record(keep ? 'keep' : 'drop', 'error_priority');
            return freezeDecision(keep ? 'keep' : 'drop', 'error_priority');
          }
          case 'LATENCY_PRIORITY': {
            if (durationMs >= slowMs) {
              record('keep', 'latency_priority');
              return freezeDecision('keep', 'latency_priority');
            }
            const keep = headKeep(key);
            record(keep ? 'keep' : 'drop', 'latency_priority');
            return freezeDecision(keep ? 'keep' : 'drop', 'latency_priority');
          }
          case 'ADAPTIVE': {
            adapt(isError);
            const keep = isError || decideHead(currentRate, seed, key);
            const reason = keep && isError ? 'error_priority' : 'adaptive_rate';
            record(keep ? 'keep' : 'drop', reason);
            return freezeDecision(keep ? 'keep' : 'drop', reason);
          }
          case 'TAIL': {
            const keep = headKeep(key);
            record(keep ? 'keep' : 'drop', 'head_hash');
            return freezeDecision(keep ? 'keep' : 'drop', 'head_hash');
          }
          default: {
            record('drop', 'invalid_signal');
            return freezeDecision('drop', 'invalid_signal');
          }
        }
      } catch {
        record('drop', 'invalid_signal');
        return freezeDecision('drop', 'invalid_signal');
      }
    }

    function begin(traceKey) {
      decisionIndex++;
      const key = typeof traceKey === 'string' && traceKey.length > 0
        ? traceKey
        : `trace-${decisionIndex}`;
      counts.tailBegin++;
      if (mode !== 'TAIL') {
        return Object.freeze({ accepted: true, key, fallback: false, mode });
      }
      if (inFlightCount >= maxInFlight) {
        const keep = headKeep(key);
        record(keep ? 'keep' : 'drop', 'tail_overload_fallback');
        return Object.freeze({ accepted: false, key, fallback: true, headKeep: keep });
      }
      let slot = -1;
      for (let i = 0; i < maxInFlight; i++) {
        if (inFlightSlots[i] === null) { slot = i; break; }
      }
      if (slot < 0) {
        const keep = headKeep(key);
        record(keep ? 'keep' : 'drop', 'tail_overload_fallback');
        return Object.freeze({ accepted: false, key, fallback: true, headKeep: keep });
      }
      inFlightSlots[slot] = key;
      inFlightCount++;
      if (inFlightCount > counts.peakInFlight) counts.peakInFlight = inFlightCount;
      return Object.freeze({ accepted: true, key, fallback: false, slot, mode });
    }

    function end(handle, summary) {
      decisionIndex++;
      try {
        if (!isPlain(handle) || typeof handle.key !== 'string') {
          record('drop', 'invalid_signal');
          return freezeDecision('drop', 'invalid_signal');
        }
        if (Number.isSafeInteger(handle.slot) && handle.slot >= 0 &&
            handle.slot < maxInFlight && inFlightSlots[handle.slot] === handle.key) {
          inFlightSlots[handle.slot] = null;
          inFlightCount = Math.max(0, inFlightCount - 1);
        }
        counts.tailEnd++;
        if (handle.fallback === true) {
          const decision = handle.headKeep ? 'keep' : 'drop';
          return freezeDecision(decision, 'tail_overload_fallback');
        }
        const bag = isPlain(summary) ? summary : {};
        const isError = bag.isError === true ||
          (typeof bag.outcome === 'string' && /^(?:error|failed|failure|reject(?:ed)?)$/i.test(bag.outcome));
        const durationMs = Number.isFinite(bag.durationMs) ? bag.durationMs : 0;
        if (mode !== 'TAIL') {
          return freezeDecision('keep', 'mode_off');
        }
        if (isError) {
          record('keep', 'tail_error');
          return freezeDecision('keep', 'tail_error');
        }
        if (durationMs >= slowMs) {
          record('keep', 'tail_latency');
          return freezeDecision('keep', 'tail_latency');
        }
        const keep = decideHead(rate, seed, handle.key);
        record(keep ? 'keep' : 'drop', 'tail_summary');
        return freezeDecision(keep ? 'keep' : 'drop', 'tail_summary');
      } catch {
        record('drop', 'invalid_signal');
        return freezeDecision('drop', 'invalid_signal');
      }
    }

    function stats() {
      return Object.freeze({
        contractVersion: SAMPLING_CONTRACT.version,
        mode,
        rate,
        seed,
        currentRate: mode === 'ADAPTIVE' ? currentRate : rate,
        baselineRate: mode === 'ADAPTIVE' ? baselineRate : rate,
        minRate: mode === 'ADAPTIVE' ? minRate : rate,
        maxRate: mode === 'ADAPTIVE' ? maxRate : rate,
        maxInFlight,
        inFlight: inFlightCount,
        overloadClamps,
        decisionsSinceChange,
        counts: Object.freeze({ ...counts, kept: counts.keep }),
      });
    }

    function reset() {
      inFlightSlots.fill(null);
      inFlightCount = 0;
      decisionIndex = 0;
      currentRate = baselineRate;
      decisionsSinceChange = 0;
      overloadClamps = 0;
      for (const k of Object.keys(counts)) counts[k] = 0;
    }

    return Object.freeze({
      contract: SAMPLING_CONTRACT,
      mode,
      limits: SAMPLING_LIMITS,
      decide,
      begin,
      end,
      stats,
      reset,
    });
  } catch {
    return null;
  }
}
