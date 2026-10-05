import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  FAILURE_CORR_CONTRACT, FAILURE_CORR_SCHEMA_VERSION, FAILURE_CORR_CAUSE_KINDS,
  FAILURE_CORR_NOTES, FAILURE_CORR_LIMITS,
  compileFailureCorrelation, classifyRootCause, expandCausalChain,
  attachEvidence, exportFailureCorrelation,
} from '../src/lego/failure-correlation.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/p9/failure-correlation.json', import.meta.url), 'utf8'));

function compileInput(spec) {
  // Fixtures/tests may carry an `expect` annotation — not part of the contract.
  const { expect: _expect, ...rest } = structuredClone(spec);
  return compileFailureCorrelation(rest);
}

test('P9.13 contract vocabulary: kinds, notes, limits, schema', () => {
  assert.equal(FAILURE_CORR_CONTRACT.id, 'observability.failure-correlation');
  assert.equal(FAILURE_CORR_CONTRACT.version, '1.0.0');
  assert.equal(FAILURE_CORR_CONTRACT.owner, 'agent-6');
  assert.equal(FAILURE_CORR_SCHEMA_VERSION, '1.0.0');
  assert.deepEqual([...FAILURE_CORR_CAUSE_KINDS], [
    'OBSERVED_CAUSE', 'INFERRED_CAUSE', 'CORRELATED_WITH', 'UNKNOWN',
  ]);
  assert.ok(FAILURE_CORR_NOTES.includes('correlation-only-not-promoted'));
  assert.ok(FAILURE_CORR_NOTES.includes('no-inbound-causal-claims'));
  assert.ok(FAILURE_CORR_NOTES.includes('inferred-not-observed'));
  assert.ok(FAILURE_CORR_LIMITS.maxEdges >= 1);
  assert.ok(FAILURE_CORR_LIMITS.maxExpansionDepth >= 1);
});

test('P9.13 direct causal chain: observed root, bounded path, no cycle', () => {
  const f = fixture.directCausalChain;
  const g = compileInput(f);
  assert.ok(g, 'direct chain compiles');
  const cls = classifyRootCause(g);
  assert.equal(cls.rootKind, f.expect.rootKind);
  const exp = expandCausalChain(g);
  assert.equal(exp.pathLength, f.expect.pathLength);
  assert.equal(exp.cycleDetected, f.expect.cycleDetected);
  assert.equal(exp.terminates, true);
  assert.ok(exp.path.includes('trigger.fail'));
});

test('P9.13 correlation-only: never promoted to cause', () => {
  const f = fixture.correlationOnly;
  const g = compileInput(f);
  assert.ok(g, 'correlation-only compiles');
  const cls = classifyRootCause(g);
  assert.equal(cls.rootKind, f.expect.rootKind);
  assert.equal(cls.note, f.expect.note);
  // correlation edge retained but root is UNKNOWN
  assert.ok(g.edges.some(e => e.kind === 'CORRELATED_WITH'));
  assert.equal(cls.rootKind, 'UNKNOWN');
});

test('P9.13 unknown root cause: honest UNKNOWN + evidenceMissing', () => {
  const f = fixture.unknownRoot;
  const g = compileInput(f);
  assert.ok(g, 'unknown root compiles');
  const cls = classifyRootCause(g);
  assert.equal(cls.rootKind, f.expect.rootKind);
  assert.equal(cls.note, f.expect.note);
  assert.ok(g.evidenceMissing.includes(f.expect.evidenceMissingIncludes));
});

test('P9.13 cycle protection: expansion terminates with cycleDetected', () => {
  const f = fixture.cycleProtection;
  const g = compileInput(f);
  assert.ok(g, 'cycle graph compiles');
  const cls = classifyRootCause(g);
  assert.equal(cls.rootKind, f.expect.rootKind);
  const exp = expandCausalChain(g);
  assert.equal(exp.cycleDetected, f.expect.cycleDetected);
  assert.equal(exp.terminates, f.expect.terminates);
  assert.ok(exp.pathLength <= FAILURE_CORR_LIMITS.maxPathNodes);
  // each node visited once — path cannot exceed node count
  assert.ok(exp.path.length <= g.events.length + 1);
});

test('P9.13 confidence/source on inference: carried, not observed', () => {
  const f = fixture.confidenceSource;
  const g = compileInput(f);
  assert.ok(g, 'confidence graph compiles');
  const cls = classifyRootCause(g);
  assert.equal(cls.rootKind, f.expect.rootKind);
  assert.equal(cls.confidence, f.expect.confidence);
  assert.equal(cls.source, f.expect.source);
  assert.equal(cls.note, f.expect.note);
});

test('P9.13 invalid fixtures fail closed to null', () => {
  for (const [name, spec] of Object.entries(fixture.invalid)) {
    assert.equal(compileInput(spec), null, name);
  }
});

test('P9.13 attachEvidence merges safe refs and rejects unsafe', () => {
  const g = compileInput(fixture.directCausalChain);
  assert.ok(g);
  const key = 'exec.not_startedexec.failOBSERVED_CAUSE';
  const merged = attachEvidence(g, { [key]: ['log:extra-1'] });
  assert.ok(merged);
  const edge = merged.find(e => e.from === 'exec.not_started' && e.to === 'exec.fail');
  assert.ok(edge.evidence.includes('log:extra-1'));
  assert.ok(edge.evidence.includes('log:exec-500'));
  // secret-shaped evidence rejected
  assert.equal(attachEvidence(g, { [key]: ['bearer abc123secret'] }), null);
  // non-plain map rejected
  assert.equal(attachEvidence(g, null), null);
});

test('P9.13 export is deterministic and secret-safe', () => {
  const g = compileInput(fixture.directCausalChain);
  const a = exportFailureCorrelation(g);
  const b = exportFailureCorrelation(g);
  assert.equal(typeof a, 'string');
  assert.equal(a, b, 'same graph -> same bytes');
  const parsed = JSON.parse(a);
  assert.equal(parsed.schemaVersion, '1.0.0');
  assert.equal(parsed.contract.id, 'observability.failure-correlation');
  assert.equal(parsed.rootId, 'exec.fail');
  assert.ok(Array.isArray(parsed.events));
  assert.ok(Array.isArray(parsed.edges));
  // adjacency maps not serialized
  assert.equal(parsed.inbound, undefined);
  assert.equal(parsed.outbound, undefined);
  assert.equal(exportFailureCorrelation(null), null);
});

test('P9.13 evidence refs on edges: observed edges carry evidence', () => {
  const g = compileInput(fixture.directCausalChain);
  for (const e of g.edges) {
    if (e.kind === 'OBSERVED_CAUSE') {
      assert.ok(e.evidence && e.evidence.length > 0, 'observed edge has evidence');
    }
    if (e.kind === 'INFERRED_CAUSE') {
      assert.equal(typeof e.confidence, 'number');
      assert.equal(typeof e.source, 'string');
    }
  }
});

test('P9.13 bounded inputs: oversized edge list rejected', () => {
  const events = [{ id: 'a', kind: 'k' }, { id: 'b', kind: 'k' }];
  const edges = [];
  for (let i = 0; i < FAILURE_CORR_LIMITS.maxEdges + 1; i++) {
    edges.push({ from: 'a', to: 'b', kind: 'CORRELATED_WITH', evidence: ['log:x'] });
  }
  assert.equal(compileFailureCorrelation({ events, edges, rootId: 'b' }), null);
});

test('P9.13 lock pin: contracts length 66 after P9.13 row', () => {
  const lock = JSON.parse(readFileSync(new URL('../src/lego/contracts/contract-lock.json', import.meta.url), 'utf8'));
  assert.equal(lock.contracts.length, 100); // P9.13 adds observability.failure-correlation@1.0.0; P9.14 adds observability.replay-evidence@1.0.0; P9.15 adds observability.telemetry-retention@1.0.0; P9.16 adds observability.operator-inspection@1.0.0; P9.17 adds observability.low-resource-mode@1.0.0; P9.18 adds observability.self-observability@1.0.0; P9.19 adds observability.tenant-isolation@1.0.0; P9.20 adds observability.contract-oracle@1.0.0; P9.21 adds observability.advanced-diagnostics@1.0.0; P9.22 adds observability.p9-acceptance@1.0.0; count-pins say 75 // P9 integration (Agent 1): P9.5-P9.22 add 18 observability.* rows on top of protected main 76 -> 94 (union, zero id collisions); P9 was developed on 24032a0c (57 rows). P5.1 adds the ninety-fifth (auth.principal). P5.2 adds the ninety-sixth (auth.session). P5.3 adds the ninety-seventh (auth.authorization). P5.5 adds the ninety-eighth (auth.credential-crypto). P5.6 adds the ninety-ninth (auth.account-security). P5.7 adds the hundredth (auth.machine-identity).
  const row = lock.contracts.find(c => c.id === 'observability.failure-correlation');
  assert.ok(row, 'P9.13 row present');
  assert.equal(row.version, '1.0.0');
  assert.equal(row.owner, 'agent-6');
  assert.equal(row.domain, 'observability');
});
