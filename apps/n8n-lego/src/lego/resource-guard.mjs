/**
 * Resource guard (P3 Slice M, Issues #75/#97 — required architecture #7
 * "enforced resource budgets").
 *
 * PUBLIC CONTRACT (`execution.guard`, v1.0.0, owner: agent-1, domain
 * execution): budgets are MANDATORY (fail-closed construction), admission
 * decisions follow five priority lanes under a three-tier pressure model,
 * and the guard holds NO clock — every observed quantity (concurrency, queue
 * depth, memory, elapsed/overdue time) is passed in by the caller as
 * observed state. Time-based policy is therefore reproducible and testable
 * without timers; the executor owns the tick, this module owns the rule.
 *
 * Budgets (Issue #75 #7): `memoryBytes`, `maxConcurrency`, `queueDepth`,
 * `outputBytes`, `timeoutMs`, `ioOps` — plus optional `pressureThresholds`
 * ({elevated, critical} ratios in (0,1], critical > elevated).
 *
 * Pressure tiers from observed/budget ratios (worst dimension wins):
 *   normal    ratio < elevated    → every lane admitted
 *   elevated  ratio ≥ elevated, < critical → system/interactive admit,
 *             background/bulk/deferred defer
 *   critical  ratio ≥ critical    → system admits (unless a HARD limit is
 *             exceeded), interactive/background defer, bulk/deferred reject
 *   HARD limits (observed ≥ 100% of a budget: queue full, concurrency cap,
 *   memory/output/io exhausted, overdue) → REJECT every lane — the
 *   backpressure wall (Issue #75 #3 bounded queue/backpressure). The system
 *   lane is never exempt from a HARD limit.
 *
 * Zero imports (purity scan); no executor, no clock, no scheduling loop —
 * admission is a pure decision given observed state.
 * Owner: agent-1 (Issue #98).
 */

/** The contract this module publishes. */
export const EXECUTION_GUARD_CONTRACT = Object.freeze({
  id: `execution.guard`,
  version: '1.0.0',
  owner: 'agent-1',
});

/** Pinned contract version for pin-style assertions. */
export const EXECUTION_GUARD_CONTRACT_VERSION = EXECUTION_GUARD_CONTRACT.version;

/** The five priority lanes, strict admission precedence (index 0 = highest). */
export const GUARD_LANES = Object.freeze([
  'system',
  'interactive',
  'background',
  'bulk',
  'deferred',
]);

/** The mandatory budget dimensions (Issue #75 #7 subset enforced here). */
export const GUARD_BUDGETS = Object.freeze([
  'memoryBytes',
  'maxConcurrency',
  'queueDepth',
  'outputBytes',
  'timeoutMs',
  'ioOps',
]);

/** Decisions a guard may return. */
export const GUARD_DECISIONS = Object.freeze(['admit', 'defer', 'reject']);

/** One error family for this module. */
export class ResourceGuardError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ResourceGuardError';
    this.code = 'lego.contract_violation';
    this.details = Object.freeze({ ...details });
  }
}

function fail(message, details) {
  throw new ResourceGuardError(message, details);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const DEFAULT_THRESHOLDS = Object.freeze({ elevated: 0.7, critical: 0.9 });

/**
 * Build a guard over MANDATORY budgets. Construction fails closed when a
 * required budget is missing, not a finite positive number, or thresholds
 * are out of range — an unbounded dimension is a budget that cannot hold.
 *
 * @param {object} budgets { memoryBytes, maxConcurrency, queueDepth,
 *   outputBytes, timeoutMs, ioOps, pressureThresholds? }
 * @returns {{ budgets, thresholds, admit, pressure, remaining }}
 */
export function createResourceGuard(budgets) {
  if (!isPlainObject(budgets)) {
    fail('budgets must be a plain object', { field: 'budgets' });
  }
  const frozen = {};
  for (const key of GUARD_BUDGETS) {
    const value = budgets[key];
    if (!Number.isFinite(value) || value <= 0) {
      fail(`budget '${key}' must be a finite number > 0 (budgets are mandatory)`, { field: 'budgets', budget: key });
    }
    frozen[key] = value;
  }
  let thresholds = DEFAULT_THRESHOLDS;
  if (budgets.pressureThresholds !== undefined) {
    const pt = budgets.pressureThresholds;
    if (!isPlainObject(pt)) {
      fail('pressureThresholds must be a plain object {elevated, critical}', { field: 'pressureThresholds' });
    }
    for (const key of ['elevated', 'critical']) {
      const v = pt[key];
      if (!Number.isFinite(v) || v <= 0 || v > 1) {
        fail(`pressureThresholds.${key} must be a finite number in (0, 1]`, { field: 'pressureThresholds', threshold: key });
      }
    }
    if (pt.critical <= pt.elevated) {
      fail('pressureThresholds.critical must be greater than elevated', { field: 'pressureThresholds' });
    }
    thresholds = Object.freeze({ elevated: pt.elevated, critical: pt.critical });
  }
  const known = new Set(GUARD_BUDGETS);
  for (const key of Object.keys(budgets)) {
    if (key === 'pressureThresholds') continue;
    if (!known.has(key)) {
      fail(`unknown budget '${key}'`, { field: 'budgets', reason: 'unknown-budget', budget: key });
    }
  }
  Object.freeze(frozen);

  function ratiosFor(observed) {
    if (!isPlainObject(observed)) {
      fail('observed must be a plain object of observed state (guard holds no clock)', { field: 'observed' });
    }
    const ratios = {};
    const dimOf = {
      memoryBytes: 'memoryBytes',
      maxConcurrency: 'activeConcurrency',
      queueDepth: 'queuedItems',
      outputBytes: 'outputBytes',
      timeoutMs: 'overdueMs',
      ioOps: 'ioOps',
    };
    for (const [budgetKey, observedKey] of Object.entries(dimOf)) {
      const value = observed[observedKey];
      if (value === undefined) {
        fail(`observed.${observedKey} is required (mandatory observation for budget '${budgetKey}')`, {
          field: 'observed', observedKey,
        });
      }
      if (!Number.isFinite(value) || value < 0) {
        fail(`observed.${observedKey} must be a finite number >= 0`, { field: 'observed', observedKey });
      }
      ratios[budgetKey] = value / frozen[budgetKey];
    }
    return ratios;
  }

  function pressure(observed) {
    const ratios = ratiosFor(observed);
    let worst = 'normal';
    for (const ratio of Object.values(ratios)) {
      if (ratio >= thresholds.critical) { worst = 'critical'; break; }
      if (ratio >= thresholds.elevated) worst = 'elevated';
    }
    return Object.freeze({ tier: worst, ratios: Object.freeze(ratios) });
  }

  function admit(lane, observed) {
    if (!GUARD_LANES.includes(lane)) {
      fail(`unknown lane '${lane}'`, { field: 'lane', reason: 'unknown-lane', lane });
    }
    const ratios = ratiosFor(observed);
    // HARD limit first: observed ≥ 100% of any budget (or overdue) = wall.
    let hardBudget = null;
    for (const key of GUARD_BUDGETS) {
      if (ratios[key] >= 1) { hardBudget = key; break; }
    }
    let tier = 'normal';
    for (const ratio of Object.values(ratios)) {
      if (ratio >= thresholds.critical) { tier = 'critical'; break; }
      if (ratio >= thresholds.elevated) tier = 'elevated';
    }
    if (hardBudget !== null) {
      return Object.freeze({
        decision: 'reject',
        lane,
        pressure: tier,
        hardLimit: hardBudget,
        reason: `budget '${hardBudget}' exhausted — backpressure wall`,
      });
    }
    if (tier === 'normal') {
      return Object.freeze({ decision: 'admit', lane, pressure: tier, hardLimit: null, reason: 'within budgets' });
    }
    if (lane === 'system') {
      return Object.freeze({ decision: 'admit', lane, pressure: tier, hardLimit: null, reason: 'system lane admitted while budgets hold' });
    }
    if (tier === 'elevated') {
      if (lane === 'interactive') {
        return Object.freeze({ decision: 'admit', lane, pressure: tier, hardLimit: null, reason: 'elevated: interactive keeps precedence' });
      }
      return Object.freeze({ decision: 'defer', lane, pressure: tier, hardLimit: null, reason: 'elevated: yielding until pressure recedes' });
    }
    // critical
    if (lane === 'interactive' || lane === 'background') {
      return Object.freeze({ decision: 'defer', lane, pressure: tier, hardLimit: null, reason: 'critical: deferring until pressure recedes' });
    }
    return Object.freeze({
      decision: 'reject',
      lane,
      pressure: tier,
      hardLimit: null,
      reason: 'critical: bulk/deferred rejected to protect the working set',
    });
  }

  function remaining(observed) {
    const ratios = ratiosFor(observed);
    const remainingValues = {};
    const dimOf = {
      memoryBytes: 'memoryBytes', maxConcurrency: 'activeConcurrency', queueDepth: 'queuedItems',
      outputBytes: 'outputBytes', timeoutMs: 'overdueMs', ioOps: 'ioOps',
    };
    for (const key of GUARD_BUDGETS) {
      const observedKey = dimOf[key];
      // remaining headroom in budget units (negative = over budget)
      remainingValues[key] = frozen[key] - (ratios[key] * frozen[key]);
      void observedKey;
    }
    return Object.freeze(remainingValues);
  }

  return Object.freeze({
    budgets: frozen,
    thresholds,
    admit,
    pressure,
    remaining,
  });
}
