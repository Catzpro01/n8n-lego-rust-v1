import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  EXEC_DIAG_CONTRACT, EXEC_DIAG_OUTCOMES, EXEC_DIAG_LIMITS, EXEC_DIAG_IDENTITY_FIELDS,
  EXEC_DIAG_EVIDENCE_KINDS, EXEC_DIAG_FAILURE_CLASSES,
  createExecutionDiagnostic, summarizeFailure, serializeExecutionDiagnostic,
} from '../src/lego/execution-diagnostics.mjs';
import { containsSecretShape } from '../src/lego/telemetry-redaction.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/p9/execution-diagnostics.json', import.meta.url), 'utf8'));

test('P9.11 contract vocabulary: outcomes, identity fields, failure classes, evidence kinds', () => {
  assert.equal(EXEC_DIAG_CONTRACT.id, 'observability.execution-diagnostics');
  assert.equal(EXEC_DIAG_CONTRACT.version, '1.0.0');
  assert.equal(EXEC_DIAG_CONTRACT.owner, 'agent-6');
  assert.deepEqual([...EXEC_DIAG_OUTCOMES], fixture.outcomes);
  assert.deepEqual([...EXEC_DIAG_FAILURE_CLASSES], fixture.failureClasses);
  assert.deepEqual([...EXEC_DIAG_IDENTITY_FIELDS], fixture.identityFields);
  assert.ok(EXEC_DIAG_EVIDENCE_KINDS.includes('checkpoint'));
  assert.ok(EXEC_DIAG_EVIDENCE_KINDS.includes('replay'));
  assert.ok(EXEC_DIAG_EVIDENCE_KINDS.includes('artifact'));
  assert.ok(EXEC_DIAG_EVIDENCE_KINDS.includes('resource'));
});

test('P9.11 successful execution diagnostic', () => {
  const f = fixture.successfulDiagnostic;
  const d = createExecutionDiagnostic({
    outcome: f.outcome,
    identity: f.identity,
    resource: f.resource,
  });
  assert.ok(d);
  assert.equal(d.outcome, 'success');
  assert.equal(d.identity.executionId, 'exec-ok-1');
  assert.equal(d.identity.workflowId, 'wf-1');
  assert.equal(d.identity.workflowVersion, '3');
  assert.equal(d.identity.triggerId, 'trg-1');
  assert.equal(d.identity.runtimeId, 'rt-1');
  assert.equal(d.failure, null);
  assert.equal(d.resource.memoryUsedBytes, 1048576);
  assert.equal(d.resource.cpuPercent, 12.5);
  // refs/state/nodes absent → listed missing
  assert.ok(d.evidenceMissing.includes('refs'));
  assert.ok(d.evidenceMissing.includes('state'));
  assert.equal(summarizeFailure(d), null); // success has no failure summary
  const wire = serializeExecutionDiagnostic(d);
  assert.ok(wire);
  assert.equal(containsSecretShape(JSON.parse(wire)), false);
});

test('P9.11 failed execution diagnostic: full correlation + refs + summary', () => {
  const f = fixture.failedDiagnostic;
  const d = createExecutionDiagnostic({
    outcome: f.outcome,
    identity: f.identity,
    failure: f.failure,
    resource: f.resource,
    refs: f.refs,
    nodes: f.nodes,
  });
  assert.ok(d);
  assert.equal(d.outcome, 'failed');
  // correlation to workflow/version/trigger/node/runtime
  assert.equal(d.identity.workflowId, 'wf-42');
  assert.equal(d.identity.workflowVersion, '7');
  assert.equal(d.identity.triggerId, 'trg-hooks');
  assert.equal(d.identity.nodeId, 'http-1');
  assert.equal(d.identity.runtimeId, 'rt-2');
  // resource state attached
  assert.equal(d.resource.queueDepth, 12);
  // checkpoint/replay/artifact references attached
  assert.equal(d.refs.checkpoint, 'ckpt-abc');
  assert.equal(d.refs.replay, 'replay-xyz');
  assert.deepEqual([...d.refs.artifacts], ['artifact-1', 'artifact-2']);
  assert.equal(d.nodes.length, 1);
  assert.equal(d.nodes[0].outcome, 'failed');
  // standardized failure summary
  const s = summarizeFailure(d);
  assert.ok(s);
  assert.ok(s.fingerprint.startsWith(f.expectSummary.fingerprintPrefix));
  assert.equal(s.code, f.expectSummary.code);
  assert.equal(s.class, f.expectSummary.class);
  assert.equal(s.executionId, f.expectSummary.executionId);
  assert.equal(s.workflowId, 'wf-42');
  assert.equal(s.hasResource, true);
  assert.equal(s.hasRefs, true);
  assert.equal(containsSecretShape(s), false);
});

test('P9.11 missing-evidence diagnostic remains usable', () => {
  const f = fixture.missingEvidenceDiagnostic;
  const d = createExecutionDiagnostic({
    outcome: f.outcome,
    identity: f.identity,
    failure: f.failure,
  });
  assert.ok(d, 'missing evidence must not fail the diagnostic');
  assert.equal(d.outcome, 'failed');
  assert.equal(d.identity.executionId, 'exec-miss-1');
  assert.equal(d.identity.workflowId, 'wf-9');
  for (const field of f.expectEvidenceMissingIncludes) {
    assert.ok(d.evidenceMissing.includes(field), field);
    if (EXEC_DIAG_IDENTITY_FIELDS.includes(field)) {
      assert.equal(d.identity[field], null, field);
    }
  }
  // still summarizable
  const s = summarizeFailure(d);
  assert.ok(s);
  assert.ok(s.fingerprint.startsWith('FFP:v1:'));
  assert.equal(s.class, 'UNKNOWN');
  assert.ok(s.evidenceMissing.length > 0);
  // resource/refs explicitly absent but marked
  assert.equal(d.resource, null);
  assert.equal(d.refs, null);
});

test('P9.11 large execution state is referenced, not duplicated', () => {
  const big = 'X'.repeat(fixture.largePayload.stateBytesOverLimit);
  assert.ok(big.length > EXEC_DIAG_LIMITS.maxStateBytes);
  const d = createExecutionDiagnostic({
    outcome: 'failed',
    identity: { executionId: 'exec-big', workflowId: 'wf-big' },
    failure: { code: 'state.too_large', class: 'INTERNAL' },
    state: big,
  });
  assert.ok(d);
  assert.equal(d.state.state_ref, true);
  assert.equal(d.state.bytes, big.length);
  assert.equal(d.state.value, undefined, 'raw state must not be copied');
  assert.ok(d.state.ref);
  const s = summarizeFailure(d);
  assert.ok(s);
  assert.ok(s.stateRef);
  assert.equal(s.stateRef.bytes, big.length);
  const wire = serializeExecutionDiagnostic(d);
  assert.ok(wire);
  assert.ok(wire.length <= EXEC_DIAG_LIMITS.maxWireBytes);
  assert.equal(wire.includes(big.slice(0, 100)), false, 'big payload not on wire');
  // Inline small state allowed
  const small = createExecutionDiagnostic({
    outcome: 'success',
    identity: { executionId: 'e', workflowId: 'w' },
    state: { cursor: 1 },
  });
  assert.ok(small);
  assert.equal(small.state.state_inline, true);
});

test('P9.11 secret-safe behavior is proven', () => {
  const f = fixture.secretSafe;
  // secret-shaped identifier fails closed
  assert.equal(createExecutionDiagnostic({
    outcome: 'failed',
    identity: { executionId: f.identityWithSecret, workflowId: 'wf' },
    failure: { code: 'x', class: 'INTERNAL' },
  }), null);
  assert.equal(createExecutionDiagnostic({
    outcome: 'success',
    identity: { executionId: 'ok', workflowId: f.identityWithSecret },
  }), null);
  // secret-shaped failure message never enters raw
  const d = createExecutionDiagnostic({
    outcome: 'failed',
    identity: { executionId: 'e1', workflowId: 'w1' },
    failure: { code: 'auth.fail', class: 'DEPENDENCY', message: f.messageWithSecret },
  });
  assert.ok(d);
  assert.equal(d.failure.message, '[REDACTED:SECRET]');
  assert.equal(containsSecretShape(d), false);
  const s = summarizeFailure(d);
  assert.ok(s);
  assert.equal(containsSecretShape(s), false);
  // secret in refs rejected
  assert.equal(createExecutionDiagnostic({
    outcome: 'failed',
    identity: { executionId: 'e', workflowId: 'w' },
    failure: { code: 'x', class: 'INTERNAL' },
    refs: { checkpoint: 'Bearer dG9rZQ' },
  }), null);
  // serialize choke rejects secret-shaped structures
  assert.equal(serializeExecutionDiagnostic({ contractVersion: '1.0.0', token: 'sk-live-abcdefgh' }), null);
});

test('P9.11 fingerprint stability: same inputs → same FFP; changed code → different', () => {
  const base = fixture.failedDiagnostic;
  const a = createExecutionDiagnostic({
    outcome: 'failed', identity: base.identity, failure: base.failure,
  });
  const b = createExecutionDiagnostic({
    outcome: 'failed', identity: base.identity, failure: base.failure,
  });
  assert.ok(a && b);
  const sa = summarizeFailure(a);
  const sb = summarizeFailure(b);
  assert.equal(sa.fingerprint, sb.fingerprint, 'stable across builds');
  const c = createExecutionDiagnostic({
    outcome: 'failed', identity: base.identity,
    failure: { ...base.failure, code: 'http.timeout' },
  });
  const sc = summarizeFailure(c);
  assert.ok(sc);
  assert.notEqual(sa.fingerprint, sc.fingerprint);
});

test('P9.11 invalid specs fail closed; bounded caps enforced', () => {
  assert.equal(createExecutionDiagnostic(null), null);
  assert.equal(createExecutionDiagnostic({}), null);
  assert.equal(createExecutionDiagnostic({ outcome: 'nope' }), null);
  assert.equal(createExecutionDiagnostic({ outcome: 'failed' }), null); // missing identity+failure
  assert.equal(createExecutionDiagnostic({ outcome: 'success' }), null); // missing identity ids
  assert.equal(createExecutionDiagnostic({ outcome: 'success', identity: {}, unknown: 1 }), null);
  assert.equal(createExecutionDiagnostic({
    outcome: 'success',
    identity: { executionId: 'e', workflowId: 'w', bogus: 'x' },
  }), null);
  assert.equal(createExecutionDiagnostic({
    outcome: 'failed',
    identity: { executionId: 'e', workflowId: 'w' },
    failure: { code: 'x', class: 'NOT_A_CLASS' },
  }), null);
  assert.equal(createExecutionDiagnostic({
    outcome: 'success',
    identity: { executionId: 'e', workflowId: 'w' },
    failure: { code: 'x', class: 'INTERNAL' },
  }), null, 'success must not carry failure');
  // oversize identity rejected
  assert.equal(createExecutionDiagnostic({
    outcome: 'success',
    identity: { executionId: 'e'.repeat(200), workflowId: 'w' },
  }), null);
  // too many refs
  const arts = Array.from({ length: 20 }, (_, i) => `a${i}`);
  assert.equal(createExecutionDiagnostic({
    outcome: 'failed',
    identity: { executionId: 'e', workflowId: 'w' },
    failure: { code: 'x', class: 'INTERNAL' },
    refs: { artifacts: arts },
  }), null);
  // summarize rejects non-failed
  assert.equal(summarizeFailure(null), null);
  assert.equal(summarizeFailure({ outcome: 'success' }), null);
  assert.equal(summarizeFailure({ outcome: 'failed', contractVersion: 'nope', failure: {} }), null);
});

test('P9.11 source stays pure: no I/O, no clock; locked row documents the boundary', () => {
  const stringify = JSON.stringify, now = Date.now;
  try {
    JSON.stringify = () => { throw Error('encoding'); };
    Date.now = () => { throw Error('clock'); };
    // stringify poisoned — create still fail-closes via catch; fingerprint uses fnv not JSON for digest
    const d = createExecutionDiagnostic({
      outcome: 'failed',
      identity: { executionId: 'e', workflowId: 'w' },
      failure: { code: 'x', class: 'INTERNAL' },
    });
    // JSON.stringify poisoned means wire bound fails → null (fail closed), no throw
    assert.equal(d, null);
  } finally {
    JSON.stringify = stringify; Date.now = now;
  }
  // recover: works with normal JSON
  const d2 = createExecutionDiagnostic({
    outcome: 'failed',
    identity: { executionId: 'e', workflowId: 'w' },
    failure: { code: 'x', class: 'INTERNAL' },
  });
  assert.ok(d2);
  assert.ok(summarizeFailure(d2));
  const source = readFileSync(new URL('../src/lego/execution-diagnostics.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\b(?:fetch|setTimeout|setInterval|writeFile|readFile|appendFile|console\.(?:log|error)|Date\.now|Math\.random)\s*\(/);
  const lock = JSON.parse(readFileSync(new URL('../src/lego/contracts/contract-lock.json', import.meta.url), 'utf8'));
  const rows = lock.contracts.filter(row => row.id === EXEC_DIAG_CONTRACT.id);
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.owner, 'agent-6');
  assert.equal(row.domain, 'observability');
  assert.equal(row.version, '1.0.0');
  assert.deepEqual(row.surface, ['src/lego/execution-diagnostics.mjs']);
  assert.deepEqual(row.exports['src/lego/execution-diagnostics.mjs'], [
    'EXEC_DIAG_CONTRACT', 'EXEC_DIAG_OUTCOMES', 'EXEC_DIAG_LIMITS',
    'EXEC_DIAG_IDENTITY_FIELDS', 'EXEC_DIAG_EVIDENCE_KINDS', 'EXEC_DIAG_FAILURE_CLASSES',
    'createExecutionDiagnostic', 'summarizeFailure', 'serializeExecutionDiagnostic',
  ]);
  assert.deepEqual(row.tests, ['apps/n8n-lego/test/lego-execution-diagnostics.test.mjs']);
  assert.equal(lock.contracts.length, 100); // P9.11 adds observability.execution-diagnostics@1.0.0; P9.12 adds observability.diagnostic-bundle@1.0.0; P9.13 adds observability.failure-correlation@1.0.0; P9.14 adds observability.replay-evidence@1.0.0; P9.15 adds observability.telemetry-retention@1.0.0; P9.16 adds observability.operator-inspection@1.0.0; P9.17 adds observability.low-resource-mode@1.0.0; P9.18 adds observability.self-observability@1.0.0; P9.19 adds observability.tenant-isolation@1.0.0; P9.20 adds observability.contract-oracle@1.0.0; P9.21 adds observability.advanced-diagnostics@1.0.0; P9.22 adds observability.p9-acceptance@1.0.0; count-pins say 75 // P9 integration (Agent 1): P9.5-P9.22 add 18 observability.* rows on top of protected main 76 -> 94 (union, zero id collisions); P9 was developed on 24032a0c (57 rows). P5.1 adds the ninety-fifth (auth.principal). P5.2 adds the ninety-sixth (auth.session). P5.3 adds the ninety-seventh (auth.authorization). P5.5 adds the ninety-eighth (auth.credential-crypto). P5.6 adds the ninety-ninth (auth.account-security). P5.7 adds the hundredth (auth.machine-identity).
  const doc = readFileSync(new URL('../../../docs/architecture/p9/P9.11-EXECUTION-DIAGNOSTICS.md', import.meta.url), 'utf8');
  assert.match(doc, /state_ref/);
  assert.match(doc, /FFP:v1/);
  assert.match(doc, /evidenceMissing/);
  assert.match(doc, /secret/i);
});
