/**
 * P5-M03 — the public REST API (`/api/v1`), first surface: the boundary plus
 * the workflows resource.
 *
 * Mirrors pinned n8n 2.9.4 `packages/cli/src/public-api` (express +
 * express-openapi-validator). The request pipeline runs in upstream order:
 *
 *   1. route match     unknown path -> 404 `not found`; known path, wrong
 *                      method -> 405 `<METHOD> method not allowed`
 *   2. security        X-N8N-API-KEY via authenticateMachineCredential();
 *                      missing -> 401 `'X-N8N-API-KEY' header required`,
 *                      anything else invalid -> 401 `unauthorized` (both are
 *                      recorded upstream goldens: publicApiNoKey/publicApiBadKey)
 *   3. body parse      invalid JSON -> 400 `Invalid JSON in request body`
 *   4. validation      query/path/body against the pinned OpenAPI schemas ->
 *                      400 with ajv-style `request/...` messages
 *   5. key scope       the principal's effective scopes (key ∩ owner's CURRENT
 *                      grant) through the P5.3 `authorize()` kernel -> 403
 *                      `Forbidden`
 *   6. handler         `{ message }` error bodies, never the `/rest` envelope
 *
 * Every error body is `{ message }`, exactly like upstream's error handler.
 * `/rest/*` keeps accepting session cookies only; `/api/v1/*` accepts API keys
 * only (no cookie, so no ambient authority and no CSRF surface).
 *
 * Deliberate differences from pinned n8n, all fail-closed:
 *   - key scopes are ALWAYS enforced. Upstream skips `apiKeyHasScope` unless
 *     the enterprise `apiKeyScopes` licence is on; here a key only ever acts
 *     within the scopes it was issued with (deny-by-default invariant).
 *   - this product has a single workspace and no project/sharing model yet, so
 *     `projectId` filtering and `shared`/`activeVersion` relations are not
 *     served, and `/workflows/{id}/transfer` is not mounted (404).
 *   - activation mirrors `/rest/workflows/:id/activate`: it publishes the
 *     current version (`activeVersionId = versionId`); there is no trigger
 *     registration service to consult, so no trigger-node check is claimed.
 *
 * P5-M08 adds tags, variables (licence-gated like the community edition),
 * executions list/get/delete and `GET /api/v1/openapi.yml`, a spec of exactly
 * the mounted operations (see scripts/extract-public-api-spec.py).
 *
 * P5-M09 adds credentials (list, create, update, delete, schema) and users
 * (list, get, create, delete, change role) over the same backing stores the
 * editor uses (`src/compat/credentials.mjs` + the P5.5 vault, and the users
 * collection behind the `PublicUser` whitelist). Secrets are never returned:
 * the credential surface publishes the sanitised record, exactly like
 * upstream's `sanitizeCredentials`, so `data` cannot leave the server.
 *
 * Not mounted yet: `/docs` (a Swagger-UI decision, DEC-0022 — the spec is
 * served, a bundled UI is not); projects, audit, source-control, data-tables,
 * workflow/credential transfer, workflow versions, execution retry and
 * execution tags (P5-M10, no backing model).
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { HttpError } from '../compat/error.mjs';
import { sendJson } from '../compat/response.mjs';
import { apiKeyPermissionRegistry, authenticateMachineCredential } from './api-key-routes.mjs';
import { mergeCredentialData } from '../compat/credentials.mjs';
import { authorize } from './security/authorization.mjs';

export const PUBLIC_API_PREFIX = '/api/v1';
export const PUBLIC_API_KEY_HEADER = 'x-n8n-api-key';

/** Upstream messages, verbatim. */
export const PUBLIC_API_MESSAGES = Object.freeze({
  KEY_REQUIRED: "'X-N8N-API-KEY' header required",
  UNAUTHORIZED: 'unauthorized',
  FORBIDDEN: 'Forbidden',
  NOT_FOUND_ROUTE: 'not found',
  NOT_FOUND: 'Not Found',
  INVALID_JSON: 'Invalid JSON in request body',
  INVALID_CURSOR: 'An invalid cursor was provided',
  TAGS_NOT_FOUND: 'Some tags not found',
  TAG_EXISTS: 'Tag already exists',
  RUNNING_EXECUTION: 'Cannot delete a running execution',
});

export const PUBLIC_API_LIMITS = Object.freeze({ DEFAULT_LIMIT: 100, MAX_LIMIT: 250 });

/* ------------------------------------------------------------ schemas */

const WORKFLOW_SETTINGS_KEYS = Object.freeze([
  'saveExecutionProgress',
  'saveManualExecutions',
  'saveDataErrorExecution',
  'saveDataSuccessExecution',
  'executionTimeout',
  'errorWorkflow',
  'timezone',
  'executionOrder',
  'callerPolicy',
  'callerIds',
  'timeSavedPerExecution',
  'availableInMCP',
]);

/** node.yml: property -> expected JSON type (readOnly props are marked). */
const NODE_PROPERTIES = Object.freeze({
  id: 'string',
  name: 'string',
  webhookId: 'string',
  disabled: 'boolean',
  notesInFlow: 'boolean',
  notes: 'string',
  type: 'string',
  typeVersion: 'number',
  executeOnce: 'boolean',
  alwaysOutputData: 'boolean',
  retryOnFail: 'boolean',
  maxTries: 'number',
  waitBetweenTries: 'number',
  continueOnFail: 'boolean',
  onError: 'string',
  position: 'array',
  parameters: 'object',
  credentials: 'object',
  createdAt: 'readOnly',
  updatedAt: 'readOnly',
});

/** workflow.yml top level. */
const WORKFLOW_REQUIRED = Object.freeze(['name', 'nodes', 'connections', 'settings']);
const WORKFLOW_READ_ONLY = Object.freeze(['id', 'active', 'createdAt', 'updatedAt', 'tags']);
const WORKFLOW_WRITABLE = Object.freeze(['name', 'nodes', 'connections', 'settings', 'staticData', 'shared', 'activeVersion']);

function jsonType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function invalid(message) {
  return new HttpError(400, message);
}

/**
 * Validates a workflow body the way the pinned OpenAPI schema does
 * (`additionalProperties: false`, required, readOnly, types). Returns the
 * body; throws 400 with an ajv-style message on the first violation.
 */
export function validateWorkflowBody(body) {
  if (jsonType(body) !== 'object') throw invalid('request/body must be object');
  for (const key of Object.keys(body)) {
    if (WORKFLOW_READ_ONLY.includes(key)) throw invalid(`request/body/${key} is read-only`);
    if (!WORKFLOW_WRITABLE.includes(key)) throw invalid('request/body must NOT have additional properties');
  }
  for (const key of WORKFLOW_REQUIRED) {
    if (!(key in body)) throw invalid(`request/body must have required property '${key}'`);
  }
  if (typeof body.name !== 'string') throw invalid('request/body/name must be string');
  if (!Array.isArray(body.nodes)) throw invalid('request/body/nodes must be array');
  body.nodes.forEach((node, index) => validateNode(node, index));
  if (jsonType(body.connections) !== 'object') throw invalid('request/body/connections must be object');
  if (jsonType(body.settings) !== 'object') throw invalid('request/body/settings must be object');
  for (const key of Object.keys(body.settings)) {
    if (!WORKFLOW_SETTINGS_KEYS.includes(key)) throw invalid('request/body/settings must NOT have additional properties');
  }
  if ('staticData' in body && body.staticData !== null) {
    const kind = jsonType(body.staticData);
    if (kind === 'string') {
      try {
        JSON.parse(body.staticData);
      } catch {
        throw invalid('request/body/staticData must match format "jsonString"');
      }
    } else if (kind !== 'object') {
      throw invalid('request/body/staticData must match a schema in anyOf');
    }
  }
  return body;
}

function validateNode(node, index) {
  const at = `request/body/nodes/${index}`;
  if (jsonType(node) !== 'object') throw invalid(`${at} must be object`);
  for (const [key, value] of Object.entries(node)) {
    const expected = NODE_PROPERTIES[key];
    if (expected === undefined) throw invalid(`${at} must NOT have additional properties`);
    if (expected === 'readOnly') throw invalid(`${at}/${key} is read-only`);
    if (jsonType(value) !== expected) throw invalid(`${at}/${key} must be ${expected}`);
    if (key === 'position' && !value.every((item) => typeof item === 'number')) {
      throw invalid(`${at}/position must be array of numbers`);
    }
  }
}

/** OpenAPI boolean query coercion (express-openapi-validator coerceTypes). */
function queryBoolean(query, name) {
  const raw = query[name];
  if (raw === undefined) return undefined;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw invalid(`request/query/${name} must be boolean`);
}

function queryLimit(query) {
  const raw = query.limit;
  if (raw === undefined) return PUBLIC_API_LIMITS.DEFAULT_LIMIT;
  const value = Number(raw);
  if (raw === '' || !Number.isFinite(value)) throw invalid('request/query/limit must be number');
  if (value > PUBLIC_API_LIMITS.MAX_LIMIT) throw invalid(`request/query/limit must be <= ${PUBLIC_API_LIMITS.MAX_LIMIT}`);
  // Upstream passes the number to `take`; a non-positive or fractional page is
  // not a meaningful request, so it is floored to a sane page size.
  return Math.max(1, Math.floor(value));
}

/* ---------------------------------------------------------- pagination */

/** Upstream `encodeNextCursor` (offset flavour). */
export function encodeNextCursor({ offset, limit, numberOfTotalRecords }) {
  if (numberOfTotalRecords > offset + limit) {
    return Buffer.from(JSON.stringify({ limit, offset: offset + limit })).toString('base64');
  }
  return null;
}

/** Upstream `validCursor`: a cursor overrides limit/offset; garbage is a 400. */
export function decodeOffsetCursor(cursor) {
  let decoded;
  try {
    decoded = JSON.parse(Buffer.from(String(cursor), 'base64').toString());
  } catch {
    throw invalid(PUBLIC_API_MESSAGES.INVALID_CURSOR);
  }
  const offset = Number(decoded?.offset);
  const limit = Number(decoded?.limit);
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > PUBLIC_API_LIMITS.MAX_LIMIT) {
    throw invalid(PUBLIC_API_MESSAGES.INVALID_CURSOR);
  }
  return { offset, limit };
}

/** Upstream `encodeNextCursor` (lastId flavour, used by executions). */
export function encodeLastIdCursor({ lastId, limit, numberOfNextRecords }) {
  if (numberOfNextRecords) return Buffer.from(JSON.stringify({ lastId, limit })).toString('base64');
  return null;
}

/**
 * Upstream `validCursor` + `decodeCursor`: a cursor is either the offset or the
 * lastId flavour (`'offset' in decoded` decides). Garbage is a 400.
 */
export function decodeCursor(cursor) {
  let decoded;
  try {
    decoded = JSON.parse(Buffer.from(String(cursor), 'base64').toString());
  } catch {
    throw invalid(PUBLIC_API_MESSAGES.INVALID_CURSOR);
  }
  if (jsonType(decoded) !== 'object') throw invalid(PUBLIC_API_MESSAGES.INVALID_CURSOR);
  if ('offset' in decoded) return decodeOffsetCursor(cursor);
  const limit = Number(decoded.limit);
  const lastId = decoded.lastId;
  if ((typeof lastId !== 'string' && typeof lastId !== 'number') || !/^\d+$/.test(String(lastId))
    || !Number.isInteger(limit) || limit < 1 || limit > PUBLIC_API_LIMITS.MAX_LIMIT) {
    throw invalid(PUBLIC_API_MESSAGES.INVALID_CURSOR);
  }
  return { lastId: String(lastId), limit };
}

/** Offset pagination window from `limit`/`cursor` (tags, variables). */
function offsetWindow(query) {
  if (query.cursor) {
    // Upstream: a lastId-flavour cursor only sets `limit`; offset stays 0.
    const decoded = decodeCursor(query.cursor);
    return 'offset' in decoded ? decoded : { offset: 0, limit: decoded.limit };
  }
  return { offset: 0, limit: queryLimit(query) };
}

/* ---------------------------------------------------------- DTOs */

function tagDto(tag) {
  return { id: tag.id, name: tag.name, createdAt: tag.createdAt ?? null, updatedAt: tag.updatedAt ?? null };
}

/** The upstream WorkflowEntity projection this product can honestly serve. */
export function publicWorkflowDto(workflow, { excludePinnedData = false } = {}) {
  const dto = {
    id: workflow.id,
    name: workflow.name,
    active: Boolean(workflow.active),
    isArchived: Boolean(workflow.isArchived),
    createdAt: workflow.createdAt,
    updatedAt: workflow.updatedAt,
    nodes: workflow.nodes ?? [],
    connections: workflow.connections ?? {},
    settings: workflow.settings ?? {},
    staticData: workflow.staticData ?? null,
    meta: workflow.meta ?? null,
    pinData: workflow.pinData ?? {},
    versionId: workflow.versionId ?? null,
    activeVersionId: workflow.active ? (workflow.activeVersionId ?? workflow.versionId ?? null) : null,
    triggerCount: workflow.triggerCount ?? 0,
    tags: (workflow.tags ?? []).map(tagDto),
  };
  if (excludePinnedData) delete dto.pinData;
  return dto;
}

/* ---------------------------------------------------------- handlers */

function loadWorkflow(ctx) {
  const workflow = ctx.store.workflows.get(ctx.params.id);
  if (!workflow) throw new HttpError(404, PUBLIC_API_MESSAGES.NOT_FOUND);
  return workflow;
}

function normaliseStaticData(value) {
  if (typeof value === 'string') return JSON.parse(value);
  return value ?? null;
}

function listWorkflows(ctx) {
  let offset = 0;
  let limit = queryLimit(ctx.query);
  if (ctx.query.cursor) ({ offset, limit } = decodeOffsetCursor(ctx.query.cursor));
  const active = queryBoolean(ctx.query, 'active');
  const excludePinnedData = queryBoolean(ctx.query, 'excludePinnedData') ?? false;
  const name = typeof ctx.query.name === 'string' ? ctx.query.name.trim().toLowerCase() : undefined;

  let candidates = ctx.store.workflows.all();
  if (typeof ctx.query.tags === 'string') {
    // Upstream getWorkflowIdsViaTags: the INTERSECTION of the workflows of
    // every tag that exists; unknown names are ignored, none found -> empty.
    const names = ctx.query.tags.split(',').map((tag) => tag.trim());
    const tagIds = ctx.store.tags.all().filter((tag) => names.includes(tag.name)).map((tag) => tag.id);
    candidates = tagIds.length === 0
      ? []
      : candidates.filter((workflow) => tagIds.every((id) => (workflow.tags ?? []).some((tag) => tag.id === id)));
  }
  const matching = candidates
    .filter((workflow) => (name !== undefined ? String(workflow.name).toLowerCase().includes(name) : true))
    .filter((workflow) => (active !== undefined ? Boolean(workflow.active) === active : true))
    // Stable order so cursors are deterministic across pages.
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || String(a.id).localeCompare(String(b.id)));

  sendJson(ctx.res, 200, {
    data: matching.slice(offset, offset + limit).map((workflow) => publicWorkflowDto(workflow, { excludePinnedData })),
    nextCursor: encodeNextCursor({ offset, limit, numberOfTotalRecords: matching.length }),
  });
}

function createWorkflow(ctx) {
  const body = validateWorkflowBody(ctx.body);
  const now = new Date().toISOString();
  const workflow = ctx.store.workflows.insert({
    name: body.name,
    description: null,
    active: false,
    nodes: body.nodes.map((node) => ({ ...node, id: typeof node.id === 'string' && node.id !== '' ? node.id : randomUUID() })),
    connections: body.connections,
    settings: body.settings,
    pinData: {},
    staticData: normaliseStaticData(body.staticData),
    meta: null,
    tags: [],
    versionId: randomUUID(),
    createdAt: now,
    updatedAt: now,
  });
  ctx.logger?.info?.('workflow created', { workflowId: workflow.id, via: 'public-api' });
  sendJson(ctx.res, 200, publicWorkflowDto(workflow));
}

function getWorkflow(ctx) {
  const excludePinnedData = queryBoolean(ctx.query, 'excludePinnedData') ?? false;
  sendJson(ctx.res, 200, publicWorkflowDto(loadWorkflow(ctx), { excludePinnedData }));
}

function updateWorkflow(ctx) {
  const existing = loadWorkflow(ctx);
  const body = validateWorkflowBody(ctx.body);
  const versionId = randomUUID();
  const patch = {
    name: body.name,
    nodes: body.nodes.map((node) => ({ ...node, id: typeof node.id === 'string' && node.id !== '' ? node.id : randomUUID() })),
    connections: body.connections,
    settings: body.settings,
    updatedAt: new Date().toISOString(),
    versionId,
  };
  if ('staticData' in body) patch.staticData = normaliseStaticData(body.staticData);
  // Upstream `publishIfActive: true` — an active workflow publishes the update.
  if (existing.active) patch.activeVersionId = versionId;
  const updated = ctx.store.workflows.update(existing.id, patch);
  sendJson(ctx.res, 200, publicWorkflowDto(updated));
}

function deleteWorkflow(ctx) {
  const existing = loadWorkflow(ctx);
  ctx.store.workflows.remove(existing.id);
  sendJson(ctx.res, 200, publicWorkflowDto(existing));
}

function activateWorkflow(ctx) {
  const existing = loadWorkflow(ctx);
  const updated = ctx.store.workflows.update(existing.id, {
    active: true,
    activeVersionId: existing.versionId ?? null,
    updatedAt: new Date().toISOString(),
  });
  sendJson(ctx.res, 200, publicWorkflowDto(updated));
}

function deactivateWorkflow(ctx) {
  const existing = loadWorkflow(ctx);
  const updated = ctx.store.workflows.update(existing.id, {
    active: false,
    activeVersionId: null,
    updatedAt: new Date().toISOString(),
  });
  sendJson(ctx.res, 200, publicWorkflowDto(updated));
}

function getWorkflowTags(ctx) {
  const existing = loadWorkflow(ctx);
  sendJson(ctx.res, 200, (existing.tags ?? []).map(tagDto));
}

function updateWorkflowTags(ctx) {
  const body = ctx.body;
  if (!Array.isArray(body)) throw invalid('request/body must be array');
  body.forEach((item, index) => {
    if (jsonType(item) !== 'object') throw invalid(`request/body/${index} must be object`);
    if (!('id' in item)) throw invalid(`request/body/${index} must have required property 'id'`);
    if (typeof item.id !== 'string') throw invalid(`request/body/${index}/id must be string`);
    for (const key of Object.keys(item)) {
      if (key !== 'id') throw invalid(`request/body/${index} must NOT have additional properties`);
    }
  });
  const existing = loadWorkflow(ctx);
  const wanted = [...new Set(body.map((item) => item.id))];
  const tags = wanted.map((id) => ctx.store.tags.get(id));
  if (tags.some((tag) => !tag)) throw new HttpError(404, PUBLIC_API_MESSAGES.TAGS_NOT_FOUND);
  ctx.store.workflows.update(existing.id, { tags, updatedAt: new Date().toISOString() });
  sendJson(ctx.res, 200, tags.map(tagDto));
}

/* ---------------------------------------------------------- tags (P5-M08) */

const TAG_READ_ONLY = Object.freeze(['id', 'createdAt', 'updatedAt']);
const TAG_NAME_MAX = 24;

/** `tag.yml`: additionalProperties false, required name, readOnly id/dates. */
export function validateTagBody(body) {
  if (jsonType(body) !== 'object') throw invalid('request/body must be object');
  for (const key of Object.keys(body)) {
    if (TAG_READ_ONLY.includes(key)) throw invalid(`request/body/${key} is read-only`);
    if (key !== 'name') throw invalid('request/body must NOT have additional properties');
  }
  if (!('name' in body)) throw invalid("request/body must have required property 'name'");
  if (typeof body.name !== 'string') throw invalid('request/body/name must be string');
  return body;
}

function loadTag(ctx) {
  const tag = ctx.store.tags.get(ctx.params.id);
  if (!tag) throw new HttpError(404, PUBLIC_API_MESSAGES.NOT_FOUND);
  return tag;
}

/**
 * Upstream `TagService.save`: entity validation (`@Length(1, 24)`) and the
 * unique index both reject inside the handler's try/catch, which answers
 * EVERY save failure with 409 `Tag already exists` — mirrored verbatim.
 */
function assertTagSavable(ctx, name, selfId = null) {
  const duplicate = ctx.store.tags.find((tag) => tag.name === name && tag.id !== selfId);
  if (name.length < 1 || name.length > TAG_NAME_MAX || duplicate) {
    throw new HttpError(409, PUBLIC_API_MESSAGES.TAG_EXISTS);
  }
}

/** Workflows embed tag copies; keep them in step with the tag table. */
function syncWorkflowTags(ctx, tagId, replacement) {
  for (const workflow of ctx.store.workflows.filter((candidate) => (candidate.tags ?? []).some((tag) => tag.id === tagId))) {
    const tags = replacement
      ? workflow.tags.map((tag) => (tag.id === tagId ? replacement : tag))
      : workflow.tags.filter((tag) => tag.id !== tagId);
    ctx.store.workflows.update(workflow.id, { tags });
  }
}

function listTags(ctx) {
  const { offset, limit } = offsetWindow(ctx.query);
  const all = ctx.store.tags.all();
  sendJson(ctx.res, 200, {
    data: all.slice(offset, offset + limit).map(tagDto),
    nextCursor: encodeNextCursor({ offset, limit, numberOfTotalRecords: all.length }),
  });
}

function createTag(ctx) {
  const name = ctx.body.name.trim();
  assertTagSavable(ctx, name);
  const now = new Date().toISOString();
  const tag = ctx.store.tags.insert({ name, createdAt: now, updatedAt: now });
  ctx.logger?.info?.('tag created', { tagId: tag.id, via: 'public-api' });
  sendJson(ctx.res, 201, tagDto(tag));
}

function getTag(ctx) {
  sendJson(ctx.res, 200, tagDto(loadTag(ctx)));
}

function updateTag(ctx) {
  const existing = loadTag(ctx);
  const name = ctx.body.name.trim();
  assertTagSavable(ctx, name, existing.id);
  const updated = ctx.store.tags.update(existing.id, { name, updatedAt: new Date().toISOString() });
  syncWorkflowTags(ctx, existing.id, updated);
  sendJson(ctx.res, 200, tagDto(updated));
}

function deleteTag(ctx) {
  const existing = loadTag(ctx);
  ctx.store.tags.remove(existing.id);
  syncWorkflowTags(ctx, existing.id, null);
  ctx.logger?.info?.('tag deleted', { tagId: existing.id, via: 'public-api' });
  sendJson(ctx.res, 200, tagDto(existing));
}

/* ----------------------------------------------------- variables (P5-M08) */

/**
 * Licensed features of this build. It is the community edition (see
 * `/rest/license`): no enterprise feature is licensed, so upstream's
 * `isLicensed(feature)` middleware answers 403 before the scope check.
 */
export const PUBLIC_API_LICENSED_FEATURES = Object.freeze([]);

export function featureNotLicensedMessage(feature) {
  return `Your license does not allow for ${feature}. To enable ${feature}, please upgrade to a license that supports this feature.`;
}

const VARIABLE_READ_ONLY = Object.freeze(['id', 'type']);
const VARIABLE_WRITABLE = Object.freeze(['key', 'value', 'projectId']);

/** `variable.create.yml` (create and update share it). */
export function validateVariableBody(body) {
  if (jsonType(body) !== 'object') throw invalid('request/body must be object');
  for (const key of Object.keys(body)) {
    if (VARIABLE_READ_ONLY.includes(key)) throw invalid(`request/body/${key} is read-only`);
    if (!VARIABLE_WRITABLE.includes(key)) throw invalid('request/body must NOT have additional properties');
  }
  for (const key of ['key', 'value']) {
    if (!(key in body)) throw invalid(`request/body must have required property '${key}'`);
    if (typeof body[key] !== 'string') throw invalid(`request/body/${key} must be string`);
  }
  if ('projectId' in body && body.projectId !== null && typeof body.projectId !== 'string') {
    throw invalid('request/body/projectId must be string');
  }
  return body;
}

function validateVariableQuery(ctx) {
  queryLimit(ctx.query);
  if (ctx.query.state !== undefined && ctx.query.state !== 'empty') {
    throw invalid('request/query/state must be equal to one of the allowed values: empty');
  }
}

/**
 * Unreachable while `feat:variables` is unlicensed: the licence gate answers
 * first. Kept fail-closed so a future licence flag cannot silently expose an
 * unimplemented store.
 */
function variablesNotImplemented() {
  throw new HttpError(403, featureNotLicensedMessage('feat:variables'));
}

/* ---------------------------------------------------- executions (P5-M08) */

const EXECUTION_STATUS_FILTER = Object.freeze(['canceled', 'error', 'running', 'success', 'waiting']);

function validateExecutionId(ctx) {
  if (!/^\d+$/.test(ctx.params.id)) throw invalid('request/params/id must be number');
}

function validateExecutionListQuery(ctx) {
  queryBoolean(ctx.query, 'includeData');
  queryLimit(ctx.query);
  const { status } = ctx.query;
  if (status !== undefined && !EXECUTION_STATUS_FILTER.includes(status)) {
    throw invalid(`request/query/status must be equal to one of the allowed values: ${EXECUTION_STATUS_FILTER.join(', ')}`);
  }
}

/**
 * The executions a key owner may see: those of workflows that exist
 * (upstream `getSharedWorkflowIds`; this product has one workspace, so every
 * stored workflow is shared). Executions without a saved workflow are not
 * listed, exactly like upstream's `workflowId IN (...)` condition.
 */
function accessibleExecutions(ctx) {
  const workflowIds = new Set(ctx.store.workflows.all().map((workflow) => workflow.id));
  return ctx.store.executions.filter((execution) => execution.workflowId != null && workflowIds.has(execution.workflowId));
}

/** `ExecutionRepository.getExecutionsForPublicApi` select list. */
function executionListDto(execution, includeData) {
  const dto = {
    id: String(execution.id),
    finished: Boolean(execution.finished),
    mode: execution.mode ?? 'manual',
    retryOf: execution.retryOf ?? null,
    retrySuccessId: execution.retrySuccessId ?? null,
    status: execution.status,
    startedAt: execution.startedAt ?? null,
    stoppedAt: execution.stoppedAt ?? null,
    workflowId: execution.workflowId,
    waitTill: execution.waitTill ?? null,
  };
  return includeData ? withExecutionData(dto, execution) : dto;
}

/** `findSingleExecution`: every ExecutionEntity column. */
function executionEntityDto(execution, includeData) {
  const dto = {
    id: String(execution.id),
    finished: Boolean(execution.finished),
    mode: execution.mode ?? 'manual',
    retryOf: execution.retryOf ?? null,
    retrySuccessId: execution.retrySuccessId ?? null,
    status: execution.status,
    createdAt: execution.createdAt ?? null,
    startedAt: execution.startedAt ?? null,
    stoppedAt: execution.stoppedAt ?? null,
    deletedAt: null,
    workflowId: execution.workflowId,
    waitTill: execution.waitTill ?? null,
    storedAt: 'db',
  };
  return includeData ? withExecutionData(dto, execution) : dto;
}

function withExecutionData(dto, execution) {
  return { ...dto, data: execution.data ?? {}, workflowData: execution.workflowData ?? null, customData: execution.customData ?? {} };
}

function loadExecution(ctx) {
  const execution = accessibleExecutions(ctx).find((candidate) => String(candidate.id) === ctx.params.id);
  if (!execution) throw new HttpError(404, PUBLIC_API_MESSAGES.NOT_FOUND);
  return execution;
}

function listExecutions(ctx) {
  let limit = queryLimit(ctx.query);
  let lastId;
  if (ctx.query.cursor) {
    const decoded = decodeCursor(ctx.query.cursor);
    limit = decoded.limit;
    // Upstream: an offset-flavour cursor carries no lastId -> first page.
    if ('lastId' in decoded) lastId = decoded.lastId;
  }
  const includeData = queryBoolean(ctx.query, 'includeData') ?? false;
  const { status, workflowId } = ctx.query;

  const workflowIds = new Set(ctx.store.workflows.all().map((workflow) => workflow.id));
  if (workflowIds.size === 0 || (typeof workflowId === 'string' && workflowId !== '' && !workflowIds.has(workflowId))) {
    sendJson(ctx.res, 200, { data: [], nextCursor: null });
    return;
  }

  const matches = (execution, below) => {
    if (typeof workflowId === 'string' && workflowId !== '' && execution.workflowId !== workflowId) return false;
    if (below !== undefined && !(Number(execution.id) < Number(below))) return false;
    // Running executions are excluded unless explicitly asked for.
    if (status !== 'running' && execution.status === 'running') return false;
    if (status === 'error') return execution.status === 'error' || execution.status === 'crashed';
    if (status !== undefined) return execution.status === status;
    return true;
  };
  const candidates = accessibleExecutions(ctx).slice().sort((a, b) => Number(b.id) - Number(a.id));
  const page = candidates.filter((execution) => matches(execution, lastId)).slice(0, limit);
  const newLastId = page.length === 0 ? '0' : String(page[page.length - 1].id);
  const numberOfNextRecords = Math.min(limit, candidates.filter((execution) => matches(execution, newLastId)).length);

  sendJson(ctx.res, 200, {
    data: page.map((execution) => executionListDto(execution, includeData)),
    nextCursor: encodeLastIdCursor({ lastId: newLastId, limit, numberOfNextRecords }),
  });
}

function getExecution(ctx) {
  const includeData = queryBoolean(ctx.query, 'includeData') ?? false;
  sendJson(ctx.res, 200, executionEntityDto(loadExecution(ctx), includeData));
}

function deleteExecution(ctx) {
  const execution = loadExecution(ctx);
  if (execution.status === 'running') throw invalid(PUBLIC_API_MESSAGES.RUNNING_EXECUTION);
  ctx.store.executions.remove(execution.id);
  ctx.logger?.info?.('execution deleted', { executionId: String(execution.id), via: 'public-api' });
  sendJson(ctx.res, 200, executionEntityDto(execution, false));
}

/* ------------------------------------------------ credentials (P5-M09) */

/**
 * The credential-type index the editor also uses, so a secret field is
 * recognised by exactly the same rule on both surfaces. It is injected by
 * `server.mjs` from the node catalog; a missing catalog makes every type
 * unknown, which makes every value secret. Fail closed.
 */
function credentialIndexFor(ctx) {
  return ctx.credentialTypes ?? null;
}

/** Upstream `sanitizeCredentials`: the entity without `data` and `shared`. */
function credentialDto(credential) {
  return {
    id: credential.id,
    name: credential.name,
    type: credential.type,
    createdAt: credential.createdAt ?? null,
    updatedAt: credential.updatedAt ?? null,
    isResolvable: Boolean(credential.isResolvable),
  };
}

/**
 * The credential the caller may act on. This product has one workspace and no
 * project/sharing model, so a credential is either the caller's own (the
 * personal-project owner rule of `credentialScopesFor`) or the caller is an
 * admin who may see everything. Nobody else reaches it.
 */
function accessibleCredential(ctx, user) {
  const all = ctx.store.credentials.all();
  const admin = user?.role === 'global:owner' || user?.role === 'global:admin';
  return all.filter((credential) => admin || credential.ownerId === user?.id);
}

function loadCredential(ctx, user) {
  const credential = accessibleCredential(ctx, user).find((candidate) => candidate.id === ctx.params.id);
  // Upstream answers `Not Found` (not `Forbidden`) for a credential the caller
  // may not see, so the existence of another tenant's credential does not leak.
  if (!credential) throw new HttpError(404, PUBLIC_API_MESSAGES.NOT_FOUND);
  return credential;
}

/**
 * `toJsonSchema` (upstream credentials.service): the credential type's
 * properties as a JSON Schema, with the `options` enums resolved and the
 * `displayOptions` dependencies expressed as if/then/else. `hidden`
 * properties are filtered out first, exactly like the upstream middleware.
 */
export function credentialTypeJsonSchema(properties) {
  const schema = { additionalProperties: false, type: 'object', properties: {}, required: [] };
  const optionsValues = {};
  const dependencies = new Map();
  const required = [];

  for (const property of Array.isArray(properties) ? properties : []) {
    if (!property || typeof property.name !== 'string' || property.type === 'hidden') continue;
    if (property.type === 'options') {
      optionsValues[property.name] = (property.options ?? []).map((option) => option.value);
      schema.properties[property.name] = { type: 'string', enum: optionsValues[property.name] };
    } else {
      schema.properties[property.name] = { type: property.type };
    }
    if (property.required) required.push(property.name);

    const shown = property.displayOptions?.show;
    if (shown && typeof shown === 'object') {
      const [dependantName] = Object.keys(shown);
      const values = Array.isArray(shown[dependantName]) ? shown[dependantName] : [shown[dependantName]];
      const dependantValue = values[0];
      // One if/then/else block per dependant name + value pair, so two
      // properties depending on the same field with different values each get
      // their own condition instead of overwriting one another.
      const key = `${dependantName}:${JSON.stringify(dependantValue)}`;
      if (!dependencies.has(key)) {
        dependencies.set(key, {
          if: { properties: { [dependantName]: { enum: [dependantValue] } } },
          then: { allOf: [] },
          else: { allOf: [] },
        });
      }
      dependencies.get(key).then.allOf.push({ required: [property.name] });
      dependencies.get(key).else.allOf.push({ not: { required: [property.name] } });
    }
  }
  schema.required = required;
  const allOf = [...dependencies.values()];
  if (allOf.length > 0) schema.allOf = allOf;
  return schema;
}

/** The credential-type properties for a type name, or null when unknown. */
function credentialPropertiesFor(ctx, typeName) {
  const types = ctx.credentialTypeList ?? [];
  return types.find((entry) => entry?.name === typeName)?.properties ?? null;
}

/**
 * Upstream `validateCredentialData`: validate a data bag against the type's
 * schema, answering 400 with the upstream message shape on the first failure.
 * An unknown type has no schema, so its data cannot be validated and the write
 * is refused rather than stored unvalidated.
 */
function validateCredentialData(ctx, typeName, data) {
  const properties = credentialPropertiesFor(ctx, typeName);
  if (properties === null) throw invalid('req.body.type is not a known type');
  if (jsonType(data) !== 'object') throw invalid('request.body.data must be object');
  const schema = credentialTypeJsonSchema(properties);
  for (const key of Object.keys(data)) {
    if (schema.additionalProperties === false && !(key in schema.properties)) {
      throw invalid(`request.body.data should NOT have additional properties: '${key}'`);
    }
  }
  for (const key of schema.required) {
    if (!(key in data)) throw invalid(`request.body.data must have required property '${key}'`);
  }
  for (const [key, value] of Object.entries(data)) {
    const expected = schema.properties[key]?.type;
    if (expected === undefined) continue;
    if (jsonType(value) !== expected) {
      throw invalid(`request.body.data/${key} must be ${expected}`);
    }
    if (Array.isArray(schema.properties[key]?.enum) && !schema.properties[key].enum.includes(value)) {
      throw invalid(`request.body.data/${key} must be equal to one of the allowed values: ${schema.properties[key].enum.join(', ')}`);
    }
  }
  // `if/then/else` conditions: a property only required when its dependant
  // holds the value the condition names.
  for (const condition of schema.allOf ?? []) {
    const [name, matcher] = Object.entries(condition.if.properties)[0];
    const value = data[name];
    if (!matcher.enum.includes(value)) {
      for (const clause of condition.else.allOf) {
        if (clause.not?.required?.some((key) => key in data)) {
          throw invalid(`request.body.data must NOT be valid: '${clause.not.required.find((key) => key in data)}' is not allowed`);
        }
      }
    } else {
      for (const clause of condition.then.allOf) {
        for (const key of clause.required ?? []) {
          if (!(key in data)) throw invalid(`request.body.data must have required property '${key}'`);
        }
      }
    }
  }
  return data;
}

function listCredentials(ctx) {
  const { offset, limit } = offsetWindow(ctx.query);
  const filterType = typeof ctx.query.type === 'string' ? ctx.query.type : undefined;
  const filterName = typeof ctx.query.name === 'string' ? ctx.query.name.trim().toLowerCase() : undefined;
  const all = accessibleCredential(ctx, ctx.user)
    .filter((credential) => (filterType === undefined ? true : credential.type === filterType))
    .filter((credential) => (filterName === undefined ? true : String(credential.name).toLowerCase().includes(filterName)))
    // Upstream orders by createdAt DESC.
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)) || String(b.id).localeCompare(String(a.id)));
  sendJson(ctx.res, 200, {
    // `data` is deliberately absent: upstream's list select carries no secret.
    data: all.slice(offset, offset + limit).map(credentialDto),
    nextCursor: encodeNextCursor({ offset, limit, numberOfTotalRecords: all.length }),
  });
}

function createCredential(ctx) {
  const body = ctx.body ?? {};
  if (typeof body.name !== 'string' || body.name.trim() === '') throw invalid('request/body/name must NOT have fewer than 1 characters');
  if (typeof body.type !== 'string' || body.type.trim() === '') throw invalid('request/body/type must NOT have fewer than 1 characters');
  validateCredentialData(ctx, body.type, body.data ?? {});
  const vault = ctx.vault;
  if (!vault) throw new HttpError(503, 'Credential encryption is unavailable', { code: 'lego.unavailable' });
  const now = new Date().toISOString();
  // The id is minted before sealing because it is part of the ciphertext's
  // associated data: the blob is bound to this exact credential.
  const id = randomUUID();
  const sealed = vault.sealData({ id, type: body.type, tenantId: 'default' }, body.data ?? {});
  const credential = ctx.store.credentials.insert({
    id,
    name: body.name,
    type: body.type,
    ...sealed,
    tenantId: 'default',
    ownerId: ctx.user.id,
    credentialVersion: 1,
    createdAt: now,
    updatedAt: now,
  });
  ctx.logger?.info?.('credential created', { credentialId: credential.id, type: credential.type, via: 'public-api' });
  // Upstream returns the sanitised entity: no `data`, no `shared`.
  sendJson(ctx.res, 200, credentialDto(credential));
}

function updateCredential(ctx) {
  const existing = loadCredential(ctx, ctx.user);
  const body = ctx.body ?? {};
  const changingType = body.type !== undefined && body.type !== existing.type;
  if (body.type !== undefined && (typeof body.type !== 'string' || body.type.trim() === '')) {
    throw invalid('request/body/type must NOT have fewer than 1 characters');
  }
  const nextType = changingType ? body.type : existing.type;
  // Upstream: changing the type without new data is refused, because the
  // stored data belongs to the old type.
  if (changingType && body.data === undefined) {
    throw invalid('request.body.data is required when changing credential type. The existing data cannot be used with the new type.');
  }
  if (body.data !== undefined) validateCredentialData(ctx, nextType, body.data);
  if (body.name !== undefined && (typeof body.name !== 'string' || body.name.trim() === '')) {
    throw invalid('request/body/name must NOT have fewer than 1 characters');
  }
  const vault = ctx.vault;
  if (!vault) throw new HttpError(503, 'Credential encryption is unavailable', { code: 'lego.unavailable' });
  // The blank sentinel means "unchanged", so echoing a redacted view back must
  // not overwrite the stored secret with the literal sentinel string.
  const merged = mergeCredentialData(vault.openData(existing), body.data ?? {});
  const sealed = vault.sealData({ ...existing, type: nextType, tenantId: existing.tenantId ?? 'default' }, merged);
  const updated = ctx.store.credentials.update(existing.id, (current) => {
    const { data: _legacyPlaintext, ...rest } = current;
    return {
      ...rest,
      ...sealed,
      name: typeof body.name === 'string' ? body.name : existing.name,
      type: nextType,
      // Bumping the version invalidates any SecretRef minted against the
      // previous contents.
      credentialVersion: (existing.credentialVersion ?? 1) + 1,
      updatedAt: new Date().toISOString(),
    };
  });
  ctx.logger?.info?.('credential updated', { credentialId: updated.id, via: 'public-api' });
  sendJson(ctx.res, 200, credentialDto(updated));
}

function deleteCredential(ctx) {
  const existing = loadCredential(ctx, ctx.user);
  ctx.store.credentials.remove(existing.id);
  ctx.logger?.info?.('credential deleted', { credentialId: existing.id, via: 'public-api' });
  sendJson(ctx.res, 200, credentialDto(existing));
}

function getCredentialSchema(ctx) {
  const typeName = ctx.params.credentialTypeName;
  const properties = credentialPropertiesFor(ctx, typeName);
  if (properties === null) throw new HttpError(404, PUBLIC_API_MESSAGES.NOT_FOUND);
  sendJson(ctx.res, 200, credentialTypeJsonSchema(properties));
}

/* ------------------------------------------------------- users (P5-M09) */

/**
 * Upstream `clean` / `pickUserSelectableProperties`: the selectable subset of
 * a user. The password hash, the MFA sealed secret, the recovery-code digests
 * and the API keys are NOT in this list and never leave the server — the same
 * whitelist the editor's `PublicUser` is built from.
 */
const USER_SELECTABLE = Object.freeze(['id', 'email', 'firstName', 'lastName', 'createdAt', 'updatedAt', 'isPending']);
const USER_ROLES = Object.freeze(['global:owner', 'global:admin', 'global:member', 'global:chatUser']);

function userDto(user, { includeRole = false } = {}) {
  const dto = {
    id: user.id,
    email: user.email,
    firstName: user.firstName ?? '',
    lastName: user.lastName ?? '',
    createdAt: user.createdAt ?? null,
    updatedAt: user.updatedAt ?? user.createdAt ?? null,
    isPending: user.isPending ?? false,
  };
  if (includeRole) dto.role = user.role ?? null;
  return dto;
}

/**
 * Upstream `getUser`: an identifier that IS an id resolves by id, anything else
 * by email. Upstream decides that with a UUID test because its ids are UUIDs;
 * this product mints 16-hex ids (`createOwner`), so a UUID test would make
 * every id lookup fall through to an email lookup and 404. Resolving by id
 * first is the same rule without the shape assumption: an email address is
 * never a stored id, and a stored id is never an email address.
 */
function findUser(store, identifier) {
  const users = store.users.all();
  return users.find((user) => user.id === identifier) ?? users.find((user) => user.email === identifier) ?? null;
}

function listUsers(ctx) {
  const { offset, limit } = offsetWindow(ctx.query);
  const includeRole = queryBoolean(ctx.query, 'includeRole') ?? false;
  const all = ctx.store.users.all()
    .slice()
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || String(a.id).localeCompare(String(b.id)));
  sendJson(ctx.res, 200, {
    data: all.slice(offset, offset + limit).map((user) => userDto(user, { includeRole })),
    nextCursor: encodeNextCursor({ offset, limit, numberOfTotalRecords: all.length }),
  });
}

function getUser(ctx) {
  const includeRole = queryBoolean(ctx.query, 'includeRole') ?? false;
  const user = findUser(ctx.store, ctx.params.id);
  if (!user) throw new HttpError(404, `Could not find user with id: ${ctx.params.id}`);
  ctx.logger?.info?.('user retrieved', { userId: ctx.user.id, via: 'public-api' });
  sendJson(ctx.res, 200, userDto(user, { includeRole }));
}

function createUser(ctx) {
  const body = ctx.body ?? {};
  if (!Array.isArray(body)) throw invalid('request/body must be array');
  const invited = [];
  for (const [index, entry] of body.entries()) {
    if (jsonType(entry) !== 'object') throw invalid(`request/body/${index} must be object`);
    for (const key of Object.keys(entry)) {
      if (key !== 'email' && key !== 'role') throw invalid(`request/body/${index} must NOT have additional properties`);
    }
    if (typeof entry.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(entry.email)) {
      throw invalid(`request/body/${index}/email must match format "email"`);
    }
    if (entry.role !== undefined && !USER_ROLES.includes(entry.role)) {
      throw invalid(`request/body/${index}/role must be equal to one of the allowed values: ${USER_ROLES.join(', ')}`);
    }
    const email = entry.email.toLowerCase();
    if (ctx.store.users.find((user) => user.email === email)) {
      // Upstream reports a per-row failure inside the 200 envelope.
      invited.push({ email, error: 'User already exists' });
      continue;
    }
    const now = new Date().toISOString();
    const user = ctx.store.users.insert({
      id: randomUUID(),
      email,
      firstName: '',
      lastName: '',
      role: entry.role ?? 'global:member',
      // An invited user has no password until they accept; the account is
      // pending and cannot sign in, so no hash is minted here.
      isPending: true,
      createdAt: now,
      updatedAt: now,
      settings: {},
    });
    ctx.logger?.info?.('user invited', { userId: user.id, email, via: 'public-api' });
    invited.push({ user: userDto(user, { includeRole: true }) });
  }
  sendJson(ctx.res, 200, { data: invited });
}

function deleteUser(ctx) {
  const user = findUser(ctx.store, ctx.params.id);
  if (!user) throw new HttpError(404, PUBLIC_API_MESSAGES.NOT_FOUND);
  // The instance owner is the account that can mint API keys; removing it
  // would lock the instance out of its own public API.
  if (user.role === 'global:owner') throw new HttpError(403, PUBLIC_API_MESSAGES.FORBIDDEN);
  ctx.store.users.remove(user.id);
  ctx.logger?.info?.('user deleted', { userId: user.id, via: 'public-api' });
  ctx.res.writeHead(204);
  ctx.res.end();
}

function changeUserRole(ctx) {
  const user = findUser(ctx.store, ctx.params.id);
  if (!user) throw new HttpError(404, PUBLIC_API_MESSAGES.NOT_FOUND);
  const body = ctx.body ?? {};
  if (typeof body.newRoleName !== 'string' || !USER_ROLES.includes(body.newRoleName)) {
    throw invalid(`request/body/newRoleName must be equal to one of the allowed values: ${USER_ROLES.join(', ')}`);
  }
  // An instance always has exactly one owner: promoting somebody else would
  // make two, demoting the owner would make none.
  if (user.role === 'global:owner' || body.newRoleName === 'global:owner') {
    throw new HttpError(403, PUBLIC_API_MESSAGES.FORBIDDEN);
  }
  const updated = ctx.store.users.update(user.id, { role: body.newRoleName, updatedAt: new Date().toISOString() });
  ctx.logger?.info?.('user role changed', { userId: updated.id, role: updated.role, via: 'public-api' });
  ctx.res.writeHead(204);
  ctx.res.end();
}

/* ---------------------------------------------------------- routes */

/**
 * The mounted operations: method, path template, the API-key scope upstream
 * guards it with (`apiKeyHasScope`), and the handler.
 */
export const PUBLIC_API_OPERATIONS = Object.freeze([
  { method: 'GET', path: '/workflows', scope: 'workflow:list', handler: listWorkflows },
  { method: 'POST', path: '/workflows', scope: 'workflow:create', handler: createWorkflow, body: true },
  { method: 'GET', path: '/workflows/:id', scope: 'workflow:read', handler: getWorkflow },
  { method: 'PUT', path: '/workflows/:id', scope: 'workflow:update', handler: updateWorkflow, body: true },
  { method: 'DELETE', path: '/workflows/:id', scope: 'workflow:delete', handler: deleteWorkflow },
  { method: 'POST', path: '/workflows/:id/activate', scope: 'workflow:activate', handler: activateWorkflow },
  { method: 'POST', path: '/workflows/:id/deactivate', scope: 'workflow:deactivate', handler: deactivateWorkflow },
  { method: 'GET', path: '/workflows/:id/tags', scope: 'workflowTags:list', handler: getWorkflowTags },
  { method: 'PUT', path: '/workflows/:id/tags', scope: 'workflowTags:update', handler: updateWorkflowTags, body: true },
  // P5-M08. `validate` runs before the licence and scope gates, like
  // express-openapi-validator runs before upstream's handler middlewares.
  { method: 'GET', path: '/tags', scope: 'tag:list', handler: listTags, validate: (ctx) => offsetWindow(ctx.query) },
  { method: 'POST', path: '/tags', scope: 'tag:create', handler: createTag, body: true, validate: (ctx) => validateTagBody(ctx.body) },
  { method: 'GET', path: '/tags/:id', scope: 'tag:read', handler: getTag },
  { method: 'PUT', path: '/tags/:id', scope: 'tag:update', handler: updateTag, body: true, validate: (ctx) => validateTagBody(ctx.body) },
  { method: 'DELETE', path: '/tags/:id', scope: 'tag:delete', handler: deleteTag },
  { method: 'GET', path: '/variables', scope: 'variable:list', licensed: 'feat:variables', handler: variablesNotImplemented, validate: validateVariableQuery },
  { method: 'POST', path: '/variables', scope: 'variable:create', licensed: 'feat:variables', handler: variablesNotImplemented, body: true, validate: (ctx) => validateVariableBody(ctx.body) },
  { method: 'PUT', path: '/variables/:id', scope: 'variable:update', licensed: 'feat:variables', handler: variablesNotImplemented, body: true, validate: (ctx) => validateVariableBody(ctx.body) },
  { method: 'DELETE', path: '/variables/:id', scope: 'variable:delete', licensed: 'feat:variables', handler: variablesNotImplemented },
  { method: 'GET', path: '/executions', scope: 'execution:list', handler: listExecutions, validate: validateExecutionListQuery },
  { method: 'GET', path: '/executions/:id', scope: 'execution:read', handler: getExecution, validate: (ctx) => { validateExecutionId(ctx); queryBoolean(ctx.query, 'includeData'); } },
  { method: 'DELETE', path: '/executions/:id', scope: 'execution:delete', handler: deleteExecution, validate: validateExecutionId },

  /* P5-M09 — credentials. `sanitizeCredentials` upstream: no `data` leaves. */
  { method: 'GET', path: '/credentials', scope: 'credential:list', handler: listCredentials, validate: (ctx) => offsetWindow(ctx.query) },
  { method: 'POST', path: '/credentials', scope: 'credential:create', handler: createCredential, body: true },
  { method: 'PATCH', path: '/credentials/:id', scope: 'credential:update', handler: updateCredential, body: true },
  { method: 'DELETE', path: '/credentials/:id', scope: 'credential:delete', handler: deleteCredential },
  // Upstream mounts this operation with no scope guard (it publishes a schema,
  // never a secret) and ahead of the validator: `scope: 'public'`.
  { method: 'GET', path: '/credentials/schema/:credentialTypeName', scope: 'public', handler: getCredentialSchema },

  /* P5-M09 — users. Owner/admin only upstream (`apiKeyHasScopeWithGlobalScopeFallback`). */
  { method: 'GET', path: '/users', scope: 'user:list', handler: listUsers, validate: (ctx) => offsetWindow(ctx.query) },
  { method: 'POST', path: '/users', scope: 'user:create', handler: createUser, body: true },
  { method: 'GET', path: '/users/:id', scope: 'user:read', handler: getUser, validate: (ctx) => queryBoolean(ctx.query, 'includeRole') },
  { method: 'DELETE', path: '/users/:id', scope: 'user:delete', handler: deleteUser },
  { method: 'PATCH', path: '/users/:id/role', scope: 'user:changeRole', handler: changeUserRole, body: true },
].map((operation) => Object.freeze(operation)));

function compile(template) {
  const names = [];
  const pattern = template.replace(/:([A-Za-z]+)/g, (_, name) => {
    names.push(name);
    return '([^/]+)';
  });
  return { regex: new RegExp(`^${pattern}/?$`), names };
}

const COMPILED = PUBLIC_API_OPERATIONS.map((operation) => ({ operation, ...compile(operation.path) }));

/* ------------------------------------------------- P5-M10 runtime mount table
 *
 * The backing resources (projects, audit, source-control, data-tables,
 * transfer, workflow versions, execution retry, execution tags) are mounted at
 * server start and can be UNMOUNTED without touching their backing models or
 * the history they wrote — rollback = unmount routes (P5-M10 CP-04).
 * matchPublicApiRoute sees base + mounted; the served OpenAPI document covers
 * the full build (specOperations below).
 */
const MOUNTED_OPERATIONS = [];
let COMPILED_MOUNTED = [];

export function mountPublicApiOperations(operations) {
  if (!Array.isArray(operations)) throw new TypeError('mountPublicApiOperations expects an operation array');
  MOUNTED_OPERATIONS.splice(0, MOUNTED_OPERATIONS.length, ...operations);
  COMPILED_MOUNTED = MOUNTED_OPERATIONS.map((operation) => ({ operation, ...compile(operation.path) }));
  return function unmountPublicApiOperations() {
    MOUNTED_OPERATIONS.splice(0);
    COMPILED_MOUNTED = [];
  };
}

export function mountedOperations() {
  return [...PUBLIC_API_OPERATIONS, ...MOUNTED_OPERATIONS];
}

/**
 * Route match in express-openapi-validator order. `path` is relative to
 * `/api/v1`. Returns `{ operation, params }`, or throws 404/405.
 */
export function matchPublicApiRoute(method, path) {
  let pathKnown = false;
  for (const { operation, regex, names } of [...COMPILED, ...COMPILED_MOUNTED]) {
    const found = regex.exec(path);
    if (!found) continue;
    pathKnown = true;
    if (operation.method !== method) continue;
    const params = {};
    names.forEach((name, index) => {
      params[name] = decodeURIComponent(found[index + 1]);
    });
    return { operation, params };
  }
  if (pathKnown) throw new HttpError(405, `${method} method not allowed`);
  throw new HttpError(404, PUBLIC_API_MESSAGES.NOT_FOUND_ROUTE);
}

export function isPublicApiPath(pathname) {
  return pathname === PUBLIC_API_PREFIX || pathname.startsWith(`${PUBLIC_API_PREFIX}/`);
}

async function readJsonBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'request entity too large');
    chunks.push(chunk);
  }
  if (size === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, PUBLIC_API_MESSAGES.INVALID_JSON);
  }
}

/* ---------------------------------------------------------- openapi.yml */

export const PUBLIC_API_SPEC_PATH = '/openapi.yml';
// @scale-out-safe: immutable memoization of a static JSON file that ships with
// the package (data/public-api-openapi.json). Every process renders the same
// string and nothing mutates it; no state crosses a process boundary.
let specCache = null;

/**
 * Minimal YAML emitter: block mappings/sequences, every string and key as a
 * JSON double-quoted scalar (valid YAML 1.2), so no dependency is needed and
 * no value can change meaning.
 */
export function toYaml(value, indent = '') {
  const scalar = (item) => (typeof item === 'string' ? JSON.stringify(item) : item === null ? 'null' : String(item));
  const isEmpty = (item) => (Array.isArray(item) ? item.length === 0 : jsonType(item) === 'object' && Object.keys(item).length === 0);
  const nested = (item) => (Array.isArray(item) || jsonType(item) === 'object') && !isEmpty(item);
  const inlineValue = (item) => (Array.isArray(item) ? '[]' : jsonType(item) === 'object' ? '{}' : scalar(item));
  const lines = [];
  if (Array.isArray(value)) {
    for (const item of value) {
      if (nested(item)) lines.push(`${indent}-\n${toYaml(item, `${indent}  `)}`);
      else lines.push(`${indent}- ${inlineValue(item)}`);
    }
  } else {
    for (const [key, item] of Object.entries(value)) {
      if (nested(item)) lines.push(`${indent}${JSON.stringify(key)}:\n${toYaml(item, `${indent}  `)}`);
      else lines.push(`${indent}${JSON.stringify(key)}: ${inlineValue(item)}`);
    }
  }
  return lines.join('\n');
}

/** The mounted-operations spec (data/public-api-openapi.json) as YAML. */
export function publicApiSpecYaml() {
  if (specCache === null) {
    const spec = JSON.parse(readFileSync(new URL('../../data/public-api-openapi.json', import.meta.url), 'utf8'));
    specCache = `---\n${toYaml(spec)}\n`;
  }
  return specCache;
}

/**
 * Serves one `/api/v1/*` request end to end. Never throws: every failure
 * becomes an upstream-shaped `{ message }` body. Returns the authenticated
 * owner's email (for the access log) or null.
 */
export async function handlePublicApiRequest(ctx) {
  const { req, res, store, config, logger } = ctx;
  let ownerEmail = null;
  try {
    const relative = ctx.path.slice(PUBLIC_API_PREFIX.length) || '/';
    // Upstream registers this route ahead of the validator and auth: public.
    if (ctx.method === 'GET' && relative === PUBLIC_API_SPEC_PATH) {
      res.writeHead(200, { 'content-type': 'text/yaml; charset=UTF-8' });
      res.end(publicApiSpecYaml());
      return ownerEmail;
    }
    const { operation, params } = matchPublicApiRoute(ctx.method, relative);

    const presented = req.headers[PUBLIC_API_KEY_HEADER];
    if (presented === undefined || presented === '') throw new HttpError(401, PUBLIC_API_MESSAGES.KEY_REQUIRED);
    const verified = authenticateMachineCredential({ store, config, presented: Array.isArray(presented) ? presented[0] : presented, logger });
    if (!verified.ok) throw new HttpError(401, PUBLIC_API_MESSAGES.UNAUTHORIZED);
    ownerEmail = verified.owner.email ?? null;

    ctx.params = params;
    ctx.principal = verified.principal;
    ctx.user = verified.owner;
    if (operation.body) {
      ctx.body = await readJsonBody(req, config.maxBodyBytes);
      // bodyOptional (P5-M10): upstream allows an absent body on some POST/PUT
      // routes (POST /audit, POST /executions/{id}/retry, POST /source-control/pull).
      if (ctx.body === undefined && !operation.bodyOptional) throw invalid('request/body must be object');
    }

    if (operation.validate) operation.validate(ctx);
    if (operation.licensed && !PUBLIC_API_LICENSED_FEATURES.includes(operation.licensed)) {
      throw new HttpError(403, featureNotLicensedMessage(operation.licensed));
    }

    // `public` marks an operation upstream mounts with no scope guard at all
    // (GET /credentials/schema/{type} publishes a schema, never a secret).
    // Every other operation goes through the P5.3 kernel: unknown permission
    // fails closed, and expiry and permission are re-checked here rather than
    // trusted from issuance.
    if (operation.scope !== 'public') {
      const decision = authorize(
        { principal: verified.principal, action: operation.scope, resourceType: operation.scope.startsWith('workflow') ? 'workflow' : operation.scope.split(':')[0], resourceId: params.id },
        { registry: apiKeyPermissionRegistry(config) },
      );
      if (!decision.allowed) throw new HttpError(403, PUBLIC_API_MESSAGES.FORBIDDEN);
    }

    await operation.handler(ctx);
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    const message = error instanceof HttpError ? error.message : 'Internal Server Error';
    if (status >= 500) logger?.error?.('public api request failed', { cause: error instanceof Error ? error.message : String(error) });
    if (!res.headersSent) sendJson(res, status, { message });
  }
  return ownerEmail;
}
