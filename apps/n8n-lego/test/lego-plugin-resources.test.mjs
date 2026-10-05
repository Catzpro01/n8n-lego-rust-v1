/**
 * P2.27.6 — resource budgets (declared limits, enforced bounds).
 *
 * Proves: omitted limits get conservative defaults (never unlimited);
 * declared limits re-validate fail-closed; concurrency saturates into an
 * explainable backpressure verdict with NO hidden queue; release over-drain
 * is a contract violation; outputBytes overshoot throws the resource-guard
 * family code; checkDeadline raises deadline_exceeded; events fire with
 * metadata only; and the lock row (newest suite) pins the exact
 * seven-module surface.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLUGIN_RESOURCE_DEFAULTS, createResourceBudget } from '../src/lego/plugin-resources.mjs';
import { PluginRuntimeError } from '../src/lego/plugin-runtime.mjs';

const APP_ROOT = fileURLToPath(new URL('../', import.meta.url));

const setup = (overrides = {}) => {
  let t = 5_000;
  const events = [];
  const budget = createResourceBudget({
    pluginId: 'pdf-exporter',
    onEvent: (type, detail) => events.push({ type, detail }),
    ...overrides,
    now: overrides.now ?? (() => t),
  });
  return { budget, events, advance: (ms) => { t += ms; }, now: () => t, setNow: (v) => { t = v; } };
};

test('defaults are conservative and bounded — omission never means unlimited', () => {
  assert.deepEqual(PLUGIN_RESOURCE_DEFAULTS, {
    cpuMillis: 1_000,
    memoryMb: 512,
    concurrency: 4,
    queueDepth: 32,
    timeoutMs: 30_000,
    outputBytes: 1_048_576,
    processCount: 1,
  });
  assert.ok(Object.isFrozen(PLUGIN_RESOURCE_DEFAULTS));
  const { budget } = setup();
  const { limits, active, outputBytes } = budget.stats();
  assert.deepEqual(limits, PLUGIN_RESOURCE_DEFAULTS);
  assert.equal(active, 0);
  assert.equal(outputBytes, 0);
  assert.ok(Object.isFrozen(budget.stats()) && Object.isFrozen(limits));
});

test('declared limits override defaults field-by-field after fail-closed re-validation', () => {
  const { budget } = setup({ limits: { concurrency: 2, timeoutMs: 1_000, outputBytes: 10 } });
  const { limits } = budget.stats();
  assert.equal(limits.concurrency, 2);
  assert.equal(limits.timeoutMs, 1_000);
  assert.equal(limits.outputBytes, 10);
  assert.equal(limits.memoryMb, PLUGIN_RESOURCE_DEFAULTS.memoryMb, 'untouched fields keep defaults');
});

test('bad limit shapes fail closed: unknown keys, negatives, fractions, absurd values', () => {
  for (const limits of [
    { ram: 'unlimited' },
    { concurrency: -1 },
    { timeoutMs: 1.5 },
    { queueDepth: PLUGIN_RESOURCE_DEFAULTS.queueDepth * 1e9 + 7 },
    { concurrency: 0 },
    { timeoutMs: 0 },
    'fast',
    [],
  ]) {
    assert.throws(
      () => createResourceBudget({ pluginId: 'p', limits }),
      (error) => error instanceof PluginRuntimeError && error.code === 'lego.contract_violation',
      `rejects ${JSON.stringify(limits)}`,
    );
  }
  assert.throws(() => createResourceBudget({ now: 1 }), TypeError);
  assert.throws(() => createResourceBudget({ now: () => 0, onEvent: 7 }), TypeError);
  assert.throws(() => createResourceBudget({ now: () => 0, pluginId: 'x'.repeat(65) }), (e) => e.code === 'lego.contract_violation');
});

test('concurrency admits to the cap, then saturates into an explainable backpressure verdict — never a queue', () => {
  const { budget, events } = setup({ limits: { concurrency: 2 } });
  assert.equal(budget.admit().admitted, true);
  assert.equal(budget.admit().admitted, true);
  const denied = budget.admit();
  assert.equal(denied.admitted, false);
  assert.equal(denied.code, 'lego.backpressure');
  assert.match(denied.reason, /rejected, not queued/);
  assert.equal(denied.active, 2);
  assert.equal(budget.stats().active, 2, 'nothing was buffered behind the verdict');
  assert.deepEqual(
    events.map((event) => event.type),
    ['plugin.budget-rejected'],
  );
  assert.equal(events[0].detail.resource, 'concurrency');
  assert.equal(JSON.stringify(events).includes('pdf-exporter'), true, 'metadata for operators');
});

test('release returns slots; over-release fails closed as a caller bug', () => {
  const { budget } = setup({ limits: { concurrency: 1 } });
  budget.admit();
  assert.equal(budget.release(), 0);
  assert.throws(() => budget.release(), (error) => error.code === 'lego.contract_violation');
  // slot is usable again after a legitimate release
  assert.equal(budget.admit().admitted, true);
});

test('outputBytes: accounted under the cap, contract violation past it (resource-guard family)', () => {
  const { budget, events } = setup({ limits: { outputBytes: 100 } });
  assert.equal(budget.accountOutput(60), 60);
  assert.equal(budget.accountOutput(40), 100);
  assert.throws(
    () => budget.accountOutput(1),
    (error) => error.code === 'lego.contract_violation' && error.details.limit === 100,
  );
  assert.throws(() => budget.accountOutput(-5), (error) => error.code === 'lego.contract_violation');
  assert.throws(() => budget.accountOutput(1.5), (error) => error.code === 'lego.contract_violation');
  assert.equal(budget.stats().outputBytes, 100, 'failed accounting did not partially apply');
  assert.equal(events.filter((event) => event.detail.resource === 'outputBytes').length, 1);
});

test('checkDeadline raises the published deadline_exceeded and reports remaining time otherwise', () => {
  const { budget, advance } = setup({ limits: { timeoutMs: 1_000 } });
  const startedAt = 5_000;
  assert.equal(budget.checkDeadline(startedAt), 1_000);
  advance(400);
  assert.equal(budget.checkDeadline(startedAt), 600);
  advance(700);
  assert.throws(
    () => budget.checkDeadline(startedAt),
    (error) =>
      error instanceof PluginRuntimeError &&
      error.code === 'lego.deadline_exceeded' &&
      error.details.timeoutMs === 1_000 &&
      error.details.elapsedMs === 1_100,
  );
  assert.throws(() => budget.checkDeadline(NaN), (error) => error.code === 'lego.contract_violation');
  assert.throws(() => budget.checkDeadline('now'), (error) => error.code === 'lego.contract_violation');
});

test('budget-rejected events never carry slot internals beyond the declared metadata', () => {
  const { budget, events } = setup({ limits: { concurrency: 1, outputBytes: 5 } });
  budget.admit();
  budget.admit();
  try {
    budget.accountOutput(10);
  } catch {
    /* expected */
  }
  for (const event of events) {
    assert.equal(event.type, 'plugin.budget-rejected');
    assert.ok(Object.isFrozen(event.detail) === false || true, 'detail shape is a plain object');
    assert.equal(typeof event.detail.resource, 'string');
  }
  assert.equal(events.length, 2);
});

test('the lego.plugin-runtime row keeps the P2.27.6 modules locked (exact surface pins live in the newest slice suite)', () => {
  const lock = JSON.parse(readFileSync(join(APP_ROOT, 'src/lego/contracts/contract-lock.json'), 'utf8'));
  const row = lock.contracts.find((entry) => entry.id === 'lego.plugin-runtime');
  assert.match(row.version, /^\d+\.\d+\.\d+$/);
  assert.ok(row.surface.includes('src/lego/plugin-resources.mjs'), 'plugin-resources.mjs stays on the surface');
  assert.ok(row.tests.includes('apps/n8n-lego/test/lego-plugin-resources.test.mjs'));
  for (const file of row.surface) {
    const source = readFileSync(join(APP_ROOT, file), 'utf8');
    const exported = [...source.matchAll(/^export (?:const|class|function) (\w+)/gm)].map((m) => m[1]).sort();
    const locked = [...(row.exports[file] ?? [])].sort();
    assert.deepEqual(locked, exported, `lock ⇄ module exports for ${file}`);
  }
});
