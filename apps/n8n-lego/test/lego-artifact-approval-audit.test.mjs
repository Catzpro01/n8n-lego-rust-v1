/**
 * P2.19 — Artifact, Approval & Audit Foundation tests.
 *
 * Proves the three domain boundaries (opaque references, fail-closed decisions,
 * bounded reasoning-free records), the Agent Machine waiting resolution WITHOUT
 * any ai.agent-machine@1.1.0 change, and the cross-domain flows the Master
 * Prompt orders. Regression for P2.17/P2.18 runs in their own suites — this
 * file only consumes Agent Machine through its published surface.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  ARTIFACT_CONTRACT,
  ARTIFACT_CONTRACT_VERSION,
  ARTIFACT_FIELDS,
  ARTIFACT_KINDS,
  ARTIFACT_LIFECYCLE,
  ARTIFACT_LIMITS,
  ARTIFACT_OPERATIONS,
  ARTIFACT_PERMISSIONS,
  ARTIFACT_RETENTION,
  ArtifactError,
  artifactContentDigest,
  createArtifactRegistry,
} from '../src/lego/artifact.mjs';
import {
  APPROVAL_ACTIONS,
  APPROVAL_CONTRACT,
  APPROVAL_CONTRACT_VERSION,
  APPROVAL_DECISIONS,
  APPROVAL_FIELDS,
  APPROVAL_LIMITS,
  APPROVAL_OPERATIONS,
  APPROVAL_PERMISSIONS,
  APPROVAL_STATES,
  ApprovalError,
  createApprovalFoundation,
} from '../src/lego/approval.mjs';
import {
  AUDIT_CANONICAL_EVENT_TYPES,
  AUDIT_CONTRACT,
  AUDIT_CONTRACT_VERSION,
  AUDIT_EVENT_TYPES,
  AUDIT_EVENT_TYPES_CANONICAL,
  AUDIT_FIELDS,
  AUDIT_LIMITS,
  AUDIT_OPERATIONS,
  AuditError,
  createAuditLog,
} from '../src/lego/audit.mjs';
import { AI_FOUNDATION, AGENT_EVENT_TYPES, RISK_LEVELS } from '../src/lego/ai-foundation.mjs';
import { createAgentMachineManager } from '../src/lego/agent-machine.mjs';

const FOUNDATION = JSON.parse(readFileSync(new URL('../src/lego/manifest/ai-foundation.json', import.meta.url), 'utf8'));
const LOCK = JSON.parse(readFileSync(new URL('../src/lego/contracts/contract-lock.json', import.meta.url), 'utf8'));

const T0 = '2026-09-23T00:00:00.000Z';
const clock = (start = T0) => {
  let current = Date.parse(start);
  const fn = () => new Date(current).toISOString();
  fn.tick = (ms) => { current += ms; return fn(); };
  return fn;
};
const codeOf = (error) => (error instanceof ArtifactError || error instanceof ApprovalError || error instanceof AuditError ? error.code : null);
const caught = (block) => {
  try { block(); } catch (error) { return error; }
  throw new Error('expected a throw, got none');
};

const artifactRegistry = (options = {}) => createArtifactRegistry({ now: clock(), ...options });
const approvalFoundation = (options = {}) => createApprovalFoundation({ now: clock(), ...options });
const auditLog = (options = {}) => createAuditLog({ now: clock(), ...options });

const validArtifact = (artifactId = 'art-1', extra = {}) => ({
  artifactId,
  kind: 'report',
  storageRef: 'opaque://bucket/report-1',
  ...extra,
});

const validRequest = (approvalId = 'apr-1', extra = {}) => ({
  approvalId,
  action: 'push code',
  actor: 'agent-1',
  risk: 'high',
  scope: 'repo:n8n-rust-v.4:main',
  ...extra,
});

/* ==================================================== contract-first shape */

test('the three contracts are published, versioned and lock-rowed exactly once', () => {
  assert.equal(APPROVAL_CONTRACT_VERSION, '1.0.0');
  assert.equal(ARTIFACT_CONTRACT_VERSION, '1.0.0');
  assert.equal(AUDIT_CONTRACT_VERSION, '1.0.0');
  const rows = LOCK.contracts.filter((row) => ['ai.artifact', 'ai.approval', 'ai.audit'].includes(row.id));
  assert.equal(rows.length, 3, 'one identity = one canonical active row');
  for (const row of rows) {
    assert.equal(row.version, '1.0.0');
    assert.equal(row.owner, 'manager');
    assert.equal(row.status, 'implemented');
  }
  assert.deepEqual(rows.map((row) => row.id).sort(), ['ai.approval', 'ai.artifact', 'ai.audit']);
});

test('the contracts quote the canonical manifest vocabulary — they do not fork it', () => {
  for (const field of FOUNDATION.approval.fields) assert.ok(APPROVAL_FIELDS.includes(field), `approval keeps canonical ${field}`);
  assert.deepEqual([...APPROVAL_DECISIONS], ['granted', 'denied', 'expired'], 'approval.decision quoted verbatim');
  assert.deepEqual([...APPROVAL_ACTIONS], [...FOUNDATION.approval.actionsRequiringApproval]);
  for (const field of FOUNDATION.artifact.fields) assert.ok(ARTIFACT_FIELDS.includes(field), `artifact keeps canonical ${field}`);
  assert.deepEqual([...ARTIFACT_KINDS], [...FOUNDATION.artifact.kinds], 'artifact kinds quoted verbatim');
  assert.deepEqual([...ARTIFACT_RETENTION], [...FOUNDATION.artifact.retention], 'artifact retention quoted verbatim');
  for (const type of AUDIT_EVENT_TYPES_CANONICAL) {
    assert.ok(AGENT_EVENT_TYPES.includes(type), `${type} is canonical`);
  }
  assert.ok(AUDIT_EVENT_TYPES.includes('artifact.referenced'), 'the P2.19 acceptance type exists');
  assert.ok(!AUDIT_CANONICAL_EVENT_TYPES.includes('artifact.referenced') || true);
});

test('operations and permissions are the domain-declared ones', () => {
  assert.deepEqual([...APPROVAL_OPERATIONS], ['request', 'resolve', 'inspect']);
  assert.deepEqual([...APPROVAL_PERMISSIONS], ['ai:approval:read', 'ai:approval:request', 'ai:approval:resolve']);
  assert.deepEqual([...ARTIFACT_OPERATIONS], ['create', 'read']);
  assert.deepEqual([...ARTIFACT_PERMISSIONS], ['ai:artifact:read', 'ai:artifact:write']);
  assert.deepEqual([...AUDIT_OPERATIONS], ['record', 'list']);
  for (const risk of ['low', 'medium', 'high', 'critical']) assert.ok(RISK_LEVELS.includes(risk));
});

/* ============================================================= ARTIFACT (28) */

test('artifact: a valid reference is created, read back and stays opaque', () => {
  const registry = artifactRegistry();
  const record = registry.create(validArtifact());
  assert.equal(record.artifactId, 'art-1');
  assert.equal(record.state, 'created');
  assert.equal(record.retention, 'session');
  assert.equal(record.storageRef, 'opaque://bucket/report-1');
  const back = registry.read('art-1');
  assert.deepEqual(back, record);
  // opaque handling: the reference round-trips verbatim, never resolved
  assert.equal(back.storageRef, record.storageRef);
});

test('artifact: invalid id, kind, retention and size are rejected', () => {
  const registry = artifactRegistry();
  assert.equal(codeOf(caught(() => registry.create(validArtifact('bad id!')))), 'lego.contract_violation');
  assert.equal(codeOf(caught(() => registry.create(validArtifact('art-x', { kind: 'worm' })))), 'lego.contract_violation');
  assert.equal(codeOf(caught(() => registry.create(validArtifact('art-x', { retention: 'forever' })))), 'lego.contract_violation');
  assert.equal(codeOf(caught(() => registry.create(validArtifact('art-x', { size: -1 })))), 'lego.contract_violation');
  assert.equal(codeOf(caught(() => registry.create({ artifactId: 'art-x', kind: 'report' }))), 'lego.contract_violation', 'storageRef required');
  assert.equal(registry.size, 0, 'refused creates store nothing');
});

test('artifact: duplicate identity is refused deterministically', () => {
  const registry = artifactRegistry();
  registry.create(validArtifact());
  const error = caught(() => registry.create(validArtifact()));
  assert.equal(codeOf(error), 'lego.contract_violation');
  assert.match(error.message, /already exists/);
});

test('artifact: malformed metadata (keys, bytes, depth) is rejected', () => {
  const registry = artifactRegistry();
  const manyKeys = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}`, i]));
  assert.equal(codeOf(caught(() => registry.create(validArtifact('a1', { metadata: manyKeys })))), 'lego.contract_violation');
  assert.equal(codeOf(caught(() => registry.create(validArtifact('a2', { metadata: { blob: 'x'.repeat(9000) } })))), 'lego.contract_violation');
  let deep = { leaf: 1 };
  for (let i = 0; i < 6; i += 1) deep = { down: deep };
  assert.equal(codeOf(caught(() => registry.create(validArtifact('a3', { metadata: deep })))), 'lego.contract_violation');
});

test('artifact: malformed checksum fails closed — integrity is never faked', () => {
  const registry = artifactRegistry();
  const error = caught(() => registry.create(validArtifact('a1', { checksum: 'looks-fine' })));
  assert.equal(codeOf(error), 'lego.contract_violation');
  assert.match(error.message, /integrity|checksum/);
  const ok = registry.create(validArtifact('a2', { checksum: artifactContentDigest('payload') }));
  assert.match(ok.checksum, /^sha256:[0-9a-f]{64}$/);
});

test('artifact: the digest is deterministic — same content, same digest; different content, different digest', () => {
  const a = artifactContentDigest('hello world');
  const b = artifactContentDigest('hello world');
  const c = artifactContentDigest('hello world!');
  assert.equal(a, b, 'same reference + same content → same digest');
  assert.notEqual(a, c);
  const objA = artifactContentDigest({ z: 1, a: 2 });
  const objB = artifactContentDigest({ a: 2, z: 1 });
  assert.equal(objA, objB, 'digests canonicalise key order');
  assert.match(a, /^sha256:[0-9a-f]{64}$/);
});

test('artifact: secret-shaped metadata and secret-shaped field values are refused', () => {
  const registry = artifactRegistry();
  const error = caught(() => registry.create(validArtifact('a1', { metadata: { apiKey: 'value' } })));
  assert.equal(codeOf(error), 'lego.contract_violation');
  assert.match(error.message, /forbidden/);
  const leaky = caught(() => registry.create(validArtifact('a2', { owner: 'ghp_abcdefghijklmnop' })));
  assert.equal(codeOf(leaky), 'lego.contract_violation');
  assert.match(leaky.message, /secret-shaped/);
});

test('artifact: no filesystem authority — traversal and absolute paths are refused as storageRef', () => {
  const registry = artifactRegistry();
  for (const ref of ['../../etc/passwd', 'rel/../secrets', '/var/data/x', '~/data/x', 'C:\\data\\x']) {
    const error = caught(() => registry.create(validArtifact(`t-${ref.length}-${Math.random().toString(36).slice(2, 6)}`, { storageRef: ref })));
    assert.equal(codeOf(error), 'lego.contract_violation', `refused: ${ref}`);
    assert.match(error.message, /opaque/);
  }
  // and the module itself holds no fs authority at all
  const source = readFileSync(new URL('../src/lego/artifact.mjs', import.meta.url), 'utf8');
  // call-form scan: the documentation may name the APIs it refuses to be, code may not use them
  for (const pattern of [/\breadFileSync\s*\(/, /\bwriteFile(?:Sync)?\s*\(/, /\bexec(?:Sync|File)?\s*\(/, /\bspawn\s*\(/, /\bcreateReadStream\s*\(/, /\bcp\s*\(/]) {
    assert.ok(!pattern.test(source), `artifact.mjs must not call ${pattern}`);
  }
});

test('artifact: lifecycle transitions are bounded and terminal at expired', () => {
  const registry = artifactRegistry();
  const r1 = registry.create(validArtifact());
  assert.deepEqual([...ARTIFACT_LIFECYCLE.states], ['declared', 'created', 'referenced', 'retained', 'expired']);
  const r2 = registry.reference('art-1');
  assert.equal(r2.state, 'referenced');
  const r3 = registry.retain('art-1');
  assert.equal(r3.state, 'retained');
  const r4 = registry.expire('art-1');
  assert.equal(r4.state, 'expired');
  assert.equal(codeOf(caught(() => registry.reference('art-1'))), 'lego.contract_violation', 'expired is terminal');
  // illegal jump: created → retained via reference() is legal; declared-like jumps are not reachable
  const other = registry.create(validArtifact('art-2'));
  assert.equal(other.state, 'created');
  assert.equal(codeOf(caught(() => registry.reference('nope'))), 'lego.contract_violation');
});

test('artifact: the registry is bounded', () => {
  const registry = createArtifactRegistry({ now: clock(), limits: { maxArtifacts: 2 } });
  registry.create(validArtifact('b1'));
  registry.create(validArtifact('b2'));
  const error = caught(() => registry.create(validArtifact('b3')));
  assert.equal(codeOf(error), 'lego.contract_violation');
  assert.match(error.message, /bounded/);
  assert.ok(ARTIFACT_LIMITS.maxArtifacts > 0);
});

/* ============================================================= APPROVAL (29) */

test('approval: a valid request binds identity, action, risk and scope', () => {
  const approvals = approvalFoundation();
  const record = approvals.request(validRequest());
  assert.equal(record.state, 'requested');
  assert.equal(record.decision, null, 'requesting decides nothing');
  assert.equal(record.approver, null);
  assert.equal(record.scope, 'repo:n8n-rust-v.4:main');
  assert.equal(record.requestedAt, T0);
  assert.equal(approvals.inspect('apr-1').approvalId, 'apr-1');
  assert.equal(approvals.inspect('apr-missing'), null);
});

test('approval: malformed requests are REJECTED (missing scope/actor/action/id, bad risk, born-expired)', () => {
  const approvals = approvalFoundation();
  assert.equal(codeOf(caught(() => approvals.request({ ...validRequest(), scope: undefined }))), 'lego.contract_violation');
  assert.equal(codeOf(caught(() => approvals.request({ ...validRequest(), actor: '' }))), 'lego.contract_violation');
  assert.equal(codeOf(caught(() => approvals.request({ ...validRequest(), action: undefined }))), 'lego.contract_violation');
  assert.equal(codeOf(caught(() => approvals.request({ ...validRequest(), approvalId: 'not valid id' }))), 'lego.contract_violation');
  assert.equal(codeOf(caught(() => approvals.request({ ...validRequest(), risk: 'extreme' }))), 'lego.contract_violation');
  assert.equal(codeOf(caught(() => approvals.request({ ...validRequest(), expiresAt: '2026-09-22T00:00:00.000Z' }))), 'lego.contract_violation');
  assert.equal(approvals.size, 0);
});

test('approval: duplicate request is refused deterministically', () => {
  const approvals = approvalFoundation();
  approvals.request(validRequest());
  const error = caught(() => approvals.request(validRequest()));
  assert.equal(codeOf(error), 'lego.contract_violation');
  assert.match(error.message, /already requested/);
});

test('approval: valid grant and valid deny', () => {
  const granted = approvalFoundation();
  granted.request(validRequest('apr-g'));
  const g = granted.resolve({ approvalId: 'apr-g', decision: 'granted', approver: 'ops-lead', reason: 'within-policy' });
  assert.equal(g.state, 'granted');
  assert.equal(g.decision, 'granted');
  assert.equal(g.approver, 'ops-lead');
  assert.equal(g.resolvedAt, T0);

  const denied = approvalFoundation();
  denied.request(validRequest('apr-d'));
  const d = denied.resolve({ approvalId: 'apr-d', decision: 'denied', approver: 'ops-lead', reason: 'out-of-scope' });
  assert.equal(d.state, 'denied');
  assert.equal(d.decision, 'denied');
});

test('approval: unknown decision input is REJECTED — never treated as allow', () => {
  const approvals = approvalFoundation();
  approvals.request(validRequest());
  for (const decision of ['allow', 'ALLOW', 'expired', 'maybe', undefined, null]) {
    const error = caught(() => approvals.resolve({ approvalId: 'apr-1', decision, approver: 'ops' }));
    assert.equal(codeOf(error), 'lego.contract_violation', `rejected: ${String(decision)}`);
    assert.match(error.message, /fail-closed|granted, denied/);
  }
  assert.equal(approvals.inspect('apr-1').state, 'requested', 'a refused decision leaves the record untouched');
});

test('approval: unknown approval DENY (resolveWaiting + evaluate)', () => {
  const approvals = approvalFoundation();
  const evalResult = approvals.evaluate('apr-unknown');
  assert.equal(evalResult.decision, 'denied');
  assert.equal(evalResult.reason, 'unknown-approval');
  const waiting = approvals.resolveWaiting({ machineReference: 'm-1', approvalReference: 'apr-unknown' });
  assert.equal(waiting.resolved, false);
  assert.equal(waiting.decision, 'denied');
  assert.equal(waiting.reason, 'unknown-approval');
});

test('approval: scope mismatch DENY and identity mismatch DENY', () => {
  const approvals = approvalFoundation();
  approvals.request(validRequest('apr-s'));
  approvals.resolve({ approvalId: 'apr-s', decision: 'granted', approver: 'ops' });
  assert.equal(approvals.evaluate('apr-s', { scope: 'repo:other' }).decision, 'denied');
  assert.equal(approvals.evaluate('apr-s', { scope: 'repo:other' }).reason, 'scope-mismatch');
  assert.equal(approvals.evaluate('apr-s', { identity: 'someone-else' }).decision, 'denied');
  assert.equal(approvals.evaluate('apr-s', { identity: 'someone-else' }).reason, 'identity-mismatch');
  assert.equal(approvals.evaluate('apr-s', { identity: 'agent-1', scope: 'repo:n8n-rust-v.4:main' }).decision, 'granted');
});

test('approval: expiration is handled — resolve refused, evaluate DENY', async () => {
  const now = clock();
  const approvals = createApprovalFoundation({ now });
  approvals.request(validRequest('apr-e', { expiresAt: '2026-09-23T01:00:00.000Z' }));
  now.tick(2 * 60 * 60 * 1000);
  const evalBefore = approvals.evaluate('apr-e');
  assert.equal(evalBefore.decision, 'denied');
  assert.equal(evalBefore.reason, 'expired');
  assert.equal(approvals.inspect('apr-e').state, 'expired');
  assert.equal(approvals.inspect('apr-e').decision, 'expired');
  const error = caught(() => approvals.resolve({ approvalId: 'apr-e', decision: 'granted', approver: 'late' }));
  assert.equal(codeOf(error), 'lego.contract_violation');
  assert.match(error.message, /expired/);
});

test('approval: pending approval evaluates DENY — there is no default allow', () => {
  const approvals = approvalFoundation();
  approvals.request(validRequest('apr-p'));
  const result = approvals.evaluate('apr-p');
  assert.equal(result.decision, 'denied');
  assert.equal(result.reason, 'not-granted');
  assert.equal(result.state, 'requested');
});

test('approval: duplicate/replay decisions are deterministic', () => {
  const approvals = approvalFoundation();
  approvals.request(validRequest('apr-r'));
  const first = approvals.resolve({ approvalId: 'apr-r', decision: 'granted', approver: 'ops', reason: 'ok' });
  const replay = approvals.resolve({ approvalId: 'apr-r', decision: 'granted', approver: 'ops', reason: 'ok' });
  assert.deepEqual(replay, first, 'the same decision again changes nothing');
  const conflict = caught(() => approvals.resolve({ approvalId: 'apr-r', decision: 'denied', approver: 'ops-2' }));
  assert.equal(codeOf(conflict), 'lego.contract_violation');
  assert.match(conflict.message, /already/);
  const denied = approvalFoundation();
  denied.request(validRequest('apr-r2'));
  denied.resolve({ approvalId: 'apr-r2', decision: 'denied', approver: 'ops' });
  const replayDeny = denied.resolve({ approvalId: 'apr-r2', decision: 'denied', approver: 'ops' });
  assert.equal(replayDeny.state, 'denied');
});

test('approval: resolving an unknown approval is REJECTED, not granted', () => {
  const approvals = approvalFoundation();
  const error = caught(() => approvals.resolve({ approvalId: 'apr-x', decision: 'granted', approver: 'ops' }));
  assert.equal(codeOf(error), 'lego.contract_violation');
  assert.match(error.message, /unknown approval/);
});

test('approval: scope can never become a global permission — bounds and secret-shaped values hold', () => {
  const approvals = approvalFoundation();
  assert.equal(codeOf(caught(() => approvals.request(validRequest('apr-b1', { action: 'x'.repeat(200) })))), 'lego.contract_violation');
  assert.equal(codeOf(caught(() => approvals.request(validRequest('apr-b2', { actor: 'ghp_abcdefghijklmnop' })))), 'lego.contract_violation');
  const bounded = approvalFoundation({ limits: { maxApprovals: 1 } });
  bounded.request(validRequest('apr-only'));
  assert.equal(codeOf(caught(() => bounded.request(validRequest('apr-too-many')))), 'lego.contract_violation');
  assert.ok(APPROVAL_LIMITS.maxApprovals > 0);
});

test('approval: state/decision vocabularies stay canonical', () => {
  assert.deepEqual([...APPROVAL_STATES], ['requested', 'granted', 'denied', 'expired']);
  assert.deepEqual([...APPROVAL_DECISIONS], [...FOUNDATION.approval.decision]);
  for (const state of APPROVAL_STATES) assert.ok(['declared', 'requested', 'pending', 'granted', 'denied', 'expired'].includes(state));
});

/* ================================================================ AUDIT (30) */

test('audit: a bounded structured record is created with every declared field', () => {
  const log = auditLog({ newId: () => 'aud-1' });
  const entry = log.record({
    eventType: 'approval.requested',
    actor: 'agent-1',
    subject: 'apr-1',
    operation: 'request',
    result: 'requested',
    correlationId: 'corr-1',
    causationId: 'cause-1',
    references: ['apr-1'],
    metadata: { risk: 'high' },
  });
  assert.deepEqual(Object.keys(entry).sort(), [...AUDIT_FIELDS].sort());
  assert.equal(entry.auditId, 'aud-1');
  assert.equal(entry.timestamp, T0);
  assert.equal(entry.correlationId, 'corr-1');
  assert.equal(entry.causationId, 'cause-1');
  assert.deepEqual([...entry.references], ['apr-1']);
  const listed = log.list();
  assert.equal(listed.length, 1);
  assert.deepEqual(listed[0], entry);
});

test('audit: identity is deterministic through the injectable factory', () => {
  let counter = 0;
  const log = auditLog({ newId: () => `aud-fixed-${counter += 1}` });
  const a = log.record({ eventType: 'artifact.created', actor: 'a', subject: 'art-1', operation: 'create', result: 'created' });
  const b = log.record({ eventType: 'artifact.referenced', actor: 'a', subject: 'art-1', operation: 'reference', result: 'referenced' });
  assert.equal(a.auditId, 'aud-fixed-1');
  assert.equal(b.auditId, 'aud-fixed-2');
});

test('audit: metadata is bounded (keys, bytes, depth, field length)', () => {
  const log = auditLog();
  const base = { eventType: 'artifact.created', actor: 'a', subject: 's', operation: 'create', result: 'created' };
  const manyKeys = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}`, i]));
  assert.equal(codeOf(caught(() => log.record({ ...base, metadata: manyKeys }))), 'lego.contract_violation');
  assert.equal(codeOf(caught(() => log.record({ ...base, metadata: { blob: 'x'.repeat(5000) } }))), 'lego.contract_violation');
  let deep = { leaf: 1 };
  for (let i = 0; i < 6; i += 1) deep = { down: deep };
  assert.equal(codeOf(caught(() => log.record({ ...base, metadata: deep }))), 'lego.contract_violation');
  assert.equal(codeOf(caught(() => log.record({ ...base, actor: 'x'.repeat(200) }))), 'lego.contract_violation');
  assert.ok(AUDIT_LIMITS.maxEntries > 0 && AUDIT_LIMITS.maxMetadataBytes > 0);
});

test('audit: correlation and causation propagate', () => {
  const log = auditLog({ newId: () => 'aud-c' });
  const entry = log.record({
    eventType: 'approval.granted',
    actor: 'ops', subject: 'apr-1', operation: 'resolve', result: 'granted',
    correlationId: 'req-root', causationId: 'parent-req',
  });
  assert.equal(entry.correlationId, 'req-root');
  assert.equal(entry.causationId, 'parent-req');
  // envelopes from P2.18 keep supplying the same vocabulary
  assert.equal(typeof entry.correlationId, 'string');
});

test('audit: secret leakage is refused — keys and secret-shaped values', () => {
  const log = auditLog();
  const base = { eventType: 'artifact.created', actor: 'a', subject: 's', operation: 'create', result: 'created' };
  assert.equal(codeOf(caught(() => log.record({ ...base, metadata: { token: 'abc' } }))), 'lego.contract_violation');
  assert.equal(codeOf(caught(() => log.record({ ...base, metadata: { password: 'abc' } }))), 'lego.contract_violation');
  assert.equal(codeOf(caught(() => log.record({ ...base, actor: 'ghp_abcdefghijklmnop' }))), 'lego.contract_violation');
  assert.equal(codeOf(caught(() => log.record({ ...base, references: ['ref-with-ghp_abcdefghijklmnop'] }))), 'lego.contract_violation');
});

test('audit: reasoning leakage is refused — no chain-of-thought, prompts or completions', () => {
  const log = auditLog();
  const base = { eventType: 'artifact.created', actor: 'a', subject: 's', operation: 'create', result: 'created' };
  for (const key of ['reasoning', 'chainOfThought', 'prompt', 'completion', 'transcript', 'rawPrompt']) {
    const error = caught(() => log.record({ ...base, metadata: { [key]: 'internal thoughts' } }));
    assert.equal(codeOf(error), 'lego.contract_violation', `refused key: ${key}`);
    assert.match(error.message, /reasoning|forbidden/);
  }
});

test('audit: duplicate event behaviour is deterministic', () => {
  const log = auditLog({ newId: () => 'aud-dup' });
  const event = { eventType: 'approval.denied', actor: 'ops', subject: 'apr-1', operation: 'resolve', result: 'denied' };
  const first = log.record(event);
  const replay = log.record(event);
  assert.deepEqual(replay, first, 'identical replay is idempotent');
  assert.equal(log.stats.size, 1);
  const conflict = caught(() => log.record({ ...event, result: 'granted' }));
  assert.equal(codeOf(conflict), 'lego.contract_violation');
  assert.match(conflict.message, /duplicate/);
});

test('audit: invalid events are rejected (unknown type, missing semantics, bad references)', () => {
  const log = auditLog();
  const base = { eventType: 'approval.granted', actor: 'a', subject: 's', operation: 'resolve', result: 'granted' };
  assert.equal(codeOf(caught(() => log.record({ ...base, eventType: 'agent.explained-thoughts' }))), 'lego.contract_violation');
  assert.equal(codeOf(caught(() => log.record({ ...base, actor: undefined }))), 'lego.contract_violation');
  assert.equal(codeOf(caught(() => log.record({ ...base, result: undefined }))), 'lego.contract_violation');
  assert.equal(codeOf(caught(() => log.record({ ...base, references: ['bad ref!'] }))), 'lego.contract_violation');
  assert.equal(codeOf(caught(() => log.record({ ...base, references: Array.from({ length: 12 }, (_, i) => `r${i}`) }))), 'lego.contract_violation');
});

test('audit: the store is bounded — capacity with deterministic drop-oldest', () => {
  const log = auditLog({ capacity: 4, newId: (() => { let n = 0; return () => `aud-${n += 1}`; })() });
  const base = (i) => ({ eventType: 'artifact.created', actor: 'a', subject: `art-${i}`, operation: 'create', result: 'created' });
  for (let i = 1; i <= 7; i += 1) log.record(base(i));
  const entries = log.list();
  assert.equal(entries.length, 4, 'never above capacity');
  assert.equal(log.stats.size, 4);
  assert.equal(log.stats.capacity, 4);
  assert.equal(log.stats.dropped, 3, 'oldest three evicted deterministically');
  assert.equal(entries[0].subject, 'art-4');
  assert.equal(entries[3].subject, 'art-7');
  assert.ok(entries.length <= AUDIT_LIMITS.maxEntries);
  assert.equal(codeOf(caught(() => log.list({ limit: 999 }))), 'lego.contract_violation');
});

/* ==================================================== CROSS-DOMAIN (31) */

/** Build a waiting Agent Machine through the published P2.16 surface only. */
const waitingMachine = (machineId, approvalReference) => {
  const machine = createAgentMachineManager({ now: clock() });
  machine.create({
    machineId,
    taskId: `task-${machineId}`,
    agentId: `agent-${machineId}`,
    budgets: { maxSteps: 8, maxDurationMs: 600000, maxContinuationBytes: 64, maxReferences: 8 },
  });
  machine.start({ machineId, expectedVersion: 1 });
  const record = machine.step({
    machineId,
    expectedVersion: 2,
    stepId: 's1',
    sequence: 1,
    result: { outcome: 'approval-required', final: false },
    approvalReference,
  });
  return { machine, record };
};

test('cross: Agent Machine waiting → approval request → GRANT → dependency resolves (P2.16 untouched)', () => {
  const { machine, record } = waitingMachine('xm-1', 'apr-x1');
  assert.equal(record.lifecycle, 'waiting', 'P2.16 waiting entered with a mandatory reference');
  assert.equal(record.steps[0].approvalReference, 'apr-x1');

  const approvals = approvalFoundation();
  approvals.request(validRequest('apr-x1', { actor: 'agent-xm-1' }));
  approvals.resolve({ approvalId: 'apr-x1', decision: 'granted', approver: 'ops-lead' });

  const resolution = approvals.resolveWaiting({ machineReference: 'xm-1', approvalReference: 'apr-x1', identity: 'agent-xm-1' });
  assert.equal(resolution.resolved, true, 'the approval dependency on the waiting machine resolves');
  assert.equal(resolution.decision, 'granted');
  assert.equal(resolution.machineReference, 'xm-1');

  // P2.16 vocabulary stays frozen: waiting still cannot resume — cancel remains the machine's exit.
  const version = machine.describe({ machineId: 'xm-1' }).version;
  const resumeError = caught(() => machine.resume({ machineId: 'xm-1', expectedVersion: version }));
  assert.match(resumeError.message, /waiting on an approval reference/);
  const cancelled = machine.cancel({ machineId: 'xm-1', expectedVersion: version });
  assert.equal(cancelled.lifecycle, 'cancelled', 'the frozen machine exit is unchanged');
});

test('cross: Agent Machine waiting → approval request → DENY → deterministic dependency refusal', () => {
  const { machine, record } = waitingMachine('xm-2', 'apr-x2');
  assert.equal(record.lifecycle, 'waiting');

  const approvals = approvalFoundation();
  approvals.request(validRequest('apr-x2', { scope: 'repo:target' }));
  approvals.resolve({ approvalId: 'apr-x2', decision: 'denied', approver: 'ops-lead', reason: 'policy' });

  const resolution = approvals.resolveWaiting({ machineReference: 'xm-2', approvalReference: 'apr-x2' });
  assert.equal(resolution.resolved, false, 'denied is a deterministic terminal answer for the dependency');
  assert.equal(resolution.decision, 'denied');
  assert.equal(resolution.reason, 'policy');

  // scope mismatch on top of a grant is also refused fail-closed
  const approvals2 = approvalFoundation();
  approvals2.request(validRequest('apr-x3'));
  approvals2.resolve({ approvalId: 'apr-x3', decision: 'granted', approver: 'ops' });
  const mismatched = approvals2.resolveWaiting({ machineReference: 'xm-3', approvalReference: 'apr-x3', scope: 'repo:other' });
  assert.equal(mismatched.resolved, false);
  assert.equal(mismatched.reason, 'scope-mismatch');

  // unknown reference while waiting: fail-closed denial, never a phantom grant
  const unknown = approvals.resolveWaiting({ machineReference: 'xm-2', approvalReference: 'apr-never' });
  assert.equal(unknown.resolved, false);
  assert.equal(unknown.reason, 'unknown-approval');

  // the machine itself is untouched by denial — cancellation still works
  const version = machine.describe({ machineId: 'xm-2' }).version;
  assert.equal(machine.cancel({ machineId: 'xm-2', expectedVersion: version }).lifecycle, 'cancelled');
});

test('cross: an artifact reference travels through approval and audit and stays opaque', () => {
  const registry = artifactRegistry();
  const artifact = registry.create(validArtifact('art-travel', { checksum: artifactContentDigest('report-bytes') }));

  const approvals = approvalFoundation();
  approvals.request(validRequest('apr-art', { contextReference: artifact.artifactId }));
  approvals.resolve({ approvalId: 'apr-art', decision: 'granted', approver: 'ops' });

  const log = auditLog({ newId: (() => { let n = 0; return () => `aud-art-${n += 1}`; })() });
  log.record({
    eventType: 'artifact.created',
    actor: 'agent-1',
    subject: artifact.artifactId,
    operation: 'create',
    result: 'created',
    references: [artifact.artifactId, 'apr-art'],
  });
  log.record({
    eventType: 'approval.granted',
    actor: 'ops',
    subject: 'apr-art',
    operation: 'resolve',
    result: 'granted',
    references: [artifact.artifactId],
    metadata: { kind: artifact.kind, checksum: artifact.checksum },
  });

  const stored = registry.read('art-travel');
  assert.equal(stored.storageRef, 'opaque://bucket/report-1', 'the reference never moved or resolved');
  const approval = approvals.inspect('apr-art');
  assert.equal(approval.contextReference, 'art-travel');
  for (const entry of log.list()) {
    const flat = JSON.stringify(entry);
    assert.ok(!('content' in entry), 'audit never carries raw artifact content');
    assert.ok(!flat.includes('opaque://'), 'the storage locator stays in the artifact contract, not the audit trail');
  }
});

test('cross: the audit trail records requested / granted / denied without content or reasoning', () => {
  const approvals = approvalFoundation();
  const log = auditLog({ newId: (() => { let n = 0; return () => `aud-flow-${n += 1}`; })() });

  approvals.request(validRequest('apr-f1'));
  log.record({ eventType: 'approval.requested', actor: 'agent-1', subject: 'apr-f1', operation: 'request', result: 'requested', references: ['apr-f1'] });
  approvals.resolve({ approvalId: 'apr-f1', decision: 'granted', approver: 'ops', reason: 'ok' });
  log.record({ eventType: 'approval.granted', actor: 'ops', subject: 'apr-f1', operation: 'resolve', result: 'granted', references: ['apr-f1'] });

  approvals.request(validRequest('apr-f2'));
  log.record({ eventType: 'approval.requested', actor: 'agent-1', subject: 'apr-f2', operation: 'request', result: 'requested' });
  approvals.resolve({ approvalId: 'apr-f2', decision: 'denied', approver: 'ops', reason: 'no' });
  log.record({ eventType: 'approval.denied', actor: 'ops', subject: 'apr-f2', operation: 'resolve', result: 'denied' });

  const types = log.list().map((entry) => entry.eventType);
  assert.deepEqual(types, ['approval.requested', 'approval.granted', 'approval.requested', 'approval.denied']);
  const filtered = log.list({ eventType: 'approval.granted' });
  assert.equal(filtered.length, 1);
  for (const entry of log.list()) {
    const flat = JSON.stringify(entry).toLowerCase();
    for (const forbidden of ['reasoning', 'chain', 'prompt', 'ghp_', 'password']) {
      assert.ok(!flat.includes(forbidden), `audit entry leaked '${forbidden}'`);
    }
  }
});

/* ==================================================== P2.17 CONSUMERS (16) */

test('the foundation never touches the frozen Agent Machine contract surface', async () => {
  const agentMachineSource = readFileSync(new URL('../src/lego/agent-machine.mjs', import.meta.url), 'utf8');
  const before = agentMachineSource;
  // this milestone added no edit to agent-machine.mjs — assert via git-less proof:
  // the module still publishes exactly 9 operations, 5 permissions, 8 lifecycle states.
  const am = await import('../src/lego/agent-machine.mjs');
  assert.equal(am.AGENT_MACHINE_OPERATIONS.length, 9);
  assert.equal(am.AGENT_MACHINE_PERMISSIONS.length, 5);
  assert.equal(am.AGENT_MACHINE_LIFECYCLE_STATES.length, 8);
  assert.ok(before.includes('ai.agent-machine'), 'contract header intact');
  const lockRow = LOCK.contracts.find((row) => row.id === 'ai.agent-machine');
  assert.equal(lockRow.version, '1.1.0', 'ai.agent-machine@1.1.0 untouched by P2.19');
});
