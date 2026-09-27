/**
 * P5-M11 — project / sharing backing model over the storage facade. Two
 * logical hosts share one storage for the race cases; the model layer is the
 * only surface (API routes stay gated upstream).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStorage } from '../src/lego/storage/contract.mjs';
import { createLocalStorage } from '../src/lego/storage/local-provider.mjs';
import { createTestClock } from '../src/lego/storage/conformance.mjs';
import {
  createProjectSharingModel, ProjectModelError, PROJECT_ERROR_CODES,
  PROJECT_ROLES, roleAtLeast, assertRole,
} from '../src/lego/project-sharing-model.mjs';

const setup = () => {
  const clock = createTestClock();
  const provider = createLocalStorage({ clock });
  let n = 0;
  const idFactory = () => `project-${String(++n).padStart(6, '0')}-id`;
  const hostA = createProjectSharingModel(createStorage(provider), { clock, idFactory });
  const hostB = createProjectSharingModel(createStorage(provider), { clock, idFactory });
  return { clock, hostA, hostB };
};

test('project: create/get/rename/archive lifecycle through the facade only', () => {
  const { hostA } = setup();
  const created = hostA.createProject({ name: '  Growth  ', owner: 'user-1' });
  assert.equal(created.projectId, 'project-000001-id', 'injected idFactory is deterministic');
  assert.equal(created.name, 'Growth', 'name is trimmed');
  assert.equal(created.ownerId, 'user-1');
  assert.equal(created.archived, false);

  const got = hostA.getProject(created.projectId);
  assert.equal(typeof got.version, 'string', 'opaque version for CAS callers');

  const renamed = hostA.renameProject(created.projectId, 'Growth 2026', { version: got.version });
  assert.equal(renamed.name, 'Growth 2026');
  assert.notEqual(renamed.version, got.version, 'rename bumps the version');

  const archived = hostA.setArchived(created.projectId, true, { version: renamed.version });
  assert.equal(archived.archived, true);
  assert.throws(() => hostA.getProject('project-999999-id'),
    (e) => e instanceof ProjectModelError && e.code === PROJECT_ERROR_CODES.NOT_FOUND);
});

test('project: closed role vocabulary and hierarchy (share-role semantics)', () => {
  assert.deepEqual(PROJECT_ROLES, ['owner', 'editor', 'viewer']);
  assert.equal(roleAtLeast('owner', 'editor'), true);
  assert.equal(roleAtLeast('editor', 'owner'), false);
  assert.equal(roleAtLeast('viewer', 'viewer'), true);
  assert.throws(() => assertRole('admin'),
    (e) => e.code === PROJECT_ERROR_CODES.INVALID && /owner\|editor\|viewer/.test(e.message));
});

test('membership: add/get/changeRole/remove with one-owner invariant', () => {
  const { hostA } = setup();
  const { projectId } = hostA.createProject({ name: 'P', owner: 'user-1' });

  const viewer = hostA.addMember(projectId, 'user-2', 'viewer');
  assert.equal(viewer.role, 'viewer');
  assert.equal(hostA.getMember(projectId, 'user-2').role, 'viewer');

  const changed = hostA.changeMemberRole(projectId, 'user-2', 'editor', { version: viewer.version });
  assert.equal(changed.role, 'editor');

  assert.throws(() => hostA.changeMemberRole(projectId, 'user-1', 'viewer', { version: hostA.getMember(projectId, 'user-1').version }),
    (e) => e.code === PROJECT_ERROR_CODES.CONFLICT && /transferOwnership/.test(e.message), 'the owner role cannot be swapped casually');
  assert.throws(() => hostA.addMember(projectId, 'user-3', 'owner'),
    (e) => e.code === PROJECT_ERROR_CODES.CONFLICT && /transferOwnership/.test(e.message));
  assert.throws(() => hostA.removeMember(projectId, 'user-1'),
    (e) => e.code === PROJECT_ERROR_CODES.CONFLICT && /transfer/.test(e.message), 'the owner cannot be removed');

  assert.deepEqual(hostA.removeMember(projectId, 'user-2'), { removed: true });
  assert.throws(() => hostA.getMember(projectId, 'user-2'), (e) => e.code === PROJECT_ERROR_CODES.NOT_FOUND);
});

test('membership: archived projects refuse membership changes (explicit conflict)', () => {
  const { hostA } = setup();
  const { projectId } = hostA.createProject({ name: 'P', owner: 'user-1' });
  const v = hostA.getProject(projectId).version;
  hostA.setArchived(projectId, true, { version: v });
  assert.throws(() => hostA.addMember(projectId, 'user-2', 'viewer'),
    (e) => e.code === PROJECT_ERROR_CODES.CONFLICT && /archived/.test(e.message));
});

test('multi-host: concurrent role changes - exactly one winner, explicit CONFLICT for the loser', () => {
  const { hostA, hostB } = setup();
  const { projectId } = hostA.createProject({ name: 'P', owner: 'user-1' });
  const member = hostA.addMember(projectId, 'user-2', 'viewer');
  hostA.changeMemberRole(projectId, 'user-2', 'editor', { version: member.version });
  const seen = hostB.getMember(projectId, 'user-2');
  assert.equal(seen.role, 'editor', 'host B observes host A write (shared storage)');
  assert.throws(() => hostB.changeMemberRole(projectId, 'user-2', 'viewer', { version: member.version }),
    (e) => e.code === PROJECT_ERROR_CODES.CONFLICT, 'stale version loses explicitly');
  const fresh = hostB.getMember(projectId, 'user-2');
  assert.doesNotThrow(() => hostB.changeMemberRole(projectId, 'user-2', 'viewer', { version: fresh.version }));
  assert.equal(hostA.getMember(projectId, 'user-2').role, 'viewer');
});

test('transfer: ownership transfer is atomic all-or-nothing (applyBatch)', () => {
  const { hostA } = setup();
  const { projectId } = hostA.createProject({ name: 'P', owner: 'user-1' });
  hostA.addMember(projectId, 'user-2', 'viewer');

  const result = hostA.transferOwnership(projectId, 'user-2');
  assert.equal(result.ownerId, 'user-2');
  assert.equal(result.previousOwnerId, 'user-1');
  assert.equal(hostA.getProject(projectId).ownerId, 'user-2', 'project record updated');
  assert.equal(hostA.getMember(projectId, 'user-2').role, 'owner', 'promoted');
  assert.equal(hostA.getMember(projectId, 'user-1').role, 'editor', 'previous owner demoted to editor');

  assert.throws(() => hostA.transferOwnership(projectId, 'user-1', { fromVersion: 'o999' }),
    (e) => e.code === PROJECT_ERROR_CODES.CONFLICT && /lost a concurrent update/.test(e.message), 'stale batch aborts');
  // Nothing from the aborted transfer landed:
  assert.equal(hostA.getProject(projectId).ownerId, 'user-2');
  assert.equal(hostA.getMember(projectId, 'user-1').role, 'editor');

  assert.throws(() => hostA.transferOwnership(projectId, 'user-2'),
    (e) => e.code === PROJECT_ERROR_CODES.CONFLICT, 'same-owner transfer refused');
  assert.throws(() => hostA.transferOwnership(projectId, 'user-9'),
    (e) => e.code === PROJECT_ERROR_CODES.NOT_FOUND, 'non-member promotion refused');
});

test('list: members paginate with the storage cursor; invalid inputs are typed', () => {
  const { hostA } = setup();
  const { projectId } = hostA.createProject({ name: 'P', owner: 'user-1' });
  for (let i = 2; i <= 5; i += 1) hostA.addMember(projectId, `user-${i}`, 'viewer');
  const page = hostA.listMembers(projectId, { limit: 10 });
  assert.equal(page.members.length, 5);
  assert.deepEqual(page.members.map((m) => m.principal).sort(),
    ['user-1', 'user-2', 'user-3', 'user-4', 'user-5']);
  assert.throws(() => hostA.createProject({ name: '', owner: 'u' }), (e) => e.code === PROJECT_ERROR_CODES.INVALID);
  assert.throws(() => hostA.createProject({ name: 'P', owner: '' }), (e) => e.code === PROJECT_ERROR_CODES.INVALID);
  assert.throws(() => hostA.renameProject(projectId, 'x', {}), (e) => e.code === PROJECT_ERROR_CODES.INVALID);
  assert.throws(() => hostA.getMember(projectId, ''), (e) => e.code === PROJECT_ERROR_CODES.INVALID);
});

test('boundary: surface exposes no provider internals; storage failures propagate', () => {
  const { hostA } = setup();
  assert.deepEqual(Object.keys(hostA).sort(), [
    'addMember', 'capabilities', 'changeMemberRole', 'createProject', 'getMember', 'getProject',
    'listMembers', 'removeMember', 'renameProject', 'setArchived', 'transferOwnership',
  ]);
  const clock = createTestClock();
  let explode = false;
  const persistence = { load: () => null, save: () => { if (explode) throw new Error('disk full'); } };
  const model = createProjectSharingModel(createStorage(createLocalStorage({ clock, persistence })), {
    clock, idFactory: () => 'project-000001-id',
  });
  model.createProject({ name: 'P', owner: 'u' });
  explode = true;
  assert.throws(() => model.renameProject('project-000001-id', 'Q', { version: 'o1' }),
    (e) => e.name === 'StorageError' && e.code === 'STORAGE_UNAVAILABLE', 'propagated, never swallowed');
});

test('deterministic given the same clock/idFactory/storage', () => {
  const run = () => {
    const { hostA } = setup();
    const p = hostA.createProject({ name: 'P', owner: 'u' });
    hostA.addMember(p.projectId, 'v', 'viewer');
    return JSON.stringify([p, hostA.getProject(p.projectId), hostA.getMember(p.projectId, 'v')]);
  };
  assert.equal(run(), run());
});
