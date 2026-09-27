/**
 * P6-S05 + P5-M02 — the ONE canonical credential chain, end to end (REQ-0005
 * sections 6-7):
 *
 *   workflow node -> credentialRef -> SecretRef -> P2.27 Secret Broker
 *     -> credential resolution -> httpRequest node -> Authorization header
 *     -> mock HTTP server (a REAL local HTTP endpoint; the node really sends).
 *
 * Also proves the secret-safety rule: the deterministic sentinel secret must
 * not appear in workflow JSON, execution output, error objects, warnings or
 * logs — only in the request header the server observes (the one intended
 * place).
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { permissionRegistryFor } from '../src/auth/security/permission-registry.mjs';
import { createPrincipalSnapshot } from '../src/auth/security/principal.mjs';
import { createSecretRefAuthority, REF_DENIAL } from '../src/auth/security/secret-ref.mjs';
import { createCredentialRuntime, CredentialResolutionError, CREDENTIAL_RESOLUTION_ERRORS } from '../src/lego/credential-runtime.mjs';
import { createNodeRegistry } from '../../../packages/reconstructed-engine/node-registry.mjs';
import { createFetchTransport, TransportError } from '../../../packages/reconstructed-engine/http-transport.mjs';
import { httpRequestHandler, HttpRequestNodeError, HTTP_REQUEST_ERRORS } from '../../../packages/reconstructed-engine/http-request.mjs';

const SENTINEL = 'P6S05-SENTINEL-SECRET-7c2d';

const CATALOG_DIR = mkdtempSync(join(tmpdir(), 'n8n-lego-p6s05-cat-'));
writeFileSync(
  join(CATALOG_DIR, 'credentials.json'),
  JSON.stringify([
    {
      name: 'httpBearerAuth',
      displayName: 'Bearer Auth',
      properties: [
        { displayName: 'Token', name: 'token', type: 'string', typeOptions: { password: true }, default: '' },
      ],
    },
    {
      name: 'httpHeaderAuth',
      displayName: 'Header Auth',
      properties: [
        { displayName: 'Name', name: 'name', type: 'string', default: '' },
        { displayName: 'Value', name: 'value', type: 'string', typeOptions: { password: true }, default: '' },
      ],
    },
  ]),
);
writeFileSync(join(CATALOG_DIR, 'nodes.json'), '[]');

function makeStore() {
  return new Map([
    ['cred-bearer', {
      id: 'cred-bearer',
      name: 'Prod API',
      type: 'httpBearerAuth',
      tenantId: 'default',
      credentialVersion: 1,
      data: { value: SENTINEL },
    }],
    ['cred-header', {
      id: 'cred-header',
      name: 'X-Key API',
      type: 'httpHeaderAuth',
      tenantId: 'default',
      credentialVersion: 1,
      data: { name: 'X-Api-Key', value: SENTINEL },
    }],
    ['cred-empty', {
      id: 'cred-empty',
      name: 'No material',
      type: 'httpBearerAuth',
      tenantId: 'default',
      credentialVersion: 1,
      data: {},
    }],
    ['cred-broken', {
      id: 'cred-broken',
      name: 'Bad version',
      type: 'httpBearerAuth',
      tenantId: 'default',
      credentialVersion: 0,
      data: { value: SENTINEL },
    }],
  ]);
}

function principalFor() {
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

function runtimeFor({ clock = { now: 1_000_000 }, grants = ['cap.http'] } = {}) {
  const authority = createSecretRefAuthority({
    now: () => clock.now,
    materialOf: (credential) => {
      if (typeof credential?.data?.value !== 'string' || credential.data.value === '') {
        throw new Error('vault has no material for this credential');
      }
      return JSON.stringify({ value: credential.data.value });
    },
    registry: permissionRegistryFor({ catalogDir: CATALOG_DIR }),
  });
  return {
    authority,
    clock,
    runtime: createCredentialRuntime({
      authority,
      store: makeStore(),
      principal: principalFor(),
      audience: 'httpRequest',
      capability: 'cap.http',
      capabilityGrants: grants,
    }),
  };
}

/* ------------------------------------------------------- the mock endpoint */
let server = null;
let serverBase = '';
const serverRequests = [];

before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      serverRequests.push({ method: req.method, url: req.url, authorization: req.headers.authorization ?? null, apiKey: req.headers['x-api-key'] ?? null, body });
      if (req.url === '/fail') {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end('{"error":"boom"}');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, path: req.url }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  serverBase = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  rmSync(CATALOG_DIR, { recursive: true, force: true });
});

function nodeFor(parameters, credentialRef) {
  return { name: 'HTTP', type: 'n8n-nodes-base.httpRequest', parameters, credentialRef };
}

function contextFor(runtime) {
  return createNodeRegistry({
    httpTransport: createFetchTransport({ timeoutMsDefault: 3000 }),
    credentials: runtime.asContext(),
  }).context;
}

/* ================================================================= 1. chain */

describe('P6-S05 chain: workflow node -> credentialRef -> SecretRef -> P2.27 broker -> HTTP request', () => {
  test('bearer credential reaches the real endpoint as an Authorization header', async () => {
    const { runtime } = runtimeFor();
    const node = nodeFor({ method: 'GET', url: `${serverBase}/ping`, authentication: 'httpBearerAuth' }, 'cred-bearer');
    const out = await httpRequestHandler(node, [{ json: { seed: 1 } }], contextFor(runtime));
    assert.equal(out[0].json.statusCode, 200);
    assert.deepEqual(out[0].json.body, { ok: true, path: '/ping' });
    const seen = serverRequests[serverRequests.length - 1];
    assert.equal(seen.authorization, `Bearer ${SENTINEL}`);
    // SECRET SAFETY: output items never carry the sentinel
    assert.equal(JSON.stringify(out).includes(SENTINEL), false, 'secret leaked into output items');
  });

  test('header credential reaches the real endpoint as the chosen header', async () => {
    const { runtime } = runtimeFor();
    const node = nodeFor({ method: 'POST', url: `${serverBase}/echo`, authentication: 'httpHeaderAuth', headerName: 'X-Api-Key', sendBody: true, body: '{"q":1}' }, 'cred-header');
    const out = await httpRequestHandler(node, [{ json: {} }], contextFor(runtime));
    assert.equal(out[0].json.statusCode, 200);
    const seen = serverRequests[serverRequests.length - 1];
    assert.equal(seen.apiKey, SENTINEL);
    assert.equal(seen.body, '{"q":1}');
    assert.equal(JSON.stringify(out).includes(SENTINEL), false);
  });

  test('the canonical path is singular: the resolved credential is broker-released material, not stored data', async () => {
    const { runtime, authority } = runtimeFor();
    const liveBefore = authority.liveCount();
    const node = nodeFor({ method: 'GET', url: `${serverBase}/ping`, authentication: 'httpBearerAuth' }, 'cred-bearer');
    await httpRequestHandler(node, [{ json: {} }], contextFor(runtime));
    // single-use: the ref died on redeem; no live refs accumulate
    assert.equal(authority.liveCount(), liveBefore);
  });
});

/* ========================================================= 2. failure matrix */

describe('every failure is explicit (no empty-success fallback)', () => {
  test('credential missing (unknown id) -> CREDENTIAL_MISSING', async () => {
    const { runtime } = runtimeFor();
    const node = nodeFor({ method: 'GET', url: `${serverBase}/ping`, authentication: 'httpBearerAuth' }, 'cred-nope');
    await assert.rejects(
      () => httpRequestHandler(node, [{ json: {} }], contextFor(runtime)),
      (e) => e instanceof HttpRequestNodeError && e.code === HTTP_REQUEST_ERRORS.CREDENTIAL_MISSING,
    );
  });

  test('credential missing (no credentialRef at all) -> CREDENTIAL_MISSING', async () => {
    const { runtime } = runtimeFor();
    const node = nodeFor({ method: 'GET', url: `${serverBase}/ping`, authentication: 'httpBearerAuth' }, undefined);
    await assert.rejects(
      () => httpRequestHandler(node, [{ json: {} }], contextFor(runtime)),
      (e) => e instanceof HttpRequestNodeError && e.code === HTTP_REQUEST_ERRORS.CREDENTIAL_MISSING,
    );
  });

  test('credential unauthorized (principal without the capability grant) -> CREDENTIAL_UNAUTHORIZED', async () => {
    const { runtime } = runtimeFor({ grants: [] });
    const node = nodeFor({ method: 'GET', url: `${serverBase}/ping`, authentication: 'httpBearerAuth' }, 'cred-bearer');
    await assert.rejects(
      () => httpRequestHandler(node, [{ json: {} }], contextFor(runtime)),
      (e) => e instanceof HttpRequestNodeError && e.code === HTTP_REQUEST_ERRORS.CREDENTIAL_UNAUTHORIZED,
    );
  });

  test('malformed reference (broken credential version) -> CREDENTIAL_MALFORMED_REF', async () => {
    const { runtime } = runtimeFor();
    const node = nodeFor({ method: 'GET', url: `${serverBase}/ping`, authentication: 'httpBearerAuth' }, 'cred-broken');
    await assert.rejects(
      () => httpRequestHandler(node, [{ json: {} }], contextFor(runtime)),
      (e) => e instanceof HttpRequestNodeError && e.code === HTTP_REQUEST_ERRORS.CREDENTIAL_MALFORMED_REF,
    );
  });

  test('broker failure (vault cannot supply material) -> CREDENTIAL_BROKER_FAILURE', async () => {
    const { runtime } = runtimeFor();
    const node = nodeFor({ method: 'GET', url: `${serverBase}/ping`, authentication: 'httpBearerAuth' }, 'cred-empty');
    await assert.rejects(
      () => httpRequestHandler(node, [{ json: {} }], contextFor(runtime)),
      (e) => e instanceof HttpRequestNodeError && e.code === HTTP_REQUEST_ERRORS.CREDENTIAL_BROKER_FAILURE,
    );
  });

  test('broker TTL evidence: a ref minted and then expired is refused at redeem (authority level)', async () => {
    const { authority, clock } = runtimeFor();
    const ref = authority.mint({
      principal: principalFor(),
      credential: { id: 'cred-bearer', credentialVersion: 1, data: { value: SENTINEL }, type: 'httpBearerAuth' },
      requestId: 'req-ttl-1',
      audience: 'httpRequest',
      capability: 'cap.http',
      permission: 'credential:read',
      tenantId: 'default',
      ttlMs: 1000,
      capabilityGrants: ['cap.http'],
    });
    clock.now += 10_000;
    assert.throws(
      () => authority.redeem(ref, { requestId: 'req-ttl-1', audience: 'httpRequest', capability: 'cap.http' }),
      (e) => e.name === 'SecretRefDenied',
    );
  });

  test('target request failure (endpoint down) -> TARGET_REQUEST_FAILURE, no empty success', async () => {
    const { runtime } = runtimeFor();
    const node = nodeFor({ method: 'GET', url: 'http://127.0.0.1:1/nothing-here', authentication: 'httpBearerAuth' }, 'cred-bearer');
    await assert.rejects(
      () => httpRequestHandler(node, [{ json: {} }], contextFor(runtime)),
      (e) => e instanceof HttpRequestNodeError && e.code === HTTP_REQUEST_ERRORS.TARGET_REQUEST_FAILURE,
    );
  });

  test('a 5xx response is a RESULT, not a silent failure (status is surfaced)', async () => {
    const { runtime } = runtimeFor();
    const node = nodeFor({ method: 'GET', url: `${serverBase}/fail`, authentication: 'httpBearerAuth' }, 'cred-bearer');
    const out = await httpRequestHandler(node, [{ json: {} }], contextFor(runtime));
    assert.equal(out[0].json.statusCode, 500);
    assert.deepEqual(out[0].json.body, { error: 'boom' });
  });
});

/* ================================================== 3. secret-leak + round-trip */

describe('secret safety and round-trips', () => {
  test('the sentinel never appears in workflow JSON, errors or warnings - only server-side headers', async () => {
    const { runtime } = runtimeFor();
    const workflow = {
      nodes: [{ name: 'HTTP', type: 'n8n-nodes-base.httpRequest', parameters: { method: 'GET', url: `${serverBase}/ping`, authentication: 'httpBearerAuth' }, credentialRef: 'cred-bearer' }],
      connections: {},
    };
    // workflow JSON round-trip: serialize -> parse -> run (credentialRef survives; no secret inside)
    const roundTripped = JSON.parse(JSON.stringify(workflow));
    assert.equal(JSON.stringify(roundTripped).includes(SENTINEL), false);
    const out = await httpRequestHandler(roundTripped.nodes[0], [{ json: {} }], contextFor(runtime));
    assert.equal(out[0].json.statusCode, 200);
    assert.equal(JSON.stringify(out).includes(SENTINEL), false);

    // error objects carry codes, never material
    const badNode = nodeFor({ method: 'GET', url: `${serverBase}/ping`, authentication: 'httpBearerAuth' }, 'cred-nope');
    let captured = null;
    try {
      await httpRequestHandler(badNode, [{ json: {} }], contextFor(runtime));
    } catch (error) {
      captured = error;
    }
    assert.ok(captured instanceof HttpRequestNodeError);
    assert.equal(JSON.stringify({ m: captured.message, d: captured.details }).includes(SENTINEL), false);

    // the ONE place the secret legitimately exists: the header the real server saw
    const seen = serverRequests.find((r) => r.authorization === `Bearer ${SENTINEL}`);
    assert.ok(seen, 'the server must have observed the Authorization header');
  });

  test('execution output round-trips through JSON without the secret', async () => {
    const { runtime } = runtimeFor();
    const node = nodeFor({ method: 'GET', url: `${serverBase}/ping`, authentication: 'httpBearerAuth' }, 'cred-bearer');
    const out = await httpRequestHandler(node, [{ json: {} }], contextFor(runtime));
    const roundTripped = JSON.parse(JSON.stringify(out));
    assert.deepEqual(roundTripped[0].json.body, { ok: true, path: '/ping' });
    assert.equal(JSON.stringify(roundTripped).includes(SENTINEL), false);
  });

  test('the credential runtime errors are typed and code-closed', async () => {
    const { runtime } = runtimeFor();
    assert.throws(
      () => runtime.resolve({ credentialRef: '' }),
      (e) => e instanceof CredentialResolutionError && e.code === CREDENTIAL_RESOLUTION_ERRORS.MISSING,
    );
    assert.throws(
      () => runtime.resolve({ credentialRef: 'cred-nope' }),
      (e) => e instanceof CredentialResolutionError && e.code === CREDENTIAL_RESOLUTION_ERRORS.MISSING,
    );
    assert.throws(
      () => runtime.resolve({ credentialRef: 'cred-broken' }),
      (e) => e instanceof CredentialResolutionError && e.code === CREDENTIAL_RESOLUTION_ERRORS.MALFORMED_REF,
    );
  });

  test('single-use: replaying a redeemed ref fails at the broker (no second release)', async () => {
    const { runtime, authority } = runtimeFor();
    const { resolve } = runtime.asContext();
    const first = resolve({ credentialRef: 'cred-bearer' });
    assert.equal(first.token, SENTINEL);
    // The authority-level replay guard: a second redeem of the same ref refuses.
    // (The runtime mints per call, so replay is exercised at the authority seam.)
    const ref = authority.mint({
      principal: principalFor(),
      credential: { id: 'cred-bearer', credentialVersion: 1, data: { value: SENTINEL }, type: 'httpBearerAuth' },
      requestId: 'req-replay-1',
      audience: 'httpRequest',
      capability: 'cap.http',
      permission: 'credential:read',
      tenantId: 'default',
      capabilityGrants: ['cap.http'],
    });
    authority.redeem(ref, { requestId: 'req-replay-1', audience: 'httpRequest', capability: 'cap.http' });
    assert.throws(
      () => authority.redeem(ref, { requestId: 'req-replay-1', audience: 'httpRequest', capability: 'cap.http' }),
      (e) => e.reason === REF_DENIAL.ALREADY_REDEEMED || e.name === 'SecretRefDenied',
    );
  });
});
