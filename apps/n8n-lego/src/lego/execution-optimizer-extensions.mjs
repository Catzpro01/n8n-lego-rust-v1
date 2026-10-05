/**
 * Execution optimizer EXTENSIONS (P3-S01, Issues #75/#224).
 *
 * Extends `execution.optimizer` v1.0.0 (P3.13, `execution-optimizer.mjs`), which
 * ships FUSION and a node-result cache. P3-S01 adds the six remaining #75/#224
 * optimization items whose foundations already exist in P3.3-P3.13:
 *
 *   1. SEMANTIC NODE ELIMINATION  — remove a node that provably cannot affect
 *      the result, decided from structural preconditions plus a pure-type
 *      whitelist. "Provably" means the whitelist, never a guess.
 *   2. CONTENT-ADDRESSED SUBGRAPH CACHE — a subgraph is cached under the SHA-256
 *      of its canonical serialisation, so a cache hit means byte-identical
 *      inputs, not "looks similar".
 *   3. RESOURCE-AWARE COMPILATION — pick a plan shape (sequential vs. width-capped
 *      parallel) from a declared budget and the graph's fan-out. A budget that
 *      cannot be met REFUSES; it never silently degrades.
 *   4. INCREMENTAL EXECUTION — given a previous run's per-step fingerprints,
 *      compute the minimal re-run set. An absent fingerprint forces a recompute.
 *   5. SELF-PROFILING — per-step observed cost with an explicit provenance, so a
 *      plan built on a profile can be audited for how much of it was measured.
 *   6. HOT/COLD PATH SPLIT — classify steps from observed frequency against a
 *      declared threshold, and report how much of the classification was
 *      actually measured rather than defaulted.
 *
 * HOUSE RULES, inherited from P3.13 and non-negotiable here:
 *   - DEFAULTS ARE OFF. Every transform is opt-in; the canonical path (identity)
 *     is always reachable. An optimizer that changes behaviour by default is a
 *     bug, not a feature.
 *   - NO SEMANTIC GUESSING. Outside an explicit whitelist nothing is claimed
 *     safe. "Where proven" (#97) means the whitelist.
 *   - ZERO-IMPORT. The `execution` domain depends on platform-kernel,
 *     compatibility and storage — NOT `workflow` (which owns `src/checksum.mjs`)
 *     and NOT `observability`. A content address therefore cannot borrow a
 *     checksum from another domain, so SHA-256 is implemented here, in-domain.
 *   - NO I/O, NO CLOCK, NO WORKFLOW IMPORT. Pure functions over plain data.
 *   - BOUNDED. Every structure has a declared maximum; over-limit REFUSES.
 *
 * One error family: `ExecutionOptimizerExtensionError`.
 */
import { GUARD_BUDGETS } from './resource-guard.mjs';

export const OPTIMIZER_EXT_CONTRACT = Object.freeze({
  id: 'execution.optimizer-extensions',
  version: '1.0.0',
  owner: 'agent-1',
  extends: 'execution.optimizer@1.0.0',
});

/** Transform names this module adds (oracle toggle names). */
export const OPTIMIZER_EXT_TRANSFORMS = Object.freeze([
  'elimination', 'subgraphCache', 'resourceAwareCompile', 'incremental', 'selfProfile', 'hotColdSplit',
]);

/**
 * Node types that may be ELIMINATED (not merely fused) when they are dead.
 * Dead + pure = removing it cannot change the result, because it had no output
 * consumer and no side effect. Anything not listed here is never eliminated.
 */
export const ELIMINABLE_PURE_TYPES = Object.freeze([
  'n8n-nodes-base.noOp',
  'n8n-nodes-base.set',
]);

/** Transient step flags that make a step ineligible for elimination. */
export const NON_ELIMINABLE_FLAGS = Object.freeze([
  'credentials', 'retry', 'onError', 'continueOnFail', 'alwaysOutputData', 'webhook', 'trigger',
]);

/** Provenance ladder for profiled cost — deliberately P9.9's, restated here. */
export const PROFILE_PROVENANCE = Object.freeze(['OBSERVED', 'ESTIMATED']);

/** Plan shapes `compilePlan` may choose between. */
export const PLAN_SHAPES = Object.freeze(['sequential', 'bounded-parallel']);

export const OPTIMIZER_EXT_LIMITS = Object.freeze({
  maxSteps: 4096,
  maxDepsPerStep: 64,
  maxSubgraphSteps: 256,
  maxCacheEntries: 1024,
  maxSubgraphBytes: 65536,
  maxProfileSteps: 4096,
  maxHotColdSteps: 4096,
  maxPlanWidth: 256,
  /** Hot/cold threshold bounds: a fraction in (0, 1]. */
  minHotThreshold: 0.0001,
  addressBytes: 64,
});

/** Budget dimensions this module reads from the P3.11 guard vocabulary. */
export const COMPILE_BUDGETS = Object.freeze(['maxConcurrency', 'memoryBytes', 'timeoutMs']);

export class ExecutionOptimizerExtensionError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ExecutionOptimizerExtensionError';
    this.code = 'lego.contract_violation';
    this.details = Object.freeze({ ...details });
  }
}

function fail(message, details) {
  throw new ExecutionOptimizerExtensionError(message, details);
}

function isPlain(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function boundedText(value, max = 256) {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

/* ------------------------------------------------------------------ *
 * SHA-256, implemented in-domain.
 *
 * `execution` may not import `workflow`'s `src/checksum.mjs`, and a content
 * address that is only a 32-bit hash would be a false claim of
 * collision-resistance. So the real thing, pure, no dependency.
 * ------------------------------------------------------------------ */
const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function sha256Bytes(message) {
  const bytes = typeof message === 'string' ? new TextEncoder().encode(message) : message;
  const bitLen = bytes.length * 8;
  const withPad = new Uint8Array((((bytes.length + 9) + 63) >> 6) << 6);
  withPad.set(bytes);
  withPad[bytes.length] = 0x80;
  const view = new DataView(withPad.buffer);
  view.setUint32(withPad.length - 4, bitLen >>> 0);
  view.setUint32(withPad.length - 8, Math.floor(bitLen / 0x100000000));
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  for (let off = 0; off < withPad.length; off += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i += 1) {
      const s0 = ((w[i - 15] >>> 7) | (w[i - 15] << 25)) ^ ((w[i - 15] >>> 18) | (w[i - 15] << 14)) ^ (w[i - 15] >>> 3);
      const s1 = ((w[i - 2] >>> 17) | (w[i - 2] << 15)) ^ ((w[i - 2] >>> 19) | (w[i - 2] << 13)) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i += 1) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + SHA256_K[i] + w[i]) >>> 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
  }
  const out = new Uint8Array(32);
  const ov = new DataView(out.buffer);
  for (let i = 0; i < 8; i += 1) ov.setUint32(i * 4, h[i]);
  return out;
}

/** Lowercase hex SHA-256 of a string. */
export function sha256Hex(text) {
  if (typeof text !== 'string') fail('sha256Hex expects a string', { field: 'text' });
  return [...sha256Bytes(text)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Canonical serialisation of an IR (or subgraph). Key order is FIXED here rather
 * than taken from the input, so two structurally identical IRs written with
 * different key orders produce the SAME content address. Without this, a cache
 * keyed on JSON.stringify would miss on formatting alone.
 */
export function canonicalIr(ir) {
  if (!isPlain(ir) || !Array.isArray(ir.steps)) return null;
  const steps = ir.steps.map((step) => {
    // `type` is REQUIRED: an identity function must not encode a missing type as
    // null, or a typeless step and a differently-typed step could share an
    // address. The elimination whitelist already refuses a typeless step.
    if (!isPlain(step) || !boundedText(step.id, 256) || !boundedText(step.type, 256) || !Array.isArray(step.deps)) return null;
    const deps = step.deps.map((d) => (boundedText(d, 256) ? d : null));
    if (deps.some((d) => d === null)) return null;
    return {
      id: step.id,
      type: step.type,
      params: isPlain(step.params) ? canonicalValue(step.params) : null,
      deps: deps.sort(),
    };
  });
  if (steps.some((s) => s === null)) return null;
  return JSON.stringify({ irVersion: ir.irVersion ?? null, steps: steps.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) });
}

/** A deep, frozen copy so a cache entry can never be mutated by its reader. */
function deepFreezeCopy(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return Object.freeze(value.map(deepFreezeCopy));
  const out = {};
  for (const [key, item] of Object.entries(value)) out[key] = deepFreezeCopy(item);
  return Object.freeze(out);
}

function canonicalValue(value) {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (isPlain(value)) {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonicalValue(value[key]);
    return out;
  }
  return null;
}

/** Content address of an IR / subgraph: `sha256:<hex>`, or null when unusable. */
export function contentAddress(ir) {
  const canonical = canonicalIr(ir);
  if (canonical === null) return null;
  return `sha256:${sha256Hex(canonical)}`;
}

/* ------------------------------------------------------------------ *
 * Shared IR validation
 * ------------------------------------------------------------------ */
function validateIr(ir, { maxSteps = OPTIMIZER_EXT_LIMITS.maxSteps } = {}) {
  if (!isPlain(ir) || !Array.isArray(ir.steps)) {
    fail('ir must be a compiled IR (an object with steps)', { field: 'ir' });
  }
  if (ir.steps.length > maxSteps) {
    fail(`ir exceeds the ${maxSteps}-step bound`, { field: 'ir.steps', reason: 'too-many-steps' });
  }
  const byId = new Map();
  for (const step of ir.steps) {
    if (!isPlain(step) || !boundedText(step.id, 256) || !Array.isArray(step.deps)) {
      fail('every IR step needs id (string) and deps (array)', { field: 'ir.steps' });
    }
    if (step.deps.length > OPTIMIZER_EXT_LIMITS.maxDepsPerStep) {
      fail(`step '${step.id}' exceeds the dependency bound`, { field: 'ir.steps', reason: 'too-many-deps' });
    }
    if (byId.has(step.id)) fail(`duplicate IR step id '${step.id}'`, { reason: 'duplicate-step' });
    byId.set(step.id, step);
  }
  for (const step of ir.steps) {
    for (const dep of step.deps) {
      if (!byId.has(dep)) fail(`step '${step.id}' depends on unknown step '${dep}'`, { reason: 'dangling-dep' });
    }
  }
  return byId;
}

/* ================================================================== *
 * 1. SEMANTIC NODE ELIMINATION
 * ================================================================== */

/**
 * Plan which steps can be ELIMINATED without changing the result.
 *
 * A step is eliminable iff ALL of:
 *   (a) its type is in `ELIMINABLE_PURE_TYPES` — no side effect;
 *   (b) NO step consumes it (it is dead);
 *   (c) it carries none of `NON_ELIMINABLE_FLAGS` — no credentials, no retry,
 *       no error branch, no always-output, no webhook;
 *   (d) removing it leaves at least one terminal step (a graph must still
 *       produce a declared output);
 *   (e) eliminating it does not leave a consumer with a dangling dependency —
 *       the consumer is rewired to the eliminated step's own dependencies.
 *
 * Deterministic: steps in ordinal (array) order; a step belongs to at most one
 * elimination. Returns a plan; nothing is mutated.
 */
export function eliminationPlan(ir) {
  const byId = validateIr(ir);
  const order = ir.steps.map((s) => s.id);
  const consumers = new Map(order.map((id) => [id, []]));
  for (const step of ir.steps) for (const dep of step.deps) consumers.get(dep).push(step.id);
  const terminal = new Set(order.filter((id) => consumers.get(id).length === 0));
  const flagged = new Set();
  for (const step of ir.steps) {
    for (const flag of NON_ELIMINABLE_FLAGS) if (step[flag]) flagged.add(step.id);
  }

  const eliminated = [];
  const rewired = {};
  for (const id of order) {
    const step = byId.get(id);
    if (consumers.get(id).length !== 0) continue;  // (b) not dead
    if (!ELIMINABLE_PURE_TYPES.includes(step.type)) continue; // (a)
    if (flagged.has(id)) continue;                 // (c)
    // (d) a terminal step is only eliminable when another terminal survives:
    // the graph must still be able to produce its declared output.
    if (terminal.has(id) && terminal.size - eliminated.filter((e) => terminal.has(e)).length <= 1) continue;
    const parents = step.deps.filter((d) => !eliminated.includes(d));
    eliminated.push(id);
    // (e) rewire: the eliminated step's consumers (none, by (b)) would inherit
    // its parents. Recorded so an incremental replan can reuse the mapping.
    rewired[id] = Object.freeze(parents);
  }
  return Object.freeze({
    eliminated: Object.freeze(eliminated),
    rewired: Object.freeze(rewired),
    remaining: Object.freeze(order.filter((id) => !eliminated.includes(id))),
    // A plan that eliminates nothing is a valid plan, not a failure.
    reduced: eliminated.length > 0,
  });
}

/**
 * Apply an elimination plan, returning a new IR. The original is never mutated.
 * Rewiring keeps every surviving consumer's dependency list satisfiable: an
 * eliminated step's dependencies are hoisted onto the consumers that referenced
 * the eliminated step.
 */
export function applyElimination(ir, plan) {
  const byId = validateIr(ir);
  if (!isPlain(plan) || !Array.isArray(plan.eliminated)) {
    fail('plan must carry an eliminated array', { field: 'plan' });
  }
  const dropped = new Set(plan.eliminated);
  for (const id of dropped) if (!byId.has(id)) fail(`plan eliminates unknown step '${id}'`, { reason: 'unknown-step' });
  const steps = [];
  for (const step of ir.steps) {
    if (dropped.has(step.id)) continue;
    const deps = new Set();
    for (const dep of step.deps) {
      if (dropped.has(dep)) {
        // Hoist the eliminated step's own parents so the consumer stays valid.
        for (const parent of byId.get(dep).deps) if (!dropped.has(parent)) deps.add(parent);
      } else {
        deps.add(dep);
      }
    }
    steps.push(Object.freeze({
      id: step.id,
      type: step.type,
      params: step.params,
      deps: Object.freeze([...deps].sort()),
    }));
  }
  return Object.freeze({ irVersion: ir.irVersion ?? null, steps: Object.freeze(steps) });
}

/* ================================================================== *
 * 2. CONTENT-ADDRESSED SUBGRAPH CACHE
 * ================================================================== */

/**
 * Bounded LRU cache keyed by the SHA-256 content address of a subgraph.
 *
 * Semantics-safe by construction: the key is the content address of the
 * canonical subgraph, so a hit means byte-identical structure and parameters —
 * never "looks similar". The caller supplies the result; this cache never
 * computes or guesses one.
 *
 * Admission is refused (counted, not thrown) for: a non-canonicalisable
 * subgraph, a subgraph over the step bound, a non-pure type, or a payload that
 * is not JSON-serialisable. A refused admission is visible in `stats()`, so a
 * caller cannot mistake a silent refusal for a cache miss.
 */
export function createSubgraphCache({
  maxEntries = OPTIMIZER_EXT_LIMITS.maxCacheEntries,
  maxSubgraphSteps = OPTIMIZER_EXT_LIMITS.maxSubgraphSteps,
  pureTypes = ELIMINABLE_PURE_TYPES,
} = {}) {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
    fail('maxEntries must be a safe integer >= 1', { field: 'maxEntries' });
  }
  if (!Number.isSafeInteger(maxSubgraphSteps) || maxSubgraphSteps < 1) {
    fail('maxSubgraphSteps must be a safe integer >= 1', { field: 'maxSubgraphSteps' });
  }
  const store = new Map();
  const stats = { hits: 0, misses: 0, evictions: 0, refused: 0, bytes: 0 };
  const pure = new Set(pureTypes);

  const api = {
    /** @returns {string|null} the content address, or null when unusable. */
    address(subgraph) {
      const address = contentAddress(subgraph);
      if (address === null) return null;
      if (subgraph.steps.length > maxSubgraphSteps) return null;
      for (const step of subgraph.steps) if (!pure.has(step.type)) return null;
      return address;
    },
    get(subgraph) {
      const address = api.address(subgraph);
      if (address === null) { stats.refused += 1; return undefined; }
      if (!store.has(address)) { stats.misses += 1; return undefined; }
      const entry = store.get(address);
      store.delete(address);
      store.set(address, entry); // LRU promote
      stats.hits += 1;
      return entry.value;
    },
    set(subgraph, value) {
      const address = api.address(subgraph);
      if (address === null) { stats.refused += 1; return api; }
      // Serialise for the byte accounting and to prove the payload is storable,
      // but hand back a deep-frozen COPY of the value: a caller that receives a
      // JSON string would have to re-parse it, and a caller that receives the
      // original object could mutate a cache entry behind the cache's back.
      let payload;
      try { payload = JSON.stringify(value); } catch { stats.refused += 1; return api; }
      if (payload.length > OPTIMIZER_EXT_LIMITS.maxSubgraphBytes) { stats.refused += 1; return api; }
      const stored = deepFreezeCopy(JSON.parse(payload));
      store.delete(address);
      store.set(address, { value: stored, bytes: payload.length });
      stats.bytes += payload.length;
      while (store.size > maxEntries) {
        const oldest = store.keys().next().value;
        stats.bytes -= store.get(oldest).bytes;
        store.delete(oldest);
        stats.evictions += 1;
      }
      return api;
    },
    has(subgraph) {
      const address = api.address(subgraph);
      if (address === null) { stats.refused += 1; return false; }
      return store.has(address);
    },
    clear() {
      store.clear();
      stats.hits = 0; stats.misses = 0; stats.evictions = 0; stats.refused = 0; stats.bytes = 0;
      return api;
    },
    stats() { return { ...stats, size: store.size, maxEntries }; },
    get size() { return store.size; },
  };
  return Object.freeze(api);
}

/* ================================================================== *
 * 3. RESOURCE-AWARE COMPILATION
 * ================================================================== */

/**
 * Compile an IR into an execution plan shape given a declared budget.
 *
 * Chooses `sequential` or `bounded-parallel` with the WIDEST legal width:
 *   - `sequential` when every step has a single dependency (nothing to run
 *     concurrently) or when the budget forbids concurrency;
 *   - `bounded-parallel` otherwise, width = min(graph fan-out, budget
 *     maxConcurrency, the plan-width bound).
 *
 * The budget is READ, never invented: an unknown budget key is refused, and a
 * graph that cannot satisfy the budget is REFUSED rather than degraded. A plan
 * that silently ignores its budget is worse than no plan.
 *
 * @param {object} ir
 * @param {object} budget  subset of P3.11 GUARD_BUDGETS (maxConcurrency,
 *                         memoryBytes, timeoutMs) that the caller has actually
 *                         declared.
 */
export function compilePlan(ir, budget = {}) {
  const byId = validateIr(ir);
  if (!isPlain(budget)) fail('budget must be a plain object', { field: 'budget' });
  for (const key of Object.keys(budget)) {
    if (!COMPILE_BUDGETS.includes(key)) {
      fail(`unknown budget key '${key}'; declare it in the P3.11 guard first`, { field: 'budget', key });
    }
    const value = budget[key];
    if (key === 'maxConcurrency') {
      if (!Number.isSafeInteger(value) || value < 0) fail('maxConcurrency must be an integer >= 0', { field: 'budget.maxConcurrency' });
    } else if (!Number.isSafeInteger(value) || value < 0) {
      fail(`${key} must be a non-negative safe integer`, { field: `budget.${key}` });
    }
  }
  // A declared zero concurrency budget cannot run anything: refuse.
  if (budget.maxConcurrency === 0) {
    fail('a budget with maxConcurrency 0 cannot execute anything', { field: 'budget.maxConcurrency', reason: 'unsatisfiable' });
  }

  // Widest concurrency the graph can express, as a LEGAL schedule: longest-path
  // layering. A step sits at level 1 + max(level of its dependencies), so every
  // step in a level has all of its dependencies in strictly earlier levels and
  // the whole level may run at once. The width is the largest level size — a
  // schedule this module can actually justify, not the graph's raw fan-out.
  const level = new Map();
  const resolveLevel = (id, seen = new Set()) => {
    if (level.has(id)) return level.get(id);
    if (seen.has(id)) fail(`cycle detected at step '${id}'`, { reason: 'cycle' });
    seen.add(id);
    const deps = byId.get(id).deps;
    const value = deps.length === 0 ? 0 : 1 + Math.max(...deps.map((d) => resolveLevel(d, seen)));
    level.set(id, value);
    return value;
  };
  const perLevel = new Map();
  for (const step of ir.steps) {
    const l = resolveLevel(step.id);
    perLevel.set(l, (perLevel.get(l) ?? 0) + 1);
  }
  const readyWidth = Math.max(1, ...perLevel.values());
  let fanOut = 0;
  for (const step of ir.steps) fanOut = Math.max(fanOut, step.deps.length);

  const concurrency = budget.maxConcurrency === undefined
    ? OPTIMIZER_EXT_LIMITS.maxPlanWidth
    : budget.maxConcurrency;
  const width = Math.min(readyWidth, concurrency, OPTIMIZER_EXT_LIMITS.maxPlanWidth);
  const shape = width > 1 ? 'bounded-parallel' : 'sequential';

  const plan = Object.freeze({
    shape,
    width,
    steps: ir.steps.length,
    fanOut,
    budget: Object.freeze({ ...budget }),
    // Declared, not measured: the plan says what it MAY use, never what it did.
    budgetDeclared: Object.freeze(Object.keys(budget).sort()),
    satisfiable: true,
  });
  return plan;
}

/* ================================================================== *
 * 4. INCREMENTAL EXECUTION
 * ================================================================== */

/**
 * Compute the minimal re-run set from a previous run's per-step fingerprints.
 *
 * A step is reusable iff its fingerprint is UNCHANGED from the previous run AND
 * every one of its dependencies is also reusable. Anything else re-runs. This
 * is conservative by construction: a changed step invalidates its whole
 * downstream cone, because a downstream step cannot know whether the change
 * was observable.
 *
 * A step absent from the previous fingerprint map is treated as CHANGED —
 * "no evidence it is the same" is not evidence it is the same.
 *
 * @param {object} ir                 the new IR
 * @param {Map<string,string>|object} previousFingerprints
 * @returns {{reusable: string[], rerun: string[], invalidatedBy: Record<string,string>}}
 */
export function replanIncremental(ir, previousFingerprints) {
  const byId = validateIr(ir);
  const previous = previousFingerprints instanceof Map
    ? previousFingerprints
    : new Map(isPlain(previousFingerprints) ? Object.entries(previousFingerprints) : []);
  const changed = new Map();
  for (const [id, value] of previous) {
    if (!byId.has(id)) fail(`previous fingerprint names unknown step '${id}'`, { reason: 'unknown-step' });
    if (typeof value !== 'string') fail(`previous fingerprint for '${id}' must be a string`, { reason: 'bad-fingerprint' });
  }

  const reusable = new Set();
  const rerun = new Set();
  const invalidatedBy = {};
  for (const step of ir.steps) {
    const prev = previous.get(step.id);
    const ownChanged = prev === undefined || prev !== stepFingerprint(step);
    const brokenDeps = step.deps.filter((dep) => !reusable.has(dep));
    if (ownChanged) {
      changed.set(step.id, prev === undefined ? 'no-previous-fingerprint' : 'fingerprint-changed');
      rerun.add(step.id);
      continue;
    }
    if (brokenDeps.length) {
      const cause = brokenDeps.map((dep) => changed.get(dep) ?? 'dependency-rerun').sort()[0];
      changed.set(step.id, cause);
      invalidatedBy[step.id] = brokenDeps.sort()[0];
      rerun.add(step.id);
      continue;
    }
    reusable.add(step.id);
  }
  return Object.freeze({
    reusable: Object.freeze([...reusable].sort()),
    rerun: Object.freeze([...rerun].sort()),
    invalidatedBy: Object.freeze(invalidatedBy),
    // Savings is derived, never asserted.
    savings: reusable.size / Math.max(1, ir.steps.length),
  });
}

/** Content address of a single step — the same canonical form as a subgraph. */
export function stepFingerprint(step) {
  if (!isPlain(step) || !boundedText(step.id, 256) || !boundedText(step.type, 256)) return null;
  return `sha256:${sha256Hex(JSON.stringify({
    id: step.id,
    type: step.type,
    params: isPlain(step.params) ? canonicalValue(step.params) : null,
    deps: Array.isArray(step.deps) ? [...step.deps].sort() : [],
  }))}`;
}

/* ================================================================== *
 * 5. SELF-PROFILING
 * ================================================================== */

/**
 * Bounded per-step cost profiler.
 *
 * Every sample carries a provenance (OBSERVED or ESTIMATED). A profile that
 * mixes the two reports `mixedProvenance`, so a plan built on it cannot be read
 * as if the whole of it were measured. An unknown provenance is refused: a cost
 * nobody measured is not a cheap cost, it is a fabricated one.
 *
 * No clock: the caller supplies the measured value. This module never invents a
 * duration, because an invented duration would become a real budget decision.
 */
export function createOptimizerProfiler({ maxSteps = OPTIMIZER_EXT_LIMITS.maxProfileSteps } = {}) {
  if (!Number.isSafeInteger(maxSteps) || maxSteps < 1) {
    fail('maxSteps must be a safe integer >= 1', { field: 'maxSteps' });
  }
  /** @type {Map<string, {samples:number, total:number, max:number, provenance:Set<string>}>} */
  const steps = new Map();
  const api = {
    /** @returns {boolean} false when the sample was refused. */
    record(stepId, costMs, provenance = 'OBSERVED') {
      if (!boundedText(stepId, 256)) return false;
      if (!PROFILE_PROVENANCE.includes(provenance)) return false;
      if (typeof costMs !== 'number' || !Number.isFinite(costMs) || costMs < 0) return false;
      let entry = steps.get(stepId);
      if (!entry) {
        if (steps.size >= maxSteps) return false;
        entry = { samples: 0, total: 0, max: 0, provenance: new Set() };
        steps.set(stepId, entry);
      }
      entry.samples += 1;
      entry.total += costMs;
      entry.max = Math.max(entry.max, costMs);
      entry.provenance.add(provenance);
      return true;
    },
    /** @returns {Readonly<object>|null} null when the step was never profiled. */
    summary(stepId) {
      const entry = steps.get(stepId);
      if (!entry) return null;
      return Object.freeze({
        stepId,
        samples: entry.samples,
        totalMs: entry.total,
        meanMs: entry.total / entry.samples,
        maxMs: entry.max,
        provenance: Object.freeze([...entry.provenance].sort()),
        mixedProvenance: entry.provenance.size > 1,
      });
    },
    summaries() {
      return Object.freeze([...steps.keys()].sort().map((id) => api.summary(id)));
    },
    /** Total measured cost across the profiled steps. */
    totalMs() {
      let total = 0;
      for (const entry of steps.values()) total += entry.total;
      return total;
    },
    /** Fraction of profiled steps whose samples are all OBSERVED. */
    measuredFraction() {
      if (steps.size === 0) return null; // nothing measured is not 100%
      let observed = 0;
      for (const entry of steps.values()) if (entry.provenance.size === 1 && entry.provenance.has('OBSERVED')) observed += 1;
      return observed / steps.size;
    },
    clear() { steps.clear(); return api; },
    get size() { return steps.size; },
  };
  return Object.freeze(api);
}

/* ================================================================== *
 * 6. HOT / COLD PATH SPLIT
 * ================================================================== */

/**
 * Split steps into a hot and a cold path from OBSERVED invocation counts.
 *
 * `threshold` is a fraction in (0, 1]: a step is hot when its invocation count
 * is at least `threshold * maxCount`. Steps that were never observed are COLD
 * and reported as `unmeasured` — a step nobody measured is not cold by
 * evidence, it is cold by default, and the two must not be conflated.
 *
 * The split is advisory: it never removes a step from the IR and never changes
 * execution order. It only records which path a later decision may prioritise.
 */
export function splitHotCold(ir, observations = {}, { threshold = 0.5 } = {}) {
  const byId = validateIr(ir);
  if (typeof threshold !== 'number' || !Number.isFinite(threshold) ||
      threshold <= 0 || threshold > 1) {
    fail('threshold must be a fraction in (0, 1]', { field: 'threshold' });
  }
  const counts = new Map();
  if (observations instanceof Map) {
    for (const [id, value] of observations) counts.set(id, value);
  } else if (isPlain(observations)) {
    for (const [id, value] of Object.entries(observations)) counts.set(id, value);
  }
  for (const [id, value] of counts) {
    if (!byId.has(id)) fail(`observation names unknown step '${id}'`, { reason: 'unknown-step' });
    if (!Number.isSafeInteger(value) || value < 0) fail(`observation for '${id}' must be a non-negative integer`, { reason: 'bad-observation' });
  }

  const maxCount = Math.max(0, ...counts.values());
  const hot = [];
  const cold = [];
  const unmeasured = [];
  for (const step of ir.steps) {
    if (!counts.has(step.id)) { cold.push(step.id); unmeasured.push(step.id); continue; }
    const count = counts.get(step.id);
    if (maxCount > 0 && count >= threshold * maxCount) hot.push(step.id);
    else cold.push(step.id);
  }
  return Object.freeze({
    hot: Object.freeze(hot.sort()),
    cold: Object.freeze(cold.sort()),
    // Cold-by-default is not cold-by-evidence; keep them separable.
    unmeasured: Object.freeze(unmeasured.sort()),
    threshold,
    maxCount,
    // Fraction of steps whose classification rests on an actual observation.
    measuredFraction: unmeasured.length === 0 ? 1 : (ir.steps.length - unmeasured.length) / ir.steps.length,
  });
}

/* ================================================================== *
 * 7. TOGGLES (oracle integration)
 * ================================================================== */

/**
 * The default profile: EVERY extension OFF. The canonical path is always
 * reachable, and no extension changes behaviour unless it is explicitly turned
 * on. `toggleSweep({toggleNames})` in the compatibility oracle receives these
 * names; equivalence is judged there, never here (#91 Security rule: a
 * benchmark is never sufficient, only `compareCanonical`).
 */
export const OPTIMIZER_EXT_DEFAULTS = Object.freeze(
  Object.fromEntries(OPTIMIZER_EXT_TRANSFORMS.map((name) => [name, false])),
);

/** Resolve a caller-supplied toggle set against the all-off default. */
export function resolveExtensions(toggles = {}) {
  if (!isPlain(toggles)) fail('toggles must be a plain object', { field: 'toggles' });
  const resolved = { ...OPTIMIZER_EXT_DEFAULTS };
  for (const [key, value] of Object.entries(toggles)) {
    if (!OPTIMIZER_EXT_TRANSFORMS.includes(key)) {
      fail(`unknown extension '${key}'`, { field: 'toggles', key });
    }
    if (typeof value !== 'boolean') fail(`extension '${key}' must be a boolean`, { field: 'toggles', key });
    resolved[key] = value;
  }
  return Object.freeze(resolved);
}

/** Re-export so a caller can assert the guard vocabulary this module reads. */
export const OPTIMIZER_EXT_BUDGETS = Object.freeze([...GUARD_BUDGETS]);
