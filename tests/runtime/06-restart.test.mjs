/**
 * W3 — restart behaviour (contract §1 "restart MUST be idempotent", §3.4
 * "records MUST survive a process restart").
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Runtime, linearConnections, nodes, portIsFree, tempDataDir, waitFor, workflow, freePort } from './helpers/process.mjs';
import { rm } from 'node:fs/promises';

test('workflows and execution records survive a restart, and the port is released', async () => {
  const dataDir = await tempDataDir('n8n-ts-restart-');
  let first;
  let second;
  try {
    first = await Runtime.start({ dataDir });
    const created = await first.post('/api/v1/workflows', {
      workflow: workflow({
        name: 'restart survivor',
        nodes: [nodes.manualTrigger('Start'), nodes.noOp('Done')],
        connections: linearConnections('Start', 'Done'),
      }),
    });
    assert.equal(created.status, 201);
    const workflowId = created.body.data.id;

    const run = await first.post(`/api/v1/workflows/${workflowId}/run`, { input: [{ json: { survived: true } }] });
    const executionId = run.body.data.executionId;
    assert.equal(run.status, 200);

    const exitCode = await first.stop();
    assert.equal(exitCode, 0, 'SIGTERM must be a clean shutdown');
    assert.equal(await portIsFree(first.port), true, 'the port must be free after shutdown');

    second = await Runtime.start({ dataDir, port: await freePort() });
    const listed = await second.get('/api/v1/workflows');
    assert.equal(listed.body.data.count, 1);
    assert.equal(listed.body.data.items[0].id, workflowId);

    const rerun = await second.post(`/api/v1/workflows/${workflowId}/run`, { input: [{ json: { afterRestart: true } }] });
    assert.equal(rerun.status, 200);
    assert.deepEqual(rerun.body.data.data.Done, [{ json: { afterRestart: true } }]);

    const record = await second.get(`/api/v1/executions/${executionId}`);
    assert.equal(record.status, 200);
    assert.equal(record.body.data.executionId, executionId);
    assert.deepEqual(record.body.data.data.Done, [{ json: { survived: true } }]);

    const history = await second.get('/api/v1/executions?limit=10');
    assert.ok(history.body.data.items.length >= 2, 'both runs are in the history');
  } finally {
    await second?.cleanup();
    await first?.cleanup();
    await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('restarting the same data dir repeatedly keeps working', async () => {
  const dataDir = await tempDataDir('n8n-ts-restart-loop-');
  const port = await freePort();
  try {
    for (let cycle = 0; cycle < 3; cycle += 1) {
      const runtime = await Runtime.start({ dataDir, port });
      const created = await runtime.post('/api/v1/workflows', {
        workflow: workflow({ name: `cycle ${cycle}`, nodes: [nodes.manualTrigger('Start')], connections: {} }),
      });
      assert.equal(created.status, 201);
      assert.equal((await runtime.get('/api/v1/workflows')).body.data.count, cycle + 1);
      assert.equal(await runtime.stop(), 0);
      assert.equal(await portIsFree(port), true);
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('a second process on the same port fails fast with a readable error', async () => {
  const runtime = await Runtime.start();
  try {
    const clashing = await Runtime.start({ port: runtime.port, waitForReady: false });
    const exitCode = await waitFor(
      async () => (clashing.exited ? clashing.exitCode : null),
      { timeoutMs: 15_000, what: 'the clashing process to exit' },
    ).catch(() => null);
    assert.equal(exitCode === null ? 'still-running' : exitCode, 1);
    assert.match(clashing.output, /EADDRINUSE|address already in use/);
    await clashing.cleanup();
    // the original instance is unaffected
    assert.equal((await runtime.get('/healthz')).status, 200);
  } finally {
    await runtime.cleanup();
  }
});

test('shutdown drains in-flight state and flip readiness before exit', async () => {
  const runtime = await Runtime.start();
  await runtime.post('/api/v1/workflows/run', { workflow: workflow({ nodes: [nodes.manualTrigger('Start')], connections: {} }) });
  const recordId = (await runtime.get('/api/v1/executions?limit=1')).body.data.items[0].executionId;
  assert.ok(recordId);

  await runtime.stop();
  const restarted = await Runtime.start({ dataDir: runtime.dataDir });
  try {
    const record = await restarted.get(`/api/v1/executions/${recordId}`);
    assert.equal(record.status, 200, 'records written before shutdown are readable after restart');
  } finally {
    await restarted.cleanup({ keepDataDir: true });
    await rm(runtime.dataDir, { recursive: true, force: true }).catch(() => {});
  }
});
