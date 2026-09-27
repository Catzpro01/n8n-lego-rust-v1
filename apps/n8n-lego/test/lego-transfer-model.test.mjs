/**
 * P5-M15 — workflow/credential transfer backing model over the storage facade:
 * versioned export bundles + transfer records. Bundle round-trip + secret-free
 * invariant; API routes stay gated upstream.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStorage } from '../src/lego/storage/contract.mjs';
import { createLocalStorage } from '../src/lego/storage/local-provider.mjs';
import { createTestClock } from '../src/lego/storage/conformance.mjs';
import {
  createTransferModel, TransferModelError, TRANSFER_ERROR_CODES, TRANSFER_STATES,
  TRANSFER_TRANSITIONS, BUNDLE_KINDS, FORBIDDEN_SECRET_KEYS, bundleDigestOf,
} from '../src/lego/transfer-model.mjs';

const MANIFEST = {
  items: [
    { itemType: 'workflow', itemId: 'wf-000001-id', name: 'Orders sync', digest: 'abc' },
    { itemType: 'credential-ref', itemId: 'cred-00001-id', name: 'Stripe', envelopeRef: 'env-000001-id' },
  ],
};

const setup = (name) => {
  const clock = createTestClock();
  const provider = createLocalStorage({ clock });
  let n = 0;
  const idFactory = () => `trf-${String(++n).padStart(6, '0')}-id`;
  const namespace = `trf-${name.replace(/\W+/g, '_')}`;
  const hostA = createTransferModel(createStorage(provider), { clock, idFactory, namespace });
  const hostB = createTransferModel(createStorage(provider), { clock, idFactory, namespace });
  return { clock, hostA, hostB };
};

const seedBundle = (host) => host.createBundle({
  kind: 'mixed', manifest: MANIFEST,
  payload: { workflows: [{ id: 'wf-000001-id', nodes: [{ name: 'http', parameters: { url: 'https://x' } }] }] },
});

test('1. bundle: create/get round-trip is byte-stable and versioned', () => {
  const { hostA } = setup('t1');
  const created = seedBundle(hostA);
  assert.equal(created.bundleId, 'trf-000001-id', 'injected idFactory is deterministic');
  assert.equal(created.kind, 'mixed');
  assert.equal(created.schemaVersion, 1);
  assert.deepEqual(BUNDLE_KINDS, ['workflow-export', 'credential-export', 'mixed']);

  const read = hostA.getBundle(created.bundleId);
  const { version: _a, ...body } = created;
  const { version: _b, ...readBody } = read;
  assert.equal(JSON.stringify(readBody), JSON.stringify(body), 'byte-stable round-trip');
  assert.throws(() => hostA.createBundle({ kind: 'zip', manifest: MANIFEST }),
    (e) => e instanceof TransferModelError && e.code === TRANSFER_ERROR_CODES.INVALID);
});

test('2. secret-free invariant: raw secrets refused at any depth', () => {
  const { hostA } = setup('t2');
  for (const [where, make] of [
    ['payload', () => hostA.createBundle({ kind: 'workflow-export', manifest: { items: [] }, payload: { nodes: [{ parameters: { password: 'hunter2' } }] } })],
    ['manifest item', () => hostA.createBundle({ kind: 'credential-export', manifest: { items: [{ itemType: 'workflow', itemId: 'wf-000001-id', apiKey: 'sk-live' }] } })],
    ['metadata', () => hostA.createBundle({ kind: 'workflow-export', manifest: { items: [] }, metadata: { token: 'ghp_x' } })],
    ['transfer metadata', () => {
      const { bundleId } = hostA.createBundle({ kind: 'workflow-export', manifest: { items: [] } });
      return hostA.createTransfer({ bundleId, fromPrincipal: 'a', toPrincipal: 'b', metadata: { clientSecret: 's3cr3t' } });
    }],
  ]) {
    assert.throws(make, (e) => e.code === TRANSFER_ERROR_CODES.INVALID, `${where} must be refused`);
  }
  assert.ok(FORBIDDEN_SECRET_KEYS.includes('password') && FORBIDDEN_SECRET_KEYS.includes('apikey'));

  // credential-ref discipline: envelopeRef REQUIRED, raw fields forbidden
  assert.throws(() => hostA.createBundle({
    kind: 'credential-export',
    manifest: { items: [{ itemType: 'credential-ref', itemId: 'cred-00001-id', name: 'X' }] },
  }), (e) => e.code === TRANSFER_ERROR_CODES.INVALID, 'credential-ref without envelopeRef refused');
  assert.throws(() => hostA.createBundle({
    kind: 'credential-export',
    manifest: { items: [{ itemType: 'credential-ref', itemId: 'cred-00001-id', envelopeRef: 'env-1', secret: 'raw' }] },
  }), (e) => e.code === TRANSFER_ERROR_CODES.INVALID, 'credential-ref carrying raw secret refused');
});

test('3. transfer lifecycle: created -> sealed -> completed; seal pins the bundle digest', () => {
  const { hostA } = setup('t3');
  const bundle = seedBundle(hostA);
  const created = hostA.createTransfer({
    bundleId: bundle.bundleId, fromPrincipal: 'alice', toPrincipal: 'bob',
  });
  assert.equal(created.state, 'created');
  assert.equal(created.bundleDigest, null);

  const sealed = hostA.sealTransfer(created.transferId, { version: created.version });
  assert.equal(sealed.state, 'sealed');
  assert.equal(sealed.bundleDigest,
    bundleDigestOf({ manifest: bundle.manifest, payload: bundle.payload, schemaVersion: bundle.schemaVersion }),
    'seal pins the deterministic bundle digest');

  const done = hostA.completeTransfer(created.transferId, { version: sealed.version });
  assert.equal(done.state, 'completed');
  assert.deepEqual(TRANSFER_STATES, ['created', 'sealed', 'completed', 'aborted']);
});

test('4. closed lifecycle: illegal transitions refused', () => {
  const { hostA } = setup('t4');
  const bundle = seedBundle(hostA);
  const t = hostA.createTransfer({ bundleId: bundle.bundleId, fromPrincipal: 'a', toPrincipal: 'b' });
  assert.throws(() => hostA.completeTransfer(t.transferId, { version: t.version }),
    (e) => e.code === TRANSFER_ERROR_CODES.INVALID, 'created -> completed is illegal');
  const sealed = hostA.sealTransfer(t.transferId, { version: t.version });
  const done = hostA.completeTransfer(t.transferId, { version: sealed.version });
  for (const target of ['sealed', 'completed', 'aborted']) {
    assert.throws(() => hostA[target === 'sealed' ? 'sealTransfer' : target === 'completed' ? 'completeTransfer' : 'abortTransfer'](
      t.transferId, { version: done.version }),
    (e) => e.code === TRANSFER_ERROR_CODES.INVALID, `completed -> ${target} is illegal`);
  }
  assert.deepEqual(TRANSFER_TRANSITIONS.completed, []);
  // created -> aborted is legal
  const t2 = hostA.createTransfer({ bundleId: bundle.bundleId, fromPrincipal: 'a', toPrincipal: 'b' });
  assert.equal(hostA.abortTransfer(t2.transferId, { version: t2.version }).state, 'aborted');
});

test('5. conflict semantics: stale CAS refused; version token REQUIRED', () => {
  const { hostA } = setup('t5');
  const bundle = seedBundle(hostA);
  const t = hostA.createTransfer({ bundleId: bundle.bundleId, fromPrincipal: 'a', toPrincipal: 'b' });
  const stale = t.version;
  hostA.sealTransfer(t.transferId, { version: stale });
  assert.throws(() => hostA.abortTransfer(t.transferId, { version: stale }),
    (e) => e.code === TRANSFER_ERROR_CODES.CONFLICT, 'stale token refused');
  assert.throws(() => hostA.abortTransfer(t.transferId),
    (e) => e.code === TRANSFER_ERROR_CODES.INVALID, 'token is REQUIRED (no fallback)');
  assert.throws(() => hostA.getTransfer('trf-999999-id'),
    (e) => e.code === TRANSFER_ERROR_CODES.NOT_FOUND);
});

test('6. multi-host: shared store, cross-host lifecycle conflicts are explicit', () => {
  const { hostA, hostB } = setup('t6');
  const bundle = hostA.createBundle({ kind: 'workflow-export', manifest: { items: [{ itemType: 'workflow', itemId: 'wf-000001-id' }] } });
  const t = hostB.createTransfer({ bundleId: bundle.bundleId, fromPrincipal: 'a', toPrincipal: 'b' });
  hostA.sealTransfer(t.transferId, { version: t.version });
  assert.throws(() => hostB.abortTransfer(t.transferId, { version: t.version }),
    (e) => e.code === TRANSFER_ERROR_CODES.CONFLICT, 'cross-host lost update is explicit');
  assert.equal(hostB.getTransfer(t.transferId).state, 'sealed');
});

test('7. lists: filter-aware cursor paging, stable order', () => {
  const { hostA } = setup('t7');
  for (let i = 0; i < 3; i += 1) {
    const b = hostA.createBundle({ kind: 'workflow-export', manifest: { items: [{ itemType: 'workflow', itemId: `wf-00000${i}-id` }] } });
    hostA.createTransfer({ bundleId: b.bundleId, fromPrincipal: 'a', toPrincipal: 'b' });
  }
  const p1 = hostA.listTransfers({ limit: 2 });
  assert.equal(p1.transfers.length, 2);
  assert.ok(p1.nextCursor);
  const p2 = hostA.listTransfers({ limit: 2, cursor: p1.nextCursor });
  assert.equal(p2.transfers.length, 1);
  assert.equal(p2.nextCursor, null);
  assert.equal(hostA.listBundles({ limit: 100 }).bundles.length, 3);
});

test('8. rollback = unmount: namespace isolation leaves history untouched but hidden', () => {
  const { hostA, clock } = setup('t8');
  const bundle = seedBundle(hostA);
  const other = createTransferModel(createStorage(createLocalStorage({ clock })), {
    clock,
    idFactory: () => 'trf-999999-id',
    namespace: 'trf_t8_v2',
  });
  assert.throws(() => other.getBundle(bundle.bundleId),
    (e) => e.code === TRANSFER_ERROR_CODES.NOT_FOUND);
  assert.equal(hostA.getBundle(bundle.bundleId).kind, 'mixed', 'original history stays intact');
});

test('9. surface pin + determinism: closed keys, stable digest and serialization', () => {
  const { hostA } = setup('t9');
  assert.deepEqual(Object.keys(hostA).sort(), [
    'abortTransfer', 'capabilities', 'completeTransfer', 'createBundle', 'createTransfer',
    'getBundle', 'getTransfer', 'listBundles', 'listTransfers', 'namespace', 'sealTransfer',
  ].sort(), 'model surface is closed');

  const clock = createTestClock();
  const mk = (ns) => createTransferModel(createStorage(createLocalStorage({ clock })), {
    clock, idFactory: () => 'trf-000001-id', namespace: ns,
  });
  const a = mk('deta').createBundle({ kind: 'workflow-export', manifest: { items: [{ itemType: 'workflow', itemId: 'wf-000001-id' }] } });
  const b = mk('detb').createBundle({ kind: 'workflow-export', manifest: { items: [{ itemType: 'workflow', itemId: 'wf-000001-id' }] } });
  const { version: _va, ...ba } = a;
  const { version: _vb, ...bb } = b;
  assert.equal(JSON.stringify(ba), JSON.stringify(bb), 'identical inputs, identical records');
  assert.equal(bundleDigestOf({ manifest: ba.manifest, payload: ba.payload, schemaVersion: 1 }),
    bundleDigestOf({ manifest: bb.manifest, payload: bb.payload, schemaVersion: 1 }), 'digest is deterministic');
});
