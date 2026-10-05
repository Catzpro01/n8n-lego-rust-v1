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

export const engineMetadata = Object.freeze({
  package: ENGINE_PACKAGE,
  version: ENGINE_VERSION,
  registryVersion: NODE_REGISTRY_VERSION,
});

export function createEngine(config, logger) {

  return {
    metadata: engineMetadata,
    listNodeTypes: (locale = config.locale) => listNodeTypes({ locale }),

    /**
     * Runs a workflow definition and persists an execution record.
     * Returns the stored record (never throws for engine-level failures — the
     * editor shows a failed execution instead of an error toast, like n8n).
     */
    async execute({ definition, startNode = null, input, workflowId = null, workflowName = null, mode = 'manual', requestedBy = null, store }) {
      const executionId = newExecutionId();
      const startedAt = new Date();
      const registry = createNodeRegistry({ locale: config.locale, allowCodeEval: false });

      const record = {
        id: executionId,
        finished: false,
        mode,
        status: 'running',
        createdAt: startedAt.toISOString(),
        startedAt: startedAt.toISOString(),
        stoppedAt: null,
        workflowId,
        workflowName,
        requestedBy,
        data: { resultData: { runData: {} } },
        workflowData: { name: workflowName, nodes: definition?.nodes ?? [], connections: definition?.connections ?? {} },
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
        store.executions.insert(record);
        logger.info('execution finished', {
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
