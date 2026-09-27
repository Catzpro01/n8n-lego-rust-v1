/**
 * W4 unit gate — validation surface (contract §5, error codes §4).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  WorkflowRunError,
  createNodeRegistry,
  validateWorkflowDefinition,
  assertRunnableDefinition,
} from '../index.mjs';

const linear = () => ({
  name: 'linear',
  nodes: [
    { name: 'Manual Trigger', type: 'n8n-nodes-base.manualTrigger', parameters: {} },
    { name: 'Edit Fields', type: 'n8n-nodes-base.set', parameters: { values: { string: [{ name: 'status', value: 'ok' }] } } },
  ],
  connections: { 'Manual Trigger': { main: [[{ node: 'Edit Fields', type: 'main', index: 0 }]] } },
});

test('valid definition passes and returns a normalized copy', () => {
  const original = linear();
  const result = validateWorkflowDefinition(original, { registry: createNodeRegistry() });
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
  assert.notEqual(result.normalized, original);
  assert.deepEqual(result.normalized.nodes, original.nodes);
  assert.equal(original.nodes[0].parameters && typeof original.nodes[0].parameters, 'object');
});

test('non-object definition is VALIDATION_ERROR (missing/typed field)', () => {
  const result = validateWorkflowDefinition(null);
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'VALIDATION_ERROR');
});

test('missing nodes array is VALIDATION_ERROR (missing/typed field)', () => {
  const result = validateWorkflowDefinition({ name: 'x' });
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'VALIDATION_ERROR');
  assert.equal(result.errors[0].path, 'workflow.nodes');
});

test('empty node array is EMPTY_WORKFLOW', () => {
  const result = validateWorkflowDefinition({ nodes: [], connections: {} });
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'EMPTY_WORKFLOW');
});

test('duplicate node names and bad node shapes are INVALID_WORKFLOW', () => {
  const result = validateWorkflowDefinition({
    nodes: [
      { name: 'A', type: 'n8n-nodes-base.noOp' },
      { name: 'A', type: 'n8n-nodes-base.noOp' },
      { name: '', type: 'n8n-nodes-base.noOp' },
      { name: 'C' },
    ],
  });
  assert.equal(result.ok, false);
  const messages = result.errors.map((entry) => entry.message).join(' | ');
  assert.match(messages, /duplicate node name "A"/);
  assert.match(messages, /needs a non-empty string "name"/);
  assert.match(messages, /needs a non-empty string "type"/);
  assert.ok(result.errors.every((entry) => entry.code === 'INVALID_WORKFLOW'));
});

test('unknown node types and dangling connections become warnings, not errors', () => {
  const result = validateWorkflowDefinition(
    {
      nodes: [
        { name: 'Start', type: 'n8n-nodes-base.manualTrigger' },
        { name: 'GhostNode', type: 'n8n-nodes-base.notARealNode' },
      ],
      connections: { Start: { main: [[{ node: 'Ghost', type: 'main', index: 0 }]] } },
    },
    { registry: createNodeRegistry() },
  );
  assert.equal(result.ok, true);
  const codes = result.warnings.map((entry) => entry.code).sort();
  assert.deepEqual(codes, ['UNKNOWN_CONNECTION_TARGET', 'UNKNOWN_NODE_TYPE']);
  assert.equal(result.warnings.find((w) => w.code === 'UNKNOWN_NODE_TYPE').type, 'n8n-nodes-base.notARealNode');
});

test('httpRequest is a registered built-in since P6-S05 (no longer an unknown type)', () => {
  const registry = createNodeRegistry();
  assert.equal(registry.has('n8n-nodes-base.httpRequest'), true);
  assert.equal(registry.info('n8n-nodes-base.httpRequest').alias, 'httpRequest');
});

test('malformed connections shape is INVALID_WORKFLOW', () => {
  const result = validateWorkflowDefinition({
    nodes: [{ name: 'Start', type: 'n8n-nodes-base.manualTrigger' }],
    connections: { Start: { main: { node: 'x' } } },
  });
  assert.equal(result.ok, false);
  assert.match(result.errors[0].message, /must be an array of output branches/);
});

test('assertRunnableDefinition throws WorkflowRunError with the frozen code', () => {
  assert.throws(
    () => assertRunnableDefinition({ nodes: [] }),
    (error) => error instanceof WorkflowRunError && error.code === 'EMPTY_WORKFLOW',
  );
});

test('validation never mutates the caller definition', () => {
  const definition = linear();
  const snapshot = JSON.stringify(definition);
  validateWorkflowDefinition(definition, { registry: createNodeRegistry() });
  assert.equal(JSON.stringify(definition), snapshot);
});
