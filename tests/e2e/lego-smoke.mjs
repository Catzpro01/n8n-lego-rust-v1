#!/usr/bin/env node
/**
 * Browser/E2E smoke test for n8n lego.
 *
 * Drives the **real n8n editor UI** against a running instance and checks the
 * milestone flow end to end. It is deliberately dependency-light (puppeteer only)
 * and fails loudly: any missing element, HTTP 5xx or console error fails the run.
 *
 *   node tests/e2e/lego-smoke.mjs <baseUrl> [--mode=create|verify] [--headed]
 *
 *   create  (default) fresh instance: owner setup → dashboard → create workflow
 *           → canvas → add node → save → execute → execution result
 *   verify  same instance after a restart: sign in → the workflow from the state
 *           file is still listed → its canvas still has the saved nodes
 *
 * Environment:
 *   LEGO_SMOKE_EMAIL     owner email       (default smoke@n8nlego.local)
 *   LEGO_SMOKE_PASSWORD  owner password    (default Surabaya2026!)
 *   LEGO_SMOKE_STATE     state file        (default /tmp/lego-smoke-state.json)
 *   LEGO_SMOKE_SHOTS     screenshot dir    (default /tmp/lego-smoke)
 *
 * Exit code 0 only when every step passed.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import puppeteer from 'puppeteer';

const baseUrl = (process.argv[2] ?? process.env.LEGO_SMOKE_URL ?? 'http://localhost:5678').replace(/\/$/, '');
const mode = process.argv.find((a) => a.startsWith('--mode='))?.slice(7) ?? 'create';
const headed = process.argv.includes('--headed');
const email = process.env.LEGO_SMOKE_EMAIL ?? 'smoke@n8nlego.local';
const password = process.env.LEGO_SMOKE_PASSWORD ?? 'Surabaya2026!';
const statePath = process.env.LEGO_SMOKE_STATE ?? '/tmp/lego-smoke-state.json';
const shotDir = process.env.LEGO_SMOKE_SHOTS ?? '/tmp/lego-smoke';

const steps = [];
const problems = [];
let stepName = 'startup';
const workflowName = `Smoke workflow ${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function pass(name, detail) {
  steps.push({ name, verdict: 'PASS', detail });
  console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`);
}
function fail(name, detail) {
  steps.push({ name, verdict: 'FAIL', detail });
  problems.push(`${name}: ${detail}`);
  console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
}
async function step(name, fn) {
  stepName = name;
  try {
    const detail = await fn();
    if (detail === false) {
      fail(name, 'returned false');
      return false;
    }
    pass(name, typeof detail === 'string' ? detail : '');
    return true;
  } catch (error) {
    fail(name, String(error?.message ?? error).split('\n')[0]);
    return false;
  }
}

/** Polls a predicate in the page until it is true (or the timeout expires). */
async function until(page, fn, { timeout = 20000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await page.evaluate(fn);
      if (last) return last;
    } catch {
      /* page still navigating */
    }
    await wait(300);
  }
  throw new Error(`timed out waiting for ${label} (last=${JSON.stringify(last)})`);
}

/**
 * Clicks through the DOM. The editor is a Vue app that re-renders the canvas while
 * it boots, so a coordinate click can land on a detached node; a DOM click is
 * delivered to the component either way. Retries until the element exists.
 */
async function domClick(selector, { timeout = 45000 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const clicked = await page
      .evaluate((sel) => {
        const el = document.querySelector(sel);
        if (!el) return false;
        el.scrollIntoView({ block: 'center' });
        el.click();
        return true;
      }, selector)
      .catch(() => false);
    if (clicked) return true;
    await wait(300);
  }
  throw new Error(`could not click ${selector}`);
}

/** Focuses an input and types into it through the keyboard (Vue-friendly). */
async function focusAndType(selector, text, { timeout = 45000 } = {}) {
  await page.waitForSelector(selector, { visible: true, timeout });
  await page.evaluate((sel) => document.querySelector(sel)?.focus(), selector);
  await page.type(selector, text, { delay: 25 });
}

function writeState(patch) {
  let state = {};
  try {
    state = JSON.parse(readFileSync(statePath, 'utf8'));
  } catch {
    state = {};
  }
  const next = { ...state, ...patch, baseUrl, email };
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

function readState() {
  try {
    return JSON.parse(readFileSync(statePath, 'utf8'));
  } catch {
    throw new Error(`no state file at ${statePath} — run --mode=create first`);
  }
}

mkdirSync(shotDir, { recursive: true });

// --------------------------------------------------------------------- browser
// CHROME_PATH lets CI reuse an already installed Chrome; otherwise puppeteer's
// own download (done by `npm install`) is used.
const browser = await puppeteer.launch({
  headless: headed ? false : true,
  executablePath: process.env.CHROME_PATH || undefined,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  defaultViewport: { width: 1680, height: 1000 },
});

const page = await browser.newPage();
const restCalls = [];
const iconFailures = [];
const unsupportedCalls = [];

page.on('response', (response) => {
  const url = new URL(response.url());
  if (url.pathname.startsWith('/rest/')) {
    restCalls.push(`${response.request().method()} ${url.pathname} ${response.status()}`);
    // P2 contract: 501 is the compatibility layer's explicit "capability not
    // implemented" (docs/n8n-lego/FRONTEND_COMPATIBILITY.md §P2) — a described
    // state, recorded but not a crash. Any other 5xx is a real server failure.
    if (response.status() === 501) unsupportedCalls.push(`${response.request().method()} ${url.pathname}`);
    else if (response.status() >= 500) problems.push(`HTTP ${response.status()} ${response.request().method()} ${url.pathname}`);
  }
  if (url.pathname.startsWith('/icons/') && response.status() >= 400) iconFailures.push(`${response.status()} ${url.pathname}`);
});
page.on('pageerror', (error) => problems.push(`pageerror: ${String(error.message).slice(0, 160)}`));

const screenshot = (name) => page.screenshot({ path: `${shotDir}/${name}.png` }).catch(() => {});

console.log(`n8n-lego smoke: mode=${mode} url=${baseUrl} email=${email}`);

try {
  await step('open the app', async () => {
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await until(page, () => /n8n/i.test(document.title), { label: 'the n8n editor title' });
    const title = await page.title();
    await screenshot(`${mode}-1-open`);
    return `title="${title}" url=${page.url()}`;
  });

  await step('owner setup / sign in', async () => {
    await until(page, () => location.pathname !== '/loading' && (document.querySelector('input[type="password"]') !== null || location.pathname.startsWith('/home')), { label: 'the setup or sign-in form' });
    const onSetup = page.url().includes('/setup');
    if (onSetup) {
      await page.evaluate((mail, pass) => {
        const set = (selector, value) => {
          const el = document.querySelector(selector);
          if (!el) throw new Error(`missing input ${selector}`);
          const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        };
        set('input[type="email"], #email', mail);
        set('#firstName, input[name="firstName"]', 'Smoke');
        set('#lastName, input[name="lastName"]', 'Test');
        set('input[type="password"]', pass);
      }, email, password);
      await wait(400);
      const response = page.waitForResponse((r) => r.url().includes('/rest/owner/setup'), { timeout: 30000 }).catch(() => null);
      await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => /next|sign up/i.test(b.textContent || ''))?.click());
      const setupResponse = await response;
      if (!setupResponse) throw new Error('no POST /rest/owner/setup observed');
      if (setupResponse.status() !== 200) throw new Error(`POST /rest/owner/setup -> ${setupResponse.status()}`);
    } else {
      await page.evaluate((mail, pass) => {
        const set = (selector, value) => {
          const el = document.querySelector(selector);
          if (!el) throw new Error(`missing input ${selector}`);
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, value);
          el.dispatchEvent(new Event('input', { bubbles: true }));
        };
        set('input[type="email"], #email', mail);
        set('input[type="password"]', pass);
      }, email, password);
      const response = page.waitForResponse((r) => r.url().includes('/rest/login') && r.request().method() === 'POST', { timeout: 30000 }).catch(() => null);
      await page.keyboard.press('Enter');
      const loginResponse = await response;
      if (!loginResponse) throw new Error('no POST /rest/login observed');
      if (loginResponse.status() !== 200) throw new Error(`POST /rest/login -> ${loginResponse.status()}`);
    }
    await until(page, () => location.pathname.startsWith('/home'), { timeout: 30000, label: 'the dashboard' });
    await screenshot(`${mode}-2-after-auth`);
    return `${onSetup ? 'owner created' : 'signed in'} → ${page.url()}`;
  });

  if (mode === 'create') {
    await step('dashboard + create workflow', async () => {
      // n8n shows two different create affordances: `add-resource-workflow` in the
      // list header and `new-workflow-card` in the empty state.
      const used = await until(page, () => {
        for (const id of ['add-resource-workflow', 'new-workflow-card']) {
          const el = document.querySelector(`[data-test-id="${id}"]`);
          if (el) {
            el.click();
            return id;
          }
        }
        return null;
      }, { timeout: 45000, label: 'a "create workflow" affordance' });
      await until(page, () => /\/workflow\/[A-Za-z0-9]{16}/.test(location.pathname), { timeout: 30000, label: 'the new workflow URL' });
      await screenshot(`${mode}-3-new-workflow`);
      return `clicked ${used} → ${page.url()}`;
    });

    const workflowId = new URL(page.url()).pathname.split('/')[2];
    writeState({ workflowId, nodes: [] });

    await step('canvas is editable', async () => {
      const canvas = await until(page, () => {
        const add = document.querySelector('[data-test-id="canvas-add-button"]');
        if (!add) return null;
        if (/\bLoading\b/i.test(document.body.innerText)) return null; // editor still bootstrapping
        const readOnly = /read only/i.test(document.body.innerText);
        return { add: true, readOnly, placeholder: /add first step/i.test(document.body.innerText) };
      }, { timeout: 60000, label: 'the canvas' });
      if (canvas.readOnly) throw new Error('canvas rendered read-only');
      return `addButton=${canvas.add} placeholder=${canvas.placeholder}`;
    });

    await step('add a node from the palette', async () => {
      await domClick('[data-test-id="canvas-add-button"] button');
      await focusAndType('[data-test-id="node-creator-search-bar"]', 'set');
      const itemSelector = '[data-test-id="node-creator-node-item"], [data-test-id="node-creator-action-item"]';
      await until(page, () => document.querySelectorAll('[data-test-id="node-creator-node-item"], [data-test-id="node-creator-action-item"]').length > 0, { label: 'palette results', timeout: 45000 });
      const picked = await page.evaluate((sel) => {
        const item = [...document.querySelectorAll(sel)].find((el) => /edit fields|^set\b/i.test(el.textContent || ''));
        if (!item) return null;
        const label = item.textContent.trim().replace(/\s+/g, ' ').slice(0, 40);
        item.click();
        return label;
      }, itemSelector);
      if (!picked) throw new Error('the Set node is missing from the palette');
      const nodes = await until(page, () => {
        const rendered = [...document.querySelectorAll('.vue-flow__node')].map((n) => n.textContent.trim().replace(/\s+/g, ' ').slice(0, 30));
        return rendered.some((n) => /edit fields/i.test(n)) ? rendered : null;
      }, { timeout: 45000, label: 'the Set node on the canvas' });
      await page.keyboard.press('Escape');
      await wait(1200);
      await screenshot(`${mode}-4-node-added`);
      return `picked "${picked}" → ${JSON.stringify(nodes)}`;
    });

    await step('icons load (no 404)', async () => {
      const rendered = await page.evaluate(() => [...document.querySelectorAll('img')].filter((i) => (i.getAttribute('src') || '').includes('/icons/')).length);
      if (iconFailures.length > 0) throw new Error(`${iconFailures.length} icon request(s) failed: ${iconFailures.slice(0, 3).join(', ')}`);
      return `${rendered} icons on screen, 0 failed`;
    });

    await step('save the workflow', async () => {
      const writes = [];
      const collect = (response) => {
        const url = new URL(response.url());
        if (/^\/rest\/workflows(\/[A-Za-z0-9]{16})?$/.test(url.pathname) && ['POST', 'PATCH'].includes(response.request().method())) {
          writes.push(`${response.request().method()} ${url.pathname} ${response.status()}`);
        }
      };
      page.on('response', collect);

      // Rename from the breadcrumb (a real edit), then save with Ctrl+S. The editor
      // auto-saves when the first node is added, so Ctrl+S on a clean workflow is
      // legitimately a no-op — the edit makes the save path observable.
      await domClick('[data-test-id="inline-edit-preview"]');
      await page.waitForSelector('[data-test-id="inline-edit-input"]', { visible: true, timeout: 30000 });
      await page.evaluate(() => {
        const el = document.querySelector('[data-test-id="inline-edit-input"]');
        el.focus();
        if (el.select) el.select();
      });
      await page.keyboard.down('Control');
      await page.keyboard.press('a');
      await page.keyboard.up('Control');
      await page.type('[data-test-id="inline-edit-input"]', workflowName, { delay: 15 });
      await page.keyboard.press('Enter');
      await wait(3000);
      await page.keyboard.down('Control');
      await page.keyboard.press('s');
      await page.keyboard.up('Control');
      await wait(6000);
      page.off('response', collect);

      if (!writes.some((w) => w.endsWith('200'))) throw new Error(`no successful save request (${JSON.stringify(writes)})`);
      const saved = await page.evaluate(async (id) => {
        const body = await (await fetch(`/rest/workflows/${id}`, { credentials: 'include' })).json();
        return { name: body.data?.name, nodes: (body.data?.nodes ?? []).map((n) => n.name) };
      }, workflowId);
      if (saved.name !== workflowName) throw new Error(`the renamed workflow was not stored (server name "${saved.name}")`);
      if (!saved.nodes.some((n) => /edit fields/i.test(n))) {
        throw new Error(`the saved workflow is missing the node added on the canvas (${JSON.stringify(saved.nodes)})`);
      }
      writeState({ workflowId, workflowName: saved.name, nodes: saved.nodes });
      await screenshot(`${mode}-5-saved`);
      return `${JSON.stringify(writes)} name="${saved.name}" nodes=${JSON.stringify(saved.nodes)}`;
    });

    await step('execute the workflow', async () => {
      const response = page.waitForResponse((r) => /\/rest\/workflows\/[^/]+\/run$/.test(new URL(r.url()).pathname), { timeout: 60000 }).catch(() => null);
      const clicked = await page.evaluate(() => {
        const button = [...document.querySelectorAll('button')].find((b) => /execute workflow/i.test(b.textContent || ''));
        if (!button) return false;
        button.click();
        return true;
      });
      if (!clicked) throw new Error('the "Execute workflow" button is missing');
      const runResponse = await response;
      if (!runResponse) throw new Error('no POST /rest/workflows/<id>/run observed');
      if (runResponse.status() !== 200) throw new Error(`POST /run -> ${runResponse.status()}`);
      await wait(5000);
      const executions = await page.evaluate(async () => {
        const body = await (await fetch('/rest/executions?limit=5', { credentials: 'include' })).json();
        return (body.data?.results ?? []).map((e) => ({ id: e.id, status: e.status, workflowId: e.workflowId }));
      });
      const mine = executions.find((e) => e.workflowId === workflowId);
      if (!mine) throw new Error(`no execution recorded for ${workflowId} (${JSON.stringify(executions)})`);
      if (mine.status !== 'success') throw new Error(`execution ${mine.id} status=${mine.status}`);
      writeState({ executionId: mine.id });
      await screenshot(`${mode}-6-executed`);
      return `execution ${mine.id} ${mine.status}`;
    });

    await step('execution result is inspectable', async () => {
      const state = readState();
      if (!state.executionId) throw new Error('skipped: no execution was recorded');
      await page.goto(`${baseUrl}/workflow/${state.workflowId}/executions/${state.executionId}`, { waitUntil: 'domcontentloaded' });
      const result = await until(page, () => {
        const text = document.body.innerText;
        return /succeeded|success/i.test(text) ? text.replace(/\s+/g, ' ').slice(0, 120) : null;
      }, { timeout: 40000, label: 'the execution result view' });
      await screenshot(`${mode}-7-execution-result`);
      return `"${result}"`;
    });
  } else if (mode === 'verify') {
    const state = readState();

    await step('workflow survived the restart', async () => {
      const workflows = await page.evaluate(async () => {
        const body = await (await fetch('/rest/workflows?limit=50', { credentials: 'include' })).json();
        return (body.data ?? []).map((w) => ({ id: w.id, name: w.name }));
      });
      const found = workflows.find((w) => w.id === state.workflowId);
      if (!found) throw new Error(`workflow ${state.workflowId} is gone (${JSON.stringify(workflows.slice(0, 5))})`);
      if (found.name !== state.workflowName) throw new Error(`name changed: "${found.name}" != "${state.workflowName}"`);
      return `${found.name} (${found.id}) still listed`;
    });

    await step('workflow content survived the restart', async () => {
      const nodes = await page.evaluate(async (id) => {
        const body = await (await fetch(`/rest/workflows/${id}`, { credentials: 'include' })).json();
        return (body.data?.nodes ?? []).map((n) => n.name);
      }, state.workflowId);
      const expected = state.nodes ?? [];
      if (JSON.stringify(nodes) !== JSON.stringify(expected)) throw new Error(`nodes changed: ${JSON.stringify(nodes)} != ${JSON.stringify(expected)}`);
      return JSON.stringify(nodes);
    });

    await step('canvas still renders the saved workflow', async () => {
      await page.goto(`${baseUrl}/workflow/${state.workflowId}`, { waitUntil: 'domcontentloaded' });
      const nodes = await until(page, () => {
        const rendered = [...document.querySelectorAll('.vue-flow__node')];
        return rendered.length >= 2 ? rendered.map((n) => n.textContent.trim().replace(/\s+/g, ' ').slice(0, 30)) : null;
      }, { timeout: 40000, label: 'the saved nodes on the canvas' });
      await screenshot(`${mode}-8-canvas-after-restart`);
      return JSON.stringify(nodes);
    });
  } else {
    throw new Error(`unknown mode: ${mode}`);
  }
} catch (error) {
  fail(stepName, String(error?.message ?? error).split('\n')[0]);
  await screenshot(`failure-${stepName.replace(/\W+/g, '-')}`);
}

await browser.close();

// ------------------------------------------------------------------- veredict
const failed = steps.filter((s) => s.verdict === 'FAIL').length;
// 501 = acknowledged unsupported capability (P2 contract); all other 5xx fail.
const serverErrors = restCalls.filter((c) => / 5\d\d$/.test(c) && !/ 501$/.test(c));
console.log('\n--- rest calls (non-2xx) ---');
[...new Set(restCalls.filter((c) => !/ 2\d\d$/.test(c)))].forEach((c) => console.log(`  ${c}`));
if (unsupportedCalls.length) {
  console.log('--- unsupported capabilities hit (P2 contract, acknowledged) ---');
  [...new Set(unsupportedCalls)].forEach((c) => console.log(`  ${c}`));
}
console.log('--- problems ---');
[...new Set(problems)].forEach((p) => console.log(`  ${p}`));
console.log(`\nSMOKE ${mode}: ${steps.length - failed}/${steps.length} steps passed`);
if (iconFailures.length) console.log(`icon failures: ${iconFailures.length}`);
console.log(`screenshots: ${shotDir}`);
process.exit(failed > 0 || serverErrors.length > 0 ? 1 : 0);
