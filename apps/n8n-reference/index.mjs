/**
 * apps/n8n-reference/index.mjs
 * 
 * Launcher for official upstream n8n serving as Truth Oracle on Port 5680.
 */
import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..');

const port = process.env.N8N_REFERENCE_PORT || process.env.N8N_PORT || '5680';
const userFolder = process.env.N8N_REFERENCE_USER_FOLDER || resolve(repoRoot, 'data', 'reference');

console.log(`[n8n-reference] Starting official n8n reference oracle on port ${port}...`);
console.log(`[n8n-reference] User folder: ${userFolder}`);

const env = {
  ...process.env,
  N8N_PORT: port,
  N8N_USER_FOLDER: userFolder,
  N8N_ENFORCE_SETTINGS_FILE_PERMISSIONS: 'true',
  N8N_DIAGNOSTICS_ENABLED: 'false',
  N8N_HIRING_BANNER_ENABLED: 'false',
  N8N_VERSION_NOTIFICATIONS_ENABLED: 'false',
};

const n8nCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const child = spawn(n8nCmd, ['n8n', 'start'], {
  stdio: 'inherit',
  env,
  shell: true,
});

child.on('exit', (code, signal) => {
  console.log(`[n8n-reference] Process exited with code: ${code}, signal: ${signal}`);
  process.exit(code ?? 0);
});
