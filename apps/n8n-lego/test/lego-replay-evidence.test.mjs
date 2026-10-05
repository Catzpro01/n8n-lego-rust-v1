import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  REPLAY_EVID_CONTRACT, REPLAY_EVID_SCHEMA_VERSION, REPLAY_EVID_SOURCES,
  REPLAY_EVID_FORMATS, REPLAY_EVID_LIMITS, REPLAY_EVID_NOTES, REPLAY_EVID_VERDICTS,
  checkReplayRef, compileReplayEvidence, selectReplayRefsForBundle,
  attachReplayEvidence, exportReplayEvidence,
} from '../src/lego/replay-evidence.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/p9/replay-evidence.json', import.meta.url), 'utf8'));

function compileInput(spec) {
  const { expect: _expect, ...rest } = structuredClone(spec);
  return compileReplayEvidence(rest);
}

test('P9.14 contract identifies itself, is versioned, pins owning formats', () => {
  assert.equal(REPLAY_EVID_CONTRACT.id, 'observability.replay-evidence');
  assert.equal(REPLAY_EVID_CONTRACT.version, '1.0.0');
  assert.equal(REPLAY_EVID_CONTRACT.owner, 'agent-6');
  assert.equal(REPLAY_EVID_SCHEMA_VERSION, '1.0.0');
  assert.deepEqual([...REPLAY_EVID_SOURCES], ['P3', 'P6']);
  const p3 = REPLAY_EVID_FORMATS.P3;
  assert.equal(p3.contract, 'execution.state-stream');
  assert.equal(p3.contractVersion, '0.1.0');
  assert.equal(p3.snapshotVersion, 1);
  assert.equal(p3.bundleSlot, 'checkpoint');
  const p6 = REPLAY_EVID_FORMATS.P6;
  assert.equal(p6.contract, 'node.semantics');
  assert.equal(p6.contractVersion, '0.1.0');
  assert.equal(p6.schemaVersion, 1);
  assert.equal(p6.bundleSlot, 'replay');
  assert.ok(REPLAY_EVID_NOTES.includes('references-not-engines'));
  assert.ok(REPLAY_EVID_VERDICTS.includes('DIFF'));
  assert.ok(REPLAY_EVID_LIMITS.maxRefs >= 1);
});

test('P9.14 P3 replay/checkpoint reference fixture compiles (version-checked)', () => {
  const f = fixture.p3Checkpoint;
  const c = compileInput(f);
  assert.ok(c, 'P3 fixture compiles');
  assert.equal(c.evidence.length, f.expect.compatible);
  assert.equal(c.incompatible.length, f.expect.incompatible);
  assert.equal(c.evidence[0].bundleSlot, f.expect.bundleSlot);
  assert.equal(c.evidence[0].source, 'P3');
  assert.equal(c.evidence[0].snapshotVersion, 1);
  const chk = checkReplayRef(f.refs[0]);
  assert.equal(chk.ok, true);
});

test('P9.14 P6 compatibility replay reference fixture compiles (version-checked)', () => {
  const f = fixture.p6Compatibility;
  const c = compileInput(f);
  assert.ok(c, 'P6 fixture compiles');
  assert.equal(c.evidence.length, f.expect.compatible);
  assert.equal(c.evidence[0].bundleSlot, f.expect.bundleSlot);
  assert.equal(c.evidence[0].verdict, f.expect.verdictCarried);
  assert.equal(c.evidence[0].schemaVersion, 1);
  const chk = checkReplayRef(f.refs[0]);
  assert.equal(chk.ok, true);
});

test('P9.14 missing replay references are handled safely (evidenceMissing)', () => {
  const f = fixture.missingReference;
  const c = compileInput(f);
  assert.ok(c, 'missing refs is data, not an error');
  assert.deepEqual([...c.evidenceMissing], f.expect.evidenceMissing);
  assert.equal(c.evidence.length, 0);
  assert.equal(c.incompatible.length, 0);
  const c2 = compileReplayEvidence({});
  assert.ok(c2);
  assert.ok(c2.evidenceMissing.includes('replayRefs'));
});

test('P9.14 incompatible snapshot version is segregated, never evidence', () => {
  const f = fixture.incompatibleVersion;
  const c = compileInput(f);
  assert.ok(c, 'incompatible version compiles to segregated result');
  assert.equal(c.evidence.length, f.expect.compatible);
  assert.equal(c.incompatible.length, f.expect.incompatible);
  assert.equal(c.incompatible[0].reason, f.expect.reason);
  assert.equal(c.evidence.length, 0, 'never promoted to evidence');
  const chk = checkReplayRef(f.refs[0]);
  assert.equal(chk.ok, false);
  assert.equal(chk.reason, 'snapshotVersion-mismatch');
});

test('P9.14 incompatible contract id is segregated (version-check on contract too)', () => {
  const f = fixture.incompatibleContract;
  const c = compileInput(f);
  assert.ok(c);
  assert.equal(c.evidence.length, f.expect.compatible);
  assert.equal(c.incompatible.length, f.expect.incompatible);
  assert.equal(c.incompatible[0].reason, f.expect.reason);
  assert.equal(c.evidence.length, 0, 'never promoted to evidence');
  const chk = checkReplayRef(f.refs[0]);
  assert.equal(chk.ok, false);
  assert.equal(chk.reason, 'contract-mismatch');
});

test('P9.14 secret-shaped refs fail closed (null)', () => {
  const f = fixture.secretRef;
  const c = compileInput(f);
  assert.equal(c, null, 'secret-shaped ref nulls the compile');
  const chk = checkReplayRef(f.refs[0]);
  assert.equal(chk.ok, false);
});

test('P9.14 bundle selection maps P3 -> checkpoint slot and P6 -> replay slot', () => {
  const c = compileReplayEvidence({ refs: structuredClone(fixture.endToEnd.refs) });
  assert.ok(c);
  const slots = selectReplayRefsForBundle(c);
  assert.ok(slots);
  assert.equal(slots.checkpoint, 'ckpt:exec-e2e:seq-1');
  assert.equal(slots.replay, 'compat:node-e2e:epoch-1');
  const onlyP3 = compileInput(fixture.p3Checkpoint);
  const s3 = selectReplayRefsForBundle(onlyP3);
  assert.equal(s3.checkpoint, fixture.p3Checkpoint.refs[0].refId);
  assert.equal(s3.replay, undefined);
});

test('P9.14 attach merges into a diagnostic refs map without dropping artifacts', () => {
  const c = compileReplayEvidence({ refs: structuredClone(fixture.endToEnd.refs) });
  assert.ok(c);
  const target = {
    refs: { artifacts: [...fixture.endToEnd.artifacts], checkpoint: 'stale-ckpt' },
    outcome: 'failed',
  };
  const merged = attachReplayEvidence(target, c);
  assert.ok(merged, 'merge succeeds');
  assert.equal(merged.outcome, 'failed', 'non-refs fields preserved');
  assert.equal(merged.refs.checkpoint, 'ckpt:exec-e2e:seq-1', 'fresh checkpoint replaces stale');
  assert.equal(merged.refs.replay, 'compat:node-e2e:epoch-1');
  assert.deepEqual([...merged.refs.artifacts], fixture.endToEnd.artifacts, 'artifacts preserved');
  assert.equal(attachReplayEvidence(target, null), null);
  assert.equal(attachReplayEvidence({ refs: { note: 'bearer xyzsecret' } }, c), null);
});

test('P9.14 end-to-end: replay refs + diagnostic + failure correlation', () => {
  const f = fixture.endToEnd;
  const c = compileReplayEvidence({ refs: structuredClone(f.refs) });
  assert.ok(c);
  assert.equal(c.evidence.length, 2);
  const slots = selectReplayRefsForBundle(c);
  assert.deepEqual(Object.keys(slots).sort(), [...f.expect.slots].sort());
  assert.equal(f.diagnostic.executionId, f.expect.executionId);
  assert.equal(f.correlation.rootId, f.expect.rootId);
  assert.equal(f.correlation.rootId, f.diagnostic.executionId,
    'diagnostic executionId = correlation rootId');
  const rootInbound = f.correlation.edges.filter(e => e.to === f.correlation.rootId);
  assert.ok(rootInbound.some(e => e.kind === f.expect.rootKind),
    `rootKind ${f.expect.rootKind} observed on inbound edge`);
  const diag = { identity: { ...f.diagnostic }, refs: { artifacts: [...f.artifacts] } };
  const merged = attachReplayEvidence(diag, c);
  assert.ok(merged);
  assert.equal(merged.refs.checkpoint, 'ckpt:exec-e2e:seq-1');
  assert.equal(merged.refs.replay, 'compat:node-e2e:epoch-1');
  const edgeEvidence = f.correlation.edges.flatMap(e => e.evidence || []);
  assert.ok(edgeEvidence.includes(merged.refs.checkpoint),
    'checkpoint refId is also correlation evidence');
});

test('P9.14 export is deterministic and secret-safe', () => {
  const c = compileInput(fixture.p3Checkpoint);
  assert.ok(c);
  const a = exportReplayEvidence(c);
  const b = exportReplayEvidence(c);
  assert.equal(typeof a, 'string');
  assert.equal(a, b, 'same inputs → same bytes');
  const c2 = compileInput(fixture.p3Checkpoint);
  const d = exportReplayEvidence(c2);
  assert.equal(a, d);
  assert.ok(a.includes('"schemaVersion":"1.0.0"') || a.includes('"schemaVersion":'));
  const secretCompiled = {
    evidence: [{ source: 'P3', refId: 'bearer leaked-token-value' }],
    incompatible: [],
    evidenceMissing: [],
  };
  assert.equal(exportReplayEvidence(secretCompiled), null);
  assert.equal(exportReplayEvidence(null), null);
});

test('P9.14 references-not-engines: module has no state-stream restore / replay engine calls', async () => {
  const src = readFileSync(new URL('../src/lego/replay-evidence.mjs', import.meta.url), 'utf8');
  assert.equal(src.includes('stateStreamFromSnapshot'), false);
  assert.equal(src.includes('replayCompatibility'), false);
  assert.equal(src.includes('replayFingerprints'), false);
  assert.equal(src.includes('restoreFromSnapshot'), false);
  const importLines = [...src.matchAll(/import\s+\{([^}]+)\}\s+from\s+'([^']+)'/g)]
    .map(m => ({ names: m[1].split(',').map(s => s.trim()).filter(Boolean), from: m[2] }));
  assert.equal(importLines.length, 1, 'exactly one named-import line');
  assert.equal(importLines[0].from, './telemetry-redaction.mjs');
  assert.deepEqual(importLines[0].names, ['containsSecretShape']);
  assert.equal(REPLAY_EVID_FORMATS.P3.contract, 'execution.state-stream');
  assert.equal(REPLAY_EVID_FORMATS.P3.contractVersion, '0.1.0');
  assert.equal(REPLAY_EVID_FORMATS.P3.snapshotVersion, 1);
  assert.equal(REPLAY_EVID_FORMATS.P6.contract, 'node.semantics');
  assert.equal(REPLAY_EVID_FORMATS.P6.contractVersion, '0.1.0');
  assert.equal(REPLAY_EVID_FORMATS.P6.schemaVersion, 1);
  assert.equal(/\bimport\s*\(/.test(src), false);
  assert.equal(/\beval\s*\(/.test(src), false);
});

test('P9.14 lock pin: contracts length tracks shared lock (75 after P9.22)', () => {
  const lock = JSON.parse(readFileSync(
    new URL('../src/lego/contracts/contract-lock.json', import.meta.url), 'utf8'));
  assert.equal(lock.contracts.length, 100, // P9 integration (Agent 1): P9.5-P9.22 add 18 observability.* rows on top of protected main 76 -> 94 (union, zero id collisions); P9 was developed on 24032a0c (57 rows). P5.2 adds the ninety-sixth (auth.session). P5.3 adds the ninety-seventh (auth.authorization). P5.5 adds the ninety-eighth (auth.credential-crypto). P5.6 adds the ninety-ninth (auth.account-security). P5.7 adds the hundredth (auth.machine-identity).
    'P9.14 adds observability.replay-evidence@1.0.0; P9.15 adds observability.telemetry-retention@1.0.0; P9.16 adds observability.operator-inspection@1.0.0; P9.17 adds observability.low-resource-mode@1.0.0; P9.18 adds observability.self-observability@1.0.0; P9.19 adds observability.tenant-isolation@1.0.0; P9.20 adds observability.contract-oracle@1.0.0; P9.21 adds observability.advanced-diagnostics@1.0.0; P9.22 adds observability.p9-acceptance@1.0.0; count-pins say 75');
  const row = lock.contracts.find(c => c.id === 'observability.replay-evidence');
  assert.ok(row, 'P9.14 row present');
  assert.equal(row.version, '1.0.0');
  assert.equal(row.owner, 'agent-6');
  assert.equal(row.domain, 'observability');
  assert.ok(Array.isArray(row.tests) && row.tests.length >= 1);
  assert.ok(typeof row.notes === 'string' && row.notes.includes('P9.14'));
});
