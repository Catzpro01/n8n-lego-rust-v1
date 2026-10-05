import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DIAG_BUNDLE_CONTRACT, DIAG_BUNDLE_SCHEMA_VERSION, DIAG_BUNDLE_LIMITS,
  DIAG_BUNDLE_SECTIONS, DIAG_BUNDLE_SIGNAL_KINDS, DIAG_BUNDLE_BUDGET_REASONS,
  DIAG_BUNDLE_CORRELATION_FIELDS,
  compileDiagnosticBundle, verifyBundleIntegrity,
  exportDiagnosticBundle, importDiagnosticBundle,
} from '../src/lego/diagnostic-bundle.mjs';
import { containsSecretShape } from '../src/lego/telemetry-redaction.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/p9/diagnostic-bundle.json', import.meta.url), 'utf8'));

function compileInput(spec) {
  // Fixtures/tests may carry an `expect` annotation — not part of the contract.
  const { expect: _expect, ...rest } = structuredClone(spec);
  return compileDiagnosticBundle(rest);
}

function generateLogs(n, execId, long = false) {
  const base = 1760000000000;
  const sev = ['ERROR', 'WARN', 'INFO', 'DEBUG', 'TRACE'];
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      timestamp: base + i,
      severity: sev[i % sev.length],
      operation: `op.${i % 7}`,
      outcome: i % 5 === 0 ? 'failed' : 'success',
      errorCode: i % 5 === 0 ? `code.${i % 3}` : undefined,
      message: long
        ? `padding-message-${'x'.repeat(200)}-${i}`
        : `m${i}`,
      executionId: i % 3 === 0 ? execId : `other-${i % 9}`,
      workflowId: i % 4 === 0 ? execId.replace('exec', 'wf') : undefined,
    });
    for (const k of Object.keys(out[i])) {
      if (out[i][k] === undefined) delete out[i][k];
    }
  }
  return out;
}

function generateEvents(n, execId) {
  const base = 1760000000000;
  const names = ['execution.started', 'execution.failed', 'node.loaded', 'checkpoint.created'];
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      timestamp: base + i,
      eventName: names[i % names.length],
      severity: i % 6 === 0 ? 'ERROR' : 'INFO',
      sequence: i,
      executionId: i % 2 === 0 ? execId : undefined,
    });
    for (const k of Object.keys(out[i])) {
      if (out[i][k] === undefined) delete out[i][k];
    }
  }
  return out;
}

function generateSpans(n, execId, traceId = null) {
  const base = 1760000000000;
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      timestamp: base + i,
      name: `span.${i % 5}`,
      spanId: `span${String(i).padStart(12, '0')}`.slice(0, 16),
      ...(traceId ? { traceId } : {}),
      durationMs: i * 1.5,
      outcome: i % 4 === 0 ? 'failed' : 'success',
      executionId: i % 2 === 0 ? execId : undefined,
    });
    for (const k of Object.keys(out[i])) {
      if (out[i][k] === undefined) delete out[i][k];
    }
  }
  return out;
}

test('P9.12 contract vocabulary: schema, sections, kinds, budget reasons', () => {
  assert.equal(DIAG_BUNDLE_CONTRACT.id, 'observability.diagnostic-bundle');
  assert.equal(DIAG_BUNDLE_CONTRACT.version, '1.0.0');
  assert.equal(DIAG_BUNDLE_CONTRACT.owner, 'agent-6');
  assert.equal(DIAG_BUNDLE_SCHEMA_VERSION, '1.0.0');
  assert.deepEqual([...DIAG_BUNDLE_SECTIONS], fixture.sections ?? [
    'correlation', 'diagnostic', 'logs', 'events', 'spans',
    'resource', 'refs', 'configFingerprints',
  ]);
  assert.deepEqual([...DIAG_BUNDLE_SIGNAL_KINDS], fixture.signalKinds);
  assert.deepEqual([...DIAG_BUNDLE_BUDGET_REASONS], fixture.budgetReasons);
  assert.ok(DIAG_BUNDLE_CORRELATION_FIELDS.includes('executionId'));
  assert.ok(DIAG_BUNDLE_CORRELATION_FIELDS.includes('workflowId'));
});

test('P9.12 small bundle: selects relevant signals, not everything', () => {
  const f = fixture.smallBundle;
  const b = compileInput(f);
  assert.ok(b, 'small bundle compiles');
  assert.equal(b.schemaVersion, '1.0.0');
  assert.equal(b.contractVersion, '1.0.0');
  assert.equal(b.correlation.executionId, 'exec-b-1');
  assert.equal(b.correlation.workflowId, 'wf-7');
  // Selected: correlated ERROR log + failed event + failed span; out-of-window / unrelated dropped
  assert.equal(b.logs.length, f.expect.logCount);
  assert.equal(b.events.length, f.expect.eventCount);
  assert.equal(b.spans.length, f.expect.spanCount);
  assert.ok(b.dropped.logs >= f.expect.droppedLogsAtLeast);
  assert.ok(b.dropped.reasons['logs.window'] >= 1);
  assert.ok(b.resource.memoryUsedBytes === 2097152);
  assert.equal(b.refs.checkpoint, 'ckpt-9');
  assert.equal(b.configFingerprints[0].key, 'executor.mode');
  assert.equal(b.budget.exceeded, false);
  assert.equal(containsSecretShape(b), false);
  // Determinism: same input → same integrity digest
  const b2 = compileInput(f);
  assert.equal(b.integrity.digest, b2.integrity.digest);
});

test('P9.12 large bundle: per-kind caps hold; wire within absolute ceiling', () => {
  const f = fixture.largeBundle;
  const spec = structuredClone(f);
  spec.candidates.logs = generateLogs(200, spec.correlation.executionId);
  spec.candidates.events = generateEvents(40, spec.correlation.executionId);
  spec.candidates.spans = generateSpans(20, spec.correlation.executionId);
  const b = compileInput(spec);
  assert.ok(b, 'large bundle compiles');
  assert.ok(b.logs.length <= f.expect.logCountMax, `logs ${b.logs.length}`);
  assert.ok(b.events.length <= f.expect.eventCountMax);
  assert.ok(b.spans.length <= f.expect.spanCountMax);
  assert.ok(b.dropped.logs + b.dropped.events + b.dropped.spans > 0, 'selection dropped something');
  const wire = exportDiagnosticBundle(b);
  assert.ok(wire);
  assert.ok(wire.length <= DIAG_BUNDLE_LIMITS.maxWireBytes);
  assert.equal(b.budget.exceeded, false);
});

test('P9.12 budget-exceeded: drops counted honestly; never unbounded', () => {
  const f = fixture.budgetExceeded;
  const spec = structuredClone(f);
  spec.candidates.logs = generateLogs(120, spec.correlation.executionId, true);
  const b = compileInput(spec);
  assert.ok(b, 'budget-exceeded bundle still compiles');
  const wire = exportDiagnosticBundle(b);
  assert.ok(wire);
  // Wire never exceeds hard ceiling even when policy budget is tiny
  assert.ok(wire.length <= DIAG_BUNDLE_LIMITS.maxWireBytes);
  // Either budget flag or explicit budget drops (or both)
  const budgetDrops = b.dropped.reasons['logs.budget'] ?? 0;
  assert.ok(b.budget.exceeded === true || budgetDrops > 0,
    `expected budget.exceeded or logs.budget drops, got exceeded=${b.budget.exceeded} drops=${budgetDrops}`);
  assert.ok(b.logs.length < 120, 'must not include all 120 long logs under 768-byte policy');
});

test('P9.12 missing evidence: explicit list; bundle remains usable', () => {
  const f = fixture.missingEvidence;
  const b = compileInput(f);
  assert.ok(b, 'minimal correlation-only bundle compiles');
  for (const field of f.expect.evidenceMissingIncludes) {
    assert.ok(b.evidenceMissing.includes(field), `evidenceMissing should include ${field}`);
  }
  assert.equal(b.diagnostic, null);
  assert.equal(b.resource, null);
  assert.equal(b.refs, null);
  assert.deepEqual(b.logs, []);
  assert.deepEqual(b.events, []);
  assert.deepEqual(b.spans, []);
  const wire = exportDiagnosticBundle(b);
  assert.ok(wire);
  const back = importDiagnosticBundle(wire);
  assert.ok(back, 'round-trip import works');
  assert.equal(back.integrity.digest, b.integrity.digest);
});

test('P9.12 secret-safe: secret-shaped correlation/candidates never enter the bundle', () => {
  for (const secret of fixture.secretShapes) {
    const b = compileDiagnosticBundle({
      correlation: { executionId: 'e1', workflowId: 'w1', correlationId: secret },
    });
    assert.equal(b, null, `secret correlationId rejected: ${secret}`);
  }
  // Secret message in a log is redacted to marker, not stored raw
  const b2 = compileDiagnosticBundle({
    correlation: { executionId: 'e1', workflowId: 'w1' },
    anchorTimestamp: 1760000000000,
    candidates: {
      logs: [{
        timestamp: 1760000000001,
        severity: 'ERROR',
        operation: 'op',
        outcome: 'failed',
        message: 'failed with token=ghp_ABCDEFGHIJKLMNOPQRSTUV',
        executionId: 'e1',
      }],
    },
  });
  assert.ok(b2);
  assert.equal(b2.logs.length, 1);
  assert.notEqual(b2.logs[0].message, 'failed with token=ghp_ABCDEFGHIJKLMNOPQRSTUV');
  assert.equal(containsSecretShape(b2.logs[0].message), false);
  assert.equal(containsSecretShape(b2), false);
  // Export also refuses secret-bearing trees
  const dirty = { ...b2, sneaky: { password: 'hunter2hunter2xx' } };
  assert.equal(exportDiagnosticBundle(dirty), null);
});

test('P9.12 stability: repeated generation byte-identical for same inputs + policy', () => {
  const f = fixture.smallBundle;
  const w1 = exportDiagnosticBundle(compileInput(f));
  const w2 = exportDiagnosticBundle(compileInput(f));
  assert.equal(w1, w2);
  // Order of input candidates does not change selection result (sorted by score/ts)
  const reordered = structuredClone(f);
  reordered.candidates.logs = [...reordered.candidates.logs].reverse();
  reordered.candidates.events = [...reordered.candidates.events].reverse();
  const w3 = exportDiagnosticBundle(compileInput(reordered));
  assert.equal(w1, w3, 'input order does not affect output bytes');
});

test('P9.12 integrity: export/import verifies; tamper fails closed', () => {
  const f = fixture.smallBundle;
  const b = compileInput(f);
  assert.ok(b);
  const digest = verifyBundleIntegrity(b);
  assert.ok(digest && digest.startsWith('BDL:v1:'));
  const wire = exportDiagnosticBundle(b);
  assert.ok(wire);
  const imported = importDiagnosticBundle(wire);
  assert.ok(imported);
  assert.equal(verifyBundleIntegrity(imported), digest);

  // Tamper: flip a correlation field after import
  const tampered = JSON.parse(wire);
  tampered.correlation.executionId = 'exec-FORGED';
  assert.equal(verifyBundleIntegrity(tampered), null);
  assert.equal(importDiagnosticBundle(JSON.stringify(tampered)), null);

  // Tamper: mutate a selected log message
  const tampered2 = JSON.parse(wire);
  tampered2.logs[0].message = 'mutated-payload';
  assert.equal(importDiagnosticBundle(JSON.stringify(tampered2)), null);

  // Missing integrity → reject
  const noInt = JSON.parse(wire);
  delete noInt.integrity;
  assert.equal(importDiagnosticBundle(JSON.stringify(noInt)), null);

  // Garbage wire → reject
  assert.equal(importDiagnosticBundle('not-json'), null);
  assert.equal(importDiagnosticBundle(''), null);
  assert.equal(importDiagnosticBundle(null), null);
});

test('P9.12 invalid specs fail closed; determinism guards', () => {
  // Missing required correlation
  assert.equal(compileDiagnosticBundle({}), null);
  assert.equal(compileDiagnosticBundle({ correlation: { executionId: 'e' } }), null);
  assert.equal(compileDiagnosticBundle({ correlation: { workflowId: 'w' } }), null);
  // Unknown spec keys
  assert.equal(compileDiagnosticBundle({ correlation: { executionId: 'e', workflowId: 'w' }, extra: 1 }), null);
  // Invalid policy
  assert.equal(compileDiagnosticBundle({
    correlation: { executionId: 'e', workflowId: 'w' },
    policy: { maxBundleBytes: 10 },
  }), null);
  assert.equal(compileDiagnosticBundle({
    correlation: { executionId: 'e', workflowId: 'w' },
    policy: { unknown: true },
  }), null);
  // Candidates must be arrays
  assert.equal(compileDiagnosticBundle({
    correlation: { executionId: 'e', workflowId: 'w' },
    candidates: { logs: 'nope' },
  }), null);
  // Export/import reject non-plain
  assert.equal(exportDiagnosticBundle(null), null);
  assert.equal(importDiagnosticBundle(undefined), null);
  // Determinism: two compiles of same minimal spec share digest
  const spec = { correlation: { executionId: 'e', workflowId: 'w' } };
  const a = compileInput(spec);
  const c = compileInput(spec);
  assert.ok(a && c);
  assert.equal(a.integrity.digest, c.integrity.digest);
});

test('P9.12 source stays pure: no I/O, no clock; locked row documents the boundary', () => {
  const stringify = JSON.stringify, now = Date.now;
  try {
    JSON.stringify = () => { throw Error('encoding'); };
    Date.now = () => { throw Error('clock'); };
    const b = compileDiagnosticBundle({ correlation: { executionId: 'e', workflowId: 'w' } });
    assert.equal(b, null); // wire bound fail-closed, no throw
  } finally {
    JSON.stringify = stringify; Date.now = now;
  }
  const b2 = compileDiagnosticBundle({ correlation: { executionId: 'e', workflowId: 'w' } });
  assert.ok(b2);
  const source = readFileSync(new URL('../src/lego/diagnostic-bundle.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\b(?:fetch|setTimeout|setInterval|writeFile|readFile|appendFile|console\.(?:log|error)|Date\.now|Math\.random)\s*\(/);

  const lock = JSON.parse(readFileSync(new URL('../src/lego/contracts/contract-lock.json', import.meta.url), 'utf8'));
  const rows = lock.contracts.filter(row => row.id === DIAG_BUNDLE_CONTRACT.id);
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.owner, 'agent-6');
  assert.equal(row.domain, 'observability');
  assert.equal(row.version, '1.0.0');
  assert.deepEqual(row.surface, ['src/lego/diagnostic-bundle.mjs']);
  assert.deepEqual(row.exports['src/lego/diagnostic-bundle.mjs'], [
    'DIAG_BUNDLE_CONTRACT', 'DIAG_BUNDLE_SCHEMA_VERSION', 'DIAG_BUNDLE_LIMITS',
    'DIAG_BUNDLE_SECTIONS', 'DIAG_BUNDLE_SIGNAL_KINDS', 'DIAG_BUNDLE_BUDGET_REASONS',
    'DIAG_BUNDLE_CORRELATION_FIELDS',
    'compileDiagnosticBundle', 'verifyBundleIntegrity',
    'exportDiagnosticBundle', 'importDiagnosticBundle',
  ]);
  assert.deepEqual(row.tests, ['apps/n8n-lego/test/lego-diagnostic-bundle.test.mjs']);
  assert.equal(lock.contracts.length, 100); // P9.12 adds observability.diagnostic-bundle@1.0.0; P9.13 adds observability.failure-correlation@1.0.0; P9.14 adds observability.replay-evidence@1.0.0; P9.15 adds observability.telemetry-retention@1.0.0; P9.16 adds observability.operator-inspection@1.0.0; P9.17 adds observability.low-resource-mode@1.0.0; P9.18 adds observability.self-observability@1.0.0; P9.19 adds observability.tenant-isolation@1.0.0; P9.20 adds observability.contract-oracle@1.0.0; P9.21 adds observability.advanced-diagnostics@1.0.0; P9.22 adds observability.p9-acceptance@1.0.0; count-pins say 75 // P9 integration (Agent 1): P9.5-P9.22 add 18 observability.* rows on top of protected main 76 -> 94 (union, zero id collisions); P9 was developed on 24032a0c (57 rows). P5.1 adds the ninety-fifth (auth.principal). P5.2 adds the ninety-sixth (auth.session). P5.3 adds the ninety-seventh (auth.authorization). P5.5 adds the ninety-eighth (auth.credential-crypto). P5.6 adds the ninety-ninth (auth.account-security). P5.7 adds the hundredth (auth.machine-identity).
  const doc = readFileSync(new URL('../../../docs/architecture/p9/P9.12-DIAGNOSTIC-BUNDLE.md', import.meta.url), 'utf8');
  assert.match(doc, /BDL:v1/);
  assert.match(doc, /budget/i);
  assert.match(doc, /evidenceMissing/);
  assert.match(doc, /secret/i);
});
