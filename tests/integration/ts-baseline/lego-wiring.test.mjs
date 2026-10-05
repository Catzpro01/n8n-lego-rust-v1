/**
 * Integration: LEGO packages are present and adapter can load the engine.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

describe('LEGO wiring integration', () => {
  it('workflow-lego package exists', () => {
    assert.equal(
      fs.existsSync(path.join(REPO_ROOT, 'packages/workflow-lego/package.json')),
      true,
    );
    assert.equal(
      fs.existsSync(path.join(REPO_ROOT, 'packages/workflow-lego/src/index.ts')),
      true,
    );
  });

  it('execution-lego re-exports reconstructed-engine execution-engine', () => {
    const index = fs.readFileSync(
      path.join(REPO_ROOT, 'packages/execution-lego/src/index.ts'),
      'utf8',
    );
    assert.match(index, /reconstructed-engine\/src\/execution-engine/);
    assert.match(index, /createExecutionRuntime/);
    assert.match(index, /ActiveExecutions/);
  });

  it('reconstructed-engine runner exports WorkflowExecutionEngine', async () => {
    const href = pathToFileURL(
      path.join(REPO_ROOT, 'packages/reconstructed-engine/runner.mjs'),
    ).href;
    const mod = await import(href);
    assert.equal(typeof mod.WorkflowExecutionEngine, 'function');
  });

  it('engine-adapter runWorkflowViaLego executes one node', async () => {
    const href = pathToFileURL(
      path.join(REPO_ROOT, 'apps/n8n-ts/lib/engine-adapter.mjs'),
    ).href;
    const { runWorkflowViaLego, LEGO_INTEGRATION, probeExecutionLego, probeWorkflowLego } =
      await import(href);

    assert.equal(LEGO_INTEGRATION.engine, 'reconstructed-engine');
    assert.equal(LEGO_INTEGRATION.secondEngineForbidden, true);

    const exec = await probeExecutionLego();
    assert.equal(exec.available, true);
    const wf = await probeWorkflowLego();
    assert.equal(wf.available, true);

    const { result, engineMeta } = await runWorkflowViaLego(
      {
        nodes: [{ name: 'Start', type: 'n8n-nodes-base.manualTrigger', parameters: {} }],
        connections: {},
      },
      { locale: 'en' },
    );
    assert.equal(result.status, 'COMPLETED');
    assert.equal(engineMeta.engine, 'reconstructed-engine');
  });
});
