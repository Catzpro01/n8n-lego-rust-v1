/**
 * P6-S05 — httpRequest node unit suite: contract, auth modes, failure matrix,
 * secret redaction, and the Rust-parity fixtures (fixtures/http-request-contract.json).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  httpRequestHandler,
  buildRequest,
  shapeResponse,
  HttpRequestNodeError,
  HTTP_REQUEST_ERRORS,
  HTTP_AUTH_MODES,
} from '../http-request.mjs';
import { createMockTransport, createFetchTransport, TransportError } from '../http-transport.mjs';
import { createNodeRegistry } from '../node-registry.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = JSON.parse(readFileSync(join(HERE, '..', 'fixtures', 'http-request-contract.json'), 'utf8'));
const SENTINEL = FIXTURES.secretSentinel;

function nodeFor(parameters, credentialRef = 'cred1') {
  return { name: 'HTTP', type: 'n8n-nodes-base.httpRequest', parameters, credentialRef };
}

function contextFor({ transport, resolve }) {
  return {
    allowCodeEval: false,
    emitWarning: () => {},
    locale: 'en',
    httpTransport: transport,
    credentials: { resolve },
  };
}

function resolverFor(fixtureCredential) {
  return () => {
    if (fixtureCredential === 'MISSING') {
      const e = new Error('credential not in store'); e.code = 'CREDENTIAL_MISSING'; throw e;
    }
    if (fixtureCredential === 'UNAUTHORIZED') {
      const e = new Error('refused'); e.code = 'ref.not_authorized'; throw e;
    }
    if (fixtureCredential === 'MALFORMED_REF') {
      const e = new Error('bad ref'); e.code = 'ref.malformed'; throw e;
    }
    if (fixtureCredential === 'BROKER_FAILURE') {
      const e = new Error('broker exploded'); e.code = 'ref.no_material'; throw e;
    }
    return fixtureCredential;
  };
}

function materialize(value) {
  return typeof value === 'string' ? value.replaceAll('<secretSentinel>', SENTINEL) : value;
}

test('the registry carries httpRequest as a built-in (P6-S05)', () => {
  const registry = createNodeRegistry();
  assert.equal(registry.has('n8n-nodes-base.httpRequest'), true);
  const info = registry.info('n8n-nodes-base.httpRequest');
  assert.equal(info.alias, 'httpRequest');
  assert.equal(info.implemented, true);
});

test('the auth vocabulary is the closed reference token set', () => {
  assert.deepEqual([...HTTP_AUTH_MODES], ['none', 'httpBearerAuth', 'httpHeaderAuth']);
  assert.deepEqual([...FIXTURES.authModes], [...HTTP_AUTH_MODES]);
});

for (const fixture of FIXTURES.cases) {
  test(`fixture: ${fixture.name}`, async () => {
    const parameters = JSON.parse(JSON.stringify(fixture.parameters, (k, v) => v));
    // deep-materialize sentinel placeholders inside parameters
    const node = nodeFor(materializeDeep(parameters), 'cred1');
    if (fixture.credential === null || fixture.credential === 'MISSING') node.credentialRef = undefined;
    const transportCalls = [];
    const transport = createMockTransport((req) => {
      if (fixture.transport === 'NETWORK_ERROR') throw new TransportError('connection refused', { kind: 'network' });
      return materializeDeep(fixture.transport);
    });
    const context = contextFor({ transport, resolve: resolverFor(materializeDeep(fixture.credential)) });

    if (fixture.expect.errorCode) {
      await assert.rejects(
        () => httpRequestHandler(node, [{ json: {} }], context),
        (error) => {
          assert.ok(error instanceof HttpRequestNodeError, 'typed node error');
          assert.equal(error.code, fixture.expect.errorCode);
          // secret-leak rule: error objects never carry the sentinel
          assert.equal(JSON.stringify({ m: error.message, d: error.details }).includes(SENTINEL), false);
          return true;
        },
      );
      return;
    }
    const out = await httpRequestHandler(node, [{ json: { seed: 1 } }], context);
    assert.equal(out.length, 1);
    assert.deepEqual(out[0].json, materializeDeep(fixture.expect.outputJson));
    // the sent request is asserted through the recorded transport call
    const sent = transport.calls[0];
    assert.equal(sent.method, fixture.expect.sentRequest.method);
    assert.equal(sent.url, fixture.expect.sentRequest.url);
    assert.deepEqual(sent.headers, materializeDeep(fixture.expect.sentRequest.headers));
    assert.equal(sent.body, fixture.expect.sentRequest.body ?? null);
    // output never echoes request headers (redaction)
    assert.equal(JSON.stringify(out).includes(SENTINEL), false, 'the secret must not appear in output items');
  });
}

function materializeDeep(value) {
  if (typeof value === 'string') return value.replaceAll('<secretSentinel>', SENTINEL);
  if (Array.isArray(value)) return value.map(materializeDeep);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = materializeDeep(v);
    return out;
  }
  return value;
}

test('one request per input item (literal parameters)', async () => {
  const calls = [];
  const transport = createMockTransport(() => { calls.push(1); return { status: 200, headers: {}, body: 'x' }; });
  const context = contextFor({ transport, resolve: () => ({ kind: 'bearer', token: SENTINEL }) });
  const node = nodeFor({ method: 'GET', url: 'http://localhost:1/a', authentication: 'httpBearerAuth' });
  const out = await httpRequestHandler(node, [{ json: {} }, { json: {} }, { json: {} }], context);
  assert.equal(out.length, 3);
  assert.equal(transport.calls.length, 3);
});

test('expression literals are refused explicitly (registry EXPRESSION policy)', async () => {
  const context = contextFor({ transport: createMockTransport(), resolve: () => ({ kind: 'bearer', token: SENTINEL }) });
  const node = nodeFor({ method: 'GET', url: '= {{ $json.u }}', authentication: 'httpBearerAuth' });
  await assert.rejects(
    () => httpRequestHandler(node, [{ json: {} }], context),
    (e) => e instanceof HttpRequestNodeError && e.code === HTTP_REQUEST_ERRORS.INVALID_PARAMETERS,
  );
});

test('credentialRef with authentication none is a wiring error', async () => {
  const context = contextFor({ transport: createMockTransport(), resolve: () => ({ kind: 'bearer', token: SENTINEL }) });
  const node = nodeFor({ method: 'GET', url: 'http://localhost:1/a', authentication: 'none' }, 'cred1');
  await assert.rejects(
    () => httpRequestHandler(node, [{ json: {} }], context),
    (e) => e instanceof HttpRequestNodeError && e.code === HTTP_REQUEST_ERRORS.INVALID_PARAMETERS,
  );
});

test('without an injected transport the node fails explicitly, never silently', async () => {
  const context = contextFor({ transport: null, resolve: () => ({ kind: 'bearer', token: SENTINEL }) });
  const node = nodeFor({ method: 'GET', url: 'http://localhost:1/a', authentication: 'httpBearerAuth' });
  await assert.rejects(
    () => httpRequestHandler(node, [{ json: {} }], context),
    (e) => e instanceof HttpRequestNodeError && e.code === HTTP_REQUEST_ERRORS.TARGET_REQUEST_FAILURE,
  );
});

test('shapeResponse strips sensitive response headers and parses json bodies', () => {
  const shaped = shapeResponse(
    { method: 'GET', url: 'http://x/y' },
    { status: 200, headers: { 'content-type': 'application/json', 'set-cookie': 'a=b' }, body: '{"k":1}' },
  );
  assert.equal(shaped.headers['set-cookie'], undefined);
  assert.deepEqual(shaped.body, { k: 1 });
  assert.deepEqual(shaped.request, { method: 'GET', url: 'http://x/y' });
});

test('the fetch transport performs real requests and maps failures to TransportError', async () => {
  // Deterministic fake fetch: proves the seam contract without a live network.
  const fakeFetch = async (url, init) => {
    assert.equal(init.method, 'GET');
    assert.equal(init.headers.Authorization, `Bearer ${SENTINEL}`);
    return {
      status: 200,
      headers: new Map([['content-type', 'application/json']]),
      text: async () => '{"ok":true}',
    };
  };
  const transport = createFetchTransport({ fetchImpl: fakeFetch });
  const response = await transport.request({ method: 'GET', url: 'http://localhost:1/a', headers: { Authorization: `Bearer ${SENTINEL}` } });
  assert.equal(response.status, 200);
  assert.equal(response.body, '{"ok":true}');

  const failing = createFetchTransport({ fetchImpl: async () => { const e = new Error('connection refused'); e.name = 'TypeError'; throw e; } });
  await assert.rejects(
    () => failing.request({ method: 'GET', url: 'http://localhost:1/a', headers: {} }),
    (e) => e instanceof TransportError && e.kind === 'network',
  );

  const timingOut = createFetchTransport({ fetchImpl: async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; } });
  await assert.rejects(
    () => timingOut.request({ method: 'GET', url: 'http://localhost:1/a', headers: {}, timeoutMs: 5 }),
    (e) => e instanceof TransportError && e.kind === 'timeout',
  );
});
