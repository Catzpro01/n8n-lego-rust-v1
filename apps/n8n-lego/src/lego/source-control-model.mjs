/**
 * P5-M13 source-control backing model (P5-M10-C): repository / branch /
 * changeset records with provider-neutral fields over the P8 storage facade.
 * The /api/v1/source-control surface stays gated upstream; it mounts on this
 * model later.
 *
 * Records (provider-neutral, closed shapes):
 *   repository {tag, repoId, name, provider, defaultBranch, createdAt, archived, metadata}
 *   branch     {tag, branchId, repoId, name, headChangesetId, baseBranchId, createdAt, updatedAt, archived, metadata}
 *   changeset  {tag, changesetId, repoId, branchId, parentIds, author, message, fileCount, state, createdAt, metadata}
 *
 * Conflict semantics: race-sensitive updates (rename, branch head move,
 * changeset state transition, archive) are pure CAS against the opaque version
 * token; a lost concurrent update is SOURCE_CONFLICT - never a silent LWW.
 * Creates are unique-id (idFactory) with pre-check + put + read-back verify
 * (P8-S01 has no atomic create-if-absent; documented deviation).
 *
 * Rollback = unmount: the model exposes no destructive op; dropping the mount
 * leaves history keys untouched (namespace isolation).
 *
 * Error set (closed): SOURCE_INVALID | SOURCE_NOT_FOUND | SOURCE_CONFLICT.
 * Storage errors propagate unchanged.
 */

export const SOURCE_ERROR_CODES = Object.freeze({
  INVALID: 'SOURCE_INVALID',
  NOT_FOUND: 'SOURCE_NOT_FOUND',
  CONFLICT: 'SOURCE_CONFLICT',
});

export class SourceControlModelError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'SourceControlModelError';
    this.code = code;
    this.details = options.details ?? {};
    if (!Object.values(SOURCE_ERROR_CODES).includes(code)) {
      throw new TypeError(`SourceControlModelError: unknown code ${String(code)}`);
    }
  }
}

const invalid = (message, details) => new SourceControlModelError(SOURCE_ERROR_CODES.INVALID, message, { details });
const notFound = (message, details) => new SourceControlModelError(SOURCE_ERROR_CODES.NOT_FOUND, message, { details });
const conflict = (message, details) => new SourceControlModelError(SOURCE_ERROR_CODES.CONFLICT, message, { details });

const RECORD_TAGS = Object.freeze({ repository: 1, branch: 2, changeset: 3 });

const repoKey = (repoId) => `r:${repoId}`;
const branchKey = (repoId, branchId) => `b:${repoId}:${branchId}`;
const changesetKey = (repoId, changesetId) => `c:${repoId}:${changesetId}`;

const keyOf = (record) => (record.tag === 1
  ? `r:${record.repoId}`
  : record.tag === 2
    ? `b:${record.repoId}:${record.branchId}`
    : `c:${record.repoId}:${record.changesetId}`);

const assertId = (value, field) => {
  if (typeof value !== 'string' || value.length < 6 || value.length > 128) {
    throw invalid(`${field} must be an opaque string of 6..128 characters`);
  }
  return value;
};
const assertName = (value, field) => {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 200) {
    throw invalid(`${field} must be a non-empty name of at most 200 characters`);
  }
  return value.trim();
};
const assertOptionalString = (value, field) => {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length > 256) {
    throw invalid(`${field} must be a string of at most 256 characters`);
  }
  return value;
};

/** Closed changeset state vocabulary. */
export const CHANGESET_STATES = Object.freeze(['open', 'merged', 'closed']);
const assertState = (state) => {
  if (!CHANGESET_STATES.includes(state)) {
    throw invalid(`state must be one of ${CHANGESET_STATES.join('|')}`, { state: String(state).slice(0, 32) });
  }
  return state;
};

/**
 * @param {object} storage storage facade handle - the ONLY persistence boundary
 * @param {object} options
 * @param {{ now: () => number }} options.clock REQUIRED deterministic clock (ms)
 * @param {() => string} options.idFactory REQUIRED opaque id factory
 * @param {string} [options.namespace='source-control']
 */
export function createSourceControlModel(storage, { clock, idFactory, namespace = 'source-control' } = {}) {
  if (!storage || typeof storage.get !== 'function' || typeof storage.putIfVersion !== 'function') {
    throw invalid('createSourceControlModel requires a storage facade handle');
  }
  if (!clock || typeof clock.now !== 'function') throw invalid('an injected clock is required');
  if (typeof idFactory !== 'function') throw invalid('an injected idFactory is required');

  const readJson = (key, kind) => {
    const got = storage.get(namespace, key);
    if (!got.found) return null;
    let record;
    try {
      record = JSON.parse(got.value.toString('utf8'));
    } catch (error) {
      throw conflict(`${kind} record is unreadable`, { cause: error });
    }
    const tag = RECORD_TAGS[kind];
    if (record.tag !== tag) throw conflict(`${kind} record has an unsupported shape`);
    return { record, version: got.version };
  };

  const readRepo = (repoId) => {
    const found = readJson(repoKey(repoId), 'repository');
    if (!found) throw notFound('repository not found', { repoId: repoId.slice(0, 8) });
    return found;
  };
  const readBranch = (repoId, branchId) => {
    const found = readJson(branchKey(repoId, branchId), 'branch');
    if (!found) throw notFound('branch not found', { branchId: branchId.slice(0, 8) });
    return found;
  };
  const readChangeset = (repoId, changesetId) => {
    const found = readJson(changesetKey(repoId, changesetId), 'changeset');
    if (!found) throw notFound('changeset not found', { changesetId: changesetId.slice(0, 8) });
    return found;
  };

  /** Unique-id create: pre-check + put + read-back verify (P8 has no create-if-absent). */
  const createRecord = (key, record, kind) => {
    if (storage.get(namespace, key).found) throw conflict(`${kind} already exists`);
    const bytes = Buffer.from(JSON.stringify(record), 'utf8');
    storage.put(namespace, key, bytes);
    const verify = storage.get(namespace, key);
    if (!verify.found || !verify.value.equals(bytes)) {
      throw conflict(`${kind} create lost a concurrent write`);
    }
    return Object.freeze({ ...record, version: verify.version });
  };

  /** Pure CAS update: stale version is SOURCE_CONFLICT - never a silent LWW. */
  const casUpdate = (key, record, expectedVersion, kind) => {
    if (typeof expectedVersion !== 'string' || expectedVersion.length === 0) {
      throw invalid('a CAS version token is required for this update');
    }
    const applied = storage.putIfVersion(
      namespace, key, Buffer.from(JSON.stringify(record), 'utf8'), expectedVersion,
    );
    if (!applied.applied) {
      throw conflict(`${kind} update lost a concurrent update`, { reason: applied.reason });
    }
    return Object.freeze({ ...record, version: applied.version });
  };

  const listFiltered = ({ prefix, kind, cursor, limit, field, where = () => true }) => {
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
        const found = readJson(entry.key, kind);
        if (found && where(found.record)) collected.push({ ...found.record, version: entry.version });
      }
      if (!page.nextCursor) break;
      scan = page.nextCursor;
    }
    collected.sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0));
    const after = cursor === null ? collected : collected.filter((r) => keyOf(r) > cursor);
    const items = after.slice(0, limit);
    const last = items[items.length - 1];
    return Object.freeze({
      [field]: Object.freeze(items),
      nextCursor: after.length > items.length && last ? keyOf(last) : null,
    });
  };

  return Object.freeze({
    capabilities: storage.capabilities,
    namespace,

    /* ------------------------------------------------------- repositories */

    createRepository({ name, provider = 'unknown', defaultBranch = null, metadata = null } = {}) {
      const repoId = assertId(idFactory(), 'idFactory output');
      const now = clock.now();
      const record = {
        tag: RECORD_TAGS.repository,
        repoId,
        name: assertName(name, 'name'),
        provider: assertOptionalString(provider, 'provider') ?? 'unknown',
        defaultBranch: assertOptionalString(defaultBranch, 'defaultBranch'),
        createdAt: now,
        archived: false,
        metadata: metadata === undefined ? null : structuredClone(metadata),
      };
      return createRecord(repoKey(repoId), record, 'repository');
    },

    getRepository(repoId) {
      assertId(repoId, 'repoId');
      const { record, version } = readRepo(repoId);
      return Object.freeze({ ...record, version });
    },

    renameRepository(repoId, name, { version } = {}) {
      assertId(repoId, 'repoId');
      const { record } = readRepo(repoId);
      const next = { ...record, name: assertName(name, 'name') };
      return casUpdate(repoKey(repoId), next, version, 'repository');
    },

    archiveRepository(repoId, archived = true, { version } = {}) {
      assertId(repoId, 'repoId');
      const { record } = readRepo(repoId);
      const next = { ...record, archived: Boolean(archived) };
      return casUpdate(repoKey(repoId), next, version, 'repository');
    },

    /* ----------------------------------------------------------- branches */

    createBranch({ repoId, name, baseBranchId = null, headChangesetId = null, metadata = null } = {}) {
      assertId(repoId, 'repoId');
      readRepo(repoId);
      const branchId = assertId(idFactory(), 'idFactory output');
      const now = clock.now();
      const record = {
        tag: RECORD_TAGS.branch,
        branchId,
        repoId,
        name: assertName(name, 'name'),
        headChangesetId: assertOptionalString(headChangesetId, 'headChangesetId'),
        baseBranchId: assertOptionalString(baseBranchId, 'baseBranchId'),
        createdAt: now,
        updatedAt: now,
        archived: false,
        metadata: metadata === undefined ? null : structuredClone(metadata),
      };
      return createRecord(branchKey(repoId, branchId), record, 'branch');
    },

    getBranch(repoId, branchId) {
      assertId(repoId, 'repoId');
      assertId(branchId, 'branchId');
      const found = readJson(branchKey(repoId, branchId), 'branch');
      return found ? Object.freeze({ ...found.record, version: found.version }) : null;
    },

    /** Move the branch pointer (race-sensitive, CAS). */
    moveBranchHead(repoId, branchId, headChangesetId, { version } = {}) {
      assertId(repoId, 'repoId');
      assertId(branchId, 'branchId');
      assertId(headChangesetId, 'headChangesetId');
      const { record } = readBranch(repoId, branchId);
      const next = { ...record, headChangesetId, updatedAt: clock.now() };
      return casUpdate(branchKey(repoId, branchId), next, version, 'branch');
    },

    /* -------------------------------------------------------- changesets */

    createChangeset({ repoId, branchId, author, message, parentIds = [], fileCount = 0, metadata = null } = {}) {
      assertId(repoId, 'repoId');
      assertId(branchId, 'branchId');
      readRepo(repoId);
      readBranch(repoId, branchId);
      const changesetId = assertId(idFactory(), 'idFactory output');
      const now = clock.now();
      const record = {
        tag: RECORD_TAGS.changeset,
        changesetId,
        repoId,
        branchId,
        parentIds: [...parentIds],
        author: assertName(author, 'author'),
        message: assertName(message, 'message'),
        fileCount: Number.isInteger(fileCount) && fileCount >= 0 ? fileCount : 0,
        state: 'open',
        createdAt: now,
        metadata: metadata === undefined ? null : structuredClone(metadata),
      };
      return createRecord(changesetKey(repoId, changesetId), record, 'changeset');
    },

    getChangeset(repoId, changesetId) {
      assertId(repoId, 'repoId');
      assertId(changesetId, 'changesetId');
      const found = readJson(changesetKey(repoId, changesetId), 'changeset');
      return found ? Object.freeze({ ...found.record, version: found.version }) : null;
    },

    /** Changeset state transition (race-sensitive, CAS); vocabulary is closed. */
    setChangesetState(repoId, changesetId, state, { version } = {}) {
      assertId(repoId, 'repoId');
      assertId(changesetId, 'changesetId');
      assertState(state);
      const { record } = readChangeset(repoId, changesetId);
      const next = { ...record, state };
      return casUpdate(changesetKey(repoId, changesetId), next, version, 'changeset');
    },

    /* -------------------------------------------------------------- lists */

    /**
     * Bounded listing over repositories (P5-M10: /source-control/pull needs to
     * discover the connected repository). Stable key order, opaque cursor.
     */
    listRepositories({ cursor = null, limit = 100 } = {}) {
      return listFiltered({ prefix: 'r:', kind: 'repository', cursor, limit, field: 'repositories' });
    },

    /** Bounded listing over the filtered result set: stable key order, opaque
     *  cursor = key of the last returned item (stateless, filter-aware). */
    listBranches(repoId, { cursor = null, limit = 100 } = {}) {
      assertId(repoId, 'repoId');
      readRepo(repoId);
      return listFiltered({ prefix: `b:${repoId}:`, kind: 'branch', cursor, limit, field: 'branches' });
    },

    listChangesets(repoId, { branchId = null, cursor = null, limit = 100 } = {}) {
      assertId(repoId, 'repoId');
      readRepo(repoId);
      return listFiltered({
        prefix: `c:${repoId}:`, kind: 'changeset', cursor, limit, field: 'changesets',
        where: (record) => (branchId === null ? true : record.branchId === branchId),
      });
    },
  });
}

export const SOURCE_CONTROL_MODEL_VERSION = 1;
