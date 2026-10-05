/**
 * SBOM / VEX + policy diff gate — P6.18.
 *
 * PUBLIC CONTRACT (`node.sbom@0.1.0`, domain `node-registry`).
 *
 * An epoch is an executable description of a registry. Nobody outside the registry
 * can read it, and nobody outside can answer the two questions that get asked in
 * every serious review: **"what exactly is in here?"** and **"what changed, and is
 * that change allowed?"**
 *
 * AN SBOM IS A READING OF AN EPOCH, NOT A SECOND SOURCE OF TRUTH. `createSbom`
 * derives a document from an epoch and nothing else: one entry per package version,
 * carrying the checksums of the node declarations it provides, the trust class, the
 * capability names it asks for, and its licence as DECLARED BY THE CALLER
 * (`NOASSERTION` when nobody said). The format is SPDX-SHAPED on purpose — a
 * consumer that already reads SPDX should not have to learn a dialect — and calling
 * it what it is matters: `format: 'lego-sbom@1'`, not a claim of SPDX conformance.
 *
 * A DIFF IS THE SUBSTANCE. "What changed" is answered field by field (added,
 * removed, changed with the changed fields named), because a diff that only says
 * "it changed" produces exactly the review nobody wants to be in.
 *
 * VEX IS A STATEMENT, NOT A SCAN. A vulnerability status is asserted BY SOMEONE,
 * with a justification and a tick, in a closed vocabulary. This contract does not
 * scan anything: it records who said what, and where they said nothing, the answer
 * stays `under_investigation` — which is not a pass.
 *
 * THE GATE IS POLICY AS DATA. Rules are declared (no new packages, no removals, no
 * new capabilities, no trust downgrade, a ceiling on additions, no affected
 * vulnerability) and evaluated against a diff. A rule whose evidence is missing
 * makes the gate INCOMPLETE, and incomplete fails closed — *a gate that opens
 * because it could not look is not a gate*.
 *
 * TRUST ORDER IS P6.1'S, QUOTED. `node.registry@0.1.0` already names four trust
 * classes; this contract orders those four (untrusted < community < verified <
 * core) and refuses any name it does not know. Inventing a fifth word here would
 * make two vocabularies for one idea, which is how "downgrade" stops meaning
 * anything.
 *
 * WHAT THIS IS NOT (P6.18 scope walls, enforced by tests):
 *   - no scanning, no network, no vulnerability database: VEX statements are data
 *     handed in by whoever is accountable for them;
 *   - no admission decision (P6.17 explains, P6.8/P6.11/P6.12 decide) and no
 *     rollout (P6.19): the gate answers one question — may this DIFF be accepted;
 *   - no signing, publishing or attestation (P6.12/P6.27) and no delegated trust
 *     (P6.28): a document that is signed later is signed by a contract that owns it;
 *   - no filesystem, network, clock, randomness or mutation.
 *
 * Authority: an allowed diff is permission to proceed with a change, never a claim
 * that the result is safe. That claim belongs to capability, health and lease.
 */
import { createHash } from 'node:crypto';

import { NODE_TRUST_CLASSES } from './node-registry.mjs';
import { isFrozenRegistryEpoch } from './registry-compiler.mjs';

export const SBOM_CONTRACT = 'node.sbom@0.1.0';
export const SBOM_CONTRACT_VERSION = '0.1.0';
export const SBOM_SCHEMA_VERSION = 1;

export const SBOM_OPERATIONS = Object.freeze(['build', 'diff', 'gate', 'vex', 'describe']);
export const SBOM_PERMISSIONS = Object.freeze(['node:read']);

/** What this document IS: SPDX-shaped, and named honestly. */
export const SBOM_FORMAT = 'lego-sbom@1';
export const SBOM_RELATIONSHIPS = Object.freeze(['DEPENDS_ON']);

/** P6.1's four trust classes, ordered weakest → strongest. No fifth word. */
export const TRUST_ORDER = Object.freeze(['untrusted', 'community', 'verified', 'core']);

export const DIFF_KINDS = Object.freeze(['added', 'removed', 'changed', 'unchanged']);
export const GATE_RULE_KINDS = Object.freeze([
  'no-new-packages', 'no-removals', 'no-new-capabilities', 'no-trust-downgrade',
  'max-added-packages', 'no-affected-vulnerability',
]);
export const GATE_VERDICTS = Object.freeze(['allow', 'deny', 'incomplete']);

/** What someone may assert about a vulnerability. Silence is not a status. */
export const VEX_STATUSES = Object.freeze(['not_affected', 'affected', 'fixed', 'under_investigation']);
export const VEX_JUSTIFICATIONS = Object.freeze([
  'vulnerable_code_not_present', 'vulnerable_code_not_reachable', 'requires_configuration',
  'requires_privileges', 'inline_mitigations_already_exist', 'fixed_in_this_version',
]);

export const SBOM_REASONS = Object.freeze([
  'sbom.input',
  'sbom.epoch',
  'sbom.package',
  'sbom.diff',
  'sbom.rule',
  'sbom.vex',
  'sbom.gate',
]);

export const SBOM_RULES = Object.freeze({
  reading: 'an SBOM is a READING of an epoch, never a second source of truth: a document that can disagree with the registry is a second registry',
  format: 'the format is SPDX-shaped so a consumer does not have to learn a dialect, and it is named lego-sbom@1 rather than claiming a conformance it has not been tested against',
  diff: 'a diff names the fields that changed: "it changed" is how a review becomes a rumour',
  vex: 'a vulnerability status is asserted by someone with a justification and a tick, and where nobody said anything the answer stays under_investigation — which is not a pass',
  gate: 'a gate that opens because it could not look is not a gate: missing evidence makes the verdict incomplete, and incomplete fails closed',
  trust: 'the trust order is P6.1\'s four classes, ordered and quoted: a fifth word here would make two vocabularies for one idea, which is how "downgrade" stops meaning anything',
  authority: 'an allowed diff is permission to proceed with a change, never a claim that the result is safe',
});

/* ------------------------------------------------------------------ *
 * Errors, helpers
 * ------------------------------------------------------------------ */

/** Raised for API misuse. A denied diff is data. */
export class SbomError extends Error {
  constructor(message, meta = {}) {
    super(message);
    this.name = 'SbomError';
    this.code = 'lego.contract_violation';
    this.meta = Object.freeze({ ...meta });
  }
}

const fail = (message, meta) => { throw new SbomError(message, meta); };
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

/** The rank of a trust class in P6.1's vocabulary; unknown names fail closed. */
export function trustRankOf(trustClass) {
  const rank = TRUST_ORDER.indexOf(trustClass);
  if (rank < 0) fail(`unknown trust class ${JSON.stringify(trustClass)} — P6.1 names ${TRUST_ORDER.join(', ')}, and an unknown class is not a rank`, { code: 'sbom.package', field: 'trustClass' });
  return rank;
}

/* ------------------------------------------------------------------ *
 * Building the document
 * ------------------------------------------------------------------ */

export function createSbom(epoch, { documentId = null, licenses = {}, supplier = null, tickets = [], dependencies = {} } = {}) {
  if (!isFrozenRegistryEpoch(epoch)) fail('createSbom reads a compiled epoch: a document without a registry behind it is a text file', { code: 'sbom.epoch', field: 'epoch' });
  if (!isPlainObject(licenses)) fail('licenses must map a package name to its declared licence', { code: 'sbom.input', field: 'licenses' });
  if (!Array.isArray(tickets)) fail('tickets must be an array when supplied', { code: 'sbom.input', field: 'tickets' });
  // Dependencies are SUPPLIED (from P6.4's closure), never inferred: an epoch lists
  // nodes, not edges, and a document that invented edges would be a second registry.
  if (!isPlainObject(dependencies)) fail('dependencies must map a package key to the package keys it depends on', { code: 'sbom.input', field: 'dependencies' });
  for (const [key, edges] of Object.entries(dependencies)) {
    if (!Array.isArray(edges) || edges.some((edge) => !isNonEmptyString(edge))) {
      fail(`dependencies['${key}'] must be an array of package keys`, { code: 'sbom.input', field: 'dependencies' });
    }
  }

  const byPackage = new Map();
  for (const identity of epoch.identities) {
    const entry = epoch.byIdentity[identity];
    const declaration = entry.declaration;
    const key = `${declaration.package}@${declaration.packageVersion}`;
    const record = byPackage.get(key) ?? {
      key,
      name: declaration.package,
      version: declaration.packageVersion,
      vendor: declaration.vendor ?? null,
      supplier: supplier ?? declaration.vendor ?? null,
      license: licenses[declaration.package] ?? 'NOASSERTION',
      trustClasses: new Set(),
      capabilities: new Set(),
      checksums: new Set(),
      identities: [],
    };
    // A package may hold nodes at different trust classes (P6.1 declares trust per
    // declaration). The document records the SET, and comparisons use the weakest
    // member: a document that refused to read such an epoch would be useless for
    // exactly the registries this milestone exists to describe.
    if (declaration.trustClass !== undefined) {
      trustRankOf(declaration.trustClass);
      record.trustClasses.add(declaration.trustClass);
    }
    for (const capability of declaration.capabilities ?? []) record.capabilities.add(capability);
    if (isNonEmptyString(declaration.digest)) record.checksums.add(declaration.digest);
    record.identities.push(identity);
    byPackage.set(key, record);
  }

  const packages = [...byPackage.values()].map((record) => {
    const identities = [...record.identities].sort();
    return Object.freeze({
      spdxId: `SPDXRef-Package-${record.name}-${record.version}`.replace(/[^A-Za-z0-9.-]/g, '-'),
      key: record.key,
      name: record.name,
      version: record.version,
      supplier: record.supplier,
      license: record.license,
      trustClasses: Object.freeze([...record.trustClasses].sort()),
      capabilities: Object.freeze([...record.capabilities].sort()),
      checksums: Object.freeze([...record.checksums].sort()),
      identities: Object.freeze(identities),
      dependencies: Object.freeze([...new Set(dependencies[record.key] ?? [])].sort().filter((dependency) => dependency !== record.key)),
    });
  }).sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));

  const relationships = [];
  for (const pkg of packages) {
    for (const dependency of pkg.dependencies) {
      if (dependency !== pkg.key) relationships.push(Object.freeze({ kind: 'DEPENDS_ON', from: pkg.spdxId, to: dependency }));
    }
  }

  const document = {
    format: SBOM_FORMAT,
    documentId: documentId ?? `urn:lego-sbom:${epoch.epochNumber}:${epoch.epochDigest.slice(0, 16)}`,
    registryEpochNumber: epoch.epochNumber,
    registryEpochDigest: epoch.epochDigest,
    registryEpochSource: epoch.source,
    dependenciesDeclared: Object.keys(dependencies).length > 0,
    packages,
    relationships: Object.freeze(relationships),
    vulnerabilities: Object.freeze([]),
    tickets: Object.freeze([...tickets]),
  };
  return deepFreeze({
    ok: true,
    schemaVersion: SBOM_SCHEMA_VERSION,
    contract: SBOM_CONTRACT,
    ...document,
    packageCount: packages.length,
    identityCount: epoch.identities.length,
    sbomDigest: digestOf(stableJson({ ...document, packages: packages.map((pkg) => [pkg.key, pkg.checksums, pkg.trustClasses, pkg.capabilities, pkg.identities]) })),
  });
}

/** @returns {boolean} whether `value` is a document this contract produced. */
export function isSbom(value) {
  return (
    isPlainObject(value) &&
    value.ok === true &&
    value.contract === SBOM_CONTRACT &&
    value.format === SBOM_FORMAT &&
    Array.isArray(value.packages) &&
    typeof value.sbomDigest === 'string' &&
    Object.isFrozen(value)
  );
}

const requireSbom = (sbom, fn) => {
  if (!isSbom(sbom)) fail(`${fn} expects a document from createSbom`, { got: typeof sbom });
};

/** One package of a document, by key (`name@version`). */
export function sbomPackageOf(sbom, key) {
  requireSbom(sbom, 'sbomPackageOf');
  if (!isNonEmptyString(key)) fail('sbomPackageOf expects a package key', { code: 'sbom.input', field: 'key' });
  return sbom.packages.find((pkg) => pkg.key === key) ?? null;
}

/* ------------------------------------------------------------------ *
 * Diffing
 * ------------------------------------------------------------------ */

const CHANGED_FIELDS = Object.freeze(['checksums', 'trustClasses', 'capabilities', 'license', 'identities', 'supplier']);

/** The weakest trust class in a set governs: a chain is as strong as its weakest link. */
const weakestRank = (classes) => Math.min(...classes.map((trustClass) => trustRankOf(trustClass)));

/** What changed between two documents, field by field. */
export function diffSbom(before, after) {
  requireSbom(before, 'diffSbom');
  requireSbom(after, 'diffSbom');
  const beforeByKey = Object.fromEntries(before.packages.map((pkg) => [pkg.key, pkg]));
  const afterByKey = Object.fromEntries(after.packages.map((pkg) => [pkg.key, pkg]));
  const keys = [...new Set([...Object.keys(beforeByKey), ...Object.keys(afterByKey)])].sort();

  const added = [];
  const removed = [];
  const changed = [];
  const unchanged = [];
  for (const key of keys) {
    const left = beforeByKey[key];
    const right = afterByKey[key];
    if (!left) { added.push(key); continue; }
    if (!right) { removed.push(key); continue; }
    const fields = CHANGED_FIELDS.filter((field) => stableJson(left[field]) !== stableJson(right[field]));
    if (fields.length === 0) { unchanged.push(key); continue; }
    changed.push(Object.freeze({
      key,
      fields: Object.freeze(fields),
      before: Object.freeze(Object.fromEntries(fields.map((field) => [field, left[field]]))),
      after: Object.freeze(Object.fromEntries(fields.map((field) => [field, right[field]]))),
      trustDirection: fields.includes('trustClasses')
        ? (() => {
          const before = weakestRank(left.trustClasses);
          const after = weakestRank(right.trustClasses);
          return after === before ? 'unchanged' : (after > before ? 'upgraded' : 'downgraded');
        })()
        : null,
      capabilityDelta: fields.includes('capabilities')
        ? Object.freeze({
          added: Object.freeze(right.capabilities.filter((capability) => !left.capabilities.includes(capability))),
          removed: Object.freeze(left.capabilities.filter((capability) => !right.capabilities.includes(capability))),
        })
        : null,
    }));
  }
  const payload = {
    before: before.sbomDigest,
    after: after.sbomDigest,
    added,
    removed,
    changed: changed.map((entry) => [entry.key, entry.fields]),
  };
  return deepFreeze({
    ok: true,
    schemaVersion: SBOM_SCHEMA_VERSION,
    contract: SBOM_CONTRACT,
    beforeDigest: before.sbomDigest,
    afterDigest: after.sbomDigest,
    changeCount: added.length + removed.length + changed.length,
    added: Object.freeze(added),
    removed: Object.freeze(removed),
    changed: Object.freeze(changed),
    unchanged: Object.freeze(unchanged),
    diffDigest: digestOf(stableJson(payload)),
    message: null,
  });
}

/** @returns {boolean} whether `value` is a diff this contract produced. */
export function isSbomDiff(value) {
  return isPlainObject(value) && value.contract === SBOM_CONTRACT && Array.isArray(value.added) && typeof value.diffDigest === 'string' && Object.isFrozen(value);
}

/** A sentence a reviewer can act on. */
export function explainDiff(diff) {
  if (!isSbomDiff(diff)) fail('explainDiff expects a diff from diffSbom', { got: typeof diff });
  if (diff.changeCount === 0) return `nothing changed: ${diff.unchanged.length} package(s) identical, digest ${diff.afterDigest.slice(0, 18)}…`;
  const parts = [
    `${diff.added.length} added${diff.added.length ? ` (${diff.added.join(', ')})` : ''}`,
    `${diff.removed.length} removed${diff.removed.length ? ` (${diff.removed.join(', ')})` : ''}`,
    `${diff.changed.length} changed${diff.changed.length ? ` (${diff.changed.map((entry) => `${entry.key}: ${entry.fields.join('+')}`).join('; ')})` : ''}`,
  ];
  return `${parts.join(', ')}; ${diff.unchanged.length} unchanged`;
}

/* ------------------------------------------------------------------ *
 * VEX
 * ------------------------------------------------------------------ */

/** One statement: who says what about which package, with a justification. */
export function vexStatement({ packageKey, vulnerability, status, justification = null, assertedBy, tick, detail = null } = {}) {
  if (!isNonEmptyString(packageKey)) fail('a VEX statement must name the package it is about', { code: 'sbom.vex', field: 'packageKey' });
  if (!isNonEmptyString(vulnerability)) fail('a VEX statement must name the vulnerability', { code: 'sbom.vex', field: 'vulnerability' });
  if (!VEX_STATUSES.includes(status)) fail(`unknown VEX status ${JSON.stringify(status)} — expected one of ${VEX_STATUSES.join(', ')}`, { code: 'sbom.vex', field: 'status' });
  if (justification !== null && !VEX_JUSTIFICATIONS.includes(justification)) {
    fail(`unknown justification ${JSON.stringify(justification)} — expected one of ${VEX_JUSTIFICATIONS.join(', ')}`, { code: 'sbom.vex', field: 'justification' });
  }
  if (!isNonEmptyString(assertedBy)) fail('a VEX statement must name who asserts it: an unattributed status is a rumour', { code: 'sbom.vex', field: 'assertedBy' });
  if (!Number.isInteger(tick) || tick < 0) fail('a VEX statement is asserted at a tick, and the tick is data', { code: 'sbom.vex', field: 'tick' });
  if (status === 'not_affected' && justification === null) {
    fail("a 'not_affected' statement needs a justification: \"we looked and it is fine\" is not a justification", { code: 'sbom.vex', field: 'justification' });
  }
  return deepFreeze({
    ok: true,
    schemaVersion: SBOM_SCHEMA_VERSION,
    contract: SBOM_CONTRACT,
    packageKey,
    vulnerability,
    status,
    justification,
    assertedBy,
    tick,
    detail,
    statementDigest: digestOf(stableJson({ packageKey, vulnerability, status, justification, assertedBy, tick, detail })),
  });
}

/** A set of statements, one per (package, vulnerability). */
export function createVex(statements = []) {
  if (!Array.isArray(statements)) fail('createVex expects an array of statements', { code: 'sbom.input', field: 'statements' });
  const seen = new Map();
  for (const statement of statements) {
    if (!isPlainObject(statement) || statement.contract !== SBOM_CONTRACT || typeof statement.statementDigest !== 'string') {
      fail('every VEX statement must come from vexStatement', { code: 'sbom.vex', field: 'statements' });
    }
    const key = `${statement.packageKey}::${statement.vulnerability}`;
    const existing = seen.get(key);
    if (existing) {
      if (existing.status === statement.status && existing.justification === statement.justification) continue;
      fail(`two statements disagree about ${statement.vulnerability} in ${statement.packageKey} (${existing.status} vs ${statement.status}): a disagreement about a vulnerability is resolved by a person, not by ordering`, { code: 'sbom.vex', field: 'statements' });
    }
    seen.set(key, statement);
  }
  const ordered = [...seen.values()].sort((left, right) => (left.packageKey === right.packageKey ? (left.vulnerability < right.vulnerability ? -1 : 1) : (left.packageKey < right.packageKey ? -1 : 1)));
  return deepFreeze({
    ok: true,
    schemaVersion: SBOM_SCHEMA_VERSION,
    contract: SBOM_CONTRACT,
    statements: Object.freeze(ordered.map((statement) => Object.freeze({ ...statement }))),
    count: ordered.length,
    vexDigest: digestOf(stableJson(ordered.map((statement) => [statement.packageKey, statement.vulnerability, statement.status, statement.justification, statement.assertedBy, statement.tick]))),
  });
}

/** @returns {boolean} whether `value` is a VEX set this contract produced. */
export function isVex(value) {
  return isPlainObject(value) && value.ok === true && value.contract === SBOM_CONTRACT && Array.isArray(value.statements) && typeof value.vexDigest === 'string' && Object.isFrozen(value);
}

/**
 * Attach the statements to a document's packages. Silence is `under_investigation`:
 * a package nobody spoke about is not a package that is fine.
 */
export function applyVex(sbom, vex) {
  requireSbom(sbom, 'applyVex');
  if (!isVex(vex)) fail('applyVex expects a VEX set from createVex', { code: 'sbom.vex', field: 'vex' });
  const byPackage = {};
  for (const statement of vex.statements) {
    byPackage[statement.packageKey] = [...(byPackage[statement.packageKey] ?? []), statement];
  }
  const packages = sbom.packages.map((pkg) => {
    const statements = byPackage[pkg.key] ?? [];
    const statuses = statements.map((statement) => statement.status);
    const worst = ['affected', 'under_investigation', 'fixed', 'not_affected'].find((candidate) => statuses.includes(candidate));
    return Object.freeze({
      ...pkg,
      vulnerabilityStatus: statements.length === 0 ? 'under_investigation' : worst,
      statements: Object.freeze(statements.map((statement) => Object.freeze({ ...statement }))),
    });
  });
  return deepFreeze({ ...sbom, packages: Object.freeze(packages), vex: vex, vexDigest: vex.vexDigest, annulledDigest: sbom.sbomDigest });
}

/** Counts per status — the shape a review opens with. */
export function summarizeVex(vex) {
  if (!isVex(vex)) fail('summarizeVex expects a VEX set from createVex', { code: 'sbom.vex', field: 'vex' });
  const byStatus = {};
  for (const statement of vex.statements) byStatus[statement.status] = (byStatus[statement.status] ?? 0) + 1;
  return deepFreeze({
    count: vex.count,
    byStatus: Object.freeze(byStatus),
    vulnerabilities: Object.freeze([...new Set(vex.statements.map((statement) => statement.vulnerability))].sort()),
    assertedBy: Object.freeze([...new Set(vex.statements.map((statement) => statement.assertedBy))].sort()),
    vexDigest: vex.vexDigest,
  });
}

/* ------------------------------------------------------------------ *
 * The gate
 * ------------------------------------------------------------------ */

/** A policy: rules as data, each with an id and a kind. */
export function createPolicyGate({ policyId, rules = [] } = {}) {
  if (!isNonEmptyString(policyId)) fail('a policy must name itself: an anonymous policy cannot be cited when a change is questioned', { code: 'sbom.rule', field: 'policyId' });
  if (!Array.isArray(rules) || rules.length === 0) fail('a policy with no rules is not a policy, it is a decision nobody wrote down', { code: 'sbom.rule', field: 'rules' });
  const normalized = rules.map((rule) => {
    if (!isPlainObject(rule) || !isNonEmptyString(rule.id)) fail('every rule needs an id', { code: 'sbom.rule', field: 'rules' });
    if (!GATE_RULE_KINDS.includes(rule.kind)) fail(`unknown rule kind ${JSON.stringify(rule.kind)} — expected one of ${GATE_RULE_KINDS.join(', ')}`, { code: 'sbom.rule', field: 'kind' });
    if (rule.kind === 'max-added-packages' && (!Number.isInteger(rule.limit) || rule.limit < 0)) {
      fail("a 'max-added-packages' rule needs a non-negative integer limit", { code: 'sbom.rule', field: 'limit' });
    }
    return Object.freeze({ id: rule.id, kind: rule.kind, limit: rule.limit ?? null, note: rule.note ?? null });
  });
  const ids = normalized.map((rule) => rule.id);
  if (new Set(ids).size !== ids.length) fail('two rules share one id: a decision with two names is a decision nobody can cite', { code: 'sbom.rule', field: 'rules' });
  return deepFreeze({ ok: true, schemaVersion: SBOM_SCHEMA_VERSION, contract: SBOM_CONTRACT, policyId, rules: Object.freeze(normalized), ruleCount: normalized.length });
}

/** @returns {boolean} whether `value` is a policy this contract produced. */
export function isPolicyGate(value) {
  return isPlainObject(value) && value.ok === true && value.contract === SBOM_CONTRACT && Array.isArray(value.rules) && isNonEmptyString(value.policyId) && Object.isFrozen(value);
}

const evaluateRule = (rule, { diff, before, after, vex = null }) => {
  const outcome = (result, evidence) => Object.freeze({ rule: rule.id, kind: rule.kind, outcome: result, evidence });
  switch (rule.kind) {
    case 'no-new-packages':
      return diff.added.length === 0
        ? outcome('pass', 'no package was added')
        : outcome('fail', `added ${diff.added.join(', ')}`);
    case 'no-removals':
      return diff.removed.length === 0
        ? outcome('pass', 'no package was removed')
        : outcome('fail', `removed ${diff.removed.join(', ')}`);
    case 'no-new-capabilities': {
      const grew = diff.changed.filter((entry) => entry.capabilityDelta && entry.capabilityDelta.added.length > 0);
      return grew.length === 0
        ? outcome('pass', 'no package asks for a capability it did not ask for before')
        : outcome('fail', grew.map((entry) => `${entry.key} gains ${entry.capabilityDelta.added.join('+')}`).join('; '));
    }
    case 'no-trust-downgrade': {
      const downgrades = diff.changed.filter((entry) => entry.trustDirection === 'downgraded');
      return downgrades.length === 0
        ? outcome('pass', 'no package decreased in trust class')
        : outcome('fail', downgrades.map((entry) => `${entry.key}: ${entry.before.trustClasses.join('/')} → ${entry.after.trustClasses.join('/')}`).join('; '));
    }
    case 'max-added-packages':
      return diff.added.length <= rule.limit
        ? outcome('pass', `${diff.added.length} added, ceiling ${rule.limit}`)
        : outcome('fail', `${diff.added.length} added, past the ceiling of ${rule.limit}`);
    case 'no-affected-vulnerability': {
      if (vex === null) return outcome('incomplete', 'no VEX was supplied: a gate that opens because it could not look is not a gate');
      const affected = [...new Set(vex.statements.filter((statement) => statement.status === 'affected' || statement.status === 'under_investigation').map((statement) => `${statement.packageKey} (${statement.vulnerability}, ${statement.status})`))];
      return affected.length === 0
        ? outcome('pass', 'every vulnerability mentioned is fixed or not applicable')
        : outcome('fail', affected.join('; '));
    }
    default:
      return outcome('incomplete', `no evaluator for rule kind '${rule.kind}': an unevaluated rule is not a satisfied one`);
  }
};

/**
 * Evaluate a diff against a policy.
 *
 * @param {{ diff: object, policy: object, before?: object, after?: object, vex?: object }} input
 */
export function evaluateGate({ diff, policy, before = null, after = null, vex = null } = {}) {
  if (!isSbomDiff(diff)) fail('evaluateGate expects a diff from diffSbom', { code: 'sbom.diff', field: 'diff' });
  if (!isPolicyGate(policy)) fail('evaluateGate expects a policy from createPolicyGate', { code: 'sbom.rule', field: 'policy' });
  if (vex !== null && !isVex(vex)) fail('the VEX must come from createVex', { code: 'sbom.vex', field: 'vex' });
  const decisions = Object.freeze(policy.rules.map((rule) => evaluateRule(rule, { diff, before, after, vex })));
  const failed = decisions.filter((decision) => decision.outcome === 'fail');
  const incomplete = decisions.filter((decision) => decision.outcome === 'incomplete');
  const verdict = failed.length > 0 ? 'deny' : (incomplete.length > 0 ? 'incomplete' : 'allow');
  return deepFreeze({
    ok: verdict === 'allow',
    schemaVersion: SBOM_SCHEMA_VERSION,
    contract: SBOM_CONTRACT,
    policyId: policy.policyId,
    verdict,
    decisions,
    failed: Object.freeze(failed.map((decision) => decision.rule)),
    incomplete: Object.freeze(incomplete.map((decision) => decision.rule)),
    diffDigest: diff.diffDigest,
    gateDigest: digestOf(stableJson({ policy: policy.policyId, rules: policy.rules.map((rule) => [rule.id, rule.kind, rule.limit]), verdict, decisions: decisions.map((decision) => [decision.rule, decision.outcome]) })),
    message: verdict === 'allow'
      ? null
      : (verdict === 'deny'
        ? `denied by ${failed.map((decision) => decision.rule).join(', ')}`
        : `incomplete: ${incomplete.map((decision) => `${decision.rule} (${decision.evidence})`).join(', ')}`),
  });
}

/** @returns {boolean} whether `value` is a gate result this contract produced. */
export function isGateResult(value) {
  return isPlainObject(value) && value.contract === SBOM_CONTRACT && GATE_VERDICTS.includes(value.verdict) && Array.isArray(value.decisions) && Object.isFrozen(value);
}

/** A sentence an operator reads before signing off a change. */
export function explainGate(result) {
  if (!isGateResult(result)) fail('explainGate expects a result from evaluateGate', { got: typeof result });
  if (result.verdict === 'allow') return `policy '${result.policyId}' allows this diff: ${result.decisions.length} rule(s) evaluated, ${result.decisions.length} passed`;
  if (result.verdict === 'deny') return `policy '${result.policyId}' DENIES this diff: ${result.decisions.filter((decision) => decision.outcome === 'fail').map((decision) => `${decision.rule} — ${decision.evidence}`).join('; ')}`;
  return `policy '${result.policyId}' is INCOMPLETE: ${result.decisions.filter((decision) => decision.outcome === 'incomplete').map((decision) => `${decision.rule} — ${decision.evidence}`).join('; ')}`;
}

/** Counts and digests — the shape an operations page wants. */
export function describeSbom(sbom) {
  requireSbom(sbom, 'describeSbom');
  return deepFreeze({
    format: sbom.format,
    documentId: sbom.documentId,
    epochNumber: sbom.registryEpochNumber,
    epochDigest: sbom.registryEpochDigest,
    packageCount: sbom.packageCount,
    identityCount: sbom.identityCount,
    sbomDigest: sbom.sbomDigest,
    trustClasses: Object.freeze([...new Set(sbom.packages.flatMap((pkg) => pkg.trustClasses))].sort()),
    capabilities: Object.freeze([...new Set(sbom.packages.flatMap((pkg) => pkg.capabilities))].sort()),
    packages: Object.freeze(sbom.packages.map((pkg) => `${pkg.key} (${pkg.trustClasses.join(',')})`)),
  });
}

export const SBOM_INPUT_SCHEMA_VERSION = SBOM_SCHEMA_VERSION;
export { NODE_TRUST_CLASSES };
