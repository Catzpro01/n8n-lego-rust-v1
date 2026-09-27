/**
 * EXECUTION ENGINE LEGO — built-in node handler registry.
 *
 * The registry is the *only* place in the TypeScript baseline where node
 * behaviour lives.  It is deterministic by design (no clock reads, no network,
 * no randomness) so that workflow runs can be asserted byte-for-byte by the
 * regression suite and later replayed against the Rust implementation.
 *
 * Contract: contracts/runtime-api.contract.md §5
 * NOT IMPLEMENTED in the baseline (documented, not silently wrong):
 *   - expression evaluation (`= {{ ... }}`) — literals are used verbatim and a
 *     EXPRESSION_NOT_EVALUATED warning is emitted
 *   - router/conditional nodes (`if`, `switch`, `merge`)
 *   - webhook/schedule triggers (no listener is started by this package)
 * IMPLEMENTED with an injected seam (P6-S05): `httpRequest` performs real
 * requests through `context.httpTransport` and resolves credentials through
 * `context.credentials.resolve` (the one canonical SecretRef/P2.27 path).
 * The registry itself stays deterministic — no network without an injected
 * transport.
 */
import vm from 'node:vm';
import { getNodeCatalogEntry, nodeAliasOf } from './node-catalog.mjs';
import { httpRequestHandler } from './http-request.mjs';

export const NODE_REGISTRY_VERSION = '1.0.0';

/** Wall-clock budget for the opt-in `jsCode` sandbox. */
export const CODE_EVAL_TIMEOUT_MS = 1000;

const EXPRESSION_PREFIX = '=';

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/* ------------------------------------------------------------------ */
/* handler helpers                                                     */
/* ------------------------------------------------------------------ */

/** Wrap any plain JSON value into the n8n item shape without cloning twice. */
function toItem(value) {
  if (isPlainObject(value) && Object.hasOwn(value, 'json')) return value;
  return { json: value === undefined ? {} : value };
}

function toItems(value) {
  if (Array.isArray(value)) return value.map(toItem);
  if (value === undefined || value === null) return [];
  return [toItem(value)];
}

/**
 * Values produced inside the `node:vm` sandbox live in another realm, so their
 * prototypes differ from host objects.  Copy them back into the host realm so
 * that downstream comparisons/serialisation behave identically to handlers that
 * never left the process.
 */
function realmToHost(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(realmToHost);
  const out = {};
  for (const [key, child] of Object.entries(value)) out[key] = realmToHost(child);
  return out;
}

function expressionWarning(emitWarning, node, field) {
  emitWarning({
    code: 'EXPRESSION_NOT_EVALUATED',
    message: `expression value in "${field}" was used verbatim (expression evaluation is not implemented in the baseline)`,
    node: node?.name,
  });
}

function resolveLiteral(value, emitWarning, node, field) {
  if (typeof value === 'string' && value.startsWith(EXPRESSION_PREFIX)) {
    expressionWarning(emitWarning, node, field);
    return value.slice(EXPRESSION_PREFIX.length);
  }
  return value;
}

/* ------------------------------------------------------------------ */
/* built-in handlers                                                   */
/* ------------------------------------------------------------------ */

/** `n8n-nodes-base.manualTrigger` / `n8n-nodes-base.start` — seed the run. */
function manualTriggerHandler(_node, items) {
  return items.length > 0 ? items : [{ json: {} }];
}

/** `n8n-nodes-base.noOp` — identity. */
function noOpHandler(_node, items) {
  return items;
}

/** Collect assignments from the 2.x (`assignments.assignments`) and 1.x (`values.*`) shapes. */
function collectAssignments(parameters, node, emitWarning) {
  const assignments = [];
  const modern = parameters?.assignments;
  const list = Array.isArray(modern) ? modern : Array.isArray(modern?.assignments) ? modern.assignments : null;
  if (list) {
    for (const entry of list) {
      if (!isPlainObject(entry) || typeof entry.name !== 'string' || entry.name === '') continue;
      assignments.push({
        name: entry.name,
        type: typeof entry.type === 'string' ? entry.type : 'string',
        value: resolveLiteral(entry.value, emitWarning, node, entry.name),
      });
    }
    return assignments;
  }
  const values = isPlainObject(parameters?.values) ? parameters.values : {};
  for (const [type, entries] of Object.entries(values)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!isPlainObject(entry) || typeof entry.name !== 'string' || entry.name === '') continue;
      assignments.push({
        name: entry.name,
        type,
        value: resolveLiteral(entry.value, emitWarning, node, entry.name),
      });
    }
  }
  return assignments;
}

function coerceValue(type, value) {
  switch (type) {
    case 'number':
      return typeof value === 'number' ? value : Number(value);
    case 'boolean':
      return typeof value === 'boolean' ? value : value === 'true' || value === true;
    case 'object':
    case 'json':
      return value;
    case 'array':
      return Array.isArray(value) ? value : value === undefined ? [] : [value];
    default:
      return typeof value === 'string' ? value : JSON.stringify(value);
  }
}

/** `n8n-nodes-base.set` — restricted manual assignments (no expressions). */
function setHandler(node, items, context) {
  const parameters = isPlainObject(node.parameters) ? node.parameters : {};
  const includeOtherFields =
    typeof parameters.includeOtherFields === 'boolean'
      ? parameters.includeOtherFields
      : parameters.keepOnlySet === true
        ? false
        : true;
  const assignments = collectAssignments(parameters, node, context.emitWarning);
  const source = items.length > 0 ? items : [{ json: {} }];
  return source.map((item) => {
    const json = includeOtherFields ? { ...(isPlainObject(item.json) ? item.json : { json: item.json }) } : {};
    for (const assignment of assignments) json[assignment.name] = coerceValue(assignment.type, assignment.value);
    return { json };
  });
}

function readCode(parameters) {
  const code = parameters?.jsCode ?? parameters?.functionCode ?? parameters?.code;
  return typeof code === 'string' ? code : '';
}

/** Restricted `jsCode` execution — only reachable when explicitly enabled. */
async function evalCode(node, items, context) {
  const code = readCode(isPlainObject(node.parameters) ? node.parameters : {});
  const perItem = node.parameters?.mode === 'runOnceForEachItem';
  const sandboxItems = items.map((item) => ({
    json: isPlainObject(item.json) ? structuredClone(item.json) : item.json,
  }));
  // n8n user code is a function body with top-level `return`/`await`, so it is
  // wrapped like the reference implementation does before compiling.
  const runScript = (source, sandbox) => {
    const script = new vm.Script(`(async () => {\n${source}\n})()`, {
      filename: `code-node:${node.name ?? 'code'}.js`,
    });
    return script.runInContext(vm.createContext(sandbox), { timeout: CODE_EVAL_TIMEOUT_MS });
  };
  const baseSandbox = () => ({
    console: { log() {}, warn() {}, error() {}, info() {} },
    $input: {
      all: () => sandboxItems,
      first: () => sandboxItems[0],
      last: () => sandboxItems[sandboxItems.length - 1],
      item: sandboxItems[0],
    },
    items: sandboxItems,
  });

  if (perItem) {
    return Promise.all(
      sandboxItems.map(async (item) => {
        const sandbox = { ...baseSandbox(), $json: item.json, item };
        const result = realmToHost(await runScript(code, sandbox));
        if (result === undefined) return { json: item.json };
        if (isPlainObject(result) && Object.hasOwn(result, 'json')) return result;
        return { json: result };
      }),
    );
  }
  const result = realmToHost(
    await runScript(code, { ...baseSandbox(), $json: sandboxItems[0]?.json ?? {}, item: sandboxItems[0] }),
  );
  if (result === undefined) {
    context.emitWarning({
      code: 'CODE_EVAL_NO_RETURN',
      message: 'jsCode returned undefined — input items were passed through unchanged',
      node: node.name,
    });
    return items;
  }
  return toItems(result);
}

/** `n8n-nodes-base.code` / `function` / `functionItem`. */
function codeHandler(node, items, context) {
  if (!context.allowCodeEval) {
    context.emitWarning({
      code: 'CODE_EVAL_DISABLED',
      message:
        'jsCode was not executed: set N8N_TS_ALLOW_CODE_EVAL=true to enable the restricted in-process sandbox (not production safe)',
      node: node.name,
    });
    return items;
  }
  return evalCode(node, items, context);
}

/* ------------------------------------------------------------------ */
/* registry                                                           */
/* ------------------------------------------------------------------ */

/**
 * Definition table of the built-in handlers.  `implemented: false` entries are
 * *not* registered: they intentionally fall through to the unknown-node policy
 * so operators get an explicit warning instead of a silent wrong result.
 */
const BUILTIN_HANDLER_DEFS = Object.freeze([
  {
    type: 'n8n-nodes-base.manualTrigger',
    alias: 'manualTrigger',
    group: 'trigger',
    label: 'Manual Trigger',
    description: 'Starts the workflow manually and seeds it with the run input items.',
    handler: manualTriggerHandler,
  },
  {
    type: 'n8n-nodes-base.start',
    alias: 'manualTrigger',
    group: 'trigger',
    label: 'Start',
    description: 'Legacy start node — behaves like the manual trigger.',
    handler: manualTriggerHandler,
  },
  {
    type: 'n8n-nodes-base.noOp',
    alias: 'noOp',
    group: 'transform',
    label: 'No Operation, do nothing',
    description: 'Passes items through unchanged.',
    handler: noOpHandler,
  },
  {
    type: 'n8n-nodes-base.set',
    alias: 'set',
    group: 'transform',
    label: 'Edit Fields (Set)',
    description: 'Sets fields from literal values (legacy `values` and 2.x `assignments` shapes; expressions are not evaluated).',
    handler: setHandler,
  },
  {
    type: 'n8n-nodes-base.code',
    alias: 'code',
    group: 'transform',
    label: 'Code',
    description: 'Runs jsCode in a restricted sandbox when enabled, otherwise passes items through with a warning.',
    handler: codeHandler,
  },
  {
    type: 'n8n-nodes-base.function',
    alias: 'code',
    group: 'transform',
    label: 'Function',
    description: 'Legacy code node — same restrictions as the Code node.',
    handler: codeHandler,
  },
  {
    type: 'n8n-nodes-base.functionItem',
    alias: 'code',
    group: 'transform',
    label: 'Function Item',
    description: 'Legacy per-item code node — same restrictions as the Code node.',
    handler: codeHandler,
  },
  {
    type: 'n8n-nodes-base.httpRequest',
    alias: 'httpRequest',
    group: 'input',
    label: 'HTTP Request',
    description: 'Performs an HTTP request with Bearer/Header credential authentication through the injected transport and the canonical SecretRef/P2.27 credential path (P6-S05).',
    handler: httpRequestHandler,
  },
]);

function localizeInfo(def, locale) {
  const entry = getNodeCatalogEntry(nodeAliasOf(def.type), locale);
  return {
    type: def.type,
    alias: def.alias,
    group: def.group,
    label: entry?.label ?? def.label,
    description: entry?.description ?? def.description,
    implemented: true,
  };
}

/**
 * Create a node handler registry with the built-in handlers registered.
 *
 * @param {{ locale?: string, allowCodeEval?: boolean, onWarning?: (w: object) => void, httpTransport?: object, credentials?: object }} [options]
 */
export function createNodeRegistry(options = {}) {
  const locale = typeof options.locale === 'string' && options.locale ? options.locale : 'en';
  const allowCodeEval = options.allowCodeEval === true;
  const onWarning = typeof options.onWarning === 'function' ? options.onWarning : null;

  const handlers = new Map();
  const infos = new Map();
  const warnings = [];

  const emitWarning = (warning) => {
    const entry = { ...warning };
    warnings.push(entry);
    if (onWarning) onWarning(entry);
    return entry;
  };

  // P6-S05 seams: injected network transport and the canonical credential
  // resolver. The registry never performs I/O itself; a missing seam is an
  // explicit failure in the handler, never a silent stub.
  const context = {
    allowCodeEval,
    emitWarning,
    locale,
    httpTransport: options.httpTransport ?? null,
    credentials: options.credentials ?? null,
  };

  const register = (type, handler, info = {}) => {
    if (typeof type !== 'string' || type.trim() === '') throw new TypeError('register(type, handler): type is required');
    if (typeof handler !== 'function') throw new TypeError('register(type, handler): handler must be a function');
    handlers.set(type, handler);
    infos.set(type, {
      type,
      alias: info.alias ?? nodeAliasOf(type),
      group: info.group ?? 'custom',
      label: info.label ?? type,
      description: info.description ?? '',
      implemented: true,
    });
    return registry;
  };

  for (const def of BUILTIN_HANDLER_DEFS) {
    handlers.set(def.type, def.handler);
    infos.set(def.type, localizeInfo(def, locale));
  }

  const registry = {
    version: NODE_REGISTRY_VERSION,
    locale,
    allowCodeEval,
    handlers,
    context,
    warnings,
    register,
    has: (type) => handlers.has(type),
    get: (type) => handlers.get(type) ?? null,
    info: (type) => infos.get(type) ?? null,
    list: () => [...infos.values()].map((info) => ({ ...info })).sort((a, b) => a.type.localeCompare(b.type)),
    takeWarnings: () => warnings.splice(0, warnings.length),
  };

  return registry;
}

/** Convenience wrapper used by `listNodeTypes()`. */
export function registryNodeTypes(options = {}) {
  return createNodeRegistry(options).list();
}
