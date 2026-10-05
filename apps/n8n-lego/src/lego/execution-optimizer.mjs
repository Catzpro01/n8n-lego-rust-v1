/**
 * Execution optimizer (P3 Slice K, Issues #75/#97 — "semantics-safe node
 * fusion/elimination/caching WHERE PROVEN").
 *
 * PUBLIC CONTRACT (`execution.optimizer`, v1.0.0, owner: agent-1, domain
 * execution). Zero-import (purity scan); the compatibility domain's oracle
 * receives these transforms through callbacks — equivalence is judged there
 * (#91 Security rule: a benchmark is never sufficient, only `compareCanonical`).
 *
 * WHAT IS PROVEN SAFE HERE (structural preconditions only — no semantic
 * guessing beyond the whitelist):
 *
 *   - FUSION: chain `A → B` collapses iff (1) B is A's ONLY consumer,
 *     (2) A is B's ONLY dependency, (3) BOTH types are in the explicit
 *     pure whitelist (`n8n-nodes-base.noOp`, `n8n-nodes-base.set`), (4) no
 *     cycle introduction (single-consumer/single-dep pairs cannot create one
 *     when collapsed head-ward). Anything outside the whitelist is NOT
 *     claimed fusible — "where proven" means the whitelist, not vibes.
 *   - ELIMINATION: noOp pass-through already lives in `execution.ir`
 *     (`noopPassthrough` toggle, all-off = canonical identity). This module
 *     reuses that contract through the caller (it never re-implements it).
 *   - CACHING: node-result cache admits ONLY whitelisted pure types, ONLY
 *     with an exact input fingerprint match (miss = recompute), bounded LRU,
 *     fail-closed config. Semantics-safe = exact-key or nothing.
 *
 * Defaults are OFF (optimizer transforms are opt-in; the canonical path is
 * always reachable) and every transform is independently disableable via the
 * oracle's `toggleSweep({toggleNames: ['fusion']})`.
 *
 * One error family: `ExecutionOptimizerError`.
 * Owner: agent-1 (Issue #98).
 */

/** The contract this module publishes. */
export const EXECUTION_OPTIMIZER_CONTRACT = Object.freeze({
  id: `execution.optimizer`,
  version: '1.0.0',
  owner: 'agent-1',
});

/** Pinned contract version for pin-style assertions. */
export const EXECUTION_OPTIMIZER_CONTRACT_VERSION = EXECUTION_OPTIMIZER_CONTRACT.version;

/**
 * The ONLY node types this module claims fusion/caching-safe (Issue #97
 * "where proven"): noOp (no side effect) and set (pure parameter copy).
 * Everything else — http, code, credentials-bearing nodes — is never
 * fused or cached by this module.
 */
export const OPTIMIZER_PURE_TYPES = Object.freeze([
  'n8n-nodes-base.noOp',
  'n8n-nodes-base.set',
]);

/** Transform names this module supports (oracle toggle names). */
export const OPTIMIZER_TRANSFORMS = Object.freeze(['fusion']);

/** One error family for this module. */
export class ExecutionOptimizerError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ExecutionOptimizerError';
    this.code = 'lego.contract_violation';
    this.details = Object.freeze({ ...details });
  }
}

function fail(message, details) {
  throw new ExecutionOptimizerError(message, details);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertIr(ir) {
  if (!isPlainObject(ir) || ir.irVersion !== 1 || !Array.isArray(ir.steps)) {
    fail('ir must be a compiled IR (irVersion 1 with steps)', { field: 'ir' });
  }
  const byId = new Map();
  for (const step of ir.steps) {
    if (!isPlainObject(step) || typeof step.id !== 'string' || !Array.isArray(step.deps)) {
      fail('every IR step needs id and deps', { field: 'ir' });
    }
    if (byId.has(step.id)) {
      fail(`duplicate IR step id '${step.id}'`, { field: 'ir', reason: 'duplicate-step' });
    }
    byId.set(step.id, step);
  }
  for (const step of ir.steps) {
    for (const dep of step.deps) {
      if (!byId.has(dep)) {
        fail(`step '${step.id}' depends on unknown step '${dep}'`, { field: 'ir', reason: 'dangling-dep' });
      }
    }
  }
  return byId;
}

function freezeStep(step) {
  return Object.freeze({
    id: step.id,
    type: step.type,
    deps: Object.freeze([...step.deps]),
    fused: step.fused === undefined ? Object.freeze([]) : Object.freeze([...step.fused]),
  });
}

/**
 * Build the FUSION PLAN without mutating the IR: maximal chains of
 * fusible single-consumer/single-dependency pure pairs. Deterministic:
 * steps in ordinal (array) order; a step belongs to at most one chain.
 *
 * @returns {{chains: Array<{head: string, tail: string, members: string[], fusedType: string}>}}
 */
export function fusionPlan(ir) {
  const byId = assertIr(ir);
  const order = ir.steps.map((s) => s.id);
  const consumers = new Map(order.map((id) => [id, []]));
  for (const step of ir.steps) {
    for (const dep of step.deps) consumers.get(dep).push(step.id);
  }
  const pure = new Set(OPTIMIZER_PURE_TYPES);
  const used = new Set();
  const chains = [];
  for (const head of order) {
    if (used.has(head)) continue;
    const headStep = byId.get(head);
    if (!pure.has(headStep.type)) continue;
    // extend tail-ward greedily: head → t1 → t2 … while both sides fusible
    const members = [head];
    let tail = head;
    let extended = true;
    used.add(head);
    while (extended) {
      extended = false;
      const tailConsumers = consumers.get(tail);
      if (tailConsumers.length !== 1) continue; // single consumer required
      const nextId = tailConsumers[0];
      if (used.has(nextId)) continue;
      const nextStep = byId.get(nextId);
      if (!pure.has(nextStep.type)) continue;
      if (nextStep.deps.length !== 1 || nextStep.deps[0] !== tail) continue; // single dep required
      members.push(nextId);
      used.add(nextId);
      tail = nextId;
      extended = true;
    }
    if (members.length >= 2) {
      chains.push(Object.freeze({
        head,
        tail,
        members: Object.freeze(members),
        fusedType: byId.get(head).type, // head's type carries the chain
      }));
    }
  }
  return Object.freeze({ chains: Object.freeze(chains) });
}

/**
 * Apply a fusion plan: each chain collapses into its head step (deps = head's
 * deps; consumers of removed members rewired to the head; `fused` records the
 * member ids for auditability). Pure — the input IR is untouched; output
 * steps carry the same {id, type, deps} shape plus `fused` so the IR module's
 * own consumers keep working (they ignore extra fields).
 */
export function applyFusion(ir, plan) {
  const byId = assertIr(ir);
  if (!isPlainObject(plan) || !Array.isArray(plan.chains)) {
    fail('plan must be a fusionPlan() result ({chains})', { field: 'plan' });
  }
  const headOf = new Map(); // member → canonical head
  for (const chain of plan.chains) {
    if (!Array.isArray(chain.members) || chain.members.length < 2) {
      fail('every chain needs ≥ 2 members', { field: 'plan', reason: 'bad-chain' });
    }
    for (const member of chain.members) {
      if (!byId.has(member)) {
        fail(`chain references unknown step '${member}'`, { field: 'plan', reason: 'unknown-step' });
      }
      if (headOf.has(member)) {
        fail(`step '${member}' appears in two chains`, { field: 'plan', reason: 'overlapping-chain' });
      }
      headOf.set(member, chain.head);
    }
    if (!byId.has(chain.head)) {
      fail(`chain head '${chain.head}' not in IR`, { field: 'plan', reason: 'unknown-step' });
    }
    headOf.set(chain.head, chain.head);
  }
  const removed = new Set([...headOf.keys()].filter((id) => headOf.get(id) !== id));
  const fusedMembers = new Map(); // head → members list (excluding head? including all)
  for (const chain of plan.chains) {
    fusedMembers.set(chain.head, [...chain.members]);
  }
  const steps = [];
  for (const step of ir.steps) {
    if (removed.has(step.id)) continue;
    const deps = [];
    for (const dep of step.deps) {
      const canonical = headOf.get(dep) ?? dep;
      if (canonical === step.id) continue; // self after collapse — skip
      if (!deps.includes(canonical)) deps.push(canonical);
    }
    steps.push({
      id: step.id,
      type: step.type,
      deps,
      fused: fusedMembers.get(step.id) ?? step.fused ?? [],
    });
  }
  return Object.freeze({
    irVersion: 1,
    steps: Object.freeze(steps.map(freezeStep)),
  });
}

/**
 * Semantics-safe node-result cache: admits ONLY `OPTIMIZER_PURE_TYPES`,
 * ONLY on exact fingerprint equality (the caller supplies the fingerprint —
 * hashing stays the caller's zero-import-friendly job; wrong fingerprint =
 * caller's miss, never this cache's guess). Bounded LRU, fail-closed config.
 */
export function createNodeResultCache({ maxEntries } = {}) {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
    fail('maxEntries must be a safe integer >= 1', { field: 'maxEntries' });
  }
  const store = new Map();
  const stats = { hits: 0, misses: 0, evictions: 0, refused: 0 };
  const cacheable = new Set(OPTIMIZER_PURE_TYPES);
  const api = {
    get({ stepType, fingerprint }) {
      const key = cacheKey(stepType, fingerprint, cacheable, stats);
      if (!store.has(key)) {
        stats.misses += 1;
        return undefined;
      }
      const value = store.get(key);
      store.delete(key);
      store.set(key, value); // LRU promote
      stats.hits += 1;
      return value;
    },
    set({ stepType, fingerprint }, value) {
      const key = cacheKey(stepType, fingerprint, cacheable, stats);
      if (store.has(key)) store.delete(key);
      store.set(key, deepFreezeCopy(value));
      while (store.size > maxEntries) {
        const oldest = store.keys().next().value;
        store.delete(oldest);
        stats.evictions += 1;
      }
      return api;
    },
    has(args) {
      const key = cacheKey(args.stepType, args.fingerprint, cacheable, stats);
      return store.has(key);
    },
    clear() {
      store.clear();
      stats.hits = 0;
      stats.misses = 0;
      stats.evictions = 0;
      stats.refused = 0;
    },
    stats() {
      return { ...stats, size: store.size, maxEntries };
    },
    get size() {
      return store.size;
    },
  };
  return Object.freeze(api);
}

function cacheKey(stepType, fingerprint, cacheable, stats) {
  if (!cacheable.has(stepType)) {
    stats.refused += 1;
    fail(`step type '${stepType}' is not on the proven-pure whitelist`, {
      field: 'stepType', reason: 'impure-type', stepType,
    });
  }
  if (typeof fingerprint !== 'string' || fingerprint.length === 0) {
    fail('fingerprint must be a non-empty string (exact-key or nothing)', { field: 'fingerprint' });
  }
  return `${stepType}\u0000${fingerprint}`;
}

function deepFreezeCopy(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return Object.freeze(value.map(deepFreezeCopy));
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = deepFreezeCopy(v);
  return Object.freeze(out);
}
