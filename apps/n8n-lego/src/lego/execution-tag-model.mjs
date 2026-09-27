/**
 * P5-M18 execution annotation/tag model (P5-M10-H): AnnotationTag-equivalent
 * entities + attach/detach on executions (upstream parity) over the store
 * extension of the P8 storage facade. The annotation API surface stays gated
 * upstream; it mounts on this model later.
 *
 * Records (closed shapes):
 *   tag        {tag:1, tagId, name, createdAt, updatedAt}        at `t:<tagId>`
 *   name index {tag:1, tagId, name}                              at `n:<lc(name)>`
 *   attachment {tag:2, executionId, tagId, createdAt}            at `a:<execId>:<tagId>`
 *
 * Upstream-parity behavior (relevant subset):
 *   - tag names are unique case-insensitively (second createTag -> TAG_CONFLICT);
 *   - attach is idempotent: re-attaching returns {attached:false} and never
 *     creates a duplicate record (no hidden side effects);
 *   - detach is idempotent: {detached:false} when the link is absent;
 *   - deleting a tag detaches it everywhere in ONE all-or-nothing batch (no
 *     dangling attachments).
 *
 * Concurrency: createTag/attach are create-only (pre-check + put + read-back
 * verify); deleteTag is pure CAS (version token REQUIRED; stale -> CONFLICT);
 * the delete batch carries per-op expectedVersion so a concurrent attach fails
 * the whole delete (all-or-nothing).
 *
 * Orphan cleanup (explicit, never automatic): attachments whose execution no
 * longer exists (dependency-injected `executionLookup`) are orphans;
 * `cleanupGarbage()` removes them in deterministic key order and returns the
 * count. The model never silently rewrites history outside these APIs.
 *
 * Error set (closed): TAG_INVALID | TAG_NOT_FOUND | TAG_CONFLICT.
 * Storage errors propagate unchanged.
 */

export const TAG_ERROR_CODES = Object.freeze({
  INVALID: 'TAG_INVALID',
  NOT_FOUND: 'TAG_NOT_FOUND',
  CONFLICT: 'TAG_CONFLICT',
});

export class ExecutionTagModelError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'ExecutionTagModelError';
    this.code = code;
    this.details = options.details ?? {};
    if (!Object.values(TAG_ERROR_CODES).includes(code)) {
      throw new TypeError(`ExecutionTagModelError: unknown code ${String(code)}`);
    }
  }
}

const invalid = (message, details) => new ExecutionTagModelError(TAG_ERROR_CODES.INVALID, message, { details });
const notFound = (message, details) => new ExecutionTagModelError(TAG_ERROR_CODES.NOT_FOUND, message, { details });
const conflict = (message, details) => new ExecutionTagModelError(TAG_ERROR_CODES.CONFLICT, message, { details });

const TAG_RECORD = 1;
const ATTACH_RECORD = 2;

const tagKey = (tagId) => `t:${tagId}`;
const nameKey = (name) => `n:${name.trim().toLowerCase()}`;
const attachKey = (executionId, tagId) => `a:${executionId}:${tagId}`;

const assertId = (value, field) => {
  if (typeof value !== 'string' || value.length < 6 || value.length > 128) {
    throw invalid(`${field} must be an opaque string of 6..128 characters`);
  }
  return value;
};
const assertName = (name) => {
  if (typeof name !== 'string' || name.trim().length === 0 || name.length > 100) {
    throw invalid('name must be a non-empty string of at most 100 characters');
  }
  return name.trim();
};

/**
 * @param {object} storage storage facade handle - the ONLY persistence boundary
 * @param {object} options
 * @param {{ now: () => number }} options.clock REQUIRED deterministic clock (ms)
 * @param {() => string} options.idFactory REQUIRED opaque id factory
 * @param {(id: string) => unknown} options.executionLookup REQUIRED
 *   dependency-injected resolver of execution existence (any non-null = exists)
 * @param {string} [options.namespace='exec-tags']
 */
export function createExecutionTagModel(storage, { clock, idFactory, executionLookup, namespace = 'exec-tags' } = {}) {
  if (!storage || typeof storage.get !== 'function' || typeof storage.putIfVersion !== 'function') {
    throw invalid('createExecutionTagModel requires a storage facade handle');
  }
  if (!clock || typeof clock.now !== 'function') throw invalid('an injected clock is required');
  if (typeof idFactory !== 'function') throw invalid('an injected idFactory is required');
  if (typeof executionLookup !== 'function') throw invalid('an injected executionLookup is required');

  const readJson = (key, recordTag, kind) => {
    const got = storage.get(namespace, key);
    if (!got.found) return null;
    let record;
    try {
      record = JSON.parse(got.value.toString('utf8'));
    } catch (error) {
      throw conflict(`${kind} record is unreadable`, { cause: error });
    }
    if (record.tag !== recordTag) throw conflict(`${kind} record has an unsupported shape`);
    return { record, version: got.version };
  };

  const readTag = (tagId) => {
    const found = readJson(tagKey(tagId), TAG_RECORD, 'tag');
    if (!found) throw notFound('tag not found', { tagId: tagId.slice(0, 8) });
    return found;
  };

  const createRecord = (key, record) => {
    if (storage.get(namespace, key).found) throw conflict('record already exists');
    const bytes = Buffer.from(JSON.stringify(record), 'utf8');
    storage.put(namespace, key, bytes);
    const verify = storage.get(namespace, key);
    if (!verify.found || !verify.value.equals(bytes)) {
      throw conflict('create lost a concurrent write');
    }
    return Object.freeze({ ...record, version: verify.version });
  };

  const scanPrefix = (prefix) => {
    const collected = [];
    let scan;
    for (;;) {
      const page = storage.list(namespace, { cursor: scan, limit: 1000 });
      for (const entry of page.keys) {
        if (!entry.key.startsWith(prefix)) continue;
        collected.push(entry);
      }
      if (!page.nextCursor) break;
      scan = page.nextCursor;
    }
    collected.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    return collected;
  };

  return Object.freeze({
    capabilities: storage.capabilities,
    namespace,

    /* --------------------------------------------------------------- tags */

    /** Create a tag. Names are unique case-insensitively (upstream parity). */
    createTag({ name } = {}) {
      const clean = assertName(name);
      const tagId = assertId(idFactory(), 'idFactory output');
      const now = clock.now();
      const record = { tag: TAG_RECORD, tagId, name: clean, createdAt: now, updatedAt: now };
      createRecord(nameKey(clean), { tag: TAG_RECORD, tagId, name: clean }); // name index first (uniqueness)
      try {
        return createRecord(tagKey(tagId), record);
      } catch (error) {
        throw error;
      }
    },

    getTag(tagId) {
      assertId(tagId, 'tagId');
      const { record, version } = readTag(tagId);
      return Object.freeze({ ...record, version });
    },

    /** Resolve a tag by name (case-insensitive). */
    getTagByName(name) {
      const clean = assertName(name);
      const index = readJson(nameKey(clean), TAG_RECORD, 'name index');
      if (!index) throw notFound('tag not found', { name: clean });
      return this.getTag(index.record.tagId);
    },

    listTags({ cursor = null, limit = 100 } = {}) {
      if (cursor !== null && (typeof cursor !== 'string' || cursor.length === 0 || cursor.length > 256)) {
        throw invalid('cursor must be an opaque token issued by a previous list call');
      }
      if (!Number.isInteger(limit) || limit <= 0) throw invalid('limit must be a positive integer');
      const rows = scanPrefix('t:')
        .map((entry) => {
          const found = readJson(entry.key, TAG_RECORD, 'tag');
          return found ? { ...found.record, version: entry.version } : null;
        })
        .filter(Boolean);
      const after = cursor === null ? rows : rows.filter((r) => tagKey(r.tagId) > cursor);
      const items = after.slice(0, limit);
      const last = items[items.length - 1];
      return Object.freeze({
        tags: Object.freeze(items),
        nextCursor: after.length > items.length && last ? tagKey(last.tagId) : null,
      });
    },

    /**
     * Delete a tag: tag + name index + ALL its attachments removed in ONE
     * all-or-nothing batch (no dangling attachments). Pure CAS.
     */
    deleteTag(tagId, { version } = {}) {
      assertId(tagId, 'tagId');
      if (typeof version !== 'string' || version.length === 0) {
        throw invalid('a CAS version token is required for this update');
      }
      const { record } = readTag(tagId);
      const attachments = scanPrefix('a:').filter((entry) => entry.key.endsWith(`:${tagId}`));
      const ops = [
        { type: 'delete', namespace, key: tagKey(tagId), expectedVersion: version },
        { type: 'delete', namespace, key: nameKey(record.name) },
        ...attachments.map((entry) => ({ type: 'delete', namespace, key: entry.key, expectedVersion: entry.version })),
      ];
      const result = storage.applyBatch(ops);
      if (!result.applied) {
        throw conflict('tag delete lost a concurrent update (all-or-nothing batch aborted)', {
          failedOpIndex: result.failedOpIndex, reason: result.reason,
        });
      }
      return Object.freeze({ deleted: true, detached: attachments.length });
    },

    /* -------------------------------------------------------- attachments */

    /**
     * Attach a tag to an execution (idempotent): re-attach is a no-op RESULT,
     * never a duplicate record and never an error (upstream parity).
     */
    attachTag({ executionId, tagId } = {}) {
      assertId(executionId, 'executionId');
      assertId(tagId, 'tagId');
      if (executionLookup(executionId) === null || executionLookup(executionId) === undefined) {
        throw notFound('execution not found', { executionId: executionId.slice(0, 8) });
      }
      readTag(tagId);
      const existing = storage.get(namespace, attachKey(executionId, tagId));
      if (existing.found) {
        return Object.freeze({ attached: false, reason: 'already_attached' });
      }
      const record = {
        tag: ATTACH_RECORD, executionId, tagId, createdAt: clock.now(),
      };
      createRecord(attachKey(executionId, tagId), record);
      return Object.freeze({ attached: true });
    },

    /** Detach a tag from an execution (idempotent): absent link -> {detached:false}. */
    detachTag({ executionId, tagId } = {}) {
      assertId(executionId, 'executionId');
      assertId(tagId, 'tagId');
      const result = storage.delete(namespace, attachKey(executionId, tagId));
      return Object.freeze({ detached: Boolean(result.deleted) });
    },

    /** Attachments of one execution (stable key order). */
    listAttachments({ executionId, cursor = null, limit = 100 } = {}) {
      assertId(executionId, 'executionId');
      if (cursor !== null && (typeof cursor !== 'string' || cursor.length === 0 || cursor.length > 256)) {
        throw invalid('cursor must be an opaque token issued by a previous list call');
      }
      if (!Number.isInteger(limit) || limit <= 0) throw invalid('limit must be a positive integer');
      const rows = scanPrefix(`a:${executionId}:`)
        .map((entry) => {
          const found = readJson(entry.key, ATTACH_RECORD, 'attachment');
          return found ? { ...found.record, version: entry.version } : null;
        })
        .filter(Boolean);
      const after = cursor === null ? rows : rows.filter((r) => attachKey(r.executionId, r.tagId) > cursor);
      const items = after.slice(0, limit);
      const last = items[items.length - 1];
      return Object.freeze({
        attachments: Object.freeze(items),
        nextCursor: after.length > items.length && last ? attachKey(last.executionId, last.tagId) : null,
      });
    },

    /** Attachments of one tag (usage view; stable key order). */
    listByTag({ tagId, cursor = null, limit = 100 } = {}) {
      assertId(tagId, 'tagId');
      readTag(tagId);
      if (cursor !== null && (typeof cursor !== 'string' || cursor.length === 0 || cursor.length > 256)) {
        throw invalid('cursor must be an opaque token issued by a previous list call');
      }
      if (!Number.isInteger(limit) || limit <= 0) throw invalid('limit must be a positive integer');
      const rows = scanPrefix('a:')
        .filter((entry) => entry.key.endsWith(`:${tagId}`))
        .map((entry) => {
          const found = readJson(entry.key, ATTACH_RECORD, 'attachment');
          return found ? { ...found.record, version: entry.version } : null;
        })
        .filter(Boolean);
      const after = cursor === null ? rows : rows.filter((r) => attachKey(r.executionId, r.tagId) > cursor);
      const items = after.slice(0, limit);
      const last = items[items.length - 1];
      return Object.freeze({
        attachments: Object.freeze(items),
        nextCursor: after.length > items.length && last ? attachKey(last.executionId, last.tagId) : null,
      });
    },

    /**
     * Explicit orphan cleanup (never automatic): remove attachments whose
     * execution no longer exists. Deterministic key order; returns the count.
     */
    cleanupGarbage() {
      const removed = [];
      for (const entry of scanPrefix('a:')) {
        const found = readJson(entry.key, ATTACH_RECORD, 'attachment');
        if (!found) continue;
        const exists = executionLookup(found.record.executionId);
        if (exists === null || exists === undefined) {
          const result = storage.delete(namespace, entry.key);
          if (result.deleted) removed.push(entry.key);
        }
      }
      return Object.freeze({ removed: removed.length, keys: Object.freeze(removed) });
    },
  });
}

export const EXECUTION_TAG_MODEL_VERSION = 1;
