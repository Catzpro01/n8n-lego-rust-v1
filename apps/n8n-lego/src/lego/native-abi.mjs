/**
 * node.abi@0.1.0 — the native ABI and dual artifacts.
 *
 * P6 milestone 25 of 31 (Issue #100). A node identity may be implemented more than once: once
 * in JavaScript for the `js-compat` locality, once natively for `rust-native`. That is only an
 * asset if the two are the SAME node — which means three things have to be true and checkable:
 *
 *  1. NOTHING LANGUAGE-SPECIFIC CROSSES. The boundary carries a closed set of types (JSON
 *     values and byte handles) and the host owns item memory. A pointer, a borrow or a
 *     language object crossing the ABI would make the implementation language part of the
 *     contract, which the milestone forbids.
 *  2. AN ARTIFACT'S LOCALITY IS NOT A FREE CHOICE. A native artifact runs `rust-native`, a
 *     module runs `wasm`, a script runs `js-compat`; declaring otherwise is refused, and a
 *     native or WASM artifact without a declared ABI version is not an artifact at all.
 *  3. TWO IMPLEMENTATIONS ARE CHECKED WITH ONE SET OF VECTORS. `conformanceVectors` derives
 *     deterministic cases from the wire contract (an empty item, a full item, an unexpected
 *     field under an open and a closed shape), and `conformDualArtifact` compares what each
 *     implementation actually did. A case that did not run is INCOMPLETE and never a pass, and
 *     a divergence between the two implementations is named: TWO IMPLEMENTATIONS THAT DISAGREE
 *     ARE TWO NODES SHARING A NAME.
 *
 * Falling back to another implementation is allowed only when it is declared: substituting a
 * different locality is a decision with a record, not a silent convenience.
 *
 * Scope walls (enforced by tests): no IO compilation (P6.21 — the field map arrives as data), no
 * semantic fingerprinting (P6.9 — the digest arrives as data), no leases (P6.22) or placement
 * (P6.24), no cache (P6.26), no loading or executing anything. No filesystem, network, clock,
 * randomness or shared-state mutation — the only `node:` import is the hash.
 *
 * Authority: this contract says whether two implementations may share one identity and which one
 * a locality may run. It never runs either of them and never decides that a node may execute.
 */
import { createHash } from 'node:crypto';
import { NODE_RUNTIME_LOCALITIES } from './node-registry.mjs';

export const ABI_CONTRACT = 'node.abi@0.1.0';
export const ABI_CONTRACT_VERSION = '0.1.0';
export const ABI_SCHEMA_VERSION = 1;

export const ABI_OPERATIONS = Object.freeze(['declare', 'vectors', 'conform', 'select', 'describe']);
export const ABI_PERMISSIONS = Object.freeze(['node:read']);

/** The ABI an artifact is built against. A native artifact without one is not an artifact. */
export const NATIVE_ABI_VERSION = 'lego-native-abi@1';

/** What may cross the boundary. Nothing else does — that is what keeps the language out of it. */
export const ABI_TYPES = Object.freeze(['null', 'boolean', 'number', 'string', 'list', 'map', 'bytes-handle']);

/** Which kinds of implementation exist, and the locality each one runs in. */
export const IMPLEMENTATION_KINDS = Object.freeze(['js', 'native', 'wasm']);
export const LOCALITY_BY_KIND = Object.freeze({ js: 'js-compat', native: 'rust-native', wasm: 'wasm' });
export const ABI_REQUIRED_KINDS = Object.freeze(['native', 'wasm']);

/** What conformance can say. `INCOMPLETE` is not a pass. */
export const CONFORMANCE_VERDICTS = Object.freeze(['MATCH', 'DIVERGENT', 'INCOMPLETE']);

/** The vectors a shape produces, so two implementations are asked the same questions. */
export const VECTOR_KINDS = Object.freeze(['empty-item', 'full-item', 'unexpected-field', 'null-field']);

export const ABI_REASONS = Object.freeze([
  'abi.input', 'abi.artifact', 'abi.vectors', 'abi.conformance', 'abi.selection', 'abi.locality',
]);

export const ABI_RULES = Object.freeze({
  boundary: 'the boundary carries a closed set of types: JSON values and byte handles, and the host owns item memory',
  locality: 'an implementation kind runs in the locality it belongs to: a native artifact runs rust-native, not wherever it is convenient',
  abiVersion: 'a native or WASM artifact declares the ABI it was built against',
  vectors: 'two implementations are asked the same deterministic questions, derived from the wire contract',
  incomplete: 'a case that did not run is not a case that passed: missing results are INCOMPLETE',
  agree: 'two implementations that disagree are two nodes sharing a name',
  fallback: 'substituting a different locality is declared and recorded, never silent',
  authority: 'this contract says whether two implementations may share one identity; it never runs them',
});

export class AbiError extends Error {
  constructor(message, { code = 'abi.input', meta = {} } = {}) {
    super(message);
    this.name = 'AbiError';
    this.code = 'lego.contract_violation';
    this.meta = { code, ...meta };
  }
}

const fail = (message, detail = {}) => { throw new AbiError(message, detail); };

const isNonEmptyString = (value) => typeof value === 'string' && value.length > 0;
const isIdentity = (value) => isNonEmptyString(value) && value.includes('@') && value.split('@').every((part) => part.length > 0);

/** Canonical JSON: key order must not change a digest. */
export function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

/** A digest over a set of fields, so an artifact or a vector set can be cited by content. */
export function abiDigest(fields) {
  return sha256(stableJson(fields ?? {}));
}

/**
 * Declaring implementations for one identity is a claim that they are the same node. The claim
 * has to be consistent before it is tested: kinds, localities, ABI versions and digests.
 */
export function declareDualArtifact({ identity, ioDigest: wireDigest, semanticsDigest = null, implementations = [] } = {}) {
  if (!isIdentity(identity)) {
    fail("a dual artifact belongs to an identity 'type@typeVersion': two implementations of nothing share nothing", { code: 'abi.input', field: 'identity' });
  }
  if (!isNonEmptyString(wireDigest)) {
    fail('implementations are declared against a wire contract digest: without it there is nothing for them to agree on', { code: 'abi.artifact', field: 'ioDigest' });
  }
  if (!Array.isArray(implementations) || implementations.length === 0) {
    fail('an artifact has at least one implementation', { code: 'abi.artifact', field: 'implementations' });
  }
  const seen = new Set();
  const normalized = implementations.map((implementation, index) => {
    const kind = implementation?.kind;
    if (!IMPLEMENTATION_KINDS.includes(kind)) {
      fail(`implementation ${index} has kind '${String(kind)}': an artifact is js, native or wasm`, { code: 'abi.artifact', field: `implementations[${index}].kind` });
    }
    if (seen.has(kind)) {
      fail(`two '${kind}' implementations of one identity: which one runs would depend on the order of a list`, { code: 'abi.artifact', field: `implementations[${index}].kind` });
    }
    seen.add(kind);
    const expectedLocality = LOCALITY_BY_KIND[kind];
    if (implementation?.locality !== undefined && implementation.locality !== expectedLocality) {
      fail(`a '${kind}' implementation declares locality '${implementation.locality}' and belongs in '${expectedLocality}': the kind decides where it runs`, { code: 'abi.locality', field: `implementations[${index}].locality` });
    }
    if (ABI_REQUIRED_KINDS.includes(kind) && implementation?.abiVersion !== NATIVE_ABI_VERSION) {
      fail(`a '${kind}' artifact must declare the ABI it was built against (${NATIVE_ABI_VERSION}); got ${String(implementation?.abiVersion)}`, { code: 'abi.artifact', field: `implementations[${index}].abiVersion` });
    }
    if (kind === 'js' && implementation?.abiVersion !== undefined && implementation.abiVersion !== null) {
      fail('a js implementation does not declare a native ABI version: it is the host language, and claiming an ABI would be a costume', { code: 'abi.artifact', field: `implementations[${index}].abiVersion` });
    }
    if (!isNonEmptyString(implementation?.digest)) {
      fail(`implementation ${index} has no artifact digest: an artifact nobody can identify cannot be pinned`, { code: 'abi.artifact', field: `implementations[${index}].digest` });
    }
    if (!NODE_RUNTIME_LOCALITIES.includes(expectedLocality)) {
      fail(`locality '${expectedLocality}' is not one the foundation publishes`, { code: 'abi.locality', field: 'locality' });
    }
    return Object.freeze({
      kind,
      locality: expectedLocality,
      abiVersion: ABI_REQUIRED_KINDS.includes(kind) ? NATIVE_ABI_VERSION : null,
      artifact: isNonEmptyString(implementation?.artifact) ? implementation.artifact : null,
      digest: implementation.digest,
    });
  });
  const body = {
    contract: ABI_CONTRACT,
    schemaVersion: ABI_SCHEMA_VERSION,
    identity,
    ioDigest: wireDigest,
    semanticsDigest: isNonEmptyString(semanticsDigest) ? semanticsDigest : null,
    abiVersion: NATIVE_ABI_VERSION,
    implementations: Object.freeze(normalized),
    kinds: Object.freeze(normalized.map((implementation) => implementation.kind).sort()),
    dual: normalized.length > 1,
  };
  return Object.freeze({ ...body, artifactDigest: abiDigest(body) });
}

export function isDualArtifact(value) {
  return Boolean(value) && typeof value === 'object' && value.contract === ABI_CONTRACT && isIdentity(value.identity) && Array.isArray(value.implementations);
}

/* ------------------------------------------------------------------- vectors */

const VALUE_FOR_TYPE = Object.freeze({
  string: 'text', number: 1, boolean: true, date: '2026-01-01T00:00:00Z', object: { key: 'value' }, array: [], binary: 'bytes-handle:0', null: null,
});

/**
 * Vectors are derived from the wire contract, not invented per implementation: an empty item,
 * a full item, an unexpected field under an open and a closed shape, and a null in a declared
 * field. Both implementations are asked exactly these questions.
 */
export function conformanceVectors({ identity, ioDigest: wireDigest, fields = {}, additionalProperties = true } = {}) {
  if (!isIdentity(identity)) fail("conformance vectors belong to an identity 'type@typeVersion'", { code: 'abi.input', field: 'identity' });
  if (!isNonEmptyString(wireDigest)) fail('vectors are derived from a wire contract digest', { code: 'abi.vectors', field: 'ioDigest' });
  if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) {
    fail('the field map arrives as data: name to type', { code: 'abi.vectors', field: 'fields' });
  }
  if (typeof additionalProperties !== 'boolean') fail('additionalProperties is a boolean: a shape is open or closed', { code: 'abi.vectors', field: 'additionalProperties' });
  const full = Object.fromEntries(Object.entries(fields).map(([name, type]) => [name, VALUE_FOR_TYPE[type] ?? 'text']));
  const body = {
    contract: ABI_CONTRACT,
    schemaVersion: ABI_SCHEMA_VERSION,
    identity,
    ioDigest: wireDigest,
    additionalProperties,
    vectors: Object.freeze([
      Object.freeze({ id: 'empty-item', kind: 'empty-item', input: Object.freeze({}), expect: 'ok' }),
      Object.freeze({ id: 'full-item', kind: 'full-item', input: Object.freeze(full), expect: 'ok' }),
      Object.freeze({ id: 'unexpected-field', kind: 'unexpected-field', input: Object.freeze({ ...full, unknownField: 'text' }), expect: additionalProperties ? 'passed-through' : 'refused' }),
      Object.freeze({ id: 'null-field', kind: 'null-field', input: Object.freeze(Object.fromEntries(Object.keys(fields).map((name, index) => [name, index === 0 ? null : full[name]]))), expect: 'ok' }),
    ]),
  };
  return Object.freeze({ ...body, vectorDigest: abiDigest(body) });
}

export function isConformanceVectors(value) {
  return Boolean(value) && typeof value === 'object' && value.contract === ABI_CONTRACT && Array.isArray(value.vectors) && isNonEmptyString(value.vectorDigest);
}

/* -------------------------------------------------------------- conformance */

/**
 * Results arrive from whoever ran the implementation: one entry per vector, saying what happened.
 * Nothing here runs anything, and a vector with no result is INCOMPLETE.
 */
export function compareConformance(vectors, resultsByImplementation = {}) {
  if (!isConformanceVectors(vectors)) fail('compareConformance reads vectors made by conformanceVectors', { code: 'abi.input', field: 'vectors' });
  if (resultsByImplementation === null || typeof resultsByImplementation !== 'object' || Array.isArray(resultsByImplementation)) {
    fail('results are a map of implementation kind to per-vector results', { code: 'abi.input', field: 'results' });
  }
  const reports = Object.entries(resultsByImplementation).sort().map(([kind, results]) => {
    if (!IMPLEMENTATION_KINDS.includes(kind)) {
      fail(`results are keyed by implementation kind; '${kind}' is not one`, { code: 'abi.input', field: 'results' });
    }
    if (results === null || typeof results !== 'object' || Array.isArray(results)) {
      fail(`results for '${kind}' are a map of vector id to what happened`, { code: 'abi.input', field: kind });
    }
    const cases = vectors.vectors.map((vector) => {
      const observed = results[vector.id];
      if (observed === undefined) {
        return Object.freeze({ id: vector.id, expected: vector.expect, observed: null, ok: false, note: 'no result was reported for this case' });
      }
      const outcome = typeof observed === 'string' ? observed : observed?.outcome;
      const note = typeof observed === 'object' && observed !== null && isNonEmptyString(observed.note) ? observed.note : null;
      return Object.freeze({
        id: vector.id,
        expected: vector.expect,
        observed: outcome ?? null,
        ok: outcome === vector.expect,
        note: outcome === vector.expect ? note : (note ?? `expected '${vector.expect}' and observed '${String(outcome)}'`),
      });
    });
    const missing = cases.filter((entry) => entry.observed === null).length;
    const diverged = cases.filter((entry) => entry.observed !== null && !entry.ok).length;
    return Object.freeze({
      kind,
      verdict: missing > 0 ? 'INCOMPLETE' : (diverged > 0 ? 'DIVERGENT' : 'MATCH'),
      missing,
      diverged,
      cases: Object.freeze(cases),
    });
  });
  const body = {
    contract: ABI_CONTRACT,
    identity: vectors.identity,
    ioDigest: vectors.ioDigest,
    vectorDigest: vectors.vectorDigest,
    reports: Object.freeze(reports),
  };
  return Object.freeze({ ...body, reportDigest: abiDigest(body) });
}

export function isConformanceReport(value) {
  return Boolean(value) && typeof value === 'object' && value.contract === ABI_CONTRACT && Array.isArray(value.reports) && isNonEmptyString(value.reportDigest);
}

/**
 * Deciding whether two implementations may share one identity: both must MATCH the vectors, and
 * every implementation declared must have been asked. A declaration that includes an
 * implementation nobody ran is not conformant — it is a promise with a hole in it.
 */
export function conformDualArtifact(artifact, { vectors, results } = {}) {
  if (!isDualArtifact(artifact)) fail('conformDualArtifact reads an artifact made by declareDualArtifact', { code: 'abi.input', field: 'artifact' });
  if (!isConformanceVectors(vectors)) fail('conformDualArtifact reads vectors made by conformanceVectors', { code: 'abi.input', field: 'vectors' });
  if (vectors.ioDigest !== artifact.ioDigest || vectors.identity !== artifact.identity) {
    fail(`these vectors are for '${vectors.identity}' under wire contract ${vectors.ioDigest}: running them against '${artifact.identity}' under ${artifact.ioDigest} would prove nothing`, { code: 'abi.vectors', field: 'ioDigest' });
  }
  const report = compareConformance(vectors, results ?? {});
  const declared = new Set(artifact.kinds);
  const reported = new Set(report.reports.map((entry) => entry.kind));
  const unasked = [...declared].filter((kind) => !reported.has(kind));
  const extra = [...reported].filter((kind) => !declared.has(kind));
  if (extra.length > 0) {
    fail(`results were reported for ${extra.join(', ')}, which this artifact does not declare: a result from somewhere else is not evidence about this artifact`, { code: 'abi.conformance', field: 'results' });
  }
  const failing = report.reports.filter((entry) => entry.verdict !== 'MATCH');
  // Incompleteness wins the verdict: an implementation that was never asked, or a case that was
  // never run, is not a divergence that could be argued with — it is a hole.
  const incomplete = unasked.length > 0 || failing.some((entry) => entry.verdict === 'INCOMPLETE');
  const verdict = incomplete ? 'INCOMPLETE' : (failing.length > 0 ? 'DIVERGENT' : 'MATCH');
  const body = {
    contract: ABI_CONTRACT,
    identity: artifact.identity,
    artifactDigest: artifact.artifactDigest,
    verdict,
    asked: Object.freeze([...reported].sort()),
    unasked: Object.freeze(unasked.sort()),
    report,
  };
  return Object.freeze({
    ...body,
    ok: verdict === 'MATCH',
    evidenceDigest: abiDigest({ artifactDigest: artifact.artifactDigest, reportDigest: report.reportDigest, verdict }),
    message: verdict === 'MATCH'
      ? `every declared implementation matched the same ${vectors.vectors.length} vectors`
      : (unasked.length > 0
        ? `${unasked.join(', ')} was declared and never asked: a promise with a hole in it is not conformance`
        : `${failing.map((entry) => `${entry.kind} ${entry.verdict}`).join(', ')}: two implementations that disagree are two nodes sharing a name`),
  });
}

/* ------------------------------------------------------------------ selection */

/**
 * Which implementation a locality may run. Falling back to a different locality is allowed only
 * when it is declared, and the substitution is recorded rather than silent.
 */
export function selectImplementation(artifact, { locality, allowFallback = false } = {}) {
  if (!isDualArtifact(artifact)) fail('selectImplementation reads an artifact made by declareDualArtifact', { code: 'abi.input', field: 'artifact' });
  if (!NODE_RUNTIME_LOCALITIES.includes(locality)) {
    fail(`locality '${String(locality)}' is not one the foundation publishes (${NODE_RUNTIME_LOCALITIES.join(', ')})`, { code: 'abi.locality', field: 'locality' });
  }
  if (typeof allowFallback !== 'boolean') fail('allowFallback is a boolean: a substitution is declared or it does not happen', { code: 'abi.selection', field: 'allowFallback' });
  const exact = artifact.implementations.find((implementation) => implementation.locality === locality) ?? null;
  if (exact) {
    return Object.freeze({ ok: true, implementation: exact, locality, substituted: false, message: `'${artifact.identity}' runs its ${exact.kind} implementation in '${locality}'` });
  }
  if (!allowFallback) {
    return Object.freeze({
      ok: false,
      reason: 'abi.locality',
      locality,
      available: Object.freeze(artifact.implementations.map((implementation) => `${implementation.kind} (${implementation.locality})`)),
      message: `'${artifact.identity}' has no implementation for '${locality}': falling back would run it somewhere else, and that is a decision, not a convenience`,
    });
  }
  const substitute = [...artifact.implementations].sort((left, right) => (left.kind < right.kind ? -1 : 1))[0];
  return Object.freeze({
    ok: true,
    implementation: substitute,
    locality: substitute.locality,
    requested: locality,
    substituted: true,
    message: `'${artifact.identity}' was asked for '${locality}' and runs its ${substitute.kind} implementation in '${substitute.locality}': the substitution is declared and recorded`,
  });
}

/* -------------------------------------------------------------------- reads */

export function describeDualArtifact(artifact) {
  if (!isDualArtifact(artifact)) fail('describeDualArtifact reads an artifact made by declareDualArtifact', { code: 'abi.input', field: 'artifact' });
  return Object.freeze({
    contract: ABI_CONTRACT,
    identity: artifact.identity,
    dual: artifact.dual,
    kinds: artifact.kinds,
    abiVersion: artifact.abiVersion,
    implementations: Object.freeze(artifact.implementations.map((implementation) => `${implementation.kind} → ${implementation.locality} (${implementation.digest.slice(0, 12)}…)`)),
    ioDigest: artifact.ioDigest,
    semanticsDigest: artifact.semanticsDigest,
    artifactDigest: artifact.artifactDigest,
  });
}

export function explainConformance(conformance) {
  if (!conformance || typeof conformance !== 'object' || !isNonEmptyString(conformance.identity)) {
    fail('explainConformance reads a conformance made by conformDualArtifact', { code: 'abi.input', field: 'conformance' });
  }
  return `'${conformance.identity}': ${conformance.verdict} — ${conformance.message}`;
}
