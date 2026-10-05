/**
 * P5-M10 CP-02/CP-03 — end-to-end contract for the /api/v1 backing resources
 * (projects, audit, source-control, data-tables, workflow/credential transfer,
 * workflow versions, execution retry, execution tags) through the real server.
 *
 * Guardrails verified here: contract + HTTP semantics per resource; request ->
 * model -> response mapping (writes through HTTP are readable through the
 * backing models — the P8 facade is the only store, no hidden state); error
 * propagation through the closed mapping; the auth boundary (pinned scopes,
 * fail-closed 403); deterministic responses.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../src/server.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(HERE, '..');
const REPO_CATALOG = resolve(APP_DIR, '..', '..', 'data', 'n8n-lego', 'catalog');
const PASSWORD = 'BackingApi-Passw0rd';
const USER_FOLDER = mkdtempSync(join(tmpdir(), 'n8n-lego-public-api-m10-'));

let running;
let store;
let backing;
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
  backing = started.backing;
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
    headers: {
      ...(key === undefined ? {} : { 'x-n8n-api-key': key }),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* not json (204, or raw text) */
  }
  return { status: res.status, body: json, raw: text };
}

let owner;
let fullKey;
let narrowKey;

const ALL_SCOPES = [
  'project:create', 'project:update', 'project:delete', 'project:list',
  'user:list', 'securityAudit:generate', 'sourceControl:pull',
  'dataTable:create', 'dataTable:read', 'dataTable:update', 'dataTable:delete', 'dataTable:list',
  'dataTableRow:create', 'dataTableRow:read', 'dataTableRow:update', 'dataTableRow:delete', 'dataTableRow:upsert',
  'execution:retry', 'executionTags:list', 'executionTags:update',
  'workflow:read', 'workflow:move', 'workflow:create', 'workflow:list',
  'credential:move', 'credential:create',
];

async function mintKey(call, scopes, label) {
  const created = await call('POST', '/rest/api-keys', { label, scopes, expiresAt: null });
  assert.equal(created.status, 200, created.raw);
  return created.body.data.rawApiKey;
}

async function setupOwnerAndKeys() {
  owner = editor();
  assert.equal((await owner('POST', '/rest/owner/setup', { email: 'owner@api-m10.test', firstName: 'O', lastName: 'W', password: PASSWORD })).status, 200);
  fullKey = await mintKey(owner, ALL_SCOPES, 'full');
  narrowKey = await mintKey(owner, ['workflow:list'], 'narrow');
}

/* ------------------------------------------------------------- auth boundary */

describe('auth boundary (pinned vocabulary, fail-closed)', () => {
  test('missing key 401, bad key 401, key without the scope 403', async () => {
    assert.equal((await api(undefined, 'GET', '/projects')).status, 401);
    assert.equal((await api('not-a-real-key', 'GET', '/projects')).status, 401);
    const denied = await api(narrowKey, 'GET', '/projects');
    assert.equal(denied.status, 403);
    assert.deepEqual(denied.body, { message: 'Forbidden' });
    assert.equal((await api(fullKey, 'GET', '/projects')).status, 200);
  });
});

/* ------------------------------------------------------------------ projects */

describe('projects resource over the M11 sharing model', () => {
  let projectId;

  test('POST /projects 201 with the project DTO; invalid body 400', async () => {
    const bad = await api(fullKey, 'POST', '/projects', { id: 'nope' });
    assert.equal(bad.status, 400);
    const created = await api(fullKey, 'POST', '/projects', { name: 'Growth' });
    assert.equal(created.status, 201);
    assert.equal(created.body.name, 'Growth');
    assert.equal(created.body.type, 'team');
    assert.ok(created.body.id);
    projectId = created.body.id;
    // request -> model -> response: the model holds exactly what the API returned
    const record = backing.projects.getProject(projectId);
    assert.equal(record.name, 'Growth');
  });

  test('GET /projects lists {data,nextCursor}; deterministic across calls', async () => {
    const first = await api(fullKey, 'GET', '/projects');
    const second = await api(fullKey, 'GET', '/projects');
    assert.equal(first.status, 200);
    assert.ok(Array.isArray(first.body.data));
    assert.ok('nextCursor' in first.body);
    assert.equal(first.raw, second.raw, 'byte-identical: deterministic');
    assert.ok(first.body.data.some((project) => project.id === projectId));
  });

  test('PUT /projects/{id} renames (204 empty); DELETE archives (204) and the model shows it', async () => {
    const renamed = await api(fullKey, 'PUT', `/projects/${projectId}`, { name: 'Growth II' });
    assert.equal(renamed.status, 204);
    assert.equal(renamed.raw, '');
    assert.equal(backing.projects.getProject(projectId).name, 'Growth II');
    const archived = await api(fullKey, 'DELETE', `/projects/${projectId}`);
    assert.equal(archived.status, 204);
    assert.equal(backing.projects.getProject(projectId).archived, true);
  });

  test('project members: add (201), list (roles prefixed), change (204), delete (204)', async () => {
    const created = await api(fullKey, 'POST', '/projects', { name: 'Members' });
    const id = created.body.id;
    const added = await api(fullKey, 'POST', `/projects/${id}/users`, {
      relations: [{ userId: 'user-1@example.test', role: 'project:editor' }],
    });
    assert.equal(added.status, 201);
    const listed = await api(fullKey, 'GET', `/projects/${id}/users`);
    assert.equal(listed.status, 200);
    assert.equal(listed.body.data.length, 2, 'creator (owner) + the added member');
    assert.deepEqual(listed.body.data.find((m) => m.userId === 'user-1@example.test')?.role, 'project:editor');
    const changed = await api(fullKey, 'PATCH', `/projects/${id}/users/user-1@example.test`, { role: 'project:viewer' });
    assert.equal(changed.status, 204);
    assert.equal(backing.projects.getMember(id, 'user-1@example.test').role, 'viewer');
    const removed = await api(fullKey, 'DELETE', `/projects/${id}/users/user-1@example.test`);
    assert.equal(removed.status, 204);
    assert.throws(() => backing.projects.getMember(id, 'user-1@example.test'), /not found/);
  });

  test('error propagation: unknown project 404 {message:Not Found}, bad role 400', async () => {
    const missing = await api(fullKey, 'PUT', '/projects/does-not-exist', { name: 'x' });
    assert.equal(missing.status, 404);
    assert.deepEqual(missing.body, { message: 'Not Found' });
    const badRole = await api(fullKey, 'POST', '/projects', { name: 'Roles' });
    await api(fullKey, 'POST', `/projects/${badRole.body.id}/users`, { relations: [{ userId: 'user-0001', role: 'project:viewer' }] });
    const attempt = await api(fullKey, 'PATCH', `/projects/${badRole.body.id}/users/user-0001`, { role: 'project:admin' });
    assert.equal(attempt.status, 400, 'the model rejects roles outside owner|editor|viewer');
  });
});

/* --------------------------------------------------------------------- audit */

describe('audit resource over the M12 audit-event model', () => {
  test('POST /audit reports the audit summary; bad options 400', async () => {
    backing.audit.append({ eventId: 'e-1', actor: 'owner@api-m10.test', action: 'login', target: 'instance' });
    backing.audit.append({ eventId: 'e-2', actor: 'owner@api-m10.test', action: 'login', target: 'instance' });
    backing.audit.append({ eventId: 'e-3', actor: 'ci', action: 'project.create', target: 'p-1' });
    const report = await api(fullKey, 'POST', '/audit', { additionalOptions: { categories: ['instance'] } });
    assert.equal(report.status, 200);
    assert.equal(report.body.summary.total, 3);
    assert.deepEqual(report.body.summary.byAction, { 'project.create': 1, login: 2 });
    assert.deepEqual(report.body.additionalOptions.categories, ['instance']);
    const bad = await api(fullKey, 'POST', '/audit', { additionalOptions: { categories: ['nope'] } });
    assert.equal(bad.status, 400);
  });
});

/* ----------------------------------------------------------- execution tags */

describe('execution tags (AnnotationTag) over the M18 tag model', () => {
  test('GET/PUT /executions/{id}/tags with model-backed tag records', async () => {
    store.executions.insert({ id: 'exec-2001', status: 'success', workflowId: 'wf-tags', mode: 'manual', startedAt: 1, stoppedAt: 2, finished: true });
    const bug = backing.executionTags.createTag({ name: 'bug' });
    const triage = backing.executionTags.createTag({ name: 'triage' });

    const empty = await api(fullKey, 'GET', '/executions/exec-2001/tags');
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.body, []);

    const set = await api(fullKey, 'PUT', '/executions/exec-2001/tags', [{ id: bug.tagId }, { id: triage.tagId }]);
    assert.equal(set.status, 200);
    assert.deepEqual(set.body.map((tag) => tag.name).sort(), ['bug', 'triage']);

    // API write is visible through the model (one facade, no hidden state)
    assert.equal(backing.executionTags.listAttachments({ executionId: 'exec-2001' }).attachments.length, 2);

    const shrink = await api(fullKey, 'PUT', '/executions/exec-2001/tags', [{ id: bug.tagId }]);
    assert.equal(shrink.status, 200);
    assert.deepEqual(shrink.body.map((tag) => tag.name), ['bug']);
  });

  test('error propagation: unknown execution 404 Not Found; unknown tag 404 "Some tags not found"', async () => {
    const missingExecution = await api(fullKey, 'GET', '/executions/exec-9999/tags');
    assert.equal(missingExecution.status, 404);
    assert.deepEqual(missingExecution.body, { message: 'Not Found' });
    const missingTag = await api(fullKey, 'PUT', '/executions/exec-2001/tags', [{ id: 'no-such-tag' }]);
    assert.equal(missingTag.status, 404);
    assert.deepEqual(missingTag.body, { message: 'Some tags not found' });
    // set-diff semantics: the failed PUT left the previous set untouched
    assert.deepEqual((await api(fullKey, 'GET', '/executions/exec-2001/tags')).body.map((t) => t.name), ['bug']);
  });
});

/* ---------------------------------------------------------- workflow versions */

describe('workflow versions over the M16 version model', () => {
  test('GET /workflows/{id}/{versionId} 200; wrong workflow or unknown 404 "Version not found"', async () => {
    const made = backing.workflowVersions.createVersion({
      workflowId: 'wf-000001', parentIds: [], diff: { nodes: 1 }, author: 'owner@api-m10.test', versionId: 'ver-000001',
    });
    assert.equal(made.versionId, 'ver-000001');
    const found = await api(fullKey, 'GET', '/workflows/wf-000001/ver-000001');
    assert.equal(found.status, 200);
    assert.equal(found.body.versionId, 'ver-000001');
    assert.equal(found.body.workflowId, 'wf-000001');
    assert.deepEqual(found.body.parentIds, []);

    const wrongWorkflow = await api(fullKey, 'GET', '/workflows/wf-000002/ver-000001');
    assert.equal(wrongWorkflow.status, 404);
    assert.deepEqual(wrongWorkflow.body, { message: 'Version not found' });
    const unknown = await api(fullKey, 'GET', '/workflows/wf-000001/nope');
    assert.equal(unknown.status, 404);
    assert.deepEqual(unknown.body, { message: 'Version not found' });
  });
});

/* ---------------------------------------------------------------- execution retry */

describe('execution retry over the M17 retry model', () => {
  test('POST /executions/{id}/retry runs the retry lifecycle once; second retry 409', async () => {
    store.executions.insert({ id: 'exec-3001', status: 'error', workflowId: 'wf-retry', mode: 'manual', startedAt: 1, stoppedAt: 2, finished: true });
    const first = await api(fullKey, 'POST', '/executions/exec-3001/retry', { loadWorkflow: true });
    assert.equal(first.status, 200);
    assert.equal(first.body.executionId, 'exec-3001');
    assert.equal(first.body.state, 'executed');
    assert.equal(first.body.requestedBy, 'owner@api-m10.test');

    // no hidden side effects: the record is in the model exactly once
    const record = backing.executionRetries.getRetry('exec-3001');
    assert.equal(record.state, 'executed');

    const second = await api(fullKey, 'POST', '/executions/exec-3001/retry');
    assert.equal(second.status, 409);
  });

  test('unknown execution 404; ineligible (succeeded) execution 409', async () => {
    assert.equal((await api(fullKey, 'POST', '/executions/exec-9999/retry')).status, 404);
    store.executions.insert({ id: 'exec-3002', status: 'success', workflowId: 'wf-ok', mode: 'manual', startedAt: 1, stoppedAt: 2, finished: true });
    const refused = await api(fullKey, 'POST', '/executions/exec-3002/retry');
    assert.equal(refused.status, 409);
  });
});

/* ---------------------------------------------------------------------- transfer */

describe('workflow/credential transfer over the M15 transfer model', () => {
  test('PUT /workflows/{id}/transfer 204 and records the transfer history', async () => {
    const project = await api(fullKey, 'POST', '/projects', { name: 'Destination' });
    const made = await api(fullKey, 'POST', '/workflows', {
      name: 'Moveable',
      nodes: [{ name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} }],
      connections: {},
      settings: { executionOrder: 'v1' },
    });
    assert.equal(made.status, 200, made.raw);
    const moved = await api(fullKey, 'PUT', `/workflows/${made.body.id}/transfer`, { destinationProjectId: project.body.id });
    assert.equal(moved.status, 204);
    const history = backing.transfers.listTransfers({}).transfers;
    assert.equal(history.length, 1);
    assert.equal(history[0].toPrincipal, project.body.id);
    assert.equal(history[0].state, 'completed');
  });

  test('bad body 400; unknown workflow 404; unknown destination project 404', async () => {
    const project = await api(fullKey, 'POST', '/projects', { name: 'P' });
    const made = await api(fullKey, 'POST', '/workflows', {
      name: 'W',
      nodes: [{ name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} }],
      connections: {},
      settings: { executionOrder: 'v1' },
    });
    assert.equal((await api(fullKey, 'PUT', `/workflows/${made.body.id}/transfer`, {})).status, 400);
    assert.equal((await api(fullKey, 'PUT', '/workflows/missing/transfer', { destinationProjectId: project.body.id })).status, 404);
    assert.equal((await api(fullKey, 'PUT', `/workflows/${made.body.id}/transfer`, { destinationProjectId: 'ghost' })).status, 404);
    // transfer of an unknown credential mirrors the workflow contract
    assert.equal((await api(fullKey, 'PUT', '/credentials/missing/transfer', { destinationProjectId: project.body.id })).status, 404);
  });
});

/* --------------------------------------------------------------- source control */

describe('source-control pull over the M13 source-control model', () => {
  test('not connected: 400 {status,Message} exactly like upstream', async () => {
    const res = await api(fullKey, 'POST', '/source-control/pull', {});
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { status: 'Error', message: 'Source Control is not connected to a repository' });
  });

  test('pull merges open changesets onto the branch head and reports them', async () => {
    const repo = backing.sourceControl.createRepository({ name: 'ops', defaultBranch: 'main' });
    const branch = backing.sourceControl.createBranch({ repoId: repo.repoId, name: 'main' });
    const open = backing.sourceControl.createChangeset({
      repoId: repo.repoId, branchId: branch.branchId, author: 'owner@api-m10.test', message: 'import me', fileCount: 2,
    });
    const pulled = await api(fullKey, 'POST', '/source-control/pull', { force: false, autoPublish: 'none', variables: { foo: 'bar' } });
    assert.equal(pulled.status, 200);
    assert.deepEqual(pulled.body.statusResult.changed, [open.changesetId]);
    assert.deepEqual(pulled.body.variables.changed, ['foo']);
    // model read-back: the changeset is merged and the head moved
    assert.equal(backing.sourceControl.getChangeset(repo.repoId, open.changesetId).state, 'merged');
    assert.equal(backing.sourceControl.getBranch(repo.repoId, branch.branchId).headChangesetId, open.changesetId);
  });

  test('bad body 400 (closed validate)', async () => {
    const res = await api(fullKey, 'POST', '/source-control/pull', { autoPublish: 'sometimes' });
    assert.equal(res.status, 400);
  });
});

/* ------------------------------------------------------------------ data tables */

describe('data-tables resource over the M14 table model', () => {
  let tableId;

  test('tables: create 201, get 200, rename 200, list {data,nextCursor}, delete 204 (rows go with it)', async () => {
    const created = await api(fullKey, 'POST', '/data-tables', {
      name: 'customers',
      columns: [{ name: 'email', type: 'string' }, { name: 'age', type: 'number' }],
    });
    assert.equal(created.status, 201, created.raw);
    assert.deepEqual(created.body.columns.map((column) => column.name), ['email', 'age']);
    tableId = created.body.id;

    assert.equal((await api(fullKey, 'GET', `/data-tables/${tableId}`)).status, 200);
    const renamed = await api(fullKey, 'PATCH', `/data-tables/${tableId}`, { name: 'clients' });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.name, 'clients');
    assert.equal(backing.dataTables.getTable(tableId).name, 'clients');

    const listed = await api(fullKey, 'GET', '/data-tables');
    assert.equal(listed.status, 200);
    assert.ok(listed.body.data.some((table) => table.id === tableId));

    // rows first, then delete: both disappear together (all-or-nothing)
    await api(fullKey, 'POST', `/data-tables/${tableId}/rows`, {
      data: [{ email: 'a@x.test', age: 1 }], returnType: 'count',
    });
    const deleted = await api(fullKey, 'DELETE', `/data-tables/${tableId}`);
    assert.equal(deleted.status, 204);
    assert.throws(() => backing.dataTables.getTable(tableId), /not found/);
    assert.equal((await api(fullKey, 'GET', `/data-tables/${tableId}`)).status, 404);
  });

  test('rows: insert returnType count|id|all; unknown column 400', async () => {
    const created = await api(fullKey, 'POST', '/data-tables', {
      name: 'orders',
      columns: [{ name: 'status', type: 'string' }, { name: 'total', type: 'number' }],
    });
    tableId = created.body.id;
    const count = await api(fullKey, 'POST', `/data-tables/${tableId}/rows`, {
      data: [{ status: 'pending', total: 10 }, { status: 'done', total: 20 }], returnType: 'count',
    });
    assert.equal(count.status, 200);
    assert.deepEqual(count.body, { count: 2 });

    const ids = await api(fullKey, 'POST', `/data-tables/${tableId}/rows`, {
      data: [{ status: 'new', total: 5 }], returnType: 'id',
    });
    assert.equal(ids.body.length, 1);

    const all = await api(fullKey, 'POST', `/data-tables/${tableId}/rows`, {
      data: [{ status: 'batch', total: 1 }], returnType: 'all',
    });
    assert.equal(all.body[0].status, 'batch');
    assert.ok(all.body[0].id);

    const bad = await api(fullKey, 'POST', `/data-tables/${tableId}/rows`, {
      data: [{ nope: 1 }], returnType: 'count',
    });
    assert.equal(bad.status, 400);
  });

  test('rows query: filter/sort/search deterministic; filter JSON errors 400', async () => {
    const filtered = await api(fullKey, 'GET',
      `/data-tables/${tableId}/rows?filter=${encodeURIComponent(JSON.stringify({ type: 'and', filters: [{ columnName: 'status', condition: 'eq', value: 'pending' }] }))}`);
    assert.equal(filtered.status, 200);
    assert.equal(filtered.body.data.length, 1);
    assert.equal(filtered.body.data[0].status, 'pending');

    const sorted = await api(fullKey, 'GET', `/data-tables/${tableId}/rows?sortBy=${encodeURIComponent('total:desc')}`);
    assert.deepEqual(sorted.body.data.map((row) => row.total), [20, 10, 5, 1]);

    const searched = await api(fullKey, 'GET', `/data-tables/${tableId}/rows?search=don`);
    assert.deepEqual(searched.body.data.map((row) => row.status), ['done']);

    assert.equal((await api(fullKey, 'GET', `/data-tables/${tableId}/rows?filter=%7Bnope`)).status, 400);
  });

  test('rows mutate: update/upsert/delete honor filter, dryRun and returnData', async () => {
    const dry = await api(fullKey, 'PATCH', `/data-tables/${tableId}/rows/update`, {
      filter: { type: 'and', filters: [{ columnName: 'status', condition: 'eq', value: 'pending' }] },
      data: { status: 'in-progress' },
      dryRun: true, returnData: true,
    });
    assert.equal(dry.status, 200);
    assert.equal(dry.body[0].status, 'pending', 'dryRun does not persist');
    assert.equal((await api(fullKey, 'GET', `/data-tables/${tableId}/rows?search=pending`)).body.data.length, 1);

    const updated = await api(fullKey, 'PATCH', `/data-tables/${tableId}/rows/update`, {
      filter: { type: 'and', filters: [{ columnName: 'status', condition: 'eq', value: 'pending' }] },
      data: { status: 'in-progress' }, returnData: true,
    });
    assert.equal(updated.body[0].status, 'in-progress');

    const upsertExisting = await api(fullKey, 'POST', `/data-tables/${tableId}/rows/upsert`, {
      filter: { type: 'and', filters: [{ columnName: 'status', condition: 'eq', value: 'done' }] },
      data: { status: 'done', total: 21 }, returnData: true,
    });
    assert.equal(upsertExisting.body.total, 21);

    const upsertNew = await api(fullKey, 'POST', `/data-tables/${tableId}/rows/upsert`, {
      filter: { type: 'and', filters: [{ columnName: 'status', condition: 'eq', value: 'fresh' }] },
      data: { status: 'fresh', total: 0 }, returnData: true,
    });
    assert.equal(upsertNew.body.status, 'fresh');

    const remove = await api(fullKey, 'DELETE',
      `/data-tables/${tableId}/rows/delete?filter=${encodeURIComponent(JSON.stringify({ type: 'or', filters: [{ columnName: 'total', condition: 'lte', value: 1 }] }))}&returnData=true`);
    assert.equal(remove.status, 200);
    assert.ok(remove.body.length >= 1);
    assert.equal((await api(fullKey, 'DELETE', `/data-tables/${tableId}/rows/delete`)).status, 400, 'filter is required');
  });
});
