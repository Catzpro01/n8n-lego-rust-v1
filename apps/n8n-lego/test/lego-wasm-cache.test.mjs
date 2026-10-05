/**
 * P6.26 — the WASM compilation cache.
 * Contract `runtime.wasm-cache@0.1.0`.
 *
 * Matrix: the key as content AND toolchain, hits and misses, cached failures that a new
 * toolchain re-asks, one key one module, the declaration rule, capacity that evicts only idle
 * entries and refuses rather than throwing away something running, adoption, hit verification,
 * targeted invalidation, the reads, and the walls.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  CACHE_ENTRY_OUTCOMES,
  CACHE_LOOKUP_STATES,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_ENTRIES,
  WASM_CACHE_CONTRACT,
  WASM_CACHE_CONTRACT_VERSION,
  WASM_CACHE_OPERATIONS,
  WASM_CACHE_PERMISSIONS,
  WASM_CACHE_REASONS,
  WASM_CACHE_RULES,
  WASM_CACHE_SCHEMA_VERSION,
  WasmCacheError,
  adopt,
  cacheDigest,
  cacheKey,
  createWasmCache,
  describeWasmCache,
  explainWasmCache,
  insert,
  invalidate,
  isCacheEntry,
  isWasmCache,
  lookup,
  release,
  stableJson,
  verifyHit,
} from '../src/lego/wasm-cache.mjs';

/* ------------------------------------------------------------------ fixtures */

const ARTIFACT = `sha256:${'a'.repeat(64)}`;
const ARTIFACT_V2 = `sha256:${'d'.repeat(64)}`;
const WIRE = 'b'.repeat(64);
const ABI = 'lego-native-abi@1';
const TOOLCHAIN = 'wazero-1.7';
const MODULE = `sha256:${'c'.repeat(64)}`;
const MODULE_V2 = `sha256:${'e'.repeat(64)}`;

const KEY = (overrides = {}) => cacheKey({ artifactDigest: ARTIFACT, ioDigest: WIRE, abiVersion: ABI, toolchain: TOOLCHAIN, ...overrides });

const INSERTED = (cache, overrides = {}) => {
  const result = insert(cache, { artifactDigest: ARTIFACT, ioDigest: WIRE, abiVersion: ABI, toolchain: TOOLCHAIN, moduleDigest: MODULE, bytes: 1024, tick: 0, ...overrides });
  assert.equal(result.ok, true, result.message);
  return result;
};

const throwsWith = (fn, code) => {
  let caught = null;
  try { fn(); } catch (error) { caught = error; }
  assert.ok(caught instanceof WasmCacheError, `expected a WasmCacheError carrying ${code}`);
  assert.equal(caught.code, 'lego.contract_violation');
  assert.equal(caught.meta.code, code);
  return caught;
};

/* ------------------------------------------------------------------ contract */

test('the contract surface is the published one: id, version, ops, closed vocabularies', () => {
  assert.equal(WASM_CACHE_CONTRACT, 'runtime.wasm-cache@0.1.0');
  assert.equal(WASM_CACHE_CONTRACT_VERSION, '0.1.0');
  assert.equal(WASM_CACHE_SCHEMA_VERSION, 1);
  assert.deepEqual([...WASM_CACHE_OPERATIONS], ['lookup', 'insert', 'adopt', 'release', 'invalidate', 'describe']);
  assert.deepEqual([...WASM_CACHE_PERMISSIONS], ['node:read']);
  assert.deepEqual([...CACHE_LOOKUP_STATES], ['hit', 'negative', 'miss']);
  assert.deepEqual([...CACHE_ENTRY_OUTCOMES], ['compiled', 'failed']);
  assert.equal(WASM_CACHE_REASONS.length, 6);
  assert.equal(DEFAULT_MAX_ENTRIES, 64);
  assert.equal(DEFAULT_MAX_BYTES, 64 * 1024 * 1024);
  assert.match(WASM_CACHE_RULES.inUse, /refused rather than throwing away something running/);
  assert.match(WASM_CACHE_RULES.authority, /never compiles or executes/);
});

test('a cache key carries what it identifies, and the toolchain is part of the identity', () => {
  assert.equal(KEY(), KEY(), 'the same inputs give the same key');
  assert.match(KEY(), /^[0-9a-f]{64}$/);
  assert.notEqual(KEY({ toolchain: 'wasmtime-26' }), KEY(), 'the same artifact compiled by another engine is another object');
  assert.notEqual(KEY({ artifactDigest: ARTIFACT_V2 }), KEY());
  assert.notEqual(KEY({ ioDigest: 'f'.repeat(64) }), KEY(), 'the same artifact under another wire contract is another module');
  assert.notEqual(KEY({ abiVersion: 'lego-native-abi@2' }), KEY());
  throwsWith(() => cacheKey({ artifactDigest: ARTIFACT, ioDigest: WIRE, abiVersion: ABI }), 'cache.key');
  throwsWith(() => cacheKey({ artifactDigest: ARTIFACT, ioDigest: WIRE, toolchain: TOOLCHAIN }), 'cache.key');
  throwsWith(() => cacheKey({}), 'cache.key');
  assert.equal(cacheDigest({ b: 1, a: 2 }), cacheDigest({ a: 2, b: 1 }));
  assert.equal(stableJson({ b: 1, a: 2 }), stableJson({ a: 2, b: 1 }));
});

test('a cache is created with real limits, and it refuses limits that are not limits', () => {
  const cache = createWasmCache();
  assert.equal(isWasmCache(cache), true);
  assert.equal(cache.maxEntries, DEFAULT_MAX_ENTRIES);
  assert.equal(cache.maxBytes, DEFAULT_MAX_BYTES);
  assert.equal(cache.entries.size, 0);
  assert.equal(createWasmCache({ maxEntries: 2, maxBytes: 4096 }).maxBytes, 4096);
  throwsWith(() => createWasmCache({ maxEntries: 0 }), 'cache.input');
  throwsWith(() => createWasmCache({ maxBytes: -1 }), 'cache.input');
  throwsWith(() => createWasmCache({ maxEntries: 1.5 }), 'cache.input');
  assert.equal(isWasmCache({ contract: WASM_CACHE_CONTRACT }), false);
  assert.equal(isCacheEntry({ contract: WASM_CACHE_CONTRACT, key: 'k' }), false);
});

/* -------------------------------------------------------- hits, misses, facts */

test('a compiled module is cached and found, and a miss is not a failure', () => {
  const cache = createWasmCache();
  const inserted = INSERTED(cache);
  assert.equal(inserted.inserted, true);
  assert.equal(inserted.entry.bytes, 1024);
  assert.equal(inserted.entry.outcome, 'compiled');
  assert.equal(inserted.entry.inUse, 0);
  assert.match(inserted.entry.entryDigest, /^[0-9a-f]{64}$/);
  assert.equal(isCacheEntry(inserted.entry), true);

  const hit = lookup(cache, { artifactDigest: ARTIFACT, ioDigest: WIRE, abiVersion: ABI, toolchain: TOOLCHAIN, tick: 5 });
  assert.equal(hit.state, 'hit');
  assert.equal(hit.entry.lastUsedAt, 5, 'a lookup records that the entry was wanted');
  assert.match(hit.message, /hit on wazero-1\.7: module cccccccccccc…, 1024 byte\(s\)/);
  const miss = lookup(cache, { artifactDigest: ARTIFACT_V2, ioDigest: WIRE, abiVersion: ABI, toolchain: TOOLCHAIN, tick: 6 });
  assert.equal(miss.state, 'miss');
  assert.equal(miss.entry, null);
  assert.match(miss.message, /a miss is not a failure/);
  assert.equal(describeWasmCache(cache).counters.hits, 1);
  assert.equal(describeWasmCache(cache).counters.misses, 1);
  assert.equal(describeWasmCache(cache).toolchains.length, 1);
  throwsWith(() => lookup(cache, { artifactDigest: ARTIFACT, ioDigest: WIRE, abiVersion: ABI, toolchain: TOOLCHAIN }), 'cache.input');
  throwsWith(() => lookup({}, { artifactDigest: ARTIFACT, ioDigest: WIRE, abiVersion: ABI, toolchain: TOOLCHAIN, tick: 1 }), 'cache.input');
});

test('a failed compilation is cached as a fact, and a new toolchain asks the question again', () => {
  const cache = createWasmCache();
  const failed = insert(cache, { artifactDigest: ARTIFACT, ioDigest: WIRE, abiVersion: ABI, toolchain: TOOLCHAIN, outcome: 'failed', reason: 'module declares an unsupported memory limit', tick: 1 });
  assert.equal(failed.entry.outcome, 'failed');
  assert.equal(failed.entry.bytes, 0);
  assert.match(failed.message, /cached the failure for wazero-1\.7/);
  const negative = lookup(cache, { artifactDigest: ARTIFACT, ioDigest: WIRE, abiVersion: ABI, toolchain: TOOLCHAIN, tick: 2 });
  assert.equal(negative.state, 'negative');
  assert.match(negative.message, /already failed to compile on wazero-1\.7: module declares an unsupported memory limit/);
  // Another engine is another question: the toolchain is in the key, so the failure is not inherited.
  const reasked = lookup(cache, { artifactDigest: ARTIFACT, ioDigest: WIRE, abiVersion: ABI, toolchain: 'wasmtime-26', tick: 3 });
  assert.equal(reasked.state, 'miss', 'a new toolchain does not inherit last toolchain\'s failure');
  assert.equal(describeWasmCache(cache).counters.negativeHits, 1);
  assert.equal(describeWasmCache(cache).failed, 1);
  throwsWith(() => insert(cache, { artifactDigest: ARTIFACT_V2, ioDigest: WIRE, abiVersion: ABI, toolchain: TOOLCHAIN, outcome: 'failed', tick: 4 }), 'cache.insert');
  throwsWith(() => insert(cache, { artifactDigest: ARTIFACT_V2, ioDigest: WIRE, abiVersion: ABI, toolchain: TOOLCHAIN, outcome: 'failed', reason: 'x', bytes: 10, tick: 4 }), 'cache.insert');
  throwsWith(() => insert(cache, { artifactDigest: ARTIFACT_V2, ioDigest: WIRE, abiVersion: ABI, toolchain: TOOLCHAIN, outcome: 'maybe', tick: 4 }), 'cache.insert');
});

test('one key holds one module, and a module without a digest is a guess', () => {
  const cache = createWasmCache();
  INSERTED(cache);
  const duplicate = INSERTED(cache);
  assert.equal(duplicate.inserted, false);
  assert.equal(duplicate.duplicate, true);
  assert.match(duplicate.message, /already cached under this key/);
  assert.match(
    throwsWith(() => INSERTED(cache, { moduleDigest: MODULE_V2 }), 'cache.insert').message,
    /one key holds one module/,
  );
  assert.match(
    throwsWith(() => INSERTED(cache, { moduleDigest: null }), 'cache.insert').message,
    /a hit nobody can verify is a guess/,
  );
  throwsWith(() => INSERTED(cache, { bytes: 0 }), 'cache.insert');
  throwsWith(() => INSERTED(cache, { bytes: -5 }), 'cache.insert');
  throwsWith(() => INSERTED(cache, { tick: -1 }), 'cache.input');
  throwsWith(() => INSERTED({}, {}), 'cache.input');
  assert.equal(describeWasmCache(cache).entries, 1, 'a refused insert adds nothing');
});

/* ------------------------------------------------------------------ capacity */

test('capacity evicts idle entries by recency, and refuses rather than evicting what is running', () => {
  const cache = createWasmCache({ maxEntries: 2, maxBytes: 4096 });
  INSERTED(cache, { artifactDigest: `sha256:${'1'.repeat(64)}`, tick: 0 });
  INSERTED(cache, { artifactDigest: `sha256:${'2'.repeat(64)}`, tick: 10 });
  lookup(cache, { artifactDigest: `sha256:${'1'.repeat(64)}`, ioDigest: WIRE, abiVersion: ABI, toolchain: TOOLCHAIN, tick: 20 });
  const third = INSERTED(cache, { artifactDigest: `sha256:${'3'.repeat(64)}`, tick: 30 });
  assert.equal(third.evicted.length, 1, 'the least recently used idle entry makes room');
  assert.equal(third.evicted[0], cacheKey({ artifactDigest: `sha256:${'2'.repeat(64)}`, ioDigest: WIRE, abiVersion: ABI, toolchain: TOOLCHAIN }));
  assert.match(third.message, /evicting 1 idle entry\(ies\)/);
  assert.equal(describeWasmCache(cache).counters.evictions, 1);

  // Now hold both entries: nothing may be thrown away, so nothing is — the insert is refused.
  const held = createWasmCache({ maxEntries: 2, maxBytes: 4096 });
  const first = INSERTED(held, { artifactDigest: `sha256:${'4'.repeat(64)}`, tick: 0 });
  const second = INSERTED(held, { artifactDigest: `sha256:${'5'.repeat(64)}`, tick: 1 });
  adopt(held, first.entry.key);
  adopt(held, second.entry.key);
  const refused = insert(held, { artifactDigest: `sha256:${'6'.repeat(64)}`, ioDigest: WIRE, abiVersion: ABI, toolchain: TOOLCHAIN, moduleDigest: MODULE, bytes: 1024, tick: 2 });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'cache.capacity');
  assert.match(refused.message, /refusing the insert rather than throwing away a module that is running/);
  assert.equal(describeWasmCache(held).entries, 2);
  assert.equal(describeWasmCache(held).counters.refusals, 1);
  release(held, first.entry.key);
  const after = INSERTED(held, { artifactDigest: `sha256:${'6'.repeat(64)}`, tick: 3 });
  assert.equal(after.evicted.length, 1, 'once released, the entry is idle and may be evicted');

  // The byte budget is a limit too.
  const small = createWasmCache({ maxEntries: 10, maxBytes: 2048 });
  INSERTED(small, { artifactDigest: `sha256:${'7'.repeat(64)}`, bytes: 1024, tick: 0 });
  INSERTED(small, { artifactDigest: `sha256:${'8'.repeat(64)}`, bytes: 1024, tick: 1 });
  const tooBig = insert(small, { artifactDigest: `sha256:${'9'.repeat(64)}`, ioDigest: WIRE, abiVersion: ABI, toolchain: TOOLCHAIN, moduleDigest: MODULE, bytes: 4096, tick: 2 });
  assert.equal(tooBig.ok, false);
  assert.match(tooBig.message, /no room for 4096 byte\(s\)/);
});

test('adoption counts users, and releasing without adopting is refused', () => {
  const cache = createWasmCache();
  const entry = INSERTED(cache).entry;
  assert.equal(adopt(cache, entry.key).inUse, 1);
  assert.equal(adopt(cache, entry.key).inUse, 2, 'two users of one module are two reasons not to throw it away');
  assert.equal(release(cache, entry.key).inUse, 1);
  assert.equal(release(cache, entry.key).inUse, 0);
  assert.match(throwsWith(() => release(cache, entry.key), 'cache.lookup').message, /would invent a user/);
  throwsWith(() => adopt(cache, 'nope'), 'cache.lookup');
  throwsWith(() => release(cache, 'nope'), 'cache.lookup');
  throwsWith(() => adopt({}, entry.key), 'cache.input');
});

/* --------------------------------------------------------------- verification */

test('a hit is only worth something once it is verified, and a cached failure has nothing to verify', () => {
  const cache = createWasmCache();
  const entry = INSERTED(cache).entry;
  const verified = verifyHit(entry, MODULE);
  assert.equal(verified.verified, true);
  assert.match(verified.message, /the module matches the entry/);
  const tampered = verifyHit(entry, MODULE_V2);
  assert.equal(tampered.ok, false);
  assert.equal(tampered.reason, 'cache.lookup');
  assert.match(tampered.message, /does not match the entry: expected cccccccccccc… and got eeeeeeeeeeee…/);
  const failed = insert(cache, { artifactDigest: `sha256:${'f'.repeat(64)}`, ioDigest: WIRE, abiVersion: ABI, toolchain: TOOLCHAIN, outcome: 'failed', reason: 'unsupported import', tick: 1 }).entry;
  assert.equal(verifyHit(failed, MODULE).verified, false);
  assert.match(verifyHit(failed, MODULE).message, /there is no module to verify/);
  throwsWith(() => verifyHit(entry, ''), 'cache.lookup');
  throwsWith(() => verifyHit({ key: 'x' }, MODULE), 'cache.input');
});

/* -------------------------------------------------------------- invalidation */

test('invalidation is targeted, and it leaves what is in use alone', () => {
  const cache = createWasmCache();
  const first = INSERTED(cache, { artifactDigest: ARTIFACT, tick: 0 }).entry;
  INSERTED(cache, { artifactDigest: ARTIFACT, toolchain: 'wasmtime-26', tick: 1 });
  INSERTED(cache, { artifactDigest: ARTIFACT_V2, tick: 2 });
  adopt(cache, first.key);

  const byArtifact = invalidate(cache, { artifactDigest: ARTIFACT });
  assert.equal(byArtifact.removed.length, 1, 'the other toolchain went, the held entry stayed');
  assert.deepEqual([...byArtifact.held], [first.key]);
  assert.match(byArtifact.message, /1 entry\(ies\) invalidated; 1 are in use and remain until released/);
  assert.equal(describeWasmCache(cache).entries, 2);

  const byToolchain = invalidate(cache, { toolchain: TOOLCHAIN });
  assert.equal(byToolchain.removed.length, 1, 'the other artifact under this toolchain is idle and goes');
  assert.deepEqual([...byToolchain.held], [first.key], 'the held entry stays, whatever the selector says');
  assert.equal(describeWasmCache(cache).entries, 1);
  release(cache, first.key);
  assert.equal(invalidate(cache, { toolchain: TOOLCHAIN }).removed.length, 1, 'once released, the held entry is no longer exempt');
  assert.match(
    throwsWith(() => invalidate(cache, {}), 'cache.invalidate').message,
    /clearing a cache is a restart/,
  );
  throwsWith(() => invalidate({}, { toolchain: TOOLCHAIN }), 'cache.input');
  assert.equal(describeWasmCache(cache).counters.invalidations, 3);
});

test('the census digests the cache, and a review can read it in one line', () => {
  const cache = createWasmCache({ maxEntries: 4, maxBytes: 8192 });
  INSERTED(cache, { tick: 0 });
  lookup(cache, { artifactDigest: ARTIFACT, ioDigest: WIRE, abiVersion: ABI, toolchain: TOOLCHAIN, tick: 1 });
  insert(cache, { artifactDigest: ARTIFACT_V2, ioDigest: WIRE, abiVersion: ABI, toolchain: TOOLCHAIN, outcome: 'failed', reason: 'unsupported import', tick: 2 });
  const described = describeWasmCache(cache);
  assert.equal(described.entries, 2);
  assert.equal(described.compiled, 1);
  assert.equal(described.failed, 1);
  assert.equal(described.bytes, 1024);
  assert.deepEqual([...described.toolchains], [TOOLCHAIN]);
  assert.equal(described.counters.hits, 1);
  assert.match(described.cacheDigest, /^[0-9a-f]{64}$/);
  const { cacheDigest: digest, ...body } = described;
  assert.equal(digest, cacheDigest(body));
  assert.match(explainWasmCache(cache), /wasm cache: 2\/4 entries \(1 compiled, 1 cached failures\), 1024\/8192 bytes, 1 hit\(s\), 0 miss\(es\), 0 eviction\(s\); toolchains: wazero-1\.7/);
  throwsWith(() => describeWasmCache({}), 'cache.input');
});

/* --------------------------------------------------------------------- walls */

test('the cache stores what it is told: it compiles nothing and touches no engine', () => {
  const source = readFileSync(new URL('../src/lego/wasm-cache.mjs', import.meta.url), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const forbidden of ['node:fs', 'node:net', 'node:http', 'node:os', 'node:child_process', 'process.', 'Math.random', 'setTimeout', 'performance.', 'fetch(', 'node:vm', 'eval(', 'WebAssembly', 'compileStreaming', 'instantiate']) {
    assert.equal(code.includes(forbidden), false, `the cache contract must not reference ${forbidden}`);
  }
  assert.deepEqual([...code.matchAll(/from '(node:[a-z_/]+)'/g)].map((match) => match[1]), ['node:crypto']);
  assert.equal(/\bnew Date\b|\bDate\.now\b/.test(code), false);
  for (const forbidden of ['./native-abi.mjs', './jit-lease.mjs', './runtime-pool.mjs', './cancel-accounting.mjs', './node-residency.mjs', './io-compiler.mjs']) {
    assert.equal(code.includes(forbidden), false, `P6.26 must not reach into ${forbidden}: the digests and the sizes arrive as data`);
  }
  for (const name of ['declareDualArtifact', 'selectImplementation', 'requestLease', 'loadNode', 'compileNodeIo']) {
    assert.equal(code.includes(name), false, `${name} belongs to another milestone`);
  }
});

/* ------------------------------------------------------------------- lock row */

test('the contract-lock row is canonical: one row, version, ops, tests, exports, domain path', () => {
  const lock = JSON.parse(readFileSync(new URL('../src/lego/contracts/contract-lock.json', import.meta.url)));
  const rows = lock.contracts.filter((contract) => contract.id === 'runtime.wasm-cache');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].version, WASM_CACHE_CONTRACT_VERSION);
  assert.equal(rows[0].domain, 'node-registry');
  assert.equal(rows[0].status, 'implemented');
  assert.deepEqual(rows[0].surface, ['src/lego/wasm-cache.mjs']);
  assert.deepEqual(rows[0].tests, ['apps/n8n-lego/test/lego-wasm-cache.test.mjs']);
  for (const name of ['createWasmCache', 'cacheKey', 'lookup', 'insert', 'adopt', 'release', 'verifyHit', 'invalidate', 'describeWasmCache']) {
    assert.equal(rows[0].exports['src/lego/wasm-cache.mjs'].includes(name), true, `${name} must be locked`);
  }
  for (const id of ['node.registry', 'node.io', 'node.abi', 'runtime.jit', 'runtime.cancel', 'runtime.pool', 'registry.compiler', 'node.admission', 'node.sbom', 'node.canary', 'node.revocation']) {
    assert.equal(lock.contracts.find((contract) => contract.id === id).version, '0.1.0', `P6.26 must not re-version ${id}`);
  }
  const domain = JSON.parse(readFileSync(new URL('../src/lego/manifest/domains.json', import.meta.url)))
    .domains.find((entry) => entry.id === 'node-registry');
  assert.equal(domain.contract.id, 'node.portability');
  assert.ok(domain.paths.includes('src/lego/wasm-cache.mjs'));
});
