/**
 * n8n lego — REST smoke test.
 *
 * Boots the real server on an ephemeral port with in-memory storage and walks the
 * path the editor takes: settings → owner setup → login → workflow → run →
 * execution record. This is the gate that says "the app works", independent of
 * the browser.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../src/server.mjs';
import { deserializeRustExecutionResult } from '../src/rust-engine-client.mjs';

/**
 * The catalog (node types, icons, roles) is fetched per install, not committed —
 * `npm run lego:catalog` writes it into the user folder. The smoke test therefore
 * points the server at the checkout's copy and keeps every other file it writes
 * inside a throwaway directory.
 */
const CANDIDATE_CATALOG_1 = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'data', 'lego', 'catalog');
const CANDIDATE_CATALOG_2 = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'data', 'n8n-lego', 'catalog');
const REPO_CATALOG = existsSync(CANDIDATE_CATALOG_1) ? CANDIDATE_CATALOG_1 : CANDIDATE_CATALOG_2;
const USER_FOLDER = mkdtempSync(join(tmpdir(), 'n8n-lego-test-'));

let base;
let running;
let cookie = '';
let csrfCookie = '';
let workflowId = '';
let executionId = '';

before(async () => {
  const { server } = await startServer({
    env: {
      ...process.env,
      N8N_LEGO_PORT: '0',
      N8N_LEGO_HOST: '127.0.0.1',
      N8N_LEGO_STORAGE: 'memory',
      N8N_LEGO_LOG_LEVEL: 'error',
      N8N_LEGO_PROTOCOL: 'http',
      N8N_LEGO_USER_FOLDER: USER_FOLDER,
      N8N_LEGO_CATALOG_DIR: process.env.N8N_LEGO_CATALOG_DIR ?? REPO_CATALOG,
    },
  });
  running = server;
  const address = server.address();
  base = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  // Close the listener so the test process exits instead of hanging.
  if (running) await new Promise((done) => running.close(() => done()));
  rmSync(USER_FOLDER, { recursive: true, force: true });
});


/**
/**
 * P5.2: this helper models the BROWSER, not a bare HTTP client. A browser sends
 * `Origin` on every state-changing request, which is what the CSRF origin check
 * consumes. It deliberately sends NO x-n8n-csrf-token header, because the
 * shipped n8n editor — the declared compatibility surface — does not know that
 * header exists. Exercising the same path production does is the point.
 */
async function api(method, path, body, { withCookie = true } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(withCookie && cookie ? { cookie } : {}),
      ...(withCookie ? { origin: base } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  for (const entry of response.headers.getSetCookie?.() ?? []) {
    const pair = entry.split(';')[0];
    if (pair.startsWith('n8n-auth=')) cookie = pair;
    else if (pair.startsWith('n8n-csrf=')) csrfCookie = pair;
  }
  const text = await response.text();
  const json = text === '' ? null : JSON.parse(text);
  return { status: response.status, json };
}

test('GET /rest/settings exposes the complete FrontendSettings shape', async () => {
  const { status, json } = await api('GET', '/rest/settings');
  assert.equal(status, 200);
  const settings = json.data;
  for (const key of [
    'instanceId',
    'versionCli',
    'pushBackend',
    'endpointWebhook',
    'userManagement',
    'enterprise',
    'publicApi',
    'telemetry',
    'posthog',
    'license',
    'activeModules',
  ]) {
    assert.ok(key in settings, `settings.${key} is missing`);
  }
  assert.equal(settings.folders.enabled, false, 'folders feature must be disabled');
  assert.equal(settings.enterprise.sharing, false, 'enterprise sharing must be disabled');
  assert.equal(settings.enterprise.projects.team.limit, 0, 'team projects limit must be 0');
  assert.equal(settings.enterprise.personalSpacePolicy, false, 'personalSpacePolicy must be disabled');
  assert.equal(settings.userManagement.showSetupOnFirstLoad, true, 'a fresh instance must show the setup screen');
});

test('GET /rest/login is 401 before setup', async () => {
  const { status } = await api('GET', '/rest/login');
  assert.equal(status, 401);
});

test('POST /rest/owner/setup creates the owner and a session', async () => {
  const { status, json } = await api('POST', '/rest/owner/setup', {
    email: 'owner@example.test',
    firstName: 'Test',
    lastName: 'Owner',
    password: 'test-password-123',
  });
  assert.equal(status, 200);
  assert.equal(json.data.role, 'global:owner');
  assert.ok(cookie.startsWith('n8n-auth='), 'setup must set the session cookie');
});

test('GET /rest/login returns the signed-in user', async () => {
  const { status, json } = await api('GET', '/rest/login');
  assert.equal(status, 200);
  assert.equal(json.data.email, 'owner@example.test');
});

test('GET /rest/settings hides the setup screen once an owner exists', async () => {
  const { json } = await api('GET', '/rest/settings');
  assert.equal(json.data.userManagement.showSetupOnFirstLoad, false);
});

test('GET /rest/types/nodes.json serves the node catalog', async () => {
  const response = await fetch(`${base}/rest/types/nodes.json`);
  assert.equal(response.status, 200);
  const nodes = await response.json();
  assert.ok(Array.isArray(nodes) && nodes.length > 100, 'expected the full catalog');
  assert.ok(nodes.every((node) => typeof node.name === 'string' && node.displayName !== undefined));
});

test('GET /rest/types/node-versions.json lists name@version identifiers', async () => {
  const { status, json } = await api('GET', '/rest/types/node-versions.json');
  assert.equal(status, 200);
  assert.ok(json.some((entry) => entry.startsWith('n8n-nodes-base.set@')));
});

test('GET /rest/roles gives the owner its scopes', async () => {
  const { status, json } = await api('GET', '/rest/roles');
  assert.equal(status, 200);
  const owner = json.data.global.find((role) => role.slug === 'global:owner');
  assert.ok(owner, 'global:owner must be present');
  assert.ok(owner.scopes.includes('workflow:create'), 'owner must be allowed to create workflows');
});

test('POST /rest/node-types returns descriptions for requested versions', async () => {
  const { status, json } = await api('POST', '/rest/node-types', {
    nodeInfos: [{ name: 'n8n-nodes-base.httpRequest', version: 4.4 }, { name: 'n8n-nodes-base.nope', version: 1 }],
  });
  assert.equal(status, 200);
  assert.equal(json.data.length, 1, 'unknown node types are skipped, not fatal');
  assert.equal(json.data[0].displayName, 'HTTP Request');
  assert.ok(Array.isArray(json.data[0].properties) && json.data[0].properties.length > 0);

  const byIdentifier = await api('POST', '/rest/node-types/by-identifier', {
    identifiers: ['n8n-nodes-base.set@3.4', 'n8n-nodes-base.httpRequest@4.2'],
  });
  assert.equal(byIdentifier.status, 200);
  assert.deepEqual(
    byIdentifier.json.data.map((node) => node.name),
    ['n8n-nodes-base.set', 'n8n-nodes-base.httpRequest'],
  );
});

test('workflow CRUD + manual execution', async () => {
  const created = await api('POST', '/rest/workflows', {
    name: 'Smoke test',
    nodes: [
      { id: '1', name: 'Manual', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
      {
        id: '2',
        name: 'Edit Fields',
        type: 'n8n-nodes-base.set',
        typeVersion: 3.4,
        position: [220, 0],
        parameters: {
          mode: 'manual',
          includeOtherFields: false,
          assignments: { assignments: [{ id: 'a1', name: 'status', value: 'ok', type: 'string' }] },
        },
      },
    ],
    connections: { Manual: { main: [[{ node: 'Edit Fields', type: 'main', index: 0 }]] } },
  });
  assert.equal(created.status, 200);
  workflowId = created.json.data.id;
  assert.ok(workflowId, 'workflow id required');

  const listed = await api('GET', '/rest/workflows');
  assert.equal(listed.json.count, 1);
  assert.equal(listed.json.data.length, 1, 'workflow list items are bare objects');

  const run = await api('POST', `/rest/workflows/${workflowId}/run`, { startNodes: [{ name: 'Manual' }] });
  assert.equal(run.status, 200);
  assert.equal(run.json.data.status, 'success');
  executionId = run.json.data.executionId;
  assert.ok(executionId, 'execution id required');

  const execution = await api('GET', `/rest/executions/${executionId}`);
  assert.equal(execution.status, 200);
  const { parse: flattedParse } = await import('flatted');
  const executionData = typeof execution.json.data.data === 'string' ? flattedParse(execution.json.data.data) : execution.json.data.data;
  const runData = executionData.resultData.runData;
  assert.deepEqual(Object.keys(runData), ['Manual', 'Edit Fields']);
  assert.deepEqual(runData['Edit Fields'][0].data.main[0][0].json, { status: 'ok' });

  const history = await api('GET', '/rest/executions?limit=5');
  assert.equal(history.json.data.count, 1);

  const removed = await api('DELETE', `/rest/workflows/${workflowId}`);
  assert.equal(removed.status, 200);
  assert.equal((await api('GET', '/rest/workflows')).json.count, 0);
});

test('POST /rest/workflows/run executes unsaved workflow and GET /rest/executions/:id parses with flatted', async () => {
  const run = await api('POST', '/rest/workflows/run', {
    workflowData: {
      name: 'Unsaved run',
      nodes: [
        { id: '1', name: 'Manual', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
        {
          id: '2',
          name: 'Edit Fields',
          type: 'n8n-nodes-base.set',
          typeVersion: 3.4,
          position: [220, 0],
          parameters: {
            mode: 'manual',
            includeOtherFields: false,
            assignments: { assignments: [{ id: 'a1', name: 'status', value: 'unsaved-ok', type: 'string' }] },
          },
        },
      ],
      connections: { Manual: { main: [[{ node: 'Edit Fields', type: 'main', index: 0 }]] } },
    },
    startNodes: [{ name: 'Manual' }],
  });
  assert.equal(run.status, 200);
  assert.equal(run.json.data.status, 'success');
  const execId = run.json.data.executionId;
  assert.ok(execId, 'execution id required');

  const execution = await api('GET', `/rest/executions/${execId}`);
  assert.equal(execution.status, 200);
  assert.ok(execution.json.data.workflowData, 'workflowData must not be null');
  assert.equal(execution.json.data.workflowData.name, 'Unsaved run');
  const { parse: flattedParse } = await import('flatted');
  const executionData = typeof execution.json.data.data === 'string' ? flattedParse(execution.json.data.data) : execution.json.data.data;
  assert.deepEqual(executionData.resultData.runData['Edit Fields'][0].data.main[0][0].json, { status: 'unsaved-ok' });
  assert.equal(executionData.resultData.runData['Edit Fields'][0].executionIndex, 0, 'executionIndex must be 0');
  assert.equal(executionData.resultData.runData['Manual'][0].executionIndex, 0, 'executionIndex must be 0');
});

test('GET & POST /rest/workflow-history routes return valid snapshots and versions', async () => {
  const created = await api('POST', '/rest/workflows', {
    name: 'History Test Workflow',
    nodes: [{ id: '1', name: 'Manual', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} }],
    connections: {},
  });
  assert.equal(created.status, 200);
  const wfId = created.json.data.id;

  const list = await api('GET', `/rest/workflow-history/workflow/${wfId}`);
  assert.equal(list.status, 200);
  assert.equal(list.json.count, 1);
  assert.equal(list.json.data.length, 1);
  assert.equal(list.json.data[0].workflowId, wfId);
  assert.equal(list.json.data[0].authors, 'Owner Admin');

  const version = await api('GET', `/rest/workflow-history/workflow/${wfId}/version/v123`);
  assert.equal(version.status, 200);
  assert.equal(version.json.data.versionId, 'v123');
  assert.equal(version.json.data.workflowId, wfId);
  assert.equal(version.json.data.authors, 'Owner Admin');
  assert.ok(Array.isArray(version.json.data.nodes));

  const versions = await api('POST', `/rest/workflow-history/workflow/${wfId}/versions`, { versionIds: ['v123'] });
  assert.equal(versions.status, 200);
  assert.deepEqual(versions.json.data.versions, []);

  const notFoundHistory = await api('GET', '/rest/workflow-history/workflow/nonexistent-id');
  assert.equal(notFoundHistory.status, 404);

  const notFoundVersion = await api('GET', '/rest/workflow-history/workflow/nonexistent-id/version/v1');
  assert.equal(notFoundVersion.status, 404);

  await api('DELETE', `/rest/workflows/${wfId}`);
});

test('GET /rest/workflows/:workflowId/test-runs endpoints return empty list or 404', async () => {
  const list = await api('GET', '/rest/workflows/some-wf-id/test-runs');
  assert.equal(list.status, 200);
  assert.deepEqual(list.json.data, []);

  const single = await api('GET', '/rest/workflows/some-wf-id/test-runs/run-1');
  assert.equal(single.status, 404);
});

test('unknown /rest endpoint answers with explicit unsupported semantics', async () => {
  const { status, json } = await api('GET', '/rest/definitely-not-implemented');
  // P2: the fake `200 {"data":null}` success is gone — an unimplemented
  // capability is a distinguishable 501 with a machine-readable code.
  assert.equal(status, 501, 'an unimplemented endpoint never fakes a success');
  assert.equal(json.data, undefined, 'the envelope is an error, not {data:null}');
  assert.equal(json.code, 'unsupported');
  assert.equal(json.meta.feature, 'endpoint-not-implemented');
  assert.ok(typeof json.message === 'string' && json.message.length > 0);
});

test('unauthenticated /rest writes are rejected', async () => {
  const response = await fetch(`${base}/rest/workflows`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'nope' }),
  });
  assert.equal(response.status, 401);
});

test('GET /rest/workflows/:workflowId/collaboration/write-lock returns data: null', async () => {
  const res = await api('GET', '/rest/workflows/test-wf/collaboration/write-lock');
  assert.equal(res.status, 200);
  assert.strictEqual(res.json.data, null);
});

test('GET /rest/executions/:id returns complete workflowData schema with id and versionId', async () => {
  const run = await api('POST', '/rest/workflows/run', {
    workflowData: {
      id: 'wf-schema-test',
      name: 'Schema Test Run',
      nodes: [
        { id: '1', name: 'Manual', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
      ],
      connections: {},
    },
  });
  assert.equal(run.status, 200);
  const execId = run.json.data.executionId;
  const execRes = await api('GET', `/rest/executions/${execId}`);
  assert.equal(execRes.status, 200);
  const wfData = execRes.json.data.workflowData;
  assert.ok(wfData, 'workflowData must exist');
  assert.ok(wfData.id, 'workflowData.id must exist');
  assert.ok(wfData.versionId, 'workflowData.versionId must exist');
  assert.equal(wfData.name, 'Schema Test Run');
});

test('node catalog exposes languageVersion for JS and Python on n8n-nodes-base.code', async () => {
  // Test GET /rest/types/nodes.json
  const { status, json: nodes } = await api('GET', '/rest/types/nodes.json');
  assert.equal(status, 200);
  const codeNode = nodes.find((n) => n.name === 'n8n-nodes-base.code');
  assert.ok(codeNode, 'n8n-nodes-base.code must be present in catalog');

  const jsVersionProp = codeNode.properties.find(
    (p) => p.name === 'languageVersion' && p.displayOptions?.show?.language?.includes('javaScript'),
  );
  assert.ok(jsVersionProp, 'JavaScript languageVersion property must exist');
  assert.equal(jsVersionProp.displayName, 'JavaScript Version');
  assert.deepEqual(
    jsVersionProp.options.map((o) => o.value),
    ['default', '22', '20', '18'],
  );

  const pyVersionProp = codeNode.properties.find(
    (p) =>
      p.name === 'languageVersion' &&
      (p.displayOptions?.show?.language?.includes('python') ||
        p.displayOptions?.show?.language?.includes('pythonNative')),
  );
  assert.ok(pyVersionProp, 'Python languageVersion property must exist');
  assert.equal(pyVersionProp.displayName, 'Python Version');
  assert.deepEqual(
    pyVersionProp.options.map((o) => o.value),
    ['default', '3.12', '3.11', '3.10'],
  );

  // Test POST /rest/node-types
  const typesRes = await api('POST', '/rest/node-types', {
    nodeInfos: [{ name: 'n8n-nodes-base.code', version: 2 }],
  });
  assert.equal(typesRes.status, 200);
  const fetchedCode = typesRes.json.data.find((n) => n.name === 'n8n-nodes-base.code');
  assert.ok(fetchedCode, 'Fetched code node type must exist');
  const fetchedJsVersion = fetchedCode.properties.find(
    (p) => p.name === 'languageVersion' && p.displayOptions?.show?.language?.includes('javaScript'),
  );
  assert.ok(fetchedJsVersion, 'POST /rest/node-types must expose JavaScript languageVersion');
});

test('deserializeRustExecutionResult correctly flags error status and resultData.error on node error', () => {
  const mockResponseWithNodeError = {
    status: 'success', // Simulated misleading top-level status
    data: {
      id: 'mock-exec-1',
      status: 'success',
      resultData: {
        runData: {
          Code: [
            {
              executionIndex: 0,
              executionStatus: 'error',
              error: { message: 'ReferenceError: foo is not defined' },
              data: { main: [[]] },
            },
          ],
        },
      },
    },
  };

  const result = deserializeRustExecutionResult(mockResponseWithNodeError, {
    workflowData: { id: 'test-wf', name: 'Test' },
  });

  assert.equal(result.status, 'error', 'Status must be error when a node failed');
  assert.ok(result.data.resultData.error, 'resultData.error must be populated');
  assert.equal(result.data.resultData.error.name, 'NodeExecutionError');
  assert.ok(result.data.resultData.error.message.includes('ReferenceError: foo is not defined'));
});

test('POST /rest/workflows/run correctly propagates error when code execution fails', async () => {
  const run = await api('POST', '/rest/workflows/run', {
    workflowData: {
      id: 'wf-code-error-propagate',
      name: 'Code Error Propagation Run',
      nodes: [
        {
          id: '1',
          name: 'FailingCode',
          type: 'n8n-nodes-base.code',
          typeVersion: 2,
          position: [0, 0],
          parameters: {
            language: 'javaScript',
            languageVersion: 'default',
            jsCode: 'throw new Error("Explicit error from user code");',
          },
        },
      ],
      connections: {},
    },
  });

  assert.equal(run.status, 200);
  assert.equal(run.json.data.status, 'error', 'Execution status must be error');

  const execId = run.json.data.executionId;
  const execRes = await api('GET', `/rest/executions/${execId}`);
  assert.equal(execRes.status, 200);
  assert.equal(execRes.json.data.status, 'error', 'Persisted execution status must be error');

  const { parse: flattedParse } = await import('flatted');
  const executionData = typeof execRes.json.data.data === 'string'
    ? flattedParse(execRes.json.data.data)
    : execRes.json.data.data;

  assert.ok(executionData.resultData.error, 'Persisted execution must contain resultData.error');
  assert.equal(executionData.resultData.error.name, 'NodeExecutionError');
  assert.ok(
    executionData.resultData.error.message.includes('Explicit error from user code'),
    'Error message must reflect the failure',
  );
});

test('deserializeRustExecutionResult extracts walPath into resultData.walPath', () => {
  const mockResponseWithWal = {
    status: 'success',
    walPath: '/tmp/n8n-journal/execution-123.wal',
    data: {
      id: 'mock-exec-wal',
      status: 'success',
      resultData: {
        runData: {
          Manual: [{ executionIndex: 0, executionStatus: 'success', data: { main: [[]] } }],
        },
      },
    },
  };

  const result = deserializeRustExecutionResult(mockResponseWithWal, {
    workflowData: { id: 'test-wf-wal', name: 'Test WAL' },
  });

  assert.equal(result.data.resultData.walPath, '/tmp/n8n-journal/execution-123.wal');
  assert.equal(result.walPath, '/tmp/n8n-journal/execution-123.wal');
});

test('engine enforces Rust requirement and blocks silent JS fallback when Rust is unavailable', async () => {
  const { createEngine } = await import('../src/engine.mjs');
  const mockStore = {
    executions: { insert: (r) => r },
    workflows: { get: () => null },
  };
  const mockLogger = { info: () => {}, warn: () => {}, error: () => {} };

  // Engine configured with Rust disabled (offline), but rustRequired=true
  const strictEngine = createEngine({ rustEngine: false, rustRequired: true }, mockLogger);
  const strictRecord = await strictEngine.execute({
    definition: {
      nodes: [{ id: '1', name: 'Manual', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} }],
      connections: {},
    },
    store: mockStore,
  });

  assert.equal(strictRecord.status, 'error');
  assert.equal(strictRecord.finished, true);
  assert.ok(strictRecord.data.resultData.error);
  assert.equal(strictRecord.data.resultData.error.name, 'RustUnavailableError');
  assert.ok(strictRecord.data.resultData.error.message.includes('Rust engine is required'));

  // Engine configured with rustRequired=false allows fallback to JS engine
  const fallbackEngine = createEngine({ rustEngine: false, rustRequired: false }, mockLogger);
  const fallbackRecord = await fallbackEngine.execute({
    definition: {
      nodes: [{ id: '1', name: 'Manual', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} }],
      connections: {},
    },
    store: mockStore,
  });

  assert.equal(fallbackRecord.status, 'success');
  assert.equal(fallbackRecord.finished, true);
  assert.ok(fallbackRecord.data.resultData.runData['Manual']);
});



