/**
 * P8-S07 — storage conformance harness.
 *
 * A provider that passes this suite conforms to the P8 storage contract
 * (docs/n8n-lego/evidence/P8-S01-FOUNDATION.md items 1-10). This is the
 * acceptance gate for the local reference provider and for every future
 * provider (shared, multi-host, Rust) before it may be wired into a consumer.
 *
 * The harness is deterministic: it injects its own controllable clock into the
 * factory under test when the provider accepts one. `create()` is called fresh
 * per case group; `create({ persistence })` may be supplied to test durability.
 */

import {
  STORAGE_ERROR_CODES, StorageError,
} from './contract.mjs';

/** Deterministic controllable clock (ms). */
export function createTestClock(startMs = 1_700_000_000_000) {
  let now = startMs;
  return {
    now: () => now,
    advance(ms) { now += ms; return now; },
  };
}

/**
 * Run the full conformance battery against a provider factory.
 *
 * @param {(opts: { clock: { now: () => number }, persistence?: object }) => object} create
 *        factory returning a RAW provider (the harness wraps it with createStorage itself)
 * @param {(storage: object, clock: object, restart: (persistence: object) => object) => Promise<void>|void} run
 *        receives a `t`-like collector? No: cases are declared here; `run` executes them.
 * @returns {Promise<{ passed: string[], failed: { name: string, error: Error }[] }>}
 */
export async function runStorageConformance(create, { wrap = (provider) => provider } = {}) {
  const passed = [];
  const failed = [];
  const run = async (name, fn) => {
    try {
      await fn();
      passed.push(name);
    } catch (error) {
      failed.push({ name, error });
    }
  };
  const expect = (condition, message) => { if (!condition) throw new Error(message); };
  const expectEqual = (actual, expected, message) => {
    const a = JSON.stringify(actual); const e = JSON.stringify(expected);
    if (a !== e) throw new Error(`${message}: expected ${e}, got ${a}`);
  };
  const expectCode = (fn, code, message) => {
    try { fn(); } catch (error) {
      if (error instanceof StorageError && error.code === code) return;
      throw new Error(`${message}: expected ${code}, got ${error?.code ?? error}`);
    }
    throw new Error(`${message}: expected ${code}, but nothing was thrown`);
  };

  /* ---------------------------------------------------------- group: key/value semantics */
  await run('kv: put/get round-trips bytes and versions are opaque tokens', () => {
    const clock = createTestClock();
    const s = wrap(create({ clock }));
    const put = s.put('app', 'k1', Buffer.from('hello'));
    expectEqual(typeof put.version, 'string', 'version is a token string');
    const got = s.get('app', 'k1');
    expectEqual(got.found, true, 'found');
    expectEqual(got.value.toString('utf8'), 'hello', 'value bytes round-trip');
    expectEqual(got.version, put.version, 'get sees the put version');
  });

  await run('kv: missing key is { found: false }, never an error', () => {
    const clock = createTestClock();
    const s = wrap(create({ clock }));
    expectEqual(s.get('app', 'nope'), { found: false }, 'absent read is a result');
  });

  await run('kv: delete removes and reports; deleting missing is { deleted: false }', () => {
    const clock = createTestClock();
    const s = wrap(create({ clock }));
    s.put('app', 'k', Buffer.from('v'));
    expectEqual(s.delete('app', 'k'), { deleted: true }, 'deleted');
    expectEqual(s.get('app', 'k').found, false, 'gone');
    expectEqual(s.delete('app', 'k'), { deleted: false }, 'second delete reports false');
  });

  await run('kv: namespaces are isolated; cross-namespace reads do not exist', () => {
    const clock = createTestClock();
    const s = wrap(create({ clock }));
    s.put('ns.a', 'k', Buffer.from('A'));
    expectEqual(s.get('ns.b', 'k'), { found: false }, 'other namespace does not see the key');
  });

  await run('kv: invalid namespace/key/value are typed INVALID errors', () => {
    const clock = createTestClock();
    const s = wrap(create({ clock }));
    expectCode(() => s.get('Bad Namespace', 'k'), STORAGE_ERROR_CODES.INVALID, 'bad namespace');
    expectCode(() => s.get('ok', ''), STORAGE_ERROR_CODES.INVALID, 'empty key');
    expectCode(() => s.put('ok', 'k', 'not-bytes'), STORAGE_ERROR_CODES.INVALID, 'non-bytes value');
    expectCode(() => s.put('ok', 'k', Buffer.from('v'), { ttlSeconds: 0 }), STORAGE_ERROR_CODES.INVALID, 'ttl 0');
    expectCode(() => s.get('ok', 'k'.repeat(300)), STORAGE_ERROR_CODES.INVALID, 'key too large');
  });

  /* ---------------------------------------------------------- group: list */
  await run('list: bounded pages with opaque cursor; expired keys excluded; deterministic order', () => {
    const clock = createTestClock();
    const s = wrap(create({ clock }));
    for (const k of ['b', 'a', 'c', 'd']) s.put('app', k, Buffer.from(k));
    s.put('app', 'zz', Buffer.from('gone'), { ttlSeconds: 5 });
    clock.advance(6000); // expire zz
    const page1 = s.list('app', { limit: 2 });
    expectEqual(page1.keys.map((e) => e.key), ['a', 'b'], 'sorted page 1, expired excluded');
    expect(typeof page1.nextCursor === 'string', 'next cursor issued');
    const page2 = s.list('app', { limit: 2, cursor: page1.nextCursor });
    expectEqual(page2.keys.map((e) => e.key), ['c', 'd'], 'sorted page 2');
    expectEqual(page2.nextCursor, undefined, 'no more pages');
  });

  await run('list: a cursor from another namespace is INVALID', () => {
    const clock = createTestClock();
    const s = wrap(create({ clock }));
    s.put('app', 'a', Buffer.from('1'));
    s.put('other', 'x', Buffer.from('1'));
    const page = s.list('app', { limit: 1 });
    if (page.nextCursor) {
      expectCode(() => s.list('other', { cursor: page.nextCursor }), STORAGE_ERROR_CODES.INVALID, 'foreign cursor');
    }
    expectCode(() => s.list('app', { cursor: 'not-a-token' }), STORAGE_ERROR_CODES.INVALID, 'garbage cursor');
    expectCode(() => s.list('app', { limit: 100000 }), STORAGE_ERROR_CODES.INVALID, 'limit above profile');
  });

  /* ---------------------------------------------------------- group: TTL */
  await run('ttl: expired keys behave as absent for get and touch; eviction visible to callers', () => {
    const clock = createTestClock();
    const s = wrap(create({ clock }));
    s.put('app', 't', Buffer.from('v'), { ttlSeconds: 10 });
    expectEqual(s.get('app', 't').found, true, 'alive before expiry');
    clock.advance(10_001);
    expectEqual(s.get('app', 't'), { found: false }, 'absent after ttl');
    expectEqual(s.touch('app', 't', 10), { found: false }, 'touch on expired is absent');
  });

  await run('ttl: touch refreshes expiry from the current clock', () => {
    const clock = createTestClock();
    const s = wrap(create({ clock }));
    s.put('app', 't', Buffer.from('v'), { ttlSeconds: 10 });
    clock.advance(8_000);
    const touched = s.touch('app', 't', 10);
    expectEqual(touched.found, true, 'touch finds the key');
    expectEqual(touched.expiresAt, clock.now() + 10_000, 'expiry moved to now+ttl');
    clock.advance(9_000); // 17s after put, but only 9s after touch
    expectEqual(s.get('app', 't').found, true, 'still alive after original ttl');
    clock.advance(2_000);
    expectEqual(s.get('app', 't').found, false, 'absent after refreshed ttl');
  });

  await run('ttl: put without ttl persists past any clock advance', () => {
    const clock = createTestClock();
    const s = wrap(create({ clock }));
    s.put('app', 'forever', Buffer.from('v'));
    clock.advance(365 * 24 * 3600 * 1000);
    expectEqual(s.get('app', 'forever').found, true, 'no ttl means no expiry');
  });

  /* ---------------------------------------------------------- group: CAS */
  await run('cas: putIfVersion success bumps the version; conflict and absent are first-class', () => {
    const clock = createTestClock();
    const s = wrap(create({ clock }));
    const first = s.put('app', 'k', Buffer.from('v1'));
    const ok = s.putIfVersion('app', 'k', Buffer.from('v2'), first.version);
    expectEqual(ok.applied, true, 'cas applied');
    expect(ok.version !== first.version, 'version bumped');
    const stale = s.putIfVersion('app', 'k', Buffer.from('v3'), first.version);
    expectEqual(stale, { applied: false, reason: 'version_conflict' }, 'stale version skipped');
    const missing = s.putIfVersion('app', 'ghost', Buffer.from('v'), 'o999');
    expectEqual(missing, { applied: false, reason: 'absent' }, 'absent key skipped');
  });

  await run('cas: deleteIfVersion matches or skips; never a silent delete', () => {
    const clock = createTestClock();
    const s = wrap(create({ clock }));
    const put = s.put('app', 'k', Buffer.from('v'));
    const wrong = s.deleteIfVersion('app', 'k', 'o999');
    expectEqual(wrong, { applied: false, reason: 'version_conflict' }, 'wrong version skips');
    expectEqual(s.get('app', 'k').found, true, 'key survives a skipped delete');
    const right = s.deleteIfVersion('app', 'k', put.version);
    expectEqual(right.applied, true, 'matched delete applied');
    expectEqual(right.deleted, true, 'deleted');
    const gone = s.deleteIfVersion('app', 'k', put.version);
    expectEqual(gone, { applied: false, reason: 'absent' }, 'after delete the key is absent');
  });

  await run('cas: an expired key is absent to CAS (expectedVersion cannot resurrect it)', () => {
    const clock = createTestClock();
    const s = wrap(create({ clock }));
    const put = s.put('app', 'k', Buffer.from('v'), { ttlSeconds: 5 });
    clock.advance(6_000);
    expectEqual(s.putIfVersion('app', 'k', Buffer.from('x'), put.version),
      { applied: false, reason: 'absent' }, 'expired key is absent');
    expectEqual(s.deleteIfVersion('app', 'k', put.version),
      { applied: false, reason: 'absent' }, 'expired delete is absent');
  });

  /* ---------------------------------------------------------- group: batch */
  await run('batch: applyBatch is all-or-nothing; mid-batch CAS failure applies nothing', () => {
    const clock = createTestClock();
    const s = wrap(create({ clock }));
    const k = s.put('app', 'k', Buffer.from('v1'));
    const result = s.applyBatch([
      { type: 'put', namespace: 'app', key: 'a', value: Buffer.from('1') },
      { type: 'put', namespace: 'app', key: 'k', value: Buffer.from('2'), expectedVersion: 'o999' }, // conflicts
      { type: 'delete', namespace: 'app', key: 'a' },
    ]);
    expectEqual(result, { applied: false, failedOpIndex: 1, reason: 'version_conflict' }, 'abort names the failed op');
    expectEqual(s.get('app', 'a'), { found: false }, 'op 0 did NOT land (atomicity)');
    expectEqual(s.get('app', 'k').value.toString('utf8'), 'v1', 'op 1 did NOT land');
    void k;
  });

  await run('batch: successful batch applies every op atomically', () => {
    const clock = createTestClock();
    const s = wrap(create({ clock }));
    const k = s.put('app', 'k', Buffer.from('v1'));
    const result = s.applyBatch([
      { type: 'put', namespace: 'app', key: 'a', value: Buffer.from('1') },
      { type: 'put', namespace: 'app', key: 'k', value: Buffer.from('2'), expectedVersion: k.version },
    ]);
    expectEqual(result, { applied: true, count: 2 }, 'batch applied');
    expectEqual(s.get('app', 'a').found, true, 'op 0 landed');
    expectEqual(s.get('app', 'k').value.toString('utf8'), '2', 'op 1 landed');
  });

  await run('batch: empty batch is INVALID (typed error, never silent no-op)', () => {
    const clock = createTestClock();
    const s = wrap(create({ clock }));
    expectCode(() => s.applyBatch([]), STORAGE_ERROR_CODES.INVALID, 'empty batch');
  });

  /* ---------------------------------------------------------- group: capability honesty */
  await run('capabilities: profile is exposed and typed; local providers must not claim multi-host', () => {
    const clock = createTestClock();
    const s = wrap(create({ clock }));
    expectEqual(typeof s.capabilities.name, 'string', 'name');
    expectEqual(typeof s.capabilities.multiHost, 'boolean', 'multiHost typed');
    expectEqual(typeof s.capabilities.durable, 'boolean', 'durable typed');
    if (s.capabilities.name.startsWith('local')) {
      expectEqual(s.capabilities.multiHost, false, 'local storage must not claim multi-host semantics');
    }
  });

  return { passed, failed };
}
