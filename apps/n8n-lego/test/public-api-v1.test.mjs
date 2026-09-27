/**
 * P5-M03 — public REST API `/api/v1`, first surface (boundary + workflows).
 *
 * End to end through the real server (`startServer`): keys are minted through
 * the editor flow (`/rest/api-keys`, CSRF enforced) and then used against
 * `/api/v1` exactly like an external client would.
 *
 * Upstream truth: the recorded goldens `publicApiNoKey` / `publicApiBadKey`
 * (tests/reference/agent-4/golden/api.golden.json, real n8n 2.9.4) and the
 * pinned handler/spec sources under reference/n8n/packages/cli/src/public-api.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../src/server.mjs';
import {
  PUBLIC_API_LIMITS,
  PUBLIC_API_MESSAGES,
  PUBLIC_API_OPERATIONS,
  decodeOffsetCursor,
  encodeNextCursor,
  matchPublicApiRoute,
  validateWorkflowBody,
} from '../src/auth/public-api-routes.mjs';
import { BACKING_RESOURCE_ROUTES } from '../src/auth/public-api-backing.mjs';
import { loadApiKeyScopes } from '../src/compat/api-key-scopes.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(HERE, '..');
const REPO_ROOT = resolve(APP_DIR, '..', '..');
const REPO_CATALOG = resolve(REPO_ROOT, 'data', 'n8n-lego', 'catalog');
const GOLDEN = JSON.parse(readFileSync(join(REPO_ROOT, 'tests', 'reference', 'agent-4', 'golden', 'api.golden.json'), 'utf8'));
const PASSWORD = 'PublicApi-Passw0rd';
const USER_FOLDER = mkdtempSync(join(tmpdir(), 'n8n-lego-public-api-'));

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
});

after(async () => {
  if (running) await new Promise((done) => running.close(() => done()));
  rmSync(USER_FOLDER, { recursive: true, force: true });
});

/** Editor (browser) client: cookies + CSRF, same origin. */
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
    return { status: res.status, body: text ? JSON.parse(text) : null, raw: text, jar };
  };
}

/** External API client: X-N8N-API-KEY only, no cookies, no origin. */
async function api(key, method, path, body, { rawBody, headers = {} } = {}) {
  const res = await fetch(`${base}/api/v1${path}`, {
    method,
    headers: { ...(key === undefined ? {} : { 'x-n8n-api-key': key }), ...(body !== undefined || rawBody !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    body: rawBody ?? (body === undefined ? undefined : JSON.stringify(body)),
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

const ALL_WORKFLOW_SCOPES = ['workflow:list', 'workflow:create', 'workflow:read', 'workflow:update', 'workflow:delete', 'workflow:activate', 'workflow:deactivate', 'workflowTags:list', 'workflowTags:update'];

let owner;
let fullKey;
let readOnlyKey;

async function mintKey(call, scopes, label = 'k') {
  const created = await call('POST', '/rest/api-keys', { label, scopes, expiresAt: null });
  assert.equal(created.status, 200, created.raw);
  return created.body.data;
}

const minimalWorkflow = (name = 'API workflow') => ({
  name,
  nodes: [{ name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} }],
  connections: {},
  settings: { executionOrder: 'v1' },
});

describe('boundary: upstream goldens and pipeline order', () => {
  before(async () => {
    owner = editor();
    assert.equal((await owner('POST', '/rest/owner/setup', { email: 'owner@api-v1.test', firstName: 'O', lastName: 'W', password: PASSWORD })).status, 200);
    fullKey = (await mintKey(owner, ALL_WORKFLOW_SCOPES, 'full')).rawApiKey;
    readOnlyKey = (await mintKey(owner, ['workflow:read'], 'ro')).rawApiKey;
  });

  test('publicApiNoKey golden: 401 with the exact upstream body', async () => {
    const golden = GOLDEN.cases.publicApiNoKey.expected;
    const res = await api(undefined, 'GET', '/workflows');
    assert.equal(res.status, golden.status);
    assert.deepEqual(res.body, golden.body);
    assert.match(res.type, /application\/json/);
  });

  test('publicApiBadKey golden: 401 with the exact upstream body, for every flavour of bad key', async () => {
    const golden = GOLDEN.cases.publicApiBadKey.expected;
    const tampered = fullKey.slice(0, -2) + (fullKey.endsWith('AA') ? 'BB' : 'AA');
    for (const bad of ['not-a-key', 'n8n_api_x.y.z', tampered]) {
      const res = await api(bad, 'GET', '/workflows');
      assert.equal(res.status, golden.status, bad);
      assert.deepEqual(res.body, golden.body, bad);
    }
  });

  test('/api/v1 is never answered by the editor SPA fallback', async () => {
    const res = await api(undefined, 'GET', '/workflows');
    assert.ok(!res.raw.includes('<html'), 'an API client must not receive HTML');
  });

  test('route matching runs before security: unknown path 404, wrong method 405', async () => {
    assert.deepEqual([(await api(undefined, 'GET', '/nope')).status, (await api(undefined, 'GET', '/nope')).body], [404, { message: 'not found' }]);
    const wrong = await api(fullKey, 'PATCH', '/workflows');
    assert.deepEqual([wrong.status, wrong.body], [405, { message: 'PATCH method not allowed' }]);
    // P5-M10 mounted transfer as PUT (the upstream method); POST on the known
    // path is 405 — the earlier 404 fixture was pinned to "not mounted".
    const transferViaPost = await api(fullKey, 'POST', '/workflows/abc/transfer', { destinationProjectId: 'p' });
    assert.deepEqual([transferViaPost.status, transferViaPost.body], [405, { message: 'POST method not allowed' }]);
  });

  test('a session cookie is not an API credential', async () => {
    const me = await owner('GET', '/rest/login');
    assert.equal(me.status, 200);
    const cookie = Object.entries(me.jar).map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await api(undefined, 'GET', '/workflows', undefined, { headers: { cookie } });
    assert.deepEqual([res.status, res.body], [401, { message: PUBLIC_API_MESSAGES.KEY_REQUIRED }]);
  });

  test('an API key is still not a /rest credential', async () => {
    const res = await fetch(`${base}/rest/workflows`, { headers: { 'x-n8n-api-key': fullKey } });
    assert.equal(res.status, 401);
  });

  test('key scopes are enforced: 403 Forbidden, before any side effect', async () => {
    const before = store.workflows.all().length;
    const denied = await api(readOnlyKey, 'POST', '/workflows', minimalWorkflow('denied'));
    assert.deepEqual([denied.status, denied.body], [403, { message: 'Forbidden' }]);
    assert.equal(store.workflows.all().length, before);
    assert.deepEqual([(await api(readOnlyKey, 'GET', '/workflows')).status], [403], 'read is not list');
  });

  test('invalid JSON: 400 with the upstream message', async () => {
    const res = await api(fullKey, 'POST', '/workflows', undefined, { rawBody: '{"name":' });
    assert.deepEqual([res.status, res.body], [400, { message: PUBLIC_API_MESSAGES.INVALID_JSON }]);
  });

  test('a revoked key stops working immediately', async () => {
    const key = await mintKey(owner, ['workflow:list'], 'short-lived');
    assert.equal((await api(key.rawApiKey, 'GET', '/workflows')).status, 200);
    assert.equal((await owner('DELETE', `/rest/api-keys/${key.id}`)).status, 200);
    assert.deepEqual((await api(key.rawApiKey, 'GET', '/workflows')).body, { message: 'unauthorized' });
  });

  test('owner demotion shrinks a key on the next request (effective = key ∩ current grant)', async () => {
    const memberCall = editor();
    const ownerRecord = store.users.all().find((u) => u.email === 'owner@api-v1.test');
    const memberId = 'member-api-v1';
    store.users.insert({ ...ownerRecord, id: memberId, email: 'member@api-v1.test', role: 'global:admin', apiKeys: [] });
    assert.equal((await memberCall('POST', '/rest/login', { emailOrLdapLoginId: 'member@api-v1.test', password: PASSWORD })).status, 200);
    const key = (await mintKey(memberCall, ['workflow:list', 'user:list'], 'admin-key')).rawApiKey;
    assert.equal((await api(key, 'GET', '/workflows')).status, 200);
    store.users.update(memberId, { role: 'global:chatUser' });
    // The key still authenticates, but key ∩ current grant is now empty.
    assert.deepEqual((await api(key, 'GET', '/workflows')).body, { message: 'Forbidden' }, 'a role with no key scopes loses all authority');
  });
});

describe('workflows resource', () => {
  let created;

  test('create validates the pinned schema and returns the workflow (inactive, fresh version)', async () => {
    const missing = await api(fullKey, 'POST', '/workflows', { name: 'x', nodes: [], connections: {} });
    assert.deepEqual([missing.status, missing.body], [400, { message: "request/body must have required property 'settings'" }]);
    const extra = await api(fullKey, 'POST', '/workflows', { ...minimalWorkflow(), bogus: 1 });
    assert.deepEqual(extra.body, { message: 'request/body must NOT have additional properties' });
    const readOnly = await api(fullKey, 'POST', '/workflows', { ...minimalWorkflow(), active: true });
    assert.equal(readOnly.status, 400);
    assert.match(readOnly.body.message, /active/);
    assert.match(readOnly.body.message, /read-only/);
    const badSetting = await api(fullKey, 'POST', '/workflows', { ...minimalWorkflow(), settings: { nope: true } });
    assert.deepEqual(badSetting.body, { message: 'request/body/settings must NOT have additional properties' });

    const res = await api(fullKey, 'POST', '/workflows', { ...minimalWorkflow('Created via API'), staticData: '{"lastId":1}' });
    assert.equal(res.status, 200, res.raw);
    created = res.body;
    assert.equal(created.name, 'Created via API');
    assert.equal(created.active, false);
    assert.equal(created.activeVersionId, null);
    assert.ok(created.versionId);
    assert.deepEqual(created.staticData, { lastId: 1 });
    assert.ok(created.nodes[0].id, 'node ids are assigned (addNodeIds)');
    assert.deepEqual(created.tags, []);
    assert.ok(!('scopes' in created) && !('checksum' in created), 'the public DTO is not the editor DTO');
    assert.ok(store.workflows.get(created.id), 'persisted in the same store the editor reads');
  });

  test('get: 200, excludePinnedData, 404 Not Found', async () => {
    const got = await api(fullKey, 'GET', `/workflows/${created.id}`);
    assert.equal(got.status, 200);
    assert.deepEqual(got.body.pinData, {});
    const slim = await api(fullKey, 'GET', `/workflows/${created.id}?excludePinnedData=true`);
    assert.ok(!('pinData' in slim.body));
    assert.equal((await api(fullKey, 'GET', `/workflows/${created.id}?excludePinnedData=maybe`)).status, 400);
    const missing = await api(fullKey, 'GET', '/workflows/does-not-exist');
    assert.deepEqual([missing.status, missing.body], [404, { message: 'Not Found' }]);
  });

  test('the editor sees an API-created workflow', async () => {
    const res = await owner('GET', `/rest/workflows/${created.id}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.data.name, 'Created via API');
  });

  test('update replaces the definition, bumps the version, rejects read-only fields', async () => {
    const rejected = await api(fullKey, 'PUT', `/workflows/${created.id}`, { ...minimalWorkflow('x'), active: true });
    assert.equal(rejected.status, 400);
    assert.match(rejected.body.message, /active.*read-only/);
    const res = await api(fullKey, 'PUT', `/workflows/${created.id}`, minimalWorkflow('Renamed'));
    assert.equal(res.status, 200, res.raw);
    assert.equal(res.body.name, 'Renamed');
    assert.notEqual(res.body.versionId, created.versionId);
    assert.equal((await api(fullKey, 'PUT', '/workflows/nope', minimalWorkflow())).status, 404);
    created = res.body;
  });

  test('activate publishes the current version; update of an active workflow re-publishes; deactivate clears it', async () => {
    const on = await api(fullKey, 'POST', `/workflows/${created.id}/activate`);
    assert.equal(on.status, 200, on.raw);
    assert.equal(on.body.active, true);
    assert.equal(on.body.activeVersionId, created.versionId);
    const updated = await api(fullKey, 'PUT', `/workflows/${created.id}`, minimalWorkflow('Renamed again'));
    assert.equal(updated.body.activeVersionId, updated.body.versionId, 'publishIfActive');
    const off = await api(fullKey, 'POST', `/workflows/${created.id}/deactivate`);
    assert.deepEqual([off.body.active, off.body.activeVersionId], [false, null]);
    assert.equal((await api(fullKey, 'POST', '/workflows/nope/activate')).status, 404);
  });

  test('tags: get and replace, unknown tag 404 "Some tags not found"', async () => {
    const tag = (await owner('POST', '/rest/tags', { name: 'prod' })).body.data;
    assert.ok(tag?.id, 'tag created through the editor');
    assert.deepEqual((await api(fullKey, 'GET', `/workflows/${created.id}/tags`)).body, []);
    const set = await api(fullKey, 'PUT', `/workflows/${created.id}/tags`, [{ id: tag.id }]);
    assert.equal(set.status, 200, set.raw);
    assert.deepEqual(set.body.map((t) => t.name), ['prod']);
    assert.deepEqual((await api(fullKey, 'GET', `/workflows/${created.id}`)).body.tags.map((t) => t.id), [tag.id]);
    const unknown = await api(fullKey, 'PUT', `/workflows/${created.id}/tags`, [{ id: 'missing-tag' }]);
    assert.deepEqual([unknown.status, unknown.body], [404, { message: 'Some tags not found' }]);
    assert.equal((await api(fullKey, 'PUT', `/workflows/${created.id}/tags`, { id: tag.id })).status, 400);
  });

  test('list: filters (name, active, tags intersection) and cursor pagination', async () => {
    for (let i = 0; i < 5; i += 1) {
      assert.equal((await api(fullKey, 'POST', '/workflows', minimalWorkflow(`Paged ${i}`))).status, 200);
    }
    const all = await api(fullKey, 'GET', '/workflows');
    assert.equal(all.status, 200);
    assert.equal(all.body.nextCursor, null);
    const total = all.body.data.length;
    assert.ok(total >= 6);

    const pages = [];
    let cursor = null;
    let first = await api(fullKey, 'GET', '/workflows?limit=2');
    pages.push(...first.body.data.map((w) => w.id));
    cursor = first.body.nextCursor;
    while (cursor) {
      const next = await api(fullKey, 'GET', `/workflows?cursor=${encodeURIComponent(cursor)}`);
      assert.equal(next.status, 200);
      assert.ok(next.body.data.length <= 2, 'the cursor carries the page size');
      pages.push(...next.body.data.map((w) => w.id));
      cursor = next.body.nextCursor;
    }
    assert.deepEqual(pages, all.body.data.map((w) => w.id), 'pages concatenate to the full list, no gaps or repeats');

    assert.deepEqual((await api(fullKey, 'GET', '/workflows?name=paged%203')).body.data.map((w) => w.name), ['Paged 3']);
    await api(fullKey, 'POST', `/workflows/${first.body.data[0].id}/activate`);
    assert.ok((await api(fullKey, 'GET', '/workflows?active=true')).body.data.every((w) => w.active));
    assert.ok((await api(fullKey, 'GET', '/workflows?active=false')).body.data.every((w) => !w.active));
    assert.deepEqual((await api(fullKey, 'GET', '/workflows?tags=prod')).body.data.map((w) => w.id), [created.id]);
    assert.deepEqual((await api(fullKey, 'GET', '/workflows?tags=unknown')).body.data, []);
    assert.ok(!('pinData' in (await api(fullKey, 'GET', '/workflows?excludePinnedData=true')).body.data[0]));

    const tooMany = await api(fullKey, 'GET', '/workflows?limit=251');
    assert.deepEqual([tooMany.status, tooMany.body], [400, { message: 'request/query/limit must be <= 250' }]);
    const badCursor = await api(fullKey, 'GET', '/workflows?cursor=%%%');
    assert.deepEqual([badCursor.status, badCursor.body], [400, { message: 'An invalid cursor was provided' }]);
  });

  test('delete returns the deleted workflow, then 404', async () => {
    const res = await api(fullKey, 'DELETE', `/workflows/${created.id}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.id, created.id);
    assert.equal(store.workflows.get(created.id), null);
    assert.equal((await api(fullKey, 'DELETE', `/workflows/${created.id}`)).status, 404);
  });
});

describe('pure pieces', () => {
  test('every mounted operation is guarded by a scope from the pinned API-key vocabulary', () => {
    const vocabulary = new Set(loadApiKeyScopes({}).all);
    for (const op of [...PUBLIC_API_OPERATIONS, ...BACKING_RESOURCE_ROUTES]) {
      // `public` is the one operation upstream mounts with no scope guard at
      // all: GET /credentials/schema/{type} publishes a schema, never a secret.
      if (op.scope === 'public') continue;
      assert.ok(vocabulary.has(op.scope), `${op.method} ${op.path} -> ${op.scope}`);
    }
    assert.equal(PUBLIC_API_OPERATIONS.length, 31,
      'P5-M03 workflows (9) + P5-M08 tags (5), variables (4), executions (3) + P5-M09 credentials (5), users (5)');
    assert.equal(BACKING_RESOURCE_ROUTES.length, 26,
      'P5-M10 backing resources (26 routes over the 8 backing models)');
  });

  test('cursor encoding matches upstream encodeNextCursor', () => {
    assert.equal(encodeNextCursor({ offset: 0, limit: 2, numberOfTotalRecords: 2 }), null);
    const next = encodeNextCursor({ offset: 0, limit: 2, numberOfTotalRecords: 3 });
    assert.deepEqual(JSON.parse(Buffer.from(next, 'base64').toString()), { limit: 2, offset: 2 });
    assert.deepEqual(decodeOffsetCursor(next), { offset: 2, limit: 2 });
    const oversized = Buffer.from(JSON.stringify({ limit: PUBLIC_API_LIMITS.MAX_LIMIT + 1, offset: 0 })).toString('base64');
    assert.throws(() => decodeOffsetCursor(oversized), /invalid cursor/);
  });

  test('route matcher distinguishes 404 from 405', () => {
    assert.equal(matchPublicApiRoute('GET', '/workflows/abc').params.id, 'abc');
    // P5-M10 mounted /projects; /docs stays unmounted (DEC-0022) and is the
    // representative unknown path here.
    assert.throws(() => matchPublicApiRoute('GET', '/docs'), (e) => e.status === 404);
    assert.throws(() => matchPublicApiRoute('PATCH', '/workflows/abc'), (e) => e.status === 405);
    // A known path with an unmounted method is 405, not 404: upstream mounts
    // no GET on /credentials/{id}, and no PUT either (the update is PATCH).
    assert.throws(() => matchPublicApiRoute('GET', '/credentials/abc'), (e) => e.status === 405);
    assert.throws(() => matchPublicApiRoute('PUT', '/credentials/abc'), (e) => e.status === 405);
    assert.equal(matchPublicApiRoute('PATCH', '/credentials/abc').params.id, 'abc');
  });

  test('schema validation of nodes', () => {
    assert.throws(() => validateWorkflowBody({ ...minimalWorkflow(), nodes: [{ name: 'a', extra: 1 }] }), /nodes\/0 must NOT have additional properties/);
    assert.throws(() => validateWorkflowBody({ ...minimalWorkflow(), nodes: [{ name: 'a', createdAt: 'x' }] }), /nodes\/0\/createdAt is read-only/);
    assert.throws(() => validateWorkflowBody({ ...minimalWorkflow(), nodes: [{ position: ['a'] }] }), /position/);
    assert.throws(() => validateWorkflowBody({ ...minimalWorkflow(), staticData: '{bad' }), /jsonString/);
    assert.doesNotThrow(() => validateWorkflowBody(minimalWorkflow()));
  });
});
