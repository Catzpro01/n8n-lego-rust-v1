/**
 * W3 — real workflow execution over HTTP (contract §3.2, §3.3, §3.4).
 * Everything here runs against a live process; nothing is stubbed.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { Runtime, linearConnections, nodes, workflow } from './helpers/process.mjs';

let runtime;

before(async () => {
  runtime = await Runtime.start();
});

after(async () => {
  await runtime?.cleanup();
});

const threeNode = () =>
  workflow({
    name: 'three node workflow',
    nodes: [
      nodes.manualTrigger('Manual Trigger'),
      nodes.setFields('Edit Fields', {
        string: [{ name: 'status', value: 'ok' }],
        number: [{ name: 'count', value: 42 }],
      }),
      nodes.noOp('Done'),
    ],
    connections: {
      ...linearConnections('Manual Trigger', 'Edit Fields'),
      ...linearConnections('Edit Fields', 'Done'),
    },
  });

test('a three node workflow runs end to end', async () => {
  const { status, body } = await runtime.post('/api/v1/workflows/run', {
    workflow: threeNode(),
    input: [{ json: { seed: 1 } }],
  });
  assert.equal(status, 200);
  const run = body.data;
  assert.equal(run.status, 'COMPLETED');
  assert.equal(run.finished, true);
  assert.equal(run.workflowId, null);
  assert.match(run.executionId, /^exec_/);
  assert.deepEqual(run.warnings, []);
  assert.deepEqual(run.data.Done, [{ json: { seed: 1, status: 'ok', count: 42 } }]);
  assert.deepEqual(
    run.executionLog.map((entry) => entry.node),
    ['Manual Trigger', 'Edit Fields', 'Done'],
  );
  assert.ok(run.executionLog.every((entry) => entry.status === 'success'));
  assert.ok(run.executionLog.every((entry) => entry.inputCount === 1 && entry.outputCount === 1));
  assert.match(run.startedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(run.stoppedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(typeof run.durationMs, 'number');
});

test('executed data is never rewritten by the locale layer', async () => {
  const definition = workflow({
    nodes: [
      nodes.manualTrigger(),
      nodes.setFields('Edit Fields', { string: [{ name: 'message', value: 'execution finished' }] }),
    ],
    connections: linearConnections('Manual Trigger', 'Edit Fields'),
  });
  const { body } = await runtime.post('/api/v1/workflows/run', { workflow: definition });
  assert.equal(body.data.data['Edit Fields'][0].json.message, 'execution finished');
  assert.equal(typeof body.data.statusText, 'string', 'human-facing status text is additive');
});

test('a single node workflow with no connections still runs', async () => {
  const { body } = await runtime.post('/api/v1/workflows/run', {
    workflow: workflow({ nodes: [nodes.manualTrigger('Only')], connections: {} }),
  });
  assert.equal(body.data.status, 'COMPLETED');
  assert.deepEqual(body.data.data.Only, [{ json: {} }]);
  assert.equal(body.data.executionLog.length, 1);
});

test('branching follows every outgoing connection', async () => {
  const definition = workflow({
    nodes: [
      nodes.manualTrigger('Start'),
      nodes.setFields('Left', { string: [{ name: 'side', value: 'left' }] }),
      nodes.setFields('Right', { string: [{ name: 'side', value: 'right' }] }),
    ],
    connections: {
      Start: {
        main: [
          [
            { node: 'Left', type: 'main', index: 0 },
            { node: 'Right', type: 'main', index: 0 },
          ],
        ],
      },
    },
  });
  const { body } = await runtime.post('/api/v1/workflows/run', { workflow: definition, input: [{ json: {} }] });
  assert.equal(body.data.status, 'COMPLETED');
  assert.equal(body.data.data.Left[0].json.side, 'left');
  assert.equal(body.data.data.Right[0].json.side, 'right');
  assert.deepEqual(
    [...body.data.executionLog].map((entry) => entry.node).sort(),
    ['Left', 'Right', 'Start'],
  );
});

test('multiple input items are all processed', async () => {
  const definition = workflow({
    nodes: [nodes.manualTrigger('Start'), nodes.noOp('Done')],
    connections: linearConnections('Start', 'Done'),
  });
  const input = [{ json: { n: 1 } }, { json: { n: 2 } }, { json: { n: 3 } }];
  const { body } = await runtime.post('/api/v1/workflows/run', { workflow: definition, input });
  assert.deepEqual(body.data.data.Done, input);
  const log = body.data.executionLog.find((entry) => entry.node === 'Done');
  assert.equal(log.inputCount, 3);
  assert.equal(log.outputCount, 3);
});

test('a bare object input is accepted and wrapped into items', async () => {
  const definition = workflow({ nodes: [nodes.manualTrigger('Start')], connections: {} });
  const { body } = await runtime.post('/api/v1/workflows/run', { workflow: definition, input: { seed: 'bare' } });
  assert.deepEqual(body.data.data.Start, [{ json: { seed: 'bare' } }]);
});

test('a workflow without an input still receives one empty item', async () => {
  const definition = workflow({ nodes: [nodes.manualTrigger('Start')], connections: {} });
  const { body } = await runtime.post('/api/v1/workflows/run', { workflow: definition });
  assert.deepEqual(body.data.data.Start, [{ json: {} }]);
});

test('a bare workflow body (no wrapper) is accepted', async () => {
  const definition = workflow({ nodes: [nodes.manualTrigger('Start'), nodes.noOp('Done')], connections: linearConnections('Start', 'Done') });
  const { status, body } = await runtime.post('/api/v1/workflows/run', definition);
  assert.equal(status, 200);
  assert.equal(body.data.status, 'COMPLETED');
});

test('startNode selects the entry point', async () => {
  const { body } = await runtime.post('/api/v1/workflows/run', {
    workflow: threeNode(),
    startNode: 'Edit Fields',
    input: [{ json: {} }],
  });
  assert.deepEqual(
    body.data.executionLog.map((entry) => entry.node),
    ['Edit Fields', 'Done'],
  );
});

test('stored workflows can be saved, listed, read, replaced, run and deleted', async () => {
  const created = await runtime.post('/api/v1/workflows', { workflow: threeNode() });
  assert.equal(created.status, 201);
  const id = created.body.data.id;
  assert.match(id, /^wf_/);

  const listed = await runtime.get('/api/v1/workflows');
  assert.equal(listed.body.data.count, 1);
  assert.equal(listed.body.data.items[0].id, id);
  assert.equal(listed.body.data.items[0].nodeCount, 3);

  const fetched = await runtime.get(`/api/v1/workflows/${id}`);
  assert.equal(fetched.status, 200);
  assert.equal(fetched.body.data.name, 'three node workflow');

  const replaced = await runtime.put(`/api/v1/workflows/${id}`, {
    workflow: workflow({ name: 'renamed workflow', nodes: [nodes.manualTrigger('Start')], connections: {} }),
  });
  assert.equal(replaced.status, 200);
  assert.equal(replaced.body.data.name, 'renamed workflow');
  assert.equal(replaced.body.data.id, id, 'the id is stable across replacement');

  const run = await runtime.post(`/api/v1/workflows/${id}/run`, { input: [{ json: { from: 'store' } }] });
  assert.equal(run.status, 200);
  assert.equal(run.body.data.status, 'COMPLETED');
  assert.equal(run.body.data.workflowId, id);
  assert.deepEqual(run.body.data.data.Start, [{ json: { from: 'store' } }]);

  const deleted = await runtime.del(`/api/v1/workflows/${id}`);
  assert.deepEqual(deleted.body.data, { id, deleted: true });
  const afterDelete = await runtime.get(`/api/v1/workflows/${id}`);
  assert.equal(afterDelete.status, 404);
  assert.equal(afterDelete.body.code, 'WORKFLOW_NOT_FOUND');
});

test('every run is retrievable from the execution history', async () => {
  const run = await runtime.post('/api/v1/workflows/run', { workflow: threeNode(), input: [{ json: { n: 7 } }] });
  const executionId = run.body.data.executionId;

  const record = await runtime.get(`/api/v1/executions/${executionId}`);
  assert.equal(record.status, 200);
  assert.equal(record.body.data.executionId, executionId);
  assert.equal(record.body.data.status, 'COMPLETED');
  assert.equal(record.body.data.ok, true);
  assert.equal(record.body.data.requestedBy, 'http');
  assert.deepEqual(record.body.data.data.Done, [{ json: { n: 7, status: 'ok', count: 42 } }]);
  assert.equal(record.body.data.executionLog.length, 3);

  const listed = await runtime.get('/api/v1/executions?limit=5');
  assert.equal(listed.status, 200);
  assert.ok(listed.body.data.items.some((entry) => entry.executionId === executionId));
  assert.equal(listed.body.data.items[0].executionId, executionId, 'newest first');
});

test('execution history honours the limit parameter', async () => {
  for (let index = 0; index < 3; index += 1) {
    await runtime.post('/api/v1/workflows/run', { workflow: workflow({ nodes: [nodes.manualTrigger(`Run ${index}`)], connections: {} }) });
  }
  const limited = await runtime.get('/api/v1/executions?limit=2');
  assert.equal(limited.body.data.items.length, 2);
  const invalid = await runtime.get('/api/v1/executions?limit=0');
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.code, 'VALIDATION_ERROR');
});

test('the console can drive a stored workflow run (requestedBy=console)', async () => {
  const created = await runtime.post('/api/v1/workflows', { workflow: threeNode() });
  const id = created.body.data.id;
  const run = await runtime.post(`/api/v1/workflows/${id}/run`, { input: [{ json: {} }], requestedBy: 'console' });
  assert.equal(run.status, 200);
  const record = await runtime.get(`/api/v1/executions/${run.body.data.executionId}`);
  assert.equal(record.body.data.requestedBy, 'console');
});
