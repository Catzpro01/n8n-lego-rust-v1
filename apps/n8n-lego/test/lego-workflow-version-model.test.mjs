/**
 * P5-M16 — workflow-version backing model over the storage facade: immutable
 * version records with parent links and diff metadata. Immutability + ancestry;
 * API routes stay gated upstream.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStorage } from '../src/lego/storage/contract.mjs';
import { createLocalStorage } from '../src/lego/storage/local-provider.mjs';
import { createTestClock } from '../src/lego/storage/conformance.mjs';
import {
  createWorkflowVersionModel, WorkflowVersionModelError, VERSION_ERROR_CODES,
} from '../src/lego/workflow-version-model.mjs';

const setup = (name) => {
  const clock = createTestClock();
  const provider = createLocalStorage({ clock });
  let n = 0;
  const idFactory = () => `ver-${String(++n).padStart(6, '0')}-id`;
  const namespace = `wfver-${name.replace(/\W+/g, '_')}`;
  const hostA = createWorkflowVersionModel(createStorage(provider), { clock, idFactory, namespace });
  const hostB = createWorkflowVersionModel(createStorage(provider), { clock, idFactory, namespace });
  return { clock, hostA, hostB, provider, namespace };
};

test('1. create/get round-trip is byte-stable; diff metadata closed shape', () => {
  const { hostA } = setup('t1');
  const created = hostA.createVersion({
    workflowId: 'wf-000001-id', author: 'alice',
    diff: { summary: 'add http node', added: 1, removed: 0, changed: 2 },
  });
  assert.equal(created.versionId, 'ver-000001-id', 'injected idFactory is deterministic');
  assert.equal(created.sequence, 1);
  assert.deepEqual(created.parentIds, []);

  const read = hostA.getVersion(created.versionId);
  const { version: _a, ...body } = created;
  const { version: _b, ...readBody } = read;
  assert.equal(JSON.stringify(readBody), JSON.stringify(body), 'byte-stable round-trip');

  const v2 = hostA.createVersion({ workflowId: 'wf-000001-id', parentIds: [created.versionId], author: 'bob' });
  assert.equal(v2.sequence, 2, 'sequence is per-workflow and monotonic');
  assert.deepEqual(v2.diff, { summary: '', added: 0, removed: 0, changed: 0 }, 'absent diff reads zeros');
});

test('2. immutability: history cannot be overwritten and no mutation API exists', () => {
  const { hostA, hostB } = setup('t2');
  const created = hostA.createVersion({ workflowId: 'wf-000001-id', author: 'alice' });
  assert.throws(
    () => hostA.createVersion({ workflowId: 'wf-000001-id', author: 'mallory', versionId: created.versionId }),
    (e) => e instanceof WorkflowVersionModelError && e.code === VERSION_ERROR_CODES.CONFLICT,
  );
  assert.equal(hostA.getVersion(created.versionId).author, 'alice', 'first write survives');
  assert.throws(
    () => hostB.createVersion({ workflowId: 'wf-000001-id', author: 'mallory', versionId: created.versionId }),
    (e) => e.code === VERSION_ERROR_CODES.CONFLICT,
    'a second host cannot rewrite shared history either',
  );
  const keys = Object.keys(hostA);
  for (const forbidden of ['update', 'delete', 'remove', 'patch']) {
    assert.ok(!keys.includes(forbidden), `model must expose no mutation API, has: ${keys}`);
  }
});

test('3. ancestry: diamond DAG walks are deterministic (ancestors + descendants)', () => {
  const { hostA } = setup('t3');
  const a = hostA.createVersion({ workflowId: 'wf-000001-id', author: 'alice', versionId: 'ver-00000a-id' });
  const b = hostA.createVersion({ workflowId: 'wf-000001-id', parentIds: [a.versionId], author: 'alice', versionId: 'ver-00000b-id' });
  const c = hostA.createVersion({ workflowId: 'wf-000001-id', parentIds: [a.versionId], author: 'bob', versionId: 'ver-00000c-id' });
  const d = hostA.createVersion({ workflowId: 'wf-000001-id', parentIds: [b.versionId, c.versionId], author: 'bob', versionId: 'ver-00000d-id' });

  assert.deepEqual(hostA.ancestors(d.versionId).map((v) => v.versionId),
    [a.versionId, b.versionId, c.versionId], 'ancestors oldest-first, deterministic');
  assert.deepEqual(hostA.descendants(a.versionId).map((v) => v.versionId),
    [b.versionId, c.versionId, d.versionId], 'descendants oldest-first');
  assert.deepEqual(hostA.ancestors(a.versionId), []);
  assert.deepEqual(hostA.descendants(d.versionId), []);
});

test('4. ancestry integrity: self-parent refused; unknown parent refused; corrupted cycle refused on walk', () => {
  const { hostA, provider, namespace } = setup('t4');
  const a = hostA.createVersion({ workflowId: 'wf-000001-id', author: 'alice', versionId: 'ver-00000a-id' });
  assert.throws(() => hostA.createVersion({ workflowId: 'wf-000001-id', author: 'x', versionId: 'ver-00000b-id', parentIds: ['ver-00000b-id'] }),
    (e) => e.code === VERSION_ERROR_CODES.INVALID, 'self-parent refused');
  assert.throws(() => hostA.createVersion({ workflowId: 'wf-000001-id', author: 'x', parentIds: ['ver-999999-id'] }),
    (e) => e.code === VERSION_ERROR_CODES.NOT_FOUND, 'unknown parent refused');

  // simulate a corrupted store: raw-write a cycle the model would never create
  const raw = createStorage(provider);
  raw.put(namespace, 'v:ver-00000x-id', Buffer.from(JSON.stringify({
    tag: 1, versionId: 'ver-00000x-id', workflowId: 'wf-000001-id', parentIds: ['ver-00000y-id'],
    sequence: 90, diff: {}, author: 'corrupt', createdAt: 1,
  })));
  raw.put(namespace, 'v:ver-00000y-id', Buffer.from(JSON.stringify({
    tag: 1, versionId: 'ver-00000y-id', workflowId: 'wf-000001-id', parentIds: ['ver-00000x-id'],
    sequence: 91, diff: {}, author: 'corrupt', createdAt: 1,
  })));
  assert.throws(() => hostA.ancestors('ver-00000x-id'),
    (e) => e.code === VERSION_ERROR_CODES.CONFLICT, 'walk refuses a corrupted cycle explicitly');
  assert.ok(a);
});

test('5. validation closes the error vocabulary', () => {
  const { hostA } = setup('t5');
  for (const bad of [
    { workflowId: '', author: 'a' },
    { workflowId: 'wf-000001-id', author: '' },
    { workflowId: 'wf-000001-id', author: 'a', parentIds: ['ver-000001-id', 'ver-000001-id'] },
    { workflowId: 'wf-000001-id', author: 'a', diff: 'big' },
  ]) {
    assert.throws(() => hostA.createVersion(bad), (e) => e.code === VERSION_ERROR_CODES.INVALID);
  }
  assert.throws(() => hostA.getVersion(''), (e) => e.code === VERSION_ERROR_CODES.INVALID);
  assert.throws(() => hostA.listVersions({ limit: 0 }), (e) => e.code === VERSION_ERROR_CODES.INVALID);
  assert.throws(() => hostA.listVersions({ cursor: 'bogus' }), (e) => e.code === VERSION_ERROR_CODES.INVALID);
});

test('6. multi-host: shared immutable history and consistent ancestry across hosts', () => {
  const { hostA, hostB } = setup('t6');
  const a = hostA.createVersion({ workflowId: 'wf-000001-id', author: 'alice' });
  const b = hostB.createVersion({ workflowId: 'wf-000001-id', parentIds: [a.versionId], author: 'bob' });
  assert.deepEqual(hostA.ancestors(b.versionId).map((v) => v.versionId), [a.versionId]);
  assert.deepEqual(hostB.descendants(a.versionId).map((v) => v.versionId), [b.versionId]);
});

test('7. listVersions: workflow filter + filter-aware cursor paging, stable order', () => {
  const { hostA } = setup('t7');
  for (let i = 0; i < 5; i += 1) {
    hostA.createVersion({ workflowId: 'wf-000001-id', author: 'a', versionId: `ver-00000${i}-id` });
  }
  hostA.createVersion({ workflowId: 'wf-000002-id', author: 'a', versionId: 'ver-000009-id' });
  const all = hostA.listVersions({ workflowId: 'wf-000001-id', limit: 100 });
  assert.deepEqual(all.versions.map((v) => v.versionId),
    ['ver-000000-id', 'ver-000001-id', 'ver-000002-id', 'ver-000003-id', 'ver-000004-id']);
  const p1 = hostA.listVersions({ workflowId: 'wf-000001-id', limit: 2 });
  assert.equal(p1.versions.length, 2);
  assert.ok(p1.nextCursor);
  const p2 = hostA.listVersions({ workflowId: 'wf-000001-id', limit: 2, cursor: p1.nextCursor });
  assert.equal(p2.versions.length, 2);
  const p3 = hostA.listVersions({ workflowId: 'wf-000001-id', limit: 2, cursor: p2.nextCursor });
  assert.deepEqual(p3.versions.map((v) => v.versionId), ['ver-000004-id']);
  assert.equal(p3.nextCursor, null);
});

test('8. rollback = unmount: namespace isolation leaves history untouched but hidden', () => {
  const { hostA, clock } = setup('t8');
  const created = hostA.createVersion({ workflowId: 'wf-000001-id', author: 'alice' });
  const other = createWorkflowVersionModel(createStorage(createLocalStorage({ clock })), {
    clock,
    idFactory: () => 'ver-999999-id',
    namespace: 'wfver_t8_v2',
  });
  assert.throws(() => other.getVersion(created.versionId),
    (e) => e.code === VERSION_ERROR_CODES.NOT_FOUND);
  assert.equal(hostA.getVersion(created.versionId).author, 'alice', 'original history stays intact');
});

test('9. surface pin + determinism: closed model keys and stable serialization', () => {
  const { hostA } = setup('t9');
  assert.deepEqual(Object.keys(hostA).sort(), [
    'ancestors', 'capabilities', 'createVersion', 'descendants', 'getVersion', 'listVersions', 'namespace',
  ].sort(), 'model surface is closed');

  const clock = createTestClock();
  const mk = (ns) => createWorkflowVersionModel(createStorage(createLocalStorage({ clock })), {
    clock, idFactory: () => 'ver-000001-id', namespace: ns,
  });
  const a = mk('deta').createVersion({ workflowId: 'wf-000001-id', author: 'x', diff: { summary: 's', added: 1 } });
  const b = mk('detb').createVersion({ workflowId: 'wf-000001-id', author: 'x', diff: { summary: 's', added: 1 } });
  const { version: _va, ...ba } = a;
  const { version: _vb, ...bb } = b;
  assert.equal(JSON.stringify(ba), JSON.stringify(bb), 'identical inputs, identical records');
});
