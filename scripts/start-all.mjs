/**
 * scripts/start-all.mjs
 * 
 * Monorepo Multi-Instance Orchestrator:
 * - Starts n8n-lego on port 5677
 * - Starts n8n-rust on port 5678
 * - Starts n8n-reference on port 5680
 */
import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

const instances = [
  {
    name: 'n8n-lego (Frontend)',
    port: process.env.N8N_LEGO_PORT || 5677,
    cmd: 'node',
    args: ['apps/n8n-lego/bin/n8n-lego.mjs', 'start'],
    env: {
      ...process.env,
      N8N_LEGO_PORT: process.env.N8N_LEGO_PORT || '5677',
      N8N_PORT: process.env.N8N_LEGO_PORT || '5677',
      N8N_USER_FOLDER: resolve(repoRoot, 'data', 'lego'),
    },
  },
  {
    name: 'n8n-reference (Oracle)',
    port: process.env.N8N_REFERENCE_PORT || 5680,
    cmd: 'node',
    args: ['apps/n8n-reference/index.mjs'],
    env: {
      ...process.env,
      N8N_REFERENCE_PORT: process.env.N8N_REFERENCE_PORT || '5680',
      N8N_PORT: process.env.N8N_REFERENCE_PORT || '5680',
      N8N_USER_FOLDER: resolve(repoRoot, 'data', 'reference'),
    },
  },
];

console.log('====================================================');
console.log('🚀 Starting Unified n8n LEGO (Port 5677) + Oracle (Port 5680)...');
console.log('====================================================');

const children = [];

for (const inst of instances) {
  console.log(`[INIT] ${inst.name} configured on port ${inst.port}`);
  const child = spawn(inst.cmd, inst.args, {
    cwd: repoRoot,
    env: inst.env,
    stdio: 'inherit',
    shell: true,
  });

  child.on('error', (err) => {
    console.error(`[ERROR] Failed to start ${inst.name}:`, err.message);
  });

  children.push({ name: inst.name, child });
}

process.on('SIGINT', () => {
  console.log('\n[SHUTDOWN] Stopping all instances gracefully...');
  for (const { name, child } of children) {
    child.kill('SIGINT');
  }
  process.exit(0);
});
