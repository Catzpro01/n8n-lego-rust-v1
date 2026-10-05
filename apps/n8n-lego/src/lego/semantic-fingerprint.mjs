/**
 * Semantic fingerprint + compatibility replay — P6.9.
 *
 * PUBLIC CONTRACT (`node.semantics@0.1.0`, domain `node-registry`).
 *
 * A node version is a claim: *"same node, same contract"*. The claim is what a
 * workflow trusts when it does not replay its pins, and it is exactly the claim
 * nobody checks, because the cheap check — comparing bytes — answers a different
 * question. Two artifacts can differ in every byte and still be the same node;
 * one artifact can differ in one character and behave differently forever.
 *
 * So this contract fingerprints the CONTRACT, not the artifact:
 *
 *   type · typeVersion · parameters · expressions · credentials · io ·
 *   webhooks · behavior · ui
 *
 * Those nine axes are what the stable-identity rule (P6 / issue #100) calls the
 * n8n contract: identity, params, expressions, credential references, I/O,
 * UI metadata and declared semantics. Everything that describes how a node is
 * SUPPLIED or GOVERNED — the implementation digest, its language, the package
 * version, provenance, trust class — is deliberately OUTSIDE the fingerprint,
 * because *the implementation language is not part of the contract*. A node
 * reimplemented from JavaScript in Rust IS the same node; a node whose parameter
 * schema changed is not, however identical its bytes are.
 *
 * Replay is then a comparison of two fingerprints, with four answers and no
 * fifth:
 *
 *   MATCH            the semantics are the same (the implementation may not be)
 *   DIFF             the semantics changed; the worst axis says how much
 *   NON_DETERMINISTIC a fingerprint could not be taken — the input contained
 *                     something that cannot be canonicalised (a function, an
 *                     `undefined`, a non-finite number, a cycle, a class
 *                     instance), and a hash over a guess would look like an
 *                     answer
 *   MISSING          there is no baseline to compare against — an absent
 *                     fingerprint is not a match
 *
 * The last two are the point of the contract. A compatibility check that says
 * "probably fine" is worse than one that says "I cannot tell", because only the
 * second one stops a rollout.
 *
 * THE IMPACT LADDER. Every axis carries an impact, and a replay reports the worst
 * one it saw:
 *
 *   none < cosmetic < compatible < behavioral < breaking
 *
 * `ui` alone changing is cosmetic; a new `typeVersion` is normal and expected;
 * `expressions` or declared `behavior` changing is behavioral (the same bytes of
 * a workflow may now do something else); `type`, `parameters`, `credentials`,
 * `io` and `webhooks` changing is breaking.
 *
 * WHAT THIS IS NOT (P6.9 scope walls, enforced by tests):
 *   - it does not ADMIT anything (P6.11) and does not quarantine: a verdict is
 *     evidence for a decision, not the decision;
 *   - it does not migrate, rewrite or repair a workflow (P6.10 lifecycle, P6.30
 *     repair): it classifies a difference and names it;
 *   - it does not read files, execute code, parse source or inspect artifacts;
 *     it fingerprints the semantics INPUT it is handed, which is what makes it
 *     usable by a worker, a test and an editor without loading a node;
 *   - no clock, no network, no randomness, no mutation.
 *
 * Authority: a fingerprint is only as good as the input it was taken of. This
 * contract never invents a missing axis, never treats an absent axis as an empty
 * one, and never upgrades "I could not tell" into "MATCH".
 */
import { createHash } from 'node:crypto';

export const SEMANTIC_FINGERPRINT_CONTRACT = 'node.semantics@0.1.0';
export const SEMANTIC_FINGERPRINT_CONTRACT_VERSION = '0.1.0';
export const SEMANTIC_FINGERPRINT_SCHEMA_VERSION = 1;

export const SEMANTIC_FINGERPRINT_OPERATIONS = Object.freeze(['fingerprint', 'replay', 'explain']);
export const SEMANTIC_FINGERPRINT_PERMISSIONS = Object.freeze(['node:read']);

/** The four answers a replay may give. There is no fifth. */
export const COMPATIBILITY_VERDICTS = Object.freeze(['MATCH', 'DIFF', 'NON_DETERMINISTIC', 'MISSING']);

/** Weakest to strongest. A replay reports the worst axis it saw. */
export const IMPACT_ORDER = Object.freeze(['none', 'cosmetic', 'compatible', 'behavioral', 'breaking']);

/**
 * The nine axes of the n8n contract, each with the impact a change on it carries
 * and whether its order is semantics (`ordered`) or noise (`unordered`).
 */
export const SEMANTIC_AXES = Object.freeze([
  Object.freeze({
    axis: 'type',
    impact: 'breaking',
    order: 'ordered',
    note: 'the n8n node type name: a different type is a different node, whatever else matches',
  }),
  Object.freeze({
    axis: 'typeVersion',
    impact: 'compatible',
    order: 'ordered',
    note: 'a new typeVersion is the node saying "same node, new contract" — normal, and never silent',
  }),
  Object.freeze({
    axis: 'parameters',
    impact: 'breaking',
    order: 'ordered',
    note: 'the parameter schema is the node\'s user-facing contract; order is the UI order',
  }),
  Object.freeze({
    axis: 'expressions',
    impact: 'behavioral',
    order: 'ordered',
    note: 'which fields accept expressions and with which semantics: same workflow, different result',
  }),
  Object.freeze({
    axis: 'credentials',
    impact: 'breaking',
    order: 'unordered',
    note: 'credential references; the order of a set of references is not semantics',
  }),
  Object.freeze({
    axis: 'io',
    impact: 'breaking',
    order: 'unordered',
    note: 'inputs and outputs as a set: a moved input is a broken connection',
  }),
  Object.freeze({
    axis: 'webhooks',
    impact: 'breaking',
    order: 'unordered',
    note: 'webhook routes and methods: a changed route is a dead endpoint',
  }),
  Object.freeze({
    axis: 'behavior',
    impact: 'behavioral',
    order: 'ordered',
    note: 'declared semantics: idempotency, side effects, ordering, retry posture',
  }),
  Object.freeze({
    axis: 'ui',
    impact: 'cosmetic',
    order: 'ordered',
    note: 'display metadata: names, descriptions, icons, hints — cosmetic, never ignorable',
  }),
]);

/** axis → impact, derived from `SEMANTIC_AXES` so the two cannot drift. */
export const SEMANTIC_AXIS_IMPACTS = Object.freeze(
  Object.fromEntries(SEMANTIC_AXES.map((entry) => [entry.axis, entry.impact])),
);

/**
 * Fields that describe how a node is SUPPLIED or GOVERNED, not what it does.
 * They are recorded next to a fingerprint and never inside one.
 */
export const FINGERPRINT_EXCLUSIONS = Object.freeze([
  Object.freeze({ field: 'implementation', reason: 'the implementation language and its digest are not part of the contract: the same node reimplemented is the same node' }),
  Object.freeze({ field: 'packageVersion', reason: 'a package release is not a contract change' }),
  Object.freeze({ field: 'provenance', reason: 'where the artifact came from is supply-chain evidence (P6.12), not semantics' }),
  Object.freeze({ field: 'trustClass', reason: 'trust is a label for policy (P6.1/P6.8), never a description of behaviour' }),
  Object.freeze({ field: 'health', reason: 'health is observed at runtime (P6.11); a sick node has not changed its contract' }),
  Object.freeze({ field: 'lifecycle', reason: 'lifecycle is registry state (P6.10), not node semantics' }),
]);

/** A replay reports at most this many changed leaves, and says when it truncated. */
export const MAX_LEAF_CHANGES = 32;

export const SEMANTIC_FINGERPRINT_REASONS = Object.freeze([
  'semantics.input',
  'semantics.axis',
  'semantics.nondeterministic',
  'semantics.missing_baseline',
  'semantics.replay',
]);

export const SEMANTIC_FINGERPRINT_RULES = Object.freeze({
  fingerprint: 'a fingerprint is taken of the CONTRACT, not of the bytes: type, typeVersion, parameters, expressions, credential refs, I/O, webhooks, behaviour and UI metadata are the semantics — the implementation is not',
  determinism: 'canonical order is the fingerprint\'s foundation: keys sorted, unordered axes sorted, and anything that cannot be canonicalised makes the answer NON_DETERMINISTIC instead of a hash that looks like an answer',
  absence: 'an axis a node does not declare is recorded as ABSENT, not as empty: "no credentials" and "credentials were not declared" are different claims, and only one of them is safe to replay',
  replay: 'a replay compares a fingerprint to a fingerprint; a missing baseline is MISSING, never MATCH, and an unverifiable fingerprint is not a fingerprint',
  impact: 'the worst changed axis decides the impact: none < cosmetic < compatible < behavioral < breaking',
  authority: 'a verdict is evidence for an admission decision, not the decision: this contract classifies, it does not admit, migrate or quarantine',
  reimplementation: 'two implementations of the same contract semantics fingerprint the same: reimplementing a node in another language is not a compatibility event',
});

/* ------------------------------------------------------------------ *
 * Errors
 * ------------------------------------------------------------------ */

/** Raised for API misuse. Data problems are returned as verdicts, not thrown. */
export class SemanticFingerprintError extends Error {
  constructor(message, meta = {}) {
    super(message);
    this.name = 'SemanticFingerprintError';
    this.code = 'lego.contract_violation';
    this.meta = Object.freeze({ ...meta });
  }
}

const fail = (message, meta) => { throw new SemanticFingerprintError(message, meta); };
// Stricter than the usual check ON PURPOSE: a `Map`, a `Set` or a class instance
// has no canonical JSON form, and treating one as an empty object would produce a
// fingerprint that claims more than it knows.
const isPlainObject = (value) => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};
const isNonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0;

function deepFreeze(value) {
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
    return Object.freeze(value);
  }
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    return Object.freeze(value);
  }
  return value;
}

const stableJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
};

const digestOf = (canonicalJson) => `sha256:${createHash('sha256').update(canonicalJson, 'utf8').digest('hex')}`;
const AXIS_BY_NAME = new Map(SEMANTIC_AXES.map((entry) => [entry.axis, entry]));
const AXIS_NAMES = SEMANTIC_AXES.map((entry) => entry.axis);

/* ------------------------------------------------------------------ *
 * Canonicalisation: the step that decides whether a fingerprint exists
 * ------------------------------------------------------------------ */

const kindOf = (value) => {
  if (value === undefined) return 'undefined';
  if (typeof value === 'function') return 'function';
  if (typeof value === 'symbol') return 'symbol';
  if (typeof value === 'bigint') return 'bigint';
  if (typeof value === 'number' && !Number.isFinite(value)) return 'non-finite-number';
  if (typeof value === 'object' && value !== null && !Array.isArray(value) && !isPlainObject(value)) return 'instance';
  return null;
};

/**
 * Canonicalise a value, or say what made it impossible. `undefined` is not
 * "missing data" here: a fingerprint that silently dropped it would claim more
 * than it knows.
 */
function canonicalise(value, path, problems, stack) {
  const kind = kindOf(value);
  if (kind) {
    problems.push({
      code: 'semantics.nondeterministic',
      path,
      kind,
      message: `'${path}' holds a ${kind}, which cannot be canonicalised: a fingerprint is taken of data, and this is not data a contract can compare`,
    });
    return null;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => canonicalise(item, `${path}[${index}]`, problems, stack));
  }
  if (value && typeof value === 'object') {
    if (stack.includes(value)) {
      problems.push({
        code: 'semantics.nondeterministic',
        path,
        kind: 'cycle',
        message: `'${path}' contains a cycle: a cyclic value has no canonical form, and walking it forever is not a fingerprint`,
      });
      return null;
    }
    stack.push(value);
    const normalized = {};
    for (const key of Object.keys(value).sort()) {
      normalized[key] = canonicalise(value[key], `${path}.${key}`, problems, stack);
    }
    stack.pop();
    return normalized;
  }
  return value;
}

/** Unordered axes are compared as sets: sort by the canonical form of each item. */
function canonicalAxis(value, order, problems, axis) {
  const normalized = canonicalise(value, axis, problems, []);
  if (problems.length > 0) return null;
  if (order === 'unordered' && Array.isArray(normalized)) {
    return [...normalized].sort((left, right) => {
      const a = stableJson(left);
      const b = stableJson(right);
      return a < b ? -1 : a > b ? 1 : 0;
    });
  }
  return normalized;
}

/* ------------------------------------------------------------------ *
 * Fingerprint
 * ------------------------------------------------------------------ */

/**
 * What a node is SUPPLIED as: recorded beside a fingerprint, never inside it.
 * Two nodes with different implementations fingerprint the same.
 */
export function implementationIdentityOf(node) {
  if (!isPlainObject(node)) fail('implementationIdentityOf expects a node semantics object', { code: 'semantics.input' });
  const implementation = isPlainObject(node.implementation) ? node.implementation : {};
  return deepFreeze({
    package: typeof node.package === 'string' ? node.package : null,
    packageVersion: typeof node.packageVersion === 'string' ? node.packageVersion : null,
    implementationVersion: typeof node.implementationVersion === 'string' ? node.implementationVersion : null,
    language: typeof implementation.language === 'string' ? implementation.language : null,
    digest: typeof implementation.digest === 'string' ? implementation.digest : null,
    artifactRef: typeof implementation.artifactRef === 'string' ? implementation.artifactRef : null,
  });
}

const validateAxes = (axes) => {
  if (!Array.isArray(axes) || axes.length === 0) {
    fail('axes must be a non-empty array of semantic axis names', { code: 'semantics.axis', field: 'axes' });
  }
  for (const axis of axes) {
    if (typeof axis !== 'string' || !AXIS_BY_NAME.has(axis)) {
      fail(`'${String(axis)}' is not a semantic axis; the axes are ${AXIS_NAMES.join(', ')}`, { code: 'semantics.axis', field: 'axes' });
    }
  }
  if (new Set(axes).size !== axes.length) fail('axes must not repeat', { code: 'semantics.axis', field: 'axes' });
  return axes;
};

/**
 * Fingerprint the contract semantics of one node.
 *
 * @param {object} node the semantics INPUT: `type`, `typeVersion`, and any of
 *   `parameters`, `expressions`, `credentials`, `io`, `webhooks`, `behavior`, `ui`.
 *   `implementation`, `packageVersion`, `provenance`, `trustClass`, `health` and
 *   `lifecycle` are recorded beside the fingerprint and never inside it.
 * @param {{ axes?: string[] }} [options]
 * @returns {Readonly<object>} a fingerprint, or a NON_DETERMINISTIC refusal — never a partial one
 */
export function fingerprintNodeSemantics(node, { axes = AXIS_NAMES } = {}) {
  if (!isPlainObject(node)) fail('fingerprintNodeSemantics expects a node semantics object', { code: 'semantics.input', field: 'node' });
  const wanted = validateAxes(axes);
  const schemaVersion = SEMANTIC_FINGERPRINT_SCHEMA_VERSION;

  const problems = [];
  const digests = {};
  const present = [];
  const absent = [];
  for (const axis of wanted) {
    const value = node[axis];
    if (value === undefined) {
      absent.push(axis);
      continue;
    }
    problems.length = 0;
    const canonical = canonicalAxis(value, AXIS_BY_NAME.get(axis).order, problems, axis);
    if (problems.length > 0) {
      return deepFreeze({
        ok: false,
        schemaVersion,
        contract: SEMANTIC_FINGERPRINT_CONTRACT,
        verdict: 'NON_DETERMINISTIC',
        reason: 'semantics.nondeterministic',
        fingerprint: null,
        axes: Object.freeze({}),
        present: Object.freeze([...present]),
        absent: Object.freeze([...absent]),
        implementation: implementationIdentityOf(node),
        errors: Object.freeze(problems.map((problem) => ({ ...problem }))),
      });
    }
    digests[axis] = digestOf(stableJson(canonical));
    present.push(axis);
  }

  const sorted = [...present].sort();
  return deepFreeze({
    ok: true,
    schemaVersion,
    contract: SEMANTIC_FINGERPRINT_CONTRACT,
    verdict: null,
    reason: null,
    fingerprint: digestOf(stableJson({ axes: sorted.map((axis) => [axis, digests[axis]]) })),
    axes: Object.freeze(Object.fromEntries(sorted.map((axis) => [axis, digests[axis]]))),
    present: Object.freeze(sorted),
    absent: Object.freeze([...absent].sort()),
    implementation: implementationIdentityOf(node),
    errors: Object.freeze([]),
  });
}

/** @returns {boolean} whether `value` is a fingerprint this contract produced. */
export function isFingerprint(value) {
  return (
    isPlainObject(value) &&
    value.ok === true &&
    value.contract === SEMANTIC_FINGERPRINT_CONTRACT &&
    value.schemaVersion === SEMANTIC_FINGERPRINT_SCHEMA_VERSION &&
    typeof value.fingerprint === 'string' &&
    isPlainObject(value.axes) &&
    Object.isFrozen(value)
  );
}

/* ------------------------------------------------------------------ *
 * Replay
 * ------------------------------------------------------------------ */

const previewOf = (value) => {
  const json = stableJson(value === undefined ? null : value);
  return json.length > 120 ? `${json.slice(0, 117)}...` : json;
};

/** Bounded, path-addressed differences — enough for a human, never a document. */
const leavesBetween = (axis, before, after) => {
  const out = [];
  const normalizedBefore = canonicalise(before, axis, [], []);
  const normalizedAfter = canonicalise(after, axis, [], []);
  const walk = (left, right, path) => {
    if (out.length > MAX_LEAF_CHANGES) return;
    if (isPlainObject(left) && isPlainObject(right)) {
      for (const key of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()) {
        walk(left[key], right[key], `${path}.${key}`);
      }
      return;
    }
    if (Array.isArray(left) && Array.isArray(right) && left.length === right.length) {
      for (let index = 0; index < left.length; index += 1) walk(left[index], right[index], `${path}[${index}]`);
      return;
    }
    if (stableJson(left ?? null) !== stableJson(right ?? null)) {
      out.push({ axis, path, before: previewOf(left), after: previewOf(right) });
    }
  };
  walk(normalizedBefore, normalizedAfter, axis);
  return out;
};

const worstImpact = (impacts) => impacts.reduce(
  (worst, impact) => (IMPACT_ORDER.indexOf(impact) > IMPACT_ORDER.indexOf(worst) ? impact : worst),
  'none',
);

/** The impact of a set of changed axes: the worst one decides. */
export function impactOfAxes(changedAxes) {
  if (!Array.isArray(changedAxes)) fail('impactOfAxes expects an array of axis names', { code: 'semantics.axis', field: 'axes' });
  for (const axis of changedAxes) {
    if (!AXIS_BY_NAME.has(axis)) fail(`'${String(axis)}' is not a semantic axis; the axes are ${AXIS_NAMES.join(', ')}`, { code: 'semantics.axis', field: 'axes' });
  }
  return worstImpact(changedAxes.map((axis) => SEMANTIC_AXIS_IMPACTS[axis]));
}

const REFUSAL = (schemaVersion, verdict, reason, errors, before, after) => deepFreeze({
  ok: false,
  schemaVersion,
  contract: SEMANTIC_FINGERPRINT_CONTRACT,
  verdict,
  reason,
  before,
  after,
  changedAxes: Object.freeze([]),
  impact: 'none',
  implementationChanged: false,
  leafChanges: Object.freeze([]),
  truncated: false,
  errors: Object.freeze(errors),
});

/**
 * Replay a node's semantics: fingerprint both sides and compare.
 *
 * `ok` means "the replay could be performed", not "the answer was good": a DIFF
 * is an answer, while NON_DETERMINISTIC and MISSING are refusals to answer. Use
 * `verdict` for the answer and `compatible` for the good news.
 *
 * @param {object|null} before the semantics the workflow was written against
 * @param {object|null} after the semantics being admitted
 * @param {{ axes?: string[] }} [options]
 */
export function replayCompatibility(before, after, { axes = AXIS_NAMES } = {}) {
  const schemaVersion = SEMANTIC_FINGERPRINT_SCHEMA_VERSION;
  if (before === null || before === undefined) {
    return REFUSAL(schemaVersion, 'MISSING', 'semantics.missing_baseline', [{
      code: 'semantics.missing_baseline',
      message: 'there is no baseline to replay against: an absent fingerprint is not a match, and a workflow pinned to nothing cannot be told it is safe',
      side: 'before',
    }], null, null);
  }
  if (after === null || after === undefined) {
    return REFUSAL(schemaVersion, 'MISSING', 'semantics.missing_baseline', [{
      code: 'semantics.missing_baseline',
      message: 'there is nothing to replay: the node being admitted carries no semantics to fingerprint',
      side: 'after',
    }], null, null);
  }

  const wanted = validateAxes(axes);
  const beforeFingerprint = fingerprintNodeSemantics(before, { axes: wanted });
  const afterFingerprint = fingerprintNodeSemantics(after, { axes: wanted });
  if (!beforeFingerprint.ok || !afterFingerprint.ok) {
    return REFUSAL(schemaVersion, 'NON_DETERMINISTIC', 'semantics.nondeterministic', [
      ...beforeFingerprint.errors.map((error) => ({ ...error, side: 'before' })),
      ...afterFingerprint.errors.map((error) => ({ ...error, side: 'after' })),
    ], beforeFingerprint.ok ? beforeFingerprint : null, afterFingerprint.ok ? afterFingerprint : null);
  }

  const changedAxes = Object.freeze(wanted.filter((axis) => beforeFingerprint.axes[axis] !== afterFingerprint.axes[axis]).sort());
  const implementationChanged = stableJson(beforeFingerprint.implementation) !== stableJson(afterFingerprint.implementation);
  const leaves = [];
  for (const axis of changedAxes) {
    if (leaves.length > MAX_LEAF_CHANGES) break;
    leaves.push(...leavesBetween(axis, before[axis], after[axis]));
  }
  const verdict = changedAxes.length === 0 ? 'MATCH' : 'DIFF';

  return deepFreeze({
    ok: true,
    schemaVersion,
    contract: SEMANTIC_FINGERPRINT_CONTRACT,
    verdict,
    reason: null,
    compatible: verdict === 'MATCH',
    before: beforeFingerprint,
    after: afterFingerprint,
    changedAxes,
    absentAxes: Object.freeze([...new Set([...beforeFingerprint.absent, ...afterFingerprint.absent])].sort()),
    impact: impactOfAxes([...changedAxes]),
    implementationChanged,
    leafChanges: Object.freeze(leaves.slice(0, MAX_LEAF_CHANGES)),
    truncated: leaves.length > MAX_LEAF_CHANGES,
    errors: Object.freeze([]),
  });
}

/**
 * Replay two fingerprints a caller already holds — the worker handshake (P6.14)
 * and the cache (P6.26) exchange fingerprints, not semantics. An unverifiable
 * fingerprint is treated as MISSING, because a baseline that cannot be checked
 * is not a baseline.
 */
export function replayFingerprints(before, after) {
  const schemaVersion = SEMANTIC_FINGERPRINT_SCHEMA_VERSION;
  if (!isFingerprint(before) || !isFingerprint(after)) {
    return REFUSAL(schemaVersion, 'MISSING', 'semantics.missing_baseline', [{
      code: 'semantics.missing_baseline',
      message: 'a replay needs two fingerprints from this contract; a baseline that cannot be verified is not a baseline',
      side: isFingerprint(before) ? 'after' : 'before',
    }], isFingerprint(before) ? before : null, isFingerprint(after) ? after : null);
  }
  const names = [...new Set([...Object.keys(before.axes), ...Object.keys(after.axes)])].sort();
  const changedAxes = Object.freeze(names.filter((axis) => before.axes[axis] !== after.axes[axis]));
  const implementationChanged = stableJson(before.implementation) !== stableJson(after.implementation);
  return deepFreeze({
    ok: true,
    schemaVersion,
    contract: SEMANTIC_FINGERPRINT_CONTRACT,
    verdict: changedAxes.length === 0 ? 'MATCH' : 'DIFF',
    reason: null,
    compatible: changedAxes.length === 0,
    before,
    after,
    changedAxes,
    absentAxes: Object.freeze([...new Set([...before.absent, ...after.absent])].sort()),
    impact: impactOfAxes([...changedAxes]),
    implementationChanged,
    leafChanges: Object.freeze([]),
    truncated: false,
    errors: Object.freeze([]),
  });
}

/* ------------------------------------------------------------------ *
 * Reads
 * ------------------------------------------------------------------ */

/** @returns {boolean} whether `value` is a replay result this contract produced. */
export function isReplayResult(value) {
  return (
    isPlainObject(value) &&
    value.contract === SEMANTIC_FINGERPRINT_CONTRACT &&
    value.schemaVersion === SEMANTIC_FINGERPRINT_SCHEMA_VERSION &&
    COMPATIBILITY_VERDICTS.includes(value.verdict) &&
    Array.isArray(value.changedAxes) &&
    Object.isFrozen(value)
  );
}

const requireResult = (result, fn) => {
  if (!isReplayResult(result)) fail(`${fn} expects a replay result from replayCompatibility or replayFingerprints`, { got: typeof result });
};

/** A sentence a human can check, and a rollout can be stopped by. */
export function explainReplay(result) {
  requireResult(result, 'explainReplay');
  if (result.verdict === 'MISSING') {
    return `replay unavailable: ${result.errors[0].message}`;
  }
  if (result.verdict === 'NON_DETERMINISTIC') {
    return `replay refused: ${result.errors.length} value(s) cannot be canonicalised, so no fingerprint exists (${result.errors.map((error) => error.path).join(', ')})`;
  }
  if (result.verdict === 'MATCH') {
    return result.implementationChanged
      ? `semantics MATCH across ${result.before.present.length} axes; the implementation differs, which the contract does not count as a change`
      : `semantics MATCH across ${result.before.present.length} axes; the implementation is identical too`;
  }
  return `semantics DIFF on ${result.changedAxes.join(', ')} (impact ${result.impact}); ${result.leafChanges.length} changed value(s)${result.truncated ? ', truncated' : ''}${result.implementationChanged ? '; the implementation differs as well' : ''}`;
}

/** Machine summary: no fingerprint bodies, safe to store or log. */
export function describeFingerprint(fingerprint) {
  if (!isFingerprint(fingerprint)) fail('describeFingerprint expects a fingerprint from fingerprintNodeSemantics', { got: typeof fingerprint });
  return deepFreeze({
    contract: fingerprint.contract,
    schemaVersion: fingerprint.schemaVersion,
    fingerprint: fingerprint.fingerprint,
    present: fingerprint.present,
    absent: fingerprint.absent,
    axes: Object.freeze(Object.fromEntries(Object.keys(fingerprint.axes).map((axis) => [axis, fingerprint.axes[axis].slice(0, 15)]))),
    implementation: fingerprint.implementation,
  });
}

/** The same replay, taken again: two runs must agree, or the verdict is not evidence. */
export function verifyReplay(result, { before, after, axes } = {}) {
  requireResult(result, 'verifyReplay');
  const replayed = replayCompatibility(before, after, axes ? { axes } : {});
  if (replayed.verdict !== result.verdict || JSON.stringify(replayed.changedAxes) !== JSON.stringify(result.changedAxes)) {
    return deepFreeze({
      ok: false,
      reason: 'semantics.replay',
      expected: result.verdict,
      actual: replayed.verdict,
      message: 'the replayed verdict differs from the verdict presented; the same semantics must replay to the same answer',
    });
  }
  if (result.verdict === 'MATCH' || result.verdict === 'DIFF') {
    if (replayed.after.fingerprint !== result.after.fingerprint || replayed.before.fingerprint !== result.before.fingerprint) {
      return deepFreeze({
        ok: false,
        reason: 'semantics.replay',
        expected: result.after.fingerprint,
        actual: replayed.after.fingerprint,
        message: 'the replayed fingerprint differs from the fingerprint presented',
      });
    }
  }
  return deepFreeze({ ok: true, reason: null, expected: result.verdict, actual: replayed.verdict, message: null });
}

export const SEMANTIC_FINGERPRINT_INPUT_SCHEMA_VERSION = SEMANTIC_FINGERPRINT_SCHEMA_VERSION;
