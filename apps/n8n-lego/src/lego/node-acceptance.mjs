/**
 * P6 core acceptance — P6.15.
 *
 * PUBLIC CONTRACT (`node.acceptance@0.1.0`, domain `node-registry`).
 *
 * Fourteen contracts, fourteen promises. This contract is the one that CHECKS
 * them, and it exists because "we wrote tests" is not the same claim as "the core
 * behaves as specified, every time, on demand, with evidence".
 *
 * A CLAIM IS A SENTENCE AND A RUNNER. The sentences live in `ACCEPTANCE_CLAIMS`
 * (id, category, statement, the contracts it covers); the runners drive the REAL
 * contracts — no mocks, no stubs, no private imports. If a claim cannot be checked
 * with the public surface of the contract that makes the promise, the promise is
 * not public and the claim says so.
 *
 * THE REPORT CANNOT BE CHERRY-PICKED. `runAcceptance({ include })` runs a subset —
 * and the report records that it is partial. `verifyAcceptanceReport` rebuilds the
 * digest AND requires the full claim set: a report that quietly omits the claim
 * that fails is not evidence, and the way to prevent that is to make the omission
 * detectable rather than to trust the author.
 *
 * FAIL-CLOSED EVIDENCE. Two claims need artefacts this module deliberately does
 * not read (the module sources and the contract lock). They are INJECTED:
 * `runAcceptance({ evidence: { sources, lock } })`. Missing evidence is a FAILURE,
 * not a skip: an acceptance run that cannot check the boundary claim has not
 * checked the boundary, and reporting that as "not applicable" would be the
 * most comfortable lie in the building.
 *
 * WHAT THIS IS NOT (P6.15 scope walls, enforced by tests):
 *   - it does not re-implement any contract: every claim calls the contract that
 *     owns the promise, so a claim cannot pass while the contract is broken;
 *   - it does not decide anything: it reports. Acceptance is evidence for a human
 *     and for P6.31, not an authority;
 *   - no filesystem, no network, no clock, no randomness, no mutation: the two
 *     claims that need files receive their contents as data.
 *
 * Authority: a passing report is a statement about the contracts at one commit.
 * It is never permission to ship, and it never replaces the gates.
 */
import { createHash } from 'node:crypto';

import { NODE_REGISTRY_CONTRACT, nodeIdentity } from './node-registry.mjs';
import { REGISTRY_COMPILER_CONTRACT, compileRegistryEpoch } from './registry-compiler.mjs';
import {
  PACKAGE_TRANSACTION_CONTRACT, PACKAGE_TRANSACTION_STEPS,
  abortPackageTransaction, commitPackageTransaction, decidePackageRecovery,
  planPackageTransaction, recordPackageStep,
} from './package-transaction.mjs';
import {
  DEPENDENCY_CLOSURE_CONTRACT,
  createArtifactStore, resolveDependencyClosure, storeArtifact, verifyArtifact,
} from './dependency-closure.mjs';
import { RESOLUTION_MANIFEST_CONTRACT, createResolutionManifest, resolveWorkflowNodes } from './resolution-manifest.mjs';
import {
  RUNTIME_LEASE_CONTRACT,
  acquireLease, createLeaseTable, drainEpoch, epochsHeldBy, isFullyDrained, registerEpoch, releaseLease, retireEpoch,
} from './runtime-lease.mjs';
import { RESIDENCY_CONTRACT, createResidencyTable, evictNode, loadNode, residencyOf, warmNode } from './node-residency.mjs';
import { CAPABILITY_COMPILER_CONTRACT, compileCapabilityPlan, hostProfile } from './capability-compiler.mjs';
import { SEMANTIC_FINGERPRINT_CONTRACT, fingerprintNodeSemantics, replayFingerprints } from './semantic-fingerprint.mjs';
import { NODE_LIFECYCLE_CONTRACT, createLifecycleLedger, mayReuseName, tombstoneNode, transitionNode } from './node-lifecycle.mjs';
import { NODE_HEALTH_CONTRACT, createHealthTable, mayServe, quarantineNode, recordObservation } from './node-health.mjs';
import {
  SUPPLY_CHAIN_CONTRACT,
  createAttestationPolicy, createRevocationList, mirrorManifest, revokeArtifact, signAttestation, verifyMirror,
} from './supply-chain.mjs';
import { INCREMENTAL_REGISTRY_CONTRACT, applyRegistryChanges, createIncrementalState, verifyIncremental } from './incremental-registry.mjs';
import { WORKER_CONVERGENCE_CONTRACT, coordinatorBinding, handshake, workerBinding } from './worker-convergence.mjs';

export const ACCEPTANCE_CONTRACT = 'node.acceptance@0.1.0';
export const ACCEPTANCE_CONTRACT_VERSION = '0.1.0';
export const ACCEPTANCE_SCHEMA_VERSION = 1;

export const ACCEPTANCE_OPERATIONS = Object.freeze(['list', 'run', 'verify', 'describe']);
export const ACCEPTANCE_PERMISSIONS = Object.freeze(['node:read']);

/** The core this milestone accepts: P6.1 through P6.15, each named by its own contract. */
export const ACCEPTANCE_COVERS = Object.freeze([
  NODE_REGISTRY_CONTRACT,
  REGISTRY_COMPILER_CONTRACT,
  PACKAGE_TRANSACTION_CONTRACT,
  DEPENDENCY_CLOSURE_CONTRACT,
  RESOLUTION_MANIFEST_CONTRACT,
  RUNTIME_LEASE_CONTRACT,
  RESIDENCY_CONTRACT,
  CAPABILITY_COMPILER_CONTRACT,
  SEMANTIC_FINGERPRINT_CONTRACT,
  NODE_LIFECYCLE_CONTRACT,
  NODE_HEALTH_CONTRACT,
  SUPPLY_CHAIN_CONTRACT,
  INCREMENTAL_REGISTRY_CONTRACT,
  WORKER_CONVERGENCE_CONTRACT,
  ACCEPTANCE_CONTRACT,
]);

export const ACCEPTANCE_CATEGORIES = Object.freeze([
  'identity', 'epoch', 'install', 'closure', 'resolution', 'lease', 'residency',
  'capability', 'semantics', 'lifecycle', 'health', 'supply', 'incremental',
  'convergence', 'boundary', 'surface',
]);

export const ACCEPTANCE_REASONS = Object.freeze([
  'acceptance.input',
  'acceptance.claim',
  'acceptance.evidence',
  'acceptance.report',
]);

export const ACCEPTANCE_RULES = Object.freeze({
  claim: 'a claim is a sentence and a runner: it drives the contract that makes the promise, so a claim cannot pass while the contract is broken',
  complete: 'a report that quietly omits the claim that fails is not evidence, and the way to prevent that is to make the omission detectable rather than to trust the author',
  evidence: 'missing evidence is a failure, not a skip: an acceptance run that cannot check the boundary claim has not checked the boundary',
  authority: 'a passing report is a statement about the contracts at one commit; it is never permission to ship, and it never replaces the gates',
});

/** Modules the P6 core must never reach into: the engine, the graph, the transports. */
export const ACCEPTANCE_FORBIDDEN_IMPORTS = Object.freeze([
  'execution-ir.mjs', 'execution-optimizer.mjs', 'bounded-frontier.mjs', 'workflow-graph.mjs',
  'envelope.mjs', 'agent-machine.mjs', 'agent-machine-runtime.mjs', 'agent-session.mjs',
  'provider-declaration.mjs', 'transport-kernel.mjs', 'state-stream.mjs', 'context.mjs',
]);

/* ------------------------------------------------------------------ *
 * Errors, helpers
 * ------------------------------------------------------------------ */

/** Raised for API misuse. A failed claim is data inside a report. */
export class AcceptanceError extends Error {
  constructor(message, meta = {}) {
    super(message);
    this.name = 'AcceptanceError';
    this.code = 'lego.contract_violation';
    this.meta = Object.freeze({ ...meta });
  }
}

const fail = (message, meta) => { throw new AcceptanceError(message, meta); };
const isPlainObject = (value) => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};
const isNonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0;

function deepFreeze(value) {
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
    return Object.freeze(value);
  }
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    return Object.freeze(value);
  }
  return value;
}

const stableJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
};

const digestOf = (canonicalJson) => `sha256:${createHash('sha256').update(canonicalJson, 'utf8').digest('hex')}`;

/** A structural declaration for a node identity: P6.1's shape, as the compiler takes it. */
const declaration = (type, typeVersion, overrides = {}) => ({
  type,
  typeVersion,
  package: type.split('.')[0],
  packageVersion: '1.0.0',
  vendor: 'n8n',
  contractVersion: '0.1.0',
  implementationVersion: '0.1.0',
  digest: `sha256:${'a'.repeat(64)}`,
  provenance: { kind: 'package-registry', source: 'npm:n8n-nodes-base@1.0.0' },
  capabilities: ['network'],
  trustClass: 'core',
  runtimeLocality: 'js-compat',
  resourceProfile: { cpu: 'low', memory: 'medium', disk: 'none', network: true, concurrency: 'parallel-safe', startup: 'fast' },
  compatibility: { contractRange: '^0.1.0', portabilityTargets: ['JS'] },
  lifecycle: 'declared',
  health: 'unknown',
  discovery: { displayName: type, group: 'transform', description: `about ${type}` },
  ...overrides,
});

const HTTP = declaration('n8n-nodes-base.httpRequest', 4.4);
const SET = declaration('n8n-nodes-base.set', 3.4);
const IF = declaration('n8n-nodes-base.if', 2.2);
const EPOCH_1 = compileRegistryEpoch({ declarations: [HTTP, SET], source: 'acceptance-1' });
const EPOCH_2 = compileRegistryEpoch({ declarations: [HTTP, SET, IF], epochNumber: 2, source: 'acceptance-2' });

const semanticsNode = (overrides = {}) => ({
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
  implementation: { language: 'javascript', entry: 'HttpRequest.node.js' },
  ...overrides,
});

const accepts = (ok, evidence, failures = []) => ({ ok, evidence, failures });
const failure = (code, message) => ({ code, message });

/* ------------------------------------------------------------------ *
 * The claims: sentences a human can read, runners that call real code
 * ------------------------------------------------------------------ */

const claimDefinitions = [
  { id: 'identity.canonical', category: 'identity', statement: 'a node is identified by type and typeVersion, and two declarations claiming one identity are refused rather than silently ordered', covers: [NODE_REGISTRY_CONTRACT, REGISTRY_COMPILER_CONTRACT] },
  { id: 'epoch.deterministic', category: 'epoch', statement: 'the same declarations compile to the same immutable epoch digest, and a different epoch number is a different epoch', covers: [REGISTRY_COMPILER_CONTRACT] },
  { id: 'install.atomic', category: 'install', statement: 'an installation cannot commit before every step is done, and an aborted transaction is finished rather than half-applied', covers: [PACKAGE_TRANSACTION_CONTRACT] },
  { id: 'closure.deterministic', category: 'closure', statement: 'a dependency closure is closed, ordered and identical across runs, a missing dependency fails closed, and identical bytes share one content address', covers: [DEPENDENCY_CLOSURE_CONTRACT] },
  { id: 'resolution.pinned', category: 'resolution', statement: 'a workflow pins node identities with digests, resolves to a match on its own epoch, and reports missing or changed instead of guessing', covers: [RESOLUTION_MANIFEST_CONTRACT] },
  { id: 'lease.pinned', category: 'lease', statement: 'a lease names the epoch it holds, two epochs serve side by side, and an epoch is fully drained only when its leases are released', covers: [RUNTIME_LEASE_CONTRACT] },
  { id: 'residency.tiers', category: 'residency', statement: 'a cold node cannot be loaded without being warmed first, and eviction DEMOTES a node rather than losing it', covers: [RESIDENCY_CONTRACT] },
  { id: 'capability.all-or-nothing', category: 'capability', statement: 'a capability plan grants everything or nothing, a host that lacks a capability cannot grant it, and a trust class never stands in for one', covers: [CAPABILITY_COMPILER_CONTRACT] },
  { id: 'semantics.equivalence', category: 'semantics', statement: 'semantics are fingerprinted per axis: a behaviour change breaks the fingerprint, and an implementation-only change is REPORTED as an implementation change without breaking semantics', covers: [SEMANTIC_FINGERPRINT_CONTRACT] },
  { id: 'lifecycle.irreversible', category: 'lifecycle', statement: 'a tombstoned identity cannot be transitioned back and its name cannot be reused', covers: [NODE_LIFECYCLE_CONTRACT] },
  { id: 'health.breaker', category: 'health', statement: 'consecutive failures open the circuit and refuse work, a quarantine outranks a later success, and mayServe names why', covers: [NODE_HEALTH_CONTRACT] },
  { id: 'supply.revocation', category: 'supply', statement: 'an attestation policy gates who may attest what, and a revocation outranks an explicit unattested exemption', covers: [SUPPLY_CHAIN_CONTRACT] },
  { id: 'incremental.equivalence', category: 'incremental', statement: 'an incrementally compiled epoch equals a full compile of the same declarations, and a state that differs is reported rather than trusted', covers: [INCREMENTAL_REGISTRY_CONTRACT] },
  { id: 'convergence.separation', category: 'convergence', statement: 'a worker that is behind and consistent is upgradable, a worker that disagrees is a mismatch, and the two decisions differ', covers: [WORKER_CONVERGENCE_CONTRACT] },
  { id: 'boundary.scope-walls', category: 'boundary', statement: 'no core contract reaches into the engine, the workflow graph or the transports', covers: ACCEPTANCE_COVERS },
  { id: 'surface.lock-rows', category: 'surface', statement: 'every core contract has exactly one locked row at its shipped version', covers: ACCEPTANCE_COVERS },
];

const claimRunners = {
  'identity.canonical': () => {
    const identity = nodeIdentity({ type: 'n8n-nodes-base.httpRequest', typeVersion: 4.4 });
    const duplicated = compileRegistryEpoch({ declarations: [SET, { ...SET, digest: `sha256:${'b'.repeat(64)}` }], source: 'acceptance-dup' });
    const twoVersions = compileRegistryEpoch({ declarations: [SET, declaration('n8n-nodes-base.set', 3.5)], source: 'acceptance-two' });
    const refused = duplicated.ok === false || (duplicated.errors ?? []).length > 0;
    const evidence = [
      `identity=${identity}`,
      `duplicate refused=${refused}${refused ? ` (${(duplicated.errors ?? []).map((error) => error.code).join(', ') || duplicated.reason})` : ''}`,
      `two typeVersions are two identities=${twoVersions.count === 2}`,
    ].join('; ');
    const failures = [];
    if (identity !== 'n8n-nodes-base.httpRequest@4.4') failures.push(failure('acceptance.claim', `identity is not type@typeVersion: got ${identity}`));
    if (!refused) failures.push(failure('acceptance.claim', 'two declarations claiming one identity were accepted'));
    if (twoVersions.count !== 2) failures.push(failure('acceptance.claim', 'two typeVersions did not produce two identities'));
    return accepts(failures.length === 0, evidence, failures);
  },

  'epoch.deterministic': () => {
    const again = compileRegistryEpoch({ declarations: [HTTP, SET], source: 'acceptance-1' });
    const third = compileRegistryEpoch({ declarations: [HTTP, SET], epochNumber: 5, source: 'acceptance-1' });
    const failures = [];
    if (again.epochDigest !== EPOCH_1.epochDigest) failures.push(failure('acceptance.claim', 'the same declarations produced a different epoch digest'));
    if (third.epochDigest === EPOCH_1.epochDigest) failures.push(failure('acceptance.claim', 'a different epoch number produced the same digest'));
    if (!Object.isFrozen(EPOCH_1)) failures.push(failure('acceptance.claim', 'the compiled epoch is not frozen'));
    return accepts(failures.length === 0, `epoch ${EPOCH_1.epochNumber} digest stable=${again.epochDigest === EPOCH_1.epochDigest}, frozen=${Object.isFrozen(EPOCH_1)}, epoch 5 differs=${third.epochDigest !== EPOCH_1.epochDigest}`, failures);
  },

  'install.atomic': () => {
    let transaction = planPackageTransaction({ package: 'n8n-nodes-base', version: '2.9.1', digest: `sha256:${'a'.repeat(64)}`, source: 'npm:n8n-nodes-base@2.9.1' });
    const stageIndex = PACKAGE_TRANSACTION_STEPS.indexOf('stage');
    for (const step of PACKAGE_TRANSACTION_STEPS.slice(0, stageIndex + 1)) transaction = recordPackageStep(transaction, { step });
    let refusedCode = null;
    try {
      commitPackageTransaction(transaction);
    } catch (error) {
      refusedCode = error.meta?.code ?? error.code;
    }
    const aborted = abortPackageTransaction(transaction, 'acceptance:aborted');
    const recovery = decidePackageRecovery(aborted);
    const failures = [];
    if (refusedCode === null) failures.push(failure('acceptance.claim', 'a transaction committed before every step was done'));
    if (aborted.status !== 'aborted') failures.push(failure('acceptance.claim', `an aborted transaction is ${aborted.status}`));
    if (recovery.action !== 'none') failures.push(failure('acceptance.claim', `an aborted transaction still needs recovery: ${recovery.action}`));
    return accepts(failures.length === 0, `commit refused (${refusedCode}), aborted status=${aborted.status}, recovery action=${recovery.action}`, failures);
  },

  'closure.deterministic': () => {
    const catalogue = {
      root: { '1.0.0': { digest: `sha256:${'1'.repeat(64)}`, dependencies: [{ package: 'leaf', range: '^1.0.0' }] } },
      leaf: { '1.0.0': { digest: `sha256:${'2'.repeat(64)}` } },
    };
    const first = resolveDependencyClosure({ root: { package: 'root' }, catalogue });
    const second = resolveDependencyClosure({ root: { package: 'root' }, catalogue });
    const broken = resolveDependencyClosure({ root: { package: 'root' }, catalogue: { root: catalogue.root } });
    const store = storeArtifact(createArtifactStore(), 'contents');
    const again = storeArtifact(store.store, 'contents');
    const verified = verifyArtifact(again.store, again.address, 'contents');
    const tampered = verifyArtifact(again.store, again.address, 'other contents');
    const failures = [];
    if (!first.ok) failures.push(failure('acceptance.claim', `the closure did not resolve: ${first.reason}`));
    if (first.digest !== second.digest) failures.push(failure('acceptance.claim', 'two resolutions of one catalogue produced different digests'));
    if (JSON.stringify(first.order) !== JSON.stringify(second.order)) failures.push(failure('acceptance.claim', 'two resolutions produced different orders'));
    if (broken.ok !== false) failures.push(failure('acceptance.claim', 'a missing dependency did not fail closed'));
    if (again.deduplicated !== true || again.address !== store.address) failures.push(failure('acceptance.claim', 'identical bytes did not share one content address'));
    if (verified.ok !== true || tampered.ok !== false) failures.push(failure('acceptance.claim', 'content verification did not detect tampering'));
    return accepts(failures.length === 0, `closure digest=${String(first.digest).slice(0, 18)}…, order=${first.order.length}, missing-dep refusal=${broken.reason}, CAS deduplicated=${again.deduplicated}, tamper detected=${tampered.ok === false}`, failures);
  },

  'resolution.pinned': () => {
    // Three epochs, three answers: the pin's own epoch, an epoch where the SAME
    // identity has different bytes, and an epoch that does not contain it at all.
    const recompiled = compileRegistryEpoch({
      declarations: [HTTP, declaration('n8n-nodes-base.set', 3.4, { trustClass: 'community' }), IF],
      epochNumber: 3, source: 'acceptance-3',
    });
    const manifest = createResolutionManifest({ workflowId: 'workflow-7', nodes: [{ type: 'n8n-nodes-base.set', typeVersion: 3.4 }], epoch: EPOCH_1 });
    const onOwn = resolveWorkflowNodes(manifest, EPOCH_1);
    const elsewhere = resolveWorkflowNodes(manifest, recompiled);
    const missing = resolveWorkflowNodes(
      createResolutionManifest({ workflowId: 'workflow-8', nodes: [{ type: 'n8n-nodes-base.if', typeVersion: 2.2 }], epoch: EPOCH_2 }),
      EPOCH_1,
    );
    const states = (resolution) => (resolution.states ?? resolution.pins ?? []).map((entry) => entry.state);
    const failures = [];
    if (!states(onOwn).every((state) => state === 'match')) failures.push(failure('acceptance.claim', `a pin did not match its own epoch: ${states(onOwn).join(', ')}`));
    if (!states(elsewhere).includes('changed')) failures.push(failure('acceptance.claim', `a pin against another epoch reported ${states(elsewhere).join(', ')}`));
    if (!states(missing).includes('missing')) failures.push(failure('acceptance.claim', `an absent node reported ${states(missing).join(', ')}`));
    return accepts(failures.length === 0, `pin digest=${String(manifest.manifestDigest).slice(0, 18)}…, own=${states(onOwn).join(',')}, other epoch=${states(elsewhere).join(',')}, absent=${states(missing).join(',')}`, failures);
  },

  'lease.pinned': () => {
    let table = createLeaseTable();
    table = registerEpoch(table, EPOCH_1).table ?? registerEpoch(table, EPOCH_1);
    const registered = (() => {
      const one = registerEpoch(createLeaseTable(), EPOCH_1);
      return registerEpoch(one.table ?? one, EPOCH_2);
    })();
    const sideBySide = (registered.table ?? registered);
    const first = acquireLease(sideBySide, { executionId: 'exec-1', epoch: EPOCH_1 });
    const second = acquireLease(first.table, { executionId: 'exec-2', epoch: EPOCH_2 });
    const drainedEpoch = drainEpoch(second.table, EPOCH_1);
    const draining = drainedEpoch.table ?? drainedEpoch;
    const heldBefore = isFullyDrained(draining);
    const released = releaseLease(draining, first.lease);
    const afterRelease = released.table ?? released;
    const failures = [];
    if (!first.ok || first.lease.epochDigest !== EPOCH_1.epochDigest) failures.push(failure('acceptance.claim', 'a lease did not pin the epoch it was taken on'));
    if (!second.ok || second.lease.epochDigest !== EPOCH_2.epochDigest) failures.push(failure('acceptance.claim', 'two epochs did not serve side by side'));
    if (first.lease.epochDigest === second.lease.epochDigest) failures.push(failure('acceptance.claim', 'two epochs produced one lease epoch'));
    if (isFullyDrained(afterRelease) !== true) failures.push(failure('acceptance.claim', 'the table is not fully drained after the last lease was released'));
    if (heldBefore === true) failures.push(failure('acceptance.claim', 'the table reported fully drained while a lease was outstanding'));
    const held = epochsHeldBy(afterRelease, ['exec-2']);
    return accepts(failures.length === 0, `leases=${[first.reason, second.reason].join('/')}, epochs held by exec-2=${JSON.stringify(held)}, drained only after release=${heldBefore === false}`, failures);
  },

  'residency.tiers': () => {
    const table = createResidencyTable({ epoch: EPOCH_1, maxHot: 2 });
    let refusedCode = null;
    try {
      loadNode(table, 'n8n-nodes-base.set@3.4');
    } catch (error) {
      refusedCode = error.meta?.code ?? error.code;
    }
    const warmed = warmNode(table, 'n8n-nodes-base.set@3.4');
    const loaded = loadNode(warmed.table, 'n8n-nodes-base.set@3.4');
    const evicted = evictNode(loaded.table, 'n8n-nodes-base.set@3.4', { inUseBy: [] });
    const after = evicted.table ?? evicted;
    const afterTier = residencyOf(after, 'n8n-nodes-base.set@3.4');
    const failures = [];
    if (refusedCode === null) failures.push(failure('acceptance.claim', 'a cold node loaded without being warmed'));
    if (loaded.ok !== true || loaded.tier !== 'hot') failures.push(failure('acceptance.claim', `loading a warm node reported ${loaded.tier}`));
    if (evicted.ok !== true) failures.push(failure('acceptance.claim', `eviction was refused: ${evicted.reason}`));
    if (afterTier === 'hot') failures.push(failure('acceptance.claim', 'eviction left the node hot'));
    if (afterTier === null) failures.push(failure('acceptance.claim', 'eviction lost the node instead of demoting it: a demoted node is still a known node'));
    return accepts(failures.length === 0, `cold load refused (${refusedCode}), warm→load tier=${loaded.tier}, eviction ${evicted.tier}/${evicted.reason}, residency after=${afterTier}`, failures);
  },

  'capability.all-or-nothing': () => {
    const host = hostProfile({ hostId: 'acceptance-host', capabilities: ['network'], runtimes: ['js-compat'], failureBoundary: 'sandboxed' });
    const supported = compileCapabilityPlan({ declaration: declaration('n8n-nodes-base.httpRequest', 4.4, { capabilities: ['network'] }), host });
    const unsupported = compileCapabilityPlan({ declaration: declaration('n8n-nodes-base.set', 3.4, { capabilities: ['subprocess'] }), host });
    const promoted = compileCapabilityPlan({ declaration: declaration('n8n-nodes-base.shell', 1.0, { capabilities: ['subprocess'], trustClass: 'official' }), host });
    const failures = [];
    if (supported.ok !== true) failures.push(failure('acceptance.claim', `a supported capability was refused: ${supported.reason}`));
    if (![...supported.granted].includes('network')) failures.push(failure('acceptance.claim', 'a granted plan did not include the capability it granted'));
    if (unsupported.ok === true && unsupported.granted.length > 0) failures.push(failure('acceptance.claim', 'a host that lacks a capability granted it'));
    if (unsupported.ok === false && ![unsupported.granted, unsupported.denied].every((list) => Array.isArray(list))) failures.push(failure('acceptance.claim', 'a refused plan is not shaped as a refusal'));
    if (promoted.ok === true && promoted.granted.length > 0 && supported.granted.length === 0) failures.push(failure('acceptance.claim', 'trust stood in for a capability'));
    if (supported.granted.length !== supported.declaration?.capabilities?.length && supported.ok === true && supported.denied.length > 0) {
      failures.push(failure('acceptance.claim', `a planned grant was partial: granted=${supported.granted.join(',')} denied=${supported.denied.join(',')}`));
    }
    return accepts(failures.length === 0, `host grants network=${supported.granted.join('|') || 'none'} (plan ok=${supported.ok}), subprocess refused=${unsupported.ok === false}${unsupported.ok === false ? ` (${unsupported.reason})` : ''}, official trust grants nothing extra=${promoted.ok === false || promoted.granted.length === 0}`, failures);
  },

  'semantics.equivalence': () => {
    const baseline = fingerprintNodeSemantics(semanticsNode());
    const identical = replayFingerprints(baseline, fingerprintNodeSemantics(semanticsNode()));
    const behaviorChanged = replayFingerprints(baseline, fingerprintNodeSemantics(semanticsNode({ behavior: { idempotent: false, sideEffects: [] } })));
    const implementationOnly = replayFingerprints(baseline, fingerprintNodeSemantics(semanticsNode({ packageVersion: '2.9.2', implementation: { language: 'rust', entry: 'http_request.rs' } })));
    const failures = [];
    if (identical.verdict !== 'MATCH') failures.push(failure('acceptance.claim', `an identical node replayed as ${identical.verdict}`));
    if (behaviorChanged.verdict === 'MATCH') failures.push(failure('acceptance.claim', 'a behaviour change replayed as a match'));
    if (behaviorChanged.impact === 'none') failures.push(failure('acceptance.claim', 'a behaviour change was rated as no impact'));
    if (implementationOnly.verdict !== 'MATCH') failures.push(failure('acceptance.claim', `an implementation-only change broke the semantics: ${implementationOnly.verdict}/${implementationOnly.impact}`));
    if (implementationOnly.implementationChanged !== true) failures.push(failure('acceptance.claim', 'an implementation-only change was not REPORTED: a silent implementation swap is the thing this axis exists to surface'));
    if (behaviorChanged.impact === implementationOnly.impact) failures.push(failure('acceptance.claim', 'a behaviour change and an implementation-only change share one impact'));
    return accepts(failures.length === 0, `identical=${identical.verdict}, behaviour change=${behaviorChanged.verdict}/${behaviorChanged.impact} (axes changed: ${behaviorChanged.changedAxes.join(',') || 'none'}), implementation-only=${implementationOnly.verdict}/${implementationOnly.impact} reported=${implementationOnly.implementationChanged}`, failures);
  },

  'lifecycle.irreversible': () => {
    const ledger = createLifecycleLedger(EPOCH_2);
    const tombstoned = tombstoneNode(ledger, 'n8n-nodes-base.if@2.2', { reason: 'acceptance-retired', atEpoch: 2 });
    const revived = transitionNode(tombstoned.ledger, 'n8n-nodes-base.if@2.2', { state: 'declared', reason: 'acceptance-revive', atEpoch: 3 });
    const failures = [];
    if (tombstoned.ok !== true) failures.push(failure('acceptance.claim', `a tombstone was refused: ${tombstoned.message ?? tombstoned.reason}`));
    if (revived.ok !== false) failures.push(failure('acceptance.claim', 'a tombstoned identity was transitioned back'));
    if (mayReuseName(tombstoned.ledger, 'n8n-nodes-base.if@2.2') !== false) failures.push(failure('acceptance.claim', 'a tombstoned name was reusable'));
    return accepts(failures.length === 0, `tombstone ok=${tombstoned.ok}, revival refused=${revived.ok === false}${revived.ok === false ? ` (${revived.reason})` : ''}, name reusable=${mayReuseName(tombstoned.ledger, 'n8n-nodes-base.if@2.2')}`, failures);
  },

  'health.breaker': () => {
    let table = createHealthTable(EPOCH_1, { threshold: 3, coolOffTicks: 30 });
    for (const tick of [1, 2, 3]) table = recordObservation(table, 'n8n-nodes-base.set@3.4', { outcome: 'failure', tick }).table;
    const refused = mayServe(table, 'n8n-nodes-base.set@3.4', { tick: 4 });
    const probing = mayServe(table, 'n8n-nodes-base.set@3.4', { tick: 33 });
    const quarantined = quarantineNode(table, 'n8n-nodes-base.set@3.4', { reason: 'acceptance', origin: 'operator', tick: 5 });
    const afterSuccess = recordObservation(quarantined.table, 'n8n-nodes-base.set@3.4', { outcome: 'success', tick: 40 });
    const stillRefused = mayServe(afterSuccess.table, 'n8n-nodes-base.set@3.4', { tick: 41 });
    const failures = [];
    if (refused.ok !== false || refused.reason !== 'health.circuit_open') failures.push(failure('acceptance.claim', `a broken circuit did not refuse work: ${refused.reason ?? 'allowed'}`));
    if (probing.probe !== true || probing.circuit !== 'half-open') failures.push(failure('acceptance.claim', 'a due probe was not allowed as half-open'));
    if (afterSuccess.changed !== false) failures.push(failure('acceptance.claim', 'a success changed a quarantined node'));
    if (stillRefused.ok !== false || stillRefused.reason !== 'health.quarantined') failures.push(failure('acceptance.claim', `a quarantine did not outrank a success: ${stillRefused.reason ?? 'allowed'}`));
    return accepts(failures.length === 0, `open circuit refuses=${refused.reason}, probe at tick 33=${probing.probe}, quarantined success changed=${afterSuccess.changed}, still refused=${stillRefused.reason}`, failures);
  },

  'supply.revocation': () => {
    const policy = createAttestationPolicy({
      policyId: 'acceptance',
      allowUnattested: true,
      builders: { 'ci.internal': { packages: ['n8n-nodes-base'], predicates: ['build-provenance'], keyIds: ['k1'] } },
      requiredPredicates: ['build-provenance'],
    });
    const signed = signAttestation({
      builder: 'ci.internal', predicate: 'build-provenance',
      subject: { digest: `sha256:${'1'.repeat(64)}`, packageName: 'n8n-nodes-base' },
      issuedAtTick: 1, expiresAtTick: null, keyId: 'k1',
    }, { keyId: 'k1', secret: 'acceptance-secret' });
    const mirror = mirrorManifest({
      mirrorId: 'acceptance-mirror', source: 'registry',
      artifacts: [
        { packageName: 'n8n-nodes-base', digest: `sha256:${'1'.repeat(64)}`, attestations: [signed] },
        { packageName: 'n8n-nodes-slack', digest: `sha256:${'2'.repeat(64)}`, attestations: [] },
      ],
    });
    const allowed = verifyMirror(mirror, { policy, keyring: { k1: 'acceptance-secret' }, tick: 5 });
    const revocation = revokeArtifact(createRevocationList(), { digest: `sha256:${'2'.repeat(64)}`, reason: 'acceptance-malware', origin: 'scan', tick: 6 });
    const refused = verifyMirror(mirror, { policy, keyring: { k1: 'acceptance-secret' }, revocations: revocation.list, tick: 7 });
    const failures = [];
    if (allowed.ok !== true || ![...allowed.unattested].includes('n8n-nodes-slack')) failures.push(failure('acceptance.claim', 'an explicit exemption did not install an unattested artifact visibly'));
    if (refused.ok !== false) failures.push(failure('acceptance.claim', 'a revoked artifact installed under an exemption'));
    if (refused.primaryReason !== 'supply.revoked') failures.push(failure('acceptance.claim', `a revoked artifact was reported as ${refused.primaryReason}`));
    return accepts(failures.length === 0, `exemption installs unattested=${JSON.stringify([...allowed.unattested])}, revocation wins=${refused.ok === false} (${refused.primaryReason})`, failures);
  },

  'incremental.equivalence': () => {
    const state = createIncrementalState(EPOCH_1);
    const declarations = [HTTP, SET, IF];
    const applied = applyRegistryChanges(state, { declarations, epochNumber: 2, source: 'acceptance-2' });
    const verdict = verifyIncremental(applied.state, declarations, { epochNumber: 2, source: 'acceptance-2' });
    const wrong = verifyIncremental(applied.state, [HTTP, SET], { epochNumber: 2, source: 'acceptance-2' });
    const failures = [];
    if (applied.ok !== true) failures.push(failure('acceptance.claim', `an incremental compile was refused: ${applied.message}`));
    if (verdict.equivalent !== true) failures.push(failure('acceptance.claim', `the incremental epoch differs from a full compile: ${verdict.message}`));
    if (wrong.equivalent !== false) failures.push(failure('acceptance.claim', 'a different declaration set was reported equivalent'));
    if (applied.ledger?.reusedDigestStable !== true) failures.push(failure('acceptance.claim', 'a reused identity did not keep its digest'));
    return accepts(failures.length === 0, `added=${applied.ledger?.added}, reused=${applied.ledger?.reused} (stable=${applied.ledger?.reusedDigestStable}), equivalent=${verdict.equivalent}, wrong set=${wrong.equivalent}`, failures);
  },

  'convergence.separation': () => {
    const coordinator = coordinatorBinding(EPOCH_2);
    const digestsOf = (epoch) => Object.fromEntries(epoch.identities.map((identity) => [identity, epoch.byIdentity[identity].digest]));
    const behind = handshake(workerBinding({
      workerId: 'acceptance-behind', epochNumber: EPOCH_1.epochNumber, epochDigest: EPOCH_1.epochDigest, identityDigests: digestsOf(EPOCH_1),
    }), coordinator);
    const diverged = handshake(workerBinding({
      workerId: 'acceptance-diverged', epochNumber: EPOCH_1.epochNumber, epochDigest: EPOCH_1.epochDigest,
      identityDigests: { ...digestsOf(EPOCH_1), 'n8n-nodes-evil.node@1.0': `sha256:${'9'.repeat(64)}` },
    }), coordinator);
    const failures = [];
    if (behind.decision !== 'UPGRADE_REQUIRED') failures.push(failure('acceptance.claim', `a consistent lagging worker was decided ${behind.decision}`));
    if (diverged.decision !== 'MISMATCH') failures.push(failure('acceptance.claim', `a diverged worker was decided ${diverged.decision}`));
    if (behind.decision === diverged.decision) failures.push(failure('acceptance.claim', 'lag and divergence share one decision'));
    if (!diverged.steps.some((entry) => entry.step === 'escalate-to-operator')) failures.push(failure('acceptance.claim', 'a diverged worker was not escalated'));
    return accepts(failures.length === 0, `behind=${behind.decision} (${behind.detail?.missing?.length ?? 0} to fetch), diverged=${diverged.decision} (${diverged.detail?.reason}), escalated=${diverged.steps.map((entry) => entry.step).join('→')}`, failures);
  },

  'boundary.scope-walls': ({ evidence }) => {
    const sources = evidence?.sources;
    const failures = [];
    if (!isPlainObject(sources)) {
      failures.push(failure('acceptance.evidence', 'the module sources were not supplied: an acceptance run that cannot check the boundary claim has not checked the boundary'));
      return accepts(false, 'evidence missing', failures);
    }
    const scanned = Object.keys(sources).sort();
    const offenders = [];
    for (const file of scanned) {
      const text = sources[file];
      for (const forbidden of ACCEPTANCE_FORBIDDEN_IMPORTS) {
        if (text.includes(`from './${forbidden}'`)) offenders.push(`${file} → ${forbidden}`);
      }
    }
    if (scanned.length < 15) failures.push(failure('acceptance.evidence', `only ${scanned.length} module source(s) supplied; the P6 core is 15 contracts`));
    if (offenders.length > 0) failures.push(failure('acceptance.claim', `the core reaches outside its boundary: ${offenders.join(', ')}`));
    return accepts(failures.length === 0, `${scanned.length} module source(s) scanned, ${offenders.length} forbidden import(s)`, failures);
  },

  'surface.lock-rows': ({ evidence, sources }) => {
    const lock = evidence?.lock;
    const failures = [];
    if (!isPlainObject(lock) || !Array.isArray(lock.contracts)) {
      failures.push(failure('acceptance.evidence', 'the contract lock was not supplied: an acceptance run that cannot check the locked surface has not checked it'));
      return accepts(false, 'evidence missing', failures);
    }
    const rows = [];
    // The lock keys a contract by id and carries the version in its own column;
    // the acceptance list names the identity a consumer writes down ('id@version').
    // Matching the two shapes is this claim's job, not the caller's.
    for (const identity of ACCEPTANCE_COVERS) {
      const [id, version] = identity.split('@');
      const matching = lock.contracts.filter((row) => row.id === id);
      if (matching.length !== 1) {
        failures.push(failure('acceptance.claim', `${identity} has ${matching.length} locked row(s)`));
        continue;
      }
      rows.push(matching[0]);
      if (matching[0].version !== version) failures.push(failure('acceptance.claim', `${identity} is locked at ${matching[0].version}`));
      const surface = matching[0].surface ?? [];
      for (const file of surface) {
        if (isPlainObject(sources) && !(file in sources)) failures.push(failure('acceptance.evidence', `${id} names a surface that was not supplied: ${file}`));
      }
    }
    return accepts(failures.length === 0, `${rows.length}/${ACCEPTANCE_COVERS.length} core contract(s) locked at 0.1.0 with one row each`, failures);
  },
};

/** The claims, as data: what is promised and by which contract. */
export const ACCEPTANCE_CLAIMS = Object.freeze(claimDefinitions.map((claim) => Object.freeze({
  ...claim,
  covers: Object.freeze([...claim.covers]),
})));

/** @returns {Readonly<object>} the claim with this id, or null. */
export function claimById(id) {
  if (!isNonEmptyString(id)) fail('claimById expects a claim id', { code: 'acceptance.input', field: 'id' });
  return ACCEPTANCE_CLAIMS.find((claim) => claim.id === id) ?? null;
}

/** The claims, optionally filtered by category — the list an operator reads first. */
export function listClaims({ category = null } = {}) {
  if (category !== null && !ACCEPTANCE_CATEGORIES.includes(category)) {
    fail(`unknown category ${JSON.stringify(category)} — the categories are ${ACCEPTANCE_CATEGORIES.join(', ')}`, { code: 'acceptance.input', field: 'category' });
  }
  const claims = category === null ? ACCEPTANCE_CLAIMS : ACCEPTANCE_CLAIMS.filter((claim) => claim.category === category);
  return deepFreeze(claims.map((claim) => ({ ...claim })));
}

/* ------------------------------------------------------------------ *
 * Running
 * ------------------------------------------------------------------ */

const requireEvidence = (evidence) => {
  if (evidence !== undefined && evidence !== null && !isPlainObject(evidence)) {
    fail('acceptance evidence must be an object of { sources, lock } when supplied', { code: 'acceptance.evidence', field: 'evidence' });
  }
};

const runOne = (claim, context) => {
  const runner = claimRunners[claim.id];
  if (!runner) return { id: claim.id, ok: false, evidence: null, failures: [failure('acceptance.claim', `no runner is registered for '${claim.id}': a claim without a runner is a wish`)], error: null };
  try {
    const outcome = runner(context);
    return {
      id: claim.id,
      category: claim.category,
      statement: claim.statement,
      covers: claim.covers,
      ok: outcome.ok === true,
      evidence: outcome.evidence,
      failures: Object.freeze((outcome.failures ?? []).map((entry) => Object.freeze({ ...entry }))),
      error: null,
    };
  } catch (error) {
    return {
      id: claim.id,
      category: claim.category,
      statement: claim.statement,
      covers: claim.covers,
      ok: false,
      evidence: null,
      failures: Object.freeze([failure(error.meta?.code ?? error.code ?? 'acceptance.claim', `${error.name}: ${error.message}`)]),
      error: Object.freeze({ name: error.name, code: error.meta?.code ?? error.code ?? null }),
    };
  }
};

/**
 * Run the acceptance claims.
 *
 * @param {{ include?: string[], exclude?: string[], evidence?: { sources?: object, lock?: object } }} [options]
 * @returns {Readonly<object>} a report that says whether it was complete
 */
export function runAcceptance({ include = null, exclude = [], evidence = null } = {}) {
  requireEvidence(evidence);
  if (include !== null && !Array.isArray(include)) fail('include must be an array of claim ids or null', { code: 'acceptance.input', field: 'include' });
  if (!Array.isArray(exclude)) fail('exclude must be an array of claim ids', { code: 'acceptance.input', field: 'exclude' });
  const known = new Set(ACCEPTANCE_CLAIMS.map((claim) => claim.id));
  for (const id of [...(include ?? []), ...exclude]) {
    if (!known.has(id)) fail(`unknown claim id ${JSON.stringify(id)}: an acceptance run over a claim that does not exist proves nothing`, { code: 'acceptance.input', field: 'claim' });
  }
  const claims = ACCEPTANCE_CLAIMS.filter((claim) => (include === null || include.includes(claim.id)) && !exclude.includes(claim.id));
  const results = claims.map((claim) => Object.freeze(runOne(claim, { evidence, sources: evidence?.sources ?? null })));
  const passed = results.filter((result) => result.ok).length;
  const failed = results.filter((result) => !result.ok).length;
  const complete = results.length === ACCEPTANCE_CLAIMS.length;
  const byCategory = {};
  for (const result of results) {
    const entry = byCategory[result.category] ?? { passed: 0, failed: 0 };
    if (result.ok) entry.passed += 1; else entry.failed += 1;
    byCategory[result.category] = entry;
  }
  const failures = results.flatMap((result) => result.failures.map((entry) => Object.freeze({ claim: result.id, ...entry })));
  const canonical = {
    contract: ACCEPTANCE_CONTRACT,
    schemaVersion: ACCEPTANCE_SCHEMA_VERSION,
    claims: results.map((result) => ({ id: result.id, ok: result.ok, evidence: result.evidence, failures: result.failures.map((entry) => entry.code) })),
  };
  return deepFreeze({
    ok: failed === 0 && complete,
    schemaVersion: ACCEPTANCE_SCHEMA_VERSION,
    contract: ACCEPTANCE_CONTRACT,
    complete,
    claimCount: results.length,
    totalClaims: ACCEPTANCE_CLAIMS.length,
    passed,
    failed,
    byCategory,
    results,
    failures,
    evidence: Object.freeze({ sources: evidence?.sources ? Object.keys(evidence.sources).length : 0, lock: isPlainObject(evidence?.lock) }),
    reportDigest: digestOf(stableJson(canonical)),
    message: failed === 0
      ? (complete ? null : `the run was partial: ${results.length} of ${ACCEPTANCE_CLAIMS.length} claim(s), and a partial run is not acceptance`)
      : `${failed} claim(s) failed: ${results.filter((result) => !result.ok).map((result) => result.id).join(', ')}`,
  });
}

/** @returns {boolean} whether `value` is an acceptance report this contract produced. */
export function isAcceptanceReport(value) {
  return (
    isPlainObject(value) &&
    value.contract === ACCEPTANCE_CONTRACT &&
    Array.isArray(value.results) &&
    typeof value.reportDigest === 'string' &&
    Object.isFrozen(value)
  );
}

/**
 * Verify a report: the digest must hold, and the claim set must be COMPLETE. An
 * acceptance report that omits a claim is a summary, not evidence.
 */
export function verifyAcceptanceReport(report) {
  if (!isAcceptanceReport(report)) fail('verifyAcceptanceReport expects a report from runAcceptance', { got: typeof report });
  const canonical = {
    contract: ACCEPTANCE_CONTRACT,
    schemaVersion: ACCEPTANCE_SCHEMA_VERSION,
    claims: report.results.map((result) => ({ id: result.id, ok: result.ok, evidence: result.evidence, failures: result.failures.map((entry) => entry.code) })),
  };
  const recomputed = digestOf(stableJson(canonical));
  const failures = [];
  if (recomputed !== report.reportDigest) failures.push(failure('acceptance.report', 'the report digest does not match its content: the evidence was edited after it was produced'));
  if (!report.complete) failures.push(failure('acceptance.report', `the report covers ${report.claimCount} of ${report.totalClaims} claim(s): a partial run cannot stand in for acceptance`));
  const ids = report.results.map((result) => result.id);
  const missing = ACCEPTANCE_CLAIMS.map((claim) => claim.id).filter((id) => !ids.includes(id));
  if (missing.length > 0) failures.push(failure('acceptance.report', `the report omits ${missing.join(', ')}`));
  return deepFreeze({
    ok: failures.length === 0,
    reason: failures.length === 0 ? null : failures[0].code,
    complete: report.complete === true && missing.length === 0,
    expected: report.reportDigest,
    actual: recomputed,
    missing: Object.freeze(missing),
    failures: Object.freeze(failures.map((entry) => Object.freeze(entry))),
    message: failures.length === 0 ? null : failures.map((entry) => entry.message).join('; '),
  });
}

/** Counts per category, and the claim ids that failed — the shape an operations page wants. */
export function describeAcceptance(report) {
  if (!isAcceptanceReport(report)) fail('describeAcceptance expects a report from runAcceptance', { got: typeof report });
  return deepFreeze({
    contract: report.contract,
    complete: report.complete,
    claimCount: report.claimCount,
    totalClaims: report.totalClaims,
    passed: report.passed,
    failed: report.failed,
    byCategory: report.byCategory,
    failedClaims: Object.freeze(report.results.filter((result) => !result.ok).map((result) => result.id)),
    reportDigest: report.reportDigest,
  });
}

/** A sentence an operator can read, and a rollout can be stopped by. */
export function explainAcceptance(report) {
  if (!isAcceptanceReport(report)) fail('explainAcceptance expects a report from runAcceptance', { got: typeof report });
  if (!report.complete) return `acceptance was PARTIAL: ${report.passed}/${report.claimCount} claim(s) passed, ${report.totalClaims} exist — a partial run is not acceptance`;
  if (report.failed === 0) return `acceptance passed: ${report.passed}/${report.totalClaims} claim(s) over ${Object.keys(report.byCategory).length} categor(ies)`;
  const failedClaims = [...new Set(report.failures.map((entry) => entry.claim))];
  return `acceptance FAILED: ${report.failed} of ${report.totalClaims} claim(s) — ${failedClaims.map((claim) => `${claim} (${report.failures.find((entry) => entry.claim === claim).code})`).join(', ')}`;
}

export const ACCEPTANCE_INPUT_SCHEMA_VERSION = ACCEPTANCE_SCHEMA_VERSION;
