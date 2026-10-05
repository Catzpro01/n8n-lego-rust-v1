/**
 * P2.27.5 — secret broker (scoped, short-lived, one operation).
 *
 * Proves §12 end to end: tokens (not material) cross the plugin boundary;
 * resolve happens exactly once for the declared operation; expiry, scope and
 * consumption failures use the published codes; the live map is bounded;
 * events never carry token/material; no source ⇒ no standing material; and
 * the lock row (newest suite) pins the exact six-module surface.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLUGIN_SECRET_LIMITS, createSecretBroker } from '../src/lego/plugin-secrets.mjs';
import { PluginRuntimeError } from '../src/lego/plugin-runtime.mjs';

const APP_ROOT = fileURLToPath(new URL('../', import.meta.url));

const setup = (overrides = {}) => {
  let t = 1_000_000;
  const events = [];
  const broker = createSecretBroker({
    now: () => t,
    source: (operation, meta) => `material-for:${meta.pluginId}:${operation}`,
    onEvent: (type, detail) => events.push({ type, detail }),
    ...overrides,
  });
  return {
    broker,
    events,
    advance: (ms) => {
      t += ms;
    },
    now: () => t,
  };
};

test('limits are short-lived and bounded by construction', () => {
  assert.equal(PLUGIN_SECRET_LIMITS.defaultTtlMs, 30_000);
  assert.equal(PLUGIN_SECRET_LIMITS.maxTtlMs, 300_000);
  assert.equal(PLUGIN_SECRET_LIMITS.maxLive, 64);
  assert.ok(Object.isFrozen(PLUGIN_SECRET_LIMITS));
});

test('issue hands back a token — the plugin never sees material until the single resolve', () => {
  const { broker } = setup();
  const grant = broker.issue({ pluginId: 'pdf-exporter', operation: 'acme.pdf.render' });
  assert.ok(Object.isFrozen(grant));
  assert.match(grant.token, /^sk_/);
  assert.equal(grant.operation, 'acme.pdf.render');
  assert.equal('material' in grant, false, 'the issued grant carries no material');
  assert.equal(broker.liveCount(), 1);
  const [meta] = broker.inspect();
  assert.equal('token' in meta, false, 'inspect() is metadata only');
  assert.equal('material' in meta, false);
});

test('resolve returns material exactly once — a second call is unavailable (one operation)', () => {
  const { broker } = setup();
  const grant = broker.issue({ pluginId: 'pdf-exporter', operation: 'acme.pdf.render' });
  const material = broker.resolve(grant.token, 'acme.pdf.render');
  assert.equal(material, 'material-for:pdf-exporter:acme.pdf.render');
  assert.equal(broker.liveCount(), 0, 'consumed grants are deleted, not parked');
  assert.throws(
    () => broker.resolve(grant.token, 'acme.pdf.render'),
    (error) => error instanceof PluginRuntimeError && error.code === 'lego.unavailable',
  );
});

test('scope is exact: the wrong operation never resolves the grant', () => {
  const { broker } = setup();
  const grant = broker.issue({ pluginId: 'pdf-exporter', operation: 'acme.pdf.render' });
  assert.throws(
    () => broker.resolve(grant.token, 'acme.pdf.exfiltrate'),
    (error) =>
      error.code === 'lego.access_denied' &&
      error.details.scopedOperation === 'acme.pdf.render' &&
      error.details.attemptedOperation === 'acme.pdf.exfiltrate',
  );
  // the grant survives a scope miss — it was never consumed
  assert.equal(broker.liveCount(), 1);
  assert.equal(broker.resolve(grant.token, 'acme.pdf.render').length > 0, true);
});

test('expiry is enforced at resolve-time: expired grants die with deadline_exceeded', () => {
  const { broker, advance } = setup();
  const grant = broker.issue({ pluginId: 'pdf-exporter', operation: 'acme.pdf.render', ttlMs: 1_000 });
  advance(1_001);
  assert.throws(
    () => broker.resolve(grant.token, 'acme.pdf.render'),
    (error) => error.code === 'lego.deadline_exceeded' && error.details.expiresAt > 0,
  );
  assert.equal(broker.liveCount(), 0, 'the expired grant is dropped, not lingering');
});

test('TTLs are bounded integers — zero, negative, huge and fractional all fail closed', () => {
  const { broker } = setup();
  for (const ttlMs of [0, -1, 1.5, PLUGIN_SECRET_LIMITS.maxTtlMs + 1, '1000', null]) {
    assert.throws(
      () => broker.issue({ pluginId: 'p', operation: 'a.b', ttlMs }),
      (error) => error.code === 'lego.contract_violation',
      `rejects ttlMs=${String(ttlMs)}`,
    );
  }
});

test('the live map is bounded: past maxLive issuance raises published backpressure', () => {
  const { broker } = setup({ maxLive: 3 });
  const tokens = [];
  for (let i = 0; i < 3; i += 1) {
    tokens.push(broker.issue({ pluginId: `p${i}`, operation: 'a.b' }).token);
  }
  assert.throws(
    () => broker.issue({ pluginId: 'p4', operation: 'a.b' }),
    (error) => error.code === 'lego.backpressure' && error.retryable === true && error.details.maxLive === 3,
  );
  // revoking frees a slot — the cap is about live grants, not lifetime history
  assert.equal(broker.revoke(tokens[0]), true);
  const late = broker.issue({ pluginId: 'p4', operation: 'a.b' });
  assert.ok(late.token);
  assert.equal(broker.liveCount(), 3, 'cap still holds after the refill');
});

test('revoke is honest: known tokens drop, unknown tokens answer false, resolves afterwards fail', () => {
  const { broker } = setup();
  const grant = broker.issue({ pluginId: 'p', operation: 'a.b' });
  assert.equal(broker.revoke('sk_unknown'), false);
  assert.equal(broker.revoke(grant.token), true);
  assert.throws(() => broker.resolve(grant.token, 'a.b'), (error) => error.code === 'lego.unavailable');
});

test('sweep drops expired grants and liveCount stays honest', () => {
  const { broker, advance } = setup();
  broker.issue({ pluginId: 'p1', operation: 'a.b', ttlMs: 100 });
  broker.issue({ pluginId: 'p2', operation: 'a.b', ttlMs: 10_000 });
  advance(150);
  assert.equal(broker.sweep(), 1);
  assert.equal(broker.liveCount(), 1);
  assert.equal(broker.sweep(), 0, 'nothing else was expired');
});

test('no source ⇒ no standing material: issue fails with unavailable, nothing is parked', () => {
  const broker = createSecretBroker({ now: () => 0 });
  assert.throws(
    () => broker.issue({ pluginId: 'p', operation: 'a.b' }),
    (error) => error.code === 'lego.unavailable',
  );
  assert.equal(broker.liveCount(), 0);
});

test('a failing or empty source leaves no half-issued grant (atomic issue)', () => {
  const failing = createSecretBroker({
    now: () => 0,
    source: () => {
      throw new Error('vault down');
    },
  });
  assert.throws(() => failing.issue({ pluginId: 'p', operation: 'a.b' }), /vault down/);
  assert.equal(failing.liveCount(), 0);

  const empty = createSecretBroker({ now: () => 0, source: () => '' });
  assert.throws(
    () => empty.issue({ pluginId: 'p', operation: 'a.b' }),
    (error) => error.code === 'lego.unavailable',
  );
  assert.equal(empty.liveCount(), 0);
});

test('events carry metadata only — never the token, never the material', () => {
  const { broker, events } = setup();
  const grant = broker.issue({ pluginId: 'pdf-exporter', operation: 'acme.pdf.render' });
  broker.resolve(grant.token, 'acme.pdf.render');
  assert.deepEqual(
    events.map((event) => event.type),
    ['plugin.secret-issued', 'plugin.resolved'],
  );
  const serialized = JSON.stringify(events);
  assert.equal(serialized.includes(grant.token), false, 'no token in the event stream');
  assert.equal(serialized.includes('material-for:'), false, 'no material in the event stream');
  assert.equal(serialized.includes('pdf-exporter'), true, 'metadata that operators need is present');
});

test('pluginId/operation inputs are validated fail-closed', () => {
  const { broker } = setup();
  for (const bad of [{ pluginId: '', operation: 'a.b' }, { pluginId: 'p', operation: '' },
    { pluginId: 'p'.repeat(65), operation: 'a.b' }, { pluginId: 'p', operation: 'x'.repeat(129) },
    { operation: 'a.b' }, { pluginId: 'p' }]) {
    assert.throws(
      () => broker.issue(bad),
      (error) => error.code === 'lego.contract_violation',
      `rejects ${JSON.stringify(bad)}`,
    );
  }
  assert.throws(() => broker.resolve('', 'a.b'), (error) => error.code === 'lego.contract_violation');
  assert.throws(
    () => createSecretBroker({ now: 1 }),
    TypeError,
  );
  assert.throws(() => createSecretBroker({ now: () => 0, source: 'vault' }), TypeError);
  assert.throws(() => createSecretBroker({ now: () => 0, maxLive: 0 }), TypeError);
  assert.throws(() => createSecretBroker({ now: () => 0, defaultTtlMs: PLUGIN_SECRET_LIMITS.maxTtlMs + 1 }), TypeError);
});

test('the lego.plugin-runtime row keeps the P2.27.5 modules locked (exact surface pins live in the newest slice suite)', () => {
  const lock = JSON.parse(readFileSync(join(APP_ROOT, 'src/lego/contracts/contract-lock.json'), 'utf8'));
  const row = lock.contracts.find((entry) => entry.id === 'lego.plugin-runtime');
  assert.match(row.version, /^\d+\.\d+\.\d+$/);
  assert.ok(row.surface.includes('src/lego/plugin-secrets.mjs'), 'plugin-secrets.mjs stays on the surface');
  assert.ok(row.tests.includes('apps/n8n-lego/test/lego-plugin-secrets.test.mjs'));
  for (const file of row.surface) {
    const source = readFileSync(join(APP_ROOT, file), 'utf8');
    const exported = [...source.matchAll(/^export (?:const|class|function) (\w+)/gm)].map((m) => m[1]).sort();
    const locked = [...(row.exports[file] ?? [])].sort();
    assert.deepEqual(locked, exported, `lock ⇄ module exports for ${file}`);
  }
});
