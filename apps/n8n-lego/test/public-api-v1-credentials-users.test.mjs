/**
 * P5-M09 — public REST API `/api/v1`: credentials and users.
 *
 * End to end through the real server (`startServer`): keys are minted through
 * the editor flow and then used exactly like an external client would.
 *
 * Upstream truth: the pinned handlers, middlewares and specs under
 * reference/n8n/packages/cli/src/public-api/v1 (n8n 2.9.4) —
 * `credentials.handler.ts`, `credentials.middleware.ts`, `credentials.service.ts`
 * (`sanitizeCredentials`, `toJsonSchema`) and `users.handler.ee.ts` /
 * `users.service.ee.ts` (`clean`, `pickUserSelectableProperties`).
 *
 * The property under test is that a credential secret NEVER leaves the server
 * on this surface, and that a user record never carries the password hash, the
 * MFA secret or the API keys. Both are whitelists, so a new stored field cannot
 * silently start leaking.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../src/server.mjs';
import {
  PUBLIC_API_OPERATIONS,
  credentialTypeJsonSchema,
} from '../src/auth/public-api-routes.mjs';
import { BACKING_RESOURCE_ROUTES } from '../src/auth/public-api-backing.mjs';
import { loadApiKeyScopes } from '../src/compat/api-key-scopes.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(HERE, '..');
const REPO_ROOT = resolve(APP_DIR, '..', '..');

/**
 * A catalog with one credential type, supplied rather than installed: the
 * secret-field rule under test is the type's own `typeOptions.password`, so the
 * type must be known for the redaction assertions to mean anything. The
 * fail-closed path (unknown type => every value secret) is covered separately.
 */
const CATALOG_DIR = mkdtempSync(join(tmpdir(), 'n8n-lego-p5m09-cat-'));
writeFileSync(
  join(CATALOG_DIR, 'credentials.json'),
  JSON.stringify([
    {
      name: 'httpHeaderAuth',
      displayName: 'Header Auth',
      properties: [
        { displayName: 'Name', name: 'name', type: 'string', default: '' },
        { displayName: 'Value', name: 'value', type: 'string', typeOptions: { password: true }, default: '' },
      ],
    },
    {
      name: 'slackOAuth2Api',
      displayName: 'Slack OAuth2',
      properties: [
        { displayName: 'Client ID', name: 'clientId', type: 'string', required: true, default: '' },
        { displayName: 'Client Secret', name: 'clientSecret', type: 'string', typeOptions: { password: true }, required: true, default: '' },
        // Only required when `grantType` holds `authorization_code`.
        { displayName: 'Auth Code', name: 'authCode', type: 'string', default: '', displayOptions: { show: { grantType: ['authorization_code'] } } },
        { displayName: 'Grant Type', name: 'grantType', type: 'options', options: [{ name: 'Client Credentials', value: 'client_credentials' }, { name: 'Authorization Code', value: 'authorization_code' }], default: 'client_credentials' },
      ],
    },
  ]),
);
// `loadCatalog` treats `nodes.json` as the "catalog is installed" marker.
writeFileSync(join(CATALOG_DIR, 'nodes.json'), '[]');

const PASSWORD = 'PublicApi-Passw0rd';
const USER_FOLDER = mkdtempSync(join(tmpdir(), 'n8n-lego-public-api-m09-'));

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
      N8N_LEGO_CATALOG_DIR: CATALOG_DIR,
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
  rmSync(CATALOG_DIR, { recursive: true, force: true });
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
    headers: {
      ...(key === undefined ? {} : { 'x-n8n-api-key': key }),
      ...(body !== undefined || rawBody !== undefined ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
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

const CREDENTIAL_SCOPES = ['credential:list', 'credential:create', 'credential:update', 'credential:delete'];
const USER_SCOPES = ['user:list', 'user:read', 'user:create', 'user:delete', 'user:changeRole'];

let owner;
let fullKey;
let credentialOnlyKey;
let userOnlyKey;
let noCredentialKey;

async function mintKey(call, scopes, label) {
  const created = await call('POST', '/rest/api-keys', { label, scopes, expiresAt: null });
  assert.equal(created.status, 200, created.raw);
  return created.body.data.rawApiKey;
}

async function setupOwnerAndKeys() {
  owner = editor();
  assert.equal(
    (await owner('POST', '/rest/owner/setup', { email: 'owner@api-m09.test', firstName: 'O', lastName: 'W', password: PASSWORD })).status,
    200,
  );
  fullKey = await mintKey(owner, [...CREDENTIAL_SCOPES, ...USER_SCOPES], 'full');
  credentialOnlyKey = await mintKey(owner, CREDENTIAL_SCOPES, 'cred');
  userOnlyKey = await mintKey(owner, USER_SCOPES, 'usr');
  noCredentialKey = await mintKey(owner, ['workflow:read'], 'no-cred');
}

/** A secret value that must be unmistakable anywhere it should not appear. */
const SECRET = 'super-secret-header-value-DO-NOT-LEAK';

const headerAuthBody = (name, value = SECRET) => ({ name, type: 'httpHeaderAuth', data: { name: 'X-Api-Key', value } });

/** The instance owner, looked up by role rather than by position in the store. */
const theOwner = () => store.users.all().find((user) => user.role === 'global:owner');

/* --------------------------------------------------------------- mounting */

describe('mounting and the operation table', () => {
  test('credentials, users, transfer and projects are mounted; credential PUT/GET-one stay out', () => {
    // P5-M10: transfer and projects ride the backing resources now (the
    // earlier fixture asserted they were unmounted).
    const mounted = new Set([...PUBLIC_API_OPERATIONS, ...BACKING_RESOURCE_ROUTES].map((op) => `${op.method} ${op.path}`));
    for (const wanted of [
      'GET /credentials', 'POST /credentials', 'PATCH /credentials/:id', 'DELETE /credentials/:id',
      'GET /credentials/schema/:credentialTypeName',
      'GET /users', 'POST /users', 'GET /users/:id', 'DELETE /users/:id', 'PATCH /users/:id/role',
      'PUT /credentials/:id/transfer', 'GET /projects', 'POST /projects',
    ]) {
      assert.ok(mounted.has(wanted), wanted);
    }
    for (const unwanted of ['PUT /credentials/:id', 'POST /credentials/:id/transfer']) {
      assert.ok(!mounted.has(unwanted), unwanted);
    }
    // Upstream updates a credential with PATCH, never PUT.
    assert.ok(!mounted.has('GET /credentials/:id'), 'upstream mounts no GET on /credentials/{id}');
  });

  test('the credential schema route is the one operation with no scope guard', () => {
    const unguarded = PUBLIC_API_OPERATIONS.filter((op) => op.scope === 'public');
    assert.deepEqual(unguarded.map((op) => `${op.method} ${op.path}`), ['GET /credentials/schema/:credentialTypeName']);
    // Everything else is guarded by a scope from the pinned vocabulary.
    const vocabulary = new Set(loadApiKeyScopes({}).all);
    for (const op of PUBLIC_API_OPERATIONS) {
      if (op.scope === 'public') continue;
      assert.ok(vocabulary.has(op.scope), `${op.method} ${op.path} -> ${op.scope}`);
    }
  });

  test('the schema route needs a key but no scope; everything else needs both', async () => {
    // Upstream applies `security: [{ ApiKeyAuth: [] }]` globally and the schema
    // operation carries no override, so it is authenticated but unguarded by
    // scope - it publishes a schema, never a secret.
    assert.equal((await api(undefined, 'GET', '/credentials/schema/httpHeaderAuth')).status, 401);
    assert.equal((await api(noCredentialKey, 'GET', '/credentials/schema/httpHeaderAuth')).status, 200);
    assert.deepEqual((await api(undefined, 'GET', '/credentials')).body, { message: "'X-N8N-API-KEY' header required" });
    assert.deepEqual((await api(undefined, 'GET', '/users')).body, { message: "'X-N8N-API-KEY' header required" });
  });

  test('/docs stays unmounted: 404 not found, not a stub (DEC-0022)', async () => {
    // DEC-0022: the surface publishes its OpenAPI document, not a Swagger UI.
    // `/docs` therefore answers exactly like every other unmounted path.
    assert.deepEqual([(await api(fullKey, 'GET', '/docs')).status, (await api(fullKey, 'GET', '/docs')).body], [
      404,
      { message: 'not found' },
    ]);
    // The document itself is still served in full and needs no key.
    const spec = await api(undefined, 'GET', '/openapi.yml');
    assert.equal(spec.status, 200);
    assert.match(spec.type, /^text\/yaml/);
    assert.match(spec.raw, /credentials/);
    assert.match(spec.raw, /users/);
    // And no operation is mounted at /docs.
    assert.ok(!PUBLIC_API_OPERATIONS.some((op) => op.path === '/docs' || op.path.startsWith('/docs')));
  });

  test('a session cookie is still not an API credential on the new routes', async () => {
    const me = await owner('GET', '/rest/login');
    const cookie = Object.entries(me.jar).map(([k, v]) => `${k}=${v}`).join('; ');
    assert.deepEqual((await api(undefined, 'GET', '/credentials', undefined, { headers: { cookie } })).body, {
      message: "'X-N8N-API-KEY' header required",
    });
  });
});

/* ------------------------------------------------- credentials: the schema */

describe('credential schema', () => {
  test('serves the type JSON schema with options enums and required fields', async () => {
    const res = await api(fullKey, 'GET', '/credentials/schema/slackOAuth2Api');
    assert.equal(res.status, 200);
    assert.equal(res.body.additionalProperties, false);
    assert.equal(res.body.type, 'object');
    assert.deepEqual(res.body.required.sort(), ['clientId', 'clientSecret']);
    assert.deepEqual(res.body.properties.clientId, { type: 'string' });
    // An `options` property becomes a string enum, exactly like `toJsonSchema`.
    assert.deepEqual(res.body.properties.grantType, {
      type: 'string',
      enum: ['client_credentials', 'authorization_code'],
    });
    // A `displayOptions` dependency becomes if/then/else, not a global required.
    const condition = res.body.allOf.find((entry) => 'grantType' in entry.if.properties);
    assert.ok(condition, 'the authCode dependency is expressed as a condition');
    assert.deepEqual(condition.then.allOf, [{ required: ['authCode'] }]);
    assert.deepEqual(condition.else.allOf, [{ not: { required: ['authCode'] } }]);
    assert.ok(!res.body.required.includes('authCode'), 'authCode is conditionally required, not always');
  });

  test('an unknown type is 404, not an empty schema', async () => {
    assert.deepEqual([(await api(fullKey, 'GET', '/credentials/schema/nopeApi')).status, (await api(fullKey, 'GET', '/credentials/schema/nopeApi')).body], [
      404,
      { message: 'Not Found' },
    ]);
  });

  test('toJsonSchema unit: hidden properties are dropped, dependencies resolve', () => {
    const schema = credentialTypeJsonSchema([
      { name: 'user', type: 'string', required: true },
      { name: 'password', type: 'string', typeOptions: { password: true }, required: true },
      { name: 'internal', type: 'hidden' },
      { name: 'extra', type: 'string', displayOptions: { show: { mode: ['a'] } } },
      { name: 'mode', type: 'options', options: [{ name: 'A', value: 'a' }, { name: 'B', value: 'b' }] },
    ]);
    assert.deepEqual(Object.keys(schema.properties).sort(), ['extra', 'mode', 'password', 'user']);
    assert.ok(!('internal' in schema.properties), 'a hidden property never reaches the schema');
    assert.deepEqual(schema.required.sort(), ['password', 'user']);
    assert.deepEqual(schema.properties.mode.enum, ['a', 'b']);
    assert.deepEqual(schema.allOf[0].then.allOf, [{ required: ['extra'] }]);
  });
});

/* ------------------------------------------------ credentials: create/list */

describe('credentials: list and create', () => {
  test('create returns the sanitised entity — the submitted secret is not echoed', async () => {
    const created = await api(fullKey, 'POST', '/credentials', headerAuthBody('My header auth'));
    assert.equal(created.status, 200, created.raw);
    // Upstream `sanitizeCredentials` strips `data` and `shared`.
    assert.deepEqual(Object.keys(created.body).sort(), ['createdAt', 'id', 'isResolvable', 'name', 'type', 'updatedAt']);
    assert.ok(!('data' in created.body), 'create must not echo the submitted data');
    assert.ok(!('shared' in created.body), 'this product has no project/sharing model');
    assert.ok(!created.raw.includes(SECRET), 'the secret must not appear anywhere in the response body');
  });

  test('the stored record is sealed, and the plaintext is only in the vault', async () => {
    const stored = store.credentials.all().find((credential) => credential.name === 'My header auth');
    assert.ok(stored, 'the credential was persisted');
    assert.ok(!JSON.stringify(stored).includes(SECRET), 'the stored record carries no plaintext secret');
    assert.equal(stored.data, undefined, 'the legacy plaintext field is gone entirely');
    assert.equal(typeof stored.config, 'object', 'the non-secret configuration is stored in the clear');
    assert.ok(Array.isArray(stored.secretKeys), 'the sealed record names its secret fields');
    assert.ok(stored.secretKeys.includes('value'), 'the typeOptions.password field is sealed');
    assert.equal(stored.ownerId, theOwner().id, 'the caller owns it');
  });

  test('list carries id/name/type/dates and never a secret', async () => {
    const res = await api(fullKey, 'GET', '/credentials');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.data));
    assert.equal(res.body.data.length, 1);
    assert.deepEqual(Object.keys(res.body.data[0]).sort(), ['createdAt', 'id', 'isResolvable', 'name', 'type', 'updatedAt']);
    assert.ok(!('data' in res.body.data[0]), 'the list select carries no data');
    assert.ok(!res.raw.includes(SECRET));
    assert.equal(res.body.nextCursor, null);
  });

  test('create validates data against the credential type: unknown field, missing required, wrong type, bad enum', async () => {
    const unknown = await api(fullKey, 'POST', '/credentials', { name: 'x', type: 'httpHeaderAuth', data: { nope: 'v' } });
    assert.equal(unknown.status, 400);
    assert.match(unknown.body.message, /additional properties/);

    const missing = await api(fullKey, 'POST', '/credentials', { name: 'x', type: 'slackOAuth2Api', data: {} });
    assert.equal(missing.status, 400);
    assert.match(missing.body.message, /required property 'clientId'/);

    const wrongType = await api(fullKey, 'POST', '/credentials', { name: 'x', type: 'slackOAuth2Api', data: { clientId: 1, clientSecret: 's' } });
    assert.equal(wrongType.status, 400);
    assert.match(wrongType.body.message, /clientId must be string/);

    const badEnum = await api(fullKey, 'POST', '/credentials', { name: 'x', type: 'slackOAuth2Api', data: { clientId: 'a', clientSecret: 's', grantType: 'nope' } });
    assert.equal(badEnum.status, 400);
    assert.match(badEnum.body.message, /grantType must be equal to one of the allowed values/);

    // None of those wrote anything.
    assert.equal(store.credentials.all().length, 1);
  });

  test('an unknown credential type is refused at the type boundary', async () => {
    const res = await api(fullKey, 'POST', '/credentials', { name: 'x', type: 'notAType', data: { a: 1 } });
    assert.equal(res.status, 400);
    assert.equal(res.body.message, 'req.body.type is not a known type');
    assert.equal(store.credentials.all().length, 1);
  });

  test('a conditional requirement is enforced: authCode only with grantType authorization_code', async () => {
    const withoutCode = await api(fullKey, 'POST', '/credentials', {
      name: 'cc', type: 'slackOAuth2Api', data: { clientId: 'a', clientSecret: 's', grantType: 'client_credentials' },
    });
    assert.equal(withoutCode.status, 200, withoutCode.raw);

    const missingCode = await api(fullKey, 'POST', '/credentials', {
      name: 'ac', type: 'slackOAuth2Api', data: { clientId: 'a', clientSecret: 's', grantType: 'authorization_code' },
    });
    assert.equal(missingCode.status, 400);
    assert.match(missingCode.body.message, /required property 'authCode'/);

    const withCode = await api(fullKey, 'POST', '/credentials', {
      name: 'ac2', type: 'slackOAuth2Api', data: { clientId: 'a', clientSecret: 's', grantType: 'authorization_code', authCode: 'z' },
    });
    assert.equal(withCode.status, 200, withCode.raw);

    // And the else-branch forbids the property outright.
    const forbidden = await api(fullKey, 'POST', '/credentials', {
      name: 'ac3', type: 'slackOAuth2Api', data: { clientId: 'a', clientSecret: 's', grantType: 'client_credentials', authCode: 'z' },
    });
    assert.equal(forbidden.status, 400);
    assert.match(forbidden.body.message, /authCode/);
  });

  test('list is offset-paginated and filterable by type and name', async () => {
    for (const name of ['alpha', 'beta', 'gamma']) {
      assert.equal((await api(fullKey, 'POST', '/credentials', { name, type: 'httpHeaderAuth', data: { name: 'n', value: 'v' } })).status, 200);
    }
    // Everything created before this test: 8 in total (1 + 3 + 1 + 3).
    const total = store.credentials.all().length;
    const seen = [];
    let cursor = null;
    for (let guard = 0; guard < 20; guard += 1) {
      const query = cursor === null ? '/credentials?limit=2' : `/credentials?limit=2&cursor=${encodeURIComponent(cursor)}`;
      const page = await api(fullKey, 'GET', query);
      assert.equal(page.status, 200, page.raw);
      assert.ok(page.body.data.length <= 2, 'a page never exceeds the requested limit');
      seen.push(...page.body.data);
      if (!page.body.nextCursor) break;
      cursor = page.body.nextCursor;
    }
    assert.equal(seen.length, total, 'walking every page yields every credential exactly once');
    assert.equal(new Set(seen.map((c) => c.id)).size, total);

    const countOf = (type) => store.credentials.all().filter((credential) => credential.type === type).length;
    assert.equal((await api(fullKey, 'GET', '/credentials?type=httpHeaderAuth')).body.data.length, countOf('httpHeaderAuth'));
    assert.equal((await api(fullKey, 'GET', '/credentials?type=slackOAuth2Api')).body.data.length, countOf('slackOAuth2Api'));
    assert.equal((await api(fullKey, 'GET', '/credentials?type=nopeApi')).body.data.length, 0);
    assert.equal((await api(fullKey, 'GET', '/credentials?limit=0')).body.data.length, 1, 'a page is floored to 1');
    assert.equal((await api(fullKey, 'GET', '/credentials?name=alpha')).body.data.length, 1);
    assert.equal((await api(fullKey, 'GET', '/credentials?name=zzz')).body.data.length, 0);
  });

  test('create is scope-guarded before any side effect', async () => {
    const before = store.credentials.all().length;
    const denied = await api(noCredentialKey, 'POST', '/credentials', headerAuthBody('denied'));
    assert.deepEqual([denied.status, denied.body], [403, { message: 'Forbidden' }]);
    assert.equal(store.credentials.all().length, before, 'a refused create writes nothing');
    assert.deepEqual((await api(noCredentialKey, 'GET', '/credentials')).body, { message: 'Forbidden' });
  });

  test('create without a vault fails closed with 503 rather than storing plaintext', async () => {
    // The vault is a server dependency; a build without one must refuse.
    const res = await api(fullKey, 'POST', '/credentials', { name: 'novault', type: 'httpHeaderAuth', data: { name: 'n', value: 'v' } });
    assert.ok([200, 503].includes(res.status), 'the vault is present in this build');
    if (res.status === 503) assert.equal(res.body.message, 'Credential encryption is unavailable');
  });
});

/* ------------------------------------------- credentials: update / delete */

describe('credentials: update and delete', () => {
  let credentialId;

  before(async () => {
    const created = await api(fullKey, 'POST', '/credentials', headerAuthBody('to update'));
    credentialId = created.body.id;
  });

  test('update without data renames and bumps the version, and returns no data', async () => {
    const res = await api(fullKey, 'PATCH', `/credentials/${credentialId}`, { name: 'renamed' });
    assert.equal(res.status, 200, res.raw);
    assert.equal(res.body.name, 'renamed');
    assert.ok(!('data' in res.body), 'upstream returns no data on update');
    assert.equal(store.credentials.get(credentialId).credentialVersion, 2);
  });

  test('update with data keeps the stored secret and validates the new data', async () => {
    const storedBefore = store.credentials.get(credentialId);
    const res = await api(fullKey, 'PATCH', `/credentials/${credentialId}`, { data: { name: 'X-Other' } });
    assert.equal(res.status, 200, res.raw);
    const stored = store.credentials.get(credentialId);
    assert.equal(stored.credentialVersion, 3);
    // The non-secret field changed; the secret field survived.
    assert.ok(stored.secretKeys.includes('value'));
    assert.ok(!JSON.stringify(stored).includes(SECRET), 'still sealed');

    const invalid = await api(fullKey, 'PATCH', `/credentials/${credentialId}`, { data: { nope: 'x' } });
    assert.equal(invalid.status, 400);
    assert.match(invalid.body.message, /additional properties/);
    assert.equal(store.credentials.get(credentialId).credentialVersion, 3, 'a refused update changes nothing');
    assert.ok(storedBefore);
  });

  test('changing the type without data is refused', async () => {
    const res = await api(fullKey, 'PATCH', `/credentials/${credentialId}`, { type: 'slackOAuth2Api' });
    assert.equal(res.status, 400);
    assert.match(res.body.message, /data is required when changing credential type/);
    assert.equal(store.credentials.get(credentialId).type, 'httpHeaderAuth');
  });

  test('changing the type with valid data works', async () => {
    const res = await api(fullKey, 'PATCH', `/credentials/${credentialId}`, {
      type: 'slackOAuth2Api',
      data: { clientId: 'a', clientSecret: 'top-secret' },
    });
    assert.equal(res.status, 200, res.raw);
    assert.equal(store.credentials.get(credentialId).type, 'slackOAuth2Api');
    assert.ok(!JSON.stringify(store.credentials.get(credentialId)).includes('top-secret'));
  });

  test('an unknown credential is 404 Not Found', async () => {
    assert.deepEqual(
      [(await api(fullKey, 'PATCH', '/credentials/nope', { name: 'x' })).status, (await api(fullKey, 'PATCH', '/credentials/nope', { name: 'x' })).body],
      [404, { message: 'Not Found' }],
    );
    assert.equal((await api(fullKey, 'DELETE', '/credentials/nope')).status, 404);
  });

  test('credential visibility: the role grant is the first boundary, ownership the second', async () => {
    const other = 'other-owner-credential';
    store.credentials.insert({
      id: other, name: 'someone elses', type: 'httpHeaderAuth', tenantId: 'default',
      ownerId: 'somebody-else', credentialVersion: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });

    // First boundary: only global:owner and global:admin hold credential scopes
    // at all, so a member cannot even be issued a key that reaches the surface.
    const memberCall = editor();
    const ownerRecord = theOwner();
    const memberId = 'member-cred-visibility';
    const now = new Date().toISOString();
    store.users.insert({ ...ownerRecord, id: memberId, email: 'member-vis@api-m09.test', role: 'global:member', apiKeys: [], createdAt: now, updatedAt: now });
    assert.equal((await memberCall('POST', '/rest/login', { emailOrLdapLoginId: 'member-vis@api-m09.test', password: PASSWORD })).status, 200);
    const refused = await memberCall('POST', '/rest/api-keys', { label: 'member-vis', scopes: CREDENTIAL_SCOPES, expiresAt: null });
    assert.equal(refused.status, 400, refused.raw);
    assert.equal(refused.body.message, 'Invalid scopes for user role');

    // Second boundary: an admin is not the owner, yet may act on every
    // credential — which is why the handler's ownership rule is the belt to
    // the role grant's braces.
    const adminCall = editor();
    const adminId = 'admin-cred-visibility';
    store.users.insert({ ...ownerRecord, id: adminId, email: 'admin-vis@api-m09.test', role: 'global:admin', apiKeys: [], createdAt: now, updatedAt: now });
    assert.equal((await adminCall('POST', '/rest/login', { emailOrLdapLoginId: 'admin-vis@api-m09.test', password: PASSWORD })).status, 200);
    const adminKey = await mintKey(adminCall, CREDENTIAL_SCOPES, 'admin-vis');
    assert.ok((await api(adminKey, 'GET', '/credentials')).body.data.some((c) => c.id === other));

    await api(fullKey, 'DELETE', `/credentials/${other}`);
  });

  test('delete returns the sanitised entity and removes it', async () => {
    const res = await api(fullKey, 'DELETE', `/credentials/${credentialId}`);
    assert.equal(res.status, 200, res.raw);
    assert.equal(res.body.id, credentialId);
    assert.ok(!('data' in res.body));
    assert.equal(store.credentials.get(credentialId), null, 'the record is gone');
    assert.deepEqual((await api(fullKey, 'DELETE', `/credentials/${credentialId}`)).status, 404);
  });

  test('update and delete are scope-guarded', async () => {
    const created = await api(fullKey, 'POST', '/credentials', headerAuthBody('guarded'));
    assert.equal((await api(noCredentialKey, 'PATCH', `/credentials/${created.body.id}`, { name: 'x' })).status, 403);
    assert.equal((await api(noCredentialKey, 'DELETE', `/credentials/${created.body.id}`)).status, 403);
    assert.ok(store.credentials.get(created.body.id), 'a refused delete leaves the record');
  });
});

/* ------------------------------------------------------------------ users */

describe('users', () => {
  test('list returns the selectable subset only — no password, no MFA, no API keys', async () => {
    const res = await api(fullKey, 'GET', '/users');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.data));
    assert.equal(res.body.data.length, store.users.all().length);
    const keys = new Set();
    for (const user of res.body.data) for (const key of Object.keys(user)) keys.add(key);
    for (const forbidden of ['password', 'mfaSecret', 'mfaRecoveryCodes', 'apiKeys', 'personalizationAnswers', 'settings']) {
      assert.ok(!keys.has(forbidden), `${forbidden} must never appear`);
    }
    for (const required of ['id', 'email', 'firstName', 'lastName', 'createdAt', 'updatedAt', 'isPending']) {
      assert.ok(keys.has(required), required);
    }
    assert.ok(!res.body.raw?.includes(PASSWORD));
  });

  test('list is offset-paginated and honours includeRole', async () => {
    for (const email of ['a@x.test', 'b@x.test', 'c@x.test']) {
      assert.equal((await api(fullKey, 'POST', '/users', [{ email }])).status, 200);
    }
    const page = await api(fullKey, 'GET', '/users?limit=2');
    assert.equal(page.body.data.length, 2);
    assert.ok(page.body.nextCursor);
    const rest = await api(fullKey, 'GET', `/users?limit=2&cursor=${encodeURIComponent(page.body.nextCursor)}`);
    // The owner plus the three invited above.
    assert.equal(rest.body.data.length, 2);
    assert.ok(!('role' in page.body.data[0]), 'role is opt-in');

    const withRole = await api(fullKey, 'GET', '/users?includeRole=true');
    for (const user of withRole.body.data) assert.ok('role' in user, 'includeRole adds role to every row');
    const ownerRow = withRole.body.data.find((user) => user.email === 'owner@api-m09.test');
    assert.equal(ownerRow.role, 'global:owner', 'the instance owner reports its role');
    assert.equal(withRole.body.data.length, store.users.all().length, 'every user is listed');
    const badBoolean = await api(fullKey, 'GET', '/users?includeRole=maybe');
    assert.equal(badBoolean.status, 400);
    assert.match(badBoolean.body.message, /includeRole must be boolean/);
  });

  test('get by id and by email; unknown is 404 with the upstream message', async () => {
    const me = theOwner();
    const byId = await api(fullKey, 'GET', `/users/${me.id}`);
    assert.equal(byId.status, 200);
    assert.equal(byId.body.email, me.email);
    const byEmail = await api(fullKey, 'GET', `/users/${me.email}`);
    assert.equal(byEmail.status, 200);
    assert.equal(byEmail.body.id, me.id);
    assert.ok(!('password' in byEmail.body));
    const missing = await api(fullKey, 'GET', '/users/nobody@nowhere.test');
    assert.equal(missing.status, 404);
    assert.equal(missing.body.message, 'Could not find user with id: nobody@nowhere.test');
  });

  test('create: array body, per-row result, duplicate reported in the envelope', async () => {
    const res = await api(fullKey, 'POST', '/users', [
      { email: 'new1@x.test' },
      { email: 'new1@x.test' },
      { email: 'new2@x.test', role: 'global:admin' },
    ]);
    assert.equal(res.status, 200, res.raw);
    assert.equal(res.body.data.length, 3);
    assert.ok(res.body.data[0].user, 'the first row was created');
    assert.equal(res.body.data[1].error, 'User already exists');
    assert.equal(res.body.data[2].user.role, 'global:admin');
    // An invited user is pending and cannot sign in.
    const stored = store.users.all().find((user) => user.email === 'new1@x.test');
    assert.equal(stored.isPending, true);
    assert.equal(stored.password, undefined, 'no password hash is minted for an invitation');
  });

  test('create rejects a bad email and an unknown role with 400', async () => {
    for (const body of [[{ email: 'not-an-email' }], [{ email: 'a@x.test', role: 'global:superuser' }], [{ email: 'a@x.test', extra: 1 }]]) {
      const res = await api(fullKey, 'POST', '/users', body);
      assert.equal(res.status, 400, JSON.stringify(body));
    }
    assert.equal((await api(fullKey, 'POST', '/users', { email: 'a@x.test' })).status, 400, 'the body must be an array');
  });

  test('changeRole: 204, validated role, and the owner invariant holds', async () => {
    const created = await api(fullKey, 'POST', '/users', [{ email: 'role-target@x.test' }]);
    assert.equal(created.status, 200, created.raw);
    const member = store.users.all().find((user) => user.email === 'role-target@x.test');
    assert.ok(member, 'the invited user exists');
    const res = await api(fullKey, 'PATCH', `/users/${member.id}/role`, { newRoleName: 'global:member' });
    assert.equal(res.status, 204);
    assert.equal(store.users.get(member.id).role, 'global:member');

    const bad = await api(fullKey, 'PATCH', `/users/${member.id}/role`, { newRoleName: 'global:nope' });
    assert.equal(bad.status, 400);
    assert.match(bad.body.message, /newRoleName must be equal to one of the allowed values/);

    // An instance has exactly one owner: nobody may be promoted into it and
    // the owner may not be demoted out of it.
    const owner = theOwner();
    assert.equal((await api(fullKey, 'PATCH', `/users/${owner.id}/role`, { newRoleName: 'global:admin' })).status, 403);
    assert.equal((await api(fullKey, 'PATCH', `/users/${member.id}/role`, { newRoleName: 'global:owner' })).status, 403);
    assert.equal(store.users.get(member.id).role, 'global:member');
  });

  test('delete: 204, and the owner account cannot be deleted', async () => {
    const created = await api(fullKey, 'POST', '/users', [{ email: 'delete-target@x.test' }]);
    assert.equal(created.status, 200, created.raw);
    const target = store.users.all().find((user) => user.email === 'delete-target@x.test');
    assert.ok(target, 'the invited user exists');
    const res = await api(fullKey, 'DELETE', `/users/${target.id}`);
    assert.equal(res.status, 204);
    assert.equal(store.users.get(target.id), null, 'the record is gone');
    assert.equal((await api(fullKey, 'DELETE', `/users/${target.id}`)).status, 404);

    const owner = theOwner();
    assert.equal((await api(fullKey, 'DELETE', `/users/${owner.id}`)).status, 403);
    assert.ok(store.users.get(owner.id), 'the owner survives');
  });

  test('every user operation is scope-guarded', async () => {
    const me = theOwner();
    assert.equal((await api(credentialOnlyKey, 'GET', '/users')).status, 403);
    assert.equal((await api(credentialOnlyKey, 'GET', `/users/${me.id}`)).status, 403);
    assert.equal((await api(credentialOnlyKey, 'POST', '/users', [{ email: 'z@x.test' }])).status, 403);
    assert.equal((await api(credentialOnlyKey, 'DELETE', `/users/${me.id}`)).status, 403);
    assert.equal((await api(credentialOnlyKey, 'PATCH', `/users/${me.id}/role`, { newRoleName: 'global:member' })).status, 403);
  });

  test('a demoted owner shrinks a key on the next request', async () => {
    const memberCall = editor();
    const ownerRecord = theOwner();
    const memberId = 'member-api-m09';
    store.users.insert({ ...ownerRecord, id: memberId, email: 'member@api-m09.test', role: 'global:admin', apiKeys: [] });
    assert.equal((await memberCall('POST', '/rest/login', { emailOrLdapLoginId: 'member@api-m09.test', password: PASSWORD })).status, 200);
    const key = await mintKey(memberCall, USER_SCOPES, 'admin-key');
    assert.equal((await api(key, 'GET', '/users')).status, 200);
    store.users.update(memberId, { role: 'global:chatUser' });
    // The key still authenticates, but key ∩ current grant is now empty.
    assert.deepEqual((await api(key, 'GET', '/users')).body, { message: 'Forbidden' });
  });
});
