/**
 * Backend LEGO foundation — P2.27 tiny plugin runtime core (the Core kernel).
 *
 * PUBLIC CONTRACT (`lego.plugin-runtime`, v0.1.0, owner: agent-1).
 *
 * WHAT THIS IS (dedicated Master Prompt P2.27, design §3): the *tiny* half of
 * "tiny Core, pluggable everything". Slice P2.27.1 ships the kernel primitives
 * every later slice composes onto — the canonical plugin vocabularies, core
 * identity + clock, a bounded event primitive, a health snapshot, and an
 * error type that can only carry codes `contracts/errors.contract.json` already
 * publishes (zero new error codes, Master Prompt §51).
 *
 * WHY A SEPARATE RUNTIME CORE instead of growing `foundation.mjs`:
 * `foundation.json` answers "what is a LEGO *as code*" — provenance trust
 * levels (core/verified/community/untrusted), capability tables, activation
 * states. This module answers "what is a *plugin instance at runtime*" —
 * trust CLASS (isolation posture: CORE/TRUSTED/ISOLATED/SANDBOXED), runtime
 * locality (where it executes), and instance lifecycle
 * (DISCOVERED→…→QUARANTINED). The two axes are deliberately distinct: a
 * reviewed (`verified`) plugin can still be REQUIRED to run ISOLATED, and an
 * ISOLATED_PROCESS locality says nothing about who published the code.
 * Policy (slice P2.27.3) is where the axes meet; neither vocabulary forks.
 *
 * WHAT THIS IS NOT: no workflow engine, no scheduler, no storage, no network,
 * no process spawn, no credential handling, no queues (the event buffer is a
 * bounded ring, not a queue), and no plugin loading yet — the registry lands
 * in P2.27.2, policy in P2.27.3, supervisor in P2.27.7. Core never owns
 * workflow, execution, memory, storage, AI, credentials, GitHub, workspace or
 * translation (Master Prompt §1 invariant).
 *
 * P2.27.2 wiring: the runtime *accepts* an injected registry (composed by the
 * caller — `createPluginRegistry` from `plugin-registry.mjs`) and reports its
 * size in `health().plugins`. The registry modules import THIS module, so the
 * dependency direction stays registry → runtime (leaf), never a cycle.
 */
import { readFileSync } from 'node:fs';

/** The published identity of this contract row. */
export const PLUGIN_RUNTIME_CONTRACT = 'lego.plugin-runtime';
export const PLUGIN_RUNTIME_CONTRACT_VERSION = '0.1.0';

/**
 * Trust CLASSES (design §8) — isolation posture, not provenance.
 * Exactly these four; `foundation.json` trust LEVELS stay canonical for
 * provenance and capability default grants.
 */
export const PLUGIN_TRUST_CLASSES = Object.freeze(['CORE', 'TRUSTED', 'ISOLATED', 'SANDBOXED']);

/**
 * Runtime localities (design §6) — where an instance executes.
 * Matches the locality strings the node registry already emits
 * (`IN_PROCESS`, `ISOLATED_PROCESS`, …) so there is one locality vocabulary.
 */
export const PLUGIN_RUNTIME_LOCALITIES = Object.freeze(['IN_PROCESS', 'WASM', 'ISOLATED_PROCESS', 'REMOTE']);

/**
 * Instance lifecycle (design §15). A crash loop may only reach QUARANTINED
 * through this machine — never an endless restart outside it.
 */
export const PLUGIN_LIFECYCLE_STATES = Object.freeze([
  'DISCOVERED',
  'VALIDATING',
  'STARTING',
  'HEALTHY',
  'DEGRADED',
  'DRAINING',
  'STOPPED',
  'QUARANTINED',
]);

/** Declared event types the core primitive will record. Anything else is a contract violation. */
export const PLUGIN_EVENT_TYPES = Object.freeze([
  'core.booted',
  'plugin.registered',
  'plugin.rejected',
  'plugin.activated',
  'plugin.deactivated',
  'plugin.quarantined',
  'plugin.upgraded',
  'plugin.rolled-back',
  'plugin.policy-denied',
  'plugin.secret-issued',
  'plugin.budget-rejected',
]);

/** Core identity — the smallest possible trusted base, first-party only. */
export const PLUGIN_CORE = Object.freeze({
  id: 'n8n-lego-core',
  kind: 'core',
  trust: 'CORE',
  contract: `${PLUGIN_RUNTIME_CONTRACT}@${PLUGIN_RUNTIME_CONTRACT_VERSION}`,
});

/** Default / maximum bounded event-ring capacity (no unbounded buffers, §63). */
export const PLUGIN_EVENT_LIMIT_DEFAULT = 64;
export const PLUGIN_EVENT_LIMIT_MAX = 4096;

/**
 * Every error code this milestone is allowed to raise — verbatim from the
 * published errors contract. Loaded once; a code that is not in this set can
 * never leave the plugin runtime (foundation rule F16 keeps us honest).
 */
export const PUBLISHED_ERROR_CODES = Object.freeze(
  JSON.parse(readFileSync(new URL('./contracts/errors.contract.json', import.meta.url), 'utf8'))
    .codes.map((entry) => entry.code),
);

const PUBLISHED = new Set(PUBLISHED_ERROR_CODES);

/**
 * The only error type the plugin runtime throws. The constructor refuses to
 * exist with an unpublished `code`, so a private vocabulary cannot creep in
 * through a message string.
 */
export class PluginRuntimeError extends Error {
  constructor(code, message, { retryable = false, details = {} } = {}) {
    if (typeof code !== 'string' || !PUBLISHED.has(code)) {
      throw new TypeError(`plugin runtime error code '${code}' is not published in contracts/errors.contract.json`);
    }
    super(message);
    this.name = 'PluginRuntimeError';
    this.code = code;
    this.retryable = Boolean(retryable);
    this.details = Object.freeze({ ...details });
  }
}

function assertNowIsFunction(now) {
  if (typeof now !== 'function') throw new TypeError('createPluginRuntime requires now() to be a function');
}

function normalizeEventLimit(limit) {
  if (!Number.isInteger(limit) || limit < 1 || limit > PLUGIN_EVENT_LIMIT_MAX) {
    throw new TypeError(`eventLimit must be an integer in [1, ${PLUGIN_EVENT_LIMIT_MAX}]`);
  }
  return limit;
}

function snapshotDetail(detail, type) {
  if (detail === undefined) return Object.freeze({});
  try {
    const json = JSON.stringify(detail);
    if (json === undefined) throw new TypeError('not serializable');
    const copy = JSON.parse(json);
    if (copy === null || typeof copy !== 'object') throw new TypeError('detail must be a plain object');
    return Object.freeze(copy);
  } catch {
    throw new PluginRuntimeError('lego.contract_violation', `event '${type}' detail must be a JSON-serializable object`, {
      details: { type },
    });
  }
}

/**
 * Create the tiny Core runtime instance.
 *
 * The instance is frozen: later slices extend it by *constructor options*
 * (registry, policy, supervisor injected at creation), never by mutating a
 * live core from the outside.
 *
 * @param {{ now?: () => number, eventLimit?: number, registry?: { size: Function, get: Function } | null }} [options]
 */
export function createPluginRuntime({ now = Date.now, eventLimit = PLUGIN_EVENT_LIMIT_DEFAULT, registry = null } = {}) {
  assertNowIsFunction(now);
  if (registry !== null) {
    if (typeof registry !== 'object' || typeof registry.size !== 'function' || typeof registry.get !== 'function') {
      throw new TypeError('createPluginRuntime registry must expose size() and get() (createPluginRegistry shape)');
    }
  }
  const limit = normalizeEventLimit(eventLimit);
  const bootedAt = now();
  if (typeof bootedAt !== 'number' || !Number.isFinite(bootedAt) || bootedAt < 0) {
    throw new TypeError('createPluginRuntime now() must return a non-negative finite number');
  }
  /** @type {Array<{ type: string, at: number, detail: object }>} bounded ring — oldest drops first */
  const ring = [];
  let dropped = 0;

  const recordEvent = (type, detail) => {
    if (typeof type !== 'string' || !PLUGIN_EVENT_TYPES.includes(type)) {
      throw new PluginRuntimeError('lego.contract_violation', `unknown plugin event type '${type}'`, {
        details: { type, declared: PLUGIN_EVENT_TYPES.length },
      });
    }
    const frozenDetail = snapshotDetail(detail, type);
    if (ring.length >= limit) {
      ring.shift();
      dropped += 1;
    }
    ring.push(Object.freeze({ type, at: now(), detail: frozenDetail }));
    return ring.length;
  };

  const runtime = {
    bootedAt,
    now,
    identity: () => PLUGIN_CORE,
    recordEvent,
    registry,
    events: () => ring.map((event) => ({ ...event })),
    health: () => {
      const stored = ring.length;
      return Object.freeze({
        status: 'ok',
        core: 'ok',
        bootedAt,
        plugins: registry === null ? 0 : registry.size(),
        events: Object.freeze({ stored, limit, dropped }),
      });
    },
  };
  return Object.freeze(runtime);
}

/**
 * Bootstrap primitive (design §3): a booted core emits exactly one
 * `core.booted` event and hands back the frozen runtime instance.
 */
export function bootstrapPluginCore(options = {}) {
  const runtime = createPluginRuntime(options);
  runtime.recordEvent('core.booted', { contract: PLUGIN_CORE.contract });
  return runtime;
}
