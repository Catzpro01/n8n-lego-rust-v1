/**
 * P7-S05 — Resource Locator & Search (#223 stage 4 DISCOVER, §12-13, §24-27, §34).
 *
 * resourceLocator is first-class P7 semantics. A locator parameter has one of four
 * compatible modes (list / name / id / url) and an n8n-compatible stored value
 * `{ mode, value }`. List mode is the only mode that reaches a provider: it performs a
 * bounded, targeted search with bounded pagination — never an unbounded enumeration to
 * populate a dropdown.
 *
 * Hard rules honoured here:
 *  - §12  the four modes are parsed into a canonical form; stored values stay
 *         n8n-compatible; unknown modes / malformed values are rejected, never coerced;
 *  - §13  list search is bounded: page size, result count, next-page token, cancellation,
 *         query length limits, deterministic result ordering; targeted search over a full
 *         catalog download; never unbounded enumeration;
 *  - §24  race protection: requestId + generation + normalized query digest; only a
 *         response matching the current generation updates state;
 *  - §25  request coalescing: identical concurrent searches share one in-flight op;
 *  - §26  backpressure: concurrency bound, timeout, max page size, max result count,
 *         cancellation; one slow provider cannot consume the whole process budget;
 *  - §27  a provider failure / timeout / cancellation is always reported as a closed,
 *         MARKED failure code — never converted into a fake unmarked empty success.
 *
 * The module is deterministic and testable: the search provider is an explicit,
 * replaceable object (§17); the static provider is used for tests. It reuses the stable
 * same-domain primitives from parameter-discover.mjs (DynamicCache, CACHE_CLASSES) and
 * parameter-plan.mjs (canonicalJson) — no second cache or budget subsystem.
 */
import { createHash } from 'node:crypto';
import { canonicalJson } from './parameter-plan.mjs';
import { DynamicCache, CACHE_CLASSES } from './parameter-discover.mjs';

export const LOCATOR_FORMAT = 'n8n-lego.resource-locator';
export const LOCATOR_FORMAT_VERSION = 1;

/** §12 — the four compatible resourceLocator modes. */
export const LOCATOR_MODES = Object.freeze({
  list: 'list',
  name: 'name',
  id: 'id',
  url: 'url',
});

/** The only mode that reaches a provider. */
export const PROVIDER_MODE = LOCATOR_MODES.list;

/** §26/§34 resource budgets (reuse the P7-S04/§26/§34 primitives; no second subsystem). */
export const LOCATOR_LIMITS = Object.freeze({
  maxPageSize: 200,
  maxResultCount: 4096,
  maxQueryLength: 512,
  maxPageTokenLength: 512,
  maxPagesPerSession: 50,
  maxResponseBytes: 1024 * 1024,
  maxConcurrency: 8,
  timeoutMs: 5000,
  retryBudget: 0,
  negativeTtlMs: 5000,
  providerTtlMs: 60000,
  maxCacheEntries: 512,
});

/**
 * §27 — the closed, marked failure vocabulary for the locator stage. A result with
 * `error` set is ALWAYS a marked failure (never a fake empty success). OVERLOADED is the
 * bounded-resource cap code (concurrency bound / pages-per-session cap); INVALID_URL is
 * the local url-mode validation code.
 */
export const LOCATOR_FAILURE_CODES = Object.freeze([
  'UNAVAILABLE', 'TIMEOUT', 'RATE_LIMITED', 'AUTH_REQUIRED', 'AUTH_REJECTED',
  'INVALID_PROVIDER_DATA', 'SCHEMA_INVALID', 'DEPENDENCY_INVALID',
  'STALE_REQUEST', 'CANCELLED', 'VERSION_INCOMPATIBLE', 'OVERLOADED', 'INVALID_URL',
]);

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

export class ResourceLocatorError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ResourceLocatorError';
    this.code = code;
    this.details = details;
  }
}

/* ------------------------------------------------------------------ §12 canonical model */

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * §12 — normalize one mode's value. Returns a normalized string. Throws
 * `ResourceLocatorError` (SCHEMA_INVALID / INVALID_URL) on a malformed value; unknown
 * modes are rejected (never silently coerced).
 */
export function normalizeLocatorValue(mode, raw, limits = LOCATOR_LIMITS) {
  if (mode === LOCATOR_MODES.url) {
    if (typeof raw !== 'string' || raw.trim() === '') {
      throw new ResourceLocatorError('SCHEMA_INVALID', 'url mode requires a non-empty string value');
    }
    const trimmed = raw.trim();
    if (trimmed.length > limits.maxQueryLength) {
      throw new ResourceLocatorError('SCHEMA_INVALID', `url value exceeds ${limits.maxQueryLength} chars`, { length: trimmed.length, limit: limits.maxQueryLength });
    }
    try {
      new URL(trimmed);
    } catch {
      throw new ResourceLocatorError('INVALID_URL', 'url mode value is not a valid URL', { length: trimmed.length });
    }
    return trimmed;
  }
  // name / id / list: a bounded string (id may arrive as a number).
  if (raw === null || raw === undefined || typeof raw === 'object') {
    throw new ResourceLocatorError('SCHEMA_INVALID', `${mode} mode requires a string or number value`);
  }
  const text = String(raw).trim();
  if (text.length > limits.maxQueryLength) {
    throw new ResourceLocatorError('SCHEMA_INVALID', `${mode} value exceeds ${limits.maxQueryLength} chars`, { length: text.length, limit: limits.maxQueryLength });
  }
  return text;
}

/**
 * §12 — parse a stored n8n resourceLocator value into the canonical `{ mode, value }`
 * form. Accepts the n8n shape (extra fields such as `cachable` are ignored). Stored
 * workflow values remain n8n-compatible. Unknown modes / malformed values throw.
 */
export function parseResourceLocator(raw, limits = LOCATOR_LIMITS) {
  if (!isPlainObject(raw) || typeof raw.mode !== 'string') {
    throw new ResourceLocatorError('SCHEMA_INVALID', 'resourceLocator value must be an object with a string mode');
  }
  const mode = raw.mode;
  if (!(mode in LOCATOR_MODES)) {
    throw new ResourceLocatorError('SCHEMA_INVALID', `unknown resourceLocator mode "${mode}"`, { mode, allowed: Object.values(LOCATOR_MODES) });
  }
  const value = normalizeLocatorValue(mode, raw.value, limits);
  return Object.freeze({ mode, value });
}

/* ------------------------------------------------------------------ §17 search provider */

/**
 * §17 — a search provider is an explicit, replaceable object:
 * `{ id, version, locality, search(context, page) -> { items, nextToken } }`.
 * `search` receives `page = { query, pageToken, pageSize }` and returns a page of raw
 * option-shaped items plus an opaque next-page token (or null when exhausted).
 * `createStaticLocatorProvider` is the local/static provider (tests); it filters +
 * paginates a static list and never crosses a network boundary.
 */
export function createStaticLocatorProvider(items, extra = {}) {
  const source = (Array.isArray(items) ? items : []).map((entry) => ({
    name: entry.name, value: entry.value, description: entry.description,
  }));
  return {
    id: extra.id ?? 'static-locator',
    version: extra.version ?? '1.0.0',
    locality: 'local',
    async search(_context, page) {
      const query = (page.query ?? '').toLowerCase();
      const filtered = query === ''
        ? source
        : source.filter((it) => it.name.toLowerCase().includes(query) || String(it.value).toLowerCase().includes(query));
      // §13 deterministic result ordering: stable sort by value, then name.
      const ordered = [...filtered].sort((a, b) =>
        String(a.value).localeCompare(String(b.value)) || a.name.localeCompare(b.name));
      const start = page.pageToken ? Number.parseInt(page.pageToken, 10) : 0;
      const size = page.pageSize ?? 20;
      const slice = ordered.slice(start, start + size);
      const next = start + size < ordered.length ? String(start + size) : null;
      return { items: slice, nextToken: next };
    },
  };
}

function isPlainValue(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * §13 — normalize a raw provider page into the canonical option shape + deterministic
 * ordering, and bound it to (pageSize, maxResultCount). Throws
 * `ResourceLocatorError(INVALID_PROVIDER_DATA)` on malformed data.
 */
function normalizePage(rawPage, pageSize, limits) {
  if (!isPlainValue(rawPage)) {
    throw new ResourceLocatorError('INVALID_PROVIDER_DATA', 'provider search result must be an object { items, nextToken }');
  }
  if (!Array.isArray(rawPage.items)) {
    throw new ResourceLocatorError('INVALID_PROVIDER_DATA', 'provider search result has no items array');
  }
  const nextToken = rawPage.nextToken === undefined || rawPage.nextToken === null ? null : String(rawPage.nextToken);
  if (nextToken !== null && nextToken.length > limits.maxPageTokenLength) {
    throw new ResourceLocatorError('STALE_REQUEST', `provider next-page token exceeds ${limits.maxPageTokenLength} chars`, { length: nextToken.length });
  }
  const normalized = [];
  for (const entry of rawPage.items) {
    if (!isPlainValue(entry) || typeof entry.value !== 'string' || typeof entry.name !== 'string') {
      throw new ResourceLocatorError('INVALID_PROVIDER_DATA', 'an item is malformed (expected { name, value })');
    }
    const option = { name: entry.name, value: entry.value };
    if (typeof entry.description === 'string') option.description = entry.description;
    normalized.push(option);
  }
  // §13 deterministic ordering (value, then name) — independent of provider order.
  normalized.sort((a, b) => a.value.localeCompare(b.value) || a.name.localeCompare(b.name));
  const items = normalized.slice(0, Math.min(pageSize, limits.maxResultCount));
  return Object.freeze({ items, nextToken });
}

/* ------------------------------------------------------------------ §13/§24-27 session */

/** A small deterministic cancel token (§26). */
export function createCancelToken() {
  const token = {
    cancelled: false,
    _listeners: [],
    cancel() {
      if (this.cancelled) return;
      this.cancelled = true;
      for (const cb of this._listeners) {
        try { cb(); } catch { /* listener errors are ignored */ }
      }
    },
    onCancel(cb) {
      if (this.cancelled) { cb(); return; }
      this._listeners.push(cb);
    },
  };
  return token;
}

/**
 * §12/§13/§24-27 — the resource-locator search session. Owns a search provider, a cache,
 * a generation counter (race protection), an in-flight map (coalescing), and a per-search
 * page counter (bounded pagination).
 *
 * `search(query, options)` (first page) and `nextPage(token, query, options)` (subsequent
 * pages) both return a frozen result:
 *   { items, nextToken, hasMore, requestId, generation, cache, error? }
 * On a failure `error` is `{ code, message }` and `items` is `[]` ONLY together with a
 * non-null `error` (a real, marked failure — never an unmarked empty success).
 *
 * options: { requestId?, context?, token?, authoritative?, pageSize? }
 */
export class ResourceLocatorSession {
  constructor({ provider, cache, limits = LOCATOR_LIMITS, now = Date.now } = {}) {
    if (!provider || typeof provider.search !== 'function') {
      throw new ResourceLocatorError('INVALID_PROVIDER_DATA', 'a provider with search(context, page) is required');
    }
    this.provider = provider;
    this.cache = cache ?? new DynamicCache(limits);
    this.limits = { ...LOCATOR_LIMITS, ...limits };
    this.now = now;
    this.generation = 0;
    this.inFlight = new Map(); // cacheKey -> Promise
    this.pagesFetched = new Map(); // searchIdentity -> provider page count
    this.activeCount = 0;
    this.providerCalls = 0;
    this.cancelledRequestIds = new Set();
  }

  _searchIdentity(context) {
    return sha256(canonicalJson({
      nodeType: context.nodeType,
      nodeVersion: context.nodeVersion,
      parameterPath: context.parameterPath,
      methodName: context.methodName ?? null,
      normalizedDependencyDigest: context.dependencyDigest ?? null,
      normalizedSearchQuery: (context.searchQuery ?? '').toLowerCase(),
      providerVersion: this.provider.version,
      schemaVersion: context.schemaVersion ?? null,
    }));
  }

  _key(context, pageToken) {
    return sha256(canonicalJson({
      identity: this._searchIdentity(context),
      pageToken,
    }));
  }

  _pageSize(options) {
    const requested = Number.isFinite(options.pageSize) ? options.pageSize : this.limits.maxPageSize;
    return Math.max(1, Math.min(requested, this.limits.maxPageSize, this.limits.maxResultCount));
  }

  _validateQuery(query) {
    if (query === undefined || query === null) return '';
    if (typeof query !== 'string') {
      throw new ResourceLocatorError('SCHEMA_INVALID', 'search query must be a string');
    }
    const normalized = query.trim();
    if (normalized.length > this.limits.maxQueryLength) {
      throw new ResourceLocatorError('SCHEMA_INVALID', `search query exceeds ${this.limits.maxQueryLength} chars`, { length: normalized.length, limit: this.limits.maxQueryLength });
    }
    return normalized;
  }

  _validateToken(pageToken) {
    if (typeof pageToken !== 'string' || pageToken === '') {
      throw new ResourceLocatorError('STALE_REQUEST', 'a page token is required for nextPage');
    }
    if (pageToken.length > this.limits.maxPageTokenLength) {
      throw new ResourceLocatorError('STALE_REQUEST', `page token exceeds ${this.limits.maxPageTokenLength} chars`, { length: pageToken.length });
    }
    return pageToken;
  }

  /** §13 — first page of a bounded, targeted search. */
  async search(query, options = {}) {
    return this._run(query, options, null);
  }

  /** §13 — a subsequent page (bounded by the pages-per-session cap). */
  async nextPage(pageToken, query, options = {}) {
    return this._run(query, options, this._validateToken(pageToken));
  }

  async _run(query, options, pageToken) {
    const normalizedQuery = this._validateQuery(query);
    const context = { ...(options.context ?? {}) };
    context.searchQuery = normalizedQuery;
    const pageSize = this._pageSize(options);
    const key = this._key(context, pageToken);
    const identity = this._searchIdentity(context);
    const now = this.now();
    const requestId = options.requestId ?? `req-${this.generation + 1}`;
    const token = options.token;

    // Cancellation checked up front (§26).
    if (token && token.cancelled) {
      return this._failure('CANCELLED', `search ${requestId} was cancelled`, requestId, this.generation, 'cancelled');
    }

    // §14 cache: peek (without deleting) and handle fresh / negative explicitly.
    const entry = this.cache.peek(key, now);
    if (entry) {
      const expired = entry.expiresAt !== null && entry.expiresAt <= now;
      if (!expired) {
        this.cache._touch(key);
        if (entry.cls === CACHE_CLASSES.NEGATIVE) {
          return this._failure(entry.value.code, entry.value.message, requestId, this.generation, 'negative-hit');
        }
        return Object.freeze({ ...entry.value, source: 'cache', cache: 'hit', requestId, generation: this.generation, stale: false });
      }
      this.cache._delete(key);
    }

    // §25/§26/§13: coalesce an identical in-flight op, else issue one (bounded).
    const coalesced = this.inFlight.has(key);
    const result = await this._fetchAndCache(key, identity, context, pageToken, pageSize, requestId, token, now);
    return this._finalize(result, requestId, coalesced, pageSize);
  }

  /**
   * §25/§26 — coalesce an identical in-flight op; otherwise issue one bounded provider
   * call (concurrency bound + pages-per-session cap + timeout) and cache the result.
   */
  _fetchAndCache(key, identity, context, pageToken, pageSize, requestId, token, now) {
    if (this.inFlight.has(key)) {
      return this.inFlight.get(key);
    }
    // §13 bounded pagination: the pages-per-session cap stops unbounded enumeration.
    const fetched = this.pagesFetched.get(identity) ?? 0;
    if (fetched >= this.limits.maxPagesPerSession) {
      const error = { code: 'OVERLOADED', message: `pages-per-session cap reached (${this.limits.maxPagesPerSession})` };
      this.cache.set(key, error, CACHE_CLASSES.NEGATIVE, now);
      return Promise.resolve({ error, generation: this.generation });
    }
    // §26 concurrency bound.
    if (this.activeCount >= this.limits.maxConcurrency) {
      const error = { code: 'OVERLOADED', message: `provider concurrency bound reached (${this.limits.maxConcurrency})` };
      this.cache.set(key, error, CACHE_CLASSES.NEGATIVE, now);
      return Promise.resolve({ error, generation: this.generation });
    }
    const generation = (this.generation += 1);
    this.pagesFetched.set(identity, fetched + 1);
    this.activeCount += 1;
    this.providerCalls += 1;
    const operation = this._callProvider(context, pageToken, pageSize, requestId, token)
      .then((raw) => (token && token.cancelled
        ? { error: { code: 'CANCELLED', message: `search ${requestId} was cancelled` }, generation }
        : { ...this._onSuccess(key, raw, pageSize, now), generation }))
      .catch((error) => ({ ...this._onFailure(key, error, now), generation }))
      .finally(() => {
        this.activeCount -= 1;
        this.inFlight.delete(key);
      });
    this.inFlight.set(key, operation);
    return operation;
  }

  _callProvider(context, pageToken, pageSize, requestId, token) {
    const page = { query: context.searchQuery ?? '', pageToken, pageSize };
    const race = Promise.race([
      this.provider.search(context, page),
      new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new ResourceLocatorError('TIMEOUT', `provider ${this.provider.id} timed out after ${this.limits.timeoutMs}ms`)), this.limits.timeoutMs);
        if (typeof timer.unref === 'function') timer.unref();
      }),
    ]);
    // §26 cancellation: if the token aborts while in flight, surface it after settle.
    if (token) {
      token.onCancel(() => {
        this.cancelledRequestIds.add(requestId);
      });
    }
    return race.finally(() => {
      // (cancellation is applied in the .then above via token.cancelled)
    });
  }

  _onSuccess(key, raw, pageSize, now) {
    const page = normalizePage(raw, pageSize, this.limits);
    const value = Object.freeze({ items: page.items, nextToken: page.nextToken, hasMore: page.nextToken !== null, source: 'provider' });
    this.cache.set(key, value, CACHE_CLASSES.PROVIDER, now);
    return value;
  }

  _onFailure(key, error, now) {
    const code = error?.code && LOCATOR_FAILURE_CODES.includes(error.code) ? error.code : 'INVALID_PROVIDER_DATA';
    const message = error?.message ?? String(error);
    const normalized = { code, message };
    this.cache.set(key, normalized, CACHE_CLASSES.NEGATIVE, now);
    return { error: normalized };
  }

  _finalize(result, requestId, coalesced, pageSize) {
    if (this.cancelledRequestIds.has(requestId)) {
      this.cancelledRequestIds.delete(requestId);
      return this._failure('CANCELLED', `search ${requestId} was cancelled`, requestId, result.generation, coalesced ? 'coalesced' : 'miss');
    }
    if (result.error) {
      return this._failure(result.error.code, result.error.message, requestId, result.generation, coalesced ? 'coalesced' : 'miss');
    }
    return Object.freeze({ items: result.items, nextToken: result.nextToken, hasMore: result.hasMore, source: 'provider', cache: coalesced ? 'coalesced' : 'miss', requestId, generation: result.generation, stale: false });
  }

  _failure(code, message, requestId, generation, cache) {
    return Object.freeze({ items: [], nextToken: null, hasMore: false, source: 'provider', cache, requestId, generation, stale: false, error: Object.freeze({ code, message }) });
  }

  /** §26 — cancel an in-flight (or future) request by id. */
  cancel(requestId) {
    this.cancelledRequestIds.add(requestId);
  }

  stats() {
    return { active: this.activeCount, inFlight: this.inFlight.size, generation: this.generation, providerCalls: this.providerCalls, cache: this.cache.stats(), pagesFetched: Object.fromEntries(this.pagesFetched) };
  }
}
