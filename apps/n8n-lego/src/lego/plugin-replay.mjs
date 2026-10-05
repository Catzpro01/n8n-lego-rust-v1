/**
 * Backend LEGO foundation — P2.27 contract replay (interchangeability oracle).
 *
 * PUBLIC CONTRACT (`lego.plugin-runtime`, v0.8.0, owner: agent-1).
 *
 * Design §18, as a pure function:
 *
 * ```text
 * production failure → contract-safe fixture → plugin v1 → plugin v2
 *                   → compare semantic result
 * same input contract + same semantic contract = interchangeable implementation
 * ```
 *
 * `replayFixture` runs one input across N implementations and compares their
 * OUTCOMES semantically: success values compare through `stableStringify`
 * (sorted keys — key order is never semantics), failures compare through
 * error name+message (same contract behavior on the unhappy path). An
 * optional `normalize` strips fixture-volatile fields (timestamps, request
 * ids) BEFORE comparison — stripping is explicit, never automatic, so a
 * replay cannot silently paper over a real difference.
 *
 * Nothing here executes plugins through the registry/supervisor: replay is a
 * test-time oracle over caller-supplied `invoke` functions, zero I/O, zero
 * clocks, bounded implementation counts (§63).
 */
import { PluginRuntimeError } from './plugin-runtime.mjs';

/** Bounds — replays are fixtures, not fan-out (§63). */
export const REPLAY_BOUNDS = Object.freeze({ implementationsMin: 2, implementationsMax: 16 });

const violation = (message, details) => new PluginRuntimeError('lego.contract_violation', message, { details });

/**
 * Deterministic JSON with sorted object keys — the semantic-compare serializer.
 * Cycles and non-serializable values fail closed as contract violations.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function stableStringify(value) {
  const seen = new Set();
  const walk = (entry) => {
    if (entry === null || typeof entry !== 'object') {
      if (typeof entry === 'function' || typeof entry === 'symbol' || typeof entry === 'bigint') {
        throw violation('replay values must be JSON-serializable', { type: typeof entry });
      }
      if (typeof entry === 'number' && !Number.isFinite(entry)) {
        throw violation('replay values must be JSON-serializable (finite numbers only)', { value: String(entry) });
      }
      return entry;
    }
    if (seen.has(entry)) throw violation('replay values must be JSON-serializable (no cycles)', {});
    seen.add(entry);
    let out;
    if (Array.isArray(entry)) {
      out = entry.map(walk);
    } else {
      out = {};
      for (const key of Object.keys(entry).sort()) out[key] = walk(entry[key]);
    }
    seen.delete(entry);
    return out;
  };
  try {
    return JSON.stringify(walk(value));
  } catch (error) {
    if (error instanceof PluginRuntimeError) throw error;
    throw violation('replay values must be JSON-serializable', { reason: error?.message ?? 'unserializable' });
  }
}

/**
 * First structural difference between two values — a dotted path (operator
 * model §20: say WHERE the implementations diverged).
 *
 * @returns {{ equal: boolean, path: string | null, left: string | null, right: string | null }}
 */
export function firstDifference(left, right) {
  const visit = (a, b, path) => {
    if (Object.is(a, b)) return null;
    if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
      if (typeof a === 'number' && typeof b === 'number' && Number.isNaN(a) && Number.isNaN(b)) return null;
      return { path, left: stableStringify(a), right: stableStringify(b) };
    }
    if (Array.isArray(a) !== Array.isArray(b)) {
      return { path, left: Array.isArray(a) ? 'array' : typeof a, right: Array.isArray(b) ? 'array' : typeof b };
    }
    if (Array.isArray(a)) {
      if (a.length !== b.length) {
        return { path: path === '' ? 'length' : `${path}.length`, left: String(a.length), right: String(b.length) };
      }
      for (let i = 0; i < a.length; i += 1) {
        const diff = visit(a[i], b[i], `${path}[${i}]`);
        if (diff) return diff;
      }
      return null;
    }
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    for (const key of keys) {
      const inA = Object.prototype.hasOwnProperty.call(a, key);
      const inB = Object.prototype.hasOwnProperty.call(b, key);
      if (!inA || !inB) {
        return { path: path ? `${path}.${key}` : key, left: inA ? 'present' : 'absent', right: inB ? 'present' : 'absent' };
      }
      const diff = visit(a[key], b[key], path ? `${path}.${key}` : key);
      if (diff) return diff;
    }
    return null;
  };
  const diff = visit(left, right, '');
  return diff
    ? Object.freeze({ equal: false, path: diff.path, left: diff.left, right: diff.right })
    : Object.freeze({ equal: true, path: null, left: null, right: null });
}

/**
 * Replay one fixture across implementations and compare semantic outcomes.
 *
 * @param {{
 *   name?: string,
 *   input: unknown,
 *   implementations: Array<{ id: string, invoke: (input: unknown) => unknown }>,
 *   normalize?: (value: unknown) => unknown,
 * }} request
 * @returns {{
 *   name: string, interchangeable: boolean,
 *   outcomes: Array<{ id: string, ok: boolean, value?: unknown, error?: { name: string, message: string } }>,
 *   mismatches: Array<{ id: string, baselineId: string, reason: string, path?: string | null }>,
 * }}
 */
export function replayFixture({ name = 'fixture', input, implementations, normalize = null } = {}) {
  if (typeof name !== 'string' || name.length === 0 || name.length > 128) {
    throw violation('fixture name must be a string of length [1, 128]', { name });
  }
  if (!Array.isArray(implementations) || implementations.length < REPLAY_BOUNDS.implementationsMin) {
    throw violation(`implementations must be an array of at least ${REPLAY_BOUNDS.implementationsMin} (v1 and v2)`, {
      count: Array.isArray(implementations) ? implementations.length : null,
    });
  }
  if (implementations.length > REPLAY_BOUNDS.implementationsMax) {
    throw violation(`implementations exceeds ${REPLAY_BOUNDS.implementationsMax} entries`, { count: implementations.length });
  }
  if (normalize !== null && typeof normalize !== 'function') {
    throw violation('normalize must be a function or null');
  }
  if (input === undefined) throw violation('input is required (use null for empty)');
  stableStringify(input); // validates serializability up front

  const seenIds = new Set();
  const prepared = implementations.map((implementation, index) => {
    if (implementation === null || typeof implementation !== 'object') {
      throw violation(`implementations[${index}] must be { id, invoke }`, { index });
    }
    const { id, invoke } = implementation;
    if (typeof id !== 'string' || id.length === 0 || id.length > 64) {
      throw violation(`implementations[${index}].id must be a string of length [1, 64]`, { index });
    }
    if (seenIds.has(id)) throw violation(`duplicate implementation id '${id}'`, { id });
    seenIds.add(id);
    if (typeof invoke !== 'function') throw violation(`implementations[${index}].invoke must be a function`, { index });
    return { id, invoke };
  });

  const outcomes = prepared.map(({ id, invoke }) => {
    let raw;
    try {
      raw = invoke(input);
    } catch (error) {
      return Object.freeze({
        id,
        ok: false,
        error: Object.freeze({
          name: typeof error?.name === 'string' ? error.name : 'Error',
          message: typeof error?.message === 'string' ? error.message : String(error),
        }),
      });
    }
    // normalize + serializability live OUTSIDE the invoke try: an unserializable
    // SUCCESS outcome (or a broken normalize hook) is a fixture bug, not an
    // implementation outcome — it must propagate as a contract violation.
    const value = normalize ? normalize(raw) : raw;
    stableStringify(value);
    return Object.freeze({ id, ok: true, value });
  });

  const baseline = outcomes[0];
  const mismatches = [];
  for (const outcome of outcomes.slice(1)) {
    if (outcome.ok !== baseline.ok) {
      mismatches.push({
        id: outcome.id,
        baselineId: baseline.id,
        reason: outcome.ok
          ? 'baseline failed but this implementation succeeded'
          : 'baseline succeeded but this implementation failed',
      });
      continue;
    }
    if (!outcome.ok) {
      const sameError =
        outcome.error.name === baseline.error.name && outcome.error.message === baseline.error.message;
      if (!sameError) {
        mismatches.push({
          id: outcome.id,
          baselineId: baseline.id,
          reason: `failure contract differs: ${outcome.error.name}: ${outcome.error.message} vs ${baseline.error.name}: ${baseline.error.message}`,
        });
      }
      continue;
    }
    const diff = firstDifference(baseline.value, outcome.value);
    if (!diff.equal) {
      mismatches.push({
        id: outcome.id,
        baselineId: baseline.id,
        reason: 'semantic result differs from baseline',
        path: diff.path,
      });
    }
  }

  return Object.freeze({
    name,
    interchangeable: mismatches.length === 0,
    outcomes: Object.freeze(outcomes),
    mismatches: Object.freeze(mismatches.map((entry) => Object.freeze(entry))),
  });
}
