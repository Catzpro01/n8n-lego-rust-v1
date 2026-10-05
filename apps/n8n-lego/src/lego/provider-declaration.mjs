/**
 * Provider declaration profile — declared providers, handed-over access (P2.26).
 *
 * PUBLIC CONTRACT (`ai.provider-declaration`, v1.0.0, owner: manager).
 *
 * P2.26 implements exactly two boundaries here:
 *
 *   1. PROVIDER DECLARATION PROFILE — `sim | local | cloud`. Providers are
 *      DECLARED, never assumed: no hidden discovery, no automatic selection,
 *      no standing provider authority, no stored credential. Configuration
 *      stays explicit on the P2.25 adapters; this contract adds the missing
 *      declaration axis — WHERE a provider runs — without touching those
 *      closed configuration shapes.
 *
 *   2. HANDED-OVER ACCESS — the GitHub/application integration boundary is
 *      scoped and request-bound: an opaque grant reference, a declared scope
 *      list, a requestId. A raw credential in any field is refused by value
 *      shape (full canonical detector quoted from ai.token-usage@1.0.0), so a
 *      standing token can never be stored, logged or echoed. GitHub remains
 *      an integration boundary behind application-provider capabilities — this
 *      module never imports a client and never names an endpoint.
 *
 * WHAT THIS MODULE IS NOT
 * -----------------------
 * Not a provider client, not a discovery service, not a credential store, not
 * a GitHub SDK, not a Workspace implementation. Workspace stays exactly
 * `ai.workspace@1.0.0` (P2.15 — no second implementation, internals never
 * moved into AI Foundation). No filesystem, shell, subprocess, HTTP or any
 * ambient authority: zero `node:*` imports beyond the foundation vocabulary
 * this file quotes from, no `console.*`, time and identity never minted here.
 *
 * ZERO-INSTALL HOLDS (manifest#zeroInstall): the foundation with NO provider
 * declared is a fully valid state — declaring a provider is an operator act,
 * and the absence of a declaration is reported honestly, never backfilled.
 *
 * Owner: manager (shared boundary vocabulary — same discipline as P2.25).
 */
import { AI_FOUNDATION, PROVIDER_KINDS } from './ai-foundation.mjs';
import { SENSITIVE_USAGE_RE } from './token-usage.mjs';

/** The declaration contract this module publishes. */
export const PROVIDER_DECLARATION_CONTRACT = Object.freeze({
  id: 'ai.provider-declaration',
  version: '1.0.0',
  owner: 'manager',
});

/** Pinned contract version string for pin-style assertions. */
export const PROVIDER_DECLARATION_CONTRACT_VERSION = PROVIDER_DECLARATION_CONTRACT.version;

/**
 * The canonical provider declaration profile — quoted byte-for-byte from
 * `manifest/ai-foundation.json#providerProfiles.profiles`. Exactly three
 * words; a fourth profile is a contract change, not a configuration flag.
 */
export const PROVIDER_PROFILES = Object.freeze([
  ...Object.keys(AI_FOUNDATION.providerProfiles.profiles),
]);

/**
 * The closed declaration shape. Three fields, nothing else: an unknown field
 * and a credential-shaped field are both refusals, so this record cannot carry
 * a secret even by accident.
 */
export const PROVIDER_DECLARATION_FIELDS = Object.freeze([
  'providerId',
  'kind',
  'profile',
]);

/**
 * The handed-over access rules — quoted byte-for-byte from
 * `manifest/ai-foundation.json#applicationProvider.handedOverAccess`
 * (the GitHub-class integration boundary: handed over, scoped, request-bound;
 * never stored credential, standing token, global repository authority or
 * implicit account discovery).
 */
export const INTEGRATION_ACCESS_RULES = Object.freeze(
  AI_FOUNDATION.applicationProvider.handedOverAccess,
);

/** One error family; the code is published in the errors contract 1.2.0 (untouched). */
export class ProviderDeclarationError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ProviderDeclarationError';
    this.code = 'lego.contract_violation';
    const safe = {};
    for (const [key, value] of Object.entries(details)) {
      safe[key] = typeof value === 'string' && SENSITIVE_USAGE_RE.test(value)
        ? '[redacted]'
        : value;
    }
    this.details = Object.freeze(safe);
  }
}

function fail(message, details) {
  throw new ProviderDeclarationError(message, details);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/* Local quoting of the canonical opaque-reference grammar (same rules the
 * P2.25 adapters apply — path-shaped, traversal and credential values refused). */
const REFERENCE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const TRAVERSAL_RE = /(^|\/)\.\.(\/|$)/;
const ABSOLUTE_PATH_RE = /^(?:\/|~\/|[A-Za-z]:[\\/])/;
const SCOPE_WORD_RE = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;

const DECLARATION_LIMITS = Object.freeze({
  maxProviderIdLength: 128,
  maxScopeEntries: 32,
  maxScopeWordLength: 64,
  maxRequestIdLength: 128,
  maxDetailLength: 64,
});

/** Credential field names that may never appear in a declaration or handoff. */
const FORBIDDEN_FIELDS = Object.freeze([
  'apiKey', 'token', 'credential', 'credentials', 'authorization',
  'headers', 'secret', 'password',
]);

function refuseForbiddenFields(declaration) {
  for (const key of Object.keys(declaration)) {
    if (FORBIDDEN_FIELDS.includes(key)) {
      fail(
        `'${key}' may never appear — declarations and handoffs never store, log or echo credentials`,
        { field: key, reason: 'credential-field-refused' },
      );
    }
  }
}

function assertBoundedIdentifier(value, field, maxLength) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    fail(`${field} must be a bounded identifier (1..${maxLength} chars)`, {
      field,
      limit: maxLength,
    });
  }
  if (SENSITIVE_USAGE_RE.test(value)) {
    fail(`${field} carries a credential-shaped value`, {
      field,
      reason: 'credential-shaped-value',
    });
  }
  return value;
}

function assertOpaqueReference(value, field) {
  assertBoundedIdentifier(value, field, DECLARATION_LIMITS.maxProviderIdLength);
  if (!REFERENCE_ID_RE.test(value) || TRAVERSAL_RE.test(value) || ABSOLUTE_PATH_RE.test(value)) {
    fail(`${field} must be an opaque reference — path-shaped values are refused`, {
      field,
      reason: 'not-an-opaque-reference',
    });
  }
  return value;
}

/**
 * Describe a declared provider profile: `sim`, `local` or `cloud`.
 * Unknown profiles answer `null` — never a guess, never a default.
 *
 * @param {string} profile one of PROVIDER_PROFILES
 * @returns {object|null}
 */
export function describeProviderProfile(profile) {
  if (typeof profile !== 'string') return null;
  return AI_FOUNDATION.providerProfiles.profiles[profile] ?? null;
}

/**
 * Validate a provider declaration — declared, not assumed.
 *
 * Closed three-field shape; kind must be a published PROVIDER_KINDS word,
 * profile must be one of the three canonical profiles (exact case). Nothing
 * is defaulted: a missing profile is an error, not an auto-selection. The
 * returned declaration is a frozen copy — later mutation of the input cannot
 * rewrite what was declared.
 *
 * @param {{providerId: string, kind: string, profile: string}} declaration
 * @returns {Readonly<{providerId: string, kind: string, profile: string}>}
 */
export function assertProviderDeclaration(declaration) {
  if (!isPlainObject(declaration)) {
    fail('a provider declaration must be a plain object — there is no implicit provider', {
      field: 'declaration',
    });
  }
  refuseForbiddenFields(declaration);
  for (const key of Object.keys(declaration)) {
    if (!PROVIDER_DECLARATION_FIELDS.includes(key)) {
      fail(`unknown declaration field '${key}' — the provider declaration shape is closed`, {
        field: key,
      });
    }
  }
  for (const field of PROVIDER_DECLARATION_FIELDS) {
    if (declaration[field] === undefined || declaration[field] === null || declaration[field] === '') {
      fail(
        `${field} is required — a provider is declared, never assumed, discovered or selected by default`,
        { field },
      );
    }
  }
  const providerId = assertOpaqueReference(declaration.providerId, 'providerId');
  if (typeof declaration.kind !== 'string' || !PROVIDER_KINDS.includes(declaration.kind)) {
    fail(`kind must name a published provider kind (${PROVIDER_KINDS.join(', ')})`, {
      field: 'kind',
      reason: 'undeclared-kind',
    });
  }
  if (typeof declaration.profile !== 'string' || !PROVIDER_PROFILES.includes(declaration.profile)) {
    fail(
      `profile must be exactly one of ${PROVIDER_PROFILES.join(' | ')} — profiles are declared words, not case-insensitive flags`,
      { field: 'profile', reason: 'undeclared-profile' },
    );
  }
  return Object.freeze({
    providerId,
    kind: declaration.kind,
    profile: declaration.profile,
  });
}

/**
 * Validate a handed-over access record for an application integration
 * boundary (GitHub is the canonical example): an opaque grant reference, a
 * declared scope list, a requestId. It is request-bound by construction —
 * without a requestId the handoff is refused, so access can never become
 * standing. Raw credentials fail the opaque-reference grammar and the full
 * canonical credential detector; bare prefixes (`sk-`, `ghp_`) are NOT
 * credentials (P2.23 lesson: full forms only, never prefix false-positives).
 *
 * Authority is never granted here: this validator only proves the handoff is
 * well-formed; `ai.approval` decides the grant, exactly like P2.25.
 *
 * @param {{grantReference: string, scope: string[], requestId: string}} handoff
 * @returns {Readonly<{grantReference: string, scope: readonly string[], requestId: string}>}
 */
export function assertHandedOverAccess(handoff) {
  if (!isPlainObject(handoff)) {
    fail('a handed-over access record must be a plain object — standing access does not exist', {
      field: 'handoff',
    });
  }
  refuseForbiddenFields(handoff);
  const allowed = ['grantReference', 'scope', 'requestId'];
  for (const key of Object.keys(handoff)) {
    if (!allowed.includes(key)) {
      fail(`unknown handoff field '${key}' — the handed-over access shape is closed`, { field: key });
    }
  }
  if (handoff.grantReference === undefined || handoff.grantReference === null || handoff.grantReference === '') {
    fail('grantReference is required — access is handed over explicitly, never ambient', {
      field: 'grantReference',
    });
  }
  if (handoff.scope === undefined || handoff.scope === null) {
    fail('scope is required — handed-over access is scoped, never global', { field: 'scope' });
  }
  if (!Array.isArray(handoff.scope) || handoff.scope.length === 0) {
    fail('scope must be a non-empty list of declared capability words', {
      field: 'scope',
      reason: 'scope-not-scoped',
    });
  }
  if (handoff.scope.length > DECLARATION_LIMITS.maxScopeEntries) {
    fail(`scope may declare at most ${DECLARATION_LIMITS.maxScopeEntries} entries`, {
      field: 'scope',
      limit: DECLARATION_LIMITS.maxScopeEntries,
    });
  }
  if (handoff.requestId === undefined || handoff.requestId === null || handoff.requestId === '') {
    fail('requestId is required — handed-over access is request-bound, never standing', {
      field: 'requestId',
    });
  }
  const grantReference = assertOpaqueReference(handoff.grantReference, 'grantReference');
  const scope = handoff.scope.map((word, index) => {
    if (typeof word !== 'string' || word.length === 0
      || word.length > DECLARATION_LIMITS.maxScopeWordLength) {
      fail(`scope[${index}] must be a bounded capability word`, {
        field: 'scope',
        limit: DECLARATION_LIMITS.maxScopeWordLength,
      });
    }
    if (SENSITIVE_USAGE_RE.test(word)) {
      fail(`scope[${index}] carries a credential-shaped value — scopes name capabilities, never secrets`, {
        field: 'scope',
        reason: 'credential-shaped-value',
      });
    }
    if (!SCOPE_WORD_RE.test(word)) {
      fail(`scope[${index}] must be a lower-kebab/dot capability word (e.g. repo.read)`, {
        field: 'scope',
        reason: 'not-a-capability-word',
      });
    }
    return word;
  });
  const requestId = assertBoundedIdentifier(handoff.requestId, 'requestId',
    DECLARATION_LIMITS.maxRequestIdLength);
  return Object.freeze({
    grantReference,
    scope: Object.freeze([...scope]),
    requestId,
  });
}
