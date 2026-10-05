/**
 * Compatibility layer — credentials (`ICredentialsResponse`) and the P5.4
 * credential security boundary.
 *
 * WHY THIS FILE LIVES IN `src/compat`: the credential response shape is an
 * UPSTREAM n8n contract, and this layer is where upstream shapes are owned. The
 * security side of P5.4 (`src/auth/security/secret-ref.mjs`) consumes the pure
 * functions from here — that direction is legal because the `auth` domain
 * declares `compatibility` as a dependency, while this module must never reach
 * into `auth`.
 *
 * ---------------------------------------------------------------------------
 * The rule this file exists to enforce
 * ---------------------------------------------------------------------------
 * A runtime secret leaves storage ONLY through a SecretRef redeemed at the
 * boundary (`src/auth/security/secret-ref.mjs`). Everything the editor, the REST
 * API, logs, errors, audit and telemetry ever see is metadata, non-secret
 * configuration, or a redaction sentinel.
 *
 * The redaction shape is NOT invented here. It is n8n's own contract, recorded
 * from n8n 2.9.4 in `tests/reference/agent-4/golden/credentials.golden.json`:
 *
 *   GET   /rest/credentials/:id                  -> no `data` field at all
 *   GET   /rest/credentials/:id?includeData=true -> `data` present, secret
 *                                                   values replaced by
 *                                                   `__n8n_BLANK_VALUE_<uuid>`
 *   PATCH /rest/credentials/:id echoing the
 *         sentinel back                         -> the sentinel is dropped and
 *                                                  the stored secret survives
 *
 * Which fields count as secret is not guessed either. It comes from the
 * canonical credential-type catalog, where n8n marks a property with
 * `typeOptions.password: true`. For `httpHeaderAuth` that is `value` and not
 * `name` — exactly what the golden records. For an UNKNOWN type every value is
 * treated as secret: there is no safe subset to guess, so we fail closed.
 */

import { randomBytes } from 'node:crypto';
import { HttpError, badRequest, notFound } from './error.mjs';
import { sendData } from './response.mjs';
import { requireUser } from './auth-context.mjs';
import { getGlobalScopes, loadRoles } from './scopes.mjs';

/* ------------------------------------------------------------ authorization */

/**
 * The scopes a user holds ON ONE CREDENTIAL, computed exactly the way upstream
 * n8n does it: the user's global-role scopes, plus the `project:personalOwner`
 * scopes when the credential lives in the user's personal project (i.e. the
 * user owns it). Both sets come from the canonical `roles.json` — nothing here
 * invents a scope, and an unknown role contributes nothing.
 *
 * A record with no `ownerId` predates P5.4. It belongs to nobody's personal
 * project, so only a global scope can reach it. That is default deny: before
 * P5.4 every signed-in user could read every credential, including the owner's.
 *
 * @param {object} user
 * @param {object|null} credential null => "a credential this user would create"
 * @param {object} config
 * @returns {Set<string>}
 */
export function credentialScopesFor(user, credential, config) {
  const scopes = new Set(getGlobalScopes(user, config).filter((scope) => scope.startsWith('credential:')));
  const owns = credential === null || (credential?.ownerId !== undefined && credential.ownerId === user?.id);
  if (user && owns) {
    const personal = (loadRoles(config).project ?? []).find((role) => role.slug === 'project:personalOwner');
    for (const scope of personal?.scopes ?? []) if (scope.startsWith('credential:')) scopes.add(scope);
  }
  return scopes;
}

/** 403 in n8n's own error shape. */
function forbidden() {
  return new HttpError(403, 'User is missing a scope required to perform this action');
}

/**
 * Loads a credential the caller may READ, or throws 404. Not-readable and
 * not-found are deliberately indistinguishable, so the API cannot be used to
 * probe for other users' credential ids (upstream behaves the same way).
 */
function readableCredential(ctx, user) {
  const credential = ctx.store.credentials.get(ctx.params.id);
  if (!credential || !credentialScopesFor(user, credential, ctx.config).has('credential:read')) {
    throw notFound(`Credential with ID "${ctx.params.id}" could not be found.`);
  }
  return credential;
}

/**
 * n8n's blank-value sentinel prefix. The editor renders this as an empty
 * password field and echoes it back unchanged on save, which is how n8n knows
 * "the user did not retype this".
 */
export const CREDENTIAL_BLANK_PREFIX = '__n8n_BLANK_VALUE_';

/** Default view flags n8n's `ICredentialsResponse` exposes. */
const DEFAULT_FLAGS = Object.freeze({
  isManaged: false,
  isGlobal: false,
  isResolvable: false,
  resolvableAllowFallback: false,
  resolverId: null,
  shared: [],
  scopes: [],
  resource: 'credential',
});

/**
 * True when `value` is one of n8n's blank-value sentinels.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isBlankSentinel(value) {
  if (typeof value !== 'string') return false;
  if (!value.startsWith(CREDENTIAL_BLANK_PREFIX)) return false;
  // A bare prefix with no id is not a sentinel the editor would have produced.
  return value.length > CREDENTIAL_BLANK_PREFIX.length;
}

/**
 * Builds a type -> Set(secret field names) index from the canonical credential
 * catalog.
 *
 * @param {Array<object>} credentialTypes entries from `credentials.json`
 * @returns {{ secretFields(typeName: string): Set<string>|null, has(typeName: string): boolean, size(): number }}
 */
export function createCredentialTypeIndex(credentialTypes) {
  /** @type {Map<string, Set<string>>} */
  const byType = new Map();

  for (const entry of Array.isArray(credentialTypes) ? credentialTypes : []) {
    if (!entry || typeof entry.name !== 'string') continue;
    const secret = new Set();
    for (const property of Array.isArray(entry.properties) ? entry.properties : []) {
      if (!property || typeof property.name !== 'string') continue;
      if (property.typeOptions && property.typeOptions.password === true) secret.add(property.name);
    }
    byType.set(entry.name, secret);
  }

  return Object.freeze({
    has: (typeName) => byType.has(typeName),
    /**
     * @param {string} typeName
     * @returns {Set<string>|null} null when the type is unknown, meaning
     *   "every value must be treated as secret".
     */
    secretFields: (typeName) => byType.get(typeName) ?? null,
    size: () => byType.size,
  });
}

/**
 * Splits a stored credential into metadata, non-secret configuration and the
 * runtime secret. This separation is the backbone of P5.4: a consumer handed
 * `metadata` and `configuration` still cannot reach the runtime secret.
 *
 * @param {object} record a stored credential
 * @param {Set<string>|null} secretFields null => treat every value as secret
 * @returns {{ metadata: object, configuration: object, runtimeSecret: object }}
 */
export function splitCredential(record, secretFields) {
  const data = record && typeof record.data === 'object' && record.data !== null ? record.data : {};
  const configuration = {};
  const runtimeSecret = {};

  for (const [key, value] of Object.entries(data)) {
    // An unknown type has no safe subset, so everything is secret.
    const isSecret = secretFields === null ? true : secretFields.has(key);
    if (isSecret) runtimeSecret[key] = value;
    else configuration[key] = value;
  }

  const metadata = {
    id: record?.id,
    name: record?.name,
    type: record?.type,
    createdAt: record?.createdAt,
    updatedAt: record?.updatedAt,
    tenantId: record?.tenantId ?? null,
    credentialVersion: record?.credentialVersion ?? 1,
  };

  return Object.freeze({
    metadata: Object.freeze(metadata),
    configuration: Object.freeze(configuration),
    runtimeSecret: Object.freeze(runtimeSecret),
  });
}

/**
 * Replaces every runtime-secret value with a blank sentinel, leaving non-secret
 * configuration untouched — which is what the editor needs in order to render a
 * populated form (it shows the header `name`, not the header `value`).
 *
 * @param {object} record
 * @param {Set<string>|null} secretFields
 * @param {{ uuid?: () => string }} [options]
 * @returns {object}
 */
export function redactCredentialData(record, secretFields, { uuid = defaultUuid } = {}) {
  const { configuration, runtimeSecret } = splitCredential(record, secretFields);
  const redacted = { ...configuration };
  for (const key of Object.keys(runtimeSecret)) {
    redacted[key] = `${CREDENTIAL_BLANK_PREFIX}${uuid()}`;
  }
  return redacted;
}

/**
 * Merges an editor submission into the stored credential, treating a sentinel
 * as "unchanged". This is the property the golden file pins as
 * `updateWithBlankedValueKeepsSecret`: a client echoing back the blank sentinel
 * must not overwrite the stored secret with the literal string
 * `__n8n_BLANK_VALUE_…`.
 *
 * @param {object|null|undefined} existingData
 * @param {object|null|undefined} incomingData
 * @returns {object}
 */
export function mergeCredentialData(existingData, incomingData) {
  const existing =
    existingData && typeof existingData === 'object' && !Array.isArray(existingData) ? existingData : {};
  const incoming =
    incomingData && typeof incomingData === 'object' && !Array.isArray(incomingData) ? incomingData : {};

  const merged = { ...existing };
  for (const [key, value] of Object.entries(incoming)) {
    if (isBlankSentinel(value)) {
      // The editor never showed this value, so it cannot have changed it.
      // Keep whatever is stored; drop the key when there is nothing stored.
      if (key in existing) continue;
      delete merged[key];
      continue;
    }
    merged[key] = value;
  }
  return merged;
}

/**
 * The credential as the REST surface may publish it. `data` is either absent or
 * fully redacted — never the stored runtime secret.
 *
 * @param {object} record
 * @param {{ includeData?: boolean, secretFields?: Set<string>|null, uuid?: () => string }} [options]
 * @returns {object}
 */
export function credentialEditorView(record, { includeData = false, secretFields = null, uuid = defaultUuid } = {}) {
  const view = {
    id: record?.id,
    name: record?.name,
    type: record?.type,
    createdAt: record?.createdAt,
    updatedAt: record?.updatedAt,
    ...DEFAULT_FLAGS,
  };
  if (record?.tenantId !== undefined) view.tenantId = record.tenantId;
  if (record?.credentialVersion !== undefined) view.credentialVersion = record.credentialVersion;
  if (includeData) {
    if (record?.secret !== undefined || Array.isArray(record?.secretKeys)) {
      // P5.5 sealed record: configuration is stored in the clear and the secret
      // field NAMES are stored as schema, so the editor view needs no decrypt.
      const data = { ...(record.config ?? {}) };
      for (const key of record.secretKeys ?? []) data[key] = `${CREDENTIAL_BLANK_PREFIX}${uuid()}`;
      view.data = data;
    } else {
      view.data = redactCredentialData(record, secretFields, { uuid });
    }
  }
  return view;
}

/**
 * True when a view's `data` bag holds anything that is not a blank sentinel —
 * i.e. something that must never have reached that surface.
 *
 * @param {object} view
 * @param {Set<string>|null} secretFields
 * @returns {boolean}
 */
export function containsRuntimeSecret(view, secretFields) {
  const data = view?.data;
  if (!data || typeof data !== 'object') return false;
  const { runtimeSecret } = splitCredential({ data }, secretFields);
  for (const value of Object.values(runtimeSecret)) {
    if (value === undefined || value === null || value === '') continue;
    if (isBlankSentinel(value)) continue;
    return true;
  }
  return false;
}

/**
 * The tenant a credential belongs to. Multi-tenant provisioning is P10 and out
 * of scope for P5.4, so this resolves to the user's tenant when one exists and a
 * single explicit default otherwise. The field is real and is what a SecretRef
 * binds to — it is only ever `'default'` until P10 gives it more values.
 *
 * @param {object} ctx
 * @returns {string}
 */
export function currentTenantId(ctx) {
  return ctx?.user?.tenantId ?? ctx?.config?.tenantId ?? 'default';
}

/**
 * Builds the credential REST routes.
 *
 * The catalog accessor is INJECTED rather than imported: the `compatibility`
 * domain declares `node-registry` in `mustNotDependOn`, so this module must not
 * reach `src/catalog.mjs` itself. The legacy aggregate, which may depend on
 * anything, supplies it.
 *
 * @param {object} deps
 * @param {object} deps.logger
 * @param {(config: object) => Array<object>} deps.getCredentialTypes
 * @returns {Array<object>} route objects
 */
export function credentialRoutes({ logger, getCredentialTypes = () => [], vault = null }) {
  /**
   * P5.5: every secret write goes through the vault. Without one there is no
   * safe place to put a secret, so the write is refused — never stored plain.
   */
  const requireVault = () => {
    if (!vault) throw new HttpError(503, 'Credential encryption is unavailable', { code: 'lego.unavailable' });
    return vault;
  };
  /** Vault failures carry a published code + secret-free message; keep both. */
  const guarded = (fn) => {
    try {
      return fn();
    } catch (error) {
      if (error && error.name === 'SecurityError') {
        throw new HttpError(error.status ?? 500, error.message, { code: error.code });
      }
      throw error;
    }
  };
  /** Memoised per catalog directory so the index is built once, not per request. */
  const indexCache = new Map();
  const indexFor = (config) => {
    const key = config?.catalogDir ?? '';
    if (indexCache.has(key)) return indexCache.get(key);
    let types = [];
    try {
      types = getCredentialTypes(config) ?? [];
    } catch {
      types = [];
    }
    // A catalog that failed to load yields an empty index, which makes every
    // type unknown and therefore every value secret. Fail closed.
    const index = createCredentialTypeIndex(types);
    indexCache.set(key, index);
    return index;
  };

  const view = (credential, ctx, { includeData = false } = {}) => {
    const out = credentialEditorView(credential, {
      includeData,
      secretFields: indexFor(ctx.config).secretFields(credential?.type),
    });
    // Upstream returns the caller's effective scopes on each credential; the
    // editor uses them to enable or disable edit/delete/share.
    out.scopes = [...credentialScopesFor(ctx.user, credential, ctx.config)].sort();
    return out;
  };
  const visible = (ctx, user) =>
    ctx.store.credentials.all().filter((credential) => {
      const scopes = credentialScopesFor(user, credential, ctx.config);
      return scopes.has('credential:read') || scopes.has('credential:list');
    });

  return [
    {
      method: 'GET',
      path: '/rest/credentials/new',
      handler: (ctx) => {
        requireUser(ctx);
        const requested =
          typeof ctx.query.name === 'string' && ctx.query.name.trim() !== '' ? ctx.query.name : 'My credential';
        const taken = new Set(ctx.store.credentials.all().map((credential) => credential.name));
        let name = requested;
        for (let i = 2; taken.has(name); i += 1) name = `${requested} ${i}`;
        sendData(ctx.res, { name });
      },
    },
    {
      method: 'GET',
      path: '/rest/credentials/for-workflow',
      handler: (ctx) => {
        const user = requireUser(ctx);
        // A selector list: the editor needs id/name/type to populate the node's
        // credential dropdown, never the values — and only credentials the
        // caller may use.
        sendData(ctx.res, visible(ctx, user).map((credential) => view(credential, ctx)));
      },
    },
    {
      method: 'POST',
      path: '/rest/credentials/test',
      handler: (ctx) => {
        requireUser(ctx);
        sendData(ctx.res, { status: 'OK', message: 'Connection tested successfully.' });
      },
    },
    {
      method: 'GET',
      path: '/rest/credentials',
      handler: (ctx) => {
        const user = requireUser(ctx);
        const includeData = ctx.query.includeData === 'true';
        const filter = parseFilter(ctx.query.filter);
        const credentials = visible(ctx, user)
          .filter((credential) =>
            filter.name ? String(credential.name).toLowerCase().includes(String(filter.name).toLowerCase()) : true,
          )
          .filter((credential) => (filter.type ? credential.type === filter.type : true));
        sendData(ctx.res, credentials.map((credential) => view(credential, ctx, { includeData })));
      },
    },
    {
      method: 'POST',
      path: '/rest/credentials',
      handler: (ctx) => {
        const user = requireUser(ctx);
        if (!credentialScopesFor(user, null, ctx.config).has('credential:create')) throw forbidden();
        const body = ctx.body ?? {};
        if (typeof body.name !== 'string' || body.name.trim() === '') throw badRequest('Credential name is required');
        if (typeof body.type !== 'string' || body.type.trim() === '') throw badRequest('Credential type is required');
        const now = new Date().toISOString();
        // The id is minted before insert because it is part of the envelope's
        // associated data: the ciphertext is bound to this exact credential.
        const id = newCredentialId();
        const tenantId = currentTenantId(ctx);
        const sealed = guarded(() => requireVault().sealData({ id, type: body.type, tenantId }, body.data ?? {}));
        const credential = ctx.store.credentials.insert({
          id,
          name: body.name,
          type: body.type,
          ...sealed,
          tenantId,
          // The creator's personal project owns it — this is what later grants
          // them `project:personalOwner` scopes on it, and nobody else.
          ownerId: user.id,
          credentialVersion: 1,
          createdAt: now,
          updatedAt: now,
        });
        // Identifiers only — never the submitted values.
        logger.info('credential created', { credentialId: credential.id, type: credential.type });
        // Upstream echoes `data` on create; we echo it REDACTED. The golden
        // oracle pins `dataFieldPresent: true` and the key set, not the values.
        sendData(ctx.res, view(credential, ctx, { includeData: true }));
      },
    },
    {
      method: 'GET',
      path: '/rest/credentials/:id',
      handler: (ctx) => {
        const user = requireUser(ctx);
        const credential = readableCredential(ctx, user);
        // Default is NO data. This is the single most important line of P5.4:
        // it used to be `includeData !== 'false'`, which returned the stored
        // secret unless the caller opted OUT.
        sendData(ctx.res, view(credential, ctx, { includeData: ctx.query.includeData === 'true' }));
      },
    },
    {
      method: 'PATCH',
      path: '/rest/credentials/:id',
      handler: (ctx) => {
        const user = requireUser(ctx);
        const existing = readableCredential(ctx, user);
        if (!credentialScopesFor(user, existing, ctx.config).has('credential:update')) throw forbidden();
        const body = ctx.body ?? {};
        // A sentinel echoed back means "the user did not retype this", so the
        // stored value survives. Without this, merely opening and saving a
        // credential in the editor would overwrite every secret with the
        // literal string `__n8n_BLANK_VALUE_…`.
        // Open at the WRITE boundary only (the sentinel merge needs the stored
        // values), then reseal under the current key. A record that cannot be
        // opened — missing key, tamper — fails closed and is left untouched.
        const v = requireVault();
        const type = typeof body.type === 'string' ? body.type : existing.type;
        const merged = guarded(() => mergeCredentialData(v.openData(existing), body.data));
        const sealed = guarded(() => v.sealData({ ...existing, type, tenantId: existing.tenantId ?? 'default' }, merged));
        const updated = ctx.store.credentials.update(existing.id, (current) => {
          const { data: _legacyPlaintext, ...rest } = current;
          return {
            ...rest,
            ...sealed,
            name: typeof body.name === 'string' ? body.name : existing.name,
            type,
          // Bumping the version is what invalidates any SecretRef minted
          // against the previous contents.
            credentialVersion: (existing.credentialVersion ?? 1) + 1,
            updatedAt: new Date().toISOString(),
          };
        });
        // Upstream returns no `data` on update; the golden pins this as
        // `dataFieldPresent: false`.
        sendData(ctx.res, view(updated, ctx));
      },
    },
    {
      method: 'DELETE',
      path: '/rest/credentials/:id',
      handler: (ctx) => {
        const user = requireUser(ctx);
        const existing = readableCredential(ctx, user);
        if (!credentialScopesFor(user, existing, ctx.config).has('credential:delete')) throw forbidden();
        ctx.store.credentials.remove(existing.id);
        sendData(ctx.res, true);
      },
    },
  ];
}

/** n8n-style 16-char alphanumeric id. */
function newCredentialId() {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = randomBytes(16);
  let id = '';
  for (const byte of bytes) id += alphabet[byte % alphabet.length];
  return id;
}

/** Local copy: `parseFilter` lives in the legacy aggregate, which this domain may not import. */
function parseFilter(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Deterministic-enough id for a sentinel; format matches n8n's uuid suffix. */
function defaultUuid() {
  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}-${Math.random()
    .toString(16)
    .slice(2, 10)}-${Math.random().toString(16).slice(2, 10)}-${Math.random().toString(16).slice(2, 14)}`;
}
