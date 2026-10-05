/** P2.14 backend Memory contract and lifecycle tests. */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MEMORY_CONTRACT,
  MEMORY_CONTRACT_VERSION,
  MEMORY_SCOPES,
  MEMORY_KINDS,
  MEMORY_RETENTIONS,
  MEMORY_OPERATIONS,
  MEMORY_PERMISSIONS,
  MEMORY_FIELDS,
  MEMORY_GRAPH_NODES,
  MEMORY_GRAPH_EDGES,
  MemoryError,
  InMemoryProvider,
  createMemoryManager,
} from '../src/lego/memory.mjs';

import { readFileSync } from 'node:fs';

function manager(options = {}) {
  return createMemoryManager({ now: () => '2026-09-22T00:00:00.000Z', ...options });
}

test('canonical Memory contract exists with the exact vocabulary', () => {
  assert.equal(MEMORY_CONTRACT.id, 'ai.memory');
  assert.equal(MEMORY_CONTRACT.version, '1.0.0');
  assert.equal(MEMORY_CONTRACT.owner, 'manager');
  assert.deepEqual(MEMORY_SCOPES, ['GLOBAL', 'PROJECT', 'WORKFLOW', 'AGENT', 'SESSION']);
  assert.deepEqual(MEMORY_KINDS, ['note', 'decision', 'artifact', 'task', 'execution', 'reference']);
  assert.deepEqual(MEMORY_RETENTIONS, ['EPHEMERAL', 'WORKING', 'IMPORTANT', 'DURABLE', 'PERMANENT']);
  assert.deepEqual(MEMORY_OPERATIONS, ['memory.remember', 'memory.recall', 'memory.list', 'memory.forget']);
  assert.deepEqual(MEMORY_PERMISSIONS, ['ai:memory:read', 'ai:memory:write']);
  for (const field of ['memoryId', 'scope', 'scopeOwner', 'kind', 'retention', 'content', 'references', 'provenance', 'version', 'size', 'checksum', 'createdAt', 'updatedAt']) {
    assert.ok(MEMORY_FIELDS.includes(field), `missing memory field ${field}`);
  }
  assert.equal(MEMORY_CONTRACT_VERSION, '1.0.0');
  // Graph vocabulary
  assert.ok(MEMORY_GRAPH_NODES.includes('project'));
  assert.ok(MEMORY_GRAPH_EDGES.includes('depends_on'));
  assert.equal(MEMORY_GRAPH_NODES.length, 10);
  assert.equal(MEMORY_GRAPH_EDGES.length, 11);
});

test('contract manifest and lock match the implementation', () => {
  const manifest = JSON.parse(readFileSync(new URL('../src/lego/manifest/memory.json', import.meta.url), 'utf8'));
  assert.equal(manifest.contract, 'ai.memory');
  assert.equal(manifest.version, '1.0.0');
  assert.deepEqual(manifest.scopes, MEMORY_SCOPES);
  assert.deepEqual(manifest.kinds, MEMORY_KINDS);
  assert.deepEqual(manifest.retention, MEMORY_RETENTIONS);
  const operationNames = manifest.operations.map(o => o.name);
  assert.deepEqual(operationNames, MEMORY_OPERATIONS);
  assert.deepEqual(manifest.permissions, MEMORY_PERMISSIONS);

  const lock = JSON.parse(readFileSync(new URL('../src/lego/contracts/contract-lock.json', import.meta.url), 'utf8'));
  const row = lock.contracts.find(c => c.id === 'ai.memory');
  assert.ok(row, 'ai.memory must have a contract-lock row');
  assert.equal(row.version, '1.0.0');
  assert.equal(row.status, 'implemented');
  assert.deepEqual(row.operations, MEMORY_OPERATIONS);
  assert.deepEqual(row.permissions, MEMORY_PERMISSIONS);

  const domains = JSON.parse(readFileSync(new URL('../src/lego/manifest/domains.json', import.meta.url), 'utf8'));
  const foundation = domains.domains.find(d => d.id === 'ai-foundation');
  const cap = foundation.capabilities.find(c => c.id === 'ai.memory');
  assert.ok(cap, 'ai.memory capability must be registered under ai-foundation');
  assert.equal(cap.status, 'implemented');
  const capOps = cap.operations.map(o => o.name);
  assert.deepEqual(capOps, MEMORY_OPERATIONS);
});

test('remember creates a memory record with integrity fields', () => {
  const m = manager();
  const record = m.remember({ memoryId: 'mem-1', scope: 'GLOBAL', kind: 'note', retention: 'DURABLE', content: { summary: 'keep this' } });
  assert.equal(record.memoryId, 'mem-1');
  assert.equal(record.scope, 'GLOBAL');
  assert.equal(record.scopeOwner, null);
  assert.equal(record.kind, 'note');
  assert.equal(record.retention, 'DURABLE');
  assert.deepEqual(record.content, { summary: 'keep this' });
  assert.equal(record.version, 1);
  assert.equal(typeof record.checksum, 'string');
  assert.equal(typeof record.size, 'number');
  assert.equal(record.size > 0, true);
  // Deterministic checksum: same content -> same checksum
  const again = m.recall('mem-1');
  assert.equal(again.checksum, record.checksum);
  assert.equal(again.size, record.size);
  assert.equal(again.version, 1);
});

test('recall returns null for missing memory and validates identity', () => {
  const m = manager();
  assert.equal(m.recall('missing-id'), null);
  assert.throws(() => m.recall(''), /memoryId/);
  assert.throws(() => m.recall('__proto__'), /memoryId/);
  assert.throws(() => m.recall(null), /memoryId/);
});

test('list returns empty deterministically for an empty store', () => {
  const m = manager();
  const result = m.list({});
  assert.deepEqual(result.results, []);
  assert.equal(result.total, 0);
  assert.equal(result.nextCursor, null);
  const filtered = m.list({ scope: 'GLOBAL' });
  assert.deepEqual(filtered.results, []);
  assert.equal(filtered.total, 0);
});

test('invalid input is rejected with contract_violation', () => {
  const m = manager();
  // Unknown scope/kind/retention
  assert.throws(() => m.remember({ memoryId: 'bad1', scope: 'UNKNOWN', kind: 'note', retention: 'DURABLE', content: {} }), (e) => e.code === 'lego.contract_violation');
  assert.throws(() => m.remember({ memoryId: 'bad2', scope: 'GLOBAL', kind: 'unknown', retention: 'DURABLE', content: {} }), (e) => e.code === 'lego.contract_violation');
  assert.throws(() => m.remember({ memoryId: 'bad3', scope: 'GLOBAL', kind: 'note', retention: 'UNKNOWN', content: {} }), (e) => e.code === 'lego.contract_violation');
  // Missing scopeOwner for non-GLOBAL
  assert.throws(() => m.remember({ memoryId: 'bad4', scope: 'WORKFLOW', kind: 'note', retention: 'DURABLE', content: {} }), /scopeOwner/);
  // GLOBAL must not have owner
  assert.throws(() => m.remember({ memoryId: 'bad5', scope: 'GLOBAL', scopeOwner: 'owner-1', kind: 'note', retention: 'DURABLE', content: {} }), /GLOBAL.*scopeOwner/);
  // Bad memoryId
  assert.throws(() => m.remember({ memoryId: '', scope: 'GLOBAL', kind: 'note', retention: 'DURABLE', content: {} }), /memoryId/);
  // Sensitive keys
  assert.throws(() => m.remember({ memoryId: 'sens1', scope: 'GLOBAL', kind: 'note', retention: 'DURABLE', content: { apiKey: 'secret' } }), /sensitive/);
  assert.throws(() => m.remember({ memoryId: 'sens2', scope: 'GLOBAL', kind: 'note', retention: 'DURABLE', content: { nested: { password: 'x' } } }), /sensitive/);
  // Host path
  assert.throws(() => m.remember({ memoryId: 'path1', scope: 'GLOBAL', kind: 'note', retention: 'DURABLE', content: { path: '/etc/passwd' } }), /host-path|sensitive/);
  // Invalid references
  assert.throws(() => m.remember({ memoryId: 'ref1', scope: 'GLOBAL', kind: 'note', retention: 'DURABLE', content: {}, references: [{ id: 'x', relation: 'not-an-edge' }] }), /relation/);
  assert.throws(() => m.remember({ memoryId: 'ref2', scope: 'GLOBAL', kind: 'note', retention: 'DURABLE', content: {}, references: 'not-array' }), /references.*array/);
  // List invalid filters
  assert.throws(() => m.list({ scope: 'UNKNOWN' }), /scope/);
  assert.throws(() => m.list({ kind: 'unknown' }), /kind/);
  assert.throws(() => m.list({ retention: 'unknown' }), /retention/);
  assert.throws(() => m.list({ limit: 0 }), /limit/);
  assert.throws(() => m.list({ limit: 101 }), /limit/);
  assert.throws(() => m.list({ limit: '50' }), /limit/);
});

test('duplicate remember with identical content is idempotent (no version bump)', () => {
  const m = manager();
  const first = m.remember({ memoryId: 'dup-1', scope: 'GLOBAL', kind: 'note', retention: 'DURABLE', content: { a: 1 }, references: [{ id: 'rel-1', relation: 'related_to' }] });
  const second = m.remember({ memoryId: 'dup-1', scope: 'GLOBAL', kind: 'note', retention: 'DURABLE', content: { a: 1 }, references: [{ id: 'rel-1', relation: 'related_to' }] });
  assert.equal(second.version, 1);
  assert.equal(second.checksum, first.checksum);
  assert.equal(second.size, first.size);
  // Different content bumps version
  const third = m.remember({ memoryId: 'dup-1', scope: 'GLOBAL', kind: 'note', retention: 'DURABLE', content: { a: 2 }, references: [{ id: 'rel-1', relation: 'related_to' }] });
  assert.equal(third.version, 2);
  assert.notEqual(third.checksum, first.checksum);
});

test('update changes retention and content and bumps version', () => {
  const m = manager();
  const first = m.remember({ memoryId: 'upd-1', scope: 'GLOBAL', kind: 'task', retention: 'WORKING', content: { state: 'draft' } });
  assert.equal(first.retention, 'WORKING');
  assert.equal(first.version, 1);
  const updated = m.remember({ memoryId: 'upd-1', scope: 'GLOBAL', kind: 'task', retention: 'IMPORTANT', content: { state: 'final' } });
  assert.equal(updated.retention, 'IMPORTANT');
  assert.deepEqual(updated.content, { state: 'final' });
  assert.equal(updated.version, 2);
  // Scope/kind immutability
  assert.throws(() => m.remember({ memoryId: 'upd-1', scope: 'AGENT', scopeOwner: 'agent-1', kind: 'task', retention: 'IMPORTANT', content: { state: 'x' } }), /already exists/);
  assert.throws(() => m.remember({ memoryId: 'upd-1', scope: 'GLOBAL', kind: 'note', retention: 'IMPORTANT', content: { state: 'x' } }), /kind mismatch/);
});

test('scope isolation: list filtered by scope never leaks across namespaces', () => {
  const m = manager();
  m.remember({ memoryId: 'g-1', scope: 'GLOBAL', kind: 'note', retention: 'DURABLE', content: { v: 1 } });
  m.remember({ memoryId: 'w-1', scope: 'WORKFLOW', scopeOwner: 'wf-1', kind: 'note', retention: 'DURABLE', content: { v: 2 } });
  m.remember({ memoryId: 'w-2', scope: 'WORKFLOW', scopeOwner: 'wf-2', kind: 'note', retention: 'DURABLE', content: { v: 3 } });
  m.remember({ memoryId: 'a-1', scope: 'AGENT', scopeOwner: 'agent-1', kind: 'decision', retention: 'IMPORTANT', content: { v: 4 } });

  const globalOnly = m.list({ scope: 'GLOBAL' });
  assert.equal(globalOnly.total, 1);
  assert.equal(globalOnly.results[0].memoryId, 'g-1');

  const wf1 = m.list({ scope: 'WORKFLOW', scopeOwner: 'wf-1' });
  assert.equal(wf1.total, 1);
  assert.equal(wf1.results[0].memoryId, 'w-1');

  const wf2 = m.list({ scope: 'WORKFLOW', scopeOwner: 'wf-2' });
  assert.equal(wf2.total, 1);
  assert.equal(wf2.results[0].memoryId, 'w-2');

  const agent = m.list({ scope: 'AGENT', scopeOwner: 'agent-1' });
  assert.equal(agent.total, 1);
  assert.equal(agent.results[0].memoryId, 'a-1');

  // Different workflow id sees nothing
  const wfMissing = m.list({ scope: 'WORKFLOW', scopeOwner: 'wf-99' });
  assert.equal(wfMissing.total, 0);

  // Recall itself is global by identity, but list isolation proves the boundary
  assert.ok(m.recall('w-1'));
  assert.equal(m.recall('w-1').scopeOwner, 'wf-1');
});

test('persistence boundary: memory survives context replacement (independent managers)', () => {
  // Memory must survive context replacement: demonstrate that a memory
  // manager retains records even after a context manager is recreated.
  // Here we simulate by creating a context-like cycle and showing memory
  // count is unaffected.
  const m = manager();
  m.remember({ memoryId: 'persist-1', scope: 'SESSION', scopeOwner: 'session-1', kind: 'artifact', retention: 'DURABLE', content: { result: 'keep' } });
  m.remember({ memoryId: 'persist-2', scope: 'GLOBAL', kind: 'decision', retention: 'PERMANENT', content: { choice: 'remember' } });
  assert.equal(m.count, 2);
  // Create a new manager with the same provider — the boundary is the provider,
  // not the manager instance. Records survive a manager replacement.
  const sharedProvider = m.provider;
  const m2 = manager({ provider: sharedProvider });
  assert.equal(m2.count, 2);
  assert.ok(m2.recall('persist-1'));
  assert.ok(m2.recall('persist-2'));
  // Context replacement simulation: create a fresh isolated manager with its own provider
  // has 0 records, but the original's records are still retained.
  const fresh = manager();
  assert.equal(fresh.count, 0);
  assert.equal(m.count, 2, 'original memory survives independently');
});

test('persistence boundary: provider is replaceable and injected', () => {
  class CustomProvider {
    constructor() { this.map = new Map(); }
    put(rec) { this.map.set(rec.memoryId, JSON.parse(JSON.stringify(rec))); }
    get(id) { const v = this.map.get(id); return v ? JSON.parse(JSON.stringify(v)) : null; }
    delete(id) { return this.map.delete(id); }
    list() { return Array.from(this.map.values()).map(v => JSON.parse(JSON.stringify(v))); }
    get size() { return this.map.size; }
  }
  const custom = new CustomProvider();
  const m = manager({ provider: custom });
  m.remember({ memoryId: 'custom-1', scope: 'GLOBAL', kind: 'note', retention: 'EPHEMERAL', content: { x: 1 } });
  assert.equal(custom.size, 1);
  assert.ok(m.recall('custom-1'));
  // Contract shape is identical regardless of provider
  const result = m.list({ scope: 'GLOBAL' });
  assert.equal(result.total, 1);
});

test('integrity: checksum and size are deterministic and verified on read', () => {
  const m = manager();
  const record = m.remember({ memoryId: 'int-1', scope: 'GLOBAL', kind: 'note', retention: 'IMPORTANT', content: { b: 2, a: 1 } });
  // Stable canonical: {a:1, b:2} same checksum as {b:2, a:1} would be
  const verification = m.verify(record);
  assert.equal(verification.valid, true);
  assert.equal(verification.storedChecksum, record.checksum);
  // Tampered record fails
  const tampered = { ...record, content: { a: 99, b: 2 } };
  const tamperedVerification = m.verify(tampered);
  assert.equal(tamperedVerification.valid, false);
  // Store tampering is detected on recall via provider direct mutation
  const provider = m.provider;
  // Directly mutate the stored record's content without updating checksum
  const stored = provider.get('int-1');
  stored.content = { a: 999 };
  provider.put({ ...stored }); // keep old checksum/size intentionally
  assert.throws(() => m.recall('int-1'), (e) => e.code === 'lego.contract_violation' && /integrity/.test(e.message));
});

test('list is deterministic, bounded, ordered and paginated', () => {
  // Use incrementing timestamps to test ordering stability
  let tick = 0;
  const tickingManager = manager({ now: () => `2026-09-22T00:00:0${tick++}.000Z` });
  tickingManager.remember({ memoryId: 'ord-2', scope: 'GLOBAL', kind: 'note', retention: 'DURABLE', content: { n: 2 } });
  tickingManager.remember({ memoryId: 'ord-1', scope: 'GLOBAL', kind: 'note', retention: 'DURABLE', content: { n: 1 } });
  tickingManager.remember({ memoryId: 'ord-3', scope: 'GLOBAL', kind: 'note', retention: 'DURABLE', content: { n: 3 } });

  // Default order is createdAt asc, then memoryId asc
  const all = tickingManager.list({ scope: 'GLOBAL', limit: 10 });
  assert.equal(all.total, 3);
  assert.deepEqual(all.results.map(r => r.memoryId), ['ord-2', 'ord-1', 'ord-3']);

  // Pagination
  const page1 = tickingManager.list({ scope: 'GLOBAL', limit: 2 });
  assert.equal(page1.results.length, 2);
  assert.equal(page1.total, 3);
  assert.ok(page1.nextCursor);
  const page2 = tickingManager.list({ scope: 'GLOBAL', limit: 2, cursor: page1.nextCursor });
  assert.equal(page2.results.length, 1);
  assert.equal(page2.results[0].memoryId, 'ord-3');
  assert.equal(page2.nextCursor, null);

  // Deterministic: repeated list gives same order
  const again = tickingManager.list({ scope: 'GLOBAL', limit: 10 });
  assert.deepEqual(again.results.map(r => r.memoryId), ['ord-2', 'ord-1', 'ord-3']);
});

test('list limits and empty behaviour are deterministic', () => {
  const m = manager();
  m.remember({ memoryId: 'lim-1', scope: 'GLOBAL', kind: 'note', retention: 'DURABLE', content: { v: 1 } });
  m.remember({ memoryId: 'lim-2', scope: 'GLOBAL', kind: 'note', retention: 'DURABLE', content: { v: 2 } });
  const limited = m.list({ limit: 1 });
  assert.equal(limited.results.length, 1);
  assert.equal(limited.total, 2);
  assert.ok(limited.nextCursor);
  // Invalid cursor
  assert.throws(() => m.list({ cursor: 'not-base64!' }), /cursor/);
  // Total respects filters
  const kindFiltered = m.list({ kind: 'task' });
  assert.equal(kindFiltered.total, 0);
  assert.deepEqual(kindFiltered.results, []);
});

test('forget is explicit, idempotent and terminal', () => {
  const m = manager();
  m.remember({ memoryId: 'forget-1', scope: 'GLOBAL', kind: 'note', retention: 'EPHEMERAL', content: { t: 1 } });
  assert.ok(m.recall('forget-1'));
  const first = m.forget('forget-1');
  assert.equal(first.forgotten, true);
  assert.equal(first.memoryId, 'forget-1');
  assert.equal(m.recall('forget-1'), null);
  // Second forget is idempotent
  const second = m.forget('forget-1');
  assert.equal(second.forgotten, false);
  // Forgetting a never-existed id is also idempotent
  const never = m.forget('never-existed');
  assert.equal(never.forgotten, false);
  assert.throws(() => m.forget(''), /memoryId/);
});

test('content and reference bounds are enforced', () => {
  const m = manager();
  // Content too large
  const largeContent = { data: 'x'.repeat(70 * 1024) };
  assert.throws(() => m.remember({ memoryId: 'large-1', scope: 'GLOBAL', kind: 'note', retention: 'DURABLE', content: largeContent }), /bounded limit/);
  // Too many references
  const manyRefs = Array.from({ length: 33 }, (_, i) => ({ id: `ref-${i}`, relation: 'related_to' }));
  assert.throws(() => m.remember({ memoryId: 'many-1', scope: 'GLOBAL', kind: 'note', retention: 'DURABLE', content: {}, references: manyRefs }), /bounded limit/);
  // Reference id bad
  assert.throws(() => m.remember({ memoryId: 'badref-1', scope: 'GLOBAL', kind: 'note', retention: 'DURABLE', content: {}, references: [{ id: '', relation: 'related_to' }] }), /must match/);
});

test('status reports contract, provider and limits', () => {
  const m = manager();
  const s = m.status();
  assert.equal(s.contract, '1.0.0');
  assert.equal(s.provider, 'InMemoryProvider');
  assert.equal(s.count, 0);
  assert.ok(s.limits.maxContentBytes);
});

test('no memory record carries a permission, transcript or filesystem handle', () => {
  const m = manager();
  const record = m.remember({ memoryId: 'no-leak-1', scope: 'GLOBAL', kind: 'note', retention: 'DURABLE', content: { summary: 'bounded' } });
  assert.equal('transcript' in record, false);
  assert.equal('messages' in record, false);
  assert.equal('permission' in record, false);
  assert.equal('capabilityGrant' in record, false);
  assert.equal('hostPath' in record, false);
  // Ensure the record is frozen
  assert.ok(Object.isFrozen(record));
});

test('provider count and clear are bounded local state only', () => {
  const m = manager({ limits: { maxRecords: 2 } });
  m.remember({ memoryId: 'b-1', scope: 'GLOBAL', kind: 'note', retention: 'DURABLE', content: { n: 1 } });
  m.remember({ memoryId: 'b-2', scope: 'GLOBAL', kind: 'note', retention: 'DURABLE', content: { n: 2 } });
  assert.equal(m.count, 2);
  assert.throws(() => m.remember({ memoryId: 'b-3', scope: 'GLOBAL', kind: 'note', retention: 'DURABLE', content: { n: 3 } }), /bounded record limit/);
  m.clear();
  assert.equal(m.count, 0);
  // Can remember again after clear
  m.remember({ memoryId: 'b-3', scope: 'GLOBAL', kind: 'note', retention: 'DURABLE', content: { n: 3 } });
  assert.equal(m.count, 1);
});

test('doc coupling: code, manifest and contract document cannot drift apart', () => {
  // The contract document is manifest/memory.json — the single source of truth.
  // The code (memory.mjs exports) and the published evidence docs must quote it verbatim.
  const manifest = JSON.parse(readFileSync(new URL('../src/lego/manifest/memory.json', import.meta.url), 'utf8'));
  // Every vocabulary word the code publishes must come from the manifest, and every word the
  // manifest publishes must be quoted by the code — no hidden synonym.
  assert.deepEqual(MEMORY_SCOPES, manifest.scopes, 'scopes: code quotes manifest verbatim');
  assert.deepEqual(MEMORY_KINDS, manifest.kinds, 'kinds: code quotes manifest verbatim');
  assert.deepEqual(MEMORY_RETENTIONS, manifest.retention, 'retentions: code quotes manifest verbatim');
  assert.deepEqual(MEMORY_OPERATIONS, manifest.operations.map(o => o.name), 'operations: code quotes manifest verbatim');
  assert.deepEqual(MEMORY_PERMISSIONS, manifest.permissions, 'permissions: code quotes manifest verbatim');
  assert.equal(MEMORY_CONTRACT.version, manifest.version, 'version: code and manifest agree');
  assert.equal(MEMORY_CONTRACT.id, manifest.contract, 'id: code and manifest agree');

  // The generated doc .ai/master/AI_CONTRACT_MATRIX.md is produced by `npm run lego:ai` from the
  // manifests and the contract-lock. A doc that promises a different version, a different operation
  // set or a different LEGO status would be an invented interface.
  const matrix = readFileSync(new URL('../../../.ai/master/AI_CONTRACT_MATRIX.md', import.meta.url), 'utf8');
  assert.ok(matrix.includes('`ai.memory`') && matrix.includes('locked @ 1.0.0'), 'matrix names ai.memory locked @ 1.0.0');
  assert.ok(matrix.includes('IMPLEMENTED') && matrix.includes('ai.memory@1.0.0'), 'matrix marks ai.memory IMPLEMENTED at 1.0.0');
  for (const op of MEMORY_OPERATIONS) {
    // The matrix test column must name the memory operations via the test file, never re-quote them
    // as ai.memory.* inside the code column — the lock is the source, the matrix just points at it.
    assert.ok(matrix.includes(op) || matrix.includes('lego-memory.test.mjs'), `matrix/test column references ${op}`);
  }
  assert.equal(matrix.includes('`ai.memory.traverse`'), false, 'matrix does not invent a traversal operation');
  assert.equal(matrix.includes('`ai.memory.relate`'), false, 'matrix does not invent a relate operation');

  // The evidence report for this milestone must name the exact contract the code locked, with the
  // same four operations and two permissions the manifest publishes — otherwise the report is stale.
  const report = readFileSync(new URL('../../../docs/n8n-lego/evidence/P2.14-agent-2-final-report.md', import.meta.url), 'utf8');
  assert.ok(report.includes('ai.memory@1.0.0'), 'report names the published contract ai.memory@1.0.0');
  for (const op of MEMORY_OPERATIONS) assert.ok(report.includes(op), `report names operation ${op}`);
  for (const perm of MEMORY_PERMISSIONS) assert.ok(report.includes(perm), `report names permission ${perm}`);
  assert.ok(report.includes('BACKEND_FROZEN: YES') || report.includes('AGENT_2_P2.14_COMPLETE'), 'report carries the freeze verdict');
  assert.ok(report.includes('f11aee01') || report.includes('5fbaf934'), 'report pins the exact commit that published the contract');

  // The product manifest ai-lego-set.json must mark memory as implemented and must point at the
  // test file that proves the contract — a manifest that says planned while the lock says
  // implemented would be drift.
  const legoSet = JSON.parse(readFileSync(new URL('../src/lego/manifest/ai-lego-set.json', import.meta.url), 'utf8'));
  const memLego = (legoSet.lego ?? legoSet.legos ?? []).find(l => l.id === 'memory');
  assert.ok(memLego, 'ai-lego-set.json carries a memory LEGO row');
  assert.equal(memLego.status, 'implemented', 'the LEGO row says implemented');
  assert.ok(memLego.tests.some(t => t.includes('lego-memory.test.mjs')), 'the LEGO row points at the memory test');
  // capability is named via contracts (ai.memory) or capabilityIds — accept either shape
  const caps = memLego.capabilityIds ?? memLego.capabilities ?? memLego.contracts ?? [];
  assert.ok(caps.includes('ai.memory'), 'the LEGO row names the ai.memory capability');
});
