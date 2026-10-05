/**
 * P5-M11 — Project / sharing backing model (P5-M10-A) over the P8 storage facade.
 *
 * Project records, membership/share records and share-role semantics persist
 * ONLY behind the storage facade handle (namespace `project-share`): no
 * provider imports, no memory-local state, no silent fallback. Multi-host
 * behaviour follows the storage contract - race-sensitive updates go through
 * CAS, and ownership transfer is one atomic applyBatch.
 *
 * API surface stays gated: this is the model layer only; routes mount later
 * (P5-M10) and unmount by dropping the resource mount (rollback).
 *
 * Rust-readiness: injected clock + idFactory, JSON records with `tag: 1`,
 * closed error model (PROJECT_INVALID / PROJECT_NOT_FOUND / PROJECT_CONFLICT,
 * STORAGE_* propagated untouched), deterministic given injected deps.
 *
 * Share-role vocabulary (closed): owner > editor > viewer. One owner per
 * project (invariant enforced by every mutation that can touch ownership).
 */

import { StorageError, STORAGE_ERROR_CODES } from './storage/contract.mjs';

export const PROJECT_ERROR_CODES = Object.freeze({
  INVALID: 'PROJECT_INVALID',
  NOT_FOUND: 'PROJECT_NOT_FOUND',
  CONFLICT: 'PROJECT_CONFLICT',
});

export class ProjectModelError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'ProjectModelError';
    this.code = code;
    this.details = options.details ?? {};
    if (!Object.values(PROJECT_ERROR_CODES).includes(code)) {
      throw new TypeError(`ProjectModelError: unknown code ${String(code)}`);
    }
  }
}

const invalid = (message, details) => new ProjectModelError(PROJECT_ERROR_CODES.INVALID, message, { details });
const notFound = (message, details) => new ProjectModelError(PROJECT_ERROR_CODES.NOT_FOUND, message, { details });
const conflict = (message, details) => new ProjectModelError(PROJECT_ERROR_CODES.CONFLICT, message, { details });

/** Closed share-role vocabulary with hierarchy (owner > editor > viewer). */
export const PROJECT_ROLES = Object.freeze(['owner', 'editor', 'viewer']);
const ROLE_RANK = Object.freeze({ owner: 3, editor: 2, viewer: 1 });

export const assertRole = (role) => {
  if (!PROJECT_ROLES.includes(role)) {
    throw invalid(`role must be one of ${PROJECT_ROLES.join('|')}`, { role: String(role).slice(0, 32) });
  }
  return role;
};

/** Role hierarchy helper (share-role semantics): roleAtLeast('editor', 'viewer') === true. */
export const roleAtLeast = (role, minimum) => ROLE_RANK[assertRole(role)] >= ROLE_RANK[assertRole(minimum)];

const RECORD_TAG = 1;

const projectKey = (projectId) => `p:${projectId}`;
const memberKey = (projectId, principal) => `m:${projectId}:${principal}`;

const assertProjectId = (projectId) => {
  if (typeof projectId !== 'string' || projectId.length < 6 || projectId.length > 128) {
    throw invalid('projectId must be an opaque string of 6..128 characters');
  }
  return projectId;
};

const assertPrincipal = (principal) => {
  if (typeof principal !== 'string' || principal.length === 0 || principal.length > 128) {
    throw invalid('principal must be a non-empty string of at most 128 characters');
  }
  return principal;
};

const assertName = (name) => {
  if (typeof name !== 'string' || name.trim().length === 0 || name.length > 200) {
    throw invalid('project name must be a non-empty string of at most 200 characters');
  }
  return name.trim();
};

/**
 * @param {object} storage storage facade handle - the ONLY persistence boundary
 * @param {object} options
 * @param {{ now: () => number }} options.clock REQUIRED deterministic clock (ms)
 * @param {() => string} options.idFactory REQUIRED opaque project id factory
 * @param {string} [options.namespace='project-share']
 */
export function createProjectSharingModel(storage, { clock, idFactory, namespace = 'project-share' } = {}) {
  if (!storage || typeof storage.get !== 'function' || typeof storage.putIfVersion !== 'function') {
    throw invalid('createProjectSharingModel requires a storage facade handle');
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
    if (record.tag !== RECORD_TAG) throw conflict(`${kind} record has an unsupported shape`);
    return { record, version: got.version };
  };

  const readProject = (projectId) => {
    const found = readJson(projectKey(projectId), 'project');
    if (!found) throw notFound('project not found', { projectId: projectId.slice(0, 8) });
    return found;
  };

  return Object.freeze({
    capabilities: storage.capabilities,

    /* ---------------------------------------------------------- projects */

    /** Create a project. The creator becomes the single owner. */
    createProject({ name, owner }) {
      const cleanName = assertName(name);
      assertPrincipal(owner);
      const projectId = idFactory();
      assertProjectId(projectId);
      const now = clock.now();
      const record = {
        tag: RECORD_TAG, projectId, name: cleanName, ownerId: owner, createdAt: now, archived: false,
      };
      storage.put(namespace, projectKey(projectId), Buffer.from(JSON.stringify(record), 'utf8'));
      storage.put(namespace, memberKey(projectId, owner), Buffer.from(JSON.stringify({
        tag: RECORD_TAG, projectId, principal: owner, role: 'owner', joinedAt: now,
      }), 'utf8'));
      return Object.freeze({ projectId, name: cleanName, ownerId: owner, createdAt: now, archived: false });
    },

    getProject(projectId) {
      assertProjectId(projectId);
      const { record, version } = readProject(projectId);
      return Object.freeze({ ...record, version });
    },

    /** Rename via CAS (race-sensitive). Pass the version from getProject(). */
    renameProject(projectId, name, { version }) {
      assertProjectId(projectId);
      const cleanName = assertName(name);
      if (typeof version !== 'string' || version.length === 0) throw invalid('rename requires the version token read by getProject()');
      const { record } = readProject(projectId);
      const next = { ...record, name: cleanName };
      const applied = storage.putIfVersion(namespace, projectKey(projectId), Buffer.from(JSON.stringify(next), 'utf8'), version);
      if (!applied.applied) throw conflict('rename lost a concurrent update', { reason: applied.reason });
      return Object.freeze({ ...next, version: applied.version });
    },

    /** Archive/restore via CAS. Archived projects refuse membership changes. */
    setArchived(projectId, archived, { version }) {
      assertProjectId(projectId);
      if (typeof archived !== 'boolean') throw invalid('archived must be a boolean');
      if (typeof version !== 'string' || version.length === 0) throw invalid('setArchived requires the version token read by getProject()');
      const { record } = readProject(projectId);
      const next = { ...record, archived };
      const applied = storage.putIfVersion(namespace, projectKey(projectId), Buffer.from(JSON.stringify(next), 'utf8'), version);
      if (!applied.applied) throw conflict('archive change lost a concurrent update', { reason: applied.reason });
      return Object.freeze({ ...next, version: applied.version });
    },

    /* ---------------------------------------------------------- membership / share roles */

    /** Add (or read back) a member with a share role. */
    addMember(projectId, principal, role) {
      assertProjectId(projectId);
      assertPrincipal(principal);
      assertRole(role);
      const { record: project } = readProject(projectId);
      if (project.archived) throw conflict('archived projects refuse membership changes', { projectId: projectId.slice(0, 8) });
      const existing = readJson(memberKey(projectId, principal), 'membership');
      if (existing) {
        if (role === 'owner') throw conflict('ownership transfer goes through transferOwnership()', { principal });
        return Object.freeze({ ...existing.record, version: existing.version });
      }
      if (role === 'owner') throw conflict('use transferOwnership() to make someone an owner', { principal });
      const record = {
        tag: RECORD_TAG, projectId, principal, role, joinedAt: clock.now(),
      };
      storage.put(namespace, memberKey(projectId, principal), Buffer.from(JSON.stringify(record), 'utf8'));
      return Object.freeze({ ...record, version: storage.get(namespace, memberKey(projectId, principal)).version });
    },

    getMember(projectId, principal) {
      assertProjectId(projectId);
      assertPrincipal(principal);
      const found = readJson(memberKey(projectId, principal), 'membership');
      if (!found) throw notFound('membership not found', { principal: principal.slice(0, 32) });
      return Object.freeze({ ...found.record, version: found.version });
    },

    /** Change a member's share role via CAS (race-sensitive). */
    changeMemberRole(projectId, principal, role, { version }) {
      assertProjectId(projectId);
      assertPrincipal(principal);
      assertRole(role);
      if (typeof version !== 'string' || version.length === 0) throw invalid('changeMemberRole requires the version token read by getMember()');
      const { record } = readJson(memberKey(projectId, principal), 'membership');
      if (!record) throw notFound('membership not found', { principal: principal.slice(0, 32) });
      if (role === 'owner' || record.role === 'owner') {
        throw conflict('ownership transfer goes through transferOwnership()', { principal });
      }
      const next = { ...record, role };
      const applied = storage.putIfVersion(namespace, memberKey(projectId, principal), Buffer.from(JSON.stringify(next), 'utf8'), version);
      if (!applied.applied) throw conflict('role change lost a concurrent update', { reason: applied.reason });
      return Object.freeze({ ...next, version: applied.version });
    },

    removeMember(projectId, principal) {
      assertProjectId(projectId);
      assertPrincipal(principal);
      const { record: project } = readProject(projectId);
      if (project.ownerId === principal) throw conflict('the owner cannot be removed; transfer ownership first', { principal });
      const result = storage.delete(namespace, memberKey(projectId, principal));
      return Object.freeze({ removed: result.deleted });
    },

    /** Bounded member listing (storage list semantics: stable key order, opaque cursor). */
    listMembers(projectId, { cursor, limit } = {}) {
      assertProjectId(projectId);
      const page = storage.list(namespace, { cursor, limit });
      const members = page.keys
        .filter((entry) => entry.key.startsWith(`m:${projectId}:`))
        .map((entry) => {
          const found = readJson(entry.key, 'membership');
          return found ? { ...found.record, version: entry.version } : null;
        })
        .filter(Boolean);
      return Object.freeze({ members, nextCursor: page.nextCursor });
    },

    /**
     * Bounded listing over projects (P5-M10: GET /projects needs a read verb;
     * every sibling model already exposes its list). Stable key order,
     * opaque cursor = project key of the last returned item.
     */
    listProjects({ cursor = null, limit = 100 } = {}) {
      if (cursor !== null && (typeof cursor !== 'string' || cursor.length === 0 || cursor.length > 256)) {
        throw invalid('cursor must be an opaque token issued by a previous list call');
      }
      if (!Number.isInteger(limit) || limit <= 0) throw invalid('limit must be a positive integer');
      const collected = [];
      let scan;
      for (;;) {
        const page = storage.list(namespace, { cursor: scan, limit: 1000 });
        for (const entry of page.keys) {
          if (!entry.key.startsWith('p:')) continue;
          const found = readJson(entry.key, 'project');
          if (found) collected.push({ ...found.record, version: entry.version });
        }
        if (!page.nextCursor) break;
        scan = page.nextCursor;
      }
      collected.sort((a, b) => (projectKey(a.projectId) < projectKey(b.projectId) ? -1 : 1));
      const after = cursor === null ? collected : collected.filter((r) => projectKey(r.projectId) > cursor);
      const items = after.slice(0, limit);
      const last = items[items.length - 1];
      return Object.freeze({
        projects: Object.freeze(items),
        nextCursor: after.length > items.length && last ? projectKey(last.projectId) : null,
      });
    },

    /**
     * Atomic ownership transfer (single-owner invariant): demote the current
     * owner, promote the new owner, and rewrite project.ownerId - all inside one
     * applyBatch, so a mid-batch conflict applies NOTHING (storage item 3).
     */
    transferOwnership(projectId, newOwner, { projectVersion, fromVersion, toVersion } = {}) {
      assertProjectId(projectId);
      assertPrincipal(newOwner);
      const { record: project, version: projectV } = readProject(projectId);
      const fromPrincipal = project.ownerId;
      if (fromPrincipal === newOwner) throw conflict('new owner is already the owner', { principal: newOwner });
      const from = readJson(memberKey(projectId, fromPrincipal), 'membership');
      const to = readJson(memberKey(projectId, newOwner), 'membership');
      if (!to) throw notFound('new owner must already be a member', { principal: newOwner });
      const now = clock.now();
      const result = storage.applyBatch([
        {
          type: 'put', namespace, key: projectKey(projectId),
          value: Buffer.from(JSON.stringify({ ...project, ownerId: newOwner }), 'utf8'),
          expectedVersion: projectVersion ?? projectV,
        },
        {
          type: 'put', namespace, key: memberKey(projectId, fromPrincipal),
          value: Buffer.from(JSON.stringify({ ...from.record, role: 'editor' }), 'utf8'),
          expectedVersion: fromVersion ?? from.version,
        },
        {
          type: 'put', namespace, key: memberKey(projectId, newOwner),
          value: Buffer.from(JSON.stringify({ ...to.record, role: 'owner', promotedAt: now }), 'utf8'),
          expectedVersion: toVersion ?? to.version,
        },
      ]);
      if (!result.applied) {
        throw conflict('ownership transfer lost a concurrent update', {
          failedOpIndex: result.failedOpIndex, reason: result.reason,
        });
      }
      return Object.freeze({ projectId, ownerId: newOwner, previousOwnerId: fromPrincipal });
    },
  });
}

export { StorageError, STORAGE_ERROR_CODES };
