/**
 * scripts/start-all.mjs
 * 
 * Monorepo Multi-Instance Isolated Orchestrator:
 * - Starts n8n-lego on port 5677 (Data: data/lego)
 * - Starts n8n-rust on port 5678 (Data: data/rust, DB: data/rust/n8n.sqlite)
 * - Starts n8n-reference on port 5680 (Data: data/reference)
 * 
 * Tracks process PIDs into data/.pids.json for safe, non-global stopping.
 */
import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync, mkdirSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const dataDir = resolve(repoRoot, 'data');
const pidsFile = resolve(dataDir, '.pids.json');

mkdirSync(dataDir, { recursive: true });
mkdirSync(resolve(dataDir, 'lego'), { recursive: true });
mkdirSync(resolve(dataDir, 'rust'), { recursive: true });
mkdirSync(resolve(dataDir, 'reference'), { recursive: true });

const instances = [
  {
    key: 'lego',
    name: 'n8n-lego (Frontend / UI)',
    port: process.env.N8N_LEGO_PORT || '5677',
    cmd: 'node',
    args: ['apps/n8n-lego/bin/n8n-lego.mjs', 'start'],
    env: {
      ...process.env,
      PORT: process.env.N8N_LEGO_PORT || '5677',
      N8N_PORT: process.env.N8N_LEGO_PORT || '5677',
      N8N_LEGO_PORT: process.env.N8N_LEGO_PORT || '5677',
      USER_FOLDER: resolve(dataDir, 'lego'),
      N8N_USER_FOLDER: resolve(dataDir, 'lego'),
      N8N_LEGO_USER_FOLDER: resolve(dataDir, 'lego'),
    },
  },
  {
    key: 'rust',
    name: 'n8n-rust (Execution Engine)',
    port: process.env.N8N_RUST_PORT || '5678',
    cmd: 'cargo',
    args: ['run', '--manifest-path', 'apps/n8n-rust/Cargo.toml'],
    env: {
      ...process.env,
      PORT: process.env.N8N_RUST_PORT || '5678',
      N8N_RUST_PORT: process.env.N8N_RUST_PORT || '5678',
      N8N_RUST_DATA_DIR: resolve(dataDir, 'rust'),
      DATABASE_URL: `sqlite://${resolve(dataDir, 'rust', 'n8n.sqlite')}`,
    },
  },
  {
    key: 'reference',
    name: 'n8n-reference (Truth Oracle)',
    port: process.env.N8N_REFERENCE_PORT || '5680',
    cmd: 'node',
    args: ['apps/n8n-reference/index.mjs'],
    env: {
      ...process.env,
      PORT: process.env.N8N_REFERENCE_PORT || '5680',
      N8N_PORT: process.env.N8N_REFERENCE_PORT || '5680',
      N8N_REFERENCE_PORT: process.env.N8N_REFERENCE_PORT || '5680',
      N8N_USER_FOLDER: resolve(dataDir, 'reference'),
      N8N_REFERENCE_USER_FOLDER: resolve(dataDir, 'reference'),
    },
  },
];

console.log('===============================================================');
console.log('🚀 Starting n8n 3 Isolated Environments Monorepo...');
console.log('   1. n8n-lego      -> Port: 5677 | Data: data/lego');
console.log('   2. n8n-rust      -> Port: 5678 | Data: data/rust');
console.log('   3. n8n-reference -> Port: 5680 | Data: data/reference');
console.log('===============================================================');

const pidsRecord = {};
const activeChildren = [];

for (const inst of instances) {
  console.log(`[SPAWN] ${inst.name} on port ${inst.port}...`);
  const child = spawn(inst.cmd, inst.args, {
    cwd: repoRoot,
    env: inst.env,
    stdio: 'inherit',
    shell: true,
  });

  if (child.pid) {
    pidsRecord[inst.key] = {
      name: inst.name,
      port: inst.port,
      pid: child.pid,
      startedAt: new Date().toISOString(),
    };
  }

  child.on('error', (err) => {
    console.error(`[ERROR] Failed to start ${inst.name}:`, err.message);
  });

  activeChildren.push({ key: inst.key, name: inst.name, child });
}

// Persist PIDs for stop-all.mjs
writeFileSync(pidsFile, JSON.stringify(pidsRecord, null, 2), 'utf8');
console.log(`[PIDS] Process tracking active in ${pidsFile}`);

function cleanup() {
  console.log('\n[SHUTDOWN] Stopping all instances cleanly...');
  for (const { key, name, child } of activeChildren) {
    if (child && !child.killed) {
      console.log(`[STOP] Terminating ${name} (PID: ${child.pid})...`);
      try {
        if (process.platform === 'win32') {
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
        } else {
          child.kill('SIGTERM');
        }
      } catch (e) {
        // ignore
      }
    }
  }
  try {
    writeFileSync(pidsFile, JSON.stringify({}, null, 2), 'utf8');
  } catch (e) {}
  process.exit(0);
}

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
