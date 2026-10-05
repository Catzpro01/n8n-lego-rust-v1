#!/usr/bin/env node
/**
 * P2 browser gate — Compatibility Contract Layer, proven on the real n8n UI.
 *
 * Drives the pinned `n8n-editor-ui@2.9.4` against a running n8n-lego instance
 * and verifies what P2 changed at the contract level:
 *
 *   1. owner login          → PublicUser.globalScopes present (RBAC store input)
 *   2. Settings             → /settings redirects to /settings/usage
 *                             (hideUsagePage=false, upstream community default)
 *   3. menu visibility      → settings sidebar shows every community-available
 *                             entry (Users, n8n API, Security & policies, …)
 *   4. community behavior   → queue/AI/community-nodes entries stay hidden
 *                             (flags honestly off — never forced on)
 *   5. route guard          → scope-guarded page renders for the owner, a page
 *                             whose flag is off redirects home
 *   6. unsupported semantics→ the unimplemented backends behind those pages
 *                             answer 501 {code:'unsupported'} — no fake 200 {}
 *
 *   node tests/e2e/settings-compat.mjs <baseUrl> [--headed]
 *
 * Environment:
 *   LEGO_SMOKE_EMAIL / LEGO_SMOKE_PASSWORD   owner credentials (lego-smoke defaults)
 *   LEGO_P2_EVIDENCE     evidence JSON  (default docs/n8n-lego/evidence/settings-visibility-p2.json)
 *   LEGO_P2_SHOTS        screenshot dir (default /tmp/lego-p2-shots)
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
const evidencePath = process.env.LEGO_P2_EVIDENCE ?? 'docs/n8n-lego/evidence/settings-visibility-p2.json';
const shotDir = process.env.LEGO_P2_SHOTS ?? '/tmp/lego-p2-shots';

/** Community edition, single owner, catalog features off: the sidebar the stock
 * community editor renders when the scope contract is correct. */
const EXPECTED_SETTINGS = [
  'Usage and plan',
  'Personal',
  'Users',
  'Project roles',
  'n8n API',
  'External Secrets',
  'Environments',
  'SSO',
  'Security & policies',
  'LDAP',
  'Log Streaming',
  'Migration Report',
];
const FORBIDDEN_SETTINGS = ['Workers', 'AI Usage', 'Credential resolvers', 'Community nodes'];

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

/** Every /rest response, so unsupported endpoints are proven from the network. */
const restLog = [];
page.on('response', (response) => {
  try {
    const url = new URL(response.url());
    if (url.pathname.startsWith('/rest/')) {
      restLog.push({ method: response.request().method(), path: url.pathname, status: response.status() });
    }
  } catch {
    /* cross-origin noise */
  }
});
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(String(error).slice(0, 200)));

async function screenshot(name) {
  await page.screenshot({ path: `${shotDir}/${name}.png`, fullPage: false });
}

function settingsLabels() {
  return page.evaluate(() => {
    const root = document.querySelector('[data-test-id="settings-back"]')?.parentElement;
    return root ? (root.innerText || '').split('\n').map((line) => line.trim()).filter(Boolean) : [];
  });
}

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
      set('#firstName, input[name="firstName"]', 'P2');
      set('#lastName, input[name="lastName"]', 'Compat');
      set('input[type="password"]', pass);
    }, email, password);
    await wait(400);
    await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => /next|sign up/i.test(b.textContent || ''))?.click());
    await page.waitForFunction(() => location.pathname.startsWith('/home'), { timeout: 60000 });
    return 'owner setup';
  }
  if (page.url().includes('/signin') || document.querySelector('input[type="password"]')) {
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

/* ------------------------------------------------------------- 1. login + dashboard */
report('owner login → dashboard', true, await signInOrSetUp());
await screenshot('01-dashboard');

/* ------------------------------------------------- 2. globalScopes reach the UI */
{
  const login = await page.evaluate(async () => {
    const response = await fetch('/rest/login', { credentials: 'same-origin' });
    return { status: response.status, body: await response.json() };
  });
  const scopes = login.body?.data?.globalScopes;
  report(
    'PublicUser.globalScopes reaches the browser (RBAC store input)',
    login.status === 200 && Array.isArray(scopes) && scopes.length > 100,
    `status=${login.status} globalScopes=${Array.isArray(scopes) ? scopes.length : typeof scopes}`,
  );
}

/* --------------------------------------- 3. /settings redirect + usage page (R2) */
{
  const before = restLog.length;
  await page.goto(`${baseUrl}/settings`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => location.pathname.startsWith('/settings/'), { timeout: 60000 });
  await wait(2500);
  const usageCalls = restLog.slice(before).filter((entry) => entry.path === '/rest/license');
  const onUsage = await page.evaluate(() => location.pathname === '/settings/usage');
  report(
    'open Settings → route guard sends to "Usage and plan" (hideUsagePage=false)',
    onUsage,
    `pathname=${await page.evaluate(() => location.pathname)}`,
  );
  report('the usage page loaded its contract endpoint (GET /rest/license 200)', usageCalls.some((c) => c.status === 200), JSON.stringify(usageCalls));
  await screenshot('02-settings-usage');
}

/* -------------------------------------------------------- 4. settings sidebar */
{
  const labels = await settingsLabels();
  console.log(`     sidebar labels: [${labels.join(', ')}]`);
  const missing = EXPECTED_SETTINGS.filter((label) => !labels.includes(label));
  const forbiddenHit = FORBIDDEN_SETTINGS.filter((label) => labels.includes(label));
  report(
    'expected settings menu items visible (scope-driven, stock community set)',
    missing.length === 0,
    missing.length === 0 ? `${EXPECTED_SETTINGS.length} entries` : `missing: ${missing.join(', ')}`,
  );
  report(
    'queue/AI/community-nodes items stay hidden (flags honestly off)',
    forbiddenHit.length === 0,
    forbiddenHit.length === 0 ? `absent: ${FORBIDDEN_SETTINGS.join(', ')}` : `unexpected: ${forbiddenHit.join(', ')}`,
  );
}

/* ------------------------------------------------- 5. route guards (scope + flag) */
{
  await page.goto(`${baseUrl}/settings/users`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await wait(2500);
  const usersPath = await page.evaluate(() => location.pathname);
  report(
    'scope-guarded settings route renders for the owner (/settings/users)',
    usersPath === '/settings/users',
    `pathname=${usersPath}`,
  );
  await screenshot('03-settings-users');

  await page.goto(`${baseUrl}/settings/community-nodes`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await wait(2500);
  const cnPath = await page.evaluate(() => location.pathname);
  report(
    'flag-gated route redirects home (community nodes disabled, same as stock)',
    cnPath.startsWith('/home'),
    `pathname=${cnPath}`,
  );
}

/* ------------------------------------------------ 6. API settings page + unsupported endpoint state */
{
  // P5.7 (#220) implemented /rest/api-keys: the n8n API settings page now has a real
  // backend. The 501 contract is still asserted below against a capability that
  // remains unsupported (workflow-history).
  restLog.length = 0;
  await page.goto(`${baseUrl}/settings/api`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await wait(3000);
  const apiPath = await page.evaluate(() => location.pathname);
  const apiKeyCalls = restLog.filter((entry) => entry.path.startsWith('/rest/api-keys'));
  report(
    'navigating n8n API settings page stays (owner scope)',
    apiPath === '/settings/api',
    `pathname=${apiPath}`,
  );
  report(
    'n8n API settings page is served by the real /rest/api-keys backend (P5.7) — every call 200',
    apiKeyCalls.some((entry) => entry.method === 'GET' && entry.path === '/rest/api-keys') && apiKeyCalls.every((entry) => entry.status === 200),
    apiKeyCalls.length > 0 ? apiKeyCalls.map((entry) => `${entry.method} ${entry.path} ${entry.status}`).join('; ') : 'page never called /rest/api-keys*',
  );
  await screenshot('04-settings-api');

  // Deterministic trigger: one registered capability, from the real session.
  const probe = await page.evaluate(async () => {
    const response = await fetch('/rest/workflow-history/workflow/probe/versions', { credentials: 'same-origin' });
    return { status: response.status, body: await response.json() };
  });
  report(
    'unsupported capability contract: 501 {code:unsupported, meta.feature}',
    probe.status === 501 && probe.body?.code === 'unsupported' && probe.body?.meta?.feature === 'workflow-history' && probe.body?.data === undefined,
    `status=${probe.status} code=${probe.body?.code} feature=${probe.body?.meta?.feature}`,
  );
}

/* ------------------------------------------------------------- fatal UI errors */
{
  report(
    'no fatal uncaught page errors while walking the UI',
    pageErrors.length === 0,
    pageErrors.length === 0 ? 'clean' : pageErrors.slice(0, 3).join(' | '),
  );
}

await browser.close();

const summary = {
  kind: 'p2-settings-visibility',
  url: baseUrl,
  at: new Date().toISOString(),
  expectations: steps,
  expectedSettingsEntries: EXPECTED_SETTINGS,
  forbiddenSettingsEntries: FORBIDDEN_SETTINGS,
  restCalls: restLog.slice(-80),
  pageErrors,
  failed,
};
writeFileSync(evidencePath, `${JSON.stringify(summary, null, 2)}\n`);
console.log(`\nevidence: ${evidencePath}`);
console.log(failed === 0 ? `P2 browser gate: PASS (${steps.length}/${steps.length})` : `P2 browser gate: FAIL (${failed} failed)`);
process.exit(failed === 0 ? 0 : 1);
