/**
 * P6.21 — the node I/O compiler.
 * Contract `node.io@0.1.0`.
 *
 * Matrix: the compiled wire contract (named ports, quoted connection types, typed fields,
 * a digest per shape), the compatibility verdict (identical / additive / breaking, with the
 * reason named — including the closed-shape rule), the boundary plan (inline, reference or
 * refused, because a payload is not pushed into a sandbox and an unknown value is not
 * promised to arrive intact), the reads, and the walls.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { NODE_RUNTIME_LOCALITIES } from '../src/lego/node-registry.mjs';
import {
  CONNECTION_TYPE_ALIASES,
  IO_CONTRACT,
  IO_CONTRACT_VERSION,
  IO_OPERATIONS,
  IO_PERMISSIONS,
  IO_REASONS,
  IO_RULES,
  IO_SCHEMA_VERSION,
  IO_VERDICTS,
  ITEM_FIELD_TYPES,
  IoError,
  NODE_CONNECTION_TYPES,
  PORT_ARITIES,
  TRANSPORT_KINDS,
  compareNodeIo,
  compileNodeIo,
  describeNodeIo,
  explainIoDiff,
  explainNodeIo,
  ioDigest,
  isIoDiff,
  isNodeIo,
  planHandoff,
  stableJson,
} from '../src/lego/io-compiler.mjs';

/* ------------------------------------------------------------------ fixtures */

const SET = (overrides = {}) => compileNodeIo({
  identity: 'n8n-nodes-base.set@3.4',
  inputs: [{ name: 'main', connectionType: 'main', fields: { id: 'string', payload: 'object' } }],
  outputs: [{ name: 'main', connectionType: 'main', fields: { id: 'string', payload: 'object' } }],
  ...overrides,
});

const throwsWith = (fn, code) => {
  let caught = null;
  try { fn(); } catch (error) { caught = error; }
  assert.ok(caught instanceof IoError, `expected an IoError carrying ${code}`);
  assert.equal(caught.code, 'lego.contract_violation');
  assert.equal(caught.meta.code, code);
  return caught;
};

/* ------------------------------------------------------------------ contract */

test('the contract surface is the published one: id, version, ops, quoted vocabularies', () => {
  assert.equal(IO_CONTRACT, 'node.io@0.1.0');
  assert.equal(IO_CONTRACT_VERSION, '0.1.0');
  assert.equal(IO_SCHEMA_VERSION, 1);
  assert.deepEqual([...IO_OPERATIONS], ['compile', 'compare', 'handoff', 'describe']);
  assert.deepEqual([...IO_PERMISSIONS], ['node:read']);
  assert.deepEqual([...PORT_ARITIES], ['single', 'many']);
  assert.deepEqual([...IO_VERDICTS], ['identical', 'additive', 'breaking']);
  assert.deepEqual([...TRANSPORT_KINDS], ['inline', 'reference', 'refused']);
  assert.equal(IO_REASONS.length, 6);
  assert.equal(NODE_CONNECTION_TYPES.includes('main'), true);
  assert.equal(NODE_CONNECTION_TYPES.includes('ai_tool'), true);
  assert.equal(NODE_CONNECTION_TYPES.length, 13);
  assert.deepEqual({ ...CONNECTION_TYPE_ALIASES }, { ai_vectorRetriever: 'ai_vectorStore' });
  assert.equal(ITEM_FIELD_TYPES.includes('binary'), true);
  assert.equal(ITEM_FIELD_TYPES.includes('date'), true);
  assert.equal(IO_RULES.authority, 'this contract compiles ports; it never decides that a node may run');
  assert.deepEqual([...NODE_RUNTIME_LOCALITIES], ['js-compat', 'remote-worker', 'rust-native', 'wasm'], 'the locality vocabulary is the foundation\'s, quoted');
});

test('compiling a declaration gives named ports, quoted connection types and a digest per shape', () => {
  const io = SET();
  assert.equal(isNodeIo(io), true);
  assert.equal(Object.isFrozen(io), true);
  assert.equal(io.identity, 'n8n-nodes-base.set@3.4');
  assert.equal(io.trigger, false);
  assert.equal(io.additionalProperties, true);
  assert.deepEqual([...io.inputs[0].fieldNames], ['id', 'payload']);
  assert.equal(io.inputs[0].aliasedFrom, null);
  assert.equal(io.inputs[0].arity, 'many');
  assert.match(io.inputs[0].shapeDigest, /^[0-9a-f]{64}$/);
  assert.match(io.ioDigest, /^[0-9a-f]{64}$/);
  assert.equal(new Set([io.inputs[0].shapeDigest, io.outputs[0].shapeDigest]).size, 1, 'two ports with one shape share one digest');
  const { ioDigest: digest, ...fields } = io;
  assert.equal(digest, ioDigest(fields));
  assert.equal(stableJson({ b: 1, a: 2 }), stableJson({ a: 2, b: 1 }));
  assert.equal(isNodeIo({ contract: IO_CONTRACT, identity: 'a@1' }), false);
  assert.equal(isNodeIo(null), false);
});

test('a node that neither reads nor writes is not a node, and an unreachable node must be a trigger', () => {
  throwsWith(() => SET({ inputs: [], outputs: [] }), 'io.port');
  assert.match(throwsWith(() => SET({ inputs: [] }), 'io.port').message, /must be a trigger/);
  const trigger = SET({ inputs: [], trigger: true });
  assert.equal(trigger.trigger, true);
  assert.equal(trigger.inputs.length, 0);
  assert.equal(describeNodeIo(trigger).inputs.length, 0);
  // A sink is legitimate: a node may write nothing.
  assert.equal(SET({ outputs: [] }).outputs.length, 0);
  throwsWith(() => compileNodeIo({}), 'io.input');
  throwsWith(() => compileNodeIo({ identity: 'n8n-nodes-base.set' }), 'io.input');
  throwsWith(() => compileNodeIo({ identity: '@3.4' }), 'io.input');
  throwsWith(() => SET({ trigger: 'yes' }), 'io.input');
  throwsWith(() => SET({ additionalProperties: 'closed' }), 'io.input');
  throwsWith(() => SET({ inputs: 'main' }), 'io.input');
});

test('ports are named once per direction, and the connection type vocabulary is closed', () => {
  throwsWith(() => SET({ inputs: [{ name: '', connectionType: 'main' }] }), 'io.port');
  assert.match(
    throwsWith(() => SET({ inputs: [{ name: 'main', connectionType: 'main' }, { name: 'main', connectionType: 'main' }] }), 'io.port').message,
    /declared twice/,
  );
  assert.match(
    throwsWith(() => SET({ outputs: [{ name: 'main', connectionType: 'vector' }] }), 'io.type').message,
    /is not one n8n publishes/,
  );
  throwsWith(() => SET({ inputs: [{ name: 'main', connectionType: 'main', arity: 'some' }] }), 'io.port');
  const aliased = SET({ inputs: [{ name: 'store', connectionType: 'ai_vectorRetriever' }] });
  assert.equal(aliased.inputs[0].connectionType, 'ai_vectorStore');
  assert.equal(aliased.inputs[0].aliasedFrom, 'ai_vectorRetriever');
  assert.match(describeNodeIo(aliased).inputs[0], /aliased from ai_vectorRetriever/);
  // The same name on both sides is legitimate: one port in, one port out.
  const both = SET({ inputs: [{ name: 'main', connectionType: 'main' }], outputs: [{ name: 'main', connectionType: 'main' }] });
  assert.equal(both.inputs[0].name, both.outputs[0].name);
});

test('a shape is a promise: fields have types, and an unknown type is refused rather than tolerated', () => {
  throwsWith(() => SET({ inputs: [{ name: 'main', connectionType: 'main', fields: { id: 'uuid' } }] }), 'io.shape');
  throwsWith(() => SET({ inputs: [{ name: 'main', connectionType: 'main', fields: ['id'] }] }), 'io.shape');
  throwsWith(() => SET({ inputs: [{ name: 'main', connectionType: 'main', fields: { '': 'string' } }] }), 'io.shape');
  const closed = SET({ additionalProperties: false });
  assert.equal(closed.additionalProperties, false);
  assert.equal(describeNodeIo(closed).shape, 'closed');
  assert.notEqual(closed.ioDigest, SET().ioDigest, 'closing a shape changes what the contract promises');
});

/* ------------------------------------------------------------- compatibility */

test('an unchanged wire contract compares identical, and says so without naming changes', () => {
  const diff = compareNodeIo(SET(), SET());
  assert.equal(diff.verdict, 'identical');
  assert.equal(diff.changes.length, 0);
  assert.equal(isIoDiff(diff), true);
  assert.match(explainIoDiff(diff), /n8n-nodes-base\.set@3\.4: the wire contract is unchanged/);
  throwsWith(() => compareNodeIo(SET(), compileNodeIo({ identity: 'n8n-nodes-base.if@2.2', inputs: [{ name: 'main', connectionType: 'main' }], outputs: [{ name: 'main', connectionType: 'main' }] })), 'io.compare');
  throwsWith(() => compareNodeIo(SET(), { identity: 'n8n-nodes-base.set@3.4' }), 'io.input');
  assert.equal(isIoDiff({ verdict: 'probably-fine', changes: [] }), false);
});

test('a version movement is breaking when an existing caller could notice, and the reason is named', () => {
  const removed = compareNodeIo(SET(), SET({ inputs: [{ name: 'other', connectionType: 'main' }] }));
  assert.equal(removed.verdict, 'breaking');
  assert.match(explainIoDiff(removed), /port-removed input:main, port-added input:other/);
  assert.equal(removed.changes.find((change) => change.kind === 'port-removed').impact, 'breaking');
  assert.equal(removed.changes.find((change) => change.kind === 'port-added').impact, 'additive');

  const retyped = compareNodeIo(SET({ inputs: [{ name: 'tool', connectionType: 'ai_tool' }] }), SET({ inputs: [{ name: 'tool', connectionType: 'ai_languageModel' }] }));
  assert.equal(retyped.verdict, 'breaking');
  assert.match(retyped.changes[0].detail, /existing wires are of the wrong kind/);

  const narrowed = compareNodeIo(SET(), SET({ inputs: [{ name: 'main', connectionType: 'main', arity: 'single', fields: { id: 'string', payload: 'object' } }] }));
  assert.equal(narrowed.verdict, 'breaking');
  assert.match(narrowed.changes.find((change) => change.kind === 'arity-narrowed').detail, /a graph that used the second connection breaks/);

  const droppedField = compareNodeIo(SET(), SET({ inputs: [{ name: 'main', connectionType: 'main', fields: { id: 'string' } }] }));
  assert.equal(droppedField.verdict, 'breaking');
  assert.equal(droppedField.changes.find((change) => change.kind === 'field-removed').field, 'payload');

  const retypedField = compareNodeIo(SET(), SET({ inputs: [{ name: 'main', connectionType: 'main', fields: { id: 'number', payload: 'object' } }] }));
  assert.equal(retypedField.changes.find((change) => change.kind === 'field-type-changed').detail, "'id' was string and is now number");

  const becameTrigger = compareNodeIo(SET(), SET({ inputs: [], trigger: true }));
  assert.equal(becameTrigger.verdict, 'breaking');
  assert.equal(becameTrigger.changes.find((change) => change.kind === 'trigger-changed').impact, 'breaking');
});

test('a field added to a CLOSED shape is breaking: every producer now has to supply it', () => {
  const closed = (fields) => SET({ additionalProperties: false, inputs: [{ name: 'main', connectionType: 'main', fields }] });
  const closedAdded = compareNodeIo(closed({ id: 'string' }), closed({ id: 'string', status: 'string' }));
  assert.equal(closedAdded.verdict, 'breaking');
  assert.equal(closedAdded.changes.find((change) => change.kind === 'field-added').impact, 'breaking');
  assert.match(explainedChange(closedAdded, 'field-added'), /CLOSED shape: every producer of this item now has to supply it/);

  const openAdded = compareNodeIo(SET(), SET({ inputs: [{ name: 'main', connectionType: 'main', fields: { id: 'string', payload: 'object', extra: 'boolean' } }] }));
  assert.equal(openAdded.verdict, 'additive');
  assert.match(explainedChange(openAdded, 'field-added'), /added to an open shape/);

  const opened = compareNodeIo(closed({ id: 'string' }), SET());
  assert.equal(opened.verdict, 'additive', 'opening a shape is not something an existing caller can notice');
  assert.match(explainedChange(opened, 'field-added'), /added to an open shape/, 'whether a new field is demanded depends on the shape now, not on the shape before');
  assert.equal(opened.changes.find((change) => change.kind === 'shape-closed').impact, 'additive');
  const closedNow = compareNodeIo(SET(), closed({ id: 'string', payload: 'object' }));
  assert.equal(closedNow.verdict, 'breaking');
  assert.equal(closedNow.changes.find((change) => change.kind === 'shape-closed').impact, 'breaking');
});

function explainedChange(diff, kind) {
  return diff.changes.find((change) => change.kind === kind).detail;
}

test('a port that is only added, and an arity that is only widened, are additive', () => {
  const added = compareNodeIo(SET(), SET({ outputs: [{ name: 'main', connectionType: 'main', fields: { id: 'string', payload: 'object' } }, { name: 'error', connectionType: 'main' }] }));
  assert.equal(added.verdict, 'additive');
  assert.equal(added.changes.every((change) => change.impact === 'additive'), true);
  const widened = compareNodeIo(SET({ inputs: [{ name: 'main', connectionType: 'main', arity: 'single' }] }), SET());
  assert.equal(widened.verdict, 'additive');
  assert.match(explainedChange(widened, 'arity-widened'), /accepts more connections than before/);
});

/* ------------------------------------------------------------------ handoff */

test('moving a node between runtimes is answered per field: inline, as a handle, or not at all', () => {
  const same = planHandoff(SET(), { from: 'js-compat', to: 'js-compat' });
  assert.equal(same.same, true);
  assert.match(same.message, /nothing crosses/);

  const io = SET({
    inputs: [{ name: 'main', connectionType: 'main', fields: { id: 'string', blob: 'binary', rows: 'array' } }],
    outputs: [{ name: 'main', connectionType: 'main', fields: { id: 'string' } }],
  });
  const plan = planHandoff(io, { from: 'js-compat', to: 'wasm' });
  assert.equal(plan.ok, true);
  assert.equal(plan.transports.length, 4);
  const blob = plan.transports.find((entry) => entry.field === 'blob');
  assert.equal(blob.kind, 'reference');
  assert.match(blob.note, /handle into the artifact store/);
  assert.equal(plan.transports.find((entry) => entry.field === 'rows').kind, 'inline');
  assert.equal(plan.transports.find((entry) => entry.field === 'id').note, 'travels inline: a JSON value is the same value on the other side');
  assert.equal(plan.transports.find((entry) => entry.port === 'output:main').kind, 'inline', 'the plan covers both directions');

  const dated = planHandoff(SET({ inputs: [{ name: 'main', connectionType: 'main', fields: { created: 'date' } }] }), { from: 'js-compat', to: 'remote-worker' });
  assert.equal(dated.ok, false);
  assert.equal(dated.reason, 'io.handoff');
  assert.equal(dated.refused.length, 1);
  assert.match(dated.refused[0].note, /cannot be promised to arrive intact/);
  assert.match(dated.message, /1 field\(s\) cannot cross/);
  throwsWith(() => planHandoff(io, { from: 'js-compat', to: 'gpu-tent' }), 'io.handoff');
  throwsWith(() => planHandoff(io, { to: 'wasm' }), 'io.handoff');
  throwsWith(() => planHandoff({ identity: 'a@1' }, { from: 'js-compat', to: 'wasm' }), 'io.input');
  // Every locality the foundation publishes is answerable: a handoff plan exists for each pair.
  for (const to of NODE_RUNTIME_LOCALITIES) {
    const answer = planHandoff(SET(), { from: 'js-compat', to });
    assert.ok(answer.ok === true || answer.reason === 'io.handoff', `no answer for ${to}`);
  }
});

/* -------------------------------------------------------------------- reads */

test('describing a contract gives the counts a review opens with', () => {
  const io = compileNodeIo({
    identity: 'n8n-nodes-slack.slack@2.1',
    trigger: false,
    inputs: [{ name: 'main', connectionType: 'main', fields: { text: 'string', image: 'binary' } }],
    outputs: [{ name: 'main', connectionType: 'main', fields: { ok: 'boolean' } }, { name: 'tool', connectionType: 'ai_tool' }],
    additionalProperties: false,
  });
  const described = describeNodeIo(io);
  assert.equal(described.identity, 'n8n-nodes-slack.slack@2.1');
  assert.equal(described.ports, 3);
  assert.equal(described.fields, 3);
  assert.deepEqual([...described.connectionTypes], ['ai_tool', 'main']);
  assert.deepEqual([...described.binaryFields], ['input:main.image']);
  assert.equal(described.shape, 'closed');
  assert.deepEqual([...described.outputs], ['main (main)', 'tool (ai_tool)']);
  assert.match(explainNodeIo(io), /n8n-nodes-slack\.slack@2\.1: node with 3 port\(s\) — 1 in, 2 out; 3 declared item field\(s\), shape closed/);
  assert.match(explainNodeIo(SET({ inputs: [], trigger: true, outputs: [{ name: 'main', connectionType: 'main' }] })), /trigger with 1 port\(s\)/);
  throwsWith(() => describeNodeIo({ identity: 'a@1' }), 'io.input');
});

/* --------------------------------------------------------------------- walls */

test('the compiler reads declarations and nothing else: no graph, no store, no admission decision', () => {
  const source = readFileSync(new URL('../src/lego/io-compiler.mjs', import.meta.url), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const forbidden of ['node:fs', 'node:net', 'node:http', 'node:os', 'node:child_process', 'process.', 'Math.random', 'setTimeout', 'performance.', 'fetch(', 'node:vm', 'eval(']) {
    assert.equal(code.includes(forbidden), false, `the I/O compiler must not reference ${forbidden}`);
  }
  assert.deepEqual([...code.matchAll(/from '(node:[a-z_/]+)'/g)].map((match) => match[1]), ['node:crypto']);
  assert.equal(/\bnew Date\b|\bDate\.now\b/.test(code), false);
  for (const forbidden of ['./resolution-manifest.mjs', './dependency-closure.mjs', './capability-compiler.mjs', './admission-explain.mjs', './canary-rollout.mjs', './revocation-bulletin.mjs', './registry-compiler.mjs', './node-health.mjs']) {
    assert.equal(code.includes(forbidden), false, `P6.21 must not reach into ${forbidden}: it compiles ports and stops`);
  }
  assert.ok(code.includes("from './node-registry.mjs'"), 'the locality vocabulary is P6.1\'s, quoted');
  for (const name of ['createArtifactStore', 'storeArtifact', 'resolveWorkflowNodes', 'compileCapabilityPlan']) {
    assert.equal(code.includes(name), false, `${name} belongs to another milestone: a handoff plan describes a crossing, it does not perform one`);
  }
});

/* ------------------------------------------------------------------- lock row */

test('the contract-lock row is canonical: one row, version, ops, tests, exports, domain path', () => {
  const lock = JSON.parse(readFileSync(new URL('../src/lego/contracts/contract-lock.json', import.meta.url)));
  const rows = lock.contracts.filter((contract) => contract.id === 'node.io');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].version, IO_CONTRACT_VERSION);
  assert.equal(rows[0].domain, 'node-registry');
  assert.equal(rows[0].status, 'implemented');
  assert.deepEqual(rows[0].surface, ['src/lego/io-compiler.mjs']);
  assert.deepEqual(rows[0].tests, ['apps/n8n-lego/test/lego-io-compiler.test.mjs']);
  for (const name of ['compileNodeIo', 'compareNodeIo', 'planHandoff', 'describeNodeIo', 'explainIoDiff']) {
    assert.equal(rows[0].exports['src/lego/io-compiler.mjs'].includes(name), true, `${name} must be locked`);
  }
  for (const id of ['node.registry', 'registry.compiler', 'node.admission', 'node.sbom', 'node.canary', 'node.revocation']) {
    assert.equal(lock.contracts.find((contract) => contract.id === id).version, '0.1.0', `P6.21 must not re-version ${id}`);
  }
  const domain = JSON.parse(readFileSync(new URL('../src/lego/manifest/domains.json', import.meta.url)))
    .domains.find((entry) => entry.id === 'node-registry');
  assert.equal(domain.contract.id, 'node.portability');
  assert.ok(domain.paths.includes('src/lego/io-compiler.mjs'));
});
