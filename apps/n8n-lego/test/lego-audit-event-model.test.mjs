/**
 * P5-M12 — audit backing model over the storage facade. Append-only history
 * with a query contract for /api/v1/audit (API routes stay gated upstream).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStorage } from '../src/lego/storage/contract.mjs';
import { createLocalStorage } from '../src/lego/storage/local-provider.mjs';
import { createTestClock } from '../src/lego/storage/conformance.mjs';
import {
  createAuditEventModel, AuditModelError, AUDIT_ERROR_CODES,
} from '../src/lego/audit-event-model.mjs';

const setup = (name) => {
  const clock = createTestClock();
  const provider = createLocalStorage({ clock });
  let n = 0;
  const idFactory = () => `evt-${String(++n).padStart(4, '0')}-id`;
  const namespace = `audit-${name.replace(/\W+/g, '_')}`;
  const hostA = createAuditEventModel(createStorage(provider), { clock, idFactory, namespace });
  const hostB = createAuditEventModel(createStorage(provider), { clock, idFactory, namespace });
  return { clock, hostA, hostB };
};

test('1. append stores an immutable event; record() generates ids', () => {
  const { hostA, clock } = setup('t1');
  const saved = hostA.append({
    eventId: 'e1', actor: 'alice', action: 'login', target: 'session:1', targetType: 'session',
    attestation: { kind: 'password', by: 'alice', digest: 'h1' },
    metadata: { ip: '10.0.0.1' },
  });
  assert.equal(saved.eventId, 'e1');
  assert.equal(saved.occurredAt, clock.now(), 'clock is injected and deterministic');
  assert.equal(saved.attestation.at, saved.occurredAt, 'attestation.at defaults to occurredAt');
  const read = hostA.get('e1');
  assert.equal(read.actor, 'alice');
  assert.equal(read.version, saved.version, 'read carries the opaque CAS version');

  const gen = hostA.record({ actor: 'bob', action: 'logout', target: 'session:1' });
  assert.equal(gen.eventId, 'evt-0001-id', 'injected idFactory is deterministic');
});

test('2. immutability: history cannot be overwritten and no mutation API exists', () => {
  const { hostA, hostB } = setup('t2');
  hostA.append({ eventId: 'e1', actor: 'a', action: 'x', target: 't' });
  assert.throws(
    () => hostA.append({ eventId: 'e1', actor: 'b', action: 'y', target: 't2' }),
    (e) => e instanceof AuditModelError && e.code === AUDIT_ERROR_CODES.CONFLICT,
  );
  assert.equal(hostA.get('e1').actor, 'a', 'first write survives');
  assert.throws(
    () => hostB.append({ eventId: 'e1', actor: 'z', action: 'z', target: 't' }),
    (e) => e.code === AUDIT_ERROR_CODES.CONFLICT,
    'a second host cannot rewrite shared history either',
  );
  const keys = Object.keys(hostA);
  assert.ok(!keys.includes('update') && !keys.includes('delete') && !keys.includes('remove'),
    `model must expose no mutation API, has: ${keys}`);
});

test('3. validation closes the error vocabulary', () => {
  const { hostA } = setup('t3');
  for (const bad of [
    { eventId: '', actor: 'a', action: 'x', target: 't' },
    { eventId: 'e', actor: 'a', action: 'x', target: 't', occurredAt: 'now' },
    { eventId: 'e', actor: '', action: 'x', target: 't' },
    { eventId: 'e', actor: 'a', action: 'x', target: 't', attestation: 'yes' },
    null,
  ]) {
    assert.throws(() => hostA.append(bad), (e) => e.code === AUDIT_ERROR_CODES.INVALID);
  }
  assert.throws(() => hostA.query({ limit: 0 }), (e) => e.code === AUDIT_ERROR_CODES.INVALID);
  assert.throws(() => hostA.query({ cursor: 'bogus' }), (e) => e.code === AUDIT_ERROR_CODES.INVALID);
  assert.throws(() => hostA.get(''), (e) => e.code === AUDIT_ERROR_CODES.INVALID);
});

test('4. query filters by actor / action / target / type / time window', () => {
  const { hostA } = setup('t4');
  hostA.append({ eventId: 'e1', actor: 'alice', action: 'login', target: 's1', targetType: 'session', occurredAt: 1000 });
  hostA.append({ eventId: 'e2', actor: 'bob', action: 'login', target: 's2', targetType: 'session', occurredAt: 2000 });
  hostA.append({ eventId: 'e3', actor: 'alice', action: 'delete', target: 'wf1', targetType: 'workflow', occurredAt: 3000 });
  assert.deepEqual(hostA.query({ actor: 'alice' }).items.map((e) => e.eventId), ['e1', 'e3']);
  assert.deepEqual(hostA.query({ action: 'login' }).items.map((e) => e.eventId), ['e1', 'e2']);
  assert.deepEqual(hostA.query({ target: 'wf1' }).items.map((e) => e.eventId), ['e3']);
  assert.deepEqual(hostA.query({ targetType: 'session' }).items.map((e) => e.eventId), ['e1', 'e2']);
  assert.deepEqual(hostA.query({ occurredFrom: 2000, occurredTo: 2999 }).items.map((e) => e.eventId), ['e2']);
});

test('5. stable ordering + stateless cursor paging across the full set', () => {
  const { hostA } = setup('t5');
  for (let i = 0; i < 7; i += 1) {
    hostA.append({ eventId: `e${i}`, actor: 'a', action: 'x', target: 't', occurredAt: 1000 + i * 10 });
  }
  const page1 = hostA.query({ limit: 3 });
  assert.deepEqual(page1.items.map((e) => e.eventId), ['e0', 'e1', 'e2']);
  assert.ok(page1.nextCursor);
  const page2 = hostA.query({ limit: 3, cursor: page1.nextCursor });
  assert.deepEqual(page2.items.map((e) => e.eventId), ['e3', 'e4', 'e5']);
  const page3 = hostA.query({ limit: 3, cursor: page2.nextCursor });
  assert.deepEqual(page3.items.map((e) => e.eventId), ['e6']);
  assert.equal(page3.nextCursor, null);
  assert.deepEqual(hostA.query({ limit: 100 }).items.map((e) => e.eventId),
    ['e0', 'e1', 'e2', 'e3', 'e4', 'e5', 'e6']);
});

test('6. multi-host: two models over one store share append-only history in stable order', () => {
  const { hostA, hostB } = setup('t6');
  hostA.append({ eventId: 'e1', actor: 'a', action: 'x', target: 't', occurredAt: 1000 });
  hostB.append({ eventId: 'e2', actor: 'b', action: 'y', target: 't', occurredAt: 2000 });
  assert.deepEqual(hostA.query({}).items.map((e) => e.eventId), ['e1', 'e2']);
  assert.deepEqual(hostB.query({}).items.map((e) => e.eventId), ['e1', 'e2']);
});

test('7. summarize aggregates by action and actor deterministically', () => {
  const { hostA } = setup('t7');
  hostA.append({ eventId: 'e1', actor: 'alice', action: 'login', target: 's1', occurredAt: 1000 });
  hostA.append({ eventId: 'e2', actor: 'alice', action: 'login', target: 's2', occurredAt: 2000 });
  hostA.append({ eventId: 'e3', actor: 'bob', action: 'logout', target: 's1', occurredAt: 3000 });
  assert.deepEqual(hostA.summarize(), {
    total: 3,
    byAction: { login: 2, logout: 1 },
    byActor: { alice: 2, bob: 1 },
  });
});

test('8. rollback = unmount: namespace isolation leaves history untouched but hidden', () => {
  const { hostA, clock } = setup('t8');
  hostA.append({ eventId: 'e1', actor: 'a', action: 'x', target: 't' });
  const other = createAuditEventModel(createStorage(createLocalStorage({ clock })), {
    clock,
    idFactory: () => 'other',
    namespace: 'audit_t8_v2',
  });
  assert.deepEqual(other.query({}).items, []);
  assert.deepEqual(hostA.query({}).items.map((e) => e.eventId), ['e1']);
});

test('9. determinism: identical inputs produce byte-identical stored events', () => {
  const clock = createTestClock();
  const idFactory = () => 'fixed';
  const payload = {
    eventId: 'e1', actor: 'a', action: 'x', target: 't', occurredAt: 42,
    attestation: { kind: 'sig', digest: 'h' },
  };
  const a = createAuditEventModel(createStorage(createLocalStorage({ clock })), { clock, idFactory, namespace: 'deta' });
  const b = createAuditEventModel(createStorage(createLocalStorage({ clock })), { clock, idFactory, namespace: 'detb' });
  const ra = a.append(payload);
  const rb = b.append(payload);
  assert.equal(JSON.stringify({ ...ra, version: null }), JSON.stringify({ ...rb, version: null }));
  assert.deepEqual(a.summarize(), b.summarize());
});
