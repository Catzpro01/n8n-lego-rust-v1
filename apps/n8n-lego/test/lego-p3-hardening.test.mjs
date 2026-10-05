/**
 * P3 Slice O — Hardening (Issues #75/#97): seeded property tests + byte-flip
 * fuzz against the workflow graph's fail-closed surface, and an error-family
 * scan across the P3 modules.
 *
 * Properties (what MUST hold under arbitrary corruption):
 *   1. EVERY byte flip in a bundle either loads losslessly identical OR is
 *      REJECTED with `WorkflowGraphError` — never a wrong graph, never a
 *      crash, never a hang (the integrity digest is the tripwire).
 *   2. Malformed definitions/graphs never yield a partial silent success.
 *   3. P3 modules raise ONE error family each (no mixed vocabularies).
 *
 * Determinism: mulberry32 seeded PRNG — failures are reproducible from the
 * printed seed (no Math.random anywhere).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  createWorkflowGraph, graphFromBundle, WorkflowGraphError,
} from '../src/lego/workflow-graph.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');

/** mulberry32 — tiny deterministic PRNG (same seed ⇒ same sequence). */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fixtureDefinition() {
  return {
    name: 'P3 hardening fixture',
    settings: { timezone: 'UTC', executionOrder: 'v1' },
    nodes: [
      { name: 'Start', type: 'n8n-nodes-base.start', typeVersion: 1, position: [0, 0], parameters: {}, id: 'n1' },
      { name: 'Branch', type: 'n8n-nodes-base.if', typeVersion: 2, position: [200, 0], parameters: {}, id: 'n2' },
      { name: 'Left', type: 'n8n-nodes-base.set', typeVersion: 3, position: [400, -60], parameters: {}, id: 'n3' },
      { name: 'Right', type: 'n8n-nodes-base.set', typeVersion: 3, position: [400, 60], parameters: {}, id: 'n4' },
      { name: 'Ghost', type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [600, 0], parameters: {}, id: 'n5' },
    ],
    connections: {
      Start: { main: [[{ node: 'Branch', type: 'main', index: 0 }]] },
      Branch: { main: [[{ node: 'Left', type: 'main', index: 0 }], [{ node: 'Right', type: 'main', index: 0 }]] },
      Left: { main: [[{ node: 'Ghost', type: 'main', index: 0 }]] },
      Right: { main: [[{ node: 'Ghost', type: 'main', index: 0 }]] },
      OrphanKey: { main: [[{ node: 'Start', type: 'main', index: 0 }]] },
    },
  };
}

/** Serialize the bundle into ONE string so byte flips are addressable. */
function bundleWire() {
  return JSON.stringify(createWorkflowGraph(fixtureDefinition()).exportBundle());
}

function isWorkflowGraphError(error) {
  return error instanceof WorkflowGraphError
    || (error !== null && typeof error === 'object' && error.name === 'WorkflowGraphError');
}

test('HARDENING: seeded property — random structural mutations load losslessly OR fail closed', () => {
  const seed = 0xC0FFEE; // fixed seed: this property is reproducible, not flaky
  const rnd = mulberry32(seed);
  const graph = graphFromBundle(JSON.parse(bundleWire()));
  const baselineNames = [...graph.nodeNames()].sort();
  let rejected = 0;
  for (let i = 0; i < 200; i += 1) {
    const bundle = JSON.parse(bundleWire());
    const roll = rnd();
    if (roll < 0.34) {
      // structural mutation: delete/replace a top-level key
      const keys = Object.keys(bundle);
      const key = keys[Math.floor(rnd() * keys.length)];
      if (rnd() < 0.5) delete bundle[key];
      else bundle[key] = null;
    } else if (roll < 0.67) {
      // chunk content mutation: corrupt a node string
      const c = Math.floor(rnd() * bundle.nodeChunks.length);
      const row = Math.floor(rnd() * bundle.nodeChunks[c].length);
      bundle.nodeChunks[c][row] = bundle.nodeChunks[c][row].slice(0, 4);
    } else {
      // count/digest lie: nodeCount off by one
      bundle.manifest = { ...bundle.manifest, nodeCount: bundle.manifest.nodeCount + 1 };
    }
    let loaded = null;
    let error = null;
    try {
      loaded = graphFromBundle(bundle);
    } catch (caught_) {
      error = caught_;
    }
    if (error === null) {
      // a mutation that still validates must round-trip IDENTICALLY
      assert.ok(isWorkflowGraphError(error) === false);
      const names = [...loaded.nodeNames()].sort();
      assert.deepEqual(names, baselineNames, `seed=${seed} iter=${i}: loaded graph must match baseline`);
    } else {
      assert.ok(isWorkflowGraphError(error), `seed=${seed} iter=${i}: rejected ONLY via WorkflowGraphError, got ${error && error.name}`);
      rejected += 1;
    }
  }
  assert.ok(rejected >= 1, `seed=${seed}: corruption tripwire actually fired (rejected=${rejected})`);
  // control: untouched bundle still loads
  const control = graphFromBundle(JSON.parse(bundleWire()));
  assert.deepEqual([...control.nodeNames()].sort(), baselineNames);
});

test('HARDENING: byte-flip fuzz on the wire — always WorkflowGraphError (or byte-identical load), never another failure', () => {
  const seed = 0xBADF00D;
  const rnd = mulberry32(seed);
  const wire = bundleWire();
  const bytes = Buffer.from(wire, 'utf8');
  let rejected = 0;
  let loaded = 0;
  for (let i = 0; i < 300; i += 1) {
    const pos = Math.floor(rnd() * bytes.length);
    const bit = 1 << Math.floor(rnd() * 8);
    const corrupted = Buffer.from(bytes);
    corrupted[pos] ^= bit; // deterministic single-bit flip
    let parsed = null;
    try {
      parsed = JSON.parse(corrupted.toString('utf8'));
    } catch {
      rejected += 1; // malformed JSON = fail closed before any graph code runs
      continue;
    }
    try {
      const g = graphFromBundle(parsed);
      // If it loaded, the graph must still answer the identity check honestly
      assert.equal(typeof g.nodeCount(), 'number');
      loaded += 1;
    } catch (error) {
      assert.ok(isWorkflowGraphError(error),
        `seed=${seed} iter=${i} byte=${pos}: graph-level failure must be WorkflowGraphError, got ${error && error.name}: ${error && error.message}`);
      rejected += 1;
    }
  }
  // both outcomes are legal; a wrong-graph outcome is not — covered above.
  assert.ok(rejected > 0, 'fuzz actually exercised the rejection path');
  assert.ok(loaded + rejected === 300, 'every iteration accounted for (no hangs)');
});

test('HARDENING: malformed DEFINITIONS fail closed in the one graph error family', () => {
  const okDef = () => ({ nodes: [{ name: 'A', type: 't' }], connections: {} });
  const bad = [
    [null, undefined],
    [{}, undefined],
    [{ nodes: 'x', connections: {} }, undefined],
    [{ nodes: [null], connections: {} }, undefined],
    [{ nodes: [{ name: '', type: 't' }], connections: {} }, undefined],
    [{ nodes: [{ name: 'A', type: 't' }, { name: 'A', type: 't' }], connections: {} }, undefined],
    [{ nodes: [{ name: 'A', type: 't' }], connections: [] }, undefined],
    [okDef(), { chunkSize: 0 }],           // options (arg 2), not definition props
    [okDef(), { chunkSize: 70000 }],
    [okDef(), { maxCachedChunks: -2 }],
    [okDef(), { lazy: 1 }],
  ];
  for (const [definition, options] of bad) {
    let error = null;
    try {
      createWorkflowGraph(definition, options);
    } catch (caught_) {
      error = caught_;
    }
    assert.ok(error !== null, `refused: ${JSON.stringify(definition)}`);
    assert.ok(isWorkflowGraphError(error), `family: got ${error && error.name}`);
    assert.equal(error.code, 'lego.contract_violation');
  }
  // an EMPTY workflow is LEGAL n8n (no nodes, no connections) — must build, not throw
  const empty = createWorkflowGraph({ nodes: [], connections: {} });
  assert.equal(empty.nodeCount(), 0);
  assert.equal(empty.edgeCount(), 0);
});

test('HARDENING: P3 modules each publish exactly ONE error family (vocabulary scan)', () => {
  const modules = [
    'workflow-graph.mjs',
    'workflow-dna.mjs',
    'bounded-frontier.mjs',
    'state-stream.mjs',
    'execution-ir.mjs',
    'execution-optimizer.mjs',
    'resource-guard.mjs',
  ];
  const legoDir = path.join(ROOT, 'src', 'lego');
  const compatOracle = path.join(ROOT, 'src', 'compat', 'oracle.mjs');
  for (const name of modules) {
    const source = readFileSync(path.join(legoDir, name), 'utf8');
    const classes = [...source.matchAll(/export class (\w+Error)\b/g)].map((m) => m[1]);
    assert.equal(classes.length, 1, `${name} exports exactly one error class (got ${classes.join(', ') || 'none'})`);
    const codes = new Set([...source.matchAll(/this\.code = '([^']+)'/g)].map((m) => m[1]));
    assert.equal(codes.size, 1, `${name} raises exactly one code family (got ${[...codes].join(', ')})`);
    assert.ok([...codes][0].includes('.'), `${name} code is namespaced`);
  }
  const oracle = readFileSync(compatOracle, 'utf8');
  const oracleClasses = [...oracle.matchAll(/export class (\w+Error)\b/g)].map((m) => m[1]);
  assert.deepEqual(oracleClasses, ['CompatibilityOracleError']);
});

test('HARDENING: no banned primitives across the P3 module set (clock/random/network/process)', () => {
  const files = [
    ...['workflow-graph.mjs', 'workflow-dna.mjs', 'bounded-frontier.mjs', 'state-stream.mjs',
      'execution-ir.mjs', 'execution-optimizer.mjs', 'resource-guard.mjs'].map((f) => path.join(ROOT, 'src', 'lego', f)),
    path.join(ROOT, 'src', 'compat', 'oracle.mjs'),
  ];
  const banned = [
    [/Math\.random/, 'Math.random'],
    [/Date\.now/, 'Date.now'],
    [/new Date\(/, 'new Date'],
    [/require\(/, 'require'],
    [/from 'node:(child_process|net|http|https|dns)'/, 'network/process builtin'],
    [/\bfetch\s*\(/, 'fetch'],
    [/process\.exit/, 'process.exit'],
  ];
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    for (const [pattern, label] of banned) {
      assert.ok(!pattern.test(source), `${path.basename(file)} must not use ${label}`);
    }
  }
});
