#!/usr/bin/env node
// Agent 5 — offline contract-conformance harness.
// Checks the golden reference workflows in tests/reference/* against the
// invariants declared in contracts/*.contract.md. NO network, NO docker,
// NO running n8n required -> can be executed on any checkout.
// It does NOT re-implement n8n behavior; it only asserts that the golden
// fixtures satisfy the contracts the LEGO owners published.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CONN_TYPES = ['main', 'ai_tool', 'ai_memory', 'ai_languageModel'];

const results = [];
const check = (name, fn) => {
  try { const d = fn(); results.push({ name, ok: true, detail: d ?? '' }); }
  catch (e) { results.push({ name, ok: false, detail: e.message }); }
};
const assert = (c, m) => { if (!c) throw new Error(m); };

// --- contract presence (contracts are the communication channel) -----------
const CONTRACTS = ['workflow', 'node', 'connection', 'validation'];
for (const c of CONTRACTS) {
  check(`contract:${c} present`, () => {
    const p = join(ROOT, 'contracts', `${c}.contract.md`);
    assert(existsSync(p), `missing contracts/${c}.contract.md`);
    return `${readFileSync(p, 'utf8').length} bytes`;
  });
}

// --- golden fixtures -------------------------------------------------------
const refDir = join(ROOT, 'tests', 'reference');
const fixtures = readdirSync(refDir, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(refDir, d.name, 'workflow.json')))
  .map((d) => ({ name: d.name, wf: JSON.parse(readFileSync(join(refDir, d.name, 'workflow.json'), 'utf8')) }));

check('golden fixtures discovered', () => {
  assert(fixtures.length > 0, 'no golden fixtures found under tests/reference');
  return fixtures.map((f) => f.name).join(', ');
});

for (const { name, wf } of fixtures) {
  // WorkflowContract schema
  check(`${name}: workflow schema`, () => {
    assert(typeof wf.id === 'string' && wf.id, 'id must be a non-empty string');
    assert(typeof wf.name === 'string' && wf.name, 'name must be a non-empty string');
    assert(Array.isArray(wf.nodes), 'nodes must be an array');
    assert(wf.connections && typeof wf.connections === 'object', 'connections must be an object');
    return `${wf.nodes.length} node(s)`;
  });

  // NodeContract schema
  check(`${name}: node schema`, () => {
    for (const n of wf.nodes) {
      assert(typeof n.id === 'string' && n.id, 'node.id required');
      assert(typeof n.name === 'string' && n.name, 'node.name required');
      assert(typeof n.type === 'string' && n.type, 'node.type required');
      assert(Number.isFinite(n.typeVersion), `node ${n.name}: typeVersion must be numeric`);
      assert(Array.isArray(n.position) && n.position.length === 2, `node ${n.name}: position must be [x,y]`);
      assert(n.parameters && typeof n.parameters === 'object', `node ${n.name}: parameters required`);
    }
    return 'ok';
  });

  // WorkflowContract invariant: unique node names
  check(`${name}: NodeUniqueness`, () => {
    const seen = new Set();
    for (const n of wf.nodes) {
      assert(!seen.has(n.name), `duplicate node name '${n.name}'`);
      seen.add(n.name);
    }
    return `${seen.size} unique name(s)`;
  });

  // ConnectionContract schema + DanglingConnections
  check(`${name}: connection schema + DanglingConnections`, () => {
    const names = new Set(wf.nodes.map((n) => n.name));
    let count = 0;
    for (const [src, byType] of Object.entries(wf.connections)) {
      assert(names.has(src), `connection source '${src}' is not a declared node`);
      for (const [type, outputs] of Object.entries(byType)) {
        assert(CONN_TYPES.includes(type), `unknown connection type '${type}'`);
        assert(Array.isArray(outputs), `${src}.${type} must be an array of output slots`);
        outputs.forEach((slot, outIdx) => {
          assert(slot === null || Array.isArray(slot), `${src}.${type}[${outIdx}] must be array|null`);
          for (const c of slot ?? []) {
            assert(names.has(c.node), `dangling connection ${src} -> '${c.node}'`);
            assert(CONN_TYPES.includes(c.type), `unknown target connection type '${c.type}'`);
            assert(Number.isInteger(c.index) && c.index >= 0, `input index must be integer >= 0`);
            assert(outIdx >= 0, 'output index must be >= 0');
            count++;
          }
        });
      }
    }
    return `${count} edge(s)`;
  });

  // ValidationContract: CycleDetection
  check(`${name}: CycleDetection (acyclic)`, () => {
    const adj = new Map(wf.nodes.map((n) => [n.name, []]));
    for (const [src, byType] of Object.entries(wf.connections))
      for (const outputs of Object.values(byType))
        for (const slot of outputs) for (const c of slot ?? []) adj.get(src).push(c.node);
    const WHITE = 0, GREY = 1, BLACK = 2;
    const color = new Map(wf.nodes.map((n) => [n.name, WHITE]));
    const stack = [];
    const visit = (n) => {
      color.set(n, GREY); stack.push(n);
      for (const m of adj.get(n) ?? []) {
        if (color.get(m) === GREY) throw new Error(`cycle detected: ${[...stack, m].join(' -> ')}`);
        if (color.get(m) === WHITE) visit(m);
      }
      stack.pop(); color.set(n, BLACK);
    };
    for (const n of color.keys()) if (color.get(n) === WHITE) visit(n);
    return 'acyclic';
  });
}

// --- Phase-2 guard: no premature Rust -------------------------------------
check('Phase 2: no Rust implementation introduced', () => {
  const offenders = [];
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.rs') || e.name === 'Cargo.toml') offenders.push(p.slice(ROOT.length + 1));
    }
  };
  walk(join(ROOT, 'crates')); walk(join(ROOT, 'apps'));
  assert(offenders.length === 0, `Rust artifacts present in Phase 2: ${offenders.join(', ')}`);
  return 'crates/ and apps/ contain no Rust sources';
});

const passed = results.filter((r) => r.ok).length;
console.log('=== [AGENT 5] CONTRACT CONFORMANCE (offline) ===');
for (const r of results) console.log(`${r.ok ? '[PASS]' : '[FAIL]'} ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
console.log('-------------------------------------------------------');
console.log(`RESULT: ${passed}/${results.length} CHECKS PASSED`);
process.exit(passed === results.length ? 0 : 1);
