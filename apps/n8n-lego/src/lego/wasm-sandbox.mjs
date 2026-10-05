/**
 * runtime.wasm-sandbox@0.1.0 — the production WASM node/plugin sandbox engine.
 *
 * Slice `P6-S02` (Issue #224, "Advanced n8n-lego Runtime"; the sandbox half of
 * the WASM locality row that `plugin-locality.mjs` has offered since P2.27.4).
 *
 * WHAT THIS IS AND WHAT IT IS NOT. Two contracts already exist and neither is
 * this one:
 *
 *  - `wasm-cache.mjs` (P6.26) decides what a compiled module is IDENTIFIED BY
 *    and what may be thrown away. Its scope wall says so in as many words: *"no
 *    compilation, no engine, no bytecode inspection and no WebAssembly API — the
 *    caller compiles and reports what happened."*
 *  - `plugin-locality.mjs` (P2.27.4) offers `WASM` as a row in the SANDBOXED
 *    posture. It decides WHERE a module may run. It does not decide what it may
 *    do once it is there.
 *
 * So the cache has an owner and the placement has an owner, and the thing in
 * between — the engine that actually holds a module inside a policy while it
 * runs — has none. This module is that engine. It composes the two: it takes its
 * module from the cache and it refuses to host anything the locality matrix
 * would not place in WASM.
 *
 * THE FOUR RULES, each of which exists because the obvious engine gets it wrong:
 *
 *  1. **IMPORTS ARE DENY-BY-DEFAULT AND THERE ARE NO WILDCARDS.** A WASM module
 *     is only as privileged as the imports it is handed, so the import table is
 *     the whole security boundary. An import the sandbox was not granted is
 *     refused at instantiation — not trapped at call time, when the damage of
 *     having resolved it is already done. A wildcard grant is not a grant, it is
 *     the absence of one, and this engine has no syntax for it.
 *
 *  2. **THERE IS NO AMBIENT AUTHORITY.** `clock`, `random`, `filesystem`,
 *     `network` and `process` are imports like any other. A sandbox created with
 *     no grants cannot reach a clock, and the way it cannot is structural: there
 *     is no import to call. This is the same deny-by-default posture
 *     `plugin-policy.mjs` enforces for capabilities, expressed in the one place
 *     a WASM module could otherwise get it for free.
 *
 *  3. **FUEL IS A HARD BUDGET AND EXHAUSTING IT IS ITS OWN OUTCOME.** An
 *     instruction budget that is merely advisory is not a budget. When the fuel
 *     runs out the call stops with `fuel-exhausted`, which is a different fact
 *     from `trapped`: one says the module was stopped, the other says the module
 *     misbehaved, and an operator looking at a dead node needs to know which.
 *
 *  4. **THE SANDBOX NEVER CHANGES THE NODE CONTRACT.** A node running behind it
 *     presents the same type identity, parameters and execution semantics as the
 *     same node in-process. That rule is P6-S01's, and this engine inherits it
 *     rather than restating it differently.
 *
 * SCOPE WALLS. No WebAssembly API, no bytecode parsing, no compilation, no
 * filesystem, no network, no clock, no randomness. The caller reports what it
 * compiled and how much fuel a call burned; this module decides what may be
 * imported, what may run, and when it must stop. The only `node:` import is the
 * hash, and it is used to compare digests the caller supplies.
 */
import { createHash } from 'node:crypto';
import { PluginRuntimeError } from './plugin-runtime.mjs';
import { LOCALITY_MATRIX } from './plugin-locality.mjs';

export const WASM_SANDBOX_CONTRACT = 'runtime.wasm-sandbox@0.1.0';
export const WASM_SANDBOX_CONTRACT_VERSION = '0.1.0';
export const WASM_SANDBOX_SCHEMA_VERSION = 1;

export const WASM_SANDBOX_OPERATIONS = Object.freeze(['create', 'resolve', 'instantiate', 'run', 'describe']);
export const WASM_SANDBOX_PERMISSIONS = Object.freeze(['node:read']);

/**
 * The ambient authorities a WASM module would otherwise get for free. Each is an
 * IMPORT here, so each needs a grant, so each can be withheld. This list is the
 * whole reason rule 2 holds.
 */
export const AMBIENT_IMPORTS = Object.freeze(['clock', 'random', 'filesystem', 'network', 'process', 'env']);

/** The only posture this engine hosts. Anything else is placed elsewhere. */
export const WASM_SANDBOX_POSTURE = 'SANDBOXED';
export const WASM_SANDBOX_LOCALITY = 'WASM';

export const WASM_IMPORT_RESOLUTIONS = Object.freeze(['granted', 'refused']);

export const WASM_INSTANTIATE_VERDICTS = Object.freeze(['admitted', 'refused']);

/** How a call ended. Deliberately four outcomes, never two. */
export const WASM_CALL_OUTCOMES = Object.freeze([
  'completed',
  'fuel-exhausted',
  'trapped',
  'rejected',
]);

export const WASM_SANDBOX_REASONS = Object.freeze([
  'sandbox.input',
  'sandbox.grant',
  'sandbox.posture',
  'sandbox.resource',
  'sandbox.fuel',
  'sandbox.import',
  'sandbox.module',
]);

/** Bounds. A budget with no ceiling is not a budget. */
export const WASM_SANDBOX_LIMITS = Object.freeze({
  maxImports: 64,
  maxImportNameLength: 128,
  maxMemoryPages: 16384, // 1 GiB in 64 KiB pages
  maxFuelPerCall: 10_000_000,
  maxCallsPerInstance: 4096,
});

/** The default budget, and the reason each bound exists. */
export const WASM_SANDBOX_DEFAULTS = Object.freeze({
  maxMemoryPages: 256, // 16 MiB: a node, not a server
  fuelPerCall: 1_000_000,
  maxCallsPerInstance: 64,
});

const violation = (message, details) => new PluginRuntimeError('lego.contract_violation', message, { details });
const denied = (message, details) => new PluginRuntimeError('lego.access_denied', message, { details });

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function fail(message, details) {
  throw violation(message, details);
}

const IMPORT_NAME_RE = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/;

/* ------------------------------------------------------------------- grants */

function normalizeGrants(grants) {
  if (grants === undefined || grants === null) return Object.freeze([]);
  if (!Array.isArray(grants)) fail('grants must be an array of import names', { code: 'sandbox.grant' });
  const seen = new Set();
  for (const grant of grants) {
    if (!isNonEmptyString(grant) || grant.length > WASM_SANDBOX_LIMITS.maxImportNameLength) {
      fail(`a grant must be a non-empty string of at most ${WASM_SANDBOX_LIMITS.maxImportNameLength} characters`, {
        code: 'sandbox.grant',
        grant,
      });
    }
    // A wildcard is the absence of a grant. There is no syntax for one here, and
    // a grant that arrives shaped like one is refused rather than interpreted.
    if (grant === '*' || grant.includes('*')) {
      fail(`a wildcard grant is not a grant: '${grant}'`, { code: 'sandbox.grant', grant });
    }
    if (!IMPORT_NAME_RE.test(grant)) {
      fail(`grant '${grant}' is not an import-shaped name (lowercase dotted/underscore)`, { code: 'sandbox.grant', grant });
    }
    seen.add(grant);
  }
  return Object.freeze([...seen].sort());
}

function normalizeLimits(limits) {
  const declared = isPlainObject(limits) ? limits : {};
  const resolved = {};
  for (const [field, fallback] of Object.entries(WASM_SANDBOX_DEFAULTS)) {
    const value = declared[field] ?? fallback;
    if (!Number.isInteger(value) || value <= 0) {
      fail(`${field} must be a positive integer`, { code: 'sandbox.input', field, value });
    }
    resolved[field] = value;
  }
  if (resolved.maxMemoryPages > WASM_SANDBOX_LIMITS.maxMemoryPages) {
    fail(`maxMemoryPages ${resolved.maxMemoryPages} exceeds the ${WASM_SANDBOX_LIMITS.maxMemoryPages}-page ceiling`, {
      code: 'sandbox.resource',
      maxMemoryPages: resolved.maxMemoryPages,
      ceiling: WASM_SANDBOX_LIMITS.maxMemoryPages,
    });
  }
  if (resolved.fuelPerCall > WASM_SANDBOX_LIMITS.maxFuelPerCall) {
    fail(`fuelPerCall ${resolved.fuelPerCall} exceeds the ${WASM_SANDBOX_LIMITS.maxFuelPerCall} ceiling`, {
      code: 'sandbox.resource',
      fuelPerCall: resolved.fuelPerCall,
      ceiling: WASM_SANDBOX_LIMITS.maxFuelPerCall,
    });
  }
  return Object.freeze(resolved);
}

/**
 * Creates a sandbox. The result is frozen: a live sandbox is never widened from
 * the outside, only replaced. Widening a running sandbox is how a temporary
 * debug grant becomes a permanent capability.
 *
 * @param {object} [options]
 * @param {string[]} [options.grants]  import names the module may bind
 * @param {object} [options.limits]    memory pages, fuel per call, calls per instance
 * @param {string} [options.posture]   must be SANDBOXED
 * @returns {Readonly<object>}
 */
export function createWasmSandbox({ grants = [], limits = {}, posture = WASM_SANDBOX_POSTURE } = {}) {
  if (posture !== WASM_SANDBOX_POSTURE) {
    fail(`this engine hosts ${WASM_SANDBOX_POSTURE} only, not ${posture}`, {
      code: 'sandbox.posture',
      posture,
      hosted: WASM_SANDBOX_POSTURE,
      allowed: LOCALITY_MATRIX[WASM_SANDBOX_POSTURE],
    });
  }
  const normalizedGrants = normalizeGrants(grants);
  const normalizedLimits = normalizeLimits(limits);
  const ambient = normalizedGrants.filter((grant) => AMBIENT_IMPORTS.includes(grant));
  return Object.freeze({
    contract: WASM_SANDBOX_CONTRACT,
    schemaVersion: WASM_SANDBOX_SCHEMA_VERSION,
    ok: true,
    locality: WASM_SANDBOX_LOCALITY,
    posture: WASM_SANDBOX_POSTURE,
    grants: normalizedGrants,
    limits: normalizedLimits,
    // Recorded, not inferred: an operator inspecting a sandbox should see which
    // ambient authorities it holds without re-deriving it from the grant list.
    ambient: Object.freeze(ambient),
  });
}

export function isWasmSandbox(value) {
  return (
    isPlainObject(value) &&
    value.contract === WASM_SANDBOX_CONTRACT &&
    value.posture === WASM_SANDBOX_POSTURE &&
    Array.isArray(value.grants) &&
    Object.isFrozen(value)
  );
}

/* ------------------------------------------------------------------ imports */

/**
 * Resolves a module's requested imports against the sandbox's grants.
 *
 * Every requested import gets a row. A row is never dropped: a module that asks
 * for eleven imports and is granted ten has one REFUSED row, and the caller has
 * to be able to see which. Silently binding nine is how a module ends up running
 * with a capability nobody granted it.
 *
 * @param {object} sandbox
 * @param {string[]} requested
 * @returns {Readonly<{rows: ReadonlyArray<{name, resolution, ambient}>}>}
 */
export function resolveImports(sandbox, requested = []) {
  if (!isWasmSandbox(sandbox)) fail('resolveImports reads a sandbox from createWasmSandbox', { code: 'sandbox.input' });
  if (!Array.isArray(requested)) fail('requested imports must be an array', { code: 'sandbox.input' });
  if (requested.length > WASM_SANDBOX_LIMITS.maxImports) {
    fail(`a module may request at most ${WASM_SANDBOX_LIMITS.maxImports} imports`, {
      code: 'sandbox.import',
      requested: requested.length,
      max: WASM_SANDBOX_LIMITS.maxImports,
    });
  }
  const granted = new Set(sandbox.grants);
  const rows = requested.map((name) => {
    if (!isNonEmptyString(name) || name.length > WASM_SANDBOX_LIMITS.maxImportNameLength || !IMPORT_NAME_RE.test(name)) {
      fail(`requested import '${name}' is not an import-shaped name`, { code: 'sandbox.import', name });
    }
    const allowed = granted.has(name);
    return Object.freeze({
      name,
      resolution: allowed ? 'granted' : 'refused',
      ambient: AMBIENT_IMPORTS.includes(name),
    });
  });
  return Object.freeze({ rows: Object.freeze(rows), sandbox });
}

/* -------------------------------------------------------------- instantiate */

/**
 * Decides whether a module may be instantiated inside this sandbox.
 *
 * Fail-closed at INSTANTIATION, not at call time. An import resolved lazily is
 * an import that was already looked up by the time anyone noticed it was not
 * granted.
 *
 * @param {object} sandbox
 * @param {object} candidate
 * @param {string[]} candidate.imports      what the module declares it needs
 * @param {string} [candidate.posture]      where the caller intends to place it
 * @param {number} [candidate.memoryPages]  linear memory the module asks for
 * @returns {Readonly<object>} the instantiation decision
 */
export function instantiate(sandbox, candidate = {}) {
  if (!isWasmSandbox(sandbox)) fail('instantiate reads a sandbox from createWasmSandbox', { code: 'sandbox.input' });
  if (!isPlainObject(candidate)) fail('a candidate must be an object', { code: 'sandbox.input' });
  if (!Array.isArray(candidate.imports)) fail('a candidate must declare its imports as an array', { code: 'sandbox.input' });

  const intended = candidate.posture ?? WASM_SANDBOX_POSTURE;
  if (intended !== WASM_SANDBOX_POSTURE) {
    return Object.freeze({
      verdict: 'refused',
      reason: 'sandbox.posture',
      message: `this engine hosts ${WASM_SANDBOX_POSTURE} only, not ${intended}`,
      rows: Object.freeze([]),
    });
  }

  const resolution = resolveImports(sandbox, candidate.imports);
  const refused = resolution.rows.filter((row) => row.resolution === 'refused');

  const pages = candidate.memoryPages;
  let memoryRefused = null;
  if (pages !== undefined && pages !== null) {
    if (!Number.isInteger(pages) || pages <= 0) {
      return Object.freeze({
        verdict: 'refused',
        reason: 'sandbox.input',
        message: 'memoryPages must be a positive integer when declared',
        rows: resolution.rows,
      });
    }
    if (pages > sandbox.limits.maxMemoryPages) {
      memoryRefused = `the module asks for ${pages} pages and the sandbox allows ${sandbox.limits.maxMemoryPages}`;
    }
  }

  if (refused.length || memoryRefused) {
    return Object.freeze({
      verdict: 'refused',
      reason: refused.length ? 'sandbox.import' : 'sandbox.resource',
      message: memoryRefused ?? `${refused.length} import(s) were not granted: ${refused.map((r) => r.name).join(', ')}`,
      refused: Object.freeze(refused.map((row) => row.name)),
      rows: resolution.rows,
    });
  }

  return Object.freeze({
    verdict: 'admitted',
    reason: null,
    message: `all ${resolution.rows.length} import(s) granted within the sandbox budget`,
    // The table the engine will actually bind: exactly the granted rows, in the
    // order the module asked for them. Nothing else is reachable.
    bound: Object.freeze(resolution.rows.filter((row) => row.resolution === 'granted').map((row) => row.name)),
    rows: resolution.rows,
    locality: WASM_SANDBOX_LOCALITY,
    // The node contract is unchanged by running behind this engine (P6-S01).
    consumerContract: Object.freeze({ type: candidate.type ?? null }),
  });
}

/* ---------------------------------------------------------------------- run */

/**
 * Accounts one call against the sandbox budget.
 *
 * The caller supplies the fuel the call actually burned; this module decides
 * whether that was inside the budget and what the outcome means. Four outcomes,
 * because "the node died" is not an answer an operator can act on:
 *
 *   completed       the call returned inside its budget
 *   fuel-exhausted  the budget ran out: the module was STOPPED, not broken
 *   trapped         the module faulted: something is wrong with the module
 *   rejected        the call never ran, because the module was not admitted
 *
 * @param {object} sandbox
 * @param {object} call
 * @param {number} call.fuelUsed
 * @param {string} [call.observed]  what the caller says happened
 * @returns {Readonly<object>}
 */
export function accountCall(sandbox, call = {}) {
  if (!isWasmSandbox(sandbox)) fail('accountCall reads a sandbox from createWasmSandbox', { code: 'sandbox.input' });
  if (!isPlainObject(call)) fail('a call must be an object', { code: 'sandbox.input' });
  const { fuelUsed } = call;
  if (!Number.isInteger(fuelUsed) || fuelUsed < 0) {
    fail('fuelUsed must be a non-negative integer', { code: 'sandbox.fuel', fuelUsed });
  }
  const budget = sandbox.limits.fuelPerCall;
  const observed = call.observed ?? 'completed';
  if (!WASM_CALL_OUTCOMES.includes(observed)) {
    fail(`observed must be one of ${WASM_CALL_OUTCOMES.join(', ')}`, { code: 'sandbox.input', observed });
  }
  const withinBudget = fuelUsed <= budget;
  // The budget overrides whatever the caller reported: a call that burned more
  // than its budget did not complete, whatever the caller says it did. Inside
  // the budget the caller's own outcome stands.
  const outcome = withinBudget ? observed : 'fuel-exhausted';
  return Object.freeze({
    outcome,
    fuelUsed,
    budget,
    remaining: Math.max(0, budget - fuelUsed),
    withinBudget,
    stopped: outcome === 'fuel-exhausted',
    message: withinBudget
      ? `${fuelUsed}/${budget} fuel used`
      : `${fuelUsed} fuel used against a ${budget} budget: the call was stopped, not completed`,
  });
}

/* -------------------------------------------------------------------- cache */

/**
 * Decides whether a cache entry may be run inside this sandbox, BEFORE anything
 * runs.
 *
 * The P6.26 cache answers "we already checked that". This is the check that the
 * thing it handed back is the thing it claims to be, and the rule is the
 * sandbox's own: a module whose digest does not match the entry is never run,
 * and a cached compilation failure has no module in it to run at all.
 *
 * The entry is read as DATA — `outcome` and `moduleDigest` — rather than through
 * an import of `wasm-cache.mjs`. `lego-foundation` must not reach `node-registry`,
 * and inverting that dependency is the right shape anyway: the engine owns its
 * admission rule and does not inherit one from the cache that stores the module.
 * The caller wires the two together, which is what a composition root is for.
 */
export function admitFromCache(cacheEntry, observedModuleDigest) {
  if (!isPlainObject(cacheEntry)) {
    fail('admitFromCache reads a cache entry as data: { outcome, moduleDigest }', { code: 'sandbox.module' });
  }
  if (!isNonEmptyString(observedModuleDigest)) {
    fail('admitting a module means naming the digest of what was actually compiled', {
      code: 'sandbox.module',
      field: 'observedModuleDigest',
    });
  }
  if (cacheEntry.outcome === 'failed') {
    return Object.freeze({
      admitted: false,
      verified: false,
      reason: 'sandbox.module',
      message: 'this entry is a cached failure: there is no module in it to run',
    });
  }
  if (!isNonEmptyString(cacheEntry.moduleDigest)) {
    return Object.freeze({
      admitted: false,
      verified: false,
      reason: 'sandbox.module',
      message: 'this entry does not name the module it holds, so it cannot be verified before it runs',
    });
  }
  if (cacheEntry.moduleDigest !== observedModuleDigest) {
    return Object.freeze({
      admitted: false,
      verified: false,
      reason: 'sandbox.module',
      message: `the module does not match the entry: expected ${cacheEntry.moduleDigest.slice(0, 12)}… and got ${observedModuleDigest.slice(0, 12)}…`,
    });
  }
  return Object.freeze({
    admitted: true,
    verified: true,
    reason: null,
    message: `the module matches the entry (${observedModuleDigest.slice(0, 12)}…)`,
    moduleDigest: observedModuleDigest,
  });
}

/* ------------------------------------------------------------------ explain */

export function describeWasmSandbox(sandbox) {
  if (!isWasmSandbox(sandbox)) fail('describeWasmSandbox reads a sandbox from createWasmSandbox', { code: 'sandbox.input' });
  return Object.freeze({
    contract: WASM_SANDBOX_CONTRACT,
    locality: sandbox.locality,
    posture: sandbox.posture,
    grants: sandbox.grants,
    ambient: sandbox.ambient,
    limits: sandbox.limits,
    allowedLocalities: Object.freeze([...LOCALITY_MATRIX[sandbox.posture]]),
  });
}

/** Human-readable, in the fixed order, naming the contract that produced each fact. */
export function explainWasmSandbox(sandbox) {
  const described = describeWasmSandbox(sandbox);
  return [
    `${described.contract} — ${described.posture} in ${described.locality}`,
    `  grants: ${described.grants.length ? described.grants.join(', ') : '(none)'}`,
    `  ambient: ${described.ambient.length ? described.ambient.join(', ') : '(none — no clock, no random, no filesystem, no network)'}`,
    `  budget: ${described.limits.maxMemoryPages} pages, ${described.limits.fuelPerCall} fuel per call, ${described.limits.maxCallsPerInstance} calls`,
    `  may also run in: ${described.allowedLocalities.join(', ')} [lego.plugin-runtime]`,
  ].join('\n');
}

/** Digest helper, so a caller can name a module without importing the hash itself. */
export function sandboxDigest(bytes) {
  if (typeof bytes !== 'string' && !(bytes instanceof Uint8Array)) {
    fail('sandboxDigest takes the bytes or text of a module', { code: 'sandbox.input' });
  }
  return createHash('sha256').update(bytes).digest('hex');
}
