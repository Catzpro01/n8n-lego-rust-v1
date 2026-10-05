/**
 * P6-S02 — the production WASM node/plugin sandbox engine.
 *
 * The tests are organised around the four rules the engine exists to hold. Each
 * one is here because the obvious engine gets it wrong:
 *
 *   1. Deny-by-default imports, no wildcards — the import table is the whole
 *      security boundary, so an ungranted import is refused at instantiation
 *      and a wildcard is not a grant.
 *   2. No ambient authority — clock, random, filesystem, network and process are
 *      imports like any other, so a sandbox with no grants cannot reach them.
 *   3. Fuel is a hard budget — exhausting it is `fuel-exhausted`, which is a
 *      different fact from `trapped`.
 *   4. The sandbox never changes the node contract.
 *
 * Plus the composition rules: the engine takes its module from the P6.26 cache
 * and verifies the hit before anything runs, and it only hosts SANDBOXED.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AMBIENT_IMPORTS,
  WASM_CALL_OUTCOMES,
  WASM_INSTANTIATE_VERDICTS,
  WASM_SANDBOX_CONTRACT,
  WASM_SANDBOX_DEFAULTS,
  WASM_SANDBOX_LIMITS,
  WASM_SANDBOX_POSTURE,
  accountCall,
  admitFromCache,
  createWasmSandbox,
  describeWasmSandbox,
  explainWasmSandbox,
  instantiate,
  isWasmSandbox,
  resolveImports,
  sandboxDigest,
} from '../src/lego/wasm-sandbox.mjs';
import { createWasmCache, insert, lookup } from '../src/lego/wasm-cache.mjs';

const candidate = (overrides = {}) => Object.freeze({
  type: 'n8n-nodes-base.httpRequest',
  imports: ['log'],
  ...overrides,
});

/* ------------------------------------------------- 1. deny-by-default imports */

test('a module is admitted only when every import it declares is granted', () => {
  const sandbox = createWasmSandbox({ grants: ['log', 'network'] });
  const decision = instantiate(sandbox, candidate({ imports: ['log', 'network'] }));
  assert.equal(decision.verdict, 'admitted');
  // Exactly the granted rows, in the order the module asked for them.
  assert.deepEqual([...decision.bound], ['log', 'network']);
});

test('an ungranted import is refused at instantiation, not trapped later', () => {
  // The whole point: resolving an import lazily means it was already looked up
  // by the time anyone noticed it was not granted.
  const sandbox = createWasmSandbox({ grants: ['log'] });
  const decision = instantiate(sandbox, candidate({ imports: ['log', 'filesystem'] }));
  assert.equal(decision.verdict, 'refused');
  assert.equal(decision.reason, 'sandbox.import');
  assert.deepEqual([...decision.refused], ['filesystem']);
});

test('a refused row is never dropped from the resolution', () => {
  // A module asking for eleven imports and granted ten has one refused row the
  // caller must be able to see. Silently binding nine is how a module ends up
  // running with a capability nobody granted it.
  const sandbox = createWasmSandbox({ grants: ['log'] });
  const resolution = resolveImports(sandbox, ['log', 'clock', 'random']);
  assert.equal(resolution.rows.length, 3);
  assert.deepEqual(resolution.rows.map((row) => row.resolution), ['granted', 'refused', 'refused']);
});

test('a wildcard grant is refused, not interpreted', () => {
  for (const grant of ['*', 'log.*', '*.log']) {
    assert.throws(
      () => createWasmSandbox({ grants: [grant] }),
      (error) => error.code === 'lego.contract_violation' && error.details.code === 'sandbox.grant',
      `${grant} was accepted as a grant`,
    );
  }
});

test('a grant outside the import shape is refused', () => {
  assert.throws(
    () => createWasmSandbox({ grants: ['Log'] }),
    (error) => error.details.code === 'sandbox.grant',
  );
});

test('duplicate grants collapse and the grant list is deterministic', () => {
  const a = createWasmSandbox({ grants: ['network', 'log', 'log'] });
  const b = createWasmSandbox({ grants: ['log', 'network', 'network'] });
  assert.deepEqual([...a.grants], ['log', 'network']);
  assert.deepEqual([...a.grants], [...b.grants]);
});

/* -------------------------------------------------- 2. no ambient authority */

test('a sandbox with no grants holds no ambient authority', () => {
  const sandbox = createWasmSandbox({});
  assert.deepEqual([...sandbox.ambient], []);
  // Not "the ambient list is empty so nothing is reachable" as a convention —
  // structurally: there is no import to call.
  const decision = instantiate(sandbox, candidate({ imports: [] }));
  assert.equal(decision.verdict, 'admitted');
  assert.deepEqual([...decision.bound], []);
});

test('every ambient authority is an import, so every one can be withheld', () => {
  // The list is the reason rule 2 holds: clock, random, filesystem, network and
  // process are all things a WASM module would otherwise get for free.
  assert.deepEqual([...AMBIENT_IMPORTS], ['clock', 'random', 'filesystem', 'network', 'process', 'env']);
  const sandbox = createWasmSandbox({ grants: [] });
  for (const ambient of AMBIENT_IMPORTS) {
    const decision = instantiate(sandbox, candidate({ imports: [ambient] }));
    assert.equal(decision.verdict, 'refused', `${ambient} was reachable without a grant`);
  }
});

test('the ambient authorities a sandbox holds are recorded, not inferred', () => {
  const sandbox = createWasmSandbox({ grants: ['network', 'log', 'clock'] });
  assert.deepEqual([...sandbox.ambient], ['clock', 'network']);
  // `log` is a grant but not an ambient authority, and the distinction is the
  // thing an operator inspecting a sandbox needs.
  assert.ok(!sandbox.ambient.includes('log'));
  assert.match(explainWasmSandbox(sandbox), /ambient: clock, network/);
});

/* ------------------------------------------------------- 3. fuel is a budget */

test('a call inside its budget completes', () => {
  const sandbox = createWasmSandbox({ grants: ['log'], limits: { fuelPerCall: 1000 } });
  const account = accountCall(sandbox, { fuelUsed: 400 });
  assert.equal(account.outcome, 'completed');
  assert.equal(account.withinBudget, true);
  assert.equal(account.stopped, false);
  assert.equal(account.remaining, 600);
});

test('a call over its budget is stopped, and stopped is not completed', () => {
  const sandbox = createWasmSandbox({ grants: ['log'], limits: { fuelPerCall: 1000 } });
  const account = accountCall(sandbox, { fuelUsed: 1001, observed: 'completed' });
  // The budget overrides whatever the caller reported.
  assert.equal(account.outcome, 'fuel-exhausted');
  assert.equal(account.stopped, true);
  assert.equal(account.remaining, 0);
});

test('using the whole budget is allowed: the ceiling is inclusive', () => {
  const sandbox = createWasmSandbox({ grants: ['log'], limits: { fuelPerCall: 1000 } });
  const account = accountCall(sandbox, { fuelUsed: 1000 });
  assert.equal(account.outcome, 'completed');
  assert.equal(account.withinBudget, true);
  assert.equal(account.remaining, 0);
});

test('fuel-exhausted and trapped are different facts', () => {
  // "The node died" is not an answer an operator can act on. One says the module
  // was stopped by its budget; the other says the module misbehaved.
  const sandbox = createWasmSandbox({ grants: ['log'], limits: { fuelPerCall: 100 } });
  const exhausted = accountCall(sandbox, { fuelUsed: 500 });
  const trapped = accountCall(sandbox, { fuelUsed: 50, observed: 'trapped' });
  assert.equal(exhausted.outcome, 'fuel-exhausted');
  assert.equal(trapped.outcome, 'trapped');
  assert.notEqual(exhausted.outcome, trapped.outcome);
  assert.ok(WASM_CALL_OUTCOMES.includes('fuel-exhausted'));
  assert.ok(WASM_CALL_OUTCOMES.includes('trapped'));
});

test('a budget above the ceiling is refused rather than clamped', () => {
  assert.throws(
    () => createWasmSandbox({ limits: { fuelPerCall: WASM_SANDBOX_LIMITS.maxFuelPerCall + 1 } }),
    (error) => error.details.code === 'sandbox.resource',
  );
  assert.throws(
    () => createWasmSandbox({ limits: { maxMemoryPages: WASM_SANDBOX_LIMITS.maxMemoryPages + 1 } }),
    (error) => error.details.code === 'sandbox.resource',
  );
});

test('a module asking for more memory than the sandbox allows is refused', () => {
  const sandbox = createWasmSandbox({ grants: ['log'], limits: { maxMemoryPages: 4 } });
  const decision = instantiate(sandbox, candidate({ memoryPages: 8 }));
  assert.equal(decision.verdict, 'refused');
  assert.equal(decision.reason, 'sandbox.resource');
  assert.match(decision.message, /8 pages/);
});

/* ------------------------------------------------ 4. the node contract holds */

test('the sandbox never changes the consumer-facing node contract', () => {
  // P6-S01's rule, inherited rather than restated differently: a node running
  // behind the engine presents the same type identity as the same node
  // in-process.
  const sandbox = createWasmSandbox({ grants: ['log'] });
  const inSandbox = instantiate(sandbox, candidate({ type: 'n8n-nodes-base.httpRequest' }));
  assert.deepEqual(inSandbox.consumerContract, { type: 'n8n-nodes-base.httpRequest' });
  // The locality is recorded next to the node, not inside it.
  assert.equal(inSandbox.locality, 'WASM');
});

/* ------------------------------------------------------------- the posture */

test('the engine hosts SANDBOXED and refuses everything else', () => {
  assert.equal(WASM_SANDBOX_POSTURE, 'SANDBOXED');
  const sandbox = createWasmSandbox({ grants: ['log'] });
  for (const posture of ['CORE', 'TRUSTED', 'ISOLATED']) {
    const decision = instantiate(sandbox, candidate({ posture }));
    assert.equal(decision.verdict, 'refused', `${posture} was hosted`);
    assert.equal(decision.reason, 'sandbox.posture');
  }
});

test('a sandbox cannot be created for another posture at all', () => {
  assert.throws(
    () => createWasmSandbox({ posture: 'CORE' }),
    (error) => error.details.code === 'sandbox.posture',
  );
});

test('a live sandbox is frozen, so it cannot be widened from outside', () => {
  const sandbox = createWasmSandbox({ grants: ['log'] });
  assert.ok(Object.isFrozen(sandbox));
  assert.ok(Object.isFrozen(sandbox.grants));
  assert.throws(() => {
    sandbox.grants.push('network');
  });
  // Widening a running sandbox is how a temporary debug grant becomes permanent.
  assert.ok(!sandbox.grants.includes('network'));
});

/* ------------------------------------------------------ the P6.26 composition */

test('a module is admitted from the cache only when the hit verifies', () => {
  const moduleDigest = sandboxDigest('a real wasm module');
  const cache = createWasmCache({ maxEntries: 4 });
  insert(cache, {
    artifactDigest: moduleDigest, ioDigest: 'io-1', abiVersion: '1', toolchain: 'wasm-1.0',
    moduleDigest, outcome: 'compiled', bytes: 1024, tick: 1,
  });
  const hit = lookup(cache, { artifactDigest: moduleDigest, ioDigest: 'io-1', abiVersion: '1', toolchain: 'wasm-1.0', tick: 1 });
  assert.equal(hit.state, 'hit');
  const admitted = admitFromCache(hit.entry, moduleDigest);
  assert.equal(admitted.admitted, true);
  assert.equal(admitted.verified, true);
});

test('a module whose digest does not match the entry is never run', () => {
  // The cache answers "we already checked that". This is the check that the
  // thing it handed back is the thing it claims.
  const moduleDigest = sandboxDigest('the real module');
  const cache = createWasmCache({ maxEntries: 4 });
  insert(cache, {
    artifactDigest: moduleDigest, ioDigest: 'io-1', abiVersion: '1', toolchain: 'wasm-1.0',
    moduleDigest, outcome: 'compiled', bytes: 1024, tick: 1,
  });
  const hit = lookup(cache, { artifactDigest: moduleDigest, ioDigest: 'io-1', abiVersion: '1', toolchain: 'wasm-1.0', tick: 1 });
  const admitted = admitFromCache(hit.entry, sandboxDigest('a different module'));
  assert.equal(admitted.admitted, false);
  assert.equal(admitted.verified, false);
});

test('a cached compilation failure has no module to run and is refused', () => {
  const artifactDigest = sandboxDigest('a broken artifact');
  const cache = createWasmCache({ maxEntries: 4 });
  insert(cache, {
    artifactDigest, ioDigest: 'io-1', abiVersion: '1', toolchain: 'wasm-1.0',
    outcome: 'failed', reason: 'cache.compile', tick: 1,
  });
  // P6.26 reports a cached compilation failure as a NEGATIVE lookup, not a hit:
  // the entry exists, and what it holds is the fact that compilation failed.
  const hit = lookup(cache, { artifactDigest, ioDigest: 'io-1', abiVersion: '1', toolchain: 'wasm-1.0', tick: 1 });
  assert.equal(hit.state, 'negative');
  assert.equal(hit.entry.outcome, 'failed');
  const admitted = admitFromCache(hit.entry, sandboxDigest('whatever'));
  assert.equal(admitted.admitted, false);
  assert.match(admitted.message, /cached failure/);
});

test('the engine reads the cache but never writes one', () => {
  // P6.26 owns the cache. This engine consumes entries and decides what may run;
  // it does not become a second cache with different eviction rules.
  const sandbox = createWasmSandbox({ grants: ['log'] });
  const described = describeWasmSandbox(sandbox);
  assert.ok(!('entries' in described));
  assert.ok(!('insert' in sandbox));
  assert.equal(described.contract, WASM_SANDBOX_CONTRACT);
});

/* ------------------------------------------------------------------- bounds */

test('a module requesting too many imports is refused', () => {
  const sandbox = createWasmSandbox({ grants: [] });
  const many = Array.from({ length: WASM_SANDBOX_LIMITS.maxImports + 1 }, (_, i) => `import_${i}`);
  assert.throws(
    () => resolveImports(sandbox, many),
    (error) => error.details.code === 'sandbox.import',
  );
});

test('the defaults are inside the ceilings and are the documented shape', () => {
  assert.ok(WASM_SANDBOX_DEFAULTS.fuelPerCall <= WASM_SANDBOX_LIMITS.maxFuelPerCall);
  assert.ok(WASM_SANDBOX_DEFAULTS.maxMemoryPages <= WASM_SANDBOX_LIMITS.maxMemoryPages);
  const sandbox = createWasmSandbox({});
  assert.equal(sandbox.limits.fuelPerCall, WASM_SANDBOX_DEFAULTS.fuelPerCall);
  assert.equal(sandbox.limits.maxMemoryPages, WASM_SANDBOX_DEFAULTS.maxMemoryPages);
  assert.equal(sandbox.locality, 'WASM');
});

test('a malformed candidate is refused rather than defaulted', () => {
  const sandbox = createWasmSandbox({ grants: ['log'] });
  assert.throws(() => instantiate(sandbox, {}), (error) => error.details.code === 'sandbox.input');
  assert.throws(() => instantiate(sandbox, { imports: 'log' }), (error) => error.details.code === 'sandbox.input');
  const negative = instantiate(sandbox, { imports: [], memoryPages: -1 });
  assert.equal(negative.verdict, 'refused');
  assert.equal(negative.reason, 'sandbox.input');
  assert.throws(() => accountCall(sandbox, { fuelUsed: -5 }), (error) => error.details.code === 'sandbox.fuel');
  assert.throws(() => accountCall(sandbox, { fuelUsed: 1, observed: 'vanished' }), (error) => error.details.code === 'sandbox.input');
});

test('a foreign object is not a sandbox', () => {
  assert.equal(isWasmSandbox({}), false);
  assert.equal(isWasmSandbox({ contract: WASM_SANDBOX_CONTRACT }), false);
  assert.equal(isWasmSandbox(createWasmSandbox({})), true);
  assert.throws(() => describeWasmSandbox({}), (error) => error.code === 'lego.contract_violation');
});

test('the verdict and outcome vocabularies are frozen and closed', () => {
  assert.deepEqual([...WASM_INSTANTIATE_VERDICTS], ['admitted', 'refused']);
  assert.deepEqual([...WASM_CALL_OUTCOMES], ['completed', 'fuel-exhausted', 'trapped', 'rejected']);
  assert.ok(Object.isFrozen(WASM_CALL_OUTCOMES));
});

test('the explanation names the contract that produced each fact', () => {
  const rendered = explainWasmSandbox(createWasmSandbox({ grants: ['log'] }));
  assert.match(rendered, /runtime\.wasm-sandbox@0\.1\.0 — SANDBOXED in WASM/);
  assert.match(rendered, /grants: log/);
  assert.match(rendered, /no clock, no random, no filesystem, no network/);
  assert.match(rendered, /\[lego\.plugin-runtime\]/);
});
