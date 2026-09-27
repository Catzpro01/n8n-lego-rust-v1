/**
 * W3 — unknown node types and dangling connections, under both policies
 * (contract §2 policies, §3.3 warning vocabulary, §4 UNKNOWN_NODE / UNKNOWN_CONNECTION).
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { Runtime, linearConnections, nodes, workflow } from './helpers/process.mjs';

let permissive;
let permissiveRunOnly;
let strict;

before(async () => {
  permissive = await Runtime.start();
  permissiveRunOnly = await Runtime.start({ env: { N8N_TS_UNKNOWN_NODE_POLICY: 'error' } });
  strict = await Runtime.start({
    env: { N8N_TS_UNKNOWN_NODE_POLICY: 'error', N8N_TS_UNKNOWN_CONNECTION_POLICY: 'error' },
  });
});

after(async () => {
  await Promise.all([permissive?.cleanup(), permissiveRunOnly?.cleanup(), strict?.cleanup()]);
});

const unknownNodeWorkflow = () =>
  workflow({
    name: 'unknown node',
    nodes: [nodes.manualTrigger('Start'), nodes.unknown('Not A Real Node')],
    connections: linearConnections('Start', 'Not A Real Node'),
  });

test('default policy: unknown node types pass items through with a warning', async () => {
  const { status, body } = await permissive.post('/api/v1/workflows/run', {
    workflow: unknownNodeWorkflow(),
    input: [{ json: { a: 1 } }],
  });
  assert.equal(status, 200);
  assert.equal(body.data.status, 'COMPLETED');
  assert.deepEqual(body.data.data['Not A Real Node'], [{ json: { a: 1 } }]);
  assert.equal(body.data.warnings.length, 1);
  const warning = body.data.warnings[0];
  assert.equal(warning.code, 'UNKNOWN_NODE_TYPE');
  assert.equal(warning.node, 'Not A Real Node');
  assert.match(warning.message, /n8n-nodes-base\.notARealNode/);
});

test('the warning is persisted with the execution record', async () => {
  const run = await permissive.post('/api/v1/workflows/run', { workflow: unknownNodeWorkflow(), input: [{ json: { a: 2 } }] });
  const record = await permissive.get(`/api/v1/executions/${run.body.data.executionId}`);
  assert.equal(record.body.data.warnings[0].code, 'UNKNOWN_NODE_TYPE');
});

test('strict policy: unknown node types are 422 UNKNOWN_NODE', async () => {
  const { status, body } = await permissiveRunOnly.post('/api/v1/workflows/run', { workflow: unknownNodeWorkflow() });
  assert.equal(status, 422);
  assert.equal(body.code, 'UNKNOWN_NODE');
  assert.match(body.message, /n8n-nodes-base\.notARealNode/);
  assert.equal(body.details.nodes[0].node, 'Not A Real Node');
});

test('strict policy does not affect registered nodes', async () => {
  const { status, body } = await permissiveRunOnly.post('/api/v1/workflows/run', {
    workflow: workflow({ nodes: [nodes.manualTrigger('Start'), nodes.noOp('Done')], connections: linearConnections('Start', 'Done') }),
  });
  assert.equal(status, 200);
  assert.deepEqual(body.data.warnings, []);
});

test('a dangling connection target is a warning by default and the run completes', async () => {
  const definition = workflow({
    nodes: [nodes.manualTrigger('Start')],
    connections: { Start: { main: [[{ node: 'Ghost', type: 'main', index: 0 }]] } },
  });
  const { status, body } = await permissive.post('/api/v1/workflows/run', { workflow: definition });
  assert.equal(status, 200);
  assert.equal(body.data.status, 'COMPLETED');
  assert.deepEqual(body.data.data.Start, [{ json: {} }]);
  assert.equal(body.data.warnings[0].code, 'UNKNOWN_CONNECTION_TARGET');
  assert.equal(body.data.warnings[0].node, 'Ghost');
});

test('strict connection policy: dangling targets are 422 UNKNOWN_CONNECTION', async () => {
  const definition = workflow({
    nodes: [nodes.manualTrigger('Start')],
    connections: { Start: { main: [[{ node: 'Ghost', type: 'main', index: 0 }]] } },
  });
  const { status, body } = await strict.post('/api/v1/workflows/run', { workflow: definition });
  assert.equal(status, 422);
  assert.equal(body.code, 'UNKNOWN_CONNECTION');
  assert.equal(body.details.connections[0].node, 'Ghost');
});

test('code nodes report their jsCode was not executed', async () => {
  const definition = workflow({
    nodes: [
      nodes.manualTrigger('Start'),
      { name: 'Code', type: 'n8n-nodes-base.code', typeVersion: 2, parameters: { jsCode: 'return [{ json: { x: 1 } }];' } },
    ],
    connections: linearConnections('Start', 'Code'),
  });
  const { status, body } = await permissive.post('/api/v1/workflows/run', { workflow: definition, input: [{ json: { untouched: true } }] });
  assert.equal(status, 200);
  assert.deepEqual(body.data.data.Code, [{ json: { untouched: true } }]);
  assert.equal(body.data.warnings[0].code, 'CODE_EVAL_DISABLED');
  assert.equal(body.data.warnings[0].node, 'Code');
});

test('the node catalogue tells the operator what is actually implemented', async () => {
  const { body } = await permissive.get('/api/v1/nodes');
  const types = body.data.nodes.map((node) => node.type);
  assert.ok(types.includes('n8n-nodes-base.set'));
  assert.ok(types.includes('n8n-nodes-base.httpRequest'), 'the delivered credential-consuming node must appear in the catalogue');
  assert.equal(types.includes('n8n-nodes-base.notARealNode'), false, 'unimplemented nodes must not pretend to exist');
});
