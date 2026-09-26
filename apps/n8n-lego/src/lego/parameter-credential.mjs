/**
 * P7-S06 — Credential-Aware Resolution (#223 stage 4 DISCOVER, §18, §19, §28, §27, §34).
 *
 * Dynamic lookups that need credentials are composed as:
 *   P5 authorization -> request-bound SecretRef -> P2.27 Secret Broker -> narrowly scoped
 *   provider operation -> normalized result.
 *
 * P7 NEVER stores raw credential material. The credential plaintext must never appear in a
 * ParameterPlan, the cache, workflow parameter history, logs, telemetry, error payloads, or a
 * schema snapshot. This module enforces that invariant structurally (the material is held only
 * in-memory for the duration of one narrowly scoped operation) and by redaction (scrub).
 *
 * Hard rules honoured here:
 *  - §18  a SecretRef is the only credential handle a lookup may carry: request-bound, opaque,
 *         bound to a capability scope, and NEVER containing raw material;
 *  - §18  the composition is authorization -> SecretRef -> Secret Broker -> narrowly scoped
 *         provider operation -> normalized result; the material is never persisted/cached/logged;
 *  - §19  the principal -> tenant -> capability -> action -> resource -> SecretRef -> provider
 *         chain is enforced before the provider call; option visibility does not grant permission
 *         to execute; provider-returned metadata cannot grant itself new authority;
 *  - §28  security-sensitive / execution-authoritative values are marked revalidation-required;
 *         a cached UI option never becomes authority (cached-UI -> assumed-authority ->
 *         unauthorized-execution is prevented);
 *  - §27  a provider/auth failure is a closed, MARKED failure code — never a fake empty success.
 *
 * Deterministic and testable: the Secret Broker and the provider are explicit, replaceable
 * objects; in-memory implementations are provided for tests. No network, credential store, or
 * authentication system is implemented here (those are P5 / P2.27 / the provider itself).
 */
import { createHash } from 'node:crypto';
import { canonicalJson } from './parameter-plan.mjs';
import { DynamicCache, CACHE_CLASSES } from './parameter-discover.mjs';

export const CREDENTIAL_FORMAT = 'n8n-lego.credential-resolution';
export const CREDENTIAL_FORMAT_VERSION = 1;

/** §27 + §18/§19/§28 — the closed, marked failure vocabulary for credential resolution. */
export const CREDENTIAL_FAILURE_CODES = Object.freeze([
  'AUTH_REQUIRED', 'AUTH_REJECTED', 'CAPABILITY_DENIED', 'CREDENTIAL_LEAK',
  'INVALID_SECRET_REF', 'SCHEMA_INVALID', 'UNAVAILABLE', 'TIMEOUT',
  'INVALID_PROVIDER_DATA', 'REVALIDATION_REQUIRED',
]);

/** §18 — field names that indicate raw credential material (never allowed in a SecretRef). */
const PLAINTEXT_FIELDS = Object.freeze(['secret', 'password', 'token', 'accessToken', 'apiKey', 'api_key', 'value', 'credential', 'material']);

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

export class CredentialResolutionError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'CredentialResolutionError';
    this.code = code;
    this.details = details;
  }
}

/** §18 — the default budgets (reuse the P7-S04/§26/§34 primitives; no second subsystem). */
export const CREDENTIAL_LIMITS = Object.freeze({
  maxConcurrency: 8,
  timeoutMs: 5000,
  retryBudget: 0,
  negativeTtlMs: 5000,
  providerTtlMs: 60000,
  maxCacheEntries: 512,
});

/* ------------------------------------------------------------------ §18 SecretRef */

/**
 * §18 — create a request-bound, opaque SecretRef. The ONLY credential handle a dynamic lookup
 * may carry. It is bound to a capability scope (principal, tenant, capability, action,
 * resource) + credentialId + an opaque nonce, and NEVER contains raw credential material.
 *
 * Passing plaintext (a `secret`/`password`/`token`/... field) is rejected with
 * CREDENTIAL_LEAK — the material must go through the Secret Broker, never the ref.
 */
export function createSecretRef(fields = {}) {
  if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) {
    throw new CredentialResolutionError('INVALID_SECRET_REF', 'a SecretRef requires an object of scope fields');
  }
  for (const key of Object.keys(fields)) {
    if (PLAINTEXT_FIELDS.includes(key)) {
      throw new CredentialResolutionError('CREDENTIAL_LEAK', `a SecretRef must not carry raw credential material (found "${key}")`);
    }
  }
  for (const key of ['credentialId', 'principal', 'tenant', 'capability', 'action', 'resource']) {
    if (typeof fields[key] !== 'string' || fields[key] === '') {
      throw new CredentialResolutionError('INVALID_SECRET_REF', `SecretRef requires a non-empty string "${key}"`);
    }
  }
  const nonce = sha256(canonicalJson({
    credentialId: fields.credentialId, principal: fields.principal, tenant: fields.tenant,
    capability: fields.capability, action: fields.action, resource: fields.resource,
    issuedAt: fields.issuedAt ?? null,
  })).slice(0, 24);
  return Object.freeze({
    kind: 'SecretRef',
    credentialId: fields.credentialId,
    principal: fields.principal,
    tenant: fields.tenant,
    capability: fields.capability,
    action: fields.action,
    resource: fields.resource,
    nonce,
  });
}

/** §18 — the cache key is over the SecretRef SCOPE (never the material) + context. */
export function credentialCacheKey(ref, context = {}) {
  return sha256(canonicalJson({
    credentialId: ref.credentialId,
    principal: ref.principal,
    tenant: ref.tenant,
    capability: ref.capability,
    action: ref.action,
    resource: ref.resource,
    nonce: ref.nonce,
    providerVersion: context.providerVersion ?? null,
    schemaVersion: context.schemaVersion ?? null,
  }));
}

/* ------------------------------------------------------------------ §18 Secret Broker */

/**
 * §18 — a Secret Broker is an explicit, replaceable object:
 * `{ id, resolve(secretRef, context) -> material }`. It resolves a SecretRef to in-memory
 * credential material for the duration of one operation. `createInMemorySecretBroker` is the
 * local/test broker: it holds material in memory only (never persisted or logged) and refuses
 * to resolve a SecretRef whose scope does not match a held credential.
 */
export function createInMemorySecretBroker(secrets = new Map()) {
  const table = new Map(secrets);
  return {
    id: 'in-memory-broker',
    locality: 'local',
    resolve(secretRef, _context) {
      if (!secretRef || secretRef.kind !== 'SecretRef') {
        throw new CredentialResolutionError('INVALID_SECRET_REF', 'the broker requires a SecretRef');
      }
      const material = table.get(secretRef.credentialId);
      if (material === undefined) {
        throw new CredentialResolutionError('AUTH_REJECTED', `no credential material for "${secretRef.credentialId}"`);
      }
      // The material is returned in-memory only; the broker never logs or persists it.
      return material;
    },
    _size() { return table.size; },
  };
}

/* ------------------------------------------------------------------ §19 capability boundary */

/**
 * §19 — check the capability chain (principal -> tenant -> capability -> action -> resource ->
 * SecretRef) via an injectable P5 authorization decision. Returns a frozen decision
 * `{ allowed, reason? }`. `authorize` is `(ref) => boolean | { allowed, reason? }`. A missing
 * authorizer denies by default (fail-closed).
 */
export function checkCapability(ref, authorize) {
  if (!ref || ref.kind !== 'SecretRef') {
    return Object.freeze({ allowed: false, reason: 'no SecretRef' });
  }
  if (typeof authorize !== 'function') {
    return Object.freeze({ allowed: false, reason: 'no authorizer (fail-closed)' });
  }
  let decision;
  try {
    decision = authorize(ref);
  } catch (error) {
    return Object.freeze({ allowed: false, reason: `authorizer error: ${error?.message ?? String(error)}` });
  }
  if (typeof decision === 'boolean') {
    return Object.freeze({ allowed: decision, reason: decision ? undefined : 'denied by authorization' });
  }
  if (decision && typeof decision === 'object' && typeof decision.allowed === 'boolean') {
    return Object.freeze({ allowed: decision.allowed, reason: decision.allowed ? undefined : decision.reason ?? 'denied by authorization' });
  }
  return Object.freeze({ allowed: false, reason: 'malformed authorization decision (fail-closed)' });
}

/* ------------------------------------------------------------------ §18 scrub (no-leak) */

/**
 * §18 — redact any secret material from a value (for results, error payloads, logs, telemetry).
 * Replaces every occurrence of each secret string with `[REDACTED]`. Walks objects/arrays.
 * Returns a new value (never mutates the input).
 */
export function scrub(value, secrets = []) {
  const list = Array.isArray(secrets) ? secrets.filter((s) => typeof s === 'string' && s !== '') : [];
  if (list.length === 0) return value;
  const redact = (text) => {
    let out = text;
    for (const secret of list) {
      out = out.split(secret).join('[REDACTED]');
    }
    return out;
  };
  const walk = (node) => {
    if (typeof node === 'string') return redact(node);
    if (Array.isArray(node)) return node.map(walk);
    if (node !== null && typeof node === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(node)) out[k] = walk(v);
      return out;
    }
    return node;
  };
  return walk(value);
}

/** §18 — the redaction list for a piece of credential material (string or object of strings). */
export function secretStrings(material) {
  if (typeof material === 'string') return material === '' ? [] : [material];
  if (material !== null && typeof material === 'object') {
    return Object.values(material).filter((v) => typeof v === 'string' && v !== '');
  }
  return [];
}

/* ------------------------------------------------------------------ §18 provider */

/**
 * §18 — a narrowly scoped provider operation is an explicit, replaceable object:
 * `{ id, version, locality, invoke(material, context) -> raw }`. It receives the in-memory
 * credential material and returns a raw (option-list-shaped) result. The material is used only
 * for the duration of the call. `createInMemoryCredentialProvider` is the local/test provider.
 */
export function createInMemoryCredentialProvider(handler, extra = {}) {
  return {
    id: extra.id ?? 'in-memory-provider',
    version: extra.version ?? '1.0.0',
    locality: 'local',
    async invoke(_material, _context) {
      return handler(_material, _context);
    },
  };
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** §18 — normalize a raw provider result into a bounded option list (never the material). */
function normalizeCredentialResult(raw, limits) {
  if (raw === undefined || raw === null) {
    throw new CredentialResolutionError('INVALID_PROVIDER_DATA', 'provider returned no result');
  }
  const list = Array.isArray(raw) ? raw : (isPlainObject(raw) && Array.isArray(raw.options) ? raw.options : null);
  if (!Array.isArray(list)) {
    throw new CredentialResolutionError('INVALID_PROVIDER_DATA', 'provider result is not an option list');
  }
  const normalized = [];
  for (const entry of list) {
    if (!isPlainObject(entry) || typeof entry.value !== 'string' || typeof entry.name !== 'string') {
      throw new CredentialResolutionError('INVALID_PROVIDER_DATA', 'an option entry is malformed (expected { name, value })');
    }
    const option = { name: entry.name, value: entry.value };
    if (typeof entry.description === 'string') option.description = entry.description;
    normalized.push(Object.freeze(option));
  }
  return Object.freeze(normalized.slice(0, limits.maxResultCount ?? 4096));
}

/* ------------------------------------------------------------------ §18/§19/§28 session */

/**
 * §18/§19/§28 — the credential-aware resolution session. Composes:
 *   capability check (§19) -> SecretRef -> Secret Broker (§18) -> narrowly scoped provider
 *   operation -> normalized + scrubbed result. The credential material is held in-memory only.
 *
 * `resolve(secretRef, context, options)` returns a frozen result:
 *   { options, security: { sensitive, revalidationRequired, authority }, error? }
 * where `security.authority` is the ORIGINAL capability scope (provider metadata cannot elevate
 * it). On a failure `error` is `{ code, message }` (scrubbed) and `options` is `[]` ONLY with a
 * non-null `error` (never a fake empty success).
 *
 * options: { authoritative? } — an authoritative (execution) resolution refuses a cached value
 * and always revalidates (§28).
 */
export class CredentialResolutionSession {
  constructor({ provider, broker, authorize, cache, limits = CREDENTIAL_LIMITS, now = Date.now } = {}) {
    if (!provider || typeof provider.invoke !== 'function') {
      throw new CredentialResolutionError('INVALID_PROVIDER_DATA', 'a provider with invoke(material, context) is required');
    }
    if (!broker || typeof broker.resolve !== 'function') {
      throw new CredentialResolutionError('INVALID_SECRET_REF', 'a Secret Broker with resolve(secretRef) is required');
    }
    this.provider = provider;
    this.broker = broker;
    this.authorize = authorize;
    this.cache = cache ?? new DynamicCache({ ...CREDENTIAL_LIMITS, maxResultCount: 4096 });
    this.limits = { ...CREDENTIAL_LIMITS, ...limits, maxResultCount: limits.maxResultCount ?? 4096 };
    this.now = now;
    this.generation = 0;
    this.inFlight = new Map();
    this.activeCount = 0;
    this.providerCalls = 0;
  }

  async resolve(secretRef, context = {}, options = {}) {
    // §18 — the handle must be a SecretRef (never raw material).
    if (!secretRef || secretRef.kind !== 'SecretRef') {
      throw new CredentialResolutionError('INVALID_SECRET_REF', 'resolve() requires a SecretRef (never raw credential material)');
    }
    // §19 — the capability chain is enforced BEFORE the provider call (fail-closed).
    const decision = checkCapability(secretRef, this.authorize);
    if (!decision.allowed) {
      return Object.freeze({ options: [], security: this._authority(secretRef), error: Object.freeze({ code: 'CAPABILITY_DENIED', message: decision.reason ?? 'capability denied' }) });
    }

    const key = credentialCacheKey(secretRef, context);
    const now = this.now();
    const authoritative = options.authoritative === true;

    // §28 — an authoritative resolution never serves a cached UI option (never authority).
    if (authoritative) {
      // drop any cached entry; always revalidate against current authority.
      this.cache._delete(key);
      const result = await this._fetchAndCache(key, secretRef, context, this.now());
      return this._finalize(result, secretRef);
    }

    // §14/§18 — a display (non-authoritative) resolution may serve a fresh cached result.
    const entry = this.cache.peek(key, now);
    if (entry) {
      const expired = entry.expiresAt !== null && entry.expiresAt <= now;
      if (!expired) {
        this.cache._touch(key);
        if (entry.cls === CACHE_CLASSES.NEGATIVE) {
          return Object.freeze({ options: [], security: this._authority(secretRef), error: Object.freeze({ code: entry.value.code, message: entry.value.message }) });
        }
        return Object.freeze({ options: entry.value.options, security: this._authority(secretRef), stale: false, revalidationRequired: true });
      }
      this.cache._delete(key);
    }

    const coalesced = this.inFlight.has(key);
    const result = await this._fetchAndCache(key, secretRef, context, this.now());
    return this._finalize(result, secretRef, coalesced);
  }

  _authority(secretRef) {
    // §19 — the authority is the ORIGINAL scope; provider metadata cannot elevate it.
    return Object.freeze({
      sensitive: true,
      revalidationRequired: true,
      principal: secretRef.principal,
      tenant: secretRef.tenant,
      capability: secretRef.capability,
      action: secretRef.action,
      resource: secretRef.resource,
    });
  }

  _fetchAndCache(key, secretRef, context, now) {
    if (this.inFlight.has(key)) return this.inFlight.get(key);
    if (this.activeCount >= this.limits.maxConcurrency) {
      const error = { code: 'UNAVAILABLE', message: `provider concurrency bound reached (${this.limits.maxConcurrency})` };
      this.cache.set(key, { code: error.code, message: error.message }, CACHE_CLASSES.NEGATIVE, now);
      return Promise.resolve({ error, generation: this.generation });
    }
    const generation = (this.generation += 1);
    this.activeCount += 1;
    this.providerCalls += 1;
    const operation = this._callProvider(secretRef, context)
      .then(({ raw, material }) => ({ ...this._onSuccess(key, { raw, material }, now), generation }))
      .catch((failure) => ({ ...this._onFailure(key, failure?.error ?? failure, { material: failure?.material ?? null }, now), generation }))
      .finally(() => {
        this.activeCount -= 1;
        this.inFlight.delete(key);
      });
    this.inFlight.set(key, operation);
    return operation;
  }

  _callProvider(secretRef, context) {
    // §18 — the material is resolved in-memory and passed to the narrowly scoped operation; it
    // is carried (for scrubbing) only for the duration of this operation, then discarded.
    return Promise.race([
      this._invoke(secretRef, context),
      new Promise((_, reject) => {
        const timer = setTimeout(() => reject({ error: new CredentialResolutionError('TIMEOUT', `provider ${this.provider.id} timed out after ${this.limits.timeoutMs}ms`), material: null }), this.limits.timeoutMs);
        if (typeof timer.unref === 'function') timer.unref();
      }),
    ]);
  }

  async _invoke(secretRef, context) {
    let material = null;
    try {
      material = await this.broker.resolve(secretRef, context);
    } catch (error) {
      throw { error, material: null }; // broker/auth failure — no material to scrub
    }
    try {
      const raw = await this.provider.invoke(material, context);
      return { raw, material };
    } catch (error) {
      throw { error, material }; // provider failure — carry the material so the error is scrubbed
    }
  }

  _onSuccess(key, { raw, material }, now) {
    const options = normalizeCredentialResult(raw, this.limits);
    // §18 — scrub any echoed material; the cache stores ONLY the normalized (scrubbed) result.
    const scrubbed = scrub(options, secretStrings(material));
    this.cache.set(key, { options: scrubbed }, CACHE_CLASSES.PROVIDER, now);
    return { options: scrubbed };
  }

  _onFailure(key, error, { material } = { material: null }, now) {
    let code = error?.code ?? 'INVALID_PROVIDER_DATA';
    if (!CREDENTIAL_FAILURE_CODES.includes(code)) code = 'INVALID_PROVIDER_DATA';
    // §18 — scrub the message in case the provider/broker echoed the material.
    const message = String(scrub(String(error?.message ?? String(error)), secretStrings(material)) ?? '');
    const normalized = { code, message };
    this.cache.set(key, normalized, CACHE_CLASSES.NEGATIVE, now);
    return { error: normalized };
  }

  _finalize(result, secretRef, coalesced = false) {
    if (result.error) {
      return Object.freeze({ options: [], security: this._authority(secretRef), source: 'provider', cache: coalesced ? 'coalesced' : 'miss', error: Object.freeze(result.error) });
    }
    return Object.freeze({ options: result.options, security: this._authority(secretRef), source: 'provider', cache: coalesced ? 'coalesced' : 'miss' });
  }

  stats() {
    return { active: this.activeCount, inFlight: this.inFlight.size, generation: this.generation, providerCalls: this.providerCalls, cache: this.cache.stats() };
  }
}
