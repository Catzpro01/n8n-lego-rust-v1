#!/usr/bin/env node
/**
 * Phase 1 — n8n editor UI compatibility inventory.
 *
 * Walks the **real n8n editor UI** page by page against a running n8n-lego
 * instance and records, for every page:
 *   - the REST calls the frontend actually made (method, path, status)
 *   - where the page ended up (redirects are meaningful: a route the UI cannot
 *     reach means a missing contract, not a missing menu)
 *   - the sidebar / settings menu items that rendered (`data-test-id`s), which is
 *     what "the menu is missing" really means
 *   - console errors, page errors and the first non-2xx REST responses
 *
 * The JSON it writes is the evidence behind
 * `docs/n8n-lego/FRONTEND_COMPATIBILITY.md`. It is a read-only audit: it creates
 * nothing except an owner account when the instance has none.
 *
 *   node tests/e2e/compat-inventory.mjs <baseUrl> [--out=/tmp/inventory.json]
 *
 * Environment:
 *   LEGO_SMOKE_EMAIL / LEGO_SMOKE_PASSWORD   owner credentials (same defaults as
 *                                            tests/e2e/lego-smoke.mjs)
 *   LEGO_INVENTORY_OUT                       output JSON (default /tmp/lego-compat-inventory.json)
 *   LEGO_INVENTORY_SHOTS                     screenshot dir (default /tmp/lego-compat-inventory)
 *   CHROME_PATH                              browser binary (CI: preinstalled Chrome)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import puppeteer from 'puppeteer';

const baseUrl = (process.argv[2] ?? process.env.LEGO_SMOKE_URL ?? 'http://localhost:5678').replace(/\/$/, '');
const outPath = process.env.LEGO_INVENTORY_OUT ?? '/tmp/lego-compat-inventory.json';
const shotDir = process.env.LEGO_INVENTORY_SHOTS ?? '/tmp/lego-compat-inventory';
const email = process.env.LEGO_SMOKE_EMAIL ?? 'smoke@n8nlego.local';
const password = process.env.LEGO_SMOKE_PASSWORD ?? 'Surabaya2026!';

/**
 * Every route the pinned editor-ui (`n8n-editor-ui@2.9.4`) declares, in the order
 * a user would meet them. Route names come from
 * `reference/n8n/packages/frontend/editor-ui/src/app/router.ts`.
 */
const PAGES = [
  { id: 'home', label: 'Overview', path: '/home' },
  { id: 'workflows', label: 'Workflows list', path: '/home/workflows' },
  { id: 'executions', label: 'Executions (personal)', path: '/home/executions' },
  { id: 'credentials', label: 'Credentials', path: '/home/credentials' },
  { id: 'variables', label: 'Variables', path: '/home/variables' },
  { id: 'projects', label: 'All projects', path: '/home/projects' },
  { id: 'shared', label: 'Shared with you', path: '/home/shared' },
  { id: 'templates', label: 'Templates', path: '/templates' },
  { id: 'resource-center', label: 'Resource center', path: '/resource-center' },
  { id: 'new-workflow', label: 'New workflow (canvas)', path: '/workflow/new' },
  { id: 'settings-personal', label: 'Settings → Personal', path: '/settings/personal' },
  { id: 'settings-users', label: 'Settings → Users', path: '/settings/users' },
  { id: 'settings-api', label: 'Settings → API', path: '/settings/api' },
  { id: 'settings-security', label: 'Settings → Security', path: '/settings/security' },
  { id: 'settings-community-nodes', label: 'Settings → Community nodes', path: '/settings/community-nodes' },
  { id: 'settings-sso', label: 'Settings → SSO', path: '/settings/sso' },
  { id: 'settings-log-streaming', label: 'Settings → Log streaming', path: '/settings/log-streaming' },
  { id: 'settings-external-secrets', label: 'Settings → External secrets', path: '/settings/external-secrets' },
  { id: 'settings-workers', label: 'Settings → Workers', path: '/settings/workers' },
  { id: 'settings-source-control', label: 'Settings → Source control', path: '/settings/environments' },
  { id: 'settings-usage', label: 'Settings → Usage and plan', path: '/settings/usage' },
];

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

mkdirSync(shotDir, { recursive: true });

const browser = await puppeteer.launch({
  headless: true,
  executablePath: process.env.CHROME_PATH || undefined,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  defaultViewport: { width: 1680, height: 1000 },
});

const page = await browser.newPage();
const consoleErrors = [];
const pageErrors = [];
/** Every REST response seen during the walk: path -> {methods, statuses} */
const restIndex = new Map();
let currentPage = null;

/**
 * Summarises a JSON payload: which top-level keys exist, what `data` looks like
 * and how many items a list carries. Enough to spot a wrong shape or an empty
 * stub without storing megabytes of evidence.
 */
function shapeOf(value, depth = 0) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `array(${value.length})${value.length && depth < 2 ? ` of ${shapeOf(value[0], depth + 1)}` : ''}`;
  if (typeof value !== 'object') return typeof value;
  const keys = Object.keys(value);
  if (depth >= 2) return `object{${keys.slice(0, 12).join(',')}}`;
  return `object{${keys.slice(0, 14).join(',')}}`;
}

page.on('response', (response) => {
  let url;
  try {
    url = new URL(response.url());
  } catch {
    return;
  }
  if (!url.pathname.startsWith('/rest/')) return;
  const key = url.pathname.replace(/[0-9a-f]{16}/g, ':id');
  const entry = restIndex.get(key) ?? { path: key, methods: {}, callers: new Set(), shapes: {} };
  const method = response.request().method();
  const status = response.status();
  entry.methods[method] = entry.methods[method] ?? {};
  entry.methods[method][status] = (entry.methods[method][status] ?? 0) + 1;
  if (currentPage) entry.callers.add(currentPage);
  restIndex.set(key, entry);
  if (currentPage) currentPage.rest.push(`${method} ${url.pathname} ${status}`);
  if (status === 200 && entry.shapes[`${method} 200`] === undefined) {
    response
      .text()
      .then((body) => {
        if (body.length > 400000) {
          entry.shapes[`${method} 200`] = `text(${body.length}B)`;
          return;
        }
        try {
          const json = JSON.parse(body);
          entry.shapes[`${method} 200`] = {
            top: shapeOf(json),
            data: json && typeof json === 'object' && 'data' in json ? shapeOf(json.data, 1) : undefined,
            sampleKeys: json?.data && typeof json.data === 'object' ? Object.keys(Array.isArray(json.data) ? (json.data[0] ?? {}) : json.data).slice(0, 24) : undefined,
          };
        } catch {
          entry.shapes[`${method} 200`] = `non-json(${body.slice(0, 60)})`;
        }
      })
      .catch(() => {});
  }
});
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(`${message.text().slice(0, 240)}`);
});
page.on('pageerror', (error) => pageErrors.push(String(error.message).slice(0, 240)));

/** Waits until the page stops issuing REST calls (or a deadline passes). */
async function settle({ quietMs = 1200, maxMs = 15000 } = {}) {
  const started = Date.now();
  let lastCount = currentPage ? currentPage.rest.length : 0;
  let lastChange = Date.now();
  while (Date.now() - started < maxMs) {
    await wait(250);
    const count = currentPage ? currentPage.rest.length : 0;
    if (count !== lastCount) {
      lastCount = count;
      lastChange = Date.now();
    } else if (Date.now() - lastChange >= quietMs) {
      return;
    }
  }
}

/**
 * Everything the page rendered that identifies a menu/route, plus a text sample —
 * this is how "the n8n menu is missing" is measured instead of guessed.
 */
function snapshotUi() {
  const testIds = [...document.querySelectorAll('[data-test-id]')].map((el) => el.dataset.testId);
  const unique = [...new Set(testIds)];
  const menu = (prefix) => unique.filter((id) => id.startsWith(prefix));
  const text = (document.body.innerText || '').replace(/\s+/g, ' ').trim();
  // The settings sidebar renders N8nMenuItem without data-test-ids, so measure it by
  // label (the container is anchored by `settings-back`, SettingsSidebar.vue:23).
  const settingsRoot = document.querySelector('[data-test-id="settings-back"]')?.parentElement;
  const settingsLabels = settingsRoot
    ? (settingsRoot.innerText || '').split('\n').map((line) => line.trim()).filter(Boolean)
    : [];
  const mainSidebarRoot = document.querySelector('[data-test-id="project-home-menu-item"]')?.closest('aside, nav, [class*="sidebar"]');
  const mainLabels = mainSidebarRoot
    ? (mainSidebarRoot.innerText || '').split('\n').map((line) => line.trim()).filter(Boolean)
    : [];
  return {
    url: location.pathname + location.search,
    title: document.title,
    settingsSidebarLabels: settingsLabels.slice(0, 20),
    mainSidebarLabels: mainLabels.slice(0, 20),
    // The main sidebar's entries are buttons with aria-labels (Overview, Help, Settings …);
    // this is the reliable measurement of "which main menu entries exist".
    ariaLabels: [...document.querySelectorAll('[aria-label]')]
      .map((el) => el.getAttribute('aria-label'))
      .filter(Boolean)
      .slice(0, 20),
    tabs: [...document.querySelectorAll('[data-test-id^="tab-"], [role="tab"]')].map((el) => (el.textContent || '').trim()).filter(Boolean).slice(0, 12),
    mainSidebar: menu('main-sidebar-'),
    settingsSidebar: menu('settings-sidebar-'),
    projectNav: menu('project-'),
    testIds: unique.slice(0, 60),
    testIdCount: unique.length,
    bodyText: text.slice(0, 600),
    errorBanner: [...document.querySelectorAll('[data-test-id*="error"], [role="alert"]')].map((el) => (el.textContent || '').trim().slice(0, 160)).filter(Boolean).slice(0, 5),
  };
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
        const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      };
      set('input[type="email"], #email', mail);
      set('#firstName, input[name="firstName"]', 'Inventory');
      set('#lastName, input[name="lastName"]', 'Bot');
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

console.log(`n8n-lego compatibility inventory: ${baseUrl} (owner ${email})`);
const signedInAs = await signInOrSetUp();
console.log(`session: ${signedInAs}`);

// The editor reads /rest/settings on boot: keep the exact payload in the evidence.
const settingsPayload = await page.evaluate(async () => {
  try {
    const response = await fetch('/rest/settings', { credentials: 'include' });
    return { status: response.status, body: await response.json() };
  } catch (error) {
    return { status: 0, error: String(error) };
  }
});

const mePayload = await page.evaluate(async () => {
  try {
    const response = await fetch('/rest/me', { credentials: 'include' });
    return { status: response.status, body: await response.json() };
  } catch (error) {
    return { status: 0, error: String(error) };
  }
});

const results = [];
for (const spec of PAGES) {
  currentPage = { page: spec.id, label: spec.label, path: spec.path, rest: [], ui: null, navigatedTo: null, error: null };
  try {
    await page.goto(`${baseUrl}${spec.path}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await settle();
    currentPage.navigatedTo = page.url().replace(baseUrl, '');
    currentPage.ui = await page.evaluate(snapshotUi);
  } catch (error) {
    currentPage.error = String(error.message).split('\n')[0];
  }
  await page.screenshot({ path: `${shotDir}/${spec.id}.png` }).catch(() => {});
  results.push(currentPage);
  const statuses = [...new Set(currentPage.rest.map((r) => r.split(' ').pop()))].join(',');
  console.log(
    `  ${spec.label.padEnd(28)} -> ${String(currentPage.navigatedTo).padEnd(32)} rest=${String(currentPage.rest.length).padStart(3)} [${statuses}] sidebar=${currentPage.ui?.mainSidebar.length ?? 0} settings=${currentPage.ui?.settingsSidebar.length ?? 0}`,
  );
  currentPage = null;
}

// The workflow editor deserves its own step: open the canvas and record the boot
// sequence of the editor itself (node types, settings, push, collaboration).
const editorTrace = { rest: [], error: null, ui: null };
currentPage = { page: 'editor', label: 'Workflow editor', path: '/workflow/new', rest: [] };
try {
  await page.goto(`${baseUrl}/workflow/new`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await settle({ quietMs: 2000, maxMs: 25000 });
  editorTrace.rest = currentPage.rest;
  editorTrace.ui = await page.evaluate(() => ({
    url: location.pathname,
    addButtonVisible: !!document.querySelector('[data-test-id="canvas-add-button"]'),
    nodeCount: document.querySelectorAll('.vue-flow__node').length,
    nodeCreatorOpen: !!document.querySelector('[data-test-id="node-creator-search-bar"]'),
    testIds: [...new Set([...document.querySelectorAll('[data-test-id]')].map((el) => el.dataset.testId))].slice(0, 40),
  }));
  // Open the node creator: the palette is where the node registry contract shows up.
  await page.evaluate(() => document.querySelector('[data-test-id="canvas-add-button"] button')?.click());
  await wait(2500);
  editorTrace.palette = await page.evaluate(() => ({
    open: !!document.querySelector('[data-test-id="node-creator-search-bar"]'),
    itemCount: document.querySelectorAll('[data-test-id^="node-creator-item"]').length,
  }));
  await page.screenshot({ path: `${shotDir}/editor-palette.png` }).catch(() => {});
} catch (error) {
  editorTrace.error = String(error.message).split('\n')[0];
}
currentPage = null;

/**
 * `--deep` clicks the controls the page walk alone never reaches (workflow history,
 * the workflow menu, a project card, workflow executions) so that the endpoints
 * behind them — implemented or silently stubbed — show up in the evidence.
 */
if (process.argv.includes('--deep')) {
  const deepTrace = [];
  const record = async (label, fn) => {
    const before = restIndex.size;
    currentPage = { page: `deep:${label}`, label, path: page.url().replace(baseUrl, ''), rest: [] };
    try {
      await fn();
      await settle({ quietMs: 1200, maxMs: 12000 });
      deepTrace.push({ step: label, rest: [...new Set(currentPage.rest)], error: null });
    } catch (error) {
      deepTrace.push({ step: label, rest: [...new Set(currentPage.rest)], error: String(error.message).split('\n')[0] });
    }
    currentPage = null;
    void before;
  };

  await page.goto(`${baseUrl}/home/workflows`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await settle();

  await record('open the first workflow card', async () => {
    await page.evaluate(() => {
      const card = document.querySelector('[data-test-id="workflow-card"] a, [data-test-id="workflow-card"], [data-test-id="resources-list-item"] a');
      (card ?? document.querySelector('[data-test-id^="workflow"]'))?.click();
    });
  });

  await record('workflow history button', async () => {
    await page.goto(`${baseUrl}/workflow/new`, { waitUntil: 'domcontentloaded' });
    await settle({ quietMs: 2000, maxMs: 25000 });
    await page.evaluate(() => document.querySelector('[data-test-id="workflow-history-button"]')?.click());
  });

  await record('workflow menu (duplicate/delete)', async () => {
    await page.evaluate(() => document.querySelector('[data-test-id="workflow-menu"]')?.click());
    await wait(1500);
  });

  await record('canvas universal add (node creator)', async () => {
    await page.keyboard.press('Tab');
    await wait(2500);
  });

  await record('executions tab of the workflow', async () => {
    await page.evaluate(() => document.querySelector('[data-test-id="radio-button-executions"]')?.click());
    await wait(2500);
  });

  await record('project card on /home/projects', async () => {
    await page.goto(`${baseUrl}/home/projects`, { waitUntil: 'domcontentloaded' });
    await settle();
    await page.evaluate(() => {
      const card = document.querySelector('[data-test-id="project-card"], [data-test-id="project-menu-item"], a[href*="/projects/"]');
      card?.click();
    });
    await settle();
  });

  await record('credentials page: open the add-credential modal', async () => {
    await page.goto(`${baseUrl}/home/credentials`, { waitUntil: 'domcontentloaded' });
    await settle();
    await page.evaluate(() => {
      const btn = document.querySelector('[data-test-id="add-resource-credential"], [data-test-id="credential-list-add-button"]');
      btn?.click();
    });
    await settle();
  });

  await record('personal settings page controls', async () => {
    await page.goto(`${baseUrl}/settings/personal`, { waitUntil: 'domcontentloaded' });
    await settle();
  });

  await page.screenshot({ path: `${shotDir}/deep-last.png` }).catch(() => {});

  for (const step of deepTrace) {
    console.log(`  deep: ${step.step.padEnd(42)} rest=${step.rest.length}${step.error ? ` error=${step.error}` : ''}`);
  }

  const summaryWithDeep = true;
  void summaryWithDeep;
  globalThis.__legoDeepTrace = deepTrace;
}

const deepTrace = globalThis.__legoDeepTrace ?? null;

const summary = {
  baseUrl,
  signedInAs,
  capturedAt: new Date().toISOString(),
  settings: {
    status: settingsPayload.status,
    body: settingsPayload.body,
  },
  me: { status: mePayload.status, body: mePayload.body },
  pages: results.map((r) => ({
    page: r.page,
    label: r.label,
    requestedPath: r.path,
    navigatedTo: r.navigatedTo,
    error: r.error,
    rest: [...new Set(r.rest)],
    ui: r.ui,
  })),
  editor: editorTrace,
  deep: deepTrace,
  restIndex: [...restIndex.values()].map((entry) => ({
    path: entry.path,
    methods: entry.methods,
    callers: [...(entry.callers ?? [])],
    shapes: entry.shapes,
  })),
  consoleErrors: [...new Set(consoleErrors)],
  pageErrors: [...new Set(pageErrors)],
};

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(summary, null, 2)}\n`);

console.log(`\nREST endpoints seen: ${summary.restIndex.length}`);
console.log(`console errors: ${summary.consoleErrors.length}, page errors: ${summary.pageErrors.length}`);
console.log(`evidence: ${outPath}`);
console.log(`screenshots: ${shotDir}`);

await browser.close();
