/**
 * Execution IR (P3 Slice J, Issues #75/#91).
 *
 * PUBLIC CONTRACT (`execution.ir`, v1.0.0 owner: agent-1, domain execution).
 *
 * A tiny, ZERO-DEPENDENCY intermediate representation compiled from the
 * canonical workflow definition, used to explore #91(c) "optimization
 * toggles": every optimization is INDEPENDENTLY disableable, and disabling
 * all of them must recover canonical behavior exactly (identity asserted by
 * tests — a benchmark improvement is not allowed without equivalence proof).
 *
 * Exports (7):
 *   EXECUTION_IR_CONTRACT, EXECUTION_IR_CONTRACT_VERSION,
 *   IR_OPTIMIZATIONS, ExecutionIrError,
 *   compileExecutionIr, optimizeExecutionIr, createIrCache
 *
 * Canonical (unoptimized) IR keeps RAW dependency lists in encounter order —
 * duplicates included — so `optimizeExecutionIr(ir, all-off)` is a pure
 * identity. Structural truth: connection targets that are not nodes are not
 * dependencies (dangling excluded, same family as the graph's reverse index).
 *
 * Cache: bounded LRU keyed by caller-supplied strings (fingerprint =
 * caller's job — the cache itself has no clock, no hash import, no unbounded
 * growth; maxEntries is validated fail-closed).
 *
 * Zero imports (purity test scans this file's source). No executor: the IR
 * describes structure; scheduling remains the frontier/executor slices.
 * Owner: agent-1 (Issue #98).
 */
/** The contract this module publishes. */
export const EXECUTION_IR_CONTRACT = Object.freeze({
  id: `execution.ir`,
  version: '1.0.0',
  owner: 'agent-1',
});

/** Pinned contract version for pin-style assertions. */
export const EXECUTION_IR_CONTRACT_VERSION = EXECUTION_IR_CONTRACT.version;

/**
 * Independently disableable optimizations (#91(c)). Default: ALL ON.
 *   - noopPassthrough: contract noOp chains (successors inherit the noop's
 *     deps; sinks drop). Guarded: never rewires a dep onto itself (cycles
 *     through a noop stay canonical — skip that node instead of corrupting).
 *   - dedupeDeps: unique dependency lists, first-encounter order preserved.
 */
export const IR_OPTIMIZATIONS = Object.freeze(['noopPassthrough', 'dedupeDeps']);

/** One error family for this module. */
export class ExecutionIrError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ExecutionIrError';
    this.code = 'lego.contract_violation';
    this.details = Object.freeze({ ...details });
  }
}

function fail(message, details) {
  throw new ExecutionIrError(message, details);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** n8n node types with no side effect of their own (passthrough candidates). */
const NOOP_TYPES = new Set(['n8n-nodes-base.noOp']);

/**
 * Compile the canonical workflow definition `{nodes, connections}` into the
 * RAW IR: one step per node in canonical order, dependency lists exactly as
 * encountered (duplicates kept — dedupe is an OPTIMIZATION, not a compile
 * step), connection types preserved per source. Fail-closed on structure.
 */
export function compileExecutionIr(workflow) {
  if (!isPlainObject(workflow)) {
    fail('workflow must be a plain object', { field: 'workflow' });
  }
  const nodes = workflow.nodes;
  if (!Array.isArray(nodes) || nodes.length === 0) {
    fail('workflow.nodes must be a non-empty array', { field: 'nodes' });
  }
  const ordinals = new Map();
  const steps = [];
  for (let i = 0; i < nodes.length; i += 1) {
    const node = nodes[i];
    if (!isPlainObject(node) || typeof node.name !== 'string' || node.name.length === 0) {
      fail('every node needs a non-empty string name', { field: 'nodes', index: i });
    }
    if (ordinals.has(node.name)) {
      fail('node names must be unique', { field: 'nodes', reason: 'duplicate-name', name: node.name });
    }
    if (typeof node.type !== 'string' || node.type.length === 0) {
      fail('every node needs a non-empty string type', { field: 'nodes', index: i });
    }
    ordinals.set(node.name, i);
    steps.push(Object.freeze({
      id: node.name,
      type: node.type,
      deps: Object.freeze([]), // filled in pass two (raw encounter order)
    }));
  }
  // pass two: dependencies in encounter order (dangling targets excluded —
  // structural truth: a non-node cannot be a dependency)
  const deps = steps.map(() => []);
  const connections = workflow.connections === undefined ? {} : workflow.connections;
  if (!isPlainObject(connections)) {
    fail('workflow.connections must be a plain object when present', { field: 'connections' });
  }
  for (const [sourceName, byType] of Object.entries(connections)) {
    if (!ordinals.has(sourceName)) continue; // orphan key: not a step (structural truth)
    if (!isPlainObject(byType)) continue;
    for (const [type, outputs] of Object.entries(byType)) {
      void type; // connection types describe wire shape, not execution order
      if (!Array.isArray(outputs)) continue;
      for (const links of outputs) {
        if (!Array.isArray(links)) continue;
        for (const link of links) {
          if (!isPlainObject(link)) continue;
          const targetIndex = ordinals.get(link.node);
          if (targetIndex === undefined) continue; // dangling target never needs the dep
          // DIRECTION: edge source→target means TARGET depends on SOURCE
          deps[targetIndex].push(sourceName);
        }
      }
    }
  }
  const rawSteps = steps.map((step, i) => Object.freeze({
    id: step.id,
    type: step.type,
    deps: Object.freeze([...deps[i]]),
  }));
  return Object.freeze({ irVersion: 1, steps: Object.freeze(rawSteps) });
}

function parseToggles(toggles) {
  if (toggles === undefined) return { noopPassthrough: true, dedupeDeps: true };
  if (!isPlainObject(toggles)) {
    fail('toggles must be a plain object of known optimization keys', { field: 'toggles' });
  }
  const resolved = {};
  for (const key of Object.keys(toggles)) {
    if (!IR_OPTIMIZATIONS.includes(key)) {
      fail(`unknown optimization toggle '${key}'`, { field: 'toggles', reason: 'unknown-toggle', toggle: key });
    }
    if (typeof toggles[key] !== 'boolean') {
      fail(`toggle '${key}' must be a boolean`, { field: 'toggles', toggle: key });
    }
    resolved[key] = toggles[key];
  }
  for (const key of IR_OPTIMIZATIONS) {
    if (resolved[key] === undefined) resolved[key] = true; // default ON
  }
  return resolved;
}

/**
 * Apply the ENABLED optimizations to a raw IR — pure (input untouched),
 * output frozen. Each toggle is independent (#91(c)): every subset of
 * {noopPassthrough, dedupeDeps} must be reachable, and ALL-OFF is the
 * canonical identity (optimize(x, {noopPassthrough:false, dedupeDeps:false})
 * deep-equals x).
 */
export function optimizeExecutionIr(ir, toggles) {
  if (!isPlainObject(ir) || ir.irVersion !== 1 || !Array.isArray(ir.steps)) {
    fail('ir must be a compiled IR (irVersion 1 with steps)', { field: 'ir' });
  }
  const flags = parseToggles(toggles);
  let steps = ir.steps.map((step) => {
    if (!isPlainObject(step) || typeof step.id !== 'string' || !Array.isArray(step.deps)) {
      fail('every IR step needs id and deps', { field: 'ir' });
    }
    let deps = [...step.deps];
    if (flags.dedupeDeps) {
      deps = [...new Set(deps)]; // first-encounter order preserved by Set iteration
    }
    return { id: step.id, type: step.type, deps };
  });
  if (flags.noopPassthrough) {
    const byId = new Map(steps.map((step) => [step.id, step]));
    const removed = new Set();
    // Fixpoint contraction: consumers are recomputed LIVE each pass so multi-
    // level noop chains fully collapse (a consumer rewired in pass N can expose
    // another noop consumer in pass N+1). Bounded by noop count → termination.
    let removedAny = true;
    while (removedAny) {
      removedAny = false;
      const liveNoops = steps.filter(
        (step) => !removed.has(step.id) && NOOP_TYPES.has(step.type),
      );
      for (const noop of liveNoops) {
        const liveConsumers = steps.filter(
          (step) => !removed.has(step.id) && step.id !== noop.id && step.deps.includes(noop.id),
        );
        // cycle guard: a consumer that is also one of the noop's own sources
        // would collapse a cycle into itself — skip (canonical stays reachable,
        // no corrupted self-deps; the toggle never forces structural lies).
        const safe = liveConsumers.every((consumer) => !noop.deps.includes(consumer.id));
        if (!safe) continue;
        for (const consumer of liveConsumers) {
          const rewired = [];
          for (const dep of consumer.deps) {
            if (dep === noop.id) {
              for (const inherited of noop.deps) {
                if (inherited !== consumer.id) rewired.push(inherited);
              }
            } else {
              rewired.push(dep);
            }
          }
          consumer.deps = rewired;
        }
        removed.add(noop.id);
        removedAny = true;
      }
    }
    void byId;
    steps = steps.filter((step) => !removed.has(step.id));
  }
  const frozen = steps.map((step) => Object.freeze({
    id: step.id,
    type: step.type,
    deps: Object.freeze([...step.deps]),
  }));
  return Object.freeze({ irVersion: 1, steps: Object.freeze(frozen) });
}

/**
 * Bounded LRU IR cache — logical entries never exceed `maxEntries` (fail-
 * closed validated), `get` promotes, `set` evicts oldest on overflow, stats
 * report hits/misses/evictions. Keys are caller strings (fingerprint =
 * caller's canonical serialization — no hash import keeps zero-import);
 * values are frozen on set (resident IRs are immutable state).
 */
export function createIrCache({ maxEntries } = {}) {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
    fail('maxEntries must be a safe integer >= 1', { field: 'maxEntries' });
  }
  const store = new Map(); // insertion order = recency order
  const stats = { hits: 0, misses: 0, evictions: 0, size: 0 };
  const cache = {
    get(key) {
      if (typeof key !== 'string' || key.length === 0) {
        fail('cache key must be a non-empty string', { field: 'key' });
      }
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
    set(key, ir) {
      if (typeof key !== 'string' || key.length === 0) {
        fail('cache key must be a non-empty string', { field: 'key' });
      }
      if (!isPlainObject(ir) || ir.irVersion !== 1 || !Array.isArray(ir.steps)) {
        fail('ir must be a compiled IR (irVersion 1 with steps)', { field: 'ir' });
      }
      if (store.has(key)) store.delete(key);
      store.set(key, freezeIr(ir));
      while (store.size > maxEntries) {
        const oldest = store.keys().next().value;
        store.delete(oldest);
        stats.evictions += 1;
      }
      stats.size = store.size;
      return cache;
    },
    has(key) {
      return store.has(key);
    },
    clear() {
      store.clear();
      stats.hits = 0;
      stats.misses = 0;
      stats.evictions = 0;
      stats.size = 0;
    },
    stats() {
      return { ...stats, maxEntries };
    },
    get size() {
      return store.size;
    },
  };
  return cache;
}

function freezeIr(ir) {
  return Object.freeze({
    irVersion: ir.irVersion,
    steps: Object.freeze(ir.steps.map((step) => Object.freeze({
      id: step.id,
      type: step.type,
      deps: Object.freeze([...step.deps]),
    }))),
  });
}
