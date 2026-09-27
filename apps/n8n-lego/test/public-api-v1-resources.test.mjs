/**
 * P5-M08 — public REST API `/api/v1`: tags, variables, executions and
 * `openapi.yml`.
 *
 * End to end through the real server (`startServer`), keys minted through the
 * editor flow, then used like an external client. Upstream truth: the pinned
 * handlers/specs under reference/n8n/packages/cli/src/public-api/v1 (n8n
 * 2.9.4) and `@n8n/db` ExecutionRepository public-API queries.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../src/server.mjs';
import {
  PUBLIC_API_LICENSED_FEATURES,
  PUBLIC_API_OPERATIONS,
  decodeCursor,
  encodeLastIdCursor,
  featureNotLicensedMessage,
  toYaml,
} from '../src/auth/public-api-routes.mjs';
import { BACKING_RESOURCE_ROUTES } from '../src/auth/public-api-backing.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(HERE, '..');
const REPO_CATALOG = resolve(APP_DIR, '..', '..', 'data', 'n8n-lego', 'catalog');
const SPEC = JSON.parse(readFileSync(join(APP_DIR, 'data', 'public-api-openapi.json'), 'utf8'));
const PASSWORD = 'PublicApi-Passw0rd';
const USER_FOLDER = mkdtempSync(join(tmpdir(), 'n8n-lego-public-api-m08-'));
const VARIABLES_403 = { message: featureNotLicensedMessage('feat:variables') };

let running;
let store;
let base;

before(async () => {
  const started = await startServer({
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
  running = started.server;
  store = started.store;
  base = `http://127.0.0.1:${running.address().port}`;
  await setupOwnerAndKeys();
});

after(async () => {
  if (running) await new Promise((done) => running.close(() => done()));
  rmSync(USER_FOLDER, { recursive: true, force: true });
});

function editor() {
  const jar = {};
  return async (method, path, body) => {
    const headers = { 'content-type': 'application/json', origin: base };
    const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookie) headers.cookie = cookie;
    if (jar['n8n-csrf']) headers['x-n8n-csrf-token'] = jar['n8n-csrf'];
    const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      jar[pair.slice(0, i)] = pair.slice(i + 1);
    }
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null, raw: text };
  };
}

async function api(key, method, path, body) {
  const res = await fetch(`${base}/api/v1${path}`, {
    method,
    headers: { ...(key === undefined ? {} : { 'x-n8n-api-key': key }), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* not json */
  }
  return { status: res.status, body: json, raw: text, type: res.headers.get('content-type') ?? '' };
}

const TAG_SCOPES = ['tag:create', 'tag:read', 'tag:update', 'tag:delete', 'tag:list'];
const VARIABLE_SCOPES = ['variable:create', 'variable:update', 'variable:delete', 'variable:list'];
const EXECUTION_SCOPES = ['execution:list', 'execution:read', 'execution:delete'];
const WORKFLOW_SCOPES = ['workflow:create', 'workflow:read', 'workflowTags:list', 'workflowTags:update'];

let owner;
let fullKey;
let workflowOnlyKey;
let executionReadKey;

async function mintKey(call, scopes, label) {
  const created = await call('POST', '/rest/api-keys', { label, scopes, expiresAt: null });
  assert.equal(created.status, 200, created.raw);
  return created.body.data.rawApiKey;
}

const minimalWorkflow = (name) => ({
  name,
  nodes: [{ name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} }],
  connections: {},
  settings: { executionOrder: 'v1' },
});

async function setupOwnerAndKeys() {
  owner = editor();
  assert.equal((await owner('POST', '/rest/owner/setup', { email: 'owner@api-m08.test', firstName: 'O', lastName: 'W', password: PASSWORD })).status, 200);
  fullKey = await mintKey(owner, [...TAG_SCOPES, ...VARIABLE_SCOPES, ...EXECUTION_SCOPES, ...WORKFLOW_SCOPES], 'full');
  workflowOnlyKey = await mintKey(owner, ['workflow:read'], 'wf');
  executionReadKey = await mintKey(owner, ['execution:read'], 'exec-read');
}

/* ------------------------------------------------------------ openapi.yml */

describe('openapi.yml', () => {
  test('served without a key, as YAML, upstream route shape', async () => {
    const res = await api(undefined, 'GET', '/openapi.yml');
    assert.equal(res.status, 200);
    assert.match(res.type, /^text\/yaml/);
    assert.ok(res.raw.startsWith('---\n"openapi": "3.0.0"\n'));
    assert.equal((await api(undefined, 'POST', '/openapi.yml')).status, 404, 'only GET is registered');
  });

  test('advertises exactly the mounted operations, nothing unmounted', () => {
    const fromSpec = Object.entries(SPEC.paths)
      .flatMap(([path, item]) => Object.keys(item).map((method) => `${method.toUpperCase()} ${path}`))
      .sort();
    // P5-M10: the spec covers the FULL build — base operations plus the backing
    // resources (the earlier fixture listed those paths as unmounted).
    const mounted = [...PUBLIC_API_OPERATIONS, ...BACKING_RESOURCE_ROUTES]
      .map((op) => `${op.method} ${op.path.replace(/:([A-Za-z]+)/g, '{$1}')}`).sort();
    assert.deepEqual(fromSpec, mounted);
    assert.equal(SPEC['x-n8n-lego'].operations, PUBLIC_API_OPERATIONS.length + BACKING_RESOURCE_ROUTES.length);
    for (const unmounted of ['/docs', '/securityAudit', '/metrics']) {
      assert.equal(SPEC.paths[unmounted], undefined, unmounted);
    }
    const text = JSON.stringify(SPEC);
    for (const ref of text.matchAll(/"\$ref":"([^"]+)"/g)) {
      assert.match(ref[1], /^#\/components\/schemas\//, 'no file $ref survives');
      assert.ok(SPEC.components.schemas[ref[1].split('/').pop()], `dangling ${ref[1]}`);
    }
    assert.deepEqual(SPEC.security, [{ ApiKeyAuth: [] }]);
  });

  test('toYaml: JSON-quoted scalars, empty collections inline', () => {
    assert.equal(toYaml({ a: 'x: y', b: [1, true, null], c: {}, d: [] }), '"a": "x: y"\n"b":\n  - 1\n  - true\n  - null\n"c": {}\n"d": []');
    assert.equal(toYaml([{ k: 'v' }]), '-\n  "k": "v"');
  });
});

/* ------------------------------------------------------------------ tags */

describe('tags', () => {
  let wfId;
  let tag;

  test('body validation (400) runs before the key scope (403)', async () => {
    const readOnly = await api(workflowOnlyKey, 'POST', '/tags', { id: 'x', name: 'n' });
    assert.deepEqual([readOnly.status, readOnly.body], [400, { message: 'request/body/id is read-only' }]);
    const extra = await api(fullKey, 'POST', '/tags', { name: 'n', colour: 'red' });
    assert.deepEqual(extra.body, { message: 'request/body must NOT have additional properties' });
    assert.deepEqual((await api(fullKey, 'POST', '/tags', {})).body, { message: "request/body must have required property 'name'" });
    assert.deepEqual((await api(fullKey, 'POST', '/tags', { name: 5 })).body, { message: 'request/body/name must be string' });
    const denied = await api(workflowOnlyKey, 'POST', '/tags', { name: 'ok' });
    assert.deepEqual([denied.status, denied.body], [403, { message: 'Forbidden' }]);
    assert.equal((await api(workflowOnlyKey, 'GET', '/tags')).status, 403);
  });

  test('create: 201, name trimmed; duplicate and invalid length are 409 like upstream', async () => {
    const created = await api(fullKey, 'POST', '/tags', { name: '  Production  ' });
    assert.equal(created.status, 201, created.raw);
    tag = created.body;
    assert.deepEqual(Object.keys(tag).sort(), ['createdAt', 'id', 'name', 'updatedAt']);
    assert.equal(tag.name, 'Production');
    for (const name of ['Production', ' Production ', '   ', 'x'.repeat(25)]) {
      const res = await api(fullKey, 'POST', '/tags', { name });
      assert.deepEqual([res.status, res.body], [409, { message: 'Tag already exists' }], JSON.stringify(name));
    }
    assert.equal((await api(fullKey, 'POST', '/tags', { name: 'y'.repeat(24) })).status, 201);
  });

  test('get: 200 and 404 Not Found', async () => {
    assert.deepEqual((await api(fullKey, 'GET', `/tags/${tag.id}`)).body, tag);
    const missing = await api(fullKey, 'GET', '/tags/nope');
    assert.deepEqual([missing.status, missing.body], [404, { message: 'Not Found' }]);
  });

  test('list: offset pagination with nextCursor; invalid cursor 400', async () => {
    for (const name of ['t1', 't2', 't3']) assert.equal((await api(fullKey, 'POST', '/tags', { name })).status, 201);
    const all = (await api(fullKey, 'GET', '/tags')).body;
    assert.equal(all.nextCursor, null);
    const seen = [];
    let page = await api(fullKey, 'GET', '/tags?limit=2');
    for (;;) {
      assert.equal(page.status, 200);
      seen.push(...page.body.data.map((t) => t.id));
      if (!page.body.nextCursor) break;
      page = await api(fullKey, 'GET', `/tags?cursor=${encodeURIComponent(page.body.nextCursor)}`);
    }
    assert.deepEqual(seen, all.data.map((t) => t.id));
    const bad = await api(fullKey, 'GET', '/tags?cursor=%%%');
    assert.deepEqual([bad.status, bad.body], [400, { message: 'An invalid cursor was provided' }]);
    assert.equal((await api(fullKey, 'GET', '/tags?limit=251')).status, 400);
  });

  test('update: rename flows into workflow tags; 404; duplicate 409', async () => {
    wfId = (await api(fullKey, 'POST', '/workflows', minimalWorkflow('tagged'))).body.id;
    assert.equal((await api(fullKey, 'PUT', `/workflows/${wfId}/tags`, [{ id: tag.id }])).status, 200);
    const renamed = await api(fullKey, 'PUT', `/tags/${tag.id}`, { name: ' Prod ' });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.name, 'Prod');
    assert.deepEqual((await api(fullKey, 'GET', `/workflows/${wfId}/tags`)).body.map((t) => t.name), ['Prod']);
    assert.deepEqual((await api(fullKey, 'PUT', `/tags/${tag.id}`, { name: 'Prod' })).status, 200, 'renaming to itself is fine');
    assert.deepEqual((await api(fullKey, 'PUT', `/tags/${tag.id}`, { name: 't1' })).body, { message: 'Tag already exists' });
    assert.deepEqual((await api(fullKey, 'PUT', '/tags/nope', { name: 'z' })).status, 404);
  });

  test('delete: returns the tag, detaches it from workflows, then 404', async () => {
    const deleted = await api(fullKey, 'DELETE', `/tags/${tag.id}`);
    assert.equal(deleted.status, 200);
    assert.equal(deleted.body.id, tag.id);
    assert.deepEqual((await api(fullKey, 'GET', `/workflows/${wfId}/tags`)).body, []);
    assert.equal((await api(fullKey, 'DELETE', `/tags/${tag.id}`)).status, 404);
  });
});

/* ------------------------------------------------------------- variables */

describe('variables (community edition: feat:variables unlicensed)', () => {
  test('no enterprise feature is licensed in this build', () => {
    assert.deepEqual(PUBLIC_API_LICENSED_FEATURES, []);
  });

  test('every operation answers the upstream licence 403, before the key scope', async () => {
    for (const key of [fullKey, workflowOnlyKey]) {
      for (const [method, path, body] of [
        ['GET', '/variables'],
        ['POST', '/variables', { key: 'k', value: 'v' }],
        ['PUT', '/variables/abc', { key: 'k', value: 'v' }],
        ['DELETE', '/variables/abc'],
      ]) {
        const res = await api(key, method, path, body);
        assert.deepEqual([res.status, res.body], [403, VARIABLES_403], `${method} ${path}`);
      }
    }
  });

  test('schema validation (400) still runs first, like express-openapi-validator', async () => {
    assert.deepEqual((await api(fullKey, 'POST', '/variables', { key: 'k' })).body, { message: "request/body must have required property 'value'" });
    assert.deepEqual((await api(fullKey, 'PUT', '/variables/a', { key: 'k', value: 1 })).body, { message: 'request/body/value must be string' });
    assert.deepEqual((await api(fullKey, 'POST', '/variables', { id: 'x', key: 'k', value: 'v' })).body, { message: 'request/body/id is read-only' });
    assert.deepEqual((await api(fullKey, 'GET', '/variables?state=full')).body, { message: 'request/query/state must be equal to one of the allowed values: empty' });
    assert.equal((await api(undefined, 'GET', '/variables')).status, 401, 'security still runs before everything');
  });
});

/* ------------------------------------------------------------ executions */

describe('executions', () => {
  let wfA;
  let wfB;
  let realId;
  const seeded = {};

  before(async () => {
    wfA = (await api(fullKey, 'POST', '/workflows', minimalWorkflow('exec A'))).body.id;
    wfB = (await api(fullKey, 'POST', '/workflows', minimalWorkflow('exec B'))).body.id;
    // One real execution through the engine.
    const run = await owner('POST', `/rest/workflows/${wfA}/run`, {});
    assert.equal(run.status, 200, run.raw);
    realId = String(run.body.data.executionId ?? run.body.data.id);
    const insert = (id, status, workflowId) => {
      seeded[id] = store.executions.insert({
        id: String(id),
        finished: status !== 'running' && status !== 'waiting',
        mode: 'trigger',
        status,
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, id % 60)).toISOString(),
        startedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, id % 60)).toISOString(),
        stoppedAt: status === 'running' ? null : new Date(Date.UTC(2026, 0, 1, 0, 1, id % 60)).toISOString(),
        workflowId,
        data: { resultData: { runData: { Start: [] } } },
        workflowData: { name: 'seeded' },
      });
    };
    insert(9001, 'success', wfA);
    insert(9002, 'error', wfA);
    insert(9003, 'crashed', wfB);
    insert(9004, 'running', wfB);
    insert(9005, 'waiting', wfB);
    insert(9006, 'canceled', wfA);
    insert(9007, 'success', null); // ad-hoc run, no saved workflow
    insert(9008, 'success', 'deleted-workflow');
  });

  const ids = (res) => res.body.data.map((e) => e.id);

  test('scope: read is not list, and list/delete need their own scope', async () => {
    assert.deepEqual((await api(executionReadKey, 'GET', '/executions')).status, 403);
    assert.deepEqual((await api(executionReadKey, 'DELETE', '/executions/9001')).status, 403);
    assert.equal((await api(executionReadKey, 'GET', '/executions/9001')).status, 200);
  });

  test('list: id DESC, running excluded, only executions of existing workflows', async () => {
    const res = await api(fullKey, 'GET', '/executions');
    assert.equal(res.status, 200);
    assert.deepEqual(ids(res), ['9006', '9005', '9003', '9002', '9001', realId]);
    assert.equal(res.body.nextCursor, null);
    assert.deepEqual(Object.keys(res.body.data[0]).sort(), ['finished', 'id', 'mode', 'retryOf', 'retrySuccessId', 'startedAt', 'status', 'stoppedAt', 'waitTill', 'workflowId']);
  });

  test('list filters: status (error covers crashed), running on request, workflowId', async () => {
    assert.deepEqual(ids(await api(fullKey, 'GET', '/executions?status=error')), ['9003', '9002']);
    assert.deepEqual(ids(await api(fullKey, 'GET', '/executions?status=running')), ['9004']);
    assert.deepEqual(ids(await api(fullKey, 'GET', '/executions?status=canceled')), ['9006']);
    assert.deepEqual(ids(await api(fullKey, 'GET', `/executions?workflowId=${wfB}`)), ['9005', '9003']);
    const unknown = await api(fullKey, 'GET', '/executions?workflowId=deleted-workflow');
    assert.deepEqual([unknown.status, unknown.body], [200, { data: [], nextCursor: null }]);
    const badStatus = await api(fullKey, 'GET', '/executions?status=crashed');
    assert.deepEqual([badStatus.status, badStatus.body], [400, { message: 'request/query/status must be equal to one of the allowed values: canceled, error, running, success, waiting' }]);
    assert.deepEqual((await api(fullKey, 'GET', '/executions?includeData=yes')).body, { message: 'request/query/includeData must be boolean' });
  });

  test('list: lastId cursor pages through everything exactly once', async () => {
    const seen = [];
    let page = await api(fullKey, 'GET', '/executions?limit=2');
    for (;;) {
      assert.equal(page.status, 200);
      seen.push(...ids(page));
      if (!page.body.nextCursor) break;
      assert.deepEqual(Object.keys(JSON.parse(Buffer.from(page.body.nextCursor, 'base64').toString())), ['lastId', 'limit']);
      page = await api(fullKey, 'GET', `/executions?cursor=${encodeURIComponent(page.body.nextCursor)}`);
    }
    assert.deepEqual(seen, ['9006', '9005', '9003', '9002', '9001', realId]);
    assert.equal((await api(fullKey, 'GET', '/executions?cursor=bm9wZQ==')).status, 400);
  });

  test('includeData adds data, workflowData and customData', async () => {
    const withData = await api(fullKey, 'GET', `/executions?includeData=true&workflowId=${wfA}&limit=1`);
    assert.deepEqual(withData.body.data[0].data, seeded[9006].data);
    assert.deepEqual(withData.body.data[0].workflowData, { name: 'seeded' });
    assert.deepEqual(withData.body.data[0].customData, {});
  });

  test('get: every entity column, includeData, 400 non-numeric, 404 inaccessible', async () => {
    const plain = await api(fullKey, 'GET', '/executions/9002');
    assert.equal(plain.status, 200);
    assert.deepEqual(Object.keys(plain.body).sort(), ['createdAt', 'deletedAt', 'finished', 'id', 'mode', 'retryOf', 'retrySuccessId', 'startedAt', 'status', 'stoppedAt', 'storedAt', 'waitTill', 'workflowId']);
    assert.equal(plain.body.status, 'error');
    const real = await api(fullKey, 'GET', `/executions/${realId}?includeData=true`);
    assert.equal(real.body.workflowId, wfA);
    assert.ok(real.body.data.resultData, 'real engine run data is served');
    const nonNumeric = await api(fullKey, 'GET', '/executions/abc');
    assert.deepEqual([nonNumeric.status, nonNumeric.body], [400, { message: 'request/params/id must be number' }]);
    for (const id of ['9007', '9008', '424242']) {
      assert.deepEqual((await api(fullKey, 'GET', `/executions/${id}`)).body, { message: 'Not Found' }, id);
    }
  });

  test('delete: running is 400, otherwise returns the execution and removes it', async () => {
    const runningDelete = await api(fullKey, 'DELETE', '/executions/9004');
    assert.deepEqual([runningDelete.status, runningDelete.body], [400, { message: 'Cannot delete a running execution' }]);
    const deleted = await api(fullKey, 'DELETE', '/executions/9001');
    assert.equal(deleted.status, 200);
    assert.equal(deleted.body.id, '9001');
    assert.equal(deleted.body.data, undefined, 'no run data in the delete response');
    assert.equal(store.executions.get('9001'), null);
    assert.equal((await api(fullKey, 'DELETE', '/executions/9001')).status, 404);
    // P5-M10 mounted retry as POST (the upstream method); GET on the known
    // path is 405 — the earlier 404 fixture was pinned to "not mounted".
    assert.equal((await api(fullKey, 'GET', '/executions/1/retry')).status, 405, 'retry is mounted as POST only');
  });
});

/* -------------------------------------------------------------- cursors */

describe('cursor helpers', () => {
  test('decodeCursor accepts both upstream flavours and rejects garbage', () => {
    const offset = Buffer.from(JSON.stringify({ limit: 5, offset: 10 })).toString('base64');
    assert.deepEqual(decodeCursor(offset), { offset: 10, limit: 5 });
    assert.deepEqual(decodeCursor(encodeLastIdCursor({ lastId: '42', limit: 3, numberOfNextRecords: 1 })), { lastId: '42', limit: 3 });
    assert.equal(encodeLastIdCursor({ lastId: '42', limit: 3, numberOfNextRecords: 0 }), null);
    for (const bad of ['%%%', Buffer.from('[1]').toString('base64'), Buffer.from('{"lastId":"x","limit":2}').toString('base64'), Buffer.from('{"lastId":"1","limit":999}').toString('base64')]) {
      assert.throws(() => decodeCursor(bad), (e) => e.status === 400 && e.message === 'An invalid cursor was provided', bad);
    }
  });
});
