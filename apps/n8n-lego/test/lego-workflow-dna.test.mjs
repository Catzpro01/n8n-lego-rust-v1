/**
 * P3 Slice H — Workflow DNA (Issues #75/#97).
 *
 * Proves: bounded constant-ish summary · exact identity = n8n checksum ·
 * morphology (histogram/degrees/fan bounds/orphans) · capped name lists ·
 * determinism · node-order shuffle keeps morphology, changes checksum only ·
 * single-domain import (checksum seam) · one error family.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  WORKFLOW_DNA_CONTRACT,
  WORKFLOW_DNA_CONTRACT_VERSION,
  WORKFLOW_DNA_LIST_CAP,
  WORKFLOW_DNA_VERSION,
  WorkflowDnaError,
  computeWorkflowDna,
} from '../src/lego/workflow-dna.mjs';
import { calculateWorkflowChecksum } from '../src/checksum.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const read = (relative) => readFileSync(join(REPO_ROOT, relative), 'utf8');
const LOCK = JSON.parse(read('apps/n8n-lego/src/lego/contracts/contract-lock.json'));
const ROWS = LOCK.contracts ?? LOCK;
const DOMAINS = JSON.parse(read('apps/n8n-lego/src/lego/manifest/domains.json'));
const WORKFLOW = (DOMAINS.domains ?? DOMAINS).find((d) => d.id === 'workflow');
const ERRORS = JSON.parse(read('apps/n8n-lego/src/lego/contracts/errors.contract.json'));
const SOURCE = read('apps/n8n-lego/src/lego/workflow-dna.mjs');

const caught = (fn) => {
  try { fn(); return null; } catch (error) { return error; }
};

function sampleDefinition() {
  return {
    name: 'DNA sample',
    settings: { timezone: 'Asia/Jakarta', executionOrder: 'v1' },
    meta: { instanceId: 'i-test' },
    active: false,
    nodes: [
      { name: 'Start', type: 'n8n-nodes-base.start', typeVersion: 1, position: [0, 0], parameters: {}, id: 'n1' },
      { name: 'HTTP', type: 'n8n-nodes-base.httpRequest', typeVersion: 4, position: [200, 0], parameters: {}, id: 'n2' },
      { name: 'Branch', type: 'n8n-nodes-base.if', typeVersion: 2, position: [400, 0], parameters: {}, id: 'n3' },
      { name: 'Set A', type: 'n8n-nodes-base.set', typeVersion: 3, position: [600, -80], parameters: {}, id: 'n4' },
      { name: 'Set B', type: 'n8n-nodes-base.set', typeVersion: 3, position: [600, 80], parameters: {}, id: 'n5' },
    ],
    connections: {
      Start: { main: [[{ node: 'HTTP', type: 'main', index: 0 }]] },
      HTTP: { main: [[{ node: 'Branch', type: 'main', index: 0 }]] },
      Branch: { main: [[{ node: 'Set A', type: 'main', index: 0 }], [{ node: 'Set B', type: 'main', index: 0 }]] },
      'Set A': { main: [[]] },
      Ghost: { main: [[{ node: 'Start', type: 'main', index: 0 }]] },
    },
  };
}

/* ============================================ A. CONTRACT / LOCK ROW (36th) */

test('the lock row is the thirty-sixth: workflow.dna@0.1.0, owner agent-1, exports byte-parity', () => {
  const row = ROWS.find((r) => r.id === 'workflow.dna');
  assert.ok(row, 'workflow.dna is locked');
  // P9.1 envelope + P3 optimizer are merged; P9.2 structured-log adds row 42.
  assert.equal(ROWS.length, 100, 'P3 Slice H adds the thirty-sixth (workflow.dna); P3 Slice J adds the thirty-seventh (execution.ir); P3 Slice L adds the thirty-eighth (compatibility.oracle); P3 Slice M adds the thirty-ninth (execution.guard); P3 Slice K the forty-first (execution.optimizer) — P6.1 adds node.registry@0.1.0; P6.2 adds registry.compiler@0.1.0; P6.3 adds package.transaction@0.1.0; P6.4 adds registry.closure@0.1.0; P6.5 adds node.resolution@0.1.0; P6.6 adds runtime.lease@0.1.0; P6.7 adds node.residency@0.1.0; P6.8 adds node.capability@0.1.0; P6.9 adds node.semantics@0.1.0; P6.10 adds node.lifecycle@0.1.0; P6.11 adds node.health@0.1.0; P6.12 adds node.supply-chain@0.1.0; P6.13 adds registry.incremental@0.1.0; P6.14 adds node.worker-convergence@0.1.0; P6.15 adds node.acceptance@0.1.0; P6.16 adds registry.integrity@0.1.0; P6.17 adds node.admission@0.1.0; P6.18 adds node.sbom@0.1.0; P6.19 adds node.canary@0.1.0; P6.20 adds node.revocation@0.1.0; P6.21 adds node.io@0.1.0; P6.22 adds runtime.jit@0.1.0; P6.23 adds runtime.cancel@0.1.0; P6.24 adds runtime.pool@0.1.0; P6.25 adds node.abi@0.1.0; P6.26 adds runtime.wasm-cache@0.1.0; P6.27 adds node.provenance@0.1.0; P6.28 adds registry.freshness@0.1.0; P6.29 adds node.namespace@0.1.0; P6.30 adds registry.repair@0.1.0; P6.31 adds registry.acceptance@0.1.0; count-pins say 76; P2.27.1 adds lego.plugin-runtime@0.1.0 (seventy-sixth); P5.1 adds the ninety-fifth (auth.principal)'); // P9 integration (Agent 1): P9.5-P9.22 add 18 observability.* rows on top of protected main 76 -> 94 (union, zero id collisions); P9 was developed on 24032a0c (57 rows). P5.2 adds the ninety-sixth (auth.session). P5.3 adds the ninety-seventh (auth.authorization). P5.5 adds the ninety-eighth (auth.credential-crypto). P5.6 adds the ninety-ninth (auth.account-security). P5.7 adds the hundredth (auth.machine-identity).
  assert.equal(row.owner, 'agent-1');
  assert.equal(row.domain, 'workflow');
  assert.equal(row.version, '0.1.0', 'R9: workflow domain contract 0.1.0');
  assert.equal(row.status, 'implemented');
  assert.deepEqual(row.surface, ['src/lego/workflow-dna.mjs']);
  const module_ = {
    WORKFLOW_DNA_CONTRACT, WORKFLOW_DNA_CONTRACT_VERSION, WORKFLOW_DNA_LIST_CAP,
    WORKFLOW_DNA_VERSION, WorkflowDnaError, computeWorkflowDna,
  };
  const locked = row.exports['src/lego/workflow-dna.mjs'];
  assert.deepEqual([...locked].sort(), Object.keys(module_).sort(), 'lock ⇄ module exports');
  assert.deepEqual([...locked], [...locked].slice().sort(), 'sorted ASCII');
  assert.deepEqual(row.tests, ['apps/n8n-lego/test/lego-workflow-dna.test.mjs']);
  assert.equal('operations' in row, false, 'no capability/REST surface (by design)');
  assert.equal('permissions' in row, false);
  assert.equal(WORKFLOW_DNA_CONTRACT.id, row.id);
  assert.equal(WORKFLOW_DNA_CONTRACT_VERSION, row.version);
  assert.equal(WORKFLOW_DNA_CONTRACT.owner, row.owner);
});

test('workflow domain owns the module; only the checksum seam is imported; one error family', () => {
  assert.ok(WORKFLOW.paths.includes('src/lego/workflow-dna.mjs'));
  assert.equal(WORKFLOW.status, 'partial');
  assert.equal(ERRORS.version, '1.2.0', 'errors contract untouched');
  const imports = [...SOURCE.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(imports, ['../checksum.mjs'], 'exactly one import: the workflow checksum seam');
  for (const forbidden of [/node:fs/, /node:http/, /setTimeout/, /Date\.now/, /Math\.random/, /process\./]) {
    assert.equal(forbidden.test(SOURCE), false, `${forbidden} must not appear`);
  }
  const published = new Set((ERRORS.codes ?? []).map((e) => e.code ?? e.id));
  for (const match of SOURCE.matchAll(/'(lego\.[a-z0-9_]+)'/g)) {
    assert.ok(published.has(match[1]), `${match[1]} is published`);
  }
});

/* ==================================================== B. IDENTITY + MORPHOLOGY */

test('DNA identity = the n8n-editor checksum; morphology matches the sample exactly', () => {
  const def = sampleDefinition();
  const dna = computeWorkflowDna(def);
  assert.equal(dna.dnaVersion, WORKFLOW_DNA_VERSION);
  assert.equal(dna.contract, 'workflow.dna@0.1.0');
  assert.equal(dna.checksum, calculateWorkflowChecksum(def), 'exact identity IS the contract checksum');
  assert.equal(dna.nodeCount, 5);
  assert.equal(dna.edgeCount, 5, 'Start→HTTP, HTTP→Branch, Branch→A, Branch→B, Ghost→Start');
  assert.deepEqual({ ...dna.typeHistogram }, {
    'n8n-nodes-base.httpRequest@4': 1,
    'n8n-nodes-base.if@2': 1,
    'n8n-nodes-base.set@3': 2,
    'n8n-nodes-base.start@1': 1,
  });
  // structural truth: the orphan Ghost→Start edge counts toward Start's fan-in → NO roots
  assert.equal(dna.rootCount, 0, 'every node has incoming (Start counts Ghost input structurally)');
  assert.deepEqual([...dna.roots], []);
  // leaves = nodes with zero outgoing links (Set A has an empty bundle)
  assert.equal(dna.leafCount, 2);
  assert.deepEqual([...dna.leaves], ['Set A', 'Set B']);
  assert.equal(dna.maxFanOut, 2, 'Branch fans out to two bundles');
  assert.equal(dna.maxFanIn, 1);
  assert.equal(dna.orphanConnectionKeyCount, 1);
  assert.deepEqual([...dna.orphanConnectionKeys], ['Ghost']);
  assert.deepEqual([...dna.headerFields], ['active', 'meta', 'name', 'settings'], 'header fields sorted, nodes/connections excluded');
  assert.equal(Object.isFrozen(dna), true);
  assert.equal(Object.isFrozen(dna.roots), true);
});

test('validation refuses malformed definitions in the one error family', () => {
  for (const bad of [null, 'x', 7, []]) {
    const error = caught(() => computeWorkflowDna(bad));
    assert.ok(error instanceof WorkflowDnaError);
    assert.equal(error.code, 'lego.contract_violation');
  }
  assert.equal(caught(() => computeWorkflowDna({ connections: {} })).details.field, 'nodes');
  assert.equal(caught(() => computeWorkflowDna({ nodes: [] })).details.field, 'connections');
  const dup = caught(() => computeWorkflowDna({
    nodes: [{ name: 'A', type: 't', typeVersion: 1 }, { name: 'A', type: 't', typeVersion: 1 }],
    connections: {},
  }));
  assert.equal(dup.details.reason, 'duplicate-name');
});

/* ================================== C. BOUNDEDNESS / DETERMINISM / METAMORPHIC */

test('name lists are capped — a huge workflow still yields a bounded DNA', () => {
  const n = 5000;
  const nodes = Array.from({ length: n }, (_, i) => ({
    name: `N${i}`, type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [i, 0], parameters: {},
  }));
  const def = { name: 'wide', nodes, connections: {} }; // all nodes are roots AND leaves
  const dna = computeWorkflowDna(def);
  assert.equal(dna.nodeCount, n, 'counts stay exact');
  assert.equal(dna.rootCount, n);
  assert.equal(dna.leafCount, n);
  assert.equal(dna.roots.length, WORKFLOW_DNA_LIST_CAP, 'root SAMPLE is capped at 64');
  assert.equal(dna.leaves.length, WORKFLOW_DNA_LIST_CAP, 'leaf SAMPLE is capped at 64');
  assert.deepEqual([...dna.roots], Array.from({ length: WORKFLOW_DNA_LIST_CAP }, (_, i) => `N${i}`), 'cap keeps the ordinal-first window');
  const keys = JSON.stringify(dna);
  assert.ok(keys.length < 4096, `DNA stays tiny for 5000 nodes (${keys.length} bytes) — bounded summary`);
});

test('determinism: same definition → deep-equal DNA; shuffle keeps morphology, changes checksum only', () => {
  const def = sampleDefinition();
  const a = computeWorkflowDna(def);
  const b = computeWorkflowDna(JSON.parse(JSON.stringify(def)));
  assert.deepEqual(a, b, 'byte-stable summary for identical input');
  // metamorphic: reorder the NODES array (connections untouched — keys are names)
  const shuffled = { ...def, nodes: [def.nodes[3], def.nodes[0], def.nodes[4], def.nodes[2], def.nodes[1]] };
  const c = computeWorkflowDna(shuffled);
  assert.notEqual(c.checksum, a.checksum, 'exact identity is order-sensitive (editor contract)');
  assert.deepEqual({ ...c.typeHistogram }, { ...a.typeHistogram }, 'histogram is order-insensitive');
  assert.equal(c.nodeCount, a.nodeCount);
  assert.equal(c.edgeCount, a.edgeCount);
  assert.equal(c.maxFanOut, a.maxFanOut);
  assert.equal(c.maxFanIn, a.maxFanIn);
  assert.equal(c.rootCount, a.rootCount);
  assert.equal(c.leafCount, a.leafCount);
  assert.deepEqual([...c.leaves].sort(), [...a.leaves].sort(), 'leaf SET stable under node reorder');
});
