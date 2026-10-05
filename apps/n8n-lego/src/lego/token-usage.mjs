/**
 * ai.token-usage@1.0.0 — Token & Usage honest accounting (P2.24).
 *
 * One canonical publisher for token/cost usage figures (XA-17 resolution:
 * exactly this contract, under the ai-foundation domain — no second
 * publisher, no parallel vocabulary). Every figure carries provenance:
 *
 *   reported    — the source actually supplied this number
 *   estimated   — a caller-identified, deterministic estimator produced it
 *   unavailable — nobody reported it and no estimator applies
 *
 * Unavailable is `null`, never `0`. A missing figure is never invented as
 * fact, never coerced to zero, never presented as exact. Cost is derived
 * only from reported usage + a known pricing basis + a declared calculation
 * rule; this module ships no pricing, fetches nothing, and settles nothing —
 * P2.24 is accounting, not billing.
 *
 * The module has ZERO imports (no builtin, no cross-domain reach): time and
 * identity are injected (`now`, `newId`) exactly as in P2.19/P2.23, records
 * are frozen on arrival, the store is bounded, and record shapes are closed —
 * prompt/completion/credential material cannot enter a usage record even by
 * accident, because unknown fields are refused at the door.
 *
 * Owner: manager. Implementation: agent-1 (P2.24).
 */

/* ------------------------------------------------------------------ contract */

export const TOKEN_USAGE_CONTRACT = 'ai.token-usage@1.0.0';
export const TOKEN_USAGE_CONTRACT_VERSION = '1.0.0';

/** The three operations the AI set already declares for this contract. */
export const TOKEN_USAGE_OPERATIONS = Object.freeze(['record', 'query', 'budget']);
/** Permissions the operations refuse callers by — lock, capability and module agree. */
export const TOKEN_USAGE_PERMISSIONS = Object.freeze(['ai:usage:read', 'ai:usage:write']);

/**
 * The P2.13 token vocabulary, quoted byte-for-byte from
 * `manifest/reference-scenarios.json#scenarios[id=context-rollover].tokenKinds`.
 * No provider-shaped synonyms are coined here (input-token, prompt-token,
 * completion-token spellings stay outside the vocabulary); provider-specific
 * terms map onto these three only through a documented mapping outside this
 * contract.
 */
export const TOKEN_KINDS = Object.freeze(['message', 'modelInput', 'output']);

/**
 * The certainty a figure carries — the whole honest-accounting vocabulary.
 * `reported` claims the source gave the number; `estimated` claims a named
 * deterministic method produced it; `unavailable` claims nobody produced it
 * (value is `null`). These three never blur into each other.
 */
export const USAGE_STATUSES = Object.freeze(['reported', 'estimated', 'unavailable']);

/** The only unit this contract records — token counts, nothing else. */
export const USAGE_UNITS = Object.freeze(['tokens']);

/**
 * The scopes XA-17 asks about: per call, per run, per session. A record
 * names one scope level and one opaque reference; the foundation does not
 * invent a hierarchy between them — callers decide which records share a
 * scope, and `budget` aggregates exactly the records that match.
 */
export const USAGE_SCOPES = Object.freeze(['call', 'run', 'session']);

/** Declared calculation rules for cost. Unknown rule ids are refused. */
export const COST_RULES = Object.freeze(['linear-input-output']);

/**
 * What a derived cost may claim:
 *   calculated  — reported usage + known pricing + declared rule
 *   estimated   — at least one input figure was estimated (never "actual")
 *   unavailable — a required input or the pricing basis is missing
 */
export const COST_STATUSES = Object.freeze(['calculated', 'estimated', 'unavailable']);

/** Closed record shape — anything else is a contract violation at the door. */
export const TOKEN_USAGE_FIELDS = Object.freeze([
  'recordId', 'requestId', 'scopeLevel', 'scopeRef',
  'kind', 'value', 'unit', 'status', 'source', 'estimator', 'createdAt',
]);

/**
 * Field names that may never appear in a usage record (§7 privacy boundary).
 * The closed shape already refuses unknown fields; this list names the
 * privacy-relevant ones explicitly so the refusal message says WHY.
 */
export const FORBIDDEN_USAGE_FIELDS = Object.freeze([
  'prompt', 'completion', 'reasoning', 'thoughts', 'hiddenReasoning',
  'credential', 'credentials', 'authorization', 'apiKey', 'api-key',
  'secret', 'password', 'privateKey', 'cookie', 'header', 'headers',
  'body', 'text', 'content',
]);

/**
 * Full canonical credential shapes (never bare prefixes — a detector that
 * matched `ghp_` anywhere would flag its own regex literal, the false
 * positive P2.23 already paid for). String identity fields are scanned
 * against these so a secret cannot be laundered through `source`,
 * `estimator`, `scopeRef` or `requestId`.
 */
export const SENSITIVE_USAGE_RE = Object.freeze(
  /(?:BEGIN\s+(?:RSA|OPENSSH|PRIVATE)\s+KEY|(?:^|\W)sk-[A-Za-z0-9]{20,}|(?:^|\W)ghp_[A-Za-z0-9]{36}|(?:^|\W)github_pat_[A-Za-z0-9_]{20,}|Bearer\s+[A-Za-z0-9._-]{20,})/,
);

/** Bounds — records, strings and token values are all finite. */
export const USAGE_LIMITS = Object.freeze({
  maxRecords: 4096,
  maxRequestIdLength: 128,
  maxScopeRefLength: 128,
  maxSourceLength: 64,
  maxEstimatorLength: 64,
  maxTokenValue: 10_000_000_000,
  maxBudgetLimit: 10_000_000_000,
});

/**
 * The one error family the repository already has — accounting refuses with
 * `lego.contract_violation`, it does not invent a namespace.
 */
export class TokenUsageError extends Error {
  constructor(message, meta = {}) {
    super(message);
    this.name = 'TokenUsageError';
    this.code = 'lego.contract_violation';
    this.meta = Object.freeze({ ...meta });
  }
}

/* ---------------------------------------------------------------- helpers */

const USAGE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const SOURCE_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const ESTIMATOR_RE = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,63}$/;

function fail(message, meta = {}) {
  throw new TokenUsageError(message, meta);
}

function assertBoundedString(value, field, pattern, maxLength) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength || !pattern.test(value)) {
    fail(`${field} must be a bounded identifier (1..${maxLength} chars, [A-Za-z0-9._:@/-])`, {
      field,
      limit: maxLength,
    });
  }
  if (SENSITIVE_USAGE_RE.test(value)) {
    fail(`${field} carries a credential-shaped value — usage records hold identifiers, never secrets`, {
      field,
      reason: 'credential-shaped-value',
    });
  }
  return value;
}

function assertTokenCount(value, field) {
  if (!Number.isSafeInteger(value) || value < 0 || value > USAGE_LIMITS.maxTokenValue) {
    fail(`${field} must be a non-negative safe integer of token count (0..${USAGE_LIMITS.maxTokenValue})`, {
      field,
      limit: 'maxTokenValue',
    });
  }
  return value;
}

function freezeDeep(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) freezeDeep(value[key]);
    Object.freeze(value);
  }
  return value;
}

/**
 * Identity comparison over the ENTRY fields only: the stored record carries
 * `recordId` and `createdAt` (minted at first write), which a retry of the
 * same submission naturally does not repeat. `estimator` is normalised the
 * same way the record stores it (null unless estimated).
 */
const ENTRY_FIELDS = Object.freeze([
  'requestId', 'scopeLevel', 'scopeRef', 'kind', 'value', 'unit', 'status', 'source', 'estimator',
]);

function samePayload(record, entry) {
  const normalised = (subject) => JSON.stringify(
    ENTRY_FIELDS.slice().sort().map((k) => [k, k === 'estimator' ? (subject.estimator ?? null) : subject[k] ?? null]),
  );
  return normalised(record) === normalised(entry);
}

/* ---------------------------------------------------------------- cost (pure) */

/**
 * Derive cost from usage + pricing + a declared rule. Pure, offline, no
 * pricing tables inside the module — the caller hands over the pricing
 * basis it actually has (the optional `costPerInputToken` /
 * `costPerOutputToken` model metadata already declared by ai-foundation),
 * and when it does not, the answer is `unavailable`, never a guess.
 *
 * `message` is deliberately NOT an input: message tokens are a subset of
 * modelInput tokens, and accepting both would double-count by construction.
 */
export function calculateCost({ usage, pricingBasis = null, rule }) {
  if (!isPlainObject(usage)) fail('usage must map { modelInput, output } figures', { field: 'usage' });
  for (const key of Object.keys(usage)) {
    if (key !== 'modelInput' && key !== 'output') {
      fail(`calculateCost accepts only modelInput and output figures — '${key}' is refused so a subset cannot double-count`, {
        field: `usage.${key}`,
      });
    }
  }
  if (!COST_RULES.includes(rule)) {
    fail(`unknown calculation rule '${String(rule)}' — cost is derived only through a declared rule`, {
      field: 'rule',
      allowed: COST_RULES,
    });
  }

  const figure = (name) => {
    const entry = usage[name];
    if (entry === undefined || entry === null) return { value: null, certainty: 'unavailable' };
    if (!isPlainObject(entry)) fail(`usage.${name} must be { value, certainty } or null`, { field: `usage.${name}` });
    const { value, certainty } = entry;
    if (!USAGE_STATUSES.includes(certainty)) {
      fail(`usage.${name}.certainty must be one of ${USAGE_STATUSES.join(', ')}`, { field: `usage.${name}.certainty` });
    }
    if (certainty === 'unavailable') {
      if (value !== null) fail(`usage.${name} is unavailable — its value must be null, never a number (not even 0)`, { field: `usage.${name}.value` });
      return { value: null, certainty };
    }
    assertTokenCount(value, `usage.${name}.value`);
    return { value, certainty };
  };

  const input = figure('modelInput');
  const output = figure('output');

  if (input.value === null || output.value === null) {
    return freezeDeep({
      value: null,
      certainty: 'unavailable',
      rule,
      reason: 'usage-unavailable',
    });
  }

  if (pricingBasis === null || pricingBasis === undefined) {
    return freezeDeep({ value: null, certainty: 'unavailable', rule, reason: 'pricing-unavailable' });
  }
  if (!isPlainObject(pricingBasis)) fail('pricingBasis must be { costPerInputToken, costPerOutputToken } or null', { field: 'pricingBasis' });
  const rates = ['costPerInputToken', 'costPerOutputToken'];
  for (const rate of rates) {
    if (pricingBasis[rate] === undefined || pricingBasis[rate] === null) {
      return freezeDeep({ value: null, certainty: 'unavailable', rule, reason: 'pricing-unavailable' });
    }
    const amount = pricingBasis[rate];
    // 0 is a KNOWN price (a free model) — only a missing rate is unavailable.
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) {
      fail(`pricingBasis.${rate} must be a non-negative finite number when present`, { field: `pricingBasis.${rate}` });
    }
  }

  const value = input.value * pricingBasis.costPerInputToken
    + output.value * pricingBasis.costPerOutputToken;
  if (!Number.isFinite(value)) fail('derived cost is not finite — inputs refused', { field: 'value' });

  const certainty = (input.certainty === 'reported' && output.certainty === 'reported')
    ? 'calculated'
    : 'estimated';
  return freezeDeep({ value, certainty, rule });
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/* ---------------------------------------------------------------- foundation */

/**
 * Create the usage foundation. `now` and `newId` are REQUIRED — the module
 * never reads a wall clock or ambient randomness (P2.19/P2.23 discipline).
 */
export function createTokenUsageFoundation({ now, newId } = {}) {
  if (typeof now !== 'function' || typeof newId !== 'function') {
    throw new TokenUsageError('now and newId must be injected (no ambient clock, no ambient id)');
  }

  /** requestId → frozen record. Idempotency lives here (§14), not in a counter. */
  const byRequest = new Map();
  /** recordId → frozen record, for direct reads. */
  const byId = new Map();

  function validateEntry(entry) {
    if (!isPlainObject(entry)) fail('a usage record entry must be an object', { field: 'entry' });

    for (const key of Object.keys(entry)) {
      if (FORBIDDEN_USAGE_FIELDS.includes(key)) {
        fail(`'${key}' may never appear in a usage record — accounting stores counts and identifiers, never content or credentials`, {
          field: key,
          reason: 'forbidden-usage-field',
        });
      }
      if (!TOKEN_USAGE_FIELDS.includes(key) || key === 'recordId' || key === 'createdAt') {
        fail(`unknown field '${key}' in a usage record — the shape is closed`, { field: key });
      }
    }

    assertBoundedString(entry.requestId, 'requestId', USAGE_ID_RE, USAGE_LIMITS.maxRequestIdLength);
    if (!USAGE_SCOPES.includes(entry.scopeLevel)) {
      fail(`scopeLevel must be one of ${USAGE_SCOPES.join(', ')}`, { field: 'scopeLevel' });
    }
    assertBoundedString(entry.scopeRef, 'scopeRef', USAGE_ID_RE, USAGE_LIMITS.maxScopeRefLength);
    if (!TOKEN_KINDS.includes(entry.kind)) {
      fail(`kind must be one of ${TOKEN_KINDS.join(', ')}`, { field: 'kind' });
    }
    if (!USAGE_UNITS.includes(entry.unit)) {
      fail(`unit must be one of ${USAGE_UNITS.join(', ')}`, { field: 'unit' });
    }
    if (!USAGE_STATUSES.includes(entry.status)) {
      fail(`status must be one of ${USAGE_STATUSES.join(', ')}`, { field: 'status' });
    }
    assertBoundedString(entry.source, 'source', SOURCE_RE, USAGE_LIMITS.maxSourceLength);

    const { status, value, estimator } = entry;
    if (status === 'unavailable') {
      if (value !== null) {
        fail('an unavailable figure must be null — never a number, never 0 (missing is not zero)', {
          field: 'value',
          status,
        });
      }
      if (estimator !== undefined && estimator !== null) {
        fail('an unavailable figure carries no estimator — there is nothing to estimate from', { field: 'estimator' });
      }
    } else {
      assertTokenCount(value, 'value');
      if (status === 'estimated') {
        if (typeof estimator !== 'string' || estimator.length === 0 || estimator.length > USAGE_LIMITS.maxEstimatorLength || !ESTIMATOR_RE.test(estimator)) {
          fail('an estimated figure must name its estimator (bounded, identifiable) — an estimate without a method is not recordable', {
            field: 'estimator',
            limit: USAGE_LIMITS.maxEstimatorLength,
          });
        }
        if (SENSITIVE_USAGE_RE.test(estimator)) {
          fail('estimator carries a credential-shaped value', { field: 'estimator', reason: 'credential-shaped-value' });
        }
      } else if (estimator !== undefined && estimator !== null) {
        fail(`a ${status} figure must not carry an estimator — reported numbers are never produced by a method`, {
          field: 'estimator',
          status,
        });
      }
    }
  }

  const foundation = Object.freeze({
    /** Record one usage figure. Idempotent on `requestId` (§14). */
    record(entry) {
      validateEntry(entry);
      const existing = byRequest.get(entry.requestId);
      if (existing !== undefined) {
        if (!samePayload(existing, entry)) {
          fail(`requestId '${entry.requestId}' was already recorded with a different payload — identity reuse is refused, never overwritten`, {
            field: 'requestId',
            reason: 'request-id-reuse',
          });
        }
        return existing; // retry: same identity, same record, no double count
      }
      if (byId.size >= USAGE_LIMITS.maxRecords) {
        fail(`the usage store is bounded at ${USAGE_LIMITS.maxRecords} records`, {
          limit: 'maxRecords',
        });
      }
      const record = freezeDeep({
        recordId: `usg-${String(newId())}`,
        requestId: entry.requestId,
        scopeLevel: entry.scopeLevel,
        scopeRef: entry.scopeRef,
        kind: entry.kind,
        value: entry.value,
        unit: entry.unit,
        status: entry.status,
        source: entry.source,
        estimator: entry.status === 'estimated' ? entry.estimator : null,
        createdAt: String(now()),
      });
      byRequest.set(record.requestId, record);
      byId.set(record.recordId, record);
      return record;
    },

    /**
     * Read records. No filter → everything (bounded). Filters are exact
     * matches; the result is frozen and in insertion order, so the same
     * store always answers the same query identically.
     */
    query(filter = {}) {
      if (!isPlainObject(filter)) fail('query filter must be an object', { field: 'filter' });
      for (const key of Object.keys(filter)) {
        if (!['requestId', 'scopeLevel', 'scopeRef', 'kind', 'status'].includes(key)) {
          fail(`unknown query filter '${key}'`, { field: key });
        }
      }
      const matches = [];
      for (const record of byRequest.values()) {
        if (filter.requestId !== undefined && record.requestId !== filter.requestId) continue;
        if (filter.scopeLevel !== undefined && record.scopeLevel !== filter.scopeLevel) continue;
        if (filter.scopeRef !== undefined && record.scopeRef !== filter.scopeRef) continue;
        if (filter.kind !== undefined && record.kind !== filter.kind) continue;
        if (filter.status !== undefined && record.status !== filter.status) continue;
        matches.push(record);
      }
      return Object.freeze(matches);
    },

    /**
     * Aggregate one scope's records for one kind against a declared limit —
     * the honest budget view. Derivation rules, in order:
     *   no matching records            → unavailable (empty ≠ zero!)
     *   any matching record unavailable→ unavailable (a hole cannot be summed)
     *   any matching record estimated  → estimated   (worst certainty wins)
     *   all matching records reported  → reported
     * `over`/`remaining` exist only when `used` is derivable — unavailable
     * never means "within budget".
     */
    budget({ scopeLevel, scopeRef, kind, limit, unit = 'tokens' } = {}) {
      if (!USAGE_SCOPES.includes(scopeLevel)) fail(`scopeLevel must be one of ${USAGE_SCOPES.join(', ')}`, { field: 'scopeLevel' });
      assertBoundedString(scopeRef, 'scopeRef', USAGE_ID_RE, USAGE_LIMITS.maxScopeRefLength);
      if (!TOKEN_KINDS.includes(kind)) fail(`kind must be one of ${TOKEN_KINDS.join(', ')}`, { field: 'kind' });
      if (!USAGE_UNITS.includes(unit)) fail(`unit must be one of ${USAGE_UNITS.join(', ')}`, { field: 'unit' });
      assertTokenCount(limit, 'limit');
      if (limit > USAGE_LIMITS.maxBudgetLimit) fail(`limit exceeds ${USAGE_LIMITS.maxBudgetLimit}`, { field: 'limit', limit: 'maxBudgetLimit' });

      const records = foundation.query({ scopeLevel, scopeRef, kind });
      const base = { scopeLevel, scopeRef, kind, unit, limit };
      if (records.length === 0) {
        return freezeDeep({ ...base, used: null, remaining: null, over: null, certainty: 'unavailable', recordCount: 0 });
      }
      let used = 0;
      let certainty = 'reported';
      for (const record of records) {
        if (record.status === 'unavailable') {
          return freezeDeep({ ...base, used: null, remaining: null, over: null, certainty: 'unavailable', recordCount: records.length });
        }
        if (record.status === 'estimated') certainty = 'estimated';
        used += record.value;
      }
      if (used > USAGE_LIMITS.maxBudgetLimit) fail('aggregated usage exceeds the record bound', { limit: 'maxBudgetLimit' });
      const over = used > limit;
      return freezeDeep({
        ...base,
        used,
        remaining: over ? 0 : limit - used,
        over,
        certainty,
        recordCount: records.length,
      });
    },
  });

  return foundation;
}
