/**
 * Backend LEGO foundation — P2.27 plugin resource budgets (the broker).
 *
 * PUBLIC CONTRACT (`lego.plugin-runtime`, v0.6.0, owner: agent-1).
 *
 * Design §14: the manifest *declares* limits, the runtime *enforces* them —
 * documentation alone is insufficient. This module is the enforcement half:
 * a per-plugin budget tracker over the declared `resourceLimits` (already
 * schema-validated by `plugin-manifest.mjs`), with conservative defaults for
 * anything the manifest left out — a plugin never gets "unlimited" by
 * omission (deny-by-default applies to resources too).
 *
 * What it honestly enforces in-process (no OS magic, no fake numbers):
 *  - **concurrency** — slot accounting; saturation is an explainable
 *    `lego.backpressure` verdict (retryable pressure, no hidden queue:
 *    the broker never buffers work — §63: no unbounded *or* implicit queues).
 *  - **outputBytes** — cumulative accounted output; overshoot throws
 *    `lego.contract_violation`, the same code family `resource-guard.mjs`
 *    (P3 execution budgets) uses for declared-budget breaches — one vocabulary.
 *  - **timeoutMs** — `checkDeadline(startedAt)` raises the published
 *    `lego.deadline_exceeded` (full deadline *propagation* composes in P2.27.8
 *    on top of `lego.envelope`).
 *  - cpuMillis / memoryMb / processCount / queueDepth are validated and
 *    *carried* as declared intent for admission explainability — claims of
 *    enforcing OS-level CPU/RAM from a JS module would be a lie, and the
 *    supervisor/locality slices (process isolation) are where those become
 *    enforceable.
 *
 * Rejections emit `plugin.budget-rejected` (metadata only).
 */
import { PluginRuntimeError } from './plugin-runtime.mjs';
import { PLUGIN_MANIFEST_BOUNDS, PLUGIN_RESOURCE_LIMIT_FIELDS } from './plugin-manifest.mjs';

/**
 * Conservative defaults for omitted limits — bounded, never unlimited (§63).
 * `queueDepth` is declared for admission context; this broker itself never
 * queues.
 */
export const PLUGIN_RESOURCE_DEFAULTS = Object.freeze({
  cpuMillis: 1_000,
  memoryMb: 512,
  concurrency: 4,
  queueDepth: 32,
  timeoutMs: 30_000,
  outputBytes: 1_048_576,
  processCount: 1,
});

const violation = (message, details) => new PluginRuntimeError('lego.contract_violation', message, { details });

function normalizeLimits(limits) {
  if (limits === undefined || limits === null) return { ...PLUGIN_RESOURCE_DEFAULTS };
  if (typeof limits !== 'object' || Array.isArray(limits)) throw violation('resourceLimits must be a plain object');
  const normalized = { ...PLUGIN_RESOURCE_DEFAULTS };
  for (const [key, value] of Object.entries(limits)) {
    if (!PLUGIN_RESOURCE_LIMIT_FIELDS.includes(key)) {
      throw violation(`resourceLimits declares unknown field '${key}'`, { key });
    }
    if (!Number.isInteger(value) || value < 0 || value > PLUGIN_MANIFEST_BOUNDS.resourceValueMax) {
      throw violation(`resourceLimits.${key} must be an integer in [0, ${PLUGIN_MANIFEST_BOUNDS.resourceValueMax}]`, {
        key,
        value,
      });
    }
    normalized[key] = value;
  }
  if (normalized.concurrency < 1) throw violation('resourceLimits.concurrency must be >= 1', { concurrency: normalized.concurrency });
  if (normalized.timeoutMs < 1) throw violation('resourceLimits.timeoutMs must be >= 1', { timeoutMs: normalized.timeoutMs });
  return normalized;
}

/**
 * Create a budget tracker for one plugin instance.
 *
 * @param {{
 *   pluginId?: string,
 *   limits?: object,
 *   now?: () => number,
 *   onEvent?: (type: string, detail: object) => void,
 * }} [options]
 */
export function createResourceBudget({ pluginId = '', limits = undefined, now = Date.now, onEvent = null } = {}) {
  if (typeof now !== 'function') throw new TypeError('createResourceBudget requires now() to be a function');
  if (onEvent !== null && typeof onEvent !== 'function') {
    throw new TypeError('createResourceBudget onEvent must be a function or null');
  }
  if (typeof pluginId !== 'string' || pluginId.length > PLUGIN_MANIFEST_BOUNDS.idMaxLength) {
    throw violation('pluginId must be a string of length <= idMaxLength', { pluginId });
  }
  const effective = normalizeLimits(limits);
  let active = 0;
  let outputBytes = 0;

  const emit = (type, detail) => {
    if (onEvent) onEvent(type, detail);
  };

  /**
   * Try to take a concurrency slot. Never buffers — the verdict is the queue.
   * @returns {{ admitted: boolean, code: string | null, reason: string, active: number, concurrency: number }}
   */
  const admit = () => {
    if (active < effective.concurrency) {
      active += 1;
      return Object.freeze({ admitted: true, code: null, reason: 'concurrency slot admitted', active, concurrency: effective.concurrency });
    }
    const reason = `concurrency budget exhausted (${active}/${effective.concurrency}) — rejected, not queued`;
    emit('plugin.budget-rejected', { pluginId, resource: 'concurrency', active, limit: effective.concurrency });
    return Object.freeze({
      admitted: false,
      code: 'lego.backpressure',
      reason,
      active,
      concurrency: effective.concurrency,
    });
  };

  /** Return a slot. Over-release is a caller bug and fails closed. */
  const release = () => {
    if (active <= 0) throw violation('release() called with no active slot', { pluginId, active });
    active -= 1;
    return active;
  };

  /**
   * Account produced output against the declared byte budget.
   * Overshoot throws `lego.contract_violation` (resource-guard family).
   */
  const accountOutput = (bytes) => {
    if (!Number.isInteger(bytes) || bytes < 0) {
      throw violation('output accounting requires a non-negative integer byte count', { bytes });
    }
    if (outputBytes + bytes > effective.outputBytes) {
      emit('plugin.budget-rejected', { pluginId, resource: 'outputBytes', used: outputBytes + bytes, limit: effective.outputBytes });
      throw violation(
        `declared outputBytes budget exceeded (${outputBytes + bytes} > ${effective.outputBytes})`,
        { pluginId, used: outputBytes + bytes, limit: effective.outputBytes },
      );
    }
    outputBytes += bytes;
    return outputBytes;
  };

  /**
   * Deadline check for work started at `startedAt` (ms on this budget's clock).
   * P2.27.8 composes this with envelope propagation.
   */
  const checkDeadline = (startedAt) => {
    if (typeof startedAt !== 'number' || !Number.isFinite(startedAt)) {
      throw violation('startedAt must be a finite number', { startedAt });
    }
    const elapsed = now() - startedAt;
    if (elapsed > effective.timeoutMs) {
      throw new PluginRuntimeError('lego.deadline_exceeded', `plugin budget timeout exceeded (${elapsed}ms > ${effective.timeoutMs}ms)`, {
        details: { pluginId, elapsedMs: elapsed, timeoutMs: effective.timeoutMs },
      });
    }
    return effective.timeoutMs - elapsed;
  };

  const stats = () =>
    Object.freeze({
      pluginId,
      active,
      outputBytes,
      limits: Object.freeze({ ...effective }),
    });

  return Object.freeze({ admit, release, accountOutput, checkDeadline, stats });
}
