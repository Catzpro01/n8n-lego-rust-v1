/** P2.13 backend Context & Session contract and lifecycle tests. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  AGENT_SESSION_CONTRACT,
  AGENT_SESSION_STATES,
  AGENT_SESSION_TRANSITIONS,
  CONTEXT_CONTRACT,
  CONTEXT_MANAGER_STATES,
  CONTEXT_SCOPES,
  CONTINUATION_FIELDS,
  createContextSessionManager,
  verifyContinuationPackage,
} from '../src/lego/context-session.mjs';
import {
  AGENT_SESSION_CONTRACT as SESSION_PUBLIC_CONTRACT,
  createContextSessionManager as createFromSessionContract,
} from '../src/lego/agent-session.mjs';
import { CONTEXT_CONTRACT as CONTEXT_PUBLIC_CONTRACT } from '../src/lego/context.mjs';

const NOW = () => '2026-09-22T00:00:00.000Z';
const continuationFields = () => ({
  objective: 'finish the bounded task',
  plan: ['inspect', 'implement', 'verify'],
  completedWork: ['inspect'],
  unfinishedWork: ['implement', 'verify'],
  constraints: ['do not execute a provider'],
  decisions: ['keep Memory separate'],
  activeEntities: [{ id: 'task-1', kind: 'task' }],
  toolStateReferences: [{ ref: 'tool-state-1', kind: 'reference' }],
  artifacts: [{ artifactId: 'artifact-1', checksum: 'abc123' }],
  importantReferences: [{ ref: 'docs-1', kind: 'document' }],
  errors: [],
  unresolvedQuestions: ['which provider is configured later'],
  compressedHistory: 'bounded summary only',
});

function manager(options = {}) {
  return createContextSessionManager({ now: NOW, ...options });
}

function runningSession(m = manager()) {
  const context = m.createContext({
    contextId: 'ctx-1',
    scope: 'TASK',
    source: 'test',
    snapshotData: { objective: 'bounded', decision: 'separate memory' },
  });
  const session = m.createSession({ sessionId: 'session-1', agentId: 'agent-1', taskId: 'task-1', contextRef: context.contextId });
  m.transitionSession(session.sessionId, 'running');
  return { m, context, session: m.getSession(session.sessionId) };
}

test('contracts exist with the canonical fields and vocabulary', () => {
  assert.equal(CONTEXT_CONTRACT.id, 'ai.context');
  assert.equal(CONTEXT_CONTRACT.version, '1.0.0');
  assert.deepEqual(CONTEXT_SCOPES, ['GLOBAL', 'WORKFLOW', 'NODE', 'EXECUTION', 'EVENT', 'AGENT', 'TASK']);
  for (const field of ['contextId', 'scope', 'parent', 'snapshot', 'version', 'source', 'dependencies', 'size', 'checksum']) {
    assert.ok(CONTEXT_CONTRACT.fields.includes(field), `missing context field ${field}`);
  }
  assert.equal(AGENT_SESSION_CONTRACT.id, 'ai.agent-session');
  assert.equal(AGENT_SESSION_CONTRACT.version, '1.0.0');
  for (const field of ['sessionId', 'agentId', 'parentSessionId', 'taskId', 'workflowId', 'executionId', 'runtimeId', 'status', 'createdAt', 'updatedAt', 'contextRef', 'artifactRef', 'traceRef']) {
    assert.ok(AGENT_SESSION_CONTRACT.fields.includes(field), `missing session field ${field}`);
  }
  assert.deepEqual(CONTEXT_PUBLIC_CONTRACT, CONTEXT_CONTRACT);
  assert.deepEqual(SESSION_PUBLIC_CONTRACT, AGENT_SESSION_CONTRACT);
});

test('session states and context manager states are explicit, not booleans', () => {
  assert.deepEqual(AGENT_SESSION_STATES, ['created', 'running', 'waiting', 'paused', 'completed', 'failed', 'cancelled']);
  assert.deepEqual(CONTEXT_MANAGER_STATES, ['NORMAL', 'PREPARE', 'ROLLOVER']);
  assert.deepEqual(AGENT_SESSION_TRANSITIONS.created, ['running', 'waiting', 'cancelled']);
  assert.deepEqual(AGENT_SESSION_TRANSITIONS.completed, []);
  const foundation = JSON.parse(readFileSync(new URL('../src/lego/manifest/ai-foundation.json', import.meta.url), 'utf8'));
  assert.deepEqual(foundation.agentSession.transitions, AGENT_SESSION_TRANSITIONS,
    'the implementation transition table must have a declarative backend source');
});

test('context creation validates scope, parent references, snapshot identity and checksum lineage', () => {
  const m = manager();
  const parent = m.createContext({ contextId: 'ctx-parent', scope: 'GLOBAL', snapshotData: { rule: 'one' } });
  const child = m.createContext({ contextId: 'ctx-child', scope: 'TASK', parent: { contextId: parent.contextId, checksum: parent.checksum }, snapshotData: { rule: 'two' } });
  assert.equal(child.parent, parent.contextId);
  assert.equal(child.snapshot.parentChecksum, parent.checksum);
  assert.notEqual(child.checksum, parent.checksum);
  assert.throws(() => m.createContext({ contextId: 'bad-scope', scope: 'UNKNOWN', snapshotData: {} }), /scope/);
  assert.throws(() => m.createContext({ contextId: 'bad-parent', scope: 'TASK', parent: 'missing', snapshotData: {} }), /parent context/);
  assert.throws(() => m.createContext({ contextId: 'bad-chain', scope: 'TASK', parent: { contextId: parent.contextId, checksum: 'wrong' }, snapshotData: {} }), /checksum/);
});

test('selective load never dumps the complete snapshot by default', () => {
  const m = manager();
  const context = m.createContext({ contextId: 'ctx-select', scope: 'TASK', snapshotData: { objective: 'keep', privateSummary: 'bounded' } });
  const metadata = m.getContext(context.contextId);
  assert.equal(Object.hasOwn(metadata.snapshot, 'data'), false);
  assert.deepEqual(m.loadContext(context.contextId).snapshot.data, {});
  assert.deepEqual(m.loadContext(context.contextId, { select: ['objective'] }).snapshot.data, { objective: 'keep' });
  assert.throws(() => m.loadContext(context.contextId, { select: ['*'] }), /selective/);
});

test('session lifecycle accepts declared transitions and rejects invalid transitions', () => {
  const { m, session } = runningSession();
  assert.equal(session.status, 'running');
  assert.equal(m.transitionSession(session.sessionId, 'waiting').status, 'waiting');
  assert.equal(m.transitionSession(session.sessionId, 'paused').status, 'paused');
  assert.equal(m.transitionSession(session.sessionId, 'running').status, 'running');
  assert.equal(m.transitionSession(session.sessionId, 'completed').status, 'completed');
  assert.throws(() => m.transitionSession(session.sessionId, 'running'), (error) => error.code === 'lego.interaction_mismatch');
});

test('session state is bounded identity plus references, never transcript data', () => {
  const { m, session } = runningSession();
  assert.equal('transcript' in session, false);
  assert.equal('messages' in session, false);
  assert.equal('contextRef' in session, true);
  assert.equal('artifactRef' in session, true);
  assert.equal('traceRef' in session, true);
  assert.throws(() => m.createSession({ sessionId: 'session-2', agentId: 'agent-2', transcript: 'raw conversation' }), /not allowed|unbounded/);
});

test('close implements explicit completion, failure and cancellation semantics', () => {
  const completed = runningSession();
  assert.equal(completed.m.closeSession(completed.session.sessionId).status, 'completed');
  assert.equal(completed.m.closeSession(completed.session.sessionId).status, 'completed', 'same terminal close is idempotent');
  assert.throws(() => completed.m.closeSession(completed.session.sessionId, { status: 'cancelled' }), /already closed/);

  const cancelled = manager();
  const cancelledSession = cancelled.createSession({ sessionId: 'cancel-me', agentId: 'agent-1' });
  assert.equal(cancelled.closeSession(cancelledSession.sessionId, { status: 'cancelled' }).status, 'cancelled');

  const failed = runningSession();
  assert.equal(failed.m.closeSession(failed.session.sessionId, { status: 'failed' }).status, 'failed');
  assert.throws(() => failed.m.closeSession(failed.session.sessionId, { status: 'running' }), /not terminal|already closed/);
});

test('compaction creates an explicitly descended bounded snapshot', () => {
  const m = manager();
  const original = m.createContext({ contextId: 'ctx-original', scope: 'TASK', snapshotData: { a: 1, b: 2 } });
  const compacted = m.compactContext(original.contextId, { contextId: 'ctx-compacted', snapshotData: { summary: 'a bounded reduction' } });
  assert.equal(compacted.parent, original.contextId);
  assert.equal(compacted.snapshot.parentChecksum, original.checksum);
  assert.equal(compacted.version, original.version + 1);
  assert.notEqual(compacted.snapshot.snapshotId, original.snapshot.snapshotId);
  assert.deepEqual(m.loadContext(compacted.contextId, { select: ['summary'] }).snapshot.data, { summary: 'a bounded reduction' });
  assert.throws(() => m.compactContext(original.contextId), /explicit.*snapshotData/);
});

test('usage crosses a declared threshold before 100 percent and enters PREPARE', () => {
  const m = manager({ prepareThreshold: 0.75 });
  const context = m.createContext({ contextId: 'ctx-usage', scope: 'TASK', snapshotData: {} });
  assert.equal(m.state, 'NORMAL');
  const normal = m.observe(context.contextId, { utilization: 0.4 });
  assert.equal(normal.state, 'NORMAL');
  const prepare = m.observe(context.contextId, { utilization: 0.75 });
  assert.equal(prepare.state, 'PREPARE');
  assert.equal(prepare.triggered, true);
  assert.throws(() => m.observe(context.contextId, { tokenLimit: 1000, utilization: 0.8 }), /exact token-limit/);
});

test('continuation package preserves all required state and has a verifiable checksum', () => {
  const { m, session } = runningSession();
  const packageRecord = m.buildContinuation(session.sessionId, continuationFields());
  for (const field of CONTINUATION_FIELDS) assert.ok(field in packageRecord, `missing ${field}`);
  assert.equal(packageRecord.identity.sessionId, session.sessionId);
  assert.equal(packageRecord.identity.contextId, session.contextRef.contextId);
  assert.equal(typeof packageRecord.checksum, 'string');
  assert.equal(verifyContinuationPackage(packageRecord).status, 'verified');
});

test('missing identity and tampered continuation state fail closed', () => {
  const { m, session } = runningSession();
  const packageRecord = m.buildContinuation(session.sessionId, continuationFields());
  const tampered = { ...packageRecord, unfinishedWork: ['silently changed'] };
  const verdict = verifyContinuationPackage(tampered);
  assert.equal(verdict.status, 'failed');
  assert.ok(verdict.reasons.includes('checksum-mismatch'));
  assert.throws(() => m.rehydrateContinuation({ ...packageRecord, identity: null }), /verification failed/);
});

test('verification distinguishes degraded from failed continuation', () => {
  const { m, session } = runningSession();
  const packageRecord = m.buildContinuation(session.sessionId, continuationFields());
  const tampered = { ...packageRecord, packageVersion: '1.0.1' };
  assert.equal(verifyContinuationPackage(tampered).status, 'failed');
  assert.ok(verifyContinuationPackage(tampered).reasons.includes('checksum-mismatch'));
  // A package produced by the manager can explicitly carry an unavailable
  // optional reference. That is degraded, not silently repaired and not failed.
  const degradedFields = continuationFields();
  degradedFields.importantReferences = [{ ref: 'optional-1', kind: 'reference', availability: 'degraded' }];
  const degradedPackage = m.buildContinuation(session.sessionId, degradedFields);
  const verdict = verifyContinuationPackage(degradedPackage);
  assert.equal(verdict.status, 'degraded');
  assert.ok(verdict.reasons.includes('optional-reference-degraded'));
});

test('rehydration returns explicit verification and creates a linked child session', () => {
  const { m, session } = runningSession();
  const packageRecord = m.buildContinuation(session.sessionId, continuationFields());
  const context = m.compactContext(session.contextRef.contextId, { contextId: 'ctx-rehydrated', snapshotData: { continuation: packageRecord.continuationId } });
  const result = m.rehydrateContinuation(packageRecord, { contextId: context.contextId, sessionId: 'session-child', parentSessionId: session.sessionId });
  assert.equal(result.verification.status, 'verified');
  assert.equal(result.session.parentSessionId, session.sessionId);
  assert.equal(result.session.contextRef.contextId, context.contextId);
});

test('rollover follows NORMAL to PREPARE to ROLLOVER, links context/session, and verifies continuity', () => {
  const { m, session } = runningSession();
  const result = m.rollover(session.sessionId, { ...continuationFields(), nextContextId: 'ctx-next', nextSessionId: 'session-next' });
  assert.equal(result.state, 'ROLLOVER');
  assert.equal(result.finalState, 'NORMAL');
  assert.equal(result.linked, true);
  assert.equal(result.verification.status, 'verified');
  assert.equal(result.nextContext.parent, session.contextRef.contextId);
  assert.equal(result.nextSession.parentSessionId, session.sessionId);
  assert.deepEqual(m.status().stateHistory, ['NORMAL', 'PREPARE', 'ROLLOVER', 'NORMAL']);
  assert.equal(m.getSession(session.sessionId).status, 'completed');
});

test('rollover does not silently repair an invalid continuation', () => {
  const { m, session } = runningSession();
  const invalid = continuationFields();
  delete invalid.unfinishedWork;
  assert.throws(() => m.rollover(session.sessionId, invalid), /missing required state/);
  assert.equal(m.getSession(session.sessionId).status, 'running');
});

test('secrets, private reasoning, arbitrary paths and capability grants are rejected', () => {
  const m = manager();
  assert.throws(() => m.createContext({ scope: 'TASK', snapshotData: { apiToken: 'not allowed' } }), /not allowed/);
  assert.throws(() => m.createContext({ scope: 'TASK', snapshotData: { chainOfThought: 'private' } }), /not allowed/);
  assert.throws(() => m.createContext({ scope: 'TASK', snapshotData: { hostPath: '/etc/passwd' } }), /not allowed|host path/);
  assert.throws(() => m.createContext({ scope: 'TASK', snapshotData: { capabilityGrants: ['admin'] } }), /not allowed/);
});

test('context and continuation limits fail closed without a persistence or provider dependency', () => {
  const m = manager({ limits: { maxContextBytes: 32, maxContinuationBytes: 64, maxStateBytes: 256 } });
  assert.throws(() => m.createContext({ scope: 'TASK', snapshotData: { tooLarge: 'x'.repeat(100) } }), /bounded limit/);
  assert.equal(m.status().contextCount, 0);
  assert.equal(m.status().sessionCount, 0);
});

test('the session contract module shares the same factory and does not publish an execution loop', () => {
  const m = createFromSessionContract({ now: NOW });
  assert.equal(typeof m.createSession, 'function');
  assert.equal('execute' in m, false);
  assert.equal('run' in m, false);
  assert.equal('infer' in m, false);
});
