/**
 * Health, crash circuit breaker, quarantine — P6.11.
 *
 * PUBLIC CONTRACT (`node.health@0.1.0`, domain `node-registry`).
 *
 * A node that crashed once is a fact. A node that crashes every time is a
 * decision: either the registry keeps handing it work and pays for every attempt,
 * or it stops and says why. This contract is that decision, and it is deliberately
 * the smallest one that can be defended:
 *
 *   OBSERVATION  success or failure, with a tick the caller supplies — no clock
 *   DERIVATION   the health state follows from the observations, never the reverse
 *   BREAKER      enough consecutive failures and the circuit OPENS: work is refused
 *                with the tick at which it may be tried again, because a node that
 *                is failing right now should not be handed the next job
 *   HALF-OPEN    after the cool-off, exactly one probe is allowed through. Success
 *                closes the circuit; failure re-opens it with a longer cool-off,
 *                bounded so that a permanently broken node does not disappear
 *                into an unbounded back-off
 *   QUARANTINE   the manual, deliberate version of the same thing. It outranks
 *                every observation: a success does not clear it, a healthy streak
 *                does not clear it, and only an explicit release does
 *
 * THE STATE VOCABULARY IS P6.1's (`unknown`, `healthy`, `degraded`, `failing`,
 * `quarantined`), quoted rather than extended. What this contract adds is the
 * transition rules between those words — which is where a health system either
 * becomes trustworthy or becomes decoration.
 *
 * TWO RULES THAT KEEP IT HONEST:
 *
 *   1. NO CLOCK. `tick` is data. A health table rebuilt from the same ticks
 *      produces the same states, which is what makes a quarantine reproducible
 *      after a restart instead of a memory in a process.
 *
 *   2. RELEASE IS NOT RECOVERY. Releasing a quarantine returns the node to
 *      `unknown`, never to `healthy`: the only thing that ever makes a node
 *      healthy is an observation that says so. A release that returns to healthy
 *      would be an operator's optimism wearing a state machine's clothes.
 *
 * WHAT THIS IS NOT (P6.11 scope walls, enforced by tests):
 *   - it does not EXECUTE anything and does not retry: it decides whether a retry
 *     is allowed (`mayServe`) and leaves the retrying to the runtime;
 *   - it does not touch leases (P6.6), residency (P6.7), capabilities (P6.8) or
 *     lifecycle (P6.10): health is observed, not governed;
 *   - it does not revoke artifacts (P6.12) and does not roll back an epoch
 *     (P6.19): quarantine greys out a node on THIS host, nothing more;
 *   - no promise that a healthy node stays healthy: health is history, not a
 *     prediction.
 *
 * Authority: a quarantined node is refused here, but quarantine is per-host
 * operational state. It is not a contract change, not a trust decision, and not
 * an uninstall.
 */
import { createHash } from 'node:crypto';

import { NODE_HEALTH_STATES } from './node-registry.mjs';

export const NODE_HEALTH_CONTRACT = 'node.health@0.1.0';
export const NODE_HEALTH_CONTRACT_VERSION = '0.1.0';
export const NODE_HEALTH_SCHEMA_VERSION = 1;

export const NODE_HEALTH_OPERATIONS = Object.freeze(['observe', 'mayServe', 'quarantine', 'release', 'describe']);
export const NODE_HEALTH_PERMISSIONS = Object.freeze(['node:read']);

/** The five foundation health states, re-exported so a reader has one source. */
export const HEALTH_STATES = Object.freeze([...NODE_HEALTH_STATES]);

/** Circuit states. `open` refuses work; `half-open` allows exactly one probe. */
export const CIRCUIT_STATES = Object.freeze(['closed', 'open', 'half-open']);

export const HEALTH_OUTCOMES = Object.freeze(['success', 'failure']);

export const QUARANTINE_ORIGINS = Object.freeze(['operator', 'breaker', 'policy', 'attestation']);

/** Consecutive failures before the circuit opens, unless a table says otherwise. */
export const DEFAULT_FAILURE_THRESHOLD = 3;

/** Ticks the circuit stays open before a single probe is allowed. */
export const DEFAULT_COOL_OFF_TICKS = 30;

/** Doubling is bounded: a broken node must stay visible, not vanish. */
export const MAX_COOL_OFF_TICKS = 960;

export const NODE_HEALTH_REASONS = Object.freeze([
  'health.input',
  'health.epoch',
  'health.identity',
  'health.outcome',
  'health.tick',
  'health.circuit_open',
  'health.quarantined',
  'health.table',
]);

export const NODE_HEALTH_RULES = Object.freeze({
  derivation: 'the health state follows from the observations, never the reverse: a state that cannot be traced to a tick is a mood, not a measurement',
  noClock: 'tick is data, not a clock reading: a table rebuilt from the same ticks produces the same states, which is what makes a quarantine survive a restart',
  breaker: 'consecutive failures open the circuit and work is refused with the tick at which it may be tried again — a node that is failing right now is not handed the next job to prove it',
  halfOpen: 'after the cool-off exactly one probe is allowed through; success closes, failure re-opens with a longer cool-off, bounded so a permanently broken node stays visible',
  quarantine: 'quarantine outranks every observation: a success does not clear it and only an explicit release does, because a node that was pulled out of service for a reason deserves the reason to be respected',
  release: 'releasing a quarantine returns a node to unknown, never to healthy: the only thing that makes a node healthy is an observation that says so',
  authority: 'quarantine is per-host operational state: it greys out a node here, and it is not a trust decision, a contract change or an uninstall',
});

/* ------------------------------------------------------------------ *
 * Errors
 * ------------------------------------------------------------------ */

/** Raised for API misuse. Refusals to serve are returned as data. */
export class NodeHealthError extends Error {
  constructor(message, meta = {}) {
    super(message);
    this.name = 'NodeHealthError';
    this.code = 'lego.contract_violation';
    this.meta = Object.freeze({ ...meta });
  }
}

const fail = (message, meta) => { throw new NodeHealthError(message, meta); };
const isPlainObject = (value) => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};
const isNonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0;

function deepFreeze(value) {
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
    return Object.freeze(value);
  }
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    return Object.freeze(value);
  }
  return value;
}

const stableJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
};

const digestOf = (canonicalJson) => `sha256:${createHash('sha256').update(canonicalJson, 'utf8').digest('hex')}`;

const tableDigestOf = (identities, entries) => digestOf(stableJson({
  identities: [...identities].sort().map((identity) => [identity, entries[identity]]),
}));

/* ------------------------------------------------------------------ *
 * Table
 * ------------------------------------------------------------------ */

const identitiesOfEpoch = (epoch) => {
  if (!isPlainObject(epoch) || !Number.isInteger(epoch.epochNumber) || !isNonEmptyString(epoch.epochDigest)) {
    fail('a health table is built for one compiled epoch (P6.2): pass the epoch, not an epoch number', { code: 'health.epoch', field: 'epoch' });
  }
  if (Array.isArray(epoch.identities)) return [...epoch.identities];
  if (isPlainObject(epoch.byIdentity)) return Object.keys(epoch.byIdentity);
  fail('the epoch must expose identities or byIdentity: an unreadable epoch cannot be watched', { code: 'health.epoch', field: 'epoch' });
};

const freshEntry = (identity) => ({
  identity,
  state: 'unknown',
  circuit: 'closed',
  consecutiveFailures: 0,
  consecutiveSuccesses: 0,
  lastOutcome: null,
  lastTick: null,
  coolOffTicks: null,
  openedAtTick: null,
  quarantine: null,
  releasedAt: null,
  observationCount: 0,
});

const requireThresholds = (threshold, coolOffTicks) => {
  if (!Number.isInteger(threshold) || threshold < 1) fail('threshold must be a positive integer: a circuit that opens after zero failures is not a breaker', { code: 'health.input', field: 'threshold' });
  if (!Number.isInteger(coolOffTicks) || coolOffTicks < 1) fail('coolOffTicks must be a positive integer', { code: 'health.input', field: 'coolOffTicks' });
  return { threshold, coolOffTicks };
};

/** Build the health table of one compiled epoch: every identity starts `unknown`. */
export function createHealthTable(epoch, { threshold = DEFAULT_FAILURE_THRESHOLD, coolOffTicks = DEFAULT_COOL_OFF_TICKS } = {}) {
  const identities = identitiesOfEpoch(epoch);
  const { threshold: limit, coolOffTicks: coolOff } = requireThresholds(threshold, coolOffTicks);
  const entries = {};
  for (const identity of identities.sort()) entries[identity] = freshEntry(identity);
  return deepFreeze({
    ok: true,
    schemaVersion: NODE_HEALTH_SCHEMA_VERSION,
    contract: NODE_HEALTH_CONTRACT,
    epochNumber: epoch.epochNumber,
    epochDigest: epoch.epochDigest,
    threshold: limit,
    coolOffTicks: coolOff,
    maxCoolOffTicks: MAX_COOL_OFF_TICKS,
    entries: Object.freeze(entries),
    tableDigest: tableDigestOf(identities, entries),
  });
}

/** @returns {boolean} whether `value` is a health table this contract produced. */
export function isHealthTable(value) {
  return (
    isPlainObject(value) &&
    value.ok === true &&
    value.contract === NODE_HEALTH_CONTRACT &&
    value.schemaVersion === NODE_HEALTH_SCHEMA_VERSION &&
    isPlainObject(value.entries) &&
    typeof value.tableDigest === 'string' &&
    Object.isFrozen(value)
  );
}

const requireTable = (table, fn) => {
  if (!isHealthTable(table)) fail(`${fn} expects a table from createHealthTable`, { got: typeof table });
};

const requireIdentity = (table, identity) => {
  if (!isNonEmptyString(identity)) fail('an identity is required', { code: 'health.identity', field: 'identity' });
  const entry = table.entries[identity];
  if (!entry) {
    fail(`'${identity}' is not in this epoch: this table watches the identities of its own epoch`, { code: 'health.identity', field: 'identity' });
  }
  return entry;
};

const requireTick = (tick) => {
  if (!Number.isInteger(tick) || tick < 0) {
    fail('an observation needs a tick: without one, "how long has this been failing" has no answer', { code: 'health.tick', field: 'tick' });
  }
  return tick;
};

const nextTable = (table, entries) => {
  const identities = Object.keys(entries);
  return deepFreeze({
    ...table,
    entries: Object.freeze(entries),
    tableDigest: tableDigestOf(identities, entries),
  });
};

const withEntry = (table, identity, changes) => nextTable(table, {
  ...table.entries,
  [identity]: Object.freeze({ ...table.entries[identity], ...changes }),
});

/* ------------------------------------------------------------------ *
 * Observations
 * ------------------------------------------------------------------ */

/**
 * Record one observation. The state is derived, the circuit follows from it, and
 * a quarantined node records the observation without letting it change anything:
 * a success on a quarantined node is data, not forgiveness.
 */
export function recordObservation(table, identity, { outcome, tick, detail = null } = {}) {
  requireTable(table, 'recordObservation');
  const entry = requireIdentity(table, identity);
  if (!HEALTH_OUTCOMES.includes(outcome)) {
    fail(`unknown outcome ${JSON.stringify(outcome)} — expected ${HEALTH_OUTCOMES.join(' or ')}`, { code: 'health.outcome', field: 'outcome' });
  }
  requireTick(tick);

  if (entry.quarantine) {
    return deepFreeze({
      ok: true,
      identity,
      changed: false,
      state: entry.state,
      circuit: entry.circuit,
      table: withEntry(table, identity, { observationCount: entry.observationCount + 1, lastOutcome: outcome, lastTick: tick }),
      reason: 'health.quarantined',
      message: `'${identity}' is quarantined (${entry.quarantine.origin}: ${entry.quarantine.reason}); the observation is recorded and nothing else changes, because a success is not a release`,
    });
  }

  if (outcome === 'success') {
    // An open circuit closes only when this success was ALLOWED to happen: a
    // success recorded before the cool-off is data, not a verdict, and the
    // circuit stays open on purpose.
    const retryAtTick = entry.openedAtTick === null ? null : entry.openedAtTick + (entry.coolOffTicks ?? table.coolOffTicks);
    const closes = entry.circuit !== 'open' || (retryAtTick !== null && tick >= retryAtTick);
    const next = withEntry(table, identity, {
      state: closes ? 'healthy' : 'failing',
      circuit: closes ? 'closed' : 'open',
      consecutiveFailures: closes ? 0 : entry.consecutiveFailures,
      consecutiveSuccesses: entry.consecutiveSuccesses + 1,
      lastOutcome: 'success',
      lastTick: tick,
      coolOffTicks: closes ? null : entry.coolOffTicks,
      openedAtTick: closes ? null : entry.openedAtTick,
      observationCount: entry.observationCount + 1,
    });
    return deepFreeze({
      ok: true,
      identity,
      changed: true,
      state: closes ? 'healthy' : 'failing',
      circuit: closes ? 'closed' : 'open',
      table: next,
      reason: closes ? null : 'health.circuit_open',
      message: closes
        ? null
        : `'${identity}' reported a success at tick ${tick} before its circuit was due (tick ${retryAtTick}): the observation is recorded and the circuit stays open, because a success that was not allowed to happen proves nothing`,
    });
  }

  const consecutiveFailures = entry.consecutiveFailures + 1;
  const opensNow = entry.circuit === 'open' || consecutiveFailures >= table.threshold;
  const coolOff = opensNow
    ? Math.min(
      entry.circuit === 'open'
        ? (entry.coolOffTicks ?? table.coolOffTicks) * 2
        : table.coolOffTicks,
      table.maxCoolOffTicks,
    )
    : null;
  const state = opensNow ? 'failing' : 'degraded';
  const next = withEntry(table, identity, {
    state,
    circuit: opensNow ? 'open' : 'closed',
    consecutiveFailures,
    consecutiveSuccesses: 0,
    lastOutcome: 'failure',
    lastTick: tick,
    coolOffTicks: coolOff,
    openedAtTick: opensNow ? tick : null,
    observationCount: entry.observationCount + 1,
  });
  return deepFreeze({
    ok: true,
    identity,
    changed: true,
    state,
    circuit: next.entries[identity].circuit,
    table: next,
    reason: opensNow ? 'health.circuit_open' : null,
    message: opensNow
      ? `'${identity}' failed ${consecutiveFailures} times in a row${detail ? ` (last: ${detail})` : ''}: the circuit is open and work is refused until tick ${tick + coolOff}`
      : `'${identity}' is degraded after ${consecutiveFailures} consecutive failure(s) of a threshold of ${table.threshold}`,
  });
}

/* ------------------------------------------------------------------ *
 * Serving
 * ------------------------------------------------------------------ */

/**
 * May this node be handed work at this tick? The three refusals are the whole
 * point of the contract: quarantined, circuit open, and (in half-open) a probe
 * already spent.
 */
export function mayServe(table, identity, { tick } = {}) {
  requireTable(table, 'mayServe');
  const entry = requireIdentity(table, identity);
  requireTick(tick);

  if (entry.quarantine) {
    return deepFreeze({
      ok: false, identity, state: entry.state, circuit: entry.circuit, reason: 'health.quarantined',
      retryAtTick: null, probe: false,
      message: `'${identity}' is quarantined (${entry.quarantine.origin}: ${entry.quarantine.reason}) since tick ${entry.quarantine.tick}: only an explicit release ends this`,
    });
  }
  if (entry.circuit === 'open') {
    const retryAtTick = (entry.openedAtTick ?? 0) + (entry.coolOffTicks ?? table.coolOffTicks);
    if (tick >= retryAtTick) {
      return deepFreeze({
        ok: true, identity, state: entry.state, circuit: 'half-open', reason: null, retryAtTick, probe: true, message: null,
      });
    }
    return deepFreeze({
      ok: false, identity, state: entry.state, circuit: 'open', reason: 'health.circuit_open', retryAtTick, probe: false,
      message: `'${identity}' is failing and its circuit is open until tick ${retryAtTick}; handing it the next job is how one broken node becomes a broken workflow`,
    });
  }
  return deepFreeze({
    ok: true, identity, state: entry.state, circuit: entry.circuit, reason: null, retryAtTick: null, probe: false, message: null,
  });
}

/* ------------------------------------------------------------------ *
 * Quarantine
 * ------------------------------------------------------------------ */

/**
 * Take a node out of service. Quarantine is the deliberate version of the
 * breaker: it does not expire, it is not cleared by success, and it records who
 * asked and why.
 */
export function quarantineNode(table, identity, { reason, origin = 'operator', tick, detail = null } = {}) {
  requireTable(table, 'quarantineNode');
  const entry = requireIdentity(table, identity);
  if (!isNonEmptyString(reason)) {
    fail('a quarantine needs a reason: a node pulled out of service deserves the reason written down', { code: 'health.input', field: 'reason' });
  }
  if (!QUARANTINE_ORIGINS.includes(origin)) {
    fail(`unknown quarantine origin ${JSON.stringify(origin)} — expected one of ${QUARANTINE_ORIGINS.join(', ')}`, { code: 'health.input', field: 'origin' });
  }
  requireTick(tick);
  if (entry.quarantine) {
    if (entry.quarantine.reason === reason && entry.quarantine.origin === origin) {
      return deepFreeze({ ok: true, identity, changed: false, table, reason: null, message: null });
    }
    return deepFreeze({
      ok: false, identity, changed: false, table, reason: 'health.quarantined',
      message: `'${identity}' is already quarantined (${entry.quarantine.origin}: ${entry.quarantine.reason}); a quarantine is released, not overwritten`,
    });
  }
  const next = withEntry(table, identity, {
    state: 'quarantined',
    circuit: 'open',
    coolOffTicks: null,
    openedAtTick: null,
    quarantine: { origin, reason, tick, detail },
  });
  return deepFreeze({ ok: true, identity, changed: true, table: next, reason: null, message: null });
}

/**
 * Release a quarantine. The node returns to `unknown` — never to `healthy` — and
 * its failure history is kept, because the history is why it was quarantined.
 */
export function releaseQuarantine(table, identity, { reason, tick, origin = 'operator' } = {}) {
  requireTable(table, 'releaseQuarantine');
  const entry = requireIdentity(table, identity);
  const release = { origin, reason, tick };
  if (!isNonEmptyString(reason)) {
    fail('a release needs a reason as much as a quarantine does', { code: 'health.input', field: 'reason' });
  }
  requireTick(tick);
  if (!QUARANTINE_ORIGINS.includes(origin)) {
    fail(`unknown release origin ${JSON.stringify(origin)} — expected one of ${QUARANTINE_ORIGINS.join(', ')}`, { code: 'health.input', field: 'origin' });
  }
  if (!entry.quarantine) {
    return deepFreeze({
      ok: false, identity, changed: false, table, reason: 'health.quarantined',
      message: `'${identity}' is not quarantined (state '${entry.state}'): there is nothing to release`,
    });
  }
  const next = withEntry(table, identity, {
    state: 'unknown',
    circuit: 'closed',
    quarantine: null,
    releasedAt: release,
  });
  return deepFreeze({
    ok: true, identity, changed: true, table: next, reason: null,
    message: `'${identity}' is released to 'unknown', not to 'healthy': the only thing that makes a node healthy is an observation that says so`,
  });
}

/* ------------------------------------------------------------------ *
 * Reads
 * ------------------------------------------------------------------ */

/** The entry for one identity: state, circuit, counters, quarantine, history size. */
export function healthOf(table, identity) {
  requireTable(table, 'healthOf');
  return requireIdentity(table, identity);
}

/** @returns {boolean} whether this node may be handed work right now. */
export function isQuarantined(table, identity) {
  requireTable(table, 'isQuarantined');
  return requireIdentity(table, identity).quarantine !== null;
}

/** Counts by state, open circuits, quarantines — the shape an operations page wants. */
export function describeHealth(table) {
  requireTable(table, 'describeHealth');
  const byState = {};
  const openCircuits = [];
  const quarantined = [];
  for (const identity of Object.keys(table.entries).sort()) {
    const entry = table.entries[identity];
    byState[entry.state] = (byState[entry.state] ?? 0) + 1;
    if (entry.circuit === 'open') openCircuits.push(identity);
    if (entry.quarantine) quarantined.push({ identity, origin: entry.quarantine.origin, reason: entry.quarantine.reason, tick: entry.quarantine.tick });
  }
  return deepFreeze({
    contract: table.contract,
    schemaVersion: table.schemaVersion,
    epochNumber: table.epochNumber,
    epochDigest: table.epochDigest,
    threshold: table.threshold,
    coolOffTicks: table.coolOffTicks,
    nodeCount: Object.keys(table.entries).length,
    byState: Object.freeze(byState),
    openCircuits: Object.freeze(openCircuits),
    quarantined: Object.freeze(quarantined),
    tableDigest: table.tableDigest,
  });
}

/** Recompute the table digest: an edited health record cannot survive this. */
export function verifyHealthTable(table, epoch) {
  requireTable(table, 'verifyHealthTable');
  if (epoch !== undefined) {
    if (!isPlainObject(epoch) || table.epochDigest !== epoch.epochDigest || table.epochNumber !== epoch.epochNumber) {
      return deepFreeze({
        ok: false, reason: 'health.epoch', expected: table.epochDigest, actual: epoch?.epochDigest ?? null,
        message: 'the table belongs to a different epoch: health is observed for the identities of one epoch',
      });
    }
  }
  const recomputed = tableDigestOf(Object.keys(table.entries), table.entries);
  if (recomputed !== table.tableDigest) {
    return deepFreeze({
      ok: false, reason: 'health.table', expected: table.tableDigest, actual: recomputed,
      message: 'the table digest does not match its own entries: the digest is what makes an edited health record visible',
    });
  }
  return deepFreeze({ ok: true, reason: null, expected: table.tableDigest, actual: recomputed, message: null });
}

export const NODE_HEALTH_INPUT_SCHEMA_VERSION = NODE_HEALTH_SCHEMA_VERSION;
