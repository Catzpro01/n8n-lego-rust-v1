/**
 * scripts/stop-all.mjs
 * 
 * Safely stops only the processes tracked in data/.pids.json.
 * Does NOT kill Node or Rust processes globally.
 */
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const pidsFile = resolve(repoRoot, 'data', '.pids.json');

if (!existsSync(pidsFile)) {
  console.log('[STOP] No .pids.json found. No active workspace instances to stop.');
  process.exit(0);
}

let pidsRecord = {};
try {
  pidsRecord = JSON.parse(readFileSync(pidsFile, 'utf8'));
} catch (err) {
  console.error('[ERROR] Failed to parse .pids.json:', err.message);
  process.exit(1);
}

const keys = Object.keys(pidsRecord);
if (keys.length === 0) {
  console.log('[STOP] No running processes recorded in .pids.json.');
  process.exit(0);
}

console.log('===============================================================');
console.log('🛑 Stopping Tracked Workspace Processes (Non-Global)...');
console.log('===============================================================');

for (const key of keys) {
  const info = pidsRecord[key];
  if (!info || !info.pid) continue;

  console.log(`[STOP] Terminating ${info.name} (Port ${info.port}, PID ${info.pid})...`);
  try {
    if (process.platform === 'win32') {
      const res = spawnSync('taskkill', ['/pid', String(info.pid), '/T', '/F']);
      if (res.status === 0) {
        console.log(`   ✓ PID ${info.pid} stopped successfully.`);
      } else {
        console.log(`   - PID ${info.pid} was not running or already stopped.`);
      }
    } else {
      process.kill(info.pid, 'SIGTERM');
      console.log(`   ✓ PID ${info.pid} signaled with SIGTERM.`);
    }
  } catch (err) {
    console.log(`   ! Notice for PID ${info.pid}: ${err.message}`);
  }
}

// Reset pids record file
writeFileSync(pidsFile, JSON.stringify({}, null, 2), 'utf8');
console.log('[STOP] All tracked workspace processes stopped. data/.pids.json cleared.');
