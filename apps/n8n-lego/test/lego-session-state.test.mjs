/**
 * P5-M05 — session state over the storage facade. Multi-host behaviour is
 * proven with two createSessionState instances (two logical hosts) sharing one
 * storage: no memory-local simulation anywhere in the path.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStorage } from '../src/lego/storage/contract.mjs';
import { createLocalStorage } from '../src/lego/storage/local-provider.mjs';
import { createTestClock } from '../src/lego/storage/conformance.mjs';
import { createSessionState, SessionStateError, SESSION_ERROR_CODES } from '../src/lego/session-state.mjs';

const setup = () => {
  const clock = createTestClock();
  const provider = createLocalStorage({ clock });
  const storage = createStorage(provider);
  let n = 0;
  const idFactory = () => `session-${String(++n).padStart(6, '0')}-token`;
  const hostA = createSessionState(storage, { clock, idFactory, defaultTtlSeconds: 60 });
  const hostB = createSessionState(createStorage(provider), { clock, idFactory, defaultTtlSeconds: 60 });
  return { clock, storage, hostA, hostB };
};

test('session: create/get/refresh/revoke lifecycle through the facade only', () => {
  const { clock, hostA } = setup();
  const created = hostA.create({ principal: 'user-1' });
  assert.equal(created.sessionId, 'session-000001-token', 'idFactory is injected and deterministic');
  assert.equal(created.expiresAt, clock.now() + 60_000, 'expiry = now + ttl');

  const got = hostA.get(created.sessionId);
  assert.equal(got.principal, 'user-1');
  assert.equal(typeof got.version, 'string', 'opaque version token for CAS callers');

  const refreshed = hostA.refresh(created.sessionId, { version: got.version, ttlSeconds: 30 });
  assert.equal(refreshed.expiresAt, clock.now() + 30_000);
  assert.notEqual(refreshed.version, got.version, 'refresh bumps the version');

  assert.deepEqual(hostA.revoke(created.sessionId), { revoked: true });
  assert.throws(() => hostA.get(created.sessionId),
    (e) => e instanceof SessionStateError && e.code === SESSION_ERROR_CODES.NOT_FOUND);
});

test('session: expiry is observed as NOT_FOUND (storage TTL is the session TTL)', () => {
  const { clock, hostA } = setup();
  const created = hostA.create({ principal: 'user-1', ttlSeconds: 10 });
  clock.advance(10_001);
  assert.throws(() => hostA.get(created.sessionId),
    (e) => e.code === SESSION_ERROR_CODES.NOT_FOUND, 'expired session is an explicit NOT_FOUND');
  assert.deepEqual(hostA.revoke(created.sessionId), { revoked: false }, 'revoke of an expired session is idempotent');
});

test('session: multi-host refresh race - exactly one winner, loser gets explicit CONFLICT', () => {
  const { hostA, hostB } = setup();
  const created = hostA.create({ principal: 'user-1' });
  const version = hostA.get(created.sessionId).version;
  // Both hosts read the same version and refresh concurrently (interleaved calls).
  const r1 = hostA.refresh(created.sessionId, { version });
  assert.throws(() => hostB.refresh(created.sessionId, { version }),
    (e) => e.code === SESSION_ERROR_CODES.CONFLICT && /lost a concurrent update/.test(e.message));
  assert.equal(typeof r1.version, 'string');
  // The loser recovers by re-reading (documented CAS pattern).
  const fresh = hostB.get(created.sessionId);
  assert.doesNotThrow(() => hostB.refresh(created.sessionId, { version: fresh.version }));
});

test('session: state kv with CAS - two hosts cannot silently overwrite each other', () => {
  const { hostA, hostB } = setup();
  const created = hostA.create({ principal: 'user-1' });
  const s = created.sessionId;

  const initial = hostA.setState(s, 'cart', ['a'], { version: null });
  assert.equal(typeof initial.version, 'string');
  assert.throws(() => hostB.setState(s, 'cart', ['b'], { version: null }),
    (e) => e.code === SESSION_ERROR_CODES.CONFLICT, 'create over an existing key needs the version');

  // Host A and host B both hold initial.version; exactly one update wins.
  const winner = hostA.setState(s, 'cart', ['a', 'x'], { version: initial.version });
  assert.throws(() => hostB.setState(s, 'cart', ['b'], { version: initial.version }),
    (e) => e.code === SESSION_ERROR_CODES.CONFLICT);
  assert.deepEqual(hostB.getState(s, 'cart').value, ['a', 'x'], 'loser observes the winner write (read-your-writes across hosts)');
  assert.equal(hostB.getState(s, 'cart').version, winner.version);
  assert.deepEqual(hostA.deleteState(s, 'cart'), { deleted: true });
  assert.deepEqual(hostA.getState(s, 'cart'), { found: false });
});

test('session: counter increments never lose updates across two hosts (CAS)', () => {
  const { hostA, hostB } = setup();
  const created = hostA.create({ principal: 'user-1' });
  const s = created.sessionId;
  // Interleaved increments from both hosts (each bumps through CAS retries).
  for (let i = 0; i < 25; i += 1) {
    hostA.incrementState(s, 'hits');
    hostB.incrementState(s, 'hits');
  }
  assert.equal(hostA.getState(s, 'hits').value, 50, 'exactly 50 increments landed');
});

test('session: errors are explicit - invalid inputs and unreadable state, no silent fallback', () => {
  const { hostA, storage, clock } = setup();
  assert.throws(() => createSessionState(storage, { clock }), (e) => e.code === SESSION_ERROR_CODES.INVALID, 'idFactory required');
  assert.throws(() => createSessionState(null, { clock, idFactory: () => 'x' }), (e) => e.code === SESSION_ERROR_CODES.INVALID);
  assert.throws(() => hostA.create({ principal: '' }), (e) => e.code === SESSION_ERROR_CODES.INVALID);
  assert.throws(() => hostA.get('short'), (e) => e.code === SESSION_ERROR_CODES.INVALID);
  assert.throws(() => hostA.refresh('session-000009-token', { version: '' }),
    (e) => e.code === SESSION_ERROR_CODES.INVALID, 'refresh requires the read version');
  const created = hostA.create({ principal: 'u' });
  assert.throws(() => hostA.refresh(created.sessionId, { version: 'o999' }),
    (e) => e.code === SESSION_ERROR_CODES.CONFLICT, 'a version the store never issued is an explicit CONFLICT');
});

test('session: storage failures propagate as STORAGE_* - never a memory fallback', () => {
  const clock = createTestClock();
  let explode = false;
  const persistence = { load: () => null, save: () => { if (explode) throw new Error('disk full'); } };
  const storage = createStorage(createLocalStorage({ clock, persistence }));
  const state = createSessionState(storage, { clock, idFactory: () => 'session-000001-token' });
  state.create({ principal: 'u' });
  explode = true;
  assert.throws(() => state.incrementState('session-000001-token', 'hits'),
    (e) => e.name === 'StorageError' && e.code === 'STORAGE_UNAVAILABLE', 'propagated, not swallowed');
  explode = false;
  assert.deepEqual(state.getState('session-000001-token', 'hits'), { found: false },
    'the failed increment left no partial state (rollback at the storage boundary)');
});

test('session: surface exposes no provider internals (consumer boundary)', () => {
  const { hostA } = setup();
  const surface = Object.keys(hostA).sort();
  assert.deepEqual(surface, [
    'capabilities', 'create', 'deleteState', 'get', 'getState', 'incrementState', 'refresh', 'revoke', 'setState',
  ]);
  assert.equal(hostA.capabilities.multiHost, false, 'local provider honesty flows through');
});

test('session: deterministic given the same clock/idFactory/storage', () => {
  const run = () => {
    const { hostA } = setup();
    const a = hostA.create({ principal: 'u', metadata: { ip: '10.0.0.1' } });
    return JSON.stringify([a, hostA.get(a.sessionId)]);
  };
  assert.equal(run(), run());
});
