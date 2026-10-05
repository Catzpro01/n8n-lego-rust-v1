/**
 * P6.9 — Semantic fingerprint + compatibility replay. Contract `node.semantics@0.1.0`.
 *
 * Matrix: the nine contract axes and the impact ladder, canonicalisation as the
 * precondition for a fingerprint at all (a value that cannot be canonicalised
 * makes the answer NON_DETERMINISTIC rather than a hash that looks like an
 * answer), absent-as-a-claim (never empty), the implementation and the rest of
 * the supply chain deliberately OUTSIDE the fingerprint, replay in four answers
 * with no fifth, bounded path-addressed leaf changes, the fingerprint-to-
 * fingerprint handshake, and the scope walls.
 *
 * No epochs and no fixtures from other milestones: the semantics input is its own
 * shape, which is what lets a worker, an editor and a test fingerprint the same
 * node without loading it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  COMPATIBILITY_VERDICTS,
  FINGERPRINT_EXCLUSIONS,
  IMPACT_ORDER,
  MAX_LEAF_CHANGES,
  SEMANTIC_AXES,
  SEMANTIC_AXIS_IMPACTS,
  SEMANTIC_FINGERPRINT_CONTRACT,
  SEMANTIC_FINGERPRINT_CONTRACT_VERSION,
  SEMANTIC_FINGERPRINT_INPUT_SCHEMA_VERSION,
  SEMANTIC_FINGERPRINT_OPERATIONS,
  SEMANTIC_FINGERPRINT_PERMISSIONS,
  SEMANTIC_FINGERPRINT_REASONS,
  SEMANTIC_FINGERPRINT_RULES,
  SEMANTIC_FINGERPRINT_SCHEMA_VERSION,
  SemanticFingerprintError,
  describeFingerprint,
  explainReplay,
  fingerprintNodeSemantics,
  impactOfAxes,
  implementationIdentityOf,
  isFingerprint,
  isReplayResult,
  replayCompatibility,
  replayFingerprints,
  verifyReplay,
} from '../src/lego/semantic-fingerprint.mjs';

/* ------------------------------------------------------------------ fixtures */

const AXIS_NAMES = SEMANTIC_AXES.map((entry) => entry.axis);

const node = (overrides = {}) => ({
  type: 'n8n-nodes-base.httpRequest',
  typeVersion: 4.4,
  parameters: [
    { name: 'url', type: 'string', required: true },
    { name: 'method', type: 'options', options: ['GET', 'POST'] },
  ],
  expressions: { url: 'supported' },
  credentials: [{ name: 'httpBasicAuth', required: true }],
  io: { inputs: ['main'], outputs: ['main'] },
  webhooks: [],
  behavior: { idempotent: false, sideEffects: ['network'] },
  ui: { displayName: 'HTTP Request', icon: 'fa:globe' },
  package: 'n8n-nodes-base',
  packageVersion: '2.9.1',
  implementationVersion: '0.1.0',
  implementation: { language: 'js', digest: `sha256:${'a'.repeat(64)}` },
  provenance: { kind: 'package-registry', source: 'npm:n8n-nodes-base@2.9.1' },
  trustClass: 'core',
  health: 'unknown',
  lifecycle: 'declared',
  ...overrides,
});

const digest = (hex) => `sha256:${hex.repeat(64)}`;
const codeOf = (error) => [error.code, error.meta?.code, error.meta?.field].filter(Boolean);
const throwsWith = (fn, codes) => {
  const want = [].concat(codes);
  assert.throws(fn, (error) => {
    assert.ok(
      codeOf(error).some((code) => want.includes(code)),
      `expected ${want.join('|')}, got ${codeOf(error).join('|')}: ${error.message}`,
    );
    return true;
  });
};
const withValue = (patch) => node(patch);
const changed = (patch) => [node(), node(patch)];

/* ---------------------------------------------------------- contract surface */

test('the contract identifies itself, is versioned and declares its operations', () => {
  assert.equal(SEMANTIC_FINGERPRINT_CONTRACT, 'node.semantics@0.1.0');
  assert.equal(SEMANTIC_FINGERPRINT_CONTRACT_VERSION, '0.1.0');
  assert.equal(SEMANTIC_FINGERPRINT_SCHEMA_VERSION, 1);
  assert.equal(SEMANTIC_FINGERPRINT_INPUT_SCHEMA_VERSION, 1);
  assert.deepEqual([...SEMANTIC_FINGERPRINT_OPERATIONS], ['fingerprint', 'replay', 'explain']);
  assert.deepEqual([...SEMANTIC_FINGERPRINT_PERMISSIONS], ['node:read']);
  assert.deepEqual([...IMPACT_ORDER], ['none', 'cosmetic', 'compatible', 'behavioral', 'breaking']);
  assert.deepEqual([...COMPATIBILITY_VERDICTS], ['MATCH', 'DIFF', 'NON_DETERMINISTIC', 'MISSING']);
  for (const reason of SEMANTIC_FINGERPRINT_REASONS) assert.match(reason, /^semantics\.[a-z_]+$/);
});

test('the nine axes, their impacts and their ordering rules are declared', () => {
  assert.deepEqual(AXIS_NAMES, ['type', 'typeVersion', 'parameters', 'expressions', 'credentials', 'io', 'webhooks', 'behavior', 'ui']);
  assert.deepEqual(Object.keys(SEMANTIC_AXIS_IMPACTS).sort(), [...AXIS_NAMES].sort());
  assert.equal(SEMANTIC_AXIS_IMPACTS.type, 'breaking');
  assert.equal(SEMANTIC_AXIS_IMPACTS.typeVersion, 'compatible');
  assert.equal(SEMANTIC_AXIS_IMPACTS.expressions, 'behavioral');
  assert.equal(SEMANTIC_AXIS_IMPACTS.ui, 'cosmetic');
  for (const entry of SEMANTIC_AXES) {
    assert.ok(IMPACT_ORDER.includes(entry.impact), `${entry.axis} impact must be on the ladder`);
    assert.equal(['ordered', 'unordered'].includes(entry.order), true);
    assert.equal(typeof entry.note, 'string');
    assert.equal(Object.isFrozen(entry), true);
  }
  assert.equal(SEMANTIC_AXES.find((entry) => entry.axis === 'credentials').order, 'unordered');
  assert.equal(SEMANTIC_AXES.find((entry) => entry.axis === 'parameters').order, 'ordered');
});

test('what is deliberately outside the fingerprint is declared with a reason', () => {
  assert.deepEqual(FINGERPRINT_EXCLUSIONS.map((entry) => entry.field), ['implementation', 'packageVersion', 'provenance', 'trustClass', 'health', 'lifecycle']);
  for (const entry of FINGERPRINT_EXCLUSIONS) assert.equal(typeof entry.reason, 'string');
  assert.equal(Object.isFrozen(FINGERPRINT_EXCLUSIONS), true);
  assert.equal(MAX_LEAF_CHANGES, 32);
});

/* ------------------------------------------------------------- fingerprint */

test('a fingerprint is taken of the semantics, deterministically and frozen', () => {
  const fingerprint = fingerprintNodeSemantics(node());
  assert.equal(fingerprint.ok, true);
  assert.equal(isFingerprint(fingerprint), true);
  assert.match(fingerprint.fingerprint, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual([...fingerprint.present], [...AXIS_NAMES].sort());
  assert.deepEqual([...fingerprint.absent], []);
  assert.equal(Object.keys(fingerprint.axes).length, 9);
  assert.equal(Object.isFrozen(fingerprint), true);
  assert.equal(Object.isFrozen(fingerprint.axes), true);
  assert.equal(fingerprintNodeSemantics(node()).fingerprint, fingerprint.fingerprint);
});

test('key order is not semantics and unordered axes are compared as sets', () => {
  const shuffled = {
    ui: { icon: 'fa:globe', displayName: 'HTTP Request' },
    webhooks: [],
    behavior: { sideEffects: ['network'], idempotent: false },
    io: { outputs: ['main'], inputs: ['main'] },
    credentials: [{ required: true, name: 'httpBasicAuth' }],
    expressions: { url: 'supported' },
    parameters: node().parameters,
    typeVersion: 4.4,
    type: 'n8n-nodes-base.httpRequest',
  };
  assert.equal(fingerprintNodeSemantics(shuffled).fingerprint, fingerprintNodeSemantics(node()).fingerprint);
  assert.equal(
    fingerprintNodeSemantics(node({ credentials: [{ name: 'b' }, { name: 'a' }] })).axes.credentials,
    fingerprintNodeSemantics(node({ credentials: [{ name: 'a' }, { name: 'b' }] })).axes.credentials,
  );
  assert.notEqual(
    fingerprintNodeSemantics(node({ parameters: [1, 2] })).axes.parameters,
    fingerprintNodeSemantics(node({ parameters: [2, 1] })).axes.parameters,
    'parameter order is the UI order, and the UI order is part of the contract',
  );
});

test('the implementation and the supply chain are recorded beside the fingerprint, never inside it', () => {
  const reimplemented = node({
    packageVersion: '3.0.0',
    implementationVersion: '0.1.0',
    implementation: { language: 'rust', digest: digest('b') },
    provenance: { kind: 'attested-build', source: 'builder:internal' },
    trustClass: 'untrusted',
    health: 'sick',
    lifecycle: 'deprecated',
  });
  assert.equal(fingerprintNodeSemantics(reimplemented).fingerprint, fingerprintNodeSemantics(node()).fingerprint);
  assert.equal(implementationIdentityOf(node()).language, 'js');
  assert.equal(implementationIdentityOf(reimplemented).language, 'rust');
  assert.equal(implementationIdentityOf(reimplemented).digest, digest('b'));
  assert.equal(implementationIdentityOf(node()).packageVersion, '2.9.1');
  assert.equal(implementationIdentityOf({}).language, null);
  const replay = replayCompatibility(node(), reimplemented);
  assert.equal(replay.verdict, 'MATCH');
  assert.equal(replay.compatible, true);
  assert.equal(replay.implementationChanged, true);
});

test('an absent axis is a claim, and an empty axis is a different claim', () => {
  const sparse = fingerprintNodeSemantics({ type: 'n8n-nodes-base.set', typeVersion: 3.4 });
  assert.equal(sparse.ok, true);
  assert.deepEqual([...sparse.present], ['type', 'typeVersion']);
  assert.deepEqual([...sparse.absent], ['behavior', 'credentials', 'expressions', 'io', 'parameters', 'ui', 'webhooks']);
  const empty = fingerprintNodeSemantics(node({ credentials: [], webhooks: [] }));
  assert.equal(empty.absent.length, 0);
  assert.notEqual(empty.axes.credentials, fingerprintNodeSemantics({ type: 'n8n-nodes-base.httpRequest', typeVersion: 4.4 }).axes?.credentials);
  const replay = replayCompatibility(node(), fingerprintNodeSemantics(node()) && node({ credentials: [] }));
  assert.equal(replay.verdict, 'DIFF');
  assert.deepEqual([...replay.changedAxes], ['credentials']);
});

test('a fingerprint can be taken of a subset of axes, and it is a different fingerprint', () => {
  const subset = fingerprintNodeSemantics(node(), { axes: ['type', 'ui'] });
  assert.deepEqual([...subset.present], ['type', 'ui']);
  assert.deepEqual([...subset.absent], []);
  assert.notEqual(subset.fingerprint, fingerprintNodeSemantics(node()).fingerprint);
  assert.deepEqual([...fingerprintNodeSemantics({ type: 'a' }, { axes: ['type', 'ui'] }).absent], ['ui']);
});

test('axis selection is validated: misuse throws, data refuses', () => {
  throwsWith(() => fingerprintNodeSemantics(null), 'semantics.input');
  throwsWith(() => fingerprintNodeSemantics('n8n-nodes-base.httpRequest'), 'semantics.input');
  throwsWith(() => fingerprintNodeSemantics(node(), { axes: ['type', 'vibes'] }), 'semantics.axis');
  throwsWith(() => fingerprintNodeSemantics(node(), { axes: [] }), 'semantics.axis');
  throwsWith(() => fingerprintNodeSemantics(node(), { axes: ['type', 'type'] }), 'semantics.axis');
  throwsWith(() => implementationIdentityOf(null), 'semantics.input');
});

/* -------------------------------------------------------- non-determinism */

test('a value that cannot be canonicalised refuses the fingerprint and names it', () => {
  const cases = [
    [{ ui: { icon: undefined } }, 'ui.icon', 'undefined'],
    [{ behavior: { run: () => 1 } }, 'behavior.run', 'function'],
    [{ behavior: { weight: Number.NaN } }, 'behavior.weight', 'non-finite-number'],
    [{ behavior: { weight: Number.POSITIVE_INFINITY } }, 'behavior.weight', 'non-finite-number'],
    [{ behavior: { token: Symbol('x') } }, 'behavior.token', 'symbol'],
    [{ behavior: { big: BigInt(1) } }, 'behavior.big', 'bigint'],
    [{ io: { inputs: new Set(['main']) } }, 'io.inputs', 'instance'],
    [{ io: { inputs: new Map() } }, 'io.inputs', 'instance'],
  ];
  for (const [patch, path, kind] of cases) {
    const fingerprint = fingerprintNodeSemantics(node(patch));
    assert.equal(fingerprint.ok, false, `${path} must refuse`);
    assert.equal(fingerprint.verdict, 'NON_DETERMINISTIC');
    assert.equal(fingerprint.reason, 'semantics.nondeterministic');
    assert.equal(fingerprint.errors[0].path, path);
    assert.equal(fingerprint.errors[0].kind, kind);
    assert.equal(fingerprint.errors[0].code, 'semantics.nondeterministic');
  }
  const cyclic = { name: 'loop' };
  cyclic.self = cyclic;
  assert.equal(fingerprintNodeSemantics(node({ behavior: cyclic })).errors[0].kind, 'cycle');
});

test('a refusal carries no partial fingerprint', () => {
  const refusal = fingerprintNodeSemantics(node({ behavior: { weight: Number.NaN } }));
  assert.equal(refusal.fingerprint, null);
  assert.deepEqual(Object.keys(refusal.axes), []);
  assert.equal(refusal.verdict, 'NON_DETERMINISTIC');
  assert.equal(refusal.implementation.language, 'js', 'the implementation identity is still recorded: it never needed canonicalising');
  assert.equal(Object.isFrozen(refusal), true);
  assert.equal(Object.isFrozen(refusal.errors), true);
  assert.equal(isFingerprint(refusal), false);
});

/* ------------------------------------------------------------------- replay */

test('the same semantics replay to MATCH, and the verdict verifies', () => {
  const replay = replayCompatibility(node(), node());
  assert.equal(replay.ok, true, 'ok means the replay could be performed');
  assert.equal(replay.verdict, 'MATCH');
  assert.equal(replay.compatible, true);
  assert.equal(replay.impact, 'none');
  assert.deepEqual([...replay.changedAxes], []);
  assert.deepEqual([...replay.leafChanges], []);
  assert.equal(replay.implementationChanged, false);
  assert.equal(isReplayResult(replay), true);
  assert.equal(verifyReplay(replay, { before: node(), after: node() }).ok, true);
  assert.match(explainReplay(replay), /semantics MATCH across 9 axes/);
});

test('each axis carries its impact, and the worst changed axis decides', () => {
  const cases = [
    ['ui', { ui: { displayName: 'HTTP', icon: 'fa:globe' } }, 'cosmetic'],
    ['typeVersion', { typeVersion: 4.5 }, 'compatible'],
    ['expressions', { expressions: { url: 'required' } }, 'behavioral'],
    ['behavior', { behavior: { idempotent: true, sideEffects: ['network'] } }, 'behavioral'],
    ['type', { type: 'n8n-nodes-base.httpRequestV2' }, 'breaking'],
    ['parameters', { parameters: [{ name: 'url', type: 'string', required: false }] }, 'breaking'],
    ['credentials', { credentials: [{ name: 'httpBasicAuth', required: false }] }, 'breaking'],
    ['io', { io: { inputs: ['main', 'secondary'], outputs: ['main'] } }, 'breaking'],
    ['webhooks', { webhooks: [{ path: 'hook', method: 'POST' }] }, 'breaking'],
  ];
  for (const [axis, patch, impact] of cases) {
    const replay = replayCompatibility(...changed(patch));
    assert.equal(replay.verdict, 'DIFF', `${axis} must be a DIFF`);
    assert.deepEqual([...replay.changedAxes], [axis]);
    assert.equal(replay.impact, impact, `${axis} impact`);
    assert.equal(replay.compatible, false);
    assert.ok(replay.leafChanges.length >= 1);
    assert.ok(replay.leafChanges.every((leaf) => leaf.axis === axis));
    assert.ok(replay.leafChanges[0].path.startsWith(axis));
    assert.match(explainReplay(replay), new RegExp(axis));
    assert.match(explainReplay(replay), new RegExp(`impact ${impact}`));
  }
  const mixed = replayCompatibility(node(), node({
    ui: { displayName: 'x', icon: 'fa:globe' },
    expressions: { url: 'required' },
    credentials: [{ name: 'z' }],
  }));
  assert.deepEqual([...mixed.changedAxes], ['credentials', 'expressions', 'ui']);
  assert.equal(mixed.impact, 'breaking');
  assert.equal(impactOfAxes([]), 'none');
  assert.equal(impactOfAxes(['ui']), 'cosmetic');
  assert.equal(impactOfAxes(['ui', 'io']), 'breaking');
  assert.equal(impactOfAxes(['typeVersion', 'behavior']), 'behavioral');
  throwsWith(() => impactOfAxes(['nope']), 'semantics.axis');
  throwsWith(() => impactOfAxes('ui'), 'semantics.axis');
});

test('leaf changes are path-addressed, bounded and truncation is reported', () => {
  const single = replayCompatibility(node(), node({ ui: { displayName: 'HTTP Request!', icon: 'fa:globe' } }));
  assert.equal(single.leafChanges.length, 1);
  assert.equal(single.leafChanges[0].path, 'ui.displayName');
  assert.equal(single.truncated, false);
  assert.equal(single.leafChanges[0].before, '"HTTP Request"');
  assert.equal(single.leafChanges[0].after, '"HTTP Request!"');

  const wide = Array.from({ length: 60 }, (_, index) => ({ name: `p${index}`, required: true }));
  const many = replayCompatibility(
    node({ parameters: wide }),
    node({ parameters: wide.map((entry, index) => (index === 0 ? entry : { ...entry, required: false })) }),
  );
  assert.equal(many.leafChanges.length, MAX_LEAF_CHANGES);
  assert.equal(many.truncated, true);
  assert.match(explainReplay(many), /truncated/);

  const resized = replayCompatibility(node(), node({ parameters: [{ name: 'only' }] }));
  assert.equal(resized.leafChanges.length, 1, 'a changed array length is one bounded change, not sixty guesses');
  assert.equal(resized.leafChanges[0].path, 'parameters');
  assert.equal(resized.truncated, false);
});

test('a missing baseline is MISSING, never MATCH', () => {
  const before = replayCompatibility(undefined, node());
  assert.equal(before.ok, false, 'ok means the replay could be performed, and this one could not');
  assert.equal(before.verdict, 'MISSING');
  assert.equal(before.reason, 'semantics.missing_baseline');
  assert.equal(before.errors[0].side, 'before');
  assert.equal(before.compatible, undefined);
  assert.equal(isReplayResult(before), true);
  assert.match(explainReplay(before), /replay unavailable/);
  const after = replayCompatibility(node(), null);
  assert.equal(after.verdict, 'MISSING');
  assert.equal(after.errors[0].side, 'after');
  assert.equal(after.before, null);
});

test('a replay that cannot be taken is NON_DETERMINISTIC, and it says which side', () => {
  const bad = replayCompatibility(node({ behavior: { x: Number.NaN } }), node());
  assert.equal(bad.ok, false);
  assert.equal(bad.verdict, 'NON_DETERMINISTIC');
  assert.equal(bad.reason, 'semantics.nondeterministic');
  assert.ok(bad.errors.some((error) => error.side === 'before'));
  assert.equal(bad.before, null, 'a side that could not be fingerprinted is null, not a guess');
  assert.equal(bad.after.fingerprint, fingerprintNodeSemantics(node()).fingerprint);
  assert.match(explainReplay(bad), /cannot be canonicalised/);
  const bothSides = replayCompatibility(node({ ui: { icon: undefined } }), node({ ui: { icon: undefined } }));
  assert.deepEqual([...new Set(bothSides.errors.map((error) => error.side))], ['before', 'after']);
});

test('dropping an axis is a DIFF, and the absent axis is named', () => {
  const after = node();
  delete after.webhooks;
  const replay = replayCompatibility(node(), after);
  assert.equal(replay.verdict, 'DIFF');
  assert.deepEqual([...replay.changedAxes], ['webhooks']);
  assert.deepEqual([...replay.absentAxes], ['webhooks']);
  const removedEntirely = replayCompatibility(node(), { type: 'n8n-nodes-base.httpRequest', typeVersion: 4.4 });
  assert.deepEqual([...removedEntirely.changedAxes], ['behavior', 'credentials', 'expressions', 'io', 'parameters', 'ui', 'webhooks']);
  assert.equal(removedEntirely.impact, 'breaking');
});

test('a replay is a document: frozen, repeatable and independent of key order', () => {
  const first = replayCompatibility(node(), node({ ui: { displayName: 'y', icon: 'fa:globe' } }));
  const second = replayCompatibility(node(), node({ ui: { displayName: 'y', icon: 'fa:globe' } }));
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.changedAxes), true);
  assert.equal(first.after.fingerprint, second.after.fingerprint);
  assert.equal(first.before.fingerprint, second.before.fingerprint);
  assert.deepEqual([...first.changedAxes], [...second.changedAxes]);
  assert.equal(verifyReplay(first, { before: node(), after: node({ ui: { displayName: 'y', icon: 'fa:globe' } }) }).ok, true);
});

/* ------------------------------------------------- handshake: two fingerprints */

test('two fingerprints replay without the semantics they came from', () => {
  const before = fingerprintNodeSemantics(node());
  const after = fingerprintNodeSemantics(node({ ui: { displayName: 'HTTP Request v2', icon: 'fa:globe' } }));
  const replay = replayFingerprints(before, after);
  assert.equal(replay.ok, true);
  assert.equal(replay.verdict, 'DIFF');
  assert.deepEqual([...replay.changedAxes], ['ui']);
  assert.equal(replay.impact, 'cosmetic');
  assert.deepEqual([...replay.leafChanges], [], 'fingerprints carry no bodies: the leaves are the axes');
  assert.equal(replayFingerprints(before, before).verdict, 'MATCH');
  const swapped = replayFingerprints(before, fingerprintNodeSemantics(node({ implementation: { language: 'wasm', digest: digest('d') } })));
  assert.equal(swapped.verdict, 'MATCH');
  assert.equal(swapped.implementationChanged, true);
});

test('an unverifiable fingerprint is a missing baseline, on the side that failed', () => {
  const good = fingerprintNodeSemantics(node());
  const forged = replayFingerprints({ fingerprint: digest('e') }, good);
  assert.equal(forged.ok, false);
  assert.equal(forged.verdict, 'MISSING');
  assert.equal(forged.errors[0].side, 'before');
  assert.equal(forged.before, null);
  assert.equal(replayFingerprints(good, { ok: true }).errors[0].side, 'after');
  assert.equal(replayFingerprints(null, null).verdict, 'MISSING');
});

/* ------------------------------------------------------------ reads, guards */

test('the reads refuse what they were not given', () => {
  throwsWith(() => describeFingerprint({ ok: true }), 'lego.contract_violation');
  throwsWith(() => describeFingerprint(null), 'lego.contract_violation');
  throwsWith(() => explainReplay({ verdict: 'MATCH' }), 'lego.contract_violation');
  throwsWith(() => verifyReplay({ verdict: 'DIFF' }, {}), 'lego.contract_violation');
  throwsWith(() => explainReplay(null), 'lego.contract_violation');
});

test('describeFingerprint publishes short digests and the implementation identity', () => {
  const described = describeFingerprint(fingerprintNodeSemantics(node()));
  assert.equal(described.fingerprint, fingerprintNodeSemantics(node()).fingerprint);
  assert.equal(described.axes.ui.length, 15);
  assert.equal(described.present.length, 9);
  assert.equal(described.implementation.language, 'js');
  assert.equal(Object.isFrozen(described), true);
});

test('verification catches a substituted verdict and a substituted fingerprint', () => {
  const target = node({ ui: { displayName: 'q', icon: 'fa:globe' } });
  const replay = replayCompatibility(node(), target);
  const forgedVerdict = Object.freeze({ ...replay, verdict: 'MATCH', changedAxes: Object.freeze([]) });
  const verdictCheck = verifyReplay(forgedVerdict, { before: node(), after: target });
  assert.equal(verdictCheck.ok, false);
  assert.equal(verdictCheck.reason, 'semantics.replay');
  const forgedFingerprint = Object.freeze({ ...replay, after: fingerprintNodeSemantics(node()) });
  const fingerprintCheck = verifyReplay(forgedFingerprint, { before: node(), after: target });
  assert.equal(fingerprintCheck.ok, false);
  assert.equal(fingerprintCheck.reason, 'semantics.replay');
});

test('the error type is exported and API misuse is not a verdict', () => {
  const error = new SemanticFingerprintError('x');
  assert.equal(error instanceof Error, true);
  assert.equal(error.code, 'lego.contract_violation');
  assert.equal(Object.isFrozen(error.meta), true);
  assert.equal(new SemanticFingerprintError('x', { field: 'axes' }).meta.field, 'axes');
});

/* -------------------------------------------------------------- scope walls */

test('P6.9 is pure: the only node import is the hash, and there is no execution or I/O', () => {
  const source = readFileSync(new URL('../src/lego/semantic-fingerprint.mjs', import.meta.url), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const forbidden of ['node:fs', 'node:net', 'node:http', 'node:os', 'node:child_process', 'process.', 'Math.random', 'setTimeout', 'performance.', 'fetch(']) {
    assert.equal(code.includes(forbidden), false, `the semantic fingerprint must not reference ${forbidden}`);
  }
  assert.deepEqual([...code.matchAll(/from '(node:[a-z_/]+)'/g)].map((match) => match[1]), ['node:crypto']);
  assert.equal(/\bnew Date\b|\bDate\.now\b/.test(code), false);
  assert.equal(code.includes('foundation.mjs'), false, 'the foundation accessor stays outside the published surface (gate rule R4)');
});

test('P6.9 stays inside its walls: no admission, no lifecycle, no migration, no artifact inspection', () => {
  const source = readFileSync(new URL('../src/lego/semantic-fingerprint.mjs', import.meta.url), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const forbidden of ['node-health', 'node-lifecycle', 'capability-compiler', 'registry-compiler', 'node-residency', 'runtime-lease', 'runtime-budget', 'node:vm', 'spawn', 'acorn', '@babel', 'function quarantine']) {
    assert.equal(code.includes(forbidden), false, `P6.9 must not reach into ${forbidden}: that belongs to a later or different contract`);
  }
  assert.equal(Object.isFrozen(SEMANTIC_FINGERPRINT_RULES), true);
  assert.match(SEMANTIC_FINGERPRINT_RULES.replay, /MISSING, never MATCH/);
  assert.match(SEMANTIC_FINGERPRINT_RULES.implementation ?? SEMANTIC_FINGERPRINT_RULES.reimplementation, /not a compatibility event/);
});

/* --------------------------------------------------------------- lock row */

test('the contract-lock row is canonical: one row, version, ops, tests, exports, domain path', () => {
  const lock = JSON.parse(readFileSync(new URL('../src/lego/contracts/contract-lock.json', import.meta.url)));
  const rows = lock.contracts.filter((contract) => contract.id === 'node.semantics');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].version, SEMANTIC_FINGERPRINT_CONTRACT_VERSION);
  assert.equal(rows[0].domain, 'node-registry');
  assert.equal(rows[0].status, 'implemented');
  assert.deepEqual(rows[0].surface, ['src/lego/semantic-fingerprint.mjs']);
  assert.deepEqual(rows[0].tests, ['apps/n8n-lego/test/lego-semantic-fingerprint.test.mjs']);
  for (const name of ['fingerprintNodeSemantics', 'replayCompatibility', 'replayFingerprints', 'verifyReplay']) {
    assert.equal(rows[0].exports['src/lego/semantic-fingerprint.mjs'].includes(name), true, `${name} must be locked`);
  }
  for (const id of ['node.registry', 'registry.compiler', 'package.transaction', 'registry.closure', 'node.resolution', 'runtime.lease', 'node.residency', 'node.capability']) {
    assert.equal(lock.contracts.find((contract) => contract.id === id).version, '0.1.0', `P6.9 must not re-version ${id}`);
  }
  const domain = JSON.parse(readFileSync(new URL('../src/lego/manifest/domains.json', import.meta.url)))
    .domains.find((entry) => entry.id === 'node-registry');
  assert.equal(domain.contract.id, 'node.portability');
  assert.ok(domain.paths.includes('src/lego/semantic-fingerprint.mjs'));
});
