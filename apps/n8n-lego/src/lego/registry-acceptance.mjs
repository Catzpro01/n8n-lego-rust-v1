/**
 * registry.acceptance@0.1.0 — the acceptance of a milestone: criteria, evidence and who verified.
 *
 * P6 milestone 31 of 31 (Issue #100). This is the last contract of the lane, and it is deliberately
 * the least powerful one: it composes the verdicts of every other contract AS DATA, and it never
 * imports, re-runs or overrules any of them. What it decides is whether a milestone's evidence adds
 * up — and its answer is allowed to be "not proven".
 *
 * What it adds:
 *
 *  - A CRITERION IS A CLAIM WITH A VERDICT, A KIND, A SUBJECT AND EVIDENCE. The kinds are the ones
 *    the lane promised per slice — focused, negative, boundary, determinism, security, resource,
 *    rollback, docs, evidence — and a milestone that has no negative criterion has not been tested,
 *    only exercised.
 *  - A PASS WITH NOTHING TO POINT AT IS AN OPINION. `pass` and `fail` both require an evidence
 *    digest; `incomplete` is the verdict for the absence of evidence, and that is what it is for.
 *  - NOT APPLICABLE IS A CLAIM ABOUT THE SUBJECT, so it has to say why; and a kind covered only by
 *    `not-applicable` criteria is not covered.
 *  - AN OMISSION IS NOT A SMALLER MILESTONE. A missing slice, a missing kind, a criterion whose
 *    commit is another commit, and a criterion about a slice the acceptance does not cover are all
 *    findings, and findings make the verdict `incomplete` rather than quietly passing.
 *  - THE WEAKEST VERDICT GOVERNS: a failure is a fact and an incomplete is an absence, and a
 *    milestone reporting both is rejected.
 *  - A LANE CANNOT ACCEPT ITSELF, and a milestone is accepted on the integration rather than on the
 *    branch: `verifiedBy` must differ from `implementedBy`, and protected-main verification has to
 *    have been reported. Neither is optional, and neither can be assumed.
 *
 * Scope walls (enforced by tests): it does not run acceptance (P6.15 owns the slice-level runner),
 * it does not decide trust (P6.1), admission (P6.17), epochs (P6.16) or repair (P6.30), and it
 * imports no other module of this repository. No filesystem, network, clock or randomness; the only
 * `node:` import is the hash.
 *
 * Authority: this contract decides whether the evidence for a milestone adds up. It does not merge,
 * it does not declare the lane integrated, and it cannot make a failing criterion pass.
 */
import { createHash } from 'node:crypto';

export const REGISTRY_ACCEPTANCE_CONTRACT = 'registry.acceptance@0.1.0';
export const REGISTRY_ACCEPTANCE_CONTRACT_VERSION = '0.1.0';
export const REGISTRY_ACCEPTANCE_SCHEMA_VERSION = 1;
export const REGISTRY_ACCEPTANCE_FORMAT = 'lego-acceptance@1';

export const ACCEPTANCE_OPERATIONS = Object.freeze(['declare', 'criterion', 'assess', 'describe', 'explain']);
export const ACCEPTANCE_PERMISSIONS = Object.freeze(['node:read']);

/** What a milestone can be. `incomplete` is not a failure — it is an absence, and it is not a pass. */
export const ACCEPTANCE_VERDICTS = Object.freeze(['accepted', 'rejected', 'incomplete']);

export const CRITERION_VERDICTS = Object.freeze(['pass', 'fail', 'incomplete', 'not-applicable']);

/** The kinds every milestone promised, per slice. */
export const CRITERION_KINDS = Object.freeze(['focused', 'negative', 'boundary', 'determinism', 'security', 'resource', 'rollback', 'docs', 'evidence']);

export const ACCEPTANCE_REASONS = Object.freeze([
  'acceptance.input', 'acceptance.criterion', 'acceptance.evidence', 'acceptance.slice',
  'acceptance.kind', 'acceptance.subject', 'acceptance.self', 'acceptance.protected', 'acceptance.na',
]);

export const ACCEPTANCE_RULES = Object.freeze({
  compose: 'the verdicts of the other contracts are composed as data: this contract never imports, re-runs or overrules them',
  evidence: 'a pass with nothing to point at is an opinion, so pass and fail both require an evidence digest',
  incomplete: 'an incomplete is the verdict for the absence of evidence, and absence is never a pass',
  omission: 'an omission is not a smaller milestone: a missing slice, a missing kind and a stale commit are findings, and a criterion checked on another commit covers nothing here',
  kinds: 'a milestone with no negative criterion has not been tested, only exercised',
  na: 'not applicable is a claim about the subject, so it has to say why, and a kind covered only by not-applicable criteria is not covered',
  weakest: 'a failure is a fact and an incomplete is an absence, and the weaker one is what gets reported',
  self: 'a lane cannot accept itself, and a milestone is accepted on the integration rather than on the branch',
  authority: 'this contract decides whether the evidence adds up; it does not merge and cannot make a failing criterion pass',
});

export class AcceptanceError extends Error {
  constructor(message, { code = 'acceptance.input', meta = {} } = {}) {
    super(message);
    this.name = 'AcceptanceError';
    this.code = 'lego.contract_violation';
    this.meta = { code, ...meta };
  }
}

const fail = (message, detail = {}) => { throw new AcceptanceError(message, detail); };

const isNonEmptyString = (value) => typeof value === 'string' && value.length > 0;

/** Canonical JSON: key order must not change a digest. */
export function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

export function acceptanceDigest(fields) {
  return sha256(stableJson(fields ?? {}));
}

const bareDigest = (digest) => String(digest).replace(/^sha256:/, '');
const isDigest = (value) => isNonEmptyString(value) && /^[0-9a-f]{64}$/.test(bareDigest(value));

/* ---------------------------------------------------------------- the subject */

export function isAcceptanceSubject(value) {
  return Boolean(value) && typeof value === 'object' && value.contract === REGISTRY_ACCEPTANCE_CONTRACT && isNonEmptyString(value.commit) && Array.isArray(value.slices) && isNonEmptyString(value.subjectDigest);
}

/**
 * What is being accepted, by whom, and against what integration. The verifier is named because the
 * implementer cannot be it, and protected-main is stated because a branch result is not one.
 */
export function createAcceptanceSubject({ commit, slices, implementedBy, verifiedBy, protectedMain = false } = {}) {
  if (!isNonEmptyString(commit)) fail('an acceptance names the commit it is about', { code: 'acceptance.input', field: 'commit' });
  if (!Array.isArray(slices) || slices.length === 0) {
    fail('an acceptance names the slices it covers: an acceptance over nothing covers nothing', { code: 'acceptance.slice', field: 'slices' });
  }
  for (const slice of slices) {
    if (!isNonEmptyString(slice)) fail('a slice is named', { code: 'acceptance.slice', field: 'slices' });
  }
  if (new Set(slices).size !== slices.length) fail('the same slice is named twice', { code: 'acceptance.slice', field: 'slices' });
  if (!isNonEmptyString(implementedBy)) fail('an acceptance names who implemented it', { code: 'acceptance.input', field: 'implementedBy' });
  if (!isNonEmptyString(verifiedBy)) fail('an acceptance names who verified it', { code: 'acceptance.input', field: 'verifiedBy' });
  if (implementedBy === verifiedBy) {
    fail(`'${implementedBy}' implemented this and '${implementedBy}' is verifying it: a lane cannot accept itself`, { code: 'acceptance.self', field: 'verifiedBy' });
  }
  if (typeof protectedMain !== 'boolean') fail('protectedMain is stated as a boolean, and it is false until it is reported', { code: 'acceptance.input', field: 'protectedMain' });
  const body = {
    contract: REGISTRY_ACCEPTANCE_CONTRACT,
    schemaVersion: REGISTRY_ACCEPTANCE_SCHEMA_VERSION,
    commit,
    slices: Object.freeze([...slices].sort()),
    implementedBy,
    verifiedBy,
    protectedMain,
  };
  return Object.freeze({ ...body, subjectDigest: acceptanceDigest(body) });
}

/* ------------------------------------------------------------- the criterion */

export function isCriterion(value) {
  return Boolean(value) && typeof value === 'object' && value.contract === REGISTRY_ACCEPTANCE_CONTRACT && isNonEmptyString(value.id) && isNonEmptyString(value.criterionDigest);
}

/**
 * One criterion: a kind, a slice, the commit it was checked on, a verdict, and (for a verdict that
 * claims a fact) something to point at.
 */
export function createCriterion({ id, kind, slice, commit, verdict, evidenceDigest = null, justification = null } = {}) {
  if (!isNonEmptyString(id)) fail('a criterion has an id', { code: 'acceptance.criterion', field: 'id' });
  if (!CRITERION_KINDS.includes(kind)) {
    fail(`criterion kind '${String(kind)}' is one of ${CRITERION_KINDS.join(', ')}: a criterion outside the promised kinds is a claim nothing asked for`, { code: 'acceptance.criterion', field: 'kind' });
  }
  if (!CRITERION_VERDICTS.includes(verdict)) {
    fail(`criterion verdict '${String(verdict)}' is one of ${CRITERION_VERDICTS.join(', ')}`, { code: 'acceptance.criterion', field: 'verdict' });
  }
  if (!isNonEmptyString(slice)) fail('a criterion names the slice it belongs to', { code: 'acceptance.criterion', field: 'slice' });
  if (!isNonEmptyString(commit)) fail('a criterion names the commit it was checked on', { code: 'acceptance.criterion', field: 'commit' });
  if (evidenceDigest !== null && !isDigest(evidenceDigest)) {
    fail(`criterion '${id}' points at '${String(evidenceDigest)}', which is not a digest: evidence has to be something that can be found again`, { code: 'acceptance.evidence', field: 'evidenceDigest' });
  }
  if (evidenceDigest === null && (verdict === 'pass' || verdict === 'fail')) {
    fail(`criterion '${id}' is '${verdict}' with nothing to point at: a criterion without evidence is an opinion with a verdict attached`, { code: 'acceptance.evidence', field: 'evidenceDigest' });
  }
  if (verdict === 'not-applicable' && !isNonEmptyString(justification)) {
    fail(`criterion '${id}' is not-applicable without saying why: not applicable is a claim about the subject`, { code: 'acceptance.na', field: 'justification' });
  }
  if (justification !== null && !isNonEmptyString(justification)) fail(`criterion '${id}' has an empty justification`, { code: 'acceptance.input', field: 'justification' });

  const body = {
    contract: REGISTRY_ACCEPTANCE_CONTRACT,
    schemaVersion: REGISTRY_ACCEPTANCE_SCHEMA_VERSION,
    id,
    kind,
    slice,
    commit,
    verdict,
    evidenceDigest: evidenceDigest === null ? null : bareDigest(evidenceDigest),
    justification: justification ?? null,
  };
  return Object.freeze({ ...body, criterionDigest: acceptanceDigest(body) });
}

/* ---------------------------------------------------------------- assessment */

/**
 * The one decision: does the evidence add up? Findings are collected rather than short-circuited,
 * because a milestone that fails three ways should say three things.
 */
export function assessAcceptance({ subject, criteria, policy = {} } = {}) {
  if (!isAcceptanceSubject(subject)) fail('assessAcceptance reads a subject made by createAcceptanceSubject', { code: 'acceptance.input', field: 'subject' });
  if (!Array.isArray(criteria) || criteria.length === 0) {
    fail('an acceptance reads at least one criterion: an acceptance with no criteria is an assertion', { code: 'acceptance.criterion', field: 'criteria' });
  }
  if (policy === null || typeof policy !== 'object' || Array.isArray(policy)) fail('policy is a map', { code: 'acceptance.input', field: 'policy' });
  const requireAllKinds = policy.requireAllKinds ?? true;
  if (typeof requireAllKinds !== 'boolean') fail('requireAllKinds is a boolean', { code: 'acceptance.input', field: 'policy.requireAllKinds' });

  const seen = new Set();
  for (const criterion of criteria) {
    if (!isCriterion(criterion)) fail('every criterion was made by createCriterion', { code: 'acceptance.input', field: 'criteria' });
    if (seen.has(criterion.id)) fail(`the same criterion id '${criterion.id}' appears twice: two verdicts under one name is not evidence`, { code: 'acceptance.criterion', field: 'criteria' });
    seen.add(criterion.id);
  }

  // A criterion checked on another commit is evidence about another commit: it covers nothing here.
  const coveredSlices = new Set(criteria.filter((criterion) => criterion.commit === subject.commit).map((criterion) => criterion.slice));
  const missingSlices = subject.slices.filter((slice) => !coveredSlices.has(slice));
  const unknownSlices = [...new Set(criteria.map((criterion) => criterion.slice).filter((slice) => !subject.slices.includes(slice)))].sort();
  const stale = criteria.filter((criterion) => criterion.commit !== subject.commit).map((criterion) => criterion.id).sort();
  const failures = criteria.filter((criterion) => criterion.verdict === 'fail').map((criterion) => criterion.id).sort();
  const incompletes = criteria.filter((criterion) => criterion.verdict === 'incomplete').map((criterion) => criterion.id).sort();
  const na = criteria.filter((criterion) => criterion.verdict === 'not-applicable').map((criterion) => criterion.id).sort();
  const coveredKinds = new Set(criteria.filter((criterion) => criterion.verdict !== 'not-applicable').map((criterion) => criterion.kind));
  const missingKinds = requireAllKinds ? CRITERION_KINDS.filter((kind) => !coveredKinds.has(kind)) : [];

  const protectedMissing = subject.protectedMain !== true;
  const findings = Object.freeze([
    ...(missingSlices.length > 0 ? [`${missingSlices.length} slice(s) have no criterion: ${missingSlices.join(', ')}`] : []),
    ...(unknownSlices.length > 0 ? [`${unknownSlices.length} criterion(s) are about slices this acceptance does not cover: ${unknownSlices.join(', ')}`] : []),
    ...(stale.length > 0 ? [`${stale.length} criterion(s) were checked on another commit: ${stale.join(', ')}`] : []),
    ...(missingKinds.length > 0 ? [`${missingKinds.length} promised kind(s) are not covered by a verdict: ${missingKinds.join(', ')}`] : []),
    ...(incompletes.length > 0 ? [`${incompletes.length} criterion(s) are incomplete: ${incompletes.join(', ')}`] : []),
    ...(protectedMissing ? ['protected-main verification has not been reported'] : []),
  ]);

  const verdict = failures.length > 0
    ? 'rejected'
    : (findings.length > 0 ? 'incomplete' : 'accepted');
  const reason = failures.length > 0 ? 'acceptance.criterion'
    : stale.length > 0 || unknownSlices.length > 0 ? 'acceptance.subject'
      : missingSlices.length > 0 ? 'acceptance.slice'
        : missingKinds.length > 0 ? 'acceptance.kind'
          : protectedMissing ? 'acceptance.protected'
            : incompletes.length > 0 ? 'acceptance.evidence'
              : null;

  const counts = Object.freeze({
    criteria: criteria.length,
    passed: criteria.filter((criterion) => criterion.verdict === 'pass').length,
    failed: failures.length,
    incomplete: incompletes.length,
    notApplicable: na.length,
    slices: subject.slices.length,
    slicesCovered: subject.slices.length - missingSlices.length,
  });
  const body = {
    contract: REGISTRY_ACCEPTANCE_CONTRACT,
    schemaVersion: REGISTRY_ACCEPTANCE_SCHEMA_VERSION,
    commit: subject.commit,
    subject: subject.subjectDigest,
    verdict,
    counts,
    missingSlices: Object.freeze(missingSlices),
    unknownSlices: Object.freeze(unknownSlices),
    missingKinds: Object.freeze(missingKinds),
    stale: Object.freeze(stale),
    failures: Object.freeze(failures),
    incompletes: Object.freeze(incompletes),
    notApplicable: Object.freeze(na),
    protectedMain: subject.protectedMain,
    findings,
  };
  const message = verdict === 'accepted'
    ? `acceptance for commit ${subject.commit} is accepted: ${counts.passed} criterion(s) over ${counts.slices} slice(s), verified by ${subject.verifiedBy} and not by ${subject.implementedBy}, with protected-main verification reported`
    : verdict === 'rejected'
      ? `acceptance for commit ${subject.commit} is rejected: ${failures.join(', ')} failed${findings.length > 0 ? `, and ${findings.join('; ')}` : ''}`
      : `acceptance for commit ${subject.commit} is incomplete: ${findings.join('; ')}`;
  return Object.freeze({ ok: verdict === 'accepted', ...body, reason, message, acceptanceDigest: acceptanceDigest(body) });
}

/* -------------------------------------------------------------------- reads */

export function describeAcceptance(report) {
  if (!report || typeof report !== 'object' || !ACCEPTANCE_VERDICTS.includes(report.verdict) || !isNonEmptyString(report.acceptanceDigest)) {
    fail('describeAcceptance reads a report made by assessAcceptance', { code: 'acceptance.input', field: 'report' });
  }
  const body = {
    contract: REGISTRY_ACCEPTANCE_CONTRACT,
    format: REGISTRY_ACCEPTANCE_FORMAT,
    commit: report.commit,
    verdict: report.verdict,
    counts: report.counts,
    findings: report.findings,
    protectedMain: report.protectedMain,
  };
  return Object.freeze({
    ...body,
    message: `${report.verdict.toUpperCase()}: ${report.counts.passed}/${report.counts.criteria} criterion(s) passed over ${report.counts.slicesCovered}/${report.counts.slices} slice(s) at commit ${report.commit}${report.findings.length > 0 ? `, with ${report.findings.length} finding(s)` : ''}`,
    acceptanceDigest: report.acceptanceDigest,
  });
}

export function explainAcceptance(report) {
  if (!report || typeof report !== 'object' || !ACCEPTANCE_VERDICTS.includes(report.verdict) || !isNonEmptyString(report.message)) {
    fail('explainAcceptance reads a report made by assessAcceptance', { code: 'acceptance.input', field: 'report' });
  }
  return `${report.verdict.toUpperCase()} — ${report.message}`;
}
