/**
 * P2.5 — the frontend boundary, proven against the running instance.
 *
 *   I8  the boot descriptor is served (`GET /rest/frontend/bootstrap`, auth
 *       required), the boot `<meta>` tag on `index.html` decodes to the same
 *       payload, and the served UI is **byte-identical apart from that one
 *       additive tag** — the pinned bundle is not patched.
 *
 *   I9  a real `501 {code:'unsupported'}` from the compatibility layer becomes a
 *       machine-readable error in the framework-neutral client, with the
 *       capability metadata intact (the chain Translation LEGO will build on).
 *
 * Also covered: fail-soft behavior (no descriptor ⇒ the UI still serves), and the
 * absence of any backend coupling from the frontend LEGO.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../src/server.mjs';
import { createUi } from '../src/ui.mjs';
import { FRONTEND_PATH } from '../src/frontend.mjs';
import {
  FRONTEND_BOOT_META_NAME,
  createRestClient,
  decodeBootPayload,
  extractBootPayload,
  validateBootPayload,
} from '../../../packages/frontend-lego/index.mjs';

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_CATALOG = resolve(APP_DIR, '..', '..', 'data', 'n8n-lego', 'catalog');
const USER_FOLDER = mkdtempSync(join(tmpdir(), 'n8n-lego-p25-test-'));
const EDITOR_INSTALLED = existsSync(join(APP_DIR, 'node_modules', 'n8n-editor-ui', 'dist', 'index.html'));

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

let base;
let running;
let started;

before(async () => {
  started = await startServer({
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
  base = `http://127.0.0.1:${running.address().port}`;
});

after(async () => {
  if (running) await new Promise((done) => running.close(() => done()));
  rmSync(USER_FOLDER, { recursive: true, force: true });
});

let cookie;

async function api(path, options = {}) {
  const response = await fetch(`${base}${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(options.headers ?? {}) },
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  const setCookie = response.headers.getSetCookie?.() ?? [];
  if (setCookie.length > 0 && !cookie) cookie = setCookie.map((value) => value.split(';')[0]).join('; ');
  return { status: response.status, body, text };
}

/** Captures `createUi().serve` output without an HTTP server. */
function renderIndex({ frontend = null } = {}) {
  const ui = createUi({
    config: {
      editorDist: join(APP_DIR, 'node_modules', 'n8n-editor-ui', 'dist'),
      restEndpoint: 'rest',
      basePath: '/',
      appName: 'n8n lego',
      env: 'test',
      version: '0.1.0',
      dataDir: USER_FOLDER,
    },
    logger: silentLogger,
    frontend,
  });
  let status = 0;
  let body = '';
  ui.serve({}, {
    writeHead(code) {
      status = code;
    },
    end(chunk) {
      body += typeof chunk === 'string' ? chunk : String(chunk ?? '');
    },
  }, '/');
  return { status, body };
}

test('the frontend LEGO is present and loaded by the app', () => {
  assert.ok(FRONTEND_PATH, 'the app must resolve the frontend LEGO package');
  assert.match(FRONTEND_PATH, /frontend-lego\/index\.mjs$/);
  assert.equal(started.frontend.available, true);
  const description = started.frontend.describe();
  assert.equal(description.contractVersion, '1.0.0');
  // Refresh 2026-09-28 (P2-S14): the declared surface catalog grows by the canvas
  // surface (manifest/surfaces.json): 12 -> 13.
  // Refresh 2026-09-28 (P2-S15): + the node-config surface: 13 -> 14.
  // Refresh 2026-09-28 (P2-S16): + the connections surface: 14 -> 15.
  // Refresh 2026-09-28 (P2-S18): + the environments surface: 15 -> 16.
  // Refresh 2026-09-28 (P2-S19): + the integrations surface: 16 -> 17.
    // Refresh 2026-09-28 (P2-S20): + the execution-mgmt surface: 17 -> 18.
    // Refresh 2026-09-28 (P2-S21): + the project-admin surface: 18 -> 19.
    // Refresh 2026-09-28 (P2-S22): + the assistant surface: 19 -> 20.
    // Refresh 2026-09-28 (P2-S23): + the copilot surface: 20 -> 21.
    // Refresh 2026-09-28 (P2-S24): + the ai-node surface: 21 -> 22.
    // Refresh 2026-09-29 (P2-S25): + the work-trace surface: 22 -> 23.
  assert.equal(description.surfaces, 23);
  assert.equal(description.capabilities, 0, 'P2.5 registers no capability');
  assert.equal(description.backendUntouched, true);
  assert.equal(description.editorVersion, '2.9.4');
});

test('the descriptor carries the sub-LEGO hierarchy, never its internals', () => {
  const description = started.frontend.describe();
  assert.equal(description.subLegos, 19, 'the declared units are published');
  assert.ok(description.subLegoDepth >= 2, 'at least three levels (settings.localization.rtl)');

  const published = started.frontend.subLegos.toBootView();
  const byId = new Map(published.map((entry) => [entry.id, entry]));
  assert.equal(byId.get('settings.localization.rtl').parentId, 'settings.localization');
  assert.deepEqual(byId.get('workflow-editor.node-panel').ports, ['ui:panel:selection', 'ui:panel:parameters']);

  // A parent is always published before its children (the hierarchy is walkable
  // in one pass without a lookup table).
  const seen = new Set();
  for (const entry of published) {
    if (entry.parentId !== null) assert.ok(seen.has(entry.parentId), `${entry.id} came before its parent`);
    seen.add(entry.id);
  }
  const serialized = JSON.stringify(published);
  assert.equal(serialized.includes('src/sub-legos'), false, 'private areas are never published');
  assert.equal(serialized.includes('internals'), false);
});

test('GET /rest/frontend/bootstrap requires a session', async () => {
  const anonymous = await api('/rest/frontend/bootstrap', { headers: { cookie: '' } });
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.body.message, 'Unauthorized');
});

test('GET /rest/frontend/bootstrap answers the descriptor in the standard envelope', async () => {
  await api('/rest/owner/setup', {
    method: 'POST',
    body: JSON.stringify({ email: 'p25@n8nlego.local', firstName: 'P2.5', lastName: 'Boundary', password: 'Surabaya2026!' }),
  });
  const response = await api('/rest/frontend/bootstrap');
  assert.equal(response.status, 200);
  const payload = response.body.data;

  const validation = validateBootPayload(payload);
  assert.deepEqual(validation.errors, []);
  assert.equal(validation.ok, true);
  assert.equal(payload.contractVersion, '1.0.0');

  const required = ['dashboard', 'settings', 'workflow-editor', 'node-picker', 'credentials', 'executions', 'webhooks', 'notifications', 'dialogs', 'error-surfaces'];
  for (const id of required) {
    assert.ok(payload.surfaces.some((surface) => surface.id === id), `surface ${id} must be discoverable`);
  }
  assert.ok(payload.extensionPoints.some((point) => point.id === 'ui:message:catalog'), 'the Translation LEGO insertion point must be discoverable');
  assert.equal(payload.subLegos.length, 19, 'the nested units are discoverable over HTTP, not only in-process');
  assert.ok(payload.subLegos.some((unit) => unit.id === 'settings.localization' && unit.parentId === 'settings'), 'the translation host unit is declared');
  assert.deepEqual(payload.locales.rtl, ['ar']);
  assert.ok(payload.errorCodes.includes('frontend.capability.unsupported'));
  assert.equal(payload.ui.frameworkIsolated, true);
  assert.equal(payload.capabilities.length, 0);
});

test('the boot <meta> tag carries exactly the descriptor the endpoint serves', async () => {
  const page = await api('/');
  if (!EDITOR_INSTALLED) {
    assert.equal(page.status, 503, 'without the editor bundle the app answers its bootstrap page');
    assert.equal(extractBootPayload(page.text), null, 'and injects nothing — fail-soft');
    return;
  }
  const embedded = extractBootPayload(page.text);
  assert.ok(embedded, `index.html must carry <meta name="${FRONTEND_BOOT_META_NAME}">`);
  const endpoint = await api('/rest/frontend/bootstrap');
  assert.deepEqual(embedded, endpoint.body.data, 'one descriptor, two delivery paths, no divergence');
  assert.equal(page.text.split(FRONTEND_BOOT_META_NAME).length - 1, 1, 'the tag is injected once');
});

test('the served UI is byte-identical apart from the additive boot tag', () => {
  if (!EDITOR_INSTALLED) return; // the 503 bootstrap page has no bundle to compare
  const withDescriptor = renderIndex({ frontend: started.frontend });
  const withoutDescriptor = renderIndex();
  const stripped = withDescriptor.body.replace(new RegExp(`<meta[^>]*name="${FRONTEND_BOOT_META_NAME}"[^>]*>`), '');
  assert.equal(
    stripped,
    withoutDescriptor.body,
    'the editor bundle must be served verbatim: the boot tag is the only difference the frontend LEGO introduces',
  );
  assert.notEqual(withDescriptor.body, withoutDescriptor.body, 'the descriptor must actually be injected');
  assert.equal(withDescriptor.status, 200);
});

test('a missing frontend LEGO degrades to serving the UI without the descriptor', async () => {
  const { loadFrontend } = await import('../src/frontend.mjs');
  const previous = process.env.N8N_LEGO_FRONTEND_PATH;
  process.env.N8N_LEGO_FRONTEND_PATH = '/nonexistent-frontend-lego';
  try {
    // The env override is a candidate, not an override — the repository package
    // is still found, which is the point: resolution is fail-soft, not fatal.
    const frontend = await loadFrontend({ config: { appName: 'n8n lego', version: '0.1.0', basePath: '/', restEndpoint: 'rest' }, logger: silentLogger });
    assert.equal(frontend.available, true);
    assert.equal(typeof frontend.metaTag, 'string');
  } finally {
    if (previous === undefined) delete process.env.N8N_LEGO_FRONTEND_PATH;
    else process.env.N8N_LEGO_FRONTEND_PATH = previous;
  }
});

test('I9 — a real 501 capability answer becomes a machine-readable client error', async () => {
  const client = createRestClient({
    baseUrl: base,
    restEndpoint: 'rest',
    fetchImpl: (url, options) => fetch(url, { ...options, headers: { ...(options?.headers ?? {}), cookie } }),
  });

  const settings = await client.get('/settings');
  assert.equal(settings.ok, true, 'an implemented endpoint answers normally');
  assert.equal(settings.error, null);

  // /rest/settings/security is a known-but-unimplemented capability (P2
  // registry). It replaced /rest/api-keys here when P5.7 implemented API keys.
  const unsupported = await client.get('/settings/security');
  assert.equal(unsupported.ok, false);
  assert.equal(unsupported.status, 501);
  assert.equal(unsupported.error.kind, 'unsupported');
  assert.equal(unsupported.error.code, 'unsupported');
  assert.equal(unsupported.error.meta.feature, 'security-settings');
  assert.equal(unsupported.error.meta.owner, 'auth');
  assert.equal(unsupported.error.messageKey, 'backend-errors.capability-unsupported');
  assert.equal(unsupported.error.retryable, false);

  const display = client.unwrap({ data: [] }, { path: '/rest/variables', status: 200 });
  assert.equal(display.shape, 'data', 'an honest empty collection stays an empty collection');
});

test('the descriptor is deterministic across requests (no per-request state)', async () => {
  const first = await api('/rest/frontend/bootstrap');
  const second = await api('/rest/frontend/bootstrap');
  assert.equal(JSON.stringify(first.body), JSON.stringify(second.body));
  assert.equal(decodeBootPayload(JSON.stringify(first.body.data) && Buffer.from(JSON.stringify(first.body.data)).toString('base64')).contractVersion, '1.0.0');
});

test('the app loads the LEGO through its entry point only', async () => {
  const { FRONTEND_PATH } = await import('../src/frontend.mjs');
  const source = (await import('node:fs')).readFileSync(FRONTEND_PATH, 'utf8');
  assert.match(FRONTEND_PATH, /frontend-lego\/index\.mjs$/);
  const specifiers = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((match) => match[1]);
  assert.ok(specifiers.length > 0);
  for (const specifier of specifiers) assert.match(specifier, /^\.\/src\//);
});

test('the frontend LEGO introduces no backend coupling', async () => {
  const source = await import('node:fs').then(({ readFileSync }) => readFileSync(FRONTEND_PATH, 'utf8'));
  const specifiers = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((match) => match[1]);
  assert.ok(specifiers.length > 0, 'the entry re-exports the package modules');
  for (const specifier of specifiers) {
    assert.ok(specifier.startsWith('./src/'), `the entry may only re-export ./src/** (found ${specifier})`);
  }
  assert.doesNotMatch(JSON.stringify(specifiers), /apps\//, 'no app implementation import, ever');
});
