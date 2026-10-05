#!/usr/bin/env node
/**
 * W3 — integration gate for the *single engine rule* (contract §5).
 *
 * This is a static + dynamic audit, not a behaviour test:
 *   1. apps/n8n-ts imports the engine entrypoint from exactly one module
 *   2. apps/n8n-ts contains no execution loop, node handler table or scheduler
 *   3. apps/n8n-ts has no third-party runtime dependencies
 *   4. the engine entrypoint exports the frozen surface of contract §5
 *   5. the engine package has no dependencies and no I/O in its entrypoint
 *   6. the HTTP surface in the contract is actually registered by the runtime
 */
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const APP_SRC = join(REPO, 'apps', 'n8n-ts', 'src');
const ENGINE_DIR = join(REPO, 'packages', 'reconstructed-engine');
const CONTRACT = join(REPO, 'contracts', 'runtime-api.contract.md');

const results = [];
const check = async (name, fn) => {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail: detail ?? '' });
  } catch (error) {
    results.push({ name, ok: false, detail: error.message });
  }
};
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else out.push(full);
  }
  return out;
}

const appFiles = await walk(APP_SRC);

await check('apps/n8n-ts has exactly one engine consumer', async () => {
  const importers = [];
  for (const file of appFiles) {
    const source = await readFile(file, 'utf8');
    if (/reconstructed-engine\/(index\.mjs|package\.json)/.test(source)) importers.push(relative(REPO, file));
  }
  assert(importers.length === 1, `expected exactly one importer, found: ${importers.join(', ') || 'none'}`);
  assert(importers[0] === join('apps', 'n8n-ts', 'src', 'engine', 'bridge.ts'), `unexpected importer: ${importers[0]}`);
  return importers[0];
});

await check('apps/n8n-ts contains no execution loop or node behaviour', async () => {
  const forbidden = [
    'registerNodeType',
    'executionData.set',
    'queue.shift',
    'nodeTypes.set(',
    'new Map() /* handlers',
  ];
  const offenders = [];
  for (const file of appFiles) {
    const source = await readFile(file, 'utf8');
    for (const needle of forbidden) {
      if (source.includes(needle)) offenders.push(`${relative(REPO, file)} → "${needle}"`);
    }
  }
  assert(offenders.length === 0, `execution logic leaked into the runtime: ${offenders.join('; ')}`);
  return `${appFiles.length} files scanned`;
});

await check('apps/n8n-ts has no third-party runtime dependencies', async () => {
  const pkg = JSON.parse(await readFile(join(REPO, 'apps', 'n8n-ts', 'package.json'), 'utf8'));
  const deps = Object.keys(pkg.dependencies ?? {});
  assert(deps.length === 0, `unexpected runtime dependencies: ${deps.join(', ')}`);
  const dev = Object.keys(pkg.devDependencies ?? {}).sort().join(',');
  assert(dev === '@types/node,typescript', `devDependencies changed unexpectedly: ${dev}`);
  return 'dependencies: {}';
});

await check('the engine entrypoint exports the frozen surface', async () => {
  const engine = await import(join(ENGINE_DIR, 'index.mjs'));
  const required = [
    'ENGINE_PACKAGE',
    'ENGINE_VERSION',
    'NODE_REGISTRY_VERSION',
    'createNodeRegistry',
    'createWorkflowEngine',
    'runWorkflowDefinition',
    'validateWorkflowDefinition',
    'listNodeTypes',
    'WorkflowRunError',
  ];
  for (const name of required) {
    assert(engine[name] !== undefined, `missing export: ${name}`);
  }
  const types = engine.listNodeTypes().map((entry) => entry.type);
  assert(types.length >= 5, `registry too small: ${types.length}`);
  return `${required.length} exports, ${types.length} node types`;
});

await check('the engine package stays dependency-free and I/O-free', async () => {
  const pkg = JSON.parse(await readFile(join(ENGINE_DIR, 'package.json'), 'utf8'));
  assert(Object.keys(pkg.dependencies ?? {}).length === 0, 'engine package must not declare dependencies');
  const source = await readFile(join(ENGINE_DIR, 'index.mjs'), 'utf8');
  for (const needle of ["node:fs", "node:http", "node:net", "node:dns"]) {
    assert(!source.includes(needle), `engine entrypoint must not import ${needle}`);
  }
  const runner = await readFile(join(ENGINE_DIR, 'runner.mjs'), 'utf8');
  assert(/async runWorkflow\(/.test(runner), 'the reconstructed DAG loop must stay in runner.mjs');
  return `${pkg.name}@${pkg.version}`;
});

await check('the contract documents every route the runtime registers', async () => {
  const contract = await readFile(CONTRACT, 'utf8');
  const routes = [
    'GET /',
    'GET /healthz',
    'GET /healthz/readiness',
    'GET /api/v1/version',
    'GET /api/v1/nodes',
    'POST /api/v1/workflows/run',
    'POST /api/v1/workflows/:id/run',
    'GET /api/v1/workflows',
    'POST /api/v1/workflows',
    'GET /api/v1/workflows/:id',
    'PUT /api/v1/workflows/:id',
    'DELETE /api/v1/workflows/:id',
    'GET /api/v1/executions',
    'GET /api/v1/executions/:id',
  ];
  const missing = routes.filter((route) => !contract.includes(route.replace(' /', ' | `/').replace(':', ':')));
  assert(missing.length === 0, `contract is missing: ${missing.join(', ')}`);
  return `${routes.length} routes documented`;
});

await check('the runtime source implements the contract error vocabulary', async () => {
  const errors = await readFile(join(APP_SRC, 'http', 'errors.ts'), 'utf8');
  const contract = await readFile(CONTRACT, 'utf8');
  const codes = [
    'BAD_JSON',
    'VALIDATION_ERROR',
    'UNKNOWN_START_NODE',
    'UNAUTHORIZED',
    'NOT_FOUND',
    'WORKFLOW_NOT_FOUND',
    'EXECUTION_NOT_FOUND',
    'METHOD_NOT_ALLOWED',
    'PAYLOAD_TOO_LARGE',
    'EMPTY_WORKFLOW',
    'INVALID_WORKFLOW',
    'UNKNOWN_NODE',
    'UNKNOWN_CONNECTION',
    'INTERNAL_ERROR',
    'STORAGE_ERROR',
    'NOT_READY',
    'EXECUTION_TIMEOUT',
  ];
  for (const code of codes) {
    assert(errors.includes(`'${code}'`), `runtime does not implement error code ${code}`);
    assert(contract.includes(`\`${code}\``), `contract does not document error code ${code}`);
  }
  return `${codes.length} error codes`;
});

const failed = results.filter((entry) => !entry.ok);
for (const entry of results) {
  console.log(`${entry.ok ? '✓' : '✗'} ${entry.name}${entry.detail ? ` — ${entry.detail}` : ''}`);
}
console.log(
  `\n${results.length - failed.length}/${results.length} integration checks passed` +
    (failed.length ? `\n>>> SINGLE-ENGINE GATE: BLOCKED <<<` : '\n>>> SINGLE-ENGINE GATE: PASS <<<'),
);
process.exit(failed.length === 0 ? 0 : 1);
