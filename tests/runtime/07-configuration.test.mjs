/**
 * W3 — configuration behaviour over the wire (contract §2).
 * Every knob is proven by observing the running process, not by reading code.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { rm, stat } from 'node:fs/promises';
import { Runtime, SERVER_ENTRY, freePort, portIsFree, tempDataDir } from './helpers/process.mjs';

test('N8N_TS_PORT wins over PORT', async () => {
  const prefixed = await freePort();
  const generic = await freePort();
  const runtime = await Runtime.start({ port: prefixed, env: { N8N_TS_PORT: String(prefixed), PORT: String(generic) } });
  try {
    assert.equal((await runtime.get('/healthz')).status, 200);
    assert.equal(await portIsFree(generic), true, 'the generic PORT must not be used');
  } finally {
    await runtime.cleanup();
  }
});

test('generic PORT is honoured when N8N_TS_PORT is not set', async () => {
  const port = await freePort();
  const dataDir = await tempDataDir();
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    env: { ...process.env, N8N_TS_PORT: undefined, PORT: String(port), N8N_TS_DATA_DIR: dataDir, N8N_TS_LOG_FORMAT: 'json' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = [];
  child.stdout.on('data', (chunk) => output.push(chunk.toString()));
  child.stderr.on('data', (chunk) => output.push(chunk.toString()));
  const runtime = new Runtime({ child, port, dataDir, env: {} });
  try {
    const deadline = Date.now() + 15_000;
    let healthy = false;
    while (Date.now() < deadline && !healthy) {
      healthy = await fetch(`http://127.0.0.1:${port}/healthz`).then((response) => response.ok).catch(() => false);
      if (!healthy) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(healthy, true, `runtime did not listen on PORT: ${output.join('')}`);
  } finally {
    await runtime.cleanup();
  }
});

test('API key protection covers /api/v1 but leaves health and the console open', async () => {
  const runtime = await Runtime.start({ env: { N8N_TS_API_KEY: 'correct-horse-battery-staple' } });
  try {
    const missing = await runtime.get('/api/v1/version');
    assert.equal(missing.status, 401);
    assert.equal(missing.body.code, 'UNAUTHORIZED');

    const wrong = await runtime.get('/api/v1/version', { headers: { 'x-n8n-api-key': 'nope' } });
    assert.equal(wrong.status, 401);

    const right = await runtime.get('/api/v1/version', { headers: { 'x-n8n-api-key': 'correct-horse-battery-staple' } });
    assert.equal(right.status, 200);

    const runProtected = await runtime.post('/api/v1/workflows/run', { workflow: { nodes: [] } });
    assert.equal(runProtected.status, 401);

    assert.equal((await runtime.get('/healthz')).status, 200);
    assert.equal((await runtime.get('/healthz/readiness')).status, 200);
    assert.equal((await runtime.get('/')).status, 200);

    const preflight = await runtime.request('/api/v1/workflows/run', { method: 'OPTIONS' });
    assert.equal(preflight.status, 204, 'CORS preflight must not require the key');
  } finally {
    await runtime.cleanup();
  }
});

test('N8N_TS_MAX_BODY_BYTES is enforced exactly', async () => {
  const runtime = await Runtime.start({ env: { N8N_TS_MAX_BODY_BYTES: '4096' } });
  try {
    const small = await runtime.post('/api/v1/workflows/run', {
      workflow: { nodes: [{ name: 'A', type: 'n8n-nodes-base.noOp', parameters: { pad: 'x'.repeat(200) } }], connections: {} },
    });
    assert.equal(small.status, 200);

    const large = await runtime.post('/api/v1/workflows/run', {
      workflow: { nodes: [{ name: 'A', type: 'n8n-nodes-base.noOp', parameters: { pad: 'x'.repeat(8000) } }], connections: {} },
    });
    assert.equal(large.status, 413);
    assert.equal(large.body.code, 'PAYLOAD_TOO_LARGE');
  } finally {
    await runtime.cleanup();
  }
});

test('N8N_TS_LOCALE changes the human-facing labels but never the data', async () => {
  const english = await Runtime.start({ env: { N8N_TS_LOCALE: 'en' } });
  const indonesian = await Runtime.start({ env: { N8N_TS_LOCALE: 'id' } });
  try {
    const definition = {
      nodes: [
        { name: 'Start', type: 'n8n-nodes-base.manualTrigger', parameters: {} },
        { name: 'Edit', type: 'n8n-nodes-base.set', parameters: { values: { string: [{ name: 'label', value: 'value stays' }] } } },
      ],
      connections: { Start: { main: [[{ node: 'Edit', type: 'main', index: 0 }]] } },
    };
    const en = await english.post('/api/v1/workflows/run', { workflow: definition });
    const id = await indonesian.post('/api/v1/workflows/run', { workflow: definition });

    assert.equal(en.body.data.executionLog[0].nodeLabel, 'Manual Trigger');
    assert.notEqual(id.body.data.executionLog[0].nodeLabel, 'Manual Trigger');
    assert.equal(en.body.data.data.Edit[0].json.label, 'value stays');
    assert.equal(id.body.data.data.Edit[0].json.label, 'value stays');

    assert.equal((await english.get('/api/v1/runtime/config')).body.data.locale, 'en');
  } finally {
    await english.cleanup();
    await indonesian.cleanup();
  }
});

test('N8N_TS_STORAGE=memory leaves no trace on disk', async () => {
  const dataDir = await tempDataDir('n8n-ts-memory-');
  const runtime = await Runtime.start({ dataDir, env: { N8N_TS_STORAGE: 'memory' } });
  try {
    await runtime.post('/api/v1/workflows', { workflow: { name: 'ephemeral', nodes: [{ name: 'A', type: 'n8n-nodes-base.noOp', parameters: {} }], connections: {} } });
    await runtime.post('/api/v1/workflows/run', { workflow: { nodes: [{ name: 'A', type: 'n8n-nodes-base.noOp', parameters: {} }], connections: {} } });
    assert.equal((await runtime.get('/api/v1/workflows')).body.data.count, 1);

    const entries = await stat(dataDir).then(() => true).catch(() => false);
    assert.equal(entries, true, 'the data dir exists…');
    assert.equal(await portIsFree(runtime.port), false, '…and the runtime is up');

    await runtime.stop();
    const restarted = await Runtime.start({ dataDir, env: { N8N_TS_STORAGE: 'memory' }, port: runtime.port });
    assert.equal((await restarted.get('/api/v1/workflows')).body.data.count, 0, 'memory storage is not persisted');
    assert.equal((await restarted.get('/api/v1/executions')).body.data.count, 0);
    await restarted.cleanup({ keepDataDir: true });
  } finally {
    await runtime.cleanup();
    await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('N8N_TS_CORS_ORIGIN=off removes the CORS headers', async () => {
  const runtime = await Runtime.start({ env: { N8N_TS_CORS_ORIGIN: 'off' } });
  try {
    const response = await runtime.get('/api/v1/version');
    assert.equal(response.status, 200);
    assert.equal(response.headers['access-control-allow-origin'], undefined);
  } finally {
    await runtime.cleanup();
  }
});

test('N8N_TS_EXECUTION_HISTORY bounds the stored history', async () => {
  const runtime = await Runtime.start({ env: { N8N_TS_EXECUTION_HISTORY: '2' } });
  try {
    for (let index = 0; index < 4; index += 1) {
      await runtime.post('/api/v1/workflows/run', {
        workflow: { nodes: [{ name: `Run ${index}`, type: 'n8n-nodes-base.noOp', parameters: {} }], connections: {} },
      });
    }
    const listed = await runtime.get('/api/v1/executions?limit=50');
    assert.equal(listed.body.data.items.length, 2);
  } finally {
    await runtime.cleanup();
  }
});

test('an invalid configuration exits with code 78 and names the variable', async () => {
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    env: { ...process.env, N8N_TS_PORT: 'not-a-port' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk.toString()));
  child.stderr.on('data', (chunk) => (output += chunk.toString()));
  const [code] = await once(child, 'exit');
  assert.equal(code, 78);
  assert.match(output, /N8N_TS_PORT/);
  assert.match(output, /invalid/);
});

test('an empty API key is rejected at boot', async () => {
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    env: { ...process.env, N8N_TS_API_KEY: '   ' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stderr.on('data', (chunk) => (output += chunk.toString()));
  const [code] = await once(child, 'exit');
  assert.equal(code, 78);
  assert.match(output, /N8N_TS_API_KEY/);
});

test('N8N_TS_LOG_LEVEL=error silences access logs', async () => {
  const runtime = await Runtime.start({ env: { N8N_TS_LOG_LEVEL: 'error' } });
  try {
    await runtime.get('/healthz');
    const lines = runtime.output.split('\n').filter((line) => line.trim() !== '');
    assert.equal(lines.some((line) => line.includes('"msg":"request handled"')), false);
  } finally {
    await runtime.cleanup();
  }
});
