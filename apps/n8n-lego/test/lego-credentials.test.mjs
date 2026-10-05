/**
 * P5.4 (#217) — credential security boundary, SecretRef and P2.27 broker
 * integration.
 *
 * Three layers of proof, in increasing cost:
 *
 *   1. unit        — the redaction/merge rules and the SecretRef authority
 *   2. integration — the real REST surface, booted on an ephemeral port,
 *                    asserting the contract recorded from n8n 2.9.4
 *   3. leakage     — the stored secret is absent from every response, and is
 *                    provably PRESERVED on disk when the editor echoes a
 *                    sentinel back
 *
 * Layer 3 is the one that matters: a test that only checks "the API does not
 * return the secret" would also pass if the secret had simply been destroyed.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startServer } from '../src/server.mjs';
import { createCredentialVault } from '../src/auth/security/credential-vault.mjs';
import { createLocalKeyProvider } from '../src/auth/security/key-provider.mjs';
import { permissionRegistryFor } from '../src/auth/security/permission-registry.mjs';
import { createPrincipalSnapshot } from '../src/auth/security/principal.mjs';
import { createSecretRefAuthority, REF_DENIAL, SECRET_REF_LIMITS } from '../src/auth/security/secret-ref.mjs';
import {
  CREDENTIAL_BLANK_PREFIX,
  containsRuntimeSecret,
  createCredentialTypeIndex,
  credentialEditorView,
  isBlankSentinel,
  mergeCredentialData,
  redactCredentialData,
  splitCredential,
  credentialScopesFor,
} from '../src/compat/credentials.mjs';

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Portable recursive glob — `fs.globSync` only exists on Node >= 22. */
function findFiles(root, filename) {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry === filename) found.push(full);
    }
  };
  walk(root);
  return found;
}

/** Open a persisted record with the keyring the running server wrote (P5.5). */
function openFromDisk(record) {
  const [keyring] = findFiles(USER_FOLDER, '.credential-keys.json');
  assert.ok(keyring, 'expected the server to have written a keyring');
  const vault = createCredentialVault({ provider: createLocalKeyProvider({ file: keyring }) });
  return vault.open(record);
}

/** Every backend source file, for the boundary scans below. */
function allSources() {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith('.mjs')) found.push(full);
    }
  };
  walk(join(APP_ROOT, 'src'));
  return found;
}

/**
 * A purpose-built catalog rather than the fetched one.
 *
 * Deliberate: the fetched catalog needs the network, and when it is missing the
 * type index is empty — which correctly makes EVERY value secret, and would
 * silently turn the "name is preserved" assertions into "everything is
 * redacted" assertions. Redaction driven by a KNOWN type is the property under
 * test here, so the type definition is supplied. The fail-closed path (unknown
 * type => every value secret) is covered by the unit tests above.
 */
const CATALOG_DIR = mkdtempSync(join(tmpdir(), 'n8n-lego-p54-cat-'));
writeFileSync(
  join(CATALOG_DIR, 'credentials.json'),
  JSON.stringify([
    {
      name: 'httpHeaderAuth',
      displayName: 'Header Auth',
      properties: [
        { displayName: 'Name', name: 'name', type: 'string', default: '' },
        // n8n marks a secret property exactly this way.
        { displayName: 'Value', name: 'value', type: 'string', typeOptions: { password: true }, default: '' },
      ],
    },
  ]),
);
// `loadCatalog` treats `nodes.json` as the "catalog is installed" marker.
writeFileSync(join(CATALOG_DIR, 'nodes.json'), '[]');
const REPO_CATALOG = CATALOG_DIR;
const USER_FOLDER = mkdtempSync(join(tmpdir(), 'n8n-lego-p54-'));

/** The secret every test looks for. Chosen to be unmistakable in any output. */
const SECRET = 'P54-SUPER-SECRET-VALUE-9f3a';
const PUBLIC_FIELD = 'X-Dummy';

const CREDENTIAL_TYPES = [
  {
    name: 'httpHeaderAuth',
    properties: [
      { name: 'name', type: 'string' },
      // n8n marks secret properties exactly this way.
      { name: 'value', type: 'string', typeOptions: { password: true } },
    ],
  },
];

const INDEX = createCredentialTypeIndex(CREDENTIAL_TYPES);
const SECRET_FIELDS = INDEX.secretFields('httpHeaderAuth');

function makeRecord(overrides = {}) {
  return {
    id: 'cred1',
    name: 'My header auth',
    type: 'httpHeaderAuth',
    createdAt: '2026-09-24T00:00:00.000Z',
    updatedAt: '2026-09-24T00:00:00.000Z',
    tenantId: 'default',
    credentialVersion: 1,
    data: { name: PUBLIC_FIELD, value: SECRET },
    ...overrides,
  };
}

/* ============================================================ 1. redaction rules */

describe('credential redaction follows the recorded n8n contract', () => {
  test('the secret field set is derived from the type, not guessed', () => {
    assert.deepEqual([...SECRET_FIELDS], ['value'], 'httpHeaderAuth marks only `value` as a password');
    assert.equal(INDEX.size(), 1);
  });

  test('an unknown type has no safe subset — every value is treated as secret', () => {
    assert.equal(INDEX.secretFields('noSuchType'), null);
    const parts = splitCredential(makeRecord({ type: 'noSuchType' }), null);
    assert.deepEqual(Object.keys(parts.runtimeSecret).sort(), ['name', 'value']);
    assert.deepEqual(parts.configuration, {}, 'nothing is published for an unknown type');
  });

  test('split separates configuration from the runtime secret', () => {
    const parts = splitCredential(makeRecord(), SECRET_FIELDS);
    assert.deepEqual(parts.configuration, { name: PUBLIC_FIELD });
    assert.deepEqual(parts.runtimeSecret, { value: SECRET });
    assert.equal(JSON.stringify(parts.configuration).includes(SECRET), false);
  });

  test('redaction keeps non-secret configuration and blanks the secret', () => {
    const redacted = redactCredentialData(makeRecord(), SECRET_FIELDS);
    assert.equal(redacted.name, PUBLIC_FIELD, 'the editor must still see the header NAME');
    assert.equal(isBlankSentinel(redacted.value), true);
    assert.ok(redacted.value.startsWith(CREDENTIAL_BLANK_PREFIX));
    assert.equal(JSON.stringify(redacted).includes(SECRET), false);
  });

  test('the sentinel prefix alone is not a sentinel', () => {
    assert.equal(isBlankSentinel(CREDENTIAL_BLANK_PREFIX), false);
    assert.equal(isBlankSentinel(`${CREDENTIAL_BLANK_PREFIX}abc`), true);
    assert.equal(isBlankSentinel(SECRET), false);
    assert.equal(isBlankSentinel(null), false);
    assert.equal(isBlankSentinel(42), false);
  });

  test('the view carries no data unless asked, and never the secret', () => {
    const without = credentialEditorView(makeRecord(), { secretFields: SECRET_FIELDS });
    assert.equal('data' in without, false, 'the golden pins hasData:false for a bare GET');
    const with_ = credentialEditorView(makeRecord(), { includeData: true, secretFields: SECRET_FIELDS });
    assert.equal('data' in with_, true);
    assert.equal(with_.data.name, PUBLIC_FIELD);
    assert.equal(isBlankSentinel(with_.data.value), true);
  });

  test('containsRuntimeSecret distinguishes a redacted view from a leaking one', () => {
    assert.equal(containsRuntimeSecret({ data: { value: SECRET } }, SECRET_FIELDS), true);
    assert.equal(
      containsRuntimeSecret(redactCredentialData(makeRecord(), SECRET_FIELDS), SECRET_FIELDS),
      false,
      'a redacted bag must not be reported as leaking',
    );
    assert.equal(containsRuntimeSecret({}, SECRET_FIELDS), false);
  });
});

/* ============================================================== 2. sentinel merge */

describe('an echoed sentinel preserves the stored secret', () => {
  test('saving a form the editor never populated keeps the value', () => {
    const redacted = redactCredentialData(makeRecord(), SECRET_FIELDS);
    const merged = mergeCredentialData(makeRecord().data, { name: PUBLIC_FIELD, value: redacted.value });
    assert.equal(merged.value, SECRET, 'the sentinel must never overwrite the stored secret');
    assert.equal(merged.name, PUBLIC_FIELD);
    assert.equal(JSON.stringify(merged).includes(CREDENTIAL_BLANK_PREFIX), false);
  });

  test('a genuinely new value is accepted', () => {
    const merged = mergeCredentialData(makeRecord().data, { value: 'rotated-value' });
    assert.equal(merged.value, 'rotated-value');
  });

  test('a sentinel for a key with nothing stored is dropped, not persisted', () => {
    const merged = mergeCredentialData({ name: PUBLIC_FIELD }, { value: `${CREDENTIAL_BLANK_PREFIX}zz` });
    assert.equal('value' in merged, false);
  });

  test('an absent body leaves the stored data untouched', () => {
    assert.deepEqual(mergeCredentialData(makeRecord().data, undefined), makeRecord().data);
    assert.deepEqual(mergeCredentialData(makeRecord().data, null), makeRecord().data);
  });
});

/* ================================================================ 3. SecretRef */

describe('SecretRef is request-, audience- and version-bound, and single-use', () => {
  function authority(overrides = {}) {
    return createSecretRefAuthority({
      materialOf: (credential) => JSON.stringify({ value: credential.data.value }),
      registry: permissionRegistryFor({ catalogDir: CATALOG_DIR }),
      ...overrides,
    });
  }

  function owner() {
    const registry = permissionRegistryFor({ catalogDir: CATALOG_DIR });
    return createPrincipalSnapshot({
      principalId: 'u1',
      identityId: 'i1',
      tenantId: 'default',
      principalType: 'user',
      authMethod: 'password',
      authStrength: 'password',
      permissions: registry.permissions,
      principalVersion: 1,
    });
  }

  const mintArgs = (overrides = {}) => ({
    principal: owner(),
    credential: makeRecord(),
    requestId: 'req-1',
    audience: 'httpRequest',
    capability: 'cap.http',
    permission: 'credential:read',
    tenantId: 'default',
    capabilityGrants: ['cap.http'],
    ...overrides,
  });

  test('a ref carries no secret material', () => {
    const ref = authority().mint(mintArgs());
    assert.equal(JSON.stringify(ref).includes(SECRET), false, 'the descriptor must never hold the secret');
    assert.equal(typeof ref.token, 'string');
    assert.equal(ref.credentialVersion, 1);
    assert.equal(ref.tenantId, 'default');
  });

  test('the happy path redeems exactly once', () => {
    const auth = authority();
    const ref = auth.mint(mintArgs());
    const material = auth.redeem(ref, {
      requestId: 'req-1',
      audience: 'httpRequest',
      capability: 'cap.http',
      credentialVersion: 1,
    });
    assert.equal(JSON.parse(material).value, SECRET);
  });

  test('a second redeem is refused even with every binding correct', () => {
    const auth = authority();
    const ref = auth.mint(mintArgs());
    auth.redeem(ref, { requestId: 'req-1', audience: 'httpRequest', capability: 'cap.http' });
    assert.throws(
      () => auth.redeem(ref, { requestId: 'req-1', audience: 'httpRequest', capability: 'cap.http' }),
      (e) => e.reason === REF_DENIAL.ALREADY_REDEEMED,
    );
  });

  for (const [label, mutate] of [
    ['requestId', { requestId: 'req-OTHER' }],
    ['audience', { audience: 'someOtherNode' }],
    ['capability', { capability: 'cap.other' }],
    ['credentialVersion', { credentialVersion: 99 }],
  ]) {
    test(`a ref is refused when the ${label} does not match`, () => {
      const auth = authority();
      const ref = auth.mint(mintArgs());
      const presented = { requestId: 'req-1', audience: 'httpRequest', capability: 'cap.http', ...mutate };
      assert.throws(() => auth.redeem(ref, presented), (e) => e.name === 'SecretRefDenied');
    });
  }

  test('a ref minted for one request cannot be replayed into another', () => {
    // The confused-deputy shape: two requests, one ref.
    const auth = authority();
    const ref = auth.mint(mintArgs({ requestId: 'req-A' }));
    assert.throws(
      () => auth.redeem(ref, { requestId: 'req-B', audience: 'httpRequest', capability: 'cap.http' }),
      (e) => e.reason === REF_DENIAL.REQUEST_MISMATCH,
    );
  });

  test('an expired ref is refused by the broker, not silently served', () => {
    let clock = 1_000_000;
    const auth = createSecretRefAuthority({
      now: () => clock,
      materialOf: (c) => JSON.stringify({ value: c.data.value }),
      registry: permissionRegistryFor({ catalogDir: CATALOG_DIR }),
    });
    const ref = auth.mint({ ...mintArgs(), ttlMs: 1000 });
    clock += 5_000; // past the TTL
    assert.throws(
      () => auth.redeem(ref, { requestId: 'req-1', audience: 'httpRequest', capability: 'cap.http' }),
      (e) => e.name === 'SecretRefDenied',
    );
  });

  test('a revoking caller can cancel an unredeemed ref', () => {
    const auth = authority();
    const ref = auth.mint(mintArgs());
    assert.equal(auth.revoke(ref), true);
    assert.throws(
      () => auth.redeem(ref, { requestId: 'req-1', audience: 'httpRequest', capability: 'cap.http' }),
      (e) => e.name === 'SecretRefDenied',
    );
  });

  test('minting refuses a cross-tenant credential', () => {
    const auth = authority();
    assert.throws(
      () => auth.mint(mintArgs({ credential: makeRecord({ tenantId: 'tenant-other' }) })),
      (e) => e.reason === REF_DENIAL.TENANT_MISMATCH || e.reason === REF_DENIAL.NOT_AUTHORIZED,
    );
  });

  test('minting refuses an unknown permission — the universe is the canonical one', () => {
    const auth = authority();
    assert.throws(
      () => auth.mint(mintArgs({ permission: 'notAReal:permission' })),
      (e) => e.reason === REF_DENIAL.NOT_AUTHORIZED,
    );
  });

  test('minting refuses a principal that does not hold the scope', () => {
    const registry = permissionRegistryFor({ catalogDir: CATALOG_DIR });
    const limited = createPrincipalSnapshot({
      principalId: 'u2',
      identityId: 'i2',
      tenantId: 'default',
      principalType: 'user',
      authMethod: 'password',
      authStrength: 'password',
      permissions: ['workflow:read'],
      principalVersion: 1,
    });
    const withLimited = { ...mintArgs(), principal: limited, capabilityGrants: ['cap.http'] };
    assert.ok(Array.isArray(registry.permissions));
    assert.throws(() => authority().mint(withLimited), (e) => e.reason === REF_DENIAL.NOT_AUTHORIZED);
  });

  test('minting refuses a capability the principal does not hold', () => {
    assert.throws(
      () => authority().mint(mintArgs({ capabilityGrants: [] })),
      (e) => e.reason === REF_DENIAL.NOT_AUTHORIZED,
    );
  });

  test("the operation label stays inside the broker 128-char cap", () => {
    const long = 'r'.repeat(200);
    assert.throws(
      () => authority().mint(mintArgs({ requestId: long })),
      (e) => e.reason === REF_DENIAL.MALFORMED_REF,
    );
    assert.ok(SECRET_REF_LIMITS.requestIdMaxLength <= 40);
  });

  test('a credential with no material cannot be minted', () => {
    const auth = createSecretRefAuthority({
      materialOf: () => '',
      registry: permissionRegistryFor({ catalogDir: CATALOG_DIR }),
    });
    assert.throws(
      () => auth.mint(mintArgs()),
      (e) => e.reason === REF_DENIAL.NO_MATERIAL,
    );
  });
});


/* ============================================ 3b. who may touch which credential */

describe('credential authorization uses the canonical n8n role model', () => {
  const config = { catalogDir: CATALOG_DIR };
  const owner = { id: 'u-owner', role: 'global:owner' };
  const member = { id: 'u-member', role: 'global:member' };
  const stranger = { id: 'u-other', role: 'global:member' };
  const mine = makeRecord({ ownerId: 'u-member' });
  const legacy = makeRecord(); // no ownerId: predates P5.4

  test('the global owner reaches every credential via global scopes', () => {
    for (const cred of [mine, legacy]) {
      const scopes = credentialScopesFor(owner, cred, config);
      for (const s of ['credential:read', 'credential:update', 'credential:delete', 'credential:list']) {
        assert.ok(scopes.has(s), `owner lacks ${s}`);
      }
    }
  });

  test('a member fully manages a credential in their personal project', () => {
    const scopes = credentialScopesFor(member, mine, config);
    for (const s of ['credential:read', 'credential:update', 'credential:delete']) assert.ok(scopes.has(s), s);
  });

  test("a member cannot see another user's credential", () => {
    assert.equal(credentialScopesFor(stranger, mine, config).size, 0);
  });

  test('a pre-P5.4 record with no owner is reachable only by global scopes', () => {
    assert.equal(credentialScopesFor(member, legacy, config).size, 0, 'default deny for unowned records');
  });

  test('every member may create (into their own personal project)', () => {
    assert.ok(credentialScopesFor(member, null, config).has('credential:create'));
  });

  test('an unknown global role contributes no scope at all', () => {
    const odd = { id: 'u-x', role: 'global:doesNotExist' };
    assert.equal(credentialScopesFor(odd, legacy, config).size, 0);
  });

  test('no scope outside the canonical credential universe is ever produced', () => {
    for (const user of [owner, member]) {
      for (const s of credentialScopesFor(user, mine, config)) assert.match(s, /^credential:[a-zA-Z]+$/);
    }
  });

  test('an anonymous caller gets nothing', () => {
    assert.equal(credentialScopesFor(null, mine, config).size, 0);
  });
});

/* ============================================= 4. the real REST surface (golden) */

describe('the REST credential surface matches the recorded n8n contract', () => {
  let base;
  let running;
  let cookie = '';
  let credentialId = '';

  before(async () => {
    const { server } = await startServer({
      env: {
        ...process.env,
        N8N_LEGO_PORT: '0',
        N8N_LEGO_HOST: '127.0.0.1',
        // File storage is deliberate: the preservation test below reads the
        // persisted record to prove the secret survived a sentinel round-trip.
        N8N_LEGO_STORAGE: 'file',
        N8N_LEGO_LOG_LEVEL: 'error',
        N8N_LEGO_PROTOCOL: 'http',
        N8N_LEGO_USER_FOLDER: USER_FOLDER,
        N8N_LEGO_CATALOG_DIR: process.env.N8N_LEGO_CATALOG_DIR ?? REPO_CATALOG,
      },
    });
    running = server;
    base = `http://127.0.0.1:${server.address().port}`;

    const setup = await fetch(`${base}/rest/owner/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({
        email: 'owner@example.test',
        firstName: 'Test',
        lastName: 'Owner',
        password: 'test-password-123',
      }),
    });
    for (const entry of setup.headers.getSetCookie?.() ?? []) {
      const pair = entry.split(';')[0];
      if (pair.startsWith('n8n-auth=')) cookie = pair;
    }
  });

  after(async () => {
    if (running) await new Promise((done) => running.close(() => done()));
    rmSync(USER_FOLDER, { recursive: true, force: true });
    rmSync(CATALOG_DIR, { recursive: true, force: true });
  });

  async function api(method, path, body) {
    // Models the BROWSER: no x-n8n-csrf-token, because the shipped editor does
    // not know that header exists (see P5.2).
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(cookie ? { cookie } : {}),
        origin: base,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    return { status: response.status, text, json: text === '' ? null : JSON.parse(text) };
  }

  test('create stores the credential and echoes data (redacted)', async () => {
    const { status, json } = await api('POST', '/rest/credentials', {
      name: 'E2E header auth',
      type: 'httpHeaderAuth',
      data: { name: PUBLIC_FIELD, value: SECRET },
    });
    assert.equal(status, 200);
    const created = json.data;
    credentialId = created.id;
    // Golden `create`: dataFieldPresent true and `data` among the keys.
    assert.equal('data' in created, true, 'upstream echoes data on create');
    // …but P5.4 redacts it, which the golden does NOT pin values for.
    assert.equal(JSON.stringify(created).includes(SECRET), false, 'create must not echo the plaintext secret');
    assert.equal(created.data.name, PUBLIC_FIELD);
    assert.equal(isBlankSentinel(created.data.value), true);
    assert.equal(created.tenantId, 'default', 'records are tenant-bound');
    assert.equal(created.credentialVersion, 1, 'records are version-bound');
    assert.ok(created.scopes.includes('credential:update'), 'the creator holds edit scopes on it');
  });

  test('GET /rest/credentials/:id carries NO data — the golden default', async () => {
    const { status, json, text } = await api('GET', `/rest/credentials/${credentialId}`);
    assert.equal(status, 200);
    assert.equal('data' in json.data, false, 'golden pins hasData:false for a bare GET');
    assert.equal(text.includes(SECRET), false);
  });

  test('GET ?includeData=true returns redacted data, never the secret', async () => {
    const { status, json, text } = await api('GET', `/rest/credentials/${credentialId}?includeData=true`);
    assert.equal(status, 200);
    assert.equal('data' in json.data, true);
    assert.equal(json.data.data.name, PUBLIC_FIELD, 'the editor must still render the header name');
    assert.equal(isBlankSentinel(json.data.data.value), true, 'the value is blanked, not revealed');
    assert.equal(text.includes(SECRET), false, 'the secret must not appear anywhere in the response');
  });

  test('the list endpoint leaks nothing, with or without includeData', async () => {
    const plain = await api('GET', '/rest/credentials');
    assert.equal(plain.status, 200);
    assert.equal(plain.text.includes(SECRET), false);
    for (const credential of plain.json.data) assert.equal('data' in credential, false);

    const withData = await api('GET', '/rest/credentials?includeData=true');
    assert.equal(withData.status, 200);
    assert.equal(withData.text.includes(SECRET), false);
    for (const credential of withData.json.data) {
      if ('data' in credential) assert.equal(isBlankSentinel(credential.data.value), true);
    }
  });

  test('the workflow selector list carries no values at all', async () => {
    const { status, json, text } = await api('GET', '/rest/credentials/for-workflow');
    assert.equal(status, 200);
    assert.equal(text.includes(SECRET), false);
    for (const credential of json.data) assert.equal('data' in credential, false);
  });

  test('PATCH echoing the sentinel preserves the stored secret on disk', async () => {
    // The decisive test. If the sentinel were saved literally, the secret would
    // be destroyed; if redaction were skipped, the secret would be exposed.
    const shown = await api('GET', `/rest/credentials/${credentialId}?includeData=true`);
    const echoed = shown.json.data.data;

    const patched = await api('PATCH', `/rest/credentials/${credentialId}`, {
      name: 'E2E header auth',
      type: 'httpHeaderAuth',
      data: echoed,
    });
    assert.equal(patched.status, 200);
    // Golden `updateWithBlankedValueKeepsSecret`: no data field on update.
    assert.equal('data' in patched.json.data, false, 'golden pins dataFieldPresent:false on update');
    assert.equal(patched.text.includes(SECRET), false);
    assert.ok(patched.json.data.credentialVersion >= 2, 'the version advances, invalidating old refs');

    // Prove preservation from the persisted record, not from the API.
    const files = findFiles(USER_FOLDER, 'credentials.json');
    assert.ok(files.length > 0, 'expected a persisted credentials.json with file storage');
    const stored = JSON.parse(readFileSync(files[0], 'utf8'));
    const record = stored.find((entry) => entry.id === credentialId);
    assert.ok(record, 'the credential must still exist');
    // P5.5: the secret is sealed at rest. The raw file must not contain it...
    assert.equal(readFileSync(files[0], 'utf8').includes(SECRET), false, 'no plaintext secret on disk');
    assert.equal('data' in record, false, 'no plaintext data bag on disk');
    // ...and opening it with the instance's own keyring must yield it intact.
    const opened = openFromDisk(record);
    assert.equal(opened.value, SECRET, 'the stored secret survived the sentinel round-trip');
    assert.equal(opened.value.includes(CREDENTIAL_BLANK_PREFIX), false);
  });

  test('a genuinely new value can still be written', async () => {
    const patched = await api('PATCH', `/rest/credentials/${credentialId}`, {
      name: 'E2E header auth',
      type: 'httpHeaderAuth',
      data: { name: PUBLIC_FIELD, value: 'rotated-by-test' },
    });
    assert.equal(patched.status, 200);
    const files = findFiles(USER_FOLDER, 'credentials.json');
    const stored = JSON.parse(readFileSync(files[0], 'utf8'));
    assert.equal(openFromDisk(stored.find((e) => e.id === credentialId)).value, 'rotated-by-test');
  });

  test('a missing credential is a 404, not a leak', async () => {
    const { status, text, json } = await api('GET', '/rest/credentials/does-not-exist');
    assert.equal(status, 404);
    // Golden `notFound`: upstream's exact message.
    assert.equal(json.message, 'Credential with ID "does-not-exist" could not be found.');
    assert.equal(text.includes(SECRET), false);
  });

  test('delete removes the record', async () => {
    const { status, json } = await api('DELETE', `/rest/credentials/${credentialId}`);
    assert.equal(status, 200);
    assert.equal(json.data, true);
  });
});

/* ================================================== 5. leakage and direct access */

describe('no secret reaches a log line, and no consumer reaches the store', () => {
  test('the create log call carries identifiers only', () => {
    const source = readFileSync(join(APP_ROOT, 'src/compat/credentials.mjs'), 'utf8');
    const calls = [...source.matchAll(/logger\.(info|warn|error|debug)\(([\s\S]{0,240}?)\);/g)];
    assert.ok(calls.length > 0, 'expected at least one logger call to audit');
    for (const [, level, args] of calls) {
      assert.equal(
        /body\.data|credential\.data|\bdata\b/.test(args),
        false,
        `logger.${level} must not interpolate credential data: ${args.trim()}`,
      );
    }
  });

  test('no plugin, node or provider consumer imports the credential store', () => {
    // P5.4: direct credential-store access must be impossible for consumers.
    // The routes now live in the compatibility domain, and the store is only
    // reachable through the injected `ctx` the composition root supplies.
    const offenders = [];
    for (const file of allSources()) {
      const relative = file.slice(APP_ROOT.length + 1);
      if (relative === 'src/store.mjs' || relative === 'src/server.mjs') continue;
      if (relative.startsWith('src/compat/credentials.mjs')) continue; // the carved-out owner
      if (relative.startsWith('src/rest/')) continue; // the legacy aggregate
      // Templates ship their own internal store; the A3 test excludes them too.
      if (relative.startsWith('src/reference-lego/')) continue;
      const source = readFileSync(file, 'utf8');
      if (/from\s+['"][^'"]*\/store\.mjs['"]/.test(source)) offenders.push(relative);
    }
    // A3 permits src/engine.mjs and nothing else; credentials must not extend it.
    assert.deepEqual(offenders, ['src/engine.mjs'], `unexpected store importers: ${offenders.join(', ')}`);
  });

  test('the legacy aggregate shrank rather than grew', () => {
    const source = readFileSync(join(APP_ROOT, 'src/rest/routes.mjs'), 'utf8');
    const lines = source.split('\n').length - (source.endsWith('\n') ? 1 : 0);
    assert.ok(lines <= 845, `legacy aggregate is ${lines} lines (budget 845) — it may only shrink`);
  });

  test('the credential routes are not duplicated back into the aggregate', () => {
    const source = readFileSync(join(APP_ROOT, 'src/rest/routes.mjs'), 'utf8');
    const occurrences = (source.match(/path:\s*'\/rest\/credentials/g) ?? []).length;
    assert.equal(occurrences, 0, 'the aggregate must delegate, not re-declare');
    assert.ok(source.includes('credentialRoutes('), 'the aggregate must spread the carved-out routes');
  });
});
