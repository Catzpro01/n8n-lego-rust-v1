/** P9.17 low-resource observability mode. Product owner agent-6;
 * implementation delegate Agent 4 (Issue #101). Mode is auto- or explicitly
 * activatable; telemetry degrades in a defined priority order; P9 resource
 * budgets are enforced; hysteresis/cooldown prevents thrashing; critical/
 * security evidence is never shed; recovery is first-class; workflow A/B
 * correctness is a pure function of business input (this module only decides
 * telemetry admission — it never mutates workflow results). No I/O, no clock
 * (now is an argument), no workflow/execution import.
 */
import { containsSecretShape } from './telemetry-redaction.mjs';

export const LOWRES_CONTRACT = Object.freeze({
  id: 'observability.low-resource-mode', version: '1.0.0', owner: 'agent-6',
});
export const LOWRES_SCHEMA_VERSION = '1.0.0';

/** Mode states. NORMAL ↔ LOW_RESOURCE with hysteresis + cooldown. */
export const LOWRES_MODES = Object.freeze(['NORMAL', 'LOW_RESOURCE']);

/** Defined degradation order: first shed → last shed (critical/security last). */
export const LOWRES_DEGRADE_ORDER = Object.freeze([
  'debug', 'verbose', 'sampled_metrics', 'traces', 'logs', 'diagnostics',
  'audit_security',
]);
/** What each degrade step turns off (observable policy). */
export const LOWRES_STEP_EFFECTS = Object.freeze({
  debug: 'drop-debug-channels',
  verbose: 'drop-verbose-events',
  sampled_metrics: 'metrics-to-counter-only',
  traces: 'drop-traces',
  logs: 'logs-to-error-only',
  diagnostics: 'diagnostics-to-failure-only',
  audit_security: 'never-shed',
});

export const LOWRES_PRIORITIES = Object.freeze([
  'P0', 'P1', 'P2', 'P3', 'P4',
]);
const CHAN_RANK = Object.freeze({
  audit_security: 0, diagnostics: 1, logs: 2, traces: 3,
  sampled_metrics: 4, verbose: 5, debug: 6,
});
const SIGNAL_CHANNEL = Object.freeze({
  security: 'audit_security', audit: 'audit_security',
  diagnostic: 'diagnostics', log: 'logs', trace: 'traces',
  metric: 'sampled_metrics', verbose: 'verbose', debug: 'debug',
});

export const LOWRES_LIMITS = Object.freeze({
  identifierBytes: 128,
  minByteBudget: 1024,
  maxByteBudget: 64 * 1024 * 1024,
  minCpuBudgetPct: 1,
  maxCpuBudgetPct: 100,
  minCooldownMs: 0,
  maxCooldownMs: 3_600_000,
  defaultCooldownMs: 5_000,
  minEnterThresholdPct: 1,
  maxEnterThresholdPct: 100,
  minExitThresholdPct: 1,
  maxExitThresholdPct: 100,
  maxRecords: 65536,
  recordBytesMin: 1,
  recordBytesMax: 1_048_576,
});

export const LOWRES_NOTES = Object.freeze([
  'auto-or-explicit-activation',
  'defined-degrade-order',
  'budgets-enforced',
  'hysteresis-cooldown',
  'critical-security-protected',
  'recovery-tested',
  'workflow-ab-stable',
]);

const SIGNALS = Object.freeze(['security', 'audit', 'diagnostic', 'log', 'trace', 'metric', 'verbose', 'debug']);
const CONFIG_KEYS = Object.freeze([
  'byteBudget', 'cpuBudgetPct', 'enterThresholdPct', 'exitThresholdPct',
  'cooldownMs', 'mode',
]);
const RECORD_KEYS = Object.freeze(['id', 'channel', 'bytes', 'signal', 'priority']);
const SAMPLE_KEYS = Object.freeze(['memoryUsedBytes', 'cpuUsedPct', 'explicit', 'now']);

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
 * Create a low-resource controller. Config:
 *  byteBudget, cpuBudgetPct (enforced budgets),
 *  enter/exitThresholdPct (hysteresis band),
 *  cooldownMs (anti-thrash), mode (initial).
 * Fail closed → null.
 */
export function createLowResourceController(config = {}) {
  if (!isPlain(config)) return null;
  if (Reflect.ownKeys(config).some(k => !CONFIG_KEYS.includes(k))) return null;

  const byteBudget = config.byteBudget === undefined
    ? 8 * 1024 * 1024 : config.byteBudget;
  if (!Number.isSafeInteger(byteBudget) || byteBudget < LOWRES_LIMITS.minByteBudget ||
      byteBudget > LOWRES_LIMITS.maxByteBudget) return null;

  const cpuBudgetPct = config.cpuBudgetPct === undefined ? 50 : config.cpuBudgetPct;
  if (!Number.isSafeInteger(cpuBudgetPct) || cpuBudgetPct < LOWRES_LIMITS.minCpuBudgetPct ||
      cpuBudgetPct > LOWRES_LIMITS.maxCpuBudgetPct) return null;

  const enterThresholdPct = config.enterThresholdPct === undefined ? 80 : config.enterThresholdPct;
  const exitThresholdPct = config.exitThresholdPct === undefined ? 50 : config.exitThresholdPct;
  for (const v of [enterThresholdPct, exitThresholdPct]) {
    if (!Number.isSafeInteger(v) || v < LOWRES_LIMITS.minEnterThresholdPct ||
        v > LOWRES_LIMITS.maxEnterThresholdPct) return null;
  }
  // Hysteresis: exit must be strictly below enter (prevents oscillation)
  if (exitThresholdPct >= enterThresholdPct) return null;

  const cooldownMs = config.cooldownMs === undefined
    ? LOWRES_LIMITS.defaultCooldownMs : config.cooldownMs;
  if (!Number.isSafeInteger(cooldownMs) || cooldownMs < LOWRES_LIMITS.minCooldownMs ||
      cooldownMs > LOWRES_LIMITS.maxCooldownMs) return null;

  const mode = config.mode === undefined ? 'NORMAL' : config.mode;
  if (!LOWRES_MODES.includes(mode)) return null;

  const state = {
    mode,
    lastTransitionAt: mode === 'LOW_RESOURCE' ? 0 : null,
    bytes: 0,
    records: new Map(),
    degradeStep: mode === 'LOW_RESOURCE' ? LOWRES_DEGRADE_ORDER.length : 0,
    counters: {
      admitted: 0, shed: 0, protected: 0,
      entered: 0, recovered: 0, thrashBlocked: 0,
      budgetByteEnforced: 0, budgetCpuEnforced: 0,
    },
    memoryUsedBytes: 0,
    cpuUsedPct: 0,
  };

  function inCooldown(now) {
    if (state.lastTransitionAt === null) return false;
    return now - state.lastTransitionAt < cooldownMs;
  }

  function pressurePct() {
    const memPct = Math.floor((state.memoryUsedBytes / byteBudget) * 100);
    return Math.max(memPct, state.cpuUsedPct);
  }

  /**
   * Observe a resource sample and (maybe) transition mode.
   * sample: { memoryUsedBytes?, cpuUsedPct?, explicit?: 'NORMAL'|'LOW_RESOURCE', now }
   * Auto: enter LOW_RESOURCE when pressure ≥ enter; recover when pressure ≤ exit
   * and cooldown elapsed. Explicit mode change also respects cooldown except
   * first transition. Returns frozen transition report.
   */
  function observe(sample) {
    if (!isPlain(sample)) return err('lowres.invalid_sample', 'sample must be an object');
    if (Reflect.ownKeys(sample).some(k => !SAMPLE_KEYS.includes(k))) {
      return err('lowres.invalid_sample', 'unknown sample field');
    }
    if (!Number.isSafeInteger(sample.now) || sample.now < 0) {
      return err('lowres.invalid_sample', 'now must be a non-negative integer');
    }
    if (containsSecretShape(sample)) return err('lowres.invalid_sample', 'secret-shaped sample');
    const now = sample.now;

    if (sample.memoryUsedBytes !== undefined) {
      if (!Number.isSafeInteger(sample.memoryUsedBytes) || sample.memoryUsedBytes < 0) {
        return err('lowres.invalid_sample', 'memoryUsedBytes invalid');
      }
      state.memoryUsedBytes = sample.memoryUsedBytes;
    }
    if (sample.cpuUsedPct !== undefined) {
      if (typeof sample.cpuUsedPct !== 'number' || !Number.isFinite(sample.cpuUsedPct) ||
          sample.cpuUsedPct < 0 || sample.cpuUsedPct > 200) {
        return err('lowres.invalid_sample', 'cpuUsedPct invalid');
      }
      state.cpuUsedPct = sample.cpuUsedPct;
    }

    const before = state.mode;
    let reason = null;

    if (sample.explicit !== undefined) {
      if (!LOWRES_MODES.includes(sample.explicit)) {
        return err('lowres.invalid_sample', 'explicit mode invalid');
      }
      if (sample.explicit !== state.mode) {
        if (state.lastTransitionAt !== null && inCooldown(now)) {
          state.counters.thrashBlocked++;
          return Object.freeze({
            ok: true,
            transition: Object.freeze({
              changed: false, from: state.mode, to: state.mode,
              reason: 'cooldown', thrashBlocked: true, now, pressurePct: pressurePct(),
            }),
          });
        }
        state.mode = sample.explicit;
        state.lastTransitionAt = now;
        if (state.mode === 'LOW_RESOURCE') {
          state.degradeStep = 0;
          state.counters.entered++;
          reason = 'explicit-enter';
        } else {
          state.degradeStep = LOWRES_DEGRADE_ORDER.length;
          state.counters.recovered++;
          reason = 'explicit-recover';
        }
      }
    } else {
      const p = pressurePct();
      if (state.mode === 'NORMAL' && p >= enterThresholdPct) {
        if (inCooldown(now)) {
          state.counters.thrashBlocked++;
          return Object.freeze({
            ok: true,
            transition: Object.freeze({
              changed: false, from: state.mode, to: state.mode,
              reason: 'cooldown', thrashBlocked: true, now, pressurePct: p,
            }),
          });
        }
        state.mode = 'LOW_RESOURCE';
        state.degradeStep = 0;
        state.lastTransitionAt = now;
        state.counters.entered++;
        reason = 'pressure-enter';
      } else if (state.mode === 'LOW_RESOURCE' && p <= exitThresholdPct) {
        if (inCooldown(now)) {
          state.counters.thrashBlocked++;
          return Object.freeze({
            ok: true,
            transition: Object.freeze({
              changed: false, from: state.mode, to: state.mode,
              reason: 'cooldown', thrashBlocked: true, now, pressurePct: p,
            }),
          });
        }
        state.mode = 'NORMAL';
        state.degradeStep = LOWRES_DEGRADE_ORDER.length;
        state.lastTransitionAt = now;
        state.counters.recovered++;
        reason = 'pressure-recover';
      } else {
        reason = 'steady';
      }
    }

    const changed = state.mode !== before;
    if (changed && state.mode === 'NORMAL') reason = reason || 'recover';
    return Object.freeze({
      ok: true,
      transition: Object.freeze({
        changed, from: before, to: state.mode, reason,
        thrashBlocked: false, now, pressurePct: pressurePct(),
      }),
    });
  }

  /**
   * Advance degrade one step (defined order). audit_security never drops.
   * Returns frozen report.
   */
  function degradeOneStep() {
    if (state.mode !== 'LOW_RESOURCE') {
      return err('lowres.not_low_resource', 'degrade only applies in LOW_RESOURCE');
    }
    if (state.degradeStep >= LOWRES_DEGRADE_ORDER.length - 1) {
      // already at audit_security floor
      return Object.freeze({
        ok: true, step: Object.freeze({
          channel: 'audit_security', effect: 'never-shed', exhausted: true,
          degradeStep: state.degradeStep,
        }),
      });
    }
    const channel = LOWRES_DEGRADE_ORDER[state.degradeStep];
    state.degradeStep += 1;
    return Object.freeze({
      ok: true,
      step: Object.freeze({
        channel,
        effect: LOWRES_STEP_EFFECTS[channel],
        exhausted: false,
        degradeStep: state.degradeStep,
      }),
    });
  }

  function shedChannel(channel) {
    if (channel === 'audit_security') return 0;
    let shed = 0;
    for (const [id, rec] of [...state.records]) {
      if (rec.channel === channel) {
        state.bytes -= rec.bytes;
        state.records.delete(id);
        shed++;
        state.counters.shed++;
      }
    }
    return shed;
  }

  /**
   * Admit a telemetry record under current mode + budgets.
   * Returns { ok, outcome: admitted|shed|protected|budget_shed } or error.
   */
  function admit(record) {
    if (!isPlain(record)) return err('lowres.invalid_record', 'record must be an object');
    if (Reflect.ownKeys(record).some(k => !RECORD_KEYS.includes(k))) {
      return err('lowres.invalid_record', 'unknown record field');
    }
    if (state.records.size >= LOWRES_LIMITS.maxRecords) {
      return err('lowres.busy', 'record cap reached');
    }
    const id = typeof record.id === 'string' && record.id.length > 0 &&
      record.id.length <= LOWRES_LIMITS.identifierBytes ? record.id : null;
    if (id === null || containsSecretShape(record.id)) {
      return err('lowres.invalid_record', 'id invalid');
    }
    const signal = record.signal === undefined
      ? ({ security: 'security', audit: 'audit' }[record.channel] || 'log')
      : record.signal;
    // channel preferred; derive from signal if channel omitted? RECORD_KEYS requires channel
    const channel = record.channel;
    if (!Object.prototype.hasOwnProperty.call(SIGNAL_CHANNEL, channel) &&
        !Object.prototype.hasOwnProperty.call(CHAN_RANK, channel)) {
      // allow channel keys from CHAN_RANK / SIGNAL_CHANNEL values
      if (!LOWRES_DEGRADE_ORDER.includes(channel)) {
        return err('lowres.invalid_record', 'channel invalid');
      }
    }
    if (!Number.isSafeInteger(record.bytes) || record.bytes < LOWRES_LIMITS.recordBytesMin ||
        record.bytes > LOWRES_LIMITS.recordBytesMax) {
      return err('lowres.invalid_record', 'bytes invalid');
    }
    void signal;
    if (containsSecretShape(record)) return err('lowres.invalid_record', 'secret-shaped record');
    if (state.records.has(id)) return err('lowres.duplicate', 'duplicate id');

    // Critical/security protected — never shed, always admit (even over budget → degraded floor)
    if (channel === 'audit_security') {
      state.records.set(id, Object.freeze({
        id, channel, bytes: record.bytes,
        priority: record.priority === undefined ? 'P0' : record.priority,
      }));
      state.bytes += record.bytes;
      state.counters.admitted++;
      state.counters.protected++;
      // Budget enforcement for telemetry (non-P0): still track; P0 may exceed → enforced flag
      if (state.bytes > byteBudget) state.counters.budgetByteEnforced++;
      return Object.freeze({ ok: true, outcome: 'protected' });
    }

    // LOW_RESOURCE: channels at or beyond degradeStep are shed (defined order)
    if (state.mode === 'LOW_RESOURCE') {
      const rank = CHAN_RANK[channel];
      if (rank === undefined) {
        return err('lowres.invalid_record', 'channel invalid');
      }
      // degradeStep counts how many non-protected channels have been disabled
      // rank 6 (debug) sheds first when degradeStep>=1, etc.
      // Map: step k disables channels with CHAN_RANK >= (6 - k + 1)? Simpler:
      // disabled if channel is in first `degradeStep` entries of DEGRADE_ORDER
      const disabled = LOWRES_DEGRADE_ORDER.slice(0, state.degradeStep)
        .includes(channel);
      if (disabled) {
        state.counters.shed++;
        return Object.freeze({ ok: true, outcome: 'shed', channel });
      }
    }

    // Byte budget enforcement (never corrupt: whole-record shed of this record)
    if (state.bytes + record.bytes > byteBudget) {
      state.counters.budgetByteEnforced++;
      state.counters.shed++;
      return Object.freeze({ ok: true, outcome: 'budget_shed' });
    }
    // CPU budget: if sample already over cpu budget, non-protected sheds
    if (state.cpuUsedPct >= cpuBudgetPct && channel !== 'audit_security') {
      state.counters.budgetCpuEnforced++;
      state.counters.shed++;
      return Object.freeze({ ok: true, outcome: 'budget_shed', budget: 'cpu' });
    }

    state.records.set(id, Object.freeze({
      id, channel, bytes: record.bytes,
      priority: record.priority === undefined ? 'P1' : record.priority,
    }));
    state.bytes += record.bytes;
    state.counters.admitted++;
    return Object.freeze({ ok: true, outcome: 'admitted' });
  }

  /**
   * Workflow A/B: business transform is independent of mode/telemetry.
   * This is the pure correctness anchor the low-resource mode must not touch.
   */
  function workflowAb(workflowInput, transform) {
    if (typeof transform !== 'function') {
      return err('lowres.invalid_transform', 'transform must be a function');
    }
    if (containsSecretShape(workflowInput)) {
      return err('lowres.invalid_input', 'secret-shaped workflow input');
    }
    let out;
    try {
      out = transform(workflowInput);
    } catch (e) {
      return err('lowres.transform_failed', 'transform threw');
    }
    return Object.freeze({
      ok: true,
      result: out,
      mode: state.mode,
      telemetryPolicy: Object.freeze({
        mode: state.mode,
        degradeStep: state.degradeStep,
        // Snapshot only — result itself is mode-independent by construction.
        note: 'result derived solely from workflowInput+transform',
      }),
    });
  }

  function snapshot() {
    const channelsOff = state.mode === 'LOW_RESOURCE'
      ? LOWRES_DEGRADE_ORDER.slice(0, state.degradeStep)
      : [];
    return Object.freeze({
      schemaVersion: LOWRES_SCHEMA_VERSION,
      contract: Object.freeze({ ...LOWRES_CONTRACT }),
      mode: state.mode,
      degradeStep: state.degradeStep,
      channelsOff: Object.freeze(channelsOff),
      budgets: Object.freeze({ byteBudget, cpuBudgetPct, enterThresholdPct, exitThresholdPct, cooldownMs }),
      usage: Object.freeze({ bytes: state.bytes, records: state.records.size, memoryUsedBytes: state.memoryUsedBytes, cpuUsedPct: state.cpuUsedPct }),
      counters: Object.freeze({ ...state.counters }),
      pressurePct: pressurePct(),
      lastTransitionAt: state.lastTransitionAt,
    });
  }

  return Object.freeze({
    observe, degradeOneStep, admit, workflowAb, snapshot,
    stats: state.counters,
  });
}
