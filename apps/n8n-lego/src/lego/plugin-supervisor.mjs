/**
 * Backend LEGO foundation — P2.27 plugin supervisor (lifecycle + quarantine).
 *
 * PUBLIC CONTRACT (`lego.plugin-runtime`, v0.7.0, owner: agent-1).
 *
 * Design §15 as a state machine with one non-negotiable property: **a broken
 * plugin is quarantined, never restarted forever.** The eight states and
 * their legal edges live in `PLUGIN_LIFECYCLE_TRANSITIONS`; every
 * `transition()` is checked against them (illegal edge ⇒
 * `lego.contract_violation` — the machine stays honest), and the ONLY way out
 * of `QUARANTINED` is the explicit operator path `releaseFromQuarantine()`
 * (automatic exits would defeat the point of quarantine).
 *
 * ```text
 * DISCOVERED → VALIDATING → STARTING ⇄ HEALTHY ⇄ DEGRADED → DRAINING → STOPPED
 *                 │            │         │           │          │
 *                 └────────────┴─────────┴───────────┴──────────┴→ QUARANTINED
 * STOPPED → STARTING (explicit restart) · QUARANTINED → DISCOVERED (operator only)
 * ```
 *
 * Crash handling (`reportCrash`): a crash in a running state restarts toward
 * `STARTING` while the consecutive-crash counter is below `crashLimit`;
 * reaching the limit forces `QUARANTINED` and emits `plugin.quarantined`.
 * A successful `HEALTHY` resets the counter — the limit measures a *loop*,
 * not the lifetime of a long-running plugin. Core never dies with the plugin:
 * this supervisor holds state only, spawns nothing, owns no process.
 *
 * Events (existing vocabulary only): `plugin.activated` (→HEALTHY),
 * `plugin.quarantined` (→QUARANTINED), `plugin.deactivated` (→STOPPED).
 */
import { PluginRuntimeError, PLUGIN_LIFECYCLE_STATES, PLUGIN_EVENT_TYPES } from './plugin-runtime.mjs';

/**
 * The complete legal-edge machine for design §15. `QUARANTINED` has no
 * outgoing edges here on purpose — only `releaseFromQuarantine` leaves it.
 */
export const PLUGIN_LIFECYCLE_TRANSITIONS = Object.freeze({
  DISCOVERED: Object.freeze(['VALIDATING']),
  VALIDATING: Object.freeze(['STARTING', 'QUARANTINED']),
  STARTING: Object.freeze(['HEALTHY', 'QUARANTINED', 'STARTING']),
  HEALTHY: Object.freeze(['STARTING', 'DEGRADED', 'DRAINING', 'QUARANTINED']),
  DEGRADED: Object.freeze(['HEALTHY', 'STARTING', 'DRAINING', 'QUARANTINED']),
  DRAINING: Object.freeze(['STOPPED', 'QUARANTINED']),
  STOPPED: Object.freeze(['STARTING']),
  QUARANTINED: Object.freeze([]),
});

/** States from which a crash report is meaningful (the plugin was running). */
export const PLUGIN_RUNNING_STATES = Object.freeze(['STARTING', 'HEALTHY', 'DEGRADED']);

const violation = (message, details) => new PluginRuntimeError('lego.contract_violation', message, { details });
const unavailable = (message, details) => new PluginRuntimeError('lego.unavailable', message, { details });

/**
 * Is `from → to` a legal lifecycle edge? Pure machine check — explainable,
 * like `foundation.canTransition` for activation states.
 */
export function canPluginTransition(from, to) {
  if (!PLUGIN_LIFECYCLE_STATES.includes(from)) {
    return Object.freeze({ allowed: false, reason: `unknown lifecycle state '${from}'` });
  }
  if (!PLUGIN_LIFECYCLE_STATES.includes(to)) {
    return Object.freeze({ allowed: false, reason: `unknown lifecycle state '${to}'` });
  }
  const edges = PLUGIN_LIFECYCLE_TRANSITIONS[from];
  return Object.freeze(
    edges.includes(to)
      ? { allowed: true, reason: `${from} -> ${to}` }
      : { allowed: false, reason: `${from} -> ${to} is not a legal transition (allowed: ${edges.join(', ') || 'none'})` },
  );
}

/**
 * Create a supervisor.
 *
 * @param {{ now?: () => number, crashLimit?: number, onEvent?: (type: string, detail: object) => void }} [options]
 */
export function createPluginSupervisor({ now = Date.now, crashLimit = 3, onEvent = null } = {}) {
  if (typeof now !== 'function') throw new TypeError('createPluginSupervisor requires now() to be a function');
  if (onEvent !== null && typeof onEvent !== 'function') {
    throw new TypeError('createPluginSupervisor onEvent must be a function or null');
  }
  if (!Number.isInteger(crashLimit) || crashLimit < 1 || crashLimit > 100) {
    throw new TypeError('createPluginSupervisor crashLimit must be an integer in [1, 100]');
  }

  /** @type {Map<string, { state: string, crashes: number, trackedAt: number, lastReason: string }>} */
  const plugins = new Map();

  const emit = (type, detail) => {
    if (onEvent) onEvent(type, detail);
  };

  const emitFor = (id, from, to, reason) => {
    if (to === 'HEALTHY' && from !== 'HEALTHY') emit('plugin.activated', { id, reason });
    if (to === 'QUARANTINED') emit('plugin.quarantined', { id, reason, crashes: plugins.get(id)?.crashes ?? 0 });
    if (to === 'STOPPED') emit('plugin.deactivated', { id, reason });
  };

  const require = (id) => {
    const record = plugins.get(id);
    if (!record) throw unavailable(`plugin '${id}' is not tracked by this supervisor`, { id });
    return record;
  };

  const track = (id) => {
    if (typeof id !== 'string' || id.length === 0 || id.length > 64) {
      throw violation('plugin id must be a string of length [1, 64]', { id });
    }
    if (plugins.has(id)) throw violation(`plugin '${id}' is already tracked`, { id });
    const record = { state: 'DISCOVERED', crashes: 0, trackedAt: now(), lastReason: 'tracked' };
    plugins.set(id, record);
    return Object.freeze({ ...record });
  };

  const transition = (id, to, { reason = 'operator transition' } = {}) => {
    const record = require(id);
    const verdict = canPluginTransition(record.state, to);
    if (!verdict.allowed) {
      throw violation(`illegal lifecycle transition for '${id}': ${verdict.reason}`, { id, from: record.state, to });
    }
    const from = record.state;
    record.state = to;
    record.lastReason = reason;
    if (to === 'HEALTHY') record.crashes = 0; // a healthy check ends the loop window
    if (to === 'QUARANTINED') record.quarantinedAt = now();
    emitFor(id, from, to, reason);
    return Object.freeze({ id, from, to, crashes: record.crashes, reason });
  };

  /**
   * A running plugin crashed: restart toward STARTING while under the limit,
   * quarantine at the limit. The ONLY auto-path into QUARANTINED.
   */
  const reportCrash = (id, { reason = 'plugin crash' } = {}) => {
    const record = require(id);
    if (!PLUGIN_RUNNING_STATES.includes(record.state)) {
      throw violation(`crash reported for '${id}' while not running (state ${record.state})`, {
        id,
        state: record.state,
      });
    }
    record.crashes += 1;
    if (record.crashes >= crashLimit) {
      const from = record.state;
      record.state = 'QUARANTINED';
      record.lastReason = `crash loop ${record.crashes}/${crashLimit}: ${reason}`;
      record.quarantinedAt = now();
      emitFor(id, from, 'QUARANTINED', record.lastReason);
      return Object.freeze({
        id,
        outcome: 'QUARANTINED',
        crashes: record.crashes,
        crashLimit,
        reason: record.lastReason,
      });
    }
    const from = record.state;
    record.state = 'STARTING'; // restart attempt — legal edge from every running state
    record.lastReason = `restart after crash ${record.crashes}/${crashLimit}: ${reason}`;
    return Object.freeze({ id, outcome: 'STARTING', crashes: record.crashes, crashLimit, reason: record.lastReason });
  };

  /**
   * Operator path out of quarantine (design §20 enable/disable) — back to
   * DISCOVERED for a fresh VALIDATING cycle. Never automatic.
   */
  const releaseFromQuarantine = (id, { reason = 'operator release' } = {}) => {
    const record = require(id);
    if (record.state !== 'QUARANTINED') {
      throw violation(`releaseFromQuarantine('${id}') requires QUARANTINED, found ${record.state}`, {
        id,
        state: record.state,
      });
    }
    const from = record.state;
    record.state = 'DISCOVERED';
    record.crashes = 0;
    record.lastReason = reason;
    delete record.quarantinedAt;
    emitFor(id, from, 'DISCOVERED', reason);
    return Object.freeze({ id, from, to: 'DISCOVERED', reason });
  };

  const state = (id) => require(id).state;
  const crashCount = (id) => require(id).crashes;

  const list = () =>
    Object.freeze(
      [...plugins.entries()].map(([id, record]) =>
        Object.freeze({ id, state: record.state, crashes: record.crashes, lastReason: record.lastReason }),
      ),
    );

  return Object.freeze({
    track,
    transition,
    reportCrash,
    releaseFromQuarantine,
    state,
    crashCount,
    list,
    crashLimit: Object.freeze({ value: crashLimit }),
  });
}
