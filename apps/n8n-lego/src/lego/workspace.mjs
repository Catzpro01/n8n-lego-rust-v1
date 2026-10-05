/**
 * Workspace LEGO — bounded workspace identity and lifecycle foundation (P2.15).
 *
 * PUBLIC CONTRACT: ai.workspace@1.0.0 (owner: manager).
 *
 * This module owns a workspace's bounded identity, metadata, opaque resource
 * references and lifecycle bookkeeping. It deliberately does not own a
 * filesystem, terminal, process, credential, model, tool, MCP or runtime.
 * Those authorities remain separate contracts. A provider may support a
 * workspace kind, but that provider capability is explicit and never becomes
 * a new Workspace operation.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = resolve(HERE, "manifest", "workspace.json");

const MANIFEST = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));

export const WORKSPACE_CONTRACT = Object.freeze({
  id: "ai.workspace",
  version: '1.0.0',
  owner: 'manager',
  fields: Object.freeze([
    'workspaceId', 'kind', 'lifecycle', 'metadata', 'resourceReferences',
    'version', 'createdAt', 'updatedAt',
  ]),
});

export const WORKSPACE_CONTRACT_VERSION = WORKSPACE_CONTRACT.version;
export const WORKSPACE_KINDS = Object.freeze([
  'LOCAL', 'CONTAINER', 'REMOTE', 'VPS', 'EPHEMERAL', 'PERSISTENT',
]);
export const WORKSPACE_LIFECYCLE = Object.freeze({
  states: Object.freeze(['declared', 'created', 'mounted', 'active', 'released']),
  initial: 'declared',
  terminal: Object.freeze(['released']),
  transitions: Object.freeze({
    declared: Object.freeze(['created']),
    created: Object.freeze(['mounted', 'released']),
    mounted: Object.freeze(['active', 'released']),
    active: Object.freeze(['released']),
    released: Object.freeze([]),
  }),
});
export const WORKSPACE_LIFECYCLE_STATES = WORKSPACE_LIFECYCLE.states;
export const WORKSPACE_OPERATIONS = Object.freeze([
  "workspace.create",
  "workspace.describe",
  "workspace.mount",
  "workspace.release",
]);
export const WORKSPACE_PERMISSIONS = Object.freeze([
  'ai:workspace:read',
  'ai:workspace:create',
]);
export const WORKSPACE_FIELDS = WORKSPACE_CONTRACT.fields;

export const WORKSPACE_LIMITS = Object.freeze({
  maxWorkspaces: 256,
  maxIdentifierLength: 64,
  maxMetadataBytes: 16 * 1024,
  maxMetadataKeys: 32,
  maxMetadataDepth: 4,
  maxMetadataKeyLength: 64,
  maxResourceReferences: 16,
  maxReferenceIdLength: 128,
});

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const REFERENCE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const FORBIDDEN_KEY = /(?:credential|secret|password|token|cookie|authorization|api[-_]?key|private[-_]?key|host[-_]?path|filesystem|terminal|process|command|shell|mcp|runtime|provider)/i;

export class WorkspaceError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'WorkspaceError';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function fail(message, details = {}) {
  throw new WorkspaceError('lego.contract_violation', message, details);
}

function notFound(workspaceId) {
  throw new WorkspaceError('workspace.project_not_found', `workspace '${workspaceId}' does not exist`, { workspaceId });
}

function conflict(message, details = {}) {
  throw new WorkspaceError('storage.conflict', message, details);
}

function unavailable(message, details = {}) {
  throw new WorkspaceError('lego.unavailable', message, details);
}

function transition(message, details = {}) {
  throw new WorkspaceError('lego.interaction_mismatch', message, details);
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function freezeDeep(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeDeep(child);
  return Object.freeze(value);
}

function stableJson(value) {
  return JSON.stringify(value);
}

function bytes(value) {
  return Buffer.byteLength(stableJson(value), 'utf8');
}

function iso(now) {
  const value = now();
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) fail('now() must return an ISO timestamp');
  return value;
}

function assertPlainObject(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${field} must be a plain object`);
}

function assertId(value, field, pattern = ID_RE, max = WORKSPACE_LIMITS.maxIdentifierLength) {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || !pattern.test(value)) {
    fail(`${field} must be an opaque identifier matching ${pattern} and be 1..${max} characters`);
  }
}

function validateJsonValue(value, path, depth, limits, seen = new Set()) {
  if (depth > limits.maxMetadataDepth) fail(`${path} exceeds metadata nesting depth ${limits.maxMetadataDepth}`, { limit: limits.maxMetadataDepth });
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(`${path} contains a non-finite number`);
    return;
  }
  if (typeof value !== 'object') fail(`${path} contains unsupported value type '${typeof value}'`);
  if (seen.has(value)) fail(`${path} contains a cyclic value`);
  seen.add(value);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) validateJsonValue(value[i], `${path}[${i}]`, depth + 1, limits, seen);
  } else {
    const keys = Object.keys(value);
    if (keys.length > limits.maxMetadataKeys) fail(`${path} exceeds metadata key limit ${limits.maxMetadataKeys}`, { limit: limits.maxMetadataKeys });
    for (const key of keys) {
      if (key.length === 0 || key.length > limits.maxMetadataKeyLength) fail(`${path} has a metadata key longer than ${limits.maxMetadataKeyLength} characters`);
      if (FORBIDDEN_KEY.test(key)) fail(`${path}.${key} is forbidden: Workspace metadata cannot carry authority, credentials or runtime handles`);
      validateJsonValue(value[key], `${path}.${key}`, depth + 1, limits, seen);
    }
  }
  seen.delete(value);
}

function validateMetadata(metadata, limits) {
  assertPlainObject(metadata, 'metadata');
  validateJsonValue(metadata, 'metadata', 0, limits);
  const safe = clone(metadata);
  const size = bytes(safe);
  if (size > limits.maxMetadataBytes) fail(`metadata exceeds ${limits.maxMetadataBytes} bytes`, { size, limit: limits.maxMetadataBytes });
  return safe;
}

function validateReferences(references, limits) {
  if (references === undefined) return [];
  if (!Array.isArray(references)) fail('resourceReferences must be an array');
  if (references.length > limits.maxResourceReferences) fail(`resourceReferences exceeds ${limits.maxResourceReferences}`, { limit: limits.maxResourceReferences });
  const seen = new Set();
  return references.map((reference, index) => {
    if (typeof reference !== 'string') fail(`resourceReferences[${index}] must be an opaque identifier`);
    assertId(reference, `resourceReferences[${index}]`, REFERENCE_ID_RE, limits.maxReferenceIdLength);
    if (seen.has(reference)) conflict(`resourceReferences contains duplicate '${reference}'`, { reference });
    seen.add(reference);
    return reference;
  });
}

function publicWorkspace(record) {
  return freezeDeep(clone(record));
}

// ---------------------------------------------------------------------------
// Provider boundary
// ---------------------------------------------------------------------------

/**
 * Minimal provider seam. The provider stores opaque Workspace records only.
 * It does not receive a path, command, credential, runtime handle or browser
 * object. `supports(kind)` is mandatory so provider capabilities cannot become
 * implicit Workspace capabilities.
 */
export class InMemoryWorkspaceProvider {
  constructor() {
    this.store = new Map();
  }

  supports(kind) {
    return kind === 'EPHEMERAL';
  }

  put(record) {
    this.store.set(record.workspaceId, clone(record));
  }

  get(workspaceId) {
    const record = this.store.get(workspaceId);
    return record ? clone(record) : null;
  }

  list() {
    return Array.from(this.store.values()).map(clone);
  }

  clear() {
    this.store.clear();
  }

  get size() {
    return this.store.size;
  }
}

function makeManager(options = {}) {
  const provider = options.provider ?? new InMemoryWorkspaceProvider();
  const now = options.now ?? (() => new Date().toISOString());
  const limits = Object.freeze({ ...WORKSPACE_LIMITS, ...(options.limits ?? {}) });

  if (typeof provider.supports !== 'function' || typeof provider.put !== 'function'
    || typeof provider.get !== 'function' || typeof provider.list !== 'function') {
    fail('provider must implement { supports, put, get, list }');
  }

  function get(workspaceId) {
    assertId(workspaceId, 'workspaceId');
    return provider.get(workspaceId);
  }

  function assertKind(kind) {
    if (typeof kind !== 'string' || !WORKSPACE_KINDS.includes(kind)) {
      fail(`kind must be one of ${WORKSPACE_KINDS.join(', ')}`);
    }
  }

  function create(input) {
    assertPlainObject(input, 'create input');
    const {
      workspaceId,
      kind = 'EPHEMERAL',
      metadata = {},
      resourceReferences = [],
    } = input;
    assertId(workspaceId, 'workspaceId');
    assertKind(kind);
    const safeMetadata = validateMetadata(metadata, limits);
    const safeReferences = validateReferences(resourceReferences, limits);
    const existing = get(workspaceId);
    if (existing) conflict(`workspace '${workspaceId}' already exists`, { workspaceId });
    if (provider.list().length >= limits.maxWorkspaces) {
      fail('workspace store has reached its bounded workspace limit', { limit: limits.maxWorkspaces });
    }
    if (!provider.supports(kind)) {
      unavailable(`provider does not support workspace kind '${kind}'`, { kind });
    }
    const timestamp = iso(now);
    const record = {
      workspaceId,
      kind,
      lifecycle: 'created',
      metadata: safeMetadata,
      resourceReferences: safeReferences,
      version: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    provider.put(record);
    return publicWorkspace(record);
  }

  function describe(input) {
    assertPlainObject(input, 'describe input');
    assertId(input.workspaceId, 'workspaceId');
    const record = get(input.workspaceId);
    return record ? publicWorkspace(record) : null;
  }

  function mount(input) {
    assertPlainObject(input, 'mount input');
    assertId(input.workspaceId, 'workspaceId');
    const existing = get(input.workspaceId);
    if (!existing) notFound(input.workspaceId);
    if (existing.lifecycle === 'released') transition(`released workspace '${input.workspaceId}' cannot be mounted`, { workspaceId: input.workspaceId });
    if (existing.lifecycle === 'active') return publicWorkspace(existing);
    if (!['created', 'mounted'].includes(existing.lifecycle)) {
      transition(`workspace '${input.workspaceId}' cannot be mounted from '${existing.lifecycle}'`, { workspaceId: input.workspaceId, lifecycle: existing.lifecycle });
    }
    const record = {
      ...existing,
      lifecycle: 'active',
      version: existing.version + 1,
      updatedAt: iso(now),
    };
    provider.put(record);
    return publicWorkspace(record);
  }

  function release(input) {
    assertPlainObject(input, 'release input');
    assertId(input.workspaceId, 'workspaceId');
    const existing = get(input.workspaceId);
    if (!existing) notFound(input.workspaceId);
    if (existing.lifecycle === 'released') return publicWorkspace(existing);
    const record = {
      ...existing,
      lifecycle: 'released',
      version: existing.version + 1,
      updatedAt: iso(now),
    };
    provider.put(record);
    return publicWorkspace(record);
  }

  return Object.freeze({
    contract: WORKSPACE_CONTRACT_VERSION,
    limits,
    provider,
    create,
    describe,
    mount,
    release,
    get count() { return provider.list().length; },
    clear: () => provider.clear?.(),
  });
}

export function createWorkspaceManager(options = {}) {
  return makeManager(options);
}

export const createWorkspaceProvider = () => new InMemoryWorkspaceProvider();
export const WORKSPACE_MANIFEST = Object.freeze(clone(MANIFEST));
