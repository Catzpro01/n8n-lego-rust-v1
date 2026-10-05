#!/usr/bin/env node
/**
 * Fetches the node catalog from the pinned n8n release.
 *
 * The editor needs two static JSON files to render its palette and parameter
 * panels. n8n publishes them inside `n8n-nodes-base`, but installing that package
 * pulls ~70 MB plus a heavy dependency tree (mssql, jsdom, gm, redis, …) that a
 * workflow runtime never executes. The tarball is only ~8.7 MB and the two files
 * we want are plain JSON, so this script downloads the tarball, extracts exactly
 * those two entries, and throws the rest away.
 *
 *   node scripts/fetch-n8n-catalog.mjs [--version 2.9.1] [--dir <path>] [--force]
 *
 * The node icons live in the same tarball. `nodes.json` points at them with a
 * relative `iconUrl` (`icons/n8n-nodes-base/dist/nodes/Code/code.svg`), which the
 * editor requests from the server root — so they are extracted next to the
 * catalog and served by `/icons/*`.
 *
 * Output (gitignored, fetched per install):
 *   <dir>/nodes.json                  INodeTypeDescription[]
 *   <dir>/credentials.json            ICredentialType[]
 *   <dir>/../icons/n8n-nodes-base/**  node icons (svg/png)
 */
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { gunzipSync } from 'node:zlib';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defaultCatalogDir, defaultDataDir, readEnv } from '../src/config.mjs';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_VERSION = '2.9.1';
const WANTED = {
  'package/dist/types/nodes.json': 'nodes.json',
  'package/dist/types/credentials.json': 'credentials.json',
};

/** Icon extensions the editor renders (`getNodeIconSource`). */
const ICON_EXTENSIONS = ['.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp'];
const isIcon = (name) =>
  name.startsWith('package/dist/nodes/') && ICON_EXTENSIONS.some((extension) => name.endsWith(extension));

function parseArgs(argv) {
  // Same resolution the app itself uses: `<user folder>/catalog`, so a globally
  // installed package writes to `~/.n8n-lego` and never into the package.
  const args = { version: DEFAULT_VERSION, dir: defaultCatalogDir(), force: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--version') args.version = argv[++i];
    else if (arg === '--dir') args.dir = resolve(argv[++i]);
    else if (arg === '--data-dir') args.dataDir = resolve(argv[++i]);
    else if (arg === '--force') args.force = true;
    else if (arg === '-h' || arg === '--help') {
      process.stdout.write(
        'usage: node scripts/fetch-n8n-catalog.mjs [--version <n8n-nodes-base version>] [--dir <output dir>] [--force]\n',
      );
      process.exit(0);
    }
  }
  return args;
}

/** Minimal tar reader: enough for the ustar entries npm publishes. */
function readTarEntries(buffer) {
  const entries = new Map();
  const icons = new Map();
  let offset = 0;
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    if (name === '') break;
    const sizeField = header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim();
    const size = Number.parseInt(sizeField, 8) || 0;
    const dataStart = offset + 512;
    if (WANTED[name]) entries.set(name, buffer.subarray(dataStart, dataStart + size));
    else if (isIcon(name)) icons.set(name.slice('package/'.length), buffer.subarray(dataStart, dataStart + size));
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return { entries, icons };
}

async function download(url, to) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`download failed: ${response.status} ${response.statusText} (${url})`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(to));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const targetDir = args.dir;
  const nodesFile = join(targetDir, 'nodes.json');

  if (!args.force && existsSync(nodesFile)) {
    const stat = JSON.parse(readFileSync(nodesFile, 'utf8'));
    process.stdout.write(`catalog already present: ${nodesFile} (${stat.length} node types) — use --force to refetch\n`);
    return;
  }

  const tarballUrl = `https://registry.npmjs.org/n8n-nodes-base/-/n8n-nodes-base-${args.version}.tgz`;
  const dataDir = args.dataDir ?? defaultDataDir(readEnv(process.env, 'USER_FOLDER') === undefined ? {} : process.env);
  const tmpDir = join(dataDir, '.cache');
  mkdirSync(tmpDir, { recursive: true });
  mkdirSync(targetDir, { recursive: true });
  const tmpFile = join(tmpDir, `n8n-nodes-base-${args.version}.tgz`);

  process.stdout.write(`fetching n8n-nodes-base@${args.version} — ${tarballUrl}\n`);
  await download(tarballUrl, tmpFile);

  const { entries, icons } = readTarEntries(gunzipSync(readFileSync(tmpFile)));
  const missing = Object.keys(WANTED).filter((name) => !entries.has(name));
  if (missing.length > 0) {
    throw new Error(`tarball does not contain ${missing.join(', ')} — is ${args.version} the right version?`);
  }

  const nodes = JSON.parse(entries.get('package/dist/types/nodes.json').toString('utf8'));
  const credentials = JSON.parse(entries.get('package/dist/types/credentials.json').toString('utf8'));

  // n8n's LoadNodesAndCredentials.postProcessLoaders() prefixes node type names
  // with the package name before serving them to the editor
  // (`name: '${packageName}.${name}'`), and rewrites a credential's
  // `supportedNodes` the same way. Serving the raw file instead would make every
  // node in an existing workflow resolve to "unknown node type".
  const PACKAGE_NAME = 'n8n-nodes-base';
  const prefixedNodes = nodes.map((node) => ({ ...node, name: `${PACKAGE_NAME}.${node.name}` }));
  const prefixedCredentials = credentials.map((credential) => ({
    ...credential,
    ...(Array.isArray(credential.supportedNodes)
      ? { supportedNodes: credential.supportedNodes.map((nodeName) => `${PACKAGE_NAME}.${nodeName}`) }
      : {}),
  }));

  for (const [fileName, data] of [
    ['nodes.json', prefixedNodes],
    ['credentials.json', prefixedCredentials],
  ]) {
    const target = join(targetDir, fileName);
    const tmp = `${target}.tmp`;
    const body = Buffer.from(`${JSON.stringify(data)}\n`, 'utf8');
    writeFileSync(tmp, body);
    renameSync(tmp, target);
    process.stdout.write(`  wrote ${target} (${(body.length / 1024 / 1024).toFixed(1)} MB)\n`);
  }

  // Icons: `<dataDir>/icons/n8n-nodes-base/dist/nodes/...` -> served as
  // `/icons/n8n-nodes-base/dist/nodes/...`, the URL the editor builds from
  // `iconUrl`.
  const iconRoot = join(dirname(targetDir), 'icons', PACKAGE_NAME);
  rmSync(iconRoot, { recursive: true, force: true });
  let iconBytes = 0;
  for (const [relative, body] of icons) {
    const target = join(iconRoot, relative);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, body);
    iconBytes += body.length;
  }
  process.stdout.write(
    `  wrote ${icons.size} icons to ${iconRoot} (${(iconBytes / 1024 / 1024).toFixed(1)} MB)\n`,
  );

  rmSync(tmpFile, { force: true });
  const written = JSON.parse(readFileSync(join(targetDir, 'nodes.json'), 'utf8'));
  process.stdout.write(
    `done — ${written.length} node types (${written.filter((node) => node.name.startsWith('n8n-nodes-base.')).length} prefixed) available to the editor\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`fetch-n8n-catalog failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
