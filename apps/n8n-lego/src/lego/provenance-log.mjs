/**
 * node.provenance@0.1.0 — provenance statements and the transparency log.
 *
 * P6 milestone 27 of 31 (Issue #100). "Where did these bytes come from" is a question with a
 * cheap wrong answer: a field in a manifest, a build id, a CI badge. This contract makes the
 * answer cost something — a statement that names its subject, its inputs and its builder, and a
 * log that has to have SEEN it before anybody calls it verified.
 *
 * What it adds:
 *
 *  - PROVENANCE IS A STATEMENT ABOUT A SUBJECT DIGEST, and a statement about a different digest
 *    is refused as `mismatch`. A record that says "the build of n8n-nodes-base.set@3.4" without
 *    a digest is a rumour with a version number.
 *  - EVERY INPUT HAS A DIGEST. Source, dependency, toolchain and configuration materials are
 *    named and digested, so "built from the repo" is not a claim this contract accepts.
 *  - A STATEMENT NOBODY HAS SEEN IS A CLAIM, NOT EVIDENCE. Publication is what turns a statement
 *    into evidence: `verifyProvenance` returns `insufficient` for an unpublished statement by
 *    default, and `verified` only with a log inclusion proof that still holds.
 *  - THE LOG IS APPEND-ONLY AND ITS HEAD IS A CHECKPOINT. An inclusion proof walks from the
 *    record to the head; a log that ends sooner than a proof admits is refused, because a
 *    truncated log is how history gets removed quietly.
 *  - PROVENANCE IS NOT TRUST. This contract says where bytes came from; it never says they are
 *    safe, and it deliberately performs no cryptography — attestation and signatures belong to
 *    P6.12, and the trust classes to P6.1.
 *
 * Scope walls (enforced by tests): no signing or verification of signatures (P6.12), no trust
 * class (P6.1), no admission decision (P6.17), no artefact store (P6.7), no epoch chain (P6.16 —
 * this log is about builds, not registry states). No filesystem, network, clock, randomness or
 * shared-state mutation beyond the log handed in — the only `node:` import is the hash.
 *
 * Authority: this contract records and checks where an artifact came from. It never decides
 * whether the artifact may run.
 */
import { createHash } from 'node:crypto';

export const PROVENANCE_CONTRACT = 'node.provenance@0.1.0';
export const PROVENANCE_CONTRACT_VERSION = '0.1.0';
export const PROVENANCE_SCHEMA_VERSION = 1;

export const PROVENANCE_OPERATIONS = Object.freeze(['statement', 'publish', 'prove', 'verify', 'describe']);
export const PROVENANCE_PERMISSIONS = Object.freeze(['node:read']);

export const PROVENANCE_FORMAT = 'lego-provenance@1';

/** What a statement may cite as an input. A build with an uncited input is an unexplained build. */
export const MATERIAL_KINDS = Object.freeze(['source', 'dependency', 'toolchain', 'configuration']);

/** What verifying can say. `unknown` is what a missing statement earns. */
export const PROVENANCE_VERDICTS = Object.freeze(['verified', 'insufficient', 'mismatch', 'unknown']);

export const PROVENANCE_REASONS = Object.freeze([
  'provenance.input', 'provenance.statement', 'provenance.material', 'provenance.subject',
  'provenance.log', 'provenance.inclusion', 'provenance.policy', 'provenance.publish',
]);

export const PROVENANCE_RULES = Object.freeze({
  subject: 'a statement is about a subject digest: provenance about something else is not provenance about this',
  materials: 'every input is named and digested, because "built from the repository" is not a claim this contract accepts',
  publish: 'a statement nobody else has seen is a claim, not evidence: verification needs a log inclusion proof',
  chain: 'the log is append-only and its head is a checkpoint: a log that ends sooner than a proof admits is refused',
  truncation: 'a truncated log is how history is removed quietly, so a proof that outruns the log fails closed',
  trust: 'provenance says where bytes came from; it never says they are safe, and it performs no cryptography',
  authority: 'this contract records and checks where an artifact came from; it never decides whether it may run',
});

export class ProvenanceError extends Error {
  constructor(message, { code = 'provenance.input', meta = {} } = {}) {
    super(message);
    this.name = 'ProvenanceError';
    this.code = 'lego.contract_violation';
    this.meta = { code, ...meta };
  }
}

const fail = (message, detail = {}) => { throw new ProvenanceError(message, detail); };

const isNonEmptyString = (value) => typeof value === 'string' && value.length > 0;
const isTick = (value) => Number.isInteger(value) && value >= 0;
const isDigest = (value) => isNonEmptyString(value) && /^[0-9a-f]{64}$/.test(value.replace(/^sha256:/, ''));

/** Canonical JSON: key order must not change a digest. */
export function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

/** A digest over a set of fields. Digests are bare hex here; the caller's spelling is the caller's. */
export function provenanceDigest(fields) {
  return sha256(stableJson(fields ?? {}));
}

/* --------------------------------------------------------------- statement */

/**
 * A statement is the claim: this builder turned these inputs into this subject. Everything in it
 * is digested, because a claim without digests cannot be checked against anything.
 */
export function createProvenanceStatement({
  subject, builder, buildType, materials = [], invocation = null, startedAt, finishedAt,
} = {}) {
  if (subject === null || typeof subject !== 'object') fail('a statement has a subject', { code: 'provenance.statement', field: 'subject' });
  if (!isNonEmptyString(subject.name)) fail('the subject has a name', { code: 'provenance.subject', field: 'subject.name' });
  if (!isDigest(subject.digest)) {
    fail(`the subject digest '${String(subject.digest)}' is not a digest: a statement without one is a rumour with a version number`, { code: 'provenance.subject', field: 'subject.digest' });
  }
  if (builder === null || typeof builder !== 'object' || !isNonEmptyString(builder.id)) {
    fail('a statement names the builder, because "the CI" is not an identity', { code: 'provenance.statement', field: 'builder.id' });
  }
  if (!isNonEmptyString(buildType)) fail('a statement names the build type', { code: 'provenance.statement', field: 'buildType' });
  if (!Array.isArray(materials)) fail('materials are a list', { code: 'provenance.statement', field: 'materials' });
  if (!isTick(startedAt) || !isTick(finishedAt)) fail('a build records the ticks it started and finished at', { code: 'provenance.statement', field: 'startedAt' });
  if (finishedAt < startedAt) fail(`the build finished (${finishedAt}) before it started (${startedAt})`, { code: 'provenance.statement', field: 'finishedAt' });

  const seen = new Set();
  const normalized = materials.map((material, index) => {
    const kind = material?.kind;
    if (!MATERIAL_KINDS.includes(kind)) {
      fail(`material ${index} has kind '${String(kind)}': inputs are ${MATERIAL_KINDS.join(', ')}`, { code: 'provenance.material', field: `materials[${index}].kind` });
    }
    if (!isNonEmptyString(material?.name)) fail(`material ${index} has no name`, { code: 'provenance.material', field: `materials[${index}].name` });
    if (!isDigest(material?.digest)) {
      fail(`material ${index} has no digest: an input nobody can check is an input nobody can trust`, { code: 'provenance.material', field: `materials[${index}].digest` });
    }
    const key = `${kind}:${material.name}`;
    if (seen.has(key)) fail(`material '${key}' is cited twice`, { code: 'provenance.material', field: `materials[${index}].name` });
    seen.add(key);
    return Object.freeze({ kind, name: material.name, digest: material.digest, uri: isNonEmptyString(material?.uri) ? material.uri : null });
  });

  const body = {
    contract: PROVENANCE_CONTRACT,
    schemaVersion: PROVENANCE_SCHEMA_VERSION,
    format: PROVENANCE_FORMAT,
    subject: Object.freeze({ name: subject.name, digest: subject.digest }),
    builder: Object.freeze({ id: builder.id, toolchain: isNonEmptyString(builder.toolchain) ? builder.toolchain : null }),
    buildType,
    materials: Object.freeze(normalized),
    invocation: invocation === null ? null : Object.freeze({
      parameters: isNonEmptyString(invocation?.parameters) ? invocation.parameters : null,
      log: isNonEmptyString(invocation?.log) ? invocation.log : null,
    }),
    startedAt,
    finishedAt,
  };
  return Object.freeze({ ...body, statementDigest: provenanceDigest(body) });
}

export function isProvenanceStatement(value) {
  return Boolean(value) && typeof value === 'object' && value.contract === PROVENANCE_CONTRACT && isNonEmptyString(value.statementDigest) && value.subject !== undefined;
}

/* --------------------------------------------------------------- the log */

export function createTransparencyLog() {
  return { contract: PROVENANCE_CONTRACT, schemaVersion: PROVENANCE_SCHEMA_VERSION, records: [], head: null };
}

export function isTransparencyLog(value) {
  return Boolean(value) && typeof value === 'object' && value.contract === PROVENANCE_CONTRACT && Array.isArray(value.records) && value.records.every((record) => typeof record === 'object');
}

/**
 * Publishing is what makes a statement citable. The same statement published twice is the same
 * record — a log that grows when nothing happened is a log nobody can reason about.
 */
export function publishStatement(log, { statement, publishedBy, tick } = {}) {
  if (!isTransparencyLog(log)) fail('publishStatement reads a log made by createTransparencyLog', { code: 'provenance.input', field: 'log' });
  if (!isProvenanceStatement(statement)) fail('publishStatement reads a statement made by createProvenanceStatement', { code: 'provenance.input', field: 'statement' });
  if (!isNonEmptyString(publishedBy)) fail('a publication names who published it', { code: 'provenance.publish', field: 'publishedBy' });
  if (!isTick(tick)) fail('a publication happens at a tick', { code: 'provenance.input', field: 'tick' });

  const existing = log.records.find((record) => record.statementDigest === statement.statementDigest) ?? null;
  if (existing) {
    if (existing.subjectDigest !== statement.subject.digest) {
      fail(`one statement digest already covers subject ${existing.subjectDigest.slice(0, 12)}… and is now cited for ${statement.subject.digest.slice(0, 12)}…: the digest does not identify the statement`, { code: 'provenance.publish', field: 'statementDigest' });
    }
    return Object.freeze({ ok: true, published: false, duplicate: true, record: existing, message: 'this statement is already in the log under the same digest' });
  }

  const previous = log.records[log.records.length - 1] ?? null;
  const body = {
    contract: PROVENANCE_CONTRACT,
    schemaVersion: PROVENANCE_SCHEMA_VERSION,
    index: log.records.length,
    statementDigest: statement.statementDigest,
    subject: statement.subject.name,
    subjectDigest: statement.subject.digest,
    builder: statement.builder.id,
    publishedBy,
    tick,
    previousRecordDigest: previous === null ? null : previous.recordDigest,
  };
  const record = Object.freeze({ ...body, recordDigest: provenanceDigest(body) });
  log.records.push(record);
  log.head = record.recordDigest;
  return Object.freeze({ ok: true, published: true, record, message: `published at index ${record.index}: ${statement.subject.name}` });
}

export function headOfLog(log) {
  if (!isTransparencyLog(log)) fail('headOfLog reads a log made by createTransparencyLog', { code: 'provenance.input', field: 'log' });
  return Object.freeze({ head: log.head, length: log.records.length });
}

/**
 * An inclusion proof walks from a record to the head, carrying every link. Checking it does not
 * require trusting this log object: the links are verified.
 */
export function inclusionProof(log, { statementDigest } = {}) {
  if (!isTransparencyLog(log)) fail('inclusionProof reads a log made by createTransparencyLog', { code: 'provenance.input', field: 'log' });
  const index = log.records.findIndex((record) => record.statementDigest === statementDigest);
  if (index === -1) {
    return Object.freeze({ ok: false, reason: 'provenance.inclusion', message: 'this statement is not in the log: an unpublished statement cannot be proven included' });
  }
  const path = log.records.slice(index).map((record) => record.recordDigest);
  const body = {
    contract: PROVENANCE_CONTRACT,
    statementDigest,
    index,
    recordDigest: log.records[index].recordDigest,
    path: Object.freeze(path),
    headDigest: log.head,
    length: log.records.length,
  };
  return Object.freeze({ ...body, verified: false, proofDigest: provenanceDigest(body) });
}

/**
 * Verifying a proof checks the links and the length: a log that ends sooner than the proof admits
 * has had something removed, and that fails closed.
 */
export function verifyInclusion(log, proof) {
  if (!isTransparencyLog(log)) fail('verifyInclusion reads a log made by createTransparencyLog', { code: 'provenance.input', field: 'log' });
  if (!proof || typeof proof !== 'object' || !isNonEmptyString(proof.proofDigest)) {
    fail('verifyInclusion reads a proof made by inclusionProof', { code: 'provenance.input', field: 'proof' });
  }
  if (log.records.length < proof.length) {
    return Object.freeze({
      ok: false,
      verified: false,
      reason: 'provenance.inclusion',
      message: `the proof admits ${proof.length} record(s) and this log has ${log.records.length}: a log that ends sooner than the proof admits is a log something was removed from`,
    });
  }
  const record = log.records[proof.index];
  if (!record || record.recordDigest !== proof.recordDigest) {
    return Object.freeze({
      ok: false,
      verified: false,
      reason: 'provenance.inclusion',
      message: `index ${proof.index} in this log is not the record the proof names: the log has been rebuilt differently`,
    });
  }
  for (let index = proof.index + 1; index < proof.index + proof.path.length; index += 1) {
    const previous = log.records[index - 1];
    const current = log.records[index];
    if (current.previousRecordDigest !== previous.recordDigest) {
      return Object.freeze({ ok: false, verified: false, reason: 'provenance.inclusion', message: `the chain is broken at index ${index}: this log does not hold together from the proven record to its head` });
    }
  }
  const lastIndex = proof.index + proof.path.length - 1;
  if (log.records[lastIndex].recordDigest !== proof.headDigest) {
    return Object.freeze({ ok: false, verified: false, reason: 'provenance.inclusion', message: 'the proof ends at a different head than the one it claims: the log has moved on since the proof was made' });
  }
  return Object.freeze({
    ok: true,
    verified: true,
    statementDigest: proof.statementDigest,
    index: proof.index,
    headDigest: proof.headDigest,
    evidenceDigest: provenanceDigest({ statementDigest: proof.statementDigest, record: proof.recordDigest, head: proof.headDigest }),
    message: `included at index ${proof.index} and unchallenged at head ${String(proof.headDigest).slice(0, 12)}…`,
  });
}

/* ---------------------------------------------------------------- checking */

/**
 * The policy says what a given artifact needs. The defaults are deliberately strict: publication
 * is required, and a source material is required with it.
 */
export function verifyProvenance(artifact, { statement = null, log = null, proof = null, policy = {} } = {}) {
  if (artifact === null || typeof artifact !== 'object' || !isNonEmptyString(artifact.name) || !isDigest(artifact.digest)) {
    fail('verifyProvenance reads an artifact with a name and a digest', { code: 'provenance.input', field: 'artifact' });
  }
  const requirePublication = policy.requirePublication ?? true;
  const requireMaterials = policy.requireMaterials ?? ['source'];
  const allowedBuilders = policy.allowedBuilders ?? null;
  if (typeof requirePublication !== 'boolean') fail('requirePublication is a boolean', { code: 'provenance.policy', field: 'requirePublication' });
  if (!Array.isArray(requireMaterials) || requireMaterials.some((kind) => !MATERIAL_KINDS.includes(kind))) {
    fail(`policy materials are kinds out of ${MATERIAL_KINDS.join(', ')}`, { code: 'provenance.policy', field: 'requireMaterials' });
  }
  if (allowedBuilders !== null && (!Array.isArray(allowedBuilders) || allowedBuilders.length === 0)) {
    fail('allowedBuilders is a non-empty list when it is given: an empty allow-list is a refusal, and a refusal is said, not implied', { code: 'provenance.policy', field: 'allowedBuilders' });
  }

  if (statement === null) {
    return Object.freeze({
      ok: false,
      verdict: 'unknown',
      reason: 'provenance.statement',
      artifact: Object.freeze({ name: artifact.name, digest: artifact.digest }),
      message: 'no provenance was supplied for this artifact: unknown is not a pass, and it is not a failure either — it is an absence',
    });
  }
  if (!isProvenanceStatement(statement)) fail('verifyProvenance reads a statement made by createProvenanceStatement', { code: 'provenance.input', field: 'statement' });
  if (statement.subject.digest !== artifact.digest) {
    return Object.freeze({
      ok: false,
      verdict: 'mismatch',
      reason: 'provenance.subject',
      artifact: Object.freeze({ name: artifact.name, digest: artifact.digest }),
      message: `this statement is about ${String(statement.subject.digest).slice(0, 12)}… and the artifact is ${String(artifact.digest).slice(0, 12)}…: provenance about something else is not provenance about this`,
    });
  }
  if (statement.subject.name !== artifact.name) {
    return Object.freeze({
      ok: false,
      verdict: 'mismatch',
      reason: 'provenance.subject',
      artifact: Object.freeze({ name: artifact.name, digest: artifact.digest }),
      message: `the statement names '${statement.subject.name}' and the artifact is '${artifact.name}'`,
    });
  }
  const statedKinds = new Set(statement.materials.map((material) => material.kind));
  const missing = requireMaterials.filter((kind) => !statedKinds.has(kind));
  if (missing.length > 0) {
    return Object.freeze({
      ok: false,
      verdict: 'insufficient',
      reason: 'provenance.material',
      artifact: Object.freeze({ name: artifact.name, digest: artifact.digest }),
      missing: Object.freeze(missing),
      message: `the policy requires ${missing.join(', ')} material(s) and the statement cites none: "built from the repository" is not an input`,
    });
  }
  if (allowedBuilders !== null && !allowedBuilders.includes(statement.builder.id)) {
    return Object.freeze({
      ok: false,
      verdict: 'insufficient',
      reason: 'provenance.policy',
      artifact: Object.freeze({ name: artifact.name, digest: artifact.digest }),
      builder: statement.builder.id,
      message: `builder '${statement.builder.id}' is not among the builders this policy allows`,
    });
  }
  if (!requirePublication) {
    return Object.freeze({
      ok: true,
      verdict: 'verified',
      reason: null,
      artifact: Object.freeze({ name: artifact.name, digest: artifact.digest }),
      statementDigest: statement.statementDigest,
      evidenceDigest: provenanceDigest({ statement: statement.statementDigest, policy: { requirePublication: false } }),
      message: 'the statement matches the artifact and this policy does not require publication',
    });
  }
  if (log === null || proof === null) {
    return Object.freeze({
      ok: false,
      verdict: 'insufficient',
      reason: 'provenance.publish',
      artifact: Object.freeze({ name: artifact.name, digest: artifact.digest }),
      message: 'this statement has not been published with a proof: a statement nobody else has seen is a claim, not evidence',
    });
  }
  const inclusion = verifyInclusion(log, proof);
  if (!inclusion.verified) {
    return Object.freeze({
      ok: false,
      verdict: 'insufficient',
      reason: 'provenance.inclusion',
      artifact: Object.freeze({ name: artifact.name, digest: artifact.digest }),
      message: inclusion.message,
    });
  }
  if (proof.statementDigest !== statement.statementDigest) {
    return Object.freeze({
      ok: false,
      verdict: 'insufficient',
      reason: 'provenance.inclusion',
      artifact: Object.freeze({ name: artifact.name, digest: artifact.digest }),
      message: 'the proof is about a different statement than the one supplied: inclusion of one statement says nothing about another',
    });
  }
  return Object.freeze({
    ok: true,
    verdict: 'verified',
    reason: null,
    artifact: Object.freeze({ name: artifact.name, digest: artifact.digest }),
    statementDigest: statement.statementDigest,
    builder: statement.builder.id,
    materials: Object.freeze(statement.materials.map((material) => `${material.kind}:${material.name}`)),
    evidenceDigest: provenanceDigest({ statement: statement.statementDigest, artifact: artifact.digest, inclusion: inclusion.evidenceDigest }),
    message: `provenance verified: ${statement.builder.id} built this from ${statement.materials.length} cited input(s), published at index ${inclusion.index}`,
  });
}

/* -------------------------------------------------------------------- reads */

export function describeLog(log) {
  if (!isTransparencyLog(log)) fail('describeLog reads a log made by createTransparencyLog', { code: 'provenance.input', field: 'log' });
  const body = {
    contract: PROVENANCE_CONTRACT,
    format: PROVENANCE_FORMAT,
    length: log.records.length,
    head: log.head,
    builders: Object.freeze([...new Set(log.records.map((record) => record.builder))].sort()),
    publishers: Object.freeze([...new Set(log.records.map((record) => record.publishedBy))].sort()),
    subjects: Object.freeze([...new Set(log.records.map((record) => `${record.subject} (${String(record.subjectDigest).slice(0, 12)}…)`))].sort()),
    headHistory: Object.freeze(log.records.map((record) => record.recordDigest)),
  };
  return Object.freeze({ ...body, logDigest: provenanceDigest(body) });
}

export function explainProvenance(result) {
  if (!result || typeof result !== 'object' || !PROVENANCE_VERDICTS.includes(result.verdict)) {
    fail('explainProvenance reads a result made by verifyProvenance', { code: 'provenance.input', field: 'result' });
  }
  return `${result.artifact.name}: ${result.verdict.toUpperCase()} — ${result.message}`;
}
