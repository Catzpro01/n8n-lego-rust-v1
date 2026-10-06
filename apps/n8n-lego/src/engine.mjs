/**
 * The only module that talks to the execution engine.
 *
 * Single-engine rule (contract §5): the app never implements a DAG loop or a
 * node handler — it validates the request, calls `runWorkflowDefinition` on the
 * LEGO engine, and translates the result into the shape the n8n editor reads.
 *
 * The translation matters: the editor renders `execution.data.resultData.runData`
 * keyed by node name, while the engine returns a flat `data` map. Converting here
 * keeps the engine clean and the UI happy.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { APP_ROOT, REPO_ROOT } from './config.mjs';
import { HttpError, badRequest } from './compat/error.mjs';

/**
 * The engine is a sibling package in the repository and a vendored copy inside the
 * published npm tarball (`vendor/reconstructed-engine`, produced by
 * `scripts/release.sh`), so it is resolved at runtime instead of with a fixed
 * relative specifier. The repository path stays first: a checkout always runs the
 * engine it ships with.
 */
const ENGINE_CANDIDATES = [
  process.env.N8N_LEGO_ENGINE_PATH ? join(process.env.N8N_LEGO_ENGINE_PATH, 'index.mjs') : null,
  join(REPO_ROOT, 'packages', 'reconstructed-engine', 'index.mjs'),
  join(APP_ROOT, 'vendor', 'reconstructed-engine', 'index.mjs'),
  join(APP_ROOT, 'node_modules', '@lego', 'reconstructed-engine', 'index.mjs'),
].filter((candidate) => candidate !== null);

export const ENGINE_PATH = ENGINE_CANDIDATES.find((candidate) => existsSync(candidate));
if (!ENGINE_PATH) {
  throw new Error(
    `reconstructed engine not found — looked in:\n  ${ENGINE_CANDIDATES.join('\n  ')}\n` +
      'set N8N_LEGO_ENGINE_PATH to the directory containing index.mjs',
  );
}

const {
  ENGINE_PACKAGE,
  ENGINE_VERSION,
  NODE_REGISTRY_VERSION,
  createNodeRegistry,
  listNodeTypes,
  runWorkflowDefinition,
  validateWorkflowDefinition,
} = await import(pathToFileURL(ENGINE_PATH).href);
import { newExecutionId } from './store.mjs';
import {
  executeWorkflowOnRust,
  isRustEngineAvailable,
  DEFAULT_RUST_HOST,
  DEFAULT_RUST_PORT,
} from './rust-engine-client.mjs';

export const engineMetadata = Object.freeze({
  package: ENGINE_PACKAGE,
  version: ENGINE_VERSION,
  registryVersion: NODE_REGISTRY_VERSION,
});

export function createEngine(config = {}, logger) {
  const rustHost = config?.rustHost || process.env.N8N_RUST_HOST || DEFAULT_RUST_HOST;
  const rustPort = parseInt(String(config?.rustPort || process.env.N8N_RUST_PORT || DEFAULT_RUST_PORT), 10);
  const rustEngineEnabled = config?.rustEngine !== false && process.env.N8N_RUST_ENGINE !== 'false';

  let lastProbeTime = 0;
  let lastProbeResult = false;
  const PROBE_TTL_MS = 1000;

  async function checkRustAvailable() {
    if (!rustEngineEnabled) return false;
    const now = Date.now();
    if (now - lastProbeTime < PROBE_TTL_MS) {
      return lastProbeResult;
    }
    const isAvailable = await isRustEngineAvailable({ host: rustHost, port: rustPort, timeoutMs: 250 });
    lastProbeTime = now;
    lastProbeResult = isAvailable;
    return isAvailable;
  }

  return {
    metadata: engineMetadata,
    listNodeTypes: (locale = config.locale) => listNodeTypes({ locale }),

    /**
     * Runs a workflow definition and persists an execution record.
     * Returns the stored record (never throws for engine-level failures — the
     * editor shows a failed execution instead of an error toast, like n8n).
     *
     * Prioritizes the high-performance Rust runtime kernel at port 5678 (Rust Cut-over),
     * with seamless transparent fallback to the JS reconstructed engine if Rust is offline.
     */
    async execute({
      definition,
      startNode = null,
      destinationNode = null,
      input,
      workflowId = null,
      workflowName = null,
      mode = 'manual',
      requestedBy = null,
      store,
      pushRef = null,
    }) {
      const executionId = newExecutionId();
      const startedAt = new Date();
      const registry = createNodeRegistry({ locale: config.locale, allowCodeEval: true, httpTransport: fetch });

      const stored = workflowId ? store.workflows.get(workflowId) : null;
      const finalWorkflowId = workflowId || stored?.id || definition?.id || executionId;
      const finalVersionId = stored?.versionId || definition?.versionId || finalWorkflowId;
      const finalWorkflowName = workflowName || stored?.name || definition?.name || 'Workflow';

      const record = {
        id: String(executionId),
        finished: false,
        mode,
        status: 'running',
        createdAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
        stoppedAt: null,
        workflowId: finalWorkflowId,
        workflowVersionId: finalVersionId,
        workflowName: finalWorkflowName,
        requestedBy,
        data: { resultData: { runData: {} } },
        workflowData: {
          id: finalWorkflowId,
          versionId: finalVersionId,
          name: finalWorkflowName,
          active: stored?.active ?? definition?.active ?? false,
          nodes: definition?.nodes ?? stored?.nodes ?? [],
          connections: definition?.connections ?? stored?.connections ?? {},
          settings: definition?.settings ?? stored?.settings ?? {},
          pinData: definition?.pinData ?? stored?.pinData ?? {},
          meta: definition?.meta ?? stored?.meta ?? {},
          createdAt: stored?.createdAt || new Date().toISOString(),
          updatedAt: stored?.updatedAt || new Date().toISOString(),
        },
      };

      const validation = validateWorkflowDefinition(definition, { registry });
      if (!validation.ok) {
        const first = validation.errors?.[0] ?? { code: 'VALIDATION_ERROR', message: 'workflow is not valid' };
        record.finished = true;
        record.status = 'error';
        record.stoppedAt = new Date().toISOString();
        record.data = {
          resultData: { runData: {}, error: { name: 'WorkflowValidationError', message: first.message, code: first.code } },
        };
        store.executions.insert(record);
        logger.warn('workflow rejected before execution', { executionId, workflowId, code: first.code, message: first.message });
        return record;
      }

      const rustRequired = config?.rustRequired !== undefined
        ? config.rustRequired !== false
        : process.env.N8N_LEGO_RUST_REQUIRED !== 'false';

      // Priority 1: Rust Runtime Cut-over
      const rustOnline = await checkRustAvailable();
      if (rustOnline) {
        try {
          const rustRecord = await executeWorkflowOnRust({
            workflowData: {
              id: workflowId || executionId,
              name: workflowName || definition?.name || 'Workflow',
              active: definition?.active ?? false,
              nodes: validation.normalized?.nodes ?? definition?.nodes ?? [],
              connections: validation.normalized?.connections ?? definition?.connections ?? {},
            },
            inputData: input,
            mode,
            pushRef,
            rustUrl: config?.rustUrl || process.env.N8N_RUST_URL,
          });

          record.finished = rustRecord.finished !== false;
          record.status = rustRecord.status;
          record.stoppedAt = rustRecord.stoppedAt || new Date().toISOString();
          record.data = rustRecord.data || { resultData: { runData: {} } };

          if (rustRecord.status === 'error' || record.status === 'error') {
            record.status = 'error';
            if (!record.data.resultData) {
              record.data.resultData = { runData: {} };
            }
            if (!record.data.resultData.error) {
              let errorMsg = 'Workflow execution error';
              const runData = record.data.resultData.runData || {};
              for (const [nodeName, runs] of Object.entries(runData)) {
                if (Array.isArray(runs)) {
                  for (const r of runs) {
                    if (r?.error || r?.executionStatus === 'error') {
                      errorMsg =
                        r?.error?.message ||
                        (typeof r?.error === 'string' ? r.error : null) ||
                        r?.statusText ||
                        `Node "${nodeName}" execution failed`;
                      break;
                    }
                  }
                }
              }
              record.data.resultData.error = {
                name: 'NodeExecutionError',
                message: errorMsg,
              };
            }
          }

          if (Array.isArray(rustRecord.warnings) && rustRecord.warnings.length > 0) {
            record.data.resultData.warnings = rustRecord.warnings;
          }

          const walPath = rustRecord.walPath || rustRecord.data?.resultData?.walPath;
          if (walPath) {
            if (record.data.resultData) {
              record.data.resultData.walPath = walPath;
            }
            record.walPath = walPath;
          }

          store.executions.insert(record);
          logger.info('execution finished (Rust cut-over)', {
            executionId,
            workflowId,
            status: record.status,
            nodes: Object.keys(record.data.resultData.runData || {}).length,
          });
          return record;
        } catch (rustError) {
          lastProbeResult = false;
          lastProbeTime = 0;
          if (rustRequired) {
            logger.error('Rust engine execution failed and Rust is required (N8N_LEGO_RUST_REQUIRED=true)', {
              executionId,
              workflowId,
              error: rustError.message,
            });
            record.finished = true;
            record.status = 'error';
            record.stoppedAt = new Date().toISOString();
            record.data.resultData = {
              runData: {},
              error: {
                name: 'RustExecutionError',
                message: 'Rust engine execution failed: ' + (rustError.message || String(rustError)),
              },
            };
            store.executions.insert(record);
            return record;
          }
          logger.warn('Rust runtime execution failed, falling back to reconstructed JS engine', {
            executionId,
            workflowId,
            error: rustError.message,
          });
          // Fall through to JS engine fallback below
        }
      } else {
        if (rustRequired) {
          logger.error('Rust runtime is required (N8N_LEGO_RUST_REQUIRED=true) but no Rust runtime is available', {
            executionId,
            workflowId,
          });
          record.finished = true;
          record.status = 'error';
          record.stoppedAt = new Date().toISOString();
          record.data = {
            resultData: {
              runData: {},
              error: {
                name: 'RustUnavailableError',
                message: 'Rust engine is required (N8N_LEGO_RUST_REQUIRED=true) but no Rust runtime is available.',
              },
            },
          };
          store.executions.insert(record);
          return record;
        }
        logger.warn('Rust runtime is offline, falling back to reconstructed JS engine (N8N_LEGO_RUST_REQUIRED=false)', {
          executionId,
          workflowId,
        });
      }

      // Priority 2: Fallback to reconstructed JS engine when Rust is offline
      try {
        const result = await runWorkflowDefinition(validation.normalized, {
          startNode,
          input,
          locale: config.locale,
          registry,
        });

        record.finished = result.finished !== false;
        record.status = mapStatus(result.status);
        record.stoppedAt = new Date().toISOString();
        record.data = {
          resultData: {
            ...toResultData(result, validation.normalized),
            ...(result.statusText ? { statusText: result.statusText } : {}),
          },
        };
        if (Array.isArray(result.warnings) && result.warnings.length > 0) {
          record.data.resultData.warnings = result.warnings;
        }

        let hasJsNodeError = false;
        let jsNodeErrorMsg = null;
        for (const [nodeName, runs] of Object.entries(record.data.resultData.runData || {})) {
          if (Array.isArray(runs)) {
            for (const r of runs) {
              if (r?.executionStatus === 'error' || r?.error) {
                hasJsNodeError = true;
                if (!jsNodeErrorMsg) {
                  jsNodeErrorMsg =
                    r?.error?.message ||
                    (typeof r?.error === 'string' ? r.error : null) ||
                    r?.statusText ||
                    `Node "${nodeName}" execution failed`;
                }
              }
            }
          }
        }
        if (hasJsNodeError || record.status === 'error') {
          record.status = 'error';
          if (!record.data.resultData.error) {
            record.data.resultData.error = {
              name: 'NodeExecutionError',
              message: jsNodeErrorMsg || result.error || 'Workflow execution error',
            };
          }
        }
        store.executions.insert(record);
        logger.info('execution finished (JS engine fallback)', {
          executionId,
          workflowId,
          status: record.status,
          nodes: Object.keys(record.data.resultData.runData).length,
        });
        return record;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        record.finished = true;
        record.status = 'crashed';
        record.stoppedAt = new Date().toISOString();
        record.data = { resultData: { runData: {}, error: { name: 'ExecutionError', message } } };
        store.executions.insert(record);
        logger.error('execution crashed', { executionId, workflowId, cause: message });
        return record;
      }
    },

    validate(definition) {
      const registry = createNodeRegistry({ locale: config.locale, allowCodeEval: false });
      const validation = validateWorkflowDefinition(definition, { registry });
      if (!validation.ok) {
        const first = validation.errors?.[0];
        throw badRequest(first?.message ?? 'workflow is not valid', { errors: validation.errors });
      }
      return validation.normalized;
    },
  };
}

function mapStatus(status) {
  switch (String(status ?? '').toUpperCase()) {
    case 'COMPLETED':
    case 'SUCCESS':
      return 'success';
    case 'TIMED_OUT':
      return 'crashed';
    case 'FAILED':
    case 'ERROR':
      return 'error';
    default:
      return 'success';
  }
}

/**
 * Engine output -> `resultData.runData`.
 *
 * `runData[nodeName]` is an array of run entries; each entry carries
 * `data.main` = array of output connections, each connection an array of
 * `{ json, binary?, pairedItem? }` — exactly what the editor's NDV and the
 * "output" panel iterate over.
 */
function toResultData(result, definition) {
  const runData = {};
  const startedAt = new Date().toISOString();
  const log = Array.isArray(result.executionLog) ? result.executionLog : [];
  const outputs = result.data && typeof result.data === 'object' ? result.data : {};
  const nodeOrder = Array.isArray(definition?.nodes) ? definition.nodes.map((node) => node.name) : Object.keys(outputs);
  const byName = new Map(log.map((entry) => [entry.node, entry]));

  for (const nodeName of nodeOrder) {
    const entry = byName.get(nodeName);
    const items = Array.isArray(outputs[nodeName]) ? outputs[nodeName] : [];
    if (!entry && items.length === 0) continue;
    runData[nodeName] = [
      {
        executionIndex: 0,
        startTime: Number.isFinite(entry?.durationMs) ? Number(entry.durationMs) : 0,
        executionTime: Number.isFinite(entry?.durationMs) ? Number(entry.durationMs) : 0,
        source: [],
        executionStatus: entry?.status === 'success' || entry === undefined ? 'success' : 'error',
        data: { main: [items] },
        ...(entry?.statusText ? { statusText: entry.statusText } : {}),
        startedAt,
      },
    ];
  }

  const lastExecuted = [...nodeOrder].reverse().find((name) => runData[name] !== undefined) ?? null;
  return { runData, ...(lastExecuted ? { lastNodeExecuted: lastExecuted } : {}) };
}

export { HttpError };
