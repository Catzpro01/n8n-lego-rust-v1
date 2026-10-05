/**
 * P6.12 — Supply-chain attestation, revocation, offline mirror.
 * Contract `node.supply-chain@0.1.0`.
 *
 * Matrix: the statement/ signature / subject binding, the policy as data, the two
 * failures staying separate answers, the one-way revocation door (including the
 * subject check that an exemption cannot outrank), the air-gapped mirror verified
 * with the same policy, and the scope walls.
 *
 * Nothing here reaches a network or a disk: a mirror is DATA a caller copied onto
 * a disk, which is what makes an offline import testable.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  ATTESTATION_PREDICATES,
  REVOCATION_ORIGINS,
  REVOCATION_TARGETS,
  SUPPLY_CHAIN_CONTRACT,
  SUPPLY_CHAIN_CONTRACT_VERSION,
  SUPPLY_CHAIN_INPUT_SCHEMA_VERSION,
  SUPPLY_CHAIN_OPERATIONS,
  SUPPLY_CHAIN_PERMISSIONS,
  SUPPLY_CHAIN_REASONS,
  SUPPLY_CHAIN_RULES,
  SUPPLY_CHAIN_SCHEMA_VERSION,
  SUPPLY_REASON_PRIORITY,
  SupplyChainError,
  createAttestationPolicy,
  createRevocationList,
  describeSupplyChain,
  explainSupplyVerdict,
  isAttestationPolicy,
  isBuilderRevoked,
  isMirrorManifest,
  isRevocationList,
  isRevoked,
  mayBuilderAttest,
  mirrorManifest,
  primarySupplyReason,
  revocationReason,
  revokeArtifact,
  revokeBuilder,
  signAttestation,
  statementPayload,
  verifyAttestation,
  verifyAttestations,
  verifyMirror,
} from '../src/lego/supply-chain.mjs';

/* ------------------------------------------------------------------ fixtures */

const D1 = `sha256:${'1'.repeat(64)}`;
const D2 = `sha256:${'2'.repeat(64)}`;
const KEY = 'builder-key-1';
const SECRET = 'correct horse battery staple';
const KEY2 = 'builder-key-2';
const SECRET2 = 'another secret entirely';

const policy = createAttestationPolicy({
  policyId: 'registry-default',
  builders: {
    'ci.internal': { packages: ['n8n-nodes-base'], predicates: ['build-provenance', 'reproducible-build'], keyIds: [KEY] },
    'vendor.n8n': { packages: ['*'], predicates: ['build-provenance', 'source-review', 'ai-generation'] },
    'scanner.internal': { packages: ['*'], predicates: ['vulnerability-scan'] },
  },
  requiredPredicates: ['build-provenance'],
});
const keyring = Object.freeze({ [KEY]: SECRET, [KEY2]: SECRET2 });

const statement = (overrides = {}) => ({
  builder: 'ci.internal',
  predicate: 'build-provenance',
  subject: { digest: D1, packageName: 'n8n-nodes-base' },
  issuedAtTick: 100,
  expiresAtTick: 500,
  keyId: KEY,
  ...overrides,
});
const signed = (overrides = {}, key = { keyId: KEY, secret: SECRET }) => signAttestation(statement(overrides), key);
const scan = () => signed({ builder: 'scanner.internal', predicate: 'vulnerability-scan' }, { keyId: KEY2, secret: SECRET2 });

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

/* ---------------------------------------------------------- contract surface */

test('the contract identifies itself, is versioned and declares its operations', () => {
  assert.equal(SUPPLY_CHAIN_CONTRACT, 'node.supply-chain@0.1.0');
  assert.equal(SUPPLY_CHAIN_CONTRACT_VERSION, '0.1.0');
  assert.equal(SUPPLY_CHAIN_SCHEMA_VERSION, 1);
  assert.equal(SUPPLY_CHAIN_INPUT_SCHEMA_VERSION, 1);
  assert.deepEqual([...SUPPLY_CHAIN_OPERATIONS], ['attest', 'verify', 'revoke', 'mirror', 'describe']);
  assert.deepEqual([...SUPPLY_CHAIN_PERMISSIONS], ['node:read']);
  assert.deepEqual([...REVOCATION_TARGETS], ['artifact', 'builder']);
  assert.deepEqual([...REVOCATION_ORIGINS], ['operator', 'vendor', 'scan', 'policy']);
  assert.deepEqual([...ATTESTATION_PREDICATES], ['build-provenance', 'source-review', 'vulnerability-scan', 'reproducible-build', 'ai-generation']);
  assert.equal(SUPPLY_REASON_PRIORITY[0], 'supply.revoked');
  assert.equal(primarySupplyReason(['supply.predicate', 'supply.revoked']), 'supply.revoked');
  assert.equal(primarySupplyReason([]), null);
  throwsWith(() => primarySupplyReason('supply.revoked'), 'supply.input');
  for (const reason of SUPPLY_CHAIN_REASONS) assert.match(reason, /^supply\.[a-z_]+$/);
  assert.equal(Object.isFrozen(SUPPLY_CHAIN_RULES), true);
  assert.match(SUPPLY_CHAIN_RULES.authority, /never grants trust/);
  assert.match(SUPPLY_CHAIN_RULES.revocation, /one-way door/);
});

/* -------------------------------------------------------------------- policy */

test('a policy is data: which builders may attest which packages and predicates', () => {
  assert.equal(isAttestationPolicy(policy), true);
  assert.equal(policy.policyId, 'registry-default');
  assert.deepEqual([...policy.requiredPredicates], ['build-provenance']);
  assert.equal(policy.allowUnattested, false, 'the default is fail-closed');
  assert.match(policy.policyDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(Object.isFrozen(policy.builders['ci.internal'].packages), true);
  assert.deepEqual([...policy.builders['vendor.n8n'].packages], ['*']);
  assert.equal(createAttestationPolicy({
    policyId: 'registry-default',
    builders: {
      'ci.internal': { packages: ['n8n-nodes-base'], predicates: ['build-provenance', 'reproducible-build'], keyIds: [KEY] },
      'vendor.n8n': { packages: ['*'], predicates: ['build-provenance', 'source-review', 'ai-generation'] },
      'scanner.internal': { packages: ['*'], predicates: ['vulnerability-scan'] },
    },
    requiredPredicates: ['build-provenance'],
  }).policyDigest, policy.policyDigest, 'the same policy digests the same');
});

test('a policy that says nothing useful is refused', () => {
  throwsWith(() => createAttestationPolicy({ builders: { a: { packages: ['*'], predicates: ['build-provenance'] } } }), 'supply.policy');
  throwsWith(() => createAttestationPolicy({ policyId: 'p', builders: {} }), 'supply.policy');
  throwsWith(() => createAttestationPolicy({ policyId: 'p', builders: { a: { predicates: ['build-provenance'] } } }), 'supply.policy');
  throwsWith(() => createAttestationPolicy({ policyId: 'p', builders: { a: { packages: ['*'] } } }), 'supply.policy');
  throwsWith(() => createAttestationPolicy({ policyId: 'p', builders: { a: { packages: ['*'], predicates: ['vibes'] } } }), 'supply.predicate');
  throwsWith(() => createAttestationPolicy({
    policyId: 'p', builders: { a: { packages: ['*'], predicates: ['build-provenance'] } }, requiredPredicates: ['vibes'],
  }), 'supply.predicate');
  throwsWith(() => mayBuilderAttest({}, { builder: 'a' }), 'supply.policy');
});

test('mayBuilderAttest answers the authority question on its own', () => {
  assert.equal(mayBuilderAttest(policy, { builder: 'ci.internal', packageName: 'n8n-nodes-base', predicate: 'build-provenance' }).allowed, true);
  const unknown = mayBuilderAttest(policy, { builder: 'nobody', packageName: 'n8n-nodes-base', predicate: 'build-provenance' });
  assert.equal(unknown.allowed, false);
  assert.equal(unknown.reason, 'supply.builder');
  assert.match(unknown.message, /an unnamed builder is not a partially trusted one/);
  assert.equal(mayBuilderAttest(policy, { builder: 'ci.internal', packageName: 'n8n-nodes-slack', predicate: 'build-provenance' }).reason, 'supply.builder');
  assert.equal(mayBuilderAttest(policy, { builder: 'vendor.n8n', packageName: 'anything', predicate: 'source-review' }).allowed, true);
  assert.equal(mayBuilderAttest(policy, { builder: 'scanner.internal', packageName: 'x', predicate: 'build-provenance' }).reason, 'supply.predicate');
});

/* ---------------------------------------------------------------- statements */

test('a statement is signed deterministically by a key the caller holds', () => {
  const first = signed();
  assert.match(first.signature, /^hmac-sha256:[0-9a-f]{64}$/);
  assert.equal(signAttestation(statement(), { keyId: KEY, secret: SECRET }).signature, first.signature);
  assert.equal(Object.isFrozen(first), true);
  const payload = statementPayload(first);
  assert.equal('signature' in payload, false, 'the payload is exactly what the signature covers');
  assert.equal(payload.keyId, KEY);
  assert.notEqual(signAttestation(statement(), { keyId: KEY, secret: 'another secret' }).signature, first.signature);
  throwsWith(() => signAttestation({ builder: 'ci.internal' }, { keyId: KEY, secret: SECRET }), 'supply.statement');
  throwsWith(() => signAttestation(statement(), { secret: SECRET }), 'supply.input');
  throwsWith(() => signAttestation(statement(), { keyId: KEY }), 'supply.input');
});

test('a verified statement names its builder, its predicate and its subject', () => {
  const verdict = verifyAttestation(signed(), { digest: D1, policy, keyring, tick: 120 });
  assert.equal(verdict.verified, true);
  assert.equal(verdict.ok, true);
  assert.equal(verdict.builder, 'ci.internal');
  assert.equal(verdict.predicate, 'build-provenance');
  assert.equal(verdict.digest, D1);
  assert.equal(verdict.packageName, 'n8n-nodes-base', 'the package comes from the statement when the caller does not repeat it');
  assert.deepEqual([...verdict.failures], []);
  assert.equal(verdict.primaryReason, null);
  assert.match(explainSupplyVerdict(verdict), /attests 'build-provenance'/);
});

test('the statement must be about these bytes, and that is checked first', () => {
  const verdict = verifyAttestation(signed(), { digest: D2, policy, keyring, tick: 120 });
  assert.equal(verdict.verified, false);
  assert.deepEqual([...verdict.reasons], ['supply.subject']);
  assert.match(verdict.message, /about another artifact is about another artifact/);
});

test('the signature must cover the statement\'s own bytes', () => {
  const tampered = Object.freeze({ ...signed(), predicate: 'reproducible-build' });
  const verdict = verifyAttestation(tampered, { digest: D1, policy, keyring, tick: 120 });
  assert.equal(verdict.verified, false);
  assert.deepEqual([...verdict.reasons], ['supply.signature'], 'a valid builder asserting a valid predicate with the wrong bytes is a signature failure, not a predicate failure');
  assert.match(verdict.message, /does not cover these bytes/);
  const unknownKey = verifyAttestation(signed(), { digest: D1, policy, keyring: { other: 'x' }, tick: 120 });
  assert.equal(unknownKey.reasons.includes('supply.signature'), true);
  assert.match(unknownKey.message, /an unverifiable signature is not a verified one/);
});

test('a key the builder does not hold is not transferable evidence', () => {
  const borrowed = signAttestation(statement(), { keyId: KEY2, secret: SECRET2 });
  const verdict = verifyAttestation(borrowed, { digest: D1, policy, keyring, tick: 120 });
  assert.equal(verdict.verified, false);
  assert.equal(verdict.failures.some((failure) => /does not hold key/.test(failure.message)), true);
});

test('authority and staleness are their own answers', () => {
  const outsider = verifyAttestation(
    signAttestation(statement({ builder: 'nobody.internal', predicate: 'source-review' }), { keyId: KEY2, secret: SECRET2 }),
    { digest: D1, policy, keyring, tick: 120 },
  );
  assert.equal(outsider.reasons.includes('supply.builder'), true);
  const wrongPredicate = verifyAttestation(signAttestation(statement({ predicate: 'ai-generation' }), { keyId: KEY, secret: SECRET }), { digest: D1, policy, keyring, tick: 120 });
  assert.equal(wrongPredicate.reasons.includes('supply.predicate'), true);
  const stale = verifyAttestation(signed(), { digest: D1, policy, keyring, tick: 501 });
  assert.deepEqual([...stale.reasons], ['supply.window']);
  assert.match(stale.message, /stale evidence is not evidence/);
  assert.equal(verifyAttestation(signed({ expiresAtTick: null }), { digest: D1, policy, keyring, tick: 100000 }).verified, true);
});

test('a structurally broken statement never reaches the crypto', () => {
  const empty = verifyAttestation({}, { digest: D1, policy, keyring, tick: 1 });
  assert.equal(empty.verified, false);
  assert.equal(empty.reasons.includes('supply.statement'), true);
  assert.equal(empty.failures.some((failure) => /does not cover these bytes/.test(failure.message)), false);
  const anonymous = verifyAttestation(statement({ builder: '' }), { digest: D1, policy, keyring, tick: 1 });
  assert.match(anonymous.message, /an anonymous attestation attests nothing/);
  const badWindow = verifyAttestation(statement({ expiresAtTick: 50 }), { digest: D1, policy, keyring, tick: 1 });
  assert.equal(badWindow.reasons.includes('supply.window'), true);
  const badSubject = verifyAttestation(statement({ subject: { digest: 'not-a-digest' } }), { digest: D1, policy, keyring, tick: 1 });
  assert.equal(badSubject.reasons.includes('supply.subject'), true);
});

/* ------------------------------------------------------- sets of attestations */

test('a set covers the required predicates, and only verified statements count', () => {
  const covered = verifyAttestations([signed(), scan()], { digest: D1, policy, keyring, tick: 120 });
  assert.equal(covered.ok, true);
  assert.deepEqual([...covered.verifiedPredicates], ['build-provenance', 'vulnerability-scan']);
  assert.deepEqual([...covered.missingPredicates], []);
  const uncovered = verifyAttestations([scan()], { digest: D1, policy, keyring, tick: 120 });
  assert.equal(uncovered.ok, false);
  assert.deepEqual([...uncovered.missingPredicates], ['build-provenance']);
  assert.match(uncovered.message, /an unverified statement covers nothing/);
  const expiredBuild = verifyAttestations([signed({ expiresAtTick: 200 })], { digest: D1, policy, keyring, tick: 300 });
  assert.equal(expiredBuild.ok, false);
  assert.deepEqual([...expiredBuild.missingPredicates], ['build-provenance'], 'an expired statement does not cover its predicate');
  const nothing = verifyAttestations([], { digest: D1, policy, keyring, tick: 1 });
  assert.equal(nothing.ok, false);
  assert.match(nothing.message, /an absent attestation is a refusal, not a shrug/);
  throwsWith(() => verifyAttestations('one', { digest: D1, policy, keyring, tick: 1 }), 'supply.input');
  throwsWith(() => verifyAttestation(signed(), { digest: D1, policy: {}, tick: 1 }), 'supply.policy');
  throwsWith(() => verifyAttestation(signed(), { digest: 'nope', policy, tick: 1 }), 'supply.input');
  throwsWith(() => verifyAttestation(signed(), { digest: D1, policy }), 'supply.input');
});

/* --------------------------------------------------------------- revocation */

test('revocation is a one-way door: idempotent, not editable, and there is no unrevoke', () => {
  const empty = createRevocationList();
  assert.equal(isRevocationList(empty), true);
  assert.deepEqual([...empty.events], []);
  const revoked = revokeArtifact(empty, { digest: D2, reason: 'malicious postinstall', origin: 'scan', tick: 10 });
  assert.equal(revoked.ok, true);
  assert.equal(isRevoked(revoked.list, D2), true);
  assert.equal(isRevoked(revoked.list, D1), false);
  assert.equal(revocationReason(revoked.list, { digest: D2 }), 'malicious postinstall');
  assert.equal(revocationReason(revoked.list, { digest: D1 }), null);
  const again = revokeArtifact(revoked.list, { digest: D2, reason: 'malicious postinstall', origin: 'scan', tick: 11 });
  assert.equal(again.ok, true);
  assert.equal(again.changed, false);
  assert.equal(again.list, revoked.list);
  assert.equal(again.list.events.length, 1);
  const edited = revokeArtifact(revoked.list, { digest: D2, reason: 'something else', origin: 'operator', tick: 12 });
  assert.equal(edited.ok, false);
  assert.equal(edited.reason, 'supply.revoked');
  assert.match(edited.message, /evidence is not edited/);
  assert.equal(Object.keys(revoked.list).some((name) => /unrevoke/i.test(name)), false);
  const event = revoked.list.events[0];
  assert.deepEqual({ ...event }, { target: 'artifact', subject: D2, reason: 'malicious postinstall', origin: 'scan', tick: 10 });
});

test('builders are revoked separately from the bytes they signed', () => {
  const byBuilder = revokeBuilder(createRevocationList(), { builder: 'ci.internal', reason: 'key compromised', origin: 'operator', tick: 20 });
  assert.equal(isBuilderRevoked(byBuilder.list, 'ci.internal'), true);
  assert.equal(isRevoked(byBuilder.list, D1), false, 'revoking a builder does not revoke the bytes');
  assert.equal(revocationReason(byBuilder.list, { builder: 'ci.internal' }), 'key compromised');
  const verdict = verifyAttestation(signed(), { digest: D1, policy, keyring, revocations: byBuilder.list, tick: 120 });
  assert.equal(verdict.verified, false);
  assert.equal(verdict.reasons.includes('supply.revoked'), true);
  assert.match(verdict.message, /key compromised/);
  throwsWith(() => revokeArtifact(createRevocationList(), { digest: D2, tick: 1 }), 'supply.input');
  throwsWith(() => revokeArtifact(createRevocationList(), { digest: D2, reason: 'x' }), 'supply.input');
  throwsWith(() => revokeArtifact(createRevocationList(), { digest: 'nope', reason: 'x', tick: 1 }), 'supply.input');
  throwsWith(() => revokeArtifact(createRevocationList(), { digest: D2, reason: 'x', origin: 'vibes', tick: 1 }), 'supply.input');
  throwsWith(() => revokeBuilder(createRevocationList(), { reason: 'x', tick: 1 }), 'supply.input');
  throwsWith(() => isRevoked({}, D2), 'supply.input');
});

test('revocation outranks everything, including a set with no statements at all', () => {
  const revoked = revokeArtifact(createRevocationList(), { digest: D2, reason: 'malware', origin: 'scan', tick: 3 }).list;
  const withStatement = verifyAttestation(signed(), { digest: D2, policy, keyring, revocations: revoked, tick: 120 });
  assert.equal(withStatement.primaryReason, 'supply.revoked');
  const withoutStatements = verifyAttestations([], { digest: D2, policy, keyring, revocations: revoked, tick: 120 });
  assert.equal(withoutStatements.ok, false);
  assert.equal(withoutStatements.reasons.includes('supply.revoked'), true, 'an artifact with no attestations is still checked against the revocation list');
});

/* ------------------------------------------------------------------- mirror */

test('a mirror is data: a manifest of packages, digests and attestations', () => {
  const mirror = mirrorManifest({
    mirrorId: 'airgap-2026-09',
    source: 'registry.internal',
    artifacts: [
      { packageName: 'n8n-nodes-slack', digest: D2, attestations: [] },
      { packageName: 'n8n-nodes-base', digest: D1, attestations: [signed(), scan()] },
    ],
  });
  assert.equal(isMirrorManifest(mirror), true);
  assert.deepEqual(mirror.artifacts.map((artifact) => artifact.packageName), ['n8n-nodes-base', 'n8n-nodes-slack'], 'artifacts are sorted');
  assert.match(mirror.manifestDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(Object.isFrozen(mirror.artifacts[0]), true);
  throwsWith(() => mirrorManifest({ source: 's', artifacts: [] }), 'supply.mirror');
  throwsWith(() => mirrorManifest({ mirrorId: 'm', artifacts: [] }), 'supply.mirror');
  throwsWith(() => mirrorManifest({ mirrorId: 'm', source: 's', artifacts: [{ packageName: 'x', digest: 'nope' }] }), 'supply.input');
  throwsWith(() => mirrorManifest({ mirrorId: 'm', source: 's', artifacts: [{ digest: D1 }] }), 'supply.mirror');
  throwsWith(() => verifyMirror({ ok: true }, { policy, tick: 1 }), 'supply.mirror');
  throwsWith(() => verifyMirror(mirror, { policy }), 'supply.input');
  throwsWith(() => verifyMirror(mirror, { policy: {}, tick: 1 }), 'supply.policy');
});

test('an offline import obeys exactly the same policy', () => {
  const mirror = mirrorManifest({
    mirrorId: 'airgap-2026-09',
    source: 'registry.internal',
    artifacts: [
      { packageName: 'n8n-nodes-base', digest: D1, attestations: [signed(), scan()] },
      { packageName: 'n8n-nodes-slack', digest: D2, attestations: [] },
    ],
  });
  const strict = verifyMirror(mirror, { policy, keyring, tick: 120 });
  assert.equal(strict.ok, false);
  assert.deepEqual([...strict.installable], ['n8n-nodes-base']);
  assert.deepEqual([...strict.refused], ['n8n-nodes-slack']);
  assert.equal(strict.primaryReason, 'supply.statement');
  assert.deepEqual([...strict.unattested], []);
  assert.equal(strict.decisions[1].reason, 'supply.statement');
  assert.match(explainSupplyVerdict(strict), /refused/);
});

test('an explicit exemption installs unattested artifacts and says so', () => {
  const lax = createAttestationPolicy({
    policyId: 'airgap-exemption',
    allowUnattested: true,
    builders: {
      'ci.internal': { packages: ['n8n-nodes-base'], predicates: ['build-provenance'], keyIds: [KEY] },
      'scanner.internal': { packages: ['*'], predicates: ['vulnerability-scan'] },
    },
    requiredPredicates: ['build-provenance'],
  });
  const mirror = mirrorManifest({
    mirrorId: 'airgap-2026-09',
    source: 'registry.internal',
    artifacts: [
      { packageName: 'n8n-nodes-base', digest: D1, attestations: [signed(), scan()] },
      { packageName: 'n8n-nodes-slack', digest: D2, attestations: [] },
    ],
  });
  const allowed = verifyMirror(mirror, { policy: lax, keyring, tick: 120 });
  assert.equal(allowed.ok, true);
  assert.deepEqual([...allowed.unattested], ['n8n-nodes-slack']);
  assert.match(allowed.decisions[1].message, /UNATTESTED/);
  assert.match(allowed.message, /exemption/);
  assert.match(explainSupplyVerdict(allowed), /installable/);
});

test('an exemption never beats revocation, and it never covers a failed check', () => {
  const lax = createAttestationPolicy({
    policyId: 'airgap-exemption',
    allowUnattested: true,
    builders: { 'ci.internal': { packages: ['n8n-nodes-base'], predicates: ['build-provenance'], keyIds: [KEY] } },
    requiredPredicates: ['build-provenance'],
  });
  const revoked = revokeArtifact(createRevocationList(), { digest: D2, reason: 'malware', origin: 'scan', tick: 3 }).list;
  const mirror = mirrorManifest({
    mirrorId: 'm', source: 's', artifacts: [{ packageName: 'n8n-nodes-slack', digest: D2, attestations: [] }],
  });
  const refused = verifyMirror(mirror, { policy: lax, keyring, revocations: revoked, tick: 120 });
  assert.equal(refused.ok, false);
  assert.equal(refused.decisions[0].install, false);
  assert.equal(refused.decisions[0].reason, 'supply.revoked');

  const tampered = mirrorManifest({
    mirrorId: 'm2', source: 's',
    artifacts: [{ packageName: 'n8n-nodes-base', digest: D1, attestations: [Object.freeze({ ...signed(), signature: `hmac-sha256:${'0'.repeat(64)}` })] }],
  });
  const signedRefused = verifyMirror(tampered, { policy: lax, keyring, tick: 120 });
  assert.equal(signedRefused.ok, false);
  assert.equal(signedRefused.decisions[0].install, false);
  assert.equal(signedRefused.decisions[0].reason, 'supply.signature');
});

/* ------------------------------------------------------------ reads, guards */

test('describeSupplyChain publishes the policy, the revocations and the mirror', () => {
  const revocations = revokeArtifact(createRevocationList(), { digest: D2, reason: 'malware', origin: 'scan', tick: 3 }).list;
  const mirror = mirrorManifest({ mirrorId: 'm', source: 's', artifacts: [{ packageName: 'n8n-nodes-base', digest: D1, attestations: [] }] });
  const described = describeSupplyChain({ policy, revocations, mirror });
  assert.equal(described.policy.policyId, 'registry-default');
  assert.deepEqual([...described.policy.builders], ['ci.internal', 'scanner.internal', 'vendor.n8n']);
  assert.deepEqual([...described.revocations.artifacts], [D2]);
  assert.equal(described.mirror.artifactCount, 1);
  assert.deepEqual({ ...describeSupplyChain({}) }, {});
  assert.equal(Object.isFrozen(described), true);
});

test('the error type is exported, and a failed verification is data rather than an exception', () => {
  const error = new SupplyChainError('x');
  assert.equal(error instanceof Error, true);
  assert.equal(error.code, 'lego.contract_violation');
  assert.equal(Object.isFrozen(error.meta), true);
  assert.doesNotThrow(() => verifyAttestation({}, { digest: D1, policy, keyring, tick: 1 }));
  throwsWith(() => explainSupplyVerdict({ nope: true }), 'lego.contract_violation');
});

/* ---------------------------------------------------------------- scope walls */

test('P6.12 is pure: crypto only, and no filesystem, network, clock or process', () => {
  const source = readFileSync(new URL('../src/lego/supply-chain.mjs', import.meta.url), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const forbidden of ['node:fs', 'node:net', 'node:http', 'node:os', 'node:child_process', 'process.', 'Math.random', 'setTimeout', 'performance.', 'fetch(']) {
    assert.equal(code.includes(forbidden), false, `the supply chain contract must not reference ${forbidden}`);
  }
  assert.deepEqual([...code.matchAll(/from '(node:[a-z_/]+)'/g)].map((match) => match[1]), ['node:crypto']);
  assert.equal(/\bnew Date\b|\bDate\.now\b/.test(code), false, 'tick and validity windows are data, not clock readings');
});

test('P6.12 stays inside its walls: no install, no health, no lifecycle, no artifact store', () => {
  const source = readFileSync(new URL('../src/lego/supply-chain.mjs', import.meta.url), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const forbidden of ['node-health', 'node-lifecycle', 'package-transaction', 'runtime-lease', 'node-residency', 'registry-compiler', 'capability-compiler', 'artifact-store', 'spawn', 'node:vm', 'uninstall(']) {
    assert.equal(code.includes(forbidden), false, `P6.12 must not reach into ${forbidden}: that belongs to a later or different contract`);
  }
  assert.match(SUPPLY_CHAIN_RULES.mirror, /offline.*not a reason to accept/s);
});

/* ------------------------------------------------------------------- lock row */

test('the contract-lock row is canonical: one row, version, ops, tests, exports, domain path', () => {
  const lock = JSON.parse(readFileSync(new URL('../src/lego/contracts/contract-lock.json', import.meta.url)));
  const rows = lock.contracts.filter((contract) => contract.id === 'node.supply-chain');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].version, SUPPLY_CHAIN_CONTRACT_VERSION);
  assert.equal(rows[0].domain, 'node-registry');
  assert.equal(rows[0].status, 'implemented');
  assert.deepEqual(rows[0].surface, ['src/lego/supply-chain.mjs']);
  assert.deepEqual(rows[0].tests, ['apps/n8n-lego/test/lego-supply-chain.test.mjs']);
  for (const name of ['createAttestationPolicy', 'signAttestation', 'verifyAttestations', 'revokeArtifact', 'revokeBuilder', 'verifyMirror']) {
    assert.equal(rows[0].exports['src/lego/supply-chain.mjs'].includes(name), true, `${name} must be locked`);
  }
  for (const id of ['node.registry', 'registry.compiler', 'package.transaction', 'registry.closure', 'node.resolution', 'runtime.lease', 'node.residency', 'node.capability', 'node.semantics', 'node.lifecycle', 'node.health']) {
    assert.equal(lock.contracts.find((contract) => contract.id === id).version, '0.1.0', `P6.12 must not re-version ${id}`);
  }
  const domain = JSON.parse(readFileSync(new URL('../src/lego/manifest/domains.json', import.meta.url)))
    .domains.find((entry) => entry.id === 'node-registry');
  assert.equal(domain.contract.id, 'node.portability');
  assert.ok(domain.paths.includes('src/lego/supply-chain.mjs'));
});
