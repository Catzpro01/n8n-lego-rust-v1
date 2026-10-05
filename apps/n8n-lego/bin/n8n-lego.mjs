#!/usr/bin/env node
/**
 * `n8n-lego` CLI — the command people run after `npm install -g n8n-lego`.
 *
 *   n8n-lego start        start the app (default)
 *   n8n-lego doctor       check the install: node, UI bundle, node catalog, port
 *   n8n-lego catalog      (re)fetch the node catalog and icons
 *   n8n-lego credentials  offline credential-key operations (P5.8): status, verify,
 *                         rotate, recover, backup, restore-check, restore
 *   n8n-lego version      print versions
 *   n8n-lego --help
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { defaultCatalogDir, readEnv } from '../src/config.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(HERE, '..');

const command = process.argv[2] ?? 'start';

async function main() {
  switch (command) {
    case 'start':
      ensureCatalog();
      await import('../src/server.mjs').then((module) => module.startServer());
      return;
    case 'catalog':
      fetchCatalog({ force: process.argv.includes('--force') });
      return;
    case 'doctor':
      await doctor();
      return;
    case 'credentials':
      process.exitCode = await credentials();
      return;
    case 'version':
    case '--version':
    case '-v':
      printVersion();
      return;
    case 'help':
    case '--help':
    case '-h':
      usage();
      return;
    default:
      process.stderr.write(`unknown command: ${command}\n\n`);
      usage();
      process.exit(64);
  }
}

function printVersion() {
  const pkg = JSON.parse(readFileSync(join(APP_ROOT, 'package.json'), 'utf8'));
  process.stdout.write(
    [
      `n8n lego            ${pkg.version}`,
      `reference           n8n 2.9.4`,
      `editor UI           ${editorUiVersion() ?? 'not installed'}`,
      `node                ${process.versions.node}`,
    ].join('\n') + '\n',
  );
}

function editorUiVersion() {
  const file = join(APP_ROOT, 'node_modules', 'n8n-editor-ui', 'package.json');
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8')).version;
}

/** Where the catalog lives — same resolution the server uses. */
function catalogDir() {
  return defaultCatalogDir();
}

function catalogFile() {
  return join(catalogDir(), 'nodes.json');
}

function fetchCatalog({ force = false } = {}) {
  const scripts = [join(APP_ROOT, 'scripts', 'fetch-n8n-catalog.mjs'), join(APP_ROOT, 'scripts', 'fetch-n8n-roles.mjs')];
  const args = ['--dir', catalogDir()];
  if (force) args.push('--force');
  for (const script of scripts) {
    const result = spawnSync(process.execPath, [script, ...args], { stdio: 'inherit' });
    if (result.status !== 0) {
      process.stderr.write(`n8n-lego: ${script} failed (exit ${result.status ?? 'signal'})\n`);
      process.exit(result.status ?? 1);
    }
  }
}

/**
 * First boot of a fresh install: the node catalog is not shipped with the package
 * (8 MB of JSON, regenerated per release), so download it once. `--no-fetch`, or
 * `N8N_LEGO_SKIP_CATALOG_FETCH=1`, keeps the boot offline.
 */
function ensureCatalog() {
  if (existsSync(catalogFile())) return;
  if (process.argv.includes('--no-fetch') || readEnv(process.env, 'SKIP_CATALOG_FETCH') === '1') {
    process.stderr.write(
      `n8n-lego: node catalog missing (${catalogFile()}) — the editor will start without a palette.\n` +
        'n8n-lego: run `n8n-lego catalog` when you have network access.\n',
    );
    return;
  }
  process.stdout.write(`n8n-lego: node catalog missing — fetching it now (n8n-nodes-base + icons)\n`);
  fetchCatalog();
}

async function doctor() {
  const checks = [];
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  checks.push({
    name: 'node >= 22.18',
    ok: major > 22 || (major === 22 && minor >= 18),
    detail: process.versions.node,
  });

  const uiDist = join(APP_ROOT, 'node_modules', 'n8n-editor-ui', 'dist', 'index.html');
  checks.push({
    name: 'editor UI bundle',
    ok: existsSync(uiDist),
    detail: existsSync(uiDist) ? `n8n-editor-ui ${editorUiVersion()}` : 'run: npm install (in apps/n8n-lego)',
  });

  const catalogPath = catalogFile();
  let catalogCount = 0;
  if (existsSync(catalogPath)) {
    try {
      catalogCount = JSON.parse(readFileSync(catalogPath, 'utf8')).length;
    } catch {
      catalogCount = 0;
    }
  }
  checks.push({
    name: 'node catalog',
    ok: catalogCount > 0,
    detail: catalogCount > 0 ? `${catalogCount} node types (${catalogPath})` : 'run: n8n-lego catalog',
  });

  const iconDir = join(catalogDir(), '..', 'icons');
  const iconCount = existsSync(iconDir) ? countFiles(iconDir) : 0;
  checks.push({
    name: 'node icons',
    ok: iconCount > 0,
    detail: iconCount > 0 ? `${iconCount} files` : 'run: n8n-lego catalog',
  });

  const port = Number(process.env.N8N_LEGO_PORT ?? process.env.N8N_PORT ?? 5678);
  const free = await portFree(port);
  checks.push({ name: `port ${port} free`, ok: free, detail: free ? 'available' : 'in use — the app will fail to bind' });

  let failed = 0;
  for (const check of checks) {
    if (!check.ok) failed += 1;
    process.stdout.write(`${check.ok ? 'ok  ' : 'FAIL'}  ${check.name.padEnd(22)} ${check.detail}\n`);
  }
  process.stdout.write(failed === 0 ? '\nall checks passed\n' : `\n${failed} check(s) failed\n`);
  if (failed > 0) process.exit(1);
}

function countFiles(dir) {
  let count = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) count += countFiles(join(dir, entry.name));
    else count += 1;
  }
  return count;
}

function portFree(port) {
  return new Promise((resolvePort) => {
    const probe = createServer();
    probe.once('error', () => resolvePort(false));
    probe.once('listening', () => probe.close(() => resolvePort(true)));
    probe.listen(port, '127.0.0.1');
  });
}

/**
 * P5.8: composition only. The verbs live in src/auth/credential-operator.mjs;
 * this builds the config and the store it needs and supplies the "is the server
 * running?" probe: if the configured address:port cannot be bound, something is
 * listening there and every mutating verb refuses.
 */
async function credentials() {
  const [{ loadConfig }, { createStore }, { runCredentialCommand }] = await Promise.all([
    import('../src/config.mjs'),
    import('../src/store.mjs'),
    import('../src/auth/credential-operator.mjs'),
  ]);
  const config = loadConfig(process.env);
  const serverRunning = () =>
    new Promise((resolveProbe) => {
      const probe = createServer();
      probe.once('error', () => resolveProbe(true));
      probe.once('listening', () => probe.close(() => resolveProbe(false)));
      probe.listen(config.port, config.host);
    });
  return runCredentialCommand({
    command: process.argv[3],
    args: process.argv.slice(4),
    config,
    store: createStore(config),
    serverRunning,
    io: { out: (line) => process.stdout.write(`${line}\n`), err: (line) => process.stderr.write(`${line}\n`) },
  });
}

function usage() {
  process.stdout.write(
    [
      'n8n lego — workflow automation app (n8n-compatible editor, LEGO engine)',
      '',
      'usage: n8n-lego <command>',
      '',
      '  start      start the server (default)',
      '  doctor     check node, UI bundle, node catalog and port',
      '  catalog    (re)fetch the node catalog and icons',
      '  credentials <cmd>  offline credential-key operations (n8n-lego credentials help)',
      '  version    print versions',
      '  help       show this help',
      '',
      'environment (n8n-compatible; N8N_LEGO_* takes precedence):',
      '  N8N_LEGO_PORT / N8N_PORT             listen port (default 5678)',
      '  N8N_LEGO_HOST / N8N_HOST             listen address (default 0.0.0.0)',
      '  N8N_LEGO_USER_FOLDER / N8N_USER_FOLDER  data directory (default ~/.n8n-lego)',
      '  N8N_LEGO_OWNER_EMAIL / _PASSWORD     create the owner account on first boot',
      '  N8N_LEGO_PATH / N8N_PATH             serve under a sub-path',
      '',
    ].join('\n'),
  );
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
