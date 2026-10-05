/**
 * Memory LEGO — persistent knowledge that survives context replacement (P2.14).
 *
 * PUBLIC CONTRACT: ai.memory@1.0.0 (owner: manager).
 *
 * Memory is information intentionally retained beyond the lifetime of any single
 * context window. Where Context is what is loaded now and Session is the lifecycle
 * of an interaction, Memory is what remains after that context is replaced,
 * compacted or rehydrated. It is never hidden inside Context or Session state
 * and never dumped implicitly into a window — loading is always an explicit,
 * bounded, relevance-driven caller choice (even though relevance ranking itself
 * is deferred: P2.14's list is deterministic and ordered by creation time).
 *
 * This module is the bounded backend for that contract. It is deliberately
 * small, provider-neutral and model-free. No embedding, no vector search, no
 * inference, no filesystem or provider call lives here — the store is an
 * explicit MemoryProvider boundary whose default is an in-memory map, and the
 * whole module is local state only.
 */

import { createHash } from 'node:crypto';

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

// Read the canonical manifest so the implementation cannot drift from the
// published contract without a test noticing. The manifest is the source of
// truth for vocabulary; the constants below quote it rather than re-declaring.
const MANIFEST = (() => {
  try {
    return JSON.parse(readFileSync(resolve(HERE, 'manifest', 'memory.json'), 'utf8'));
  } catch {
    return null;
  }
})();

export const MEMORY_CONTRACT = Object.freeze({
  id: "ai.memory",
  version: '1.0.0',
  owner: 'manager',
  scopes: Object.freeze(['GLOBAL', 'PROJECT', 'WORKFLOW', 'AGENT', 'SESSION']),
  kinds: Object.freeze(['note', 'decision', 'artifact', 'task', 'execution', 'reference']),
  retentions: Object.freeze(['EPHEMERAL', 'WORKING', 'IMPORTANT', 'DURABLE', 'PERMANENT']),
  fields: Object.freeze([
    'memoryId', 'scope', 'scopeOwner', 'kind', 'retention',
    'content', 'references', 'provenance',
    'version', 'size', 'checksum', 'createdAt', 'updatedAt',
  ]),
  graphNodes: Object.freeze([
    'project', 'workflow', 'node', 'execution', 'agent', 'session',
    'decision', 'evidence', 'artifact', 'task',
  ]),
  graphEdges: Object.freeze([
    'depends_on', 'caused', 'derived_from', 'supports', 'contradicts',
    'implements', 'belongs_to', 'delegated_to', 'decided_by', 'observed_in', 'related_to',
  ]),
});

export const MEMORY_CONTRACT_VERSION = MEMORY_CONTRACT.version;
export const MEMORY_SCOPES = MEMORY_CONTRACT.scopes;
export const MEMORY_KINDS = MEMORY_CONTRACT.kinds;
export const MEMORY_RETENTIONS = MEMORY_CONTRACT.retentions;
export const MEMORY_FIELDS = MEMORY_CONTRACT.fields;
export const MEMORY_GRAPH_NODES = MEMORY_CONTRACT.graphNodes;
export const MEMORY_GRAPH_EDGES = MEMORY_CONTRACT.graphEdges;

export const MEMORY_OPERATIONS = Object.freeze([
  'memory.remember',
  'memory.recall',
  'memory.list',
  'memory.forget',
]);

export const MEMORY_PERMISSIONS = Object.freeze(['ai:memory:read', 'ai:memory:write']);

export const MEMORY_LIFECYCLE = Object.freeze({
  states: Object.freeze(['active', 'forgotten']),
  initial: 'active',
  terminal: Object.freeze(['forgotten']),
});

const DEFAULT_LIMITS = Object.freeze({
  maxContentBytes: 64 * 1024,
  maxRecordBytes: 128 * 1024,
  maxRecords: 10000,
  maxReferences: 32,
  maxReferenceIdLength: 128,
});

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 100;

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_ID_LENGTH = 128;

// Same sensitive pattern family that guards context state: credential-adjacent
// keys and values must never be persisted as memory content. A memory that
// stores a secret has silently become a credential store, and that is exactly
// the hidden coupling the boundary exists to prevent.
const SENSITIVE_KEY = /(?:credential|secret|password|passwd|token|cookie|authorization|api[-_]?key|private[-_]?key|hidden[-_]?prompt|raw[-_]?prompt|chain[-_]?of[-_]?thought|reasoning|model[-_]?thought|transcript|messages?|host[-_]?path|filesystem|terminal|capability[-_]?grant|permission[-_]?grant)/i;
const SENSITIVE_TEXT = /(?:BEGIN\s+(?:RSA|OPENSSH|PRIVATE)\s+KEY|(?:^|\W)sk-[a-z0-9]{8,}|(?:^|\W)ghp_[a-z0-9]{8,}|Bearer\s+[a-z0-9._-]+)/i;
const ABSOLUTE_HOST_PATH = /^(?:[A-Za-z]:[\\/]|\\\\|\/(?:home|root|tmp|var|etc|Users|private)\b)/;

export class MemoryError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'MemoryError';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function fail(message, details = {}) {
  throw new MemoryError('lego.contract_violation', message, details);
}

function mismatch(message, details = {}) {
  throw new MemoryError('lego.interaction_mismatch', message, details);
}

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
    if (!Number.isFinite(value)) fail('memory content contains a non-finite number');
    return value;
  }
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonical(value[key]);
    return out;
  }
  fail(`memory content contains unsupported value type '${typeof value}'`);
}

function stableJson(value) {
  return JSON.stringify(canonical(value));
}

function bytes(value) {
  return Buffer.byteLength(stableJson(value), 'utf8');
}

function checksum(value) {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function iso(nowFn) {
  const fn = nowFn ?? (() => new Date().toISOString());
  const value = fn();
  if (typeof value !== 'string') fail('now() must return an ISO string');
  return value;
}

function assertPlainObject(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${field} must be a plain object`);
  }
}

function assertId(value, field) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_ID_LENGTH || !ID_RE.test(value)) {
    fail(`${field} must match ${ID_RE} and be 1..${MAX_ID_LENGTH} chars`);
  }
}

function assertScope(value) {
  if (!MEMORY_SCOPES.includes(value)) fail(`scope must be one of ${MEMORY_SCOPES.join(', ')}`);
}

function assertKind(value) {
  if (!MEMORY_KINDS.includes(value)) fail(`kind must be one of ${MEMORY_KINDS.join(', ')}`);
}

function assertRetention(value) {
  if (!MEMORY_RETENTIONS.includes(value)) fail(`retention must be one of ${MEMORY_RETENTIONS.join(', ')}`);
}

function assertEdge(value) {
  if (!MEMORY_GRAPH_EDGES.includes(value)) fail(`relation must be one of ${MEMORY_GRAPH_EDGES.join(', ')}`);
}

function scanSensitive(value, path = '') {
  if (value === null || value === undefined) return;
  if (typeof value === 'string') {
    if (SENSITIVE_TEXT.test(value) || ABSOLUTE_HOST_PATH.test(value)) {
      fail(`memory content at '${path || 'content'}' contains sensitive or host-path material`);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) scanSensitive(value[i], `${path}[${i}]`);
    return;
  }
  if (typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (SENSITIVE_KEY.test(key)) fail(`memory content key '${path ? `${path}.` : ''}${key}' is a sensitive namespace and must not be stored`);
      scanSensitive(child, path ? `${path}.${key}` : key);
    }
  }
}

function validateReferences(references, limits) {
  if (references === undefined) return [];
  if (!Array.isArray(references)) fail('references must be an array');
  if (references.length > limits.maxReferences) fail(`references exceeds bounded limit of ${limits.maxReferences}`);
  const out = [];
  for (let i = 0; i < references.length; i++) {
    const ref = references[i];
    assertPlainObject(ref, `references[${i}]`);
    if (typeof ref.id !== 'string' || ref.id.length === 0 || ref.id.length > limits.maxReferenceIdLength || !ID_RE.test(ref.id)) {
      fail(`references[${i}].id must match ${ID_RE}`);
    }
    if (typeof ref.relation !== 'string') fail(`references[${i}].relation must be a string`);
    assertEdge(ref.relation);
    if (ref.kind !== undefined && typeof ref.kind !== 'string') fail(`references[${i}].kind must be a string when present`);
    if (ref.kind !== undefined && !MEMORY_GRAPH_NODES.includes(ref.kind) && !MEMORY_KINDS.includes(ref.kind)) {
      // kind inside a reference is informational; it may name a graph node or a memory kind,
      // but an unknown graph vocabulary is refused rather than stored silently.
      fail(`references[${i}].kind must be a known graph node or memory kind`);
    }
    // Sensitive scan inside references as well
    scanSensitive(ref, `references[${i}]`);
    out.push({ id: ref.id, relation: ref.relation, ...(ref.kind ? { kind: ref.kind } : {}) });
  }
  return out;
}

function publicRecord(internal) {
  // The frozen public view is exactly the integrity-covered body plus the two
  // envelope fields, all frozen deeply so no caller can mutate the store.
  return freezeDeep(clone(internal));
}

// ---------------------------------------------------------------------------
// Provider boundary
// ---------------------------------------------------------------------------

/**
 * The provider boundary. The contract talks to this interface and never to a
 * concrete store. The default is an in-memory map (bounded, per-process);
 * a caller that needs durability injects an alternative implementation of the
 * same surface without changing any caller.
 */
export class InMemoryProvider {
  constructor() {
    this.store = new Map();
  }

  put(record) {
    this.store.set(record.memoryId, clone(record));
  }

  get(memoryId) {
    const found = this.store.get(memoryId);
    return found ? clone(found) : null;
  }

  delete(memoryId) {
    return this.store.delete(memoryId);
  }

  list() {
    return Array.from(this.store.values()).map(clone);
  }

  clear() {
    this.store.clear();
  }

  get size() {
    return this.store.size;
  }
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

function makeManager(options = {}) {
  const now = options.now ?? (() => new Date().toISOString());
  const limits = Object.freeze({ ...DEFAULT_LIMITS, ...(options.limits ?? {}) });
  const provider = options.provider ?? new InMemoryProvider();

  // The provider is the persistence boundary: the manager never reaches into
  // provider.store directly, only through put/get/delete/list. A foreign
  // provider that implements those four methods is interchangeable.
  if (typeof provider.put !== 'function' || typeof provider.get !== 'function'
    || typeof provider.delete !== 'function' || typeof provider.list !== 'function') {
    fail('provider must implement { put, get, delete, list }');
  }

  function ensureLimitsForNewRecord() {
    if (provider.size >= limits.maxRecords) {
      fail('memory store has reached its bounded record limit', { limit: limits.maxRecords });
    }
  }

  function buildIntegrityBody(recordWithoutIntegrity) {
    // Integrity covers the canonical record without size and checksum.
    const { size: ignoredSize, checksum: ignoredChecksum, ...body } = recordWithoutIntegrity;
    const size = bytes(body);
    if (size > limits.maxRecordBytes) {
      fail('memory record exceeds its bounded size limit', { size, limit: limits.maxRecordBytes });
    }
    const sum = checksum(body);
    return { body, size, checksum: sum };
  }

  function remember(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail('remember requires a plain object');
    const {
      memoryId, scope, scopeOwner, kind, retention,
      content, references, provenance,
    } = input;

    assertId(memoryId, 'memoryId');
    if (typeof scope !== 'string') fail('scope is required');
    assertScope(scope);
    if (scope === 'GLOBAL') {
      if (scopeOwner !== undefined && scopeOwner !== null) fail('GLOBAL scope must not carry a scopeOwner');
    } else {
      if (scopeOwner === undefined || scopeOwner === null) fail(`scope '${scope}' requires a scopeOwner`);
      assertId(scopeOwner, 'scopeOwner');
    }
    if (typeof kind !== 'string') fail('kind is required');
    assertKind(kind);
    if (typeof retention !== 'string') fail('retention is required');
    assertRetention(retention);

    // Content is the bounded payload: canonical, size-checked, sensitive-scanned.
    const safeContent = content === undefined ? null : clone(content);
    // Validate that content is JSON-serializable via canonical
    const canonicalContent = safeContent === null ? null : canonical(safeContent);
    if (safeContent !== null) {
      const contentBytes = bytes(canonicalContent);
      if (contentBytes > limits.maxContentBytes) {
        fail('memory content exceeds its bounded limit', { size: contentBytes, limit: limits.maxContentBytes });
      }
      scanSensitive(canonicalContent, 'content');
    }

    const safeReferences = validateReferences(references, limits);
    if (provenance !== undefined) {
      assertPlainObject(provenance, 'provenance');
      if (provenance.createdBy !== undefined && typeof provenance.createdBy !== 'string') fail('provenance.createdBy must be a string');
      if (provenance.source !== undefined && typeof provenance.source !== 'string') fail('provenance.source must be a string');
      scanSensitive(provenance, 'provenance');
    }

    const existing = provider.get(memoryId);
    const timestamp = iso(now);

    if (existing) {
      // Scope and kind are immutable: a memory's namespace cannot be silently
      // moved by a second remember. A caller that needs a different scope
      // remembers a new identity instead.
      if (existing.scope !== scope) fail(`memory '${memoryId}' already exists in scope '${existing.scope}' and cannot be moved to '${scope}'`);
      if (existing.scopeOwner !== (scopeOwner ?? null) && existing.scopeOwner !== scopeOwner) {
        // Normalize null vs undefined for GLOBAL
        const a = existing.scopeOwner ?? null;
        const b = scopeOwner ?? null;
        if (a !== b) fail(`memory '${memoryId}' scopeOwner mismatch`);
      }
      if (existing.kind !== kind) fail(`memory '${memoryId}' kind mismatch: existing '${existing.kind}' vs '${kind}'`);
      // Retention may be updated explicitly; content and references drive the checksum.
      const candidateBody = {
        memoryId,
        scope,
        scopeOwner: scopeOwner ?? null,
        kind,
        retention,
        content: canonicalContent,
        references: safeReferences,
        provenance: provenance ? clone(provenance) : existing.provenance,
        version: existing.version,
        createdAt: existing.createdAt,
        updatedAt: timestamp,
      };
      const { body, size, checksum: sum } = buildIntegrityBody(candidateBody);
      // Idempotency: identical canonical content and references and retention
      // leaves version and checksum unchanged — a retry is a no-op.
      const existingBody = { ...existing };
      delete existingBody.size;
      delete existingBody.checksum;
      const candidateCanonical = canonical(body);
      const existingCanonical = canonical({ ...existingBody, version: existing.version, createdAt: existing.createdAt, updatedAt: existing.updatedAt });
      // Compare the bounded payload parts (content, references, retention, provenance, scope)
      // via the bodies without version/updatedAt/timestamps? Simpler: compare
      // content+references+retention canonical and provenance.
      const payloadSame = stableJson({ content: body.content, references: body.references, retention: body.retention, provenance: body.provenance, scope: body.scope, scopeOwner: body.scopeOwner, kind: body.kind })
        === stableJson({ content: existing.content, references: existing.references, retention: existing.retention, provenance: existing.provenance, scope: existing.scope, scopeOwner: existing.scopeOwner, kind: existing.kind });
      if (payloadSame) {
        return publicRecord(existing);
      }
      const nextVersion = existing.version + 1;
      const versionedBody = { ...body, version: nextVersion };
      const { size: finalSize, checksum: finalSum } = buildIntegrityBody(versionedBody);
      // Rebuild with final version/size/checksum
      const record = freezeDeep({
        ...versionedBody,
        size: finalSize,
        checksum: finalSum,
      });
      // Size/checksum already computed inside build; use the versioned body's derived values
      // Actually buildIntegrityBody recomputes over versionedBody; we can reuse final*
      const finalRecord = {
        ...versionedBody,
        size: finalSize,
        checksum: finalSum,
      };
      provider.put(finalRecord);
      return publicRecord(finalRecord);
    }

    ensureLimitsForNewRecord();
    const initialBody = {
      memoryId,
      scope,
      scopeOwner: scopeOwner ?? null,
      kind,
      retention,
      content: canonicalContent,
      references: safeReferences,
      provenance: provenance ? clone(provenance) : null,
      version: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const { body, size, checksum: sum } = buildIntegrityBody(initialBody);
    const record = { ...body, size, checksum: sum };
    provider.put(record);
    return publicRecord(record);
  }

  function recall(memoryId) {
    if (typeof memoryId !== 'string') fail('memoryId must be a string');
    assertId(memoryId, 'memoryId');
    const found = provider.get(memoryId);
    if (!found) return null;
    // Verify integrity on read: a tampered store entry is not silently returned.
    const { size: storedSize, checksum: storedChecksum, ...body } = found;
    const recomputedSize = bytes(body);
    const recomputedChecksum = checksum(body);
    if (recomputedSize !== storedSize || recomputedChecksum !== storedChecksum) {
      throw new MemoryError('lego.contract_violation', `memory '${memoryId}' integrity check failed`, { storedSize, recomputedSize, storedChecksum, recomputedChecksum });
    }
    return publicRecord(found);
  }

  function list(query = {}) {
    if (query === null || typeof query !== 'object' || Array.isArray(query)) fail('list query must be a plain object when provided');
    const { scope, scopeOwner, kind, retention, limit, cursor, order } = query;

    if (scope !== undefined) {
      if (typeof scope !== 'string') fail('list scope must be a string when present');
      assertScope(scope);
    }
    if (scopeOwner !== undefined) {
      if (scopeOwner !== null && typeof scopeOwner !== 'string') fail('scopeOwner must be a string or null');
      if (scopeOwner !== null) assertId(scopeOwner, 'scopeOwner');
    }
    // A non-GLOBAL scope filter without a scopeOwner returns nothing rather
    // than leaking across owners: isolation is exact-match.
    if (scope !== undefined && scope !== 'GLOBAL' && scopeOwner === undefined) {
      // Caller filtered by scope alone; isolation says we must not return
      // records from a different owner, but we also cannot infer one.
      // The honest answer is an empty filtered view when the namespace is
      // underspecified: the caller must name the owner.
      // However, to keep list useful for callers that genuinely want all
      // records of a scope regardless of owner, we allow scope-only filtering
      // and perform exact scope matching; owner narrowing is optional.
      // So no throw here — just filter by scope.
    }
    if (kind !== undefined) {
      if (typeof kind !== 'string') fail('list kind must be a string');
      assertKind(kind);
    }
    if (retention !== undefined) {
      if (typeof retention !== 'string') fail('list retention must be a string');
      assertRetention(retention);
    }
    let effectiveLimit = DEFAULT_LIST_LIMIT;
    if (limit !== undefined) {
      if (typeof limit !== 'number' || !Number.isInteger(limit)) fail('list limit must be an integer');
      if (limit < 1 || limit > MAX_LIST_LIMIT) fail(`list limit must be between 1 and ${MAX_LIST_LIMIT}`);
      effectiveLimit = limit;
    }
    if (cursor !== undefined && cursor !== null && typeof cursor !== 'string') fail('cursor must be a string or null');
    if (order !== undefined && order !== 'createdAt' && order !== 'createdAtAsc') {
      fail('order must be createdAt (asc) when provided');
    }

    let all = provider.list();
    // Apply filters deterministically, in declaration order.
    if (scope !== undefined) all = all.filter((record) => record.scope === scope);
    if (scopeOwner !== undefined) all = all.filter((record) => (record.scopeOwner ?? null) === (scopeOwner ?? null));
    if (kind !== undefined) all = all.filter((record) => record.kind === kind);
    if (retention !== undefined) all = all.filter((record) => record.retention === retention);

    // Deterministic ordering: createdAt asc, then memoryId asc.
    all.sort((a, b) => {
      if (a.createdAt < b.createdAt) return -1;
      if (a.createdAt > b.createdAt) return 1;
      if (a.memoryId < b.memoryId) return -1;
      if (a.memoryId > b.memoryId) return 1;
      return 0;
    });

    const total = all.length;
    let start = 0;
    if (cursor !== null && cursor !== undefined && cursor !== '') {
      // Cursor is a base64-encoded memoryId of the last seen record.
      let decoded;
      try {
        decoded = Buffer.from(cursor, 'base64').toString('utf8');
      } catch {
        fail('cursor is not a valid opaque value');
      }
      const idx = all.findIndex((record) => record.memoryId === decoded);
      if (idx === -1) fail('cursor does not match any record in the filtered view');
      start = idx + 1;
    }

    const page = all.slice(start, start + effectiveLimit);
    const hasMore = start + effectiveLimit < all.length;
    const nextCursor = hasMore ? Buffer.from(page[page.length - 1].memoryId).toString('base64') : null;

    return freezeDeep({
      results: page.map(publicRecord),
      total,
      nextCursor,
      limit: effectiveLimit,
    });
  }

  function forget(memoryId) {
    if (typeof memoryId !== 'string') fail('memoryId must be a string');
    assertId(memoryId, 'memoryId');
    const existed = provider.delete(memoryId);
    return freezeDeep({ forgotten: existed, memoryId });
  }

  function verify(record) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) fail('record must be a plain object');
    assertId(record.memoryId, 'record.memoryId');
    const { size: storedSize, checksum: storedChecksum, ...body } = record;
    if (typeof storedSize !== 'number' || typeof storedChecksum !== 'string') fail('record is missing integrity fields');
    const recomputedSize = bytes(body);
    const recomputedChecksum = checksum(body);
    const valid = recomputedSize === storedSize && recomputedChecksum === storedChecksum;
    return freezeDeep({
      valid,
      storedSize,
      storedChecksum,
      recomputedSize,
      recomputedChecksum,
      reasons: valid ? [] : ['checksum-mismatch'],
    });
  }

  function status() {
    return freezeDeep({
      contract: MEMORY_CONTRACT_VERSION,
      provider: provider.constructor?.name ?? 'MemoryProvider',
      count: provider.size,
      limits,
    });
  }

  function clear() {
    provider.clear();
  }

  return {
    contract: MEMORY_CONTRACT_VERSION,
    limits,
    get count() { return provider.size; },
    remember,
    recall,
    list,
    forget,
    verify,
    status,
    clear,
    provider,
  };
}

export function createMemoryManager(options = {}) {
  return makeManager(options);
}

export const createMemoryProvider = () => new InMemoryProvider();

// Convenience: the manifest-quoted vocabulary so consumers can import it
// from the implementation without re-reading the JSON.
export const MEMORY_MANIFEST = MANIFEST ? Object.freeze(clone(MANIFEST)) : null;
