/**
 * P5-M13 — source-control backing model over the storage facade:
 * repository/branch/changeset records with provider-neutral fields.
 * Round-trip + conflict semantics; API routes stay gated upstream.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStorage } from '../src/lego/storage/contract.mjs';
import { createLocalStorage } from '../src/lego/storage/local-provider.mjs';
import { createTestClock } from '../src/lego/storage/conformance.mjs';
import {
  createSourceControlModel, SourceControlModelError, SOURCE_ERROR_CODES, CHANGESET_STATES,
} from '../src/lego/source-control-model.mjs';

const setup = (name) => {
  const clock = createTestClock();
  const provider = createLocalStorage({ clock });
  let n = 0;
  const idFactory = () => `src-${String(++n).padStart(6, '0')}-id`;
  const namespace = `srcctl-${name.replace(/\W+/g, '_')}`;
  const hostA = createSourceControlModel(createStorage(provider), { clock, idFactory, namespace });
  const hostB = createSourceControlModel(createStorage(provider), { clock, idFactory, namespace });
  return { clock, hostA, hostB };
};

const seedRepo = (host) => host.createRepository({ name: 'n8n-rust', provider: 'github', defaultBranch: 'main' });

test('1. repository: create/get/rename/archive lifecycle through the facade only', () => {
  const { hostA } = setup('t1');
  const created = seedRepo(hostA);
  assert.equal(created.repoId, 'src-000001-id', 'injected idFactory is deterministic');
  assert.equal(created.name, 'n8n-rust');
  assert.equal(created.provider, 'github', 'provider-neutral field, free string');
  assert.equal(created.archived, false);

  const got = hostA.getRepository(created.repoId);
  assert.equal(typeof got.version, 'string', 'opaque version for CAS callers');

  const renamed = hostA.renameRepository(created.repoId, 'n8n-rust-4', { version: got.version });
  assert.equal(renamed.name, 'n8n-rust-4');
  assert.notEqual(renamed.version, got.version, 'rename bumps the version');

  const archived = hostA.archiveRepository(created.repoId, true, { version: renamed.version });
  assert.equal(archived.archived, true);
});

test('2. branch: create/get/moveBranchHead (pointer move is CAS)', () => {
  const { hostA } = setup('t2');
  const { repoId } = seedRepo(hostA);
  const branch = hostA.createBranch({ repoId, name: 'main', headChangesetId: 'src-000002-id' });
  assert.equal(branch.name, 'main');
  assert.equal(branch.headChangesetId, 'src-000002-id');

  const moved = hostA.moveBranchHead(repoId, branch.branchId, 'src-000099-id', { version: branch.version });
  assert.equal(moved.headChangesetId, 'src-000099-id');
  assert.notEqual(moved.version, branch.version);
  assert.equal(hostA.getBranch(repoId, branch.branchId).headChangesetId, 'src-000099-id');
});

test('3. changeset: create with parent lineage + closed state vocabulary', () => {
  const { hostA } = setup('t3');
  const { repoId } = seedRepo(hostA);
  const { branchId } = hostA.createBranch({ repoId, name: 'dev' });
  const cs = hostA.createChangeset({
    repoId, branchId, author: 'alice', message: 'feat: storage facade',
    parentIds: ['src-000001-id'], fileCount: 3,
  });
  assert.equal(cs.state, 'open');
  assert.deepEqual(cs.parentIds, ['src-000001-id']);
  assert.equal(cs.fileCount, 3);

  assert.deepEqual(CHANGESET_STATES, ['open', 'merged', 'closed']);
  const merged = hostA.setChangesetState(repoId, cs.changesetId, 'merged', { version: cs.version });
  assert.equal(merged.state, 'merged');
  assert.throws(() => hostA.setChangesetState(repoId, cs.changesetId, 'rebased'),
    (e) => e instanceof SourceControlModelError && e.code === SOURCE_ERROR_CODES.INVALID);
});

test('4. conflict semantics: stale CAS never silently wins', () => {
  const { hostA } = setup('t4');
  const created = seedRepo(hostA);
  const stale = created.version;
  hostA.renameRepository(created.repoId, 'first', { version: stale });
  assert.throws(() => hostA.renameRepository(created.repoId, 'second', { version: stale }),
    (e) => e.code === SOURCE_ERROR_CODES.CONFLICT, 'lost concurrent update is explicit');
  assert.equal(hostA.getRepository(created.repoId).name, 'first', 'the winning write survives');

  assert.throws(() => hostA.renameRepository('src-999999-id', 'x', { version: 'o1' }),
    (e) => e.code === SOURCE_ERROR_CODES.NOT_FOUND);
  assert.throws(() => hostA.renameRepository('bad', 'x'),
    (e) => e.code === SOURCE_ERROR_CODES.INVALID);
  assert.throws(() => hostA.renameRepository(created.repoId, 'x'),
    (e) => e.code === SOURCE_ERROR_CODES.INVALID, 'CAS updates require an explicit version');
});

test('5. round-trip: records survive the store byte-stable (get === create)', () => {
  const { hostA } = setup('t5');
  const created = seedRepo(hostA);
  const read = hostA.getRepository(created.repoId);
  const { version: _a, ...createdBody } = created;
  const { version: _b, ...readBody } = read;
  assert.deepEqual(readBody, createdBody);
  assert.equal(JSON.stringify(readBody), JSON.stringify(createdBody), 'byte-stable round-trip');
});

test('6. multi-host: shared store, consistent reads and cross-host conflicts', () => {
  const { hostA, hostB } = setup('t6');
  const { repoId } = hostA.createRepository({ name: 'shared', provider: 'local' });
  const seen = hostB.getRepository(repoId);
  assert.equal(seen.name, 'shared');

  const branch = hostB.createBranch({ repoId, name: 'main' });
  hostA.moveBranchHead(repoId, branch.branchId, 'src-000042-id', { version: branch.version });
  assert.throws(() => hostB.moveBranchHead(repoId, branch.branchId, 'src-000043-id', { version: branch.version }),
    (e) => e.code === SOURCE_ERROR_CODES.CONFLICT, 'cross-host lost update is explicit');
  assert.equal(hostB.getBranch(repoId, branch.branchId).headChangesetId, 'src-000042-id');
});

test('7. list surfaces: stable ordering + opaque cursor paging', () => {
  const { hostA } = setup('t7');
  const { repoId } = seedRepo(hostA);
  const ids = [];
  for (let i = 0; i < 3; i += 1) {
    ids.push(hostA.createBranch({ repoId, name: `br-${i}` }).branchId);
    hostA.createChangeset({ repoId, branchId: ids[i], author: 'a', message: `m-${i}` });
  }
  const page1 = hostA.listBranches(repoId, { limit: 2 });
  assert.equal(page1.branches.length, 2);
  assert.ok(page1.nextCursor);
  const page2 = hostA.listBranches(repoId, { limit: 2, cursor: page1.nextCursor });
  assert.equal(page2.branches.length, 1);
  assert.equal(page2.nextCursor ?? null, null);
  const all = hostA.listBranches(repoId, { limit: 100 });
  assert.deepEqual(all.branches.map((b) => b.name), ['br-0', 'br-1', 'br-2']);

  const forBranch = hostA.listChangesets(repoId, { branchId: ids[1], limit: 100 });
  assert.equal(forBranch.changesets.length, 1);
  assert.equal(forBranch.changesets[0].message, 'm-1');
});

test('8. rollback = unmount: namespace isolation leaves history untouched but hidden', () => {
  const { hostA, clock } = setup('t8');
  const { repoId } = seedRepo(hostA);
  const other = createSourceControlModel(createStorage(createLocalStorage({ clock })), {
    clock,
    idFactory: () => 'src-999999-id',
    namespace: 'srcctl_t8_v2',
  });
  assert.throws(() => other.getRepository(repoId),
    (e) => e.code === SOURCE_ERROR_CODES.NOT_FOUND);
  assert.equal(hostA.getRepository(repoId).name, 'n8n-rust', 'original history stays intact');
});

test('9. surface pin + determinism: closed model keys and stable serialization', () => {
  const { hostA } = setup('t9');
  assert.deepEqual(Object.keys(hostA).sort(), [
    'archiveRepository', 'capabilities', 'createBranch', 'createChangeset', 'createRepository',
    'getBranch', 'getRepository', 'getChangeset', 'listBranches', 'listChangesets',
    'moveBranchHead', 'namespace', 'renameRepository', 'setChangesetState',
  ].sort(), 'model surface is closed');

  const clock = createTestClock();
  const mk = (ns) => createSourceControlModel(createStorage(createLocalStorage({ clock })), {
    clock, idFactory: () => 'src-000001-id', namespace: ns,
  });
  const a = mk('deta').createRepository({ name: 'x', provider: 'p', defaultBranch: 'main' });
  const b = mk('detb').createRepository({ name: 'x', provider: 'p', defaultBranch: 'main' });
  const { version: _va, ...ba } = a;
  const { version: _vb, ...bb } = b;
  assert.equal(JSON.stringify(ba), JSON.stringify(bb), 'identical inputs, identical records');
});
