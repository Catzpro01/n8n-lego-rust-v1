/**
 * Rust Execution Engine Client
 *
 * Cut-over client dispatching workflow execution to the Rust Axum kernel
 * runtime (port 5678) with transparent fallback and frontend-compatible
 * deserialization.
 */
import net from 'node:net';

export const DEFAULT_RUST_HOST = '127.0.0.1';
export const DEFAULT_RUST_PORT = 5678;
export const DEFAULT_RUST_URL = `http://${DEFAULT_RUST_HOST}:${DEFAULT_RUST_PORT}/rest/workflows/run`;

/**
 * Checks whether the Rust runtime server is available and accepting TCP connections.
 *
 * @param {Object|number} [options] - Options or port number
 * @param {string} [options.host] - Target host (defaults to N8N_RUST_HOST or 127.0.0.1)
 * @param {number} [options.port] - Target port (defaults to N8N_RUST_PORT or 5678)
 * @param {number} [options.timeoutMs] - Probe timeout in ms (default: 250)
 * @returns {Promise<boolean>} True if Rust port is reachable
 */
export async function isRustEngineAvailable(options = {}) {
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
  const status = mapRustStatus(inner.status);

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

  const lastExecuted = [...nodeOrder].reverse().find((name) => sortedRunData[name] !== undefined)
    ?? Object.keys(sortedRunData).pop()
    ?? null;

  const resultData = {
    runData: sortedRunData,
    ...(lastExecuted ? { lastNodeExecuted: lastExecuted } : {}),
    ...(inner.error ? { error: { name: 'ExecutionError', message: String(inner.error) } } : {}),
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
    workflowData: {
      name: workflowName,
      nodes: workflowData?.nodes ?? [],
      connections: workflowData?.connections ?? {},
    },
  };
}

/**
 * Executes a workflow on the Rust runtime kernel at port 5678.
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

  const response = await fetch(targetUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify(requestPayload),
  });

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
