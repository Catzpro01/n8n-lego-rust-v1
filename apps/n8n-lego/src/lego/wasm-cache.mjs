/**
 * runtime.wasm-cache@0.1.0 — the WASM compilation cache.
 *
 * P6 milestone 26 of 31 (Issue #100). A cache is where a wrong answer hides: it is fast, it is
 * shared, and when it hands back the wrong thing it does so with the authority of "we already
 * checked that". This contract is the part of the runtime that decides what a cached module is
 * identified by, what happens when it is wrong, and what may be thrown away.
 *
 * What it adds:
 *
 *  - THE KEY IS CONTENT AND TOOLCHAIN, NOT A NAME OR A TIME. Two modules compiled from one
 *    artifact by different engines are different objects, so the key includes the artifact
 *    digest, the wire contract, the ABI version and the toolchain. A cache keyed by a path or
 *    "latest" is a cache that answers yesterday's question today.
 *  - A FAILED COMPILATION IS A FACT, CACHED WITH ITS REASON. Negative entries exist so the same
 *    broken artifact is not recompiled on every request — and because the toolchain is part of
 *    the key, a new toolchain asks the question again instead of inheriting yesterday's failure.
 *  - A HIT IS NOT A GUESS. Every entry carries the digest of the module it holds, and a caller
 *    can verify what it actually got before running it.
 *  - A MODULE IN USE IS NEVER EVICTED. Eviction takes the least recently used IDLE entry; when
 *    every entry is in use the insert is REFUSED instead of throwing away something that is
 *    running — the alternative is a cache that produces a crash and calls it capacity.
 *  - ONE KEY HOLDS ONE MODULE. An insert whose module digest differs from the entry already
 *    under that key is refused: two modules for one key means the key does not identify what it
 *    caches, and a declaration that does not match the cached content is how a poisoned module
 *    gets a good name.
 *
 * Scope walls (enforced by tests): no compilation, no engine, no bytecode inspection and no
 * WebAssembly API — the caller compiles and reports what happened; no artifact declaration
 * (P6.25 — digests arrive as data); no leases (P6.22) or placement (P6.24); no loading of bytes
 * from anywhere. No filesystem, network, clock, randomness — the only `node:` import is the hash
 * and every answer takes the tick it answers for.
 *
 * Authority: this contract decides what a cache may return and what it may throw away. It never
 * compiles, never executes, and never decides that a module is safe to run.
 */
import { createHash } from 'node:crypto';

export const WASM_CACHE_CONTRACT = 'runtime.wasm-cache@0.1.0';
export const WASM_CACHE_CONTRACT_VERSION = '0.1.0';
export const WASM_CACHE_SCHEMA_VERSION = 1;

export const WASM_CACHE_OPERATIONS = Object.freeze(['lookup', 'insert', 'adopt', 'release', 'invalidate', 'describe']);
export const WASM_CACHE_PERMISSIONS = Object.freeze(['node:read']);

/** What a lookup can say. `negative` is a cached failure, which is not a miss. */
export const CACHE_LOOKUP_STATES = Object.freeze(['hit', 'negative', 'miss']);

/** What an entry holds. */
export const CACHE_ENTRY_OUTCOMES = Object.freeze(['compiled', 'failed']);

export const DEFAULT_MAX_ENTRIES = 64;
export const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

export const WASM_CACHE_REASONS = Object.freeze([
  'cache.input', 'cache.key', 'cache.insert', 'cache.capacity', 'cache.lookup', 'cache.invalidate',
]);

export const WASM_CACHE_RULES = Object.freeze({
  key: 'the key is the artifact digest, the wire contract, the ABI version and the toolchain: a cache keyed by a name is a cache that answers a different question',
  negative: 'a failed compilation is cached as a fact with its reason, and a new toolchain asks the question again',
  verify: 'a hit is not a guess: every entry carries the digest of the module it holds, and the caller can verify what it got',
  inUse: 'a module in use is never evicted: when every entry is in use the insert is refused rather than throwing away something running',
  oneModule: 'one key holds one module: two modules for one key means the key does not identify what it caches',
  declaration: 'cached content that does not match its declaration is how a poisoned module gets a good name',
  authority: 'this contract decides what a cache may return and throw away; it never compiles or executes anything',
});

export class WasmCacheError extends Error {
  constructor(message, { code = 'cache.input', meta = {} } = {}) {
    super(message);
    this.name = 'WasmCacheError';
    this.code = 'lego.contract_violation';
    this.meta = { code, ...meta };
  }
}

const fail = (message, detail = {}) => { throw new WasmCacheError(message, detail); };

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

/** Digests are read by people: the prefix is noise, and twelve characters are enough to point at. */
const shortDigest = (value) => String(value ?? '').replace(/^sha256:/, '').slice(0, 12);

/** A digest over a set of fields, so a cache census can be cited by content. */
export function cacheDigest(fields) {
  return sha256(stableJson(fields ?? {}));
}

/* ---------------------------------------------------------------------- key */

/**
 * Everything that changes what a compiled module IS goes into the key. Leaving the toolchain out
 * is the classic mistake: the artifact did not change, and the module did.
 */
export function cacheKey({ artifactDigest, ioDigest: wireDigest, abiVersion, toolchain } = {}) {
  for (const [field, value] of [['artifactDigest', artifactDigest], ['ioDigest', wireDigest], ['abiVersion', abiVersion], ['toolchain', toolchain]]) {
    if (!isNonEmptyString(value)) {
      fail(`a cache key needs ${field}: a key missing part of what it identifies collides with something else`, { code: 'cache.key', field });
    }
  }
  return sha256(stableJson({ artifactDigest, ioDigest: wireDigest, abiVersion, toolchain }));
}

export function createWasmCache({ maxEntries = DEFAULT_MAX_ENTRIES, maxBytes = DEFAULT_MAX_BYTES } = {}) {
  if (!Number.isInteger(maxEntries) || maxEntries < 1) fail(`maxEntries must be a positive whole number; got ${String(maxEntries)}`, { code: 'cache.input', field: 'maxEntries' });
  if (!Number.isInteger(maxBytes) || maxBytes < 1) fail(`maxBytes must be a positive whole number; got ${String(maxBytes)}`, { code: 'cache.input', field: 'maxBytes' });
  return {
    contract: WASM_CACHE_CONTRACT,
    schemaVersion: WASM_CACHE_SCHEMA_VERSION,
    maxEntries,
    maxBytes,
    entries: new Map(),
    sequence: 0,
    counters: { hits: 0, misses: 0, negativeHits: 0, insertions: 0, evictions: 0, refusals: 0, invalidations: 0, bytes: 0 },
  };
}

export function isWasmCache(value) {
  return Boolean(value) && typeof value === 'object' && value.contract === WASM_CACHE_CONTRACT && value.entries instanceof Map;
}

export function isCacheEntry(value) {
  return Boolean(value) && typeof value === 'object' && value.contract === WASM_CACHE_CONTRACT && CACHE_ENTRY_OUTCOMES.includes(value.outcome) && isNonEmptyString(value.key);
}

const requireEntry = (cache, key) => {
  const entry = cache.entries.get(key) ?? null;
  if (!entry) fail(`nothing is cached under ${String(key)}: an entry that cannot be looked up cannot be released or verified`, { code: 'cache.lookup', field: 'key' });
  return entry;
};

/**
 * Looking a module up is a read that also records that the entry was wanted: recency is what
 * eviction uses, and an entry nobody asks for is the right thing to throw away.
 */
export function lookup(cache, { artifactDigest, ioDigest: wireDigest, abiVersion, toolchain, tick } = {}) {
  if (!isWasmCache(cache)) fail('lookup reads a cache made by createWasmCache', { code: 'cache.input', field: 'cache' });
  if (!isTick(tick)) fail('a lookup happens at a tick', { code: 'cache.input', field: 'tick' });
  const key = cacheKey({ artifactDigest, ioDigest: wireDigest, abiVersion, toolchain });
  const entry = cache.entries.get(key) ?? null;
  if (!entry) {
    cache.counters.misses += 1;
    return Object.freeze({ ok: true, state: 'miss', key, entry: null, message: `nothing is cached for ${artifactDigest.slice(0, 12)}… on ${toolchain}: this is a miss, and a miss is not a failure` });
  }
  entry.lastUsedAt = tick;
  if (entry.outcome === 'failed') {
    cache.counters.negativeHits += 1;
    return Object.freeze({ ok: true, state: 'negative', key, entry, message: `this artifact already failed to compile on ${toolchain}: ${entry.reason}` });
  }
  cache.counters.hits += 1;
  return Object.freeze({ ok: true, state: 'hit', key, entry, message: `hit on ${toolchain}: module ${shortDigest(entry.moduleDigest)}…, ${entry.bytes} byte(s)` });
}

/**
 * Inserting records what happened — a module, or a failure. Capacity is a real limit, and the
 * only entries it may touch are idle ones.
 */
export function insert(cache, {
  artifactDigest, ioDigest: wireDigest, abiVersion, toolchain, outcome = 'compiled',
  moduleDigest = null, bytes = 0, reason = null, tick,
} = {}) {
  if (!isWasmCache(cache)) fail('insert reads a cache made by createWasmCache', { code: 'cache.input', field: 'cache' });
  if (!CACHE_ENTRY_OUTCOMES.includes(outcome)) {
    fail(`outcome '${String(outcome)}' is not one of ${CACHE_ENTRY_OUTCOMES.join(', ')}: a cache stores a module or a failure`, { code: 'cache.insert', field: 'outcome' });
  }
  if (!isTick(tick)) fail('an insertion happens at a tick', { code: 'cache.input', field: 'tick' });
  const key = cacheKey({ artifactDigest, ioDigest: wireDigest, abiVersion, toolchain });
  if (outcome === 'compiled') {
    if (!isNonEmptyString(moduleDigest)) {
      fail('a compiled entry carries the digest of the module it holds: a hit nobody can verify is a guess', { code: 'cache.insert', field: 'moduleDigest' });
    }
    if (!Number.isInteger(bytes) || bytes <= 0) fail(`a compiled entry records its size in bytes; got ${String(bytes)}`, { code: 'cache.insert', field: 'bytes' });
  } else {
    if (!isNonEmptyString(reason)) fail('a failed compilation is cached with a reason a human can read', { code: 'cache.insert', field: 'reason' });
    if (bytes !== 0) fail('a failed compilation has no size: caching it with bytes would make the budget lie', { code: 'cache.insert', field: 'bytes' });
  }

  const existing = cache.entries.get(key) ?? null;
  if (existing) {
    if (existing.outcome !== outcome || (outcome === 'compiled' && existing.moduleDigest !== moduleDigest)) {
      fail(`one key holds one module: ${shortDigest(key)}… already holds ${existing.outcome === 'compiled' ? `module ${shortDigest(existing.moduleDigest)}…` : `a failure (${existing.reason})`}`, { code: 'cache.insert', field: 'key' });
    }
    existing.lastUsedAt = tick;
    return Object.freeze({ ok: true, inserted: false, duplicate: true, entry: existing, message: 'the same module is already cached under this key' });
  }

  const size = outcome === 'compiled' ? bytes : 0;
  const overCapacity = cache.entries.size >= cache.maxEntries || (cache.counters.bytes + size) > cache.maxBytes;
  const evicted = [];
  if (overCapacity) {
    for (const candidate of [...cache.entries.values()].sort((left, right) => (left.lastUsedAt - right.lastUsedAt) || (left.key < right.key ? -1 : 1))) {
      if (cache.entries.size + 1 <= cache.maxEntries && (cache.counters.bytes + size) <= cache.maxBytes) break;
      if (candidate.inUse > 0) continue;
      cache.entries.delete(candidate.key);
      cache.counters.bytes -= candidate.bytes;
      cache.counters.evictions += 1;
      evicted.push(candidate.key);
    }
    if (cache.entries.size >= cache.maxEntries || (cache.counters.bytes + size) > cache.maxBytes) {
      cache.counters.refusals += 1;
      return Object.freeze({
        ok: false,
        reason: 'cache.capacity',
        evicted: Object.freeze(evicted),
        message: evicted.length > 0
          ? `even after evicting ${evicted.length} idle entry(ies) there is no room for ${size} byte(s): the insert is refused`
          : 'every entry in this cache is in use: refusing the insert rather than throwing away a module that is running',
      });
    }
  }

  cache.sequence += 1;
  const body = {
    contract: WASM_CACHE_CONTRACT,
    schemaVersion: WASM_CACHE_SCHEMA_VERSION,
    key,
    id: `entry#${cache.sequence}`,
    artifactDigest,
    ioDigest: wireDigest,
    abiVersion,
    toolchain,
    outcome,
    moduleDigest: outcome === 'compiled' ? moduleDigest : null,
    bytes: size,
    reason: outcome === 'failed' ? reason : null,
    insertedAt: tick,
    lastUsedAt: tick,
    inUse: 0,
  };
  const entry = { ...body, entryDigest: cacheDigest(body) };
  cache.entries.set(key, entry);
  cache.counters.insertions += 1;
  cache.counters.bytes += size;
  return Object.freeze({
    ok: true,
    inserted: true,
    entry,
    evicted: Object.freeze(evicted),
    message: outcome === 'compiled'
      ? `cached ${size} byte(s) for ${toolchain}${evicted.length > 0 ? `, evicting ${evicted.length} idle entry(ies)` : ''}`
      : `cached the failure for ${toolchain}: ${reason}`,
  });
}

/**
 * Adopting an entry marks it as in use, which is what keeps eviction away from it. This is the
 * caller's declaration: the cache does not know what is running, so it is told — and each user
 * counts, because two users of one module are two reasons not to throw it away.
 */
export function adopt(cache, key) {
  if (!isWasmCache(cache)) fail('adopt reads a cache made by createWasmCache', { code: 'cache.input', field: 'cache' });
  const entry = requireEntry(cache, key);
  entry.inUse += 1;
  return Object.freeze({ ok: true, adopted: true, entry, inUse: entry.inUse, message: `entry held: ${entry.inUse} user(s)` });
}

export function release(cache, key) {
  if (!isWasmCache(cache)) fail('release reads a cache made by createWasmCache', { code: 'cache.input', field: 'cache' });
  const entry = requireEntry(cache, key);
  if (entry.inUse === 0) {
    fail('nothing was holding this entry: a release without an adopt would invent a user', { code: 'cache.lookup', field: 'key' });
  }
  entry.inUse -= 1;
  return Object.freeze({ ok: true, released: true, entry, inUse: entry.inUse, message: entry.inUse === 0 ? 'entry is idle again and may be evicted' : `entry still has ${entry.inUse} user(s)` });
}

/**
 * A hit is only worth anything if the caller checks what it got. This is that check, and it
 * compares digests: nothing here knows how to hash bytes.
 */
export function verifyHit(entry, observedModuleDigest) {
  if (!isCacheEntry(entry)) fail('verifyHit reads an entry returned by lookup or insert', { code: 'cache.input', field: 'entry' });
  if (!isNonEmptyString(observedModuleDigest)) {
    fail('verifying a hit means comparing the digest of what was actually produced', { code: 'cache.lookup', field: 'observedModuleDigest' });
  }
  if (entry.outcome === 'failed') {
    return Object.freeze({ ok: false, verified: false, reason: 'cache.lookup', message: 'this entry is a cached failure: there is no module to verify' });
  }
  const verified = entry.moduleDigest === observedModuleDigest;
  return Object.freeze({
    ok: verified,
    verified,
    reason: verified ? null : 'cache.lookup',
    message: verified
      ? `the module matches the entry (${shortDigest(entry.moduleDigest)}…)`
      : `the module does not match the entry: expected ${shortDigest(entry.moduleDigest)}… and got ${shortDigest(observedModuleDigest)}…`,
  });
}

/** Invalidating is targeted: everything at once is a restart, not an invalidation. */
export function invalidate(cache, { artifactDigest = null, toolchain = null } = {}) {
  if (!isWasmCache(cache)) fail('invalidate reads a cache made by createWasmCache', { code: 'cache.input', field: 'cache' });
  if (!isNonEmptyString(artifactDigest) && !isNonEmptyString(toolchain)) {
    fail('invalidation names what it invalidates: an empty selector clears the cache, and clearing a cache is a restart', { code: 'cache.invalidate', field: 'selector' });
  }
  const removed = [];
  const held = [];
  for (const entry of [...cache.entries.values()]) {
    if (artifactDigest !== null && entry.artifactDigest !== artifactDigest) continue;
    if (toolchain !== null && entry.toolchain !== toolchain) continue;
    if (entry.inUse > 0) {
      held.push(entry.key);
      continue;
    }
    cache.entries.delete(entry.key);
    cache.counters.bytes -= entry.bytes;
    cache.counters.invalidations += 1;
    removed.push(entry.key);
  }
  return Object.freeze({
    ok: true,
    removed: Object.freeze(removed),
    held: Object.freeze(held),
    message: held.length > 0
      ? `${removed.length} entry(ies) invalidated; ${held.length} are in use and remain until released`
      : `${removed.length} entry(ies) invalidated`,
  });
}

/** The counts a review opens with. */
export function describeWasmCache(cache) {
  if (!isWasmCache(cache)) fail('describeWasmCache reads a cache made by createWasmCache', { code: 'cache.input', field: 'cache' });
  const entries = [...cache.entries.values()];
  const body = {
    contract: WASM_CACHE_CONTRACT,
    entries: entries.length,
    maxEntries: cache.maxEntries,
    bytes: cache.counters.bytes,
    maxBytes: cache.maxBytes,
    compiled: entries.filter((entry) => entry.outcome === 'compiled').length,
    failed: entries.filter((entry) => entry.outcome === 'failed').length,
    inUse: entries.filter((entry) => entry.inUse > 0).length,
    toolchains: Object.freeze([...new Set(entries.map((entry) => entry.toolchain))].sort()),
    counters: Object.freeze({ ...cache.counters }),
  };
  return Object.freeze({ ...body, cacheDigest: cacheDigest(body) });
}

export function explainWasmCache(cache) {
  const described = describeWasmCache(cache);
  return `wasm cache: ${described.entries}/${described.maxEntries} entries (${described.compiled} compiled, ${described.failed} cached failures), ${described.bytes}/${described.maxBytes} bytes, ${described.counters.hits} hit(s), ${described.counters.misses} miss(es), ${described.counters.evictions} eviction(s); toolchains: ${described.toolchains.join(', ') || 'none'}`;
}
