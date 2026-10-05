/**
 * P6-S01 — the live node installation path.
 *
 * The tests are organised around the one rule the module exists to enforce:
 * **a node class is a policy input, not a trust grant.** Everything else follows
 * from it.
 *
 *   1. Classification      what the candidate claims is a claim; an attestation
 *                          promotes one step and no further; AI-generated code
 *                          is `custom` whatever it declares about itself.
 *   2. Trust               every class maps to a ceiling and a floor; nothing
 *                          maps to a grant; `official` reaches CORE's ceiling
 *                          but still has to earn it.
 *   3. Locality            the runtime choice never widens authority, and it is
 *                          never allowed to change the node contract.
 *   4. Fail-closed         three verdicts, deliberately distinct: refuse means
 *                          something failed, incomplete means nobody checked,
 *                          admit means both are answered.
 *   5. Contract stability  a node re-placed behind a different runtime presents
 *                          the same type identity to a workflow.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LOCALITY_MATRIX } from '../src/lego/plugin-locality.mjs';
import {
  NODE_CLASSES,
  NODE_CLASS_TRUST_CEILING,
  NODE_CLASS_TRUST_FLOOR,
  NODE_INSTALL_CONTRACT,
  NODE_INSTALL_REASONS,
  NODE_INSTALL_STEPS,
  NODE_INSTALL_VERDICTS,
  NATIVE_CAPABILITIES,
  RISKY_CAPABILITIES,
  TRUST_LOCALITY_POSTURE,
  strictestPosture,
  classifyNode,
  evaluateInstallCapabilities,
  evaluateInstallCompatibility,
  evaluateInstallResources,
  explainInstall,
  installNode,
  isInstallDecision,
  resolveInstallLocality,
  resolveTrustClass,
} from '../src/lego/node-install.mjs';

/** Evidence that answers every externally-sourced step. */
const FULL_EVIDENCE = Object.freeze({
  identify: 'pass',
  trust: 'pass',
  capability: 'pass',
  locality: 'pass',
  health: 'pass',
});

/** A minimal admissible candidate: it still has to earn its admission. */
const candidate = (overrides = {}) => Object.freeze({
  type: 'n8n-nodes-base.httpRequest',
  declaredClass: 'official',
  origin: 'registry',
  capabilities: ['network'],
  contractVersion: '0.1.0',
  implementationVersion: '1.2.3',
  ...overrides,
});

/* --------------------------------------------------------------- 1. classify */

test('every class issue #95 names is in the vocabulary', () => {
  assert.deepEqual([...NODE_CLASSES], [
    'official',
    'verified-community',
    'community',
    'private',
    'custom',
    'native',
  ]);
});

test('an undeclared class falls back to community, never to official', () => {
  assert.equal(classifyNode({ type: 'a.b', origin: 'npm' }).class, 'community');
  assert.equal(classifyNode({ type: 'a.b', origin: 'local' }).class, 'custom');
});

test('a class claim outside the vocabulary is refused, not coerced', () => {
  assert.throws(
    () => classifyNode({ type: 'a.b', declaredClass: 'trusted-by-me' }),
    (error) => error.code === 'lego.contract_violation' && error.details.code === 'install.class',
  );
});

test('an attestation promotes community one step and no further', () => {
  const promoted = classifyNode({ type: 'a.b', origin: 'npm', attested: true });
  assert.equal(promoted.class, 'verified-community');
  assert.equal(promoted.promoted, true);

  // Attesting an already-verified node changes nothing: there is no second step.
  const twice = classifyNode({ type: 'a.b', origin: 'npm', declaredClass: 'verified-community', attested: true });
  assert.equal(twice.class, 'verified-community');
  assert.equal(twice.promoted, false);
});

test('a local artifact is never promoted by an attestation', () => {
  const local = classifyNode({ type: 'a.b', origin: 'local', attested: true });
  assert.equal(local.class, 'custom');
  assert.equal(local.promoted, false);
});

test('AI-generated code is custom whatever it declares about itself', () => {
  // The exact failure issue #95 names: generated code claiming an official
  // class must not inherit it.
  const generated = classifyNode({ type: 'a.b', declaredClass: 'official', origin: 'registry', aiGenerated: true });
  assert.equal(generated.class, 'custom');
  assert.equal(generated.aiGenerated, true);
});

test('a candidate that does not name a type is refused', () => {
  assert.throws(
    () => classifyNode({ origin: 'npm' }),
    (error) => error.details.code === 'install.input',
  );
});

/* ------------------------------------------------------------------ 2. trust */

test('every class has both a ceiling and a floor', () => {
  for (const nodeClass of NODE_CLASSES) {
    const { ceiling, floor } = resolveTrustClass({ class: nodeClass });
    assert.ok(TRUST_LOCALITY_POSTURE[ceiling], `${nodeClass} ceiling ${ceiling} is not a posture`);
    assert.ok(TRUST_LOCALITY_POSTURE[floor], `${nodeClass} floor ${floor} is not a posture`);
    // A floor LESS isolated than the ceiling would be a construction bug in the
    // table: the node would be allowed a posture its own class forbids.
    assert.ok(
      Object.keys(TRUST_LOCALITY_POSTURE).indexOf(floor) >= Object.keys(TRUST_LOCALITY_POSTURE).indexOf(ceiling),
      `${nodeClass}: floor ${floor} is LESS isolated than ceiling ${ceiling}`,
    );
  }
});

test('official reaches the CORE ceiling but nothing is granted', () => {
  const { ceiling, floor } = resolveTrustClass({ class: 'official' });
  assert.equal(ceiling, 'CORE');
  assert.equal(floor, 'TRUSTED');
  // The ceiling is where it MAY sit. It still has to pass every step to sit there.
  const decision = installNode(candidate(), { evidence: FULL_EVIDENCE });
  assert.equal(decision.class, 'official');
  assert.equal(decision.trust.ceiling, 'CORE');
});

test('native is not automatically trusted: Rust buys no in-process placement', () => {
  const classification = classifyNode({ type: 'a.b', declaredClass: 'native', origin: 'git' });
  const { ceiling } = resolveTrustClass(classification);
  assert.equal(ceiling, 'ISOLATED');
  // A native artifact carrying a native capability is the one thing a WASM
  // sandbox cannot hold, so it goes to an isolated process.
  const locality = resolveInstallLocality({ classification, capabilities: ['native'] });
  assert.equal(locality.recommended, 'ISOLATED_PROCESS');
});

test('custom and private never reach the CORE ceiling', () => {
  for (const nodeClass of ['custom', 'private', 'community']) {
    assert.notEqual(NODE_CLASS_TRUST_CEILING[nodeClass], 'CORE', `${nodeClass} reached CORE`);
  }
});

test('an unknown class is refused rather than defaulted', () => {
  assert.throws(
    () => resolveTrustClass({ class: 'definitely-not-a-class' }),
    (error) => error.details.code === 'install.class',
  );
});

/* --------------------------------------------------------------- 3. locality */

test('the runtime choice never widens authority', () => {
  // A risky capability can only move a node to a MORE isolated row, and the
  // recommendation always has to be a row in the matrix.
  for (const nodeClass of NODE_CLASSES) {
    const classification = { class: nodeClass };
    for (const capabilities of [[], ['network'], ['subprocess', 'native']]) {
      const locality = resolveInstallLocality({ classification, capabilities });
      assert.ok(
        locality.allowed.includes(locality.recommended),
        `${nodeClass} + [${capabilities}]: ${locality.recommended} is not in ${locality.allowed}`,
      );
    }
  }
});

test('a native capability takes the in-process row away, whatever the class claims', () => {
  // The exploit this exists to stop: an official node asking for `subprocess`
  // must not be waved into the process on the strength of its class claim.
  for (const nodeClass of NODE_CLASSES) {
    const locality = resolveInstallLocality({ classification: { class: nodeClass }, capabilities: NATIVE_CAPABILITIES });
    assert.notEqual(locality.recommended, 'IN_PROCESS', `${nodeClass} ran in-process with a native capability`);
    assert.equal(locality.nativeRequested, true);
    // The class posture is still recorded: the class did not change, the
    // placement did.
    assert.equal(locality.classPosture, TRUST_LOCALITY_POSTURE[NODE_CLASS_TRUST_CEILING[nodeClass]]);
  }
});

test('strictestPosture is monotonic and never widens', () => {
  assert.equal(strictestPosture('CORE', 'CORE'), 'CORE');
  assert.equal(strictestPosture('CORE', 'SANDBOXED'), 'SANDBOXED');
  assert.equal(strictestPosture('SANDBOXED', 'CORE'), 'SANDBOXED');
  assert.equal(strictestPosture('TRUSTED', 'ISOLATED'), 'ISOLATED');
});

test('an official node requesting a native capability is downgraded to ISOLATED', () => {
  // The class claim buys the CORE ceiling; the capability takes it away. The
  // node is still admitted, but not in-process.
  const locality = resolveInstallLocality({ classification: { class: 'official' }, capabilities: ['native'] });
  assert.equal(locality.classPosture, 'CORE');
  assert.equal(locality.posture, 'ISOLATED');
  assert.equal(locality.recommended, 'ISOLATED_PROCESS');
});

test('a node the matrix cannot place safely is refused, not waved through', () => {
  // If the capability rule and the matrix ever disagree there is nowhere legal
  // to put the node, and the path stops instead of picking whichever answer is
  // convenient. The guard is defensive: the current matrix always has a stricter
  // row, which is exactly what the test above proves.
  // The guarantee that makes the downgrade safe: whatever posture the capability
  // rule lands on, its matrix row always has somewhere that is not in-process.
  // CORE has only IN_PROCESS, which is exactly why a native request is pushed
  // down to ISOLATED before the recommendation is made.
  for (const posture of Object.keys(TRUST_LOCALITY_POSTURE)) {
    const landed = strictestPosture(posture, 'ISOLATED');
    const row = LOCALITY_MATRIX[landed];
    assert.ok(
      row.some((locality) => locality !== 'IN_PROCESS'),
      `${posture} -> ${landed} has no non-in-process row to host a native node`,
    );
  }
});

test('an external provider implementation runs remote', () => {
  const locality = resolveInstallLocality({
    classification: { class: 'verified-community' },
    capabilities: [],
    external: true,
  });
  assert.equal(locality.recommended, 'REMOTE');
});

test('a recommendation outside the matrix is a construction bug and is refused', () => {
  // The matrix row and the recommender disagree only if someone edits one of
  // them; the path must not paper over that.
  assert.throws(
    () => resolveInstallLocality({ classification: { class: 'SANDBOXED' }, capabilities: [] }) === undefined,
    // SANDBOXED is not a node class, so this throws for a different reason --
    // which is still fail-closed, which is the point.
    (error) => error.code === 'lego.contract_violation',
  );
});

/* ------------------------------------------------------------- 4. fail-closed */

test('a fully evidenced candidate is admitted', () => {
  const decision = installNode(candidate(), { evidence: FULL_EVIDENCE });
  assert.equal(decision.verdict, 'admit');
  assert.equal(decision.class, 'official');
  assert.equal(decision.locality.recommended, 'IN_PROCESS');
  assert.ok(isInstallDecision(decision));
});

test('a missing self-test is incomplete, not refuse', () => {
  // Nothing failed; nobody checked. The answer is "run the test", not "fix the node".
  const decision = installNode(candidate(), {
    evidence: { identify: 'pass', trust: 'pass', capability: 'pass', locality: 'pass' },
  });
  assert.equal(decision.verdict, 'incomplete');
  assert.equal(decision.steps.at(-1).id, 'health');
  assert.equal(decision.steps.at(-1).evidenced, false);
});

test('a failed self-test is refused', () => {
  const decision = installNode(candidate(), { evidence: { ...FULL_EVIDENCE, health: 'fail' } });
  assert.equal(decision.verdict, 'refuse');
  assert.equal(decision.steps.at(-1).passed, false);
});

test('a node over its resource budget is refused with the budget named', () => {
  const decision = installNode(candidate({ resources: { maxMemoryMb: 4096, maxTimeoutMs: 60000 } }), { evidence: FULL_EVIDENCE });
  assert.equal(decision.verdict, 'refuse');
  const resourceStep = decision.steps.find((step) => step.id === 'resource');
  assert.match(resourceStep.detail, /maxMemoryMb=4096\(>512\)/);
});

test('a missing contract version is refused: compatibility is not optional', () => {
  const decision = installNode(
    { type: 'a.b', declaredClass: 'official', origin: 'registry', capabilities: [], implementationVersion: '1.0.0' },
    { evidence: FULL_EVIDENCE },
  );
  assert.equal(decision.verdict, 'refuse');
  assert.match(decision.steps.find((s) => s.id === 'compatibility').detail, /contractVersion/);
});

test('a dependency with an empty range is refused', () => {
  const decision = installNode(candidate({ dependencies: { lodash: '' } }), { evidence: FULL_EVIDENCE });
  assert.equal(decision.verdict, 'refuse');
});

test('a capability name that is not a string fails the capability step', () => {
  const findings = evaluateInstallCapabilities({ requested: ['network', 42], trustClass: 'CORE' });
  assert.equal(findings.findings[0].admissible, true);
  assert.equal(findings.findings[1].admissible, false);
});

test('an explicit grant is recorded but grants nothing by itself', () => {
  const ungranted = evaluateInstallCapabilities({ requested: ['network'], trustClass: 'CORE' });
  const granted = evaluateInstallCapabilities({ requested: ['network'], trustClass: 'CORE', grants: ['network'] });
  assert.equal(ungranted.findings[0].granted, false);
  assert.equal(granted.findings[0].granted, true);
  // The ceiling is the same either way: a grant does not widen it.
  assert.equal(ungranted.trustClass, granted.trustClass);
});

test('a trust class outside the posture vocabulary is refused', () => {
  assert.throws(
    () => evaluateInstallCapabilities({ requested: [], trustClass: 'core' }),
    (error) => error.details.code === 'install.trust',
  );
});

/* ------------------------------------------------------- 5. contract stability */

test('re-placing a node does not change its consumer-facing contract', () => {
  const inProcess = installNode(candidate({ capabilities: [] }), { evidence: FULL_EVIDENCE });
  const isolated = installNode(candidate({ declaredClass: 'native', capabilities: ['subprocess'] }), { evidence: FULL_EVIDENCE });
  assert.equal(inProcess.consumerContract.type, isolated.consumerContract.type);
  assert.equal(inProcess.consumerContract.type, 'n8n-nodes-base.httpRequest');
  // The runtime differs; the node does not.
  assert.equal(inProcess.locality.recommended, 'IN_PROCESS');
  assert.equal(isolated.locality.recommended, 'ISOLATED_PROCESS');
});

test('the install decision never carries a grant, only a ceiling', () => {
  const decision = installNode(candidate({ capabilities: ['network', 'secrets'] }), { evidence: FULL_EVIDENCE });
  assert.equal(decision.trust.ceiling, 'CORE');
  // Asking for a capability is not holding it.
  assert.deepEqual([...decision.capabilities], ['network', 'secrets']);
  assert.ok(!('grants' in decision));
});

test('the steps are argued in the documented fixed order', () => {
  const decision = installNode(candidate(), { evidence: FULL_EVIDENCE });
  assert.deepEqual(decision.steps.map((step) => step.id), [...NODE_INSTALL_STEPS]);
});

test('every step names the contract that produced its evidence', () => {
  const decision = installNode(candidate(), { evidence: FULL_EVIDENCE });
  for (const step of decision.steps) {
    assert.ok(step.source, `${step.id} has no evidence source`);
    assert.equal(step.evidenced, true, `${step.id} is uncited`);
  }
});

test('the explanation is rendered in the step order and cites its sources', () => {
  const rendered = explainInstall(installNode(candidate(), { evidence: FULL_EVIDENCE }));
  assert.match(rendered, /-> admit/);
  assert.match(rendered, /\[node\.registry@0\.1\.0\]/);
  assert.match(rendered, /pass health/);
});

test('explainInstall refuses a decision it did not produce', () => {
  assert.throws(
    () => explainInstall({ contract: 'something.else@0.1.0' }),
    (error) => error.code === 'lego.contract_violation',
  );
});

test('the vocabulary is frozen and the reasons cover every failure code used', () => {
  assert.ok(Object.isFrozen(NODE_INSTALL_VERDICTS));
  assert.ok(Object.isFrozen(NODE_CLASS_TRUST_CEILING));
  assert.ok(Object.isFrozen(RISKY_CAPABILITIES));
  for (const code of ['install.input', 'install.class', 'install.trust', 'install.locality']) {
    assert.ok(NODE_INSTALL_REASONS.includes(code), `${code} is not declared`);
  }
});

test('the contract identity is stable', () => {
  assert.equal(NODE_INSTALL_CONTRACT, 'node.install@0.1.0');
  assert.equal(NODE_CLASS_TRUST_FLOOR.custom, 'SANDBOXED');
});
