/**
 * W4 unit gate — frozen entrypoint behaviour (contract §5).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ENGINE_PACKAGE,
  ENGINE_VERSION,
  NODE_REGISTRY_VERSION,
  WorkflowRunError,
  createWorkflowEngine,
  runWorkflowDefinition,
} from '../index.mjs';

const threeNodeWorkflow = () => ({
  id: 'wf-test',
  name: 'three node workflow',
  nodes: [
    { name: 'Manual Trigger', type: 'n8n-nodes-base.manualTrigger', parameters: {}, typeVersion: 1 },
    {
      name: 'Prepare',
      type: 'n8n-nodes-base.set',
      parameters: { values: { string: [{ name: 'status', value: 'ok' }], number: [{ name: 'count', value: 42 }] } },
      typeVersion: 1,
    },
    { name: 'Done', type: 'n8n-nodes-base.noOp', parameters: {}, typeVersion: 1 },
  ],
  connections: {
    'Manual Trigger': { main: [[{ node: 'Prepare', type: 'main', index: 0 }]] },
    Prepare: { main: [[{ node: 'Done', type: 'main', index: 0 }]] },
  },
});

test('engine metadata matches the frozen contract', () => {
  assert.equal(ENGINE_PACKAGE, '@lego/reconstructed-engine');
  assert.match(ENGINE_VERSION, /^\d+\.\d+\.\d+$/);
  assert.match(NODE_REGISTRY_VERSION, /^\d+\.\d+\.\d+$/);
});

test('runWorkflowDefinition executes a linear workflow end to end', async () => {
  const result = await runWorkflowDefinition(threeNodeWorkflow(), { input: [{ json: { seed: 1 } }], locale: 'en' });
  assert.equal(result.status, 'COMPLETED');
  assert.equal(result.finished, true);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.data.Done, [{ json: { seed: 1, status: 'ok', count: 42 } }]);
  assert.equal(result.executionLog.length, 3);
  assert.deepEqual(
    result.executionLog.map((entry) => entry.node),
    ['Manual Trigger', 'Prepare', 'Done'],
  );
  assert.ok(result.executionLog.every((entry) => entry.status === 'success'));
});

test('executed data is never rewritten by the locale layer', async () => {
  const workflow = {
    nodes: [
      {
        name: 'Set',
        type: 'n8n-nodes-base.set',
        parameters: { values: { string: [{ name: 'message', value: 'execution finished' }] } },
      },
    ],
    connections: {},
  };
  const result = await runWorkflowDefinition(workflow, { locale: 'id' });
  assert.equal(result.data.Set[0].json.message, 'execution finished');
  assert.equal(typeof result.statusText, 'string');
});

test('caller input shapes are accepted: bare object, item array, empty', async () => {
  const workflow = threeNodeWorkflow();
  const bare = await runWorkflowDefinition(workflow, { input: { seed: 2 } });
  assert.deepEqual(bare.data['Manual Trigger'], [{ json: { seed: 2 } }]);
  const none = await runWorkflowDefinition(workflow, {});
  assert.deepEqual(none.data['Manual Trigger'], [{ json: {} }]);
});

test('startNode selects the entry node', async () => {
  const result = await runWorkflowDefinition(threeNodeWorkflow(), { startNode: 'Prepare', input: [{ json: {} }] });
  assert.deepEqual(
    result.executionLog.map((entry) => entry.node),
    ['Prepare', 'Done'],
  );
});

test('unknown node types pass through with a warning by default', async () => {
  const workflow = {
    nodes: [
      { name: 'Manual Trigger', type: 'n8n-nodes-base.manualTrigger', parameters: {} },
      { name: 'Ghost', type: 'n8n-nodes-base.notARealNode', parameters: {} },
    ],
    connections: { 'Manual Trigger': { main: [[{ node: 'Ghost', type: 'main', index: 0 }]] } },
  };
  const result = await runWorkflowDefinition(workflow, { input: [{ json: { a: 1 } }] });
  assert.equal(result.status, 'COMPLETED');
  assert.deepEqual(result.data.Ghost, [{ json: { a: 1 } }]);
  assert.equal(result.warnings.length, 1);
  assert.equal(result.warnings[0].code, 'UNKNOWN_NODE_TYPE');
  assert.equal(result.warnings[0].node, 'Ghost');
});

test('pre-execution failures throw WorkflowRunError, never a partial result', async () => {
  await assert.rejects(
    () => runWorkflowDefinition({ nodes: [], connections: {} }),
    (error) => error instanceof WorkflowRunError && error.code === 'EMPTY_WORKFLOW',
  );
  await assert.rejects(
    () => runWorkflowDefinition({ nodes: [{ name: 'x', type: 'y' }, { name: 'x', type: 'n8n-nodes-base.noOp' }] }),
    (error) => error instanceof WorkflowRunError && error.code === 'INVALID_WORKFLOW',
  );
});

test('createWorkflowEngine returns a reusable engine instance', async () => {
  const engine = createWorkflowEngine(threeNodeWorkflow(), { locale: 'en' });
  assert.equal(typeof engine.registerNodeType, 'function');
  const first = await engine.runWorkflow(null, [{ seed: 1 }], { locale: 'en' });
  assert.equal(first.status, 'COMPLETED');
  assert.deepEqual(first.data.Done, [{ json: { seed: 1, status: 'ok', count: 42 } }]);
});

test('handlers never leak warnings between runs', async () => {
  const workflow = {
    nodes: [
      { name: 'Manual Trigger', type: 'n8n-nodes-base.manualTrigger', parameters: {} },
      { name: 'Code', type: 'n8n-nodes-base.code', parameters: { jsCode: 'return [];' } },
    ],
    connections: { 'Manual Trigger': { main: [[{ node: 'Code', type: 'main', index: 0 }]] } },
  };
  const first = await runWorkflowDefinition(workflow, {});
  const second = await runWorkflowDefinition(workflow, {});
  assert.equal(first.warnings.length, 1);
  assert.equal(second.warnings.length, 1);
});
