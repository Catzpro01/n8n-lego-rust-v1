/**
 * P5-M10 — the API mounting framework plus the /api/v1 resources that sit on
 * the P5-M11..P5-M18 backing models.
 *
 * P5-M08's header listed exactly these as "not mounted yet ... (P5-M10, no
 * backing model)". The models exist now (projects, audit events, source
 * control, data tables, transfer, workflow versions, execution retry and
 * execution tags), so this module wires the public REST surface onto them and
 * closes CP-01's contract:
 *
 *   /api/v1 route -> backing model -> response   (one uniform envelope)
 *   closed model-error -> HTTP mapping:
 *     *_INVALID -> 400, *_NOT_FOUND -> 404, *_CONFLICT -> 409,
 *     storage UNAVAILABLE|TIMEOUT -> 503, anything else -> 500.
 *
 * Rules this module holds itself to (P5-M04..M09 kept the same discipline):
 *
 *   - THE ROUTES, METHODS, PATHS, SCOPES AND STATUSES mirror the pinned n8n
 *     2.9.4 public API (`reference/n8n/packages/cli/src/public-api/v1`).
 *     Where this product's backing model semantics differ from upstream's
 *     implementation (upstream re-executes; ours records a retry; upstream
 *     generates security risk reports; ours reports the audit event log), the
 *     HTTP contract stays (path, method, scope, status codes, `{ message }`
 *     error bodies) and the RESPONSE BODY is the backing model's own record
 *     shape. Every deviation is listed in
 *     docs/n8n-lego/evidence/P5-M10-DELIVERY.md. The served OpenAPI document
 *     is derived from the pinned upstream spec for exactly the mounted
 *     operations (scripts/extract-public-api-spec.py).
 *   - STORAGE ONLY THROUGH THE P8 FACADE. The backing models get one facade
 *     handle (createLocalStorage + optional write-through persistence); the
 *     API layer keeps NO shadow state. Read-modify-write loops around model
 *     CAS verbs (bulk row updates) pass the version token the model just
 *     returned — never a cached copy.
 *   - ROLLBACK = UNMOUNT (see public-api-routes.mjs mountPublicApiOperations):
 *     unmounting removes the routes only; the backing models and everything
 *     they wrote stay intact and readable.
 *   - DETERMINISTIC: no wall-clock reads here (the models own the injected
 *     clock), stable sort keys everywhere, no random ordering.
 *
 * Auth boundary: every operation carries a scope from the PINNED API-key
 * vocabulary (api-key-scopes.json) — the same universe the P5.3 authorize()
 * kernel checks. Unknown scopes fail closed, so no operation may invent one.
 */
import { HttpError } from '../compat/error.mjs';
import { sendJson } from '../compat/response.mjs';
import { PUBLIC_API_LIMITS, PUBLIC_API_MESSAGES, decodeOffsetCursor, encodeNextCursor } from './public-api-routes.mjs';
import { createProjectSharingModel } from '../lego/project-sharing-model.mjs';
import { createAuditEventModel } from '../lego/audit-event-model.mjs';
import { createSourceControlModel } from '../lego/source-control-model.mjs';
import { createDataTableModel } from '../lego/data-table-model.mjs';
import { createTransferModel } from '../lego/transfer-model.mjs';
import { createWorkflowVersionModel } from '../lego/workflow-version-model.mjs';
import { createExecutionRetryModel } from '../lego/execution-retry-model.mjs';
import { createExecutionTagModel } from '../lego/execution-tag-model.mjs';

/* ------------------------------------------------------- error mapping */

/**
 * Closed model-error -> HTTP mapping (CP-01). Returns an HttpError with the
 * upstream `{ message }` body shape. Unknown failures become 500 without
 * leaking internals; the models' closed codes are the only vocabulary.
 */
export function mapBackingError(error) {
  if (error instanceof HttpError) return error;
  const code = typeof error?.code === 'string' ? error.code : '';
  const message = error instanceof Error ? error.message : 'Internal Server Error';
  if (code.endsWith('_INVALID') || code === 'STORAGE_INVALID') return new HttpError(400, message);
  if (code.endsWith('_NOT_FOUND') || code === 'STORAGE_NOT_FOUND') return new HttpError(404, message);
  if (code.endsWith('_CONFLICT') || code === 'STORAGE_CONFLICT') return new HttpError(409, message);
  if (code === 'STORAGE_UNAVAILABLE' || code === 'STORAGE_TIMEOUT') return new HttpError(503, message);
  return new HttpError(500, 'Internal Server Error');
}

/** Wrap a backing handler so every model/storage failure renders through the closed mapping. */
export function withBackingErrors(handler) {
  return async (ctx) => {
    try {
      return await handler(ctx);
    } catch (error) {
      throw mapBackingError(error);
    }
  };
}

const invalid = (message) => new HttpError(400, message);
const notFoundBody = () => new HttpError(404, PUBLIC_API_MESSAGES.NOT_FOUND);

/* ------------------------------------------------------------- helpers */

const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

const requireString = (value, field) => {
  if (typeof value !== 'string' || value.length === 0) throw invalid(`request/body/${field} must be a non-empty string`);
  return value;
};

const bodyObject = (ctx) => {
  if (!isPlainObject(ctx.body)) throw invalid('request/body must be object');
  return ctx.body;
};

const sendEmpty = (ctx, status = 204) => {
  ctx.res.writeHead(status);
  ctx.res.end();
};

/** `project:viewer` <-> `viewer` (upstream role strings carry the resource prefix). */
export const PROJECT_ROLE_PREFIX = 'project:';
export const toApiRole = (role) => `${PROJECT_ROLE_PREFIX}${role}`;
export const toModelRole = (role) => {
  const raw = typeof role === 'string' && role.startsWith(PROJECT_ROLE_PREFIX)
    ? role.slice(PROJECT_ROLE_PREFIX.length)
    : role;
  return requireString(raw, 'role');
};

/* ------------------------------------------------- data-table filter engine */

export const FILTER_CONDITIONS = Object.freeze(['eq', 'neq', 'like', 'ilike', 'gt', 'gte', 'lt', 'lte']);

/**
 * Deterministic row matcher for the upstream filter shape:
 *   { type: 'and'|'or', filters: [{ columnName, condition, value }] }
 * `like`/`ilike` are substring matches (case-sensitive / insensitive); the
 * ordering comparisons (gt/gte/lt/lte) compare numbers numerically and strings
 * lexicographically; `eq`/`neq` are strict after number coercion of numeric
 * strings on both sides. Unknown columns never match (fail-closed, so a filter
 * typo cannot widen a delete).
 */
export function parseRowFilter(raw, { where = 'request/query/filter' } = {}) {
  let parsed = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw invalid(`${where} must be a JSON string of filter conditions`);
    }
  }
  if (!isPlainObject(parsed)) throw invalid(`${where} must be an object`);
  const type = parsed.type ?? 'and';
  if (type !== 'and' && type !== 'or') throw invalid(`${where}/type must be one of and|or`);
  if (!Array.isArray(parsed.filters) || parsed.filters.length === 0) {
    throw invalid(`${where}/filters must be a non-empty array`);
  }
  const filters = parsed.filters.map((entry, index) => {
    if (!isPlainObject(entry)) throw invalid(`${where}/filters[${index}] must be object`);
    const columnName = requireString(entry.columnName, `filters[${index}].columnName`);
    if (!FILTER_CONDITIONS.includes(entry.condition)) {
      throw invalid(`${where}/filters[${index}].condition must be one of ${FILTER_CONDITIONS.join('|')}`);
    }
    if (!('value' in entry)) throw invalid(`${where}/filters[${index}] must have required property 'value'`);
    return { columnName, condition: entry.condition, value: entry.value };
  });
  return Object.freeze({ type, filters: Object.freeze(filters) });
}

const coerceNumber = (value) => {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return null;
};

const cellCompare = (cell, condition, value) => {
  switch (condition) {
    case 'eq':
    case 'neq': {
      const a = coerceNumber(cell);
      const b = coerceNumber(value);
      const equal = a !== null && b !== null ? a === b : cell === value;
      return condition === 'eq' ? equal : !equal;
    }
    case 'like':
      return typeof cell === 'string' && typeof value === 'string' && cell.includes(value);
    case 'ilike':
      return typeof cell === 'string' && typeof value === 'string'
        && cell.toLowerCase().includes(value.toLowerCase());
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const a = coerceNumber(cell);
      const b = coerceNumber(value);
      let ok;
      if (a !== null && b !== null) {
        ok = condition === 'gt' ? a > b : condition === 'gte' ? a >= b : condition === 'lt' ? a < b : a <= b;
      } else if (typeof cell === 'string' && typeof value === 'string') {
        ok = condition === 'gt' ? cell > value : condition === 'gte' ? cell >= value
          : condition === 'lt' ? cell < value : cell <= value;
      } else {
        ok = false;
      }
      return ok;
    }
    default:
      return false;
  }
};

export function rowMatches(row, filter) {
  const results = filter.filters.map((entry) => {
    const cell = Object.hasOwn(row.cells ?? {}, entry.columnName) ? row.cells[entry.columnName] : undefined;
    if (cell === undefined) return false;
    return cellCompare(cell, entry.condition, entry.value);
  });
  return filter.type === 'and' ? results.every(Boolean) : results.some(Boolean);
}

export function rowSearchMatches(row, search) {
  const needle = search.toLowerCase();
  return Object.values(row.cells ?? {}).some((cell) => typeof cell === 'string' && cell.toLowerCase().includes(needle));
}

export function sortRows(rows, sortBy) {
  if (typeof sortBy !== 'string' || sortBy.length === 0) return rows;
  const index = sortBy.lastIndexOf(':');
  const column = index === -1 ? sortBy : sortBy.slice(0, index);
  const direction = index === -1 ? 'asc' : sortBy.slice(index + 1);
  if (direction !== 'asc' && direction !== 'desc') throw invalid('sortBy must use the format field:asc or field:desc');
  const sign = direction === 'asc' ? 1 : -1;
  return [...rows].sort((left, right) => {
    const a = left.cells?.[column];
    const b = right.cells?.[column];
    const an = coerceNumber(a);
    const bn = coerceNumber(b);
    if (an !== null && bn !== null) return an === bn ? (left.rowId < right.rowId ? -1 : left.rowId > right.rowId ? 1 : 0) : sign * (an < bn ? -1 : 1);
    const as = a === undefined ? '' : typeof a === 'string' ? a : JSON.stringify(a);
    const bs = b === undefined ? '' : typeof b === 'string' ? b : JSON.stringify(b);
    if (as === bs) return left.rowId < right.rowId ? -1 : left.rowId > right.rowId ? 1 : 0;
    return sign * (as < bs ? -1 : 1);
  });
}

/** Offset cursor window shared with the P5-M08 list endpoints. */
function offsetWindow(query) {
  const limitRaw = query.limit;
  let limit = PUBLIC_API_LIMITS.DEFAULT_LIMIT;
  if (limitRaw !== undefined) {
    if (!/^\d+$/.test(String(limitRaw))) throw invalid('limit must be a positive integer');
    limit = Number(limitRaw);
    if (limit < 1 || limit > PUBLIC_API_LIMITS.MAX_LIMIT) {
      throw invalid(`limit must be between 1 and ${PUBLIC_API_LIMITS.MAX_LIMIT}`);
    }
  }
  let offset = 0;
  if (query.cursor !== undefined && query.cursor !== '') {
    try {
      offset = decodeOffsetCursor(String(query.cursor));
    } catch {
      throw new HttpError(400, PUBLIC_API_MESSAGES.INVALID_CURSOR);
    }
    if (!Number.isInteger(offset) || offset < 0) throw new HttpError(400, PUBLIC_API_MESSAGES.INVALID_CURSOR);
  }
  return { offset, limit };
}

const pagedEnvelope = (all, { offset, limit }, dto) => ({
  data: all.slice(offset, offset + limit).map(dto),
  nextCursor: encodeNextCursor({ offset, limit, numberOfTotalRecords: all.length }),
});

/* ------------------------------------------------------------- dtos */

export const projectDto = (project) => ({
  id: project.projectId,
  name: project.name,
  type: project.type ?? 'team',
});

export const projectMemberDto = (member) => ({
  userId: member.principal,
  role: toApiRole(member.role),
  createdAt: member.joinedAt ?? null,
});

export const auditEventDto = (event) => ({ ...event });

export const executionRetryDto = (retry) => ({
  retryId: retry.retryId,
  executionId: retry.originalExecutionId,
  requestedBy: retry.requestedBy,
  reason: retry.reason,
  state: retry.state,
  createdAt: retry.createdAt,
  updatedAt: retry.updatedAt,
});

export const executionTagDto = (tag) => ({
  id: tag.tagId,
  name: tag.name,
  createdAt: tag.createdAt,
  updatedAt: tag.updatedAt,
});

export const workflowVersionDto = (version) => ({
  versionId: version.versionId,
  workflowId: version.workflowId,
  parentIds: version.parentIds ?? [],
  diff: version.diff ?? null,
  authors: version.author ?? '',
  metadata: version.metadata ?? null,
  createdAt: version.createdAt,
  updatedAt: version.updatedAt,
});

export const dataTableDto = (table) => ({
  id: table.tableId,
  name: table.name,
  columns: table.columns.map((column, index) => ({ name: column.name, type: column.type, index })),
  createdAt: table.createdAt,
  updatedAt: table.updatedAt,
});

export const dataTableRowDto = (row) => ({
  id: row.rowId,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  ...row.cells,
});

/* -------------------------------------------------- backing model wiring */

/**
 * Build the eight backing models over ONE P8 storage facade. This is the only
 * place the resources touch persistence; nothing here allocates its own store.
 */
export function createBackingModels({ storage, clock, idFactory, executionLookup }) {
  if (!storage || typeof storage.get !== 'function') throw invalid('createBackingModels requires a P8 storage facade handle');
  if (!clock || typeof clock.now !== 'function') throw invalid('createBackingModels requires an injected clock');
  if (typeof idFactory !== 'function') throw invalid('createBackingModels requires an injected idFactory');
  if (typeof executionLookup !== 'function') throw invalid('createBackingModels requires an executionLookup');
  return Object.freeze({
    // The DI handle the models validate executions through, exposed so the
    // resource layer can answer 404 before creating anything (no shadow state:
    // the lookup itself reads the execution store).
    executionLookup,
    projects: createProjectSharingModel(storage, { clock, idFactory }),
    audit: createAuditEventModel(storage, { clock, idFactory }),
    sourceControl: createSourceControlModel(storage, { clock, idFactory }),
    dataTables: createDataTableModel(storage, { clock, idFactory }),
    transfers: createTransferModel(storage, { clock, idFactory }),
    workflowVersions: createWorkflowVersionModel(storage, { clock, idFactory }),
    executionRetries: createExecutionRetryModel(storage, { clock, idFactory, executionLookup }),
    executionTags: createExecutionTagModel(storage, { clock, idFactory, executionLookup }),
  });
}

/* ----------------------------------------------------------- validators */

function validateAuditBody(ctx) {
  if (ctx.body === undefined || ctx.body === null) return {};
  const body = bodyObject(ctx);
  for (const key of Object.keys(body)) {
    if (key !== 'additionalOptions') throw invalid(`request/body/${key} is not allowed`);
  }
  const options = body.additionalOptions ?? {};
  if (!isPlainObject(options)) throw invalid('request/body/additionalOptions must be object');
  for (const key of Object.keys(options)) {
    if (!['daysAbandonedWorkflow', 'categories'].includes(key)) {
      throw invalid(`request/body/additionalOptions/${key} is not allowed`);
    }
  }
  if (options.daysAbandonedWorkflow !== undefined
    && (!Number.isInteger(options.daysAbandonedWorkflow) || options.daysAbandonedWorkflow < 0)) {
    throw invalid('request/body/additionalOptions/daysAbandonedWorkflow must be a non-negative integer');
  }
  if (options.categories !== undefined) {
    if (!Array.isArray(options.categories)) throw invalid('request/body/additionalOptions/categories must be array');
    const allowed = ['credentials', 'database', 'nodes', 'filesystem', 'instance'];
    for (const category of options.categories) {
      if (!allowed.includes(category)) {
        throw invalid(`request/body/additionalOptions/categories items must be one of ${allowed.join('|')}`);
      }
    }
  }
  return options;
}

function validateRetryBody(ctx) {
  if (ctx.body === undefined || ctx.body === null) return {};
  const body = bodyObject(ctx);
  for (const key of Object.keys(body)) {
    if (key !== 'loadWorkflow') throw invalid(`request/body/${key} is not allowed`);
  }
  if (body.loadWorkflow !== undefined && typeof body.loadWorkflow !== 'boolean') {
    throw invalid('request/body/loadWorkflow must be boolean');
  }
  return body;
}

function validateTagIdsBody(ctx) {
  if (!Array.isArray(ctx.body)) throw invalid('request/body must be an array of tag ids');
  return ctx.body.map((entry, index) => {
    if (isPlainObject(entry) && typeof entry.id === 'string') return entry.id;
    throw invalid(`request/body/${index} must be an object with an id`);
  });
}

function validateTransferBody(ctx) {
  const body = bodyObject(ctx);
  for (const key of Object.keys(body)) {
    if (key !== 'destinationProjectId') throw invalid(`request/body/${key} is not allowed`);
  }
  return requireString(body.destinationProjectId, 'destinationProjectId');
}

function validatePullBody(ctx) {
  const body = ctx.body === undefined || ctx.body === null ? {} : bodyObject(ctx);
  for (const key of Object.keys(body)) {
    if (!['force', 'autoPublish', 'variables'].includes(key)) throw invalid(`request/body/${key} is not allowed`);
  }
  if (body.force !== undefined && typeof body.force !== 'boolean') throw invalid('request/body/force must be boolean');
  if (body.autoPublish !== undefined && !['none', 'all', 'published'].includes(body.autoPublish)) {
    throw invalid('request/body/autoPublish must be one of none|all|published');
  }
  if (body.variables !== undefined && !isPlainObject(body.variables)) throw invalid('request/body/variables must be object');
  return body;
}

function validateProjectBody(ctx) {
  const body = bodyObject(ctx);
  for (const key of Object.keys(body)) {
    if (key !== 'name') throw invalid(`request/body/${key} is not allowed${key === 'id' || key === 'type' ? ' (read-only)' : ''}`);
  }
  return requireString(body.name, 'name');
}

function validateMemberRelationsBody(ctx) {
  const body = bodyObject(ctx);
  for (const key of Object.keys(body)) {
    if (key !== 'relations') throw invalid(`request/body/${key} is not allowed`);
  }
  if (!Array.isArray(body.relations) || body.relations.length === 0) {
    throw invalid('request/body/relations must be a non-empty array');
  }
  return body.relations.map((relation, index) => {
    if (!isPlainObject(relation)) throw invalid(`request/body/relations/${index} must be object`);
    const userId = requireString(relation.userId, `relations[${index}].userId`);
    for (const key of Object.keys(relation)) {
      if (!['userId', 'role'].includes(key)) throw invalid(`request/body/relations/${index}/${key} is not allowed`);
    }
    const role = toModelRole(relation.role);
    return { userId, role };
  });
}

function validateMemberRoleBody(ctx) {
  const body = bodyObject(ctx);
  for (const key of Object.keys(body)) {
    if (key !== 'role') throw invalid(`request/body/${key} is not allowed`);
  }
  return toModelRole(body.role);
}

function validateCreateTableBody(ctx) {
  const body = bodyObject(ctx);
  for (const key of Object.keys(body)) {
    if (!['name', 'columns', 'projectId'].includes(key)) throw invalid(`request/body/${key} is not allowed`);
  }
  const name = requireString(body.name, 'name');
  if (!Array.isArray(body.columns) || body.columns.length === 0) {
    throw invalid('request/body/columns must be a non-empty array');
  }
  const columns = body.columns.map((column, index) => {
    if (!isPlainObject(column)) throw invalid(`request/body/columns/${index} must be object`);
    for (const key of Object.keys(column)) {
      if (!['name', 'type'].includes(key)) throw invalid(`request/body/columns/${index}/${key} is not allowed`);
    }
    return { name: requireString(column.name, `columns[${index}].name`), type: requireString(column.type, `columns[${index}].type`) };
  });
  return { name, columns, projectId: body.projectId ?? null };
}

function validateRenameTableBody(ctx) {
  const body = bodyObject(ctx);
  for (const key of Object.keys(body)) {
    if (key !== 'name') throw invalid(`request/body/${key} is not allowed`);
  }
  return requireString(body.name, 'name');
}

function validateInsertRowsBody(ctx) {
  const body = bodyObject(ctx);
  for (const key of Object.keys(body)) {
    if (!['data', 'returnType'].includes(key)) throw invalid(`request/body/${key} is not allowed`);
  }
  if (!Array.isArray(body.data) || body.data.length === 0) throw invalid('request/body/data must be a non-empty array');
  for (const [index, row] of body.data.entries()) {
    if (!isPlainObject(row)) throw invalid(`request/body/data/${index} must be object`);
  }
  const returnType = body.returnType ?? 'count';
  if (!['count', 'id', 'all'].includes(returnType)) throw invalid('request/body/returnType must be one of count|id|all');
  return { rows: body.data, returnType };
}

function validateRowMutationBody(ctx, { needsFilter }) {
  const body = bodyObject(ctx);
  for (const key of Object.keys(body)) {
    if (!['filter', 'data', 'returnData', 'dryRun'].includes(key)) throw invalid(`request/body/${key} is not allowed`);
  }
  const filter = needsFilter || body.filter !== undefined ? parseRowFilter(body.filter) : null;
  if (needsFilter && filter === null) throw invalid('request/body/filter must be object');
  if (body.data !== undefined && !isPlainObject(body.data)) throw invalid('request/body/data must be object');
  return {
    filter,
    data: body.data ?? {},
    returnData: body.returnData === true,
    dryRun: body.dryRun === true,
  };
}

function queryBoolean(query, name) {
  if (query[name] === undefined) return false;
  if (query[name] === 'true') return true;
  if (query[name] === 'false') return false;
  throw invalid(`request/query/${name} must be true or false`);
}

/* --------------------------------------------------------- the resources */

/**
 * Route table entries in PUBLIC_API_OPERATIONS form. Handlers close over the
 * backing models; the mount/unmount lifecycle lives in public-api-routes.mjs.
 */
export function backingResourceOperations(models, { store } = {}) {
  if (!models || typeof models !== 'object') throw invalid('backingResourceOperations requires backing models');
  const run = (handler) => withBackingErrors(handler);

  /* ------------------------------------------------------------- audit */

  const generateAudit = run((ctx) => {
    const options = validateAuditBody(ctx);
    const days = options.daysAbandonedWorkflow;
    const filters = Number.isInteger(days) ? { occurredFrom: Date.now() - days * 86_400_000 } : {};
    const summary = models.audit.summarize(filters);
    sendJson(ctx.res, 200, {
      summary,
      additionalOptions: {
        daysAbandonedWorkflow: days ?? null,
        categories: options.categories ?? ['credentials', 'database', 'nodes', 'filesystem', 'instance'],
      },
    });
  });

  /* -------------------------------------------------- execution retries */

  const retryExecution = run((ctx) => {
    const options = validateRetryBody(ctx);
    const executionId = ctx.params.id;
    const execution = models.executionLookup(executionId) ?? null;
    if (execution === null) throw notFoundBody();
    const requestedBy = String(ctx.user?.email ?? ctx.user?.id ?? 'public-api');
    const created = models.executionRetries.createRetry({
      originalExecutionId: executionId,
      requestedBy,
      reason: options.loadWorkflow === true ? 'retry with latest workflow version' : '',
      metadata: options.loadWorkflow === true ? { loadWorkflow: true } : null,
    });
    const approved = models.executionRetries.approveRetry(created.retryId, { version: created.version });
    const executed = models.executionRetries.executeRetry(created.retryId, { version: approved.version });
    sendJson(ctx.res, 200, executionRetryDto(executed));
  });

  /* ---------------------------------------------------- execution tags */

  const getExecutionTags = run((ctx) => {
    const executionId = ctx.params.id;
    if (models.executionLookup(executionId) === null) throw notFoundBody();
    const attachments = models.executionTags.listAttachments({ executionId, limit: 1000 });
    const tags = attachments.attachments.map((attachment) => models.executionTags.getTag(attachment.tagId));
    sendJson(ctx.res, 200, tags.map(executionTagDto));
  });

  const updateExecutionTags = run((ctx) => {
    const executionId = ctx.params.id;
    if (models.executionLookup(executionId) === null) throw notFoundBody();
    const wanted = validateTagIdsBody(ctx);
    const resolved = wanted.map((tagId) => {
      try {
        return models.executionTags.getTag(tagId);
      } catch {
        // upstream QueryFailedError -> 404 'Some tags not found' (verbatim)
        throw new HttpError(404, PUBLIC_API_MESSAGES.TAGS_NOT_FOUND);
      }
    });
    const current = models.executionTags.listAttachments({ executionId, limit: 1000 }).attachments.map((a) => a.tagId);
    const wantedSet = new Set(wanted);
    for (const tagId of current) {
      if (!wantedSet.has(tagId)) models.executionTags.detachTag({ executionId, tagId });
    }
    const currentSet = new Set(current);
    for (const tagId of wanted) {
      if (!currentSet.has(tagId)) models.executionTags.attachTag({ executionId, tagId });
    }
    const after = models.executionTags.listAttachments({ executionId, limit: 1000 }).attachments
      .map((attachment) => models.executionTags.getTag(attachment.tagId));
    sendJson(ctx.res, 200, after.map(executionTagDto));
  });

  /* --------------------------------------------------- workflow versions */

  const getWorkflowVersion = run((ctx) => {
    let version;
    try {
      version = models.workflowVersions.getVersion(ctx.params.versionId);
    } catch {
      // upstream catch-all: any lookup failure is 404 'Version not found'
      throw new HttpError(404, 'Version not found');
    }
    if (version.workflowId !== ctx.params.id) throw new HttpError(404, 'Version not found');
    sendJson(ctx.res, 200, workflowVersionDto(version));
  });

  /* ------------------------------------------------------------ transfer */

  const transferOne = (ctx, kind) => {
    const destinationProjectId = validateTransferBody(ctx);
    const sourceId = ctx.params.id;
    const exists = kind === 'workflow-export'
      ? (store?.workflows?.get?.(sourceId) ?? null)
      : (store?.credentials?.get?.(sourceId) ?? null);
    if (!exists) throw notFoundBody();
    try {
      models.projects.getProject(destinationProjectId);
    } catch (error) {
      if (error?.code?.endsWith('_NOT_FOUND') || error?.code?.endsWith('_INVALID')) throw notFoundBody();
      throw error;
    }
    const actor = String(ctx.user?.email ?? ctx.user?.id ?? 'public-api');
    const bundle = models.transfers.createBundle({
      kind,
      // M15 manifest contract: itemType workflow|credential-ref; credential-ref
      // carries the opaque envelopeRef of the sealed secret envelope (never a
      // secret field). The destination lives in the transfer record.
      manifest: {
        items: [{
          itemType: kind === 'workflow-export' ? 'workflow' : 'credential-ref',
          itemId: sourceId,
          name: String(exists.name ?? ''),
          ...(kind === 'credential-export' ? { envelopeRef: String(sourceId) } : {}),
        }],
      },
      payload: { destinationProjectId },
    });
    const created = models.transfers.createTransfer({
      bundleId: bundle.bundleId,
      fromPrincipal: actor,
      toPrincipal: destinationProjectId,
      metadata: { destinationProjectId },
    });
    const sealed = models.transfers.sealTransfer(created.transferId, { version: created.version });
    models.transfers.completeTransfer(created.transferId, { version: sealed.version });
    sendEmpty(ctx);
  };

  const transferWorkflow = run((ctx) => transferOne(ctx, 'workflow-export'));
  const transferCredential = run((ctx) => transferOne(ctx, 'credential-export'));

  /* ----------------------------------------------------- source control */

  const pull = run((ctx) => {
    const options = validatePullBody(ctx);
    const repositories = models.sourceControl.listRepositories({ limit: 1000 }).repositories
      .filter((repo) => !repo.archived);
    if (repositories.length === 0) {
      // Upstream renders this failure as { status, message }, NOT the uniform
      // { message } envelope — mirrored verbatim.
      sendJson(ctx.res, 400, { status: 'Error', message: 'Source Control is not connected to a repository' });
      return;
    }
    const repo = repositories[0];
    const branches = models.sourceControl.listBranches(repo.repoId, { limit: 1000 }).branches;
    const branch = branches.find((candidate) => candidate.name === (repo.defaultBranch ?? 'main')) ?? branches[0] ?? null;
    const open = branch
      ? models.sourceControl.listChangesets(repo.repoId, { branchId: branch.branchId, limit: 1000 }).changesets
        .filter((changeset) => changeset.state === 'open')
      : [];
    const merged = [];
    for (const openChangeset of open) {
      const changeset = models.sourceControl.getChangeset(repo.repoId, openChangeset.changesetId);
      const done = models.sourceControl.setChangesetState(repo.repoId, changeset.changesetId, 'merged', {
        version: changeset.version,
      });
      if (branch) {
        const freshBranch = models.sourceControl.getBranch(repo.repoId, branch.branchId);
        models.sourceControl.moveBranchHead(repo.repoId, branch.branchId, changeset.changesetId, {
          version: freshBranch.version,
        });
      }
      merged.push(done);
    }
    sendJson(ctx.res, 200, {
      statusResult: {
        current: branch?.headChangesetId ?? null,
        changed: merged.map((changeset) => changeset.changesetId),
        forced: options.force === true,
      },
      variables: { added: [], changed: Object.keys(options.variables ?? {}) },
      workflows: [],
      credentials: [],
      tags: { tags: [], mappings: [] },
    });
  });

  /* -------------------------------------------------------- data tables */

  const listTables = run((ctx) => {
    const { offset, limit } = offsetWindow(ctx.query);
    const all = models.dataTables.listTables({ limit: 1000 }).tables;
    sendJson(ctx.res, 200, pagedEnvelope(all, { offset, limit }, dataTableDto));
  });

  const createTable = run((ctx) => {
    const { name, columns, projectId } = validateCreateTableBody(ctx);
    const table = models.dataTables.createTable({
      name,
      columns,
      metadata: projectId === null ? null : { projectId },
    });
    sendJson(ctx.res, 201, dataTableDto(table));
  });

  const loadTable = (ctx) => {
    try {
      return models.dataTables.getTable(ctx.params.dataTableId);
    } catch (error) {
      if (error?.code?.endsWith('_NOT_FOUND')) throw notFoundBody();
      throw error;
    }
  };

  const getTable = run((ctx) => sendJson(ctx.res, 200, dataTableDto(loadTable(ctx))));

  const updateTable = run((ctx) => {
    const table = loadTable(ctx);
    const name = validateRenameTableBody(ctx);
    const updated = models.dataTables.renameTable(table.tableId, name, { version: table.version });
    sendJson(ctx.res, 200, dataTableDto(updated));
  });

  const deleteTable = run((ctx) => {
    const table = loadTable(ctx);
    models.dataTables.deleteTable(table.tableId, { version: table.version });
    sendEmpty(ctx);
  });

  const allRows = (table) => {
    const collected = [];
    let cursor = null;
    for (;;) {
      const page = models.dataTables.listRows(table.tableId, { cursor, limit: 1000 });
      collected.push(...page.rows);
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    return collected;
  };

  const queryRows = (ctx, table) => {
    let rows = allRows(table);
    if (ctx.query.filter !== undefined && ctx.query.filter !== '') {
      const filter = parseRowFilter(ctx.query.filter);
      rows = rows.filter((row) => rowMatches(row, filter));
    }
    if (ctx.query.search !== undefined && ctx.query.search !== '') {
      rows = rows.filter((row) => rowSearchMatches(row, String(ctx.query.search)));
    }
    rows = sortRows(rows, ctx.query.sortBy);
    return rows;
  };

  const getRows = run((ctx) => {
    const table = loadTable(ctx);
    const { offset, limit } = offsetWindow(ctx.query);
    const rows = queryRows(ctx, table);
    const page = rows.slice(offset, offset + limit);
    sendJson(ctx.res, 200, {
      data: page.map(dataTableRowDto),
      nextCursor: rows.length > offset + limit
        ? encodeNextCursor({ offset, limit, numberOfTotalRecords: rows.length })
        : null,
    });
  });

  const insertRows = run((ctx) => {
    const table = loadTable(ctx);
    const { rows, returnType } = validateInsertRowsBody(ctx);
    const created = rows.map((cells) => models.dataTables.createRow(table.tableId, { cells }));
    if (returnType === 'count') sendJson(ctx.res, 200, { count: created.length });
    else if (returnType === 'id') sendJson(ctx.res, 200, created.map((row) => row.rowId));
    else sendJson(ctx.res, 200, created.map(dataTableRowDto));
  });

  const updateRows = run((ctx) => {
    const table = loadTable(ctx);
    const { filter, data, returnData, dryRun } = validateRowMutationBody(ctx, { needsFilter: true });
    const matched = allRows(table).filter((row) => rowMatches(row, filter));
    if (!dryRun) {
      for (const row of matched) {
        models.dataTables.updateRow(table.tableId, row.rowId, data, { version: row.version });
      }
    }
    const after = dryRun ? matched : matched.map((row) => models.dataTables.getRow(table.tableId, row.rowId));
    sendJson(ctx.res, 200, returnData ? after.map(dataTableRowDto) : true);
  });

  const upsertRow = run((ctx) => {
    const table = loadTable(ctx);
    const { filter, data, returnData, dryRun } = validateRowMutationBody(ctx, { needsFilter: true });
    const matched = allRows(table).filter((row) => rowMatches(row, filter));
    const existing = matched[0] ?? null;
    if (dryRun) {
      sendJson(ctx.res, 200, returnData ? dataTableRowDto(existing ?? { rowId: null, cells: data, createdAt: null, updatedAt: null }) : true);
      return;
    }
    const saved = existing
      ? models.dataTables.updateRow(table.tableId, existing.rowId, data, { version: existing.version })
      : models.dataTables.createRow(table.tableId, { cells: { ...data } });
    sendJson(ctx.res, 200, returnData ? dataTableRowDto(saved) : true);
  });

  const deleteRows = run((ctx) => {
    const table = loadTable(ctx);
    if (ctx.query.filter === undefined || ctx.query.filter === '') {
      throw invalid('request/query/filter is required to delete rows');
    }
    const filter = parseRowFilter(ctx.query.filter);
    const returnData = queryBoolean(ctx.query, 'returnData');
    const dryRun = queryBoolean(ctx.query, 'dryRun');
    const matched = allRows(table).filter((row) => rowMatches(row, filter));
    if (!dryRun) {
      for (const row of matched) {
        models.dataTables.deleteRow(table.tableId, row.rowId, { version: row.version });
      }
    }
    sendJson(ctx.res, 200, returnData ? matched.map(dataTableRowDto) : true);
  });

  /* ----------------------------------------------------------- projects */

  const listProjects = run((ctx) => {
    const { offset, limit } = offsetWindow(ctx.query);
    const all = models.projects.listProjects({ limit: 1000 }).projects;
    sendJson(ctx.res, 200, pagedEnvelope(all, { offset, limit }, projectDto));
  });

  const createProject = run((ctx) => {
    const name = validateProjectBody(ctx);
    const owner = String(ctx.user?.email ?? ctx.user?.id ?? 'public-api');
    const project = models.projects.createProject({ name, owner });
    sendJson(ctx.res, 201, projectDto(project));
  });

  const loadProject = (ctx) => {
    try {
      return models.projects.getProject(ctx.params.projectId);
    } catch (error) {
      if (error?.code?.endsWith('_NOT_FOUND')) throw notFoundBody();
      throw error;
    }
  };

  const updateProject = run((ctx) => {
    const project = loadProject(ctx);
    const name = validateProjectBody(ctx);
    models.projects.renameProject(project.projectId, name, { version: project.version });
    sendEmpty(ctx);
  });

  const deleteProject = run((ctx) => {
    const project = loadProject(ctx);
    models.projects.setArchived(project.projectId, true, { version: project.version });
    sendEmpty(ctx);
  });

  const getProjectUsers = run((ctx) => {
    const project = loadProject(ctx);
    const { offset, limit } = offsetWindow(ctx.query);
    const members = models.projects.listMembers(project.projectId, { limit: 1000 }).members;
    sendJson(ctx.res, 200, pagedEnvelope(members, { offset, limit }, projectMemberDto));
  });

  const addUsersToProject = run((ctx) => {
    const project = loadProject(ctx);
    const relations = validateMemberRelationsBody(ctx);
    for (const relation of relations) {
      models.projects.addMember(project.projectId, relation.userId, relation.role);
    }
    sendEmpty(ctx, 201);
  });

  const changeUserRoleInProject = run((ctx) => {
    const project = loadProject(ctx);
    const role = validateMemberRoleBody(ctx);
    let member;
    try {
      member = models.projects.getMember(project.projectId, ctx.params.userId);
    } catch (error) {
      if (error?.code?.endsWith('_NOT_FOUND')) throw notFoundBody();
      throw error;
    }
    if (!member) throw notFoundBody();
    models.projects.changeMemberRole(project.projectId, ctx.params.userId, role, { version: member.version });
    sendEmpty(ctx);
  });

  const deleteUserFromProject = run((ctx) => {
    const project = loadProject(ctx);
    const member = models.projects.getMember(project.projectId, ctx.params.userId);
    if (!member) throw notFoundBody();
    models.projects.removeMember(project.projectId, ctx.params.userId);
    sendEmpty(ctx);
  });

  const HANDLERS = Object.freeze({
    'POST /audit': generateAudit,
    'POST /executions/:id/retry': retryExecution,
    'GET /executions/:id/tags': getExecutionTags,
    'PUT /executions/:id/tags': updateExecutionTags,
    'GET /workflows/:id/:versionId': getWorkflowVersion,
    'PUT /workflows/:id/transfer': transferWorkflow,
    'PUT /credentials/:id/transfer': transferCredential,
    'POST /source-control/pull': pull,
    'GET /data-tables': listTables,
    'POST /data-tables': createTable,
    'GET /data-tables/:dataTableId': getTable,
    'PATCH /data-tables/:dataTableId': updateTable,
    'DELETE /data-tables/:dataTableId': deleteTable,
    'GET /data-tables/:dataTableId/rows': getRows,
    'POST /data-tables/:dataTableId/rows': insertRows,
    'PATCH /data-tables/:dataTableId/rows/update': updateRows,
    'POST /data-tables/:dataTableId/rows/upsert': upsertRow,
    'DELETE /data-tables/:dataTableId/rows/delete': deleteRows,
    'GET /projects': listProjects,
    'POST /projects': createProject,
    'PUT /projects/:projectId': updateProject,
    'DELETE /projects/:projectId': deleteProject,
    'GET /projects/:projectId/users': getProjectUsers,
    'POST /projects/:projectId/users': addUsersToProject,
    'PATCH /projects/:projectId/users/:userId': changeUserRoleInProject,
    'DELETE /projects/:projectId/users/:userId': deleteUserFromProject,
  });

  // One static route table (BACKING_RESOURCE_ROUTES) drives the runtime mount,
  // the OpenAPI extractor and the mounted-operations spec test: they cannot drift.
  return Object.freeze(BACKING_RESOURCE_ROUTES.map((route) => {
    const handler = HANDLERS[`${route.method} ${route.path}`];
    if (!handler) throw invalid(`no backing handler bound for ${route.method} ${route.path}`);
    return Object.freeze({ ...route, handler });
  }));
}

/**
 * Static route descriptors (method/path/scope/body) — the single source of
 * truth for what a full build mounts, shared by the runtime mount (handlers
 * bind over this table), the OpenAPI extractor and the mounted-operations spec
 * test. Paths/param names mirror the pinned upstream spec EXACTLY (the
 * extractor matches them against reference/n8n .../openapi.yml).
 */
export const BACKING_RESOURCE_ROUTES = Object.freeze([
  { method: 'POST', path: '/audit', scope: 'securityAudit:generate', body: true, bodyOptional: true },
  { method: 'POST', path: '/executions/:id/retry', scope: 'execution:retry', body: true, bodyOptional: true },
  { method: 'GET', path: '/executions/:id/tags', scope: 'executionTags:list' },
  { method: 'PUT', path: '/executions/:id/tags', scope: 'executionTags:update', body: true },
  { method: 'GET', path: '/workflows/:id/:versionId', scope: 'workflow:read' },
  { method: 'PUT', path: '/workflows/:id/transfer', scope: 'workflow:move', body: true },
  { method: 'PUT', path: '/credentials/:id/transfer', scope: 'credential:move', body: true },
  { method: 'POST', path: '/source-control/pull', scope: 'sourceControl:pull', body: true, bodyOptional: true },
  { method: 'GET', path: '/data-tables', scope: 'dataTable:list' },
  { method: 'POST', path: '/data-tables', scope: 'dataTable:create', body: true },
  { method: 'GET', path: '/data-tables/:dataTableId', scope: 'dataTable:read' },
  { method: 'PATCH', path: '/data-tables/:dataTableId', scope: 'dataTable:update', body: true },
  { method: 'DELETE', path: '/data-tables/:dataTableId', scope: 'dataTable:delete' },
  { method: 'GET', path: '/data-tables/:dataTableId/rows', scope: 'dataTableRow:read' },
  { method: 'POST', path: '/data-tables/:dataTableId/rows', scope: 'dataTableRow:create', body: true },
  { method: 'PATCH', path: '/data-tables/:dataTableId/rows/update', scope: 'dataTableRow:update', body: true },
  { method: 'POST', path: '/data-tables/:dataTableId/rows/upsert', scope: 'dataTableRow:upsert', body: true },
  { method: 'DELETE', path: '/data-tables/:dataTableId/rows/delete', scope: 'dataTableRow:delete' },
  { method: 'GET', path: '/projects', scope: 'project:list' },
  { method: 'POST', path: '/projects', scope: 'project:create', body: true },
  { method: 'PUT', path: '/projects/:projectId', scope: 'project:update', body: true },
  { method: 'DELETE', path: '/projects/:projectId', scope: 'project:delete' },
  { method: 'GET', path: '/projects/:projectId/users', scope: 'user:list' },
  { method: 'POST', path: '/projects/:projectId/users', scope: 'project:update', body: true },
  { method: 'PATCH', path: '/projects/:projectId/users/:userId', scope: 'project:update', body: true },
  { method: 'DELETE', path: '/projects/:projectId/users/:userId', scope: 'project:update' },
].map((route) => Object.freeze(route)));
