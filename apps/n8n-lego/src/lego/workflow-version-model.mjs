/**
 * P5-M16 workflow-version backing model (P5-M10-F): immutable workflow version
 * records with parent links and diff metadata over the P8 storage facade. The
 * /api/v1/workflow-versions surface stays gated upstream; it mounts on this
 * model later.
 *
 * Record (closed shape):
 *   version {tag:1, versionId, workflowId, parentIds[], sequence, diff:{summary,
 *            added, removed, changed}, author, createdAt, metadata}
 *
 * Immutability contract (like the P5-M12 audit store):
 *   - version records are create-only (pre-check + put + read-back verify; a
 *     duplicate id is VERSION_CONFLICT);
 *   - the model exposes no mutation or deletion API at all (rollback = drop the
 *     model mount; history keys are never touched).
 *
 * Ancestry contract:
 *   - parent links form a DAG by construction: a new version may reference only
 *     ALREADY-EXISTING parents and can never reference itself;
 *   - `ancestors` / `descendants` walks are deterministic (ordered by
 *     (sequence, createdAt, versionId)) and defensive: a corrupted cycle in the
 *     store is refused explicitly (VERSION_CONFLICT) instead of looping;
 *   - unknown parents are refused at create time (VERSION_NOT_FOUND).
 *
 * Error set (closed): VERSION_INVALID | VERSION_NOT_FOUND | VERSION_CONFLICT.
 * Storage errors propagate unchanged.
 */

export const VERSION_ERROR_CODES = Object.freeze({
  INVALID: 'VERSION_INVALID',
  NOT_FOUND: 'VERSION_NOT_FOUND',
  CONFLICT: 'VERSION_CONFLICT',
});

export class WorkflowVersionModelError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'WorkflowVersionModelError';
    this.code = code;
    this.details = options.details ?? {};
    if (!Object.values(VERSION_ERROR_CODES).includes(code)) {
      throw new TypeError(`WorkflowVersionModelError: unknown code ${String(code)}`);
    }
  }
}

const invalid = (message, details) => new WorkflowVersionModelError(VERSION_ERROR_CODES.INVALID, message, { details });
const notFound = (message, details) => new WorkflowVersionModelError(VERSION_ERROR_CODES.NOT_FOUND, message, { details });
const conflict = (message, details) => new WorkflowVersionModelError(VERSION_ERROR_CODES.CONFLICT, message, { details });

const RECORD_TAG = 1;
const versionKey = (versionId) => `v:${versionId}`;

const assertId = (value, field) => {
  if (typeof value !== 'string' || value.length < 6 || value.length > 128) {
    throw invalid(`${field} must be an opaque string of 6..128 characters`);
  }
  return value;
};
const assertAuthor = (author) => {
  if (typeof author !== 'string' || author.length === 0 || author.length > 128) {
    throw invalid('author must be a non-empty string of at most 128 characters');
  }
  return author;
};

const compare = (a, b) =>
  (a.sequence - b.sequence)
  || (a.createdAt - b.createdAt)
  || (a.versionId < b.versionId ? -1 : a.versionId > b.versionId ? 1 : 0);

const assertDiff = (diff) => {
  if (diff === undefined || diff === null) return { summary: '', added: 0, removed: 0, changed: 0 };
  if (typeof diff !== 'object' || Array.isArray(diff)) throw invalid('diff must be an object');
  const count = (value) => (Number.isInteger(value) && value >= 0 ? value : 0);
  return {
    summary: typeof diff.summary === 'string' ? diff.summary.slice(0, 500) : '',
    added: count(diff.added),
    removed: count(diff.removed),
    changed: count(diff.changed),
  };
};

/**
 * @param {object} storage storage facade handle - the ONLY persistence boundary
 * @param {object} options
 * @param {{ now: () => number }} options.clock REQUIRED deterministic clock (ms)
 * @param {() => string} options.idFactory REQUIRED opaque id factory
 * @param {string} [options.namespace='workflow-versions']
 */
export function createWorkflowVersionModel(storage, { clock, idFactory, namespace = 'workflow-versions' } = {}) {
  if (!storage || typeof storage.get !== 'function' || typeof storage.putIfVersion !== 'function') {
    throw invalid('createWorkflowVersionModel requires a storage facade handle');
  }
  if (!clock || typeof clock.now !== 'function') throw invalid('an injected clock is required');
  if (typeof idFactory !== 'function') throw invalid('an injected idFactory is required');

  const readJson = (key) => {
    const got = storage.get(namespace, key);
    if (!got.found) return null;
    let record;
    try {
      record = JSON.parse(got.value.toString('utf8'));
    } catch (error) {
      throw conflict('version record is unreadable', { cause: error });
    }
    if (record.tag !== RECORD_TAG) throw conflict('version record has an unsupported shape');
    return { record, version: got.version };
  };

  const readVersion = (versionId) => {
    const found = readJson(versionKey(versionId));
    if (!found) throw notFound('version not found', { versionId: versionId.slice(0, 8) });
    return found;
  };

  const allVersions = () => {
    const collected = [];
    let scan;
    for (;;) {
      const page = storage.list(namespace, { cursor: scan, limit: 1000 });
      for (const entry of page.keys) {
        if (!entry.key.startsWith('v:')) continue;
        const found = readJson(entry.key);
        if (found) collected.push({ record: found.record, version: entry.version });
      }
      if (!page.nextCursor) break;
      scan = page.nextCursor;
    }
    return collected;
  };

  /** Defensive DAG walk: refuses a corrupted cycle explicitly instead of looping. */
  const walk = (startId, edgeOf) => {
    const seen = new Set([startId]);
    const out = [];
    let frontier = edgeOf(startId).filter((id) => {
      if (id === startId) throw conflict('cycle detected in version ancestry (self link)');
      return true;
    });
    while (frontier.length > 0) {
      const next = [];
      for (const id of frontier) {
        if (seen.has(id)) {
          if (id !== startId) continue;
          throw conflict('cycle detected in version ancestry');
        }
        seen.add(id);
        const { record } = readVersion(id);
        out.push(record);
        next.push(...edgeOf(record.versionId));
      }
      frontier = next;
    }
    return out.sort(compare);
  };

  return Object.freeze({
    capabilities: storage.capabilities,
    namespace,

    /** Create-only. Parent links must reference existing versions (DAG). */
    createVersion({ workflowId, parentIds = [], diff, author, metadata = null, versionId } = {}) {
      assertId(workflowId, 'workflowId');
      const id = versionId === undefined ? assertId(idFactory(), 'idFactory output') : assertId(versionId, 'versionId');
      const parents = parentIds.map((p) => assertId(p, 'parentId'));
      if (new Set(parents).size !== parents.length) {
        throw invalid('parentIds must be unique');
      }
      if (parents.includes(id)) {
        throw invalid('a version cannot be its own parent');
      }
      for (const parentId of parents) {
        readVersion(parentId); // unknown parent -> NOT_FOUND (explicit)
      }
      const maxSequence = allVersions()
        .filter((entry) => entry.record.workflowId === workflowId)
        .reduce((max, entry) => Math.max(max, entry.record.sequence), 0);
      const now = clock.now();
      const record = {
        tag: RECORD_TAG,
        versionId: id,
        workflowId,
        parentIds: parents,
        sequence: maxSequence + 1,
        diff: assertDiff(diff),
        author: assertAuthor(author),
        createdAt: now,
        metadata: metadata === undefined ? null : structuredClone(metadata),
      };
      const key = versionKey(id);
      if (storage.get(namespace, key).found) {
        throw conflict('version already exists (append-only)');
      }
      const bytes = Buffer.from(JSON.stringify(record), 'utf8');
      storage.put(namespace, key, bytes);
      const verify = storage.get(namespace, key);
      if (!verify.found || !verify.value.equals(bytes)) {
        throw conflict('version create lost a concurrent write');
      }
      return Object.freeze({ ...record, version: verify.version });
    },

    getVersion(versionId) {
      assertId(versionId, 'versionId');
      const { record, version } = readVersion(versionId);
      return Object.freeze({ ...record, version });
    },

    /** Deterministic ancestor list (oldest first), defensive against cycles. */
    ancestors(versionId) {
      assertId(versionId, 'versionId');
      readVersion(versionId);
      return Object.freeze(walk(versionId, (id) => readVersion(id).record.parentIds));
    },

    /** Deterministic descendant list (oldest first), defensive against cycles. */
    descendants(versionId) {
      assertId(versionId, 'versionId');
      readVersion(versionId);
      const childrenOf = (id) => allVersions()
        .filter((entry) => entry.record.parentIds.includes(id))
        .map((entry) => entry.record.versionId);
      return Object.freeze(walk(versionId, childrenOf));
    },

    /** Bounded listing (stable order, filter-aware cursor). */
    listVersions({ workflowId = null, cursor = null, limit = 100 } = {}) {
      if (cursor !== null) {
        try {
          assertId(String(cursor), 'cursor');
        } catch {
          throw invalid('cursor must be an opaque token issued by a previous list call');
        }
      }
      if (!Number.isInteger(limit) || limit <= 0) throw invalid('limit must be a positive integer');
      const rows = allVersions()
        .map((entry) => ({ ...entry.record, version: entry.version }))
        .filter((record) => (workflowId === null ? true : record.workflowId === workflowId))
        .sort((a, b) => compare(a, b));
      const after = cursor === null ? rows : rows.filter((r) => r.versionId > cursor);
      const items = after.slice(0, limit);
      const last = items[items.length - 1];
      return Object.freeze({
        versions: Object.freeze(items),
        nextCursor: after.length > items.length && last ? last.versionId : null,
      });
    },
  });
}

export const WORKFLOW_VERSION_MODEL_VERSION = 1;
