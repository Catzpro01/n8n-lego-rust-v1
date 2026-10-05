/**
 * W3 — malformed and hostile requests (contract §4).
 * A bad request must never 500, never leak a stack trace in production and
 * always answer with the frozen error code.
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

test('invalid JSON is 400 BAD_JSON', async () => {
  const { status, body } = await runtime.post('/api/v1/workflows/run', '{oops', { raw: true });
  assert.equal(status, 400);
  assert.equal(body.code, 'BAD_JSON');
  assert.ok(body.requestId);
});

test('a non-object body is 400 VALIDATION_ERROR', async () => {
  for (const payload of ['[]', '"string"', '42', 'null']) {
    const { status, body } = await runtime.post('/api/v1/workflows/run', payload, { raw: true });
    assert.equal(status, 400, `payload ${payload}`);
    assert.equal(body.code, 'VALIDATION_ERROR', `payload ${payload}`);
  }
});

test('a body without nodes is 400 VALIDATION_ERROR with the offending path', async () => {
  const { status, body } = await runtime.post('/api/v1/workflows/run', { workflow: { name: 'no nodes' } });
  assert.equal(status, 400);
  assert.equal(body.code, 'VALIDATION_ERROR');
  assert.equal(body.details.errors[0].path, 'workflow.nodes');
});

test('nodes that are not an array are 400 VALIDATION_ERROR', async () => {
  const { status, body } = await runtime.post('/api/v1/workflows/run', { workflow: { nodes: 'nope' } });
  assert.equal(status, 400);
  assert.equal(body.code, 'VALIDATION_ERROR');
});

test('duplicate node names, missing types and bad connection shapes are 422 INVALID_WORKFLOW', async () => {
  const cases = [
    { nodes: [{ name: 'A', type: 'n8n-nodes-base.noOp' }, { name: 'A', type: 'n8n-nodes-base.noOp' }], connections: {} },
    { nodes: [{ name: 'A' }], connections: {} },
    { nodes: [{ type: 'n8n-nodes-base.noOp' }], connections: {} },
    { nodes: [{ name: 'A', type: 'n8n-nodes-base.noOp' }], connections: { A: { main: { node: 'B' } } } },
    { nodes: [{ name: 'A', type: 'n8n-nodes-base.noOp', parameters: 'nope' }], connections: {} },
  ];
  for (const definition of cases) {
    const { status, body } = await runtime.post('/api/v1/workflows/run', { workflow: definition });
    assert.equal(status, 422, JSON.stringify(definition));
    assert.equal(body.code, 'INVALID_WORKFLOW', JSON.stringify(body));
    assert.ok(Array.isArray(body.details.errors) && body.details.errors.length > 0);
  }
});

test('unknown startNode is 400 UNKNOWN_START_NODE and lists the candidates', async () => {
  const definition = workflow({ nodes: [nodes.manualTrigger('Start')], connections: {} });
  const { status, body } = await runtime.post('/api/v1/workflows/run', { workflow: definition, startNode: 'Ghost' });
  assert.equal(status, 400);
  assert.equal(body.code, 'UNKNOWN_START_NODE');
  assert.deepEqual(body.details.available, ['Start']);
});

test('a wrong typed startNode is 400 VALIDATION_ERROR', async () => {
  const definition = workflow({ nodes: [nodes.manualTrigger('Start')], connections: {} });
  const { status, body } = await runtime.post('/api/v1/workflows/run', { workflow: definition, startNode: 5 });
  assert.equal(status, 400);
  assert.equal(body.code, 'VALIDATION_ERROR');
});

test('a wrong typed input is 400 VALIDATION_ERROR', async () => {
  const definition = workflow({ nodes: [nodes.manualTrigger('Start')], connections: {} });
  const { status, body } = await runtime.post('/api/v1/workflows/run', { workflow: definition, input: 'nope' });
  assert.equal(status, 400);
  assert.equal(body.code, 'VALIDATION_ERROR');
});

test('a body above N8N_TS_MAX_BODY_BYTES is 413 PAYLOAD_TOO_LARGE', async () => {
  // default limit is 1 MiB (contract §2), so the body has to exceed it
  const big = JSON.stringify({
    workflow: { nodes: [{ name: 'A', type: 'n8n-nodes-base.noOp', parameters: { pad: 'x'.repeat(1024 * 1024 + 1024) } }], connections: {} },
  });
  assert.ok(big.length > 1024 * 1024);
  const { status, body } = await runtime.post('/api/v1/workflows/run', big, { raw: true });
  assert.equal(status, 413);
  assert.equal(body.code, 'PAYLOAD_TOO_LARGE');
});

test('GET on a POST-only route is 405 with the Allow header', async () => {
  const { status, body, headers } = await runtime.get('/api/v1/workflows/run');
  assert.equal(status, 405);
  assert.equal(body.code, 'METHOD_NOT_ALLOWED');
  assert.ok(body.details.allowed.includes('POST'));
  assert.equal(headers.allow, 'POST');
});

test('unknown ids are 404 with the specific code', async () => {
  const workflowMissing = await runtime.get('/api/v1/workflows/wf_missing');
  assert.equal(workflowMissing.status, 404);
  assert.equal(workflowMissing.body.code, 'WORKFLOW_NOT_FOUND');

  const executionMissing = await runtime.get('/api/v1/executions/exec_missing');
  assert.equal(executionMissing.status, 404);
  assert.equal(executionMissing.body.code, 'EXECUTION_NOT_FOUND');

  const runMissing = await runtime.post('/api/v1/workflows/wf_missing/run', {});
  assert.equal(runMissing.status, 404);
  assert.equal(runMissing.body.code, 'WORKFLOW_NOT_FOUND');

  const deleteMissing = await runtime.del('/api/v1/workflows/wf_missing');
  assert.equal(deleteMissing.status, 404);
  assert.equal(deleteMissing.body.code, 'WORKFLOW_NOT_FOUND');
});

test('PUT on an unknown workflow does not silently create it', async () => {
  const response = await runtime.put('/api/v1/workflows/wf_nope', { workflow: workflow({ nodes: [nodes.noOp('A')] }) });
  assert.equal(response.status, 404);
  assert.equal(response.body.code, 'WORKFLOW_NOT_FOUND');
  const listed = await runtime.get('/api/v1/workflows');
  assert.ok(listed.body.data.items.every((item) => item.id !== 'wf_nope'));
});

test('a bad limit parameter is 400 VALIDATION_ERROR', async () => {
  const response = await runtime.get('/api/v1/executions?limit=abc');
  assert.equal(response.status, 400);
  assert.equal(response.body.code, 'VALIDATION_ERROR');
});

test('errors never leak stack traces outside development', async () => {
  const response = await runtime.post('/api/v1/workflows', { workflow: { nodes: 'nope' } });
  assert.equal(response.status, 400);
  assert.equal(JSON.stringify(response.body).includes('at '), false, 'no stack frames in the payload');

  const definition = workflow({ nodes: [nodes.manualTrigger('Start')], connections: {} });
  const ok = await runtime.post('/api/v1/workflows/run', { workflow: definition });
  assert.equal(ok.status, 200);
});
