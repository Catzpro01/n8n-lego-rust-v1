/**
 * Runtime test harness — spawns the REAL server process and talks to it over
 * real HTTP. Nothing is mocked: the suite fails if the runtime does not behave
 * as the contract says on the wire.
 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const SERVER_ENTRY = join(REPO, 'apps', 'n8n-ts', 'src', 'server.ts');
export const STARTUP_TIMEOUT_MS = 20_000;

/** Ask the OS for a free port (then release it — the runtime binds it next). */
export async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

export async function tempDataDir(prefix = 'n8n-ts-test-') {
  return mkdtemp(join(tmpdir(), prefix));
}

export async function waitFor(fn, { timeoutMs = 10_000, intervalMs = 100, what = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}${lastError ? ` (last error: ${lastError.message})` : ''}`);
}

export class Runtime {
  #child;
  #stdout = '';
  #stderr = '';
  #stopped = false;

  constructor({ child, port, dataDir, env }) {
    this.#child = child;
    this.port = port;
    this.dataDir = dataDir;
    this.env = env;
    this.baseUrl = `http://127.0.0.1:${port}`;
  }

  get output() {
    return `${this.#stdout}\n${this.#stderr}`;
  }

  get pid() {
    return this.#child.pid;
  }

  get exited() {
    return this.#child.exitCode !== null || this.#child.signalCode !== null;
  }

  /** Process exit code, or null while it is still running. */
  get exitCode() {
    return this.#child.exitCode;
  }

  get signalCode() {
    return this.#child.signalCode;
  }

  /**
   * Start the runtime on an ephemeral port with an isolated data dir.
   * `env` overrides are merged on top of a hermetic base environment.
   */
  static async start({ env = {}, port, dataDir, waitForReady = true } = {}) {
    const resolvedPort = port ?? (await freePort());
    const resolvedDataDir = dataDir ?? (await tempDataDir());
    const childEnv = {
      ...process.env,
      N8N_TS_HOST: '127.0.0.1',
      N8N_TS_PORT: String(resolvedPort),
      N8N_TS_DATA_DIR: resolvedDataDir,
      N8N_TS_LOG_FORMAT: 'json',
      N8N_TS_LOG_LEVEL: 'debug',
      N8N_TS_ENV: 'test',
      ...env,
    };
    // a hermetic base environment: only strip the API key when the caller did
    // not ask for authentication explicitly
    if (!Object.hasOwn(env, 'N8N_TS_API_KEY')) delete childEnv.N8N_TS_API_KEY;

    const child = spawn(process.execPath, [SERVER_ENTRY], { cwd: REPO, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    const runtime = new Runtime({ child, port: resolvedPort, dataDir: resolvedDataDir, env: childEnv });
    child.stdout.on('data', (chunk) => {
      runtime.#stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      runtime.#stderr += chunk.toString();
    });

    if (waitForReady) {
      try {
        await waitFor(
          async () => {
            if (child.exitCode !== null) throw new Error(`runtime exited early with code ${child.exitCode}: ${runtime.output}`);
            const response = await fetch(`http://127.0.0.1:${resolvedPort}/healthz/full`).catch(() => null);
            if (!response?.ok) return false;
            const body = await response.json().catch(() => null);
            // make sure the answer comes from THIS process: a stale listener on
            // the same port would otherwise make tests silently test the wrong
            // server
            return body?.data?.pid === child.pid;
          },
          { timeoutMs: STARTUP_TIMEOUT_MS, what: `runtime (pid ${child.pid}) on port ${resolvedPort} to become healthy` },
        );
      } catch (error) {
        await runtime.stop().catch(() => {});
        throw new Error(`${error.message}\n--- runtime output ---\n${runtime.output}`);
      }
    }
    return runtime;
  }

  /** Run a request and return `{ status, headers, body, raw }` (body may be null). */
  async request(path, { method = 'GET', body, headers = {}, raw = false } = {}) {
    const init = { method, headers: { ...headers } };
    if (body !== undefined) {
      init.body = raw ? body : JSON.stringify(body);
      if (!init.headers['content-type']) init.headers['content-type'] = 'application/json';
    }
    const response = await fetch(`${this.baseUrl}${path}`, init);
    const text = await response.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    return { status: response.status, headers: Object.fromEntries(response.headers), body: parsed, text };
  }

  get(path, options) {
    return this.request(path, { ...options, method: 'GET' });
  }

  post(path, body, options) {
    return this.request(path, { ...options, method: 'POST', body });
  }

  put(path, body, options) {
    return this.request(path, { ...options, method: 'PUT', body });
  }

  del(path, options) {
    return this.request(path, { ...options, method: 'DELETE' });
  }

  /** SIGTERM and wait for the process to exit; returns the exit code. */
  async stop({ timeoutMs = 10_000 } = {}) {
    if (this.#stopped) return this.#child.exitCode;
    this.#stopped = true;
    if (this.#child.exitCode === null) {
      this.#child.kill('SIGTERM');
      const timer = setTimeout(() => this.#child.kill('SIGKILL'), timeoutMs);
      timer.unref?.();
      await once(this.#child, 'exit').catch(() => {});
      clearTimeout(timer);
    }
    return this.#child.exitCode;
  }

  async cleanup({ keepDataDir = false } = {}) {
    await this.stop();
    if (!keepDataDir) await rm(this.dataDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** True when nothing is listening on the port any more. */
export async function portIsFree(port) {
  const server = createServer();
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });
    return true;
  } catch {
    return false;
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

/** Minimal workflow builder for fixtures — keeps tests readable. */
export function workflow({ name = 'test workflow', nodes = [], connections = {} } = {}) {
  return { name, nodes, connections };
}

export const nodes = {
  manualTrigger: (name = 'Manual Trigger') => ({ name, type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, parameters: {} }),
  noOp: (name = 'Done') => ({ name, type: 'n8n-nodes-base.noOp', typeVersion: 1, parameters: {} }),
  setFields: (name, values) => ({ name, type: 'n8n-nodes-base.set', typeVersion: 1, parameters: { values } }),
  unknown: (name = 'Not A Real Node', type = 'n8n-nodes-base.notARealNode') => ({ name, type, typeVersion: 1, parameters: {} }),
};

export const linearConnections = (from, to) => ({ [from]: { main: [[{ node: to, type: 'main', index: 0 }]] } });
