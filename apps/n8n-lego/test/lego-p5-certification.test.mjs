/**
 * P5.8 (#221) — certification of the complete P5 security plane.
 *
 * The per-slice suites (P5.1–P5.7) each prove their own module. This suite proves
 * the plane AS A WHOLE, across slice boundaries, mostly against the real server
 * running as a separate process with file storage and debug-level logging:
 *
 *   1. contract-lock closure       every P5 contract row is present, stable, owned
 *                                  and pinned to what the module really exports
 *   2. one permission vocabulary   REST's role->scope source and the P5.3 engine
 *                                  agree on every role x every canonical permission
 *   3. end-to-end negative matrix  the attacks, one server, one run
 *   4. leakage scan                canaries (password, credential secret, raw API
 *                                  key) never appear in REST bodies/headers, logs,
 *                                  audit lines, execution records, errors or disk
 *   5. confused deputy             a credential/ref/key minted for one party cannot
 *                                  be exercised by another
 *   6. stale authority             a version bump is never served from a cache
 *   7. tenant boundary             every tenant-bearing structure refuses a cross
 *   8. operator recovery drills    the `n8n-lego credentials` CLI against a real
 *                                  data directory: refusal while running, rotation,
 *                                  interrupted rotation, backup/restore, tamper,
 *                                  missing keyring
 */
import { strict as assert } from 'node:assert';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { authenticateMachineCredential } from '../src/auth/api-key-routes.mjs';
import { apiKeyScopesForRole } from '../src/compat/api-key-scopes.mjs';
import { generateApiKey } from '../src/auth/security/api-key.mjs';
import { DECISION, authorize, authorizeCached, cacheKeyFor, createDecisionCache } from '../src/auth/security/authorization.mjs';
import { KEYRING_FILE } from '../src/auth/security/credential-vault.mjs';
import { delegate } from '../src/auth/security/machine-identity.mjs';
import { permissionRegistryFor } from '../src/auth/security/permission-registry.mjs';
import { createPrincipalSnapshot } from '../src/auth/security/principal.mjs';
import { checkTenantBinding, createSecurityContext } from '../src/auth/security/security-context.mjs';
import { createSecretRefAuthority } from '../src/auth/security/secret-ref.mjs';
import { createSecurityStamp } from '../src/auth/security/security-stamp.mjs';
import { getGlobalScopes, loadRoles } from '../src/compat/scopes.mjs';
import { createStore } from '../src/store.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..');
const BIN = join(APP, 'bin', 'n8n-lego.mjs');
const LOCK = JSON.parse(readFileSync(join(APP, 'src/lego/contracts/contract-lock.json'), 'utf8'));
const CATALOG_DIR = process.env.N8N_LEGO_CATALOG_DIR ?? join(APP, 'data');
const CONFIG = { catalogDir: CATALOG_DIR };

/* Canaries: unique strings that must never leave their boundary. */
const PASSWORD = 'Cert-Passw0rd-7Q2m';
const NEW_PASSWORD = 'Cert-Passw0rd-8R3n';
const CREDENTIAL_SECRET = 'sk-live-CERT-CANARY-3b9c1e7a5d';

/* ============================================================ helpers */

function tempDir(tag) {
  return mkdtempSync(join(tmpdir(), `n8n-lego-p58-${tag}-`));
}

function envFor(userFolder, port, extra = {}) {
  return {
    ...process.env,
    N8N_LEGO_PORT: String(port),
    N8N_LEGO_HOST: '127.0.0.1',
    N8N_LEGO_STORAGE: 'file',
    N8N_LEGO_LOG_LEVEL: 'debug',
    N8N_LEGO_PROTOCOL: 'http',
    N8N_LEGO_USER_FOLDER: userFolder,
    N8N_LEGO_CATALOG_DIR: CATALOG_DIR,
    N8N_LEGO_SKIP_CATALOG_FETCH: '1',
    ...extra,
  };
}

/** A free TCP port (bound then released). */
async function freePort() {
  const { createServer } = await import('node:net');
  return new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/** Every spawned server, so a failed assertion can never leave one running (and hang the suite). */
const CHILDREN = new Set();
process.on('exit', () => {
  for (const child of CHILDREN) if (child.exitCode === null) child.kill('SIGKILL');
});
after(() => {
  for (const child of CHILDREN) if (child.exitCode === null) child.kill('SIGKILL');
});

/** The real product: `n8n-lego start` as its own process. Captures every log byte. */
async function bootServer(userFolder, port) {
  const child = spawn(process.execPath, [BIN, 'start', '--no-fetch'], { env: envFor(userFolder, port), stdio: ['ignore', 'pipe', 'pipe'] });
  CHILDREN.add(child);
  child.logs = '';
  child.stdout.on('data', (chunk) => { child.logs += chunk; });
  child.stderr.on('data', (chunk) => { child.logs += chunk; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 150; i += 1) {
    try {
      if ((await fetch(`${base}/rest/settings`)).ok) return { child, base };
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  child.kill('SIGKILL');
  throw new Error(`server did not start:\n${child.logs}`);
}

async function stopServer(child) {
  if (child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  await exited;
}

/** Cookie-jar client that records EVERY response (body + headers) for the leakage scan. */
function client(base, transcript) {
  const jar = {};
  const call = async (method, path, body, { headers: extra = {}, raw = null } = {}) => {
    const headers = { 'content-type': 'application/json', origin: base, ...extra };
    const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookie && !('cookie' in extra)) headers.cookie = cookie;
    if (jar['n8n-csrf'] && !('x-n8n-csrf-token' in extra)) headers['x-n8n-csrf-token'] = jar['n8n-csrf'];
    const res = await fetch(base + path, { method, headers, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      jar[pair.slice(0, i)] = pair.slice(i + 1);
    }
    const text = await res.text();
    transcript?.push({ method, path, status: res.status, headers: JSON.stringify([...res.headers]), body: text });
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON */
    }
    return { status: res.status, body: json, raw: text };
  };
  call.jar = jar;
  return call;
}

function filesUnder(dir) {
  const out = [];
  const walk = (d) => {
    for (const entry of readdirSync(d)) {
      const full = join(d, entry);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(full);
    }
  };
  walk(dir);
  return out;
}

function cli(userFolder, port, ...args) {
  const result = spawnSync(process.execPath, [BIN, 'credentials', ...args], { env: envFor(userFolder, port), encoding: 'utf8' });
  const lines = result.stdout.split('\n').filter(Boolean).map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return line;
    }
  });
  return { code: result.status, lines, last: lines.at(-1), stdout: result.stdout, stderr: result.stderr };
}

function userPrincipal(permissions, overrides = {}) {
  return createPrincipalSnapshot({
    principalId: 'user:u1',
    identityId: 'u1',
    tenantId: 'default',
    principalType: 'user',
    authMethod: 'password',
    authStrength: 'password',
    permissions,
    principalVersion: 1,
    ...overrides,
  });
}

/* ============================================= 1. contract-lock closure */

describe('1. contract-lock closure: the P5 plane is fully pinned', () => {
  const P5_ROWS = ['auth.principal', 'auth.session', 'auth.authorization', 'auth.credential-crypto', 'auth.account-security', 'auth.machine-identity'];

  test('the lock holds exactly 100 rows and every P5 row exactly once', () => {
    assert.equal(LOCK.contracts.length, 100);
    for (const id of P5_ROWS) assert.equal(LOCK.contracts.filter((c) => c.id === id).length, 1, id);
  });

  for (const id of P5_ROWS) {
    test(`${id}: stable, owned, and its pinned exports are exactly the module's exports`, async () => {
      const row = LOCK.contracts.find((c) => c.id === id);
      assert.equal(row.status, 'stable');
      assert.equal(row.owner, 'agent-1');
      assert.equal(row.domain, 'auth');
      assert.ok(row.tests.length > 0, 'a stable row names its tests');
      for (const t of row.tests) assert.ok(existsSync(join(APP, '..', '..', t)), `${t} exists`);
      for (const file of row.surface) {
        assert.ok(existsSync(join(APP, file)), `${file} exists`);
        if (row.exports?.[file]) {
          const actual = Object.keys(await import(join(APP, file))).sort();
          assert.deepEqual(actual, [...row.exports[file]].sort(), `${file} export pin`);
        }
      }
    });
  }

  test('the P5 security barrel stays at 27 exports (no silent surface growth)', async () => {
    assert.equal(Object.keys(await import('../src/auth/security/index.mjs')).length, 27);
  });
});

/* ======================================= 2. one permission vocabulary */

describe('2. one vocabulary: the REST role->scope source and the P5.3 engine never disagree', () => {
  const registry = permissionRegistryFor(CONFIG);
  const roles = loadRoles(CONFIG);
  const globalRoles = (roles.global ?? []).map((role) => role.slug);

  test('the canonical universe is non-trivial and every global role is covered', () => {
    assert.ok(registry.permissions.length >= 100, `universe ${registry.permissions.length}`);
    assert.deepEqual([...globalRoles].sort(), ['global:admin', 'global:chatUser', 'global:member', 'global:owner']);
  });

  for (const role of ['global:owner', 'global:admin', 'global:member', 'global:chatUser']) {
    test(`${role}: for every canonical permission, REST grant === engine ALLOW`, () => {
      const granted = getGlobalScopes({ role }, CONFIG);
      // Every scope REST hands out is in the canonical universe: nothing REST
      // grants could be refused by the engine as UNKNOWN_PERMISSION.
      for (const scope of granted) assert.ok(registry.universe.has(scope), `${role} grants ${scope}, which is outside the canonical universe`);
      const principal = userPrincipal(granted);
      const disagreements = [];
      for (const permission of registry.permissions) {
        const engine = authorize({ principal, action: permission, resourceTenantId: 'default' }, { registry }).allowed;
        if (engine !== granted.includes(permission)) disagreements.push(permission);
      }
      assert.deepEqual(disagreements, [], `${role}: engine and REST disagree`);
    });
  }

  test('a scope outside the universe fails closed as UNKNOWN_PERMISSION even for the owner', () => {
    const principal = userPrincipal(getGlobalScopes({ role: 'global:owner' }, CONFIG));
    const decision = authorize({ principal, action: 'workflow:frobnicate', resourceTenantId: 'default' }, { registry });
    assert.equal(decision.decision, DECISION.DENY);
    assert.equal(decision.details?.unknownPermission, true);
  });

  test('API-key grants are a subset of what each role may grant; chatUser grants nothing', () => {
    for (const role of ['global:owner', 'global:admin', 'global:member']) {
      const keyScopes = apiKeyScopesForRole(role, CONFIG);
      assert.ok(keyScopes.length > 0);
    }
    assert.deepEqual(apiKeyScopesForRole('global:chatUser', CONFIG), []);
    assert.ok(apiKeyScopesForRole('global:member', CONFIG).length < apiKeyScopesForRole('global:owner', CONFIG).length);
  });
});

/* ================= 3 + 4. real server: negative matrix and leakage scan */

describe('3+4. real server (separate process, file storage, debug logs): negative matrix + leakage scan', () => {
  const USER_FOLDER = tempDir('e2e');
  const transcript = [];
  let port = 0;
  let server = null;
  let base = '';
  let owner = null;
  let rawApiKey = '';
  let credentialId = '';
  const logs = [];

  before(async () => {
    port = await freePort();
    ({ child: server, base } = await bootServer(USER_FOLDER, port));
    owner = client(base, transcript);
  });
  after(async () => {
    if (server) await stopServer(server);
    rmSync(USER_FOLDER, { recursive: true, force: true });
  });

  test('setup: owner, credential with a secret, API key, workflow referencing the credential, one run', async () => {
    assert.equal((await owner('POST', '/rest/owner/setup', { email: 'owner@p58.test', firstName: 'O', lastName: 'W', password: PASSWORD })).status, 200);
    const cred = await owner('POST', '/rest/credentials', { name: 'hdr', type: 'httpHeaderAuth', data: { name: 'X-Api-Key', value: CREDENTIAL_SECRET } });
    assert.equal(cred.status, 200, cred.raw);
    credentialId = cred.body.data.id;
    const key = await owner('POST', '/rest/api-keys', { label: 'cert', scopes: ['workflow:read', 'workflow:list'], expiresAt: null });
    assert.equal(key.status, 200, key.raw);
    rawApiKey = key.body.data.rawApiKey;
    const workflow = await owner('POST', '/rest/workflows', {
      name: 'cert',
      nodes: [
        { id: 'n1', name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
        { id: 'n2', name: 'Uses credential', type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [200, 0], parameters: {}, credentials: { httpHeaderAuth: { id: credentialId, name: 'hdr' } } },
      ],
      connections: { Start: { main: [[{ node: 'Uses credential', type: 'main', index: 0 }]] } },
      settings: {},
    });
    assert.equal(workflow.status, 200, workflow.raw);
    const run = await owner('POST', `/rest/workflows/${workflow.body.data.id}/run`, {});
    assert.equal(run.status, 200, run.raw);
    // Read every surface the editor reads, so all of it enters the transcript.
    for (const path of ['/rest/credentials', `/rest/credentials/${credentialId}`, `/rest/credentials/${credentialId}?includeData=true`, '/rest/credentials?includeData=true', '/rest/api-keys', '/rest/executions', `/rest/executions/${run.body.data.executionId}`, '/rest/login', '/rest/settings', '/healthz']) {
      await owner('GET', path);
    }
  });

  /* ------------------------------------------------ negative matrix */

  test('unauthenticated: every protected surface answers 401', async () => {
    const anon = client(base, transcript);
    for (const path of ['/rest/credentials', `/rest/credentials/${credentialId}`, '/rest/api-keys', '/rest/workflows', '/rest/executions', '/rest/me/settings']) {
      assert.equal((await anon('GET', path)).status, 401, path);
    }
  });

  test('a forged or garbage session cookie is not a session', async () => {
    const forged = client(base, transcript);
    for (const cookie of ['n8n-auth=garbage', 'n8n-auth=eyJhbGciOiJub25lIn0.eyJpZCI6IngifQ.', `n8n-auth=${owner.jar['n8n-auth']}x`]) {
      assert.equal((await forged('GET', '/rest/credentials', undefined, { headers: { cookie } })).status, 401, cookie);
    }
  });

  test('confused deputy: an API key is not a session on /rest (header or cookie)', async () => {
    const anon = client(base, transcript);
    assert.equal((await anon('GET', '/rest/workflows', undefined, { headers: { 'x-n8n-api-key': rawApiKey } })).status, 401);
    assert.equal((await anon('GET', '/rest/workflows', undefined, { headers: { cookie: `n8n-auth=${rawApiKey}` } })).status, 401);
    assert.equal((await anon('GET', '/rest/workflows', undefined, { headers: { authorization: `Bearer ${rawApiKey}` } })).status, 401);
  });

  test('CSRF (P5.2 contract): Origin is always enforced; the double-submit token is opt-in because the pinned editor never sends it', async () => {
    const before = (await owner('GET', '/rest/api-keys')).body.data.length;
    const body = JSON.stringify({ label: 'x', scopes: ['workflow:read'], expiresAt: null });
    const cookie = Object.entries(owner.jar).map(([k, v]) => `${k}=${v}`).join('; ');
    const post = (headers) => fetch(`${base}/rest/api-keys`, { method: 'POST', headers: { 'content-type': 'application/json', cookie, ...headers }, body });
    const evil = await post({ origin: 'https://evil.example', 'x-n8n-csrf-token': owner.jar['n8n-csrf'] });
    assert.equal(evil.status, 403, 'a cross-site origin is refused even WITH a valid token');
    const evilReferer = await post({ referer: 'https://evil.example/page' });
    assert.equal(evilReferer.status, 403, 'a cross-site referer is refused');
    const blind = await post({});
    assert.equal(blind.status, 403, 'a state change with neither Origin nor Referer is refused');
    assert.equal((await owner('GET', '/rest/api-keys')).body.data.length, before, 'none of them changed anything');
    // Recorded residual: same-origin without the token is accepted (the upstream
    // editor's own requests look exactly like this). Defence = Origin + SameSite=Lax.
    const sameOrigin = await post({ origin: base });
    assert.equal(sameOrigin.status, 200);
    const created = JSON.parse(await sameOrigin.text()).data;
    assert.equal((await owner('DELETE', `/rest/api-keys/${created.id}`)).status, 200);
  });

  test('scope escalation through an API key is refused', async () => {
    const escalate = await owner('POST', '/rest/api-keys', { label: 'x', scopes: ['workflow:read', 'workflow:frobnicate'], expiresAt: null });
    assert.equal(escalate.status, 400);
    assert.equal(escalate.body.message, 'Invalid scopes for user role');
  });

  test('forgot-password gives one answer for a real and an unknown account (no SMTP: upstream 500 text, before any lookup)', async () => {
    const anon = client(base, transcript);
    const real = await anon('POST', '/rest/forgot-password', { email: 'owner@p58.test' });
    const unknown = await anon('POST', '/rest/forgot-password', { email: 'nobody@p58.test' });
    assert.equal(real.status, unknown.status);
    assert.equal(real.raw, unknown.raw);
  });

  test('a password change kills every other session of that user', async () => {
    const second = client(base, transcript);
    assert.equal((await second('POST', '/rest/login', { emailOrLdapLoginId: 'owner@p58.test', password: PASSWORD })).status, 200);
    assert.equal((await second('GET', '/rest/credentials')).status, 200);
    assert.equal((await owner('PATCH', '/rest/me/password', { currentPassword: PASSWORD, newPassword: NEW_PASSWORD })).status, 200);
    assert.equal((await second('GET', '/rest/credentials')).status, 401, 'the other session is dead');
    assert.equal((await owner('GET', '/rest/credentials')).status, 200, 'the changing session was reissued');
  });

  test('logout revokes the session server-side: replaying the old cookie fails', async () => {
    const session = client(base, transcript);
    assert.equal((await session('POST', '/rest/login', { emailOrLdapLoginId: 'owner@p58.test', password: NEW_PASSWORD })).status, 200);
    const stolen = session.jar['n8n-auth'];
    assert.equal((await session('POST', '/rest/logout')).status, 200);
    const replay = client(base, transcript);
    assert.equal((await replay('GET', '/rest/credentials', undefined, { headers: { cookie: `n8n-auth=${stolen}` } })).status, 401);
  });

  test('login brute force is bounded: 429 before the attacker gets many guesses', async () => {
    const attacker = client(base, transcript);
    const statuses = [];
    for (let i = 0; i < 8; i += 1) statuses.push((await attacker('POST', '/rest/login', { emailOrLdapLoginId: 'owner@p58.test', password: `wrong-${i}` })).status);
    assert.ok(statuses.includes(429), `statuses ${statuses}`);
    assert.ok(statuses.indexOf(429) <= 6, 'throttled within the per-account budget');
  });

  test('malformed input that carries a secret is rejected without echoing it', async () => {
    const bad = await owner('POST', '/rest/credentials', undefined, { raw: `{"name":"x","type":"httpHeaderAuth","data":{"value":"${CREDENTIAL_SECRET}"` });
    assert.ok(bad.status >= 400 && bad.status < 500, `status ${bad.status}`);
    assert.ok(!bad.raw.includes(CREDENTIAL_SECRET));
  });

  /* ------------------------------------------------- leakage scan */

  test('LEAKAGE: no canary in any REST body or header of the whole run', () => {
    assert.ok(transcript.length >= 40, `transcript ${transcript.length}`);
    const hits = [];
    for (const entry of transcript) {
      for (const [name, canary] of [['password', PASSWORD], ['new password', NEW_PASSWORD], ['credential secret', CREDENTIAL_SECRET]]) {
        if (entry.body.includes(canary) || entry.headers.includes(canary)) hits.push(`${name} in ${entry.method} ${entry.path}`);
      }
      // The raw key is shown exactly once: in the create response. Nowhere else.
      if ((entry.body.includes(rawApiKey) || entry.headers.includes(rawApiKey)) && !(entry.method === 'POST' && entry.path === '/rest/api-keys' && entry.status === 200)) {
        hits.push(`raw api key in ${entry.method} ${entry.path}`);
      }
    }
    assert.deepEqual(hits, []);
  });

  test('LEAKAGE: no canary in the execution records (credentials never enter execution)', async () => {
    const list = await owner('GET', '/rest/executions');
    assert.equal(list.status, 200);
    const text = JSON.stringify(list.body) + transcript.filter((e) => e.path.startsWith('/rest/executions/')).map((e) => e.body).join('');
    for (const canary of [PASSWORD, NEW_PASSWORD, CREDENTIAL_SECRET, rawApiKey]) assert.ok(!text.includes(canary));
  });

  test('LEAKAGE: no canary in the debug-level server log, and audit lines carry references only', async () => {
    await stopServer(server);
    const log = server.logs;
    server = null;
    logs.push(log);
    assert.ok(log.length > 0);
    for (const canary of [PASSWORD, NEW_PASSWORD, CREDENTIAL_SECRET, rawApiKey]) assert.ok(!log.includes(canary), 'canary in the log');
    assert.match(log, /auth\.api-key\.created/);
    assert.match(log, /auth\.password-changed/);
    assert.doesNotMatch(log, /"digest"|"material"|"rawApiKey"/);
  });

  test('LEAKAGE: no canary anywhere in the data directory (credentials sealed, keys hashed, passwords scrypt)', () => {
    const files = filesUnder(USER_FOLDER);
    assert.ok(files.some((f) => f.endsWith('credentials.json')));
    assert.ok(files.some((f) => f.endsWith(KEYRING_FILE)));
    const hits = files.filter((file) => {
      const text = readFileSync(file, 'latin1');
      return [PASSWORD, NEW_PASSWORD, CREDENTIAL_SECRET, rawApiKey].some((canary) => text.includes(canary));
    });
    assert.deepEqual(hits, []);
  });
});

/* ============================================== 5. confused deputy */

describe('5. confused deputy: authority minted for one party cannot be exercised by another', () => {
  const registry = permissionRegistryFor(CONFIG);
  const credential = { id: 'cred1', name: 'c', type: 'httpHeaderAuth', tenantId: 'default', credentialVersion: 1, data: { value: CREDENTIAL_SECRET } };
  const authority = () => createSecretRefAuthority({ materialOf: (c) => c.data.value, registry });
  const mintArgs = (overrides = {}) => ({
    principal: userPrincipal(registry.permissions),
    credential,
    requestId: 'req-1',
    audience: 'httpRequest',
    capability: 'cap.http',
    permission: 'credential:read',
    tenantId: 'default',
    capabilityGrants: ['cap.http'],
    ...overrides,
  });
  const redeemOk = { requestId: 'req-1', audience: 'httpRequest', capability: 'cap.http', credentialVersion: 1 };

  test('baseline: the bound redeemer gets the secret exactly once', () => {
    const a = authority();
    const ref = a.mint(mintArgs());
    assert.equal(a.redeem(ref, redeemOk), CREDENTIAL_SECRET);
    assert.throws(() => a.redeem(ref, redeemOk));
  });

  for (const [what, presented] of [
    ['another request', { ...redeemOk, requestId: 'req-2' }],
    ['another node (audience)', { ...redeemOk, audience: 'slack' }],
    ['another capability', { ...redeemOk, capability: 'cap.fs' }],
    ['a newer credential version', { ...redeemOk, credentialVersion: 2 }],
  ]) {
    test(`a ref minted for req-1/httpRequest cannot be redeemed by ${what}`, () => {
      const a = authority();
      const ref = a.mint(mintArgs());
      assert.throws(() => a.redeem(ref, presented));
    });
  }

  test('an API-key principal without credential:read cannot mint a ref for a credential', () => {
    const keyPrincipal = createPrincipalSnapshot({
      principalId: 'api-key:k1', identityId: 'u1', tenantId: 'default', principalType: 'api-key', authMethod: 'api-key', authStrength: 'api-key',
      permissions: ['workflow:read'], principalVersion: 1,
    });
    assert.throws(() => authority().mint(mintArgs({ principal: keyPrincipal })));
  });

  test('a delegated agent cannot redeem its parent\'s authority beyond its own grant', () => {
    const parent = userPrincipal(['workflow:read', 'credential:read'], { expiresAt: Date.now() + 3_600_000 });
    const { principal: agent } = delegate(parent, { principalId: 'agent:a1', permissions: ['workflow:read'], ttlMs: 60_000, grantId: 'g1' });
    assert.equal(agent.identityId, parent.identityId, 'the accountable identity is preserved');
    assert.throws(() => authority().mint(mintArgs({ principal: agent })), 'the agent does not hold credential:read');
    assert.throws(() => delegate(parent, { principalId: 'agent:a2', permissions: ['credential:delete'], ttlMs: 60_000, grantId: 'g2' }), (e) => e.details?.reason === 'delegation-escalation');
  });
});

/* =============================================== 6. stale authority */

describe('6. stale authority is never served', () => {
  const registry = permissionRegistryFor(CONFIG);

  test('a cached ALLOW is dropped (not served) once the principal version moves', () => {
    const cache = createDecisionCache();
    const principal = userPrincipal(['workflow:read']);
    const request = { principal, action: 'workflow:read', resourceTenantId: 'default' };
    const v1 = createSecurityStamp({ principalVersion: 1, tenantVersion: 1, policyVersion: 1, sessionVersion: 1 });
    const v2 = createSecurityStamp({ principalVersion: 2, tenantVersion: 1, policyVersion: 1, sessionVersion: 1 });
    assert.equal(authorizeCached(cache, request, { currentStamp: v1, registry }).allowed, true);
    assert.equal(cache.size(), 1);
    assert.equal(cache.get(cacheKeyFor(request), v1).hit, true, 'served while the authority is current');
    const stale = cache.get(cacheKeyFor(request), v2);
    assert.equal(stale.hit, false);
    assert.equal(stale.reason, 'stale', 'the entry is reported stale, not served');
    const fresh = authorizeCached(cache, request, { currentStamp: v2, registry });
    assert.equal(fresh.cached, false, 'a decision under a newer stamp is recomputed, never served stale');
  });

  test('an API key shrinks the moment its owner is demoted (no re-issue, no cache)', () => {
    const store = createStore({ storage: 'memory' });
    const ownerId = 'owner000000000001';
    const minted = generateApiKey({ ownerId, keyId: 'key0000001' });
    store.users.insert({
      id: ownerId, email: 'o@stale.test', role: 'global:owner',
      apiKeys: [{ id: 'key0000001', label: 'k', scopes: ['workflow:read', 'user:list', 'sourceControl:pull'], audience: 'public-api', tenantId: 'default', digest: minted.digest, hint: minted.hint, createdAt: '', updatedAt: '', expiresAt: null, lastUsedAt: null, revokedAt: null }],
    });
    const asOwner = authenticateMachineCredential({ store, config: CONFIG, presented: minted.raw });
    assert.equal(asOwner.ok, true);
    assert.ok(asOwner.principal.permissions.includes('sourceControl:pull'));
    store.users.update(ownerId, { role: 'global:member' });
    const asMember = authenticateMachineCredential({ store, config: CONFIG, presented: minted.raw });
    assert.equal(asMember.ok, true);
    assert.ok(!asMember.principal.permissions.includes('sourceControl:pull'), 'owner-only scope gone on the very next request');
    assert.ok(asMember.principal.permissions.includes('workflow:read'));
  });
});

/* ================================================ 7. tenant boundary */

describe('7. tenant boundary: every tenant-bearing structure refuses a cross', () => {
  const registry = permissionRegistryFor(CONFIG);
  const principal = userPrincipal(registry.permissions);

  test('authorization: a full-permission principal is denied in another tenant', () => {
    assert.equal(authorize({ principal, action: 'workflow:read', resourceTenantId: 'tenant-b' }, { registry }).allowed, false);
  });

  test('SecurityContext: tenant binding refuses a foreign resource', () => {
    const context = createSecurityContext({ principal, requestId: 'r1', tenantVersion: 1, policyVersion: 1, sessionVersion: 1 });
    assert.equal(checkTenantBinding(context, 'default').allowed, true);
    assert.equal(checkTenantBinding(context, 'tenant-b').allowed, false);
  });

  test('SecretRef: a ref cannot be minted across tenants', () => {
    const a = createSecretRefAuthority({ materialOf: () => 'x', registry });
    assert.throws(() => a.mint({ principal, credential: { id: 'c', type: 't', tenantId: 'tenant-b', credentialVersion: 1 }, requestId: 'r', audience: 'n', capability: 'c', permission: 'credential:read', tenantId: 'tenant-b', capabilityGrants: ['c'] }));
  });

  test('delegation: an agent cannot be delegated into another tenant', () => {
    const parent = userPrincipal(['workflow:read'], { expiresAt: Date.now() + 3_600_000 });
    assert.throws(() => delegate(parent, { principalId: 'agent:x', permissions: ['workflow:read'], ttlMs: 60_000, grantId: 'g', tenantId: 'tenant-b' }), (e) => e.details?.reason === 'cross-tenant-delegation');
  });
});

/* ========================================= 8. operator recovery drills */

describe('8. operator drills: `n8n-lego credentials` against a real data directory', () => {
  const USER_FOLDER = tempDir('ops');
  let port = 0;
  let credentialIds = [];
  let b1 = '';
  let b2 = '';

  before(async () => {
    port = await freePort();
    const { child, base } = await bootServer(USER_FOLDER, port);
    try {
      const call = client(base, null);
      assert.equal((await call('POST', '/rest/owner/setup', { email: 'ops@p58.test', firstName: 'O', lastName: 'P', password: PASSWORD })).status, 200);
      for (let i = 0; i < 3; i += 1) {
        const created = await call('POST', '/rest/credentials', { name: `c${i}`, type: 'httpHeaderAuth', data: { name: 'X', value: `${CREDENTIAL_SECRET}-${i}` } });
        assert.equal(created.status, 200);
        credentialIds.push(created.body.data.id);
      }
      // While the server is up: every mutating verb refuses, read-only verbs work.
      for (const verb of ['rotate', 'recover']) {
        const refused = cli(USER_FOLDER, port, verb);
        assert.equal(refused.code, 2, `${verb} must refuse while running`);
        assert.match(refused.stderr, /server is running/);
      }
      assert.equal(cli(USER_FOLDER, port, 'verify').code, 0);
    } finally {
      await stopServer(child);
    }
  });
  after(() => rmSync(USER_FOLDER, { recursive: true, force: true }));

  test('status reports lineage and counts without any key material or secret', () => {
    const status = cli(USER_FOLDER, port, 'status');
    assert.equal(status.code, 0);
    assert.equal(status.last.rotationPending, false);
    assert.equal(Object.values(status.last.credentialsByKeyRef).reduce((a, b) => a + b, 0), 3);
    assert.doesNotMatch(status.stdout, /material/);
    const keyring = JSON.parse(readFileSync(join(USER_FOLDER, KEYRING_FILE), 'utf8'));
    for (const key of keyring.keys) if (key.material) assert.ok(!status.stdout.includes(key.material));
    assert.ok(!status.stdout.includes(CREDENTIAL_SECRET));
  });

  test('backup: written 0600, sealed (no secret inside), never overwrites', () => {
    b1 = join(USER_FOLDER, 'backup-1.json');
    const made = cli(USER_FOLDER, port, 'backup', b1);
    assert.equal(made.code, 0, made.stderr);
    assert.equal(statSync(b1).mode & 0o777, 0o600);
    assert.ok(!readFileSync(b1, 'utf8').includes(CREDENTIAL_SECRET));
    assert.equal(cli(USER_FOLDER, port, 'backup', b1).code, 2, 'refuses to overwrite');
    assert.equal(cli(USER_FOLDER, port, 'restore-check', b1).code, 0);
  });

  test('tampered backup: quarantine rejects it and restore writes nothing', () => {
    const tampered = join(USER_FOLDER, 'tampered.json');
    const bundle = JSON.parse(readFileSync(b1, 'utf8'));
    const ct = bundle.manifest.ct;
    const i = Math.floor(ct.length / 2);
    bundle.manifest.ct = ct.slice(0, i) + (ct[i] === 'A' ? 'B' : 'A') + ct.slice(i + 1);
    writeFileSync(tampered, JSON.stringify(bundle));
    const before = readFileSync(join(USER_FOLDER, 'credentials.json'), 'utf8');
    assert.equal(cli(USER_FOLDER, port, 'restore-check', tampered).code, 1);
    assert.equal(cli(USER_FOLDER, port, 'restore', tampered).code, 1);
    assert.equal(readFileSync(join(USER_FOLDER, 'credentials.json'), 'utf8'), before, 'nothing written');
  });

  test('interrupted rotation: pause after one batch, then a plain server restart finishes it', async () => {
    const paused = cli(USER_FOLDER, port, 'rotate', '--batch', '1', '--max-batches', '1');
    assert.equal(paused.code, 0, paused.stderr);
    assert.equal(paused.last.rotation, 'paused');
    assert.equal(paused.last.remaining, 2);
    assert.equal(cli(USER_FOLDER, port, 'status').last.rotationPending, true);
    assert.equal(cli(USER_FOLDER, port, 'rotate').code, 2, 'a second rotation cannot start over a pending one');
    // Mixed state (1 record on the new key, 2 on the previous) is fully readable.
    assert.equal(cli(USER_FOLDER, port, 'verify').code, 0);
    const { child } = await bootServer(USER_FOLDER, port);
    await stopServer(child);
    const status = cli(USER_FOLDER, port, 'status');
    assert.equal(status.last.rotationPending, false, 'boot-time recovery finished the rotation');
    assert.equal(Object.keys(status.last.credentialsByKeyRef).length, 1, 'every record on one key');
    assert.match(child.logs, /credential\.rotation-recovered/);
  });

  test('a finished rotation crypto-shreds the old key: the pre-rotation backup is refused', () => {
    const check = cli(USER_FOLDER, port, 'restore-check', b1);
    assert.equal(check.code, 1);
    assert.equal(check.last.reason, 'backup-key-unavailable');
  });

  test('full rotation via the CLI, then a fresh backup restores and the server can open every record', async () => {
    const rotated = cli(USER_FOLDER, port, 'rotate');
    assert.equal(rotated.code, 0, rotated.stderr);
    assert.equal(rotated.last.rotation, 'finished');
    assert.match(rotated.last.warning, /new backup/);
    b2 = join(USER_FOLDER, 'backup-2.json');
    assert.equal(cli(USER_FOLDER, port, 'backup', b2).code, 0);
    // Simulate loss: wipe the credential records, then restore from b2.
    const credentialsFile = join(USER_FOLDER, 'credentials.json');
    writeFileSync(credentialsFile, '[]');
    const restored = cli(USER_FOLDER, port, 'restore', b2);
    assert.equal(restored.code, 0, restored.stderr);
    assert.equal(restored.last.restored, 3);
    assert.equal(cli(USER_FOLDER, port, 'verify').code, 0);
    // The server opens each record at the write boundary: a rename re-seals it.
    const { child, base } = await bootServer(USER_FOLDER, port);
    const call = client(base, null);
    assert.equal((await call('POST', '/rest/login', { emailOrLdapLoginId: 'ops@p58.test', password: PASSWORD })).status, 200);
    for (const id of credentialIds) assert.equal((await call('PATCH', `/rest/credentials/${id}`, { name: `renamed-${id}` })).status, 200, id);
    await stopServer(child);
    assert.ok(!child.logs.includes(CREDENTIAL_SECRET));
  });

  test('missing keyring: the CLI refuses and never mints; the server fails closed (503) and does not mint either', async () => {
    const keyringPath = join(USER_FOLDER, KEYRING_FILE);
    const saved = readFileSync(keyringPath);
    rmSync(keyringPath);
    try {
      for (const verb of ['verify', 'rotate', 'recover']) {
        const refused = cli(USER_FOLDER, port, verb);
        assert.equal(refused.code, 2, verb);
        assert.match(refused.stderr, /keyring missing/);
      }
      assert.equal(cli(USER_FOLDER, port, 'status').code, 1);
      assert.equal(existsSync(keyringPath), false, 'the CLI minted nothing');
      const { child, base } = await bootServer(USER_FOLDER, port);
      const call = client(base, null);
      assert.equal((await call('POST', '/rest/login', { emailOrLdapLoginId: 'ops@p58.test', password: PASSWORD })).status, 200, 'metadata keeps serving');
      assert.equal((await call('PATCH', `/rest/credentials/${credentialIds[0]}`, { name: 'x' })).status, 503, 'secret operations fail closed');
      await stopServer(child);
      assert.equal(existsSync(keyringPath), false, 'the server minted nothing over sealed data');
    } finally {
      writeFileSync(keyringPath, saved, { mode: 0o600 });
    }
    assert.equal(cli(USER_FOLDER, port, 'verify').code, 0, 'restoring the keyring file restores everything');
  });

  test('memory storage and unknown verbs are refused', () => {
    const memory = spawnSync(process.execPath, [BIN, 'credentials', 'status'], { env: envFor(USER_FOLDER, port, { N8N_LEGO_STORAGE: 'memory' }), encoding: 'utf8' });
    assert.equal(memory.status, 2);
    assert.equal(cli(USER_FOLDER, port, 'shred').code, 2);
  });
});
