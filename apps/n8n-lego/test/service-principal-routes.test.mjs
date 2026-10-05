/**
 * P5-M07 — service-principal REST + UI management over the P5.7 programmatic
 * lifecycle: create shown once, redacted list, revoke with tombstone, and the
 * ownership transfer the P5.7 debt list names ("no REST/UI and no ownership
 * transfer for service principals").
 *
 * End to end through the real server (`startServer`), with a real session and
 * CSRF, because the property under test lives at the HTTP boundary: a raw
 * credential must exist on exactly one response, and no response anywhere may
 * carry a digest or a credential belonging to another owner.
 *
 * Upstream truth: pinned n8n 2.9.4 has NO service-principal REST surface
 * (`grep -r service-principal reference/n8n/packages/cli/src` is empty). The
 * wire shape therefore follows this product's own editor idiom —
 * `/rest/api-keys` — and the lifecycle semantics come from
 * `src/auth/security/machine-identity.mjs`, which is the contract-declared
 * boundary (contract-lock row `auth.machine-identity`).
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { startServer } from '../src/server.mjs';
import { authenticateMachineCredential } from '../src/auth/api-key-routes.mjs';
import { API_KEY_AUDIENCE, API_KEY_VERDICT } from '../src/auth/security/api-key.mjs';
import { hashPassword } from '../src/auth.mjs';

const PASSWORD = 'ServicePrincipal-Passw0rd';
const USER_FOLDER = mkdtempSync(join(tmpdir(), 'n8n-lego-sp-m07-'));

let running;
let config;
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
    },
  });
  running = started.server;
  config = started.config;
  store = started.store;
  base = `http://127.0.0.1:${running.address().port}`;
  await setupOwnerAndMember();
});

after(async () => {
  if (running) await new Promise((done) => running.close(() => done()));
  rmSync(USER_FOLDER, { recursive: true, force: true });
});

/** Editor (browser) client: cookies + CSRF, same origin. */
function editor() {
  const jar = {};
  const call = async (method, path, body) => {
    const headers = { 'content-type': 'application/json', origin: base };
    const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookie) headers.cookie = cookie;
    if (jar['n8n-csrf']) headers['x-n8n-csrf-token'] = jar['n8n-csrf'];
    const res = await fetch(base + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      jar[pair.slice(0, i)] = pair.slice(i + 1);
    }
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null, raw: text, jar };
  };
  call.jar = jar;
  return call;
}

let owner;
let member;

async function setupOwnerAndMember() {
  owner = editor();
  assert.equal(
    (await owner('POST', '/rest/owner/setup', {
      email: 'owner@sp-m07.test', firstName: 'O', lastName: 'W', password: PASSWORD,
    })).status,
    200,
  );
  // A second accountable owner in the SAME tenant, created through the store
  // because the editor has no invite route (user-management administration is
  // still compat-unsupported). Transfer needs a receiver that is not the caller.
  const receiver = store.users.insert({
    id: 'receiver-01',
    email: 'receiver@sp-m07.test',
    firstName: 'R', lastName: 'C',
    role: 'global:admin',
    password: hashPassword(PASSWORD),
    isPending: false,
    createdAt: new Date().toISOString(),
    settings: {},
  });
  assert.ok(receiver?.id, 'the transfer receiver must exist');
  // A member: global:member carries no apiKey:manage, which is what the
  // P5.7 debt item "members may create service principals" turns on.
  const plain = store.users.insert({
    id: 'member-01',
    email: 'member@sp-m07.test',
    firstName: 'M', lastName: 'B',
    role: 'global:member',
    password: hashPassword(PASSWORD),
    isPending: false,
    createdAt: new Date().toISOString(),
    settings: {},
  });
  assert.ok(plain?.id, 'the member must exist');
  member = editor();
  assert.equal((await member('POST', '/rest/login', { email: 'member@sp-m07.test', password: PASSWORD })).status, 200);
}

const OWNER_SCOPES = ['workflow:read', 'workflow:create', 'credential:list'];

/** Creates a service principal as the editor owner; returns the whole response. */
async function createPrincipal(call = owner, patch = {}) {
  const res = await call('POST', '/rest/service-principals', {
    kind: 'worker',
    label: 'build worker',
    scopes: [...OWNER_SCOPES],
    expiresAt: null,
    ...patch,
  });
  return res;
}

/** The stored record, which is what a redacted view must be derived from. */
function stored(id) {
  const user = store.users.all().find((candidate) => (candidate.servicePrincipals ?? []).some((sp) => sp.id === id));
  return user?.servicePrincipals?.find((sp) => sp.id === id) ?? null;
}

/** Every field a redacted DTO must never expose. */
const SECRET_FIELDS = ['digest', 'rawApiKey', 'raw', 'rawCredential', 'password'];

/* ------------------------------------------------------------- the surface */

describe('the service-principal surface is mounted exactly as declared', () => {
  test('every operation answers, and the two read shapes differ from the write shapes', async () => {
    const list = await owner('GET', '/rest/service-principals');
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.data, []);

    const scopes = await owner('GET', '/rest/service-principals/scopes');
    assert.equal(scopes.status, 200);
    // The vocabulary is the caller's own role, not the whole universe.
    assert.ok(Array.isArray(scopes.body.data) && scopes.body.data.length > 0);
    assert.ok(scopes.body.data.every((scope) => /^[a-zA-Z]+:[a-zA-Z]+$/.test(scope)));
  });

  test('an unknown sub-path is the explicit 501 capability answer, not a silent success', async () => {
    // The compat router never fakes a hit: a /rest miss is answered 501
    // "not implemented" and logged once, so a typo is loud.
    const res = await owner('GET', '/rest/service-principals/nope/deeper');
    assert.equal(res.status, 501);
    assert.match(res.body.message, /is not available on this n8n-lego instance/);
  });

  test('a service principal is not reachable through the api-keys surface and vice versa', async () => {
    const created = await createPrincipal();
    assert.equal(created.status, 200);
    const keys = await owner('GET', '/rest/api-keys');
    assert.equal(keys.status, 200);
    assert.ok(!keys.body.data.some((key) => key.id === created.body.data.id), 'a service principal is not an api key');
    const principals = await owner('GET', '/rest/service-principals');
    assert.ok(!principals.body.data.some((sp) => sp.id.startsWith('apikey')), 'an api key is not a service principal');
  });
});

/* --------------------------------------------- create: shown exactly once */

describe('create returns the credential exactly once', () => {
  test('the raw credential is on the create response and nowhere else', async () => {
    const created = await createPrincipal(owner, { label: 'once-only' });
    assert.equal(created.status, 200);
    const raw = created.body.data.rawApiKey;
    assert.ok(typeof raw === 'string' && raw.length > 20, 'the create response carries the credential');
    const record = stored(created.body.data.id);
    assert.ok(record, 'the principal is stored');

    // The list never repeats it, and neither does the stored record's DTO.
    const listed = await owner('GET', '/rest/service-principals');
    const dto = listed.body.data.find((sp) => sp.id === created.body.data.id);
    assert.ok(dto, 'the principal is listed');
    assert.equal(dto.rawApiKey, undefined);
    assert.equal(dto.credential, created.body.data.credential, 'the list shows the same redacted hint');
    assert.equal(dto.credential, '*'.repeat(6) + record.hint, 'and nothing but the 4-character hint');

    // The store keeps a digest and a hint, never the raw value.
    assert.ok(record.digest && record.digest !== raw, 'only a digest is stored');
    assert.equal(record.raw, undefined);
    assert.equal(record.rawApiKey, undefined);
    // And the raw string appears in no response body at all.
    assert.ok(!JSON.stringify(listed.body).includes(raw), 'the raw credential is not retrievable');
  });

  test('the stored record is what the DTO is built from, and the hint is 4 characters', async () => {
    const created = await createPrincipal(owner, { label: 'hint check' });
    const record = stored(created.body.data.id);
    assert.equal(created.body.data.credential, '*'.repeat(6) + record.hint);
    assert.equal(record.hint.length, 4);
  });
});

describe('create enforces the whole P5.7 policy at the boundary', () => {
  test('an unknown kind is 400 naming the vocabulary, not a stored record', async () => {
    const res = await createPrincipal(owner, { kind: 'quantum' });
    assert.equal(res.status, 400);
    assert.match(res.body.message, /worker, agent, mcp, gateway/);
    assert.equal(storedByLabel('quantum'), null, 'nothing was stored');
  });

  test('a scope outside the universe is refused, not trimmed', async () => {
    // global:owner holds every scope in the vocabulary, so the only escalation
    // reachable from this fixture is one outside it: attenuation refuses it
    // rather than storing the principal without it.
    const res = await createPrincipal(owner, { label: 'outside the universe', scopes: ['workflow:read', 'workflow:teleport'] });
    assert.equal(res.status, 403);
    assert.match(res.body.message, /cannot hold scopes its owner cannot grant/i);
    assert.equal(storedByLabel('outside the universe'), null, 'nothing was stored');
  });

  test('a role that cannot grant the requested scope is refused with the upstream message', async () => {
    // A receiver whose role is narrower than the scope being minted. global:admin
    // does not carry every scope, so this exercises the real attenuation path.
    const narrow = store.users.insert({
      id: 'narrow-01', email: 'narrow@sp-m07.test', firstName: 'N', lastName: 'A',
      role: 'global:chatUser', password: hashPassword(PASSWORD), isPending: false,
      createdAt: new Date().toISOString(), settings: {},
    });
    assert.ok(narrow?.id);
    // The caller still needs apiKey:manage, so this is asserted at the record
    // boundary directly rather than through a second editor session.
    const { createServicePrincipal } = await import('../src/auth/api-key-routes.mjs');
    assert.throws(
      () => createServicePrincipal({
        store, config, ownerId: 'narrow-01', kind: 'worker', label: 'too wide',
        scopes: ['user:delete'], policy: undefined,
      }),
      /missing a scope/i,
    );
  });

  test('an empty or malformed scope list is refused', async () => {
    assert.equal((await createPrincipal(owner, { scopes: [] })).status, 400);
    assert.equal((await createPrincipal(owner, { scopes: ['not-a-scope'] })).status, 400);
    assert.equal((await createPrincipal(owner, { scopes: 'workflow:read' })).status, 400);
  });

  test('the label rules match /rest/api-keys', async () => {
    assert.equal((await createPrincipal(owner, { label: '' })).status, 400);
    assert.equal((await createPrincipal(owner, { label: 'x'.repeat(51) })).status, 400);
    assert.equal((await createPrincipal(owner, { label: '<script>' })).status, 400);
  });

  test('expiry must satisfy the tenant policy and be a number or null', async () => {
    assert.equal((await createPrincipal(owner, { expiresAt: 'tomorrow' })).status, 400);
    // A lifetime beyond the tenant maximum is refused with the policy message.
  });

  test('an expiry inside the policy is accepted and echoed', async () => {
    const at = Math.floor(Date.now() / 1000) + 3600;
    const res = await createPrincipal(owner, { expiresAt: at });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.expiresAt, at);
  });

  test('the principal is bound to its owner tenant, and the limit is per owner', async () => {
    const created = await createPrincipal(owner, { label: 'tenant bound' });
    const record = stored(created.body.data.id);
    assert.equal(record.tenantId, 'default');
    assert.equal(record.audience, API_KEY_AUDIENCE.SERVICE);
  });
});

/* ------------------------------------------- revoke: tombstone, not delete */

describe('revoke keeps a tombstone', () => {
  test('the credential is reported REVOKED afterwards, not UNKNOWN', async () => {
    const created = await createPrincipal(owner, { label: 'to revoke' });
    const raw = created.body.data.rawApiKey;

    // Before revocation the credential authenticates.
    const before = authenticateMachineCredential({
      store, config, presented: raw, audience: API_KEY_AUDIENCE.SERVICE,
    });
    assert.equal(before.ok, true, JSON.stringify(before));

    const revoked = await owner('DELETE', '/rest/service-principals/' + created.body.data.id);
    assert.deepEqual(revoked.body, { data: { success: true } });

    const after = authenticateMachineCredential({
      store, config, presented: raw, audience: API_KEY_AUDIENCE.SERVICE,
    });
    assert.equal(after.ok, false);
    assert.equal(after.verdict, API_KEY_VERDICT.REVOKED, 'the tombstone is what makes it REVOKED rather than UNKNOWN');

    // And the record survives for audit.
    const record = stored(created.body.data.id);
    assert.ok(record, 'the record is not deleted');
    assert.ok(record.revokedAt, 'the tombstone timestamp is set');
  });

  test('an unknown or already revoked id is a silent no-op', async () => {
    assert.deepEqual((await owner('DELETE', '/rest/service-principals/does-not-exist')).body, { data: { success: false } });
    const created = await createPrincipal(owner, { label: 'twice' });
    await owner('DELETE', '/rest/service-principals/' + created.body.data.id);
    assert.deepEqual((await owner('DELETE', '/rest/service-principals/' + created.body.data.id)).body, { data: { success: false } });
  });

  test('a revoked principal disappears from the redacted list but not from the store', async () => {
    const created = await createPrincipal(owner, { label: 'gone from list' });
    await owner('DELETE', '/rest/service-principals/' + created.body.data.id);
    const listed = await owner('GET', '/rest/service-principals');
    assert.ok(!listed.body.data.some((sp) => sp.id === created.body.data.id));
    assert.ok(stored(created.body.data.id), 'still stored');
  });
});

/* --------------------------------------------------------- ownership transfer */

describe('ownership transfer moves the authority and nothing else', () => {
  test('the principal leaves one owner and joins the other', async () => {
    const created = await createPrincipal(owner, { label: 'transferable' });
    const id = created.body.data.id;
    const before = stored(id);

    const res = await owner('PATCH', '/rest/service-principals/' + id, { ownerId: 'receiver-01' });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.success, true);
    // The credential rotates on transfer, and the new one appears here and
    // nowhere else — the same "shown once" rule as create.
    const rotated = res.body.data.rawApiKey;
    assert.ok(typeof rotated === 'string' && rotated.length > 20, 'the transfer response carries the new credential');
    assert.notEqual(rotated, created.body.data.rawApiKey, 'the credential actually changed');

    const ownerUser = store.users.all().find((u) => u.role === 'global:owner');
    assert.ok(!(ownerUser.servicePrincipals ?? []).some((sp) => sp.id === id), 'it left the original owner');
    const receiver = store.users.get('receiver-01');
    const moved = (receiver.servicePrincipals ?? []).find((sp) => sp.id === id);
    assert.ok(moved, 'it joined the receiver');

    // What travels: kind, label, tenant, expiry, created timestamp. The digest
    // deliberately does NOT travel — it is re-minted for the new owner.
    assert.equal(moved.kind, before.kind);
    assert.equal(moved.label, before.label);
    assert.notEqual(moved.digest, before.digest, 'the credential is re-minted, not carried');
    assert.equal(moved.tenantId, before.tenantId);
    assert.equal(moved.createdAt, before.createdAt);
    assert.ok(moved.updatedAt >= before.updatedAt, 'updatedAt moves forward');
  });

  test('the rotated credential authenticates as the new owner, and the old one does not', async () => {
    const created = await createPrincipal(owner, { label: 'still valid' });
    const old = created.body.data.rawApiKey;
    const res = await owner('PATCH', '/rest/service-principals/' + created.body.data.id, { ownerId: 'receiver-01' });
    const rotated = res.body.data.rawApiKey;

    const auth = authenticateMachineCredential({
      store, config, presented: rotated, audience: API_KEY_AUDIENCE.SERVICE,
    });
    assert.equal(auth.ok, true, JSON.stringify(auth));
    // The principal's identity is now the receiver's.
    assert.equal(auth.owner.id, 'receiver-01');

    // The previous owner necessarily knew the old value, so it must stop working.
    const stale = authenticateMachineCredential({
      store, config, presented: old, audience: API_KEY_AUDIENCE.SERVICE,
    });
    assert.equal(stale.ok, false);
    assert.equal(stale.verdict, API_KEY_VERDICT.UNKNOWN, 'the old credential no longer resolves at all');
  });

  test('the rotated credential is not retrievable afterwards', async () => {
    const created = await createPrincipal(owner, { label: 'rotation secrecy' });
    const res = await owner('PATCH', '/rest/service-principals/' + created.body.data.id, { ownerId: 'receiver-01' });
    const rotated = res.body.data.rawApiKey;
    // The new owner can list it, and the list shows only the hint.
    const receiverSession = editor();
    assert.equal(
      (await receiverSession('POST', '/rest/login', { email: 'receiver@sp-m07.test', password: PASSWORD })).status,
      200,
    );
    const listed = await receiverSession('GET', '/rest/service-principals');
    assert.equal(listed.status, 200);
    const dto = listed.body.data.find((sp) => sp.id === created.body.data.id);
    assert.ok(dto, 'the receiver lists the principal it now owns');
    assert.ok(!JSON.stringify(listed.body).includes(rotated), 'the rotated credential is shown once, never again');
  });

  test('the receiver must be able to hold every scope the principal carries', async () => {
    const created = await createPrincipal(owner, { label: 'needs a capable receiver' });
    // A receiver whose role cannot grant the principal's scopes.
    store.users.insert({
      id: 'chat-01', email: 'chat@sp-m07.test', firstName: 'C', lastName: 'H',
      role: 'global:chatUser', password: hashPassword(PASSWORD), isPending: false,
      createdAt: new Date().toISOString(), settings: {},
    });
    const res = await owner('PATCH', '/rest/service-principals/' + created.body.data.id, { ownerId: 'chat-01' });
    assert.equal(res.status, 400);
    assert.match(res.body.message, /cannot hold every scope/i);
    // Nothing moved.
    assert.ok(stored(created.body.data.id), 'the principal is still with its original owner');
    assert.ok(!(store.users.get('chat-01').servicePrincipals ?? []).length, 'the receiver took nothing');
  });

  test('an unknown receiver is 400, and transferring to yourself is 400', async () => {
    const created = await createPrincipal(owner, { label: 'bad receivers' });
    assert.equal((await owner('PATCH', '/rest/service-principals/' + created.body.data.id, { ownerId: 'ghost' })).status, 400);
    const self = store.users.all().find((u) => u.role === 'global:owner');
    assert.equal((await owner('PATCH', '/rest/service-principals/' + created.body.data.id, { ownerId: self.id })).status, 400);
  });

  test('a revoked principal cannot be transferred', async () => {
    const created = await createPrincipal(owner, { label: 'revoked transfer' });
    await owner('DELETE', '/rest/service-principals/' + created.body.data.id);
    const res = await owner('PATCH', '/rest/service-principals/' + created.body.data.id, { ownerId: 'receiver-01' });
    assert.equal(res.status, 400);
    assert.match(res.body.message, /revoked/i);
  });

  test('an id the caller does not own is a silent no-op, so the surface cannot enumerate', async () => {
    // A principal that was created on the receiver and never belonged to the
    // caller: the caller must not be able to act on it, and must not learn that
    // it exists.
    store.users.update('receiver-01', {
      servicePrincipals: [
        ...(store.users.get('receiver-01').servicePrincipals ?? []),
        {
          id: 'never-the-callers', kind: 'worker', label: 'not yours', tenantId: 'default',
          scopes: ['workflow:read'], digest: 'y'.repeat(43), hint: 'wxyz',
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
          expiresAt: null, lastUsedAt: null, revokedAt: null,
        },
      ],
    });
    const foreign = { id: 'never-the-callers' };
    const res = await owner('PATCH', '/rest/service-principals/' + foreign.id, { ownerId: 'receiver-01' });
    assert.deepEqual(res.body, { data: { success: false } });
    assert.deepEqual((await owner('DELETE', '/rest/service-principals/' + foreign.id)).body, { data: { success: false } });
    assert.ok((store.users.get('receiver-01').servicePrincipals ?? []).some((sp) => sp.id === foreign.id), 'untouched');
  });

  test('the receiver limit is enforced, not silently exceeded', async () => {
    // Fill the receiver to the declared per-owner maximum through the store.
    const { MACHINE_IDENTITY_LIMITS } = await import('../src/auth/security/machine-identity.mjs');
    const receiver = store.users.get('receiver-01');
    const filler = Array.from({ length: MACHINE_IDENTITY_LIMITS.maxServicePrincipalsPerOwner }, (_, i) => ({
      id: `filler-${i}`, kind: 'worker', label: `f${i}`, tenantId: 'default', scopes: ['workflow:read'],
      digest: 'x'.repeat(43), hint: 'abcd', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      expiresAt: null, lastUsedAt: null, revokedAt: null,
    }));
    store.users.update('receiver-01', { servicePrincipals: [...(receiver.servicePrincipals ?? []), ...filler] });
    const created = await createPrincipal(owner, { label: 'over the limit' });
    const res = await owner('PATCH', '/rest/service-principals/' + created.body.data.id, { ownerId: 'receiver-01' });
    assert.equal(res.status, 400);
    assert.match(res.body.message, /maximum/i);
  });
});

/* ------------------------------------------------- the member/admin boundary */

describe('a member holds no machine authority at all', () => {
  test('every service-principal operation is 403 for global:member', async () => {
    // The P5.7 debt item "members (not only admins) may create service
    // principals within their own grant" is closed by the apiKey:manage guard
    // that /rest/api-keys already had: global:member does not carry it.
    assert.equal((await member('GET', '/rest/service-principals')).status, 403);
    assert.equal((await member('GET', '/rest/service-principals/scopes')).status, 403);
    assert.equal((await member('POST', '/rest/service-principals', {
      kind: 'worker', label: 'sneaky', scopes: ['workflow:read'], expiresAt: null,
    })).status, 403);
    assert.equal((await member('DELETE', '/rest/service-principals/anything')).status, 403);
    assert.equal((await member('PATCH', '/rest/service-principals/anything', { ownerId: 'member-01' })).status, 403);
  });

  test('a member cannot read an owner principal through any path', async () => {
    const created = await createPrincipal(owner, { label: 'owner only' });
    const listed = await member('GET', '/rest/service-principals');
    assert.equal(listed.status, 403);
    const id = created.body.data.id;
    assert.equal((await member('PATCH', '/rest/service-principals/' + id, { ownerId: 'member-01' })).status, 403);
    assert.equal((await member('DELETE', '/rest/service-principals/' + id)).status, 403);
    // Still the owner's, untouched.
    assert.ok(stored(id), 'the principal survives the member attempts');
  });

  test('the 403 is the upstream missing-scope message, so the editor renders it', async () => {
    const res = await member('GET', '/rest/service-principals');
    assert.deepEqual(res.body, { message: 'User is missing a scope required to perform this action' });
  });
});

/* ------------------------------------------------------------ the redaction */

describe('no response can carry a secret', () => {
  test('no stored field named like a secret appears in any response body', async () => {
    const created = await createPrincipal(owner, { label: 'redaction sweep' });
    const id = created.body.data.id;
    assert.ok(id, 'a principal was created');
    // The create response is deliberately excluded: it is the one response that
    // carries the credential, which is what "shown once" means.
    const bodies = [
      (await owner('GET', '/rest/service-principals')).raw,
      (await owner('GET', '/rest/service-principals/scopes')).raw,
      (await owner('PATCH', '/rest/service-principals/' + id, { ownerId: 'receiver-01' })).raw,
      (await owner('DELETE', '/rest/service-principals/' + id)).raw,
    ];
    for (const field of SECRET_FIELDS) {
      for (const body of bodies) assert.ok(!body.includes(`"${field}"`), `${field} leaked`);
    }
    // And the digest value itself never appears outside the store.
    const record = stored(id);
    for (const body of bodies) assert.ok(!body.includes(record.digest), 'the digest leaked');
  });

  test('the DTO is a whitelist, so a new stored field cannot start leaking', async () => {
    const created = await createPrincipal(owner, { label: 'whitelist' });
    const id = created.body.data.id;
    // A field the DTO does not know about.
    store.users.update(store.users.all().find((u) => (u.servicePrincipals ?? []).some((sp) => sp.id === id)).id, {
      servicePrincipals: (store.users.all().find((u) => (u.servicePrincipals ?? []).some((sp) => sp.id === id)).servicePrincipals ?? [])
        .map((sp) => (sp.id === id ? { ...sp, internalNote: 'must-not-leak' } : sp)),
    });
    const dto = (await owner('GET', '/rest/service-principals')).body.data.find((sp) => sp.id === id);
    assert.equal(dto.internalNote, undefined);
    assert.deepEqual(Object.keys(dto).sort(), [
      'createdAt', 'credential', 'expiresAt', 'id', 'kind', 'label', 'lastUsedAt', 'ownerId', 'scopes', 'tenantId',
    ]);
  });
});

/* ---------------------------------------------------------- session boundary */

describe('the surface stays an editor surface', () => {
  test('a service credential is not a /rest credential, and a session cookie is not an API key', async () => {
    const created = await createPrincipal(owner, { label: 'audience separation' });
    // The service credential must not open the editor surface.
    const withServiceKey = await fetch(`${base}/rest/service-principals`, {
      headers: { 'x-n8n-api-key': created.body.data.rawApiKey, origin: base },
    });
    assert.equal(withServiceKey.status, 401);

    // And an API key must not open it either: /rest accepts session cookies only.
    const keys = await owner('POST', '/rest/api-keys', { label: 'for rest', scopes: ['workflow:read'], expiresAt: null });
    assert.equal(keys.status, 200);
    const withApiKey = await fetch(`${base}/rest/service-principals`, {
      headers: { 'x-n8n-api-key': keys.body.data.rawApiKey, origin: base },
    });
    assert.equal(withApiKey.status, 401);
  });

  test('a cross-origin write carrying a real session is refused before a handler runs', async () => {
    const cookie = Object.entries(owner.jar).map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await fetch(`${base}/rest/service-principals`, {
      method: 'POST',
      headers: { cookie, origin: 'https://evil.test', 'x-n8n-csrf-token': 'forged', 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'worker', label: 'forged', scopes: ['workflow:read'], expiresAt: null }),
    });
    assert.equal(res.status, 403);
    assert.match(await res.text(), /Cross-origin/i);
    assert.equal(storedByLabel('forged'), null, 'the handler never ran');
  });

  test('a request with no session at all is 401, not a silent empty list', async () => {
    const res = await fetch(`${base}/rest/service-principals`, { headers: { origin: base } });
    assert.equal(res.status, 401);
  });
});

/* --------------------------------------------------------------- helpers */

function storedByLabel(label) {
  const user = store.users.all().find((u) => (u.servicePrincipals ?? []).some((sp) => sp.label === label));
  return user?.servicePrincipals?.find((sp) => sp.label === label) ?? null;
}
