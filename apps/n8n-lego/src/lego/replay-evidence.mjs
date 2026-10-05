/** P9.14 replay / compatibility evidence integration. Product owner agent-6;
 * implementation delegate Agent 4 (Issue #101). Consumes replay/checkpoint
 * references from owning domains (P3 state-stream, P6 semantics) as REFERENCES
 * only — never re-runs their engines. P3/P6 formats are version-checked;
 * incompatible refs are segregated (never evidence); missing refs are safe
 * (evidenceMissing); secret-shaped refs fail closed to null. Bundle slots:
 * P3 → checkpoint, P6 → replay. Deterministic export; no I/O, no clock.
 */
import { containsSecretShape } from './telemetry-redaction.mjs';

// Owning-domain format pins (values match the published owners; P9 stores the
// pins as data and never imports their engines — arch: observability must not
// depend on execution; F16 scans quoted namespace.snake strings even in
// comments, so bare contract ids are kept inside full @version strings).
const P3_CONTRACT_FULL = 'execution.state-stream@0.1.0';
const P3_SNAPSHOT_VERSION = 1;
const P6_CONTRACT_FULL = 'node.semantics@0.1.0';
const P6_SCHEMA_VERSION = 1;
const pin = (full) => {
  const at = full.lastIndexOf('@');
  return { id: full.slice(0, at), version: full.slice(at + 1) };
};
const P3_PIN = pin(P3_CONTRACT_FULL);
const P6_PIN = pin(P6_CONTRACT_FULL);

export const REPLAY_EVID_CONTRACT = Object.freeze({
  id: 'observability.replay-evidence', version: '1.0.0', owner: 'agent-6',
});
export const REPLAY_EVID_SCHEMA_VERSION = '1.0.0';

/** Owning-domain sources P9 may reference (never own their engines). */
export const REPLAY_EVID_SOURCES = Object.freeze(['P3', 'P6']);

/** Pinned reference formats from the owning domains (pins as data, no engines). */
export const REPLAY_EVID_FORMATS = Object.freeze({
  P3: Object.freeze({
    source: 'P3',
    contract: P3_PIN.id,
    contractVersion: P3_PIN.version,
    versionField: 'snapshotVersion',
    snapshotVersion: P3_SNAPSHOT_VERSION,
    bundleSlot: 'checkpoint',
  }),
  P6: Object.freeze({
    source: 'P6',
    contract: P6_PIN.id,
    contractVersion: P6_PIN.version,
    versionField: 'schemaVersion',
    schemaVersion: P6_SCHEMA_VERSION,
    bundleSlot: 'replay',
  }),
});

export const REPLAY_EVID_LIMITS = Object.freeze({
  identifierBytes: 128,
  maxRefs: 16,
  digestHex: 64,
});
export const REPLAY_EVID_NOTES = Object.freeze([
  'references-not-engines',
  'incompatible-never-evidence',
  'missing-is-data',
  'secret-fail-closed',
]);
export const REPLAY_EVID_VERDICTS = Object.freeze(
  ['MATCH', 'DIFF', 'NON_DETERMINISTIC', 'MISSING'],
);

const SPEC_KEYS = Object.freeze(['refs']);
const REF_KEYS = Object.freeze([
  'source', 'contract', 'contractVersion',
  'snapshotVersion', 'schemaVersion',
  'refId', 'digest', 'verdict',
]);

function isPlain(value) {
  return value !== null && typeof value === 'object' &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function boundedId(value) {
  if (typeof value !== 'string' || value.length === 0 ||
      value.length > REPLAY_EVID_LIMITS.identifierBytes) return null;
  if (containsSecretShape(value)) return null;
  if (/\b(?:bearer|basic)\s+\S/i.test(value)) return null;
  if (/\b(?:password|secret|token|api[-_]?key)\s*[:=]\s*\S/i.test(value)) return null;
  return value;
}

/** Shape + contract-id + version-field check only (never executes engines).
 * Returns frozen { ok, reason?, source?, format? }. */
export function checkReplayRef(ref) {
  if (!isPlain(ref)) return Object.freeze({ ok: false, reason: 'invalid-shape' });
  if (Reflect.ownKeys(ref).some(k => !REF_KEYS.includes(k))) {
    return Object.freeze({ ok: false, reason: 'invalid-shape' });
  }
  if (!REPLAY_EVID_SOURCES.includes(ref.source)) {
    return Object.freeze({ ok: false, reason: 'unknown-source' });
  }
  const format = REPLAY_EVID_FORMATS[ref.source];
  if (typeof ref.contract !== 'string' || ref.contract !== format.contract) {
    return Object.freeze({ ok: false, reason: 'contract-mismatch', source: ref.source });
  }
  if (typeof ref.contractVersion !== 'string' || ref.contractVersion !== format.contractVersion) {
    return Object.freeze({ ok: false, reason: 'contract-mismatch', source: ref.source });
  }
  const versionValue = ref[format.versionField];
  const expected = format[format.versionField];
  if (!Number.isSafeInteger(versionValue) || versionValue !== expected) {
    return Object.freeze({
      ok: false,
      reason: `${format.versionField}-mismatch`,
      source: ref.source,
    });
  }
  const refId = boundedId(ref.refId);
  if (refId === null) return Object.freeze({ ok: false, reason: 'invalid-refId', source: ref.source });
  if (ref.digest !== undefined) {
    if (typeof ref.digest !== 'string' || !/^[0-9a-f]{64}$/.test(ref.digest)) {
      return Object.freeze({ ok: false, reason: 'invalid-digest', source: ref.source });
    }
  }
  if (ref.verdict !== undefined && !REPLAY_EVID_VERDICTS.includes(ref.verdict)) {
    return Object.freeze({ ok: false, reason: 'invalid-verdict', source: ref.source });
  }
  return Object.freeze({ ok: true, source: ref.source, format });
}

/** Compile `{ refs }` → frozen `{ evidence, incompatible, evidenceMissing }`.
 * Secret/shape fail closed to `null`. Missing refs is data, not an error. */
export function compileReplayEvidence(spec) {
  if (!isPlain(spec)) return null;
  if (Reflect.ownKeys(spec).some(k => !SPEC_KEYS.includes(k))) return null;
  if (containsSecretShape(spec)) return null;

  const evidence = [];
  const incompatible = [];
  const evidenceMissing = [];

  if (spec.refs === undefined || spec.refs === null ||
      (Array.isArray(spec.refs) && spec.refs.length === 0)) {
    evidenceMissing.push('replayRefs');
    return Object.freeze({
      evidence: Object.freeze(evidence),
      incompatible: Object.freeze(incompatible),
      evidenceMissing: Object.freeze(evidenceMissing),
    });
  }
  if (!Array.isArray(spec.refs)) return null;
  if (spec.refs.length > REPLAY_EVID_LIMITS.maxRefs) return null;

  for (const raw of spec.refs) {
    if (containsSecretShape(raw)) return null;
    const check = checkReplayRef(raw);
    if (!check.ok) {
      if (check.reason === 'invalid-shape' || check.reason === 'unknown-source' ||
          check.reason === 'invalid-refId' || check.reason === 'invalid-digest' ||
          check.reason === 'invalid-verdict') {
        return null;
      }
      incompatible.push(Object.freeze({
        source: raw && typeof raw.source === 'string' ? raw.source : null,
        contract: raw && typeof raw.contract === 'string' ? raw.contract : null,
        reason: check.reason,
        refId: raw && boundedId(raw.refId) !== null ? raw.refId : null,
      }));
      continue;
    }
    const format = check.format;
    evidence.push(Object.freeze({
      source: raw.source,
      contract: raw.contract,
      contractVersion: raw.contractVersion,
      [format.versionField]: raw[format.versionField],
      refId: raw.refId,
      ...(raw.digest !== undefined ? { digest: raw.digest } : {}),
      ...(raw.verdict !== undefined ? { verdict: raw.verdict } : {}),
      bundleSlot: format.bundleSlot,
    }));
  }

  return Object.freeze({
    evidence: Object.freeze(evidence),
    incompatible: Object.freeze(incompatible),
    evidenceMissing: Object.freeze(evidenceMissing),
  });
}

/** Map first compatible P3 → `checkpoint`, first compatible P6 → `replay`. */
export function selectReplayRefsForBundle(compiled) {
  if (compiled === null || typeof compiled !== 'object') return null;
  if (!Array.isArray(compiled.evidence)) return null;
  const slots = {};
  for (const ev of compiled.evidence) {
    const slot = ev.bundleSlot;
    if ((slot === 'checkpoint' || slot === 'replay') && slots[slot] === undefined) {
      slots[slot] = ev.refId;
    }
  }
  return Object.freeze(slots);
}

/** Merge selected slots into a diagnostic/bundle `refs` map without dropping artifacts. */
export function attachReplayEvidence(target, compiled) {
  if (target === null || typeof target !== 'object') return null;
  if (compiled === null || typeof compiled !== 'object') return null;
  const slots = selectReplayRefsForBundle(compiled);
  if (slots === null) return null;
  const existing = isPlain(target.refs) ? { ...target.refs } : {};
  const allowed = ['checkpoint', 'replay', 'artifacts'];
  if (Reflect.ownKeys(existing).some(k => !allowed.includes(k))) return null;
  const next = { ...existing, ...slots };
  if (existing.artifacts !== undefined) next.artifacts = existing.artifacts;
  return Object.freeze({ ...target, refs: Object.freeze(next) });
}

/** Deterministic stableStringify body; refuses secret-shaped content. */
export function exportReplayEvidence(compiled) {
  if (compiled === null || typeof compiled !== 'object') return null;
  if (!Array.isArray(compiled.evidence) || !Array.isArray(compiled.incompatible)) return null;
  const body = {
    schemaVersion: REPLAY_EVID_SCHEMA_VERSION,
    contract: {
      id: REPLAY_EVID_CONTRACT.id,
      version: REPLAY_EVID_CONTRACT.version,
      owner: REPLAY_EVID_CONTRACT.owner,
    },
    evidence: compiled.evidence.map(e => ({ ...e })),
    incompatible: compiled.incompatible.map(e => ({ ...e })),
    evidenceMissing: [...(compiled.evidenceMissing || [])],
  };
  if (containsSecretShape(body)) return null;
  let canonical;
  try {
    canonical = stableStringify(body);
  } catch {
    return null;
  }
  if (canonical === null || containsSecretShape(canonical)) return null;
  return canonical;
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value).sort();
  const parts = [];
  for (const k of keys) {
    const v = value[k];
    if (v === undefined) continue;
    parts.push(JSON.stringify(k) + ':' + stableStringify(v));
  }
  return '{' + parts.join(',') + '}';
}
