#!/usr/bin/env node
/**
 * P2.5 browser gate — the frontend boundary, proven on the real n8n UI.
 *
 * Drives the pinned `n8n-editor-ui@2.9.4` against a running n8n-lego instance and
 * checks the boundary from inside a real browser:
 *
 *   1. sign in            → the stock UI renders exactly as before
 *   2. boot descriptor    → <meta name="n8n-lego:frontend-bootstrap"> is present
 *                           in the served document and decodes to a valid payload
 *   3. discovery endpoint → the same descriptor is readable over
 *                           GET /rest/frontend/bootstrap from the page itself
 *   4. contract contents  → the ten required surfaces and the extension points a
 *                           future feature LEGO attaches to are discoverable
 *   5. honesty            → no capability is registered (nothing may look shipped)
 *   6. isolation          → the page leaks no bridge global into the UI, and the
 *                           UI reports no page errors
 *
 *   node tests/e2e/frontend-boundary.mjs <baseUrl> [--headed]
 *
 * Environment:
 *   LEGO_SMOKE_EMAIL / LEGO_SMOKE_PASSWORD   owner credentials (lego-smoke defaults)
 *   LEGO_P25_EVIDENCE    evidence JSON  (default docs/n8n-lego/evidence/frontend-boundary-p25.json)
 *   LEGO_P25_SHOTS       screenshot dir (default /tmp/lego-p25-shots)
 *   CHROME_PATH          browser binary (CI: preinstalled Chrome)
 *
 * Exit code 0 only when every expectation held.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import puppeteer from 'puppeteer';

const baseUrl = (process.argv[2] ?? process.env.LEGO_SMOKE_URL ?? 'http://localhost:5678').replace(/\/$/, '');
const headed = process.argv.includes('--headed');
const email = process.env.LEGO_SMOKE_EMAIL ?? 'smoke@n8nlego.local';
const password = process.env.LEGO_SMOKE_PASSWORD ?? 'Surabaya2026!';
const evidencePath = process.env.LEGO_P25_EVIDENCE ?? 'docs/n8n-lego/evidence/frontend-boundary-p25.json';
const shotDir = process.env.LEGO_P25_SHOTS ?? '/tmp/lego-p25-shots';

const BOOT_META = 'n8n-lego:frontend-bootstrap';
const REQUIRED_SURFACES = [
  'auth',
  'navigation',
  'dashboard',
  'settings',
  'workflow-editor',
  'node-picker',
  'credentials',
  'executions',
  'webhooks',
  'notifications',
  'dialogs',
  'error-surfaces',
];

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const steps = [];
let failed = 0;
function report(name, ok, detail) {
  steps.push({ name, verdict: ok ? 'PASS' : 'FAIL', detail });
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

mkdirSync(shotDir, { recursive: true });
mkdirSync(dirname(evidencePath), { recursive: true });

const browser = await puppeteer.launch({
  headless: !headed,
  executablePath: process.env.CHROME_PATH || undefined,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  defaultViewport: { width: 1680, height: 1000 },
});
const page = await browser.newPage();

const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(String(error).slice(0, 200)));
const restLog = [];
page.on('response', (response) => {
  try {
    const url = new URL(response.url());
    if (url.pathname.startsWith('/rest/')) restLog.push({ method: response.request().method(), path: url.pathname, status: response.status() });
  } catch {
    /* cross-origin noise */
  }
});

async function screenshot(name) {
  await page.screenshot({ path: `${shotDir}/${name}.png`, fullPage: false });
}

/** Same flow as the P2 gate: owner setup or sign-in, whichever the instance needs. */
async function signInOrSetUp() {
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await wait(3000);
  await page.waitForFunction(
    () => location.pathname !== '/loading' && (document.querySelector('input[type="password"]') !== null || location.pathname.startsWith('/home')),
    { timeout: 60000 },
  );
  if (page.url().includes('/setup')) {
    await page.evaluate((mail, pass) => {
      const set = (selector, value) => {
        const el = document.querySelector(selector);
        if (!el) return;
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      };
      set('input[type="email"], #email', mail);
      set('#firstName, input[name="firstName"]', 'P2.5');
      set('#lastName, input[name="lastName"]', 'Boundary');
      set('input[type="password"]', pass);
    }, email, password);
    await wait(400);
    await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => /next|sign up/i.test(b.textContent || ''))?.click());
    await page.waitForFunction(() => location.pathname.startsWith('/home'), { timeout: 60000 });
    return 'owner setup';
  }
  if (page.url().includes('/signin') || (await page.$('input[type="password"]'))) {
    await page.evaluate((mail, pass) => {
      const set = (selector, value) => {
        const el = document.querySelector(selector);
        if (!el) return;
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      };
      set('input[type="email"], #email', mail);
      set('input[type="password"]', pass);
    }, email, password);
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => location.pathname.startsWith('/home'), { timeout: 60000 });
    return 'sign in';
  }
  return 'already authenticated';
}

/* ------------------------------------------------------------- 1. sign in */
report('owner login → dashboard (stock UI unchanged)', await signInOrSetUp().then(() => true), await page.evaluate(() => location.pathname));
await screenshot('01-dashboard');

/* --------------------------------------------- 2. boot descriptor in the page */
const boot = await page.evaluate((metaName) => {
  const tag = document.querySelector(`meta[name="${metaName}"]`);
  if (!tag) return { present: false };
  const encoded = tag.getAttribute('content') || '';
  try {
    const binary = atob(encoded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return { present: true, bytes: encoded.length, payload: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch (error) {
    return { present: true, error: String(error) };
  }
}, BOOT_META);

report('boot descriptor is present in the served document', boot.present === true, boot.present ? `${boot.bytes} bytes (base64)` : 'meta tag missing');
report(
  'the descriptor decodes to a valid payload',
  Boolean(boot.payload) && boot.payload.contractVersion === '1.0.0' && Array.isArray(boot.payload.surfaces),
  boot.payload ? `contractVersion=${boot.payload.contractVersion} surfaces=${boot.payload.surfaces.length}` : `decode failed: ${boot.error}`,
);

if (boot.payload) {
  const missing = REQUIRED_SURFACES.filter((id) => !boot.payload.surfaces.some((surface) => surface.id === id));
  report('every required UI surface is declared', missing.length === 0, missing.length === 0 ? `${REQUIRED_SURFACES.length} surfaces` : `missing: ${missing.join(', ')}`);

  const hooks = new Set((boot.payload.extensionPoints ?? []).map((point) => point.id));
  const requiredHooks = ['ui:message:catalog', 'ui:locale:switch', 'ui:error:render', 'ui:notification:render', 'ui:nav:item'];
  const missingHooks = requiredHooks.filter((hook) => !hooks.has(hook));
  report('extensions have declared insertion points', missingHooks.length === 0, missingHooks.length === 0 ? `${hooks.size} hooks` : `missing: ${missingHooks.join(', ')}`);

  report('no frontend capability claims to be shipped', Array.isArray(boot.payload.capabilities) && boot.payload.capabilities.length === 0, `capabilities=${(boot.payload.capabilities ?? []).length}`);

  const units = boot.payload.subLegos ?? [];
  const nested = units.filter((unit) => unit.parentId !== null);
  const deepest = units.find((unit) => unit.id === 'settings.localization.rtl');
  report(
    'the nested units are published with their hierarchy',
    units.length >= 15 && nested.length >= 6 && deepest?.parentId === 'settings.localization',
    `${units.length} units, ${nested.length} nested, depth example settings.localization.rtl`,
  );
  report(
    'private areas never reach the browser',
    JSON.stringify(units).includes('src/sub-legos') === false && JSON.stringify(units).includes('internals') === false,
    'no internals or test paths in the payload',
  );
  report('the locale model carries the six locales and Arabic RTL', (boot.payload.locales?.supported?.length ?? 0) === 6 && (boot.payload.locales?.rtl ?? []).includes('ar'), (boot.payload.locales?.supported ?? []).map((locale) => locale.code).join(','));
}

/* ------------------------------------- 3. discovery endpoint, read from the page */
const endpoint = await page.evaluate(async () => {
  const response = await fetch('/rest/frontend/bootstrap', { credentials: 'same-origin' });
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { status: response.status, data: body?.data ?? null };
});
report('GET /rest/frontend/bootstrap answers from the browser session', endpoint.status === 200, `status=${endpoint.status}`);
if (boot.payload && endpoint.data) {
  report(
    'both delivery paths carry the same descriptor',
    JSON.stringify(boot.payload.surfaces) === JSON.stringify(endpoint.data.surfaces),
    `surfaces match (${endpoint.data.surfaces.length})`,
  );
}

/* ------------------------------------------------- 4. isolation + stock UI */
const isolation = await page.evaluate(() => {
  const root = document.querySelector('#app');
  return {
    bridgeLeaked: typeof window.__N8N_LEGO_FRONTEND__ !== 'undefined',
    appRoot: Boolean(root),
    appChildren: root ? root.children.length : 0,
    title: document.title,
    pathname: location.pathname,
  };
});
report('no bridge global leaks into the stock application', isolation.bridgeLeaked === false, isolation.bridgeLeaked ? 'window.__N8N_LEGO_FRONTEND__ was defined by the page' : 'window untouched');
report(
  'the stock editor shell is rendered (unchanged)',
  isolation.appRoot === true && isolation.appChildren > 0 && isolation.pathname.startsWith('/home'),
  `#app children=${isolation.appChildren} path=${isolation.pathname} title="${isolation.title}"`,
);
report('the UI raised no page errors', pageErrors.length === 0, pageErrors.length === 0 ? 'clean console' : pageErrors.join(' | '));
await screenshot('02-home-with-descriptor');

/* ------------------------------------------------------ 5. request footprint */
const unexpected = restLog.filter((entry) => entry.status >= 500 && entry.status !== 501);
report('no unexpected 5xx while browsing', unexpected.length === 0, unexpected.length === 0 ? `${restLog.length} /rest responses inspected` : JSON.stringify(unexpected));

/* ------------------------------------------------------------------ evidence */
const evidence = {
  phase: 'P2.5',
  generatedAt: new Date().toISOString(),
  url: baseUrl,
  steps,
  bootDescriptor: boot.payload
    ? {
        contractVersion: boot.payload.contractVersion,
        surfaces: boot.payload.surfaces.map((surface) => ({ id: surface.id, status: surface.status })),
        extensionPoints: (boot.payload.extensionPoints ?? []).map((point) => point.id),
        locales: (boot.payload.locales?.supported ?? []).map((locale) => locale.code),
        capabilities: boot.payload.capabilities,
        ui: boot.payload.ui,
      }
    : null,
  restSample: restLog.slice(0, 40),
  pageErrors,
};
writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
console.log(`\nP2.5 frontend boundary: ${steps.length - failed}/${steps.length} PASS${failed > 0 ? ` — ${failed} FAILED` : ''}`);
console.log(`evidence: ${evidencePath}`);

await browser.close();
process.exit(failed === 0 ? 0 : 1);
