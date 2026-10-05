/**
 * P2.27.8 — contract replay (§18 interchangeability oracle).
 *
 * Proves: stableStringify is key-order-insensitive and fails closed on
 * cycles/unserializable values; firstDifference names the divergent path;
 * replayFixture declares implementations interchangeable only when outcomes
 * match semantically (success values or identical failure contracts), with
 * explicit normalize stripping volatile fields; mixed ok/fail and any value
 * divergence produce honest mismatches; bounds (2..16, unique ids) hold; and
 * the lock row stays semver-versioned with the replay/failure suites pinned
 * (the exact surface pin lives in the newest suite).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPLAY_BOUNDS, stableStringify, firstDifference, replayFixture } from '../src/lego/plugin-replay.mjs';
import { PluginRuntimeError } from '../src/lego/plugin-runtime.mjs';

const APP_ROOT = fileURLToPath(new URL('../', import.meta.url));

test('stableStringify sorts keys — key order is never semantics', () => {
  assert.equal(stableStringify({ b: 1, a: 2 }), stableStringify({ a: 2, b: 1 }));
  assert.equal(stableStringify({ z: { y: 1, x: 2 } }), '{"z":{"x":2,"y":1}}');
  assert.equal(stableStringify([1, { b: 1, a: 2 }]), '[1,{"a":2,"b":1}]');
  assert.equal(stableStringify(null), 'null');
});

test('stableStringify fails closed on cycles, functions, non-finite numbers', () => {
  const cyclic = { self: null };
  cyclic.self = cyclic;
  for (const bad of [cyclic, { fn: () => {} }, { n: Infinity }, { s: Symbol('x') }, { b: 10n }]) {
    assert.throws(
      () => stableStringify(bad),
      (error) => error instanceof PluginRuntimeError && error.code === 'lego.contract_violation',
      `rejects ${Object.keys(bad)[0]}`,
    );
  }
});

test('firstDifference names the divergent path — operator model §20', () => {
  assert.equal(firstDifference({ a: 1 }, { a: 1 }).equal, true);
  const deep = firstDifference({ a: { b: [1, 2, 3] } }, { a: { b: [1, 9, 3] } });
  assert.equal(deep.equal, false);
  assert.equal(deep.path, 'a.b[1]');
  assert.equal(deep.left, '2');
  assert.equal(deep.right, '9');
  const missing = firstDifference({ present: 1 }, {});
  assert.equal(missing.path, 'present');
  assert.equal(missing.right, 'absent');
  const len = firstDifference([1, 2], [1, 2, 3]);
  assert.equal(len.path, 'length');
  assert.ok(Object.isFrozen(firstDifference(1, 2)));
});

test('replay: two implementations with the same semantics (different key order) are interchangeable', () => {
  const report = replayFixture({
    name: 'pdf-render',
    input: { doc: 'a' },
    implementations: [
      { id: 'v1', invoke: () => ({ pages: 3, meta: { title: 'x', pages: 3 } }) },
      { id: 'v2', invoke: () => ({ meta: { pages: 3, title: 'x' }, pages: 3 }) },
    ],
  });
  assert.equal(report.interchangeable, true);
  assert.equal(report.mismatches.length, 0);
  assert.equal(report.outcomes.length, 2);
  assert.equal(report.outcomes.every((outcome) => outcome.ok), true);
  assert.equal(report.name, 'pdf-render');
  assert.ok(Object.isFrozen(report) && Object.isFrozen(report.outcomes));
});

test('replay: volatile fields are stripped only through the explicit normalize hook', () => {
  const normalize = (value) => ({ ...value, renderedAt: undefined, requestId: undefined });
  const stripIds = (value) => {
    const copy = JSON.parse(JSON.stringify(value));
    delete copy.renderedAt;
    delete copy.requestId;
    return copy;
  };
  const input = { doc: 'a' };
  const impls = [
    { id: 'v1', invoke: () => ({ pages: 3, renderedAt: 111, requestId: 'r1' }) },
    { id: 'v2', invoke: () => ({ pages: 3, renderedAt: 222, requestId: 'r2' }) },
  ];
  const raw = replayFixture({ input, implementations: impls });
  assert.equal(raw.interchangeable, false, 'without normalize the timestamps ARE a semantic difference');
  assert.equal(raw.mismatches[0].path, 'renderedAt');
  const stripped = replayFixture({ input, implementations: impls, normalize: stripIds });
  assert.equal(stripped.interchangeable, true, 'with an explicit normalize the fixture is interchangeable');
  void normalize;
});

test('replay: value divergence marks the report non-interchangeable with the path', () => {
  const report = replayFixture({
    input: null,
    implementations: [
      { id: 'v1', invoke: () => ({ total: 10 }) },
      { id: 'v2', invoke: () => ({ total: 11 }) },
    ],
  });
  assert.equal(report.interchangeable, false);
  assert.equal(report.mismatches.length, 1);
  assert.equal(report.mismatches[0].id, 'v2');
  assert.equal(report.mismatches[0].baselineId, 'v1');
  assert.equal(report.mismatches[0].path, 'total');
});

test('replay: failure contracts compare too — identical failures interchange, differing ones do not; mixed outcomes never interchange', () => {
  const failWith = (name, message) => () => {
    const error = new Error(message);
    error.name = name;
    throw error;
  };
  const same = replayFixture({
    input: {},
    implementations: [
      { id: 'v1', invoke: failWith('CodecError', 'page 2 unreadable') },
      { id: 'v2', invoke: failWith('CodecError', 'page 2 unreadable') },
    ],
  });
  assert.equal(same.interchangeable, true, 'same failure contract on both sides is interchangeability');
  const differing = replayFixture({
    input: {},
    implementations: [
      { id: 'v1', invoke: failWith('CodecError', 'page 2 unreadable') },
      { id: 'v2', invoke: failWith('CodecError', 'page corrupt') },
    ],
  });
  assert.equal(differing.interchangeable, false);
  assert.match(differing.mismatches[0].reason, /failure contract differs/);
  const mixed = replayFixture({
    input: {},
    implementations: [
      { id: 'v1', invoke: failWith('CodecError', 'boom') },
      { id: 'v2', invoke: () => ({ ok: true }) },
    ],
  });
  assert.equal(mixed.interchangeable, false);
  assert.match(mixed.mismatches[0].reason, /succeeded but|failed but/);
});

test('replay requests fail closed: bounds, unique ids, callable invokes, serializable input/outcomes', () => {
  const good = [
    { id: 'a', invoke: () => 1 },
    { id: 'b', invoke: () => 2 },
  ];
  assert.throws(() => replayFixture({ implementations: [good[0]] }), (e) => e.code === 'lego.contract_violation');
  const tooMany = Array.from({ length: REPLAY_BOUNDS.implementationsMax + 1 }, (_, i) => ({ id: `i${i}`, invoke: () => i }));
  assert.throws(() => replayFixture({ implementations: tooMany }), (e) => e.code === 'lego.contract_violation');
  assert.throws(
    () => replayFixture({ implementations: [{ id: 'a', invoke: () => 1 }, { id: 'a', invoke: () => 1 }] }),
    (e) => e.code === 'lego.contract_violation',
  );
  assert.throws(
    () => replayFixture({ implementations: [{ id: 'a', invoke: 1 }, { id: 'b', invoke: () => 2 }] }),
    (e) => e.code === 'lego.contract_violation',
  );
  assert.throws(() => replayFixture({ input: { f: () => {} }, implementations: good }), (e) => e.code === 'lego.contract_violation');
  assert.throws(
    () => replayFixture({ input: {}, implementations: good, normalize: 'nope' }),
    (e) => e.code === 'lego.contract_violation',
  );
  assert.throws(() => replayFixture({ implementations: good }), (e) => e.code === 'lego.contract_violation', 'input required');
  // an unserializable SUCCESS outcome is a fixture bug — fail closed at replay time
  assert.throws(
    () => replayFixture({ input: {}, implementations: [{ id: 'a', invoke: () => ({ n: Infinity }) }, { id: 'b', invoke: () => ({ n: 1 }) }] }),
    (e) => e.code === 'lego.contract_violation',
  );
});

test('the lock row stays semver-versioned and keeps the replay surface + suites pinned', () => {
  const lock = JSON.parse(readFileSync(join(APP_ROOT, 'src/lego/contracts/contract-lock.json'), 'utf8'));
  const row = lock.contracts.find((entry) => entry.id === 'lego.plugin-runtime');
  assert.match(row.version, /^\d+\.\d+\.\d+$/);
  for (const file of [
    'src/lego/plugin-failure.mjs',
    'src/lego/plugin-replay.mjs',
    'src/lego/plugin-supervisor.mjs',
    'src/lego/plugin-runtime.mjs',
  ]) {
    assert.ok(row.surface.includes(file), `${file} stays on the surface`);
  }
  assert.ok(row.tests.includes('apps/n8n-lego/test/lego-plugin-replay.test.mjs'));
  assert.ok(row.tests.includes('apps/n8n-lego/test/lego-plugin-failure.test.mjs'));
  for (const file of row.surface) {
    const source = readFileSync(join(APP_ROOT, file), 'utf8');
    const exported = [...source.matchAll(/^export (?:const|class|function) (\w+)/gm)].map((m) => m[1]).sort();
    const locked = [...(row.exports[file] ?? [])].sort();
    assert.deepEqual(locked, exported, `lock ⇄ module exports for ${file}`);
  }
});
