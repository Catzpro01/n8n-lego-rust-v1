#!/usr/bin/env node
import readline from 'node:readline';
import vm from 'node:vm';

/**
 * Normalizes output data to standard INodeExecutionData[] format.
 * Format: [ { json: Object, binary?: Object, pairedItem?: any }, ... ]
 */
function normalizeExecutionData(result, originalInputs = []) {
  if (result === undefined || result === null) {
    return [{ json: {} }];
  }

  // If array of arrays (multi-output), flatten or preserve
  if (Array.isArray(result) && result.length > 0 && Array.isArray(result[0])) {
    return result.map((branch, branchIdx) =>
      branch.map((item, itemIdx) =>
        normalizeSingleItem(item, originalInputs[itemIdx] ?? { item: itemIdx })
      )
    );
  }

  const items = Array.isArray(result) ? result : [result];
  if (items.length === 0) {
    return [];
  }

  return items.map((item, idx) =>
    normalizeSingleItem(item, originalInputs[idx] ?? { item: idx })
  );
}

function normalizeSingleItem(item, defaultPairedItem) {
  if (item && typeof item === 'object') {
    if ('json' in item && typeof item.json === 'object' && item.json !== null) {
      return {
        json: item.json,
        binary: item.binary || undefined,
        pairedItem: item.pairedItem !== undefined ? item.pairedItem : defaultPairedItem,
      };
    }
    // Object without explicit 'json' property -> treat top-level properties as json
    const { binary, pairedItem, ...jsonFields } = item;
    return {
      json: jsonFields,
      binary: binary || undefined,
      pairedItem: pairedItem !== undefined ? pairedItem : defaultPairedItem,
    };
  }

  // Primitive value
  return {
    json: { value: item },
    pairedItem: defaultPairedItem,
  };
}

/**
 * Processes a single job payload.
 * Expected payload: { id, nodeType, parameters, credentials, inputData }
 */
async function processJob(job) {
  const { id, nodeType, parameters = {}, credentials = {}, inputData = [] } = job;

  // Check for simulated error flag
  if (parameters.simulateError === true || parameters.failExecution === true) {
    const errorMsg = parameters.errorMessage || `Simulated failure for node '${nodeType}'`;
    return {
      id,
      success: false,
      error: errorMsg,
    };
  }

  // 1. Code node or custom JavaScript execution in VM sandbox
  const code = parameters.jsCode || parameters.code;
  if (typeof code === 'string' && code.trim().length > 0) {
    const sandbox = {
      $input: {
        all: () => inputData,
        first: () => inputData[0] || { json: {} },
        item: (index) => inputData[index] || { json: {} },
        params: parameters,
      },
      items: JSON.parse(JSON.stringify(inputData)),
      $parameters: parameters,
      $credentials: credentials,
      $node: { name: nodeType, type: nodeType },
      console: {
        log: (...args) => process.stderr.write(`[worker-log] ${args.join(' ')}\n`),
        warn: (...args) => process.stderr.write(`[worker-warn] ${args.join(' ')}\n`),
        error: (...args) => process.stderr.write(`[worker-error] ${args.join(' ')}\n`),
      },
      Buffer,
      URL,
      URLSearchParams,
      Date,
      Math,
      JSON,
      setTimeout,
      clearTimeout,
    };

    const context = vm.createContext(sandbox);
    // Wrap code in async IIFE to support await and return statements
    const script = new vm.Script(`(async () => {\n${code}\n})()`);
    const runResult = await script.runInContext(context, { timeout: 30000 });

    const outputData = normalizeExecutionData(runResult, inputData);
    return {
      id,
      success: true,
      data: outputData,
    };
  }

  // 2. Generic compatibility fallback execution
  const baseItems = Array.isArray(inputData) && inputData.length > 0
    ? inputData
    : [{ json: {} }];

  const outputData = baseItems.map((item, idx) => {
    const json = { ...(item.json || {}) };

    if (parameters.values && typeof parameters.values === 'object') {
      Object.assign(json, parameters.values);
    }
    if (parameters.fields && typeof parameters.fields === 'object') {
      Object.assign(json, parameters.fields);
    }

    // Attach execution marker for verification
    json._executed_by = 'compatibility-worker';
    json._node_type = nodeType;

    return {
      json,
      binary: item.binary,
      pairedItem: item.pairedItem !== undefined ? item.pairedItem : { item: idx },
    };
  });

  return {
    id,
    success: true,
    data: outputData,
  };
}

async function start() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let job;
    try {
      job = JSON.parse(trimmed);
    } catch (parseErr) {
      process.stdout.write(
        JSON.stringify({
          id: 'unknown',
          success: false,
          error: `Invalid JSON input: ${parseErr.message}`,
        }) + '\n'
      );
      continue;
    }

    try {
      const response = await processJob(job);
      process.stdout.write(JSON.stringify(response) + '\n');
    } catch (execErr) {
      process.stdout.write(
        JSON.stringify({
          id: job.id || 'unknown',
          success: false,
          error: execErr?.message || String(execErr),
        }) + '\n'
      );
    }
  }
}

start().catch((err) => {
  process.stderr.write(`Compatibility Worker fatal error: ${err.stack || err}\n`);
  process.exit(1);
});
