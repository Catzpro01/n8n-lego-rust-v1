/**
 * Node residency — P6.7 (manifest/implementation split + HOT/WARM/COLD).
 *
 * PUBLIC CONTRACT (`node.residency@0.1.0`, domain `node-registry`).
 *
 * An epoch can hold hundreds of node types. A process cannot hold hundreds of
 * loaded implementations, and pretending otherwise is how a node registry turns
 * into a memory leak with a catalogue. The way out is the split this contract
 * exists to enforce:
 *
 *   THE MANIFEST AND THE IMPLEMENTATION ARE DIFFERENT THINGS.
 *
 * A declaration (metadata: identity, capabilities, resources, compatibility —
 * P6.1) is cheap, and a workflow needs it to resolve and to be edited. An
 * implementation (code that does the work) is expensive, and a workflow needs it
 * only while it runs. Tying the two together means either loading everything or
 * resolving against nothing. Splitting them means a registry can know about
 * every node in the catalogue while running a handful.
 *
 * Three tiers, and the order between them is the contract:
 *
 *   COLD  the node is known to the epoch and nothing about it is resident here.
 *   WARM  the MANIFEST is resident: the declaration is in memory, the
 *         implementation is not. Resolution and the editor work; execution does
 *         not.
 *   HOT   the IMPLEMENTATION is resident and runnable.
 *
 * COLD → WARM → HOT is the only way up, and that is the point: metadata is read
 * BEFORE code is loaded, which is what leaves room for a capability, trust or
 * residency check to happen at all. A load straight from COLD is refused rather
 * than quietly warmed as a side effect — the check that was skipped would never
 * be reported, because there would be nothing to report it.
 *
 * Two consequences worth naming:
 *
 *   - HOT is BOUNDED. A hot budget demotes the LEAST-RECENTLY-USED hot node to
 *     WARM automatically when a load would exceed it, and says which node it
 *     demoted. Memory pressure is handled by an explicit, reported policy
 *     instead of by an out-of-memory kill.
 *   - EVICTION RESPECTS LEASES (P6.6). An implementation an execution is still
 *     holding is never unloaded: `inUseBy` is a required input, and a non-empty
 *     set refuses the eviction with the executions named.
 *
 * WHAT THIS IS NOT (P6.7 scope walls, enforced by tests):
 *   - no execution and no runtime: `load` records that an implementation is
 *     resident, it does not run anything;
 *   - no capability or trust decision (P6.8/P6.12): the split MAKES such a check
 *     possible, it does not perform one;
 *   - no health, quarantine (P6.11) and no pool or worker (P6.24);
 *   - no filesystem, no network, no clock: recency is a monotonic TICK, not a
 *     timestamp, so the same operations produce the same table anywhere;
 *   - no mutation: every operation returns a new frozen table.
 *
 * Authority: residency is a local caching decision. Being HOT grants nothing and
 * being COLD revokes nothing: it says where code currently lives, not what it is
 * allowed to do.
 */
import { NODE_REGISTRY_SCHEMA_VERSION } from './node-registry.mjs';
import { isFrozenRegistryEpoch } from './registry-compiler.mjs';

export const RESIDENCY_CONTRACT = 'node.residency@0.1.0';
export const RESIDENCY_CONTRACT_VERSION = '0.1.0';
export const RESIDENCY_SCHEMA_VERSION = 1;

export const RESIDENCY_OPERATIONS = Object.freeze(['warm', 'load', 'evict', 'describe']);
export const RESIDENCY_PERMISSIONS = Object.freeze(['node:read']);

/** Cold → warm → hot. The order is the contract, not a convention. */
export const RESIDENCY_TIERS = Object.freeze(['cold', 'warm', 'hot']);

/** Tiers in which the MANIFEST is resident. The implementation is resident only in `hot`. */
export const MANIFEST_RESIDENT_TIERS = Object.freeze(['warm', 'hot']);

/** Default hot budget: small enough to matter, large enough to be useful. */
export const DEFAULT_HOT_BUDGET = 8;

export const RESIDENCY_REASONS = Object.freeze([
  'residency.epoch',
  'residency.identity',
  'residency.order',
  'residency.in-use',
  'residency.budget',
  'residency.tier',
  'residency.table',
]);

export const RESIDENCY_RULES = Object.freeze({
  split: 'the manifest and the implementation are different things: metadata is read before code is loaded, which is what leaves room for a check to happen',
  order: 'cold → warm → hot is the only way up; a load straight from cold is refused rather than quietly warmed as a side effect',
  bounded: 'hot is bounded by an explicit budget; exceeding it demotes the least-recently-used node and says which one, instead of an out-of-memory kill',
  leases: 'an implementation an execution is still holding is never unloaded: the eviction is refused with the executions named',
  recency: 'recency is a monotonic tick, not a timestamp, so the same operations produce the same table on any host',
  authority: 'being hot grants nothing and being cold revokes nothing: residency says where code lives, not what it may do',
});

/* ------------------------------------------------------------------ *\n * Errors\n * ------------------------------------------------------------------ */

export class ResidencyError extends Error {
  constructor(message, meta = {}) {
    super(message);
    this.name = 'ResidencyError';
    this.code = 'lego.contract_violation';
    this.meta = Object.freeze({ ...meta });
  }
}

const fail = (message, meta) => { throw new ResidencyError(message, meta); };
const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value;
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return Object.freeze(value);
}

const requireEpoch = (epoch, fn) => {
  if (!isFrozenRegistryEpoch(epoch)) fail(`${fn} expects a frozen epoch compiled by registry.compiler`, { got: typeof epoch });
};

/**
 * Create a residency table for an epoch: every identity starts COLD, which is
 * the honest starting point — knowing about a node is not having it.
 *
 * @param {{ epoch?: object, maxHot?: number }} input
 */
export function createResidencyTable({ epoch, maxHot = DEFAULT_HOT_BUDGET } = {}) {
  requireEpoch(epoch, 'createResidencyTable');
  if (!Number.isInteger(maxHot) || maxHot < 1) {
    fail(`maxHot must be a positive integer, got ${JSON.stringify(maxHot)}; an unbounded hot tier is an unbounded process`, { code: 'residency.budget', field: 'maxHot' });
  }
  const entries = {};
  for (const identity of epoch.identities) {
    entries[identity] = deepFreeze({ identity, tier: 'cold', tick: 0, loads: 0 });
  }
  return deepFreeze({
    ok: true,
    contract: RESIDENCY_CONTRACT,
    schemaVersion: RESIDENCY_SCHEMA_VERSION,
    epochNumber: epoch.epochNumber,
    epochDigest: epoch.epochDigest,
    epochSource: epoch.source,
    maxHot,
    tick: 0,
    entries: deepFreeze(entries),
    identityCount: epoch.identities.length,
    loads: 0,
    demotions: 0,
    refusals: 0,
  });
}

/** @returns {boolean} whether `value` is a residency table this contract produced. */
export function isResidencyTable(value) {
  return (
    isPlainObject(value) &&
    value.ok === true &&
    value.contract === RESIDENCY_CONTRACT &&
    value.schemaVersion === RESIDENCY_SCHEMA_VERSION &&
    typeof value.epochDigest === 'string' &&
    Number.isInteger(value.maxHot) &&
    isPlainObject(value.entries) &&
    Number.isInteger(value.tick) &&
    Object.isFrozen(value)
  );
}

const requireTable = (table, fn) => {
  if (!isResidencyTable(table)) fail(`${fn} expects a table produced by createResidencyTable`, { got: typeof table });
};

const requireIdentity = (table, identity, fn) => {
  if (typeof identity !== 'string' || !Object.hasOwn(table.entries, identity)) {
    fail(`${fn}: '${identity}' is not in epoch ${table.epochNumber}; a node the registry does not have cannot be made resident`, { code: 'residency.identity', identity });
  }
};

const withEntry = (table, identity, entry, extra = {}) => deepFreeze({
  ...table,
  tick: table.tick + 1,
  entries: { ...table.entries, [identity]: deepFreeze({ ...entry, tick: table.tick + 1 }) },
  ...extra,
});

const hotIdentities = (table) => Object.values(table.entries).filter((entry) => entry.tier === 'hot').map((entry) => entry.identity);
const warmIdentities = (table) => Object.values(table.entries).filter((entry) => entry.tier === 'warm').map((entry) => entry.identity);

/* ------------------------------------------------------------------ *\n * Up\n * ------------------------------------------------------------------ */

/**
 * COLD → WARM: bring the MANIFEST into memory. The implementation is untouched.
 * @returns {{ ok: true, table: object, tier: 'warm' }}
 */
export function warmNode(table, identity) {
  requireTable(table, 'warmNode');
  requireIdentity(table, identity, 'warmNode');
  const entry = table.entries[identity];
  if (entry.tier !== 'cold') {
    // Already warm or hot: touching it refreshes recency and nothing else.
    return Object.freeze({ ok: true, table: withEntry(table, identity, entry), tier: entry.tier, reason: 'already-resident' });
  }
  return Object.freeze({ ok: true, table: withEntry(table, identity, { ...entry, tier: 'warm' }), tier: 'warm', reason: 'warmed' });
}

/**
 * WARM → HOT: bring the IMPLEMENTATION into memory.
 *
 * Refused from COLD: the metadata read that a capability or trust check needs
 * must be an actual step, not a side effect of loading code.
 *
 * @returns {{ ok: true, table: object, tier: 'hot', demoted: string[] }}
 */
export function loadNode(table, identity) {
  requireTable(table, 'loadNode');
  requireIdentity(table, identity, 'loadNode');
  const entry = table.entries[identity];

  if (entry.tier === 'cold') {
    fail(
      `'${identity}' is COLD: warm its manifest before loading its implementation; metadata is read before code is loaded, which is what leaves room for a check to happen`,
      { code: 'residency.order', identity, tier: entry.tier },
    );
  }
  if (entry.tier === 'hot') {
    return Object.freeze({ ok: true, table: withEntry(table, identity, entry), tier: 'hot', reason: 'already-hot', demoted: Object.freeze([]) });
  }

  const hot = hotIdentities(table);
  const demoted = [];
  let next = table;

  // Memory pressure is a POLICY, not an accident: demote least-recently-used
  // hot nodes until the load fits, and report exactly which ones.
  if (hot.length >= table.maxHot) {
    const victims = Object.values(table.entries)
      .filter((candidate) => candidate.tier === 'hot')
      .sort((a, b) => a.tick - b.tick || (a.identity < b.identity ? -1 : 1))
      .slice(0, hot.length - table.maxHot + 1);
    for (const victim of victims) {
      demoted.push(victim.identity);
      next = withEntry(next, victim.identity, { ...next.entries[victim.identity], tier: 'warm' });
    }
    next = deepFreeze({ ...next, demotions: next.demotions + victims.length });
  }

  const loaded = { ...next.entries[identity], tier: 'hot', loads: (next.entries[identity].loads ?? 0) + 1 };
  return Object.freeze({
    ok: true,
    table: withEntry(next, identity, loaded, { loads: next.loads + 1 }),
    tier: 'hot',
    reason: 'loaded',
    demoted: Object.freeze(demoted),
  });
}

/* ------------------------------------------------------------------ *\n * Down\n * ------------------------------------------------------------------ */

/**
 * HOT → WARM: unload the implementation, keep the manifest.
 *
 * `inUseBy` is REQUIRED and must be empty: an implementation an execution still
 * holds is not unloaded, and the refusal names the executions.
 */
export function evictNode(table, identity, { inUseBy } = {}) {
  requireTable(table, 'evictNode');
  requireIdentity(table, identity, 'evictNode');
  const entry = table.entries[identity];

  if (!Array.isArray(inUseBy) && !(inUseBy instanceof Set)) {
    fail('evictNode requires the inUseBy set of executions holding this node; evicting without asking is how a running execution loses its implementation', { code: 'residency.in-use', identity, field: 'inUseBy' });
  }
  const holders = [...inUseBy];
  if (holders.length > 0) {
    return Object.freeze({
      ok: false,
      table: deepFreeze({ ...table, refusals: table.refusals + 1 }),
      tier: entry.tier,
      reason: 'residency.in-use',
      error: Object.freeze({
        code: 'residency.in-use',
        identity,
        holders: Object.freeze(holders),
        message: `'${identity}' is still held by ${holders.length} execution${holders.length === 1 ? '' : 's'} (${holders.join(', ')}); an implementation in use is never unloaded`,
      }),
    });
  }
  if (entry.tier !== 'hot') {
    return Object.freeze({ ok: true, table, tier: entry.tier, reason: entry.tier === 'cold' ? 'already-cold' : 'already-warm' });
  }
  return Object.freeze({ ok: true, table: withEntry(table, identity, { ...entry, tier: 'warm' }), tier: 'warm', reason: 'evicted' });
}

/** WARM → COLD: drop the manifest too, leaving only the pin in the epoch. */
export function dropNode(table, identity, { inUseBy } = {}) {
  requireTable(table, 'dropNode');
  requireIdentity(table, identity, 'dropNode');
  const entry = table.entries[identity];

  if (!Array.isArray(inUseBy) && !(inUseBy instanceof Set)) {
    fail('dropNode requires the inUseBy set of executions holding this node', { code: 'residency.in-use', identity, field: 'inUseBy' });
  }
  if ([...inUseBy].length > 0) {
    const holders = [...inUseBy];
    return Object.freeze({
      ok: false, table: deepFreeze({ ...table, refusals: table.refusals + 1 }), tier: entry.tier, reason: 'residency.in-use',
      error: Object.freeze({ code: 'residency.in-use', identity, holders: Object.freeze(holders), message: `'${identity}' is still held by ${holders.length} execution${holders.length === 1 ? '' : 's'}; drop the holders first` }),
    });
  }
  if (entry.tier === 'cold') return Object.freeze({ ok: true, table, tier: 'cold', reason: 'already-cold' });
  if (entry.tier === 'hot') {
    fail(`'${identity}' is HOT; evict the implementation before dropping its manifest`, { code: 'residency.order', identity, tier: 'hot' });
  }
  return Object.freeze({ ok: true, table: withEntry(table, identity, { ...entry, tier: 'cold' }), tier: 'cold', reason: 'dropped' });
}

/* ------------------------------------------------------------------ *\n * Reads\n * ------------------------------------------------------------------ */

/** The tier of one node, or null when the epoch does not have it at all. */
export function residencyOf(table, identity) {
  requireTable(table, 'residencyOf');
  return Object.hasOwn(table.entries, identity) ? table.entries[identity].tier : null;
}

/** Every node whose IMPLEMENTATION is resident, most recently used first. */
export function hotNodes(table) {
  requireTable(table, 'hotNodes');
  return deepFreeze(Object.values(table.entries)
    .filter((entry) => entry.tier === 'hot')
    .sort((a, b) => b.tick - a.tick || (a.identity < b.identity ? -1 : 1))
    .map((entry) => entry.identity));
}

/** Every node whose MANIFEST is resident, most recently used first. */
export function manifestResidentNodes(table) {
  requireTable(table, 'manifestResidentNodes');
  return deepFreeze(Object.values(table.entries)
    .filter((entry) => MANIFEST_RESIDENT_TIERS.includes(entry.tier))
    .sort((a, b) => b.tick - a.tick || (a.identity < b.identity ? -1 : 1))
    .map((entry) => entry.identity));
}

/** The census an operator wants: how much of the catalogue this process is holding. */
export function describeResidency(table) {
  requireTable(table, 'describeResidency');
  const tiers = { cold: 0, warm: 0, hot: 0 };
  for (const entry of Object.values(table.entries)) tiers[entry.tier] += 1;
  return deepFreeze({
    contract: table.contract,
    schemaVersion: table.schemaVersion,
    epochNumber: table.epochNumber,
    epochDigest: table.epochDigest,
    epochSource: table.epochSource,
    identityCount: table.identityCount,
    tiers,
    hotBudget: table.maxHot,
    hot: hotNodes(table),
    warm: deepFreeze(warmIdentities(table)),
    manifestResident: tiers.warm + tiers.hot,
    implementationResident: tiers.hot,
    tick: table.tick,
    loads: table.loads,
    demotions: table.demotions,
    refusals: table.refusals,
    atBudget: tiers.hot >= table.maxHot,
  });
}

/** `residency: 2 hot / 3 warm / 478 cold of 483 (budget 2)`. */
export function formatResidency(table) {
  requireTable(table, 'formatResidency');
  const { tiers, identityCount, hotBudget } = describeResidency(table);
  return `residency: ${tiers.hot} hot / ${tiers.warm} warm / ${tiers.cold} cold of ${identityCount} (budget ${hotBudget})`;
}

/** Which nodes are worth warming next, given how often they were asked for. */
export function residencyCandidates(table, identities) {
  requireTable(table, 'residencyCandidates');
  if (!Array.isArray(identities)) fail('residencyCandidates expects an array of identities', { code: 'residency.identity' });
  const unique = [...new Set(identities)].filter((identity) => Object.hasOwn(table.entries, identity));
  return deepFreeze(unique
    .filter((identity) => table.entries[identity].tier === 'cold')
    .sort((a, b) => (a < b ? -1 : 1)));
}

/** The headroom left in the hot budget. */
export function hotHeadroom(table) {
  requireTable(table, 'hotHeadroom');
  return Math.max(0, table.maxHot - hotIdentities(table).length);
}

export const RESIDENCY_INPUT_SCHEMA_VERSION = NODE_REGISTRY_SCHEMA_VERSION;
