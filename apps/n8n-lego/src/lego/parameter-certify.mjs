/**
 * P7-S08 — Differential Certification (#223 §37-38, §40-41, §42 P7.8).
 *
 * The certification slice: it makes P7's correctness a REPEATABLE, DETERMINISTIC RECORD by
 * (a) comparing P7 output against pinned n8n behavior (the differential oracle, §40) and
 * classifying every difference; (b) pinning the 20-case mandatory negative/security matrix
 * (§41); and (c) enforcing the low-resource performance target (§37-38).
 *
 * P7 never hardcodes vendor internals: the oracle is an explicit, injectable, pinned reference
 * (the pinned n8n-workflow 2.9.1 behavior). A certification is a record — deterministic,
 * reproducible, tied to the pinned version — not a one-off boolean hand-wave.
 *
 * Deterministic and testable; it reuses the same-domain `canonicalJson` (P7-S01) and, for the
 * negative matrix, the failure vocabularies the P7 stages already emit (P7-S03/S04/S05/S06).
 */
import { canonicalJson } from './parameter-plan.mjs';

export const CERTIFICATION_FORMAT = 'n8n-lego.differential-certification';
export const CERTIFICATION_FORMAT_VERSION = 1;

/** §40 — the pinned n8n version the differential oracle compares against. */
export const PINNED_N8N_VERSION = '2.9.1';

/** §40 — the twelve differential aspects P7 must compare against pinned n8n behavior. */
export const DIFFERENTIAL_ASPECTS = Object.freeze([
  'parameter-visibility', 'defaults', 'options', 'dynamic-options',
  'dependent-fields', 'resource-locator', 'pagination', 'validation',
  'error-behavior', 'normalization', 'expression-dependent-fields', 'credential-aware-lookups',
]);

/** §40 — the four closed difference classes. */
export const DIFFERENCE_CLASSES = Object.freeze({
  EQUIVALENT: 'equivalent',
  COMPATIBLE_IMPROVEMENT: 'compatible-improvement',
  MIGRATION_REQUIRED: 'migration-required',
  BREAKING: 'breaking',
});

export class CertificationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'CertificationError';
    this.code = code;
    this.details = details;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * §40 — is `superset` a superset of `subset` (subset's data is contained in superset)?
 * - arrays: every subset element (canonicalJson) is present in superset;
 * - objects: every subset key is present in superset, and each value is a superset;
 * - primitives: equal.
 */
function isSuperset(superset, subset) {
  if (Array.isArray(subset) && Array.isArray(superset)) {
    const have = new Set(superset.map((x) => canonicalJson(x)));
    return subset.every((x) => have.has(canonicalJson(x)));
  }
  if (isPlainObject(subset) && isPlainObject(superset)) {
    return Object.keys(subset).every((k) => k in superset && isSuperset(superset[k], subset[k]));
  }
  return canonicalJson(superset) === canonicalJson(subset);
}

/**
 * §40 — classify a single difference between a P7 output and the pinned n8n oracle output.
 *  - canonical-JSON equal                -> EQUIVALENT
 *  - P7 is a strict superset of the oracle -> COMPATIBLE_IMPROVEMENT (P7 adds, changes nothing)
 *  - P7 drops oracle data (subset)       -> BREAKING (observable data loss)
 *  - same shape, different value          -> MIGRATION_REQUIRED
 */
export function classifyDifference(p7, oracle, aspect) {
  if (!DIFFERENTIAL_ASPECTS.includes(aspect)) {
    throw new CertificationError('CERTIFICATION_INVALID', `unknown differential aspect "${aspect}"`, { aspect, allowed: DIFFERENTIAL_ASPECTS });
  }
  const a = canonicalJson(p7);
  const b = canonicalJson(oracle);
  if (a === b) {
    return Object.freeze({ aspect, differenceClass: DIFFERENCE_CLASSES.EQUIVALENT });
  }
  if (isSuperset(p7, oracle) && !isSuperset(oracle, p7)) {
    return Object.freeze({ aspect, differenceClass: DIFFERENCE_CLASSES.COMPATIBLE_IMPROVEMENT, detail: 'p7 is a strict superset of the pinned n8n behavior' });
  }
  if (isSuperset(oracle, p7) && !isSuperset(p7, oracle)) {
    return Object.freeze({ aspect, differenceClass: DIFFERENCE_CLASSES.BREAKING, detail: 'p7 drops data the pinned n8n behavior provides' });
  }
  return Object.freeze({ aspect, differenceClass: DIFFERENCE_CLASSES.MIGRATION_REQUIRED, detail: 'p7 and the pinned n8n behavior differ in value (same shape)' });
}

/**
 * CP-02 — run the differential cases and produce a frozen certification report. `cases` is an
 * array of `{ aspect, p7, oracle }`. `certified` is true ONLY when no difference is BREAKING
 * (equivalent, compatible-improvement, and migration-required are tolerated). The breaking set
 * is explicitly enumerated.
 */
export function certify(cases = []) {
  if (!Array.isArray(cases)) {
    throw new CertificationError('CERTIFICATION_INVALID', 'certify() requires an array of { aspect, p7, oracle } cases');
  }
  const differences = cases.map((c) => {
    if (!c || !c.aspect || !('p7' in c) || !('oracle' in c)) {
      throw new CertificationError('CERTIFICATION_INVALID', 'each case requires { aspect, p7, oracle }');
    }
    return classifyDifference(c.p7, c.oracle, c.aspect);
  });
  const breaking = differences.filter((d) => d.differenceClass === DIFFERENCE_CLASSES.BREAKING);
  return Object.freeze({
    format: CERTIFICATION_FORMAT,
    pinnedN8nVersion: PINNED_N8N_VERSION,
    certified: breaking.length === 0,
    total: cases.length,
    differences: Object.freeze(differences),
    breaking: Object.freeze(breaking),
  });
}

/* ------------------------------------------------------------------ §41 negative/security matrix */

/**
 * §41 — the 20 mandatory negative/security cases. `expectedCode` is the marked failure code the
 * P7 stages must emit (or null for a behavioral case verified by `behavior`). The matrix is a
 * frozen registry — the required cases, not an optional list.
 */
export const NEGATIVE_CASES = Object.freeze([
  { id: 'cyclic-dependency', category: 'validation', expectedCode: 'DEPENDENCY_INVALID' },
  { id: 'invalid-path', category: 'validation', expectedCode: 'SCHEMA_INVALID' },
  { id: 'malformed-provider-response', category: 'provider', expectedCode: 'INVALID_PROVIDER_DATA' },
  { id: 'oversized-response', category: 'provider', expectedCode: 'INVALID_PROVIDER_DATA' },
  { id: 'excessive-result-count', category: 'provider', expectedCode: 'INVALID_PROVIDER_DATA' },
  { id: 'timeout', category: 'provider', expectedCode: 'TIMEOUT' },
  { id: 'cancellation', category: 'provider', expectedCode: 'CANCELLED' },
  { id: 'stale-overlapping-response', category: 'race', expectedCode: 'STALE_REQUEST' },
  { id: 'cache-scope-collision', category: 'cache', expectedCode: null },
  { id: 'wrong-tenant', category: 'security', expectedCode: 'AUTH_REJECTED' },
  { id: 'missing-capability', category: 'security', expectedCode: 'CAPABILITY_DENIED' },
  { id: 'provider-without-permission', category: 'security', expectedCode: 'AUTH_REJECTED' },
  { id: 'credential-access-without-p5', category: 'security', expectedCode: 'AUTH_REQUIRED' },
  { id: 'secret-leakage-through-cache', category: 'security', expectedCode: null },
  { id: 'secret-leakage-through-logs', category: 'security', expectedCode: null },
  { id: 'provider-forged-permission-metadata', category: 'security', expectedCode: null },
  { id: 'schema-version-mismatch', category: 'validation', expectedCode: 'VERSION_INCOMPATIBLE' },
  { id: 'incompatible-node-definition', category: 'compatibility', expectedCode: 'NODE_DECLARATION_INVALID' },
  { id: 'unbounded-pagination', category: 'provider', expectedCode: 'OVERLOADED' },
  { id: 'provider-retry-storm', category: 'provider', expectedCode: null },
]);

const NEGATIVE_INDEX = Object.freeze(Object.fromEntries(NEGATIVE_CASES.map((c) => [c.id, c])));

/**
 * §41 — verify a P7 result is the expected behavior for a negative case. For a code-based case,
 * the result must be a marked failure with the expected code. For a behavioral case, `result`
 * must carry the expected behavioral marker (result.behavior === case.id).
 */
export function verifyNegativeResult(caseId, result) {
  const c = NEGATIVE_INDEX[caseId];
  if (!c) {
    throw new CertificationError('CERTIFICATION_INVALID', `unknown negative case "${caseId}"`, { caseId });
  }
  if (result === undefined || result === null) {
    return Object.freeze({ id: caseId, pass: false, reason: 'no result provided' });
  }
  if (c.expectedCode !== null) {
    const code = result?.error?.code;
    const pass = code === c.expectedCode;
    return Object.freeze({ id: caseId, pass, expectedCode: c.expectedCode, observedCode: code ?? null, reason: pass ? undefined : `expected marked failure ${c.expectedCode}, got ${code ?? 'none'}` });
  }
  const pass = result.behavior === caseId;
  return Object.freeze({ id: caseId, pass, expectedBehavior: caseId, observedBehavior: result.behavior ?? null, reason: pass ? undefined : `expected behavioral marker "${caseId}", got ${result.behavior ?? 'none'}` });
}

/**
 * §41 — run the negative matrix. `probes` is a map of caseId -> observed P7 result. Reports
 * coverage (how many of the 20 cases are probed) and pass (how many match the expected
 * behavior). `complete` is true only when all 20 are covered AND passing.
 */
export function runNegativeMatrix(probes = {}) {
  if (!isPlainObject(probes)) {
    throw new CertificationError('CERTIFICATION_INVALID', 'runNegativeMatrix() requires a map of caseId -> result');
  }
  const results = NEGATIVE_CASES.map((c) => {
    if (!(c.id in probes)) {
      return Object.freeze({ id: c.id, covered: false, pass: false, reason: 'not covered' });
    }
    const v = verifyNegativeResult(c.id, probes[c.id]);
    return Object.freeze({ ...v, covered: true });
  });
  const covered = results.filter((r) => r.covered).length;
  const passed = results.filter((r) => r.covered && r.pass).length;
  return Object.freeze({
    format: CERTIFICATION_FORMAT,
    pinnedN8nVersion: PINNED_N8N_VERSION,
    total: NEGATIVE_CASES.length,
    covered,
    passed,
    complete: passed === NEGATIVE_CASES.length,
    results: Object.freeze(results),
  });
}

/* ------------------------------------------------------------------ §37-38 low-resource budget */

/** §38 — the low-resource target: 1 vCPU / 1 GB. P7 must degrade before process-level memory pressure. */
export const LOW_RESOURCE_BUDGET = Object.freeze({
  vcpu: 1,
  memoryBytes: 1024 * 1024 * 1024,
  compileStrategy: 'once',
  persistentPolling: false,
  maxCacheEntries: 512,
  maxProviderConcurrency: 8,
  maxPageSize: 200,
  maxResultCount: 4096,
  maxResponseBytes: 1024 * 1024,
});

/**
 * §37-38 — check a config against the low-resource budget. A config fits when it has bounded
 * cache, bounded provider concurrency, small pages, bounded responses, amortized (compile-once)
 * schema compilation, and no persistent polling. Enumerates violations.
 */
export function checkLowResourceBudget(config = {}) {
  const violations = [];
  if (config.persistentPolling === true) {
    violations.push('persistent polling is not allowed by default (P7 must not poll persistently)');
  }
  if (config.compileStrategy !== undefined && config.compileStrategy !== LOW_RESOURCE_BUDGET.compileStrategy) {
    violations.push('schema compilation must be amortized (compile once), not per-request');
  }
  if (config.maxCacheEntries !== undefined && config.maxCacheEntries > LOW_RESOURCE_BUDGET.maxCacheEntries) {
    violations.push(`cache is not bounded (maxCacheEntries ${config.maxCacheEntries} > ${LOW_RESOURCE_BUDGET.maxCacheEntries})`);
  }
  if (config.maxProviderConcurrency !== undefined && config.maxProviderConcurrency > LOW_RESOURCE_BUDGET.maxProviderConcurrency) {
    violations.push(`provider concurrency is not bounded (${config.maxProviderConcurrency} > ${LOW_RESOURCE_BUDGET.maxProviderConcurrency})`);
  }
  if (config.maxPageSize !== undefined && config.maxPageSize > LOW_RESOURCE_BUDGET.maxPageSize) {
    violations.push(`pages are not small (maxPageSize ${config.maxPageSize} > ${LOW_RESOURCE_BUDGET.maxPageSize})`);
  }
  if (config.maxResultCount !== undefined && config.maxResultCount > LOW_RESOURCE_BUDGET.maxResultCount) {
    violations.push(`results are not bounded (maxResultCount ${config.maxResultCount} > ${LOW_RESOURCE_BUDGET.maxResultCount})`);
  }
  if (config.maxResponseBytes !== undefined && config.maxResponseBytes > LOW_RESOURCE_BUDGET.maxResponseBytes) {
    violations.push(`large provider responses must be bounded (maxResponseBytes ${config.maxResponseBytes} > ${LOW_RESOURCE_BUDGET.maxResponseBytes})`);
  }
  return Object.freeze({ fits: violations.length === 0, budget: LOW_RESOURCE_BUDGET, violations: Object.freeze(violations) });
}

/* ------------------------------------------------------------------ CP-05 reproducibility */

/**
 * CP-05 — a certification is a deterministic record pinned to the n8n version. The report's
 * fingerprint is the canonical JSON hash of the report (minus the fingerprint itself); re-running
 * the same cases + oracle gives an identical fingerprint. A stale certification (different pinned
 * version) is invalid.
 */
export function certificationFingerprint(report) {
  const { pinnedN8nVersion, total, differences, breaking } = report;
  const basis = canonicalJson({ pinnedN8nVersion, total, differences, breaking });
  // A stable fingerprint: the canonical JSON itself is deterministic; return its length + a
  // SHA-free stable hash (sum of char codes) so it is reproducible without a crypto import.
  let hash = 0;
  for (let i = 0; i < basis.length; i++) {
    hash = (hash * 31 + basis.charCodeAt(i)) >>> 0;
  }
  return Object.freeze({ fingerprint: hash.toString(16).padStart(8, '0'), pinnedN8nVersion, basisBytes: basis.length });
}
