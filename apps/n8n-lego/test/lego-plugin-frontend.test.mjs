/**
 * P2.27.10 — frontend plugin boundary.
 *
 * Proves: attachment routes are exactly Issue #83's two — public extension
 * points for trusted extensions, message boundaries for untrusted or
 * high-risk ones — DERIVED from trust (register cannot request a route and
 * unknown fields fail closed); a direct handle across a message boundary is
 * a contract violation; delivery validates before dispatch (invalid messages
 * never reach an extension) through the replay oracle's stableStringify;
 * boundary delivery sends a deep-frozen serialized copy while public
 * delivery hands the trusted caller the same object; detach/unreachable ids
 * fail closed with `lego.unavailable`; inspect stays metadata-only; and the
 * lock row (newest suite) pins the exact twelve-module surface at 0.10.0.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FRONTEND_ATTACHMENT_ROUTES,
  FRONTEND_MESSAGE_BOUNDS,
  resolveAttachmentRoute,
  assertFrontendMessage,
  createFrontendExtensionHost,
} from '../src/lego/plugin-frontend.mjs';
import { PluginRuntimeError } from '../src/lego/plugin-runtime.mjs';

const APP_ROOT = fileURLToPath(new URL('../', import.meta.url));

const violation = (fragment) => (error) =>
  error instanceof PluginRuntimeError && error.code === 'lego.contract_violation' && error.message.includes(fragment);

test('the routes are exactly #83\'s two, and trust/risk derive them fail-closed', () => {
  assert.deepEqual([...FRONTEND_ATTACHMENT_ROUTES], ['PUBLIC_EXTENSION_POINT', 'MESSAGE_BOUNDARY']);
  assert.ok(Object.isFrozen(FRONTEND_ATTACHMENT_ROUTES));
  assert.ok(Object.isFrozen(FRONTEND_MESSAGE_BOUNDS));
  assert.equal(resolveAttachmentRoute({ trustClass: 'CORE' }), 'PUBLIC_EXTENSION_POINT');
  assert.equal(resolveAttachmentRoute({ trustClass: 'TRUSTED' }), 'PUBLIC_EXTENSION_POINT');
  assert.equal(
    resolveAttachmentRoute({ trustClass: 'TRUSTED', highRisk: true }),
    'MESSAGE_BOUNDARY',
    'risk forces the boundary even for a trusted class'
  );
  assert.equal(resolveAttachmentRoute({ trustClass: 'ISOLATED', highRisk: false }), 'MESSAGE_BOUNDARY');
  assert.equal(resolveAttachmentRoute({ trustClass: 'SANDBOXED' }), 'MESSAGE_BOUNDARY');
  assert.equal(resolveAttachmentRoute({ trustClass: 'SANDBOXED', highRisk: true }), 'MESSAGE_BOUNDARY');
  assert.throws(() => resolveAttachmentRoute({}), violation('trustClass must be one of'));
  assert.throws(() => resolveAttachmentRoute({ trustClass: 'ADMIN' }), violation('trustClass must be one of'));
  assert.throws(() => resolveAttachmentRoute({ trustClass: 'TRUSTED', highRisk: 'yes' }), violation('highRisk must be a boolean'));
  assert.throws(() => resolveAttachmentRoute({ trustClass: 42 }), violation('trustClass must be one of'));
});

test('register derives the route — a request cannot name it, and unknown fields fail closed', () => {
  const host = createFrontendExtensionHost({ now: () => 7 });
  const receipt = host.register({
    id: 'nav-ext',
    trustClass: 'TRUSTED',
    extensionPoint: 'ui:nav:item',
    handler: () => {},
  });
  assert.equal(receipt.route, 'PUBLIC_EXTENSION_POINT');
  assert.deepEqual(receipt, {
    id: 'nav-ext',
    route: 'PUBLIC_EXTENSION_POINT',
    trustClass: 'TRUSTED',
    highRisk: false,
    extensionPoint: 'ui:nav:item',
  });
  assert.throws(
    () =>
      host.register({
        id: 'spoof',
        trustClass: 'SANDBOXED',
        route: 'PUBLIC_EXTENSION_POINT',
        handler: () => {},
      }),
    violation('the route is derived, never requested'),
    'asking for a route is not a way to get one'
  );
  assert.throws(
    () => host.register({ id: 'no-handler', trustClass: 'TRUSTED' }),
    violation('PUBLIC_EXTENSION_POINT requires a handler')
  );
  assert.throws(
    () => host.register({ id: 'nav-ext', trustClass: 'TRUSTED', handler: () => {} }),
    violation('already registered'),
    'duplicate id rejected'
  );
});

test('a direct handle across a message boundary is a violation; channels replace handlers', () => {
  const host = createFrontendExtensionHost();
  assert.throws(
    () => host.register({ id: 'sb', trustClass: 'SANDBOXED', handler: () => {} }),
    violation('MESSAGE_BOUNDARY forbids a direct handle')
  );
  assert.throws(
    () => host.register({ id: 'sb2', trustClass: 'SANDBOXED' }),
    violation('MESSAGE_BOUNDARY requires a channel')
  );
  assert.throws(
    () => host.register({ id: 'sb3', trustClass: 'SANDBOXED', channel: { send: 'not-a-function' } }),
    violation('MESSAGE_BOUNDARY requires a channel')
  );
  const ok = host.register({ id: 'sb4', trustClass: 'SANDBOXED', channel: { send: () => {} } });
  assert.equal(ok.route, 'MESSAGE_BOUNDARY');
  assert.throws(
    () => host.register({ id: 'risky', trustClass: 'TRUSTED', highRisk: true, handler: () => {} }),
    violation('MESSAGE_BOUNDARY forbids a direct handle'),
    'high-risk TRUSTED is still forced onto the boundary'
  );
  const risky = host.register({ id: 'risky2', trustClass: 'TRUSTED', highRisk: true, channel: { send: () => {} } });
  assert.equal(risky.route, 'MESSAGE_BOUNDARY');
  assert.throws(
    () => host.register({ id: 'pub-channel', trustClass: 'CORE', handler: () => {}, channel: { send: () => {} } }),
    violation('handler only'),
    'a public route never carries a side channel'
  );
  assert.equal(host.routeOf('sb4'), 'MESSAGE_BOUNDARY');
  assert.equal(host.routeOf('risky2'), 'MESSAGE_BOUNDARY');
});

test('public delivery hands the trusted caller the SAME object; boundary delivery sends a deep-frozen copy', () => {
  const host = createFrontendExtensionHost({ now: () => 42 });
  let receivedByPublic = null;
  host.register({ id: 'pub', trustClass: 'TRUSTED', extensionPoint: 'ui:settings:section', handler: (m) => (receivedByPublic = m) });
  const sent = { type: 'ui:render', payload: { items: [{ label: 'a' }] } };
  const receipt = host.deliver('pub', sent);
  assert.equal(receivedByPublic, sent, 'trusted in-process route keeps the direct reference (locality semantics)');
  assert.deepEqual({ id: receipt.id, route: receipt.route, delivered: receipt.delivered, at: receipt.at }, {
    id: 'pub',
    route: 'PUBLIC_EXTENSION_POINT',
    delivered: true,
    at: 42,
  });

  let receivedByBoundary = null;
  host.register({ id: 'bnd', trustClass: 'ISOLATED', channel: { send: (m) => (receivedByBoundary = m) } });
  const boundarySent = { type: 'ui:render', payload: { items: [{ label: 'a' }] }, requestId: 'r-1' };
  host.deliver('bnd', boundarySent);
  assert.notEqual(receivedByBoundary, boundarySent, 'no shared reference crosses the boundary');
  assert.deepEqual(receivedByBoundary, boundarySent, 'the copy is semantically identical');
  assert.ok(Object.isFrozen(receivedByBoundary) && Object.isFrozen(receivedByBoundary.payload));
  assert.ok(Object.isFrozen(receivedByBoundary.payload.items) && Object.isFrozen(receivedByBoundary.payload.items[0]));
  assert.throws(() => { receivedByBoundary.type = 'mutated'; }, TypeError, 'the copy is deep-frozen');
});

test('delivery validates before dispatch — invalid messages never reach an extension', () => {
  const host = createFrontendExtensionHost();
  let calls = 0;
  host.register({ id: 'pub', trustClass: 'TRUSTED', handler: () => { calls += 1; } });
  host.register({ id: 'bnd', trustClass: 'SANDBOXED', channel: { send: () => { calls += 1; } } });

  const cyclic = { type: 'x' };
  cyclic.self = cyclic;
  for (const bad of [
    null,
    'string',
    [],
    {},
    { payload: 1 },
    { type: '' },
    { type: 42 },
    { type: 'x'.repeat(FRONTEND_MESSAGE_BOUNDS.typeMaxLength + 1) },
    { type: 'x', surprise: true },
    { type: 'x', requestId: 7 },
    { type: 'x', requestId: 'y'.repeat(FRONTEND_MESSAGE_BOUNDS.requestIdMaxLength + 1) },
    { type: 'x', payload: { fn: () => {} } },
    cyclic,
  ]) {
    const label = typeof bad === 'object' && bad !== null ? `type=${String(bad.type)}` : String(bad);
    assert.throws(() => host.deliver('pub', bad), violation(''), `public rejects ${label}`);
    assert.throws(() => host.deliver('bnd', bad), violation(''), `boundary rejects ${label}`);
  }
  assert.equal(calls, 0, 'nothing was dispatched');
  assert.equal(assertFrontendMessage({ type: 'ok', payload: { n: 1.5 } }), true);
  assert.equal(assertFrontendMessage({ type: 'ok' }), true, 'payload is optional');
});

test('unknown or detached ids fail closed with lego.unavailable; inspect stays metadata-only', () => {
  const host = createFrontendExtensionHost();
  host.register({ id: 'x', trustClass: 'TRUSTED', extensionPoint: 'ui:nav:item', handler: () => {} });
  const listing = host.list();
  assert.equal(listing.length, 1);
  assert.deepEqual({ ...listing[0] }, {
    id: 'x',
    route: 'PUBLIC_EXTENSION_POINT',
    trustClass: 'TRUSTED',
    highRisk: false,
    extensionPoint: 'ui:nav:item',
  });
  assert.equal('handler' in listing[0], false, 'handlers never leak through inspect');
  assert.ok(Object.isFrozen(listing) && Object.isFrozen(listing[0]));
  assert.equal(host.routeOf('x'), 'PUBLIC_EXTENSION_POINT');
  assert.throws(
    () => host.deliver('ghost', { type: 'ping' }),
    (error) => error instanceof PluginRuntimeError && error.code === 'lego.unavailable'
  );
  assert.throws(
    () => host.routeOf('ghost'),
    (error) => error.code === 'lego.unavailable'
  );
  assert.deepEqual({ ...host.detach('x') }, { id: 'x', detached: true });
  assert.throws(
    () => host.deliver('x', { type: 'ping' }),
    (error) => error.code === 'lego.unavailable',
    'detached extensions are unreachable'
  );
  assert.throws(
    () => host.detach('x'),
    (error) => error.code === 'lego.unavailable'
  );
  assert.equal(host.list().length, 0);
});

test('the lock row (0.10.0) pins the exact twelve-module surface and export sets', () => {
  const lock = JSON.parse(readFileSync(join(APP_ROOT, 'src/lego/contracts/contract-lock.json'), 'utf8'));
  const row = lock.contracts.find((entry) => entry.id === 'lego.plugin-runtime');
  assert.equal(row.version, '0.10.0');
  assert.deepEqual(row.surface.slice().sort(), [
    'src/lego/plugin-failure.mjs',
    'src/lego/plugin-frontend.mjs',
    'src/lego/plugin-locality.mjs',
    'src/lego/plugin-manifest.mjs',
    'src/lego/plugin-policy.mjs',
    'src/lego/plugin-registry.mjs',
    'src/lego/plugin-replay.mjs',
    'src/lego/plugin-resources.mjs',
    'src/lego/plugin-runtime.mjs',
    'src/lego/plugin-secrets.mjs',
    'src/lego/plugin-supervisor.mjs',
    'src/lego/plugin-upgrade.mjs',
  ]);
  assert.ok(row.tests.includes('apps/n8n-lego/test/lego-plugin-frontend.test.mjs'));
  assert.ok(row.tests.includes('apps/n8n-lego/test/lego-plugin-upgrade.test.mjs'));
  for (const file of row.surface) {
    const source = readFileSync(join(APP_ROOT, file), 'utf8');
    const exported = [...source.matchAll(/^export (?:const|class|function) (\w+)/gm)].map((m) => m[1]).sort();
    const locked = [...(row.exports[file] ?? [])].sort();
    assert.deepEqual(locked, exported, `lock ⇄ module exports for ${file}`);
  }
});
