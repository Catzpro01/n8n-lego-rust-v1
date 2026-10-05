/**
 * Artifact foundation — opaque, reference-only artifact identity (P2.19).
 *
 * PUBLIC CONTRACT: ai.artifact@1.0.0 (owner: manager).
 *
 * An artifact in this contract is a REFERENCE plus metadata — never a file.
 * The foundation knows an artifact exists, what it is (kind), how to name it
 * (artifactId), where its bytes live *somewhere else* (an opaque storageRef
 * that this module never dereferences), how to check them (checksum as an
 * integrity reference) and how long it is kept (retention/lifecycle).
 *
 * WHAT THIS IS NOT: a storage engine. No S3, no Supabase, no filesystem, no
 * database blob store, no download server. There is deliberately no readFile,
 * writeFile, exec, spawn or path resolution in this module — the storage
 * provider boundary owns bytes, and P2.19 does not build it. Traversal-shaped
 * references are refused at declaration so a path can never masquerade as an
 * opaque reference.
 *
 * Vocabulary (kinds, retention, canonical fields) is quoted from
 * manifest/ai-foundation.json — the contract-first source of truth — through
 * the ai.foundation accessors. This module extends nothing it does not quote:
 * first publication of the lock row absorbs the P2.19 fields (`state`) into
 * the canonical nine.
 *
 * Owner of the contract: manager. Implementation: agent-1 (P2.19).
 */
import { createHash } from 'node:crypto';

import {
  AI_FOUNDATION,
  ARTIFACT_KINDS,
  ARTIFACT_RETENTION,
} from './ai-foundation.mjs';

/* ---------------------------------------------------------------- contract */

export const ARTIFACT_CONTRACT = Object.freeze({
  id: "ai.artifact",
  version: '1.0.0',
  owner: 'manager',
  /** The canonical nine fields quoted from manifest/ai-foundation.json. */
  fields: Object.freeze([
    ...AI_FOUNDATION.artifact.fields,
    // P2.19 addition absorbed at first publication: the lifecycle the
    // descriptor declares (declared → created → referenced → retained →
    // expired) needs a record-level state to be observable.
    'state',
  ]),
  canonicalFields: Object.freeze([...AI_FOUNDATION.artifact.fields]),
});

export const ARTIFACT_CONTRACT_VERSION = ARTIFACT_CONTRACT.version;
export const ARTIFACT_FIELDS = ARTIFACT_CONTRACT.fields;
export { ARTIFACT_KINDS, ARTIFACT_RETENTION };

/** Lifecycle quoted from the Artifact LEGO descriptor (ai-lego-set.json). */
export const ARTIFACT_LIFECYCLE = Object.freeze({
  states: Object.freeze(['declared', 'created', 'referenced', 'retained', 'expired']),
  /** Records are born by `create` at `created`; `declared` is the descriptor's pre-state. */
  initial: 'declared',
  terminal: Object.freeze(['expired']),
  transitions: Object.freeze({
    declared: Object.freeze(['created', 'expired']),
    created: Object.freeze(['referenced', 'retained', 'expired']),
    referenced: Object.freeze(['retained', 'expired']),
    retained: Object.freeze(['expired']),
    expired: Object.freeze([]),
  }),
});
export const ARTIFACT_LIFECYCLE_STATES = ARTIFACT_LIFECYCLE.states;

/** Domain-declared operations (manifest/domains.json). */
export const ARTIFACT_OPERATIONS = Object.freeze(['create', 'read']);
export const ARTIFACT_PERMISSIONS = Object.freeze(['ai:artifact:read', 'ai:artifact:write']);

export const ARTIFACT_LIMITS = Object.freeze({
  maxArtifacts: 256,
  maxIdentifierLength: 64,
  maxStorageRefLength: 256,
  maxOwnerLength: 128,
  maxMimeLength: 128,
  maxMetadataBytes: 8 * 1024,
  maxMetadataKeys: 16,
  maxMetadataDepth: 4,
  maxMetadataKeyLength: 64,
  maxContentSizeBytes: 1024 * 1024,
});

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const CHECKSUM_RE = /^sha256:[0-9a-f]{64}$/;
/** Path-shaped storage references can never be "opaque" — refuse them. */
const TRAVERSAL_RE = /(^|\/)\.\.(\/|$)/;
const ABSOLUTE_PATH_RE = /^(?:\/|~\/|[A-Za-z]:[\\/])/;
const SENSITIVE_KEY = /(?:credential|secret|password|passwd|token|cookie|authorization|api[-_]?key|private[-_]?key|hidden[-_]?prompt|raw[-_]?prompt|chain[-_]?of[-_]?thought|reasoning|model[-_]?thought|transcript|messages?|host[-_]?path|filesystem|terminal|capability[-_]?grant|permission[-_]?grant)/i;
const SENSITIVE_TEXT = /(?:BEGIN\s+(?:RSA|OPENSSH|PRIVATE)\s+KEY|(?:^|\W)sk-[a-z0-9]{8,}|(?:^|\W)ghp_[a-z0-9]{8,}|(?:^|\W)github_pat_[a-z0-9_]{8,}|Bearer\s+[a-z0-9._-]+)/i;

/* ------------------------------------------------------------------ errors */

export class ArtifactError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ArtifactError';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function fail(message, details = {}) {
  throw new ArtifactError('lego.contract_violation', message, details);
}

/* -------------------------------------------------------------- primitives */

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function freezeDeep(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeDeep(child);
  return Object.freeze(value);
}

function canonical(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('artifact value contains a non-finite number');
    return value;
  }
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonical(value[key]);
    return out;
  }
  fail(`artifact value contains unsupported type '${typeof value}'`);
}

function stableJson(value) {
  return JSON.stringify(canonical(value));
}

function assertPlainObject(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${field} must be a plain object`);
  return value;
}

function assertBoundedString(value, field, maxLength, { required = true, nullable = false } = {}) {
  if (value === undefined || value === null) {
    if (required && !nullable) fail(`${field} is required`);
    return null;
  }
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    fail(`${field} must be a non-empty string of at most ${maxLength} characters`);
  }
  if (SENSITIVE_TEXT.test(value)) {
    fail(`${field} carries secret-shaped material — artifact metadata never holds credentials`, { field });
  }
  return value;
}

function assertId(value, field) {
  if (typeof value !== 'string' || !ID_RE.test(value)) {
    fail(`${field} must match ${ID_RE} (1..${ARTIFACT_LIMITS.maxIdentifierLength} characters)`);
  }
  return value;
}

/**
 * An opaque storage reference. This foundation never resolves it — but a
 * traversal or absolute path is not opaque, it is authority trying to pass as
 * a reference, so it fails closed at the door.
 */
function assertStorageRef(value) {
  const ref = assertBoundedString(value, 'storageRef', ARTIFACT_LIMITS.maxStorageRefLength);
  if (TRAVERSAL_RE.test(ref) || ABSOLUTE_PATH_RE.test(ref)) {
    fail('storageRef must be an opaque reference — path-shaped values (../, absolute, ~/ or drive letters) are refused', {
      field: 'storageRef',
    });
  }
  if (ref.includes('\0')) fail('storageRef must not contain NUL bytes');
  return ref;
}

function assertChecksum(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') fail('checksum must be a string of the form sha256:<64 hex>');
  const normalized = /^sha256:[0-9a-f]{64}$/.test(value) ? value : (/^[0-9a-f]{64}$/.test(value) ? `sha256:${value}` : null);
  if (normalized === null) {
    fail('checksum must be sha256:<64 hex> — malformed integrity metadata is refused, never accepted as-is', {
      field: 'checksum',
    });
  }
  return normalized;
}

function assertMetadata(value) {
  if (value === undefined || value === null) return {};
  assertPlainObject(value, 'metadata');
  const keys = Object.keys(value);
  if (keys.length > ARTIFACT_LIMITS.maxMetadataKeys) {
    fail(`metadata exceeds ${ARTIFACT_LIMITS.maxMetadataKeys} keys`, { limit: ARTIFACT_LIMITS.maxMetadataKeys });
  }
  for (const key of keys) {
    if (key.length === 0 || key.length > ARTIFACT_LIMITS.maxMetadataKeyLength) {
      fail(`metadata key must be 1..${ARTIFACT_LIMITS.maxMetadataKeyLength} characters`);
    }
    if (SENSITIVE_KEY.test(key)) {
      fail(`metadata key '${key}' is forbidden: artifact metadata cannot carry credentials, authority or reasoning`, { key });
    }
  }
  const size = Buffer.byteLength(stableJson(value), 'utf8');
  if (size > ARTIFACT_LIMITS.maxMetadataBytes) {
    fail(`metadata is ${size} bytes, beyond the ${ARTIFACT_LIMITS.maxMetadataBytes}-byte bound`, { size, limit: ARTIFACT_LIMITS.maxMetadataBytes });
  }
  validateJsonDepth(value, 'metadata', 0);
  return freezeDeep(clone(value));
}

function validateJsonDepth(value, path, depth) {
  if (depth > ARTIFACT_LIMITS.maxMetadataDepth) {
    fail(`${path} exceeds metadata nesting depth ${ARTIFACT_LIMITS.maxMetadataDepth}`, { limit: ARTIFACT_LIMITS.maxMetadataDepth });
  }
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const entry of value) validateJsonDepth(entry, path, depth + 1);
  } else {
    for (const entry of Object.values(value)) validateJsonDepth(entry, path, depth + 1);
  }
}

/* ---------------------------------------------------------------- digest */

/**
 * Deterministic content digest: same content in, same digest out — the only
 * honest way a checksum enters this contract. Callers that cannot produce the
 * content simply omit the checksum; the foundation never invents one.
 *
 * @param {string|object} content plain content whose integrity is being named
 * @returns {string} `sha256:<hex>` matching the checksum field format
 */
export function artifactContentDigest(content) {
  if (content === undefined) fail('artifactContentDigest requires the content to digest');
  const body = typeof content === 'string' ? content : stableJson(content);
  if (Buffer.byteLength(body, 'utf8') > ARTIFACT_LIMITS.maxContentSizeBytes) {
    fail(`content exceeds ${ARTIFACT_LIMITS.maxContentSizeBytes} bytes — digest helpers bound their input`, {
      limit: 'maxContentSizeBytes',
    });
  }
  return `sha256:${createHash('sha256').update(body, 'utf8').digest('hex')}`;
}

/* --------------------------------------------------------------- registry */

function makeRegistry(options = {}) {
  const now = options.now ?? (() => new Date().toISOString());
  const limits = Object.freeze({ ...ARTIFACT_LIMITS, ...(options.limits ?? {}) });
  if (typeof now !== 'function') fail('now must be a function returning an ISO timestamp');
  if (!Number.isInteger(limits.maxArtifacts) || limits.maxArtifacts < 1) fail('limits.maxArtifacts must be a positive integer');

  const store = new Map();

  function timestamp() {
    const value = now();
    if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) fail('now() must return an ISO timestamp');
    return value;
  }

  function assertTransition(current, next) {
    const allowed = ARTIFACT_LIFECYCLE.transitions[current];
    if (!allowed || !allowed.includes(next)) {
      fail(`artifact lifecycle cannot move from '${current}' to '${next}'`, { from: current, to: next });
    }
  }

  function mutate(artifactId, next) {
    const record = store.get(artifactId);
    if (!record) return null;
    assertTransition(record.state, next);
    const updated = Object.freeze({ ...record, state: next });
    store.set(artifactId, updated);
    return updated;
  }

  const registry = {
    /**
     * Declare an artifact reference. `state` starts at `created` — the record
     * now exists; content stays behind the opaque storageRef.
     */
    create(input) {
      assertPlainObject(input, 'create input');
      const {
        artifactId, kind, storageRef,
        size = null, mime = null, checksum = null,
        owner = null, retention = 'session', metadata = {},
      } = input;
      assertId(artifactId, 'artifactId');
      if (store.has(artifactId)) {
        fail(`artifact '${artifactId}' already exists — one identity, one record`, { artifactId });
      }
      if (store.size >= limits.maxArtifacts) {
        fail(`artifact registry is bounded at ${limits.maxArtifacts} records`, { limit: 'maxArtifacts' });
      }
      if (typeof kind !== 'string' || !ARTIFACT_KINDS.includes(kind)) {
        fail(`kind must be one of ${ARTIFACT_KINDS.join(', ')}`, { kind });
      }
      const ref = assertStorageRef(storageRef);
      if (size !== null && size !== undefined) {
        if (!Number.isInteger(size) || size < 0) fail('size must be a non-negative integer (bytes)');
      }
      const safeMime = mime === null || mime === undefined ? null : assertBoundedString(mime, 'mime', limits.maxMimeLength, { nullable: true });
      const safeChecksum = assertChecksum(checksum);
      const safeOwner = owner === null || owner === undefined ? null : assertBoundedString(owner, 'owner', limits.maxOwnerLength, { nullable: true });
      if (typeof retention !== 'string' || !ARTIFACT_RETENTION.includes(retention)) {
        fail(`retention must be one of ${ARTIFACT_RETENTION.join(', ')}`, { retention });
      }
      const record = Object.freeze({
        artifactId,
        kind,
        size: size ?? null,
        mime: safeMime,
        createdAt: timestamp(),
        owner: safeOwner,
        storageRef: ref,
        checksum: safeChecksum,
        retention,
        state: 'created',
        metadata: assertMetadata(metadata),
      });
      store.set(artifactId, record);
      return freezeDeep(clone(record));
    },

    /** Read a reference back. Unknown artifact → null (a lookup is not an approval). */
    read(artifactId) {
      assertId(artifactId, 'artifactId');
      const record = store.get(artifactId);
      return record ? freezeDeep(clone(record)) : null;
    },

    /** The reference was carried somewhere (approval, audit, session). */
    reference(artifactId) {
      assertId(artifactId, 'artifactId');
      const next = mutate(artifactId, 'referenced');
      if (!next) fail(`unknown artifact '${artifactId}'`, { artifactId });
      return freezeDeep(clone(next));
    },

    /** Retention upgraded to a kept class. */
    retain(artifactId) {
      assertId(artifactId, 'artifactId');
      const next = mutate(artifactId, 'retained');
      if (!next) fail(`unknown artifact '${artifactId}'`, { artifactId });
      return freezeDeep(clone(next));
    },

    /** Lifecycle end. Deterministic, terminal, reversible by nothing here. */
    expire(artifactId) {
      assertId(artifactId, 'artifactId');
      const next = mutate(artifactId, 'expired');
      if (!next) fail(`unknown artifact '${artifactId}'`, { artifactId });
      return freezeDeep(clone(next));
    },

    get size() {
      return store.size;
    },
    clear() {
      store.clear();
    },
  };
  return registry;
}

/**
 * Create an artifact foundation instance.
 * @param {{ now?: () => string, limits?: object }} [options]
 */
export function createArtifactRegistry(options = {}) {
  return makeRegistry(options);
}
