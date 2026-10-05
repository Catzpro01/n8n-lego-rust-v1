/**
 * P6.27 — provenance statements and the transparency log.
 * Contract `node.provenance@0.1.0`.
 *
 * Matrix: the statement and its digests, publication as what turns a claim into evidence, the
 * append-only log and its head, inclusion proofs that are checked rather than trusted,
 * truncation and rebuild detection, every verification verdict, the reads, and the walls.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  MATERIAL_KINDS,
  PROVENANCE_CONTRACT,
  PROVENANCE_CONTRACT_VERSION,
  PROVENANCE_FORMAT,
  PROVENANCE_OPERATIONS,
  PROVENANCE_PERMISSIONS,
  PROVENANCE_REASONS,
  PROVENANCE_RULES,
  PROVENANCE_SCHEMA_VERSION,
  PROVENANCE_VERDICTS,
  ProvenanceError,
  createProvenanceStatement,
  createTransparencyLog,
  describeLog,
  explainProvenance,
  headOfLog,
  inclusionProof,
  isProvenanceStatement,
  isTransparencyLog,
  provenanceDigest,
  publishStatement,
  stableJson,
  verifyInclusion,
  verifyProvenance,
} from '../src/lego/provenance-log.mjs';

/* ------------------------------------------------------------------ fixtures */

const ARTIFACT_DIGEST = 'a'.repeat(64);
const ARTIFACT = { name: 'n8n-nodes-base.set', digest: ARTIFACT_DIGEST };

const STATEMENT = (overrides = {}) => createProvenanceStatement({
  subject: { name: 'n8n-nodes-base.set', digest: ARTIFACT_DIGEST },
  builder: { id: 'ci.example/build@v3', toolchain: 'rustc-1.83' },
  buildType: 'lego.package-build@1',
  materials: [
    { kind: 'source', name: 'github.com/example/set', digest: 'b'.repeat(64), uri: 'git+https://example/set@abc' },
    { kind: 'toolchain', name: 'rustc', digest: 'c'.repeat(64) },
  ],
  invocation: { parameters: 'release=true', log: 'https://ci.example/run/42' },
  startedAt: 10,
  finishedAt: 25,
  ...overrides,
});

const PUBLISHED = () => {
  const log = createTransparencyLog();
  const statement = STATEMENT();
  const published = publishStatement(log, { statement, publishedBy: 'log.example', tick: 30 });
  assert.equal(published.published, true);
  return { log, statement, record: published.record };
};

const throwsWith = (fn, code) => {
  let caught = null;
  try { fn(); } catch (error) { caught = error; }
  assert.ok(caught instanceof ProvenanceError, `expected a ProvenanceError carrying ${code}`);
  assert.equal(caught.code, 'lego.contract_violation');
  assert.equal(caught.meta.code, code);
  return caught;
};

/* ------------------------------------------------------------------ contract */

test('the contract surface is the published one: id, version, ops, closed vocabularies', () => {
  assert.equal(PROVENANCE_CONTRACT, 'node.provenance@0.1.0');
  assert.equal(PROVENANCE_CONTRACT_VERSION, '0.1.0');
  assert.equal(PROVENANCE_SCHEMA_VERSION, 1);
  assert.equal(PROVENANCE_FORMAT, 'lego-provenance@1');
  assert.deepEqual([...PROVENANCE_OPERATIONS], ['statement', 'publish', 'prove', 'verify', 'describe']);
  assert.deepEqual([...PROVENANCE_PERMISSIONS], ['node:read']);
  assert.deepEqual([...MATERIAL_KINDS], ['source', 'dependency', 'toolchain', 'configuration']);
  assert.deepEqual([...PROVENANCE_VERDICTS], ['verified', 'insufficient', 'mismatch', 'unknown']);
  assert.equal(PROVENANCE_REASONS.length, 8);
  assert.match(PROVENANCE_RULES.publish, /a statement nobody else has seen is a claim, not evidence/);
  assert.match(PROVENANCE_RULES.trust, /it never says they are safe, and it performs no cryptography/);
});

test('a statement names its subject, its builder and every input, with digests', () => {
  const statement = STATEMENT();
  assert.equal(isProvenanceStatement(statement), true);
  assert.equal(Object.isFrozen(statement), true);
  assert.equal(statement.subject.digest, ARTIFACT_DIGEST);
  assert.equal(statement.builder.id, 'ci.example/build@v3');
  assert.equal(statement.builder.toolchain, 'rustc-1.83');
  assert.deepEqual(statement.materials.map((material) => `${material.kind}:${material.name}`), ['source:github.com/example/set', 'toolchain:rustc']);
  assert.equal(statement.materials[0].uri, 'git+https://example/set@abc');
  assert.equal(statement.invocation.log, 'https://ci.example/run/42');
  assert.equal(statement.startedAt, 10);
  assert.match(statement.statementDigest, /^[0-9a-f]{64}$/);
  const { statementDigest, ...body } = statement;
  assert.equal(statementDigest, provenanceDigest(body), 'the digest covers the statement by content');
  assert.equal(stableJson({ b: 1, a: 2 }), stableJson({ a: 2, b: 1 }));

  const bare = STATEMENT({ materials: [], invocation: null, builder: { id: 'ci' } });
  assert.equal(bare.materials.length, 0);
  assert.equal(bare.builder.toolchain, null);
  assert.equal(bare.invocation, null);
  assert.equal(isProvenanceStatement({ statementDigest: 'x' }), false);
});

test('a statement refuses to be vague about what it is about or what went into it', () => {
  throwsWith(() => STATEMENT({ subject: { digest: ARTIFACT_DIGEST } }), 'provenance.subject');
  throwsWith(() => STATEMENT({ subject: { name: 'n8n-nodes-base.set' } }), 'provenance.subject');
  assert.match(
    throwsWith(() => STATEMENT({ subject: { name: 'x', digest: 'not-a-digest' } }), 'provenance.subject').message,
    /a rumour with a version number/,
  );
  throwsWith(() => STATEMENT({ builder: {} }), 'provenance.statement');
  throwsWith(() => STATEMENT({ buildType: '' }), 'provenance.statement');
  throwsWith(() => STATEMENT({ materials: 'none' }), 'provenance.statement');
  throwsWith(() => STATEMENT({ materials: [{ kind: 'vibes', name: 'x', digest: 'd'.repeat(64) }] }), 'provenance.material');
  throwsWith(() => STATEMENT({ materials: [{ kind: 'source', name: '', digest: 'd'.repeat(64) }] }), 'provenance.material');
  assert.match(
    throwsWith(() => STATEMENT({ materials: [{ kind: 'source', name: 'repo' }] }), 'provenance.material').message,
    /an input nobody can check is an input nobody can trust/,
  );
  throwsWith(() => STATEMENT({ materials: [{ kind: 'source', name: 'repo', digest: 'd'.repeat(64) }, { kind: 'source', name: 'repo', digest: 'e'.repeat(64) }] }), 'provenance.material');
  throwsWith(() => STATEMENT({ startedAt: -1 }), 'provenance.statement');
  assert.match(
    throwsWith(() => STATEMENT({ startedAt: 30, finishedAt: 20 }), 'provenance.statement').message,
    /finished \(20\) before it started \(30\)/,
  );
});

/* --------------------------------------------------------------- the log */

test('publishing is what makes a statement citable, and the log links every record to the one before', () => {
  const log = createTransparencyLog();
  assert.equal(isTransparencyLog(log), true);
  const first = publishStatement(log, { statement: STATEMENT(), publishedBy: 'log.example', tick: 30 });
  assert.equal(first.record.index, 0);
  assert.equal(first.record.previousRecordDigest, null);
  const secondStatement = STATEMENT({ subject: { name: 'n8n-nodes-base.if', digest: 'f'.repeat(64) } });
  const second = publishStatement(log, { statement: secondStatement, publishedBy: 'log.example', tick: 31 });
  assert.equal(second.record.index, 1);
  assert.equal(second.record.previousRecordDigest, first.record.recordDigest);
  assert.deepEqual(headOfLog(log), { head: second.record.recordDigest, length: 2 });

  const duplicate = publishStatement(log, { statement: STATEMENT(), publishedBy: 'someone-else', tick: 32 });
  assert.equal(duplicate.published, false);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.record.recordDigest, first.record.recordDigest, 'a log that grows when nothing happened is a log nobody can reason about');
  assert.equal(log.records.length, 2);

  throwsWith(() => publishStatement(log, { statement: { statementDigest: 'x' }, publishedBy: 'a', tick: 1 }), 'provenance.input');
  throwsWith(() => publishStatement(log, { statement: STATEMENT(), publishedBy: '', tick: 1 }), 'provenance.publish');
  throwsWith(() => publishStatement(log, { statement: STATEMENT(), publishedBy: 'a' }), 'provenance.input');
  throwsWith(() => publishStatement({}, { statement: STATEMENT(), publishedBy: 'a', tick: 1 }), 'provenance.input');
  throwsWith(() => headOfLog({}), 'provenance.input');
});

test('a log whose record was rebuilt under one digest is refused rather than folded in', () => {
  const { log, statement } = PUBLISHED();
  const record = log.records[0];
  log.records[0] = { ...record, subjectDigest: 'f'.repeat(64) };
  assert.match(
    throwsWith(() => publishStatement(log, { statement, publishedBy: 'log.example', tick: 40 }), 'provenance.publish').message,
    /the digest does not identify the statement/,
  );
  assert.equal(log.records.length, 1);
});

/* ---------------------------------------------------------------- proofs */

test('an inclusion proof walks to the head, and verifying it checks the links rather than trusting them', () => {
  const log = createTransparencyLog();
  const statements = ['1', '2', '3'].map((character) => STATEMENT({ subject: { name: `node-${character}`, digest: character.repeat(64) } }));
  statements.forEach((statement, index) => publishStatement(log, { statement, publishedBy: 'log.example', tick: 30 + index }));

  const proof = inclusionProof(log, { statementDigest: statements[0].statementDigest });
  assert.equal(proof.index, 0);
  assert.equal(proof.path.length, 3);
  assert.equal(proof.length, 3);
  assert.equal(proof.headDigest, log.head);
  assert.deepEqual([...proof.path], log.records.map((record) => record.recordDigest));
  const verified = verifyInclusion(log, proof);
  assert.equal(verified.verified, true);
  assert.equal(verified.index, 0);
  assert.match(verified.message, /included at index 0 and unchallenged at head/);
  assert.match(verified.evidenceDigest, /^[0-9a-f]{64}$/);

  const late = verifyInclusion(log, inclusionProof(log, { statementDigest: statements[2].statementDigest }));
  assert.equal(late.verified, true);
  assert.equal(late.index, 2);
  const absent = inclusionProof(log, { statementDigest: 'f'.repeat(64) });
  assert.equal(absent.ok, false);
  assert.match(absent.message, /an unpublished statement cannot be proven included/);
  throwsWith(() => verifyInclusion(log, absent), 'provenance.input');
  throwsWith(() => inclusionProof({}, { statementDigest: 'x' }), 'provenance.input');
});

test('a truncated log and a rebuilt log both fail closed, because history is not negotiable', () => {
  const { log, statement } = PUBLISHED();
  publishStatement(log, { statement: STATEMENT({ subject: { name: 'other', digest: '2'.repeat(64) } }), publishedBy: 'log.example', tick: 31 });
  const proof = inclusionProof(log, { statementDigest: statement.statementDigest });

  const truncated = createTransparencyLog();
  truncated.records.push(...log.records.slice(0, 2));
  truncated.head = truncated.records[1].recordDigest;
  assert.equal(verifyInclusion(truncated, proof).verified, true, 'nothing was removed from this one');

  const shorter = createTransparencyLog();
  shorter.records.push(log.records[0]);
  shorter.head = log.records[0].recordDigest;
  const shortProof = verifyInclusion(shorter, proof);
  assert.equal(shortProof.verified, false);
  assert.match(shortProof.message, /a log that ends sooner than the proof admits is a log something was removed from/);

  const rebuilt = createTransparencyLog();
  rebuilt.records.push({ ...log.records[0], recordDigest: '9'.repeat(64) }, log.records[1]);
  rebuilt.head = log.records[1].recordDigest;
  assert.match(verifyInclusion(rebuilt, proof).message, /the log has been rebuilt differently/);

  const brokenLink = createTransparencyLog();
  brokenLink.records.push(log.records[0], { ...log.records[1], previousRecordDigest: '8'.repeat(64) });
  brokenLink.head = log.records[1].recordDigest;
  assert.match(verifyInclusion(brokenLink, proof).message, /does not hold together from the proven record to its head/);
});

/* ---------------------------------------------------------------- checking */

test('a statement nobody has seen is a claim, not evidence: verification needs publication', () => {
  const { log, statement } = PUBLISHED();
  const proof = inclusionProof(log, { statementDigest: statement.statementDigest });
  const verified = verifyProvenance(ARTIFACT, { statement, log, proof });
  assert.equal(verified.ok, true);
  assert.equal(verified.verdict, 'verified');
  assert.equal(verified.builder, 'ci.example/build@v3');
  assert.deepEqual([...verified.materials], ['source:github.com/example/set', 'toolchain:rustc']);
  assert.match(verified.message, /provenance verified: ci\.example\/build@v3 built this from 2 cited input\(s\), published at index 0/);
  assert.match(explainProvenance(verified), /n8n-nodes-base\.set: VERIFIED/);

  const unpublished = verifyProvenance(ARTIFACT, { statement });
  assert.equal(unpublished.verdict, 'insufficient');
  assert.equal(unpublished.reason, 'provenance.publish');
  assert.match(unpublished.message, /a statement nobody else has seen is a claim, not evidence/);

  const noStatement = verifyProvenance(ARTIFACT, {});
  assert.equal(noStatement.verdict, 'unknown');
  assert.equal(noStatement.ok, false);
  assert.match(noStatement.message, /unknown is not a pass, and it is not a failure either — it is an absence/);

  const waived = verifyProvenance(ARTIFACT, { statement, policy: { requirePublication: false } });
  assert.equal(waived.verdict, 'verified');
  assert.match(waived.message, /this policy does not require publication/);
});

test('provenance about a different artifact, builder or input set is not provenance about this one', () => {
  const { log, statement } = PUBLISHED();
  const proof = inclusionProof(log, { statementDigest: statement.statementDigest });

  const wrongDigest = verifyProvenance({ name: 'n8n-nodes-base.set', digest: 'e'.repeat(64) }, { statement, log, proof });
  assert.equal(wrongDigest.verdict, 'mismatch');
  assert.match(wrongDigest.message, /provenance about something else is not provenance about this/);
  const wrongName = verifyProvenance({ name: 'n8n-nodes-base.if', digest: ARTIFACT_DIGEST }, { statement, log, proof });
  assert.equal(wrongName.verdict, 'mismatch');
  assert.match(wrongName.message, /the statement names 'n8n-nodes-base\.set' and the artifact is 'n8n-nodes-base\.if'/);

  const needsDependency = verifyProvenance(ARTIFACT, { statement, log, proof, policy: { requireMaterials: ['source', 'dependency'] } });
  assert.equal(needsDependency.verdict, 'insufficient');
  assert.equal(needsDependency.reason, 'provenance.material');
  assert.deepEqual([...needsDependency.missing], ['dependency']);

  const builderNotAllowed = verifyProvenance(ARTIFACT, { statement, log, proof, policy: { allowedBuilders: ['ci.example/other@v1'] } });
  assert.equal(builderNotAllowed.verdict, 'insufficient');
  assert.equal(builderNotAllowed.reason, 'provenance.policy');
  assert.match(builderNotAllowed.message, /builder 'ci\.example\/build@v3' is not among the builders this policy allows/);

  const otherStatement = STATEMENT({ subject: { name: 'n8n-nodes-base.set', digest: ARTIFACT_DIGEST }, buildType: 'lego.package-build@1', invocation: { parameters: 'release=false' } });
  const mismatchedProof = verifyProvenance(ARTIFACT, { statement, log, proof: { ...proof, statementDigest: otherStatement.statementDigest } });
  assert.equal(mismatchedProof.verdict, 'insufficient');
  assert.match(mismatchedProof.message, /inclusion of one statement says nothing about another/);

  const unpublishedProof = verifyProvenance(ARTIFACT, { statement, log: createTransparencyLog(), proof });
  assert.equal(unpublishedProof.verdict, 'insufficient');
  assert.match(unpublishedProof.message, /ends sooner than the proof admits/);

  throwsWith(() => verifyProvenance({ name: 'x' }, {}), 'provenance.input');
  throwsWith(() => verifyProvenance(ARTIFACT, { statement, policy: { allowedBuilders: [] } }), 'provenance.policy');
  throwsWith(() => verifyProvenance(ARTIFACT, { statement, policy: { requireMaterials: ['vibes'] } }), 'provenance.policy');
  throwsWith(() => verifyProvenance(ARTIFACT, { statement, policy: { requirePublication: 'yes' } }), 'provenance.policy');
  throwsWith(() => verifyProvenance(ARTIFACT, { statement: { statementDigest: 'x' } }), 'provenance.input');
});

/* -------------------------------------------------------------------- reads */

test('the log census names what it holds, and it digests itself', () => {
  const log = createTransparencyLog();
  publishStatement(log, { statement: STATEMENT(), publishedBy: 'log.example', tick: 30 });
  publishStatement(log, { statement: STATEMENT({ subject: { name: 'n8n-nodes-base.if', digest: 'f'.repeat(64) }, builder: { id: 'ci.example/build@v2' } }), publishedBy: 'mirror.example', tick: 31 });
  const described = describeLog(log);
  assert.equal(described.length, 2);
  assert.equal(described.format, PROVENANCE_FORMAT);
  assert.equal(described.head, log.head);
  assert.deepEqual([...described.builders], ['ci.example/build@v2', 'ci.example/build@v3']);
  assert.deepEqual([...described.publishers], ['log.example', 'mirror.example']);
  assert.equal(described.subjects.length, 2);
  assert.equal(described.headHistory.length, 2);
  assert.match(described.logDigest, /^[0-9a-f]{64}$/);
  const { logDigest, ...body } = described;
  assert.equal(logDigest, provenanceDigest(body));
  throwsWith(() => describeLog({}), 'provenance.input');
  throwsWith(() => explainProvenance({ verdict: 'probably' }), 'provenance.input');
  assert.equal(describeLog(createTransparencyLog()).head, null);
});

/* --------------------------------------------------------------------- walls */

test('provenance records where bytes came from: it signs nothing and decides nothing', () => {
  const source = readFileSync(new URL('../src/lego/provenance-log.mjs', import.meta.url), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const forbidden of ['node:fs', 'node:net', 'node:http', 'node:os', 'node:child_process', 'process.', 'Math.random', 'setTimeout', 'performance.', 'fetch(', 'node:vm', 'eval(', 'createSign', 'subtle', 'privateKey', 'signAttestation']) {
    assert.equal(code.includes(forbidden), false, `the provenance contract must not reference ${forbidden}`);
  }
  assert.deepEqual([...code.matchAll(/from '(node:[a-z_/]+)'/g)].map((match) => match[1]), ['node:crypto']);
  assert.equal(/\bnew Date\b|\bDate\.now\b/.test(code), false);
  for (const forbidden of ['./supply-chain.mjs', './registry-integrity.mjs', './node-registry.mjs', './admission-explain.mjs', './sbom-policy.mjs', './native-abi.mjs', './wasm-cache.mjs', './artifact-store.mjs']) {
    assert.equal(code.includes(forbidden), false, `P6.27 must not reach into ${forbidden}: this log is about builds, and the attestation list belongs to P6.12`);
  }
  for (const name of ['createAttestationPolicy', 'mirrorManifest', 'verifyChain', 'appendEpoch', 'compileRegistryEpoch', 'NODE_TRUST_CLASSES']) {
    assert.equal(code.includes(name), false, `${name} belongs to another milestone: provenance is not trust`);
  }
});

/* ------------------------------------------------------------------- lock row */

test('the contract-lock row is canonical: one row, version, ops, tests, exports, domain path', () => {
  const lock = JSON.parse(readFileSync(new URL('../src/lego/contracts/contract-lock.json', import.meta.url)));
  const rows = lock.contracts.filter((contract) => contract.id === 'node.provenance');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].version, PROVENANCE_CONTRACT_VERSION);
  assert.equal(rows[0].domain, 'node-registry');
  assert.equal(rows[0].status, 'implemented');
  assert.deepEqual(rows[0].surface, ['src/lego/provenance-log.mjs']);
  assert.deepEqual(rows[0].tests, ['apps/n8n-lego/test/lego-provenance-log.test.mjs']);
  for (const name of ['createProvenanceStatement', 'createTransparencyLog', 'publishStatement', 'inclusionProof', 'verifyInclusion', 'verifyProvenance', 'describeLog']) {
    assert.equal(rows[0].exports['src/lego/provenance-log.mjs'].includes(name), true, `${name} must be locked`);
  }
  for (const id of ['node.registry', 'node.abi', 'runtime.wasm-cache', 'node.io', 'registry.compiler', 'node.supply-chain', 'registry.integrity', 'node.admission', 'node.sbom', 'node.canary', 'node.revocation']) {
    assert.equal(lock.contracts.find((contract) => contract.id === id).version, '0.1.0', `P6.27 must not re-version ${id}`);
  }
  const domain = JSON.parse(readFileSync(new URL('../src/lego/manifest/domains.json', import.meta.url)))
    .domains.find((entry) => entry.id === 'node-registry');
  assert.equal(domain.contract.id, 'node.portability');
  assert.ok(domain.paths.includes('src/lego/provenance-log.mjs'));
});
