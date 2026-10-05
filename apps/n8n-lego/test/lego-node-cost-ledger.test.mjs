import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  NODE_COST_CONTRACT, COST_DIMENSIONS, COST_VALUE_PROVENANCE, COST_SCOPES,
  COST_OUTCOMES, COST_LIMITS, COST_IDENTITY_FIELDS, COST_NUMERIC_LIMITS,
  createNodeCostRow, createNodeCostLedger, fingerprintRow, costDimensionsAllowed,
} from '../src/lego/node-cost-ledger.mjs';
import { EXEC_DIAG_IDENTITY_FIELDS } from '../src/lego/execution-diagnostics.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/p9/node-cost-ledger.json', import.meta.url), 'utf8'));

const row = (overrides = {}) => createNodeCostRow({
  identity: fixture.identity,
  dimensions: fixture.valid.dimensions,
  provenance: fixture.valid.provenance,
  ...overrides,
});

test('P9-S01 contract vocabulary: dimensions, provenance, scopes, outcomes', () => {
  assert.equal(NODE_COST_CONTRACT.id, 'observability.node-cost-ledger');
  assert.equal(NODE_COST_CONTRACT.version, '1.0.0');
  assert.equal(NODE_COST_CONTRACT.owner, 'agent-6');
  assert.deepEqual([...COST_DIMENSIONS], fixture.dimensions);
  assert.deepEqual([...COST_VALUE_PROVENANCE], fixture.provenance);
  assert.deepEqual([...COST_SCOPES], fixture.scopes);
  assert.deepEqual([...COST_OUTCOMES], fixture.outcomes);
  assert.equal(COST_LIMITS.maxNodes, fixture.limits.maxNodes);
  assert.equal(COST_LIMITS.maxSamplesPerNode, fixture.limits.maxSamplesPerNode);
  assert.equal(COST_LIMITS.maxLedgerRows, fixture.limits.maxLedgerRows);
  assert.equal(COST_LIMITS.maxWireBytes, fixture.limits.maxWireBytes);
  assert.equal(COST_LIMITS.identifierBytes, fixture.limits.identifierBytes);
});

test('P9-S01 correlation identity is exactly P9.11 identity — one truth, not two', () => {
  assert.deepEqual([...COST_IDENTITY_FIELDS], [...EXEC_DIAG_IDENTITY_FIELDS]);
  assert.deepEqual([...COST_IDENTITY_FIELDS], fixture.identityFields);
  assert.ok(COST_IDENTITY_FIELDS.includes('nodeId'));
  assert.ok(COST_IDENTITY_FIELDS.includes('runtimeId'));
});

test('P9-S01 every declared dimension has a non-negative bound', () => {
  for (const dimension of COST_DIMENSIONS) {
    assert.ok(Object.prototype.hasOwnProperty.call(COST_NUMERIC_LIMITS, dimension), `${dimension} unbounded`);
    assert.ok(COST_NUMERIC_LIMITS[dimension] > 0);
  }
});

test('P9-S01 a valid row is frozen and carries a fingerprint', () => {
  const built = row();
  assert.ok(built);
  assert.equal(Object.isFrozen(built), true);
  assert.equal(Object.isFrozen(built.identity), true);
  assert.equal(Object.isFrozen(built.dimensions), true);
  assert.match(built.fingerprint, /^NC:v1:[0-9a-f]{8}$/);
  assert.equal(built.provenance, 'OBSERVED');
  assert.equal(built.outcome, 'success');
  assert.equal(built.identity.nodeId, 'node-http-request');
});

test('P9-S01 outcome defaults to success and unit/at/refs are carried when safe', () => {
  const built = row({ outcome: undefined, unit: fixture.valid.unit, at: fixture.valid.at, refs: fixture.valid.refs });
  assert.equal(built.outcome, 'success');
  assert.equal(built.unit, 'ms');
  assert.equal(built.at, '2026-09-26T10:15:30.000Z');
  assert.deepEqual([...built.refs], ['run-36184852810']);
});

test('P9-S01 the fingerprint is over identity and outcome, NOT over measured values', () => {
  const cheap = row({ dimensions: { durationMs: 4, invocations: 1 } });
  const dear = row({ dimensions: { durationMs: 4000, invocations: 1 } });
  assert.equal(cheap.fingerprint, dear.fingerprint, 'cost must not fork the join key');
  const other = row({ identity: { ...fixture.identity, nodeId: 'node-set' } });
  assert.notEqual(cheap.fingerprint, other.fingerprint);
  const failed = row({ outcome: 'failed', dimensions: { durationMs: 4, invocations: 1 } });
  assert.notEqual(cheap.fingerprint, failed.fingerprint);
});

test('P9-S01 the fingerprint ignores key order in the supplied identity', () => {
  const reversed = {};
  for (const key of [...EXEC_DIAG_IDENTITY_FIELDS].reverse()) {
    if (fixture.identity[key] !== undefined) reversed[key] = fixture.identity[key];
  }
  assert.equal(fingerprintRow(reversed, 'success'), row().fingerprint);
});

test('P9-S01 a row without executionId or nodeId is refused — it could not be correlated', () => {
  assert.equal(createNodeCostRow(fixture.rejections.missingExecutionId), null);
  assert.equal(createNodeCostRow(fixture.rejections.missingNodeId), null);
  // nodeId present, executionId absent → still orphaned.
  assert.equal(createNodeCostRow({
    identity: { nodeId: 'n1' }, dimensions: { durationMs: 1 }, provenance: 'OBSERVED',
  }), null);
});

test('P9-S01 provenance is mandatory — an unmeasurable claim is refused', () => {
  assert.equal(createNodeCostRow(fixture.rejections.missingProvenance), null);
  assert.equal(createNodeCostRow(fixture.rejections.unknownProvenance), null);
});

test('P9-S01 every rejection case returns null (fail-closed)', () => {
  for (const [name, spec] of Object.entries(fixture.rejections)) {
    assert.equal(createNodeCostRow(spec), null, `${name} must be refused`);
  }
  // NaN and Infinity cannot be expressed in JSON, so they are built here.
  assert.equal(createNodeCostRow({
    identity: { executionId: 'exec-9f31', nodeId: 'n1' }, dimensions: { durationMs: Infinity }, provenance: 'OBSERVED',
  }), null);
  assert.equal(createNodeCostRow({
    identity: { executionId: 'exec-9f31', nodeId: 'n1' }, dimensions: { durationMs: NaN }, provenance: 'OBSERVED',
  }), null);
  assert.equal(createNodeCostRow({
    identity: { executionId: 'exec-9f31', nodeId: 'n1' }, dimensions: { durationMs: '412' }, provenance: 'OBSERVED',
  }), null, 'a string is not a measured count');
  assert.equal(createNodeCostRow(null), null);
  assert.equal(createNodeCostRow('nope'), null);
  assert.equal(createNodeCostRow(42), null);
});

test('P9-S01 a secret-shaped label or ref never enters a row', () => {
  assert.equal(createNodeCostRow(fixture.rejections.secretLabel), null);
  assert.equal(createNodeCostRow(fixture.rejections.secretRef), null);
});

test('P9-S01 an unknown spec key is refused — no silent extra cost dimension', () => {
  assert.equal(createNodeCostRow(fixture.rejections.unknownSpecKey), null);
});

test('P9-S01 an oversized identifier is refused rather than truncated', () => {
  const bytes = fixture.rejections.oversizedIdentifierBytes;
  assert.equal(createNodeCostRow({
    identity: { executionId: 'x'.repeat(bytes), nodeId: 'n1' },
    dimensions: { durationMs: 1 }, provenance: 'OBSERVED',
  }), null);
  assert.equal(createNodeCostRow({
    identity: { executionId: 'x'.repeat(bytes - 1), nodeId: 'n1' },
    dimensions: { durationMs: 1 }, provenance: 'OBSERVED',
  }) !== null, true, 'exactly at the bound is still accepted');
});

test('P9-S01 an invalid timestamp is refused', () => {
  assert.equal(createNodeCostRow(fixture.rejections.badTimestamp), null);
});

test('P9-S01 the ledger sums repeated samples of one node invocation into one entry', () => {
  const ledger = createNodeCostLedger();
  assert.ok(ledger);
  assert.equal(ledger.add(row()), true);
  assert.equal(ledger.add(row({ dimensions: { durationMs: 100, invocations: 1 } })), true);
  assert.equal(ledger.add(row({ dimensions: { durationMs: 50, invocations: 1 } })), true);
  const entries = ledger.entries();
  assert.equal(entries.length, 1, 'one node invocation, one entry');
  assert.equal(entries[0].samples, 3);
  assert.equal(entries[0].totals.durationMs, 562);
  assert.equal(entries[0].totals.invocations, 3);
  assert.equal(ledger.size, 1);
  assert.equal(ledger.rows, 3);
});

test('P9-S01 a mixed-provenance entry says so instead of reading as fully measured', () => {
  const ledger = createNodeCostLedger();
  ledger.add(row());
  ledger.add(createNodeCostRow({ identity: fixture.identity, dimensions: { durationMs: 900, invocations: 1, retries: 2 }, provenance: 'ESTIMATED' }));
  ledger.add(createNodeCostRow({ identity: fixture.identity, dimensions: fixture.reported.dimensions, provenance: 'REPORTED' }));
  const entries = ledger.entries();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].mixedProvenance, true);
  assert.deepEqual([...entries[0].provenance], ['ESTIMATED', 'OBSERVED', 'REPORTED']);
});

test('P9-S01 a pure-OBSERVED entry is not marked mixed', () => {
  const ledger = createNodeCostLedger();
  ledger.add(row());
  ledger.add(row({ dimensions: { durationMs: 10, invocations: 1 } }));
  const [entry] = ledger.entries();
  assert.equal(entry.mixedProvenance, false);
  assert.deepEqual([...entry.provenance], ['OBSERVED']);
});

test('P9-S01 per-node rollup aggregates across executions and keeps the node type', () => {
  const ledger = createNodeCostLedger();
  const other = { ...fixture.identity, executionId: 'exec-other' };
  ledger.add(row());
  ledger.add(createNodeCostRow({ identity: other, dimensions: { durationMs: 200, invocations: 1 }, provenance: 'OBSERVED' }));
  ledger.add(createNodeCostRow({ identity: { ...fixture.identity, nodeId: 'node-set', nodeType: 'n8n-nodes-base.set' }, dimensions: { durationMs: 5, invocations: 1 }, provenance: 'OBSERVED' }));
  const rollup = ledger.byNode();
  assert.equal(rollup.length, 2);
  const http = rollup.find((entry) => entry.nodeId === 'node-http-request');
  assert.equal(http.nodeType, 'n8n-nodes-base.httpRequest');
  assert.equal(http.invocations, 2);
  assert.equal(http.totals.durationMs, 612);
  assert.equal(http.mixedProvenance, false);
});

test('P9-S01 a node invocation with no duration is still an invocation', () => {
  const ledger = createNodeCostLedger();
  ledger.add(createNodeCostRow({ identity: fixture.identity, dimensions: { invocations: 1 }, provenance: 'OBSERVED' }));
  const [entry] = ledger.entries();
  assert.equal(entry.samples, 1);
  assert.equal(entry.totals.invocations, 1);
  assert.equal(entry.totals.durationMs, undefined);
});

test('P9-S01 the ledger refuses a malformed row instead of recording half of it', () => {
  const ledger = createNodeCostLedger();
  assert.equal(ledger.add(null), false);
  assert.equal(ledger.add({}), false);
  assert.equal(ledger.add({ fingerprint: 'NC:v1:deadbeef' }), false, 'a row without identity/dimensions is not a row');
  assert.equal(ledger.add({ ...row(), dimensions: undefined }), false);
  assert.equal(ledger.rows, 0, 'nothing was recorded');
});

test('P9-S01 the ledger refuses at maxNodes rather than evicting a recorded node', () => {
  const ledger = createNodeCostLedger({ maxNodes: 2 });
  assert.equal(ledger.add(row()), true);
  assert.equal(ledger.add(createNodeCostRow({ identity: { ...fixture.identity, nodeId: 'n2' }, dimensions: { invocations: 1 }, provenance: 'OBSERVED' })), true);
  assert.equal(ledger.add(createNodeCostRow({ identity: { ...fixture.identity, nodeId: 'n3' }, dimensions: { invocations: 1 }, provenance: 'OBSERVED' })), false, 'must refuse, not evict');
  assert.equal(ledger.size, 2);
  assert.equal(ledger.rows, 2);
});

test('P9-S01 the ledger refuses at maxSamplesPerNode', () => {
  const ledger = createNodeCostLedger({ maxSamplesPerNode: 2 });
  assert.equal(ledger.add(row()), true);
  assert.equal(ledger.add(row({ dimensions: { durationMs: 1, invocations: 1 } })), true);
  assert.equal(ledger.add(row({ dimensions: { durationMs: 1, invocations: 1 } })), false);
  assert.equal(ledger.entries()[0].samples, 2);
});

test('P9-S01 an out-of-range ledger constructor is refused', () => {
  assert.equal(createNodeCostLedger({ maxNodes: 0 }), null);
  assert.equal(createNodeCostLedger({ maxNodes: COST_LIMITS.maxNodes + 1 }), null);
  assert.equal(createNodeCostLedger({ maxSamplesPerNode: 0 }), null);
  assert.equal(createNodeCostLedger({ maxNodes: 1.5 }), null);
});

test('P9-S01 the ledger is bounded and reports when it is full', () => {
  const perNode = COST_LIMITS.maxSamplesPerNode;
  const nodeCount = COST_LIMITS.maxLedgerRows / perNode;
  const ledger = createNodeCostLedger({ maxNodes: nodeCount, maxSamplesPerNode: perNode });
  assert.equal(ledger.bounded, false);
  for (let node = 0; node < nodeCount; node += 1) {
    for (let sample = 0; sample < perNode; sample += 1) {
      assert.equal(ledger.add(createNodeCostRow({
        identity: { ...fixture.identity, nodeId: `node-${node}` },
        dimensions: { invocations: 1 }, provenance: 'OBSERVED',
      })), true);
    }
  }
  assert.equal(ledger.rows, COST_LIMITS.maxLedgerRows);
  assert.equal(ledger.bounded, true);
  assert.equal(ledger.add(row()), false, 'a full ledger refuses, it does not truncate');
});

test('P9-S01 firstAt/lastAt track the sample window', () => {
  const ledger = createNodeCostLedger();
  ledger.add(row({ at: '2026-09-26T10:15:30.000Z' }));
  ledger.add(row({ at: '2026-09-26T09:00:00.000Z' }));
  ledger.add(row({ at: '2026-09-26T11:45:00.000Z' }));
  const [entry] = ledger.entries();
  assert.equal(entry.firstAt, '2026-09-26T09:00:00.000Z');
  assert.equal(entry.lastAt, '2026-09-26T11:45:00.000Z');
});

test('P9-S01 correlate reports an unmatched row as drift, not as nothing', () => {
  const ledger = createNodeCostLedger();
  ledger.add(row());
  const orphan = createNodeCostRow({ identity: { ...fixture.identity, nodeId: 'node-orphan' }, dimensions: { invocations: 1 }, provenance: 'OBSERVED' });
  const result = ledger.correlate([row(), row(), orphan]);
  assert.equal(result.matched.length, 2);
  assert.deepEqual([...result.unmatched], [orphan.fingerprint]);
  assert.equal(result.coverage, 2 / 3);
});

test('P9-S01 correlate of an empty set is null coverage, not 100%', () => {
  const ledger = createNodeCostLedger();
  ledger.add(row());
  const result = ledger.correlate([]);
  assert.equal(result.matched.length, 0);
  assert.equal(result.coverage, null);
});

test('P9-S01 correlate refuses a non-array', () => {
  const ledger = createNodeCostLedger();
  assert.equal(ledger.correlate('nope'), null);
});

test('P9-S01 serialisation is bounded and identifies the contract', () => {
  const ledger = createNodeCostLedger();
  ledger.add(row());
  const text = ledger.serialize();
  assert.ok(text.length <= COST_LIMITS.maxWireBytes);
  const parsed = JSON.parse(text);
  assert.equal(parsed.contract, 'observability.node-cost-ledger');
  assert.equal(parsed.version, '1.0.0');
  assert.equal(parsed.nodes[0].nodeId, 'node-http-request');
  assert.equal(parsed.nodes[0].totals.durationMs, 412);
});

test('P9-S01 serialisation refuses an oversized ledger rather than emitting a truncated one', () => {
  const ledger = createNodeCostLedger({ maxNodes: COST_LIMITS.maxNodes });
  for (let i = 0; i < COST_LIMITS.maxLedgerRows; i += 1) {
    ledger.add(createNodeCostRow({
      identity: { ...fixture.identity, nodeId: `node-with-a-fairly-long-identifier-${i}` },
      dimensions: { invocations: 1, durationMs: 1 }, provenance: 'OBSERVED',
    }));
  }
  assert.equal(ledger.serialize(), null);
});

test('P9-S01 a secret-shaped dimension map is rejected before it can become a row', () => {
  assert.equal(costDimensionsAllowed(fixture.valid.dimensions), true);
  assert.equal(costDimensionsAllowed(fixture.secretDimensions), false);
  assert.equal(costDimensionsAllowed({ unknownDimension: 1 }), false);
  assert.equal(costDimensionsAllowed(null), false);
  assert.equal(costDimensionsAllowed('nope'), false);
});

test('P9-S01 an ESTIMATED row is preserved as ESTIMATED — it is never promoted to REPORTED', () => {
  const built = createNodeCostRow({
    identity: fixture.identity, dimensions: fixture.estimated.dimensions,
    provenance: 'ESTIMATED', outcome: fixture.estimated.outcome,
  });
  assert.equal(built.provenance, 'ESTIMATED');
  assert.equal(built.outcome, 'failed');
  const ledger = createNodeCostLedger();
  ledger.add(built);
  assert.deepEqual([...ledger.entries()[0].provenance], ['ESTIMATED']);
});

test('P9-S01 a REPORTED row is accepted only when the provider actually reported it', () => {
  const built = createNodeCostRow({
    identity: fixture.identity, dimensions: fixture.reported.dimensions,
    provenance: 'REPORTED', unit: 'usd-micros',
  });
  assert.equal(built.provenance, 'REPORTED');
  assert.equal(built.unit, 'usd-micros');
});
