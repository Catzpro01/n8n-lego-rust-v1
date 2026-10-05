/**
 * P2.23 — Node Creator & Translation Foundation.
 *
 * A. creator · B. translation · C. human-vs-node · D. approval · E. artifact
 * F. portability reuse · G. security · H. regression-adjacent guards
 * plus §32 determinism and §34 bounds. Everything runs offline: injected
 * clock/id, no network, no model, no credentials.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import * as creatorModule from '../src/lego/node-creator.mjs';
import {
  APPROVAL_POLICY, APPROVAL_REQUIRED_CLASSES, CREATION_MODES, CREATOR_KIND,
  CREATOR_LIMITS, CREATOR_REFUSAL_REASONS, CREATOR_STATES, CREATOR_STATE_TRANSITIONS,
  NODE_CREATOR_CONTRACT, NODE_CREATOR_OPERATIONS, NODE_CREATOR_PERMISSIONS,
  NodeCreatorError, SOURCE_KINDS, TRANSLATION_CONTRACT_VERSION,
  TRANSLATION_FORBIDDEN_FIELDS, TRANSLATION_MARKER_RE, TRANSLATION_REFUSAL_REASONS,
  TRANSLATION_SOURCE_FIELDS, approvalRiskFor, createNodeCreator, requiresApproval,
} from '../src/lego/node-creator.mjs';
import {
  PORTABILITY_CLASSES, PORTABILITY_REASONS, canPort, describePortability,
} from '../src/lego/node-portability.mjs';
import { APPROVAL_STATES, createApprovalFoundation } from '../src/lego/approval.mjs';
import { ARTIFACT_KINDS, artifactContentDigest, createArtifactRegistry } from '../src/lego/artifact.mjs';

const HERE = new URL('.', import.meta.url);
const MODULE_PATH = join(HERE.pathname, '..', 'src', 'lego', 'node-creator.mjs');
const MODULE_SOURCE = readFileSync(MODULE_PATH, 'utf8');
const LOCK = JSON.parse(readFileSync(join(HERE.pathname, '..', 'src', 'lego', 'contracts', 'contract-lock.json'), 'utf8'));
const DOMAINS = JSON.parse(readFileSync(join(HERE.pathname, '..', 'src', 'lego', 'manifest', 'domains.json'), 'utf8'));

const NODE_DOMAIN = DOMAINS.domains.find((domain) => domain.id === 'node-registry');
const CREATOR_CAP = NODE_DOMAIN.capabilities.find((capability) => capability.id === 'node-registry.creator');
const LOCK_ROW = LOCK.contracts.find((row) => row.id === 'node.creator');

/* ---------------- harness: injected clock + deterministic ids ---------------- */

let seq = 0;
const tick = () => `t${String(++seq).padStart(4, '0')}`;
const clock = () => '2026-09-23T00:00:00.000Z';

function harness(options = {}) {
  seq = 0;
  const approvals = options.approvals ?? createApprovalFoundation({ now: clock, newId: tick });
  const artifacts = options.artifacts ?? createArtifactRegistry({ now: clock, newId: tick });
  const creator = createNodeCreator({ now: clock, newId: tick, approvals, artifacts });
  return { creator, approvals, artifacts };
}

const HUMAN = Object.freeze({
  creationMode: 'HUMAN', creatorKind: 'node-creator',
  creatorId: 'agent-1', sourceKind: 'manual', sourceReference: null,
});
const NODE_MODE = Object.freeze({ ...HUMAN, creationMode: 'NODE' });

const pureDef = (over = {}) => ({
  nodeId: 'demo.echo', name: 'Echo', version: '1.0.0', description: 'echo node',
  portability: { class: 'PURE' },
  requiredCapabilities: [], requiredPermissions: [],
  schemas: { input: { type: 'string' }, output: { type: 'boolean' } },
  ...over,
});

const networkDef = (over = {}) => pureDef({
  nodeId: 'demo.http', name: 'HTTP', portability: { class: 'NETWORK' },
  requiredCapabilities: ['webhook.ingress'], requiredPermissions: ['webhook:receive'],
  ...over,
});

const sourceEnvelope = (source = {}) => ({
  sourceRuntime: 'n8n-nodes-base@2.9.1',
  sourceReference: 'src-ref-1',
  source: {
    nodeId: 'demo.echo', version: '1.0.0', name: 'Echo',
    schemas: { input: { type: 'string' }, output: { type: 'boolean' } },
    portability: { class: 'PURE' },
    requiredCapabilities: [], requiredPermissions: [],
    ...source,
  },
});

/* ================================================================ *
 * Contract / lock / capability three-way parity
 * ================================================================ */

test('the contract string is the exact locked identity — row 28, domain node-registry', () => {
  assert.equal(NODE_CREATOR_CONTRACT, 'node.creator@1.0.0');
  assert.equal(LOCK_ROW.version, '1.0.0');
  assert.equal(LOCK_ROW.status, 'implemented');
  assert.equal(LOCK_ROW.domain, 'node-registry');
  assert.equal(LOCK_ROW.owner, 'manager');
  // P9.1 envelope + P3 optimizer are merged; P9.2 structured-log adds row 42.
  assert.equal(LOCK.contracts.length, 100, 'rows through P3 Slice A persistent logical graph (thirty-third); P3 Slice D adds the thirty-fourth (execution.frontier); P3 Slice E adds the thirty-fifth (execution.state-stream); P3 Slice H adds the thirty-sixth (workflow.dna); P3 Slice J the thirty-seventh (execution.ir); P3 Slice L the thirty-eighth (compatibility.oracle); P3 Slice M the thirty-ninth (execution.guard); P3 Slice K the forty-first (execution.optimizer) — P6.1 adds node.registry@0.1.0; P6.2 adds registry.compiler@0.1.0; P6.3 adds package.transaction@0.1.0; P6.4 adds registry.closure@0.1.0; P6.5 adds node.resolution@0.1.0; P6.6 adds runtime.lease@0.1.0; P6.7 adds node.residency@0.1.0; P6.8 adds node.capability@0.1.0; P6.9 adds node.semantics@0.1.0; P6.10 adds node.lifecycle@0.1.0; P6.11 adds node.health@0.1.0; P6.12 adds node.supply-chain@0.1.0; P6.13 adds registry.incremental@0.1.0; P6.14 adds node.worker-convergence@0.1.0; P6.15 adds node.acceptance@0.1.0; P6.16 adds registry.integrity@0.1.0; P6.17 adds node.admission@0.1.0; P6.18 adds node.sbom@0.1.0; P6.19 adds node.canary@0.1.0; P6.20 adds node.revocation@0.1.0; P6.21 adds node.io@0.1.0; P6.22 adds runtime.jit@0.1.0; P6.23 adds runtime.cancel@0.1.0; P6.24 adds runtime.pool@0.1.0; P6.25 adds node.abi@0.1.0; P6.26 adds runtime.wasm-cache@0.1.0; P6.27 adds node.provenance@0.1.0; P6.28 adds registry.freshness@0.1.0; P6.29 adds node.namespace@0.1.0; P6.30 adds registry.repair@0.1.0; P6.31 adds registry.acceptance@0.1.0; count-pins say 76; P2.27.1 adds lego.plugin-runtime@0.1.0 (seventy-sixth); P5.1 adds the ninety-fifth (auth.principal)'); // P9 integration (Agent 1): P9.5-P9.22 add 18 observability.* rows on top of protected main 76 -> 94 (union, zero id collisions); P9 was developed on 24032a0c (57 rows). P5.2 adds the ninety-sixth (auth.session). P5.3 adds the ninety-seventh (auth.authorization). P5.5 adds the ninety-eighth (auth.credential-crypto). P5.6 adds the ninety-ninth (auth.account-security). P5.7 adds the hundredth (auth.machine-identity).
  // primary contract of the domain stays node.portability — node.creator is NOT primary (R9)
  assert.equal(NODE_DOMAIN.contract.id, 'node.portability');
});

test('the lock row names real exports, real ops, the real test file — exports pinned to the module', () => {
  assert.deepEqual([...LOCK_ROW.operations], [...NODE_CREATOR_OPERATIONS]);
  const exported = LOCK_ROW.exports['src/lego/node-creator.mjs'];
  assert.deepEqual([...exported].sort(), Object.keys(creatorModule).sort(),
    'the lock exports exactly what the module exports');
  assert.equal(exported.length, 24, 'export count pinned');
  assert.deepEqual(LOCK_ROW.tests, ['apps/n8n-lego/test/lego-node-creator.test.mjs']);
  assert.ok(LOCK_ROW.notes.includes('candidate') && LOCK_ROW.notes.includes('fail-closed'));
});

test('the domain capability, lock row and module agree on operations and permissions', () => {
  assert.deepEqual(CREATOR_CAP.operations.map((op) => op.name), [...NODE_CREATOR_OPERATIONS]);
  assert.deepEqual([...CREATOR_CAP.permissions].sort(), [...NODE_CREATOR_PERMISSIONS].sort());
  assert.equal(CREATOR_CAP.permissions.length, 4, 'permission count pinned');
  assert.equal(CREATOR_CAP.operations.length, 5, 'operation count pinned');
  for (const op of CREATOR_CAP.operations) {
    assert.ok(NODE_CREATOR_PERMISSIONS.includes(op.permission), `${op.permission} published`);
    assert.equal(op.interaction, 'call');
  }
  assert.ok(NODE_DOMAIN.paths.includes('src/lego/node-creator.mjs'), 'domain owns the file');
  assert.ok(NODE_DOMAIN.dependsOn.includes('ai-foundation'), 'declared: approval/artifact primitives');
  assert.ok(NODE_DOMAIN.dependsOn.includes('lego-foundation'), 'declared: registry vocabulary');
  // no publish/execute/grant operation ever appears
  for (const banned of ['publish', 'execute', 'grant', 'run', 'spawn']) {
    assert.ok(!NODE_CREATOR_OPERATIONS.includes(banned), `no '${banned}' operation`);
  }
});

test('identity, lifecycle, translation and approval vocabularies are closed canonical sets', () => {
  assert.deepEqual([...CREATION_MODES], ['HUMAN', 'NODE']);
  assert.equal(CREATOR_KIND, 'node-creator');
  assert.deepEqual([...SOURCE_KINDS], ['manual', 'imported', 'translated']);
  assert.deepEqual([...CREATOR_STATES], [
    'INPUT', 'CANDIDATE', 'VALIDATING', 'VALID', 'REJECTED',
    'APPROVAL_REQUIRED', 'APPROVED', 'PUBLISHED_REFERENCE',
  ]);
  assert.deepEqual(Object.keys(CREATOR_STATE_TRANSITIONS).sort(), [...CREATOR_STATES].sort());
  for (const [state, nexts] of Object.entries(CREATOR_STATE_TRANSITIONS)) {
    for (const next of nexts) assert.ok(CREATOR_STATES.includes(next), `${state}->${next}`);
  }
  assert.deepEqual([...APPROVAL_REQUIRED_CLASSES], ['NETWORK', 'FILESYSTEM', 'NATIVE_PROCESS', 'REMOTE_BRIDGE'],
    'authority-bearing classes derived from the P2.22 declaration rules, not re-invented');
  assert.deepEqual([...APPROVAL_POLICY.requiredCreationModes], ['NODE']);
  assert.equal(TRANSLATION_CONTRACT_VERSION, '1.0.0');
  assert.equal(CREATOR_LIMITS.maxDepth, 16);
});

/* ================================================================ *
 * A. Creator
 * ================================================================ */

test('A: valid creation produces a CANDIDATE record — candidate/reference output only', () => {
  const { creator } = harness();
  const record = creator.create(pureDef(), HUMAN);
  assert.equal(record.state, 'CANDIDATE');
  assert.equal(record.candidate.contract, 'demo.echo@1.0.0', 'contract derived nodeId@version');
  assert.equal(record.candidate.creator.creationMode, 'HUMAN');
  assert.equal(record.candidate.creator.creatorKind, 'node-creator');
  assert.equal(record.candidate.translationProvenance, null, 'create() is not a translation');
  assert.equal(record.reference, null);
  assert.equal(record.approval, null);
  assert.equal(record.validation, null);
  for (const forbidden of ['publish', 'execute', 'grant', 'credential', 'permission-grant']) {
    assert.ok(!(forbidden in record), `record never carries '${forbidden}'`);
  }
});

test('A: missing required fields and malformed candidates throw lego.contract_violation', () => {
  const { creator } = harness();
  const bad = (fn, pattern) => assert.throws(fn, (error) => {
    assert.ok(error instanceof NodeCreatorError);
    assert.equal(error.code, 'lego.contract_violation');
    if (pattern) assert.match(String(error.message), pattern);
    return true;
  });
  bad(() => creator.create(null, HUMAN));
  bad(() => creator.create(pureDef({ nodeId: 'BadId' }), HUMAN), /nodeId/);
  bad(() => creator.create(pureDef({ version: '1.0' }), HUMAN), /version/);
  bad(() => creator.create(pureDef({ name: '' }), HUMAN), /name/);
  bad(() => creator.create(pureDef({ schemas: { input: { type: 'string' } } }), HUMAN), /schemas/);
  bad(() => creator.create(pureDef({ portability: { class: 'CLUSTERISH' } }), HUMAN), /canonical class/);
  bad(() => creator.create(pureDef(), { ...HUMAN, creationMode: 'ROBOT' }), /creationMode/);
  bad(() => creator.create(pureDef(), { ...HUMAN, creatorKind: 'other-creator' }), /creatorKind/);
  bad(() => creator.create(pureDef(), { ...HUMAN, sourceKind: 'generated' }), /sourceKind/);
  bad(() => creator.create(pureDef({ requiredCapabilities: [42] }), HUMAN), /requiredCapabilities/);
  bad(() => creator.create(pureDef({ securityProfile: 7 }), HUMAN), /securityProfile/);
  // credentials in a definition are refused at the door
  bad(() => creator.create(pureDef({ token: 'abc' }), HUMAN), /credentials|standing authority|token/);
});

test('A: unknown capability and unknown permission reject through the canonical pipeline', () => {
  const { creator } = harness();
  const unknownCap = creator.validate(creator.create(pureDef({ requiredCapabilities: ['not.a-cap'] }), HUMAN));
  assert.equal(unknownCap.state, 'REJECTED');
  assert.ok(unknownCap.reasons.some((r) => r.reason === 'unknown-capability'));
  const unknownPerm = creator.validate(creator.create(pureDef({
    portability: { class: 'NETWORK' },
    requiredCapabilities: ['webhook.ingress'],
    requiredPermissions: ['node:creator:teleport'],
  }), HUMAN));
  assert.equal(unknownPerm.state, 'REJECTED');
  assert.ok(unknownPerm.reasons.some((r) => r.reason === 'unknown-permission'));
});

test('A: invalid schema inside a candidate rejects with the P2.22 schema family', () => {
  const { creator } = harness();
  const record = creator.create(pureDef({
    schemas: { input: { type: 'string', pattern: '^x' }, output: { type: 'boolean' } },
  }), HUMAN);
  const answer = creator.validate(record);
  assert.equal(answer.state, 'REJECTED');
  assert.equal(answer.reasons[0].reason, 'schema-unsupported');
  assert.match(answer.reasons[0].detail, /pattern/);
  const lossy = creator.validate(creator.create(pureDef({
    schemas: { input: { type: 'string', format: 'date-time' }, output: { type: 'boolean' } },
  }), HUMAN));
  assert.equal(lossy.state, 'REJECTED');
  assert.equal(lossy.reasons[0].reason, 'schema-lossy');
});

test('A: invalid portability class and unsupported environment declarations are refused, never coerced', () => {
  const { creator } = harness();
  // unknown class refused at creation (structure), unknown env value refused at validation
  assert.throws(() => creator.create(pureDef({ portability: { class: 'serverless' } }), HUMAN), /canonical class/);
  const envNode = creator.validate(creator.create(pureDef({
    nodeId: 'demo.env', portability: { class: 'ENVIRONMENT_SPECIFIC', environmentRequirements: { region: 'eu' } },
  }), HUMAN), { context: { environment: { region: 'us' } } });
  assert.equal(envNode.state, 'REJECTED');
  assert.ok(envNode.reasons.some((r) => r.reason === 'environment-mismatch'));
  assert.ok(CREATOR_REFUSAL_REASONS.includes('contract-incompatible'));
});

test('A: bounds are deterministic refusals — depth, nodes, size and reference counts', () => {
  const { creator } = harness();
  let deep = { type: 'string' };
  for (let i = 0; i < CREATOR_LIMITS.maxDepth + 4; i += 1) deep = { type: 'object', properties: { n: deep } };
  assert.throws(() => creator.create(pureDef({
    schemas: { input: deep, output: { type: 'boolean' } },
  }), HUMAN), (error) => {
    assert.equal(error.code, 'lego.contract_violation');
    assert.ok(error.meta.limit === 'maxDepth' || error.meta.limit === 'maxSchemaNodes');
    return true;
  });
  assert.throws(() => creator.create(pureDef({
    artifactRequirements: Array.from({ length: CREATOR_LIMITS.maxArtifactRequirements + 1 }, (_, i) => `art-${i}`),
  }), HUMAN), /artifact requirements/);
  const huge = pureDef({ description: 'x'.repeat(CREATOR_LIMITS.maxDescriptionLength + 1) });
  assert.throws(() => creator.create(huge, HUMAN), /description/);
});

/* ================================================================ *
 * B. Translation
 * ================================================================ */

test('B: translation is deterministic — identical input ⇒ identical output, provenance and id', () => {
  const { creator } = harness();
  const envelope = sourceEnvelope();
  const first = creator.translate(envelope, { ...HUMAN, sourceKind: 'imported' });
  const second = creator.translate(envelope, { ...HUMAN, sourceKind: 'imported' });
  assert.equal(first.state, 'CANDIDATE');
  assert.deepEqual(first, second, 'whole record byte-identical (§32)');
  assert.equal(first.recordId, second.recordId, 'content-addressed identity');
  assert.equal(first.candidate.contract, 'demo.echo@1.0.0');
  assert.equal(first.candidate.creator.sourceKind, 'translated', 'translate stamps translated provenance');
  assert.equal(first.candidate.translationProvenance.translator, NODE_CREATOR_CONTRACT);
  assert.equal(first.candidate.translationProvenance.sourceRuntime, 'n8n-nodes-base@2.9.1');
  assert.match(first.candidate.translationProvenance.sourceDigest, /^sha256:[0-9a-f]{64}$/);
  // canonical ordering: keys of the candidate are sorted-stable across runs
  assert.deepEqual(JSON.stringify(first.candidate), JSON.stringify(second.candidate));
});

test('B: lossy source constructs REJECT with canonical reasons — no best-effort, no silent drop', () => {
  const { creator } = harness();
  for (const field of ['token', 'credentials', 'apiKey']) {
    const refused = creator.translate(sourceEnvelope({ [field]: 'value' }), HUMAN);
    assert.equal(refused.state, 'REJECTED', field);
    assert.equal(refused.reasons[0].reason, 'lossy-source-field');
    assert.equal(refused.reasons[0].detail, field);
    assert.ok(TRANSLATION_REFUSAL_REASONS.includes('lossy-source-field'));
    assert.equal(refused.candidate, null, 'nothing partially produced');
  }
});

test('B: unknown constructs and unknown language markers refuse deterministically', () => {
  const { creator } = harness();
  const unknown = creator.translate(sourceEnvelope({ webhookUrl: 'https://x' }), HUMAN);
  assert.equal(unknown.state, 'REJECTED');
  assert.equal(unknown.reasons[0].reason, 'unknown-source-construct');
  assert.equal(unknown.reasons[0].detail, 'webhookUrl');
  assert.throws(() => creator.translate({ ...sourceEnvelope(), sourceRuntime: 'N8N loud!' }, HUMAN), /sourceRuntime/);
  assert.ok(TRANSLATION_MARKER_RE.test('n8n-nodes-base@2.9.1'));
  const same = creator.translate(sourceEnvelope({ webhookUrl: 'https://x' }), HUMAN);
  assert.deepEqual(unknown.reasons, same.reasons, 'same input ⇒ same refusal (§32)');
});

test('B: unsupported/lossy schema in the source refuses with the P2.22 family verbatim', () => {
  const { creator } = harness();
  const pattern = creator.translate(sourceEnvelope({
    schemas: { input: { type: 'string', pattern: 'x' }, output: { type: 'boolean' } },
  }), HUMAN);
  assert.equal(pattern.reasons[0].reason, 'schema-unsupported');
  const format = creator.translate(sourceEnvelope({
    schemas: { input: { type: 'string', format: 'uri' }, output: { type: 'boolean' } },
  }), HUMAN);
  assert.equal(format.reasons[0].reason, 'schema-lossy');
  const union = creator.translate(sourceEnvelope({
    schemas: { input: { anyOf: [{ type: 'string' }] }, output: { type: 'boolean' } },
  }), HUMAN);
  assert.equal(union.reasons[0].reason, 'schema-unsupported');
  // reasons are members of closed sets only
  for (const answer of [pattern, format, union]) {
    for (const reason of answer.reasons) {
      assert.ok(
        ['schema-unsupported', 'schema-lossy'].includes(reason.reason)
        || TRANSLATION_REFUSAL_REASONS.includes(reason.reason),
        `${reason.reason} is canonical`,
      );
    }
  }
});

test('B: translation grants nothing — success yields CANDIDATE, never VALID/approved/published', () => {
  const { creator } = harness();
  const record = creator.translate(sourceEnvelope(), HUMAN);
  assert.equal(record.state, 'CANDIDATE');
  assert.equal(record.approval, null);
  assert.equal(record.reference, null);
  assert.equal(record.validation, null);
  const text = JSON.stringify(record);
  for (const word of ['granted', 'published', 'authorized', 'credential']) {
    assert.ok(!text.includes(word), `translation output never carries '${word}'`);
  }
});

/* ================================================================ *
 * C. Human vs Node — one pipeline, origin is provenance only
 * ================================================================ */

test('C: same candidate, different origin — identical validation semantics, no origin bypass', () => {
  const { creator } = harness();
  const human = creator.create(pureDef(), HUMAN);
  const nodeMade = creator.create(pureDef(), NODE_MODE);
  assert.equal(human.candidate.contract, nodeMade.candidate.contract);
  assert.deepEqual(human.candidate.schemas, nodeMade.candidate.schemas);
  assert.deepEqual(human.candidate.portability, nodeMade.candidate.portability);
  assert.deepEqual(human.candidate.requiredCapabilities, nodeMade.candidate.requiredCapabilities);
  assert.deepEqual(human.candidate.requiredPermissions, nodeMade.candidate.requiredPermissions);
  assert.notEqual(human.candidate.creator.creationMode, nodeMade.candidate.creator.creationMode);

  const invalidHuman = creator.create(pureDef({ requiredCapabilities: ['nope.nope'] }), HUMAN);
  const invalidNode = creator.create(pureDef({ requiredCapabilities: ['nope.nope'] }), NODE_MODE);
  const answerHuman = creator.validate(invalidHuman);
  const answerNode = creator.validate(invalidNode);
  assert.equal(answerHuman.state, 'REJECTED');
  assert.equal(answerNode.state, 'REJECTED');
  assert.deepEqual(
    answerHuman.reasons.map((r) => r.reason),
    answerNode.reasons.map((r) => r.reason),
    'identical refusals for identical candidates',
  );
  // origin difference is visible ONLY as provenance
  assert.equal(answerHuman.candidate.creator.creationMode, 'HUMAN');
  assert.equal(answerNode.candidate.creator.creationMode, 'NODE');
});

test('C: NODE origin requires approval on the SAME valid pipeline — stricter, never laxer', () => {
  const { creator } = harness();
  const human = creator.validate(creator.create(pureDef(), HUMAN));
  const nodeMade = creator.validate(creator.create(pureDef(), NODE_MODE));
  assert.equal(human.state, 'VALID', 'human+pure needs no gate');
  assert.equal(nodeMade.state, 'APPROVAL_REQUIRED', 'node-created always waits');
  assert.ok(requiresApproval(nodeMade.candidate) === true);
  assert.ok(requiresApproval(human.candidate) === false);
});

/* ================================================================ *
 * D. Approval
 * ================================================================ */

test('D: approval-required state is explicit, bounded, policy-driven — and never implicit for all', () => {
  const { creator, approvals } = harness();
  const network = creator.validate(creator.create(networkDef(), HUMAN));
  assert.equal(network.state, 'APPROVAL_REQUIRED');
  assert.ok(network.approval?.approvalId, 'an approval record exists');
  const status = creator.approvalStatus(network);
  assert.equal(status.required, true);
  assert.equal(status.state, 'requested');
  assert.equal(status.risk, 'high', 'authority-bearing class ⇒ high risk');
  assert.equal(status.scope, 'node-registry:demo.http', 'scope is the node boundary');
  assert.ok(APPROVAL_STATES.includes(status.state));
  // the approval record lives in the P2.19 foundation with actor/risk/scope — structural, auditable
  const record = approvals.inspect(network.approval.approvalId);
  assert.equal(record.actor, 'agent-1');
  assert.equal(record.risk, 'high');
  assert.match(record.action, /^node\.create:demo\.http@1\.0\.0$/);
  // PURE+HUMAN opened no approval at all
  const pure = creator.validate(creator.create(pureDef(), HUMAN));
  assert.equal(pure.state, 'VALID');
  assert.equal(creator.approvalStatus(pure).approvalId, null);
  assert.equal(creator.approvalStatus(pure).required, false, 'no implicit approval for every node');
});

test('D: explicit granted decision seals the record into a publishable reference', () => {
  const { creator, approvals } = harness();
  const pending = creator.validate(creator.create(pureDef(), NODE_MODE));
  assert.equal(pending.state, 'APPROVAL_REQUIRED');
  approvals.resolve({ approvalId: pending.approval.approvalId, decision: 'granted', approver: 'manager' });
  const sealed = creator.validate(pending);
  assert.equal(sealed.state, 'PUBLISHED_REFERENCE');
  assert.match(sealed.reference.checksum, /^sha256:[0-9a-f]{64}$/);
  assert.equal(sealed.reference.storageRef, 'node.definition/demo.echo@1.0.0');
  assert.match(sealed.reference.meaning, /no such authority|holds none/, 'reference never claims creator publish power');
  const status = creator.approvalStatus(sealed);
  assert.equal(status.decision, 'granted');
  assert.equal(status.state, 'granted');
});

test('D: explicit denied decision rejects — approval reference is never a credential', () => {
  const { creator, approvals } = harness();
  const pending = creator.validate(creator.create(pureDef(), NODE_MODE));
  approvals.resolve({
    approvalId: pending.approval.approvalId, decision: 'denied', approver: 'manager', reason: 'not-yet',
  });
  const denied = creator.validate(pending);
  assert.equal(denied.state, 'REJECTED');
  assert.equal(denied.reasons[0].reason, 'approval-not-granted');
  assert.equal(denied.reference, null, 'denial produces no reference');
  const text = JSON.stringify(denied.reasons);
  assert.ok(!/Bearer|token|credential/i.test(text), 'reasons never carry credential-shaped text');
});

test('D: malformed / unknown approval references fail closed — never granted', () => {
  const { creator } = harness();
  const pending = creator.validate(creator.create(pureDef(), NODE_MODE));
  const forged = { ...pending, approval: { approvalId: 'apr-ghost-0001' } };
  const status = creator.approvalStatus(forged);
  assert.equal(status.state, null);
  assert.equal(status.decision, 'denied');
  assert.match(status.reason, /unknown approval/);
  const settled = creator.validate(forged);
  assert.equal(settled.state, 'REJECTED', 'unknown approval settles as refusal, not allow');
  assert.equal(settled.reasons[0].reason, 'approval-not-granted');
  assert.throws(() => creator.approvalStatus({ recordId: 'nope' }), /approvalStatus/);
});

/* ================================================================ *
 * E. Artifact
 * ================================================================ */

test('E: the artifact result is a reference — identity, checksum, provenance; content never copied', () => {
  const { creator, approvals, artifacts } = harness();
  const pending = creator.validate(creator.create(pureDef(), NODE_MODE));
  approvals.resolve({ approvalId: pending.approval.approvalId, decision: 'granted', approver: 'manager' });
  const sealed = creator.validate(pending);
  const artifact = artifacts.read(sealed.reference.artifactId);
  assert.ok(artifact, 'the P2.19 registry holds the record');
  assert.ok(ARTIFACT_KINDS.includes(artifact.kind));
  assert.equal(artifact.checksum, sealed.reference.checksum);
  assert.equal(artifact.storageRef, sealed.reference.storageRef);
  assert.equal(artifact.content, undefined, 'content stays behind the opaque reference');
  assert.equal(artifact.metadata.nodeId, 'demo.echo');
  assert.equal(artifact.metadata.mode, 'NODE');
  // checksum is the canonical digest of the canonical candidate core
  const expected = artifactContentDigest({
    nodeId: 'demo.echo',
    version: '1.0.0',
    schemas: { input: { type: 'string' }, output: { type: 'boolean' } },
    portability: { class: 'PURE' },
    requiredCapabilities: [],
    requiredPermissions: [],
  });
  assert.equal(sealed.reference.checksum, expected, 'checksum = canonical digest (sorted keys)');
});

test('E: no arbitrary blob, no credential injection — sensitive values are refused everywhere', () => {
  const { creator } = harness();
  assert.throws(() => creator.create(pureDef({
    artifactRequirements: ['Bearer abcdef123456'],
  }), HUMAN), NodeCreatorError);
  assert.throws(() => creator.create(pureDef(), {
    ...HUMAN, creatorId: 'ghp_abcdefgh1234567890',
  }), /secret-shaped|creatorId/);
  const fromSource = creator.translate(sourceEnvelope({ secret: 'shh' }), HUMAN);
  assert.equal(fromSource.state, 'REJECTED');
  assert.equal(fromSource.reasons[0].reason, 'lossy-source-field');
});

/* ================================================================ *
 * F. Portability — P2.22 is the ONE authority
 * ================================================================ */

test('F: validate() IS canPort — same result as calling P2.22 directly, no parallel checker', () => {
  const { creator } = harness();
  const record = creator.create(networkDef(), HUMAN);
  const answer = creator.validate(record, { target: 'JS', context: {} });
  assert.equal(answer.state, 'APPROVAL_REQUIRED', 'valid before the gate');
  const direct = canPort({
    nodeId: record.candidate.nodeId,
    contract: record.candidate.contract,
    portability: record.candidate.portability,
    requiredCapabilities: record.candidate.requiredCapabilities,
    requiredPermissions: record.candidate.requiredPermissions,
    schemas: record.candidate.schemas,
    artifactRequirements: record.candidate.artifactRequirements,
  }, 'JS', {});
  assert.deepEqual(answer.validation, direct, 'identical object from the same authority');
  assert.equal(answer.validation.reasons.every((r) => PORTABILITY_REASONS.includes(r.reason)), true);
  // module source: only one portability verb, imported from P2.22
  assert.ok(MODULE_SOURCE.includes("from './node-portability.mjs'"));
  assert.ok(!/function canPort/.test(MODULE_SOURCE), 'canPort is never re-implemented');
  assert.ok(!/creatorPortabilityCheck|translationPortabilityCheck/.test(MODULE_SOURCE));
  const imports = [...MODULE_SOURCE.matchAll(/import \{([^}]+)\} from '\.\/node-portability\.mjs'/g)][0][1];
  assert.ok(imports.includes('canPort'), 'the verdict comes from the import');
});

test('F: preview surfaces describePortability verbatim (the P2.22 read path)', () => {
  const { creator } = harness();
  const record = creator.create(networkDef(), HUMAN);
  const preview = creator.preview(record);
  assert.deepEqual(preview.portability, describePortability(record.candidate));
  assert.equal(preview.portability.class, 'NETWORK');
  assert.equal(preview.requiresApproval, true);
  assert.deepEqual(Object.keys(preview.portability.matrixRow).sort(), ['JS', 'REMOTE', 'RUST_NATIVE', 'WASM']);
});

test('F: unknown portability class never reaches a permissive path — refused at the door', () => {
  const { creator } = harness();
  assert.throws(() => creator.create(pureDef({ portability: { class: 'REMOTE-ONLY' } }), HUMAN), /canonical class/);
  assert.equal(PORTABILITY_CLASSES.includes('REMOTE-ONLY'), false, 'and it is not a P2.22 class either');
});

/* ================================================================ *
 * G. Security — static walls + firewalls
 * ================================================================ */

test('G: static imports are five canonical backend files — zero builtin surface, no fs/net/process/model', () => {
  const imports = [...MODULE_SOURCE.matchAll(/from '([^']+)'/g)].map((match) => match[1]);
  assert.deepEqual(imports.sort(), [
    './ai-foundation.mjs', './approval.mjs', './artifact.mjs',
    './node-portability.mjs', './registry.mjs',
  ], 'no builtin import at all — OS reach lives only inside the foundations');
  for (const forbidden of ['node:fs', 'node:net', 'node:child_process', 'node:timers', 'node:http',
    'node:https', 'node:worker_threads', 'node:dgram', 'child_process', 'spawn(', 'exec(', 'fetch(']) {
    assert.ok(!MODULE_SOURCE.includes(forbidden), `forbidden: ${forbidden}`);
  }
  for (const forbidden of ['openai', 'anthropic', 'deepseek', 'gemini', 'hermes', 'mirofish',
    'openclaw', 'composio', '9router', 'telegram']) {
    assert.ok(!MODULE_SOURCE.toLowerCase().includes(forbidden.toLowerCase()), `no ${forbidden}`);
  }
  // no live credential SHAPES — the module may only carry the detectors that refuse them
  assert.ok(!/ghp_[A-Za-z0-9]{30,}/.test(MODULE_SOURCE), 'no embedded GitHub PAT value');
  assert.ok(!/github_pat_[A-Za-z0-9_]{20,}/.test(MODULE_SOURCE), 'no embedded fine-grained PAT');
  assert.ok(!/\bsk-[A-Za-z0-9]{20,}/.test(MODULE_SOURCE), 'no embedded api key value');
  assert.ok(!/Bearer\s+[A-Za-z0-9._-]{20,}/.test(MODULE_SOURCE), 'no embedded bearer token value');
  assert.ok(!/Math\.random|new Date\(|setTimeout|setInterval|performance\.now/.test(MODULE_SOURCE),
    'no wall clock, timers or randomness — time and identity are injected');
});

test('G: no autonomous publishing, no execution, no self-modification in the module', () => {
  assert.ok(!/\bpublish\s*\(/.test(MODULE_SOURCE), 'no publish() call exists');
  assert.ok(!/\bexecute\s*\(|runNode|eval\(/.test(MODULE_SOURCE), 'no execution path');
  assert.ok(!/writeFileSync|appendFileSync|renameSync|mkdirSync|rmSync/.test(MODULE_SOURCE), 'no filesystem authority');
  assert.ok(!/setPolicy|modifyPolicy|grantItself|selfGrant|rewriteRules/.test(MODULE_SOURCE), 'no self-modification surface');
  for (const name of Object.keys(creatorModule)) {
    assert.ok(!/publish|execute|grant|mutatePolicy|credential/i.test(name), `${name} stays inside the boundary`);
  }
  // policy objects are frozen — configuration is declared input, not mutable policy
  assert.ok(Object.isFrozen(APPROVAL_POLICY));
  assert.ok(Object.isFrozen(CREATOR_LIMITS));
  assert.ok(Object.isFrozen(CREATOR_STATE_TRANSITIONS));
});

test('G: declaration never becomes grant — answer shapes carry no authority fields', () => {
  const { creator, approvals } = harness();
  const pending = creator.validate(creator.create(networkDef(), NODE_MODE));
  const text = JSON.stringify(pending);
  for (const word of ['"granted"', 'allowToken', '"capabilityGrant"', '"permissionGrant"', 'credential']) {
    assert.ok(!text.includes(word), `pending record never carries ${word}`);
  }
  // the approval record itself keeps decision words OUT while requested
  const record = approvals.inspect(pending.approval.approvalId);
  assert.equal(record.state, 'requested');
  assert.equal(record.decision, null, 'no decision exists yet — not even a default allow');
  // requiresApproval is pure and policy-table driven
  assert.equal(typeof requiresApproval(pending.candidate), 'boolean');
  assert.deepEqual(Object.keys(APPROVAL_POLICY), ['requiredClasses', 'requiredCreationModes', 'note', 'riskFor']);
  assert.equal(approvalRiskFor('PURE'), 'low');
  assert.equal(approvalRiskFor('NETWORK'), 'high');
  assert.equal(approvalRiskFor('FILESYSTEM'), 'medium');
});

test('G: the creator refuses to exist without injected clock and identity', () => {
  assert.throws(() => createNodeCreator({
    approvals: { open() {}, evaluate() {}, resolve() {}, inspect() {} },
    artifacts: { create() {}, read() {} },
  }), /must be injected/);
  assert.throws(() => createNodeCreator({
    approvals: { open() {}, evaluate() {}, resolve() {}, inspect() {} },
    artifacts: { create() {}, read() {} },
    now: clock, // newId missing
  }), /must be injected/);
});

test('G: origin never appears as a security decision — only as provenance fields', () => {
  const { creator } = harness();
  const pending = creator.validate(creator.create(pureDef(), NODE_MODE));
  const preview = creator.preview(pending);
  assert.equal(preview.state, 'APPROVAL_REQUIRED', 'the gate uses the policy, and status stays structural');
  assert.equal(preview.candidate.creator.creationMode, 'NODE');
  // preview/read paths expose provenance, never an identity-based verdict field
  for (const key of ['originAllowed', 'trusted', 'bypass', 'autoApproved']) {
    assert.ok(!(key in preview), `no '${key}' verdict`);
  }
});

/* ================================================================ *
 * §32 Determinism + pipeline convergence (imported input too)
 * ================================================================ */

test('pipeline convergence: equivalent candidates — created or translated — pass the SAME validation', () => {
  const { creator } = harness();
  const created = creator.create(pureDef(), HUMAN);
  const translated = creator.translate(sourceEnvelope(), { ...HUMAN, sourceKind: 'imported' });
  const a = creator.validate(created);
  const b = creator.validate(translated);
  assert.equal(a.state, 'VALID');
  assert.equal(b.state, 'VALID');
  assert.deepEqual(a.validation.compatibility, b.validation.compatibility, 'same five-axis verdict');
  assert.deepEqual(a.validation.reasons, b.validation.reasons);
  assert.equal(a.validation.overall, b.validation.overall);
  // and identical candidates converge even across creators
  const { creator: other } = harness();
  const twin = other.translate(sourceEnvelope(), { ...HUMAN, sourceKind: 'imported' });
  assert.deepEqual(twin.candidate, translated.candidate, 'two creators, one canonical candidate');
});

test('same input ⇒ same refusal, same reason, every run (differential determinism)', () => {
  const { creator } = harness();
  const bad = sourceEnvelope({ token: 'x' });
  const runs = [0, 1, 2].map(() => creator.translate(bad, HUMAN));
  assert.deepEqual(runs[0].reasons, runs[1].reasons);
  assert.deepEqual(runs[1].reasons, runs[2].reasons);
  assert.equal(runs[0].recordId, runs[1].recordId);
  const validA = creator.validate(creator.create(pureDef(), HUMAN));
  const validB = creator.validate(creator.create(pureDef(), HUMAN));
  assert.deepEqual(validA.validation, validB.validation, 'canonical observable contract only');
});

/* ================================================================ *
 * H. Guards — prior contracts untouched (range-checked in git; file pins here)
 * ================================================================ */

test('H: prior contract files are read, never modified — pins on their public surfaces', () => {
  const agentSource = readFileSync(join(HERE.pathname, '..', 'src', 'lego', 'agent-machine.mjs'), 'utf8');
  assert.equal((agentSource.match(/^export /gm) ?? []).length, 23, 'P2.16 untouched');
  const portabilitySource = readFileSync(join(HERE.pathname, '..', 'src', 'lego', 'node-portability.mjs'), 'utf8');
  assert.ok(portabilitySource.includes("NODE_PORTABILITY_CONTRACT = 'node.portability@1.0.0'"), 'P2.22 contract untouched');
  assert.ok(!portabilitySource.includes('node.creator'), 'P2.22 does not know about P2.23 (no reverse coupling)');
  const errors = JSON.parse(readFileSync(join(HERE.pathname, '..', 'src', 'lego', 'contracts', 'errors.contract.json'), 'utf8'));
  assert.equal(errors.version, '1.2.0', 'error contract untouched — we reused lego.contract_violation');
  // approval/artifact foundations used as-is (P2.19)
  assert.deepEqual([...APPROVAL_STATES], ['requested', 'granted', 'denied', 'expired']);
});

test('H: input field vocabularies stay closed — source fields, forbidden fields, refused reasons', () => {
  assert.deepEqual([...TRANSLATION_SOURCE_FIELDS].sort(), [
    'artifactRequirements', 'description', 'name', 'nodeId', 'portability',
    'requiredCapabilities', 'requiredPermissions', 'schemas', 'securityProfile', 'version',
  ]);
  for (const field of TRANSLATION_FORBIDDEN_FIELDS) {
    assert.ok(['credential', 'credentials', 'token', 'secret', 'apiKey', 'api-key',
      'authentication', 'oauth', 'privateKey', 'webhookSecret'].includes(field));
  }
  assert.deepEqual([...TRANSLATION_REFUSAL_REASONS], [
    'unknown-source-construct', 'lossy-source-field', 'unknown-language-marker',
    'unknown-creation-mode', 'unknown-source-kind', 'missing-source-schema',
  ]);
  for (const reason of CREATOR_REFUSAL_REASONS) assert.equal(typeof reason, 'string');
});
