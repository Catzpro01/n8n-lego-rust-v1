/**
 * P5-M15 workflow/credential transfer backing model (P5-M10-E): versioned
 * export bundles + transfer records over the P8 storage facade. The
 * /api/v1/transfer surface stays gated upstream; it mounts on this model later.
 *
 * Records (closed shapes):
 *   bundle   {tag:1, bundleId, kind, schemaVersion, manifest:{items:[...]}, payload, createdAt}
 *   transfer {tag:2, transferId, bundleId, fromPrincipal, toPrincipal, state,
 *             bundleDigest, createdAt, updatedAt, metadata}
 *
 * SECRET-FREE INVARIANT (enforced on write, pinned by tests):
 *   - credential material travels ONLY as envelope refs: manifest items with
 *     itemType 'credential-ref' REQUIRE an opaque `envelopeRef` and must NOT
 *     carry raw fields (value/secret/data/privateKey/...);
 *   - NO record (bundle payload, manifest, transfer metadata) may contain a
 *     forbidden secret-bearing key at ANY depth (password, secret, token,
 *     apiKey, privateKey, clientSecret, credentials, ...);
 *   - round-trip never widens exposure: the invariant holds for everything the
 *     store returns.
 *
 * Transfer lifecycle (closed): created -> sealed -> completed | aborted
 *   (created -> aborted is legal). Sealing pins the bundle digest (bundle
 *   version). Every transition is pure CAS (version token REQUIRED; stale ->
 *   TRANSFER_CONFLICT). Bundles are create-only (append-only like audit).
 *
 * Error set (closed): TRANSFER_INVALID | TRANSFER_NOT_FOUND | TRANSFER_CONFLICT.
 * Storage errors propagate unchanged.
 */

export const TRANSFER_ERROR_CODES = Object.freeze({
  INVALID: 'TRANSFER_INVALID',
  NOT_FOUND: 'TRANSFER_NOT_FOUND',
  CONFLICT: 'TRANSFER_CONFLICT',
});

export class TransferModelError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'TransferModelError';
    this.code = code;
    this.details = options.details ?? {};
    if (!Object.values(TRANSFER_ERROR_CODES).includes(code)) {
      throw new TypeError(`TransferModelError: unknown code ${String(code)}`);
    }
  }
}

const invalid = (message, details) => new TransferModelError(TRANSFER_ERROR_CODES.INVALID, message, { details });
const notFound = (message, details) => new TransferModelError(TRANSFER_ERROR_CODES.NOT_FOUND, message, { details });
const conflict = (message, details) => new TransferModelError(TRANSFER_ERROR_CODES.CONFLICT, message, { details });

/** Closed bundle kinds. */
export const BUNDLE_KINDS = Object.freeze(['workflow-export', 'credential-export', 'mixed']);
/** Closed transfer state vocabulary. */
export const TRANSFER_STATES = Object.freeze(['created', 'sealed', 'completed', 'aborted']);
/** Legal transitions (sealed -> completed|aborted; created -> sealed|aborted). */
export const TRANSFER_TRANSITIONS = Object.freeze({
  created: ['sealed', 'aborted'],
  sealed: ['completed', 'aborted'],
  completed: [],
  aborted: [],
});

/** Secret-bearing keys refused at ANY depth (secret-free invariant). */
export const FORBIDDEN_SECRET_KEYS = Object.freeze([
  'password', 'secret', 'token', 'apikey', 'api_key', 'apisecret', 'api_secret',
  'privatekey', 'private_key', 'clientsecret', 'client_secret', 'credentials',
  'passphrase', 'secretkey', 'secret_key', 'auth', 'authorization',
]);

const BUNDLE_TAG = 1;
const TRANSFER_TAG = 2;

const bundleKey = (bundleId) => `b:${bundleId}`;
const transferKey = (transferId) => `t:${transferId}`;

const assertId = (value, field) => {
  if (typeof value !== 'string' || value.length < 6 || value.length > 128) {
    throw invalid(`${field} must be an opaque string of 6..128 characters`);
  }
  return value;
};
const assertPrincipal = (value, field) => {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) {
    throw invalid(`${field} must be a non-empty principal of at most 128 characters`);
  }
  return value;
};

/**
 * Recursive secret scan: refuses forbidden keys at any depth. Returns the
 * (structured-cloned) value so round-trips cannot widen exposure.
 */
export const assertSecretFree = (value, path = '$') => {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.map((entry, index) => assertSecretFree(entry, `${path}[${index}]`));
  }
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    if (FORBIDDEN_SECRET_KEYS.includes(key.toLowerCase())) {
      throw invalid(`secret-bearing key ${key} is not allowed in transfer records`, { path: `${path}.${key}` });
    }
    out[key] = assertSecretFree(entry, `${path}.${key}`);
  }
  return structuredClone(out);
};

const assertManifest = (manifest) => {
  if (manifest === null || typeof manifest !== 'object' || !Array.isArray(manifest.items)) {
    throw invalid('manifest.items must be an array');
  }
  const items = manifest.items.map((item, index) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw invalid(`manifest item ${index} must be an object`);
    }
    const itemType = item.itemType === 'workflow' || item.itemType === 'credential-ref' ? item.itemType : null;
    if (!itemType) throw invalid(`manifest item ${index} itemType must be workflow|credential-ref`);
    const clean = {
      itemType,
      itemId: assertId(item.itemId, `manifest item ${index} itemId`),
      name: typeof item.name === 'string' && item.name.length > 0 ? item.name : '',
      digest: typeof item.digest === 'string' ? item.digest : '',
    };
    if (itemType === 'credential-ref') {
      if (typeof item.envelopeRef !== 'string' || item.envelopeRef.length === 0) {
        throw invalid(`credential-ref item ${index} requires an opaque envelopeRef`);
      }
      clean.envelopeRef = item.envelopeRef;
    }
    // secret-free: any extra key is scanned; raw secret fields are refused
    assertSecretFree(item, `manifest.items[${index}]`);
    return clean;
  });
  return { items };
};

/** Stable digest over the sealed bundle body (deterministic serialization). */
export const bundleDigestOf = (body) => {
  const json = JSON.stringify(body);
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let i = 0; i < json.length; i += 1) {
    hash ^= BigInt(json.charCodeAt(i));
    hash = BigInt.asUintN(64, hash * prime);
  }
  return `d${hash.toString(16).padStart(16, '0')}`;
};

/**
 * @param {object} storage storage facade handle - the ONLY persistence boundary
 * @param {object} options
 * @param {{ now: () => number }} options.clock REQUIRED deterministic clock (ms)
 * @param {() => string} options.idFactory REQUIRED opaque id factory
 * @param {string} [options.namespace='transfer']
 */
export function createTransferModel(storage, { clock, idFactory, namespace = 'transfer' } = {}) {
  if (!storage || typeof storage.get !== 'function' || typeof storage.putIfVersion !== 'function') {
    throw invalid('createTransferModel requires a storage facade handle');
  }
  if (!clock || typeof clock.now !== 'function') throw invalid('an injected clock is required');
  if (typeof idFactory !== 'function') throw invalid('an injected idFactory is required');

  const readJson = (key, tag, kind) => {
    const got = storage.get(namespace, key);
    if (!got.found) return null;
    let record;
    try {
      record = JSON.parse(got.value.toString('utf8'));
    } catch (error) {
      throw conflict(`${kind} record is unreadable`, { cause: error });
    }
    if (record.tag !== tag) throw conflict(`${kind} record has an unsupported shape`);
    return { record, version: got.version };
  };

  const readBundle = (bundleId) => {
    const found = readJson(bundleKey(bundleId), BUNDLE_TAG, 'bundle');
    if (!found) throw notFound('bundle not found', { bundleId: bundleId.slice(0, 8) });
    return found;
  };
  const readTransfer = (transferId) => {
    const found = readJson(transferKey(transferId), TRANSFER_TAG, 'transfer');
    if (!found) throw notFound('transfer not found', { transferId: transferId.slice(0, 8) });
    return found;
  };

  const requireVersion = (version) => {
    if (typeof version !== 'string' || version.length === 0) {
      throw invalid('a CAS version token is required for this update');
    }
    return version;
  };

  const createRecord = (key, record) => {
    if (storage.get(namespace, key).found) throw conflict('record already exists (append-only)');
    const bytes = Buffer.from(JSON.stringify(record), 'utf8');
    storage.put(namespace, key, bytes);
    const verify = storage.get(namespace, key);
    if (!verify.found || !verify.value.equals(bytes)) {
      throw conflict('create lost a concurrent write');
    }
    return Object.freeze({ ...record, version: verify.version });
  };

  const casUpdate = (key, record, version, kind) => {
    requireVersion(version);
    const applied = storage.putIfVersion(
      namespace, key, Buffer.from(JSON.stringify(record), 'utf8'), version,
    );
    if (!applied.applied) {
      throw conflict(`${kind} update lost a concurrent update`, { reason: applied.reason });
    }
    return Object.freeze({ ...record, version: applied.version });
  };

  const listFiltered = ({ prefix, tag, kind, cursor, limit, field }) => {
    if (cursor !== null && (typeof cursor !== 'string' || cursor.length === 0 || cursor.length > 256)) {
      throw invalid('cursor must be an opaque token issued by a previous list call');
    }
    if (!Number.isInteger(limit) || limit <= 0) throw invalid('limit must be a positive integer');
    const collected = [];
    let scan;
    for (;;) {
      const page = storage.list(namespace, { cursor: scan, limit: 1000 });
      for (const entry of page.keys) {
        if (!entry.key.startsWith(prefix)) continue;
        const found = readJson(entry.key, tag, kind);
        if (found) collected.push({ key: entry.key, record: found.record, version: entry.version });
      }
      if (!page.nextCursor) break;
      scan = page.nextCursor;
    }
    collected.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const after = cursor === null ? collected : collected.filter((e) => e.key > cursor);
    const items = after.slice(0, limit).map((e) => ({ ...e.record, version: e.version }));
    const last = after.slice(0, limit).pop();
    return Object.freeze({
      [field]: Object.freeze(items),
      nextCursor: after.length > items.length && last ? last.key : null,
    });
  };

  const transition = (transferId, target, version) => {
    assertId(transferId, 'transferId');
    const { record } = readTransfer(transferId);
    const allowed = TRANSFER_TRANSITIONS[record.state];
    if (!allowed.includes(target)) {
      throw invalid(`cannot move a transfer from ${record.state} to ${target}`);
    }
    const next = { ...record, state: target, updatedAt: clock.now() };
    return casUpdate(transferKey(transferId), next, version, 'transfer');
  };

  return Object.freeze({
    capabilities: storage.capabilities,
    namespace,

    /* ------------------------------------------------------------ bundles */

    /** Create-only export bundle. Secret-free invariant enforced on write. */
    createBundle({ kind, schemaVersion = 1, manifest, payload = null, metadata = null } = {}) {
      if (!BUNDLE_KINDS.includes(kind)) {
        throw invalid(`kind must be one of ${BUNDLE_KINDS.join('|')}`, { kind: String(kind).slice(0, 32) });
      }
      const bundleId = assertId(idFactory(), 'idFactory output');
      const record = {
        tag: BUNDLE_TAG,
        bundleId,
        kind,
        schemaVersion: Number.isInteger(schemaVersion) && schemaVersion > 0 ? schemaVersion : 1,
        manifest: assertManifest(manifest),
        payload: payload === null ? null : assertSecretFree(payload, 'payload'),
        createdAt: clock.now(),
        metadata: metadata === undefined ? null : assertSecretFree(metadata, 'metadata'),
      };
      return createRecord(bundleKey(bundleId), record);
    },

    getBundle(bundleId) {
      assertId(bundleId, 'bundleId');
      const { record, version } = readBundle(bundleId);
      return Object.freeze({ ...record, version });
    },

    /* ---------------------------------------------------------- transfers */

    createTransfer({ bundleId, fromPrincipal, toPrincipal, metadata = null } = {}) {
      assertId(bundleId, 'bundleId');
      readBundle(bundleId);
      const transferId = assertId(idFactory(), 'idFactory output');
      const now = clock.now();
      const record = {
        tag: TRANSFER_TAG,
        transferId,
        bundleId,
        fromPrincipal: assertPrincipal(fromPrincipal, 'fromPrincipal'),
        toPrincipal: assertPrincipal(toPrincipal, 'toPrincipal'),
        state: 'created',
        bundleDigest: null,
        createdAt: now,
        updatedAt: now,
        metadata: metadata === undefined ? null : assertSecretFree(metadata, 'metadata'),
      };
      return createRecord(transferKey(transferId), record);
    },

    getTransfer(transferId) {
      assertId(transferId, 'transferId');
      const { record, version } = readTransfer(transferId);
      return Object.freeze({ ...record, version });
    },

    /** Seal: pins the bundle digest (bundle version) on the transfer record. */
    sealTransfer(transferId, { version } = {}) {
      assertId(transferId, 'transferId');
      const { record } = readTransfer(transferId);
      const allowed = TRANSFER_TRANSITIONS[record.state];
      if (!allowed.includes('sealed')) {
        throw invalid(`cannot seal a transfer in state ${record.state}`);
      }
      const { record: bundle } = readBundle(record.bundleId);
      const digest = bundleDigestOf({ manifest: bundle.manifest, payload: bundle.payload, schemaVersion: bundle.schemaVersion });
      const next = { ...record, state: 'sealed', bundleDigest: digest, updatedAt: clock.now() };
      return casUpdate(transferKey(transferId), next, version, 'transfer');
    },

    completeTransfer(transferId, { version } = {}) {
      return transition(transferId, 'completed', version);
    },

    abortTransfer(transferId, { version } = {}) {
      return transition(transferId, 'aborted', version);
    },

    /* -------------------------------------------------------------- lists */

    listBundles({ cursor = null, limit = 100 } = {}) {
      return listFiltered({ prefix: 'b:', tag: BUNDLE_TAG, kind: 'bundle', cursor, limit, field: 'bundles' });
    },

    listTransfers({ cursor = null, limit = 100 } = {}) {
      return listFiltered({ prefix: 't:', tag: TRANSFER_TAG, kind: 'transfer', cursor, limit, field: 'transfers' });
    },
  });
}

export const TRANSFER_MODEL_VERSION = 1;
