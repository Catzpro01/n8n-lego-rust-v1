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
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../src/server.mjs';

/**
 * The catalog (node types, icons, roles) is fetched per install, not committed —
 * `npm run lego:catalog` writes it into the user folder. The smoke test therefore
 * points the server at the checkout's copy and keeps every other file it writes
 * inside a throwaway directory.
 */
const REPO_CATALOG = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'data', 'n8n-lego', 'catalog');
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
  const runData = execution.json.data.data.resultData.runData;
  assert.deepEqual(Object.keys(runData), ['Manual', 'Edit Fields']);
  assert.deepEqual(runData['Edit Fields'][0].data.main[0][0].json, { status: 'ok' });

  const history = await api('GET', '/rest/executions?limit=5');
  assert.equal(history.json.data.count, 1);

  const removed = await api('DELETE', `/rest/workflows/${workflowId}`);
  assert.equal(removed.status, 200);
  assert.equal((await api('GET', '/rest/workflows')).json.count, 0);
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
