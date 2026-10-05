/**
 * P5.7 — API keys and machine identities at the storage/HTTP boundary.
 *
 *   /rest/api-keys           upstream wire contract (api-keys.controller.ts):
 *     GET    /                redacted list for the caller
 *     GET    /scopes          scopes the caller's role may place on a key
 *     POST   /                { label, scopes, expiresAt } -> key + rawApiKey ONCE
 *     PATCH  /:id             { label, scopes } -> { success: true }
 *     DELETE /:id             revoke -> { success: true }
 *   all behind global scope `apiKey:manage`, exactly like upstream.
 *
 *   authenticateMachineCredential()  the verifier a key-accepting surface calls.
 *     `/api/v1` (src/auth/public-api-routes.mjs, P5-M03) mounts it; worker and
 *     agent transports must use it too. `/rest/*` keeps accepting session
 *     cookies only, as upstream does.
 *
 *   service principals (workers / agents / MCP / gateway) — programmatic
 *     lifecycle over the P5.7 model, mounted by P5-M07:
 *     GET    /rest/service-principals          redacted list for the caller
 *     GET    /rest/service-principals/scopes   the vocabulary the caller may attenuate to
 *     POST   /rest/service-principals          { kind, label, scopes, expiresAt } -> record + rawApiKey ONCE
 *     PATCH  /rest/service-principals/:id      { ownerId } -> ownership transfer
 *     DELETE /rest/service-principals/:id      revoke -> { success: true }
 *   all behind the same global scope `apiKey:manage` as /rest/api-keys, so a
 *   member (global:member carries no apiKey:manage) cannot mint machine
 *   authority at all — the P5.7 debt item "members may create service
 *   principals" is closed by that guard, not by a new one.
 *
 * STORAGE. Keys and service principals live on their accountable owner's user
 * record (`apiKeys`, `servicePrincipals`), bounded per owner. No new store
 * collection: deleting the owner deletes every credential they could have
 * issued, which is the only safe default for authority that is derived from
 * theirs. `toPublicUser` is a whitelist, so neither field leaves the server
 * through any user payload.
 *
 * Differences from pinned n8n, all security-driven and invisible to the editor:
 *   - only a SHA-256 digest and a 4-character hint are stored (upstream stores
 *     the raw JWT);
 *   - requested scopes are honoured and attenuated to the role (upstream
 *     ignores them unless the enterprise `apiKeyScopes` licence is present, and
 *     then grants the role's full set);
 *   - effective scopes are re-intersected with the owner's CURRENT role on every
 *     use, so a demotion shrinks keys immediately.
 */
import { randomBytes } from 'node:crypto';

import { HttpError, badRequest, forbidden } from '../compat/error.mjs';
import { sendData } from '../compat/response.mjs';
import { requireUser } from '../compat/auth-context.mjs';
import { getGlobalScopes } from '../compat/scopes.mjs';
import { apiKeyScopesForRole, loadApiKeyScopes } from '../compat/api-key-scopes.mjs';
import { securityVersionFor } from '../auth.mjs';
import { createPermissionRegistry } from './security/permission-registry.mjs';
import {
  API_KEY_AUDIENCE,
  API_KEY_POLICY,
  API_KEY_VERDICT,
  apiKeyMatches,
  apiKeyVerdict,
  attenuateScopes,
  generateApiKey,
  lastUsedIsStale,
  parseApiKey,
  pruneTombstones,
  redactApiKey,
  revokeWithTombstone,
} from './security/api-key.mjs';
import {
  DEFAULT_TENANT_SECURITY_POLICY,
  MACHINE_IDENTITY_LIMITS,
  SERVICE_PRINCIPAL_KINDS,
  createServicePrincipalRecord,
  keyPolicyViolation,
  machineAuditEvent,
  machinePrincipal,
} from './security/machine-identity.mjs';
import { DEFAULT_TENANT } from './security/principal.mjs';

/** Upstream RESPONSE_ERROR_MESSAGES.MISSING_SCOPE. */
export const MISSING_SCOPE_MESSAGE = 'User is missing a scope required to perform this action';
const SCOPE_FORMAT = /^[a-zA-Z]+:[a-zA-Z]+$/;
const SCOPE_FORMAT_MESSAGE = "Each scope must follow the format '{resource}:{scope}' with only letters (e.g., 'workflow:create')";

/* ------------------------------------------------------- canonical universe */

/**
 * The P5.3 registry over the API-key vocabulary. Memoised per extracted
 * vocabulary object, so it is built once and never diverges from the file.
 */
const REGISTRIES = new WeakMap();
export function apiKeyPermissionRegistry(config) {
  const vocabulary = loadApiKeyScopes(config);
  if (vocabulary.all.length === 0) return null;
  let registry = REGISTRIES.get(vocabulary);
  if (!registry) {
    registry = createPermissionRegistry({ global: [{ scopes: vocabulary.all }] });
    REGISTRIES.set(vocabulary, registry);
  }
  return registry;
}

/* ----------------------------------------------------------------- helpers */

/** 96-bit opaque record id, base64url (no '.', so it is safe inside a key). */
function newCredentialId() {
  return randomBytes(12).toString('base64url');
}

function requireApiKeyScope(ctx) {
  const user = requireUser(ctx);
  if (!getGlobalScopes(user, ctx.config).includes('apiKey:manage')) throw forbidden(MISSING_SCOPE_MESSAGE);
  return user;
}

/**
 * Roles allowed to hold machine authority (DEC-0023).
 *
 * `apiKey:manage` cannot be reused here: pinned n8n 2.9.4 lists it inside
 * GLOBAL_MEMBER_SCOPES as well as the admin/owner sets
 * (reference/n8n/packages/@n8n/permissions/src/roles/scopes/global-scopes.ee.ts),
 * so a member passes the /rest/api-keys guard and would pass this one too. A
 * service principal is a separate identity that keeps working after the human
 * who created it is demoted or removed, so minting one is administration, not
 * self-service — while a member's own API key remains self-service.
 */
const SERVICE_PRINCIPAL_ROLES = Object.freeze(['global:owner', 'global:admin']);

function requireServicePrincipalAuthority(ctx) {
  const user = requireApiKeyScope(ctx);
  if (!SERVICE_PRINCIPAL_ROLES.includes(user.role ?? 'global:owner')) {
    audit(null, 'service-principal.denied', {
      ownerRef: user.id, reason: 'role-not-permitted-to-hold-machine-authority',
    });
    throw forbidden(MISSING_SCOPE_MESSAGE);
  }
  return user;
}

function publicApiKeys(user) {
  return (user.apiKeys ?? []).filter((key) => key.audience === API_KEY_AUDIENCE.PUBLIC_API && !key.revokedAt);
}

/** Upstream response shape (ApiKey + userId/audience), plus last-used metadata. */
function apiKeyDto(record, userId) {
  return {
    id: record.id,
    label: record.label,
    userId,
    scopes: [...record.scopes],
    audience: record.audience,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    apiKey: redactApiKey(record.hint),
    expiresAt: record.expiresAt ?? null,
    lastUsedAt: record.lastUsedAt ?? null,
  };
}

function validateLabel(label) {
  // Upstream: z.string().min(1).max(50) and an xss() round-trip; a value xss
  // would rewrite (any angle bracket) is refused rather than stored escaped.
  if (typeof label !== 'string' || label.length < 1 || label.length > API_KEY_POLICY.maxLabelLength || /[<>]/.test(label)) {
    throw badRequest(`label must be 1 to ${API_KEY_POLICY.maxLabelLength} characters, without markup`);
  }
  return label;
}

function validateScopeShape(scopes) {
  if (!Array.isArray(scopes) || scopes.length === 0) throw badRequest('scopes must contain at least one scope');
  for (const scope of scopes) if (typeof scope !== 'string' || !SCOPE_FORMAT.test(scope)) throw badRequest(SCOPE_FORMAT_MESSAGE);
  return scopes;
}

/**
 * Maps a security-kernel denial to its published HTTP status, the same way
 * `src/compat/credentials.mjs` does for the vault. Without this a refused
 * service principal escapes as a 500, which tells an operator the server broke
 * when in fact the request was correctly refused.
 */
function guarded(fn) {
  try {
    return fn();
  } catch (error) {
    if (error && error.name === 'SecurityError') {
      throw new HttpError(error.status ?? 500, error.message, { code: error.code });
    }
    throw error;
  }
}

function audit(logger, type, fields) {
  const event = machineAuditEvent(type, fields);
  logger?.info?.(`auth.${type}`, event);
  return event;
}

/* ----------------------------------------------------------- authentication */

/**
 * Verifies a presented machine credential and returns the principal it proves.
 * Never throws for a bad credential: every failure is `{ ok: false, verdict }`
 * with a reason for audit, and the caller answers a uniform 401.
 *
 * @param {object} input
 * @param {object} input.store
 * @param {object} input.config
 * @param {unknown} input.presented       the X-N8N-API-KEY value
 * @param {string} [input.audience]       API_KEY_AUDIENCE.PUBLIC_API (default) or .SERVICE
 * @param {object} [input.logger]
 * @param {number} [input.now]
 * @returns {{ ok: true, principal: object, record: object, owner: object } | { ok: false, verdict: string }}
 */
export function authenticateMachineCredential({ store, config, presented, audience = API_KEY_AUDIENCE.PUBLIC_API, logger = null, now = Date.now() }) {
  const parsed = parseApiKey(presented);
  if (!parsed) return { ok: false, verdict: API_KEY_VERDICT.MALFORMED };
  const owner = store.users.get(parsed.ownerId) ?? null;
  const field = audience === API_KEY_AUDIENCE.SERVICE ? 'servicePrincipals' : 'apiKeys';
  const record = (owner?.[field] ?? []).find((candidate) => candidate.id === parsed.keyId) ?? null;
  // The digest check runs whether or not a record was found, so an unknown key
  // and a wrong secret cost the same.
  const matches = apiKeyMatches(presented, record?.digest ?? 'x'.repeat(43));
  let verdict = matches ? apiKeyVerdict(record, { now, owner, audience }) : API_KEY_VERDICT.UNKNOWN;
  if (verdict !== API_KEY_VERDICT.OK) {
    audit(logger, audience === API_KEY_AUDIENCE.SERVICE ? 'service-principal.denied' : 'api-key.denied', {
      keyRef: record ? parsed.keyId : undefined,
      reason: verdict,
    });
    return { ok: false, verdict };
  }
  const registry = apiKeyPermissionRegistry(config);
  if (!registry) {
    verdict = 'authority-unavailable';
    return { ok: false, verdict };
  }
  const principal = machinePrincipal({
    record,
    owner,
    kind: audience === API_KEY_AUDIENCE.SERVICE ? 'service' : 'api-key',
    ownerGrantable: apiKeyScopesForRole(owner.role ?? 'global:owner', config),
    universe: registry.universe,
    principalVersion: securityVersionFor(owner.id),
    now,
  });
  if (lastUsedIsStale(record, now)) {
    // Bounded write amplification: at most one write per key per interval.
    const at = new Date(now).toISOString();
    store.users.update(owner.id, {
      [field]: owner[field].map((candidate) => (candidate.id === record.id ? { ...candidate, lastUsedAt: at } : candidate)),
    });
  }
  return { ok: true, principal, record, owner };
}

/* -------------------------------------------------------- service principals */

/**
 * @returns {{ servicePrincipal: object, rawCredential: string }} the credential is shown ONCE
 */
export function createServicePrincipal({ store, config, ownerId, kind, label, scopes, expiresAt = null, policy = DEFAULT_TENANT_SECURITY_POLICY, logger = null, now = Date.now() }) {
  const owner = store.users.get(ownerId);
  if (!owner) throw badRequest('Unknown owner');
  if (!getGlobalScopes(owner, config).includes('apiKey:manage')) throw forbidden(MISSING_SCOPE_MESSAGE);
  const existing = (owner.servicePrincipals ?? []).filter((sp) => !sp.revokedAt);
  const { record, raw } = createServicePrincipalRecord({
    id: newCredentialId(),
    owner,
    kind,
    label,
    scopes,
    ownerGrantable: apiKeyScopesForRole(owner.role ?? 'global:owner', config),
    expiresAt,
    policy,
    existing: existing.length,
    now,
  });
  store.users.update(owner.id, { servicePrincipals: [...pruneTombstones(owner.servicePrincipals), record] });
  audit(logger, 'service-principal.created', { tenantId: record.tenantId, principalRef: `svc:${record.id}`, ownerRef: owner.id, kind, scopeCount: record.scopes.length });
  return { servicePrincipal: servicePrincipalDto(record, owner.id), rawCredential: raw };
}

export function servicePrincipalDto(record, ownerId) {
  return {
    id: record.id,
    kind: record.kind,
    label: record.label,
    ownerId,
    tenantId: record.tenantId,
    scopes: [...record.scopes],
    credential: redactApiKey(record.hint),
    createdAt: record.createdAt,
    expiresAt: record.expiresAt ?? null,
    lastUsedAt: record.lastUsedAt ?? null,
  };
}

export function listServicePrincipals({ store, ownerId }) {
  const owner = store.users.get(ownerId);
  return (owner?.servicePrincipals ?? []).filter((sp) => !sp.revokedAt).map((sp) => servicePrincipalDto(sp, ownerId));
}

/**
 * Transfers a service principal to another accountable owner — the P5.7 debt item
 * "no ownership transfer for service principals".
 *
 * The invariants are the reason this is a distinct operation rather than a field
 * update, and each one is asserted here rather than left to the caller:
 *
 *   1. the authority MOVES: the record leaves the current owner's list and joins
 *      the receiving owner's, so deleting either owner deletes exactly the
 *      credentials that owner is accountable for;
 *   2. the TENANT does not: a principal is bound to the tenant it was minted in,
 *      and its scopes are only meaningful against that tenant's registry, so a
 *      cross-tenant transfer is refused rather than re-homed;
 *   3. the RECEIVER must be able to hold what the principal already carries:
 *      every scope is re-attenuated against the new owner's current grant, so a
 *      transfer to a less privileged owner narrows the principal instead of
 *      leaving it with authority its new owner could not have granted;
 *   4. a REVOKED principal cannot be transferred (a tombstone is not an asset);
 *   5. the CREDENTIAL ROTATES and the record LEAVES the sender outright. This
 *      is not cosmetic: `generateApiKey` bakes the owner id into the key so a
 *      presented credential resolves in O(1) with no process-local index, so a
 *      carried-over record would stop resolving the moment it moved. Rotating
 *      also means the previous owner — who necessarily knew the raw value —
 *      cannot keep using it, which is the only safe reading of "transfer". The
 *      record is removed rather than tombstoned on the sender because it was
 *      MOVED, not revoked: a tombstone would leave the sender holding a revoked
 *      principal they no longer own, and would answer 400 where the surface's
 *      own idiom is a silent no-op;
 *   6. both sides are audited, because accountability changed on both.
 *
 * An unknown id, or one the caller does not own, is a silent no-op (false), which
 * is the upstream `/rest/api-keys/:id` idiom: the response never confirms that an
 * id exists, so the surface cannot be used to enumerate another owner's machine
 * identities.
 *
 * @returns {{ moved: boolean, rawCredential?: string, servicePrincipal?: object }}
 *          the new raw credential is present only when the principal moved, and
 *          is shown exactly once, like every minted credential.
 */
export function transferServicePrincipal({
  store,
  ownerId,
  id,
  newOwnerId,
  config,
  policy = DEFAULT_TENANT_SECURITY_POLICY,
  logger = null,
  now = Date.now(),
}) {
  const owner = store.users.get(ownerId);
  if (!owner) return { moved: false };
  const record = (owner.servicePrincipals ?? []).find((candidate) => candidate.id === id);
  if (!record) return { moved: false };
  if (record.revokedAt) throw badRequest('A revoked service principal cannot be transferred');

  const receiver = store.users.get(newOwnerId);
  if (!receiver) throw badRequest('Unknown owner');
  if (receiver.id === owner.id) throw badRequest('The service principal already belongs to this owner');

  const tenant = record.tenantId ?? ownerTenantOf(owner);
  if (tenant !== ownerTenantOf(receiver)) {
    // Invariant 2. The tenant is part of the principal's identity, not a label.
    throw badRequest('A service principal cannot be transferred across tenants');
  }

  // Invariant 3: the receiver must be able to hold every scope already granted.
  const grantable = apiKeyScopesForRole(receiver.role ?? 'global:owner', config);
  const attenuated = attenuateScopes(record.scopes, grantable);
  if (!attenuated.ok) {
    audit(logger, 'service-principal.denied', {
      principalRef: `svc:${record.id}`, ownerRef: owner.id, reason: 'transfer-scope-escalation',
      scopeCount: attenuated.escalated.length,
    });
    throw badRequest('The receiving owner cannot hold every scope of this service principal');
  }

  const existing = (receiver.servicePrincipals ?? []).filter((sp) => !sp.revokedAt);
  if (existing.length >= MACHINE_IDENTITY_LIMITS.maxServicePrincipalsPerOwner) {
    throw badRequest(`The receiving owner is at the maximum of ${MACHINE_IDENTITY_LIMITS.maxServicePrincipalsPerOwner} service principals`);
  }

  const at = new Date(now).toISOString();
  // Scopes are narrowed to the receiver's grant. The credential is re-minted for
  // the receiver rather than carried over, because the key embeds the owner id
  // and the previous owner already knows the raw value.
  const minted = generateApiKey({ ownerId: receiver.id, keyId: id });
  const moved = Object.freeze({
    ...record,
    id,
    scopes: Object.freeze(attenuated.scopes),
    digest: minted.digest,
    hint: minted.hint,
    updatedAt: at,
  });
  // The sender's list must hold only what the sender owns. The old credential
  // stops resolving on its own: it carries the previous owner id, so the O(1)
  // lookup finds no record for it at all.
  store.users.update(owner.id, {
    servicePrincipals: (owner.servicePrincipals ?? []).filter((candidate) => candidate.id !== id),
  });
  store.users.update(receiver.id, {
    servicePrincipals: [...pruneTombstones(receiver.servicePrincipals), moved],
  });
  audit(logger, 'service-principal.transferred', {
    tenantId: tenant, principalRef: `svc:${id}`,
    fromRef: owner.id, toRef: receiver.id, scopeCount: moved.scopes.length,
  });
  return { moved: true, rawCredential: minted.raw, servicePrincipal: servicePrincipalDto(moved, receiver.id) };
}

/** The tenant an accountable owner belongs to; `default` when unset. */
function ownerTenantOf(owner) {
  return typeof owner?.tenantId === 'string' && owner.tenantId !== '' ? owner.tenantId : DEFAULT_TENANT;
}

/**
 * Revocation keeps a tombstone (P5-M01): the credential then fails as REVOKED, not UNKNOWN, and the
 * record survives for audit. Revoking an unknown or already revoked id is a no-op (false).
 */
export function revokeServicePrincipal({ store, ownerId, id, reason = 'revoked-by-owner', logger = null, now = Date.now() }) {
  const owner = store.users.get(ownerId);
  const result = owner ? revokeWithTombstone(owner.servicePrincipals, id, { reason, now }) : null;
  if (!result) return false;
  store.users.update(owner.id, { servicePrincipals: result.records });
  audit(logger, 'service-principal.revoked', { tenantId: result.revoked.tenantId, principalRef: `svc:${id}`, ownerRef: owner.id, reason });
  return true;
}

/* ------------------------------------------------------------------ routes */

/**
 * @param {object} options
 * @param {object} options.logger
 * @param {Readonly<object>} [options.policy] tenant security policy input
 */
export function apiKeyRoutes({ logger, policy = DEFAULT_TENANT_SECURITY_POLICY }) {
  return [
    {
      method: 'GET',
      path: '/rest/api-keys',
      handler: (ctx) => {
        const user = requireApiKeyScope(ctx);
        sendData(ctx.res, publicApiKeys(user).map((key) => apiKeyDto(key, user.id)));
      },
    },
    {
      method: 'GET',
      path: '/rest/api-keys/scopes',
      handler: (ctx) => {
        const user = requireServicePrincipalAuthority(ctx);
        sendData(ctx.res, apiKeyScopesForRole(user.role ?? 'global:owner', ctx.config));
      },
    },
    {
      method: 'POST',
      path: '/rest/api-keys',
      handler: (ctx) => {
        const user = requireApiKeyScope(ctx);
        const body = ctx.body ?? {};
        const label = validateLabel(body.label);
        const requested = validateScopeShape(body.scopes);
        const expiresAt = body.expiresAt === undefined ? null : body.expiresAt;
        if (expiresAt !== null && typeof expiresAt !== 'number') throw badRequest('Expiration date must be in the future or null');
        const violation = keyPolicyViolation(policy, { expiresAt });
        if (violation) throw badRequest(violation);
        const attenuated = attenuateScopes(requested, apiKeyScopesForRole(user.role ?? 'global:owner', ctx.config));
        if (!attenuated.ok) {
          audit(logger, 'api-key.denied', { ownerRef: user.id, reason: 'scope-escalation', scopeCount: attenuated.escalated.length });
          throw badRequest('Invalid scopes for user role');
        }
        const existing = (user.apiKeys ?? []).filter((key) => !key.revokedAt);
        if (existing.length >= API_KEY_POLICY.maxKeysPerOwner) {
          throw badRequest(`You have reached the maximum of ${API_KEY_POLICY.maxKeysPerOwner} API keys`);
        }
        const id = newCredentialId();
        const minted = generateApiKey({ ownerId: user.id, keyId: id });
        const at = new Date().toISOString();
        const record = {
          id,
          label,
          scopes: attenuated.scopes,
          audience: API_KEY_AUDIENCE.PUBLIC_API,
          tenantId: policy.tenantId,
          digest: minted.digest,
          hint: minted.hint,
          createdAt: at,
          updatedAt: at,
          expiresAt,
          lastUsedAt: null,
          revokedAt: null,
        };
        ctx.store.users.update(user.id, { apiKeys: [...pruneTombstones(user.apiKeys), record] });
        audit(logger, 'api-key.created', { tenantId: record.tenantId, keyRef: id, ownerRef: user.id, scopeCount: record.scopes.length });
        sendData(ctx.res, { ...apiKeyDto(record, user.id), rawApiKey: minted.raw });
      },
    },
    {
      method: 'PATCH',
      path: '/rest/api-keys/:id',
      handler: (ctx) => {
        const user = requireApiKeyScope(ctx);
        const body = ctx.body ?? {};
        const label = validateLabel(body.label);
        const requested = validateScopeShape(body.scopes);
        const attenuated = attenuateScopes(requested, apiKeyScopesForRole(user.role ?? 'global:owner', ctx.config));
        if (!attenuated.ok) {
          audit(logger, 'api-key.denied', { ownerRef: user.id, keyRef: String(ctx.params.id).slice(0, 64), reason: 'scope-escalation', scopeCount: attenuated.escalated.length });
          throw badRequest('Invalid scopes for user role');
        }
        const keys = user.apiKeys ?? [];
        // Upstream updates `WHERE id AND userId`: another user's id is a silent
        // no-op, so the response never confirms that a key id exists.
        if (keys.some((key) => key.id === ctx.params.id && !key.revokedAt)) {
          const at = new Date().toISOString();
          ctx.store.users.update(user.id, {
            apiKeys: keys.map((key) => (key.id === ctx.params.id ? { ...key, label, scopes: attenuated.scopes, updatedAt: at } : key)),
          });
          audit(logger, 'api-key.updated', { keyRef: ctx.params.id, ownerRef: user.id, scopeCount: attenuated.scopes.length });
        }
        sendData(ctx.res, { success: true });
      },
    },
    /* ------------------------------------------------ service principals (P5-M07) */
    {
      method: 'GET',
      path: '/rest/service-principals',
      handler: (ctx) => {
        const user = requireServicePrincipalAuthority(ctx);
        sendData(ctx.res, listServicePrincipals({ store: ctx.store, ownerId: user.id }));
      },
    },
    {
      // The vocabulary the caller may attenuate to. Publishing it is what keeps
      // the create form honest: a scope the owner cannot grant is refused at the
      // boundary rather than silently trimmed.
      method: 'GET',
      path: '/rest/service-principals/scopes',
      handler: (ctx) => {
        const user = requireServicePrincipalAuthority(ctx);
        sendData(ctx.res, apiKeyScopesForRole(user.role ?? 'global:owner', ctx.config));
      },
    },
    {
      // The only route that mints machine authority, so it is the only response
      // that ever carries a raw credential. There is no GET that returns it
      // again: `rawApiKey` exists on this one response and nowhere else.
      method: 'POST',
      path: '/rest/service-principals',
      handler: (ctx) => {
        const user = requireServicePrincipalAuthority(ctx);
        const body = ctx.body ?? {};
        const kind = typeof body.kind === 'string' ? body.kind : '';
        const label = validateLabel(body.label);
        const requested = validateScopeShape(body.scopes);
        const expiresAt = body.expiresAt === undefined ? null : body.expiresAt;
        if (expiresAt !== null && typeof expiresAt !== 'number') throw badRequest('Expiration date must be in the future or null');
        const violation = keyPolicyViolation(policy, { expiresAt });
        if (violation) throw badRequest(violation);
        // Unknown kind is a 400 naming the vocabulary, not a stored record with a
        // kind the tenant policy never allowed.
        if (!SERVICE_PRINCIPAL_KINDS.includes(kind)) {
          throw badRequest(`kind must be one of ${SERVICE_PRINCIPAL_KINDS.join(', ')}`);
        }
        const { servicePrincipal, rawCredential } = guarded(() => createServicePrincipal({
          store: ctx.store,
          config: ctx.config,
          ownerId: user.id,
          kind,
          label,
          scopes: requested,
          expiresAt,
          policy,
          logger,
        }));
        sendData(ctx.res, { ...servicePrincipal, rawApiKey: rawCredential });
      },
    },
    {
      // Ownership transfer. An id the caller does not own is a silent no-op, so
      // the surface cannot be used to probe another owner's machine identities.
      method: 'PATCH',
      path: '/rest/service-principals/:id',
      handler: (ctx) => {
        const user = requireServicePrincipalAuthority(ctx);
        const body = ctx.body ?? {};
        const newOwnerId = typeof body.ownerId === 'string' ? body.ownerId : '';
        if (newOwnerId === '') throw badRequest('ownerId is required');
        const { moved, rawCredential, servicePrincipal } = guarded(() => transferServicePrincipal({
          store: ctx.store,
          ownerId: user.id,
          id: ctx.params.id,
          newOwnerId,
          config: ctx.config,
          policy,
          logger,
        }));
        // The rotated credential appears here and nowhere else, exactly like a
        // create. A transfer that did not move anything returns no credential.
        sendData(ctx.res, moved
          ? { success: true, ...servicePrincipal, rawApiKey: rawCredential }
          : { success: false });
      },
    },
    {
      // Tombstone, not delete: the record stays with revokedAt so the credential
      // is reported REVOKED and the audit row survives (P5-M01).
      method: 'DELETE',
      path: '/rest/service-principals/:id',
      handler: (ctx) => {
        const user = requireServicePrincipalAuthority(ctx);
        const revoked = revokeServicePrincipal({ store: ctx.store, ownerId: user.id, id: ctx.params.id, logger });
        sendData(ctx.res, { success: revoked });
      },
    },
    {
      method: 'DELETE',
      path: '/rest/api-keys/:id',
      handler: (ctx) => {
        const user = requireApiKeyScope(ctx);
        // Tombstone, not delete (P5-M01): the record stays with revokedAt so the credential is
        // reported REVOKED and the audit row survives. Unknown or already revoked ids are a silent
        // no-op, as upstream: the response never confirms that a key id exists.
        const result = revokeWithTombstone(user.apiKeys, ctx.params.id, { reason: 'revoked-by-owner' });
        if (result) {
          ctx.store.users.update(user.id, { apiKeys: result.records });
          audit(logger, 'api-key.revoked', { keyRef: ctx.params.id, ownerRef: user.id, reason: 'revoked-by-owner' });
        }
        sendData(ctx.res, { success: true });
      },
    },
  ];
}

