/**
 * W3 — health, metadata, console and protocol-level HTTP behaviour
 * (contract §3 rows 1–6, 16–17).
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { Runtime } from './helpers/process.mjs';

let runtime;

before(async () => {
  runtime = await Runtime.start();
});

after(async () => {
  await runtime?.cleanup();
});

test('/healthz returns exactly the n8n-compatible body', async () => {
  const response = await runtime.get('/healthz');
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { status: 'ok' });
  assert.match(response.headers['content-type'], /application\/json/);
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.ok(response.headers['x-request-id']);
  assert.equal(response.headers['x-frame-options'], undefined, 'framing must stay allowed for proxied previews');
  assert.equal(response.headers['x-n8n-ts-contract'], '1.0.0');
});

test('/healthz/readiness reports checks and is 200 when healthy', async () => {
  const response = await runtime.get('/healthz/readiness');
  assert.equal(response.status, 200);
  assert.equal(response.body.status, 'ok');
  const checks = response.body.checks;
  assert.equal(checks.shuttingDown, false);
  assert.equal(checks.dataDirWritable, true);
  assert.equal(checks.storage, 'file');
  assert.equal(checks.nodeTypes, 8);
  assert.equal(typeof checks.uptimeSec, 'number');
  assert.equal(checks.engine.package, '@lego/reconstructed-engine');
});

test('/healthz/full aggregates the diagnostics doctor.sh needs', async () => {
  const response = await runtime.get('/healthz/full');
  assert.equal(response.status, 200);
  const data = response.body.data;
  assert.equal(data.status, 'ok');
  assert.equal(typeof data.version, 'string');
  assert.equal(data.env, 'test');
  assert.equal(typeof data.executions, 'number');
});

test('/api/v1/version matches contract §3.1', async () => {
  const { status, body } = await runtime.get('/api/v1/version');
  assert.equal(status, 200);
  const data = body.data;
  assert.equal(data.name, 'n8n-ts-runtime');
  assert.equal(data.api, 'v1');
  assert.equal(data.contract, '1.0.0');
  assert.match(data.node, /^v\d+\./);
  assert.match(data.startedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(typeof data.uptimeSec, 'number');
  assert.equal(data.engine.package, '@lego/reconstructed-engine');
  assert.match(data.engine.version, /^\d+\.\d+\.\d+$/);
  assert.match(data.engine.registryVersion, /^\d+\.\d+\.\d+$/);
});

test('/api/v1/nodes lists the registered handlers', async () => {
  const { status, body } = await runtime.get('/api/v1/nodes');
  assert.equal(status, 200);
  assert.equal(body.data.count, body.data.nodes.length);
  const types = body.data.nodes.map((node) => node.type);
  for (const type of ['n8n-nodes-base.manualTrigger', 'n8n-nodes-base.set', 'n8n-nodes-base.noOp']) {
    assert.ok(types.includes(type), `${type} must be registered`);
  }
  assert.ok(body.data.nodes.every((node) => node.implemented === true && typeof node.label === 'string'));
});

test('the operator console is served at / and favicon answers 204', async () => {
  const page = await runtime.get('/');
  assert.equal(page.status, 200);
  assert.match(page.headers['content-type'], /text\/html/);
  assert.match(page.text, /n8n-ts runtime/);
  assert.match(page.text, /\/api\/v1\/workflows\/run/, 'console drives the contract endpoints');

  const favicon = await runtime.get('/favicon.ico');
  assert.equal(favicon.status, 204);
});

test('unknown routes are 404 NOT_FOUND with a requestId', async () => {
  const { status, body, headers } = await runtime.get('/nope');
  assert.equal(status, 404);
  assert.equal(body.code, 'NOT_FOUND');
  assert.ok(body.message.includes('/nope'));
  assert.equal(body.requestId, headers['x-request-id']);
});

test('a known path with the wrong method is 405 with an Allow header', async () => {
  const { status, body, headers } = await runtime.del('/api/v1/version');
  assert.equal(status, 405);
  assert.equal(body.code, 'METHOD_NOT_ALLOWED');
  assert.deepEqual(body.details.allowed, ['GET']);
  assert.equal(headers.allow, 'GET');
});

test('CORS headers are present on /api/* and preflight is 204', async () => {
  const api = await runtime.get('/api/v1/version');
  assert.equal(api.headers['access-control-allow-origin'], '*');

  const preflight = await runtime.request('/api/v1/workflows/run', { method: 'OPTIONS' });
  assert.equal(preflight.status, 204);
  assert.match(preflight.headers['access-control-allow-methods'], /POST/);
  assert.match(preflight.headers['access-control-allow-headers'], /X-N8N-API-KEY/);

  const publicRoute = await runtime.get('/healthz');
  assert.equal(publicRoute.headers['access-control-allow-origin'], undefined);
});

test('every request gets its own request id', async () => {
  const first = await runtime.get('/healthz');
  const second = await runtime.get('/healthz');
  assert.notEqual(first.headers['x-request-id'], second.headers['x-request-id']);
});
