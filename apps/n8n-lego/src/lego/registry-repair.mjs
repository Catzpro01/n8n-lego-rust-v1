/**
 * registry.repair@0.1.0 — repair assessment, ordered restoration and offline recovery.
 *
 * P6 milestone 30 of 31 (Issue #100). A registry comes back from wherever it was: an install that
 * was interrupted, a disk that lost a file, a machine that has been offline for a month. The two
 * ways to get this wrong are to trust what is there, and to repair what is not.
 *
 * What it adds:
 *
 *  - A DAMAGED REGISTRY IS COMPARED, NOT TRUSTED. What should be there (an expectation, by digest)
 *    is compared with what is there (a census, by digest), and the answer is a NAMED census of
 *    damage: intact, altered, missing, unexpected.
 *  - AN ITEM THAT DOES NOT HASH TO ITS OWN DIGEST IS NOT EVIDENCE. When a census supplies bytes,
 *    they are hashed here; a self-inconsistent item is refused instead of being folded in.
 *  - A REPAIR DOES NOT DELETE WHAT IT DID NOT PUT THERE. An unexpected item is quarantined and
 *    named, never deleted: its presence is not evidence of damage to another file.
 *  - OFFLINE IS A DECISION, AND IT IS THE DEFAULT. A repair is offline unless the caller says
 *    otherwise, and an offline repair may not use a mirror; assuming a network is how an offline
 *    repair becomes a partial one. Nothing here has a network in the first place — the sources are
 *    named by the caller.
 *  - A REPAIR CANNOT INVENT CONTENT IT HAS NEVER SEEN. An item is restored from a named source or
 *    the plan is blocked by name; there is no "re-download whatever it should be".
 *  - RESTORATION FOLLOWS DEPENDENCIES, NOT ALPHABET. The order is a topological order over the
 *    items being repaired, deterministic with an alphabetical tie-break, and a cycle is refused
 *    because a cycle is not an order.
 *  - REPAIRING AN EPOCH THAT HAS BEEN SUPERSEDED IS A ROLLBACK WEARING A RECOVERY'S CLOTHES. When
 *    the caller names the superseded epochs, a census sitting on one is refused outright — no
 *    partial plan is produced.
 *  - PART OF THE WAY BACK IS NOT BACK. `verifyRepair` decides, and it says how far short.
 *
 * Scope walls (enforced by tests): no artefact store (P6.7), no epoch chain (P6.16), no admission
 * (P6.17), no freshness (P6.28), no names or trust (P6.29, P6.1). No filesystem, network, clock or
 * randomness — the caller names the sources, and the only `node:` import is the hash.
 *
 * Authority: this contract decides what is missing and what may be put back. It never fetches, and
 * it never decides whether the restored registry may serve.
 */
import { createHash } from 'node:crypto';

export const REGISTRY_REPAIR_CONTRACT = 'registry.repair@0.1.0';
export const REGISTRY_REPAIR_CONTRACT_VERSION = '0.1.0';
export const REGISTRY_REPAIR_SCHEMA_VERSION = 1;
export const REGISTRY_REPAIR_FORMAT = 'lego-repair@1';

export const REPAIR_OPERATIONS = Object.freeze(['assess', 'plan', 'order', 'verify', 'describe']);
export const REPAIR_PERMISSIONS = Object.freeze(['node:read']);

/** `intact` means every expected item matched; extras are reported, not hidden. */
export const REPAIR_VERDICTS = Object.freeze(['intact', 'recoverable', 'blocked']);

export const ITEM_STATES = Object.freeze(['intact', 'altered', 'missing', 'unexpected']);

/** Where correct bytes may come from. `mirror` is network, and network is what offline refuses. */
export const REPAIR_SOURCES = Object.freeze(['local-store', 'mirror']);

export const REPAIR_REASONS = Object.freeze([
  'repair.input', 'repair.item', 'repair.altered', 'repair.missing',
  'repair.unexpected', 'repair.order', 'repair.stale', 'repair.offline',
]);

export const REPAIR_RULES = Object.freeze({
  compare: 'a damaged registry is compared and not trusted: what should be there, by digest, against what is there',
  hash: 'an item that does not hash to its own digest is not evidence, so it is refused rather than folded in',
  keep: 'a repair does not delete what it did not put there, so an unexpected item is quarantined and named',
  offline: 'a repair is offline unless the caller says otherwise, and an offline repair may not use a mirror',
  invent: 'a repair cannot invent content it has never seen: it is restored from a named source or the plan is blocked by name',
  order: 'restoration follows dependencies and not the alphabet, and a cycle is not an order',
  stale: 'repairing to an epoch that has been superseded is a rollback wearing a recovery\'s clothes',
  partial: 'part of the way back is not back, and the answer says how far short it is',
  authority: 'this contract decides what is missing and what may be put back; it never fetches and never decides whether the registry may serve',
});

export class RepairError extends Error {
  constructor(message, { code = 'repair.input', meta = {} } = {}) {
    super(message);
    this.name = 'RepairError';
    this.code = 'lego.contract_violation';
    this.meta = { code, ...meta };
  }
}

const fail = (message, detail = {}) => { throw new RepairError(message, detail); };

const isNonEmptyString = (value) => typeof value === 'string' && value.length > 0;
const isDigest = (value) => isNonEmptyString(value) && /^[0-9a-f]{64}$/.test(String(value).replace(/^sha256:/, ''));

/** Canonical JSON: key order must not change a digest. */
export function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

export function repairDigest(fields) {
  return sha256(stableJson(fields ?? {}));
}

/** The digest of content, so a census can be checked against what it says about itself. */
export function itemDigest(content) {
  if (typeof content === 'string') return sha256(content);
  if (content !== null && typeof content === 'object') return sha256(stableJson(content));
  fail('itemDigest reads text or a JSON value', { code: 'repair.input', field: 'content' });
}

const bareDigest = (digest) => String(digest).replace(/^sha256:/, '');

/* -------------------------------------------------------------- expectations */

export function isExpectation(value) {
  return Boolean(value) && typeof value === 'object' && value.contract === REGISTRY_REPAIR_CONTRACT && isNonEmptyString(value.epoch) && Array.isArray(value.items) && isNonEmptyString(value.expectationDigest);
}

export function isCensus(value) {
  return Boolean(value) && typeof value === 'object' && value.contract === REGISTRY_REPAIR_CONTRACT && isNonEmptyString(value.epoch) && Array.isArray(value.items) && isNonEmptyString(value.censusDigest);
}

/**
 * What should be there. An empty expectation is refused: a repair with nothing to compare against
 * is a wish, and a registry that says it expects nothing cannot be found damaged.
 */
export function createExpectation({ epoch, items } = {}) {
  if (!isNonEmptyString(epoch)) fail('an expectation names the epoch it expects', { code: 'repair.input', field: 'epoch' });
  if (!Array.isArray(items) || items.length === 0) {
    fail('an expectation names at least one item: a repair with nothing to compare against is a wish', { code: 'repair.item', field: 'items' });
  }
  const seen = new Set();
  const normalized = items.map((item, index) => {
    if (item === null || typeof item !== 'object') fail(`item ${index} is not an item`, { code: 'repair.item', field: `items[${index}]` });
    if (!isNonEmptyString(item.name)) fail(`item ${index} has no name`, { code: 'repair.item', field: `items[${index}].name` });
    if (!isDigest(item.digest)) fail(`item '${item.name}' has no digest: what is expected has to be checkable`, { code: 'repair.item', field: `items[${index}].digest` });
    if (seen.has(item.name)) fail(`the expectation names '${item.name}' twice: two expectations for one name is not an expectation`, { code: 'repair.item', field: `items[${index}].name` });
    seen.add(item.name);
    return Object.freeze({ name: item.name, digest: bareDigest(item.digest) });
  });
  const body = {
    contract: REGISTRY_REPAIR_CONTRACT,
    schemaVersion: REGISTRY_REPAIR_SCHEMA_VERSION,
    epoch,
    items: Object.freeze([...normalized].sort((left, right) => left.name.localeCompare(right.name))),
  };
  return Object.freeze({ ...body, expectationDigest: repairDigest(body) });
}

/**
 * What is there. Bytes are optional, but bytes that do not hash to the digest beside them are not
 * evidence, so they are refused.
 */
export function observeRegistry({ epoch, items = [] } = {}) {
  if (!isNonEmptyString(epoch)) fail('a census names the epoch it found', { code: 'repair.input', field: 'epoch' });
  if (!Array.isArray(items)) fail('a census is a list of items', { code: 'repair.input', field: 'items' });
  const seen = new Set();
  const normalized = items.map((item, index) => {
    if (item === null || typeof item !== 'object') fail(`item ${index} is not an item`, { code: 'repair.item', field: `items[${index}]` });
    if (!isNonEmptyString(item.name)) fail(`item ${index} has no name`, { code: 'repair.item', field: `items[${index}].name` });
    if (!isDigest(item.digest)) fail(`item '${item.name}' has no digest: a census that cannot be checked is a rumour about a directory`, { code: 'repair.item', field: `items[${index}].digest` });
    if (seen.has(item.name)) fail(`the census names '${item.name}' twice: one name, one item`, { code: 'repair.item', field: `items[${index}].name` });
    seen.add(item.name);
    const source = item.source ?? 'unknown';
    if (item.source !== undefined && !REPAIR_SOURCES.includes(source)) fail(`item '${item.name}' claims source '${String(item.source)}', and sources are ${REPAIR_SOURCES.join(', ')}`, { code: 'repair.input', field: `items[${index}].source` });
    const digest = bareDigest(item.digest);
    if (item.bytes !== undefined && item.bytes !== null) {
      const computed = itemDigest(item.bytes);
      if (computed !== digest) {
        fail(`item '${item.name}' reports ${digest.slice(0, 12)}… and its bytes hash to ${computed.slice(0, 12)}…: an item that does not hash to its own digest is not evidence`, { code: 'repair.input', field: `items[${index}].bytes` });
      }
    }
    return Object.freeze({ name: item.name, digest, source, bytes: item.bytes ?? null });
  });
  const body = {
    contract: REGISTRY_REPAIR_CONTRACT,
    schemaVersion: REGISTRY_REPAIR_SCHEMA_VERSION,
    epoch,
    items: Object.freeze([...normalized].sort((left, right) => left.name.localeCompare(right.name))),
  };
  return Object.freeze({ ...body, censusDigest: repairDigest(body) });
}

/* --------------------------------------------------------------- assessment */

/** The named census of damage. Extras are reported; they do not make a matching registry not match. */
export function assessRegistry({ expected, observed } = {}) {
  if (!isExpectation(expected)) fail('assessRegistry reads an expectation made by createExpectation', { code: 'repair.input', field: 'expected' });
  if (!isCensus(observed)) fail('assessRegistry reads a census made by observeRegistry', { code: 'repair.input', field: 'observed' });
  const found = new Map(observed.items.map((item) => [item.name, item]));
  const states = { intact: [], altered: [], missing: [], unexpected: [] };
  for (const item of expected.items) {
    const present = found.get(item.name) ?? null;
    if (present === null) states.missing.push(item.name);
    else if (present.digest === item.digest) states.intact.push(item.name);
    else states.altered.push(item.name);
  }
  const expectedNames = new Set(expected.items.map((item) => item.name));
  for (const item of observed.items) {
    if (!expectedNames.has(item.name)) states.unexpected.push(item.name);
  }
  const counts = Object.freeze({
    intact: states.intact.length,
    altered: states.altered.length,
    missing: states.missing.length,
    unexpected: states.unexpected.length,
  });
  const verdict = counts.altered === 0 && counts.missing === 0 ? 'intact' : 'recoverable';
  const message = verdict === 'intact'
    ? `the registry is at epoch '${observed.epoch}' and every one of the ${expected.items.length} expected item(s) matches its digest${counts.unexpected > 0 ? `, with ${counts.unexpected} unexpected item(s) reported` : ''}`
    : `${counts.altered} altered, ${counts.missing} missing and ${counts.unexpected} unexpected item(s) against ${expected.items.length} expected`;
  const body = {
    contract: REGISTRY_REPAIR_CONTRACT,
    schemaVersion: REGISTRY_REPAIR_SCHEMA_VERSION,
    epoch: observed.epoch,
    expectedEpoch: expected.epoch,
    verdict,
    states: Object.freeze({
      intact: Object.freeze([...states.intact]),
      altered: Object.freeze([...states.altered]),
      missing: Object.freeze([...states.missing]),
      unexpected: Object.freeze([...states.unexpected]),
    }),
    counts,
  };
  return Object.freeze({ ok: verdict === 'intact', ...body, message, assessmentDigest: repairDigest(body) });
}

/* -------------------------------------------------------------------- order */

/**
 * Dependencies first, alphabetically within a level. A cycle is refused rather than broken at
 * random: a repair order that has to invent a tie-break is a repair order that has to guess.
 */
export function repairOrder({ items, dependencies = {} } = {}) {
  if (!Array.isArray(items)) fail('repairOrder takes a list of names being repaired', { code: 'repair.order', field: 'items' });
  if (dependencies === null || typeof dependencies !== 'object' || Array.isArray(dependencies)) fail('dependencies are a map of name to names', { code: 'repair.order', field: 'dependencies' });
  const names = [...new Set(items)];
  if (names.length !== items.length) fail('the list being ordered names the same item twice', { code: 'repair.order', field: 'items' });
  for (const name of names) {
    if (!isNonEmptyString(name)) fail('a name being ordered is a non-empty string', { code: 'repair.order', field: 'items' });
  }
  const known = new Set(names);
  const waitsFor = new Map(names.map((name) => [name, []]));
  for (const [name, requires] of Object.entries(dependencies)) {
    if (!Array.isArray(requires)) fail(`the dependencies of '${name}' are a list`, { code: 'repair.order', field: `dependencies.${name}` });
    if (!known.has(name)) continue;
    for (const requirement of requires) {
      if (!isNonEmptyString(requirement)) fail(`'${name}' depends on something without a name`, { code: 'repair.order', field: `dependencies.${name}` });
      if (!known.has(requirement)) {
        fail(`'${name}' needs '${requirement}', which is not part of this repair: an order over a set that is not closed cannot be computed`, { code: 'repair.order', field: `dependencies.${name}` });
      }
      waitsFor.get(name).push(requirement);
    }
  }
  const ordered = [];
  const placed = new Set();
  while (placed.size < names.length) {
    const ready = names.filter((name) => !placed.has(name) && waitsFor.get(name).every((requirement) => placed.has(requirement))).sort();
    if (ready.length === 0) {
      const stuck = names.filter((name) => !placed.has(name)).sort();
      fail(`a cycle is not an order: ${stuck.join(', ')} are waiting on each other`, { code: 'repair.order', field: 'dependencies' });
    }
    for (const name of ready) placed.add(name);
    ordered.push(...ready);
  }
  return Object.freeze(ordered);
}

/* --------------------------------------------------------------------- plan */

/**
 * The plan names every step and refuses to guess: what is restored, from where, in which order, and
 * what is quarantined rather than deleted.
 */
export function planRepair({ expected, observed, dependencies = {}, policy = {} } = {}) {
  if (!isExpectation(expected)) fail('planRepair reads an expectation made by createExpectation', { code: 'repair.input', field: 'expected' });
  if (!isCensus(observed)) fail('planRepair reads a census made by observeRegistry', { code: 'repair.input', field: 'observed' });
  if (policy === null || typeof policy !== 'object' || Array.isArray(policy)) fail('policy is a map', { code: 'repair.input', field: 'policy' });
  const offline = policy.offline ?? true;
  if (typeof offline !== 'boolean') fail('offline is a boolean, and it defaults to true', { code: 'repair.input', field: 'policy.offline' });
  const superseded = policy.supersededEpochs ?? [];
  if (!Array.isArray(superseded) || superseded.some((entry) => !isNonEmptyString(entry))) {
    fail('supersededEpochs is a list of epoch names', { code: 'repair.input', field: 'policy.supersededEpochs' });
  }
  const available = policy.available ?? {};
  if (available === null || typeof available !== 'object' || Array.isArray(available)) fail('available is a map of name to source', { code: 'repair.input', field: 'policy.available' });
  for (const [name, source] of Object.entries(available)) {
    if (!REPAIR_SOURCES.includes(source)) fail(`the source named for '${name}' is '${String(source)}', and sources are ${REPAIR_SOURCES.join(', ')}`, { code: 'repair.input', field: `policy.available.${name}` });
  }

  const expectedDigests = new Map(expected.items.map((item) => [item.name, item.digest]));

  if (superseded.includes(observed.epoch)) {
    const body = {
      contract: REGISTRY_REPAIR_CONTRACT,
      schemaVersion: REGISTRY_REPAIR_SCHEMA_VERSION,
      epoch: observed.epoch,
      offline,
      intact: Object.freeze([]),
      steps: Object.freeze([]),
      blocked: Object.freeze([Object.freeze({ name: observed.epoch, reason: 'repair.stale' })]),
    };
    return Object.freeze({
      ok: false,
      ...body,
      verdict: 'blocked',
      reason: 'repair.stale',
      message: `the census is at epoch '${observed.epoch}', which has been superseded: repairing to an epoch that has been superseded is a rollback wearing a recovery's clothes`,
      planDigest: repairDigest(body),
    });
  }

  const assessment = assessRegistry({ expected, observed });
  const toRestore = [...assessment.states.altered, ...assessment.states.missing].sort();
  const blocked = [];
  const restorable = [];
  for (const name of toRestore) {
    const source = available[name] ?? null;
    const state = assessment.states.altered.includes(name) ? 'altered' : 'missing';
    if (source === null) {
      blocked.push(Object.freeze({ name, reason: 'repair.missing', message: `nothing has the bytes for '${name}': a repair cannot invent content it has never seen` }));
      continue;
    }
    if (offline && source === 'mirror') {
      blocked.push(Object.freeze({ name, reason: 'repair.offline', message: `this repair is offline and the only source for '${name}' is a mirror` }));
      continue;
    }
    restorable.push({ name, source, reason: state === 'altered' ? 'repair.altered' : 'repair.missing' });
  }

  const restricted = {};
  for (const [name, requires] of Object.entries(dependencies)) {
    if (!restorable.some((entry) => entry.name === name)) continue;
    restricted[name] = requires.filter((requirement) => restorable.some((entry) => entry.name === requirement));
  }
  const order = repairOrder({ items: restorable.map((entry) => entry.name), dependencies: restricted });
  const byName = new Map(restorable.map((entry) => [entry.name, entry]));
  const steps = [
    ...order.map((name) => Object.freeze({
      action: 'restore',
      name,
      digest: expectedDigests.get(name),
      source: byName.get(name).source,
      reason: byName.get(name).reason,
      message: `restore '${name}' from the ${byName.get(name).source}`,
    })),
    ...[...assessment.states.unexpected].sort().map((name) => Object.freeze({
      action: 'quarantine',
      name,
      digest: null,
      source: null,
      reason: 'repair.unexpected',
      message: `quarantine '${name}', which nothing expected: a repair does not delete what it did not put there`,
    })),
  ];
  const verdict = blocked.length > 0 ? 'blocked' : steps.length === 0 ? 'intact' : 'recoverable';
  const body = {
    contract: REGISTRY_REPAIR_CONTRACT,
    schemaVersion: REGISTRY_REPAIR_SCHEMA_VERSION,
    epoch: observed.epoch,
    expectedEpoch: expected.epoch,
    offline,
    intact: Object.freeze([...assessment.states.intact]),
    steps: Object.freeze(steps),
    blocked: Object.freeze(blocked),
  };
  const restores = steps.filter((step) => step.action === 'restore').length;
  const quarantines = steps.filter((step) => step.action === 'quarantine').length;
  const message = verdict === 'intact'
    ? `the registry matches epoch '${expected.epoch}': nothing to repair${quarantines > 0 ? `, ${quarantines} unexpected item(s) quarantined` : ''}`
    : verdict === 'blocked'
      ? `the repair is blocked on ${blocked.map((entry) => `'${entry.name}' (${entry.reason})`).join(', ')}: ${restores} step(s) are still planned and are not a repair on their own`
      : `${restores} item(s) to restore and ${quarantines} to quarantine, ${offline ? 'offline, using only what is already on this machine' : 'online, from the sources named'}`;
  return Object.freeze({ ok: verdict !== 'blocked', ...body, verdict, reason: verdict === 'blocked' ? blocked[0].reason : null, message, planDigest: repairDigest(body) });
}

/* ---------------------------------------------------------------- verifying */

/** Part of the way back is not back. */
export function verifyRepair({ expected, observed } = {}) {
  if (!isExpectation(expected)) fail('verifyRepair reads an expectation made by createExpectation', { code: 'repair.input', field: 'expected' });
  if (!isCensus(observed)) fail('verifyRepair reads a census made by observeRegistry', { code: 'repair.input', field: 'observed' });
  const assessment = assessRegistry({ expected, observed });
  const remaining = [...assessment.states.altered, ...assessment.states.missing].sort();
  const verified = remaining.length === 0;
  const body = {
    contract: REGISTRY_REPAIR_CONTRACT,
    schemaVersion: REGISTRY_REPAIR_SCHEMA_VERSION,
    epoch: observed.epoch,
    expectedEpoch: expected.epoch,
    verdict: verified ? 'verified' : 'partial',
    remaining: Object.freeze(remaining),
  };
  return Object.freeze({
    ok: verified,
    ...body,
    message: verified
      ? `every item the expectation names is present at epoch '${observed.epoch}' and matches its digest`
      : `${remaining.length} item(s) still do not match (${remaining.join(', ')}): a registry that is part of the way back is not a registry that works`,
    repairDigest: repairDigest(body),
  });
}

/* ------------------------------------------------------------------- reads */

export function describeRepair(plan) {
  if (!plan || typeof plan !== 'object' || !REPAIR_VERDICTS.includes(plan.verdict) || !isNonEmptyString(plan.planDigest)) {
    fail('describeRepair reads a plan made by planRepair', { code: 'repair.input', field: 'plan' });
  }
  const actions = { restore: 0, quarantine: 0 };
  for (const step of plan.steps) actions[step.action] += 1;
  const body = {
    contract: REGISTRY_REPAIR_CONTRACT,
    format: REGISTRY_REPAIR_FORMAT,
    epoch: plan.epoch,
    verdict: plan.verdict,
    offline: plan.offline,
    actions: Object.freeze(actions),
    intact: plan.intact.length,
    blocked: Object.freeze(plan.blocked.map((entry) => `${entry.name} (${entry.reason})`)),
    names: Object.freeze(plan.steps.map((step) => `${step.action}:${step.name}`)),
  };
  return Object.freeze({
    ...body,
    message: plan.verdict === 'blocked'
      ? `blocked: ${body.blocked.length} item(s) cannot be put back and ${actions.restore} restorable step(s) wait on them`
      : `${actions.restore} to restore, ${actions.quarantine} to quarantine, ${plan.intact.length} already intact${plan.offline ? ' (offline)' : ' (online)'}`,
    planDigest: plan.planDigest,
  });
}

export function explainRepair(result) {
  if (!result || typeof result !== 'object' || !isNonEmptyString(result.message) || (!REPAIR_VERDICTS.includes(result.verdict) && result.verdict !== 'verified' && result.verdict !== 'partial')) {
    fail('explainRepair reads a result made by assessRegistry, planRepair or verifyRepair', { code: 'repair.input', field: 'result' });
  }
  return `${String(result.verdict).toUpperCase()} — ${result.message}`;
}
