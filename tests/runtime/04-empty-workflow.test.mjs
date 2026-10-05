/**
 * W3 — empty / minimal workflows (contract §4 EMPTY_WORKFLOW).
 * Saving an empty workflow is allowed (the console is an editor); *running*
 * one is a 422.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { Runtime, nodes, workflow } from './helpers/process.mjs';

let runtime;

before(async () => {
  runtime = await Runtime.start();
});

after(async () => {
  await runtime?.cleanup();
});

test('running a workflow with no nodes is 422 EMPTY_WORKFLOW', async () => {
  const { status, body } = await runtime.post('/api/v1/workflows/run', { workflow: { nodes: [], connections: {} } });
  assert.equal(status, 422);
  assert.equal(body.code, 'EMPTY_WORKFLOW');
  assert.equal(body.message, 'workflow contains no nodes');
  assert.equal(body.details.errors[0].code, 'EMPTY_WORKFLOW');
  assert.equal(body.details.errors[0].path, 'workflow.nodes');
});

test('the empty run is recorded in the execution history as a failure', async () => {
  const response = await runtime.post('/api/v1/workflows/run', { workflow: { nodes: [], connections: {} } });
  assert.equal(response.status, 422);
  const listed = await runtime.get('/api/v1/executions?limit=1');
  const latest = listed.body.data.items[0];
  assert.equal(latest.status, 'FAILED');
  assert.equal(latest.ok, false);
  const record = await runtime.get(`/api/v1/executions/${latest.executionId}`);
  assert.equal(record.body.data.error.code, 'EMPTY_WORKFLOW');
  assert.deepEqual(record.body.data.executionLog, []);
});

test('a workflow without a connections key still runs', async () => {
  const { status, body } = await runtime.post('/api/v1/workflows/run', { workflow: { name: 'no connections', nodes: [nodes.manualTrigger('Start')] } });
  assert.equal(status, 200);
  assert.equal(body.data.status, 'COMPLETED');
  assert.deepEqual(body.data.data.Start, [{ json: {} }]);
});

test('a workflow with connections: {} still runs', async () => {
  const { status, body } = await runtime.post('/api/v1/workflows/run', {
    workflow: workflow({ nodes: [nodes.manualTrigger('Start')], connections: {} }),
  });
  assert.equal(status, 200);
  assert.equal(body.data.status, 'COMPLETED');
});

test('saving an empty workflow is allowed, running it is not', async () => {
  const created = await runtime.post('/api/v1/workflows', { workflow: { name: 'draft workflow', nodes: [], connections: {} } });
  assert.equal(created.status, 201);
  const id = created.body.data.id;
  assert.deepEqual(created.body.data.nodes, []);

  const run = await runtime.post(`/api/v1/workflows/${id}/run`, {});
  assert.equal(run.status, 422);
  assert.equal(run.body.code, 'EMPTY_WORKFLOW');

  const fetched = await runtime.get(`/api/v1/workflows/${id}`);
  assert.equal(fetched.body.data.name, 'draft workflow', 'the draft survives a failed run');
  await runtime.del(`/api/v1/workflows/${id}`);
});

test('a failing run does not disturb later runs', async () => {
  await runtime.post('/api/v1/workflows/run', { workflow: { nodes: [], connections: {} } });
  const ok = await runtime.post('/api/v1/workflows/run', {
    workflow: workflow({ nodes: [nodes.manualTrigger('Start'), nodes.noOp('Done')] }),
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.data.status, 'COMPLETED');
});
