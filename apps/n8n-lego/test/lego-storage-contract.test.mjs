/**
 * P8-S01..S06 unit + boundary tests: facade validation parity, provider
 * isolation (consumers never see provider internals), durability/recovery
 * semantics, persistence fault behaviour, and the deterministic clock rule.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createStorage, StorageError, STORAGE_ERROR_CODES,
  assertNamespace, assertKey, assertBatchOps, assertProvider, assertCapabilityProfile,
  NAMESPACE_PATTERN, MAX_LIST_LIMIT,
} from '../src/lego/storage/contract.mjs';
import { createLocalStorage } from '../src/lego/storage/local-provider.mjs';
import { createTestClock } from '../src/lego/storage/conformance.mjs';

const memPersistence = () => {
  let saved = null;
  return {
    load: () => saved,
    save: (bytes) => { saved = Buffer.from(bytes); },
    read: () => saved,
  };
};

test('contract: namespace rules are closed and typed', () => {
  for (const ok of ['app', 'ns.a', 'session', 'rate-limit', 'a1.b2_c3-d4', 'x'.repeat(64)]) {
    assert.equal(assertNamespace(ok), ok);
  }
  for (const bad of ['', 'A', 'a b', '.lead', '-lead', 'x'.repeat(65), 'ünïcode', 'a/b', null, 42]) {
    assert.throws(() => assertNamespace(bad), (e) => e instanceof StorageError && e.code === STORAGE_ERROR_CODES.INVALID, String(bad));
  }
  assert.ok(NAMESPACE_PATTERN.test('p5.session'));
});

test('contract: key/value/ttl/version validation is identical across providers (facade-level)', () => {
  assert.throws(() => assertKey(''), /non-empty/);
  assert.throws(() => assertKey('k'.repeat(257)), (e) => e.code === STORAGE_ERROR_CODES.INVALID);
  assert.throws(() => createStorage(createLocalStorage({ clock: createTestClock() })).put('n', 'k', 'str'),
    (e) => e.code === STORAGE_ERROR_CODES.INVALID && /bytes/.test(e.message));
  assert.throws(() => assertBatchOps([{ type: 'nope', namespace: 'n', key: 'k' }]),
    (e) => e.code === STORAGE_ERROR_CODES.INVALID);
  assert.throws(() => assertBatchOps([{ type: 'put', namespace: 'n', key: 'k', value: 'x' }]),
    (e) => e.code === STORAGE_ERROR_CODES.INVALID, 'batch values must be bytes');
});

test('contract: facade enforces list bounds from the capability profile', () => {
  const s = createStorage(createLocalStorage({ clock: createTestClock() }));
  assert.equal(s.capabilities.maxListLimit, 1000);
  assert.throws(() => s.list('n', { limit: 0 }), (e) => e.code === STORAGE_ERROR_CODES.INVALID);
  assert.throws(() => s.list('n', { limit: MAX_LIST_LIMIT + 1 }), (e) => e.code === STORAGE_ERROR_CODES.INVALID);
  const page = s.list('n', { limit: 5 });
  assert.deepEqual(page.keys, []);
  assert.equal(page.nextCursor, undefined);
});

test('contract: a provider missing a method is refused at the boundary, not at first write', () => {
  const broken = createLocalStorage({ clock: createTestClock() });
  const { touch, ...mangled } = broken;
  void touch;
  assert.throws(() => createStorage(mangled), (e) => e.code === STORAGE_ERROR_CODES.INVALID && /touch/.test(e.message));
});

test('contract: an untyped provider failure becomes STORAGE_UNAVAILABLE, never a fake result', () => {
  const base = createLocalStorage({ clock: createTestClock() });
  const angry = Object.create(base, {
    get: { value: () => { throw new TypeError('raw provider explosion'); } },
  });
  const s = createStorage(angry);
  assert.throws(() => s.get('n', 'k'), (e) => e instanceof StorageError && e.code === STORAGE_ERROR_CODES.UNAVAILABLE
    && /raw provider explosion/.test(e.message));
});

test('provider: clock is REQUIRED (no hidden time dependency)', () => {
  assert.throws(() => createLocalStorage({}), (e) => e.code === STORAGE_ERROR_CODES.INVALID && /clock/.test(e.message));
});

test('provider: capability honesty - durable only with persistence; never multi-host locally', () => {
  const memoryOnly = createLocalStorage({ clock: createTestClock() });
  assert.equal(memoryOnly.capabilities.durable, false);
  assert.equal(memoryOnly.capabilities.multiHost, false);
  const durable = createLocalStorage({ clock: createTestClock(), persistence: memPersistence() });
  assert.equal(durable.capabilities.durable, true);
  assert.equal(durable.capabilities.multiHost, false);
  assert.throws(() => assertCapabilityProfile({ name: 'x', multiHost: 'yes', durable: true, maxListLimit: 10, maxValueBytes: 10 }),
    (e) => e.code === STORAGE_ERROR_CODES.INVALID);
});

test('recovery: acknowledged writes survive provider restart only when durable (persistence adapter)', () => {
  const persistence = memPersistence();
  const clock = createTestClock();
  const s1 = createStorage(createLocalStorage({ clock, persistence }));
  s1.put('app', 'k', Buffer.from('acknowledged'));
  s1.put('app', 'temp', Buffer.from('x'), { ttlSeconds: 5 });

  // Restart: new provider instance over the same persistence payload.
  const s2 = createStorage(createLocalStorage({ clock, persistence }));
  assert.equal(s2.get('app', 'k').value.toString('utf8'), 'acknowledged', 'acknowledged write visible after restart');
  clock.advance(6_000);
  const s3 = createStorage(createLocalStorage({ clock, persistence }));
  assert.equal(s3.get('app', 'temp').found, false, 'expired key stays expired across restart');
});

test('recovery: a memory-only provider promises nothing about restart (durable false)', () => {
  const clock = createTestClock();
  const s1 = createStorage(createLocalStorage({ clock }));
  s1.put('app', 'k', Buffer.from('v'));
  const s2 = createStorage(createLocalStorage({ clock }));
  assert.equal(s2.get('app', 'k').found, false, 'fresh instance starts empty; profile.durable=false is the promise');
});

test('failure: persistence save failure is UNAVAILABLE and leaves memory state unchanged (no partial write)', () => {
  const clock = createTestClock();
  let failSaves = false;
  const persistence = {
    load: () => null,
    save: () => { if (failSaves) throw new Error('disk full'); },
  };
  const provider = createLocalStorage({ clock, persistence });
  const s = createStorage(provider);
  s.put('app', 'k', Buffer.from('v1'));
  failSaves = true;
  assert.throws(() => s.put('app', 'k', Buffer.from('v2')), (e) => e.code === STORAGE_ERROR_CODES.UNAVAILABLE && /disk full/.test(e.message));
  failSaves = false;
  // The failed write must not be visible: rollback restored v1 (or absent), never a half-write.
  const got = s.get('app', 'k');
  assert.equal(got.value.toString('utf8'), 'v1', 'failed write rolled back');
});

test('failure: persistence save failure during applyBatch aborts the whole batch', () => {
  const clock = createTestClock();
  let failSaves = false;
  const persistence = {
    load: () => null,
    save: () => { if (failSaves) throw new Error('disk full'); },
  };
  const s = createStorage(createLocalStorage({ clock, persistence }));
  failSaves = true;
  assert.throws(() => s.applyBatch([{ type: 'put', namespace: 'app', key: 'a', value: Buffer.from('1') }]),
    (e) => e.code === STORAGE_ERROR_CODES.UNAVAILABLE);
  failSaves = false;
  assert.equal(s.get('app', 'a').found, false, 'no op from the failed batch is visible');
});

test('upgrade compatibility: persistence payload carries a version tag and is rejected when foreign', () => {
  const clock = createTestClock();
  let saved = Buffer.from(JSON.stringify({ v: 999, namespaces: {} }), 'utf8');
  const persistence = { load: () => saved, save: (b) => { saved = Buffer.from(b); } };
  assert.throws(() => createLocalStorage({ clock, persistence }).get('n', 'k'),
    (e) => e.code === STORAGE_ERROR_CODES.UNAVAILABLE && /unsupported shape/.test(e.message));
});

test('consumer boundary: the storage handle exposes only contract operations (no provider internals)', () => {
  const s = createStorage(createLocalStorage({ clock: createTestClock() }));
  const surface = Object.keys(s).sort();
  assert.deepEqual(surface, ['applyBatch', 'capabilities', 'delete', 'deleteIfVersion', 'get', 'list', 'put', 'putIfVersion', 'touch'].sort());
  assert.equal(typeof s.capabilities, 'object', 'capability profile travels with the handle');
});

test('assertProvider validates capabilities before any operation', () => {
  const provider = createLocalStorage({ clock: createTestClock() });
  const mangled = Object.create(provider, { capabilities: { value: { name: 'x' } } });
  assert.throws(() => assertProvider(mangled), (e) => e.code === STORAGE_ERROR_CODES.INVALID);
});
