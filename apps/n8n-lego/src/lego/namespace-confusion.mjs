/**
 * node.namespace@0.1.0 — name claims, handovers and the confusion between them.
 *
 * P6 milestone 29 of 31 (Issue #100). Every other contract in this registry identifies a node by
 * `type@typeVersion`; this one is about the part in front of that — the NAME — because a name that
 * means two things quietly is how a dependency gets swapped for another one that runs.
 *
 * The four confusions this contract exists for:
 *
 *   TYPOSQUAT    a name one keystroke away from a name somebody already trusted;
 *   SHADOWING    a public claim answering a private name, or the other way round;
 *   HANDOVER     a name that changed publisher without anybody saying so;
 *   SPELLING     two spellings folded into one key, or one spelling quietly standing for two.
 *
 * What it adds:
 *
 *  - A CLAIM IS MADE BY KEY, NOT BY SPELLING. `Some-Node` and `some-node` are one name, and the
 *    second claim is refused rather than stored beside the first. A name that needs a second look
 *    is a name that lies, so anything outside plain ASCII letters, digits, `.`, `_`, `-` — and any
 *    whitespace, however invisible — is refused with the character and its position named.
 *  - A NAME THAT CHANGES HANDS QUIETLY IS NOT AN UPDATE. Resolving a known name to a different
 *    publisher is `name-reused` unless a handover was declared; and a handover does not travel
 *    backwards, because a claim before the handover is the claim the handover replaced.
 *  - A NAME ARRIVING ONE EDIT FROM ANOTHER IS A CONFUSION, NOT A NEW NAME — unless the name it is
 *    close to is the claimant's own, which is a deliberate relative rather than a swap.
 *  - VISIBILITY IS PART OF THE NAME. A public claim does not answer a private name and a private
 *    claim does not answer a public one: the public registry answering a private name is the
 *    oldest confusion there is.
 *
 * Scope walls (enforced by tests): no resolution against a workflow (P6.14), no registry epoch
 * (P6.16), no admission (P6.17), no freshness (P6.28), no trust classes (P6.1), no distance to a
 * package that is not claimed here. No filesystem, network, clock or randomness — every answer
 * takes the tick it answers for — and the only `node:` import is the hash.
 *
 * Authority: this contract decides whether a name is the name that was meant. It never decides
 * whether the node behind it may run.
 */
import { createHash } from 'node:crypto';

export const NAMESPACE_CONTRACT = 'node.namespace@0.1.0';
export const NAMESPACE_CONTRACT_VERSION = '0.1.0';
export const NAMESPACE_SCHEMA_VERSION = 1;
export const NAMESPACE_FORMAT = 'lego-namespace@1';

export const NAMESPACE_OPERATIONS = Object.freeze(['claim', 'resolve', 'handover', 'compare', 'describe']);
export const NAMESPACE_PERMISSIONS = Object.freeze(['node:read']);

/** A name is public or private, and which one it is, is part of what it means. */
export const CLAIM_VISIBILITIES = Object.freeze(['public', 'private']);

export const NAMESPACE_VERDICTS = Object.freeze(['same-publisher', 'handover', 'new-name', 'unknown', 'name-reused', 'typosquat', 'shadowed']);

export const NAMESPACE_REASONS = Object.freeze([
  'namespace.input', 'namespace.name', 'namespace.claim', 'namespace.reuse',
  'namespace.typosquat', 'namespace.shadow', 'namespace.handover', 'namespace.tick',
]);

/** The npm limit, adopted because a name longer than this is not a name anybody types. */
export const MAX_NAME_LENGTH = 214;

export const NAMESPACE_RULES = Object.freeze({
  key: 'a claim is made by key and not by spelling: two spellings of one name are one name',
  ascii: 'a name that needs a second look is a name that lies, so anything outside plain ASCII letters, digits, dot, underscore and dash is refused',
  quiet: 'a name that changes hands quietly is how a dependency is swapped, so a handover has to be declared to be accepted',
  backwards: 'a handover does not travel backwards: a claim before the handover is the claim the handover replaced',
  relatives: 'a name one edit from another is a confusion unless the near neighbour belongs to the claimant',
  visibility: 'the public registry answering a private name is the oldest confusion there is',
  authority: 'this contract decides whether a name is the name that was meant; it never decides whether the node behind it may run',
});

export class NamespaceError extends Error {
  constructor(message, { code = 'namespace.input', meta = {} } = {}) {
    super(message);
    this.name = 'NamespaceError';
    this.code = 'lego.contract_violation';
    this.meta = { code, ...meta };
  }
}

const fail = (message, detail = {}) => { throw new NamespaceError(message, detail); };

const isNonEmptyString = (value) => typeof value === 'string' && value.length > 0;
const isTick = (value) => Number.isInteger(value) && value >= 0;

/** Canonical JSON: key order must not change a digest. */
export function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

export function namespaceDigest(fields) {
  return sha256(stableJson(fields ?? {}));
}

const NAME_PART = /^[a-z0-9][a-z0-9._-]*$/;
const asCodePoint = (codePoint) => `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`;

/* -------------------------------------------------------------------- names */

/**
 * The canonical spelling of a name, or a refusal that names the character that made it impossible.
 */
export function normalizeName(name) {
  if (!isNonEmptyString(name)) fail('a name is a non-empty string', { code: 'namespace.input', field: 'name' });
  if (name.length > MAX_NAME_LENGTH) {
    fail(`the name is ${name.length} characters and the limit is ${MAX_NAME_LENGTH}: a name longer than that is not a name anybody types`, { code: 'namespace.input', field: 'name' });
  }
  if (name !== name.trim()) {
    fail(`'${name}' has whitespace around it: a name with whitespace around it is not the name anybody means`, { code: 'namespace.name', field: 'name' });
  }
  for (let index = 0; index < name.length; index += 1) {
    const codePoint = name.codePointAt(index);
    if (codePoint > 0x7f) {
      fail(`a name that needs a second look is a name that lies: '${name}' carries ${asCodePoint(codePoint)} at position ${index}`, { code: 'namespace.name', field: 'name' });
    }
  }
  if (/\s/.test(name)) fail(`'${name}' carries whitespace: an invisible character is how two names are made to look like one`, { code: 'namespace.name', field: 'name' });

  const canonical = name.toLowerCase();
  if (canonical.startsWith('@')) {
    const parts = canonical.split('/');
    if (parts.length !== 2) fail(`'${name}' is scoped and has no name after the scope: a scope is not a package`, { code: 'namespace.name', field: 'name' });
    const [scope, rest] = parts;
    if (!NAME_PART.test(scope.slice(1))) fail(`the scope in '${name}' is not a scope: scopes start with a letter or digit and carry no slashes of their own`, { code: 'namespace.name', field: 'name' });
    if (!NAME_PART.test(rest)) fail(`the name after the scope in '${name}' is not a name`, { code: 'namespace.name', field: 'name' });
    return canonical;
  }
  if (canonical.includes('/')) fail(`'${name}' carries a slash and no scope: a slashed name is a scoped name, and a name that looks scoped without being scoped is a confusion`, { code: 'namespace.name', field: 'name' });
  if (!NAME_PART.test(canonical)) fail(`'${name}' is not a name: names in this registry are ASCII letters, digits, dot, underscore and dash, starting with a letter or digit`, { code: 'namespace.name', field: 'name' });
  return canonical;
}

/** The key a claim is made under. `Some-Node` and `some-node` share it, and that is the point. */
export function nameKey(name) {
  return normalizeName(name);
}

/** Optimal string alignment: one insertion, deletion, substitution or transposition is one edit. */
export function nameDistance(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') fail('nameDistance compares two names', { code: 'namespace.input', field: 'name' });
  if (left === right) return 0;
  const rows = left.length + 1;
  const cols = right.length + 1;
  const table = Array.from({ length: rows }, () => new Array(cols).fill(0));
  for (let row = 0; row < rows; row += 1) table[row][0] = row;
  for (let column = 0; column < cols; column += 1) table[0][column] = column;
  for (let row = 1; row < rows; row += 1) {
    for (let column = 1; column < cols; column += 1) {
      const cost = left[row - 1] === right[column - 1] ? 0 : 1;
      let best = Math.min(table[row - 1][column] + 1, table[row][column - 1] + 1, table[row - 1][column - 1] + cost);
      if (row > 1 && column > 1 && left[row - 1] === right[column - 2] && left[row - 2] === right[column - 1]) {
        best = Math.min(best, table[row - 2][column - 2] + 1);
      }
      table[row][column] = best;
    }
  }
  return table[rows - 1][cols - 1];
}

/** Identical names are not "confusable" — they are the same name, and that is a claim, not a typo. */
export function isNearConfusable(name, other, { maxDistance = 1 } = {}) {
  if (!Number.isInteger(maxDistance) || maxDistance < 0) {
    fail(`maxDistance '${String(maxDistance)}' is not a whole number of edits`, { code: 'namespace.input', field: 'maxDistance' });
  }
  const distance = nameDistance(normalizeName(name), normalizeName(other));
  return distance > 0 && distance <= maxDistance;
}

/* -------------------------------------------------------------------- state */

export function createNamespaceState() {
  return { contract: NAMESPACE_CONTRACT, schemaVersion: NAMESPACE_SCHEMA_VERSION, claims: [], handovers: [] };
}

export function isNamespaceState(value) {
  return Boolean(value) && typeof value === 'object' && value.contract === NAMESPACE_CONTRACT && Array.isArray(value.claims) && Array.isArray(value.handovers);
}

export function isNameClaim(value) {
  return Boolean(value) && typeof value === 'object' && value.contract === NAMESPACE_CONTRACT && isNonEmptyString(value.nameKey) && isNonEmptyString(value.claimDigest);
}

export function isHandover(value) {
  return Boolean(value) && typeof value === 'object' && value.contract === NAMESPACE_CONTRACT && isNonEmptyString(value.to) && isNonEmptyString(value.handoverDigest);
}

const requireState = (state, fn) => {
  if (!isNamespaceState(state)) fail(`${fn} reads a namespace state made by createNamespaceState`, { code: 'namespace.input', field: 'state' });
};

const claimFor = (state, key) => state.claims.find((claim) => claim.nameKey === key) ?? null;

const handoversFor = (state, key) => state.handovers.filter((handover) => handover.nameKey === key).sort((left, right) => left.tick - right.tick);

/**
 * A name is claimed once. The second claim is a handover or it is a confusion — it is never stored
 * beside the first, because two claims under one name is exactly the state this contract exists to
 * prevent.
 */
export function claimName(state, { name, publisher, visibility = 'public', tick } = {}) {
  requireState(state, 'claimName');
  const canonical = normalizeName(name);
  if (!isNonEmptyString(publisher)) fail('a claim names the publisher holding the name', { code: 'namespace.claim', field: 'publisher' });
  if (!CLAIM_VISIBILITIES.includes(visibility)) fail(`visibility '${String(visibility)}' is one of ${CLAIM_VISIBILITIES.join(', ')}`, { code: 'namespace.input', field: 'visibility' });
  if (!isTick(tick)) fail('a claim happens at a tick', { code: 'namespace.input', field: 'tick' });

  const existing = claimFor(state, canonical);
  if (existing) {
    if (name !== canonical) {
      fail(`'${name}' is not a spelling that exists: it folds to '${canonical}', which is already claimed by ${existing.publisher} — two spellings of one name are one name`, { code: 'namespace.claim', field: 'name' });
    }
    fail(`'${canonical}' is already claimed by ${existing.publisher} since tick ${existing.tick}: a second claim is a handover or a confusion, never a quiet overwrite`, { code: 'namespace.claim', field: 'name' });
  }

  const body = {
    contract: NAMESPACE_CONTRACT,
    schemaVersion: NAMESPACE_SCHEMA_VERSION,
    name: canonical,
    nameKey: canonical,
    publisher,
    visibility,
    tick,
  };
  const claim = Object.freeze({ ...body, claimDigest: namespaceDigest(body) });
  state.claims.push(claim);
  return Object.freeze({ ok: true, claim, message: `'${canonical}' is claimed by ${publisher} (${visibility}) since tick ${tick}` });
}

/**
 * A handover is an accusation until it is evidenced: it names who held the name, who takes it, when
 * it takes effect, and on what grounds.
 */
export function createHandover(state, { name, from, to, tick, evidence } = {}) {
  requireState(state, 'createHandover');
  const canonical = normalizeName(name);
  const claim = claimFor(state, canonical);
  if (!claim) fail(`there is nothing to hand over: '${canonical}' has never been claimed`, { code: 'namespace.handover', field: 'name' });
  if (!isNonEmptyString(from) || !isNonEmptyString(to)) fail('a handover names both the publisher it leaves and the one it goes to', { code: 'namespace.handover', field: 'from' });
  if (from === to) fail(`'${canonical}' cannot be handed from '${from}' to itself`, { code: 'namespace.handover', field: 'to' });
  if (!isNonEmptyString(evidence)) fail(`a handover of '${canonical}' without evidence is a rumour with a timestamp`, { code: 'namespace.handover', field: 'evidence' });
  if (!isTick(tick)) fail('a handover happens at a tick', { code: 'namespace.input', field: 'tick' });
  if (tick < claim.tick) fail(`'${canonical}' was claimed at tick ${claim.tick} and cannot be handed over at tick ${tick}: a handover does not travel backwards`, { code: 'namespace.tick', field: 'tick' });

  const history = handoversFor(state, canonical);
  const holder = history.length === 0 ? claim.publisher : history[history.length - 1].to;
  if (holder !== from) {
    fail(`'${canonical}' is held by '${holder}' and not by '${from}': a handover from somebody who does not hold the name is a wish`, { code: 'namespace.handover', field: 'from' });
  }
  if (history.length > 0 && tick < history[history.length - 1].tick) {
    fail(`'${canonical}' was handed over at tick ${history[history.length - 1].tick} and this handover is at tick ${tick}: a handover does not travel backwards`, { code: 'namespace.tick', field: 'tick' });
  }

  const body = {
    contract: NAMESPACE_CONTRACT,
    schemaVersion: NAMESPACE_SCHEMA_VERSION,
    name: canonical,
    nameKey: canonical,
    from,
    to,
    tick,
    evidence,
  };
  const handover = Object.freeze({ ...body, handoverDigest: namespaceDigest(body) });
  state.handovers.push(handover);
  return Object.freeze({ ok: true, handover, message: `'${canonical}' is handed from ${from} to ${to} at tick ${tick}` });
}

/** Who holds the name at a tick: the claim, or the latest handover that had already happened. */
export function effectivePublisher(state, name, tick) {
  requireState(state, 'effectivePublisher');
  const canonical = normalizeName(name);
  if (!isTick(tick)) fail('effectivePublisher takes the tick it answers for', { code: 'namespace.input', field: 'tick' });
  const claim = claimFor(state, canonical);
  if (!claim) return Object.freeze({ ok: false, reason: 'namespace.name', name: canonical, publisher: null, since: null, via: null, message: `'${canonical}' has never been claimed, so it has no publisher` });
  const effective = handoversFor(state, canonical).filter((handover) => handover.tick <= tick);
  const last = effective.length === 0 ? null : effective[effective.length - 1];
  return Object.freeze({
    ok: true,
    name: canonical,
    publisher: last === null ? claim.publisher : last.to,
    since: last === null ? claim.tick : last.tick,
    via: last === null ? 'claim' : 'handover',
    handover: last,
    message: last === null
      ? `'${canonical}' has belonged to ${claim.publisher} since tick ${claim.tick}`
      : `'${canonical}' has belonged to ${last.to} since the handover at tick ${last.tick}`,
  });
}

/* --------------------------------------------------------------- resolution */

const verdictOf = (verdict, reason, message, extra = {}) => Object.freeze({ ok: verdict === 'same-publisher' || verdict === 'handover' || verdict === 'new-name', verdict, reason, message, ...extra });

/**
 * The one decision: is this name the name that was meant? A refusal here is not a failure — it is
 * the answer that stops a swap.
 */
export function resolveName(state, { name, publisher, tick, visibility = 'public', policy = {} } = {}) {
  requireState(state, 'resolveName');
  const canonical = normalizeName(name);
  if (!isNonEmptyString(publisher)) fail('resolution names the publisher asking for the name', { code: 'namespace.input', field: 'publisher' });
  if (!CLAIM_VISIBILITIES.includes(visibility)) fail(`visibility '${String(visibility)}' is one of ${CLAIM_VISIBILITIES.join(', ')}`, { code: 'namespace.input', field: 'visibility' });
  if (!isTick(tick)) fail('resolution happens at a tick', { code: 'namespace.input', field: 'tick' });
  if (policy === null || typeof policy !== 'object' || Array.isArray(policy)) fail('policy is a map', { code: 'namespace.input', field: 'policy' });
  const maxDistance = policy.maxDistance ?? 1;
  if (!Number.isInteger(maxDistance) || maxDistance < 1) {
    fail(`maxDistance '${String(maxDistance)}' is not a whole number from 1: looking for a confusion with no edits allowed is looking for the exact name`, { code: 'namespace.input', field: 'policy.maxDistance' });
  }

  const claim = claimFor(state, canonical);
  if (!claim) {
    const similar = state.claims
      .filter((known) => known.visibility === visibility && isNearConfusable(canonical, known.name, { maxDistance }))
      .map((known) => Object.freeze({ name: known.name, publisher: known.publisher, distance: nameDistance(canonical, known.name) }))
      .sort((left, right) => (left.distance - right.distance) || left.name.localeCompare(right.name));
    if (similar.length > 0 && similar.every((entry) => entry.publisher === publisher)) {
      return verdictOf('new-name', null, `nothing here has ever been called '${canonical}', and it is close to ${similar.map((entry) => `'${entry.name}'`).join(', ')} — which ${publisher} already holds, so this is a relative rather than a swap`, {
        name: canonical, publisher, similar: Object.freeze(similar),
        decisionDigest: namespaceDigest({ name: canonical, publisher, tick, visibility, verdict: 'new-name' }),
      });
    }
    if (similar.length > 0) {
      return verdictOf('typosquat', 'namespace.typosquat', `nothing here has ever been called '${canonical}', and it is ${similar[0].distance} edit(s) from ${similar.map((entry) => `'${entry.name}' (${entry.publisher})`).join(', ')}: a name that arrives one keystroke from another is how a package is swapped`, {
        name: canonical, publisher, similar: Object.freeze(similar),
        decisionDigest: namespaceDigest({ name: canonical, publisher, tick, visibility, verdict: 'typosquat', similar }),
      });
    }
    return verdictOf('unknown', 'namespace.name', `nothing in this registry has ever been called '${canonical}': an unknown name is not a claim on it`, {
      name: canonical, publisher,
      decisionDigest: namespaceDigest({ name: canonical, publisher, tick, visibility, verdict: 'unknown' }),
    });
  }

  const base = { name: canonical, publisher, claim, tick, visibility };

  if (claim.visibility !== visibility) {
    const message = claim.visibility === 'private'
      ? `a public claim does not answer the private name '${canonical}': the public registry answering a private name is the oldest confusion there is`
      : `a private claim does not answer the public name '${canonical}': '${canonical}' is claimed publicly by ${claim.publisher}`;
    return verdictOf('shadowed', 'namespace.shadow', message, {
      ...base,
      decisionDigest: namespaceDigest({ name: canonical, publisher, tick, visibility, verdict: 'shadowed', claim: claim.claimDigest }),
    });
  }

  const history = handoversFor(state, canonical);
  const effective = history.filter((handover) => handover.tick <= tick);
  const current = effective.length === 0 ? null : effective[effective.length - 1];

  if (current !== null && current.to === publisher) {
    return verdictOf('handover', null, `'${canonical}' changed hands from ${current.from} to ${current.to} at tick ${current.tick} and this claim is at tick ${tick}`, {
      ...base, handover: current,
      decisionDigest: namespaceDigest({ name: canonical, publisher, tick, visibility, verdict: 'handover', claim: claim.claimDigest, handover: current.handoverDigest }),
    });
  }

  if (current === null && claim.publisher === publisher) {
    return verdictOf('same-publisher', null, `'${canonical}' has belonged to ${publisher} since tick ${claim.tick}`, {
      ...base,
      decisionDigest: namespaceDigest({ name: canonical, publisher, tick, visibility, verdict: 'same-publisher', claim: claim.claimDigest }),
    });
  }

  const future = history.find((handover) => handover.to === publisher && handover.tick > tick) ?? null;
  if (future !== null) {
    return verdictOf('name-reused', 'namespace.tick', `a handover does not travel backwards: '${canonical}' becomes ${publisher}'s at tick ${future.tick} and this claim is at tick ${tick}`, {
      ...base, handover: future,
      decisionDigest: namespaceDigest({ name: canonical, publisher, tick, visibility, verdict: 'name-reused', future: future.handoverDigest }),
    });
  }
  if (current !== null && current.from === publisher) {
    return verdictOf('name-reused', 'namespace.reuse', `'${canonical}' changed hands at tick ${current.tick} from ${current.from} to ${current.to}: a name that has been handed over does not come back to ${publisher}`, {
      ...base, handover: current,
      decisionDigest: namespaceDigest({ name: canonical, publisher, tick, visibility, verdict: 'name-reused', handover: current.handoverDigest }),
    });
  }
  if (history.length > 0) {
    return verdictOf('name-reused', 'namespace.reuse', `'${canonical}' changed hands at tick ${history[0].tick} (${history[0].from} → ${history[0].to}) and ${publisher} was never part of it: a third publisher arriving is not a handover`, {
      ...base, handover: history[0],
      decisionDigest: namespaceDigest({ name: canonical, publisher, tick, visibility, verdict: 'name-reused', handover: history[0].handoverDigest }),
    });
  }
  return verdictOf('name-reused', 'namespace.reuse', `'${canonical}' has belonged to ${claim.publisher} since tick ${claim.tick} and ${publisher} is asking for it: a name that changes hands quietly is how a dependency is swapped`, {
    ...base,
    decisionDigest: namespaceDigest({ name: canonical, publisher, tick, visibility, verdict: 'name-reused', claim: claim.claimDigest }),
  });
}

/* -------------------------------------------------------------------- reads */

export function describeNamespace(state) {
  requireState(state, 'describeNamespace');
  const claims = [...state.claims].sort((left, right) => left.nameKey.localeCompare(right.nameKey));
  const handovers = [...state.handovers].sort((left, right) => (left.tick - right.tick) || left.nameKey.localeCompare(right.nameKey));
  const body = {
    contract: NAMESPACE_CONTRACT,
    format: NAMESPACE_FORMAT,
    claims: Object.freeze(claims.map((claim) => Object.freeze({ name: claim.name, publisher: claim.publisher, visibility: claim.visibility, tick: claim.tick }))),
    handovers: Object.freeze(handovers.map((handover) => Object.freeze({ name: handover.name, from: handover.from, to: handover.to, tick: handover.tick }))),
    publishers: Object.freeze([...new Set(claims.map((claim) => claim.publisher))].sort()),
    counts: Object.freeze({ claims: claims.length, handovers: handovers.length, private: claims.filter((claim) => claim.visibility === 'private').length }),
    message: claims.length === 0
      ? 'no name has been claimed, so every name is a first contact'
      : `${claims.length} name(s) claimed by ${new Set(claims.map((claim) => claim.publisher)).size} publisher(s), ${handovers.length} handover(s)`,
  };
  return Object.freeze({ ...body, namespaceDigest: namespaceDigest(body) });
}

export function explainNamespace(result) {
  if (!result || typeof result !== 'object' || !NAMESPACE_VERDICTS.includes(result.verdict)) {
    fail('explainNamespace reads a result made by resolveName', { code: 'namespace.input', field: 'result' });
  }
  return `${result.name}: ${result.verdict.toUpperCase()} — ${result.message}`;
}
