/**
 * P2.15 Workspace LEGO contract and bounded-foundation tests.
 *
 * These tests exercise only the published ai.workspace surface. They prove that
 * Workspace owns identity, metadata, opaque references and logical lifecycle,
 * while refusing execution authority and provider leakage.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  InMemoryWorkspaceProvider,
  WORKSPACE_CONTRACT,
  WORKSPACE_CONTRACT_VERSION,
  WORKSPACE_FIELDS,
  WORKSPACE_KINDS,
  WORKSPACE_LIMITS,
  WORKSPACE_LIFECYCLE,
  WORKSPACE_OPERATIONS,
  WORKSPACE_PERMISSIONS,
  WorkspaceError,
  createWorkspaceManager,
} from '../src/lego/workspace.mjs';
import { loadRegistry } from '../src/lego/registry.mjs';

const manifest = JSON.parse(readFileSync(new URL('../src/lego/manifest/workspace.json', import.meta.url), 'utf8'));
const registry = loadRegistry({ reload: true });
const fresh = (options = {}) => createWorkspaceManager({
  now: (() => {
    let tick = 0;
    return () => `2026-09-22T00:00:0${tick++}.000Z`;
  })(),
  ...options,
});
const create = (manager, workspaceId, extra = {}) => manager.create({
  workspaceId,
  kind: 'EPHEMERAL',
  metadata: { label: workspaceId },
  ...extra,
});

/* -------------------------------------------------------------- contract */

test('the contract has one identity, version and bounded published surface', () => {
  assert.equal(WORKSPACE_CONTRACT.id, 'ai.workspace');
  assert.equal(WORKSPACE_CONTRACT_VERSION, '1.0.0');
  assert.deepEqual([...WORKSPACE_OPERATIONS], [
    'workspace.create', 'workspace.describe', 'workspace.mount', 'workspace.release',
  ]);
  assert.deepEqual([...WORKSPACE_PERMISSIONS], ['ai:workspace:read', 'ai:workspace:create']);
  assert.deepEqual([...WORKSPACE_FIELDS], [
    'workspaceId', 'kind', 'lifecycle', 'metadata', 'resourceReferences',
    'version', 'createdAt', 'updatedAt',
  ]);
  assert.equal(manifest.contract, WORKSPACE_CONTRACT.id);
  assert.equal(manifest.version, WORKSPACE_CONTRACT_VERSION);
  assert.equal(manifest.status, 'implemented');
  assert.equal(manifest.operations.length, 4);
  assert.equal(manifest.permissions.includes('ai:workspace:execute'), false,
    'P2.15 must not publish execution authority');
});

test('the lifecycle is explicit and mount does not expose an executor', () => {
  assert.deepEqual(WORKSPACE_LIFECYCLE.states, ['declared', 'created', 'mounted', 'active', 'released']);
  assert.deepEqual(WORKSPACE_LIFECYCLE.terminal, ['released']);
  assert.deepEqual(WORKSPACE_LIFECYCLE.transitions.released, []);
  assert.match(manifest.lifecycle.mountRule, /does not mount a filesystem|start a process/i);
});

test('the registry has exactly one Workspace domain and one locked contract row', () => {
  const domains = registry.domains.filter((domain) => domain.id === 'workspace');
  assert.equal(domains.length, 1);
  assert.equal(domains[0].contract.id, 'ai.workspace');
  assert.equal(domains[0].contract.version, '1.0.0');
  const rows = registry.contractLock.contracts.filter((contract) => contract.id === 'ai.workspace');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].version, '1.0.0');
  assert.equal(rows[0].domain, 'workspace');
});

test('the canonical capability publishes the same four operations and two permissions', () => {
  const domain = registry.byId.get('workspace');
  const capability = domain.capabilities.find((entry) => entry.id === 'workspace.boundary');
  assert.ok(capability);
  assert.equal(capability.status, 'implemented');
  assert.deepEqual(capability.operations.map((entry) => `workspace.${entry.name}`), [...WORKSPACE_OPERATIONS]);
  assert.deepEqual(capability.permissions, [...WORKSPACE_PERMISSIONS]);
  assert.equal(capability.availability, 'available');
});

/* -------------------------------------------------------------- validation */

test('a valid Workspace is created with bounded metadata and exact identity', () => {
  const manager = fresh();
  const result = create(manager, 'workspace-a', {
    metadata: { label: 'A', purpose: 'contract test' },
    resourceReferences: ['artifact:one'],
  });
  assert.deepEqual(Object.keys(result).sort(), [...WORKSPACE_FIELDS].sort());
  assert.equal(result.workspaceId, 'workspace-a');
  assert.equal(result.kind, 'EPHEMERAL');
  assert.equal(result.lifecycle, 'created');
  assert.equal(result.version, 1);
  assert.deepEqual(result.resourceReferences, ['artifact:one']);
  assert.equal(manager.count, 1);
  assert.equal(Object.isFrozen(result), true);
});

test('invalid identities fail deterministically', () => {
  for (const workspaceId of ['', 'bad id', '/host/path', 'x'.repeat(WORKSPACE_LIMITS.maxIdentifierLength + 1), null]) {
    const manager = fresh();
    assert.throws(() => create(manager, workspaceId), (error) => {
      assert.ok(error instanceof WorkspaceError);
      assert.equal(error.code, 'lego.contract_violation');
      return true;
    }, `identity ${String(workspaceId)} must fail closed`);
  }
});

test('unknown kinds and unsupported provider kinds fail closed', () => {
  const manager = fresh();
  assert.throws(() => create(manager, 'unknown-kind', { kind: 'HOST' }), /kind must be one of/);
  assert.throws(() => create(manager, 'local-kind', { kind: 'LOCAL' }), (error) => {
    assert.equal(error.code, 'lego.unavailable');
    assert.match(error.message, /does not support/);
    return true;
  });
});

test('malformed metadata, depth, size and authority-shaped keys are refused', () => {
  assert.throws(() => create(fresh(), 'array-meta', { metadata: [] }), /metadata must be a plain object/);
  assert.throws(() => create(fresh(), 'secret-meta', { metadata: { apiKey: 'never' } }), /forbidden/);
  assert.throws(() => create(fresh(), 'path-meta', { metadata: { hostPath: '/tmp/x' } }), /forbidden/);
  assert.throws(() => create(fresh(), 'deep-meta', { metadata: { a: { b: { c: { d: { e: true } } } } } }), /nesting depth/);
  assert.throws(() => create(fresh(), 'large-meta', { metadata: { value: 'x'.repeat(WORKSPACE_LIMITS.maxMetadataBytes) } }), /bytes/);
});

test('references are opaque, bounded and duplicate-safe', () => {
  assert.throws(() => create(fresh(), 'bad-ref', { resourceReferences: ['/tmp/host'] }), /opaque identifier/);
  assert.throws(() => create(fresh(), 'duplicate-ref', { resourceReferences: ['artifact:one', 'artifact:one'] }), (error) => {
    assert.equal(error.code, 'storage.conflict');
    return true;
  });
  assert.throws(() => create(fresh(), 'too-many-refs', {
    resourceReferences: Array.from({ length: WORKSPACE_LIMITS.maxResourceReferences + 1 }, (_, i) => `ref:${i}`),
  }), /exceeds/);
});

test('duplicate identity is a conflict and does not overwrite the original', () => {
  const manager = fresh();
  create(manager, 'same', { metadata: { label: 'first' } });
  assert.throws(() => create(manager, 'same', { metadata: { label: 'second' } }), (error) => {
    assert.equal(error.code, 'storage.conflict');
    return true;
  });
  assert.equal(manager.describe({ workspaceId: 'same' }).metadata.label, 'first');
  assert.equal(manager.count, 1);
});

test('resource limits are machine-checkable', () => {
  const manager = fresh({ limits: { maxWorkspaces: 2 } });
  create(manager, 'one');
  create(manager, 'two');
  assert.throws(() => create(manager, 'three'), (error) => {
    assert.equal(error.code, 'lego.contract_violation');
    assert.equal(error.details.limit, 2);
    return true;
  });
});

/* -------------------------------------------------------------- isolation */

test('describe uses exact identity and isolates two workspaces', () => {
  const manager = fresh();
  create(manager, 'workspace-a', { metadata: { owner: 'A' } });
  create(manager, 'workspace-b', { metadata: { owner: 'B' } });
  assert.equal(manager.describe({ workspaceId: 'workspace-a' }).metadata.owner, 'A');
  assert.equal(manager.describe({ workspaceId: 'workspace-b' }).metadata.owner, 'B');
  assert.equal(manager.describe({ workspaceId: 'workspace-unknown' }), null);
});

test('mutation boundaries affect only the addressed Workspace', () => {
  const manager = fresh();
  create(manager, 'workspace-a');
  create(manager, 'workspace-b');
  manager.mount({ workspaceId: 'workspace-a' });
  assert.equal(manager.describe({ workspaceId: 'workspace-a' }).lifecycle, 'active');
  assert.equal(manager.describe({ workspaceId: 'workspace-b' }).lifecycle, 'created');
  manager.release({ workspaceId: 'workspace-a' });
  assert.equal(manager.describe({ workspaceId: 'workspace-a' }).lifecycle, 'released');
  assert.equal(manager.describe({ workspaceId: 'workspace-b' }).lifecycle, 'created');
});

test('unknown mutation identities fail rather than falling back to another Workspace', () => {
  const manager = fresh();
  create(manager, 'real');
  for (const operation of ['mount', 'release']) {
    assert.throws(() => manager[operation]({ workspaceId: 'missing' }), (error) => {
      assert.equal(error.code, 'workspace.project_not_found');
      assert.equal(error.details.workspaceId, 'missing');
      return true;
    });
  }
  assert.equal(manager.describe({ workspaceId: 'real' }).lifecycle, 'created');
});

/* -------------------------------------------------------------- lifecycle */

test('mount advances the logical lifecycle and is idempotent once active', () => {
  const manager = fresh();
  create(manager, 'mountable');
  const mounted = manager.mount({ workspaceId: 'mountable' });
  assert.equal(mounted.lifecycle, 'active');
  assert.equal(mounted.version, 2);
  const retry = manager.mount({ workspaceId: 'mountable' });
  assert.deepEqual(retry, mounted);
});

test('release is terminal and idempotent; released workspaces cannot be mounted', () => {
  const manager = fresh();
  create(manager, 'releasable');
  const released = manager.release({ workspaceId: 'releasable' });
  assert.equal(released.lifecycle, 'released');
  assert.deepEqual(manager.release({ workspaceId: 'releasable' }), released);
  assert.throws(() => manager.mount({ workspaceId: 'releasable' }), (error) => {
    assert.equal(error.code, 'lego.interaction_mismatch');
    return true;
  });
});

test('all operation inputs are deterministic plain objects', () => {
  const manager = fresh();
  for (const operation of ['create', 'describe', 'mount', 'release']) {
    assert.throws(() => manager[operation](null), (error) => {
      assert.equal(error.code, 'lego.contract_violation');
      return true;
    });
  }
});

/* -------------------------------------------------------------- provider seam */

test('the default provider is bounded and replaceable without provider leakage', () => {
  const provider = new InMemoryWorkspaceProvider();
  assert.equal(provider.supports('EPHEMERAL'), true);
  assert.equal(provider.supports('LOCAL'), false);
  const manager = fresh({ provider });
  const result = create(manager, 'provider-default');
  assert.equal(result.provider, undefined, 'provider identity must not enter the Workspace record');
  assert.equal(result.store, undefined, 'provider internals must not enter the Workspace record');
});

test('a provider replacement is accepted only through the explicit seam', () => {
  const records = new Map();
  const provider = {
    supports: (kind) => kind === 'PERSISTENT',
    put: (record) => records.set(record.workspaceId, structuredClone(record)),
    get: (id) => records.has(id) ? structuredClone(records.get(id)) : null,
    list: () => [...records.values()].map(structuredClone),
  };
  const manager = fresh({ provider });
  const record = manager.create({ workspaceId: 'replaceable', kind: 'PERSISTENT', metadata: {} });
  assert.equal(record.kind, 'PERSISTENT');
  assert.equal(manager.describe({ workspaceId: 'replaceable' }).workspaceId, 'replaceable');
});

test('a provider without explicit capability support is refused', () => {
  assert.throws(() => createWorkspaceManager({ provider: { put() {}, get() {}, list() {} } }), /supports/);
});

test('the implementation publishes no execution, shell, filesystem or runtime operation', () => {
  const source = readFileSync(new URL('../src/lego/workspace.mjs', import.meta.url), 'utf8');
  for (const forbidden of ['execSync', 'spawn(', 'child_process', 'fs.readFile', 'terminal.execute', 'filesystem.write', 'mcp.execute']) {
    assert.equal(source.includes(forbidden), false, `Workspace must not implement ${forbidden}`);
  }
  assert.deepEqual([...WORKSPACE_OPERATIONS].filter((operation) => /execute|terminal|filesystem|process|mcp/i.test(operation)), []);
});
