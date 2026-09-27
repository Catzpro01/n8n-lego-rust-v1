/**
 * P5-M18 — execution annotation/tag model over the store extension: AnnotationTag
 * entities + attach/detach on executions (upstream parity). Tag lifecycle +
 * orphan cleanup; API routes stay gated upstream.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStorage } from '../src/lego/storage/contract.mjs';
import { createLocalStorage } from '../src/lego/storage/local-provider.mjs';
import { createTestClock } from '../src/lego/storage/conformance.mjs';
import {
  createExecutionTagModel, ExecutionTagModelError, TAG_ERROR_CODES,
} from '../src/lego/execution-tag-model.mjs';

const setup = (name, executions = {}) => {
  const clock = createTestClock();
  const provider = createLocalStorage({ clock });
  let n = 0;
  const idFactory = () => `tag-${String(++n).padStart(6, '0')}-id`;
  const namespace = `tags-${name.replace(/\W+/g, '_')}`;
  const lookup = (id) => (Object.prototype.hasOwnProperty.call(executions, id) ? executions[id] : null);
  const hostA = createExecutionTagModel(createStorage(provider), { clock, idFactory, executionLookup: lookup, namespace });
  const hostB = createExecutionTagModel(createStorage(provider), { clock, idFactory, executionLookup: lookup, namespace });
  return { clock, hostA, hostB, provider, namespace };
};

const EXECS = { 'exec-000001-id': { state: 'succeeded' }, 'exec-000002-id': { state: 'failed' } };

test('1. tag lifecycle: create/get/resolve by name; names unique case-insensitively (upstream parity)', () => {
  const { hostA } = setup('t1', EXECS);
  const created = hostA.createTag({ name: '  Production  ' });
  assert.equal(created.tagId, 'tag-000001-id', 'injected idFactory is deterministic');
  assert.equal(created.name, 'Production', 'name trimmed');
  assert.equal(hostA.getTag(created.tagId).name, 'Production');
  assert.equal(hostA.getTagByName('production').tagId, created.tagId, 'name lookup is case-insensitive');

  for (const dup of ['Production', 'production', '  PRODUCTION  ']) {
    assert.throws(() => hostA.createTag({ name: dup }),
      (e) => e instanceof ExecutionTagModelError && e.code === TAG_ERROR_CODES.CONFLICT,
      `duplicate name ${JSON.stringify(dup)} refused`);
  }
  assert.throws(() => hostA.getTagByName('ghost'),
    (e) => e.code === TAG_ERROR_CODES.NOT_FOUND);
  assert.throws(() => hostA.createTag({ name: '   ' }),
    (e) => e.code === TAG_ERROR_CODES.INVALID);
});

test('2. attach: idempotent (no duplicate record), bound to an existing execution', () => {
  const { hostA, provider, namespace } = setup('t2', EXECS);
  const tag = hostA.createTag({ name: 'bug' });
  const first = hostA.attachTag({ executionId: 'exec-000001-id', tagId: tag.tagId });
  assert.equal(first.attached, true);
  const again = hostA.attachTag({ executionId: 'exec-000001-id', tagId: tag.tagId });
  assert.deepEqual({ ...again }, { attached: false, reason: 'already_attached' }, 're-attach is a no-op result');

  const raw = createStorage(provider).list(namespace, { limit: 1000 });
  const attachKeys = raw.keys.filter((e) => e.key.startsWith('a:'));
  assert.equal(attachKeys.length, 1, 'exactly one attachment record exists');

  assert.throws(() => hostA.attachTag({ executionId: 'exec-999999-id', tagId: tag.tagId }),
    (e) => e.code === TAG_ERROR_CODES.NOT_FOUND, 'unknown execution refused');
  assert.throws(() => hostA.attachTag({ executionId: 'exec-000001-id', tagId: 'tag-999999-id' }),
    (e) => e.code === TAG_ERROR_CODES.NOT_FOUND, 'unknown tag refused');
});

test('3. detach: explicit removal, idempotent result', () => {
  const { hostA } = setup('t3', EXECS);
  const tag = hostA.createTag({ name: 'bug' });
  hostA.attachTag({ executionId: 'exec-000001-id', tagId: tag.tagId });
  assert.deepEqual({ ...hostA.detachTag({ executionId: 'exec-000001-id', tagId: tag.tagId }) }, { detached: true });
  assert.deepEqual({ ...hostA.detachTag({ executionId: 'exec-000001-id', tagId: tag.tagId }) }, { detached: false },
    'second detach is a no-op result');
  assert.equal(hostA.listAttachments({ executionId: 'exec-000001-id' }).attachments.length, 0);
});

test('4. views: listAttachments + listByTag (usage) with stable order and cursor paging', () => {
  const { hostA } = setup('t4', { ...EXECS, 'exec-000003-id': { state: 'succeeded' } });
  const tag = hostA.createTag({ name: 'bug' });
  for (let i = 1; i <= 3; i += 1) {
    hostA.attachTag({ executionId: `exec-00000${i}-id`, tagId: tag.tagId });
  }
  hostA.attachTag({ executionId: 'exec-000001-id', tagId: hostA.createTag({ name: 'feat' }).tagId });
  assert.equal(hostA.listByTag({ tagId: tag.tagId }).attachments.length, 3, 'usage view');
  assert.equal(hostA.listAttachments({ executionId: 'exec-000001-id' }).attachments.length, 2, 'per-execution view');
  const p1 = hostA.listByTag({ tagId: tag.tagId, limit: 2 });
  assert.equal(p1.attachments.length, 2);
  assert.ok(p1.nextCursor);
  const p2 = hostA.listByTag({ tagId: tag.tagId, limit: 2, cursor: p1.nextCursor });
  assert.equal(p2.attachments.length, 1);
  assert.equal(p2.nextCursor, null);
});

test('5. deleteTag: pure CAS, detaches everywhere in one batch (no dangling attachments)', () => {
  const { hostA, provider, namespace } = setup('t5', EXECS);
  const tag = hostA.createTag({ name: 'bug' });
  hostA.attachTag({ executionId: 'exec-000001-id', tagId: tag.tagId });
  hostA.attachTag({ executionId: 'exec-000002-id', tagId: tag.tagId });
  assert.throws(() => hostA.deleteTag(tag.tagId),
    (e) => e instanceof ExecutionTagModelError && e.code === TAG_ERROR_CODES.INVALID, 'version token REQUIRED');
  const stale = tag.version;
  hostA.createTag({ name: 'other' }); // unrelated write does not stale the token
  const deleted = hostA.deleteTag(tag.tagId, { version: stale });
  assert.deepEqual({ ...deleted }, { deleted: true, detached: 2 });
  assert.throws(() => hostA.getTag(tag.tagId), (e) => e.code === TAG_ERROR_CODES.NOT_FOUND);
  const raw = createStorage(provider).list(namespace, { limit: 1000 });
  assert.equal(raw.keys.filter((e) => e.key.startsWith(`a:`) && e.key.endsWith(`:${tag.tagId}`)).length, 0,
    'no dangling attachments');
  assert.throws(() => hostA.deleteTag(tag.tagId, { version: stale }),
    (e) => e.code === TAG_ERROR_CODES.NOT_FOUND, 'second delete on a gone tag is NOT_FOUND');
});

test('6. orphan cleanup: explicit, counted, deterministic; live attachments untouched', () => {
  const { hostA, provider, namespace } = setup('t6', EXECS);
  const tag = hostA.createTag({ name: 'bug' });
  hostA.attachTag({ executionId: 'exec-000001-id', tagId: tag.tagId });
  // simulate an execution disappearing behind the model
  const raw = createStorage(provider);
  raw.put(namespace, 'a:exec-000009-id:' + tag.tagId, Buffer.from(JSON.stringify({
    tag: 2, executionId: 'exec-000009-id', tagId: tag.tagId, createdAt: 1,
  })));
  assert.equal(hostA.listByTag({ tagId: tag.tagId }).attachments.length, 2);
  const cleaned = hostA.cleanupGarbage();
  assert.equal(cleaned.removed, 1, 'orphan counted');
  assert.deepEqual([...cleaned.keys], [`a:exec-000009-id:${tag.tagId}`]);
  assert.equal(hostA.listByTag({ tagId: tag.tagId }).attachments.length, 1, 'live attachment untouched');
  assert.deepEqual({ ...hostA.cleanupGarbage() }, { removed: 0, keys: [] }, 'idempotent second pass');
});

test('7. multi-host: shared state, idempotent attach across hosts; CAS conflicts explicit', () => {
  const { hostA, hostB } = setup('t7', EXECS);
  const tag = hostA.createTag({ name: 'bug' });
  assert.equal(hostB.attachTag({ executionId: 'exec-000001-id', tagId: tag.tagId }).attached, true);
  assert.equal(hostA.attachTag({ executionId: 'exec-000001-id', tagId: tag.tagId }).attached, false,
    'cross-host re-attach is a no-op, not an error');
  assert.throws(() => hostA.createTag({ name: 'bug' }),
    (e) => e.code === TAG_ERROR_CODES.CONFLICT, 'name index is shared across hosts while the tag is alive');
  hostB.deleteTag(tag.tagId, { version: tag.version });
  assert.throws(() => hostA.deleteTag(tag.tagId, { version: tag.version }),
    (e) => e.code === TAG_ERROR_CODES.NOT_FOUND, 'cross-host delete already gone');
  assert.equal(hostA.createTag({ name: 'bug' }).name, 'bug', 'deleteTag frees the name (upstream parity)');
});

test('8. rollback = unmount: namespace isolation leaves history untouched but hidden', () => {
  const { hostA, clock } = setup('t8', EXECS);
  const tag = hostA.createTag({ name: 'bug' });
  hostA.attachTag({ executionId: 'exec-000001-id', tagId: tag.tagId });
  const other = createExecutionTagModel(createStorage(createLocalStorage({ clock })), {
    clock,
    idFactory: () => 'tag-999999-id',
    executionLookup: (id) => EXECS[id] ?? null,
    namespace: 'tags_t8_v2',
  });
  assert.throws(() => other.getTag(tag.tagId), (e) => e.code === TAG_ERROR_CODES.NOT_FOUND);
  assert.equal(hostA.listByTag({ tagId: tag.tagId }).attachments.length, 1, 'original history stays intact');
});

test('9. surface pin + determinism: closed model keys and stable serialization', () => {
  const { hostA } = setup('t9', EXECS);
  assert.deepEqual(Object.keys(hostA).sort(), [
    'attachTag', 'capabilities', 'cleanupGarbage', 'createTag', 'deleteTag', 'detachTag',
    'getTag', 'getTagByName', 'listAttachments', 'listByTag', 'listTags', 'namespace',
  ].sort(), 'model surface is closed');

  const clock = createTestClock();
  const mk = (ns) => createExecutionTagModel(createStorage(createLocalStorage({ clock })), {
    clock,
    idFactory: () => 'tag-000001-id',
    executionLookup: (id) => EXECS[id] ?? null,
    namespace: ns,
  });
  const a = mk('deta').createTag({ name: 'Same' });
  const b = mk('detb').createTag({ name: 'Same' });
  assert.equal(JSON.stringify({ ...a }), JSON.stringify({ ...b }), 'identical inputs, identical records');
});
