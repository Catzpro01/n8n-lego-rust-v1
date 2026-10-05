/**
 * Compatibility oracle (P3 Slice L, Issue #91 — canonical workflow behavior
 * IS the oracle).
 *
 * Part of the n8n compatibility boundary (`src/compat/`): a zero-import,
 * side-effect-free comparison toolkit that states WHAT equivalence means
 * before anything is allowed to claim an optimization, virtualization, or
 * metamorphic rewrite is safe:
 *
 *   - `ORACLE_MODES`     — the four required comparison modes (#91):
 *                          differential execution, virtualization equivalence,
 *                          optimization toggles, metamorphic transforms.
 *   - `ORACLE_OBSERVABLES` — the canonical check surface (#91): final status,
 *                          outputs, error class/message contract, observable
 *                          node order, retry behavior, side-effect boundaries,
 *                          execution metadata, credential behavior,
 *                          partial/failure semantics.
 *   - `differentialPlan` — freeze the ordered comparison intent (mode +
 *                          observables) before running anything.
 *   - `compareCanonical` — deep structural equivalence over the observables,
 *                          fail-closed on absent observables (comparable means
 *                          present on BOTH sides — silent skips would turn a
 *                          gate into a rubber stamp).
 *   - `toggleSweep`      — #91(c): every subset of independently disableable
 *                          optimizations is applied and compared against the
 *                          canonical result; `identityRecovered` is true only
 *                          when the all-off subset reproduces the canonical
 *                          value exactly.
 *
 * Zero imports (purity test scans this source): the domain's
 * `mustNotDependOn: [workflow, execution]` is honored structurally — the
 * oracle never imports the graph, the IR, or any executor; harnesses pass
 * values and callbacks in. No clock, no randomness, no I/O: comparisons are
 * pure, and "benchmark improvement is never sufficient without equivalence"
 * (#91 Security rule) is enforced by making equivalence a first-class value.
 *
 * One error family: `CompatibilityOracleError`.
 * Owner: agent-1 (Issue #98 — compatibility layer).
 */

/** The contract this module publishes. */
export const COMPATIBILITY_ORACLE_CONTRACT = Object.freeze({
  id: `compatibility.oracle`,
  version: '1.0.0',
  owner: 'agent-1',
});

/** Pinned contract version for pin-style assertions. */
export const COMPATIBILITY_ORACLE_CONTRACT_VERSION = COMPATIBILITY_ORACLE_CONTRACT.version;

/** Issue #91's four required comparison modes, fixed order. */
export const ORACLE_MODES = Object.freeze([
  'differential',
  'virtualization-equivalence',
  'optimization-toggles',
  'metamorphic',
]);

/** Issue #91's canonical observable comparison surface (nine checks). */
export const ORACLE_OBSERVABLES = Object.freeze([
  'finalStatus',
  'outputs',
  'errorClassMessage',
  'nodeExecutionOrder',
  'retryBehavior',
  'sideEffectBoundaries',
  'executionMetadata',
  'credentialBehavior',
  'partialFailureSemantics',
]);

/** One error family for this module. */
export class CompatibilityOracleError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'CompatibilityOracleError';
    this.code = 'lego.contract_violation';
    this.details = Object.freeze({ ...details });
  }
}

function fail(message, details) {
  throw new CompatibilityOracleError(message, details);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Structural equality: objects compared key-order-insensitively, arrays
 * ORDER-SENSITIVE (node order is observable per #91), primitives via
 * Object.is (NaN === NaN for this purpose — both sides describe the same
 * observed value). Cycles are not expected in run snapshots; a cycle would
 * fail closed as non-equivalent rather than hang (depth guard).
 */
function deepEqualStable(a, b, depth = 0) {
  if (depth > 64) return false;
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (!deepEqualStable(a[i], b[i], depth + 1)) return false;
    }
    return true;
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;
    for (const key of keysA) {
      if (!Object.hasOwn(b, key)) return false;
      if (!deepEqualStable(a[key], b[key], depth + 1)) return false;
    }
    return true;
  }
  return false;
}

function firstDifference(a, b, path = '$', depth = 0) {
  if (depth > 32 || Object.is(a, b)) return null;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return { path, expected: `array(length ${a.length})`, actual: `array(length ${b.length})` };
    for (let i = 0; i < a.length; i += 1) {
      const hit = firstDifference(a[i], b[i], `${path}[${i}]`, depth + 1);
      if (hit !== null) return hit;
    }
    return null;
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of keys) {
      if (!Object.hasOwn(a, key) || !Object.hasOwn(b, key)) {
        return { path: `${path}.${key}`, expected: Object.hasOwn(a, key) ? 'present' : 'absent', actual: Object.hasOwn(b, key) ? 'present' : 'absent' };
      }
      const hit = firstDifference(a[key], b[key], `${path}.${key}`, depth + 1);
      if (hit !== null) return hit;
    }
    return null;
  }
  return { path, expected: preview(a), actual: preview(b) };
}

function preview(value) {
  let text;
  try {
    text = typeof value === 'string' ? JSON.stringify(value) : String(value);
  } catch {
    text = '<unpreviewable>';
  }
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

function resolveOptions({ mode = 'differential', observables } = {}) {
  if (!ORACLE_MODES.includes(mode)) {
    fail(`unknown oracle mode '${mode}'`, { field: 'mode', reason: 'unknown-mode', mode });
  }
  let list;
  if (observables === undefined) {
    list = [...ORACLE_OBSERVABLES];
  } else {
    if (!Array.isArray(observables) || observables.length === 0) {
      fail('observables must be a non-empty array of known observable names', { field: 'observables' });
    }
    list = [];
    for (const name of observables) {
      if (!ORACLE_OBSERVABLES.includes(name)) {
        fail(`unknown observable '${name}'`, { field: 'observables', reason: 'unknown-observable', observable: name });
      }
      if (list.includes(name)) {
        fail(`duplicate observable '${name}'`, { field: 'observables', reason: 'duplicate-observable', observable: name });
      }
      list.push(name);
    }
  }
  return { mode, observables: list };
}

/**
 * Freeze the comparison intent BEFORE execution (#91 harness planning): which
 * mode, which observables, which reference/candidate pair per observable.
 * No deep walk — planning is cheap; `compareCanonical` performs the check.
 */
export function differentialPlan(reference, candidate, options = {}) {
  if (!isPlainObject(reference) || !isPlainObject(candidate)) {
    fail('reference and candidate must be plain observable objects', { field: 'reference' });
  }
  const { mode, observables } = resolveOptions(options);
  const pairs = observables.map((observable) => Object.freeze({
    observable,
    reference,
    candidate,
  }));
  return Object.freeze({ mode, observables: Object.freeze(observables), pairs: Object.freeze(pairs) });
}

/**
 * Deep structural equivalence over the selected observables. Fail-closed: an
 * observable absent on EITHER side is a failure (`absent-observable`) — the
 * oracle never silently skips a check (#91 Security rule: improvement is not
 * evidence; only equivalence is).
 */
export function compareCanonical(reference, candidate, options = {}) {
  const plan = differentialPlan(reference, candidate, options);
  const failures = [];
  for (const { observable } of plan.pairs) {
    const inReference = Object.hasOwn(reference, observable);
    const inCandidate = Object.hasOwn(candidate, observable);
    if (!inReference || !inCandidate) {
      failures.push(Object.freeze({
        observable,
        reason: 'absent-observable',
        detail: `reference:${inReference ? 'present' : 'absent'} candidate:${inCandidate ? 'present' : 'absent'}`,
      }));
      continue;
    }
    if (!deepEqualStable(reference[observable], candidate[observable])) {
      const diff = firstDifference(reference[observable], candidate[observable], observable);
      failures.push(Object.freeze({
        observable,
        reason: 'not-equivalent',
        path: diff ? diff.path : observable,
        expected: diff ? diff.expected : '<deep>',
        actual: diff ? diff.actual : '<deep>',
      }));
    }
  }
  return Object.freeze({
    mode: plan.mode,
    observables: plan.observables,
    equivalent: failures.length === 0,
    failures: Object.freeze(failures),
  });
}

/**
 * #91(c) optimization-toggle sweep: apply EVERY subset of `toggleNames`
 * (2^n rows, n capped at 8 → ≤ 256 bounded), compare each result to the
 * canonical value structurally, and surface `identityRecovered` = the
 * all-off subset reproduced the canonical value EXACTLY (the non-negotiable
 * recovery property — toggles may be default-ON, but disabling them all must
 * land back on canonical without workflow conversion).
 *
 * `apply(toggles)` receives a plain object mapping EVERY toggle name to a
 * boolean for that subset (no defaulting inside the oracle — the callback's
 * contract is explicit). `canonical` is the reference value (e.g. the raw
 * compile). Structural equality only: an optimized-but-semantically-equal
 * result may legitimately differ structurally row-by-row — semantic
 * equivalence for RUN outcomes is `compareCanonical` over observables.
 */
export function toggleSweep({ canonical, apply, toggleNames } = {}) {
  if (typeof apply !== 'function') {
    fail('apply must be a function (toggles) => value', { field: 'apply' });
  }
  if (canonical === undefined) {
    fail('canonical reference value is required', { field: 'canonical' });
  }
  if (!Array.isArray(toggleNames) || toggleNames.length === 0) {
    fail('toggleNames must be a non-empty array of unique strings', { field: 'toggleNames' });
  }
  if (toggleNames.length > 8) {
    fail('toggleNames capped at 8 (≤ 256 subset rows — bounded by design)', { field: 'toggleNames', reason: 'too-many-toggles' });
  }
  for (const name of toggleNames) {
    if (typeof name !== 'string' || name.length === 0) {
      fail('toggleNames must be non-empty strings', { field: 'toggleNames' });
    }
    if (toggleNames.indexOf(name) !== toggleNames.lastIndexOf(name)) {
      fail(`duplicate toggle '${name}'`, { field: 'toggleNames', reason: 'duplicate-toggle', toggle: name });
    }
  }
  const subsetCount = 2 ** toggleNames.length;
  const rows = [];
  let allOffValue;
  for (let mask = 0; mask < subsetCount; mask += 1) {
    const toggles = {};
    for (let bit = 0; bit < toggleNames.length; bit += 1) {
      // mask bit 0 = toggle ON, 1 = OFF (so mask = all-1s is the all-off identity row)
      toggles[toggleNames[bit]] = (mask & (1 << bit)) === 0;
    }
    const value = apply(toggles);
    const offNames = toggleNames.filter((name) => toggles[name] === false);
    if (offNames.length === toggleNames.length) allOffValue = value;
    rows.push(Object.freeze({
      toggles: Object.freeze({ ...toggles }),
      off: Object.freeze([...offNames]),
      equivalentToCanonical: deepEqualStable(value, canonical),
    }));
  }
  const identityRecovered = allOffValue !== undefined && deepEqualStable(allOffValue, canonical);
  return Object.freeze({
    toggleNames: Object.freeze([...toggleNames]),
    rows: Object.freeze(rows),
    identityRecovered,
  });
}
