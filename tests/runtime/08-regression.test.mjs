/**
 * W3 — regression net.
 *
 * Replays every fixture in tests/fixtures/runtime/workflows against the live
 * runtime and compares the normalised result with the committed snapshot in
 * tests/fixtures/runtime/expected. These snapshots are the behavioural
 * reference the later Rust migration must reproduce byte for byte.
 *
 * A missing or stale snapshot is a FAILURE, never an auto-update:
 *   node tests/runtime/helpers/update-fixtures.mjs   # regenerate, then review the diff
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { Runtime } from './helpers/process.mjs';
import { loadFixtures, normalizeRunResult, readExpected, requestBodyFor } from './helpers/fixtures.mjs';

let runtime;
let fixtures;

before(async () => {
  runtime = await Runtime.start();
  fixtures = await loadFixtures();
});

after(async () => {
  await runtime?.cleanup();
});

test('the fixture corpus is present and non-trivial', () => {
  assert.ok(fixtures.length >= 8, `expected at least 8 fixtures, found ${fixtures.length}`);
  const ids = fixtures.map((fixture) => fixture.id);
  for (const required of [
    '02-linear-three-nodes',
    '04-multi-item',
    '05-unknown-node-passthrough',
    '06-code-eval-disabled',
    '09-dangling-connection',
  ]) {
    assert.ok(ids.includes(required), `missing fixture ${required}`);
  }
});

for (const fixture of await loadFixtures()) {
  test(`fixture ${fixture.id}: matches the committed snapshot`, async () => {
    const expected = await readExpected(fixture.id);
    assert.ok(expected, `missing tests/fixtures/runtime/expected/${fixture.id}.json — run update-fixtures.mjs and review the diff`);

    const response = await runtime.post('/api/v1/workflows/run', requestBodyFor(fixture));
    assert.equal(response.status, 200, `fixture ${fixture.id} failed: ${JSON.stringify(response.body)}`);
    assert.deepEqual(normalizeRunResult(response.body.data), expected);
  });
}

test('fixtures are deterministic: two runs produce identical normalised results', async () => {
  for (const fixture of fixtures) {
    const first = await runtime.post('/api/v1/workflows/run', requestBodyFor(fixture));
    const second = await runtime.post('/api/v1/workflows/run', requestBodyFor(fixture));
    assert.equal(first.status, 200, fixture.id);
    assert.equal(second.status, 200, fixture.id);
    assert.deepEqual(normalizeRunResult(first.body.data), normalizeRunResult(second.body.data), `fixture ${fixture.id} is not deterministic`);
    assert.notEqual(first.body.data.executionId, second.body.data.executionId, 'execution ids must still be unique');
  }
});

test('fixtures can be replayed through every endpoint that runs a workflow', async () => {
  const fixture = fixtures.find((entry) => entry.id === '02-linear-three-nodes');
  const stateless = await runtime.post('/api/v1/workflows/run', requestBodyFor(fixture));
  assert.equal(stateless.status, 200);

  const stored = await runtime.post('/api/v1/workflows', { workflow: fixture.workflow });
  const id = stored.body.data.id;
  const viaStore = await runtime.post(`/api/v1/workflows/${id}/run`, {
    input: fixture.input,
    locale: 'en',
  });
  assert.equal(viaStore.status, 200);
  assert.deepEqual(normalizeRunResult(viaStore.body.data), normalizeRunResult(stateless.body.data));

  const record = await runtime.get(`/api/v1/executions/${viaStore.body.data.executionId}`);
  assert.equal(record.status, 200);
  assert.deepEqual(normalizeRunResult(record.body.data), normalizeRunResult(stateless.body.data));

  const deleted = await runtime.del(`/api/v1/workflows/${id}`);
  assert.equal(deleted.status, 200);
});
