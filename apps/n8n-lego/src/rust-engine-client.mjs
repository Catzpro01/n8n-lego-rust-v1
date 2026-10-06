/**
 * Rust Execution Engine Client
 *
 * Cut-over client dispatching workflow execution to the Rust Axum kernel
 * runtime (port 5678) with transparent fallback and frontend-compatible
 * deserialization.
 */
import net from 'node:net';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const DEFAULT_RUST_HOST = '127.0.0.1';
export const DEFAULT_RUST_PORT = 5678;
export const DEFAULT_RUST_URL = `http://${DEFAULT_RUST_HOST}:${DEFAULT_RUST_PORT}/rest/workflows/run`;

/**
 * Resolves the location of the compiled Rust standalone engine binary or cargo runner.
 */
export function resolveRustBinary() {
  if (process.env.N8N_RUST_BIN && fs.existsSync(process.env.N8N_RUST_BIN)) {
    return { command: process.env.N8N_RUST_BIN, args: ['execute'] };
  }

  const isWin = process.platform === 'win32';
  const binName = isWin ? 'n8n-rust-app.exe' : 'n8n-rust-app';

  const candidates = [
    path.resolve(process.cwd(), 'apps', 'n8n-rust', 'target', 'debug', binName),
    path.resolve(process.cwd(), 'apps', 'n8n-rust', 'target', 'release', binName),
    path.resolve(process.cwd(), 'target', 'debug', binName),
    path.resolve(process.cwd(), 'target', 'release', binName),
  ];

  try {
    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    candidates.push(path.resolve(currentDir, '..', '..', 'n8n-rust', 'target', 'debug', binName));
    candidates.push(path.resolve(currentDir, '..', '..', 'n8n-rust', 'target', 'release', binName));
    candidates.push(path.resolve(currentDir, '..', '..', '..', 'target', 'debug', binName));
  } catch (_) {}

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return { command: candidate, args: ['execute'] };
    }
  }

  // Fallback ke cargo run jika executable belum terkompilasi
  let manifestPath = path.resolve(process.cwd(), 'apps', 'n8n-rust', 'Cargo.toml');
  if (!fs.existsSync(manifestPath)) {
    try {
      const currentDir = path.dirname(fileURLToPath(import.meta.url));
      manifestPath = path.resolve(currentDir, '..', '..', 'n8n-rust', 'Cargo.toml');
    } catch (_) {}
  }

  return {
    command: 'cargo',
    args: ['run', '--manifest-path', manifestPath, '--bin', 'n8n-rust-app', '--', 'execute'],
  };
}

/**
 * Checks whether the Rust binary or cargo build tool is available.
 */
export function isRustBinaryAvailable() {
  const resolved = resolveRustBinary();
  if (resolved.command !== 'cargo') {
    return fs.existsSync(resolved.command);
  }
  const manifestArgIdx = resolved.args.indexOf('--manifest-path');
  if (manifestArgIdx !== -1 && resolved.args[manifestArgIdx + 1]) {
    return fs.existsSync(resolved.args[manifestArgIdx + 1]);
  }
  return false;
}

/**
 * Checks whether the Rust HTTP server port is listening.
 */
export async function isRustPortAvailable(options = {}) {
  let host = process.env.N8N_RUST_HOST || DEFAULT_RUST_HOST;
  let port = parseInt(process.env.N8N_RUST_PORT || String(DEFAULT_RUST_PORT), 10);
  let timeoutMs = 250;

  if (typeof options === 'number') {
    port = options;
  } else if (typeof options === 'object' && options !== null) {
    if (options.host) host = options.host;
    if (options.port) port = Number(options.port);
    if (options.timeoutMs) timeoutMs = Number(options.timeoutMs);
  }

  if (host === 'localhost') {
    host = '127.0.0.1';
  }

  return new Promise((resolve) => {
    let finished = false;
    const socket = net.createConnection({ host, port });

    const finish = (result) => {
      if (!finished) {
        finished = true;
        socket.removeAllListeners();
        socket.destroy();
        resolve(result);
      }
    };

    socket.setTimeout(timeoutMs, () => finish(false));
    socket.on('connect', () => finish(true));
    socket.on('error', () => finish(false));
  });
}

/**
 * Checks whether the Rust execution engine is available (either via HTTP port 5678 or standalone binary IPC).
 *
 * @param {Object|number} [options] - Options or port number
 * @returns {Promise<boolean>} True if Rust engine is ready to execute workflows
 */
export async function isRustEngineAvailable(options = {}) {
  // 1. Cek apakah server HTTP port 5678 tersedia
  const portReachable = await isRustPortAvailable(options);
  if (portReachable) return true;

  // 2. Jika port 5678 mati, cek ketersediaan standalone binary Rust
  return isRustBinaryAvailable();
}

/**
 * Normalizes status strings from Rust runtime to standard n8n statuses.
 */
function mapRustStatus(status) {
  const s = String(status ?? '').toLowerCase();
  switch (s) {
    case 'success':
    case 'completed':
      return 'success';
    case 'error':
    case 'failed':
      return 'error';
    case 'crashed':
    case 'cancelled':
    case 'timed_out':
      return 'crashed';
    default:
      return 'success';
  }
}

/**
 * Normalizes a single output item and enriches parameters (e.g. Set/Edit Fields assignments).
 */
function normalizeItemData(item, nodeDef) {
  let json = {};
  if (item && typeof item === 'object') {
    if ('json' in item && typeof item.json === 'object' && item.json !== null) {
      json = { ...item.json };
    } else {
      json = { ...item };
    }
  }

  if (nodeDef && nodeDef.type && nodeDef.type.includes('set')) {
    const params = nodeDef.parameters ?? {};
    const assignments = params.assignments?.assignments ?? params.assignments ?? params.values?.string ?? params.values;
    if (Array.isArray(assignments)) {
      if (params.includeOtherFields === false) {
        json = {};
      }
      for (const assign of assignments) {
        if (assign?.name) {
          json[assign.name] = assign.value;
        }
      }
    }
  }

  return {
    json,
    ...(item?.binary ? { binary: item.binary } : {}),
    ...(item?.pairedItem ? { pairedItem: item.pairedItem } : {}),
  };
}

/**
 * Deserializes an Axum Rust server execution response into the n8n frontend editor shape.
 *
 * @param {Object} rawResponse - Response object returned from Rust Axum server
 * @param {Object} context - Execution context
 * @returns {Object} Deserialized execution record
 */
export function deserializeRustExecutionResult(rawResponse, { workflowData = {}, mode = 'manual', executionId = null } = {}) {
  const payload = rawResponse?.data ?? rawResponse ?? {};
  const inner = payload?.data?.resultData ? payload : (payload?.data ?? payload);
  const id = String(inner.executionId || inner.id || executionId || '');
  const workflowId = inner.workflowId || workflowData?.id || null;
  const workflowName = inner.workflowName || workflowData?.name || null;
  const startedAt = inner.startedAt || new Date().toISOString();
  const stoppedAt = inner.stoppedAt || new Date().toISOString();
  const finished = inner.finished !== false;
  let status = mapRustStatus(inner.status ?? rawResponse?.status);

  const walPath =
    inner.walPath ||
    inner.wal_path ||
    inner.data?.walPath ||
    inner.data?.wal_path ||
    inner.resultData?.walPath ||
    inner.resultData?.wal_path ||
    inner.data?.resultData?.walPath ||
    inner.data?.resultData?.wal_path ||
    rawResponse?.walPath ||
    rawResponse?.wal_path ||
    rawResponse?.data?.walPath ||
    rawResponse?.data?.wal_path ||
    rawResponse?.data?.resultData?.walPath ||
    rawResponse?.data?.resultData?.wal_path ||
    null;

  const rawRunData = inner.data?.resultData?.runData || inner.resultData?.runData || inner.runData || {};
  const frames = inner.frames && typeof inner.frames === 'object' ? inner.frames : {};

  const nodesByName = new Map();
  if (Array.isArray(workflowData?.nodes)) {
    for (const node of workflowData.nodes) {
      if (node?.name) nodesByName.set(node.name, node);
    }
  }

  const nodeOrder = Array.isArray(workflowData?.nodes)
    ? workflowData.nodes.map((n) => n.name)
    : Object.keys(rawRunData);

  const allNodeNames = new Set([...nodeOrder, ...Object.keys(rawRunData), ...Object.keys(frames)]);
  const runData = {};

  for (const nodeName of allNodeNames) {
    const rawList = rawRunData[nodeName];
    const nodeDef = nodesByName.get(nodeName);

    if (Array.isArray(rawList) && rawList.length > 0) {
      const isRunEntry = rawList[0] && typeof rawList[0] === 'object' && ('data' in rawList[0] || 'executionTime' in rawList[0] || 'executionStatus' in rawList[0]);

      if (isRunEntry) {
        runData[nodeName] = rawList.map((entry) => {
          let main = entry?.data?.main;
          if (!Array.isArray(main)) {
            main = [[]];
          } else if (main.length > 0 && !Array.isArray(main[0])) {
            main = [main];
          }

          main = main.map((branch) =>
            Array.isArray(branch)
              ? branch.map((item) => normalizeItemData(item, nodeDef))
              : []
          );

          return {
            executionIndex: entry?.executionIndex ?? 0,
            startTime: Number.isFinite(entry?.startTime) ? Number(entry.startTime) : 0,
            executionTime: Number.isFinite(entry?.executionTime) ? Number(entry.executionTime) : 0,
            source: Array.isArray(entry?.source) ? entry.source : [],
            executionStatus: entry?.executionStatus || (entry?.error ? 'error' : 'success'),
            data: { main },
            startedAt: entry?.startedAt || startedAt,
            ...(entry?.statusText ? { statusText: entry.statusText } : {}),
            ...(entry?.error ? { error: entry.error } : {}),
          };
        });
      } else {
        const normalizedItems = rawList.map((item) => normalizeItemData(item, nodeDef));
        runData[nodeName] = [
          {
            executionIndex: 0,
            startTime: 0,
            executionTime: 0,
            source: [],
            executionStatus: 'success',
            data: { main: [normalizedItems] },
            startedAt,
          },
        ];
      }
    } else if (frames[nodeName]) {
      const frame = frames[nodeName];
      let main = frame.output_data;
      if (!Array.isArray(main)) {
        main = [[]];
      } else if (main.length > 0 && !Array.isArray(main[0])) {
        main = [main];
      }
      main = main.map((branch) =>
        Array.isArray(branch)
          ? branch.map((item) => normalizeItemData(item, nodeDef))
          : []
      );

      runData[nodeName] = [
        {
          executionIndex: 0,
          startTime: frame.start_time ? new Date(frame.start_time).getTime() : 0,
          executionTime: Number.isFinite(frame.execution_time_ms) ? Number(frame.execution_time_ms) : 0,
          source: [],
          executionStatus: frame.status === 'Completed' || !frame.error ? 'success' : 'error',
          data: { main },
          startedAt: frame.start_time || startedAt,
          ...(frame.error ? { error: { message: frame.error } } : {}),
        },
      ];
    }
  }

  // Preserve workflow node order in runData object
  const sortedRunData = {};
  for (const name of nodeOrder) {
    if (runData[name] !== undefined) {
      sortedRunData[name] = runData[name];
    }
  }
  for (const [name, val] of Object.entries(runData)) {
    if (sortedRunData[name] === undefined) {
      sortedRunData[name] = val;
    }
  }

  // Periksa apakah ada node di runData yang memiliki executionStatus === 'error' atau properti error
  let hasNodeError = false;
  let firstNodeErrorMsg = null;
  let firstNodeErrorName = null;

  for (const [nodeName, runs] of Object.entries(sortedRunData)) {
    if (Array.isArray(runs)) {
      for (const run of runs) {
        if (run && (run.executionStatus === 'error' || run.error)) {
          hasNodeError = true;
          if (!firstNodeErrorMsg) {
            firstNodeErrorName = nodeName;
            const errObj = run.error;
            if (typeof errObj === 'string') {
              firstNodeErrorMsg = errObj;
            } else if (errObj && typeof errObj === 'object' && errObj.message) {
              firstNodeErrorMsg = errObj.message;
            } else if (run.statusText) {
              firstNodeErrorMsg = run.statusText;
            } else {
              firstNodeErrorMsg = `Node "${nodeName}" execution failed`;
            }
          }
        }
      }
    }
  }

  const rawStatus = String(rawResponse?.status ?? '').toLowerCase();
  const innerStatus = String(inner?.status ?? '').toLowerCase();
  const isStatusError =
    rawStatus === 'error' ||
    rawStatus === 'failed' ||
    innerStatus === 'error' ||
    innerStatus === 'failed';

  if (hasNodeError || isStatusError) {
    status = 'error';
  }

  const errorMsg =
    firstNodeErrorMsg ||
    (typeof inner?.error === 'string' ? inner.error : inner?.error?.message) ||
    (typeof rawResponse?.error === 'string' ? rawResponse.error : rawResponse?.error?.message) ||
    rawResponse?.message ||
    inner?.message ||
    (firstNodeErrorName ? `Node "${firstNodeErrorName}" execution failed` : 'Node execution error occurred');

  let existingError = null;
  if (inner?.error) {
    existingError =
      typeof inner.error === 'object' && inner.error !== null
        ? inner.error
        : { name: 'ExecutionError', message: String(inner.error) };
  } else if (rawResponse?.error) {
    existingError =
      typeof rawResponse.error === 'object' && rawResponse.error !== null
        ? rawResponse.error
        : { name: 'ExecutionError', message: String(rawResponse.error) };
  }

  if (!existingError && (status === 'error' || hasNodeError || isStatusError)) {
    existingError = {
      name: 'NodeExecutionError',
      message: errorMsg,
      ...(firstNodeErrorName ? { node: firstNodeErrorName } : {}),
    };
  }

  const lastExecuted = [...nodeOrder].reverse().find((name) => sortedRunData[name] !== undefined)
    ?? Object.keys(sortedRunData).pop()
    ?? null;

  const resultData = {
    runData: sortedRunData,
    ...(walPath ? { walPath } : {}),
    ...(lastExecuted ? { lastNodeExecuted: lastExecuted } : {}),
    ...(existingError ? { error: existingError } : {}),
  };

  return {
    id,
    finished,
    mode: inner.mode || mode || 'manual',
    status,
    createdAt: inner.createdAt || startedAt,
    startedAt,
    stoppedAt,
    workflowId,
    workflowName,
    data: {
      resultData,
    },
    ...(walPath ? { walPath } : {}),
    workflowData: {
      id: workflowId || workflowData?.id,
      versionId: workflowData?.versionId || workflowId || workflowData?.id,
      name: workflowName,
      active: workflowData?.active ?? false,
      nodes: workflowData?.nodes ?? [],
      connections: workflowData?.connections ?? {},
      settings: workflowData?.settings ?? {},
      pinData: workflowData?.pinData ?? {},
      meta: workflowData?.meta ?? {},
      createdAt: workflowData?.createdAt || startedAt,
      updatedAt: workflowData?.updatedAt || startedAt,
    },
  };
}

/**
 * Executes a workflow directly via the standalone Rust binary child process (stdin/stdout IPC).
 *
 * @param {Object} params
 * @param {Object} params.workflowData - Workflow definition object ({ id, name, nodes, connections, ... })
 * @param {Array|Object} [params.inputData] - Input / trigger data
 * @param {string} [params.mode='manual'] - Execution mode
 * @returns {Promise<Object>} Deserialized execution record
 */
export async function executeWorkflowViaRustBinary({
  workflowData,
  inputData,
  mode = 'manual',
} = {}) {
  const normalizedWorkflow = {
    id: workflowData?.id ? String(workflowData.id) : undefined,
    name: workflowData?.name || 'Workflow',
    active: Boolean(workflowData?.active ?? false),
    nodes: (workflowData?.nodes || []).map((n) => ({
      id: String(n.id || n.name),
      name: String(n.name),
      type: String(n.type),
      typeVersion: Number(n.typeVersion || 1),
      position: Array.isArray(n.position) ? n.position : [0, 0],
      parameters: n.parameters || {},
      disabled: Boolean(n.disabled),
    })),
    connections: workflowData?.connections || {},
  };

  const requestPayload = {
    workflowData: normalizedWorkflow,
    ...(inputData !== undefined ? { inputData } : {}),
    mode,
  };

  const { command, args } = resolveRustBinary();

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stdoutData = '';
    let stderrData = '';

    child.stdout.on('data', (chunk) => {
      stdoutData += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderrData += chunk.toString();
    });

    child.on('error', (err) => {
      reject(new Error(`Gagal memulai proses Rust binary (${command}): ${err.message}`));
    });

    child.on('close', (code) => {
      let parsed = null;
      try {
        if (stdoutData.trim()) {
          parsed = JSON.parse(stdoutData.trim());
        }
      } catch (parseErr) {
        const errDetail = stderrData.trim() || stdoutData.trim();
        return reject(
          new Error(`Output JSON dari Rust binary tidak valid (exit code ${code}): ${errDetail}`)
        );
      }

      if (!parsed) {
        return reject(
          new Error(`Rust binary selesai tanpa output JSON (exit code ${code}): ${stderrData.trim()}`)
        );
      }

      if (code !== 0 && !parsed.data && !parsed.resultData) {
        const errorMsg = parsed.error || stderrData.trim() || `Rust binary exit dengan error code ${code}`;
        return reject(new Error(errorMsg));
      }

      try {
        const deserialized = deserializeRustExecutionResult(parsed, {
          workflowData,
          mode,
          executionId: parsed?.data?.id || parsed?.id,
        });
        resolve(deserialized);
      } catch (deserErr) {
        reject(new Error(`Gagal mendeserialisasi hasil eksekusi Rust: ${deserErr.message}`));
      }
    });

    child.stdin.write(JSON.stringify(requestPayload));
    child.stdin.end();
  });
}

/**
 * Executes a workflow on the Rust runtime kernel (prioritizes HTTP port 5678 if alive,
 * or directly via standalone Rust binary if port 5678 is inactive).
 *
 * @param {Object} params
 * @param {Object} params.workflowData - Workflow definition object ({ id, name, nodes, connections, ... })
 * @param {Array|Object} [params.inputData] - Input / trigger data
 * @param {string} [params.mode='manual'] - Execution mode
 * @param {string} [params.pushRef=null] - WebSocket push session ref
 * @param {string} [params.rustUrl=null] - Target URL (defaults to http://127.0.0.1:5678/rest/workflows/run)
 * @returns {Promise<Object>} Deserialized execution record
 */
export async function executeWorkflowOnRust({
  workflowData,
  inputData,
  mode = 'manual',
  pushRef = null,
  rustUrl = null,
} = {}) {
  // Cek ketersediaan server HTTP port 5678
  const isHttpActive = await isRustPortAvailable();
  if (!isHttpActive) {
    // Port HTTP 5678 tidak aktif: eksekusi langsung via binary Rust (100% Rust engine)!
    return executeWorkflowViaRustBinary({ workflowData, inputData, mode });
  }

  const targetUrl = rustUrl
    || process.env.N8N_RUST_URL
    || `http://${process.env.N8N_RUST_HOST || DEFAULT_RUST_HOST}:${process.env.N8N_RUST_PORT || DEFAULT_RUST_PORT}/rest/workflows/run`;

  const normalizedWorkflow = {
    id: workflowData?.id ? String(workflowData.id) : undefined,
    name: workflowData?.name || 'Workflow',
    active: Boolean(workflowData?.active ?? false),
    nodes: (workflowData?.nodes || []).map((n) => ({
      id: String(n.id || n.name),
      name: String(n.name),
      type: String(n.type),
      typeVersion: Number(n.typeVersion || 1),
      position: Array.isArray(n.position) ? n.position : [0, 0],
      parameters: n.parameters || {},
      disabled: Boolean(n.disabled),
    })),
    connections: workflowData?.connections || {},
  };

  const requestPayload = {
    workflowData: normalizedWorkflow,
    ...(inputData !== undefined ? { inputData } : {}),
    mode,
    ...(pushRef ? { pushRef } : {}),
  };

  let response;
  try {
    response = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(requestPayload),
    });
  } catch (netErr) {
    // Fallback jika koneksi HTTP gagal tiba-tiba
    return executeWorkflowViaRustBinary({ workflowData, inputData, mode });
  }

  const responseText = await response.text();
  let json = null;
  try {
    json = responseText ? JSON.parse(responseText) : {};
  } catch (parseErr) {
    throw new Error(`Invalid JSON response from Rust engine (HTTP ${response.status}): ${responseText}`);
  }

  // Axum returns HTTP 500 when workflow execution failed, but includes complete execution payload
  if (!response.ok && !json?.data && !json?.resultData) {
    const errorMsg = json?.error || json?.message || `Rust execution request failed with HTTP ${response.status}`;
    throw new Error(errorMsg);
  }

  return deserializeRustExecutionResult(json, {
    workflowData,
    mode,
    executionId: json?.data?.id || json?.data?.executionId,
  });
}
