/**
 * P2 — Compatibility Contract Layer tests.
 *
 * Contract coverage (docs/n8n-lego/FRONTEND_COMPATIBILITY.md §P2):
 *
 *   1. PublicUser.globalScopes  exists on login / me, computed from the user's
 *      actual global role (owner vs member proven against the extracted n8n
 *      permission model in data/roles.json) — never "all scopes", never empty
 *      for a known role.
 *   2. Settings contract        the flags and scopes the editor's route guards
 *      and sidebar read: hideUsagePage (upstream default false), community /
 *      enterprise gating inputs, showSetupOnFirstLoad.
 *   3. Unsupported semantics    known-but-unimplemented capabilities and never
 *      seen paths answer 501 {code:'unsupported'} — the old fake-success
 *      `200 {"data":null}` is gone; implemented-but-empty features keep their
 *      honest 200.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../src/server.mjs';
import { hashPassword } from '../src/auth.mjs';
import { getGlobalScopes } from '../src/compat/scopes.mjs';

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_CATALOG = resolve(APP_DIR, '..', '..', 'data', 'n8n-lego', 'catalog');
const USER_FOLDER = mkdtempSync(join(tmpdir(), 'n8n-lego-p2-test-'));

/** The extracted permission model (pinned @n8n/permissions, bundled fallback). */
const ROLES = JSON.parse(readFileSync(join(APP_DIR, 'data', 'roles.json'), 'utf8'));
const OWNER_SCOPES = ROLES.global.find((role) => role.slug === 'global:owner').scopes;
const MEMBER_SCOPES = ROLES.global.find((role) => role.slug === 'global:member').scopes;
const ADMIN_SCOPES = ROLES.global.find((role) => role.slug === 'global:admin').scopes;

let base;
let running;
let store;
const cookies = {};
const csrfCookies = {};

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
  const address = running.address();
  base = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  if (running) await new Promise((done) => running.close(() => done()));
  rmSync(USER_FOLDER, { recursive: true, force: true });
});


/**
 * P5.2: this helper models the BROWSER, not a bare HTTP client. A browser sends
 * `Origin` on every state-changing request, which is what the CSRF origin check
 * consumes. It deliberately sends NO x-n8n-csrf-token header, because the
 * shipped n8n editor — the declared compatibility surface — does not know that
 * header exists. Exercising the same path production does is the point.
 */
async function api(method, path, body, { as = 'owner' } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(as && cookies[as] ? { cookie: cookies[as] } : {}),
      ...(as ? { origin: base } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  for (const entry of response.headers.getSetCookie?.() ?? []) {
    const pair = entry.split(';')[0];
    if (pair.startsWith('n8n-auth=')) { if (as) cookies[as] = pair; }
    else if (pair.startsWith('n8n-csrf=')) { if (as) csrfCookies[as] = pair; }
  }
  const text = await response.text();
  const json = text === '' ? null : JSON.parse(text);
  return { status: response.status, json };
}

const sorted = (list) => [...list].sort();

/* ------------------------------------------------ 1. PublicUser.globalScopes */

test('owner setup returns PublicUser with globalScopes from the permission model', async () => {
  const { status, json } = await api('POST', '/rest/owner/setup', {
    email: 'owner@p2.test',
    firstName: 'P2',
    lastName: 'Owner',
    password: 'p2-owner-password',
  });
  assert.equal(status, 200);
  const user = json.data;
  assert.ok(Array.isArray(user.globalScopes), 'globalScopes must exist on the PublicUser envelope');
  assert.deepEqual(sorted(user.globalScopes), sorted(OWNER_SCOPES), 'computed from global:owner, not hardcoded');
  assert.ok(user.globalScopes.length > 100, 'the owner really holds the upstream owner scope set');
  assert.equal(user.mfaAuthenticated, false);
});

test('GET /rest/login and GET /rest/me both expose identical globalScopes', async () => {
  const login = await api('GET', '/rest/login');
  assert.equal(login.status, 200);
  assert.deepEqual(sorted(login.json.data.globalScopes), sorted(OWNER_SCOPES));

  const me = await api('GET', '/rest/me');
  assert.equal(me.status, 200);
  assert.deepEqual(sorted(me.json.data.globalScopes), sorted(OWNER_SCOPES));

  // POST /rest/login (fresh session) must carry the same contract — the editor
  // seeds its RBAC store from it (`init.ts: setGlobalScopes(user.globalScopes)`).
  const fresh = await api('POST', '/rest/login', { email: 'owner@p2.test', password: 'p2-owner-password' });
  assert.equal(fresh.status, 200);
  assert.deepEqual(sorted(fresh.json.data.globalScopes), sorted(OWNER_SCOPES));
});

test('a limited user gets exactly their role scopes — not the owner set, not all scopes', async () => {
  store.users.insert({
    id: 'member001',
    email: 'member@p2.test',
    firstName: 'Limited',
    lastName: 'Member',
    role: 'global:member',
    password: hashPassword('p2-member-password'),
    isPending: false,
    createdAt: new Date().toISOString(),
    settings: {},
  });
  const { status, json } = await api('POST', '/rest/login', { email: 'member@p2.test', password: 'p2-member-password' }, { as: 'member' });
  assert.equal(status, 200);
  const scopes = json.data.globalScopes;
  assert.deepEqual(sorted(scopes), sorted(MEMBER_SCOPES), 'computed from global:member');
  assert.ok(!scopes.includes('user:create'), 'a member must not gain scopes the role does not have');
  assert.ok(!scopes.includes('user:delete'), 'a member must not gain scopes the role does not have');
  assert.ok(scopes.length < OWNER_SCOPES.length, 'RBAC is not bypassed: member ⊊ owner');

  // Unknown roles degrade to [] — exactly like upstream getGlobalScopes.
  assert.deepEqual(getGlobalScopes({ role: 'global:nope' }, { catalogDir: REPO_CATALOG }), []);
  assert.deepEqual(getGlobalScopes(null, { catalogDir: REPO_CATALOG }), []);
});

test('the permission model itself is faithful (extraction sanity)', () => {
  // GLOBAL_ADMIN_SCOPES is defined as GLOBAL_OWNER_SCOPES.concat() upstream —
  // the extractor must not degrade it to an empty role.
  assert.deepEqual(sorted(ADMIN_SCOPES), sorted(OWNER_SCOPES));
  assert.ok(MEMBER_SCOPES.length > 0 && MEMBER_SCOPES.length < OWNER_SCOPES.length);
});

test('the users list stays within the upstream contract (no scopes on list rows)', async () => {
  const { status, json } = await api('GET', '/rest/users');
  assert.equal(status, 200);
  assert.equal(json.data.count, 2);
  for (const row of json.data.items) {
    assert.equal(row.globalScopes, undefined, 'upstream listUsers serializes PublicUser without scopes');
  }
});

test('authentication/authorization semantics are unchanged', async () => {
  const anonymous = await api('GET', '/rest/login', undefined, { as: null });
  assert.equal(anonymous.status, 401);
  const wrongPassword = await api('POST', '/rest/login', { email: 'owner@p2.test', password: 'wrong' }, { as: null });
  assert.equal(wrongPassword.status, 401);
  const protectedList = await api('GET', '/rest/workflows', undefined, { as: null });
  assert.equal(protectedList.status, 401);
  const missingWorkflow = await api('GET', '/rest/workflows/no-such-workflow');
  assert.equal(missingWorkflow.status, 404);
});

/* --------------------------------------------- 2. settings visibility inputs */

test('GET /rest/settings feeds the community route guards truthfully', async () => {
  const { status, json } = await api('GET', '/rest/settings');
  assert.equal(status, 200);
  const settings = json.data;

  // R2 fixed: upstream N8N_HIDE_USAGE_PAGE default is false — "Usage and plan"
  // is a community feature and the /settings redirect targets it.
  assert.equal(settings.hideUsagePage, false);

  // Community gating inputs stay honest — enterprise capability is not faked
  // on just to render menus.
  assert.equal(settings.userManagement.showSetupOnFirstLoad, false);
  assert.equal(settings.executionMode, 'regular', 'Workers view requires queue mode — correctly off');
  assert.equal(settings.enterprise.sharing, false);
  assert.equal(settings.enterprise.workerView, false);
  assert.equal(settings.enterprise.sourceControl, false);
  assert.equal(settings.communityNodesEnabled, false);
  assert.equal(settings.publicApi.enabled, true);
});

test('the scopes the settings route guards require are present in the owner set', async () => {
  // Every rbac-gated settings entry the stock community editor can show
  // (reference: editor-ui router.ts + useSettingsItems.ts).
  for (const scope of ['user:create', 'user:update', 'apiKey:manage', 'securitySettings:manage', 'breakingChanges:list']) {
    assert.ok(OWNER_SCOPES.includes(scope), `owner scope set must include ${scope}`);
  }
});

/* ----------------------------------------------------- 3. unsupported semantics */

test('a known-but-unimplemented capability answers 501 unsupported, not 200 {data:null}', async () => {
  const { status, json } = await api('GET', '/rest/workflow-history/workflow/abc123/versions');
  assert.equal(status, 501, 'workflow-history is not implemented and must say so');
  assert.equal(json.data, undefined, 'no fake-success data envelope');
  assert.equal(json.code, 'unsupported');
  assert.equal(json.meta.feature, 'workflow-history');
  assert.equal(json.meta.owner, 'workflow');
  assert.ok(json.message.length > 0);
});

test('unreachable-settings backends answer with distinct features', async () => {
  const cases = [
    ['/rest/settings/security', 'security-settings'],
    ['/rest/sso/saml/config', 'sso'],
    ['/rest/source-control/preferences', 'source-control'],
    ['/rest/breaking-changes/report', 'breaking-changes'],
    ['/rest/community-packages', 'community-packages'],
    ['/rest/orchestration/worker/status', 'orchestration'],
  ];
  for (const [path, feature] of cases) {
    const { status, json } = await api('GET', path);
    assert.equal(status, 501, `${path} must be an explicit 501`);
    assert.equal(json.code, 'unsupported');
    assert.equal(json.meta.feature, feature);
  }
});

test('P5.7: /rest/api-keys left the unsupported table — it is served for real now', async () => {
  const { status, json } = await api('GET', '/rest/api-keys');
  assert.equal(status, 200, 'implemented features must not keep answering 501');
  assert.ok(Array.isArray(json.data));
  assert.notEqual(json.code, 'unsupported');
});

test('unsupported semantics also apply to writes', async () => {
  const { status, json } = await api('POST', '/rest/license/activate', { activationKey: 'x' });
  assert.equal(status, 501);
  assert.equal(json.code, 'unsupported');
  assert.notEqual(json.data, true, 'a write must never fake persistence with {data:true}');
});

test('implemented-but-empty features keep their honest 200', async () => {
  const variables = await api('GET', '/rest/variables');
  assert.equal(variables.status, 200);
  assert.deepEqual(variables.json.data, [], 'feature exists, collection is empty — distinct from unsupported');

  const workflows = await api('GET', '/rest/workflows');
  assert.equal(workflows.status, 200);
  assert.equal(workflows.json.count, 0);
});

test('unauthenticated unsupported paths still answer 401 first (auth before capability)', async () => {
  const { status } = await api('GET', '/rest/workflow-history/workflow/abc123/versions', undefined, { as: null });
  assert.equal(status, 401, 'authentication is evaluated before the capability handler');
});
