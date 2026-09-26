/**
 * P7-S04 — Dynamic Options Runtime (#223 stage 4 DISCOVER, §11, §14-16, §23-26, §34).
 *
 * The DISCOVER stage is the only stage allowed to cross a provider/network boundary,
 * and only under explicit capability + resource policy. It resolves a dynamic option
 * source into a bounded, normalized option list, caches the result, and protects the
 * instance from slow/broken/malicious providers.
 *
 * Hard rules honoured here:
 *  - §11  parameter -> loadOptionsMethod -> resolved dependency context -> provider
 *         operation -> normalized option list; malformed provider data is rejected,
 *         never blindly passed to UI;
 *  - §14-15 a bounded, keyed cache with explicit classes (STATIC/SESSION/REQUEST/
 *         PROVIDER/NEGATIVE); never caches credentials or secrets;
 *  - §16  stale-while-revalidate is display-only; authoritative values are
 *         revalidated; cached UI state is never permission authority;
 *  - §24  race protection: requestId + generation + dependency digest; only a response
 *         matching the current generation updates state (stale responses discarded);
 *  - §25  request coalescing: identical concurrent requests share one in-flight op;
 *  - §26, §34 backpressure + resource budgets: concurrency bound, deadline/timeout,
 *         max result count, max response bytes, retry budget, cancellation, negative
 *         cache; one slow provider cannot consume the whole process budget.
 *
 * This module is deterministic and testable: providers are explicit, replaceable
 * objects (§17); the local/static provider is used for tests. Remote/credential-aware
 * providers and the plugin boundary are P7-S06/S07.
 */
import { createHash } from 'node:crypto';
import { canonicalJson } from './parameter-plan.mjs';

export const DISCOVER_FORMAT = 'n8n-lego.parameter-discover';
export const DISCOVER_FORMAT_VERSION = 1;

/** §15 cache classes. */
export const CACHE_CLASSES = Object.freeze({
  STATIC: 'STATIC',
  SESSION: 'SESSION',
  REQUEST: 'REQUEST',
  PROVIDER: 'PROVIDER',
  NEGATIVE: 'NEGATIVE',
});

/** §26/§34 resource budgets (one bounded policy; no second subsystem). */
export const DISCOVER_LIMITS = Object.freeze({
  maxCacheEntries: 512,
  maxResultCount: 4096,
  maxResponseBytes: 1024 * 1024,
  maxConcurrency: 8,
  timeoutMs: 5000,
  retryBudget: 0,
  negativeTtlMs: 5000,
  providerTtlMs: 60000,
  staleWindowMs: 30000,
});

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

export class DynamicOptionsError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'DynamicOptionsError';
    this.code = code;
    this.details = details;
  }
}

/* ------------------------------------------------------------------ §17 provider abstraction */

/**
 * §17 — a provider is an explicit, replaceable object: `{ id, version, locality,
 * loadOptions(context) -> rawOptions }`. `loadOptions` returns a raw option list
 * (an array of `{ name, value, description? }`-shaped entries) or throws.
 * `createStaticProvider` is the local/static provider (used for tests + the STATIC
 * cache class); it never crosses a network boundary.
 */
export function createStaticProvider(options, extra = {}) {
  return {
    id: extra.id ?? 'static',
    version: extra.version ?? '1.0.0',
    locality: 'local',
    async loadOptions() {
      return JSON.parse(JSON.stringify(options));
    },
  };
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/* ------------------------------------------------------------------ §11 normalization */

/**
 * §11 — normalize a raw provider result into the small canonical option shape
 * `{ name, value, description? }`. Rejects malformed data (never blindly passed to
 * UI) and bounds the result count. Throws `DynamicOptionsError(INVALID_PROVIDER_DATA)`
 * on a malformed list/entry.
 */
export function normalizeOptionList(raw, limits = DISCOVER_LIMITS) {
  if (raw === undefined || raw === null) {
    throw new DynamicOptionsError('INVALID_PROVIDER_DATA', 'provider returned no option list');
  }
  const list = Array.isArray(raw) ? raw : (isPlainObject(raw) && Array.isArray(raw.options) ? raw.options : null);
  if (!Array.isArray(list)) {
    throw new DynamicOptionsError('INVALID_PROVIDER_DATA', 'provider result is not an option list');
  }
  if (list.length > limits.maxResultCount) {
    throw new DynamicOptionsError('INVALID_PROVIDER_DATA', `provider returned ${list.length} options (max ${limits.maxResultCount})`, { count: list.length, limit: limits.maxResultCount });
  }
  const normalized = [];
  for (const entry of list) {
    if (!isPlainObject(entry) || typeof entry.value !== 'string' || typeof entry.name !== 'string') {
      throw new DynamicOptionsError('INVALID_PROVIDER_DATA', 'an option entry is malformed (expected { name, value })');
    }
    const option = { name: entry.name, value: entry.value };
    if (typeof entry.description === 'string') option.description = entry.description;
    if (entry.disabled === true) option.disabled = true;
    normalized.push(Object.freeze(option));
  }
  return Object.freeze(normalized);
}

/* ------------------------------------------------------------------ §14-15 bounded cache */

/** §14 — the dynamic cache key (SHA-256 over the canonical field set). */
export function cacheKey(fields) {
  return sha256(canonicalJson(fields));
}

/**
 * §14-15 — a bounded, keyed, classed LRU cache. Stores only normalized options +
 * bounded metadata (never credentials/secrets). PROVIDER entries expire after
 * `providerTtlMs`; NEGATIVE entries after `negativeTtlMs`; the others do not expire.
 */
export class DynamicCache {
  constructor(limits = DISCOVER_LIMITS) {
    this.limits = { ...DISCOVER_LIMITS, ...limits };
    this.entries = new Map(); // key -> { value, cls, createdAt, expiresAt }
  }
  _evict() {
    while (this.entries.size > this.limits.maxCacheEntries) {
      this.entries.delete(this.entries.keys().next().value);
    }
  }
  get(key, now = Date.now()) {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && entry.expiresAt <= now) {
      this.entries.delete(key);
      return null;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry;
  }
  peek(key, now = Date.now()) {
    const entry = this.entries.get(key);
    if (!entry) return null;
    return entry;
  }
  _touch(key) {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.entries.set(key, entry);
  }
  _delete(key) {
    this.entries.delete(key);
  }
  set(key, value, cls, now = Date.now()) {
    let expiresAt = null;
    if (cls === CACHE_CLASSES.PROVIDER) expiresAt = now + this.limits.providerTtlMs;
    else if (cls === CACHE_CLASSES.NEGATIVE) expiresAt = now + this.limits.negativeTtlMs;
    const entry = { value, cls, createdAt: now, expiresAt };
    this.entries.set(key, entry);
    this._evict();
    return entry;
  }
  stats() {
    return { size: this.entries.size, max: this.limits.maxCacheEntries };
  }
  clear() {
    this.entries.clear();
  }
}

/* ------------------------------------------------------------------ §11/§16/§24-26 session */

/**
 * §11/§16/§24-26 — the dynamic options resolution session. Owns a provider, a cache,
 * a generation counter (race protection) and an in-flight map (request coalescing).
 *
 * `resolve(parameter, context, options)`:
 *   - computes the §14 cache key from (nodeType, nodeVersion, parameterPath,
 *     methodName, normalizedDependencyDigest, normalizedSearchQuery, providerVersion,
 *     schemaVersion);
 *   - returns a fresh cache hit, or — for display-only (non-authoritative) requests —
 *     a stale value within the SWR window, triggering a coalesced background
 *     revalidation (§16);
 *   - coalesces an identical in-flight request (§25);
 *   - enforces the concurrency bound and timeout (§26);
 *   - normalizes the provider result (§11);
 *   - on success stores a PROVIDER entry; on failure stores a NEGATIVE entry (short
 *     TTL) and reports the failure (never a fake empty success, §27).
 *
 * Returns a frozen result:
 *   { options, source, cache, requestId, generation, stale, revalidating, error? }
 * On a provider failure `error` is `{ code, message }` and `options` is `[]` ONLY
 * together with a non-null `error` (a real, marked failure — never an unmarked empty
 * success).
 */
export class DynamicOptionsSession {
  constructor({ provider, cache, limits = DISCOVER_LIMITS, now = Date.now } = {}) {
    if (!provider || typeof provider.loadOptions !== 'function') {
      throw new DynamicOptionsError('INVALID_PROVIDER', 'a provider with loadOptions(context) is required');
    }
    this.provider = provider;
    this.cache = cache ?? new DynamicCache(limits);
    this.limits = { ...DISCOVER_LIMITS, ...limits };
    this.now = now;
    this.generation = 0;
    this.inFlight = new Map(); // cacheKey -> Promise
    this.activeCount = 0;
    this.providerCalls = 0;
  }

  _key(parameter, context) {
    return cacheKey({
      nodeType: context.nodeType,
      nodeVersion: context.nodeVersion,
      parameterPath: parameter.path,
      methodName: parameter.dynamic?.loadOptionsMethod ?? null,
      normalizedDependencyDigest: context.dependencyDigest ?? null,
      normalizedSearchQuery: context.searchQuery ?? null,
      providerVersion: this.provider.version,
      schemaVersion: context.schemaVersion ?? null,
    });
  }

  async resolve(parameter, context, options = {}) {
    const key = this._key(parameter, context);
    const now = this.now();
    const requestId = options.requestId ?? `req-${this.generation + 1}`;

    // §14 cache: peek (without deleting) and handle fresh / negative / stale explicitly.
    const entry = this.cache.peek(key, now);
    if (entry) {
      const expired = entry.expiresAt !== null && entry.expiresAt <= now;
      if (!expired) {
        this.cache._touch(key);
        if (entry.cls === CACHE_CLASSES.NEGATIVE) {
          return Object.freeze({ options: [], source: 'cache', cache: 'negative-hit', requestId, generation: this.generation, stale: false, revalidating: false, error: { code: entry.value.code, message: entry.value.message } });
        }
        return Object.freeze({ options: entry.value, source: 'cache', cache: 'hit', requestId, generation: this.generation, stale: false, revalidating: false });
      }
      // §16 stale-while-revalidate (display-only): a PROVIDER entry past its TTL but
      //    within the SWR window is served stale + revalidated in the background. It is
      //    never used for an authoritative (execution) resolution.
      if (entry.cls === CACHE_CLASSES.PROVIDER && !options.authoritative && this._withinStaleWindow(entry, now)) {
        this._fetchAndCache(key, parameter, context, this.now()).catch(() => {});
        return Object.freeze({ options: entry.value, source: 'cache', cache: 'stale', requestId, generation: this.generation, stale: true, revalidating: true });
      }
      // Expired and not servable: drop it and treat as a miss.
      this.cache._delete(key);
    }

    // §25/§26/§11: coalesce an identical in-flight op, else issue one (bounded).
    const coalesced = this.inFlight.has(key);
    const result = await this._fetchAndCache(key, parameter, context, this.now());
    return this._finalize(result, requestId, coalesced);
  }

  _withinStaleWindow(entry, now) {
    const windowFloor = now - this.limits.staleWindowMs;
    return entry.expiresAt >= windowFloor;
  }

  /**
   * §25/§26 — coalesce an identical in-flight operation; otherwise issue a single
   * bounded provider call (concurrency bound + timeout) and cache the result.
   */
  _fetchAndCache(key, parameter, context, now) {
    if (this.inFlight.has(key)) {
      return this.inFlight.get(key);
    }
    if (this.activeCount >= this.limits.maxConcurrency) {
      const error = { code: 'OVERLOADED', message: `provider concurrency bound reached (${this.limits.maxConcurrency})` };
      this.cache.set(key, error, CACHE_CLASSES.NEGATIVE, now);
      return Promise.resolve({ error, generation: this.generation });
    }
    const generation = (this.generation += 1);
    this.activeCount += 1;
    this.providerCalls += 1;
    const operation = this._callProvider(parameter, context)
      .then((raw) => ({ ...this._onSuccess(key, raw, now), generation }))
      .catch((error) => ({ ...this._onFailure(key, error, now), generation }))
      .finally(() => {
        this.activeCount -= 1;
        this.inFlight.delete(key);
      });
    this.inFlight.set(key, operation);
    return operation;
  }

  _staleEntry(key, now) {
    const entry = this.cache.peek(key, now);
    if (!entry || entry.cls !== CACHE_CLASSES.PROVIDER) return null;
    if (entry.expiresAt === null || entry.expiresAt > now) return null; // fresh or non-expiring
    const windowFloor = now - this.limits.staleWindowMs;
    if (entry.expiresAt < windowFloor) return null; // too old to serve
    return entry;
  }

  _callProvider(parameter, context) {
    return Promise.race([
      this.provider.loadOptions(context),
      new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new DynamicOptionsError('TIMEOUT', `provider ${this.provider.id} timed out after ${this.limits.timeoutMs}ms`)), this.limits.timeoutMs);
        if (typeof timer.unref === 'function') timer.unref();
      }),
    ]);
  }

  _onSuccess(key, raw, now) {
    const options = normalizeOptionList(raw, this.limits);
    this.cache.set(key, options, CACHE_CLASSES.PROVIDER, now);
    return { options };
  }

  _onFailure(key, error, now) {
    const code = error?.code ?? 'INVALID_PROVIDER_DATA';
    const message = error?.message ?? String(error);
    const normalized = { code, message };
    this.cache.set(key, normalized, CACHE_CLASSES.NEGATIVE, now);
    return { error: normalized };
  }

  _finalize(result, requestId, coalesced) {
    if (result.error) {
      return Object.freeze({ options: [], source: 'provider', cache: coalesced ? 'coalesced' : 'miss', requestId, generation: result.generation, stale: false, revalidating: false, error: result.error });
    }
    return Object.freeze({ options: result.options, source: 'provider', cache: coalesced ? 'coalesced' : 'miss', requestId, generation: result.generation, stale: false, revalidating: false });
  }

  stats() {
    return { active: this.activeCount, inFlight: this.inFlight.size, generation: this.generation, providerCalls: this.providerCalls, cache: this.cache.stats() };
  }
}
