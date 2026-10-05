/** P9.20 observability contract oracle + cross-domain acceptance.
 * Product owner agent-6; implementation delegate Agent 4 (Issue #101).
 * Validates P3/P4/P6/P8 producer specimens against declared schemas:
 * missing fields, invented fields, vocabulary drift and version
 * incompatibility are detected; output is deterministic (stable sort);
 * cross-domain fixtures are checked in under test/fixtures/p9/.
 * Version-range semantics match lego-foundation's public compat model
 * (exact / ^ / ~ / >= / *) but are implemented locally: src/lego/compat.mjs
 * is not on lego-foundation's public surface (R4 boundary).
 * No I/O, no clock, no workflow/execution/storage import.
 */
import { containsSecretShape } from './telemetry-redaction.mjs';

export const CORACLE_CONTRACT = Object.freeze({
  id: 'observability.contract-oracle', version: '1.0.0', owner: 'agent-6',
});
export const CORACLE_SCHEMA_VERSION = '1.0.0';

/** Finding codes — fixed vocabulary of the oracle itself. */
export const CORACLE_FINDINGS = Object.freeze([
  'missing_field', 'invented_field', 'vocabulary_drift', 'version_incompatible',
]);

/** Producer phases the oracle accepts fixtures for. */
export const CORACLE_PHASES = Object.freeze(['P3', 'P4', 'P6', 'P8']);

export const CORACLE_LIMITS = Object.freeze({
  identifierBytes: 128,
  maxFields: 64,
  maxVocabulary: 64,
  maxValueBytes: 256,
  maxSpecimens: 256,
  maxFindings: 256,
});

export const CORACLE_NOTES = Object.freeze([
  'p3-p4-p6-p8-validated',
  'missing-field-detected',
  'invented-field-detected',
  'vocabulary-drift-detected',
  'version-incompatibility-detected',
  'deterministic-output',
  'cross-domain-fixtures',
]);

const SCHEMA_KEYS = Object.freeze(['id', 'phase', 'versionRange', 'fields']);
const FIELD_KEYS = Object.freeze(['required', 'type', 'vocabulary']);
const VERSION_KEYS = Object.freeze(['contractVersion', 'version']);

function isPlain(value) {
  return value !== null && typeof value === 'object' &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function err(code, message, extra = undefined) {
  return Object.freeze({
    ok: false,
    error: Object.freeze({ code, message, ...(extra ? { ...extra } : {}) }),
  });
}

function validId(value) {
  return typeof value === 'string' && value.length > 0 &&
    value.length <= CORACLE_LIMITS.identifierBytes;
}

/** Local semver-range check (compat public semantics). Pure, no import. */
const VER_RE = /^(\d+)\.(\d+)\.(\d+)$/;
function parseVer(value) {
  const m = typeof value === 'string' ? VER_RE.exec(value) : null;
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3] };
}
function cmpVer(a, b) {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}
function satisfies(version, range) {
  const spec = String(range ?? '*').trim();
  if (spec === '*' || spec === '') return { satisfied: true, reason: 'any version accepted' };
  const actual = parseVer(version);
  if (!actual) return { satisfied: false, reason: `${version} is not a semver triple` };
  if (spec.startsWith('^')) {
    const base = parseVer(spec.slice(1));
    if (!base) return { satisfied: false, reason: `invalid range ${spec}` };
    if (cmpVer(actual, base) < 0) {
      return { satisfied: false, reason: `${version} is older than the required ${spec}` };
    }
    if (base.major === 0) {
      const ok = actual.major === 0 && actual.minor === base.minor;
      return {
        satisfied: ok,
        reason: ok
          ? `${version} is within the provisional 0.${base.minor}.x line`
          : `${version} leaves the provisional 0.${base.minor}.x line required by ${spec}`,
      };
    }
    const ok = actual.major === base.major;
    return {
      satisfied: ok,
      reason: ok ? `${version} satisfies ${spec}` : `major ${actual.major} != ${base.major} required by ${spec}`,
    };
  }
  if (spec.startsWith('~')) {
    const base = parseVer(spec.slice(1));
    if (!base) return { satisfied: false, reason: `invalid range ${spec}` };
    const ok = actual.major === base.major && actual.minor === base.minor && cmpVer(actual, base) >= 0;
    return {
      satisfied: ok,
      reason: ok ? `${version} satisfies ${spec}` : `${version} is outside the ${base.major}.${base.minor}.x line required by ${spec}`,
    };
  }
  if (spec.startsWith('>=')) {
    const base = parseVer(spec.slice(2));
    if (!base) return { satisfied: false, reason: `invalid range ${spec}` };
    const ok = cmpVer(actual, base) >= 0;
    return {
      satisfied: ok,
      reason: ok ? `${version} >= ${spec.slice(2)}` : `${version} < ${spec.slice(2)}`,
    };
  }
  const base = parseVer(spec);
  if (!base) return { satisfied: false, reason: `invalid range ${spec}` };
  const ok = cmpVer(actual, base) === 0;
  return {
    satisfied: ok,
    reason: ok ? `${version} == ${spec}` : `${version} != the pinned ${spec}`,
  };
}

/** Stable finding comparator: code, then field, then value — deterministic. */
function compareFindings(a, b) {
  if (a.code !== b.code) return a.code < b.code ? -1 : 1;
  const fa = a.field === undefined ? '' : a.field;
  const fb = b.field === undefined ? '' : b.field;
  if (fa !== fb) return fa < fb ? -1 : 1;
  const va = a.value === undefined ? '' : String(a.value);
  const vb = b.value === undefined ? '' : String(b.value);
  if (va !== vb) return va < vb ? -1 : 1;
  return 0;
}

/**
 * Create a contract oracle for one schema. Config:
 *  id, phase ('P3'|'P4'|'P6'|'P8'), versionRange (compat range),
 *  fields: { name: { required, type, vocabulary? } }.
 * Fail closed → null.
 */
export function createContractOracle(schema = {}) {
  if (!isPlain(schema)) return null;
  if (Reflect.ownKeys(schema).some(k => !SCHEMA_KEYS.includes(k))) return null;
  if (!validId(schema.id)) return null;
  if (!CORACLE_PHASES.includes(schema.phase)) return null;
  if (typeof schema.versionRange !== 'string' || schema.versionRange.length === 0 ||
      schema.versionRange.length > CORACLE_LIMITS.maxValueBytes) return null;
  if (!isPlain(schema.fields)) return null;
  const fieldNames = Reflect.ownKeys(schema.fields).filter(k => typeof k === 'string');
  if (fieldNames.length === 0 || fieldNames.length > CORACLE_LIMITS.maxFields) return null;
  const fields = {};
  for (const name of fieldNames) {
    if (!validId(name)) return null;
    const spec = schema.fields[name];
    if (!isPlain(spec)) return null;
    if (Reflect.ownKeys(spec).some(k => !FIELD_KEYS.includes(k))) return null;
    const required = spec.required === undefined ? false : spec.required;
    if (typeof required !== 'boolean') return null;
    const type = spec.type === undefined ? 'string' : spec.type;
    if (!['string', 'number', 'boolean', 'object'].includes(type)) return null;
    let vocabulary;
    if (spec.vocabulary !== undefined) {
      if (!Array.isArray(spec.vocabulary) || spec.vocabulary.length === 0 ||
          spec.vocabulary.length > CORACLE_LIMITS.maxVocabulary) return null;
      vocabulary = [];
      for (const v of spec.vocabulary) {
        if (typeof v !== 'string' || v.length === 0 ||
            v.length > CORACLE_LIMITS.maxValueBytes) return null;
        vocabulary.push(v);
      }
      vocabulary = Object.freeze(vocabulary);
    } else {
      vocabulary = null;
    }
    fields[name] = Object.freeze({ required, type, vocabulary });
  }

  const state = {
    validated: 0,
    clean: 0,
    withFindings: 0,
    counters: {
      missing_field: 0,
      invented_field: 0,
      vocabulary_drift: 0,
      version_incompatible: 0,
    },
  };

  function typeOk(value, type) {
    switch (type) {
      case 'string': return typeof value === 'string';
      case 'number': return typeof value === 'number' && Number.isFinite(value);
      case 'boolean': return typeof value === 'boolean';
      case 'object': return isPlain(value);
      default: return false;
    }
  }

  /**
   * Validate one specimen against the schema. Deterministic: findings are
   * sorted by (code, field, value) and frozen. Returns report or error.
   */
  function validate(specimen) {
    if (!isPlain(specimen)) return err('coracle.invalid_specimen', 'specimen must be an object');
    if (containsSecretShape(specimen)) {
      return err('coracle.secret', 'secret-shaped specimen');
    }
    const keys = Reflect.ownKeys(specimen).filter(k => typeof k === 'string');
    if (keys.length > CORACLE_LIMITS.maxFields + VERSION_KEYS.length + 4) {
      return err('coracle.invalid_specimen', 'too many fields');
    }

    // Version: contractVersion preferred, else version; one of them required
    // for the version check (absence → version_incompatible with value 'missing').
    let specimenVersion;
    let versionKey = null;
    if (specimen.contractVersion !== undefined) {
      specimenVersion = specimen.contractVersion;
      versionKey = 'contractVersion';
    } else if (specimen.version !== undefined) {
      specimenVersion = specimen.version;
      versionKey = 'version';
    }

    const findings = [];

    if (versionKey === null) {
      findings.push(Object.freeze({
        code: 'version_incompatible',
        field: 'contractVersion',
        value: 'missing',
        expected: schema.versionRange,
        reason: 'specimen declares no contractVersion/version',
      }));
    } else if (typeof specimenVersion !== 'string' ||
               specimenVersion.length > CORACLE_LIMITS.maxValueBytes) {
      findings.push(Object.freeze({
        code: 'version_incompatible',
        field: versionKey,
        value: 'invalid',
        expected: schema.versionRange,
        reason: 'version is not a string',
      }));
    } else {
      const sat = satisfies(specimenVersion, schema.versionRange);
      if (!sat.satisfied) {
        findings.push(Object.freeze({
          code: 'version_incompatible',
          field: versionKey,
          value: specimenVersion,
          expected: schema.versionRange,
          reason: sat.reason,
        }));
      }
    }

    // Missing required fields
    for (const name of Object.keys(fields).sort()) {
      const f = fields[name];
      if (f.required && specimen[name] === undefined) {
        findings.push(Object.freeze({
          code: 'missing_field',
          field: name,
          expected: f.type,
        }));
      }
    }

    // Invented fields (not in schema, not version keys) + value checks
    for (const key of keys.sort()) {
      if (VERSION_KEYS.includes(key)) continue;
      const value = specimen[key];
      const f = fields[key];
      if (f === undefined) {
        findings.push(Object.freeze({
          code: 'invented_field',
          field: key,
        }));
        continue;
      }
      if (value === undefined) continue;
      if (!typeOk(value, f.type)) {
        findings.push(Object.freeze({
          code: 'missing_field',
          field: key,
          value: 'type_mismatch',
          expected: f.type,
          reason: `expected ${f.type}`,
        }));
        continue;
      }
      if (f.vocabulary !== null && typeof value === 'string' &&
          !f.vocabulary.includes(value)) {
        findings.push(Object.freeze({
          code: 'vocabulary_drift',
          field: key,
          value,
          allowed: f.vocabulary,
          reason: 'value outside declared vocabulary',
        }));
      }
    }

    findings.sort(compareFindings);
    if (findings.length > CORACLE_LIMITS.maxFindings) {
      return err('coracle.invalid_specimen', 'too many findings');
    }

    state.validated++;
    if (findings.length === 0) state.clean++;
    else state.withFindings++;
    for (const f of findings) state.counters[f.code]++;

    return Object.freeze({
      ok: true,
      report: Object.freeze({
        schemaId: schema.id,
        phase: schema.phase,
        versionRange: schema.versionRange,
        valid: findings.length === 0,
        findings: Object.freeze(findings),
        findingCount: findings.length,
        // deterministic fingerprint of the finding set
        fingerprint: findings
          .map(f => `${f.code}:${f.field === undefined ? '' : f.field}:${f.value === undefined ? '' : f.value}`)
          .join('|'),
      }),
    });
  }

  /**
   * Validate an ordered list of specimens (a cross-domain matrix row set).
   * Report order follows input order; each report is individually sorted —
   * running the same matrix twice yields deep-equal output.
   */
  function validateMatrix(specimens) {
    if (!Array.isArray(specimens) || specimens.length === 0 ||
        specimens.length > CORACLE_LIMITS.maxSpecimens) {
      return err('coracle.invalid_matrix', 'matrix must be a non-empty array');
    }
    const reports = [];
    for (let i = 0; i < specimens.length; i++) {
      const r = validate(specimens[i]);
      if (!r.ok) return err('coracle.invalid_matrix', `specimen ${i} invalid`,
        { index: i, cause: r.error.code });
      reports.push(r.report);
    }
    const invalidCount = reports.filter(x => !x.valid).length;
    return Object.freeze({
      ok: true,
      matrix: Object.freeze({
        schemaId: schema.id,
        phase: schema.phase,
        count: reports.length,
        validCount: reports.length - invalidCount,
        invalidCount,
        reports: Object.freeze(reports),
      }),
    });
  }

  function snapshot() {
    return Object.freeze({
      schemaVersion: CORACLE_SCHEMA_VERSION,
      contract: Object.freeze({ ...CORACLE_CONTRACT }),
      schema: Object.freeze({
        id: schema.id,
        phase: schema.phase,
        versionRange: schema.versionRange,
        fieldCount: Object.keys(fields).length,
      }),
      validated: state.validated,
      clean: state.clean,
      withFindings: state.withFindings,
      counters: Object.freeze({ ...state.counters }),
    });
  }

  return Object.freeze({ validate, validateMatrix, snapshot, stats: state.counters });
}
